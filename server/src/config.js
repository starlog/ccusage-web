export const config = {
  port: Number(process.env.PORT ?? 3200),
  host: process.env.HOST ?? '0.0.0.0',
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017',
  mongoDb: process.env.MONGODB_DB ?? 'cc_usage',
  // When set, POST /api/reports requires `Authorization: Bearer <token>`.
  ingestToken: process.env.INGEST_TOKEN || null,
};
