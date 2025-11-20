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

function stringifyIds(docs) {
  return docs.map(d => { const copy = { ...d }; if (copy._id) copy._id = copy._id.toString(); return copy; });
}

// Checklists collection endpoints
// Document shape:
// { _id, name, createdAt, updatedAt, items: [{ id, text, completed, createdAt, updatedAt }] }

app.get('/checklists', async (req, res) => {
  try {
    const db = await connect();
    const coll = db.collection('checklists');
    const docs = await coll.find().sort({ createdAt: -1 }).toArray();
    res.json({ checklists: stringifyIds(docs) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/checklists', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    const db = await connect();
    const coll = db.collection('checklists');
    const doc = { name: String(name).trim(), items: [], createdAt: new Date(), updatedAt: new Date() };
    const result = await coll.insertOne(doc);
    res.status(201).json({ insertedId: result.insertedId.toString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/checklists/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const { name } = req.body || {};
    const update = {};
    if (typeof name !== 'undefined') update.name = String(name).trim();
    if (!Object.keys(update).length) return res.status(400).json({ error: 'nothing to update' });
    update.updatedAt = new Date();
    const db = await connect();
    const coll = db.collection('checklists');
    const result = await coll.updateOne({ _id: new ObjectId(id) }, { $set: update });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/checklists/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const db = await connect();
    const coll = db.collection('checklists');
    const result = await coll.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Items endpoints (operate on items array inside checklist)
app.post('/checklists/:id/items', async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    const db = await connect();
    const coll = db.collection('checklists');
    const item = { id: new ObjectId().toString(), text: String(text).trim(), completed: false, createdAt: new Date(), updatedAt: new Date() };
    const result = await coll.updateOne({ _id: new ObjectId(id) }, { $push: { items: item }, $set: { updatedAt: new Date() } });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
    res.status(201).json({ item });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/checklists/:id/items/:itemId', async (req, res) => {
  try {
    const id = req.params.id;
    const itemId = req.params.itemId;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const body = req.body || {};
    const updateFields = {};
    if ('text' in body) updateFields['items.$.text'] = String(body.text).trim();
    if ('completed' in body) updateFields['items.$.completed'] = !!body.completed;
    if (!Object.keys(updateFields).length) return res.status(400).json({ error: 'nothing to update' });
    updateFields['items.$.updatedAt'] = new Date();
    const db = await connect();
    const coll = db.collection('checklists');
    const result = await coll.updateOne({ _id: new ObjectId(id), 'items.id': itemId }, { $set: updateFields, $currentDate: { updatedAt: true } });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/checklists/:id/items/:itemId', async (req, res) => {
  try {
    const id = req.params.id;
    const itemId = req.params.itemId;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid id' });
    const db = await connect();
    const coll = db.collection('checklists');
    const result = await coll.updateOne({ _id: new ObjectId(id) }, { $pull: { items: { id: itemId } }, $set: { updatedAt: new Date() } });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
});

