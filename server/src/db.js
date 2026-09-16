import { MongoClient } from 'mongodb';
import { config } from './config.js';

const client = new MongoClient(config.mongoUri);

/** @type {import('mongodb').Db} */
export let db;

export async function connect() {
  await client.connect();
  db = client.db(config.mongoDb);
  await Promise.all([
    // One document per user/machine/day: re-submitting an overlapping window replaces the day,
    // while reports from a user's other machines are kept and summed.
    db.collection('daily').createIndex({ user: 1, machineId: 1, date: 1 }, { unique: true }),
    db.collection('daily').createIndex({ date: 1 }),
    // Full history: every submitted report is kept as received.
    db.collection('reports').createIndex({ receivedAt: -1 }),
    db.collection('reports').createIndex({ user: 1, machineId: 1, receivedAt: -1 }),
  ]);
  return db;
}

export async function ping() {
  await db.command({ ping: 1 });
}

export function close() {
  return client.close();
}
