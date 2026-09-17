import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];
const DAY = 86_400_000;
export const SCHEMA_VERSION = 3;

/** The ccusage CLI bundled as a dependency (version pinned in package.json). */
export function ccusageInfo() {
  const packageFile = require.resolve('ccusage/package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.ccusage;
  return { version: pkg.version, bin: path.join(path.dirname(packageFile), bin) };
}

function runCcusage(args) {
  const { bin } = ccusageInfo();
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, 'claude', ...args],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 300_000, env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`ccusage ${args.join(' ')} 실행 실패: ${(stderr || error.message).trim().slice(0, 500)}`));
        const start = stdout.indexOf('{'); // some versions print log lines before the JSON document
        if (start < 0) return reject(new Error(`ccusage ${args.join(' ')} 결과에 JSON이 없습니다`));
        try {
          resolve(JSON.parse(stdout.slice(start)));
        } catch (parseError) {
          reject(new Error(`ccusage 결과를 해석하지 못했습니다: ${parseError.message}`));
        }
      },
    );
  });
}

export const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** YYYY-MM-DD of an instant in the local timezone (the same grouping ccusage uses). */
const localDate = (value) => new Date(value).toLocaleDateString('en-CA');

const addDays = (isoDate, days) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * Collects the last `days` days (ending `until`, default today) and builds the upload body.
 * Only aggregate token and session counts leave the machine: no cost, models, projects or session details.
 */
export async function buildReport({ days, until, identity }) {
  if (!Number.isInteger(days) || days < 1) throw new Error('--days는 1 이상의 정수여야 합니다');
  const end = until ?? localDate(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('--until은 YYYY-MM-DD 형식이어야 합니다');
  const since = addDays(end, -(days - 1));
  const compact = (d) => d.replaceAll('-', '');

  const [daily, sessions] = await Promise.all([
    runCcusage(['daily', '--json', '--offline', '--since', compact(since), '--until', compact(end)]),
    // ccusage's own date filter drops sessions, so fetch all and count by local start date here.
    runCcusage(['session', '--json', '--offline']),
  ]);

  const started = new Map();
  for (const session of sessions.sessions ?? []) {
    const first = session.firstActivity ?? session.lastActivity;
    if (!first) continue;
    const date = first.includes('T') ? localDate(first) : first.slice(0, 10);
    started.set(date, (started.get(date) ?? 0) + 1);
  }

  const byDate = new Map((daily.daily ?? []).map((row) => [row.date, row]));
  const dailyTotals = [];
  for (let date = since; date <= end; date = addDays(date, 1)) {
    const row = byDate.get(date) ?? {};
    const tokens = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, row[f] ?? 0]));
    dailyTotals.push({
      date,
      ...tokens,
      totalTokens: TOKEN_FIELDS.reduce((sum, f) => sum + tokens[f], 0),
      sessions: started.get(date) ?? 0,
    });
  }

  const sum = (field) => dailyTotals.reduce((total, d) => total + d[field], 0);
  const totals = Object.fromEntries([...TOKEN_FIELDS, 'totalTokens', 'sessions'].map((f) => [f, sum(f)]));
  const cacheBase = totals.cacheReadTokens + totals.cacheCreationTokens + totals.inputTokens;
  const timezone = localTimezone();

  return {
    schemaVersion: SCHEMA_VERSION,
    user: identity.user,
    ...(identity.name ? { name: identity.name } : {}),
    machineId: identity.machineId,
    hostname: os.hostname(),
    timezone,
    meta: { generatedAt: new Date().toISOString(), ccusageVersion: ccusageInfo().version, timezone },
    range: { since, until: end, days },
    periodTotal: {
      ...totals,
      activeDays: dailyTotals.filter((d) => d.totalTokens > 0).length,
      cacheHitRate: cacheBase ? totals.cacheReadTokens / cacheBase : 0,
    },
    dailyTotals,
  };
}
