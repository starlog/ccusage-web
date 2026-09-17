# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Team Claude Code usage tracker; clients and server talk only over HTTP:

- `client/` — Node.js client (`cc-usage` bin) run on each person's machine, installed with one `npx <server>/client/…tgz setup` line. Uploads **aggregate** numbers and registers a daily upload.
- `ccusage_report.py` — earlier Python client (same config, identity and payload; also writes detailed local reports). Kept working for existing users.
- `server/` — Node.js (ESM, Express 5, official `mongodb` driver) API + static dashboard (vanilla JS + Chart.js, no build step). UI text is Korean.

There is no test suite, linter, or build. Verify changes by syntax-checking and exercising the running server (see Commands).

## Commands

```bash
# Server (MongoDB is the docker container named `mongodb` on localhost:27017, db `cc_usage`, no auth)
cd server && npm install
npm start                 # http://localhost:3200 (PORT, HOST, MONGODB_URI, MONGODB_DB, INGEST_TOKEN via env or server/.env)
npm run dev               # node --watch
npm run seed:sample       # 40 fake users (@sample.local), 90 days, weekly 7-day uploads through POST /api/reports
npm run seed:clean        # delete only @sample.local records
node scripts/seed-sample.js --users 20 --days 30

# Syntax checks (no tests exist)
node --check src/stats.js public/app.js
python3 -c "import ast; ast.parse(open('ccusage_report.py').read())"

# Node client (from client/; npm install once for local runs)
cd client && npm install
node bin/cc-usage.js send --dry-run --server http://localhost:3200 --user you@example.com   # print the body, no upload
# Test setup without touching real settings/schedules: override HOME (or XDG_CONFIG_HOME/XDG_DATA_HOME) and
# CC_USAGE_SCHEDULE_NAME (always — the default launchd label/cron tag is shared with a real install on the same account); clean Linux end-to-end: docker run --add-host=host.docker.internal:host-gateway node:22-slim …

# Python client (stdlib only; needs node/npx for ccusage)
./ccusage_report.py --user you@example.com --name 홍길동 --server http://localhost:3200 --save-config   # once per machine
./ccusage_report.py [--days 30] [--no-send] [--show-config] [--send-only reports/<range>/summary.json]

# Inspect / reset data
docker exec mongodb mongosh cc_usage --quiet --eval 'db.reports.countDocuments()'
curl -s "localhost:3200/api/stats?since=2026-08-18&until=2026-09-16" | jq .trend
```

The server does not auto-reload in `npm start`; restart after editing `server/src/*`. Files in `server/public/` are served statically (just reload the browser).

## Node client (`client/`)

- `usage.js` runs the **pinned** `ccusage` dependency (`20.0.20`, resolved via `require.resolve('ccusage/package.json')`) as `node <bin> claude daily|session --json --offline`, and builds exactly the Python client's payload (verified identical for the same range). Bump the pin deliberately and re-verify the JSON shape.
- `identity.js` mirrors the Python rules: ASCII `USER_RE`, name normalization, and `machineId = sha256("cc-usage:" + OS UUID)[:32]` — changing any of these splits a person's records.
- `setup` with none of the value options in a TTY runs `prompt.js` (asks server → user → name → token if required → schedule → confirm; Ctrl+C/"n" exits 130 without changes), then continues as the flag path. Without a TTY it keeps the flag behavior.
- `setup` (in `cli.js`): check `/api/client-info` → save config → `install.js` runs `npm install --prefix <DATA_DIR> <server tarball>` (npx caches are temporary) and writes a `cc-usage` wrapper (only if the file is missing or ours) → first `send` → `schedule.js` registers launchd / cron / schtasks with absolute `process.execPath` + installed entry + `send --log`. Schedule failure is a warning, not fatal. State for `status` lives in `state.json`; the last body sent in `last-upload.json`.
- Windows scheduling and install are implemented but untested; macOS launchd and Linux cron were verified end to end.
- Server side: `server/src/client-package.js` runs `npm pack` in `client/` into `server/.client-dist/` when sources are newer than the build; `/api/client-info` returns `client.package` with version+hash in the filename so npx never reuses a stale cache.

## Python client (`ccusage_report.py`)

- **ccusage invocation**: defaults to `npx --yes ccusage@latest` (`--bin`/`CCUSAGE_BIN` to override). ccusage ≥18 nests Claude reports under a `claude` subcommand; `Ccusage._has_claude_subcommand()` detects this from `--help`. Old global installs (15.x) produce wrong session grouping — prefer latest.
- Runs four JSON reports: `daily --breakdown`, `daily --instances` (per project), `session --breakdown`, `blocks`. **Sessions are fetched without `--since/--until`** because ccusage's session date filter drops sessions; `summarize()` filters them locally by first/last activity date.
- Local output `reports/<since>_<until>/` (raw JSON, `summary.json`, `report.md`) keeps full detail including cost, models, projects, sessions, blocks. `reports/` is gitignored.
- **Upload payload is deliberately minimal** (`build_payload`, `SCHEMA_VERSION = 3`): `range`, `periodTotal`, and `dailyTotals[]` with only token fields (`inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `totalTokens`) and `sessions` (sessions started that day). Cost, model, project, session and billing-block details must never be sent — this was an explicit product decision (company uses Max plans; cost is meaningless and details are private).
- **Identity**: `user` resolves option > `CCUSAGE_USER` > `~/.config/cc-usage/config.json` (`--save-config`, chmod 600) > git `user.email` > login name; validated by `USER_RE` (ASCII-only, same regex as server — note Python needs `re.ASCII` to match JS `\w`). Optional display `name` (e.g. Korean) resolves option > `CCUSAGE_NAME` > config; NFC-normalized, whitespace collapsed, ≤50 chars, no control chars (mirrored in server `ingest.js`); omitted from the payload when unset. `machineId` is `sha256("cc-usage:" + OS machine UUID)[:32]` (macOS IOPlatformUUID / Linux machine-id / Windows MachineGuid, fallback random UUID saved in config). When no server is configured the upload is skipped with an explicit message.

## Server architecture (`server/src`)

- `ingest.js` — `parseReport` validates and normalizes the body; accepts schemaVersion 1–3 but **silently discards** cost and any detail sections from older clients. `storeReport` writes three collections:
  - `reports`: every submission kept as history (period total + daily totals).
  - `users`: latest display name per user (upserted only when a report carries a name, so a machine without a name never erases it). Stats attach `name` to users/machines/trend rows; the dashboard labels charts by name and keeps the email id for identity, color and filtering (`displayName` / `fullLabel` in `app.js`).
  - `daily`: one doc per `(user, machineId, date)`. For the submitted window the machine's days are replaced (upsert active days, delete days now zero), so re-sending overlapping windows never double counts, while different machines of the same user are summed in stats.
- `stats.js` — everything the dashboard shows comes from `GET /api/stats?since&until[&user]`, aggregated from `daily`: totals, `byDateUser`, per-user totals, per-machine latest report, and `trend`.
  - **Trend groups**: per user, a least-squares line through daily `totalTokens` over the range (missing days = 0). `change = slope*(n-1)/mean`; `>= +TREND_THRESHOLD` (0.2) → `increasing`, `<= -0.2` → `decreasing`, else `steady` (UI label 일정). Needs ≥3 days. The client-side `linearFit` in `app.js` mirrors this for drawing group trend lines — keep them consistent.
  - `listUsers` orders users by all-time tokens; the dashboard assigns categorical color slots from this order.
- `server.js` — routes (`POST /api/reports` with optional bearer `INGEST_TOKEN`, `GET /api/stats`, `/api/reports`, `/api/reports/:id`, `/api/users`, `/api/client-info` (only `tokenRequired`, never the token), `/api/health`), serves the client script at `/client/ccusage_report.py` (read from the repo root), `public/` and `node_modules/chart.js` at `/vendor/chart.umd.js`. Rejected uploads are logged.
- `export.js` — `GET /api/export.xlsx` (same `since/until/user` validation as `/api/stats` via `rangeQuery`) builds an `exceljs` workbook: it reuses `getStats` and adds user×day and per-day aggregations plus overlapping `reports`. Totals across the summary, users, daily, user-daily and matrix sheets must agree. `uuid` is pinned via `overrides` to clear exceljs's audit warning.
- `db.js` creates indexes on startup (unique `daily{user,machineId,date}`).

## Dashboard (`server/public`)

- Header button (and the empty state) opens the **클라이언트 설정 방법** `<dialog>`: email/name inputs fill the one-line `npx … setup` command (package path from `/api/client-info`) plus `cc-usage status|send|uninstall`. Commands stay single-line (PowerShell has no `\` continuation); `setCode` keeps words unbroken when wrapping. Keep its commands and privacy text in sync with the client's options and payload.
- Single page; filters (7/30/90 days/custom, user) live in the URL query and re-fetch `/api/stats`; previous render is dimmed while loading.
- Charts: 일별 토큰 (stacked by user, area/bar toggle), 사용자별 토큰량 (horizontal bars), 사용량 추세 (group totals, as a 7-day moving average for ranges ≥14 days, plus each group's straight trend line; line/area toggle), plus trend-group tables and users/machines tables. Every chart has a table view (`renderChartTable`); helper datasets flagged `trendLine` are excluded from legend, tooltip and table.
- Styling follows a data-viz convention: colors are CSS custom properties with separate light/dark values (charts are rebuilt on color-scheme change), categorical slots never cycle — beyond 8 users the rest fold into "기타", and color follows the entity (all-time rank), not the filtered rank. Chart-type choices persist in `localStorage` with try/catch.
- Removed on purpose (don't reintroduce without asking): any cost/USD display, per-model, per-project, hour-of-day and top-session views.
