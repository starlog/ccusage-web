# cc-usage

Collects Claude Code usage from each person's machines and shows team statistics.

- `client/` — Node.js client (`cc-usage`): bundles a pinned [ccusage](https://github.com/ryoppippi/ccusage), uploads
  daily token totals, and registers a daily upload. Served by the server, so users install it with one `npx` line.
- `server/` — Node.js (Express) server that stores reports in MongoDB and serves the dashboard.
- `ccusage_report.py` — the earlier Python client (still works; writes detailed local reports).

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
`GET /api/export.xlsx?since=&until=[&user=]`, `GET /api/reports[?user=&machineId=&limit=]`, `GET /api/reports/:id`,
`GET /api/users`, `GET /api/client-info`, `GET /api/health`.

The dashboard's **엑셀 다운로드** button downloads `export.xlsx` for the current filters, with sheets 요약, 사용자별,
일별 합계, 사용자별 일별 (long format for pivots), 일별 토큰표 (users × dates), 추세 그룹, 머신, 보고 이력.
The client script is also served at `/client/ccusage_report.py`, and the dashboard's **클라이언트 설정 방법** button opens a
step-by-step setup guide with copyable commands for new users.

## Client (every machine)

Needs Node.js 20+. Open the dashboard and click **클라이언트 설정 방법** for a ready-to-copy command, or run:

```bash
npx --yes http://SERVER:3200/client/cc-usage-client.tgz setup --user you@example.com --name 홍길동 --server http://SERVER:3200
```

Running `npx … setup` (or `cc-usage setup`) with no options in a terminal asks for every value interactively (server
check, user id, name, token when required, schedule time) with saved settings as defaults.

`setup` saves the settings (`~/.config/cc-usage/config.json`), installs the client into a stable folder
(`~/.local/share/cc-usage`, Windows `%LOCALAPPDATA%\cc-usage`), uploads the last 7 days, and registers a daily
upload at 13:00 (macOS launchd, Linux cron, Windows Task Scheduler) that runs node by absolute path.
Options: `--time HH:MM`, `--no-schedule` (still installs the `cc-usage` command; removes an existing schedule), `--token`,
`--dry-run`. Re-running `setup` updates the client and schedule.

```bash
cc-usage status      # settings, schedule, last upload, whether the server has a newer client
cc-usage send        # upload the last 7 days now (--days 30, --dry-run prints the body instead)
cc-usage uninstall   # remove the schedule and the install (--purge also deletes settings)
```

- **What is sent**: user id, optional name, machine id, hostname, and per-day/period token counts and sessions
  started. No cost, models, projects, or conversation content. The last body sent is kept in
  `~/.config/cc-usage/last-upload.json`.
- **User id**: letters, digits and `. _ % + @ -` (an email). **Name**: any language, up to 50 characters.
- **Machine id**: SHA-256 of the OS machine UUID (macOS `IOPlatformUUID`, Linux `/etc/machine-id`, Windows
  `MachineGuid`), identical to the Python client, so switching clients keeps the same records.
- **Token**: if the server sets `INGEST_TOKEN`, pass `--token`.
- The server packs `client/` with `npm pack` on demand (rebuilt when sources change) and serves it at
  `/client/cc-usage-client-<version>-<hash>.tgz`; the hash keeps npx from reusing an older cached package.

### Python client (earlier)

Python 3.9+ and Node.js. Same settings file, user id, name and machine id as the Node client.

```bash
./ccusage_report.py --user you@example.com --name 홍길동 --server http://SERVER:3200 --save-config
./ccusage_report.py                    # last 7 days; detailed local report under ./reports/
./ccusage_report.py --no-send | --show-config | --send-only reports/<range>/summary.json
```
# ccusage-web
