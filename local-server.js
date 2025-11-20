// local-server.js
require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
app.use(express.json());

// Serve static files (index.html, css, js) from project root
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

// server-side validation helper
const VALID_TIMEFRAMES = ['5m', '15m', '4h', '1d', '1w'];
const VALID_INSTRUMENT_TYPES = ['index', 'stock', 'crypto'];
function validateTrade(payload) {
  if (!payload) return 'Missing payload';
  const { asset, instrumentType, timeframe, note } = payload;
  if (!asset || !String(asset).trim()) return 'asset required';
  if (!instrumentType || !VALID_INSTRUMENT_TYPES.includes(instrumentType)) return 'invalid instrumentType';
  if (!timeframe || !VALID_TIMEFRAMES.includes(timeframe)) return 'invalid timeframe';
  if (note && String(note).length > 1000) return 'note too long';
  return null;
}

// GET list
app.get('/.netlify/functions/mongo-proxy', async (req, res) => {
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

// POST insert
app.post('/.netlify/functions/mongo-proxy', async (req, res) => {
  try {
    const payload = req.body || {};
    const errMsg = validateTrade(payload);
    if (errMsg) return res.status(400).json({ error: errMsg });

    const db = await connect();
    const trades = db.collection('trades');
    const doc = {
      asset: payload.asset.trim(),
      instrumentType: payload.instrumentType,
      timeframe: payload.timeframe,
      note: payload.note ? String(payload.note).trim() : '',
      createdAt: new Date()
    };

    const result = await trades.insertOne(doc);
    res.status(201).json({ insertedId: result.insertedId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Local server running at http://localhost:${PORT}`);
  console.log(`Function endpoint: http://localhost:${PORT}/.netlify/functions/mongo-proxy`);
});
