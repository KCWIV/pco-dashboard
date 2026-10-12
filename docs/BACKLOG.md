# Backlog

Ideas and larger initiatives that are scoped but not yet scheduled. Each entry should be enough to pick the work back up cold.

---

## Data-agent chatbot ("ask the dashboard")

**Status:** Backlog — scoped 2026-09-24, not started.

**Goal:** A chat interface anyone on staff can use to ask questions of Planning Center data in plain English — "how many women attended the City Chicks cohort?", "who leads the Auditorium Host team?", "what's attendance trending vs last year?" — without needing PCO permissions or knowing which PCO product holds the answer.

**Why it fits this project:** The hard part already exists in `server.js`: an authenticated PCO client (`pcoFetch`) with retry, 429 backoff and pagination, plus the aggregation pipeline (`buildData`). A data agent is Claude with tool use, where the tools are thin wrappers over that client. The City Chicks discovery (see `docs/city-chicks-data-inventory.md` if present, or the 2026-09-24 session) was exactly the sequence such an agent would run: search Groups, Check-Ins, Registrations, People forms/fields, and join by person ID.

### Proposed shape (v1)

- **Endpoint:** `POST /chat` in `server.js`. Calls the Claude Messages API over stdlib `https` (no new npm deps — keep the zero-dependency rule). Model: latest Claude; tool-use loop server-side.
- **UI:** a chat panel in `public/index.html`, behind the existing `DASHBOARD_PASSWORD` login.
- **Tools (~8):**
  1. `search_people(query)` — People API name search
  2. `list_groups(name?, type?, include_archived)` — Groups incl. `filter=archived`; group types
  3. `group_memberships(group_id, role?)`
  4. `checkin_events(name?, include_archived)` and `checkin_attendees(event_id, from, to)`
  5. `registration_signups(name?)` and `signup_attendees(signup_id)`
  6. `team_leaders(service_type_id?, team_id?)` — Services teams → `team_leaders` → person
  7. `people_lists()` / `field_lookup(field_definition_id)` — lists and custom fields
  8. `dashboard_metrics(weeks)` — returns the already-computed `/data` payload so trend questions reuse the pipeline
- **Person joins:** resolve person IDs through `/people/v2/people/{id}` only for the rows the answer needs — never bulk-dump the directory.

### The decision that matters: access tiers

A Personal Access Token runs as the token owner, so the agent sees everything that person sees. "Anyone can talk to it" therefore needs its own permission layer, independent of PCO's:

| Tier | Who | Can see |
|---|---|---|
| Aggregate | all staff | counts, trends, rosters as numbers — no names |
| Ministry lead | per-ministry | names + contact info **for their ministry only** |
| Admin | you | everything the token can see |

Plus: an audit log of who asked what and which tools ran; Giving and Calendar never wired in (token can't reach them today anyway — keep it that way). The auto-mode classifier blocking a bulk contact export during the City Chicks work is the same concern surfacing early.

### Alternative considered

Ship the same tool wrappers as a small **MCP server** so staff use them inside the Claude desktop app. Faster to ship, but loses the shared access-tier layer and audit log. Not recommended for a church context.

### Suggested first slice

Aggregate-only tier + the City Chicks tools (Groups, Check-Ins, Registrations by name). Real use case, real data, and it forces the permission design before anything sensitive is exposed.

### Open questions

- Which model/API key pays for this, and who owns rotation?
- Does staff login move from a shared password to per-person accounts (needed for tiers + audit)?
- Should answers cite the PCO record IDs/links they came from? (Recommended — cheap, and it's how staff verify.)
