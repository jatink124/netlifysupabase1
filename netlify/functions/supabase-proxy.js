// netlify/functions/supabase-proxy.js
const { createClient } = require('@supabase/supabase-js');

// Read credentials from Netlify environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('Supabase credentials are missing (SUPABASE_URL / SUPABASE_KEY).');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Netlify Function handler
 */
exports.handler = async (event) => {
  // Basic CORS headers so the browser can call this function
  const headers = {
    'Access-Control-Allow-Origin': '*', // in production restrict origin
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...headers,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
      },
      body: ''
    };
  }

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const name = (body.name || '').trim();

      if (!name) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name required' }) };
      }

      const { data, error } = await supabase
        .from('users')
        .insert([{ name }])
        .select();

      if (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
      }

      return { statusCode: 201, headers, body: JSON.stringify({ inserted: data }) };
    }

    // Default: GET - fetch all users
    const { data, error } = await supabase
      .from('users')
      .select('id,name,created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ users: data }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
