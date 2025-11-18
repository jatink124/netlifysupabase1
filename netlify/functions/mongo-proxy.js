// netlify/functions/mongo-proxy.js
// Simple Netlify Function that connects to MongoDB Atlas and exposes GET (list) and POST (insert)

const { MongoClient } = require('mongodb');

// Environment variables to set in Netlify:
// MONGODB_URI  -> full connection string (do NOT expose it to browser)
// MONGODB_DB   -> database name (optional, default 'test')

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'test';

if (!MONGODB_URI) {
  console.warn('MONGODB_URI is not set. Set it in Netlify Environment Variables.');
}

// Cache for re-use across function invocations (best practice on serverless)
let cachedClient = global._mongoClient || null;
let cachedDb = global._mongoDb || null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // change to your domain in production
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...CORS_HEADERS,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
      },
      body: ''
    };
  }

  try {
    // Ensure connected
    if (!cachedClient) {
      const client = new MongoClient(MONGODB_URI, {
        // modern driver options
      });
      await client.connect();
      cachedClient = client;
      cachedDb = client.db(DB_NAME);
      global._mongoClient = cachedClient;
      global._mongoDb = cachedDb;
      console.log('Connected to MongoDB Atlas');
    }

    const db = cachedDb;
    const users = db.collection('users');

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const name = (body.name || '').trim();
      if (!name) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'name required' }) };
      }
      const result = await users.insertOne({ name, createdAt: new Date() });
      return {
        statusCode: 201,
        headers: CORS_HEADERS,
        body: JSON.stringify({ insertedId: result.insertedId })
      };
    }

    // Default: GET - return latest 100 users
    const docs = await users.find().sort({ createdAt: -1 }).limit(100).toArray();
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ users: docs })
    };

  } catch (err) {
    console.error('Mongo function error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message })
    };
  }
};
