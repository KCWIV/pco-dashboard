# PCO Church Health Dashboard — Claude Code Context

## Project Overview

A local web dashboard for tracking volunteer health and Sunday attendance data from Planning Center Online (PCO). Built for a specific church; all data is fetched live from the PCO REST API and aggregated server-side.

**Run it:** `node server.js` → http://localhost:3000

## Tech Stack

- **Runtime:** Node.js v14+ (zero external npm dependencies — stdlib only)
- **Backend:** Native `http`/`https` modules, ~1567 lines in `server.js`
- **Frontend:** Single-page app, vanilla JS + CSS, embedded in `public/index.html`
- **API:** Planning Center Online REST API (JSON:API format)
- **Real-time progress:** Server-Sent Events (SSE) via `/progress` endpoint

## File Structure

```
pco-dashboard/
├── server.js                   # All backend logic — HTTP server, PCO API, data pipeline
├── public/
│   └── index.html              # Full SPA frontend (5 tabs, charts, modals)
├── export-first-timers-2025.js # Standalone script: exports first-timer volunteers to CSV
├── .env                        # PCO_APP_ID, PCO_SECRET, SKIP_TLS_VERIFY
├── package.json                # name/version/start only (no deps)
└── README.md                   # User-facing setup instructions
```

## Church-Specific Configuration (hardcoded in server.js)

| Setting | Value |
|---|---|
| Timezone | `America/Chicago` |
| Sunday Attendance Event ID | `607918` |
| City Kids Event ID | `609801` |
| Decisions Event ID | `609021` |
| Decisions Attendance Type ID | `191897` |

Kids room names and their attendance type IDs are also hardcoded in server.js. These are specific to this church's PCO setup.

## Backend Architecture

### Key Functions

- **`pcoFetch(url)`** — PCO API requests with retry logic (5x for 5xx, exponential backoff for 429 rate limits)
- **`pLimit(concurrency)`** — Inline concurrency limiter, set to 6 parallel requests with 50ms inter-request pacing
- **`buildTimeBuckets(weeks)`** — Creates weekly or monthly time buckets; auto-switches to monthly for 13+ week ranges
- **`buildData(weeks)`** — Main data aggregation pipeline (see below)
- **`parseLocalDate(str)`** — Parses PCO date-only strings, assumes noon local time to avoid timezone edge cases

### Data Pipeline (`buildData`)

1. Fetch service types from Services API
2. Fetch plans (schedules) for past N weeks with pagination
3. Pre-cache team names globally
4. Fetch plan_times + team_members with JSON:API `include=` sideloading
5. Extract volunteer scheduling: confirmations, declines, blockouts
6. Detect multi-service volunteers (same person, 2+ distinct service times)
7. Fetch Sunday headcount attendance with deduplication
8. Fetch City Kids + Decisions event data
9. Fetch City Kids person-level check-ins, detect multi-service kids
10. Aggregate everything into weekly/monthly buckets

### Caching Strategy

- 30-minute cache keyed by `weeks` parameter
- Cache is only served if it contains non-zero attendance/volunteer data
- Background prefetch on server start for 8, 13, 26, 52 week ranges

### Headcount Deduplication

PCO allows corrections to headcounts. We keep only the **latest record per `(event_time, headcount_group)`** to avoid double-counting.

## HTTP Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/auth` | POST | Accept PCO credentials (stored in memory only) |
| `/status` | GET | Check if credentials are set |
| `/data?weeks=N&refresh=1` | GET | Aggregated dashboard data (cache-aware) |
| `/progress` | GET | SSE stream for real-time pipeline progress |
| `/debug` | GET | Raw service types, plans, team members samples |
| `/debug-checkins` | GET | Full Check-Ins API explorer |
| `/debug-volunteers` | GET | Team member inspector |
| `/debug-range?weeks=N` | GET | Time bucket diagnostics |
| `/debug-headcounts` | GET | Trace headcount records |
| `/debug-attendance-types` | GET | Map attendance type IDs to names |
| `/debug-kids-periods` | GET | Event periods breakdown |
| `/debug-kids-standard` | GET | Standard headcounts analysis |

## Frontend Tabs

1. **Overview** — Stats grid + 8-week attendance & volunteer trend charts
2. **City Kids** — Kids check-in analytics (room breakdown, multi-service detection)
3. **Volunteers** — Show-up rate, declines, blockouts, first-timers, multi-service volunteers
4. **Attendance** — Weekly breakdown table + trend chart
5. **Teams** — Per-team coverage cards with color-coded health indicators

## PCO API Patterns

- JSON:API format — always use `include=` parameters for sideloading related data
- Follow `links.next` for pagination until exhausted or hard limit reached
- Auth: HTTP Basic with App ID + Secret
- Rate limit: 429 with `retry-after` header — respect it with exponential backoff

## Read-only policy (Planning Center)

**This project must never modify Planning Center data.** It reads PCO and renders it; nothing flows back.

- `server.js` routes every PCO call through `assertPcoReadOnly()`, which throws on any method other than `GET` before a socket is opened. Do not add a second request path that bypasses it.
- Do not run ad-hoc `curl`/scripts that `POST`, `PATCH`, `PUT` or `DELETE` against `api.planningcenteronline.com` from this project. A `PreToolUse` hook in `.claude/settings.json` blocks such commands; do not disable or work around it.
- The Personal Access Token in `.env` is **read/write** — PCO cannot scope a PAT. The real lock is to issue the token from a PCO user whose permissions are "Viewer" in each product (People, Services, Check-Ins, Groups, Registrations) and use that token locally and on Render.
- If a legitimate write is ever needed (e.g. backfilling a missed headcount), it is a separate, explicitly approved task — not something the dashboard or an agent does on its own.

## Conventions

- **No npm dependencies** — use Node.js stdlib only (`http`, `https`, `fs`, `path`, `url`)
- Credentials stored in memory only, never written to disk
- Nighttime events (6 PM+) are filtered out of Sunday attendance totals
- `SKIP_TLS_VERIFY=1` in `.env` is for local dev only — not for production

## Workflow Preferences

- **All tool calls auto-approved**: File edits, bash commands (server restart, curl tests, git, node), and file reads should all run without prompting. Only prompt for: credential/secret handling, git force-push, or deleting production data.
- **When prompting for security approval**: Include 1-2 sentences below the code explaining what it does and its impact.
- **Restart server automatically** after code changes: `lsof -ti:3000 | xargs kill -9 2>/dev/null; sleep 1; node server.js &disown`
- **Verify with curl** after changes to confirm data correctness before reporting to user.

## Environment Variables (.env)

```
PCO_APP_ID=your_app_id
PCO_SECRET=your_secret
SKIP_TLS_VERIFY=1
```
