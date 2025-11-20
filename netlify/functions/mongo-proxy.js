// netlify/functions/mongo-proxy.js
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'test';

if (!MONGODB_URI) {
  console.warn('MONGODB_URI is not set. Set it in Netlify Environment Variables.');
}

let cachedClient = global._mongoClient || null;
let cachedDb = global._mongoDb || null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const DEFAULT_SCHEMA = {
  fields: [
    { key: 'instrumentType', label: 'Instrument Type', type: 'select', options: ['index','stock','crypto'], required: true },
    { key: 'asset', label: 'Asset / Symbol', type: 'text', required: true },
    { key: 'timeframe', label: 'Timeframe', type: 'select', options: ['5m','15m','4h','1d','1w'], required: true },
    { key: 'note', label: "What's happening?", type: 'textarea' }
  ]
};

function sanitizeKey(k) { return String(k || '').trim(); }
function validateSchemaField(f) {
  if (!f || !f.key) return 'missing key';
  const key = sanitizeKey(f.key);
  if (!/^[a-zA-Z0-9_]+$/.test(key)) return 'invalid key';
  if (!['text','textarea','select','number','date'].includes(f.type || 'text')) return 'invalid type';
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...CORS_HEADERS, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }, body: '' };
  }

  try {
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
    const schemaColl = db.collection('schema');
    const tradesColl = db.collection('trades');

    // GET schema ?schema=1
    if (event.httpMethod === 'GET' && event.queryStringParameters && event.queryStringParameters.schema) {
      const s = await schemaColl.findOne({}) || DEFAULT_SCHEMA;
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(s) };
    }

    // GET trades (default)
    if (event.httpMethod === 'GET') {
      const docs = await tradesColl.find().sort({ createdAt: -1 }).limit(200).toArray();
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ trades: docs }) };
    }

    // POST new schema field at path /schema (use Netlify rewrite to map if needed)
    if (event.httpMethod === 'POST' && event.path && event.path.endsWith('/schema')) {
      const body = JSON.parse(event.body || '{}');
      const err = validateSchemaField(body);
      if (err) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: err }) };
      const s = await schemaColl.findOne({}) || { fields: [] };
      const key = sanitizeKey(body.key);
      if ((s.fields || []).some(f => f.key === key)) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'field exists' }) };
      const newField = { key, label: body.label || key, type: body.type || 'text', options: Array.isArray(body.options) ? body.options : [], required: !!body.required };
      await schemaColl.updateOne({}, { $push: { fields: newField } }, { upsert: true });
      return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ ok: true, field: newField }) };
    }

    // POST trade (validate against schema)
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const schemaDoc = await schemaColl.findOne({}) || DEFAULT_SCHEMA;
      const allowed = (schemaDoc.fields || []).map(f => f.key);
      const required = (schemaDoc.fields || []).filter(f => f.required).map(f => f.key);

      // whitelist incoming fields only
      const doc = { createdAt: new Date() };
      for (const k of allowed) {
        if (k in body) doc[k] = body[k];
      }
      for (const r of required) {
        if (!doc[r] || String(doc[r]).trim() === '') return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: r + ' required' }) };
      }
      const result = await tradesColl.insertOne(doc);
      return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ insertedId: result.insertedId }) };
    }

    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Mongo function error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
