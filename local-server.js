// local-server.js
// Robust local dev server for Checklist app with Mongo fallback to in-memory.
// - Improved logging
// - Consistent return shapes between Mongo and in-memory for easier client handling
// - Stable date handling and sorting
// - Clearer error returns

require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// request logger
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

// in-memory store (for dev)
const inMemoryStore = {
  checklists: [] // each: { _id, name, createdAt(ISO), updatedAt(ISO), items: [{ id, text, completed, priority, createdAt(ISO), updatedAt(ISO) }] }
};

const makeId = () => new ObjectId().toString();
const nowISO = () => (new Date()).toISOString();

// normalize dates for sorting (accept Date or ISO string)
function toTime(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

function stringifyIds(docs) {
  return docs.map(d => {
    const copy = { ...d };
    if (copy._id && typeof copy._id !== 'string') copy._id = copy._id.toString();
    // ensure items are plain objects with string ids
    if (Array.isArray(copy.items)) {
      copy.items = copy.items.map(it => ({ ...it }));
    } else {
      copy.items = [];
    }
    return copy;
  });
}

// try Mongo connection; fall back to in-memory if not available
async function tryConnectMongo() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not set — using in-memory store.');
    usingInMemory = true;
    return null;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    cachedClient = client;
    cachedDb = client.db(DB_NAME);
    usingInMemory = false;
    console.log('Connected to MongoDB:', DB_NAME);
    return cachedDb;
  } catch (err) {
    console.error('Mongo connect failed — falling back to in-memory:', err.message || err);
    usingInMemory = true;
    return null;
  }
}

async function getDb() {
  if (usingInMemory) return null;
  if (cachedDb) return cachedDb;
  return await tryConnectMongo();
}

// --- CRUD helpers (abstracted) ---

async function dbListChecklists() {
  if (usingInMemory) {
    // sort by createdAt (newest first) — robust to ISO strings
    const copy = inMemoryStore.checklists.slice().sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt));
    return stringifyIds(copy);
  }
  const db = await getDb();
  const docs = await db.collection('checklists').find().sort({ createdAt: -1 }).toArray();
  return stringifyIds(docs);
}

async function dbCreateChecklist(name) {
  const doc = { name, items: [], createdAt: nowISO(), updatedAt: nowISO() };
  if (usingInMemory) {
    doc._id = makeId();
    inMemoryStore.checklists.push(doc);
    return doc._id;
  }
  const db = await getDb();
  const res = await db.collection('checklists').insertOne(doc);
  return res.insertedId.toString();
}

async function dbUpdateChecklist(id, updateObj) {
  if (usingInMemory) {
    const idx = inMemoryStore.checklists.findIndex(c => String(c._id) === String(id));
    if (idx === -1) return { matchedCount: 0 };
    inMemoryStore.checklists[idx] = { ...inMemoryStore.checklists[idx], ...updateObj, updatedAt: nowISO() };
    return { matchedCount: 1 };
  }
  const db = await getDb();
  const res = await db.collection('checklists').updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...updateObj, updatedAt: new Date() } }
  );
  return res;
}

async function dbDeleteChecklist(id) {
  if (usingInMemory) {
    const before = inMemoryStore.checklists.length;
    inMemoryStore.checklists = inMemoryStore.checklists.filter(c => String(c._id) !== String(id));
    const removed = before - inMemoryStore.checklists.length;
    return { deletedCount: removed };
  }
  const db = await getDb();
  const res = await db.collection('checklists').deleteOne({ _id: new ObjectId(id) });
  return res;
}

async function dbAddItem(checklistId, text, priority = '') {
  const item = { id: makeId(), text, completed: false, priority: priority || '', createdAt: nowISO(), updatedAt: nowISO() };
  if (usingInMemory) {
    const cl = inMemoryStore.checklists.find(c => String(c._id) === String(checklistId));
    if (!cl) return null;
    cl.items.push(item);
    cl.updatedAt = nowISO();
    return item;
  }
  const db = await getDb();
  const res = await db.collection('checklists').updateOne(
    { _id: new ObjectId(checklistId) },
    { $push: { items: item }, $set: { updatedAt: new Date() } }
  );
  if (res.matchedCount === 0) return null;
  return item;
}

async function dbUpdateItem(checklistId, itemId, body = {}) {
  if (usingInMemory) {
    const cl = inMemoryStore.checklists.find(c => String(c._id) === String(checklistId));
    if (!cl) return { matchedCount: 0 };
    const it = cl.items.find(i => i.id === itemId);
    if (!it) return { matchedCount: 0 };
    if ('text' in body) it.text = String(body.text || '').trim();
    if ('completed' in body) it.completed = !!body.completed;
    if ('priority' in body) it.priority = String(body.priority || '');
    it.updatedAt = nowISO();
    cl.updatedAt = nowISO();
    return { matchedCount: 1 };
  }
  const updateFields = {};
  if ('text' in body) updateFields['items.$.text'] = String(body.text || '').trim();
  if ('completed' in body) updateFields['items.$.completed'] = !!body.completed;
  if ('priority' in body) updateFields['items.$.priority'] = String(body.priority || '');
  updateFields['items.$.updatedAt'] = new Date();
  const db = await getDb();
  const res = await db.collection('checklists').updateOne(
    { _id: new ObjectId(checklistId), 'items.id': itemId },
    { $set: updateFields, $currentDate: { updatedAt: true } }
  );
  return res;
}

async function dbDeleteItem(checklistId, itemId) {
  if (usingInMemory) {
    const cl = inMemoryStore.checklists.find(c => String(c._id) === String(checklistId));
    if (!cl) return { matchedCount: 0 };
    const before = cl.items.length;
    cl.items = cl.items.filter(it => it.id !== itemId);
    const removed = before - cl.items.length;
    cl.updatedAt = nowISO();
    return { matchedCount: removed ? 1 : 0 };
  }
  const db = await getDb();
  const res = await db.collection('checklists').updateOne(
    { _id: new ObjectId(checklistId) },
    { $pull: { items: { id: itemId } }, $set: { updatedAt: new Date() } }
  );
  return res;
}

// kick off try to connect (non-fatal)
(async () => {
  await tryConnectMongo();
})();

// standardized error helper
function sendServerError(res, err) {
  console.error('SERVER ERROR:', err);
  res.status(500).json({ error: (err && err.message) || String(err) });
}

// -------- REST endpoints (same semantics as Netlify function) --------

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
    const deletedCount = (result.deletedCount !== undefined) ? result.deletedCount : (result.matchedCount ? 1 : 0);
    if (!deletedCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) { sendServerError(res, err); }
});

// items
app.post('/checklists/:id/items', async (req, res) => {
  try {
    const id = req.params.id;
    if (!usingInMemory && !ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const { text, priority } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    const item = await dbAddItem(id, String(text).trim(), priority || '');
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
    const has = ('text' in body) || ('completed' in body) || ('priority' in body);
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

// -------- Netlify-style function mapping (for frontend that calls /.netlify/functions/...) --------
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

    // PUT -> update via ?id=
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

    // DELETE -> delete via ?id=
    if (req.method === 'DELETE' && !isItems) {
      const id = qs.id;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) return res.status(400).json({ error: 'invalid id' });
      const result = await dbDeleteChecklist(id);
      const deletedCount = (result.deletedCount !== undefined) ? result.deletedCount : (result.matchedCount ? 1 : 0);
      if (!deletedCount) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true });
    }

    // Items: POST /.netlify/functions/mongo-proxy/items?id=ID
    if (req.method === 'POST' && isItems) {
      const id = qs.id;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) return res.status(400).json({ error: 'invalid id' });
      const { text, priority } = req.body || {};
      if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
      const item = await dbAddItem(id, String(text).trim(), priority || '');
      if (!item) return res.status(404).json({ error: 'not found' });
      return res.status(201).json({ item });
    }

    // Items: PUT /.netlify/functions/mongo-proxy/items?id=ID&itemId=ITEMID
    if (req.method === 'PUT' && isItems) {
      const id = qs.id;
      const itemId = qs.itemId;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) return res.status(400).json({ error: 'invalid id' });
      if (!itemId) return res.status(400).json({ error: 'itemId required' });
      const body = req.body || {};
      const updateFields = {};
      if ('text' in body) updateFields.text = String(body.text || '').trim();
      if ('completed' in body) updateFields.completed = !!body.completed;
      if ('priority' in body) updateFields.priority = String(body.priority || '');
      if (!Object.keys(updateFields).length) return res.status(400).json({ error: 'nothing to update' });
      const result = await dbUpdateItem(id, itemId, body);
      if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true });
    }

    // Items: DELETE /.netlify/functions/mongo-proxy/items?id=ID&itemId=ITEMID
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
  console.log('Using in-memory DB:', usingInMemory);
});
