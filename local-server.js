// local-server.js
require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
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
  if (!/^[a-zA-Z0-9_]+$/.test(key)) return 'invalid key (letters, numbers, underscore only)';
  if (!['text','textarea','select','number','date'].includes(f.type || 'text')) return 'invalid type';
  return null;
}
function stringifyIds(docs) {
  return docs.map(d => { const copy = { ...d }; if (copy._id) copy._id = copy._id.toString(); return copy; });
}

// ----------------- Original REST endpoints (kept for convenience) -----------------
// Schema REST: GET /schema, POST /schema, PUT /schema/:key, DELETE /schema/:key
app.get('/schema', async (req, res) => {
  try {
    const db = await connect();
    const coll = db.collection('schema');
    let schemaDoc = await coll.findOne({});
    if (!schemaDoc) {
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

app.put('/schema/:key', async (req, res) => {
  try {
    const key = sanitizeKey(req.params.key);
    const body = req.body || {};
    const allowedTypes = ['text','textarea','select','number','date'];
    if (body.type && !allowedTypes.includes(body.type)) return res.status(400).json({ error: 'invalid type' });
    const db = await connect();
    const coll = db.collection('schema');
    const s = await coll.findOne({}) || { fields: [] };
    const idx = (s.fields || []).findIndex(f => f.key === key);
    if (idx === -1) return res.status(404).json({ error: 'field not found' });
    const updated = { ...s.fields[idx] };
    if ('label' in body) updated.label = body.label;
    if ('type' in body) updated.type = body.type;
    if ('options' in body) updated.options = Array.isArray(body.options) ? body.options : [];
    if ('required' in body) updated.required = !!body.required;
    s.fields[idx] = updated;
    await coll.updateOne({}, { $set: { fields: s.fields } }, { upsert: true });
    res.json({ ok: true, field: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/schema/:key', async (req, res) => {
  try {
    const key = sanitizeKey(req.params.key);
    const db = await connect();
    const coll = db.collection('schema');
    const s = await coll.findOne({}) || { fields: [] };
    if (!s.fields || !s.fields.some(f => f.key === key)) return res.status(404).json({ error: 'field not found' });
    const newFields = (s.fields || []).filter(f => f.key !== key);
    await coll.updateOne({}, { $set: { fields: newFields } }, { upsert: true });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Trades REST
app.get('/trades', async (req, res) => {
  try {
    const db = await connect();
    const trades = db.collection('trades');
    const docs = await trades.find().sort({ createdAt: -1 }).limit(500).toArray();
    res.json({ trades: stringifyIds(docs) });
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
    res.status(201).json({ insertedId: result.insertedId.toString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/trades/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const db = await connect();
    const collSchema = db.collection('schema');
    const schemaDoc = await collSchema.findOne({}) || DEFAULT_SCHEMA;
    const allowed = (schemaDoc.fields || []).map(f => f.key);
    const body = req.body || {};
    const updateDoc = {};
    for (const k of allowed) {
      if (k in body) updateDoc[k] = body[k];
    }
    if (!Object.keys(updateDoc).length) return res.status(400).json({ error: 'nothing to update' });
    const trades = db.collection('trades');
    const result = await trades.updateOne({ _id: new ObjectId(id) }, { $set: updateDoc });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/trades/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const db = await connect();
    const trades = db.collection('trades');
    const result = await trades.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------- Netlify-function-like routes for local testing -----------------
// This maps requests to the same behavior the Netlify function implements
app.all('/.netlify/functions/mongo-proxy', async (req, res) => {
  try {
    const db = await connect();
    const schemaColl = db.collection('schema');
    const tradesColl = db.collection('trades');

    // handle OPTIONS (preflight)
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    // GET with ?schema=1 returns schema
    if (req.method === 'GET' && req.query && ('schema' in req.query)) {
      const s = await schemaColl.findOne({}) || DEFAULT_SCHEMA;
      return res.json(s);
    }

    // GET (default) -> list trades
    if (req.method === 'GET') {
      const docs = await tradesColl.find().sort({ createdAt: -1 }).limit(500).toArray();
      return res.json({ trades: stringifyIds(docs) });
    }

    // POST -> create trade
    if (req.method === 'POST') {
      const body = req.body || {};
      const schemaDoc = await schemaColl.findOne({}) || DEFAULT_SCHEMA;
      const allowed = (schemaDoc.fields || []).map(f => f.key);
      const required = (schemaDoc.fields || []).filter(f => f.required).map(f => f.key);

      const doc = { createdAt: new Date() };
      for (const k of allowed) {
        if (k in body) doc[k] = body[k];
      }
      for (const r of required) {
        if (!doc[r] || String(doc[r]).trim() === '') return res.status(400).json({ error: r + ' required' });
      }
      const result = await tradesColl.insertOne(doc);
      return res.status(201).json({ insertedId: result.insertedId.toString() });
    }

    // PUT -> update trade, expects ?id=<id>
    if (req.method === 'PUT') {
      const id = req.query && req.query.id;
      if (!id || !ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
      const body = req.body || {};
      const schemaDoc = await schemaColl.findOne({}) || DEFAULT_SCHEMA;
      const allowed = (schemaDoc.fields || []).map(f => f.key);
      const updateDoc = {};
      for (const k of allowed) {
        if (k in body) updateDoc[k] = body[k];
      }
      if (!Object.keys(updateDoc).length) return res.status(400).json({ error: 'nothing to update' });
      const result = await tradesColl.updateOne({ _id: new ObjectId(id) }, { $set: updateDoc });
      if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true });
    }

    // DELETE -> delete trade, expects ?id=<id>
    if (req.method === 'DELETE') {
      const id = req.query && req.query.id;
      if (!id || !ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
      const result = await tradesColl.deleteOne({ _id: new ObjectId(id) });
      if (result.deletedCount === 0) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true });
    }

    // fallback
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('local function error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Netlify-like schema endpoints so frontend calls to /.netlify/functions/mongo-proxy/schema work
app.all('/.netlify/functions/mongo-proxy/schema', async (req, res) => {
  try {
    const db = await connect();
    const coll = db.collection('schema');

    if (req.method === 'OPTIONS') return res.status(204).end();

    // POST -> create new field
    if (req.method === 'POST') {
      const field = req.body || {};
      const v = validateSchemaField(field);
      if (v) return res.status(400).json({ error: v });
      const key = sanitizeKey(field.key);
      const s = await coll.findOne({}) || { fields: [] };
      if ((s.fields || []).some(f => f.key === key)) return res.status(400).json({ error: 'field exists' });
      const newField = { key, label: field.label || key, type: field.type || 'text', options: Array.isArray(field.options) ? field.options : [], required: !!field.required };
      await coll.updateOne({}, { $push: { fields: newField } }, { upsert: true });
      return res.status(201).json({ ok: true, field: newField });
    }

    // PUT -> update field using ?id=key
    if (req.method === 'PUT') {
      const key = sanitizeKey(req.query && req.query.id);
      if (!key) return res.status(400).json({ error: 'id required' });
      const body = req.body || {};
      const s = await coll.findOne({}) || { fields: [] };
      const idx = (s.fields || []).findIndex(f => f.key === key);
      if (idx === -1) return res.status(404).json({ error: 'field not found' });
      const updated = { ...s.fields[idx] };
      if ('label' in body) updated.label = body.label;
      if ('type' in body) updated.type = body.type;
      if ('options' in body) updated.options = Array.isArray(body.options) ? body.options : [];
      if ('required' in body) updated.required = !!body.required;
      s.fields[idx] = updated;
      await coll.updateOne({}, { $set: { fields: s.fields } }, { upsert: true });
      return res.json({ ok: true, field: updated });
    }

    // DELETE -> delete field using ?id=key
    if (req.method === 'DELETE') {
      const key = sanitizeKey(req.query && req.query.id);
      if (!key) return res.status(400).json({ error: 'id required' });
      const s = await coll.findOne({}) || { fields: [] };
      if (!s.fields || !s.fields.some(f => f.key === key)) return res.status(404).json({ error: 'field not found' });
      const newFields = (s.fields || []).filter(f => f.key !== key);
      await coll.updateOne({}, { $set: { fields: newFields } }, { upsert: true });
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('local schema function error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Local server running at http://localhost:${PORT}`);
  console.log(`You can use the Netlify-style endpoints locally:`);
  console.log(`  /.netlify/functions/mongo-proxy?schema=1  (GET schema)`);
  console.log(`  /.netlify/functions/mongo-proxy           (GET/POST/PUT/DELETE trades - with ?id= for PUT/DELETE)`);
  console.log(`  /.netlify/functions/mongo-proxy/schema    (POST / PUT?id= / DELETE?id=)`);
  console.log(`Also the regular REST endpoints exist: /schema and /trades etc.`);
});
