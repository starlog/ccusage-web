import fs from 'node:fs';

// Local runs read .env from the working directory. Values already in the environment (set by the deployment
// platform) are never overridden.
if (fs.existsSync('.env')) process.loadEnvFile('.env');

// Empty values count as unset (`||`), so a blank line in .env never yields port 0 or an empty URI.
const env = (name) => process.env[name] || undefined;

/** Database name from the connection string path (mongodb://host:27017/<db>), if any. */
function databaseFromUri(uri) {
  return /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri ?? '')?.[1] || undefined;
}

/** http(s) URL without a trailing slash, or undefined when unset. */
function baseUrl(value) {
  return value?.trim().replace(/\/+$/, '') || undefined;
}

// MONGODB_URI is the documented name; MONGO_URL is accepted too.
const mongoUri = env('MONGODB_URI') ?? env('MONGO_URL');

export const config = {
  port: Number(env('PORT') ?? 3000),
  host: env('HOST') ?? '0.0.0.0',
  // No built-in default, so a missing setting is reported instead of silently using localhost.
  mongoUri,
  // MONGODB_DB wins, then the database in the connection string, then cc_usage.
  mongoDb: env('MONGODB_DB') ?? databaseFromUri(mongoUri) ?? 'cc_usage',
  // When set, POST /api/reports requires `Authorization: Bearer <token>`.
  ingestToken: env('INGEST_TOKEN') ?? null,
  // Address clients should use (e.g. https://tools.example.com/c/cc-usage). Shown in the setup guide when set;
  // otherwise the guide uses the address the dashboard was opened with.
  publicUrl: baseUrl(env('PUBLIC_URL')),
  // Timezone for timestamps written into Excel exports (containers usually run in UTC).
  reportTimezone: env('REPORT_TIMEZONE') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export const MISSING_MONGO_URI =
  'MONGODB_URI (or MONGO_URL) is not set. Set it in the deployment environment or in .env (e.g. mongodb://mongodb:27017/cc_usage).';

/** Settings that make the server unable to start at all. */
export function assertConfig() {
  if (config.publicUrl && !/^https?:\/\/[^/\s]+/.test(config.publicUrl)) {
    throw new Error(`PUBLIC_URL must start with http:// or https:// (got ${config.publicUrl}).`);
  }
}
