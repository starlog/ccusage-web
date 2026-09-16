#!/usr/bin/env python3
"""ccusage wrapper: capture detailed Claude Code usage for the last N days (default 7).

Runs several ccusage reports in JSON mode, saves the raw output, and renders a
combined summary (summary.json + report.md).

Usage:
    ./ccusage_report.py                    # last 7 days, including today
    ./ccusage_report.py --days 14
    ./ccusage_report.py --bin ccusage      # use the locally installed binary
    ./ccusage_report.py --stdout           # also print the markdown report
    ./ccusage_report.py --user felix.cho.kr@gmail.com --server http://localhost:3200 --save-config
                                           # one-time: remember sender id and server
    ./ccusage_report.py                    # then every run also uploads (--no-send to skip)
    ./ccusage_report.py --send-only reports/2026-09-10_2026-09-16/summary.json
                                           # re-upload a previously captured summary
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

DEFAULT_BIN = "npx --yes ccusage@latest"
SCHEMA_VERSION = 3
TOKEN_FIELDS = ("inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens")


# --------------------------------------------------------------------------- runner


class CcusageError(RuntimeError):
    pass


class Ccusage:
    """Thin wrapper around the ccusage CLI that always returns parsed JSON."""

    def __init__(self, bin_cmd: str, timezone: str | None, offline: bool, timeout: int):
        self.base = shlex.split(bin_cmd)
        if not shutil.which(self.base[0]):
            raise CcusageError(f"executable not found: {self.base[0]}")
        self.timezone = timezone
        self.offline = offline
        self.timeout = timeout
        # ccusage >= 18 reports every agent at the top level; Claude-only reports live under `claude`.
        self.prefix = ["claude"] if self._has_claude_subcommand() else []

    def _run(self, args: list[str]) -> subprocess.CompletedProcess:
        env = {**os.environ, "NO_COLOR": "1"}
        try:
            return subprocess.run(
                self.base + args, capture_output=True, text=True, timeout=self.timeout, env=env
            )
        except subprocess.TimeoutExpired as e:
            raise CcusageError(f"timed out after {self.timeout}s: {' '.join(self.base + args)}") from e

    def _has_claude_subcommand(self) -> bool:
        out = self._run(["--help"]).stdout
        return any(line.strip().startswith("claude ") for line in out.splitlines())

    def version(self) -> str:
        return self._run(["--version"]).stdout.strip().removeprefix("ccusage").strip()

    def report(self, command: str, since: date | None, until: date | None, *extra: str) -> dict:
        args = [*self.prefix, command, "--json", *extra]
        if since and until:
            args += ["--since", since.strftime("%Y%m%d"), "--until", until.strftime("%Y%m%d")]
        if self.timezone:
            args += ["--timezone", self.timezone]
        if self.offline:
            args.append("--offline")
        proc = self._run(args)
        if proc.returncode != 0:
            raise CcusageError(f"`{' '.join(self.base + args)}` failed ({proc.returncode}):\n{proc.stderr.strip()}")
        # Some versions print log lines before the JSON document.
        start = proc.stdout.find("{")
        if start < 0:
            raise CcusageError(f"no JSON in output of `{' '.join(args)}`:\n{proc.stdout[:500]}")
        return json.loads(proc.stdout[start:])


# --------------------------------------------------------------------------- aggregation


def empty_usage() -> dict:
    return {**{f: 0 for f in TOKEN_FIELDS}, "totalTokens": 0, "cost": 0.0}


def add_usage(acc: dict, row: dict, cost_key: str) -> None:
    for f in TOKEN_FIELDS:
        acc[f] += row.get(f, 0) or 0
    acc["totalTokens"] += sum(row.get(f, 0) or 0 for f in TOKEN_FIELDS)
    acc["cost"] += row.get(cost_key, 0) or 0


def activity_date(value: str | None) -> str:
    """Local calendar date of a ccusage activity field (ISO timestamp or plain YYYY-MM-DD)."""
    if not value:
        return ""
    if "T" not in value:
        return value[:10]
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone().date().isoformat()


def summarize(raw: dict, since: date, until: date) -> dict:
    daily_rows = raw["daily"].get("daily", [])

    days = []
    by_model: dict[str, dict] = {}
    by_date = {r["date"]: r for r in daily_rows}
    d = since
    while d <= until:  # include zero-usage days so the 7-day view has no holes
        row = by_date.get(d.isoformat())
        usage = empty_usage()
        day_models = []
        if row:
            add_usage(usage, row, "totalCost")
            for mb in row.get("modelBreakdowns", []):
                add_usage(by_model.setdefault(mb["modelName"], empty_usage()), mb, "cost")
                model_usage = empty_usage()
                add_usage(model_usage, mb, "cost")
                day_models.append({"model": mb["modelName"], **model_usage})
        days.append({"date": d.isoformat(), **usage, "models": row.get("modelsUsed", []) if row else [],
                     "modelBreakdowns": day_models})
        d += timedelta(days=1)

    totals = empty_usage()
    for day in days:
        add_usage(totals, day, "cost")

    projects = []
    project_daily = []
    for name, rows in raw["projects"].get("projects", {}).items():
        usage = empty_usage()
        in_range = [r for r in rows if since.isoformat() <= r["date"] <= until.isoformat()]
        for r in in_range:
            add_usage(usage, r, "totalCost")
            day_usage = empty_usage()
            add_usage(day_usage, r, "totalCost")
            project_daily.append({"date": r["date"], "project": name, **day_usage})
        if usage["totalTokens"]:
            projects.append({"project": name, "activeDays": len(in_range), **usage})
    projects.sort(key=lambda p: (p["cost"], p["totalTokens"]), reverse=True)

    sessions = [
        {
            "sessionId": s.get("sessionId"),
            "project": s.get("projectPath"),
            "firstActivity": s.get("firstActivity"),
            "lastActivity": s.get("lastActivity"),
            "firstDate": activity_date(s.get("firstActivity") or s.get("lastActivity")),
            "lastDate": activity_date(s.get("lastActivity")),
            "models": s.get("modelsUsed", []),
            **{f: s.get(f, 0) for f in TOKEN_FIELDS},
            "totalTokens": s.get("totalTokens", 0),
            "cost": s.get("totalCost", 0),
        }
        for s in raw["sessions"].get("sessions", [])
        # overlaps the range: ended on/after `since` and started on/before `until`
        if activity_date(s.get("lastActivity")) >= since.isoformat()
        and activity_date(s.get("firstActivity") or s.get("lastActivity")) <= until.isoformat()
    ]
    sessions.sort(key=lambda s: (s["cost"], s["totalTokens"]), reverse=True)

    blocks = [
        {
            "start": b.get("startTime"),
            "end": b.get("actualEndTime") or b.get("endTime"),
            "isActive": b.get("isActive", False),
            "entries": b.get("entries", 0),
            "models": b.get("models", []),
            "totalTokens": b.get("totalTokens", 0),
            "cost": b.get("costUSD", 0),
        }
        for b in raw["blocks"].get("blocks", [])
        if not b.get("isGap")
    ]

    active_days = sum(1 for day in days if day["totalTokens"])
    cache_denominator = totals["cacheReadTokens"] + totals["cacheCreationTokens"] + totals["inputTokens"]
    return {
        "range": {"since": since.isoformat(), "until": until.isoformat(), "days": len(days)},
        "totals": {
            **totals,
            "activeDays": active_days,
            "avgCostPerActiveDay": totals["cost"] / active_days if active_days else 0,
            "cacheHitRate": totals["cacheReadTokens"] / cache_denominator if cache_denominator else 0,
            "sessions": len(sessions),
            "billingBlocks": len(blocks),
        },
        "daily": days,
        "models": [{"model": m, **u} for m, u in sorted(by_model.items(), key=lambda kv: kv[1]["cost"], reverse=True)],
        "projects": projects,
        "projectDaily": project_daily,
        "sessions": sessions,
        "blocks": blocks,
    }


# --------------------------------------------------------------------------- rendering


def n(v: float) -> str:
    return f"{int(v):,}"


def usd(v: float) -> str:
    return f"${v:,.2f}"


def short_project(p: str | None) -> str:
    if not p:
        return "-"
    home = "-" + str(Path.home()).strip("/").replace("/", "-") + "-"
    return p[len(home):] if p.startswith(home) else p


def local_time(iso: str | None) -> str:
    if not iso:
        return "-"
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%m-%d %H:%M")


def table(headers: list[str], rows: list[list[str]], right: set[int]) -> str:
    align = ["---:" if i in right else "---" for i in range(len(headers))]
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(align) + " |"]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(lines)


def render_markdown(s: dict, meta: dict, top: int) -> str:
    t = s["totals"]
    r = s["range"]
    usage_cols = ["Input", "Output", "Cache create", "Cache read", "Total tokens", "Cost"]

    def usage_cells(u: dict) -> list[str]:
        return [n(u["inputTokens"]), n(u["outputTokens"]), n(u["cacheCreationTokens"]),
                n(u["cacheReadTokens"]), n(u["totalTokens"]), usd(u["cost"])]

    out = [
        f"# Claude Code usage: {r['since']} ~ {r['until']} ({r['days']} days)",
        "",
        f"_Generated {meta['generatedAt']} with ccusage {meta['ccusageVersion']}_",
        "",
        "## Summary",
        "",
        table(["Metric", "Value"], [
            ["Total cost", usd(t["cost"])],
            ["Total tokens", n(t["totalTokens"])],
            ["Active days", f"{t['activeDays']} / {r['days']}"],
            ["Avg cost per active day", usd(t["avgCostPerActiveDay"])],
            ["Cache hit rate", f"{t['cacheHitRate']:.1%}"],
            ["Sessions", str(t["sessions"])],
            ["5h billing blocks", str(t["billingBlocks"])],
        ], {1}),
        "",
        "## Daily",
        "",
        table(["Date", *usage_cols, "Models"],
              [[d["date"], *usage_cells(d), ", ".join(d["models"]) or "-"] for d in s["daily"]]
              + [["**Total**", *[f"**{c}**" for c in usage_cells(t)], ""]],
              set(range(1, 7))),
        "",
        "## By model",
        "",
        table(["Model", *usage_cols], [[m["model"], *usage_cells(m)] for m in s["models"]], set(range(1, 7))),
        "",
        "## By project",
        "",
        table(["Project", "Days", *usage_cols],
              [[short_project(p["project"]), str(p["activeDays"]), *usage_cells(p)] for p in s["projects"]],
              set(range(1, 8))),
        "",
        f"## Top {min(top, len(s['sessions']))} sessions (by cost)",
        "",
        table(["Project", "Session", "First", "Last", "Total tokens", "Cost", "Models"],
              [[short_project(x["project"]), (x["sessionId"] or "-")[:8], local_time(x["firstActivity"]),
                local_time(x["lastActivity"]) if "T" in (x["lastActivity"] or "") else (x["lastActivity"] or "-"),
                n(x["totalTokens"]), usd(x["cost"]), ", ".join(x["models"])]
               for x in s["sessions"][:top]],
              {4, 5}),
        "",
        "## 5-hour billing blocks",
        "",
        table(["Start", "End", "Entries", "Total tokens", "Cost", "Models"],
              [[local_time(b["start"]), local_time(b["end"]) + (" (active)" if b["isActive"] else ""),
                n(b["entries"]), n(b["totalTokens"]), usd(b["cost"]), ", ".join(b["models"])]
               for b in s["blocks"]],
              {2, 3, 4}),
        "",
    ]
    return "\n".join(out)


# --------------------------------------------------------------------------- identity & upload


CONFIG_PATH = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "cc-usage" / "config.json"
USER_RE = re.compile(r"^[\w.%+@-]{1,200}$")  # same rule the server enforces


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        print(f"warning: ignoring unreadable {CONFIG_PATH}: {e}", file=sys.stderr)
        return {}


def save_config(values: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(values, indent=2) + "\n")
    CONFIG_PATH.chmod(0o600)  # may hold the upload token


def default_user() -> str:
    try:
        email = subprocess.run(["git", "config", "--global", "user.email"],
                               capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        email = ""
    return email or getpass.getuser()


def _command_output(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def os_machine_uuid() -> str | None:
    """The OS-provided stable machine identifier, if one can be read."""
    if sys.platform == "darwin":
        match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"',
                          _command_output(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]))
        return match.group(1) if match else None
    if sys.platform.startswith("win"):
        match = re.search(r"MachineGuid\s+REG_SZ\s+(\S+)",
                          _command_output(["reg", "query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"]))
        return match.group(1) if match else None
    for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            value = Path(path).read_text().strip()
        except OSError:
            continue
        if value:
            return value
    return None


def machine_id(config: dict) -> str:
    """Stable, anonymized id of this computer: a hash of the OS machine UUID (or a saved random one)."""
    raw = os_machine_uuid()
    if not raw:
        raw = config.get("fallbackMachineUuid")
        if not raw:
            raw = str(uuid.uuid4())
            save_config({**config, "fallbackMachineUuid": raw})
    return hashlib.sha256(f"cc-usage:{raw}".encode()).hexdigest()[:32]


def local_timezone() -> str:
    """Best-effort IANA name of the system timezone (dates in the summary are grouped in it)."""
    if os.environ.get("TZ"):
        return os.environ["TZ"]
    link = os.path.realpath("/etc/localtime")
    if "zoneinfo/" in link:
        return link.split("zoneinfo/", 1)[1]
    return datetime.now().astimezone().tzname() or "UTC"


USAGE_KEYS = (*TOKEN_FIELDS, "totalTokens")


def build_payload(summary: dict, meta: dict, identity: dict) -> dict:
    """Report body for the usage server: only aggregate token and session counts.

    Sends the total for the whole period and the total for every single day in it (zero days included):
    token counts and the number of sessions started. Cost, models, projects, sessions and billing blocks
    stay in the local report and are never uploaded.
    """
    started: dict[str, int] = {}
    for session in summary.get("sessions", []):
        first = session.get("firstDate") or activity_date(session.get("firstActivity") or session.get("lastActivity"))
        started[first] = started.get(first, 0) + 1

    daily = [{"date": d["date"], **{k: d.get(k, 0) for k in USAGE_KEYS}, "sessions": started.get(d["date"], 0)}
             for d in summary["daily"]]
    totals = summary["totals"]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "user": identity["user"],
        "machineId": identity["machineId"],
        "hostname": identity["hostname"],
        "timezone": meta.get("timezone") or local_timezone(),
        "meta": {k: meta.get(k) for k in ("generatedAt", "ccusageVersion", "timezone")},
        "range": summary["range"],
        "periodTotal": {
            **{k: totals.get(k, 0) for k in USAGE_KEYS},
            "activeDays": totals.get("activeDays", 0),
            "cacheHitRate": totals.get("cacheHitRate", 0),
            "sessions": sum(d["sessions"] for d in daily),
        },
        "dailyTotals": daily,
    }


def upload(server: str, token: str | None, payload: dict, timeout: int) -> dict:
    url = server.rstrip("/") + "/api/reports"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise CcusageError(f"upload to {url} failed: HTTP {e.code} {e.read().decode(errors='replace')[:500]}") from e
    except urllib.error.URLError as e:
        raise CcusageError(f"upload to {url} failed: {e.reason}") from e


def send(args: argparse.Namespace, identity: dict, summary: dict, meta: dict) -> bool:
    try:
        result = upload(args.server, args.token, build_payload(summary, meta, identity), args.timeout)
    except CcusageError as e:
        print(f"error: {e}", file=sys.stderr)
        return False
    print(f"[upload] {identity['user']} machine {identity['machineId'][:8]} ({identity['hostname']}) -> "
          f"{args.server}: {result.get('totalTokens', 0):,} tokens, {result.get('activeDays', 0)} active days, "
          f"{result.get('sessions', 0)} sessions", file=sys.stderr)
    return True


# --------------------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=7, help="number of days including today (default: 7)")
    parser.add_argument("--until", type=date.fromisoformat, default=date.today(),
                        help="last day of the range, YYYY-MM-DD (default: today)")
    parser.add_argument("--bin", default=os.environ.get("CCUSAGE_BIN", DEFAULT_BIN),
                        help=f"ccusage command (env CCUSAGE_BIN, default: '{DEFAULT_BIN}')")
    parser.add_argument("--timezone", help="IANA timezone for date grouping (default: system)")
    parser.add_argument("--offline", action="store_true", help="use cached pricing data")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "reports",
                        help="output directory (default: ./reports)")
    parser.add_argument("--top", type=int, default=20, help="sessions listed in report.md (default: 20)")
    parser.add_argument("--timeout", type=int, default=300, help="per-command timeout in seconds")
    parser.add_argument("--stdout", action="store_true", help="also print report.md to stdout")

    upload_opts = parser.add_argument_group(
        "upload", f"Values resolve as: option > environment variable > {CONFIG_PATH} > default.")
    upload_opts.add_argument("--user", help="sender id, e.g. felix.cho.kr@gmail.com "
                                            "(env CCUSAGE_USER, default: git user.email or login name)")
    upload_opts.add_argument("--server", help="usage server base URL, e.g. http://localhost:3200 (env CCUSAGE_SERVER)")
    upload_opts.add_argument("--token", help="bearer token if the server requires one (env CCUSAGE_TOKEN)")
    upload_opts.add_argument("--machine-id", help="override the computer id derived from the OS machine UUID "
                                                  "(env CCUSAGE_MACHINE_ID)")
    upload_opts.add_argument("--no-send", action="store_true", help="do not upload even if a server is configured")
    upload_opts.add_argument("--save-config", action="store_true",
                             help="save the given --user/--server/--token/--machine-id as defaults and exit")
    upload_opts.add_argument("--show-config", action="store_true", help="print the resolved sender identity and exit")
    upload_opts.add_argument("--send-only", type=Path, metavar="SUMMARY_JSON",
                             help="upload an existing summary.json without running ccusage")
    args = parser.parse_args()

    config = load_config()
    for opt, env, key in [("user", "CCUSAGE_USER", "user"), ("server", "CCUSAGE_SERVER", "server"),
                          ("token", "CCUSAGE_TOKEN", "token"), ("machine_id", "CCUSAGE_MACHINE_ID", "machineId")]:
        if args.save_config:
            continue  # only persist what was passed explicitly
        if getattr(args, opt) is None:
            setattr(args, opt, os.environ.get(env) or config.get(key))

    if args.save_config:
        updates = {"user": args.user, "server": args.server, "token": args.token, "machineId": args.machine_id}
        updates = {k: v for k, v in updates.items() if v is not None}
        if not updates:
            parser.error("--save-config needs at least one of --user, --server, --token, --machine-id")
        if "user" in updates and not USER_RE.match(updates["user"]):
            parser.error("--user may only contain letters, digits and . _ % + @ -")
        save_config({**config, **updates})
        shown = {k: ("***" if k == "token" else v) for k, v in updates.items()}
        print(f"saved {shown} to {CONFIG_PATH}", file=sys.stderr)
        return 0

    identity = {
        "user": args.user or default_user(),
        "machineId": args.machine_id or machine_id(config),
        "hostname": socket.gethostname(),
    }
    if not USER_RE.match(identity["user"]):
        parser.error(f"invalid user id {identity['user']!r}: use letters, digits and . _ % + @ - "
                     "(set one with --user you@example.com --save-config)")

    if args.show_config:
        print(json.dumps({**identity, "server": args.server, "token": "***" if args.token else None,
                          "configFile": str(CONFIG_PATH)}, indent=2))
        return 0

    if args.send_only:
        if not args.server:
            parser.error("--send-only requires a server (--server, CCUSAGE_SERVER or --save-config)")
        saved = json.loads(args.send_only.read_text())
        meta = saved.pop("meta")
        return 0 if send(args, identity, saved, meta) else 2

    until = args.until
    since = until - timedelta(days=args.days - 1)

    try:
        cc = Ccusage(args.bin, args.timezone, args.offline, args.timeout)
        reports = {
            "daily": ("daily", "--breakdown"),
            "projects": ("daily", "--instances"),
            # ccusage's own date filter drops sessions, so fetch all and filter in summarize()
            "sessions": ("session", "--breakdown"),
            "blocks": ("blocks",),
        }
        raw = {}
        for name, (command, *extra) in reports.items():
            print(f"[ccusage] {name} ...", file=sys.stderr)
            unfiltered = name == "sessions"
            raw[name] = cc.report(command, None if unfiltered else since, None if unfiltered else until, *extra)
        meta = {"generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
                "ccusageVersion": cc.version(), "command": args.bin, "timezone": args.timezone or local_timezone()}
    except CcusageError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    summary = summarize(raw, since, until)

    run_dir = args.out / f"{since.isoformat()}_{until.isoformat()}"
    (run_dir / "raw").mkdir(parents=True, exist_ok=True)
    for name, data in raw.items():
        (run_dir / "raw" / f"{name}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False))
    (run_dir / "summary.json").write_text(json.dumps({"meta": meta, **summary}, indent=2, ensure_ascii=False))
    markdown = render_markdown(summary, meta, args.top)
    (run_dir / "report.md").write_text(markdown)

    t = summary["totals"]
    print(f"[ccusage] {since} ~ {until}: {usd(t['cost'])}, {n(t['totalTokens'])} tokens, "
          f"{t['activeDays']} active days -> {run_dir}", file=sys.stderr)
    if args.stdout:
        print(markdown)

    if args.no_send:
        print("[upload] skipped (--no-send)", file=sys.stderr)
    elif not args.server:
        print(f"[upload] skipped: no server configured. Set one once with\n"
              f"         {sys.argv[0]} --user {identity['user']} --server http://SERVER:3200 --save-config\n"
              f"         (or pass --server / set CCUSAGE_SERVER), then run again or use "
              f"--send-only {run_dir / 'summary.json'}", file=sys.stderr)
    elif not send(args, identity, summary, meta):
        print(f"local report kept; retry with --send-only {run_dir / 'summary.json'}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
