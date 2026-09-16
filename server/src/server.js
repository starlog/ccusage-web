import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { close, connect, ping } from './db.js';
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
    console.log(`[ingest] ${stored.user} machine=${stored.machineId.slice(0, 8)} (${stored.hostname ?? '?'}) ${stored.since}~${stored.until} ${stored.totalTokens} tokens`);
    res.status(201).json({ ok: true, ...stored });
  }),
);

app.get(
  '/api/stats',
  asyncRoute(async (req, res) => {
    const { since, until, user } = req.query;
    if (!DATE_RE.test(since ?? '') || !DATE_RE.test(until ?? '') || since > until) {
      return res.status(400).json({ error: 'since and until (YYYY-MM-DD, since <= until) are required' });
    }
    res.json(await getStats({ since, until, user: typeof user === 'string' && user ? user : undefined }));
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
