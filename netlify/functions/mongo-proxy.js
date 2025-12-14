// netlify/functions/mongo-proxy.js
const { MongoClient, ObjectId } = require('mongodb');

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
function stringifyIds(docs) {
  return docs.map(d => { const copy = { ...d }; if (copy._id) copy._id = copy._id.toString(); return copy; });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: { ...CORS_HEADERS, 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' },
      body: ''
    };
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
    const journalColl = db.collection('live_journal'); // NEW

    const path = event.path || '';
    const method = event.httpMethod;
    const qs = event.queryStringParameters || {};

    // ---------------- LIVE JOURNAL (per user/day) ----------------
    // Simple single-user demo: userId = 'demo-user'
    const userId = 'demo-user';
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // GET /journal
    if (method === 'GET' && path.endsWith('/journal')) {
      const doc = await journalColl.findOne({ userId, date: todayStr });
      // Only send journal fields to frontend
      const journal = doc ? {
        nifty:  doc.nifty  || [],
        stock:  doc.stock  || [],
        crypto: doc.crypto || []
      } : null;

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ journal })
      };
    }

    // PUT /journal
    if (method === 'PUT' && path.endsWith('/journal')) {
      const body = JSON.parse(event.body || '{}');
      const journal = {
        nifty:  Array.isArray(body.nifty)  ? body.nifty  : [],
        stock:  Array.isArray(body.stock)  ? body.stock  : [],
        crypto: Array.isArray(body.crypto) ? body.crypto : []
      };

      await journalColl.updateOne(
        { userId, date: todayStr },
        { $set: { userId, date: todayStr, ...journal, updatedAt: new Date() } },
        { upsert: true }
      );

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: true })
      };
    }

    // ---------------- EXISTING ROUTES ----------------

    // GET schema: ?schema=1
    if (method === 'GET' && qs && qs.schema) {
      const s = await schemaColl.findOne({}) || DEFAULT_SCHEMA;
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(s) };
    }

    // GET trades (default)
    if (method === 'GET') {
      const docs = await tradesColl.find().sort({ createdAt: -1 }).limit(500).toArray();
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ trades: stringifyIds(docs) }) };
    }

    // CREATE schema field - POST to path ending /schema
    if (method === 'POST' && path.endsWith('/schema')) {
      const body = JSON.parse(event.body || '{}');
      const err = validateSchemaField(body);
      if (err) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: err }) };
      const s = await schemaColl.findOne({}) || { fields: [] };
      const key = sanitizeKey(body.key);
      if ((s.fields || []).some(f => f.key === key))
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'field exists' }) };
      const newField = {
        key,
        label: body.label || key,
        type: body.type || 'text',
        options: Array.isArray(body.options) ? body.options : [],
        required: !!body.required
      };
      await schemaColl.updateOne({}, { $push: { fields: newField } }, { upsert: true });
      return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ ok: true, field: newField }) };
    }

    // UPDATE schema field - PUT /schema?id=KEY
    if (method === 'PUT' && path.endsWith('/schema')) {
      const key = sanitizeKey(qs.id || '');
      if (!key) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'id required' }) };
      const body = JSON.parse(event.body || '{}');
      const s = await schemaColl.findOne({}) || { fields: [] };
      const idx = (s.fields || []).findIndex(f => f.key === key);
      if (idx === -1) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'field not found' }) };
      const updated = { ...s.fields[idx] };
      if ('label' in body) updated.label = body.label;
      if ('type' in body) {
        if (!['text','textarea','select','number','date'].includes(body.type))
          return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid type' }) };
        updated.type = body.type;
      }
      if ('options' in body) updated.options = Array.isArray(body.options) ? body.options : [];
      if ('required' in body) updated.required = !!body.required;
      s.fields[idx] = updated;
      await schemaColl.updateOne({}, { $set: { fields: s.fields } }, { upsert: true });
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true, field: updated }) };
    }

    // DELETE schema field - DELETE /schema?id=KEY
    if (method === 'DELETE' && path.endsWith('/schema')) {
      const key = sanitizeKey(qs.id || '');
      if (!key) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'id required' }) };
      const s = await schemaColl.findOne({}) || { fields: [] };
      if (!s.fields || !s.fields.some(f => f.key === key))
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'field not found' }) };
      const newFields = (s.fields || []).filter(f => f.key !== key);
      await schemaColl.updateOne({}, { $set: { fields: newFields } }, { upsert: true });
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // CREATE trade - POST
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const schemaDoc = await schemaColl.findOne({}) || DEFAULT_SCHEMA;
      const allowed = (schemaDoc.fields || []).map(f => f.key);
      const required = (schemaDoc.fields || []).filter(f => f.required).map(f => f.key);

      const doc = { createdAt: new Date() };
      for (const k of allowed) {
        if (k in body) doc[k] = body[k];
      }
      for (const r of required) {
        if (!doc[r] || String(doc[r]).trim() === '')
          return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: r + ' required' }) };
      }
      const result = await tradesColl.insertOne(doc);
      return {
        statusCode: 201,
        headers: CORS_HEADERS,
        body: JSON.stringify({ insertedId: result.insertedId.toString() })
      };
    }

    // UPDATE trade - PUT ?id=<id>
    if (method === 'PUT') {
      const id = qs.id || null;
      if (!id || !ObjectId.isValid(id))
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid id' }) };
      const body = JSON.parse(event.body || '{}');
      const schemaDoc = await schemaColl.findOne({}) || DEFAULT_SCHEMA;
      const allowed = (schemaDoc.fields || []).map(f => f.key);
      const updateDoc = {};
      for (const k of allowed) {
        if (k in body) updateDoc[k] = body[k];
      }
      if (!Object.keys(updateDoc).length)
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'nothing to update' }) };
      const result = await tradesColl.updateOne({ _id: new ObjectId(id) }, { $set: updateDoc });
      if (result.matchedCount === 0)
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not found' }) };
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // DELETE trade - DELETE ?id=<id>
    if (method === 'DELETE') {
      const id = qs.id || null;
      if (!id || !ObjectId.isValid(id))
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid id' }) };
      const result = await tradesColl.deleteOne({ _id: new ObjectId(id) });
      if (result.deletedCount === 0)
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not found' }) };
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error('Mongo function error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
