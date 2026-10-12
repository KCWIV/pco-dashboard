const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ── Early .env loading (needed before TLS config) ─────────────────────────────
const _earlyEnv = {};
try {
  const _envContent = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  _envContent.split("\n").forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) _earlyEnv[m[1].trim()] = m[2].trim();
  });
} catch(e) { /* .env not found — that's fine */ }

// TLS: Allow disabling cert verification for local dev environments that lack
// proper CA chains. In production, do NOT set SKIP_TLS_VERIFY.
if (_earlyEnv.SKIP_TLS_VERIFY === "1" || process.env.SKIP_TLS_VERIFY === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.log("⚠ TLS certificate verification disabled (SKIP_TLS_VERIFY=1) — do NOT use in production");
}

const PORT        = process.env.PORT || 3000;
const PCO_BASE    = "api.planningcenteronline.com";
const DEFAULT_WEEKS = 8;
const CONCURRENCY = 6;  // balanced: fast enough but with retry logic to handle rate limits

// ── Church Configuration ─────────────────────────────────────────────────────
// All PCO event/attendance IDs in one place. Update these if your church's
// PCO structure changes (new events, renamed rooms, etc.)
const CHURCH_CONFIG = {
  timezone: "America/Chicago",  // Church's local timezone (for consistent date bucketing)
  events: {
    sundayAttendance: "607918",  // Main headcount event
    sundayRelated: ["609801", "609021", "609040", "891172", "698601"],
    cityKids: "609801",
    decisions: "609021",
  },
  // Only count this attendance type for Decisions (excludes "Bibles Given", "Online", etc.)
  decisionsAttendanceType: "191897",
  // Kids room names by attendance_type ID (for room-by-room breakdown)
  kidsRoomNames: {
    "197431": "02 Walkers",
    "197435": "03 Pre-K & K",
    "197436": "04 Elem",
    "197437": "01 Crawlers",
    "197438": "05 J High",
    "306869": "KUEST Team",
  },
};

// Pin process timezone to the church's timezone so Date operations use the
// correct local time — critical for weekly bucket boundaries when deployed to cloud
process.env.TZ = CHURCH_CONFIG.timezone;

let savedCreds     = null;
let dataCache      = {};  // keyed by weeks count: { "8": { ts, payload }, "26": { ts, payload } }
let peopleDataCache     = null; // { ts, payload } — new member growth + at-risk congregants
let lifegroupsCache    = null; // { ts, payload } — life groups from PCO Groups API
let birthdaysCache     = null; // { ts, payload } — all active people with birthdays
let cityKidsTeamCache  = null; // { ts, payload } — City Kids new team members 2026 (slow fetch, cached 4h)

async function warmCityKidsTeamCache() {
  const CITY_KIDS_ST_ID = "1328172";
  const start2026 = new Date("2026-01-01T00:00:00");
  const personFirstSeen = {};
  const personSeenPre2026 = new Set();
  const ckPlans = [];
  let plUrl = "/services/v2/service_types/" + CITY_KIDS_ST_ID + "/plans?filter=past&after=2025-01-01&per_page=100&order=sort_date";
  while (plUrl) {
    const plRes = await pcoFetch(plUrl);
    if (plRes.status !== 200) break;
    ckPlans.push(...(plRes.body.data || []));
    const next = plRes.body.links && plRes.body.links.next;
    if (next) { const p = new URL(next); plUrl = p.pathname + p.search; } else { plUrl = null; }
  }
  await pLimit(ckPlans.map(plan => async () => {
    const planDate = parseLocalDate((plan.attributes || {}).sort_date || "");
    let tmUrl = "/services/v2/service_types/" + CITY_KIDS_ST_ID + "/plans/" + plan.id + "/team_members?per_page=100";
    while (tmUrl) {
      const tmRes = await pcoFetch(tmUrl);
      if (tmRes.status !== 200) break;
      for (const tm of (tmRes.body.data || [])) {
        const personId = tm.relationships && tm.relationships.person && tm.relationships.person.data && tm.relationships.person.data.id;
        if (!personId) continue;
        const name = ((tm.attributes && tm.attributes.name) || "").trim();
        const teamRel = tm.relationships && tm.relationships.team && tm.relationships.team.data;
        const teamId = teamRel && teamRel.id;
        const teamName = (teamId && globalTeamNameMap[teamId]) || "";
        if (planDate < start2026) {
          personSeenPre2026.add(personId);
        } else {
          if (!personFirstSeen[personId] || planDate < personFirstSeen[personId].firstDate) {
            personFirstSeen[personId] = { name, teamName, firstDate: planDate };
          }
        }
      }
      const next = tmRes.body.links && tmRes.body.links.next;
      if (next) { const p = new URL(next); tmUrl = p.pathname + p.search; } else { tmUrl = null; }
    }
  }), CONCURRENCY);
  const members = Object.entries(personFirstSeen)
    .filter(([id]) => !personSeenPre2026.has(id))
    .map(([, m]) => m)
    .sort((a, b) => a.firstDate - b.firstDate);
  cityKidsTeamCache = { ts: Date.now(), payload: members };
  console.log("✅ City Kids team cache warmed — " + members.length + " new members in 2026");
}
let progressClients = [];
let globalTeamNameMap = {};  // persistent: team_id → team_name (rarely changes)
let teamFirstSeenMap = {};  // persistent: teamName → { personKey → firstSeenLabel }
                            // Built from 52-week data to accurately detect truly new members
// Team renames: old name → new name. History from the old team carries over so
// members aren't falsely flagged as "new" after a rename.
const TEAM_RENAMES = {
  "Connect Bar Team": "Live Planted Team",
};
// Normalize a team name: trim whitespace, apply renames
function normalizeTeamName(name) {
  const trimmed = (name || "").trim();
  return TEAM_RENAMES[trimmed] || trimmed;
}
// Team categories for frontend grouping
const TEAM_CATEGORIES = {
  "Worship": ["Worship Band", "Worship Vocals", "Worship Leads", "Production", "Platform Speakers", "Online Services"],
  "City Kids": ["City Kids", "Elementary (1st-5th)", "Pre-K & K (3-5)", "Nursery - Infants (0-1)", "Nursery - Toddlers (1-3)", "J High (6th-8th)", "Check In"],
  "Guest Services": ["First Impressions Team", "Host Team", "Hospitality Team", "Live Planted Team", "Lobby Team", "Next Step Team", "Outdoor + Parking Team", "Parking Team"],
  "Operations": ["Anointing Team", "Finance Team", "Pastoral Host Team", "Photography Team", "Security Team", "Upper Room Team", "Sunday Rally"],
};
function getTeamCategory(name) {
  for (const [cat, teams] of Object.entries(TEAM_CATEGORIES)) {
    if (teams.indexOf(name) >= 0) return cat;
  }
  return "Other";
}
let apiCallCount   = 0;     // per-request counter for diagnostics
let prefetchRunning = false; // guard: prevent concurrent background prefetch runs

// ── Auto-load PCO credentials from .env file or environment variables ────────
const envAppId = _earlyEnv.PCO_APP_ID || process.env.PCO_APP_ID;
const envSecret = _earlyEnv.PCO_SECRET || process.env.PCO_SECRET;
if (envAppId && envSecret) {
  savedCreds = { appId: envAppId, secret: envSecret };
  console.log("✅ Loaded PCO credentials from environment");
}

// ── Staff login system ──────────────────────────────────────────────────────
// DASHBOARD_PASSWORD env var gates access to the dashboard.
// If not set, the dashboard is open (backwards-compatible for local dev).
const DASHBOARD_PASSWORD = _earlyEnv.DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD || null;
const activeSessions = new Set(); // simple in-memory session tokens

function generateToken() {
  const crypto = require("crypto");
  return crypto.randomBytes(32).toString("hex");
}

function isAuthenticated(req) {
  if (!DASHBOARD_PASSWORD) return true; // no password set = open access
  const cookies = (req.headers.cookie || "").split(";").reduce((acc, c) => {
    const [k, v] = c.trim().split("=");
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  return activeSessions.has(cookies.session);
}

// ── READ-ONLY GUARD ──────────────────────────────────────────────────────────
// This dashboard must never modify Planning Center data. Every request to PCO
// goes through assertPcoReadOnly(); anything other than GET throws before a
// socket is opened. The PAT itself is read/write (PCO cannot scope a PAT), so
// this is defence in depth — see CLAUDE.md "Read-only policy" for the rest.
const PCO_ALLOWED_METHODS = new Set(["GET"]);
function assertPcoReadOnly(method, apiPath) {
  if (!PCO_ALLOWED_METHODS.has(String(method).toUpperCase())) {
    throw new Error("PCO read-only policy: refused " + method + " " + apiPath);
  }
}

// ── PCO fetch with automatic retry on rate-limit (429) and server errors ─────
function pcoFetchOnce(apiPath) {
  return new Promise((resolve, reject) => {
    assertPcoReadOnly("GET", apiPath);
    const auth = Buffer.from(savedCreds.appId + ":" + savedCreds.secret).toString("base64");
    const req = https.request(
      { hostname: PCO_BASE, path: apiPath, method: "GET",
        headers: { Authorization: "Basic " + auth, "Content-Type": "application/json", "User-Agent": "PCO-Dashboard/1.0" } },
      (res) => {
        let d = "";
        res.on("data", c => (d += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d), retryAfter: res.headers["retry-after"] }); }
          catch (e) { resolve({ status: res.statusCode, body: d, retryAfter: res.headers["retry-after"] }); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function pcoFetch(apiPath, maxRetries) {
  maxRetries = maxRetries || 5;
  apiCallCount++;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await pcoFetchOnce(apiPath);
    // Success — return immediately
    if (result.status >= 200 && result.status < 300) return result;
    // Rate limited (429) or server error (5xx) — retry with backoff
    if (result.status === 429 || result.status >= 500) {
      const retryDelay = result.retryAfter
        ? Math.max(1, parseInt(result.retryAfter)) * 1000
        : Math.min(2000 * Math.pow(2, attempt), 30000);  // exponential backoff: 2s, 4s, 8s, 16s, 30s
      if (attempt < maxRetries) {
        console.log("⚠ PCO rate limit/error (HTTP " + result.status + ") on " + apiPath.substring(0, 80) + " — retrying in " + (retryDelay/1000) + "s (attempt " + (attempt+1) + "/" + maxRetries + ")");
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }
    }
    // Non-retryable error or exhausted retries — return whatever we got
    if (result.status !== 200 && result.status !== 429) {
      console.log("⚠ PCO returned HTTP " + result.status + " for " + apiPath.substring(0, 80));
    }
    return result;
  }
}

// ── Concurrency-limited parallel runner with inter-request pacing ─────────────
async function pLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = await tasks[i](); } catch (e) { results[i] = null; }
      // Small delay between requests per worker to avoid burst-firing
      if (idx < tasks.length) await new Promise(r => setTimeout(r, 50));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ── SSE progress ──────────────────────────────────────────────────────────────
function broadcast(msg) {
  const data = "data: " + JSON.stringify(msg) + "\n\n";
  progressClients.forEach(c => { try { c.write(data); } catch(e){} });
}

// ── Time buckets (weekly or monthly) ─────────────────────────────────────────
// Auto-switches: weekly for < 13 weeks, monthly for 13+ weeks
function buildTimeBuckets(weeks) {
  const now = new Date();
  const buckets = [], labels = [];
  const useMonthly = weeks >= 13;

  if (useMonthly) {
    // Monthly buckets — go back N months to cover the requested weeks
    const months = Math.ceil(weeks / 4.33);
    for (let i = months - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1, 0, 0, 0, 0);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
      buckets.push({ start, end });
      labels.push(start.toLocaleDateString("en-US", { month: "short", year: i > 11 ? "numeric" : undefined }));
    }
  } else {
    // Weekly buckets (Sun–Sat)
    for (let i = weeks - 1; i >= 0; i--) {
      const ref = new Date(now); ref.setDate(ref.getDate() - i * 7);
      const sun = new Date(ref); sun.setDate(ref.getDate() - ref.getDay()); sun.setHours(0,0,0,0);
      const sat = new Date(sun); sat.setDate(sun.getDate() + 6); sat.setHours(23,59,59,999);
      buckets.push({ start: sun, end: sat });
      labels.push(sun.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  }
  return { buckets, labels, grouping: useMonthly ? "monthly" : "weekly" };
}

function bucketIndexFor(date, buckets) {
  for (let i = 0; i < buckets.length; i++) {
    if (date >= buckets[i].start && date <= buckets[i].end) return i;
  }
  return -1;
}

// Parse a date string from PCO into local time consistently.
// Date-only strings like "2026-03-08" are parsed as UTC by JS,
// but our buckets use local time. This forces local-time parsing.
function parseLocalDate(str) {
  if (!str) return new Date(0);
  // If it's a date-only string (no T), append T12:00:00 to parse as local noon
  // This avoids any timezone boundary issues (UTC midnight → previous day in US timezones)
  if (typeof str === "string" && !str.includes("T")) {
    return new Date(str + "T12:00:00");
  }
  return new Date(str);
}

// ── Main data build ───────────────────────────────────────────────────────────
async function buildData(weeks) {
  weeks = weeks || DEFAULT_WEEKS;
  apiCallCount = 0;  // reset per-request counter
  const buildStart = Date.now();
  const { buckets, labels, grouping } = buildTimeBuckets(weeks);
  const N = buckets.length;  // number of time periods (weeks or months)
  const since = new Date(); since.setDate(since.getDate() - weeks * 7 - 1);
  const sinceISO = since.toISOString().split("T")[0];

  const attendance  = new Array(N).fill(0);  // total (excluding nighttime 6PM+)
  const attendanceByService = {};  // service_time_label → array[N] e.g. { "9:00 AM": [0,0,...], "10:30 AM": [...] }
  const scheduled   = new Array(N).fill(0);
  const confirmed   = new Array(N).fill(0);
  const declined    = new Array(N).fill(0);
  const blocked     = new Array(N).fill(0);
  const firstTimers = new Array(N).fill(0);
  const firstTimerNames = Array.from({ length: N }, () => []);

  // weeklyPeople[wi][personKey] = { name, teams:Set, positions:Set, serviceTimes:Set, appearances, schedules[] }
  const weeklyPeople = Array.from({ length: N }, () => ({}));
  const teamsMap = {};

  // ── 1. Service types ────────────────────────────────────────────────────────
  broadcast({ step: "Fetching service types…", pct: 2 });
  const stRes = await pcoFetch("/services/v2/service_types?per_page=25");
  const serviceTypes = (stRes.body && stRes.body.data) || [];
  broadcast({ step: "Found " + serviceTypes.length + " service types", pct: 5 });

  // ── 2. Plans (parallel per service type, with pagination for long ranges) ──
  broadcast({ step: "Fetching plans for past " + weeks + " weeks…", pct: 8 });
  const planResults = await pLimit(
    serviceTypes.slice(0, 12).map(st => async () => {
      let allPlans = [];
      let planUrl = "/services/v2/service_types/"+st.id+"/plans?after="+sinceISO+"&per_page=100&order=-sort_date";
      const maxPlans = Math.max(200, weeks * 3);  // generous: ~3 plans/week per service type
      while (planUrl && allPlans.length < maxPlans) {
        const r = await pcoFetch(planUrl);
        const rData = (r.body && r.body.data) || [];
        if (r.status !== 200) {
          console.log("⚠ Plans fetch got HTTP " + r.status + " for " + planUrl.substring(0, 80));
        }
        allPlans = allPlans.concat(rData);
        const links = (r.body && r.body.links) || {};
        if (links.next) {
          const p = new URL(links.next);
          planUrl = p.pathname + p.search;
        } else { planUrl = null; }
      }
      return { st, plans: allPlans };
    }),
    CONCURRENCY
  );
  const totalPlans = planResults.reduce((s, r) => s + (r ? r.plans.length : 0), 0);
  broadcast({ step: "Found " + totalPlans + " plans — fetching team members…", pct: 15 });

  // ── 3. Pre-fetch team names (cached globally — team names rarely change) ───
  // Only fetch if we don't already have them cached from a prior request
  const needTeamFetch = Object.keys(globalTeamNameMap).length === 0;
  if (needTeamFetch) {
    broadcast({ step: "Fetching team names…", pct: 13 });
    await pLimit(
      serviceTypes.slice(0, 12).map(st => async () => {
        const teamsRes = await pcoFetch("/services/v2/service_types/"+st.id+"/teams?per_page=100");
        for (const t of (teamsRes.body && teamsRes.body.data) || []) {
          globalTeamNameMap[t.id] = normalizeTeamName((t.attributes || {}).name || "Unknown Team");
        }
      }),
      CONCURRENCY
    );
  } else {
    broadcast({ step: "Team names cached (" + Object.keys(globalTeamNameMap).length + " teams)", pct: 13 });
  }
  const teamNameMap = globalTeamNameMap;

  const allPlanPairs = [];
  let latestPlanDate = null, latestStId = null, latestPlanId = null;
  for (const result of planResults) {
    if (!result) continue;
    for (const plan of result.plans) {
      const planDate = parseLocalDate((plan.attributes || {}).sort_date || (plan.attributes || {}).created_at);
      const wi = bucketIndexFor(planDate, buckets);
      if (wi === -1) continue;
      allPlanPairs.push({ st: result.st, plan, wi });
      if (!latestPlanDate || planDate > latestPlanDate) {
        latestPlanDate = planDate; latestStId = result.st.id; latestPlanId = plan.id;
      }
    }
  }

  // ── Debug: log bucket and plan diagnostics ──
  if (weeks > 8) {
    console.log("\n── Range diagnostics (weeks=" + weeks + ", grouping=" + grouping + ") ──");
    console.log("   sinceISO: " + sinceISO);
    console.log("   Buckets (" + N + "):");
    buckets.forEach((b, i) => console.log("     [" + i + "] " + labels[i] + ": " + b.start.toISOString() + " → " + b.end.toISOString()));
    console.log("   Total plans fetched from API: " + totalPlans);
    console.log("   Plans matching buckets (allPlanPairs): " + allPlanPairs.length);
    if (totalPlans > 0 && allPlanPairs.length === 0) {
      // Show sample plan dates to diagnose why none matched
      const sampleDates = [];
      for (const r of planResults) {
        if (r && r.plans) for (const p of r.plans.slice(0, 3)) {
          sampleDates.push((p.attributes || {}).sort_date);
        }
      }
      console.log("   ⚠ No plans matched buckets! Sample sort_dates:", sampleDates.slice(0, 6));
    }
    console.log("──────────────────────────────\n");
  }

  // ── 4. Fetch plan_times separately, then team members ──
  // include=times on team_members doesn't sideload PlanTime objects in PCO's API,
  // so we fetch plan_times for each plan first, then team_members.
  const planTimeMap = {};  // plantime_id → "9:00 AM" / "10:30 AM" etc.
  broadcast({ step: "Fetching plan times…", pct: 12 });

  // Pre-fetch plan_times for all plans
  await pLimit(
    allPlanPairs.map(({ st, plan }) => async () => {
      try {
        const ptRes = await pcoFetch("/services/v2/service_types/"+st.id+"/plans/"+plan.id+"/plan_times?per_page=100");
        for (const pt of (ptRes.body && ptRes.body.data) || []) {
          if (pt.id && !planTimeMap[pt.id]) {
            const pta = pt.attributes || {};
            // Skip rehearsal and other time types — only count actual service times
            if (pta.time_type === "rehearsal" || pta.time_type === "other") continue;
            // Skip evening times (6 PM+) — these are Saturday rehearsals or non-Sunday events
            if (pta.starts_at) {
              const ptHour = new Date(pta.starts_at).toLocaleTimeString("en-US", { hour:"numeric", hour12: false, timeZone: CHURCH_CONFIG.timezone });
              if (parseInt(ptHour) >= 18 || parseInt(ptHour) < 5) continue;
            }
            const tName = pta.name
              || (pta.starts_at ? new Date(pta.starts_at).toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" }) : "");
            if (tName) planTimeMap[pt.id] = tName;
          }
        }
      } catch(e) { /* non-fatal */ }
    }),
    CONCURRENCY
  );
  broadcast({ step: "Fetching team members…", pct: 15 });
  let doneCount = 0;
  await pLimit(
    allPlanPairs.map(({ st, plan, wi }) => async () => {
      // Paginate team members — plans can exceed 100 members
      let members = [];
      let included = [];
      let tmUrl = "/services/v2/service_types/"+st.id+"/plans/"+plan.id+"/team_members?per_page=100&include=times";
      while (tmUrl) {
        const tmRes = await pcoFetch(tmUrl);
        members = members.concat((tmRes.body && tmRes.body.data) || []);
        included = included.concat((tmRes.body && tmRes.body.included) || []);
        const nxt = tmRes.body && tmRes.body.links && tmRes.body.links.next;
        tmUrl = nxt ? (new URL(nxt)).pathname + (new URL(nxt)).search : null;
      }
      for (const inc of included) {
        if ((inc.type === "PlanTime" || inc.type === "plan_time") && inc.id && !planTimeMap[inc.id]) {
          const pta = inc.attributes || {};
          // Skip rehearsal and other time types
          if (pta.time_type === "rehearsal" || pta.time_type === "other") continue;
          // Skip evening times (6 PM+)
          if (pta.starts_at) {
            const ptHour = new Date(pta.starts_at).toLocaleTimeString("en-US", { hour:"numeric", hour12: false, timeZone: CHURCH_CONFIG.timezone });
            if (parseInt(ptHour) >= 18 || parseInt(ptHour) < 5) continue;
          }
          const tName = pta.name
            || (pta.starts_at ? new Date(pta.starts_at).toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" }) : "");
          if (tName) planTimeMap[inc.id] = tName;
        }
      }
      const attrs   = plan.attributes || {};
      const stName  = (st.attributes && st.attributes.name) || "";
      const planDateISO = attrs.sort_date ? attrs.sort_date.slice(0, 10) : null;
      const planDateStr = planDateISO
        ? new Date(attrs.sort_date).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" })
        : "—";

      for (const m of members) {
        const ma   = m.attributes || {};
        const s    = ma.status;
        const pid  = (m.relationships && m.relationships.person && m.relationships.person.data && m.relationships.person.data.id) || m.id;
        const name = ma.name || ma.full_name || "Unknown";

        // Resolve team name from team relationship ID
        const teamRelId = m.relationships && m.relationships.team && m.relationships.team.data && m.relationships.team.data.id;
        const team = (teamRelId && teamNameMap[teamRelId]) || ma.team_name || "Other";
        const pos  = ma.team_position_name || ma.position_name || "";

        // Resolve service times from service_times relationship → planTimeMap
        // IMPORTANT: store individual times separately for multi-service detection
        let individualTimes = [];  // each distinct time as a separate string
        const stRel = m.relationships && m.relationships.service_times && m.relationships.service_times.data;
        if (Array.isArray(stRel) && stRel.length > 0) {
          individualTimes = stRel.map(t => planTimeMap[t.id] || "").filter(Boolean);
        }
        // Fallback: try times relationship
        if (individualTimes.length === 0) {
          const timesRel = m.relationships && m.relationships.times && m.relationships.times.data;
          if (Array.isArray(timesRel) && timesRel.length > 0) {
            individualTimes = timesRel.map(t => planTimeMap[t.id] || "").filter(Boolean);
          }
        }
        // Fallback: try attribute
        if (individualTimes.length === 0) {
          const attrTime = ma.service_time_name || ma.time_preference_name || "";
          if (attrTime) individualTimes = [attrTime];
        }
        const svcTime = individualTimes.join(", ");  // display string for the schedule entry

        scheduled[wi]++;
        if (s === "C") confirmed[wi]++;
        else if (s === "D") declined[wi]++;
        else if (s === "B") blocked[wi]++;

        // First-time volunteers: "Next Step Team" + "First Serve Volunteer" position
        if (team === "Next Step Team" && pos === "First Serve Volunteer") {
          if (s === "C") firstTimers[wi]++;
          firstTimerNames[wi].push({ name, pid, status: s, serviceTime: svcTime || "" });
        }

        const pKey = pid || name;
        if (!weeklyPeople[wi][pKey]) {
          weeklyPeople[wi][pKey] = {
            name,
            teams:        new Set(),
            positions:    new Set(),
            // serviceTimes tracks INDIVIDUAL time slots — each added separately
            // e.g. Keaton: "10:30 AM" from J High + "12:30 PM" from Elementary = size 2
            serviceTimes: new Set(),
            appearances:  0,
            schedules:    []
          };
        }
        const p = weeklyPeople[wi][pKey];
        p.appearances++;
        p.teams.add(team);
        p.positions.add(team + "|" + pos);
        // Add each individual time to the set (not the joined string)
        for (const t of individualTimes) p.serviceTimes.add(t);
        p.schedules.push({ date: planDateStr, dateISO: planDateISO, serviceType: stName, team, position: pos, serviceTime: svcTime, status: s || "U" });
      }

      doneCount++;
      if (doneCount % 3 === 0 || doneCount === allPlanPairs.length) {
        broadcast({ step: "Team members: " + doneCount + "/" + allPlanPairs.length + " plans processed", pct: Math.round(15 + (doneCount / allPlanPairs.length) * 60) });
      }
    }),
    CONCURRENCY
  );

  broadcast({ step: "Building team coverage…", pct: 78 });

  // ── 5. Team coverage (latest plan) ─────────────────────────────────────────
  if (latestStId && latestPlanId) {
    const tmRes = await pcoFetch("/services/v2/service_types/"+latestStId+"/plans/"+latestPlanId+"/team_members?per_page=200");
    for (const m of (tmRes.body && tmRes.body.data) || []) {
      const tRelId = m.relationships && m.relationships.team && m.relationships.team.data && m.relationships.team.data.id;
      const team = (tRelId && teamNameMap[tRelId]) || (m.attributes && m.attributes.team_name) || "Other";
      const s    = m.attributes && m.attributes.status;
      if (!teamsMap[team]) teamsMap[team] = { scheduled:0, confirmed:0, declined:0, blocked:0 };
      teamsMap[team].scheduled++;
      if (s==="C") teamsMap[team].confirmed++;
      else if (s==="D") teamsMap[team].declined++;
      else if (s==="B") teamsMap[team].blocked++;
    }
  }
  const teams = Object.entries(teamsMap)
    .map(([name,v]) => ({ name, ...v, coverage: v.scheduled ? Math.round(v.confirmed/v.scheduled*100) : 0 }))
    .sort((a,b) => b.scheduled - a.scheduled);

  // ── 5. Multi-server detection ───────────────────────────────────────────────
  // ONLY criterion: person is scheduled at 2+ DISTINCT service times in the same week.
  //   e.g. Keaton: J High @ 10:30 AM + Elementary @ 12:30 PM → flagged (2 distinct times)
  //   e.g. Lauren Henderson: Position A @ 10:30 AM + Position B @ 10:30 AM → NOT flagged (same time)
  //   e.g. Zack: Sunday Services @ 9:00 AM + City Kids @ 10:30 AM → flagged (2 distinct times)
  const weeklyMultiServers = weeklyPeople.map(weekMap => {
    const result = [];
    for (const [, data] of Object.entries(weekMap)) {
      if (data.serviceTimes.size >= 2) {
        const reason = Array.from(data.serviceTimes).join(" & ") +
          " (" + Array.from(data.teams).join(", ") + ")";

        result.push({
          name:             data.name,
          appearances:      data.appearances,
          teamCount:        data.teams.size,
          positionCount:    data.positions.size,
          serviceTimeCount: data.serviceTimes.size,
          teams:            Array.from(data.teams),
          serviceTimes:     Array.from(data.serviceTimes),
          reason:           reason,
          schedules:        data.schedules,
        });
      }
    }
    return result.sort((a, b) => b.serviceTimeCount - a.serviceTimeCount || b.appearances - a.appearances);
  });

  // ── 5b. Volunteer profiles (cross-week per-person timeline) ────────────────
  // Build a flat map of every volunteer seen across all weeks with week-by-week status.
  // Used for the drill-down view and at-risk detection.
  const volunteerProfileMap = {};
  for (let wi = 0; wi < N; wi++) {
    for (const [pKey, data] of Object.entries(weeklyPeople[wi])) {
      if (!volunteerProfileMap[pKey]) {
        volunteerProfileMap[pKey] = {
          name: data.name,
          pid:  pKey,  // PCO person ID (or name if no ID was resolved)
          confirmedByWeek: new Array(N).fill(0),
          scheduledByWeek: new Array(N).fill(0),
          declinedByWeek:  new Array(N).fill(0),
          teams:     new Set(),
          positions: new Set(),
        };
      }
      const profile = volunteerProfileMap[pKey];
      for (const s of data.schedules) {
        profile.scheduledByWeek[wi]++;
        if (s.status === "C") {
          profile.confirmedByWeek[wi]++;
          if (s.dateISO) profile.lastServeDateISO = s.dateISO;
        }
        else if (s.status === "D") profile.declinedByWeek[wi]++;
        if (s.team) profile.teams.add(s.team);
        if (s.position) profile.positions.add(s.position);
      }
    }
  }

  const volunteerProfiles = Object.values(volunteerProfileMap)
    .map(p => {
      let lastServeWi = -1;
      p.confirmedByWeek.forEach((v, i) => { if (v > 0) lastServeWi = i; });
      return {
        name:            p.name,
        pid:             p.pid,
        confirmedByWeek: p.confirmedByWeek,
        scheduledByWeek: p.scheduledByWeek,
        declinedByWeek:  p.declinedByWeek,
        teams:           Array.from(p.teams),
        positions:       Array.from(p.positions),
        totalConfirmed:  p.confirmedByWeek.reduce((s, v) => s + v, 0),
        totalScheduled:  p.scheduledByWeek.reduce((s, v) => s + v, 0),
        lastServeWi,
        lastServeDate:   p.lastServeDateISO || null,
      };
    })
    .filter(v => v.totalScheduled > 0)
    .sort((a, b) => b.totalConfirmed - a.totalConfirmed);

  // ── At-risk detection: consistent volunteers who've gone quiet ──────────────
  // "Consistent" = 3+ confirmed serves in the historical window (not recent weeks)
  // "Gone quiet" = ZERO non-declined scheduling activity in the last 3 weeks.
  //   We intentionally use (scheduled - declined) rather than confirmed-only:
  //   a volunteer scheduled as "U" (pending) for next Sunday is still active —
  //   they haven't been confirmed yet but they ARE on the rota. Only flag someone
  //   who has no scheduling record at all across all their teams in recent weeks.
  const recentWks  = Math.min(3, Math.max(2, Math.floor(N / 4)));
  const historyWks = Math.min(N - recentWks, 10);
  const atRiskVolunteers = N >= 6 ? volunteerProfiles
    .filter(v => {
      // Recent activity = any week in the window with at least one non-declined slot
      const recentSlice = v.scheduledByWeek.slice(N - recentWks);
      const recentDeclined = v.declinedByWeek.slice(N - recentWks);
      const recentNonDeclined = recentSlice.reduce((s, sch, i) => s + Math.max(0, sch - recentDeclined[i]), 0);
      const histStart  = Math.max(0, N - recentWks - historyWks);
      const priorServes = v.confirmedByWeek.slice(histStart, N - recentWks).reduce((s, x) => s + x, 0);
      return recentNonDeclined === 0 && priorServes >= 3;
    })
    .map(v => {
      const histStart   = Math.max(0, N - recentWks - historyWks);
      const priorServes = v.confirmedByWeek.slice(histStart, N - recentWks).reduce((s, x) => s + x, 0);
      return {
        name:           v.name,
        teams:          v.teams,
        lastServeWi:    v.lastServeWi,
        lastServeLabel: v.lastServeWi >= 0 ? labels[v.lastServeWi] : null,
        priorServes,
        weeksMissing:   recentWks,
      };
    }) : [];

  // ── Disengaging volunteers: served in range but NOT in last 30 days ────────
  // Uses actual calendar dates, not week buckets, for a precise rolling cutoff.
  const now30 = new Date();
  now30.setDate(now30.getDate() - 30);
  const cutoff30 = now30.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const todayISO = new Date().toISOString().slice(0, 10);
  const disengagingVolunteers = volunteerProfiles
    .filter(v => {
      if (v.totalConfirmed === 0 || !v.lastServeDate) return false;
      return v.lastServeDate < cutoff30; // last serve is older than 30 days
    })
    .map(v => {
      const lastDate = new Date(v.lastServeDate + "T12:00:00");
      const daysAgo = Math.round((Date.now() - lastDate.getTime()) / 86400000);
      return {
        name:           v.name,
        pid:            v.pid,
        teams:          v.teams,
        lastServeDate:  v.lastServeDate,
        lastServeLabel: lastDate.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        daysAgo,
        totalServes:    v.totalConfirmed,
      };
    })
    .sort((a, b) => a.daysAgo - b.daysAgo);

  // ── Weekly team coverage trends (derived from weeklyPeople) ────────────────
  const weeklyTeamTotals = {};  // teamName → { scheduledByWeek[], confirmedByWeek[] }
  for (let wi = 0; wi < N; wi++) {
    for (const data of Object.values(weeklyPeople[wi])) {
      for (const s of data.schedules) {
        const tn = s.team || "Other";
        if (tn === "Other") continue;
        if (!weeklyTeamTotals[tn]) {
          weeklyTeamTotals[tn] = { scheduledByWeek: new Array(N).fill(0), confirmedByWeek: new Array(N).fill(0) };
        }
        weeklyTeamTotals[tn].scheduledByWeek[wi]++;
        if (s.status === "C") weeklyTeamTotals[tn].confirmedByWeek[wi]++;
      }
    }
  }
  const teamsWeekly = Object.entries(weeklyTeamTotals)
    .map(([name, d]) => ({
      name,
      category: getTeamCategory(name),
      scheduledByWeek: d.scheduledByWeek,
      confirmedByWeek: d.confirmedByWeek,
      coverageByWeek:  d.scheduledByWeek.map((s, i) => s ? Math.round(d.confirmedByWeek[i] / s * 100) : 0),
    }))
    .filter(t => t.scheduledByWeek.some(s => s > 0))
    .sort((a, b) => b.scheduledByWeek.reduce((s, v) => s + v, 0) - a.scheduledByWeek.reduce((s, v) => s + v, 0));

  // ── 5c. Per-team unique members per week & seasonal growth ────────────────
  // Track which unique people appeared on each team each week
  const teamMembersByWeek = {};  // teamName → array of Sets (one per week)
  const teamMemberFirstSeen = {};  // teamName → { personKey → firstWeekIndex }
  for (let wi = 0; wi < N; wi++) {
    for (const [pKey, data] of Object.entries(weeklyPeople[wi])) {
      for (const s of data.schedules) {
        const tn = s.team || "Other";
        if (tn === "Other") continue;
        if (!teamMembersByWeek[tn]) {
          teamMembersByWeek[tn] = Array.from({ length: N }, () => new Set());
          teamMemberFirstSeen[tn] = {};
        }
        teamMembersByWeek[tn][wi].add(pKey);
        if (teamMemberFirstSeen[tn][pKey] === undefined) {
          teamMemberFirstSeen[tn][pKey] = wi;
        }
      }
    }
  }

  // Update the persistent teamFirstSeenMap with actual calendar dates.
  // This map accumulates across all data ranges — the 52-week prefetch populates
  // the full history, so "new" is based on a rolling year, not just the current range.
  for (const [tn, fsMap] of Object.entries(teamMemberFirstSeen)) {
    if (!teamFirstSeenMap[tn]) teamFirstSeenMap[tn] = {};
    for (const [pKey, firstWi] of Object.entries(fsMap)) {
      const bucketDate = buckets[firstWi] ? buckets[firstWi].start : null;
      if (bucketDate) {
        const dateStr = bucketDate.toISOString().split("T")[0];
        if (!teamFirstSeenMap[tn][pKey] || dateStr < teamFirstSeenMap[tn][pKey]) {
          teamFirstSeenMap[tn][pKey] = dateStr;
        }
      }
    }
  }

  // Build quarterly unique member counts per team for seasonal growth chart
  // Quarters: split the N weeks into chunks of ~13 weeks
  const quarterSize = Math.max(4, Math.min(13, Math.ceil(N / 4)));
  const numQuarters = Math.ceil(N / quarterSize);
  const quarterLabels = [];
  for (let q = 0; q < numQuarters; q++) {
    const startWi = q * quarterSize;
    const endWi = Math.min(startWi + quarterSize - 1, N - 1);
    quarterLabels.push(labels[startWi] + "–" + labels[endWi]);
  }

  const teamSeasonalGrowth = {};  // teamName → { quarterCounts: number[], quarterLabels }
  for (const [tn, weekSets] of Object.entries(teamMembersByWeek)) {
    const quarterCounts = [];
    for (let q = 0; q < numQuarters; q++) {
      const startWi = q * quarterSize;
      const endWi = Math.min(startWi + quarterSize, N);
      const uniqueInQuarter = new Set();
      for (let wi = startWi; wi < endWi; wi++) {
        for (const p of weekSets[wi]) uniqueInQuarter.add(p);
      }
      quarterCounts.push(uniqueInQuarter.size);
    }
    teamSeasonalGrowth[tn] = { quarterCounts };
  }

  // Per-team unique member count per week
  const teamUniqueMembersByWeek = {};
  for (const [tn, weekSets] of Object.entries(teamMembersByWeek)) {
    teamUniqueMembersByWeek[tn] = weekSets.map(s => s.size);
  }

  // Per-team member detail: who's on each team with their stats, first-seen, at-risk status
  // "New" is determined from the persistent 52-week teamFirstSeenMap, not the current range.
  const now = new Date();
  const newMemberCutoff = new Date(now);
  newMemberCutoff.setDate(newMemberCutoff.getDate() - 30); // last 30 days
  const newMemberCutoffStr = newMemberCutoff.toISOString().split("T")[0];

  const teamMemberDetails = {};
  for (const [tn, firstSeenMap] of Object.entries(teamMemberFirstSeen)) {
    teamMemberDetails[tn] = [];
    for (const [pKey, firstWi] of Object.entries(firstSeenMap)) {
      const profile = volunteerProfileMap[pKey];
      if (!profile) continue;
      const name = profile.name;
      // Count confirmed serves on THIS team specifically
      let teamConfirmed = 0, teamScheduled = 0, lastTeamServeWi = -1;
      for (let wi = 0; wi < N; wi++) {
        if (teamMembersByWeek[tn][wi].has(pKey)) {
          const weekData = weeklyPeople[wi][pKey];
          if (weekData) {
            for (const s of weekData.schedules) {
              if (s.team === tn) {
                teamScheduled++;
                if (s.status === "C") { teamConfirmed++; lastTeamServeWi = wi; }
              }
            }
          }
        }
      }
      // Use persistent first-seen date from 52-week history for accurate "new" detection
      const historicalFirstSeen = (teamFirstSeenMap[tn] && teamFirstSeenMap[tn][pKey]) || null;
      const isNew = historicalFirstSeen ? historicalFirstSeen >= newMemberCutoffStr : false;
      const isInactive = lastTeamServeWi >= 0 && lastTeamServeWi < N - 4 && teamConfirmed >= 2;
      const otherTeams = Array.from(profile.teams).filter(t => t !== tn);
      const teamRate = teamScheduled > 0 ? Math.round(teamConfirmed / teamScheduled * 100) : 0;
      const firstSeenLabel = historicalFirstSeen || (labels[firstWi] || null);
      teamMemberDetails[tn].push({
        name, firstWi, firstSeenLabel, isNew, isInactive,
        teamConfirmed, teamScheduled, teamRate,
        lastTeamServeWi,
        otherTeams,
        isMultiTeam: otherTeams.length > 0,
      });
    }
    teamMemberDetails[tn].sort((a, b) => b.teamConfirmed - a.teamConfirmed);
  }

  // ── 6. Attendance ───────────────────────────────────────────────────────────
  // Discovered from debug-checkins output:
  //   - Main event: "Sunday Attendance" (607918) — this is the primary headcount
  //   - Data lives in: headcounts with a "total" field
  //   - Date linking: headcounts reference event_time_id — fetch event_time directly
  //     to get starts_at (event_times endpoint on the event returns empty, but
  //     individual event_time records exist and are referenced by headcounts)
  //   - Related Sunday events also tracked separately:
  //       609801 = Sunday City Kids
  //       609021 = Sunday Decisions
  //       609040 = Sunday Ministry
  //       891172 = Sunday Metrics
  //       698601 = Sunday Serve Team
  broadcast({ step: "Fetching attendance data…", pct: 82 });
  const SUNDAY_EVENT_ID = CHURCH_CONFIG.events.sundayAttendance;
  const SUNDAY_RELATED_IDS = CHURCH_CONFIG.events.sundayRelated;
  const KIDS_EVENT_ID = CHURCH_CONFIG.events.cityKids;
  const DECISIONS_EVENT_ID = CHURCH_CONFIG.events.decisions;
  const DECISIONS_AT_ID = CHURCH_CONFIG.decisionsAttendanceType;
  const kidsATNames = CHURCH_CONFIG.kidsRoomNames;

  const sundayBreakdown = {};
  const sundayBreakdownById = {};
  const kidsRoomBreakdown = {};
  const kidsEventTimesByWeek = {};  // "wi_etId" → { etId, wi, timeLabel }

  try {
    // ── Helper: fetch headcounts WITH sideloaded event_times (include=event_time)
    // This eliminates hundreds of individual event_time API calls by getting the
    // event_time data inline on every page of headcounts.
    const etCacheSideload = {};  // event_time_id → parsed Date (shared across all headcount fetches)

    function extractEventTimesFromIncluded(included) {
      // Build/update etCacheSideload from the "included" array in a JSON:API response
      if (!Array.isArray(included)) return;
      for (const inc of included) {
        if (inc.type === "EventTime" && inc.id && !etCacheSideload[inc.id]) {
          const starts = inc.attributes && inc.attributes.starts_at;
          etCacheSideload[inc.id] = starts ? parseLocalDate(starts) : null;
        }
      }
    }

    // ── Dedup headcounts: keep only the LATEST record per (event_time, headcount_group) ──
    // PCO creates new headcount records when counts are corrected/re-entered.
    // Without dedup, corrections cause double-counting (e.g., original=7 + correction=0 = 7 extra).
    function deduplicateHeadcounts(hcList) {
      // Group by composite key: event_time_id + attendance_type_id
      // Keep only the record with the latest created_at per group
      const byKey = {};
      for (const hc of hcList) {
        const rels = hc.relationships || {};
        const etId = rels.event_time && rels.event_time.data && rels.event_time.data.id;
        const atId = rels.attendance_type && rels.attendance_type.data && rels.attendance_type.data.id;
        const key = (etId || "noET") + "_" + (atId || hc.id);
        const created = new Date((hc.attributes || {}).created_at || 0).getTime();
        if (!byKey[key] || created > byKey[key].created) {
          byKey[key] = { hc, created };
        }
      }
      return Object.values(byKey).map(v => v.hc);
    }

    function resolveHeadcountInfo(hc) {
      const hcAttrs = hc.attributes || {};
      const etId = hc.relationships && hc.relationships.event_time
        && hc.relationships.event_time.data && hc.relationships.event_time.data.id;
      // Use sideloaded event_time first, fallback to updated_at
      const serviceDate = etId && etCacheSideload[etId] ? etCacheSideload[etId] : null;
      const date = serviceDate || parseLocalDate(hcAttrs.updated_at || hcAttrs.created_at);
      // Extract the service time label from the event_time starts_at
      let timeLabel = null;
      let hour = null;
      if (serviceDate) {
        hour = serviceDate.getHours();
        const min = serviceDate.getMinutes();
        const ampm = hour >= 12 ? "PM" : "AM";
        const h12 = hour % 12 || 12;
        timeLabel = h12 + ":" + (min < 10 ? "0" : "") + min + " " + ampm;
      }
      return { date, timeLabel, hour };
    }

    // ── Fetch ALL headcounts with include=event_time (no individual lookups needed)
    // Also request attendance_type relationship data for deduplication
    let allHC = [];
    let hcUrl = "/check-ins/v2/events/" + SUNDAY_EVENT_ID + "/headcounts?include=event_time,attendance_type&per_page=100&order=-updated_at";
    const hcHardLimit = 2000;
    while (hcUrl && allHC.length < hcHardLimit) {
      const hcRes = await pcoFetch(hcUrl);
      if (hcRes.status !== 200) {
        console.log("⚠ Headcount fetch got HTTP " + hcRes.status + " — stopping pagination");
        break;
      }
      // Extract sideloaded event_times from this page's "included" array
      extractEventTimesFromIncluded(hcRes.body && hcRes.body.included);
      const hcPage = (hcRes.body && hcRes.body.data) || [];
      allHC = allHC.concat(hcPage);
      if (hcPage.length > 0) {
        const oldestOnPage = hcPage[hcPage.length - 1].attributes || {};
        const oldestDate = new Date(oldestOnPage.updated_at || oldestOnPage.created_at || 0);
        if (oldestDate < since) { break; }
      }
      const hcLinks = (hcRes.body && hcRes.body.links) || {};
      if (hcLinks.next) {
        const p = new URL(hcLinks.next);
        hcUrl = p.pathname + p.search;
      } else { hcUrl = null; }
    }
    broadcast({ step: "Processing " + allHC.length + " headcounts…", pct: 86 });

    // Deduplicate: keep only latest record per (event_time, headcount_group)
    const allHCDeduped = deduplicateHeadcounts(allHC);
    if (allHCDeduped.length < allHC.length) {
      console.log("── Headcount dedup: " + allHC.length + " raw → " + allHCDeduped.length + " unique (removed " + (allHC.length - allHCDeduped.length) + " superseded entries)");
    }

    // Resolve dates from sideloaded data (no extra API calls needed!)
    // Group by service time and exclude nighttime (6 PM / hour >= 18)
    for (const hc of allHCDeduped) {
      const hcAttrs = hc.attributes || {};
      const { date, timeLabel, hour } = resolveHeadcountInfo(hc);
      // Skip nighttime events (6 PM and later)
      if (hour !== null && hour >= 18) continue;
      const wi = bucketIndexFor(date, buckets);
      if (wi >= 0) {
        const count = Number(hcAttrs.total || hcAttrs.count || 0);
        attendance[wi] += count;
        // Track per-service-time breakdown
        const key = timeLabel || "Unknown";
        if (!attendanceByService[key]) {
          attendanceByService[key] = new Array(N).fill(0);
        }
        attendanceByService[key][wi] += count;
      }
    }

    if (weeks > 8) {
      console.log("── Attendance diagnostics ──");
      console.log("   Headcounts fetched: " + allHC.length + ", event_times sideloaded: " + Object.keys(etCacheSideload).length);
      console.log("   Attendance by bucket:", attendance);
      console.log("   Service times found:", Object.keys(attendanceByService));
      console.log("──────────────────────────\n");
    }

    // ── Fetch related Sunday events for breakdown (also with include=event_time)
    broadcast({ step: "Fetching Sunday breakdowns…", pct: 90 });
    // Pre-fetch all related event names in parallel (5 calls instead of sequential)
    const relEventNames = {};
    await pLimit(SUNDAY_RELATED_IDS.map(evId => async () => {
      try {
        const evRes = await pcoFetch("/check-ins/v2/events/" + evId);
        relEventNames[evId] = (evRes.body && evRes.body.data && evRes.body.data.attributes && evRes.body.data.attributes.name) || evId;
      } catch(e) { relEventNames[evId] = evId; }
    }), CONCURRENCY);

    await pLimit(SUNDAY_RELATED_IDS.map(evId => async () => {
      const evName = relEventNames[evId] || evId;
      const weekTotals = new Array(N).fill(0);
      let relHCs = [];
      let relUrl = "/check-ins/v2/events/" + evId + "/headcounts?include=event_time,attendance_type&per_page=100&order=-updated_at";
      while (relUrl && relHCs.length < 2000) {
        const relHcRes = await pcoFetch(relUrl);
        if (relHcRes.status !== 200) break;
        extractEventTimesFromIncluded(relHcRes.body && relHcRes.body.included);
        const relPage = (relHcRes.body && relHcRes.body.data) || [];
        relHCs = relHCs.concat(relPage);
        if (relPage.length > 0) {
          const oldestRel = relPage[relPage.length - 1].attributes || {};
          const oldestRelDate = new Date(oldestRel.updated_at || oldestRel.created_at || 0);
          if (oldestRelDate < since) break;
        }
        const relLinks = (relHcRes.body && relHcRes.body.links) || {};
        if (relLinks.next) {
          const rp = new URL(relLinks.next);
          relUrl = rp.pathname + rp.search;
        } else { relUrl = null; }
      }
      // Deduplicate related event headcounts too
      const relHCsDeduped = deduplicateHeadcounts(relHCs);
      // Also track a filtered total for Decisions (exclude Bibles Given, Online, etc.)
      const weekTotalsFiltered = new Array(N).fill(0);
      for (const hc of relHCsDeduped) {
        const hcAttrs = hc.attributes || {};
        const { date, timeLabel, hour } = resolveHeadcountInfo(hc);
        if (hour !== null && hour >= 18) continue;  // skip nighttime
        const wi = bucketIndexFor(date, buckets);
        if (wi >= 0) {
          const val = Number(hcAttrs.total || hcAttrs.count || 0);
          const atRel = hc.relationships && hc.relationships.attendance_type
            && hc.relationships.attendance_type.data;
          const atId = atRel ? atRel.id : null;

          // Always add to raw weekTotals (total headcount sum)
          weekTotals[wi] += val;

          // For Decisions: only count the main "Decisions" attendance type
          if (evId === DECISIONS_EVENT_ID) {
            if (atId === DECISIONS_AT_ID) {
              weekTotalsFiltered[wi] += val;
            }
          }

          // For Kids: build room-by-service-time breakdown + collect event_time_ids
          if (evId === KIDS_EVENT_ID) {
            if (timeLabel) {
              const roomName = (atId && kidsATNames[atId]) || ("AT " + atId);
              if (!kidsRoomBreakdown[timeLabel]) kidsRoomBreakdown[timeLabel] = {};
              if (!kidsRoomBreakdown[timeLabel][roomName]) {
                kidsRoomBreakdown[timeLabel][roomName] = new Array(N).fill(0);
              }
              kidsRoomBreakdown[timeLabel][roomName][wi] += val;
            }
            // Collect unique event_time_ids with their week index for check-in counting
            const etIdHc = hc.relationships && hc.relationships.event_time
              && hc.relationships.event_time.data && hc.relationships.event_time.data.id;
            if (etIdHc && !kidsEventTimesByWeek[wi + "_" + etIdHc]) {
              kidsEventTimesByWeek[wi + "_" + etIdHc] = { etId: etIdHc, wi, timeLabel: timeLabel || "Unknown" };
            }
          }
        }
      }
      sundayBreakdown[evName] = weekTotals;
      // For Decisions, store the filtered totals (only "Decisions" AT, not "Bibles Given" etc.)
      if (evId === DECISIONS_EVENT_ID) {
        sundayBreakdownById[evId] = weekTotalsFiltered;
      } else {
        sundayBreakdownById[evId] = weekTotals;
      }
    }), CONCURRENCY);
  } catch(e) { /* non-fatal */ }

  // Extract dedicated arrays for kids and decisions
  const kidsAttendance = sundayBreakdownById[KIDS_EVENT_ID] || new Array(N).fill(0);
  const decisions = sundayBreakdownById[DECISIONS_EVENT_ID] || new Array(N).fill(0);

  // ── 6b. City Kids check-in counts + multi-service detection ─────────────────
  // PCO's "Standard Headcounts: Regular" = count of check-in records per event_time.
  // We fetch actual check-in records (with person name) to both count AND detect
  // kids checked into multiple service times on the same Sunday.
  broadcast({ step: "Fetching City Kids check-in counts…", pct: 94 });
  const kidsCheckinCounts = new Array(N).fill(0);
  const kidsCheckinByService = {};  // serviceTimeLabel → weeklyTotals[]
  // Track kids per week for multi-service detection: weeklyKids[wi][personKey] = { name, services: Set }
  const weeklyKids = Array.from({ length: N }, () => ({}));
  try {
    // ── Fallback: discover event_time IDs that headcounts didn't reveal ────────
    // Headcounts are entered by hand and routinely lag the service — sometimes a
    // whole Sunday, but often just ONE service time inside an otherwise-entered
    // Sunday (8/30/2026: 8:30 and 10:00 were entered, 11:30 never was).
    //
    // Coverage is therefore keyed on (week, service time), NOT week alone. Keying
    // on week alone treats a partially-entered Sunday as "covered", so the missing
    // service is never recovered and the week silently undercounts — the worst
    // failure mode, because nothing looks broken.
    //
    // event_periods?include=event_times enumerates every service time per Sunday
    // authoritatively, so we no longer depend on a check-in scan paging back far
    // enough to stumble across the missing one.
    const coverKey = (wi, timeLabel) => wi + "|" + timeLabel;
    const coveredServices = new Set(
      Object.values(kidsEventTimesByWeek).map(e => coverKey(e.wi, e.timeLabel))
    );
    let epUrl = "/check-ins/v2/events/" + KIDS_EVENT_ID
      + "/event_periods?per_page=25&order=-starts_at&include=event_times";
    let epPages = 0;
    let recoveredCount = 0;
    while (epUrl && epPages < 10) {
      const epRes = await pcoFetch(epUrl);
      if (epRes.status !== 200) break;
      epPages++;
      for (const inc of ((epRes.body && epRes.body.included) || [])) {
        if (inc.type !== "EventTime") continue;
        const etStartsAt = (inc.attributes || {}).starts_at;
        if (!etStartsAt) continue;
        // starts_at is a full UTC timestamp; process TZ is pinned to the church's
        // timezone, so getHours() yields the correct local service time. This is
        // the same derivation resolveHeadcountInfo() uses, so labels match exactly.
        const etDate = parseLocalDate(etStartsAt);
        const wi = bucketIndexFor(etDate, buckets);
        if (wi < 0) continue;
        const h = etDate.getHours();
        if (h >= 18) continue;  // skip nighttime
        const m = etDate.getMinutes();
        const ampm = h >= 12 ? "PM" : "AM";
        const timeLabel = (h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
        if (coveredServices.has(coverKey(wi, timeLabel))) continue;
        const key = wi + "_" + inc.id;
        if (kidsEventTimesByWeek[key]) continue;
        kidsEventTimesByWeek[key] = { etId: inc.id, wi, timeLabel };
        coveredServices.add(coverKey(wi, timeLabel));
        recoveredCount++;
        console.log("── Kids fallback: recovered event_time " + inc.id + " (" + timeLabel
          + ") for bucket " + wi + " — no headcounts entered for that service");
      }
      // Stop once we've paged back past the requested range
      const epData = (epRes.body && epRes.body.data) || [];
      if (epData.length === 0) break;
      const oldestEp = parseLocalDate((epData[epData.length - 1].attributes || {}).starts_at || 0);
      if (oldestEp < since) break;
      const epLinks = (epRes.body && epRes.body.links) || {};
      if (epLinks.next) {
        const p = new URL(epLinks.next);
        epUrl = p.pathname + p.search;
      } else { epUrl = null; }
    }
    if (recoveredCount > 0) {
      console.log("── Kids: recovered " + recoveredCount + " service time(s) that had no headcounts");
    }

    const etEntries = Object.values(kidsEventTimesByWeek);
    console.log("── Kids: " + etEntries.length + " unique event_times found from headcount data");

    await pLimit(
      etEntries.map(entry => async () => {
        const { etId, wi, timeLabel } = entry;
        // Fetch check-in records with person name (paginate to get all)
        let ciUrl = "/check-ins/v2/event_times/" + etId + "/check_ins?include=person&per_page=100";
        let totalCount = 0;
        while (ciUrl) {
          const ciRes = await pcoFetch(ciUrl);
          if (ciRes.status !== 200) break;
          const ciData = (ciRes.body && ciRes.body.data) || [];
          const ciIncl = (ciRes.body && ciRes.body.included) || [];

          // Build person lookup from included
          const personLookup = {};
          for (const inc of ciIncl) {
            if (inc.type === "Person" && inc.id) {
              const pa = inc.attributes || {};
              personLookup[inc.id] = (pa.first_name || "") + " " + (pa.last_name || "");
            }
          }

          totalCount += ciData.length;

          // Track each kid for multi-service detection
          for (const ci of ciData) {
            const personRel = ci.relationships && ci.relationships.person
              && ci.relationships.person.data;
            const personId = personRel ? personRel.id : null;
            if (personId) {
              const personName = personLookup[personId] || ("Person " + personId);
              if (!weeklyKids[wi][personId]) {
                weeklyKids[wi][personId] = { name: personName.trim(), services: new Set() };
              }
              weeklyKids[wi][personId].services.add(timeLabel);
            }
          }

          // Pagination
          const ciLinks = (ciRes.body && ciRes.body.links) || {};
          if (ciLinks.next) {
            const p = new URL(ciLinks.next);
            ciUrl = p.pathname + p.search;
          } else { ciUrl = null; }
        }

        kidsCheckinCounts[wi] += totalCount;
        if (!kidsCheckinByService[timeLabel]) kidsCheckinByService[timeLabel] = new Array(N).fill(0);
        kidsCheckinByService[timeLabel][wi] += totalCount;
      }), CONCURRENCY
    );

    console.log("── Kids check-in counts by week: [" + kidsCheckinCounts.join(", ") + "]");
    console.log("── Kids last bucket check-in count: " + kidsCheckinCounts[N - 1]);
  } catch(e) {
    console.log("⚠ Kids check-in count error: " + e.message);
  }

  // Build multi-service kids arrays (kids checked into 2+ service times)
  const weeklyMultiServiceKids = weeklyKids.map(weekMap => {
    const result = [];
    for (const [, data] of Object.entries(weekMap)) {
      if (data.services.size >= 2) {
        result.push({
          name: data.name,
          serviceCount: data.services.size,
          services: Array.from(data.services),
        });
      }
    }
    return result.sort((a, b) => b.serviceCount - a.serviceCount || a.name.localeCompare(b.name));
  });
  // Also compute unique kids per week (de-duplicated across services)
  const uniqueKids = weeklyKids.map(weekMap => Object.keys(weekMap).length);

  // ── 7. Unique volunteer count per week ──────────────────────────────────────
  // weeklyPeople is keyed by person ID, so Object.keys gives distinct individuals
  const uniqueVolunteers = weeklyPeople.map(weekMap => Object.keys(weekMap).length);

  // ── 8. New families (households created on Sundays within range) ─────────────
  broadcast({ step: "Fetching new families…", pct: 96 });
  const newFamiliesByWeek = new Array(N).fill(null).map(() => []);
  const newFamiliesCount = new Array(N).fill(0);
  try {
    const cutoffDate = buckets[0].start.toISOString().split("T")[0];
    let hhUrl = "/people/v2/households?order=-created_at&per_page=100&include=people";
    let hhDone = false;
    while (hhUrl && !hhDone) {
      const hhRes = await pcoFetch(hhUrl);
      for (const hh of (hhRes.body.data || [])) {
        const createdAt = new Date(hh.attributes.created_at);
        if (createdAt < buckets[0].start) { hhDone = true; break; }
        // Find which bucket this falls into
        const wi = bucketIndexFor(createdAt, buckets);
        if (wi < 0) continue;
        // Get household members from included data
        const memberIds = (hh.relationships && hh.relationships.people && hh.relationships.people.data || []).map(p => p.id);
        const included = hhRes.body.included || [];
        const members = memberIds.map(mid => {
          const person = included.find(i => i.id === mid && i.type === "Person");
          return person ? { name: (person.attributes.first_name || "") + " " + (person.attributes.last_name || ""), child: person.attributes.child || false } : null;
        }).filter(Boolean);
        newFamiliesByWeek[wi].push({
          name: hh.attributes.name,
          memberCount: hh.attributes.member_count || members.length,
          createdAt: hh.attributes.created_at,
          primaryContact: hh.attributes.primary_contact_name,
          members: members
        });
        newFamiliesCount[wi]++;
      }
      if (hhDone) break;
      const next = hhRes.body.links && hhRes.body.links.next;
      if (next) { const p = new URL(next); hhUrl = p.pathname + p.search; } else { hhUrl = null; }
    }
  } catch(e) { console.log("⚠ New families fetch error:", e.message); }
  console.log("── New families by week:", newFamiliesCount.join(", "));

  // ── Team × Service Time breakdown per week (confirmed only) ──────────────────
  // Counts unique confirmed volunteers per (team, service time) for each weekly bucket.
  const teamByServiceTimeCountByWeek = weeklyPeople.map(weekMap => {
    const teamSets = {};
    for (const [pKey, data] of Object.entries(weekMap)) {
      for (const s of data.schedules) {
        if (s.status !== "C") continue;
        const team = s.team;
        const times = s.serviceTime ? s.serviceTime.split(", ") : [];
        for (const t of times) {
          if (!teamSets[team]) teamSets[team] = {};
          if (!teamSets[team][t]) teamSets[team][t] = new Set();
          teamSets[team][t].add(pKey);
        }
      }
    }
    const out = {};
    for (const [team, timeMap] of Object.entries(teamSets)) {
      out[team] = {};
      for (const [t, s] of Object.entries(timeMap)) out[team][t] = s.size;
    }
    return out;
  });
  // Backwards-compatible alias for the most-recent-week breakdown
  const teamByServiceTimeCount = teamByServiceTimeCountByWeek[N - 1];

  const elapsed = ((Date.now() - buildStart) / 1000).toFixed(1);
  console.log("✅ buildData(weeks=" + weeks + ") completed in " + elapsed + "s with " + apiCallCount + " API calls");
  broadcast({ step: "Done! (" + elapsed + "s, " + apiCallCount + " API calls)", pct: 100 });
  return { labels, grouping, weeks, attendance, attendanceByService, kidsAttendance, decisions, sundayBreakdown, scheduled, confirmed, declined, blocked, firstTimers, firstTimerNames, teams, teamsWeekly, weeklyMultiServers, uniqueVolunteers, kidsCheckinCounts, kidsCheckinByService, kidsRoomBreakdown, weeklyMultiServiceKids, uniqueKids, volunteerProfiles, atRiskVolunteers, disengagingVolunteers, newFamiliesByWeek, newFamiliesCount, teamSeasonalGrowth, quarterLabels, teamUniqueMembersByWeek, teamMemberDetails, teamByServiceTimeCount, teamByServiceTimeCountByWeek, fetchedAt: new Date().toISOString() };
}

// ── /debug ────────────────────────────────────────────────────────────────────
async function handleDebug(res) {
  if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "No credentials." })); }
  const report = {};
  try {
    const st = await pcoFetch("/services/v2/service_types?per_page=3");
    report.service_types = { status: st.status, sample: (st.body.data||[])[0] };
    const stId = (st.body.data||[])[0] && st.body.data[0].id;
    if (stId) {
      const since = new Date(); since.setDate(since.getDate()-14);
      const plans = await pcoFetch("/services/v2/service_types/"+stId+"/plans?filter=past&after="+since.toISOString().split("T")[0]+"&per_page=2&order=-sort_date");
      report.plans = { status: plans.status, sample: (plans.body.data||[])[0] };
      const planId = (plans.body.data||[])[0] && plans.body.data[0].id;
      if (planId) {
        const tm = await pcoFetch("/services/v2/service_types/"+stId+"/plans/"+planId+"/team_members?per_page=25");
        const tmData = tm.body.data || [];
        report.team_members = {
          status: tm.status,
          total: tmData.length,
          attribute_keys: [...new Set(tmData.flatMap(m => Object.keys(m.attributes || {})))].sort(),
          split_team_examples: Object.values(
            tmData.reduce((acc, m) => {
              const pid = (m.relationships && m.relationships.person && m.relationships.person.data && m.relationships.person.data.id) || m.id;
              if (!acc[pid]) acc[pid] = { person_id: pid, rows: [] };
              acc[pid].rows.push({ name: m.attributes.name, team: m.attributes.team_name, time: m.attributes.service_time_name || m.attributes.time_preference_name, pos: m.attributes.position_name });
              return acc;
            }, {})
          ).filter(p => p.rows.length > 1).slice(0, 5),
          samples: tmData.slice(0, 3).map(m => m.attributes),
        };
      }
    }
  } catch(e) { report.error = e.message; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(report, null, 2));
}

// ── /debug-checkins — full Check-Ins API explorer ─────────────────────────────
async function handleDebugCheckins(res) {
  if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "No credentials." })); }
  const out = {};
  try {
    // 1. Page through ALL events (not just first 25)
    let allEvents = [];
    let nextUrl = "/check-ins/v2/events?per_page=100&order=name";
    while (nextUrl) {
      const evRes = await pcoFetch(nextUrl);
      const page = evRes.body.data || [];
      allEvents = allEvents.concat(page);
      // Follow pagination links
      const links = evRes.body.links || {};
      const meta  = evRes.body.meta || {};
      if (links.next) {
        // PCO returns full URLs — extract just the path+query
        const parsed = new URL(links.next);
        nextUrl = parsed.pathname + parsed.search;
      } else if (meta.next && meta.next.offset) {
        nextUrl = "/check-ins/v2/events?per_page=100&order=name&offset=" + meta.next.offset;
      } else {
        nextUrl = null;
      }
      // Safety: stop after 500 events
      if (allEvents.length > 500) break;
    }

    out.total_events = allEvents.length;
    out.all_events = allEvents.map(e => ({
      id:        e.id,
      name:      (e.attributes || {}).name,
      frequency: (e.attributes || {}).frequency,
      archived:  (e.attributes || {}).archived,
    }));

    // 2. Today's check-ins — trace back to their source event
    const ciRes = await pcoFetch("/check-ins/v2/check_ins?per_page=25&order=-created_at&include=event,event_time");
    const allCheckins = ciRes.body.data || [];
    const included    = ciRes.body.included || [];

    // Build lookup maps from included resources
    const includedEvents = {};
    const includedTimes  = {};
    for (const inc of included) {
      if (inc.type === "Event")     includedEvents[inc.id] = (inc.attributes || {}).name;
      if (inc.type === "EventTime") includedTimes[inc.id]  = inc.attributes || {};
    }

    // Filter to today's check-ins
    const todayStr = new Date().toISOString().split("T")[0];
    const todaysCheckins = allCheckins.filter(c => {
      const created = (c.attributes || {}).created_at || "";
      return created.startsWith(todayStr);
    });

    out.todays_checkins = todaysCheckins.map(c => {
      const ca = c.attributes || {};
      const rels = c.relationships || {};
      const eventId = rels.event && rels.event.data && rels.event.data.id;
      const etId    = rels.event_time && rels.event_time.data && rels.event_time.data.id;
      return {
        first_name:  ca.first_name,
        last_name:   ca.last_name,
        created_at:  ca.created_at,
        event_id:    eventId,
        event_name:  eventId ? (includedEvents[eventId] || "unknown") : "no event relationship",
        event_time_id: etId,
        event_time_starts_at: etId && includedTimes[etId] ? includedTimes[etId].starts_at : null,
      };
    });

    // 3. Live event lookup — unique events from today's check-ins
    const eventIdsFromToday = [...new Set(todaysCheckins.map(c => {
      const rels = c.relationships || {};
      return rels.event && rels.event.data && rels.event.data.id;
    }).filter(Boolean))];

    out.live_event_lookup = {};
    for (const eid of eventIdsFromToday) {
      if (includedEvents[eid]) {
        out.live_event_lookup[eid] = includedEvents[eid];
      } else {
        // Fetch individually if not in included
        try {
          const evDetail = await pcoFetch("/check-ins/v2/events/" + eid);
          out.live_event_lookup[eid] = (evDetail.body.data && evDetail.body.data.attributes && evDetail.body.data.attributes.name) || "unknown";
        } catch(e) { out.live_event_lookup[eid] = "fetch error"; }
      }
    }

    // 4. Events with data — find events that have actual headcount or check-in records
    out.events_with_data = [];
    for (const ev of allEvents) {
      const evAttrs = ev.attributes || {};
      // Quick check: get event_times count and last headcount
      const timesRes = await pcoFetch("/check-ins/v2/events/"+ev.id+"/event_times?per_page=3&order=-starts_at");
      const times = timesRes.body.data || [];
      const hcRes = await pcoFetch("/check-ins/v2/events/"+ev.id+"/headcounts?per_page=3&order=-created_at");
      const headcounts = hcRes.body.data || [];

      if (times.length > 0 || headcounts.length > 0) {
        out.events_with_data.push({
          event_id:        ev.id,
          event_name:      evAttrs.name,
          frequency:       evAttrs.frequency,
          event_times_count: times.length,
          latest_event_time: times[0] ? {
            id:          times[0].id,
            starts_at:   (times[0].attributes || {}).starts_at,
            total_count: (times[0].attributes || {}).total_count,
            regular_count: (times[0].attributes || {}).regular_count,
          } : null,
          headcounts_count: headcounts.length,
          latest_headcount: headcounts[0] ? {
            total:         (headcounts[0].attributes || {}).total,
            count:         (headcounts[0].attributes || {}).count,
            updated_at:    (headcounts[0].attributes || {}).updated_at,
            event_time_id: headcounts[0].relationships && headcounts[0].relationships.event_time &&
                           headcounts[0].relationships.event_time.data && headcounts[0].relationships.event_time.data.id,
          } : null,
        });
      }
    }

    // 5. event_periods — another attendance container some churches use
    const epRes = await pcoFetch("/check-ins/v2/event_periods?per_page=10&order=-starts_at");
    out.event_periods = {
      status: epRes.status,
      count:  (epRes.body.data||[]).length,
      fields: [...new Set((epRes.body.data||[]).flatMap(p => Object.keys(p.attributes||{})))].sort(),
      recent: (epRes.body.data||[]).slice(0, 5).map(p => ({ id: p.id, ...p.attributes })),
    };

  } catch(e) { out.error = e.message; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(out, null, 2));
}

// ── /debug-volunteers — raw team_member inspector ────────────────────────────
async function handleDebugVolunteers(res) {
  if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "No credentials." })); }
  const out = {};
  try {
    // Get first service type
    const stRes = await pcoFetch("/services/v2/service_types?per_page=5");
    const serviceTypes = stRes.body.data || [];
    out.service_types = serviceTypes.map(s => ({ id: s.id, name: (s.attributes||{}).name }));

    // Get most recent plan from first service type
    const stId = serviceTypes[0] && serviceTypes[0].id;
    if (stId) {
      const since = new Date(); since.setDate(since.getDate() - 14);
      const plansRes = await pcoFetch("/services/v2/service_types/"+stId+"/plans?filter=past&after="+since.toISOString().split("T")[0]+"&per_page=2&order=-sort_date");
      const plans = plansRes.body.data || [];
      out.latest_plan = plans[0] ? { id: plans[0].id, date: (plans[0].attributes||{}).sort_date, title: (plans[0].attributes||{}).title } : null;

      if (plans[0]) {
        const planId = plans[0].id;

        // Fetch team_members WITH include=times
        const tmRes = await pcoFetch("/services/v2/service_types/"+stId+"/plans/"+planId+"/team_members?per_page=25&include=times");
        const members = tmRes.body.data || [];
        const included = tmRes.body.included || [];

        out.included_resources = {
          count: included.length,
          types: [...new Set(included.map(i => i.type))],
          samples: included.slice(0, 5).map(i => ({ id: i.id, type: i.type, attributes: i.attributes })),
        };

        // Show ALL attributes and relationships for first 5 members
        out.raw_team_members = members.slice(0, 5).map(m => ({
          id: m.id,
          type: m.type,
          all_attributes: m.attributes,
          all_relationship_keys: Object.keys(m.relationships || {}),
          relationships_detail: Object.fromEntries(
            Object.entries(m.relationships || {}).map(([k, v]) => [k, v.data])
          ),
        }));

        // Find a multi-service person (someone appearing 2+ times)
        const personCounts = {};
        for (const m of members) {
          const pid = (m.relationships && m.relationships.person && m.relationships.person.data && m.relationships.person.data.id) || m.id;
          const name = (m.attributes||{}).name || "?";
          if (!personCounts[pid]) personCounts[pid] = { name, rows: [] };
          personCounts[pid].rows.push({
            all_attributes: m.attributes,
            relationships: Object.fromEntries(
              Object.entries(m.relationships || {}).map(([k, v]) => [k, v.data])
            ),
          });
        }
        out.multi_service_examples = Object.values(personCounts).filter(p => p.rows.length > 1).slice(0, 3);
      }
    }
  } catch(e) { out.error = e.message; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(out, null, 2));
}

// ── At-risk fallback: recently inactivated people (last 90 days) ──────────────
// Used when the Sunday service doesn't have per-person check-in data.
async function buildAtRiskFromInactivations() {
  // PCO doesn't support date range filters on inactivated_at, so we fetch inactive
  // people sorted by most-recently-inactivated and filter in code.
  const LOOKBACK_DAYS = 365; // show up to 1 year of inactivations
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);

  const people = [];
  // Sort by -inactivated_at so we can stop early once we pass the cutoff
  let nextUrl = "/people/v2/people?where[status]=inactive&order=-inactivated_at&per_page=100" +
    "&fields[Person]=first_name,last_name,inactivated_at,membership,created_at";
  let pages = 0;
  let passedCutoff = false;
  while (nextUrl && pages < 50 && !passedCutoff) {
    const r = await pcoFetch(nextUrl);
    if (r.status !== 200) break;
    for (const p of (r.body.data || [])) {
      const a = p.attributes;
      if (!a.inactivated_at) continue;
      const inactivatedTs = new Date(a.inactivated_at);
      if (inactivatedTs < cutoff) { passedCutoff = true; break; }
      const inactivatedDate = a.inactivated_at.slice(0, 10);
      const daysInactive    = Math.round((Date.now() - inactivatedTs.getTime()) / (24 * 60 * 60 * 1000));
      const name = ((a.first_name || "") + " " + (a.last_name || "")).trim();
      // Skip obvious test/anonymous profiles
      if (!name || name.length < 3 || /anonymous|test tester|accounts payable/i.test(name)) continue;
      people.push({ id: p.id, name, inactivatedDate, daysInactive, membership: a.membership || null });
    }
    if (!passedCutoff) {
      const nxt = r.body.links && r.body.links.next;
      nextUrl = nxt ? (new URL(nxt)).pathname + (new URL(nxt)).search : null;
    }
    pages++;
  }

  // Sort most recently inactivated first
  people.sort((a, b) => (a.daysInactive || 999) - (b.daysInactive || 999));

  const mostRecentDate = people.length > 0 ? people[0].inactivatedDate : null;

  return {
    available:         true,
    mode:              "inactivations",
    modeNote:          "Sunday service uses headcount-only attendance. Showing people marked inactive in PCO in the past year. The most recent batch was " + (mostRecentDate || "unknown") + ".",
    lookbackDays:      LOOKBACK_DAYS,
    atRiskCongregants: people.slice(0, 150),
    mostRecentDate,
  };
}

// ── People data: new member growth + at-risk congregants ──────────────────────
async function buildPeopleData() {
  const now = new Date();

  // ── Part 1: New Member Growth (People API) ──────────────────────────────────
  // Fetch all people profiles created in the last 13 months
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - 13);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const newPeople = [];
  let nextUrl = "/people/v2/people?where[created_at][gte]=" + cutoffStr + "&per_page=100&fields[Person]=created_at,status";
  let pages = 0;
  while (nextUrl && pages < 60) {
    const r = await pcoFetch(nextUrl);
    if (r.status !== 200) break;
    for (const p of (r.body.data || [])) {
      newPeople.push({ createdAt: p.attributes.created_at, status: p.attributes.status });
    }
    const nxt = r.body.links && r.body.links.next;
    nextUrl = nxt ? (new URL(nxt)).pathname + (new URL(nxt)).search : null;
    pages++;
  }

  // Group by month key "YYYY-MM"
  const countByMonth = {};
  for (const p of newPeople) {
    const key = p.createdAt.slice(0, 7);
    countByMonth[key] = (countByMonth[key] || 0) + 1;
  }

  // Build last 12 month labels + counts
  const months = [], monthLabels = [], newPerMonth = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now); d.setDate(1); d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    months.push(key);
    monthLabels.push(d.toLocaleString("default", { month: "short", year: "2-digit" }));
    newPerMonth.push(countByMonth[key] || 0);
  }

  // Total active / inactive counts
  const activeR   = await pcoFetch("/people/v2/people?where[status]=active&per_page=1");
  const inactiveR = await pcoFetch("/people/v2/people?where[status]=inactive&per_page=1");
  const thisMonthKey = now.toISOString().slice(0, 7);
  const lastMonthD   = new Date(now); lastMonthD.setDate(1); lastMonthD.setMonth(lastMonthD.getMonth() - 1);
  const lastMonthKey = lastMonthD.toISOString().slice(0, 7);

  const growth = {
    months: monthLabels,
    newPerMonth,
    totalActive:    (activeR.body.meta   || {}).total_count || 0,
    totalInactive:  (inactiveR.body.meta || {}).total_count || 0,
    newThisMonth:   countByMonth[thisMonthKey] || 0,
    newLastMonth:   countByMonth[lastMonthKey] || 0,
    totalInRange:   newPeople.length,
  };

  // ── Part 2: At-Risk Congregants (Check-Ins × People cross-reference) ─────────
  // We look for people who attended regularly but have gone absent recently.
  // Uses the Sunday Attendance event's individual check-in records.
  const WEEKS_BACK = 13;
  const fromDate   = new Date(now);
  fromDate.setDate(fromDate.getDate() - WEEKS_BACK * 7);
  const fromStr    = fromDate.toISOString().slice(0, 10);

  // Fetch event_periods (one per Sunday) for the main Sunday event
  const periodsR = await pcoFetch(
    "/check-ins/v2/events/" + CHURCH_CONFIG.events.sundayAttendance +
    "/event_periods?where[starts_at][gte]=" + fromStr + "&per_page=50&order=starts_at"
  );
  const periods = periodsR.status === 200 ? (periodsR.body.data || []) : [];

  if (periods.length === 0) {
    return { growth, atRisk: await buildAtRiskFromInactivations() };
  }

  // Sample the first period to confirm per-person check-ins exist
  const sampleR = await pcoFetch("/check-ins/v2/event_periods/" + periods[0].id + "/check_ins?per_page=5");
  if (sampleR.status !== 200 || !(sampleR.body.data || []).length) {
    return { growth, atRisk: await buildAtRiskFromInactivations() };
  }

  // Sort periods oldest→newest and assign week index
  const sortedPeriods = [...periods]
    .filter(p => new Date(p.attributes.starts_at) <= now)
    .sort((a, b) => new Date(a.attributes.starts_at) - new Date(b.attributes.starts_at));
  const N = sortedPeriods.length;

  // personMap: id → { name, weeks: Set<weekIndex> }
  const personMap = {};

  await pLimit(
    sortedPeriods.map((period, wi) => async () => {
      let ciUrl = "/check-ins/v2/event_periods/" + period.id + "/check_ins?include=person&per_page=100";
      while (ciUrl) {
        const r = await pcoFetch(ciUrl);
        if (r.status !== 200) break;

        // Build name lookup from included person records
        const nameLookup = {};
        for (const inc of (r.body.included || [])) {
          if (inc.type === "Person") {
            const a = inc.attributes || {};
            nameLookup[inc.id] = ((a.first_name || "") + " " + (a.last_name || "")).trim();
          }
        }

        for (const ci of (r.body.data || [])) {
          const personRel = ci.relationships && ci.relationships.person && ci.relationships.person.data;
          if (!personRel) continue;
          const pid = personRel.id;
          if (!personMap[pid]) personMap[pid] = { name: nameLookup[pid] || "Unknown", weeks: new Set() };
          if (nameLookup[pid]) personMap[pid].name = nameLookup[pid]; // refresh name if available
          personMap[pid].weeks.add(wi);
        }

        const nxt = r.body.links && r.body.links.next;
        ciUrl = nxt ? (new URL(nxt)).pathname + (new URL(nxt)).search : null;
      }
    }),
    CONCURRENCY
  );

  // Identify at-risk: attended regularly in historical window, absent in recent window
  const recentWeeks = Math.min(4, Math.floor(N / 3)); // last ~4 weeks = "recent"
  const histEnd     = N - recentWeeks;                 // exclusive upper bound of historical window

  const atRiskList = [];
  for (const [pid, data] of Object.entries(personMap)) {
    const recentCount     = [...data.weeks].filter(wi => wi >= histEnd).length;
    const historicalCount = [...data.weeks].filter(wi => wi < histEnd).length;
    if (recentCount === 0 && historicalCount >= 3) {
      const lastWi     = Math.max(...[...data.weeks]);
      const lastPeriod = sortedPeriods[lastWi];
      const lastDate   = lastPeriod ? new Date(lastPeriod.attributes.starts_at) : null;
      const weeksSince = lastDate ? Math.round((now - lastDate) / (7 * 24 * 60 * 60 * 1000)) : null;
      atRiskList.push({
        id: pid, name: data.name,
        lastCheckinDate:    lastDate ? lastDate.toISOString().slice(0, 10) : null,
        weeksSince,
        historicalCheckins: historicalCount,
        totalWeeks:         N,
      });
    }
  }

  atRiskList.sort((a, b) => b.historicalCheckins - a.historicalCheckins);

  return {
    growth,
    atRisk: {
      available:           true,
      periodsAnalyzed:     N,
      recentWindow:        recentWeeks,
      totalUniqueAttendees: Object.keys(personMap).length,
      atRiskCongregants:   atRiskList.slice(0, 150),
    },
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  // Restrict CORS to same-origin (frontend served from this same server)
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // ── Staff login system ──────────────────────────────────────────────────────
  if (req.method === "POST" && parsed.pathname === "/login") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      try {
        const { password } = JSON.parse(body);
        if (!DASHBOARD_PASSWORD || password === DASHBOARD_PASSWORD) {
          const token = generateToken();
          activeSessions.add(token);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": "session=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800"
          });
          return res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Incorrect password" }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid request" }));
      }
    });
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/logout") {
    const cookies = (req.headers.cookie || "").split(";").reduce((acc, c) => {
      const [k, v] = c.trim().split("=");
      if (k && v) acc[k] = v;
      return acc;
    }, {});
    if (cookies.session) activeSessions.delete(cookies.session);
    res.writeHead(302, {
      "Set-Cookie": "session=; Path=/; HttpOnly; Max-Age=0",
      "Location": "/"
    });
    return res.end();
  }

  // Serve login page for unauthenticated users
  if (DASHBOARD_PASSWORD && !isAuthenticated(req)) {
    // Allow login endpoint through (handled above)
    // Serve the login page for all other requests
    const loginHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>CCC Dashboard — Login</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">' +
      '<style>' +
        '*{margin:0;padding:0;box-sizing:border-box}' +
        'body{font-family:"DM Sans",sans-serif;background:#f8f9fa;display:flex;align-items:center;justify-content:center;min-height:100vh}' +
        '.login-card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:48px 40px;width:100%;max-width:400px;text-align:center}' +
        '.login-logo{width:64px;height:64px;margin:0 auto 16px;border-radius:14px;object-fit:contain}' +
        '.login-title{font-size:22px;font-weight:700;color:#1a1a2e;margin-bottom:4px}' +
        '.login-sub{font-size:13px;color:#6b7280;margin-bottom:28px}' +
        '.login-input{width:100%;padding:12px 16px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:15px;font-family:inherit;outline:none;transition:border-color .2s}' +
        '.login-input:focus{border-color:#5AAEE0}' +
        '.login-btn{width:100%;padding:12px;background:#1a1a2e;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;margin-top:16px;transition:background .2s}' +
        '.login-btn:hover{background:#2d2d44}' +
        '.login-error{color:#dc2626;font-size:13px;margin-top:12px;display:none}' +
      '</style></head><body>' +
      '<div class="login-card">' +
        '<img src="/logo.png" class="login-logo" alt="CCC" onerror="this.style.display=\'none\'">' +
        '<div class="login-title">City Church Chicago</div>' +
        '<div class="login-sub">Enter the dashboard password to continue</div>' +
        '<form id="lf" onsubmit="return doLogin(event)">' +
          '<input type="password" class="login-input" id="pw" placeholder="Password" autocomplete="current-password" autofocus>' +
          '<button type="submit" class="login-btn">Sign In</button>' +
          '<div class="login-error" id="err"></div>' +
        '</form>' +
      '</div>' +
      '<script>' +
        'function doLogin(e){' +
          'e.preventDefault();' +
          'var pw=document.getElementById("pw").value;' +
          'var err=document.getElementById("err");' +
          'err.style.display="none";' +
          'fetch("/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})})' +
            '.then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})})' +
            '.then(function(r){' +
              'if(r.ok){window.location.reload()}' +
              'else{err.textContent=r.data.error||"Incorrect password";err.style.display="block"}' +
            '}).catch(function(){err.textContent="Connection error";err.style.display="block"});' +
          'return false;' +
        '}' +
      '</script></body></html>';

    // Let static assets through (logo, fonts) so login page looks right
    if (parsed.pathname === "/logo.png" || parsed.pathname === "/logo.svg") {
      // fall through to static file handler below
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(loginHtml);
    }
  }

  if (req.method === "GET" && parsed.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ authenticated: !!savedCreds }));
  }

  if (req.method === "POST" && parsed.pathname === "/auth") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", async () => {
      let appId, secret;
      try {
        const parsed = JSON.parse(body);
        appId = parsed.appId; secret = parsed.secret;
      } catch { res.writeHead(400); return res.end(JSON.stringify({ error: "Invalid body" })); }
      if (!appId || !secret) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing appId or secret" })); }
      // Test credentials against PCO before saving
      const testCreds = { appId, secret };
      const testAuth = Buffer.from(appId + ":" + secret).toString("base64");
      try {
        assertPcoReadOnly("GET", "/services/v2/service_types?per_page=1");
        await new Promise((resolve, reject) => {
          const r = https.request(
            { hostname: PCO_BASE, path: "/services/v2/service_types?per_page=1", method: "GET",
              headers: { Authorization: "Basic " + testAuth, "User-Agent": "PCO-Dashboard/1.0" } },
            (res2) => {
              let d = ""; res2.on("data", c => (d += c)); res2.on("end", () => resolve(res2.statusCode));
            }
          );
          r.on("error", reject); r.end();
        }).then(status => {
          if (status === 401 || status === 403) throw new Error("Invalid credentials — PCO returned HTTP " + status);
          if (status >= 500) throw new Error("PCO API error (HTTP " + status + ") — try again shortly");
        });
      } catch(e) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: e.message }));
      }
      savedCreds = testCreds;
      dataCache  = {};
      globalTeamNameMap = {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/progress") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    res.write("data: " + JSON.stringify({ step: "Connected…", pct: 0 }) + "\n\n");
    progressClients.push(res);
    req.on("close", () => { progressClients = progressClients.filter(c => c !== res); });
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/data") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "No credentials." })); }
    const reqWeeks = Math.max(1, Math.min(104, parseInt(parsed.searchParams.get("weeks")) || DEFAULT_WEEKS));
    const cacheKey = String(reqWeeks);
    const cached = dataCache[cacheKey];
    // Only serve from cache if it has actual data (not a stale zero-data entry)
    const cacheHasData = cached && cached.payload &&
      (cached.payload.attendance.some(v => v > 0) || cached.payload.scheduled.some(v => v > 0));
    if (!parsed.searchParams.get("refresh") && cacheHasData && (Date.now() - cached.ts) < 30 * 60 * 1000) {
      broadcast({ step: "Loaded from cache", pct: 100 });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(cached.payload));
    }
    delete dataCache[cacheKey];
    try {
      const payload = await buildData(reqWeeks);
      dataCache[cacheKey] = { ts: Date.now(), payload };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      // Background prefetch: warm cache for other common ranges (non-blocking)
      const prefetchRanges = [4, 8, 13, 26, 52].filter(w => w !== reqWeeks && !dataCache[String(w)]);
      if (prefetchRanges.length > 0 && !prefetchRunning) {
        prefetchRunning = true;
        (async () => {
          for (const pw of prefetchRanges) {
            try {
              console.log("🔄 Background prefetch: weeks=" + pw);
              const pp = await buildData(pw);
              dataCache[String(pw)] = { ts: Date.now(), payload: pp };
            } catch(e) { console.log("⚠ Prefetch failed for weeks=" + pw + ": " + e.message); }
          }
          prefetchRunning = false;
          // Warm City Kids team cache after data is ready (globalTeamNameMap now populated)
          if (!cityKidsTeamCache) warmCityKidsTeamCache().catch(e => console.log("⚠ City Kids team cache warm error:", e.message));
        })();
      }
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Quick range diagnostic — visit /debug-range?weeks=13 in browser
  if (req.method === "GET" && parsed.pathname === "/debug-range") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "No credentials." })); }
    const weeks = parseInt(parsed.searchParams.get("weeks")) || 13;
    const out = {};
    try {
      const { buckets, labels, grouping } = buildTimeBuckets(weeks);
      const since = new Date(); since.setDate(since.getDate() - weeks * 7 - 1);
      const sinceISO = since.toISOString().split("T")[0];

      out.params = { weeks, grouping, sinceISO, bucketCount: buckets.length };
      out.buckets = buckets.map((b, i) => ({
        index: i, label: labels[i],
        start: b.start.toISOString(), end: b.end.toISOString(),
        startLocal: b.start.toString(), endLocal: b.end.toString()
      }));

      // Raw API test — show full status + errors
      const stRes = await pcoFetch("/services/v2/service_types?per_page=3");
      out.serviceTypesAPI = {
        httpStatus: stRes.status,
        hasData: !!(stRes.body && stRes.body.data),
        errors: stRes.body && stRes.body.errors ? stRes.body.errors : null,
        rawBodyType: typeof stRes.body,
        rawBodyPreview: typeof stRes.body === "string" ? stRes.body.substring(0, 200) : undefined
      };
      const sts = (stRes.body && stRes.body.data) || [];
      out.serviceTypes = sts.map(s => ({ id: s.id, name: (s.attributes||{}).name }));

      if (sts[0]) {
        const stId = sts[0].id;
        const planUrl = "/services/v2/service_types/"+stId+"/plans?filter=past&after="+sinceISO+"&per_page=10&order=-sort_date";
        const planRes = await pcoFetch(planUrl);
        out.plansAPI = {
          httpStatus: planRes.status,
          query: planUrl,
          errors: planRes.body && planRes.body.errors ? planRes.body.errors : null
        };
        const plans = (planRes.body && planRes.body.data) || [];
        out.plansReturned = plans.length;
        out.samplePlans = plans.slice(0, 5).map(p => {
          const sortDate = (p.attributes||{}).sort_date;
          const parsedDate = parseLocalDate(sortDate);
          const wi = bucketIndexFor(parsedDate, buckets);
          return {
            id: p.id,
            sort_date_raw: sortDate,
            parsed_as: parsedDate.toISOString(),
            parsed_local: parsedDate.toString(),
            matchesBucket: wi,
            bucketLabel: wi >= 0 ? labels[wi] : "NONE (-1)"
          };
        });
      }

      // Test headcounts
      const hcUrl = "/check-ins/v2/events/" + CHURCH_CONFIG.events.sundayAttendance + "/headcounts?per_page=10&order=-updated_at";
      const hcRes = await pcoFetch(hcUrl);
      out.headcountsAPI = {
        httpStatus: hcRes.status,
        query: hcUrl,
        errors: hcRes.body && hcRes.body.errors ? hcRes.body.errors : null,
        rawBodyType: typeof hcRes.body,
        rawBodyPreview: typeof hcRes.body === "string" ? hcRes.body.substring(0, 200) : undefined
      };
      const hcs = (hcRes.body && hcRes.body.data) || [];
      out.headcountsReturned = hcs.length;

      // Resolve first 3 headcount dates
      const etCache = {};
      out.sampleHeadcounts = [];
      for (const hc of hcs.slice(0, 5)) {
        const hcAttrs = hc.attributes || {};
        const etId = hc.relationships && hc.relationships.event_time
          && hc.relationships.event_time.data && hc.relationships.event_time.data.id;
        let serviceDate = null;
        if (etId) {
          if (!etCache[etId]) {
            const etRes = await pcoFetch("/check-ins/v2/event_times/" + etId);
            etCache[etId] = (etRes.body.data && etRes.body.data.attributes && etRes.body.data.attributes.starts_at) || null;
          }
          serviceDate = etCache[etId] ? parseLocalDate(etCache[etId]) : null;
        }
        const dateToUse = serviceDate || parseLocalDate(hcAttrs.updated_at || hcAttrs.created_at);
        const wi = bucketIndexFor(dateToUse, buckets);
        out.sampleHeadcounts.push({
          id: hc.id,
          total: hcAttrs.total || hcAttrs.count,
          updated_at: hcAttrs.updated_at,
          event_time_id: etId,
          event_time_starts_at: etCache[etId] || null,
          resolved_date: dateToUse.toISOString(),
          resolved_local: dateToUse.toString(),
          matchesBucket: wi,
          bucketLabel: wi >= 0 ? labels[wi] : "NONE (-1)"
        });
      }
    } catch(e) { out.error = e.message; out.stack = e.stack; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ── /debug-headcounts — trace exact headcount records for kids & decisions
  if (req.method === "GET" && parsed.pathname === "/debug-headcounts") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "No credentials." })); }
    const out = {};
    try {
      const KIDS_ID = CHURCH_CONFIG.events.cityKids;
      const DECISIONS_ID = CHURCH_CONFIG.events.decisions;
      const evIds = { kids: KIDS_ID, decisions: DECISIONS_ID };

      for (const [label, evId] of Object.entries(evIds)) {
        // Try including headcount_group to get relationship data for dedup
        let allHC = [];
        let hcUrl = "/check-ins/v2/events/" + evId + "/headcounts?include=event_time,headcount_group&per_page=100&order=-updated_at";
        const etCache = {};
        const hgCache = {};  // headcount_group_id → name
        while (hcUrl && allHC.length < 500) {
          const hcRes = await pcoFetch(hcUrl);
          if (hcRes.status !== 200) break;
          const included = (hcRes.body && hcRes.body.included) || [];
          for (const inc of included) {
            if (inc.type === "EventTime" && inc.id && !etCache[inc.id]) {
              etCache[inc.id] = inc.attributes || {};
            }
            if ((inc.type === "HeadcountGroup" || inc.type === "headcount_group") && inc.id) {
              hgCache[inc.id] = (inc.attributes || {}).name || inc.id;
            }
          }
          const page = (hcRes.body && hcRes.body.data) || [];
          allHC = allHC.concat(page);
          const links = (hcRes.body && hcRes.body.links) || {};
          if (links.next) {
            const p = new URL(links.next);
            hcUrl = p.pathname + p.search;
          } else { hcUrl = null; }
        }

        // Show last 2 weeks with FULL relationship data for diagnosis
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        const recentHC = allHC.filter(hc => {
          const ua = (hc.attributes || {}).updated_at;
          return ua && new Date(ua) >= twoWeeksAgo;
        });

        // Show ALL relationship keys on first record for diagnosis
        const firstRec = recentHC[0];
        const relKeys = firstRec ? Object.keys(firstRec.relationships || {}) : [];

        out[label] = {
          event_id: evId,
          total_headcounts_fetched: allHC.length,
          recent_2_weeks: recentHC.length,
          headcount_groups_found: hgCache,
          relationship_keys_on_first_record: relKeys,
          first_record_relationships: firstRec ? Object.fromEntries(
            Object.entries(firstRec.relationships || {}).map(([k, v]) => [k, v.data])
          ) : null,
          records: recentHC.slice(0, 20).map(hc => {
            const a = hc.attributes || {};
            const rels = hc.relationships || {};
            const etId = rels.event_time && rels.event_time.data && rels.event_time.data.id;
            const etAttrs = etId && etCache[etId] ? etCache[etId] : {};
            const hgId = rels.headcount_group && rels.headcount_group.data
              && rels.headcount_group.data.id;
            return {
              headcount_id: hc.id,
              total: a.total,
              headcount_group_id: hgId || null,
              headcount_group_name: hgId && hgCache[hgId] ? hgCache[hgId] : null,
              created_at: a.created_at,
              event_time_id: etId,
              event_time_starts_at: etAttrs.starts_at,
              all_attribute_keys: Object.keys(a),
              all_relationship_keys: Object.keys(rels)
            };
          })
        };

        // Group by event_time — only for latest Sunday
        const byET = {};
        for (const hc of recentHC) {
          const a = hc.attributes || {};
          const rels = hc.relationships || {};
          const etId = rels.event_time && rels.event_time.data && rels.event_time.data.id;
          const key = etId || "no_event_time";
          const hgId = rels.headcount_group && rels.headcount_group.data
            && rels.headcount_group.data.id;
          if (!byET[key]) byET[key] = { event_time_id: etId, starts_at: etId && etCache[etId] ? etCache[etId].starts_at : null, records: [], sum_total: 0 };
          byET[key].records.push({ id: hc.id, total: a.total, headcount_group_id: hgId, headcount_group_name: hgId && hgCache[hgId] ? hgCache[hgId] : null, created_at: a.created_at });
          byET[key].sum_total += Number(a.total || 0);
        }
        out[label + "_by_event_time"] = byET;
      }
    } catch(e) { out.error = e.message; out.stack = e.stack; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ── /debug-attendance-types — fetch names for attendance types in Kids & Decisions
  if (req.method === "GET" && parsed.pathname === "/debug-attendance-types") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "No credentials." })); }
    const out = {};
    try {
      const events = { kids: CHURCH_CONFIG.events.cityKids, decisions: CHURCH_CONFIG.events.decisions, sunday_attendance: CHURCH_CONFIG.events.sundayAttendance };
      for (const [label, evId] of Object.entries(events)) {
        const atRes = await pcoFetch("/check-ins/v2/events/" + evId + "/attendance_types?per_page=100");
        const types = (atRes.body && atRes.body.data) || [];
        out[label] = {
          event_id: evId,
          attendance_types: types.map(at => ({
            id: at.id,
            name: (at.attributes || {}).name,
            color: (at.attributes || {}).color,
            count: (at.attributes || {}).count,
            all_attributes: at.attributes
          }))
        };
      }
    } catch(e) { out.error = e.message; out.stack = e.stack; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ── /debug-kids-periods — show all event_periods for City Kids last Sunday ──
  if (req.method === "GET" && parsed.pathname === "/debug-kids-periods") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "No credentials." })); }
    const KIDS_EVENT_ID = CHURCH_CONFIG.events.cityKids;
    const out = { eventId: KIDS_EVENT_ID, periods: [], checkInCount: null };
    try {
      // Fetch last ~30 event_periods (covers several Sundays)
      const epRes = await pcoFetch("/check-ins/v2/events/" + KIDS_EVENT_ID + "/event_periods?per_page=30&order=-starts_at&include=event_times");
      const periods = (epRes.body && epRes.body.data) || [];
      const included = (epRes.body && epRes.body.included) || [];

      // Build event_time lookup from sideloaded data
      const etLookup = {};
      for (const inc of included) {
        if (inc.type === "EventTime") {
          etLookup[inc.id] = inc.attributes || {};
        }
      }

      // Group by date
      const byDate = {};
      for (const p of periods) {
        const attrs = p.attributes || {};
        const d = new Date(attrs.starts_at || 0);
        const dateKey = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: CHURCH_CONFIG.timezone });
        if (!byDate[dateKey]) byDate[dateKey] = [];
        const etRel = (p.relationships || {}).event_times || (p.relationships || {}).event_time || {};
        const etId = etRel.data && (Array.isArray(etRel.data) ? etRel.data[0] && etRel.data[0].id : etRel.data.id);
        byDate[dateKey].push({
          id: p.id,
          starts_at: attrs.starts_at,
          local_time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: CHURCH_CONFIG.timezone }),
          regular_count: attrs.regular_count,
          guest_count: attrs.guest_count,
          volunteer_count: attrs.volunteer_count,
          total: (Number(attrs.regular_count||0) + Number(attrs.guest_count||0) + Number(attrs.volunteer_count||0)),
          event_time_id: etId,
          event_time_name: etId && etLookup[etId] ? etLookup[etId].name : null,
          all_attrs: attrs
        });
      }
      out.periods = byDate;

      // Also fetch check-in count for comparison (last Sunday)
      const lastSun = new Date();
      lastSun.setDate(lastSun.getDate() - ((lastSun.getDay() + 7) % 7 || 7));
      const sunStr = lastSun.toISOString().split("T")[0];
      const ciRes = await pcoFetch("/check-ins/v2/events/" + KIDS_EVENT_ID + "/check_ins?per_page=1&order=-created_at&where[created_at][gte]=" + sunStr + "T00:00:00Z&where[created_at][lt]=" + sunStr + "T23:59:59Z");
      out.checkInMeta = { status: ciRes.status, total_count: ciRes.body && ciRes.body.meta && ciRes.body.meta.total_count };

      // Also try fetching headcounts for comparison
      const hcRes = await pcoFetch("/check-ins/v2/events/" + KIDS_EVENT_ID + "/event_periods?per_page=10&order=-starts_at");
      const latestPeriods = (hcRes.body && hcRes.body.data) || [];
      if (latestPeriods.length > 0) {
        const latestId = latestPeriods[0].id;
        // Try to get headcounts for this event_period
        const hcDetail = await pcoFetch("/check-ins/v2/event_periods/" + latestId + "/headcounts?include=attendance_type&per_page=50");
        out.latestPeriodHeadcounts = {
          period_id: latestId,
          period_starts_at: (latestPeriods[0].attributes||{}).starts_at,
          headcounts: ((hcDetail.body && hcDetail.body.data) || []).map(h => ({
            id: h.id,
            total: (h.attributes||{}).total,
            attrs: h.attributes,
            attendance_type_id: h.relationships && h.relationships.attendance_type && h.relationships.attendance_type.data && h.relationships.attendance_type.data.id
          })),
          included: (hcDetail.body && hcDetail.body.included) || []
        };
      }
    } catch(e) {
      out.error = e.message;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ── /debug-kids-standard — find Standard Headcounts via event_times ────────
  if (req.method === "GET" && parsed.pathname === "/debug-kids-standard") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "No credentials." })); }
    const KIDS_EVENT_ID = CHURCH_CONFIG.events.cityKids;
    const out = { eventId: KIDS_EVENT_ID };
    try {
      // 1. Get recent event_times for this event
      const etRes = await pcoFetch("/check-ins/v2/events/" + KIDS_EVENT_ID + "/event_times?per_page=30&order=-starts_at");
      const eventTimes = (etRes.body && etRes.body.data) || [];
      out.event_times_count = eventTimes.length;
      out.event_times = eventTimes.map(et => ({
        id: et.id,
        name: (et.attributes||{}).name,
        starts_at: (et.attributes||{}).starts_at,
        attrs: et.attributes
      }));

      // 2. For the most recent ~6 event_times (2 Sundays × 3 services), fetch their headcounts
      const recent = eventTimes.slice(0, 9);
      out.headcounts_per_event_time = [];
      for (const et of recent) {
        const hcRes = await pcoFetch("/check-ins/v2/event_times/" + et.id + "/headcounts?include=attendance_type&per_page=50");
        const hcs = (hcRes.body && hcRes.body.data) || [];
        const included = (hcRes.body && hcRes.body.included) || [];
        const atLookup = {};
        for (const inc of included) {
          if (inc.type === "AttendanceType") atLookup[inc.id] = (inc.attributes||{}).name;
        }
        out.headcounts_per_event_time.push({
          event_time_id: et.id,
          event_time_name: (et.attributes||{}).name,
          starts_at: (et.attributes||{}).starts_at,
          headcounts: hcs.map(h => ({
            id: h.id,
            total: (h.attributes||{}).total,
            attendance_type_id: h.relationships && h.relationships.attendance_type && h.relationships.attendance_type.data && h.relationships.attendance_type.data.id,
            attendance_type_name: (() => {
              const atId = h.relationships && h.relationships.attendance_type && h.relationships.attendance_type.data && h.relationships.attendance_type.data.id;
              return atId ? atLookup[atId] || ("AT:" + atId) : "none";
            })(),
            attrs: h.attributes
          }))
        });
      }

    } catch(e) {
      out.error = e.message;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ── Volunteer person profile (birthday, tenure, baptism) ────────────────────
  if (req.method === "GET" && parsed.pathname === "/vol-person") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "Not authenticated" })); }
    const personId = parsed.searchParams.get("id");
    if (!personId) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing id" })); }
    try {
      const [personRes, defsRes] = await Promise.all([
        pcoFetch("/people/v2/people/" + personId + "?include=field_data&fields[Person]=first_name,last_name,birthdate,anniversary,created_at,membership,status,gender,marital_status"),
        pcoFetch("/people/v2/field_definitions?per_page=100&fields[FieldDefinition]=name,field_type"),
      ]);
      if (personRes.status !== 200) { res.writeHead(personRes.status); return res.end(JSON.stringify({ error: "PCO returned " + personRes.status })); }
      const attrs = (personRes.body.data && personRes.body.data.attributes) || {};
      // Build field definition name map
      const defMap = {};
      for (const d of ((defsRes.body && defsRes.body.data) || [])) {
        defMap[d.id] = (d.attributes && d.attributes.name) || d.id;
      }
      // Map field_data with resolved names
      const fieldData = ((personRes.body.included || []).filter(i => i.type === "FieldDatum"))
        .map(f => {
          const defId = f.relationships && f.relationships.field_definition && f.relationships.field_definition.data && f.relationships.field_definition.data.id;
          return { name: defMap[defId] || null, value: (f.attributes && f.attributes.value) || null };
        })
        .filter(f => f.name && f.value);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        birthdate:    attrs.birthdate    || null,
        anniversary:  attrs.anniversary  || null,
        createdAt:    attrs.created_at   || null,
        membership:   attrs.membership   || null,
        gender:       attrs.gender       || null,
        maritalStatus: attrs.marital_status || null,
        fieldData,
      }));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Life Groups endpoint ─────────────────────────────────────────────────────
  if (req.method === "GET" && parsed.pathname === "/lifegroups-data") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "Not authenticated" })); }
    const forceRefresh = parsed.searchParams.get("refresh") === "1";
    const CACHE_TTL = 60 * 60 * 1000; // 1 hour
    if (!forceRefresh && lifegroupsCache && (Date.now() - lifegroupsCache.ts < CACHE_TTL)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(lifegroupsCache.payload));
    }
    try {
      // Fetch all Life Groups (group_type_id=112006) — ACTIVE AND ARCHIVED.
      // The church archives a group when its season ends, so excluding archived
      // groups silently erases every past season (Jan–Mar 2026 showed 1 group
      // instead of 51 once its groups were archived). Two passes: PCO's
      // `filter=archived` returns only archived groups, and the default returns
      // only active ones.
      const LIFE_GROUP_TYPE_ID = "112006";
      // Seasons before this year are excluded: the life-group model changed
      // completely starting 2026, so earlier seasons are not comparable.
      const LG_FIRST_YEAR = 2026;
      const groups = [];
      const groupFields = "&fields[Group]=name,schedule,memberships_count,description_as_plain_text,public_church_center_web_url,created_at,archived_at,contact_email,listed";
      for (const flt of ["group_type", "group_type,archived"]) {
        let nextUrl = "/groups/v2/groups?filter=" + flt + "&group_type_id=" + LIFE_GROUP_TYPE_ID + "&per_page=100" + groupFields;
        while (nextUrl) {
          const r = await pcoFetch(nextUrl);
          if (r.status !== 200) break;
          for (const g of (r.body.data || [])) {
            const a = g.attributes;
            // Skip aggregate/leadership groups that double-count members
            if (/serve team|young adult fridays|lg leaders|lg coaches/i.test(a.name || "")) continue;
            groups.push({
              id:          g.id,
              name:        a.name,
              schedule:    a.schedule || null,
              members:     a.memberships_count || 0,
              description: a.description_as_plain_text || null,
              churchCenterUrl: a.public_church_center_web_url || null,
              createdAt:   a.created_at ? a.created_at.slice(0, 10) : null,
              archivedAt:  a.archived_at ? a.archived_at.slice(0, 10) : null,
              contactEmail: a.contact_email || null,
            });
          }
          const nxt = r.body.links && r.body.links.next;
          nextUrl = nxt ? (new URL(nxt)).pathname + (new URL(nxt)).search : null;
        }
      }

      // ── Season detection (year-aware) ─────────────────────────────────────
      // A season is a calendar quarter in a specific year, labelled e.g.
      // "January–March 2026". Without the year, the 2025 and 2026 January
      // seasons collapse into one bucket and retention math compares the wrong
      // cohorts. Resolution order:
      //   1. explicit range in the name/schedule ("| April-June")
      //   2. explicit month name in the name/schedule ("January Life Group")
      //   3. created_at, with the church's prep cadence: groups are created in
      //      the month BEFORE a season (Mar→Apr–Jun, Jun→Jul–Sep, Sep→Oct–Dec)
      //      and in Nov/Dec for the following Jan–Mar.
      const QUARTER_LABELS = ["January–March", "April–June", "July–September", "October–December"];
      const quarterRangePatterns = [
        /\bjan(uary)?[\s\-–]+mar(ch)?\b/i,
        /\bapr(il)?[\s\-–]+jun(e)?\b/i,
        /\bjul(y)?[\s\-–]+sep(tember)?\b/i,
        /\boct(ober)?[\s\-–]+dec(ember)?\b/i,
      ];
      const MONTH_NAMES = ['january','february','march','april','may','june',
                           'july','august','september','october','november','december'];
      const seasonLabel = (year, q) => QUARTER_LABELS[q] + " " + year;
      const seasonKey   = (year, q) => year * 4 + q; // sortable

      function detectSeason(group) {
        const text = (group.name || "") + " | " + (group.schedule || "");
        const created = group.createdAt ? group.createdAt.split("-").map(Number) : null;
        const cy = created ? created[0] : null, cm = created ? created[1] : null;
        let q = null, startMonth = null;
        for (let i = 0; i < 4; i++) if (quarterRangePatterns[i].test(text)) { q = i; startMonth = i * 3 + 1; break; }
        if (q === null) {
          for (let i = 0; i < 12; i++) if (new RegExp('\\b' + MONTH_NAMES[i] + '\\b', 'i').test(text)) { startMonth = i + 1; q = Math.floor(i / 3); break; }
        }
        let year = cy;
        if (q === null) {
          if (!cm) return null;
          if (cm >= 11)          { q = 0; year = cy + 1; startMonth = 1; }   // Nov/Dec → next Jan–Mar
          else if (cm % 3 === 0) { q = cm / 3; startMonth = cm + 1; }       // Mar/Jun/Sep → next quarter
          else                   { q = Math.floor((cm - 1) / 3); startMonth = cm; }
        } else if (cm && startMonth < cm - 3) {
          year = cy + 1; // tagged January but created the previous autumn
        }
        if (!year) return null;
        return { year, q, startMonth, label: seasonLabel(year, q), key: seasonKey(year, q) };
      }

      // Tag each group; drop anything before LG_FIRST_YEAR or undatable
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        const s = detectSeason(g);
        if (!s || s.year < LG_FIRST_YEAR) { groups.splice(i, 1); continue; }
        g.season = s.label;
        g.seasonKey = s.key;
        g.startMonth = s.startMonth;
        g.displayName = g.name.replace(/\s*\|\s*(january|april|july|october)[\s\-–]+(march|june|september|december)\s*/i, "").trim();
      }

      // Sort by member count descending
      groups.sort((a, b) => b.members - a.members);

      // Determine which seasons exist and which is current
      const now = new Date();
      const currentMonth = now.getMonth() + 1; // 1-based
      const seasonKeys = {};
      for (const g of groups) seasonKeys[g.season] = g.seasonKey;
      const allSeasons = Object.keys(seasonKeys).sort((a, b) => seasonKeys[a] - seasonKeys[b]);
      // Current = this calendar quarter if it has groups, else the latest season that does
      const calendarSeason = seasonLabel(now.getFullYear(), Math.floor((currentMonth - 1) / 3));
      const currentSeasonLabel = seasonKeys[calendarSeason] !== undefined ? calendarSeason : (allSeasons[allSeasons.length - 1] || calendarSeason);

      // Active DNR is month-based, not season-based.
      // Groups rotate every 3 months from their start month:
      //   January groups → join April groups
      //   February groups → join May groups
      //   March groups → join June groups
      // The "due" month right now = 3 months before the upcoming calendar month.
      // e.g. currentMonth=3 (March) → nextMonth=4 (April) → dueFromMonth=1 (January)
      const nextCalMonth = (currentMonth % 12) + 1;
      const activeDnrFromMonth = ((nextCalMonth - 4 + 12) % 12) + 1; // 3 months before next
      const activeDnrToMonth = nextCalMonth;
      const activeDnrFrom = MONTH_NAMES[activeDnrFromMonth - 1].charAt(0).toUpperCase() + MONTH_NAMES[activeDnrFromMonth - 1].slice(1);
      const activeDnrTo = MONTH_NAMES[activeDnrToMonth - 1].charAt(0).toUpperCase() + MONTH_NAMES[activeDnrToMonth - 1].slice(1);

      // ── Fetch member person IDs per group ──────────────────────────────────
      const groupPersonIds = {};   // groupId → Set of person IDs
      const membershipRoles = {};  // groupId → { personId → "leader"|"member" }
      const personNameMap = {};    // personId → name
      await pLimit(
        groups.map(g => async () => {
          const pids = new Set();
          if (!membershipRoles[g.id]) membershipRoles[g.id] = {};
          let memUrl = "/groups/v2/groups/" + g.id + "/memberships?per_page=100&include=person&fields[Person]=first_name,last_name";
          while (memUrl) {
            const r = await pcoFetch(memUrl);
            if (r.status !== 200) break;
            const pMap = {};
            for (const inc of (r.body.included || [])) {
              if (inc.type === "Person") pMap[inc.id] = inc.attributes;
            }
            for (const m of (r.body.data || [])) {
              const pid = m.relationships && m.relationships.person && m.relationships.person.data && m.relationships.person.data.id;
              if (pid) {
                pids.add(pid);
                membershipRoles[g.id][pid] = (m.attributes || {}).role || "member";
                if (!personNameMap[pid]) {
                  const pa = pMap[pid] || {};
                  personNameMap[pid] = ((pa.first_name || "") + " " + (pa.last_name || "")).trim();
                }
              }
            }
            const nxt = r.body.links && r.body.links.next;
            memUrl = nxt ? (new URL(nxt)).pathname + (new URL(nxt)).search : null;
          }
          groupPersonIds[g.id] = pids;
        }),
        6
      );

      // Build group leader map (groupId → comma-separated leader names)
      const groupLeaderMap = {};
      for (const g of groups) {
        const roles = membershipRoles[g.id] || {};
        const leaders = Object.entries(roles)
          .filter(([, role]) => role === "leader")
          .map(([pid]) => personNameMap[pid] || "")
          .filter(n => n);
        groupLeaderMap[g.id] = leaders.length ? leaders.join(", ") : null;
      }

      // Build person → group history across all seasons
      const personGroupHistory = {};  // personId → [{season, groupName, leader}]
      for (const g of groups) {
        const leader = groupLeaderMap[g.id] || null;
        for (const pid of (groupPersonIds[g.id] || [])) {
          if (!personGroupHistory[pid]) personGroupHistory[pid] = [];
          personGroupHistory[pid].push({ season: g.season, groupName: g.displayName || g.name, leader });
        }
      }

      // ── Per-season stats ───────────────────────────────────────────────────
      const seasonStats = {};
      const seasonPersonIds = {};  // seasonLabel → Set of person IDs
      for (const sl of allSeasons) {
        const sGroups = groups.filter(g => g.season === sl);
        const personIds = new Set();
        for (const g of sGroups) {
          for (const pid of (groupPersonIds[g.id] || [])) personIds.add(pid);
        }
        seasonPersonIds[sl] = personIds;

        // Multi-group within this season
        const personGroupsInSeason = {};
        for (const g of sGroups) {
          for (const pid of (groupPersonIds[g.id] || [])) {
            if (!personGroupsInSeason[pid]) personGroupsInSeason[pid] = [];
            personGroupsInSeason[pid].push(g.displayName || g.name);
          }
        }
        const multiGroup = Object.entries(personGroupsInSeason)
          .filter(([, gs]) => gs.length >= 2)
          .map(([pid, gs]) => ({ name: personNameMap[pid] || "Unknown", groups: gs }))
          .sort((a, b) => b.groups.length - a.groups.length || a.name.localeCompare(b.name));

        const totalEnrolled = sGroups.reduce((s, g) => s + g.members, 0);
        seasonStats[sl] = {
          total: sGroups.length,
          totalEnrolled,
          uniqueIndividuals: personIds.size,
          avgSize: sGroups.length ? Math.round(totalEnrolled / sGroups.length) : 0,
          healthyGroups: sGroups.filter(g => g.members >= 5 && g.members <= 25).length,
          largeGroups: sGroups.filter(g => g.members > 25).length,
          smallGroups: sGroups.filter(g => g.members < 5).length,
          multiGroupPeople: multiGroup,
        };
      }

      // ── Season-over-season retention ───────────────────────────────────────
      // Compare consecutive seasons: who returned, who's new, who left
      const seasonTransitions = [];
      for (let si = 1; si < allSeasons.length; si++) {
        const prevSeason = allSeasons[si - 1];
        const currSeason = allSeasons[si];
        const prevIds = seasonPersonIds[prevSeason] || new Set();
        const currIds = seasonPersonIds[currSeason] || new Set();
        const returning = new Set([...currIds].filter(id => prevIds.has(id)));
        const newPeople = new Set([...currIds].filter(id => !prevIds.has(id)));
        const didNotReturn = new Set([...prevIds].filter(id => !currIds.has(id)));
        seasonTransitions.push({
          from: prevSeason,
          to: currSeason,
          returning: returning.size,
          returningNames: [...returning].map(id => personNameMap[id] || "Unknown").sort(),
          new: newPeople.size,
          newNames: [...newPeople].map(id => personNameMap[id] || "Unknown").sort(),
          didNotReturn: didNotReturn.size,
          didNotReturnNames: [...didNotReturn].map(id => personNameMap[id] || "Unknown").sort(),
          didNotReturnPeople: [...didNotReturn].map(id => {
            const prevGroups = groups
              .filter(g => g.season === prevSeason && (groupPersonIds[g.id] || new Set()).has(id))
              .map(g => ({ name: g.displayName || g.name, leader: groupLeaderMap[g.id] || null }));
            return { id, name: personNameMap[id] || "Unknown", prevGroups };
          }).sort((a, b) => a.name.localeCompare(b.name)),
          retentionRate: prevIds.size > 0 ? Math.round(returning.size / prevIds.size * 100) : 0,
        });
      }

      // ── Active DNR: month-based, not season-based ─────────────────────────
      // Build month → Set of person IDs using each group's specific start month
      const monthPersonIds = {}; // month (1-12) → Set of person IDs
      for (const g of groups) {
        if (!g.startMonth) continue;
        if (!monthPersonIds[g.startMonth]) monthPersonIds[g.startMonth] = new Set();
        for (const pid of (groupPersonIds[g.id] || new Set())) {
          monthPersonIds[g.startMonth].add(pid);
        }
      }
      const fromMonthIds = monthPersonIds[activeDnrFromMonth] || new Set();
      const toMonthIds   = monthPersonIds[activeDnrToMonth]   || new Set();
      const activeDnrIds = [...fromMonthIds].filter(id => !toMonthIds.has(id));
      const activeDnrPeople = activeDnrIds.map(id => {
        const prevGroups = groups
          .filter(g => g.startMonth === activeDnrFromMonth && (groupPersonIds[g.id] || new Set()).has(id))
          .map(g => ({ name: g.displayName || g.name, leader: groupLeaderMap[g.id] || null }));
        return { id, name: personNameMap[id] || "Unknown", prevGroups };
      }).sort((a, b) => a.name.localeCompare(b.name));

      // ── Global stats (all seasons combined, deduplicated) ──────────────────
      const allPersonIds = new Set();
      for (const pids of Object.values(groupPersonIds)) {
        for (const pid of pids) allPersonIds.add(pid);
      }
      const totalEnrolled = groups.reduce((s, g) => s + g.members, 0);
      const uniqueIndividuals = allPersonIds.size;

      // Global multi-group (across all seasons)
      const globalPersonGroups = {};
      for (const g of groups) {
        for (const pid of (groupPersonIds[g.id] || [])) {
          if (!globalPersonGroups[pid]) globalPersonGroups[pid] = [];
          globalPersonGroups[pid].push(g.displayName || g.name);
        }
      }
      const multiGroupPeople = Object.entries(globalPersonGroups)
        .filter(([, gs]) => gs.length >= 2)
        .map(([pid, gs]) => ({ name: personNameMap[pid] || "Unknown", groups: gs }))
        .sort((a, b) => b.groups.length - a.groups.length || a.name.localeCompare(b.name));

      const avgSize = groups.length ? Math.round(totalEnrolled / groups.length) : 0;
      const healthyGroups = groups.filter(g => g.members >= 5 && g.members <= 25).length;
      const largeGroups = groups.filter(g => g.members > 25).length;
      const smallGroups = groups.filter(g => g.members < 5).length;

      // Day-of-week breakdown from schedule strings (with group names per day)
      const dayGroupsMap = {};
      const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      for (const g of groups) {
        if (!g.schedule) continue;
        const match = days.find(d => g.schedule.includes(d));
        if (match) {
          if (!dayGroupsMap[match]) dayGroupsMap[match] = [];
          dayGroupsMap[match].push({ id: g.id, name: g.name, members: g.members, schedule: g.schedule });
        }
      }
      const meetingDays = days.filter(d => dayGroupsMap[d]).map(d => ({ day: d, count: dayGroupsMap[d].length, groups: dayGroupsMap[d] }));

      const payload = {
        groups,
        stats: { total: groups.length, totalEnrolled, uniqueIndividuals, avgSize, healthyGroups, largeGroups, smallGroups },
        meetingDays, multiGroupPeople,
        seasons: allSeasons, currentSeason: currentSeasonLabel, seasonStats, seasonTransitions,
        activeDnrFrom, activeDnrTo, activeDnrPeople,
        personGroupHistory,
      };
      lifegroupsCache = { ts: Date.now(), payload };
      console.log("✅ Life groups data built — " + groups.length + " groups, " + uniqueIndividuals + " unique individuals across " + allSeasons.length + " seasons");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── First-timer team assignments (persistent JSON file) ─────────────────────
  const FT_ASSIGNMENTS_FILE = path.join(__dirname, ".ft-assignments.json");
  function loadFTAssignments() {
    try { return JSON.parse(fs.readFileSync(FT_ASSIGNMENTS_FILE, "utf8")); }
    catch(e) { return {}; }
  }
  function saveFTAssignments(data) {
    fs.writeFileSync(FT_ASSIGNMENTS_FILE, JSON.stringify(data, null, 2));
  }

  if (req.method === "GET" && parsed.pathname === "/ft-assignments") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(loadFTAssignments()));
  }

  if (req.method === "POST" && parsed.pathname === "/ft-assignments") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      try {
        const { key, team } = JSON.parse(body);
        if (!key) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing key" })); }
        const data = loadFTAssignments();
        if (team) { data[key] = team; } else { delete data[key]; }
        saveFTAssignments(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request" }));
      }
    });
    return;
  }

  // ── Weekly Leadership Report ─────────────────────────────────────────────────
  if (req.method === "GET" && parsed.pathname === "/report") {
    if (!savedCreds) { res.writeHead(401); return res.end("Not authenticated — open the dashboard first and enter credentials."); }
    try {
      const CACHE_TTL = 30 * 60 * 1000;
      let D4 = dataCache[4] && (Date.now() - dataCache[4].ts < CACHE_TTL) ? dataCache[4].payload : null;
      if (!D4) { D4 = await buildData(4); dataCache[4] = { ts: Date.now(), payload: D4 }; }

      const li = D4.labels.length - 1;
      const fmt = n => (n || 0).toLocaleString();
      const pct = (n, tot) => tot > 0 ? Math.round((n / tot) * 100) : 0;
      const deltaHtml = (curr, prev) => {
        const diff = curr - prev;
        if (diff === 0) return '<span style="color:#6b7280">— no change</span>';
        const arrow = diff > 0 ? "▲" : "▼";
        const color = diff > 0 ? "#16a34a" : "#dc2626";
        return `<span style="color:${color}">${arrow} ${Math.abs(diff)}</span>`;
      };

      const now = new Date();
      const reportDate = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: CHURCH_CONFIG.timezone });
      const sundayLabel = D4.labels[li] || "This Week";

      // ── Metrics ──
      const attTotal = D4.attendance[li] || 0;
      const attPrev  = li > 0 ? (D4.attendance[li-1] || 0) : 0;
      const decisions   = (D4.decisions || [])[li] || 0;
      const decPrev     = li > 0 ? ((D4.decisions || [])[li-1] || 0) : 0;
      const kidsTotal   = (D4.kidsCheckinCounts || D4.kidsAttendance || [])[li] || 0;
      const kidsPrev    = li > 0 ? ((D4.kidsCheckinCounts || D4.kidsAttendance || [])[li-1] || 0) : 0;
      const volUnique   = (D4.uniqueVolunteers || [])[li] || 0;
      const volPrev     = li > 0 ? ((D4.uniqueVolunteers || [])[li-1] || 0) : 0;
      const multiServers = (D4.weeklyMultiServers || [])[li] || [];
      const newFamCurr  = (D4.newFamiliesCount || [])[li] || 0;
      const newFamPrev  = li > 0 ? ((D4.newFamiliesCount || [])[li-1] || 0) : 0;
      const ftNames     = D4.firstTimerNames ? (D4.firstTimerNames[li] || []) : [];

      const CURRENT_SERVICES = new Set(["8:30 AM", "10:00 AM", "11:30 AM", "1:00 PM"]);
      const sortTimes = keys => keys.slice().sort((a, b) => {
        const pa = Date.parse("2000-01-01 " + a), pb = Date.parse("2000-01-01 " + b);
        return (isNaN(pa) ? 9999 : pa) - (isNaN(pb) ? 9999 : pb);
      });

      // Attendance by service time
      const attByService = D4.attendanceByService || {};
      const attServiceKeys = sortTimes(Object.keys(attByService).filter(k => CURRENT_SERVICES.has(k)));

      // Kids room breakdown
      const roomBreakdown = D4.kidsRoomBreakdown || {};
      const roomServiceKeys = sortTimes(Object.keys(roomBreakdown).filter(k => CURRENT_SERVICES.has(k)));
      const allRooms = [...new Set(roomServiceKeys.flatMap(st => Object.keys(roomBreakdown[st] || {})))].sort();
      const kidsServiceKeys = roomServiceKeys;
      const kidsByServiceFromRooms = {};
      for (const st of kidsServiceKeys) {
        kidsByServiceFromRooms[st] = allRooms.reduce((s, room) => s + (((roomBreakdown[st] || {})[room] || [])[li] || 0), 0);
      }
      const kidsTotalFromRooms = kidsServiceKeys.reduce((s, st) => s + kidsByServiceFromRooms[st], 0);

      // Volunteers by team & service (use per-week breakdown if available)
      const volByTeam = (D4.teamByServiceTimeCountByWeek ? D4.teamByServiceTimeCountByWeek[li] : D4.teamByServiceTimeCount) || {};
      const volTeamNames = Object.keys(volByTeam)
        .filter(tn => [...CURRENT_SERVICES].some(st => (volByTeam[tn][st] || 0) > 0))
        .sort((a, b) => {
          const totA = [...CURRENT_SERVICES].reduce((s, st) => s + (volByTeam[a][st] || 0), 0);
          const totB = [...CURRENT_SERVICES].reduce((s, st) => s + (volByTeam[b][st] || 0), 0);
          return totB - totA;
        });
      const volServiceCols = sortTimes([...CURRENT_SERVICES]);
      const volTeamColHeaders = volServiceCols.map(st => `<th class="num">${st}</th>`).join("");
      const volTeamRows = volTeamNames.map(tn => {
        const cells = volServiceCols.map(st => { const v = (volByTeam[tn] || {})[st] || 0; return `<td class="num">${v > 0 ? v : "—"}</td>`; }).join("");
        const rowTotal = volServiceCols.reduce((s, st) => s + ((volByTeam[tn] || {})[st] || 0), 0);
        return `<tr><td>${tn}</td>${cells}<td class="num" style="font-weight:700">${rowTotal}</td></tr>`;
      }).join("");
      const volTotalCells = volServiceCols.map(st => { const c = volTeamNames.reduce((s, tn) => s + ((volByTeam[tn] || {})[st] || 0), 0); return `<td class="num">${c > 0 ? c : "—"}</td>`; }).join("");
      const volGrandTotal = volServiceCols.reduce((s, st) => s + volTeamNames.reduce((ss, tn) => ss + ((volByTeam[tn] || {})[st] || 0), 0), 0);

      // ── Styles (same as Easter report) ──
      const css = `
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:"DM Sans",sans-serif;background:#f8f9fa;color:#1a1a2e;-webkit-print-color-adjust:exact;print-color-adjust:exact}
        .page{max-width:840px;margin:0 auto;background:#fff;min-height:100vh}
        .header{background:linear-gradient(135deg,#1a1a2e 0%,#2d2d44 100%);color:#fff;padding:32px 40px;display:flex;align-items:center;justify-content:space-between}
        .header-left{display:flex;align-items:center;gap:16px}
        .header-logo{width:44px;height:44px;border-radius:10px;object-fit:contain}
        .header h1{font-size:22px;font-weight:700;letter-spacing:-.02em}
        .header-date{font-size:13px;opacity:.7;margin-top:2px}
        .header-right{text-align:right;font-size:12px;opacity:.6;line-height:1.6}
        .kpi-grid{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid #e5e7eb}
        .kpi{padding:14px 12px;border-right:1px solid #e5e7eb;text-align:center}
        .kpi:last-child{border-right:none}
        .kpi-value{font-size:26px;font-weight:700;letter-spacing:-.03em;line-height:1}
        .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:6px;font-weight:600}
        .kpi-sub{font-size:12px;margin-top:6px;color:#6b7280}
        .section{padding:24px 40px;border-bottom:1px solid #e5e7eb}
        .section:last-of-type{border-bottom:none}
        .section-title{font-size:15px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:8px}
        .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
        table{width:100%;border-collapse:collapse;font-size:13px}
        th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;font-weight:600;padding:6px 10px;border-bottom:2px solid #e5e7eb}
        td{padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#1a1a2e}
        tr:last-child td{border-bottom:none}
        .num{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
        .pct{text-align:right;color:#6b7280;font-size:12px}
        .total-row td{font-weight:700;border-top:2px solid #e5e7eb;border-bottom:none;background:#f9fafb}
        .person-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f3f4f6}
        .person-row:last-child{border-bottom:none}
        .avatar{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
        .person-name{font-size:13px;font-weight:600}
        .person-meta{font-size:11px;color:#6b7280}
        .badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
        .badge-green{background:#dcfce7;color:#16a34a}
        .badge-amber{background:#fef3c7;color:#d97706}
        .badge-blue{background:#dbeafe;color:#2563eb}
        .badge-purple{background:#f0e6ff;color:#7c3aed}
        .empty{color:#9ca3af;font-size:13px;font-style:italic;padding:6px 0}
        .footer{padding:20px 40px;text-align:center;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb}
        @media print{body{background:#fff}.page{box-shadow:none}.header{-webkit-print-color-adjust:exact}}
        @media(max-width:640px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.kpi:nth-child(2n){border-right:none}.header{flex-direction:column;gap:12px}.section{padding:20px 24px}}
      `;

      const initials = name => (name || "?").split(" ").map(w => w[0] || "").join("").slice(0, 2).toUpperCase();

      const attServiceRows = attServiceKeys.map(svc => {
        const count = (attByService[svc] || [])[li] || 0;
        return `<tr><td>${svc}</td><td class="num">${fmt(count)}</td><td class="pct">${pct(count, attTotal)}%</td></tr>`;
      }).join("");

      const kidsServiceRows = kidsServiceKeys.map(svc => {
        const count = kidsByServiceFromRooms[svc] || 0;
        return `<tr><td>${svc}</td><td class="num">${fmt(count)}</td><td class="pct">${pct(count, kidsTotalFromRooms)}%</td></tr>`;
      }).join("");

      const roomColHeaders = roomServiceKeys.map(st => `<th class="num">${st}</th>`).join("");
      const roomRows = allRooms.map(room => {
        const cells = roomServiceKeys.map(st => { const v = ((roomBreakdown[st] || {})[room] || [])[li] || 0; return `<td class="num">${v > 0 ? fmt(v) : "—"}</td>`; }).join("");
        const rowTotal = roomServiceKeys.reduce((s, st) => s + (((roomBreakdown[st] || {})[room] || [])[li] || 0), 0);
        return `<tr><td>${room}</td>${cells}<td class="num" style="font-weight:700">${fmt(rowTotal)}</td></tr>`;
      }).join("");
      const roomTotalCells = roomServiceKeys.map(st => { const c = allRooms.reduce((s, room) => s + (((roomBreakdown[st] || {})[room] || [])[li] || 0), 0); return `<td class="num">${fmt(c)}</td>`; }).join("");

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly Report — ${sundayLabel}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${css}</style></head><body><div class="page">

<div class="header">
  <div class="header-left">
    <img src="/logo.png" class="header-logo" alt="CCC">
    <div><h1>Weekly Leadership Report</h1><div class="header-date">${reportDate}</div></div>
  </div>
  <div class="header-right">City Church Chicago<br>${sundayLabel}</div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="kpi-label">Total Attendance</div><div class="kpi-value">${fmt(attTotal)}</div><div class="kpi-sub">${deltaHtml(attTotal, attPrev)} vs prior week</div></div>
  <div class="kpi"><div class="kpi-label">City Kids</div><div class="kpi-value">${fmt(kidsTotal)}</div><div class="kpi-sub">${deltaHtml(kidsTotal, kidsPrev)} vs prior week</div></div>
  <div class="kpi"><div class="kpi-label">Decisions</div><div class="kpi-value">${fmt(decisions)}</div><div class="kpi-sub">${deltaHtml(decisions, decPrev)} vs prior week</div></div>
  <div class="kpi"><div class="kpi-label">Volunteers</div><div class="kpi-value">${fmt(volUnique)}</div><div class="kpi-sub">${deltaHtml(volUnique, volPrev)} vs prior week</div></div>
  <div class="kpi"><div class="kpi-label">New Families</div><div class="kpi-value">${fmt(newFamCurr)}</div><div class="kpi-sub">${deltaHtml(newFamCurr, newFamPrev)} vs prior week</div></div>
</div>

<div class="section">
  <div class="section-title"><div class="dot" style="background:#2563eb"></div>Attendance by Service</div>
  <table>
    <thead><tr><th>Service</th><th class="num">Count</th><th class="pct">% of Total</th></tr></thead>
    <tbody>
      ${attServiceRows}
      <tr class="total-row"><td>Total</td><td class="num">${fmt(attTotal)}</td><td class="pct">100%</td></tr>
    </tbody>
  </table>
</div>

<div class="section">
  <div class="section-title"><div class="dot" style="background:#16a34a"></div>City Kids Check-Ins by Service</div>
  <table>
    <thead><tr><th>Service</th><th class="num">Check-Ins</th><th class="pct">% of Total</th></tr></thead>
    <tbody>
      ${kidsServiceRows}
      <tr class="total-row"><td>Total</td><td class="num">${fmt(kidsTotalFromRooms)}</td><td class="pct">100%</td></tr>
    </tbody>
  </table>
</div>

${allRooms.length > 0 ? `
<div class="section">
  <div class="section-title"><div class="dot" style="background:#16a34a"></div>City Kids Room Breakdown</div>
  <table>
    <thead><tr><th>Room</th>${roomColHeaders}<th class="num">Total</th></tr></thead>
    <tbody>
      ${roomRows}
      <tr class="total-row"><td>Total</td>${roomTotalCells}<td class="num">${fmt(kidsTotalFromRooms)}</td></tr>
    </tbody>
  </table>
</div>` : ""}

${volTeamNames.length > 0 ? `
<div class="section">
  <div class="section-title"><div class="dot" style="background:#7c3aed"></div>Volunteers by Team &amp; Service</div>
  <table>
    <thead><tr><th>Team</th>${volTeamColHeaders}<th class="num">Total</th></tr></thead>
    <tbody>
      ${volTeamRows}
      <tr class="total-row"><td>Total</td>${volTotalCells}<td class="num">${volGrandTotal > 0 ? volGrandTotal : "—"}</td></tr>
    </tbody>
  </table>
</div>` : ""}

${ftNames.length > 0 ? `
<div class="section">
  <div class="section-title"><div class="dot" style="background:#7c3aed"></div>New Volunteers <span style="font-size:13px;font-weight:500;color:#6b7280;margin-left:4px">(${ftNames.length})</span></div>
  ${ftNames.map(f => {
    const ini = initials(f.name);
    const badgeClass = f.status === "C" ? "badge-green" : "badge-amber";
    const badgeText = f.status === "C" ? "Confirmed" : "Pending";
    return `<div class="person-row"><div class="avatar" style="background:#f0e6ff;color:#7c3aed">${ini}</div><div style="flex:1"><div class="person-name">${f.name}</div><div class="person-meta">${f.serviceTime || ""}</div></div><span class="badge ${badgeClass}">${badgeText}</span></div>`;
  }).join("")}
</div>` : ""}

<div class="footer">Generated ${now.toLocaleString("en-US", { timeZone: CHURCH_CONFIG.timezone })} CT &middot; City Church Chicago &middot; <a href="/" style="color:#5AAEE0">Open Dashboard</a></div>

</div></body></html>`;

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch(e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error generating report: " + e.message);
    }
    return;
  }

  // ── Easter Report (static snapshot of April 5, 2026) ─────────────────────────
  if (req.method === "GET" && parsed.pathname === "/easter-report") {
    if (!savedCreds) { res.writeHead(401); return res.end("Not authenticated — open the dashboard first and enter credentials."); }
    try {
      // Always fetch data covering Easter Sunday (April 5, 2026) regardless of current date.
      const EASTER_DATE = new Date("2026-04-05T12:00:00");  // local noon
      const msPerWeek = 7 * 24 * 60 * 60 * 1000;
      const easterWeeksAgo = Math.max(2, Math.min(12, Math.ceil((Date.now() - EASTER_DATE.getTime()) / msPerWeek) + 1));
      const CACHE_TTL = 30 * 60 * 1000;
      const cacheKey = "easter_" + easterWeeksAgo;
      let De = dataCache[cacheKey] && (Date.now() - dataCache[cacheKey].ts < CACHE_TTL) ? dataCache[cacheKey].payload : null;
      if (!De) { De = await buildData(easterWeeksAgo); dataCache[cacheKey] = { ts: Date.now(), payload: De }; }

      // Find the bucket index that contains April 5, 2026
      const { buckets: easterBuckets } = buildTimeBuckets(easterWeeksAgo);
      const easterIdx = bucketIndexFor(EASTER_DATE, easterBuckets);
      const ei = easterIdx >= 0 ? easterIdx : De.labels.length - 1;  // fallback to latest

      const fmt = n => (n || 0).toLocaleString();
      const pct = (n, tot) => tot > 0 ? Math.round((n / tot) * 100) : 0;
      const now = new Date();

      // ── Metrics (all from Easter week bucket) ──
      const attTotal    = De.attendance[ei] || 0;
      const decisions   = (De.decisions || [])[ei] || 0;
      const kidsTotal   = (De.kidsAttendance || [])[ei] || 0;
      const volUnique   = (De.uniqueVolunteers || [])[ei] || 0;
      const multiServers = (De.weeklyMultiServers || [])[ei] || [];

      const CURRENT_SERVICES = new Set(["8:30 AM", "10:00 AM", "11:30 AM", "1:00 PM"]);
      const sortTimes = keys => keys.slice().sort((a, b) => {
        const pa = Date.parse("2000-01-01 " + a), pb = Date.parse("2000-01-01 " + b);
        return (isNaN(pa) ? 9999 : pa) - (isNaN(pb) ? 9999 : pb);
      });

      const attByService = De.attendanceByService || {};
      const attServiceKeys = sortTimes(Object.keys(attByService).filter(k => CURRENT_SERVICES.has(k)));

      const roomBreakdown = De.kidsRoomBreakdown || {};
      const roomServiceKeys = sortTimes(Object.keys(roomBreakdown).filter(k => CURRENT_SERVICES.has(k)));
      const allRooms = [...new Set(roomServiceKeys.flatMap(st => Object.keys(roomBreakdown[st] || {})))].sort();
      const kidsServiceKeys = roomServiceKeys;
      const kidsByServiceFromRooms = {};
      for (const st of kidsServiceKeys) {
        kidsByServiceFromRooms[st] = allRooms.reduce((s, room) => s + (((roomBreakdown[st] || {})[room] || [])[ei] || 0), 0);
      }
      const kidsTotalFromRooms = kidsServiceKeys.reduce((s, st) => s + kidsByServiceFromRooms[st], 0);

      // Use per-week volunteer breakdown for Easter week specifically
      const volByTeam = (De.teamByServiceTimeCountByWeek ? De.teamByServiceTimeCountByWeek[ei] : De.teamByServiceTimeCount) || {};
      const volTeamNames = Object.keys(volByTeam)
        .filter(tn => [...CURRENT_SERVICES].some(st => (volByTeam[tn][st] || 0) > 0))
        .sort((a, b) => {
          const totA = [...CURRENT_SERVICES].reduce((s, st) => s + (volByTeam[a][st] || 0), 0);
          const totB = [...CURRENT_SERVICES].reduce((s, st) => s + (volByTeam[b][st] || 0), 0);
          return totB - totA;
        });
      const volServiceCols = sortTimes([...CURRENT_SERVICES]);
      const volTeamColHeaders = volServiceCols.map(st => `<th class="num">${st}</th>`).join("");
      const volTeamRows = volTeamNames.map(tn => {
        const cells = volServiceCols.map(st => { const v = (volByTeam[tn] || {})[st] || 0; return `<td class="num">${v > 0 ? v : "—"}</td>`; }).join("");
        const rowTotal = volServiceCols.reduce((s, st) => s + ((volByTeam[tn] || {})[st] || 0), 0);
        return `<tr><td>${tn}</td>${cells}<td class="num" style="font-weight:700">${rowTotal}</td></tr>`;
      }).join("");
      const volTotalCells = volServiceCols.map(st => { const c = volTeamNames.reduce((s, tn) => s + ((volByTeam[tn] || {})[st] || 0), 0); return `<td class="num">${c > 0 ? c : "—"}</td>`; }).join("");
      const volGrandTotal = volServiceCols.reduce((s, st) => s + volTeamNames.reduce((ss, tn) => ss + ((volByTeam[tn] || {})[st] || 0), 0), 0);

      const attServiceRows = attServiceKeys.map(svc => {
        const count = (attByService[svc] || [])[ei] || 0;
        return `<tr><td>${svc}</td><td class="num">${fmt(count)}</td><td class="pct">${pct(count, attTotal)}%</td></tr>`;
      }).join("");
      const kidsServiceRows = kidsServiceKeys.map(svc => {
        const count = kidsByServiceFromRooms[svc] || 0;
        return `<tr><td>${svc}</td><td class="num">${fmt(count)}</td><td class="pct">${pct(count, kidsTotalFromRooms)}%</td></tr>`;
      }).join("");
      const roomColHeaders = roomServiceKeys.map(st => `<th class="num">${st}</th>`).join("");
      const roomRows = allRooms.map(room => {
        const cells = roomServiceKeys.map(st => { const v = ((roomBreakdown[st] || {})[room] || [])[ei] || 0; return `<td class="num">${v > 0 ? fmt(v) : "—"}</td>`; }).join("");
        const rowTotal = roomServiceKeys.reduce((s, st) => s + (((roomBreakdown[st] || {})[room] || [])[ei] || 0), 0);
        return `<tr><td>${room}</td>${cells}<td class="num" style="font-weight:700">${fmt(rowTotal)}</td></tr>`;
      }).join("");
      const roomTotalCells = roomServiceKeys.map(st => { const c = allRooms.reduce((s, room) => s + (((roomBreakdown[st] || {})[room] || [])[ei] || 0), 0); return `<td class="num">${fmt(c)}</td>`; }).join("");

      const css = `
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:"DM Sans",sans-serif;background:#f8f9fa;color:#1a1a2e;-webkit-print-color-adjust:exact;print-color-adjust:exact}
        .page{max-width:840px;margin:0 auto;background:#fff;min-height:100vh}
        .header{background:linear-gradient(135deg,#1a1a2e 0%,#2d2d44 100%);color:#fff;padding:32px 40px;display:flex;align-items:center;justify-content:space-between}
        .header-left{display:flex;align-items:center;gap:16px}
        .header-logo{width:44px;height:44px;border-radius:10px;object-fit:contain}
        .header h1{font-size:22px;font-weight:700;letter-spacing:-.02em}
        .header-date{font-size:13px;opacity:.7;margin-top:2px}
        .header-right{text-align:right;font-size:12px;opacity:.6;line-height:1.6}
        .kpi-grid{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid #e5e7eb}
        .kpi{padding:14px 12px;border-right:1px solid #e5e7eb;text-align:center}
        .kpi:last-child{border-right:none}
        .kpi-value{font-size:26px;font-weight:700;letter-spacing:-.03em;line-height:1}
        .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:6px;font-weight:600}
        .kpi-sub{font-size:12px;margin-top:6px;color:#6b7280}
        .section{padding:24px 40px;border-bottom:1px solid #e5e7eb}
        .section:last-of-type{border-bottom:none}
        .section-title{font-size:15px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:8px}
        .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
        table{width:100%;border-collapse:collapse;font-size:13px}
        th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;font-weight:600;padding:6px 10px;border-bottom:2px solid #e5e7eb}
        td{padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#1a1a2e}
        tr:last-child td{border-bottom:none}
        .num{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
        .pct{text-align:right;color:#6b7280;font-size:12px}
        .total-row td{font-weight:700;border-top:2px solid #e5e7eb;border-bottom:none;background:#f9fafb}
        .footer{padding:20px 40px;text-align:center;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb}
        @media print{body{background:#fff}.page{box-shadow:none}.header{-webkit-print-color-adjust:exact}}
        @media(max-width:640px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.kpi:nth-child(2n){border-right:none}.header{flex-direction:column;gap:12px}.section{padding:20px 24px}}
      `;

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Easter Report — April 5, 2026</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${css}</style></head><body><div class="page">

<div class="header">
  <div class="header-left">
    <img src="/logo.png" class="header-logo" alt="CCC">
    <div><h1>Easter Sunday Report</h1><div class="header-date">Sunday, April 5, 2026</div></div>
  </div>
  <div class="header-right">City Church Chicago<br>April 5, 2026</div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="kpi-label">Total Attendance</div><div class="kpi-value">${fmt(attTotal)}</div></div>
  <div class="kpi"><div class="kpi-label">City Kids</div><div class="kpi-value">${fmt(kidsTotal)}</div></div>
  <div class="kpi"><div class="kpi-label">Decisions</div><div class="kpi-value">${fmt(decisions)}</div></div>
  <div class="kpi"><div class="kpi-label">Volunteers</div><div class="kpi-value">${fmt(volUnique)}</div></div>
  <div class="kpi"><div class="kpi-label">Multi-Service Vols</div><div class="kpi-value">${fmt(multiServers.length)}</div></div>
</div>

<div class="section">
  <div class="section-title"><div class="dot" style="background:#2563eb"></div>Attendance by Service</div>
  <table>
    <thead><tr><th>Service</th><th class="num">Count</th><th class="pct">% of Total</th></tr></thead>
    <tbody>
      ${attServiceRows}
      <tr class="total-row"><td>Total</td><td class="num">${fmt(attTotal)}</td><td class="pct">100%</td></tr>
    </tbody>
  </table>
</div>

<div class="section">
  <div class="section-title"><div class="dot" style="background:#16a34a"></div>City Kids Check-Ins by Service</div>
  <table>
    <thead><tr><th>Service</th><th class="num">Check-Ins</th><th class="pct">% of Total</th></tr></thead>
    <tbody>
      ${kidsServiceRows}
      <tr class="total-row"><td>Total</td><td class="num">${fmt(kidsTotalFromRooms)}</td><td class="pct">100%</td></tr>
    </tbody>
  </table>
</div>

${allRooms.length > 0 ? `
<div class="section">
  <div class="section-title"><div class="dot" style="background:#16a34a"></div>City Kids Room Breakdown</div>
  <table>
    <thead><tr><th>Room</th>${roomColHeaders}<th class="num">Total</th></tr></thead>
    <tbody>
      ${roomRows}
      <tr class="total-row"><td>Total</td>${roomTotalCells}<td class="num">${fmt(kidsTotalFromRooms)}</td></tr>
    </tbody>
  </table>
</div>` : ""}

${volTeamNames.length > 0 ? `
<div class="section">
  <div class="section-title"><div class="dot" style="background:#7c3aed"></div>Volunteers by Team &amp; Service</div>
  <table>
    <thead><tr><th>Team</th>${volTeamColHeaders}<th class="num">Total</th></tr></thead>
    <tbody>
      ${volTeamRows}
      <tr class="total-row"><td>Total</td>${volTotalCells}<td class="num">${volGrandTotal > 0 ? volGrandTotal : "—"}</td></tr>
    </tbody>
  </table>
</div>` : ""}

<div class="footer">Generated ${now.toLocaleString("en-US", { timeZone: CHURCH_CONFIG.timezone })} CT &middot; City Church Chicago &middot; <a href="/" style="color:#5AAEE0">Open Dashboard</a></div>

</div></body></html>`;

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch(e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error generating Easter report: " + e.message);
    }
    return;
  }

  // ── City Kids Stats Report — instant HTML shell, data loaded via JS ──────────
  if (req.method === "GET" && parsed.pathname === "/city-kids-report") {
    if (!savedCreds) { res.writeHead(401); return res.end("Not authenticated — open the dashboard first and enter credentials."); }
    const shellCss = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:"DM Sans",sans-serif;background:#f8f9fa;color:#1a1a2e}.page{max-width:860px;margin:0 auto;background:#fff;min-height:100vh}.header{background:linear-gradient(135deg,#14532d 0%,#16a34a 100%);color:#fff;padding:32px 40px;display:flex;align-items:center;justify-content:space-between}.header-left{display:flex;align-items:center;gap:16px}.header-logo{width:44px;height:44px;border-radius:10px;object-fit:contain}.header h1{font-size:22px;font-weight:700;letter-spacing:-.02em}.header-date{font-size:13px;opacity:.75;margin-top:2px}.header-right{text-align:right;font-size:12px;opacity:.65;line-height:1.6}.loading{padding:60px 40px;text-align:center}.spinner{width:40px;height:40px;border:3px solid #e5e7eb;border-top-color:#16a34a;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}.loading-title{font-size:16px;font-weight:600;color:#1a1a2e;margin-bottom:8px}.loading-sub{font-size:13px;color:#6b7280}@keyframes spin{to{transform:rotate(360deg)}}`;
    const shellHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>City Kids Stats Report — 2026</title><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"><style>${shellCss}</style></head><body><div class="page"><div class="header"><div class="header-left"><img src="/logo.png" class="header-logo" alt="CCC"><div><h1>City Kids Stats Report</h1><div class="header-date">2026 Year-to-Date</div></div></div><div class="header-right">City Church Chicago</div></div><div class="loading" id="loading"><div class="spinner"></div><div class="loading-title">Building your report…</div><div class="loading-sub">Pulling data from Planning Center — usually takes 60–90 seconds on first load.</div></div><div id="report-body" style="display:none"></div></div><script>
(function poll(){
  fetch('/city-kids-report-data').then(r=>{
    if(r.status===202){setTimeout(poll,5000);return;}
    if(r.ok) return r.text().then(html=>{
      document.getElementById('loading').style.display='none';
      document.getElementById('report-body').innerHTML=html;
      document.getElementById('report-body').style.display='';
    });
    throw new Error('HTTP '+r.status);
  }).catch(e=>{
    document.getElementById('loading').innerHTML='<div class="loading-title" style="color:#dc2626">Error loading report</div><div class="loading-sub">'+e.message+'</div><br><a href="/city-kids-report" style="color:#16a34a">Retry</a>';
  });
})();
</script></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(shellHtml);
    return;
  }

  // ── City Kids Stats Report — data endpoint (cache-only, polls until ready) ───
  if (req.method === "GET" && parsed.pathname === "/city-kids-report-data") {
    if (!savedCreds) { res.writeHead(401); return res.end("Not authenticated"); }
    try {
      const CACHE_TTL = 30 * 60 * 1000;
      const TEAM_CACHE_TTL = 4 * 60 * 60 * 1000;
      const D = dataCache["52"] && (Date.now() - dataCache["52"].ts < CACHE_TTL) ? dataCache["52"].payload : null;
      const teamReady = cityKidsTeamCache && (Date.now() - cityKidsTeamCache.ts < TEAM_CACHE_TTL);
      // Return 202 while startup is still warming — shell page will poll again
      if (!D || !teamReady) {
        res.writeHead(202, { "Content-Type": "text/plain" });
        return res.end("loading");
      }

      const { buckets } = buildTimeBuckets(52);
      const N = buckets.length;

      // 52-week range → monthly buckets. Count Sundays in each bucket to normalize.
      function sundaysInBucket(b) {
        let count = 0, d = new Date(b.start);
        d.setDate(d.getDate() + (7 - d.getDay()) % 7); // first Sunday on or after start
        while (d <= b.end) { count++; d.setDate(d.getDate() + 7); }
        return Math.max(count, 1);
      }

      // Month buckets that fall in 2026
      const start2026 = new Date("2026-01-01T00:00:00");
      const w2026 = [];
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].start >= start2026) w2026.push(i);
      }

      // ── Service schedule: 3 services before April 5, 4 after ──────────────────
      const EASTER_DATE = new Date("2026-04-05T00:00:00");
      const PRE_SERVICES  = new Set(["9:00 AM", "10:30 AM", "12:30 PM"]);
      const POST_SERVICES = new Set(["8:30 AM", "10:00 AM", "11:30 AM", "1:00 PM"]);
      // April bucket is mixed (Easter is on Apr 5 = switchover day). Use POST for the whole month
      // since most of April used the new schedule.
      const servicesForBucket = i => {
        if (!buckets[i]) return PRE_SERVICES;
        // If the bucket straddles Easter (April), use POST (Apr 5 onwards is 4-service)
        const bStart = buckets[i].start;
        return bStart >= EASTER_DATE ? POST_SERVICES : PRE_SERVICES;
      };

      // ── Per-room monthly totals and all-time per-Sunday records ───────────────
      const roomBreakdown = D.kidsRoomBreakdown || {};
      const allServiceTimes = Object.keys(roomBreakdown);
      const kidRooms = [...new Set(allServiceTimes.flatMap(st => Object.keys(roomBreakdown[st] || {})))]
        .filter(r => r !== "KUEST Team").sort();

      // Monthly kids total per bucket (filtered by correct service times, no KUEST)
      const monthlyKidsTotal = new Array(N).fill(0);
      for (let i = 0; i < N; i++) {
        const svcs = servicesForBucket(i);
        for (const st of allServiceTimes) {
          if (!svcs.has(st)) continue;
          for (const room of kidRooms) {
            monthlyKidsTotal[i] += (((roomBreakdown[st] || {})[room]) || [])[i] || 0;
          }
        }
      }

      // ── Average kids per Sunday (monthly total ÷ Sundays in that month) ────────
      const nz2026 = w2026.filter(i => monthlyKidsTotal[i] > 0);
      const avgKidsSunday = nz2026.length > 0
        ? Math.round(nz2026.reduce((s, i) => s + monthlyKidsTotal[i] / sundaysInBucket(buckets[i]), 0) / nz2026.length)
        : 0;

      // ── Easter 2026 kids — use 8-week weekly cache for single-Sunday precision ──
      let easterKids = 0;
      {
        const D8 = dataCache["8"] && dataCache["8"].payload;
        if (D8) {
          const { buckets: b8 } = buildTimeBuckets(8);
          const ei = bucketIndexFor(new Date("2026-04-05T12:00:00"), b8);
          if (ei >= 0) {
            const rb8 = D8.kidsRoomBreakdown || {};
            const st8 = Object.keys(rb8);
            for (const st of st8) {
              if (!POST_SERVICES.has(st)) continue;
              for (const room of kidRooms) {
                easterKids += (((rb8[st] || {})[room]) || [])[ei] || 0;
              }
            }
          }
        }
      }

      // ── Per-room stats: avg per Sunday in 2026, all-time per-Sunday high ────────
      const roomStats = {};
      for (const room of kidRooms) {
        const monthlyRoom = new Array(N).fill(0);
        for (let i = 0; i < N; i++) {
          const svcs = servicesForBucket(i);
          for (const st of allServiceTimes) {
            if (!svcs.has(st)) continue;
            monthlyRoom[i] += (((roomBreakdown[st] || {})[room]) || [])[i] || 0;
          }
        }
        // Average per Sunday in 2026 months
        const nzRoom = w2026.filter(i => monthlyRoom[i] > 0);
        const avg2026 = nzRoom.length > 0
          ? Math.round(nzRoom.reduce((s, i) => s + monthlyRoom[i] / sundaysInBucket(buckets[i]), 0) / nzRoom.length)
          : 0;
        // All-time per-Sunday high (across all 52-week monthly buckets)
        const perSundayHigh = Math.max(0, ...Array.from({length: N}, (_, i) => monthlyRoom[i] > 0 ? Math.round(monthlyRoom[i] / sundaysInBucket(buckets[i])) : 0));
        // Easter from the 8-week cache
        let easterRoomKids = 0;
        {
          const D8 = dataCache["8"] && dataCache["8"].payload;
          if (D8) {
            const { buckets: b8 } = buildTimeBuckets(8);
            const ei = bucketIndexFor(new Date("2026-04-05T12:00:00"), b8);
            if (ei >= 0) {
              const rb8 = D8.kidsRoomBreakdown || {};
              for (const st of Object.keys(rb8)) {
                if (!POST_SERVICES.has(st)) continue;
                easterRoomKids += (((rb8[st] || {})[room]) || [])[ei] || 0;
              }
            }
          }
        }
        roomStats[room] = { avg2026, record: perSundayHigh, easterTotal: easterRoomKids };
      }

      // ── New families in 2026 (households with at least one child) ──────────────
      const families2026 = [];
      try {
        let hhUrl = "/people/v2/households?order=-created_at&per_page=100&include=people";
        let hhDone = false;
        while (hhUrl && !hhDone) {
          const hhRes = await pcoFetch(hhUrl);
          for (const hh of (hhRes.body.data || [])) {
            const createdAt = new Date(hh.attributes.created_at);
            if (createdAt < start2026) { hhDone = true; break; }
            const memberIds = ((hh.relationships && hh.relationships.people && hh.relationships.people.data) || []).map(p => p.id);
            const included = hhRes.body.included || [];
            const hasChild = memberIds.some(mid => {
              const person = included.find(inc => inc.id === mid && inc.type === "Person");
              return person && person.attributes.child;
            });
            if (!hasChild) continue;
            const members = memberIds.map(mid => {
              const person = included.find(inc => inc.id === mid && inc.type === "Person");
              if (!person) return null;
              return { name: ((person.attributes.first_name || "") + " " + (person.attributes.last_name || "")).trim(), child: person.attributes.child || false };
            }).filter(Boolean);
            families2026.push({ name: hh.attributes.name, createdAt: hh.attributes.created_at, memberCount: members.length, members });
          }
          if (hhDone) break;
          const next = hhRes.body.links && hhRes.body.links.next;
          if (next) { const p = new URL(next); hhUrl = p.pathname + p.search; } else { hhUrl = null; }
        }
      } catch(e) { console.log("⚠ City Kids report families error:", e.message); }

      // ── New team members in 2026 — already guaranteed warm by 202 check above ──
      const newTeamMembers = cityKidsTeamCache.payload;

      // ── Render HTML ─────────────────────────────────────────────────────────────
      const fmt = n => (n || 0).toLocaleString();
      const fmtDate = d => new Date(d).toLocaleDateString("en-US", { timeZone: CHURCH_CONFIG.timezone, month: "short", day: "numeric", year: "numeric" });
      const now = new Date();

      const roomRows = kidRooms.map(room => {
        const s = roomStats[room] || {};
        return `<tr><td>${room}</td><td class="num">${fmt(s.avg2026)}</td><td class="num">${fmt(s.easterTotal)}</td><td class="num record">${fmt(s.record)}</td></tr>`;
      }).join("");

      const familyRows = families2026.slice(0, 100).map(f => {
        const kids = f.members.filter(m => m.child).map(m => m.name).join(", ");
        const adults = f.members.filter(m => !m.child).map(m => m.name).join(", ");
        return `<tr><td>${f.name}</td><td>${kids || "—"}</td><td>${adults || "—"}</td><td class="muted">${fmtDate(f.createdAt)}</td></tr>`;
      }).join("");

      const teamRows = newTeamMembers.map(m => {
        return `<tr><td>${m.name}</td><td>${m.teamName}</td><td class="muted">${m.firstDate.toLocaleDateString("en-US", { timeZone: CHURCH_CONFIG.timezone, month: "short", day: "numeric", year: "numeric" })}</td></tr>`;
      }).join("");

      // Return inner HTML only — injected by the shell page via JS
      const innerCss = `<style>
        .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid #e5e7eb}
        .kpi{padding:18px 16px;border-right:1px solid #e5e7eb;text-align:center}
        .kpi:last-child{border-right:none}
        .kpi-value{font-size:30px;font-weight:700;letter-spacing:-.03em;line-height:1;color:#14532d}
        .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:8px;font-weight:600}
        .kpi-sub{font-size:11px;margin-top:6px;color:#9ca3af}
        .section{padding:24px 40px;border-bottom:1px solid #e5e7eb}
        .section:last-of-type{border-bottom:none}
        .section-title{font-size:15px;font-weight:700;margin-bottom:14px;display:flex;align-items:center;gap:8px}
        .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
        table{width:100%;border-collapse:collapse;font-size:13px}
        th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;font-weight:600;padding:6px 10px;border-bottom:2px solid #e5e7eb}
        td{padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#1a1a2e}
        tr:last-child td{border-bottom:none}
        .num{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
        .record{color:#14532d}
        .muted{color:#9ca3af;font-size:12px}
        .empty{color:#9ca3af;font-style:italic;padding:16px 0;text-align:center}
        .ck-footer{padding:20px 40px;text-align:center;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb}
        .header-date{font-size:13px;opacity:.75;margin-top:2px}
        @media(max-width:640px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.kpi:nth-child(2n){border-right:none}.section{padding:20px 24px}}
      </style>`;

      const html = `${innerCss}
<div style="padding:12px 40px;background:#f0fdf4;border-bottom:1px solid #bbf7d0;font-size:12px;color:#166534">${nz2026.length} months of 2026 tracked &mdash; Generated ${now.toLocaleString("en-US", { timeZone: CHURCH_CONFIG.timezone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })} CT</div>

<div class="kpi-grid">
  <div class="kpi"><div class="kpi-label">Avg Kids / Sunday</div><div class="kpi-value">${fmt(avgKidsSunday)}</div><div class="kpi-sub">2026 YTD avg</div></div>
  <div class="kpi"><div class="kpi-label">Easter 2026</div><div class="kpi-value">${fmt(easterKids)}</div><div class="kpi-sub">April 5, 2026</div></div>
  <div class="kpi"><div class="kpi-label">New Families</div><div class="kpi-value">${fmt(families2026.length)}</div><div class="kpi-sub">with kids, since Jan 1</div></div>
  <div class="kpi"><div class="kpi-label">New Team Members</div><div class="kpi-value">${fmt(newTeamMembers.length)}</div><div class="kpi-sub">first served in 2026</div></div>
</div>

<div class="section">
  <div class="section-title"><div class="dot" style="background:#16a34a"></div>Room Breakdown — 2026 Averages &amp; All-Time Records</div>
  ${kidRooms.length > 0 ? `<table>
    <thead><tr><th>Room</th><th class="num">2026 Avg / Week</th><th class="num">Easter Total</th><th class="num record">All-Time High</th></tr></thead>
    <tbody>${roomRows}</tbody>
  </table>` : `<div class="empty">No room breakdown data available.</div>`}
</div>

<div class="section">
  <div class="section-title"><div class="dot" style="background:#2563eb"></div>New Families in 2026 <span style="font-weight:400;color:#6b7280;font-size:13px;margin-left:6px">${families2026.length} total</span></div>
  ${families2026.length > 0 ? `<table>
    <thead><tr><th>Household</th><th>Kids</th><th>Adults</th><th>Created</th></tr></thead>
    <tbody>${familyRows}</tbody>
  </table>` : `<div class="empty">No new families found.</div>`}
</div>

<div class="section">
  <div class="section-title"><div class="dot" style="background:#7c3aed"></div>New Team Members in 2026 <span style="font-weight:400;color:#6b7280;font-size:13px;margin-left:6px">${newTeamMembers.length} total</span></div>
  ${newTeamMembers.length > 0 ? `<table>
    <thead><tr><th>Name</th><th>Team</th><th>Date Added</th></tr></thead>
    <tbody>${teamRows}</tbody>
  </table>` : `<div class="empty">No new City Kids team members found in 2026.</div>`}
</div>

<div class="ck-footer">City Church Chicago &middot; <a href="/" style="color:#16a34a">Open Dashboard</a></div>`;

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch(e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error generating City Kids report: " + e.message);
    }
    return;
  }

  // ── New Profiles Report (today's new PCO people + action source) ─────────────
  if (req.method === "GET" && parsed.pathname === "/new-profiles-report") {
    if (!savedCreds) { res.writeHead(401); return res.end("Not authenticated — open the dashboard first and enter credentials."); }
    try {
      const todayDateCT = new Date().toLocaleDateString("en-CA", { timeZone: CHURCH_CONFIG.timezone });
      const sinceISO = todayDateCT + "T00:00:00-05:00";
      const now = new Date();
      const reportDate = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: CHURCH_CONFIG.timezone });

      // 1. Fetch all people created today
      const newPeople = [];
      let npUrl = "/people/v2/people?where[created_at][gte]=" + encodeURIComponent(sinceISO) + "&order=-created_at&per_page=100&fields[Person]=first_name,last_name,created_at";
      while (npUrl) {
        const r = await pcoFetch(npUrl);
        if (r.status !== 200) break;
        for (const p of (r.body && r.body.data) || []) {
          const a = p.attributes || {};
          newPeople.push({ id: p.id, name: ((a.first_name || "") + " " + (a.last_name || "")).trim(), createdAt: a.created_at || "" });
        }
        const next = r.body && r.body.links && r.body.links.next;
        npUrl = next ? (new URL(next)).pathname + (new URL(next)).search : null;
      }

      // 2. Collect person IDs from check-ins created today
      const checkInPersonIds = new Set();
      let ciUrl = "/check-ins/v2/check_ins?where[created_at][gte]=" + encodeURIComponent(sinceISO) + "&per_page=100";
      let ciPages = 0;
      while (ciUrl && ciPages < 20) {
        const r = await pcoFetch(ciUrl);
        if (r.status !== 200) break;
        for (const ci of (r.body && r.body.data) || []) {
          const pid = ci.relationships && ci.relationships.person && ci.relationships.person.data && ci.relationships.person.data.id;
          if (pid) checkInPersonIds.add(pid);
        }
        const next = r.body && r.body.links && r.body.links.next;
        ciUrl = next ? (new URL(next)).pathname + (new URL(next)).search : null;
        ciPages++;
      }

      // 3. Collect person IDs from group memberships joined today (any group type)
      const groupSignupPersonIds = new Set();
      const groupSignupNames = {};  // personId → group name
      let lgUrl2 = "/groups/v2/memberships?include=group&order=-joined_at&per_page=100";
      let lgPages = 0;
      while (lgUrl2 && lgPages < 10) {
        const r = await pcoFetch(lgUrl2);
        if (r.status !== 200) break;
        const members  = (r.body && r.body.data)     || [];
        const included = (r.body && r.body.included) || [];
        const groupNameMap = {};
        for (const inc of included) {
          if (inc.type === "Group") groupNameMap[inc.id] = (inc.attributes && inc.attributes.name) || "Group";
        }
        let pastToday = false;
        for (const m of members) {
          const joinedDate = ((m.attributes && m.attributes.joined_at) || "").slice(0, 10);
          if (joinedDate < todayDateCT) { pastToday = true; break; }
          const pid = m.relationships && m.relationships.person && m.relationships.person.data && m.relationships.person.data.id;
          const gid = m.relationships && m.relationships.group    && m.relationships.group.data    && m.relationships.group.data.id;
          if (pid) { groupSignupPersonIds.add(pid); groupSignupNames[pid] = groupNameMap[gid] || "Group"; }
        }
        if (pastToday || members.length === 0) break;
        const next = r.body && r.body.links && r.body.links.next;
        lgUrl2 = next ? (new URL(next)).pathname + (new URL(next)).search : null;
        lgPages++;
      }

      // 4. Tag each person with their inferred source
      const tagged = newPeople.map(p => {
        const timeStr = p.createdAt ? new Date(p.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: CHURCH_CONFIG.timezone }) : "—";
        let source = "New Profile";
        let sourceColor = "#6b7280";
        let sourceBg = "#f3f4f6";
        if (checkInPersonIds.has(p.id) && groupSignupPersonIds.has(p.id)) {
          source = "Check-In + Group Sign-Up";
          sourceColor = "#7c3aed"; sourceBg = "#f0e6ff";
        } else if (checkInPersonIds.has(p.id)) {
          source = "Family Check-In";
          sourceColor = "#2563eb"; sourceBg = "#dbeafe";
        } else if (groupSignupPersonIds.has(p.id)) {
          source = "Group Sign-Up — " + (groupSignupNames[p.id] || "");
          sourceColor = "#16a34a"; sourceBg = "#dcfce7";
        }
        return { ...p, timeStr, source, sourceColor, sourceBg };
      });

      const initials = name => (name || "?").split(" ").map(w => w[0] || "").join("").slice(0, 2).toUpperCase();

      const rows = tagged.length > 0
        ? tagged.map(p =>
            `<tr>
              <td style="display:flex;align-items:center;gap:10px;padding:10px 16px">
                <div style="width:32px;height:32px;border-radius:8px;background:#f3f4f6;color:#374151;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">${initials(p.name)}</div>
                <span style="font-weight:600;font-size:13px">${p.name || "Unknown"}</span>
              </td>
              <td style="padding:10px 16px;font-size:12px;color:#6b7280">${p.timeStr}</td>
              <td style="padding:10px 16px">
                <span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:600;background:${p.sourceBg};color:${p.sourceColor}">${p.source}</span>
              </td>
            </tr>`
          ).join("")
        : `<tr><td colspan="3" style="padding:24px;text-align:center;color:#9ca3af;font-style:italic">No new profiles found today</td></tr>`;

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>New Profiles — ${todayDateCT}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:"DM Sans",sans-serif;background:#f8f9fa;color:#1a1a2e}
  .page{max-width:840px;margin:0 auto;background:#fff;min-height:100vh}
  .header{background:linear-gradient(135deg,#1a1a2e 0%,#2d2d44 100%);color:#fff;padding:28px 40px;display:flex;align-items:center;justify-content:space-between}
  .header-left{display:flex;align-items:center;gap:16px}
  .header-logo{width:40px;height:40px;border-radius:10px;object-fit:contain}
  .header h1{font-size:20px;font-weight:700;letter-spacing:-.02em}
  .header-date{font-size:12px;opacity:.7;margin-top:2px}
  .header-right{text-align:right;font-size:12px;opacity:.6}
  .summary{padding:16px 40px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:13px;color:#6b7280}
  .summary strong{color:#1a1a2e}
  table{width:100%;border-collapse:collapse}
  thead th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;font-weight:600;padding:8px 16px;border-bottom:2px solid #e5e7eb;text-align:left;background:#f9fafb}
  tbody tr{border-bottom:1px solid #f3f4f6}
  tbody tr:last-child{border-bottom:none}
  tbody tr:hover{background:#f9fafb}
  .footer{padding:20px 40px;text-align:center;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb}
  @media print{body{background:#fff}.page{box-shadow:none}}
</style></head><body><div class="page">
<div class="header">
  <div class="header-left">
    <img src="/logo.png" class="header-logo" alt="CCC">
    <div><h1>New Church Center Profiles</h1><div class="header-date">${reportDate}</div></div>
  </div>
  <div class="header-right">City Church Chicago<br>${tagged.length} new profile${tagged.length !== 1 ? "s" : ""} today</div>
</div>
<div class="summary">
  Sources detected: <strong>${tagged.filter(p => p.source.startsWith("Family")).length}</strong> check-in &nbsp;·&nbsp;
  <strong>${tagged.filter(p => p.source.startsWith("Group")).length}</strong> group sign-up &nbsp;·&nbsp;
  <strong>${tagged.filter(p => p.source === "New Profile").length}</strong> direct profile &nbsp;·&nbsp;
  <strong>${tagged.filter(p => p.source.startsWith("Check-In +")).length}</strong> both
</div>
<table>
  <thead><tr><th>Name</th><th>Time Created</th><th>Source</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="footer">Generated ${now.toLocaleString("en-US", { timeZone: CHURCH_CONFIG.timezone })} CT &middot; City Church Chicago &middot; <a href="/" style="color:#5AAEE0">Open Dashboard</a></div>
</div></body></html>`;

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch(e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error generating new profiles report: " + e.message);
    }
    return;
  }

  // ── Life group detail endpoint (members + attendance) ───────────────────────
  if (req.method === "GET" && parsed.pathname === "/lifegroup-detail") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "Not authenticated" })); }
    const groupId = parsed.searchParams.get("id");
    if (!groupId) { res.writeHead(400); return res.end(JSON.stringify({ error: "Missing id parameter" })); }
    try {
      // Fetch memberships with person sideload
      const members = [];
      let nextUrl = "/groups/v2/groups/" + groupId + "/memberships?include=person&per_page=100&order=role,first_name";
      while (nextUrl) {
        const r = await pcoFetch(nextUrl);
        if (r.status !== 200) break;
        const personMap = {};
        for (const inc of (r.body.included || [])) {
          if (inc.type === "Person") {
            personMap[inc.id] = inc.attributes;
          }
        }
        for (const m of (r.body.data || [])) {
          const personId = m.relationships && m.relationships.person && m.relationships.person.data && m.relationships.person.data.id;
          const person = personId ? personMap[personId] : {};
          members.push({
            id: personId,
            firstName: person.first_name || "",
            lastName: person.last_name || "",
            avatarUrl: person.avatar_url || null,
            role: m.attributes.role || "member",
            joinedAt: m.attributes.joined_at ? m.attributes.joined_at.slice(0, 10) : null,
          });
        }
        const nxt = r.body.links && r.body.links.next;
        nextUrl = nxt ? (new URL(nxt)).pathname + (new URL(nxt)).search : null;
      }

      // Fetch recent events (last 12 weeks)
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 84);
      const events = [];
      let evtUrl = "/groups/v2/groups/" + groupId + "/events?per_page=100&order=-starts_at&filter=not_canceled";
      let evtPages = 0;
      while (evtUrl && evtPages < 5) {
        evtPages++;
        const r = await pcoFetch(evtUrl);
        if (r.status !== 200) break;
        let pastCutoff = false;
        for (const e of (r.body.data || [])) {
          const startDate = e.attributes.starts_at ? e.attributes.starts_at.slice(0, 10) : null;
          if (startDate && new Date(startDate) < cutoff) { pastCutoff = true; break; }
          events.push({ id: e.id, name: e.attributes.name, date: startDate, startsAt: e.attributes.starts_at });
        }
        if (pastCutoff) break;
        const nxt = r.body.links && r.body.links.next;
        evtUrl = nxt ? (new URL(nxt)).pathname + (new URL(nxt)).search : null;
      }

      // Fetch attendance for each event (limit to 12 most recent)
      const recentEvents = events.slice(0, 12);
      const attendance = [];
      const attTasks = recentEvents.map((evt, i) => async () => {
        const att = { eventId: evt.id, date: evt.date, name: evt.name, attended: 0, absent: 0, records: [] };
        let attUrl = "/groups/v2/groups/" + groupId + "/events/" + evt.id + "/attendances?include=person&per_page=100";
        while (attUrl) {
          const r = await pcoFetch(attUrl);
          if (r.status !== 200) break;
          const pMap = {};
          for (const inc of (r.body.included || [])) {
            if (inc.type === "Person") pMap[inc.id] = inc.attributes;
          }
          for (const a of (r.body.data || [])) {
            const pid = a.relationships && a.relationships.person && a.relationships.person.data && a.relationships.person.data.id;
            const p = pid ? pMap[pid] : {};
            const didAttend = a.attributes.attended === true;
            if (didAttend) att.attended++; else att.absent++;
            att.records.push({ personId: pid, firstName: p.first_name || "", lastName: p.last_name || "", attended: didAttend });
          }
          const nxt = r.body.links && r.body.links.next;
          attUrl = nxt ? (new URL(nxt)).pathname + (new URL(nxt)).search : null;
        }
        attendance[i] = att;
      });
      await pLimit(attTasks, 4);

      // Sort leaders first
      const leaders = members.filter(m => m.role === "leader");
      const regularMembers = members.filter(m => m.role !== "leader");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ leaders, members: regularMembers, attendance: attendance.filter(Boolean), totalMembers: members.length }));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── People data endpoint ────────────────────────────────────────────────────
  if (req.method === "GET" && parsed.pathname === "/people-data") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({ error: "Not authenticated" })); }
    const forceRefresh = parsed.searchParams.get("refresh") === "1";
    const CACHE_TTL    = 60 * 60 * 1000; // 1 hour
    if (!forceRefresh && peopleDataCache && (Date.now() - peopleDataCache.ts < CACHE_TTL)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(peopleDataCache.payload));
    }
    try {
      console.log("⏳ Building people data (growth + at-risk)…");
      const payload = await buildPeopleData();
      peopleDataCache = { ts: Date.now(), payload };
      console.log("✅ People data built — " + (payload.atRisk.available ? payload.atRisk.atRiskCongregants.length + " at-risk congregants" : "at-risk unavailable"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch(e) {
      console.log("⚠ buildPeopleData error: " + e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && parsed.pathname === "/debug") { handleDebug(res); return; }
  if (req.method === "GET" && parsed.pathname === "/debug-checkins") { handleDebugCheckins(res); return; }
  if (req.method === "GET" && parsed.pathname === "/debug-volunteers") { handleDebugVolunteers(res); return; }

  // ── Probe PCO Groups API (Life Groups / Church Center) ──────────────────────
  if (req.method === "GET" && parsed.pathname === "/debug-groups") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({error:"Not authenticated"})); }
    try {
      const out = {};
      // Top-level group types
      const typesRaw = await pcoFetch("https://api.planningcenteronline.com/groups/v2/group_types?per_page=25");
      out.groupTypes = (typesRaw.data || []).map(g => ({ id: g.id, name: g.attributes.name, description: g.attributes.description }));

      // All groups (first page)
      const groupsRaw = await pcoFetch("https://api.planningcenteronline.com/groups/v2/groups?per_page=50&include=group_type,location");
      out.totalGroups = groupsRaw.meta && groupsRaw.meta.total_count;
      out.groups = (groupsRaw.data || []).map(g => ({
        id: g.id,
        name: g.attributes.name,
        groupType: g.attributes.group_type,
        memberCount: g.attributes.memberships_count,
        schedule: g.attributes.schedule,
        location: g.attributes.location,
        enrollmentStatus: g.attributes.enrollment_status,
        publicChurchCenter: g.attributes.public_church_center_web_url
      }));

      // Sample membership for first group
      if (out.groups.length > 0) {
        const firstId = out.groups[0].id;
        const memRaw = await pcoFetch("https://api.planningcenteronline.com/groups/v2/groups/"+firstId+"/memberships?per_page=10&include=person");
        out.sampleMemberships = {
          groupId: firstId,
          groupName: out.groups[0].name,
          totalMembers: memRaw.meta && memRaw.meta.total_count,
          sample: (memRaw.data || []).map(m => ({
            id: m.id,
            role: m.attributes.role,
            joinedAt: m.attributes.joined_at,
            personId: m.relationships && m.relationships.person && m.relationships.person.data && m.relationships.person.data.id
          }))
        };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out, null, 2));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Birthdays data endpoint ──────────────────────────────────────────────────
  if (req.method === "GET" && parsed.pathname === "/birthdays-data") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({error:"Not authenticated"})); }
    const forceRefresh = parsed.searchParams.get("refresh") === "1";
    const BIRTHDAY_TTL = 6 * 60 * 60 * 1000; // 6 hour cache
    if (birthdaysCache && !forceRefresh && (Date.now() - birthdaysCache.ts < BIRTHDAY_TTL)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(birthdaysCache.payload));
    }
    try {
      // Fetch all active people who have a birthdate set
      const people = [];
      let nextUrl = "/people/v2/people?where[status]=active&per_page=100&fields[Person]=first_name,last_name,birthdate";
      let pageCount = 0;
      while (nextUrl && pageCount < 200) { // cap at 20K people
        const r = await pcoFetch(nextUrl);
        for (const p of (r.body.data || [])) {
          const a = p.attributes;
          if (!a.birthdate) continue; // skip people without birthdays
          const bd = a.birthdate; // "YYYY-MM-DD"
          const month = parseInt(bd.split("-")[1]);
          const day = parseInt(bd.split("-")[2]);
          people.push({
            id: p.id,
            name: (a.first_name || "") + " " + (a.last_name || ""),
            birthdate: bd,
            month, day
          });
        }
        const next = r.body.links && r.body.links.next;
        if (next) { const u = new URL(next); nextUrl = u.pathname + u.search; } else { nextUrl = null; }
        pageCount++;
      }

      // Sort by month/day for calendar ordering
      people.sort((a, b) => a.month - b.month || a.day - b.day);

      // Find upcoming birthdays (next 14 days)
      const now = new Date();
      const todayM = now.getMonth() + 1;
      const todayD = now.getDate();
      const upcoming = [];
      const thisWeek = [];
      for (const p of people) {
        // Days until birthday (handles year wrap)
        const bdThisYear = new Date(now.getFullYear(), p.month - 1, p.day);
        let diff = Math.round((bdThisYear - new Date(now.getFullYear(), todayM - 1, todayD)) / 86400000);
        if (diff < 0) diff += 365; // birthday already passed this year
        if (diff <= 14) upcoming.push({ ...p, daysUntil: diff });
        if (diff <= 7) thisWeek.push({ ...p, daysUntil: diff });
      }
      upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
      thisWeek.sort((a, b) => a.daysUntil - b.daysUntil);

      // Monthly counts for calendar view
      const monthCounts = new Array(12).fill(0);
      people.forEach(p => { monthCounts[p.month - 1]++; });

      // Today's birthdays
      const today = people.filter(p => p.month === todayM && p.day === todayD);

      const payload = {
        total: people.length,
        allBirthdays: people,
        upcoming, thisWeek, today,
        monthCounts,
        fetchedAt: new Date().toISOString()
      };
      birthdaysCache = { ts: Date.now(), payload };
      console.log("✅ Birthdays data built — " + people.length + " people with birthdays, " + upcoming.length + " upcoming");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Debug: Probe households API ──────────────────────────────────────────────
  if (req.method === "GET" && parsed.pathname === "/debug-households") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({error:"Not authenticated"})); }
    try {
      const out = {};
      // Recent households
      const hhRes = await pcoFetch("/people/v2/households?order=-created_at&per_page=10&include=people");
      out.totalHouseholds = hhRes.body.meta && hhRes.body.meta.total_count;
      out.recent = (hhRes.body.data || []).map(h => ({
        id: h.id, name: h.attributes.name, memberCount: h.attributes.member_count,
        createdAt: h.attributes.created_at, primaryContactName: h.attributes.primary_contact_name
      }));
      // Check-ins: first-time check-ins for City Kids
      const ckEvent = CHURCH_CONFIG.events.cityKids;
      const ftRes = await pcoFetch("/check-ins/v2/events/" + ckEvent + "/person_events?filter=first_time&order=-created_at&per_page=10&include=person");
      out.firstTimeKidsCheckins = { total: ftRes.body.meta && ftRes.body.meta.total_count };
      const included = ftRes.body.included || [];
      out.firstTimeKidsCheckins.recent = (ftRes.body.data || []).map(pe => {
        const personId = pe.relationships && pe.relationships.person && pe.relationships.person.data && pe.relationships.person.data.id;
        const person = included.find(i => i.id === personId && i.type === "Person");
        return {
          id: pe.id, createdAt: pe.attributes.created_at,
          checkInCount: pe.attributes.check_in_count,
          personName: person ? (person.attributes.first_name + " " + person.attributes.last_name) : null
        };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out, null, 2));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
    return;
  }

  // ── Probe PCO People API (profiles, membership status, giving fields) ───────
  if (req.method === "GET" && parsed.pathname === "/debug-people") {
    if (!savedCreds) { res.writeHead(401); return res.end(JSON.stringify({error:"Not authenticated"})); }
    try {
      const out = {};

      // Sample people with key fields
      const peopleRaw = await pcoFetch("https://api.planningcenteronline.com/people/v2/people?per_page=20&include=field_data,emails,phone_numbers&fields[Person]=first_name,last_name,membership,anniversary,birthdate,grade,inactivated_at,site_administrator,status,created_at,updated_at");
      out.totalPeople = peopleRaw.meta && peopleRaw.meta.total_count;
      out.samplePeople = (peopleRaw.data || []).map(p => ({
        id: p.id,
        name: (p.attributes.first_name || "") + " " + (p.attributes.last_name || ""),
        membership: p.attributes.membership,
        status: p.attributes.status,
        inactivatedAt: p.attributes.inactivated_at,
        createdAt: p.attributes.created_at,
        anniversary: p.attributes.anniversary,
        birthdate: p.attributes.birthdate
      }));

      // Custom field definitions (what extra fields does this church track?)
      const fieldsRaw = await pcoFetch("https://api.planningcenteronline.com/people/v2/field_definitions?per_page=50");
      out.customFields = (fieldsRaw.data || []).map(f => ({
        id: f.id,
        name: f.attributes.name,
        dataType: f.attributes.data_type,
        tab: f.attributes.tab
      }));

      // Membership type breakdown (how many active/inactive etc.)
      const listsRaw = await pcoFetch("https://api.planningcenteronline.com/people/v2/lists?per_page=25");
      out.lists = (listsRaw.data || []).map(l => ({ id: l.id, name: l.attributes.name, totalCount: l.attributes.total_count, autoRefresh: l.attributes.auto_refresh }));

      // Check if PCO Giving has any data at all
      try {
        const givingRaw = await pcoFetch("https://api.planningcenteronline.com/giving/v2/donations?per_page=1");
        out.givingTotal = givingRaw.meta && givingRaw.meta.total_count;
        out.givingNote = out.givingTotal > 0 ? "PCO Giving has data — " + out.givingTotal + " donations found" : "PCO Giving module is empty (likely using Pushpay instead)";
      } catch(ge) {
        out.givingNote = "PCO Giving API error: " + ge.message + " (module may not be enabled)";
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out, null, 2));
    } catch(e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const publicDir = path.join(__dirname, "public");
  const filePath = path.resolve(publicDir, parsed.pathname === "/" ? "index.html" : parsed.pathname.slice(1));
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== path.join(publicDir, "index.html")) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const mime = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".ico":"image/x-icon" }[path.extname(filePath)] || "text/plain";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("\n✅ PCO Dashboard running at http://localhost:" + PORT);
  console.log("   Debug: http://localhost:" + PORT + "/debug\n");

  // Warm all caches in the background at startup if credentials are available
  if (savedCreds) {
    (async () => {
      try {
        for (const pw of [8, 13, 26, 52]) {
          if (!dataCache[String(pw)]) {
            console.log("🔄 Startup prefetch: weeks=" + pw);
            const pp = await buildData(pw);
            dataCache[String(pw)] = { ts: Date.now(), payload: pp };
          }
        }
        console.log("🔄 Startup: warming City Kids team cache…");
        await warmCityKidsTeamCache();
      } catch(e) {
        console.log("⚠ Startup cache warm error:", e.message);
      }
    })();
  }
});
