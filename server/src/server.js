import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { clientPackage, packagePath } from './client-package.js';
import { config } from './config.js';
import { dayCount, isCalendarDate } from './dates.js';
import { close, connect, ping } from './db.js';
import { buildWorkbook } from './export.js';
import { isLoopback, lanAddresses } from './network.js';
import { parseReport, storeReport, ValidationError } from './ingest.js';
import { getReport, getStats, listReports, listUsers } from './stats.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_RANGE_DAYS = 3 * 366;
// chart.js does not export dist/chart.umd.js, so locate it next to the package entry (works wherever npm installs it).
const chartUmd = path.join(path.dirname(createRequire(import.meta.url).resolve('chart.js')), 'chart.umd.js');

const app = express();
app.disable('x-powered-by');
// Behind the Nginx reverse proxy: take the client address from X-Forwarded-For when it comes from a private hop.
app.set('trust proxy', 'loopback, uniquelocal');

// Liveness check for the deployment platform: no auth, no database.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  });
  next();
});

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
  if (!isCalendarDate(since) || !isCalendarDate(until) || since > until) {
    res.status(400).json({ error: 'since and until (YYYY-MM-DD, since <= until) are required' });
    return null;
  }
  if (dayCount(since, until) > MAX_RANGE_DAYS) {
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

// Setup guide and client: whether uploads need a token (never the token itself), the current client package, and
// which server address to show. Network addresses are only shared with a browser on the server machine itself (the
// case where the page was opened as localhost and the guide needs an address other computers can reach).
app.get(
  '/api/client-info',
  asyncRoute(async (req, res) => {
    let client = null;
    try {
      const pkg = await clientPackage();
      client = { version: pkg.version, package: packagePath(pkg) };
    } catch (error) {
      console.error(`[client] packaging failed: ${error.message}`);
    }
    const server = {
      publicUrl: config.publicUrl ?? null,
      ...(isLoopback(req.ip) ? { addresses: lanAddresses(), hostname: os.hostname() } : {}),
    };
    res.json({ tokenRequired: Boolean(config.ingestToken), client, server });
  }),
);

// Unknown API paths answer in JSON like every other API response.
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// Node.js client package for `npx <url> setup`. Any version/hash in the name serves the current package; the
// hash only makes each build a distinct URL for npm's cache.
app.get(
  /^\/client\/cc-usage-client(-[\w.-]+)?\.tgz$/,
  asyncRoute(async (_req, res) => {
    const pkg = await clientPackage();
    res.type('application/gzip').sendFile(pkg.file, { dotfiles: 'allow' }); // may live in server/.client-dist
  }),
);

app.get('/vendor/chart.umd.js', (_req, res) => res.sendFile(chartUmd));
app.use(express.static(path.join(root, 'public')));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err); // a streamed response failed mid-way; let Express close the socket
  const reject = (status, error) => {
    console.warn(`[${req.method} ${req.path}] rejected from ${req.ip}: ${error}`);
    res.status(status).json({ error });
  };
  if (err instanceof ValidationError) return reject(400, err.message);
  if (err?.type === 'entity.parse.failed') return reject(400, 'invalid JSON body');
  if (err?.type === 'entity.too.large') return reject(413, 'report too large');
  // Other client errors raised by Express or body-parser (bad URL encoding, missing file, unsupported charset).
  const status = err?.status ?? err?.statusCode;
  if (status >= 400 && status < 500) return reject(status, err.expose ? err.message : 'bad request');
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

await connect();
const server = app.listen(config.port, config.host, () => {
  console.log(`cc-usage server listening on ${config.host}:${config.port} (db ${config.mongoDb}` +
    `${config.ingestToken ? ', ingest token required' : ''})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    setTimeout(() => process.exit(1), 10_000).unref(); // don't hang on a long export or keep-alive connection
    server.closeIdleConnections();
    server.close(async () => {
      try {
        await close();
      } catch (error) {
        console.error('[db] close failed', error);
      }
      process.exit(0);
    });
  });
}
