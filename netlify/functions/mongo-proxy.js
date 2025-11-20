// netlify/functions/mongo-proxy.js
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'test';

if (!MONGODB_URI) {
  console.warn('MONGODB_URI is not set. Set it in Netlify Environment Variables.');
}

// Cache for re-use across function invocations
let cachedClient = global._mongoClient || null;
let cachedDb = global._mongoDb || null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const VALID_TIMEFRAMES = ['5m', '15m', '4h', '1d', '1w'];
const VALID_INSTRUMENT_TYPES = ['index', 'stock', 'crypto'];

function validateTrade(payload) {
  if (!payload) return 'Missing payload';
  const { asset, instrumentType, timeframe, note } = payload;
  if (!asset || !String(asset).trim()) return 'asset required';
  if (!instrumentType || !VALID_INSTRUMENT_TYPES.includes(instrumentType)) return 'invalid instrumentType';
  if (!timeframe || !VALID_TIMEFRAMES.includes(timeframe)) return 'invalid timeframe';
  if (note && String(note).length > 1000) return 'note too long';
  // whitelist fields to avoid unexpected data
  const allowed = ['asset', 'instrumentType', 'timeframe', 'note'];
  for (const k of Object.keys(payload)) {
    if (!allowed.includes(k)) return `unknown field: ${k}`;
  }
  return null;
}

exports.handler = async (event) => {
  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...CORS_HEADERS,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
      },
      body: ''
    };
  }

  try {
    // Ensure connected
    if (!cachedClient) {
      const client = new MongoClient(MONGODB_URI, {});
      await client.connect();
      cachedClient = client;
      cachedDb = client.db(DB_NAME);
      global._mongoClient = cachedClient;
      global._mongoDb = cachedDb;
      console.log('Connected to MongoDB Atlas');
    }

    const db = cachedDb;
    const trades = db.collection('trades');

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const err = validateTrade(body);
      if (err) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: err }) };
      }

      const doc = {
        asset: String(body.asset).trim(),
        instrumentType: body.instrumentType,
        timeframe: body.timeframe,
        note: body.note ? String(body.note).trim() : '',
        createdAt: new Date()
      };

      const result = await trades.insertOne(doc);
      return {
        statusCode: 201,
        headers: CORS_HEADERS,
        body: JSON.stringify({ insertedId: result.insertedId })
      };
    }

    // Default: GET - return latest 200 trades
    const docs = await trades.find().sort({ createdAt: -1 }).limit(200).toArray();
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ trades: docs })
    };

  } catch (err) {
    console.error('Mongo function error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message })
    };
  }
};
