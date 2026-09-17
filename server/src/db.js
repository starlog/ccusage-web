import { MongoClient } from 'mongodb';
import { assertConfig, config } from './config.js';

/** @type {MongoClient} */
let client;

/** @type {import('mongodb').Db} */
export let db;

/** Connection options shared by the server and scripts: fail fast instead of hanging 30 s when the DB is down. */
export const clientOptions = {
  appName: 'cc-usage-server',
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
};

export async function connect() {
  assertConfig();
  client = new MongoClient(config.mongoUri, clientOptions);
  await client.connect();
  db = client.db(config.mongoDb);
  await Promise.all([
    // One document per user/machine/day: re-submitting an overlapping window replaces the day,
    // while reports from a user's other machines are kept and summed.
    db.collection('daily').createIndex({ user: 1, machineId: 1, date: 1 }, { unique: true }),
    db.collection('daily').createIndex({ date: 1 }),
    // Lets the all-time ranking in listUsers() read the index instead of every document.
    db.collection('daily').createIndex({ user: 1, totalTokens: 1 }),
    db.collection('users').createIndex({ user: 1 }, { unique: true }),
    // Full history: every submitted report is kept as received.
    db.collection('reports').createIndex({ receivedAt: -1 }),
    db.collection('reports').createIndex({ user: 1, machineId: 1, receivedAt: -1 }),
    // /api/reports filtered by user or machine, newest first.
    db.collection('reports').createIndex({ user: 1, receivedAt: -1 }),
    db.collection('reports').createIndex({ machineId: 1, receivedAt: -1 }),
    // Export: reports whose [since, until] overlaps the requested range.
    db.collection('reports').createIndex({ until: 1, since: 1 }),
  ]);
  return db;
}

export async function ping() {
  await db.command({ ping: 1 });
}

export function close() {
  return client?.close();
}
