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

export const config = {
  port: Number(env('PORT') ?? 3000),
  host: env('HOST') ?? '0.0.0.0',
  // Required: no built-in default, so a missing setting fails loudly instead of silently using localhost.
  mongoUri: env('MONGODB_URI'),
  // MONGODB_DB wins, then the database in MONGODB_URI, then cc_usage.
  mongoDb: env('MONGODB_DB') ?? databaseFromUri(env('MONGODB_URI')) ?? 'cc_usage',
  // When set, POST /api/reports requires `Authorization: Bearer <token>`.
  ingestToken: env('INGEST_TOKEN') ?? null,
  // Address clients should use (e.g. https://tools.example.com/c/cc-usage). Shown in the setup guide when set;
  // otherwise the guide uses the address the dashboard was opened with.
  publicUrl: baseUrl(env('PUBLIC_URL')),
  // Timezone for timestamps written into Excel exports (containers usually run in UTC).
  reportTimezone: env('REPORT_TIMEZONE') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export function assertConfig() {
  if (config.publicUrl && !/^https?:\/\/[^/\s]+/.test(config.publicUrl)) {
    throw new Error(`PUBLIC_URL must start with http:// or https:// (got ${config.publicUrl}).`);
  }
  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to .env and set it (e.g. mongodb://shared-mongo:27017/cc_usage).');
  }
}
