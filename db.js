const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;
let sqliteDb = null;
let usePg = false;

// Guards against the auto-seed migration recursing into itself (migrate_to_postgres
// calls initDatabase, which would otherwise re-trigger the seed before data exists).
let autoSeedInProgress = false;

const dbUrl = (process.env.DATABASE_URL || '').trim();

if (dbUrl) {
  usePg = true;
  pool = new Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1') 
      ? false 
      : { rejectUnauthorized: false }
  });
  console.log('PostgreSQL Connection Pool Initialized via DATABASE_URL');
} else {
  try {
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = path.join(__dirname, 'local_postgres.db');
    sqliteDb = new sqlite3.Database(dbPath);
    console.log('Local Development SQL Database Initialized:', dbPath);
  } catch (err) {
    console.warn('DATABASE_URL is not set in environment. Please add DATABASE_URL in Render Environment Variables.');
  }
}

// Convert PostgreSQL $1, $2 syntax to SQLite ? syntax when using local fallback
function convertPgSqlToSqlite(sql) {
  let converted = sql;
  converted = converted.replace(/\$\d+/g, '?');
  converted = converted.replace(/::[a-z0-9_]+/gi, '');
  converted = converted.replace(/TIMESTAMPTZ/gi, 'TEXT');
  converted = converted.replace(/JSONB/gi, 'TEXT');
  converted = converted.replace(/BIGINT/gi, 'INTEGER');
  
  if (converted.toUpperCase().includes('ON CONFLICT') && converted.toUpperCase().includes('DO UPDATE')) {
    converted = converted.replace(/INSERT INTO/gi, 'INSERT OR REPLACE INTO');
    converted = converted.replace(/ON CONFLICT[\s\S]+?;$/gi, ';');
    converted = converted.replace(/ON CONFLICT[\s\S]+/gi, '');
  } else if (converted.toUpperCase().includes('ON CONFLICT') && converted.toUpperCase().includes('DO NOTHING')) {
    converted = converted.replace(/INSERT INTO/gi, 'INSERT OR IGNORE INTO');
    converted = converted.replace(/ON CONFLICT[\s\S]+?;$/gi, ';');
    converted = converted.replace(/ON CONFLICT[\s\S]+/gi, '');
  }
  return converted;
}

// Universal SQL Query Method
async function query(text, params = []) {
  if (usePg && pool) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      console.error('[PostgreSQL Query Error]:', err.message);
      throw err;
    }
  }

  if (sqliteDb) {
    return new Promise((resolve, reject) => {
      const cleanSql = convertPgSqlToSqlite(text.trim());
      const isSelect = cleanSql.toUpperCase().startsWith('SELECT') || cleanSql.toUpperCase().startsWith('PRAGMA');

      if (isSelect) {
        sqliteDb.all(cleanSql, params, (err, rows) => {
          if (err) {
            console.error('[SQLite Query Error]:', err.message);
            return reject(err);
          }
          const parsedRows = rows ? rows.map(r => {
            const rowObj = { ...r };
            for (let key in rowObj) {
              if (typeof rowObj[key] === 'string' && (rowObj[key].startsWith('{') || rowObj[key].startsWith('['))) {
                try { rowObj[key] = JSON.parse(rowObj[key]); } catch (e) {}
              }
            }
            return rowObj;
          }) : [];
          resolve({ rows: parsedRows, rowCount: parsedRows.length });
        });
      } else {
        sqliteDb.run(cleanSql, params, function(err) {
          if (err) {
            console.error('[SQLite Query Error]:', err.message);
            return reject(err);
          }
          resolve({ rows: [], rowCount: this.changes || 0, insertId: this.lastID });
        });
      }
    });
  }

  return { rows: [], rowCount: 0 };
}

// Schema Initialization: Creates all 14 database tables
async function initDatabase() {
  console.log('Initializing PostgreSQL database schemas...');

  const schemaQueries = [
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      mobile VARCHAR(20) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'CUSTOMER',
      email VARCHAR(255),
      address TEXT,
      referral_code VARCHAR(50),
      referred_by VARCHAR(100),
      referred_by_code VARCHAR(50),
      wallet_balance NUMERIC(10, 2) DEFAULT 0.00,
      loyalty_points INT DEFAULT 0,
      cart JSONB DEFAULT '[]'::jsonb,
      favorites JSONB DEFAULT '[]'::jsonb,
      show_on_leaderboard BOOLEAN DEFAULT true,
      sound_enabled BOOLEAN DEFAULT true,
      status VARCHAR(50) DEFAULT 'active',
      blocked_at TIMESTAMPTZ,
      blocked_by VARCHAR(100),
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1,
      hotel_name VARCHAR(255) NOT NULL DEFAULT 'Sri Lakshmi Annapurna Tiffin Center',
      hotel_logo VARCHAR(500) DEFAULT '/images/tiffin_logo.png',
      phone VARCHAR(50) DEFAULT '+91 9392874900',
      address TEXT DEFAULT '#42, Temple Road, Near Gandhi Circle, Bengaluru, KA',
      open_time VARCHAR(50) DEFAULT '06:30 AM',
      close_time VARCHAR(50) DEFAULT '10:30 PM',
      holidays VARCHAR(255) DEFAULT 'None (Open 7 Days)',
      upi_id VARCHAR(100) DEFAULT 'annapurna.tiffin@upi',
      upi_name VARCHAR(100) DEFAULT 'Sri Lakshmi Annapurna Tiffin Center',
      upi_qr_code TEXT DEFAULT '/images/tiffin_logo.png',
      is_open BOOLEAN DEFAULT true,
      is_qr_pay_enabled BOOLEAN DEFAULT true,
      is_phonepe_enabled BOOLEAN DEFAULT true,
      description TEXT,
      referral JSONB DEFAULT '{"enabled": true, "referrer_reward": 30, "new_customer_discount": 30, "min_order_value": 150, "monthly_limit": 500, "milestones": [{"count": 1, "bonus": 0}, {"count": 5, "bonus": 100}, {"count": 10, "bonus": 250}]}'::jsonb,
      upi_qr_updated_at BIGINT
    );`,

    `CREATE TABLE IF NOT EXISTS tiffins (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      price NUMERIC(10, 2) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'Breakfast',
      image VARCHAR(500),
      is_available BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(100) PRIMARY KEY,
      order_number VARCHAR(100) NOT NULL UNIQUE,
      customer_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
      customer_name VARCHAR(255),
      customer_mobile VARCHAR(50),
      order_type VARCHAR(50) DEFAULT 'Takeaway',
      delivery_address TEXT,
      notes TEXT,
      total_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      used_wallet_amount NUMERIC(10, 2) DEFAULT 0.00,
      net_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      payment_method VARCHAR(100) DEFAULT 'Cash',
      payment_status VARCHAR(50) DEFAULT 'Pending',
      order_status VARCHAR(50) DEFAULT 'Received',
      items JSONB DEFAULT '[]'::jsonb,
      cancellation_reason TEXT,
      utr_number VARCHAR(100),
      payment_screenshot TEXT,
      screenshot_url TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS payments (
      id VARCHAR(100) PRIMARY KEY,
      order_number VARCHAR(100) NOT NULL,
      order_id VARCHAR(100),
      customer_id VARCHAR(100),
      customer_name VARCHAR(255),
      customer_mobile VARCHAR(50),
      amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      payment_method VARCHAR(100) DEFAULT 'Cash',
      payment_status VARCHAR(50) DEFAULT 'Pending',
      utr_number VARCHAR(100),
      screenshot_url TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS referrals (
      id VARCHAR(100) PRIMARY KEY,
      referrer_id VARCHAR(100) REFERENCES users(id) ON DELETE SET NULL,
      referrer_mobile VARCHAR(50),
      referrer_name VARCHAR(255),
      referred_id VARCHAR(100) REFERENCES users(id) ON DELETE SET NULL,
      referred_mobile VARCHAR(50),
      referred_name VARCHAR(255),
      order_number VARCHAR(100),
      status VARCHAR(50) DEFAULT 'Pending',
      reward_amount NUMERIC(10, 2) DEFAULT 30.00,
      date_time VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS wallet_transactions (
      id VARCHAR(100) PRIMARY KEY,
      user_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(10, 2) NOT NULL,
      type VARCHAR(50) NOT NULL,
      description TEXT,
      date_time VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS notifications (
      id VARCHAR(100) PRIMARY KEY,
      target_role VARCHAR(50) NOT NULL DEFAULT 'CUSTOMER',
      customer_id VARCHAR(100),
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      type VARCHAR(50) DEFAULT 'INFO',
      is_read BOOLEAN DEFAULT false,
      date_time VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS support_tickets (
      id VARCHAR(100) PRIMARY KEY,
      ticket_number VARCHAR(100) NOT NULL UNIQUE,
      user_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
      customer_id VARCHAR(100),
      customer_name VARCHAR(255),
      customer_mobile VARCHAR(50),
      subject VARCHAR(255) NOT NULL,
      category VARCHAR(100) DEFAULT 'General Inquiry',
      priority VARCHAR(50) DEFAULT 'Medium',
      status VARCHAR(50) DEFAULT 'Open',
      order_number VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS support_messages (
      id VARCHAR(100) PRIMARY KEY,
      ticket_id VARCHAR(100) REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_role VARCHAR(50) NOT NULL,
      sender_name VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      date_time VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS reviews (
      id VARCHAR(100) PRIMARY KEY,
      customer_id VARCHAR(100) REFERENCES users(id) ON DELETE SET NULL,
      customer_name VARCHAR(255) NOT NULL,
      rating INT NOT NULL DEFAULT 5,
      comment TEXT,
      is_visible BOOLEAN DEFAULT true,
      owner_reply TEXT,
      reply_date_time VARCHAR(100),
      date_time VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS tokens (
      token VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(50) NOT NULL,
      created_at BIGINT NOT NULL,
      last_activity BIGINT
    );`,

    `CREATE TABLE IF NOT EXISTS password_resets (
      user_id VARCHAR(100) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      otp VARCHAR(20) NOT NULL,
      mobile VARCHAR(50) NOT NULL,
      created_at BIGINT NOT NULL
    );`,

    `CREATE TABLE IF NOT EXISTS counters (
      name VARCHAR(50) PRIMARY KEY,
      current_value INT NOT NULL
    );`
  ];

  for (let q of schemaQueries) {
    try {
      await query(q);
    } catch (err) {
      console.error('Error creating database table:', err);
    }
  }

  // Initialize order_counter and ticket_counter if missing
  try {
    const orderCounterRes = await query(`SELECT current_value FROM counters WHERE name = 'order_counter';`);
    if (!orderCounterRes.rows || orderCounterRes.rows.length === 0) {
      await query(`INSERT INTO counters (name, current_value) VALUES ('order_counter', 1001);`);
    }
    const ticketCounterRes = await query(`SELECT current_value FROM counters WHERE name = 'ticket_counter';`);
    if (!ticketCounterRes.rows || ticketCounterRes.rows.length === 0) {
      await query(`INSERT INTO counters (name, current_value) VALUES ('ticket_counter', 1001);`);
    }
    // PostgreSQL/SQLite schema column migration adjustments
    if (usePg) {
      try {
        await query(`ALTER TABLE settings ALTER COLUMN upi_qr_code TYPE TEXT;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS utr_number VARCHAR(100);`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_screenshot TEXT;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS screenshot_url TEXT;`);
        await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_id VARCHAR(100);`);
        await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS utr_number VARCHAR(100);`);
        await query(`ALTER TABLE payments ALTER COLUMN screenshot_url TYPE TEXT;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_by VARCHAR(100);`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);
        await query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_activity BIGINT;`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS order_id VARCHAR(100);`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_before NUMERIC(10, 2);`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_after NUMERIC(10, 2);`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'SUCCESS';`);
      } catch (aErr) {
        console.warn('PostgreSQL DDL Notice:', aErr.message);
      }
    } else {
      const safeAlter = async (sql) => { try { await query(sql); } catch(e) {} };
      await safeAlter(`ALTER TABLE orders ADD COLUMN utr_number TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN payment_screenshot TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN screenshot_url TEXT;`);
      await safeAlter(`ALTER TABLE payments ADD COLUMN order_id TEXT;`);
      await safeAlter(`ALTER TABLE payments ADD COLUMN utr_number TEXT;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active';`);
      await safeAlter(`ALTER TABLE users ADD COLUMN blocked_at TEXT;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN blocked_by TEXT;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN deleted_at TEXT;`);
      await safeAlter(`ALTER TABLE tokens ADD COLUMN last_activity INTEGER;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN order_id TEXT;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN balance_before REAL;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN balance_after REAL;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN status TEXT DEFAULT 'SUCCESS';`);
    }
    await query(`UPDATE settings SET hotel_name = 'Sri Lakshmi Annapurna Tiffin Center', upi_name = 'Sri Lakshmi Annapurna Tiffin Center' WHERE id = 1;`);
  } catch (cErr) {
    console.error('Error initializing counters:', cErr);
  }

  console.log('PostgreSQL database schemas successfully initialized.');

  // Auto-seed from seed_data.json if database is fresh
  try {
    const tiffinCountRes = await query(`SELECT COUNT(*) FROM tiffins;`);
    const count = Number(tiffinCountRes.rows[0]?.count || 0);
    if (count === 0 && !autoSeedInProgress) {
      console.log('Database empty on startup — running automated seed migration from seed_data.json...');
      autoSeedInProgress = true;
      try {
        const migrateModule = require('./migrate_to_postgres');
        if (typeof migrateModule === 'function') {
          await migrateModule();
        }
      } catch (seedErr) {
        console.error('Auto-seed migration error:', seedErr.message);
      } finally {
        autoSeedInProgress = false;
      }
    }
  } catch (seedErr) {
    console.error('Auto-seed check notice:', seedErr.message);
  }
}

// Atomic Sequence Counter Helper for Globally Unique Order IDs
async function getNextCounter(counterName) {
  try {
    await query(`INSERT INTO counters (name, current_value) VALUES ($1, 1001) ON CONFLICT (name) DO NOTHING;`, [counterName]);
    if (usePg) {
      const updateRes = await query(
        `UPDATE counters SET current_value = current_value + 1 WHERE name = $1 RETURNING current_value;`,
        [counterName]
      );
      if (updateRes.rows && updateRes.rows.length > 0) {
        return Number(updateRes.rows[0].current_value);
      }
    } else {
      await query(`UPDATE counters SET current_value = current_value + 1 WHERE name = $1;`, [counterName]);
      const selectRes = await query(`SELECT current_value FROM counters WHERE name = $1;`, [counterName]);
      if (selectRes.rows && selectRes.rows.length > 0) {
        return Number(selectRes.rows[0].current_value);
      }
    }
  } catch (err) {
    console.error(`Error in getNextCounter for ${counterName}:`, err.message);
  }
  return Math.floor(100000 + Math.random() * 900000);
}

// Atomic Transaction Execution Helper for Server-Side Safety
async function executeTransaction(fn) {
  if (usePg && pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txExecutor = {
        query: async (text, params = []) => {
          return await client.query(text, params);
        }
      };
      const result = await fn(txExecutor);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else if (sqliteDb) {
    return new Promise((resolve, reject) => {
      sqliteDb.serialize(async () => {
        try {
          await query('BEGIN TRANSACTION;');
          const txExecutor = {
            query: async (text, params = []) => {
              return await query(text, params);
            }
          };
          const result = await fn(txExecutor);
          await query('COMMIT;');
          resolve(result);
        } catch (err) {
          try { await query('ROLLBACK;'); } catch (rErr) {}
          reject(err);
        }
      });
    });
  } else {
    throw new Error('Database connection not initialized.');
  }
}

module.exports = {
  query,
  initDatabase,
  getNextCounter,
  executeTransaction,
  usePg: () => usePg
};

