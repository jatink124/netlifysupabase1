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

function stringifyIds(docs) {
  return docs.map(d => { const copy = { ...d }; if (copy._id) copy._id = copy._id.toString(); return copy; });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...CORS_HEADERS, 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' }, body: '' };
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
    const coll = db.collection('checklists');
    const method = event.httpMethod;
    const path = event.path || '';
    const qs = event.queryStringParameters || {};

    // GET /?list=1 -> list checklists
    if (method === 'GET') {
      const docs = await coll.find().sort({ createdAt: -1 }).toArray();
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ checklists: stringifyIds(docs) }) };
    }

    // CREATE checklist - POST to root
    if (method === 'POST' && !path.endsWith('/items')) {
      const body = JSON.parse(event.body || '{}');
      const name = body.name && String(body.name).trim();
      if (!name) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'name required' }) };
      const doc = { name, items: [], createdAt: new Date(), updatedAt: new Date() };
      const result = await coll.insertOne(doc);
      return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ insertedId: result.insertedId.toString() }) };
    }

    // Update checklist name - PUT ?id=ID
    if (method === 'PUT' && qs.id && !path.includes('/items')) {
      const id = qs.id;
      if (!ObjectId.isValid(id)) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid id' }) };
      const body = JSON.parse(event.body || '{}');
      const update = {};
      if ('name' in body) update.name = String(body.name).trim();
      if (!Object.keys(update).length) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'nothing to update' }) };
      update.updatedAt = new Date();
      const result = await coll.updateOne({ _id: new ObjectId(id) }, { $set: update });
      if (result.matchedCount === 0) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not found' }) };
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // Delete checklist - DELETE ?id=ID
    if (method === 'DELETE' && qs.id && !path.includes('/items')) {
      const id = qs.id;
      if (!ObjectId.isValid(id)) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid id' }) };
      const result = await coll.deleteOne({ _id: new ObjectId(id) });
      if (result.deletedCount === 0) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not found' }) };
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // Items: create item - POST /items?id=CHECKLIST_ID
    if (method === 'POST' && path.endsWith('/items')) {
      const id = qs.id;
      if (!id || !ObjectId.isValid(id)) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid id' }) };
      const body = JSON.parse(event.body || '{}');
      const text = body.text && String(body.text).trim();
      if (!text) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'text required' }) };
      const item = { id: new ObjectId().toString(), text, completed: false, createdAt: new Date(), updatedAt: new Date() };
      const result = await coll.updateOne({ _id: new ObjectId(id) }, { $push: { items: item }, $set: { updatedAt: new Date() } });
      if (result.matchedCount === 0) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not found' }) };
      return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ item }) };
    }

    // Update item - PUT /items?id=CHECKLIST_ID&itemId=ITEMID
    if (method === 'PUT' && path.endsWith('/items')) {
      const id = qs.id;
      const itemId = qs.itemId;
      if (!id || !ObjectId.isValid(id)) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid id' }) };
      if (!itemId) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'itemId required' }) };
      const body = JSON.parse(event.body || '{}');
      const updateFields = {};
      if ('text' in body) updateFields['items.$.text'] = String(body.text).trim();
      if ('completed' in body) updateFields['items.$.completed'] = !!body.completed;
      if (!Object.keys(updateFields).length) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'nothing to update' }) };
      updateFields['items.$.updatedAt'] = new Date();
      const result = await coll.updateOne({ _id: new ObjectId(id), 'items.id': itemId }, { $set: updateFields, $currentDate: { updatedAt: true } });
      if (result.matchedCount === 0) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not found' }) };
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    // Delete item - DELETE /items?id=CHECKLIST_ID&itemId=ITEMID
    if (method === 'DELETE' && path.endsWith('/items')) {
      const id = qs.id;
      const itemId = qs.itemId;
      if (!id || !ObjectId.isValid(id)) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'invalid id' }) };
      if (!itemId) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'itemId required' }) };
      const result = await coll.updateOne({ _id: new ObjectId(id) }, { $pull: { items: { id: itemId } }, $set: { updatedAt: new Date() } });
      if (result.matchedCount === 0) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'not found' }) };
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error('Mongo function error:', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
