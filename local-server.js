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

// GET list
app.get('/.netlify/functions/mongo-proxy', async (req, res) => {
  try {
    const db = await connect();
    const users = db.collection('users');
    const docs = await users.find().sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ users: docs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST insert
app.post('/.netlify/functions/mongo-proxy', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    const db = await connect();
    const users = db.collection('users');
    const result = await users.insertOne({ name: name.trim(), createdAt: new Date() });
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
