import { db } from './db.js';

export const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_RE = /^[\w.%+@-]{1,200}$/;
const MACHINE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_ROWS = 5000;

export class ValidationError extends Error {}

const fail = (message) => {
  throw new ValidationError(message);
};

function str(value, name, { max = 300, optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} must be a non-empty string (<= ${max} chars)`);
  return value.trim();
}

function num(value, name) {
  const n = value ?? 0;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) fail(`${name} must be a non-negative number`);
  return n;
}

function day(value, name) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail(`${name} must be YYYY-MM-DD`);
  return value;
}

function list(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) fail(`${name} must be an array (<= ${MAX_ROWS} items)`);
  return value;
}

function usage(row, name) {
  if (!row || typeof row !== 'object') fail(`${name} must be an object`);
  const out = {};
  for (const f of TOKEN_FIELDS) out[f] = num(row[f], `${name}.${f}`);
  out.totalTokens = TOKEN_FIELDS.reduce((sum, f) => sum + out[f], 0);
  return out;
}

function timestamp(value, name) {
  if (value == null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) fail(`${name} must be a date`);
  return d;
}

/**
 * Validates the body produced by ccusage_report.py. Only aggregate token and session counts are accepted:
 *   { schemaVersion, user, machineId, hostname, timezone, meta, range, periodTotal, dailyTotals[] }
 * Cost and the detail sections sent by older clients (models, projects, sessions, billing blocks) are ignored,
 * never stored.
 */
export function parseReport(body) {
  if (!body || typeof body !== 'object') fail('body must be a JSON object');
  if (![1, 2, 3].includes(body.schemaVersion)) fail('unsupported schemaVersion (expected 3)');
  const user = str(body.user, 'user', { max: 200 });
  if (!USER_RE.test(user)) fail('user may only contain letters, digits and . _ % + @ - (e.g. name@example.com)');
  const machineId = str(body.machineId, 'machineId', { max: 128 });
  if (!MACHINE_ID_RE.test(machineId)) fail('machineId must be 8-128 chars of [A-Za-z0-9_-]');

  const since = day(body.range?.since, 'range.since');
  const until = day(body.range?.until, 'range.until');
  if (since > until) fail('range.since must be <= range.until');

  const dailyTotals = list(body.dailyTotals, 'dailyTotals').map((d, i) => {
    const date = day(d.date, `dailyTotals[${i}].date`);
    if (date < since || date > until) fail(`dailyTotals[${i}].date is outside range`);
    return { date, ...usage(d, `dailyTotals[${i}]`), sessions: num(d.sessions, `dailyTotals[${i}].sessions`) };
  });
  if (new Set(dailyTotals.map((d) => d.date)).size !== dailyTotals.length) fail('dailyTotals has duplicate dates');

  const pt = body.periodTotal;
  const periodTotal = {
    ...usage(pt, 'periodTotal'),
    activeDays: num(pt.activeDays, 'periodTotal.activeDays'),
    cacheHitRate: num(pt.cacheHitRate, 'periodTotal.cacheHitRate'),
    sessions: body.schemaVersion >= 2 ? num(pt.sessions, 'periodTotal.sessions') : dailyTotals.reduce((n, d) => n + d.sessions, 0),
  };

  return {
    user,
    machineId,
    hostname: str(body.hostname, 'hostname', { max: 200, optional: true }),
    timezone: str(body.timezone, 'timezone', { max: 100, optional: true }),
    ccusageVersion: str(body.meta?.ccusageVersion, 'meta.ccusageVersion', { max: 50, optional: true }),
    generatedAt: timestamp(body.meta?.generatedAt, 'meta.generatedAt'),
    since,
    until,
    periodTotal,
    dailyTotals,
  };
}

/**
 * Stores a parsed report in two ways:
 * - `reports`: every submission is kept as received (period total and per-day totals) as history.
 * - `daily`: the current view used for statistics, keyed by user + machine, so each computer a user reports
 *   from is kept separately and statistics sum them. For a given machine the most recently submitted window
 *   is authoritative for its days.
 */
export async function storeReport(report) {
  const { user, machineId, hostname, since, until } = report;
  const now = new Date();
  const key = { user, machineId };

  const { insertedId } = await db.collection('reports').insertOne({
    ...key,
    hostname,
    receivedAt: now,
    generatedAt: report.generatedAt,
    timezone: report.timezone,
    ccusageVersion: report.ccusageVersion,
    since,
    until,
    periodTotal: report.periodTotal,
    dailyTotals: report.dailyTotals,
  });

  const activeDays = report.dailyTotals.filter((d) => d.totalTokens > 0);
  await db.collection('daily').deleteMany({
    ...key,
    date: { $gte: since, $lte: until, $nin: activeDays.map((d) => d.date) },
  });
  if (activeDays.length) {
    await db.collection('daily').bulkWrite(
      activeDays.map((d) => ({
        replaceOne: {
          filter: { ...key, date: d.date },
          replacement: { ...key, hostname, ...d, reportId: insertedId, updatedAt: now },
          upsert: true,
        },
      })),
    );
  }

  return {
    reportId: insertedId,
    user,
    machineId,
    hostname,
    since,
    until,
    days: report.dailyTotals.length,
    activeDays: activeDays.length,
    sessions: report.periodTotal.sessions,
    totalTokens: report.periodTotal.totalTokens,
  };
}
