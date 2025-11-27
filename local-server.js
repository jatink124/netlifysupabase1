// local-server.js
// Local development server for the Checklist app.
// - Tries to use MongoDB; if it fails, falls back to in-memory storage.
// - Exposes clean REST endpoints AND a Netlify-compatible proxy:
//      /.netlify/functions/mongo-proxy[(/items)]
// - Persists checklist + item order (drag & drop) and priority.

require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// basic logger
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.originalUrl);
  next();
});

const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGODB_DB || 'test';
const PORT = process.env.PORT || 3000;

let usingInMemory = false;
let cachedClient = null;
let cachedDb = null;

// In-memory fallback structure
// checklist: { _id, name, order, createdAt, updatedAt, items: [ { id, text, completed, priority, order, createdAt, updatedAt } ] }
const inMemoryStore = {
  checklists: [],
};

const makeId = () => new ObjectId().toString();
const nowISO = () => new Date().toISOString();

function toTime(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

function stringifyIds(docs) {
  return docs.map((doc) => {
    const copy = { ...doc };
    if (copy._id && typeof copy._id !== 'string') copy._id = String(copy._id);
    if (!Array.isArray(copy.items)) copy.items = [];
    copy.items = copy.items.map((it) => ({ ...it }));
    return copy;
  });
}

// ----- Mongo handling -----

async function tryConnectMongo() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI not provided — using in-memory store only.');
    usingInMemory = true;
    return null;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    cachedClient = client;
    cachedDb = client.db(DB_NAME);
    usingInMemory = false;
    console.log('Connected to MongoDB for local-server:', DB_NAME);
    return cachedDb;
  } catch (err) {
    console.error('Mongo connection failed, falling back to in-memory:', err.message || err);
    usingInMemory = true;
    return null;
  }
}

async function getDb() {
  if (usingInMemory) return null;
  if (cachedDb) return cachedDb;
  return await tryConnectMongo();
}

// ----- Abstracted DB helpers -----

async function dbListChecklists() {
  if (usingInMemory) {
    const copy = inMemoryStore.checklists
      .slice()
      .sort((a, b) => (a.order ?? toTime(a.createdAt)) - (b.order ?? toTime(b.createdAt)));
    return stringifyIds(copy);
  }

  const db = await getDb();
  const docs = await db
    .collection('checklists')
    .find({})
    .sort({ order: 1, createdAt: 1 })
    .toArray();

  return stringifyIds(docs);
}

async function dbCreateChecklist(name, order) {
  const now = nowISO();
  const doc = {
    name,
    items: [],
    order: typeof order === 'number' ? order : Date.now(),
    createdAt: now,
    updatedAt: now,
  };

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
  // Ensure updatedAt always changes
  if (usingInMemory) {
    const idx = inMemoryStore.checklists.findIndex((c) => String(c._id) === String(id));
    if (idx === -1) return { matchedCount: 0 };

    const existing = inMemoryStore.checklists[idx];
    const updated = {
      ...existing,
      ...updateObj,
      updatedAt: nowISO(),
    };
    inMemoryStore.checklists[idx] = updated;
    return { matchedCount: 1 };
  }

  const db = await getDb();
  const setObj = { ...updateObj, updatedAt: new Date() };
  const res = await db
    .collection('checklists')
    .updateOne({ _id: new ObjectId(id) }, { $set: setObj });
  return res;
}

async function dbDeleteChecklist(id) {
  if (usingInMemory) {
    const before = inMemoryStore.checklists.length;
    inMemoryStore.checklists = inMemoryStore.checklists.filter(
      (c) => String(c._id) !== String(id)
    );
    const removed = before - inMemoryStore.checklists.length;
    return { deletedCount: removed };
  }

  const db = await getDb();
  return db.collection('checklists').deleteOne({ _id: new ObjectId(id) });
}

// Add item; order is optional. If not set, we append to end.
async function dbAddItem(checklistId, text, priority = '', order = null) {
  const now = nowISO();
  if (usingInMemory) {
    const cl = inMemoryStore.checklists.find(
      (c) => String(c._id) === String(checklistId)
    );
    if (!cl) return null;

    const itemOrder =
      typeof order === 'number' ? order : (cl.items ? cl.items.length : 0);

    const item = {
      id: makeId(),
      text,
      completed: false,
      priority: priority || '',
      order: itemOrder,
      createdAt: now,
      updatedAt: now,
    };

    cl.items.push(item);
    cl.updatedAt = nowISO();
    return item;
  }

  const db = await getDb();

  const itemOrder =
    typeof order === 'number' ? order : Date.now();

  const item = {
    id: makeId(),
    text,
    completed: false,
    priority: priority || '',
    order: itemOrder,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const res = await db.collection('checklists').updateOne(
    { _id: new ObjectId(checklistId) },
    {
      $push: { items: item },
      $set: { updatedAt: new Date() },
    }
  );

  if (res.matchedCount === 0) return null;
  return item;
}

async function dbUpdateItem(checklistId, itemId, body = {}) {
  if (usingInMemory) {
    const cl = inMemoryStore.checklists.find(
      (c) => String(c._id) === String(checklistId)
    );
    if (!cl) return { matchedCount: 0 };

    const it = cl.items.find((i) => i.id === itemId);
    if (!it) return { matchedCount: 0 };

    if ('text' in body) it.text = String(body.text || '').trim();
    if ('completed' in body) it.completed = !!body.completed;
    if ('priority' in body) it.priority = String(body.priority || '');
    if ('order' in body && body.order !== undefined && body.order !== null) {
      const parsedOrder = Number(body.order);
      if (!Number.isNaN(parsedOrder)) it.order = parsedOrder;
    }

    it.updatedAt = nowISO();
    cl.updatedAt = nowISO();

    return { matchedCount: 1 };
  }

  const updateFields = {};
  if ('text' in body) updateFields['items.$.text'] = String(body.text || '').trim();
  if ('completed' in body) updateFields['items.$.completed'] = !!body.completed;
  if ('priority' in body) updateFields['items.$.priority'] = String(body.priority || '');
  if ('order' in body && body.order !== undefined && body.order !== null) {
    const parsedOrder = Number(body.order);
    if (!Number.isNaN(parsedOrder)) updateFields['items.$.order'] = parsedOrder;
  }
  updateFields['items.$.updatedAt'] = new Date();

  const db = await getDb();
  const res = await db.collection('checklists').updateOne(
    { _id: new ObjectId(checklistId), 'items.id': itemId },
    {
      $set: updateFields,
      $currentDate: { updatedAt: true },
    }
  );
  return res;
}

async function dbDeleteItem(checklistId, itemId) {
  if (usingInMemory) {
    const cl = inMemoryStore.checklists.find(
      (c) => String(c._id) === String(checklistId)
    );
    if (!cl) return { matchedCount: 0 };

    const before = cl.items.length;
    cl.items = cl.items.filter((it) => it.id !== itemId);
    const removed = before - cl.items.length;
    if (removed) cl.updatedAt = nowISO();
    return { matchedCount: removed ? 1 : 0 };
  }

  const db = await getDb();
  const res = await db.collection('checklists').updateOne(
    { _id: new ObjectId(checklistId) },
    {
      $pull: { items: { id: itemId } },
      $set: { updatedAt: new Date() },
    }
  );
  return res;
}

// Kick off initial connection attempt (non-fatal)
(async () => {
  await tryConnectMongo();
})();

// Helper for server errors
function sendServerError(res, err) {
  console.error('SERVER ERROR:', err);
  res.status(500).json({ error: err.message || String(err) });
}

// ---------------- REST endpoints (for direct local API calls) ----------------

app.get('/checklists', async (_req, res) => {
  try {
    const docs = await dbListChecklists();
    res.json({ checklists: docs });
  } catch (err) {
    sendServerError(res, err);
  }
});

app.post('/checklists', async (req, res) => {
  try {
    const { name, order } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    const insertedId = await dbCreateChecklist(String(name).trim(), order);
    res.status(201).json({ insertedId });
  } catch (err) {
    sendServerError(res, err);
  }
});

app.put('/checklists/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!usingInMemory && !ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const { name, order } = req.body || {};
    const update = {};

    if (typeof name !== 'undefined') update.name = String(name || '').trim();
    if (typeof order !== 'undefined' && order !== null) {
      const parsedOrder = Number(order);
      if (!Number.isNaN(parsedOrder)) update.order = parsedOrder;
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'nothing to update' });
    }

    const result = await dbUpdateChecklist(id, update);
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'not found' });
    }

    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

app.delete('/checklists/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!usingInMemory && !ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const result = await dbDeleteChecklist(id);
    const deletedCount =
      typeof result.deletedCount === 'number'
        ? result.deletedCount
        : result.matchedCount
        ? 1
        : 0;

    if (!deletedCount) {
      return res.status(404).json({ error: 'not found' });
    }

    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Items REST
app.post('/checklists/:id/items', async (req, res) => {
  try {
    const id = req.params.id;
    if (!usingInMemory && !ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const { text, priority, order } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'text required' });
    }

    const item = await dbAddItem(
      id,
      String(text).trim(),
      priority || '',
      typeof order === 'number' ? order : null
    );

    if (!item) return res.status(404).json({ error: 'not found' });
    res.status(201).json({ item });
  } catch (err) {
    sendServerError(res, err);
  }
});

app.put('/checklists/:id/items/:itemId', async (req, res) => {
  try {
    const id = req.params.id;
    const itemId = req.params.itemId;
    if (!usingInMemory && !ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const body = req.body || {};
    const hasUpdatableField =
      'text' in body || 'completed' in body || 'priority' in body || 'order' in body;
    if (!hasUpdatableField) {
      return res.status(400).json({ error: 'nothing to update' });
    }

    const result = await dbUpdateItem(id, itemId, body);
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'not found' });
    }

    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

app.delete('/checklists/:id/items/:itemId', async (req, res) => {
  try {
    const id = req.params.id;
    const itemId = req.params.itemId;
    if (!usingInMemory && !ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const result = await dbDeleteItem(id, itemId);
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'not found' });
    }

    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// -------------- Netlify-style proxy (for your frontend FN_URL) --------------

app.all(/^\/\.netlify\/functions\/mongo-proxy(\/.*)?$/, async (req, res) => {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      });
      return res.status(204).end();
    }

    const qs = req.query || {};
    const pathname = req.path || '';
    const isItems = pathname.endsWith('/items');

    // For simplicity, reuse our DB helper functions exactly like the Netlify function.

    // GET -> list all checklists
    if (req.method === 'GET' && !isItems) {
      const docs = await dbListChecklists();
      res.set('Access-Control-Allow-Origin', '*');
      return res.json({ checklists: docs });
    }

    // POST -> create checklist
    if (req.method === 'POST' && !isItems) {
      const { name, order } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'name required' });
      }
      const insertedId = await dbCreateChecklist(String(name).trim(), order);
      return res.status(201).json({ insertedId });
    }

    // PUT -> update checklist (name/order) via ?id=
    if (req.method === 'PUT' && !isItems) {
      const id = qs.id;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) {
        return res.status(400).json({ error: 'invalid id' });
      }

      const { name, order } = req.body || {};
      const update = {};
      if ('name' in (req.body || {})) {
        update.name = String(name || '').trim();
      }
      if ('order' in (req.body || {}) && order !== undefined && order !== null) {
        const parsedOrder = Number(order);
        if (!Number.isNaN(parsedOrder)) update.order = parsedOrder;
      }

      if (!Object.keys(update).length) {
        return res.status(400).json({ error: 'nothing to update' });
      }

      const result = await dbUpdateChecklist(id, update);
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'not found' });
      }

      return res.json({ ok: true });
    }

    // DELETE -> delete checklist via ?id=
    if (req.method === 'DELETE' && !isItems) {
      const id = qs.id;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) {
        return res.status(400).json({ error: 'invalid id' });
      }

      const result = await dbDeleteChecklist(id);
      const deletedCount =
        typeof result.deletedCount === 'number'
          ? result.deletedCount
          : result.matchedCount
          ? 1
          : 0;

      if (!deletedCount) {
        return res.status(404).json({ error: 'not found' });
      }

      return res.json({ ok: true });
    }

    // Items: POST /.netlify/functions/mongo-proxy/items?id=CHECKLIST_ID
    if (req.method === 'POST' && isItems) {
      const id = qs.id;
      if (!id || (!usingInMemory && !ObjectId.isValid(id))) {
        return res.status(400).json({ error: 'invalid id' });
      }

      const { text, priority, order } = req.body || {};
      if (!text || !String(text).trim()) {
        return res.status(400).json({ error: 'text required' });
      }

      const item = await dbAddItem(
        id,
        String(text).trim(),
        priority || '',
        typeof order === 'number' ? order : null
      );
      if (!item) return res.status(404).json({ error: 'not found' });

      return res.status(201).json({ item });
    }

    // Items: PUT /.netlify/functions/mongo-proxy/items?id=CHECKLIST_ID&itemId=ITEM_ID
    if (req.method === 'PUT' && isItems) {
      const id = qs.id;
      const itemId = qs.itemId;

      if (!id || (!usingInMemory && !ObjectId.isValid(id))) {
        return res.status(400).json({ error: 'invalid id' });
      }
      if (!itemId) {
        return res.status(400).json({ error: 'itemId required' });
      }

      const body = req.body || {};
      const hasUpdatableField =
        'text' in body || 'completed' in body || 'priority' in body || 'order' in body;
      if (!hasUpdatableField) {
        return res.status(400).json({ error: 'nothing to update' });
      }

      const result = await dbUpdateItem(id, itemId, body);
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'not found' });
      }

      return res.json({ ok: true });
    }

    // Items: DELETE /.netlify/functions/mongo-proxy/items?id=CHECKLIST_ID&itemId=ITEM_ID
    if (req.method === 'DELETE' && isItems) {
      const id = qs.id;
      const itemId = qs.itemId;

      if (!id || (!usingInMemory && !ObjectId.isValid(id))) {
        return res.status(400).json({ error: 'invalid id' });
      }
      if (!itemId) {
        return res.status(400).json({ error: 'itemId required' });
      }

      const result = await dbDeleteItem(id, itemId);
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'not found' });
      }

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('local mongo-proxy error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`Checklist dev server running at http://localhost:${PORT}`);
  console.log('Using in-memory DB:', usingInMemory);
});
