// local-server.js (robust local dev version; fixed route for path-to-regexp)
require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Debug: log incoming requests
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl);
  next();
});

const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGODB_DB || 'test';
const PORT = process.env.PORT || 3000;

let usingInMemory = false;
let cachedClient = null;
let cachedDb = null;

// --- In-memory store used when Mongo isn't available ---
const inMemoryStore = {
  checklists: [] // each: { _id, name, createdAt, updatedAt, items:[{ id, text, completed, createdAt, updatedAt }] }
};

function makeId() { return new ObjectId().toString(); }
function now() { return new Date(); }

function stringifyIds(docs) {
  return docs.map(d => {
    const copy = { ...d };
    if (copy._id && typeof copy._id !== 'string') copy._id = copy._id.toString();
    return copy;
  });
}

// --- DB helpers (abstract away Mongo vs in-memory) ---
async function tryConnectMongo() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not set — falling back to in-memory store.');
    usingInMemory = true;
    return null;
  }
  try {
    const client = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
    await client.connect();
    cachedClient = client;
    cachedDb = client.db(DB_NAME);
    console.log('Connected to MongoDB (local-server). DB:', DB_NAME);
    usingInMemory = false;
    return cachedDb;
  } catch (err) {
    console.error('Failed to connect to MongoDB — falling back to in-memory. Error:', err.message || err);
    usingInMemory = true;
    return null;
  }
}

async function getDb() {
  if (usingInMemory) return null;
  if (cachedDb) return cachedDb;
  return await tryConnectMongo();
}

// functions for checklists
async function dbListChecklists() {
  if (usingInMemory) {
    return stringifyIds(inMemoryStore.checklists.slice().sort((a,b)=>b.createdAt - a.createdAt));
  }
  const db = await getDb();
  const docs = await db.collection('checklists').find().sort({ createdAt: -1 }).toArray();
  return stringifyIds(docs);
}

async function dbCreateChecklist(name) {
  if (usingInMemory) {
    const doc = { _id: makeId(), name, items: [], createdAt: now(), updatedAt: now() };
    inMemoryStore.checklists.push(doc);
    return doc._id;
  }
  const db = await getDb();
  const res = await db.collection('checklists').insertOne({ name, items: [], createdAt: now(), updatedAt: now() });
  return res.insertedId.toString();
}

async function dbUpdateChecklist(id, updateObj) {
  if (usingInMemory) {
    const idx = inMemoryStore.checklists.findIndex(c => c._id === id || (String(c._id) === String(id)));
    if (idx === -1) return { matchedCount: 0 };
    const existing = inMemoryStore.checklists[idx];
    inMemoryStore.checklists[idx] = { ...existing, ...updateObj, updatedAt: now() };
    return { matchedCount: 1 };
  }
  const db = await getDb();
  const res = await db.collection('checklists').updateOne({ _id: new ObjectId(id) }, { $set: { ...updateObj, updatedAt: now() } });
  return res;
}

async function dbDeleteChecklist(id) {
  if (usingInMemory) {
    const before = inMemoryStore.checklists.length;
    inMemoryStore.checklists = inMemoryStore.checklists.filter(c => !(String(c._id) === String(id)));
    return { deletedCount: before - inMemoryStore.checklists.length };
  }
  const db = await getDb();
  const res = await db.collection('checklists').deleteOne({ _id: new ObjectId(id) });
  return res;
}

// items
async function dbAddItem(checklistId, text) {
  const item = { id: makeId(), text, completed: false, createdAt: now(), updatedAt: now() };
  if (usingInMemory) {
    const cl = inMemoryStore.checklists.find(c => String(c._id) === String(checklistId));
    if (!cl) return null;
    cl.items.push(item);
    cl.updatedAt = now();
    return item;
  }
  const db = await getDb();
  const res = await db.collection('checklists').updateOne({ _id: new ObjectId(checklistId) }, { $push: { items: item }, $set: { updatedAt: now() } });
  if (res.matchedCount === 0) return null;
  return item;
}

async function dbUpdateItem(checklistId, itemId, body) {
  if (usingInMemory) {
    const cl = inMemoryStore.checklists.find(c => String(c._id) === String(checklistId));
    if (!cl) return { matchedCount: 0 };
    const it = cl.items.find(it => it.id === itemId);
    if (!it) return { matchedCount: 0 };
    if ('text' in body) it.text = String(body.text || '').trim();
    if ('completed' in body) it.completed = !!body.completed;
    it.updatedAt = now();
    cl.updatedAt = now();
    return { matchedCount: 1 };
  }
  const db = await getDb();
  const updateFields = {};
  if ('text' in body) updateFields['items.$.text'] = String(body.text || '').trim();
  if ('completed' in body) updateFields['items.$.completed'] = !!body.completed;
  updateFields['items.$.updatedAt'] = now();
  const res = await db.collection('checklists').updateOne({ _id: new ObjectId(checklistId), 'items.id': itemId }, { $set: updateFields, $currentDate: { updatedAt: true } });
  return res;
}

async function dbDeleteItem(checklistId, itemId) {
  if (usingInMemory) {
    const cl = inMemoryStore.checklists.find(c => String(c._id) === String(checklistId));
    if (!cl) return { matchedCount: 0 };
    const before = cl.items.length;
    cl.items = cl.items.filter(it => it.id !== itemId);
    cl.updatedAt = now();
    return { matchedCount: before - cl.items.length ? 1 : 0 };
  }
  const db = await getDb();
  const res = await db.collection('checklists').updateOne({ _id: new ObjectId(checklistId) }, { $pull: { items: { id: itemId } }, $set: { updatedAt: now() } });
  return res;
}

// attempt to connect (non-fatal fallback)
(async () => {
  await tryConnectMongo();
})();

// Helper to standardize JSON responses
function sendServerError(res, err) {
  console.error(err);
  res.status(500).json({ error: (err && err.message) || String(err) });
}

// ---- REST endpoints ----
app.get('/checklists', async (req, res) => {
  try {
    const docs = await dbListChecklists();
    res.json({ checklists: docs });
  } catch (err) { sendServerError(res, err); }
});

app.post('/checklists', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    const id = await dbCreateChecklist(String(name).trim());
    res.status(201).json({ insertedId: id });
  } catch (err) { sendServerError(res, err); }
});

app.put('/checklists/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // validate id for Mongo-style only if not using in-memory
    if (!usingInMemory && !ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const { name } = req.body || {};
    const update = {};
    if (typeof name !== 'undefined') update.name = String(name).trim();
    if (!Object.keys(update).length) return res.status(400).json({ error: 'nothing to update' });
    const result = await dbUpdateChecklist(id, update);
    if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) { sendServerError(res, err); }
});

app.delete('/checklists/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!usingInMemory && !ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const result = await dbDeleteChecklist(id);
    if (result.deletedCount === 0 && result.matchedCount !== 1) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) { sendServerError(res, err); }
});

// Items endpoints
app.post('/checklists/:id/items', async (req, res) => {
  try {
    const id = req.params.id;
    if (!usingInMemory && !ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    const item = await dbAddItem(id, String(text).trim());
    if (!item) return res.status(404).json({ error: 'not found' });
    res.status(201).json({ item });
  } catch (err) { sendServerError(res, err); }
});

app.put('/checklists/:id/items/:itemId', async (req, res) => {
  try {
    const id = req.params.id;
    const itemId = req.params.itemId;
    if (!usingInMemory && !ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const body = req.body || {};
    const has = ('text' in body) || ('completed' in body);
    if (!has) return res.status(400).json({ error: 'nothing to update' });
    const result = await dbUpdateItem(id, itemId, body);
    if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) { sendServerError(res, err); }
});

app.delete('/checklists/:id/items/:itemId', async (req, res) => {
  try {
    const id = req.params.id;
    const itemId = req.params.itemId;
    if (!usingInMemory && !ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const result = await dbDeleteItem(id, itemId);
    if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) { sendServerError(res, err); }
});

// ----------------- Netlify-style function mapping for local testing -----------------
// Use a regex route so path-to-regexp doesn't choke on the '*' character.
app.all(/^\/\.netlify\/functions\/mongo-proxy(\/.*)?$/, async (req, res) => {
  try {
    // preflight
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      });
      return res.status(204).end();
    }

    const qs = req.query || {};
    const pathname = req.path || '';
    const isItems = pathname.endsWith('/items');

    // GET -> list
    if (req.method === 'GET' && !isItems) {
      const docs = await dbListChecklists();
      res.set('Access-Control-Allow-Origin', '*');
      return res.json({ checklists: docs });
    }

    // POST -> create checklist
    if (req.method === 'POST' && !isItems) {
      const { name } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
      const insertedId = await dbCreateChecklist(String(name).trim());
      return res.status(201).json({ insertedId });
    }

    // PUT -> update checklist via ?id=ID
    if (req.method === 'PUT' && !isItems) {
      const id = qs.id;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) return res.status(400).json({ error: 'invalid id' });
      const { name } = req.body || {};
      const update = {};
      if ('name' in req.body) update.name = String(name || '').trim();
      if (!Object.keys(update).length) return res.status(400).json({ error: 'nothing to update' });
      const result = await dbUpdateChecklist(id, update);
      if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true });
    }

    // DELETE -> delete checklist via ?id=ID
    if (req.method === 'DELETE' && !isItems) {
      const id = qs.id;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) return res.status(400).json({ error: 'invalid id' });
      const result = await dbDeleteChecklist(id);
      if (result.deletedCount === 0 && result.matchedCount !== 1) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true });
    }

    // Items: POST /.netlify/functions/mongo-proxy/items?id=CHECKLIST_ID
    if (req.method === 'POST' && isItems) {
      const id = qs.id;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) return res.status(400).json({ error: 'invalid id' });
      const { text } = req.body || {};
      if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
      const item = await dbAddItem(id, String(text).trim());
      if (!item) return res.status(404).json({ error: 'not found' });
      return res.status(201).json({ item });
    }

    // PUT /.netlify/functions/mongo-proxy/items?id=ID&itemId=ITEMID
    if (req.method === 'PUT' && isItems) {
      const id = qs.id;
      const itemId = qs.itemId;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) return res.status(400).json({ error: 'invalid id' });
      if (!itemId) return res.status(400).json({ error: 'itemId required' });
      const body = req.body || {};
      const updateFields = {};
      if ('text' in body) updateFields['text'] = String(body.text || '').trim();
      if ('completed' in body) updateFields['completed'] = !!body.completed;
      if (!Object.keys(updateFields).length) return res.status(400).json({ error: 'nothing to update' });
      const result = await dbUpdateItem(id, itemId, body);
      if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true });
    }

    // DELETE /.netlify/functions/mongo-proxy/items?id=ID&itemId=ITEMID
    if (req.method === 'DELETE' && isItems) {
      const id = qs.id;
      const itemId = qs.itemId;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) return res.status(400).json({ error: 'invalid id' });
      if (!itemId) return res.status(400).json({ error: 'itemId required' });
      const result = await dbDeleteItem(id, itemId);
      if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('local function error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Local Checklist server running at http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log(' GET /checklists');
  console.log(' POST /checklists { name }');
  console.log(' PUT /checklists/:id { name }');
  console.log(' DELETE /checklists/:id');
  console.log(' POST /checklists/:id/items { text }');
  console.log(" PUT /checklists/:id/items/:itemId { text?, completed? }");
  console.log(' DELETE /checklists/:id/items/:itemId');
  console.log('Also Netlify-style function endpoints are available at /.netlify/functions/mongo-proxy');
  console.log('Using in-memory DB:', usingInMemory);
});
