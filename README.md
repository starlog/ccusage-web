# cc-usage

Collects Claude Code usage from each person's machines and shows team statistics.

- `ccusage_report.py` — runs [ccusage](https://github.com/ryoppippi/ccusage), writes a local report, and uploads it.
- `server/` — Node.js (Express) server that stores reports in MongoDB and serves the dashboard.

## Server

```bash
cd server
npm install
cp .env.example .env   # optional
npm start              # http://localhost:3200
```

Sample data for checking the UI (40 users `*@sample.local` with Korean names, some with 2–3 machines, 90 days of weekly uploads, sent through the API):

```bash
npm run seed:sample    # re-running replaces the same sample data
npm run seed:clean     # delete every @sample.local record
```

Uses the `mongodb` docker container (`mongodb://localhost:27017`, database `cc_usage`).

| Collection | Contents |
| --- | --- |
| `reports` | Every uploaded report, kept as received: period total and per-day totals |
| `daily` | One row per user + machine + day (latest upload wins), summed across machines for statistics |
| `users` | Each user's latest display name (e.g. a Korean name) |

Only aggregate numbers are accepted and stored: tokens (input, output, cache create, cache read) and the number of
sessions started, for the whole period and for each day. Cost and model, project, session and billing-block details
are never uploaded; if an older client sends them, the server discards them.

API: `POST /api/reports`, `GET /api/stats?since=YYYY-MM-DD&until=YYYY-MM-DD[&user=]`,
`GET /api/reports[?user=&machineId=&limit=]`, `GET /api/reports/:id`, `GET /api/users`, `GET /api/client-info`, `GET /api/health`.
The client script is also served at `/client/ccusage_report.py`, and the dashboard's **클라이언트 설정 방법** button opens a
step-by-step setup guide with copyable commands for new users.

## Sender (every machine)

Python 3.9+ and Node.js (for `npx ccusage@latest`), no pip packages.

```bash
# once per machine: remember sender id and server (~/.config/cc-usage/config.json)
./ccusage_report.py --user felix.cho.kr@gmail.com --name 조휘열 --server http://SERVER:3200 --save-config
./ccusage_report.py --show-config      # user, machine id, hostname, server

# capture the last 7 days, save under ./reports/, and upload
./ccusage_report.py
./ccusage_report.py --days 30
./ccusage_report.py --no-send          # local report only
./ccusage_report.py --send-only reports/2026-09-10_2026-09-16/summary.json
```

- **User id**: `--user` > `CCUSAGE_USER` > saved config > `git config user.email` > login name. Letters, digits and
  `. _ % + @ -` only (an email works).
- **Name** (optional): `--name 조휘열` / `CCUSAGE_NAME` / saved config. Any language, up to 50 characters; shown on the
  dashboard next to the user id. The latest name sent wins; uploads without a name keep it. `--name "" --save-config`
  clears the saved name.
- **Machine id**: SHA-256 hash of the OS machine UUID (macOS `IOPlatformUUID`, Linux `/etc/machine-id`,
  Windows `MachineGuid`), so the same user can upload from several computers; the server keeps each machine
  separately and sums them. Override with `--machine-id` / `CCUSAGE_MACHINE_ID`.
- **Token**: if the server sets `INGEST_TOKEN`, pass `--token` / `CCUSAGE_TOKEN` (or save it with `--save-config`).
- Uploads contain only token and session totals (period and per day), no cost. The local `reports/` folder still
  keeps the full detail (cost, models, projects, sessions, billing blocks) on your own machine.

To upload daily, add a cron entry, e.g. `0 19 * * * /path/to/ccusage_report.py >> /tmp/cc-usage.log 2>&1`.
# ccusage-web
