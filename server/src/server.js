import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { clientPackage, packagePath } from './client-package.js';
import { config } from './config.js';
import { close, connect, ping } from './db.js';
import { buildWorkbook } from './export.js';
import { parseReport, storeReport, ValidationError } from './ingest.js';
import { getReport, getStats, listReports, listUsers } from './stats.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const app = express();
app.disable('x-powered-by');

function requireIngestToken(req, res, next) {
  if (!config.ingestToken) return next();
  const given = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(config.ingestToken);
  if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
  console.warn(`[ingest] rejected from ${req.ip}: invalid or missing bearer token`);
  res.status(401).json({ error: 'invalid or missing bearer token' });
}

const asyncRoute = (fn) => (req, res, next) => fn(req, res).catch(next);

app.post(
  '/api/reports',
  requireIngestToken,
  express.json({ limit: '10mb' }),
  asyncRoute(async (req, res) => {
    const stored = await storeReport(parseReport(req.body));
    console.log(`[ingest] ${stored.name ? `${stored.name} <${stored.user}>` : stored.user} machine=${stored.machineId.slice(0, 8)} (${stored.hostname ?? '?'}) ${stored.since}~${stored.until} ${stored.totalTokens} tokens`);
    res.status(201).json({ ok: true, ...stored });
  }),
);

/** since/until (YYYY-MM-DD) and optional user from the query string, or null after sending a 400. */
function rangeQuery(req, res) {
  const { since, until, user } = req.query;
  if (typeof since !== 'string' || typeof until !== 'string' || !DATE_RE.test(since) || !DATE_RE.test(until) || since > until) {
    res.status(400).json({ error: 'since and until (YYYY-MM-DD, since <= until) are required' });
    return null;
  }
  if (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`) > 3 * 366 * 86_400_000) {
    res.status(400).json({ error: 'range must be at most 3 years' });
    return null;
  }
  return { since, until, user: typeof user === 'string' && user ? user : undefined };
}

app.get(
  '/api/stats',
  asyncRoute(async (req, res) => {
    const range = rangeQuery(req, res);
    if (range) res.json(await getStats(range));
  }),
);

// Detailed multi-sheet Excel report for the same filters as the dashboard.
app.get(
  '/api/export.xlsx',
  asyncRoute(async (req, res) => {
    const range = rangeQuery(req, res);
    if (!range) return;
    const workbook = await buildWorkbook(range);
    const suffix = range.user ? `_${range.user.replace(/[^\w.@-]/g, '_')}` : '';
    res.attachment(`claude-code-usage_${range.since}_${range.until}${suffix}.xlsx`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  }),
);

app.get(
  '/api/reports',
  asyncRoute(async (req, res) => {
    const text = (v) => (typeof v === 'string' && v ? v : undefined);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);
    res.json(await listReports({ user: text(req.query.user), machineId: text(req.query.machineId), limit }));
  }),
);

app.get(
  '/api/reports/:id',
  asyncRoute(async (req, res) => {
    const report = await getReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'report not found' });
    res.json(report);
  }),
);

app.get('/api/users', asyncRoute(async (_req, res) => res.json(await listUsers())));

app.get(
  '/api/health',
  asyncRoute(async (_req, res) => {
    await ping();
    res.json({ ok: true });
  }),
);

// Setup guide and client: whether uploads need a token (never the token itself) and the current client package.
app.get(
  '/api/client-info',
  asyncRoute(async (_req, res) => {
    let client = null;
    try {
      const pkg = await clientPackage();
      client = { version: pkg.version, package: packagePath(pkg) };
    } catch (error) {
      console.error(`[client] packaging failed: ${error.message}`);
    }
    res.json({ tokenRequired: Boolean(config.ingestToken), client });
  }),
);

// Node.js client package for `npx <url> setup`. Any version/hash in the name serves the current package; the
// hash only makes each build a distinct URL for npm's cache.
app.get(
  /^\/client\/cc-usage-client(-[\w.-]+)?\.tgz$/,
  asyncRoute(async (_req, res) => {
    const pkg = await clientPackage();
    res.type('application/gzip').sendFile(pkg.file, { dotfiles: 'allow' }); // lives in server/.client-dist
  }),
);

// The client script, so new users can download it straight from this server.
app.get('/client/ccusage_report.py', (_req, res) =>
  res.type('text/x-python').download(path.join(root, '..', 'ccusage_report.py'), 'ccusage_report.py'),
);

app.get('/vendor/chart.umd.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/chart.js/dist/chart.umd.js')));
app.use(express.static(path.join(root, 'public')));

app.use((err, req, res, _next) => {
  const reject = (status, error) => {
    console.warn(`[${req.method} ${req.path}] rejected from ${req.ip}: ${error}`);
    res.status(status).json({ error });
  };
  if (err instanceof ValidationError) return reject(400, err.message);
  if (err.type === 'entity.parse.failed') return reject(400, 'invalid JSON body');
  if (err.type === 'entity.too.large') return reject(413, 'report too large');
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

await connect();
const server = app.listen(config.port, config.host, () => {
  console.log(`cc-usage server on http://localhost:${config.port} (db ${config.mongoDb}` +
    `${config.ingestToken ? ', ingest token required' : ''})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => close().then(() => process.exit(0)));
  });
}
