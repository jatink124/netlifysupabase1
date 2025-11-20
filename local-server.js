// local-server.js
require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'test';
const PORT = process.env.PORT || 3000;
if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set in .env');
  process.exit(1);
}

let cachedClient = null;
let cachedDb = null;

async function connect() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  cachedClient = client;
  cachedDb = client.db(DB_NAME);
  console.log('Connected to MongoDB');
  return cachedDb;
}

// Simple schema helpers
const DEFAULT_SCHEMA = {
  fields: [
    { key: 'instrumentType', label: 'Instrument Type', type: 'select', options: ['index','stock','crypto'], required: true },
    { key: 'asset', label: 'Asset / Symbol', type: 'text', required: true },
    { key: 'timeframe', label: 'Timeframe', type: 'select', options: ['5m','15m','4h','1d','1w'], required: true },
    { key: 'note', label: "What's happening?", type: 'textarea' }
  ]
};

function sanitizeKey(k) {
  return String(k || '').trim();
}

function validateSchemaField(f) {
  if (!f || !f.key) return 'missing key';
  const key = sanitizeKey(f.key);
  if (!/^[a-zA-Z0-9_]+$/.test(key)) return 'invalid key (use letters, numbers, underscore)';
  if (!['text','textarea','select','number','date'].includes(f.type || 'text')) return 'invalid type';
  return null;
}

// Basic endpoints for local development (not Netlify functions) — helpful to test quickly
app.get('/schema', async (req, res) => {
  try {
    const db = await connect();
    const coll = db.collection('schema');
    let schemaDoc = await coll.findOne({});
    if (!schemaDoc) {
      // create default schema
      await coll.updateOne({}, { $set: DEFAULT_SCHEMA }, { upsert: true });
      schemaDoc = DEFAULT_SCHEMA;
    }
    res.json(schemaDoc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/schema', async (req, res) => {
  try {
    const db = await connect();
    const coll = db.collection('schema');
    const field = req.body || {};
    const v = validateSchemaField(field);
    if (v) return res.status(400).json({ error: v });
    const key = sanitizeKey(field.key);
    const s = await coll.findOne({}) || { fields: [] };
    if ((s.fields || []).some(f => f.key === key)) return res.status(400).json({ error: 'field exists' });
    const newField = { key, label: field.label || key, type: field.type || 'text', options: Array.isArray(field.options) ? field.options : [], required: !!field.required };
    await coll.updateOne({}, { $push: { fields: newField } }, { upsert: true });
    res.status(201).json({ ok: true, field: newField });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Trades: list & insert (respect schema)
app.get('/trades', async (req, res) => {
  try {
    const db = await connect();
    const trades = db.collection('trades');
    const docs = await trades.find().sort({ createdAt: -1 }).limit(200).toArray();
    res.json({ trades: docs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/trades', async (req, res) => {
  try {
    const db = await connect();
    const collSchema = db.collection('schema');
    const schemaDoc = await collSchema.findOne({}) || DEFAULT_SCHEMA;
    const allowed = (schemaDoc.fields || []).map(f => f.key);
    const required = (schemaDoc.fields || []).filter(f => f.required).map(f => f.key);

    const body = req.body || {};
    const doc = { createdAt: new Date() };
    for (const k of allowed) {
      if (k in body) doc[k] = body[k];
    }
    for (const r of required) {
      if (!doc[r] || String(doc[r]).trim() === '') return res.status(400).json({ error: r + ' required' });
    }
    const trades = db.collection('trades');
    const result = await trades.insertOne(doc);
    res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Local server running at http://localhost:${PORT}`);
  console.log(`Schema endpoints: GET /schema | POST /schema`);
  console.log(`Trades endpoints: GET /trades | POST /trades`);
});
