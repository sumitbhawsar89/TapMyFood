const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'restaurant_ai',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 10,                    // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
    return;
  }
  release();
  console.log('✅ PostgreSQL connected');
});

// Simple query helper
const db = {
  query: (text, params) => pool.query(text, params),

  // Get single row
  queryOne: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows[0] || null;
  },

  // Get all rows
  queryAll: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows;
  },

  // Transaction helper
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

module.exports = db;

