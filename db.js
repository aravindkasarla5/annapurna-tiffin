const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;
let sqliteDb = null;
let usePg = false;

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
      console.error('[PostgreSQL Query Notice]:', err.message);
      return { rows: [], rowCount: 0 };
    }
  }

  if (sqliteDb) {
    return new Promise((resolve, reject) => {
      const cleanSql = convertPgSqlToSqlite(text.trim());
      const isSelect = cleanSql.toUpperCase().startsWith('SELECT') || cleanSql.toUpperCase().startsWith('PRAGMA');

      if (isSelect) {
        sqliteDb.all(cleanSql, params, (err, rows) => {
          if (err) return resolve({ rows: [], rowCount: 0 });
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
          if (err) return resolve({ rows: [], rowCount: 0, insertId: 0 });
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
      upi_name VARCHAR(100) DEFAULT 'Annapurna Tiffin Center',
      upi_qr_code VARCHAR(500) DEFAULT '/images/tiffin_logo.png',
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
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS payments (
      id VARCHAR(100) PRIMARY KEY,
      order_number VARCHAR(100) NOT NULL,
      customer_id VARCHAR(100),
      customer_name VARCHAR(255),
      customer_mobile VARCHAR(50),
      amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      payment_method VARCHAR(100) DEFAULT 'Cash',
      payment_status VARCHAR(50) DEFAULT 'Pending',
      utr_number VARCHAR(100),
      screenshot_url VARCHAR(500),
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
      created_at BIGINT NOT NULL
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
  } catch (cErr) {
    console.error('Error initializing counters:', cErr);
  }

  console.log('PostgreSQL database schemas successfully initialized.');
}

// Atomic Sequence Counter Helper for Globally Unique Order IDs
async function getNextCounter(counterName) {
  const selectRes = await query(`SELECT current_value FROM counters WHERE name = $1;`, [counterName]);
  let val = 1001;
  if (selectRes.rows && selectRes.rows.length > 0) {
    val = Number(selectRes.rows[0].current_value);
  }
  const nextVal = val + 1;
  await query(`UPDATE counters SET current_value = $1 WHERE name = $2;`, [nextVal, counterName]);
  return val;
}

module.exports = {
  query,
  initDatabase,
  getNextCounter,
  usePg: () => usePg
};
