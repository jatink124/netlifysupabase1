// netlify/functions/mongo-proxy.js
// Serverless API for the Checklist app.
// Stores checklists + items (including drag/drop order + priority) in MongoDB.

const { MongoClient, ObjectId } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'test';

if (!MONGODB_URI) {
  console.warn('MONGODB_URI is not set. Configure it in your Netlify environment variables.');
}

// Basic connection caching for warm Lambda invocations
let cachedClient = global._mongoClient || null;
let cachedDb = global._mongoDb || null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function stringifyIds(docs) {
  return docs.map((doc) => {
    const copy = { ...doc };
    if (copy._id) copy._id = String(copy._id);
    if (Array.isArray(copy.items)) {
      copy.items = copy.items.map((it) => ({ ...it }));
    } else {
      copy.items = [];
    }
    return copy;
  });
}

function safeJsonParse(str, fallback = {}) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...CORS_HEADERS,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      },
      body: '',
    };
  }

  try {
    // Lazy Mongo connection
    if (!cachedClient) {
      const client = new MongoClient(MONGODB_URI, {});
      await client.connect();
      cachedClient = client;
      cachedDb = client.db(DB_NAME);
      global._mongoClient = cachedClient;
      global._mongoDb = cachedDb;
      console.log('Connected to MongoDB Atlas (Netlify function)');
    }

    const db = cachedDb;
    const coll = db.collection('checklists');

    const method = event.httpMethod;
    const path = event.path || '';
    const qs = event.queryStringParameters || {};
    const isItems = path.endsWith('/items');

    // ------------- CHECKLISTS -------------

    // GET / -> list all checklists
    if (method === 'GET' && !isItems) {
      // Prefer explicit order if present, fall back to createdAt
      const docs = await coll
        .find({})
        .sort({ order: 1, createdAt: 1 })
        .toArray();

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ checklists: stringifyIds(docs) }),
      };
    }

    // POST / -> create checklist
    if (method === 'POST' && !isItems) {
      const body = safeJsonParse(event.body);
      const name = body.name && String(body.name).trim();
      if (!name) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'name required' }),
        };
      }

      const now = new Date();
      const doc = {
        name,
        items: [],
        order: typeof body.order === 'number' ? body.order : now.getTime(), // initial ordering
        createdAt: now,
        updatedAt: now,
      };

      const result = await coll.insertOne(doc);

      return {
        statusCode: 201,
        headers: CORS_HEADERS,
        body: JSON.stringify({ insertedId: result.insertedId.toString() }),
      };
    }

    // PUT /?id=CHECKLIST_ID -> update checklist (name and/or order)
    if (method === 'PUT' && !isItems && qs.id) {
      const id = qs.id;
      if (!ObjectId.isValid(id)) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'invalid id' }),
        };
      }

      const body = safeJsonParse(event.body);
      const update = {};

      if ('name' in body) {
        update.name = String(body.name || '').trim();
      }
      if ('order' in body && body.order !== undefined && body.order !== null) {
        const parsedOrder = Number(body.order);
        if (!Number.isNaN(parsedOrder)) {
          update.order = parsedOrder;
        }
      }

      if (!Object.keys(update).length) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'nothing to update' }),
        };
      }

      update.updatedAt = new Date();

      const result = await coll.updateOne(
        { _id: new ObjectId(id) },
        { $set: update }
      );

      if (result.matchedCount === 0) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: true }),
      };
    }

    // DELETE /?id=CHECKLIST_ID -> delete checklist
    if (method === 'DELETE' && !isItems && qs.id) {
      const id = qs.id;
      if (!ObjectId.isValid(id)) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'invalid id' }),
        };
      }

      const result = await coll.deleteOne({ _id: new ObjectId(id) });

      if (result.deletedCount === 0) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: true }),
      };
    }

    // ------------- ITEMS -------------

    // POST /items?id=CHECKLIST_ID -> add item
    if (method === 'POST' && isItems) {
      const checklistId = qs.id;
      if (!checklistId || !ObjectId.isValid(checklistId)) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'invalid id' }),
        };
      }

      const body = safeJsonParse(event.body);
      const text = body.text && String(body.text).trim();
      if (!text) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'text required' }),
        };
      }

      const now = new Date();
      const priority = body.priority ? String(body.priority) : '';
      const order = typeof body.order === 'number' ? body.order : now.getTime();

      const item = {
        id: new ObjectId().toString(),
        text,
        completed: false,
        priority,
        order,
        createdAt: now,
        updatedAt: now,
      };

      const result = await coll.updateOne(
        { _id: new ObjectId(checklistId) },
        {
          $push: { items: item },
          $set: { updatedAt: now },
        }
      );

      if (result.matchedCount === 0) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'not found' }),
        };
      }

      return {
        statusCode: 201,
        headers: CORS_HEADERS,
        body: JSON.stringify({ item }),
      };
    }

    // PUT /items?id=CHECKLIST_ID&itemId=ITEM_ID -> update text/completed/priority/order
    if (method === 'PUT' && isItems) {
      const checklistId = qs.id;
      const itemId = qs.itemId;

      if (!checklistId || !ObjectId.isValid(checklistId)) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'invalid id' }),
        };
      }
      if (!itemId) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'itemId required' }),
        };
      }

      const body = safeJsonParse(event.body);
      const toSet = {};

      if ('text' in body) {
        toSet['items.$.text'] = String(body.text || '').trim();
      }
      if ('completed' in body) {
        toSet['items.$.completed'] = !!body.completed;
      }
      if ('priority' in body) {
        toSet['items.$.priority'] = String(body.priority || '');
      }
      if ('order' in body && body.order !== undefined && body.order !== null) {
        const parsedOrder = Number(body.order);
        if (!Number.isNaN(parsedOrder)) {
          toSet['items.$.order'] = parsedOrder;
        }
      }

      if (!Object.keys(toSet).length) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'nothing to update' }),
        };
      }

      toSet['items.$.updatedAt'] = new Date();

      const result = await coll.updateOne(
        { _id: new ObjectId(checklistId), 'items.id': itemId },
        {
          $set: toSet,
          $currentDate: { updatedAt: true },
        }
      );

      if (result.matchedCount === 0) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: true }),
      };
    }

    // DELETE /items?id=CHECKLIST_ID&itemId=ITEM_ID -> remove item
    if (method === 'DELETE' && isItems) {
      const checklistId = qs.id;
      const itemId = qs.itemId;

      if (!checklistId || !ObjectId.isValid(checklistId)) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'invalid id' }),
        };
      }
      if (!itemId) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'itemId required' }),
        };
      }

      const result = await coll.updateOne(
        { _id: new ObjectId(checklistId) },
        {
          $pull: { items: { id: itemId } },
          $set: { updatedAt: new Date() },
        }
      );

      if (result.matchedCount === 0) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: true }),
      };
    }

    // No matching route
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  } catch (err) {
    console.error('mongo-proxy error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message || String(err) }),
    };
  }
};
