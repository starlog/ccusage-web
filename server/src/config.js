// Empty values count as unset (`||`), so a blank line in .env never yields port 0 or an empty URI.
const env = (name) => process.env[name] || undefined;

/** Database name from the connection string path (mongodb://host:27017/<db>), if any. */
function databaseFromUri(uri) {
  return /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri ?? '')?.[1] || undefined;
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
  // Timezone for timestamps written into Excel exports (containers usually run in UTC).
  reportTimezone: env('REPORT_TIMEZONE') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export function assertConfig() {
  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to .env and set it (e.g. mongodb://shared-mongo:27017/cc_usage).');
  }
}
