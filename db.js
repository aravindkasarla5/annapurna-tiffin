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
function convertPgSqlToSqlite(sql, params = []) {
  let converted = sql;
  let expandedParams = [];

  const hasPgParams = /\$\d+/.test(sql);
  if (hasPgParams) {
    converted = converted.replace(/\$(\d+)/g, (match, num) => {
      const idx = parseInt(num, 10) - 1;
      if (idx >= 0 && idx < params.length) {
        expandedParams.push(params[idx]);
      } else {
        expandedParams.push(null);
      }
      return '?';
    });
  } else {
    expandedParams = [...params];
  }

  converted = converted.replace(/::[a-z0-9_]+/gi, '');
  converted = converted.replace(/TIMESTAMPTZ/gi, 'TEXT');
  converted = converted.replace(/JSONB/gi, 'TEXT');
  converted = converted.replace(/BIGINT/gi, 'INTEGER');
  
  if (converted.toUpperCase().includes('ON CONFLICT') && converted.toUpperCase().includes('DO UPDATE')) {
    converted = converted.replace(/INSERT INTO/gi, 'INSERT OR REPLACE INTO');
    converted = converted.replace(/ON CONFLICT[\s\S]*/gi, '');
  } else if (converted.toUpperCase().includes('ON CONFLICT') && converted.toUpperCase().includes('DO NOTHING')) {
    converted = converted.replace(/INSERT INTO/gi, 'INSERT OR IGNORE INTO');
    converted = converted.replace(/ON CONFLICT[\s\S]*/gi, '');
  }
  return { cleanSql: converted.trim(), expandedParams };
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
      const { cleanSql, expandedParams } = convertPgSqlToSqlite(text.trim(), params);
      const isSelect = cleanSql.toUpperCase().startsWith('SELECT') || cleanSql.toUpperCase().startsWith('PRAGMA');

      if (isSelect) {
        sqliteDb.all(cleanSql, expandedParams, (err, rows) => {
          if (err) {
            console.error('[SQLite Query Error]:', err.message, 'SQL:', cleanSql);
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
        sqliteDb.run(cleanSql, expandedParams, function(err) {
          if (err) {
            console.error('[SQLite Query Error]:', err.message, 'SQL:', cleanSql);
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
      customer_wallet_balance NUMERIC(10, 2) DEFAULT 0.00,
      layout_balance NUMERIC(10, 2) DEFAULT 0.00,
      loyalty_points INT DEFAULT 0,
      cart JSONB DEFAULT '[]'::jsonb,
      favorites JSONB DEFAULT '[]'::jsonb,
      show_on_leaderboard BOOLEAN DEFAULT true,
      sound_enabled BOOLEAN DEFAULT true,
      status VARCHAR(50) DEFAULT 'active',
      blocked_at TIMESTAMPTZ,
      blocked_by VARCHAR(100),
      deleted_at TIMESTAMPTZ,
      profile_photo TEXT,
      password_change_required BOOLEAN DEFAULT false,
      temp_password_expires_at BIGINT,
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
      upi_id VARCHAR(100) DEFAULT '9392974900@ybl',
      upi_name VARCHAR(100) DEFAULT 'Sri Lakshmi Annapurna Tiffin Center',
      upi_qr_code TEXT DEFAULT '/images/tiffin_logo.png',
      is_open BOOLEAN DEFAULT true,
      is_qr_pay_enabled BOOLEAN DEFAULT true,
      is_phonepe_enabled BOOLEAN DEFAULT true,
      description TEXT,
      bank_name VARCHAR(255) DEFAULT '',
      bank_account VARCHAR(100) DEFAULT '',
      bank_ifsc VARCHAR(50) DEFAULT '',
      account_holder VARCHAR(255) DEFAULT '',
      referral JSONB DEFAULT '{"enabled": true, "referrer_reward": 30, "new_customer_discount": 30, "min_order_value": 150, "monthly_limit": 500, "milestones": [{"count": 1, "bonus": 0}, {"count": 5, "bonus": 100}, {"count": 10, "bonus": 250}]}'::jsonb,
      upi_qr_updated_at BIGINT
    );`,

    `CREATE TABLE IF NOT EXISTS tiffins (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      price NUMERIC(10, 2) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'Breakfast',
      image TEXT,
      is_available BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(100) PRIMARY KEY,
      order_number VARCHAR(100) NOT NULL UNIQUE,
      customer_id VARCHAR(100) REFERENCES users(id) ON DELETE SET NULL,
      customer_name VARCHAR(255) NOT NULL,
      customer_mobile VARCHAR(50) NOT NULL,
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
      rejection_reason TEXT,
      cancelled_at TIMESTAMPTZ,
      utr_number VARCHAR(100),
      payment_screenshot TEXT,
      screenshot_url TEXT,
      pickup_pin VARCHAR(10),
      pickup_pin_verified BOOLEAN DEFAULT false,
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
      order_id VARCHAR(100),
      reward_amount NUMERIC(10, 2) DEFAULT 30.00,
      status VARCHAR(50) DEFAULT 'Pending',
      date_time VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS wallet_transactions (
      id VARCHAR(100) PRIMARY KEY,
      user_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(10, 2) NOT NULL,
      type VARCHAR(20) NOT NULL,
      description TEXT,
      date_time VARCHAR(100),
      order_id VARCHAR(100),
      balance_before NUMERIC(10, 2) DEFAULT 0.00,
      balance_after NUMERIC(10, 2) DEFAULT 0.00,
      status VARCHAR(50) DEFAULT 'SUCCESS',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS notifications (
      id VARCHAR(100) PRIMARY KEY,
      target_role VARCHAR(50) NOT NULL DEFAULT 'CUSTOMER',
      customer_id VARCHAR(100),
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      type VARCHAR(50) DEFAULT 'INFO',
      priority VARCHAR(50) DEFAULT 'NORMAL',
      action_url VARCHAR(255),
      related_order_id VARCHAR(100),
      is_read BOOLEAN DEFAULT false,
      date_time VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id VARCHAR(100) PRIMARY KEY,
      user_id VARCHAR(100) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'CUSTOMER',
      subscription JSONB NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
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
      order_number VARCHAR(100),
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
      created_at BIGINT NOT NULL,
      attempts INT DEFAULT 0,
      is_verified BOOLEAN DEFAULT false
    );`,

    `CREATE TABLE IF NOT EXISTS counters (
      name VARCHAR(50) PRIMARY KEY,
      current_value INT NOT NULL
    );`,

    `CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id VARCHAR(100) PRIMARY KEY,
      user_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
      order_id VARCHAR(100),
      order_number VARCHAR(100),
      type VARCHAR(50) NOT NULL,
      points INT NOT NULL,
      reward_amount NUMERIC(10, 2) DEFAULT 0.00,
      description TEXT,
      balance_after INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS loyalty_redemptions (
      id VARCHAR(100) PRIMARY KEY,
      user_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
      points_redeemed INT NOT NULL,
      reward_amount NUMERIC(10, 2) NOT NULL,
      status VARCHAR(50) DEFAULT 'ACTIVE',
      used_order_id VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS loyalty_milestones (
      id VARCHAR(100) PRIMARY KEY,
      user_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
      milestone_points INT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT unique_user_milestone UNIQUE (user_id, milestone_points)
    );`,

    `CREATE TABLE IF NOT EXISTS idempotency_keys (
      id VARCHAR(100) PRIMARY KEY,
      key VARCHAR(255) NOT NULL,
      user_id VARCHAR(100),
      endpoint VARCHAR(255) NOT NULL,
      request_hash VARCHAR(255),
      status VARCHAR(50) DEFAULT 'PROCESSING',
      response_status INT,
      response_body TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS food_member_applications (
      id VARCHAR(100) PRIMARY KEY,
      customer_id VARCHAR(100) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_name VARCHAR(255) NOT NULL,
      customer_mobile VARCHAR(50) NOT NULL,
      fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 10.00,
      payment_method VARCHAR(100) DEFAULT 'UPI',
      payment_status VARCHAR(50) DEFAULT 'VERIFIED',
      payment_reference VARCHAR(100),
      screenshot_url TEXT,
      status VARCHAR(50) DEFAULT 'PENDING_APPROVAL',
      rejection_reason TEXT,
      refund_status VARCHAR(50) DEFAULT 'NOT_APPLICABLE',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS food_member_cards (
      id VARCHAR(100) PRIMARY KEY,
      member_id VARCHAR(100) NOT NULL UNIQUE,
      customer_id VARCHAR(100) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_name VARCHAR(255) NOT NULL,
      customer_mobile VARCHAR(50) NOT NULL,
      application_id VARCHAR(100) REFERENCES food_member_applications(id) ON DELETE SET NULL,
      status VARCHAR(50) DEFAULT 'ACTIVE',
      valid_from TIMESTAMPTZ NOT NULL,
      valid_until TIMESTAMPTZ NOT NULL,
      discount_amount NUMERIC(10, 2) DEFAULT 5.00,
      express_delivery_eligible BOOLEAN DEFAULT true,
      qr_verification_code VARCHAR(255) NOT NULL UNIQUE,
      reminded_7d_at TIMESTAMPTZ,
      reminded_3d_at TIMESTAMPTZ,
      reminded_1d_at TIMESTAMPTZ,
      reminded_expired_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS member_card_audit_logs (
      id VARCHAR(100) PRIMARY KEY,
      customer_id VARCHAR(100),
      member_id VARCHAR(100),
      action VARCHAR(100) NOT NULL,
      actor_role VARCHAR(50),
      actor_id VARCHAR(100),
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS menu_polls (
      id VARCHAR(100) PRIMARY KEY,
      question VARCHAR(255) NOT NULL DEFAULT 'Choose Tomorrow''s Special',
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'SCHEDULED',
      winner_food_id VARCHAR(100),
      winner_selection_type VARCHAR(50) DEFAULT 'AUTOMATIC',
      tomorrow_special_published BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS menu_poll_options (
      id VARCHAR(100) PRIMARY KEY,
      poll_id VARCHAR(100) NOT NULL REFERENCES menu_polls(id) ON DELETE CASCADE,
      food_id VARCHAR(100) NOT NULL REFERENCES tiffins(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS menu_poll_votes (
      id VARCHAR(100) PRIMARY KEY,
      poll_id VARCHAR(100) NOT NULL REFERENCES menu_polls(id) ON DELETE CASCADE,
      option_id VARCHAR(100) NOT NULL REFERENCES menu_poll_options(id) ON DELETE CASCADE,
      customer_id VARCHAR(100) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT unique_customer_poll_vote UNIQUE (poll_id, customer_id)
    );`,

    `CREATE TABLE IF NOT EXISTS security_events (
      id VARCHAR(100) PRIMARY KEY,
      event_type VARCHAR(100) NOT NULL,
      risk_level VARCHAR(20) NOT NULL DEFAULT 'LOW',
      customer_id VARCHAR(100) REFERENCES users(id) ON DELETE SET NULL,
      order_id VARCHAR(100),
      payment_id VARCHAR(100),
      details TEXT,
      status VARCHAR(50) NOT NULL DEFAULT 'NEW',
      internal_note TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS owner_audit_logs (
      id VARCHAR(100) PRIMARY KEY,
      actor_id VARCHAR(100),
      actor_name VARCHAR(255),
      action VARCHAR(100) NOT NULL,
      resource_type VARCHAR(100),
      resource_id VARCHAR(100),
      details TEXT,
      ip_address VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS refunds (
      id VARCHAR(100) PRIMARY KEY,
      refund_reference VARCHAR(100) NOT NULL UNIQUE,
      order_id VARCHAR(100) NOT NULL,
      order_number VARCHAR(100) NOT NULL,
      payment_id VARCHAR(100),
      customer_id VARCHAR(100) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_name VARCHAR(255),
      customer_mobile VARCHAR(50),
      original_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      refund_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      non_refundable_amount NUMERIC(10, 2) DEFAULT 0.00,
      refund_type VARCHAR(50) DEFAULT 'FULL',
      reason TEXT NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'REFUND_REQUESTED',
      payment_method VARCHAR(100) DEFAULT 'UPI',
      payment_reference VARCHAR(100),
      expected_completion_date TIMESTAMPTZ,
      last_updated_message TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ
    );`,

    `CREATE TABLE IF NOT EXISTS refund_events (
      id VARCHAR(100) PRIMARY KEY,
      refund_id VARCHAR(100) NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
      event_type VARCHAR(100) NOT NULL,
      previous_status VARCHAR(50),
      new_status VARCHAR(50) NOT NULL,
      message TEXT,
      amount NUMERIC(10, 2),
      actor_type VARCHAR(50) NOT NULL DEFAULT 'SYSTEM',
      actor_id VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS add_ons (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      description TEXT,
      available BOOLEAN DEFAULT true,
      enabled BOOLEAN DEFAULT true,
      category VARCHAR(100) DEFAULT 'Extras',
      display_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS order_add_ons (
      id VARCHAR(100) PRIMARY KEY,
      order_id VARCHAR(100) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      add_on_id VARCHAR(100),
      add_on_name VARCHAR(255) NOT NULL,
      quantity INT NOT NULL DEFAULT 1,
      unit_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      subtotal NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS smart_cart_offers (
      id VARCHAR(100) PRIMARY KEY,
      offer_name VARCHAR(255) NOT NULL,
      min_quantity INT NOT NULL DEFAULT 2,
      eligible_item_name VARCHAR(255) NOT NULL,
      discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 10.00,
      status VARCHAR(50) DEFAULT 'Active',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS smart_cart_analytics (
      id VARCHAR(100) PRIMARY KEY,
      event_type VARCHAR(50) NOT NULL,
      offer_id VARCHAR(100),
      customer_id VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS ai_assistant_analytics (
      id VARCHAR(100) PRIMARY KEY,
      query_text TEXT,
      budget NUMERIC(10, 2),
      people_count INT,
      selected_option_id VARCHAR(100),
      customer_id VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS subscription_plans (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      meal_type VARCHAR(100) NOT NULL DEFAULT 'Breakfast',
      duration_days INT NOT NULL,
      included_meals INT NOT NULL,
      price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      description TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS subscriptions (
      id VARCHAR(100) PRIMARY KEY,
      subscription_id VARCHAR(100) NOT NULL UNIQUE,
      customer_id VARCHAR(100) REFERENCES users(id) ON DELETE SET NULL,
      customer_name VARCHAR(255),
      customer_mobile VARCHAR(50),
      plan_id VARCHAR(100) REFERENCES subscription_plans(id) ON DELETE SET NULL,
      plan_name VARCHAR(255) NOT NULL,
      meal_type VARCHAR(100) DEFAULT 'Breakfast',
      duration_days INT NOT NULL,
      total_meals INT NOT NULL,
      used_meals INT NOT NULL DEFAULT 0,
      purchase_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      start_date TIMESTAMPTZ,
      expiry_date TIMESTAMPTZ,
      payment_reference VARCHAR(100),
      payment_method VARCHAR(100) DEFAULT 'ONLINE',
      utr_number VARCHAR(100),
      payment_screenshot TEXT,
      payment_status VARCHAR(50) DEFAULT 'PENDING',
      status VARCHAR(50) DEFAULT 'PENDING_PAYMENT',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS subscription_meal_passes (
      id VARCHAR(100) PRIMARY KEY,
      pass_id VARCHAR(100) NOT NULL UNIQUE,
      subscription_id VARCHAR(100) NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      customer_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
      meal_number INT NOT NULL,
      secure_token VARCHAR(255) NOT NULL UNIQUE,
      status VARCHAR(50) DEFAULT 'AVAILABLE',
      redeemed_at TIMESTAMPTZ,
      redemption_id VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS subscription_redemptions (
      id VARCHAR(100) PRIMARY KEY,
      redemption_reference VARCHAR(100) NOT NULL UNIQUE,
      meal_pass_id VARCHAR(100) REFERENCES subscription_meal_passes(id) ON DELETE SET NULL,
      subscription_id VARCHAR(100) REFERENCES subscriptions(id) ON DELETE SET NULL,
      customer_id VARCHAR(100) REFERENCES users(id) ON DELETE SET NULL,
      customer_name VARCHAR(255),
      customer_mobile VARCHAR(50),
      plan_name VARCHAR(255),
      meal_number INT,
      redeemed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      redeemed_by VARCHAR(100),
      status VARCHAR(50) DEFAULT 'SUCCESS'
    );`,

    `CREATE TABLE IF NOT EXISTS customer_addresses (
      id VARCHAR(100) PRIMARY KEY,
      customer_id VARCHAR(100) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      address_type VARCHAR(50) NOT NULL DEFAULT 'Home',
      full_name VARCHAR(255) NOT NULL,
      mobile_number VARCHAR(50) NOT NULL,
      address_line1 TEXT NOT NULL,
      address_line2 TEXT,
      area VARCHAR(255) NOT NULL,
      city VARCHAR(255) NOT NULL,
      state VARCHAR(255) NOT NULL,
      pincode VARCHAR(20) NOT NULL,
      landmark TEXT,
      delivery_instructions TEXT,
      is_default BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS delivery_zones (
      id VARCHAR(100) PRIMARY KEY,
      zone_name VARCHAR(255) NOT NULL,
      description TEXT,
      pincodes JSONB NOT NULL DEFAULT '[]'::jsonb,
      delivery_fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
      min_order_amount NUMERIC(10, 2) DEFAULT 0.00,
      max_order_amount NUMERIC(10, 2),
      status VARCHAR(50) DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS wallet_topup_requests (
      id VARCHAR(100) PRIMARY KEY,
      request_id VARCHAR(100) NOT NULL UNIQUE,
      customer_id VARCHAR(100) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_name VARCHAR(255) NOT NULL,
      customer_mobile VARCHAR(50) NOT NULL,
      amount NUMERIC(10, 2) NOT NULL,
      payment_method VARCHAR(100) DEFAULT 'UPI',
      utr_number VARCHAR(100),
      transaction_id VARCHAR(100),
      screenshot_url TEXT,
      status VARCHAR(50) DEFAULT 'PENDING',
      rejection_reason TEXT,
      approved_at TIMESTAMPTZ,
      approved_by VARCHAR(100),
      rejected_at TIMESTAMPTZ,
      rejected_by VARCHAR(100),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`,

    `CREATE TABLE IF NOT EXISTS customer_wallet_transactions (
      id VARCHAR(100) PRIMARY KEY,
      user_id VARCHAR(100) REFERENCES users(id) ON DELETE CASCADE,
      request_id VARCHAR(100),
      order_id VARCHAR(100),
      amount NUMERIC(10, 2) NOT NULL,
      type VARCHAR(50) NOT NULL,
      description TEXT,
      date_time VARCHAR(100),
      balance_before NUMERIC(10, 2) DEFAULT 0.00,
      balance_after NUMERIC(10, 2) DEFAULT 0.00,
      status VARCHAR(50) DEFAULT 'SUCCESS',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`
  ];

  for (let q of schemaQueries) {
    try {
      await query(q);
    } catch (err) {
      console.error('Error creating database table:', err);
    }
  }

  // Initialize unique index for customer menu poll votes & add-on indexes
  try {
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_customer_poll_vote ON menu_poll_votes(poll_id, customer_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sec_events_type_status ON security_events(event_type, status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_sec_events_risk ON security_events(risk_level);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_owner_audit_created ON owner_audit_logs(created_at);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_refunds_order_id ON refunds(order_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_refunds_customer_id ON refunds(customer_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_refund_events_refund_id ON refund_events(refund_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_add_ons_enabled ON add_ons(enabled, available);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_order_add_ons_order ON order_add_ons(order_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_smart_cart_analytics_offer_id ON smart_cart_analytics(offer_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ai_assistant_analytics_created ON ai_assistant_analytics(created_at);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_wallet_req_customer ON wallet_topup_requests(customer_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_wallet_req_status ON wallet_topup_requests(status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_wallet_req_utr ON wallet_topup_requests(utr_number);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cust_wallet_tx_user ON customer_wallet_transactions(user_id);`);
    try { await query(`ALTER TABLE wallet_transactions ADD COLUMN request_id VARCHAR(100);`); } catch (colErr) {}
  } catch (idxErr) {
    console.warn('Index creation notice:', idxErr.message);
  }

  // Seed default Add-ons if empty
  try {
    const checkAddons = await query(`SELECT COUNT(*) as c FROM add_ons;`);
    if (Number(checkAddons.rows[0]?.c || 0) === 0) {
      const nowIso = new Date().toISOString();
      await query(`INSERT INTO add_ons (id, name, price, description, available, enabled, category, display_order, created_at, updated_at) VALUES
        ('addon_1', 'Extra Chutney', 5.00, 'Fresh Coconut & Peanut Chutney', true, true, 'Extras', 1, '${nowIso}', '${nowIso}'),
        ('addon_2', 'Extra Sambar', 10.00, 'Hot Traditional South Indian Sambar', true, true, 'Extras', 2, '${nowIso}', '${nowIso}'),
        ('addon_3', 'Extra Idly', 15.00, 'Steamed Rice Idly (1 pc)', true, true, 'Extras', 3, '${nowIso}', '${nowIso}')
        ON CONFLICT DO NOTHING;`);
      console.log('✓ Default Add-ons seeded successfully!');
    }
  } catch (seedErr) {
    console.warn('Add-ons seeding notice:', seedErr.message);
  }

  // Seed default Smart Cart Offers if empty
  try {
    const checkSmartOffers = await query(`SELECT COUNT(*) as c FROM smart_cart_offers;`);
    if (Number(checkSmartOffers.rows[0]?.c || 0) === 0) {
      const nowIso = new Date().toISOString();
      await query(`INSERT INTO smart_cart_offers (id, offer_name, min_quantity, eligible_item_name, discount_amount, status, created_at, updated_at) VALUES
        ('sco_vada_seed', 'Vada Combo Discount', 2, 'Vada', 10.00, 'Active', '${nowIso}', '${nowIso}'),
        ('sco_idly_seed', 'Idly Savings Combo', 3, 'Idly', 5.00, 'Active', '${nowIso}', '${nowIso}')
        ON CONFLICT DO NOTHING;`);
      console.log('✓ Default Smart Cart Offers seeded successfully!');
    }
  } catch (scoErr) {
    console.warn('Smart Cart Offers seeding notice:', scoErr.message);
  }

  // Initialize order_counter, ticket_counter, and member_counter if missing
  try {
    const orderCounterRes = await query(`SELECT current_value FROM counters WHERE name = 'order_counter';`);
    if (!orderCounterRes.rows || orderCounterRes.rows.length === 0) {
      await query(`INSERT INTO counters (name, current_value) VALUES ('order_counter', 1001);`);
    }
    const ticketCounterRes = await query(`SELECT current_value FROM counters WHERE name = 'ticket_counter';`);
    if (!ticketCounterRes.rows || ticketCounterRes.rows.length === 0) {
      await query(`INSERT INTO counters (name, current_value) VALUES ('ticket_counter', 1001);`);
    }
    const memberCounterRes = await query(`SELECT current_value FROM counters WHERE name = 'member_counter';`);
    if (!memberCounterRes.rows || memberCounterRes.rows.length === 0) {
      await query(`INSERT INTO counters (name, current_value) VALUES ('member_counter', 100001);`);
    }
    const subSeqRes = await query(`SELECT current_value FROM counters WHERE name = 'subscription_seq';`);
    if (!subSeqRes.rows || subSeqRes.rows.length === 0) {
      await query(`INSERT INTO counters (name, current_value) VALUES ('subscription_seq', 1001);`);
    }
    const passSeqRes = await query(`SELECT current_value FROM counters WHERE name = 'mealpass_seq';`);
    if (!passSeqRes.rows || passSeqRes.rows.length === 0) {
      await query(`INSERT INTO counters (name, current_value) VALUES ('mealpass_seq', 1001);`);
    }
    const redSeqRes = await query(`SELECT current_value FROM counters WHERE name = 'redemption_seq';`);
    if (!redSeqRes.rows || redSeqRes.rows.length === 0) {
      await query(`INSERT INTO counters (name, current_value) VALUES ('redemption_seq', 1001);`);
    }

    // Seed default subscription plans if table is empty
    const plansCheck = await query(`SELECT COUNT(*) as cnt FROM subscription_plans;`);
    const planCount = parseInt(plansCheck.rows[0]?.cnt || '0', 10);
    if (planCount === 0) {
      await query(`INSERT INTO subscription_plans (id, name, meal_type, duration_days, included_meals, price, description, is_active) VALUES
        ('plan_7d_breakfast', 'Weekly Breakfast Plan', 'Breakfast', 7, 7, 399.00, '7 Days wholesome fresh South Indian breakfast meal passes.', true),
        ('plan_15d_breakfast', 'Half-Month Breakfast Plan', 'Breakfast', 15, 15, 749.00, '15 Days daily delicious hot tiffin breakfast meal passes.', true),
        ('plan_30d_breakfast', 'Monthly Breakfast Plan', 'Breakfast', 30, 30, 1499.00, '30 Days complete monthly breakfast subscription with maximum savings.', true);
      `);
    }
    // Seed default delivery zones if table is empty
    const zonesCheck = await query(`SELECT COUNT(*) as cnt FROM delivery_zones;`);
    const zoneCount = parseInt(zonesCheck.rows[0]?.cnt || '0', 10);
    if (zoneCount === 0) {
      await query(`INSERT INTO delivery_zones (id, zone_name, description, pincodes, delivery_fee, min_order_amount, status) VALUES
        ('zone_default_a', 'Nandigama Town - Zone A', 'Primary local delivery zone covering central main road and local colonies.', '["521185", "521186"]', 20.00, 100.00, 'ACTIVE'),
        ('zone_default_b', 'Nandigama Outskirts - Zone B', 'Extended delivery zone covering surrounding areas and highway junctions.', '["521187", "521188"]', 35.00, 150.00, 'ACTIVE');
      `);
    }

    // PostgreSQL/SQLite schema column migration adjustments
    if (usePg) {
      try {
        await query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_number VARCHAR(100);`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason TEXT;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address_json TEXT;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10, 2) DEFAULT 0.00;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone_id VARCHAR(100);`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone_name VARCHAR(255);`);
        await query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255) DEFAULT '';`);
        await query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS bank_account VARCHAR(100) DEFAULT '';`);
        await query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(50) DEFAULT '';`);
        await query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS account_holder VARCHAR(255) DEFAULT '';`);
        await query(`ALTER TABLE food_member_cards ADD COLUMN IF NOT EXISTS reminded_7d_at TIMESTAMPTZ;`);
        await query(`ALTER TABLE food_member_cards ADD COLUMN IF NOT EXISTS reminded_3d_at TIMESTAMPTZ;`);
        await query(`ALTER TABLE food_member_cards ADD COLUMN IF NOT EXISTS reminded_1d_at TIMESTAMPTZ;`);
        await query(`ALTER TABLE food_member_cards ADD COLUMN IF NOT EXISTS reminded_expired_at TIMESTAMPTZ;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS utr_number VARCHAR(100);`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_screenshot TEXT;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS screenshot_url TEXT;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_pin VARCHAR(10);`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_pin_verified BOOLEAN DEFAULT false;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_discount NUMERIC(10, 2) DEFAULT 0.00;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS food_member_discount NUMERIC(10, 2) DEFAULT 0.00;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_express_delivery BOOLEAN DEFAULT false;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_premium_member BOOLEAN DEFAULT false;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS add_ons JSONB DEFAULT '[]'::jsonb;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS preparation_minutes INT DEFAULT 15;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_ready_at TIMESTAMPTZ;`);
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_card_per_customer ON food_member_cards(customer_id) WHERE status = 'ACTIVE';`);
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_pending_app_per_customer ON food_member_applications(customer_id) WHERE status = 'PENDING_APPROVAL';`);
        await query(`CREATE INDEX IF NOT EXISTS idx_member_app_pay_ref ON food_member_applications(payment_reference);`);
        await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_id VARCHAR(100);`);
        await query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS utr_number VARCHAR(100);`);
        await query(`ALTER TABLE payments ALTER COLUMN screenshot_url TYPE TEXT;`);
        await query(`ALTER TABLE tiffins ALTER COLUMN image TYPE TEXT;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_by VARCHAR(100);`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_change_required BOOLEAN DEFAULT false;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS temp_password_expires_at BIGINT;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS loyalty_points INT DEFAULT 0;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS loyalty_reward_balance NUMERIC(10, 2) DEFAULT 0.00;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_wallet_balance NUMERIC(10, 2) DEFAULT 0.00;`);
        await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS layout_balance NUMERIC(10, 2) DEFAULT 0.00;`);
        await query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_activity BIGINT;`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS order_id VARCHAR(100);`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_before NUMERIC(10, 2);`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_after NUMERIC(10, 2);`);
        await query(`ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;`);
        await query(`ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'SUCCESS';`);
        await query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100) DEFAULT 'ONLINE';`);
        await query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS utr_number VARCHAR(100);`);
        await query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_screenshot TEXT;`);
        await query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'NORMAL';`);
        await query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_url VARCHAR(255);`);
        await query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS related_order_id VARCHAR(100);`);
      } catch (aErr) {
        console.warn('PostgreSQL DDL Notice:', aErr.message);
      }
    } else {
      const safeAlter = async (sql) => { try { await query(sql); } catch(e) {} };
      await safeAlter(`ALTER TABLE notifications ADD COLUMN priority TEXT DEFAULT 'NORMAL';`);
      await safeAlter(`ALTER TABLE notifications ADD COLUMN action_url TEXT;`);
      await safeAlter(`ALTER TABLE notifications ADD COLUMN related_order_id TEXT;`);
      await safeAlter(`ALTER TABLE subscriptions ADD COLUMN payment_method TEXT DEFAULT 'ONLINE';`);
      await safeAlter(`ALTER TABLE subscriptions ADD COLUMN utr_number TEXT;`);
      await safeAlter(`ALTER TABLE subscriptions ADD COLUMN payment_screenshot TEXT;`);
      await safeAlter(`ALTER TABLE reviews ADD COLUMN order_number TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN cancellation_reason TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN rejection_reason TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN cancelled_at TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN delivery_address_json TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN delivery_fee NUMERIC(10, 2) DEFAULT 0.00;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN delivery_zone_id TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN delivery_zone_name TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN utr_number TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN payment_screenshot TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN screenshot_url TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN pickup_pin TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN pickup_pin_verified INTEGER DEFAULT 0;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN loyalty_discount NUMERIC(10, 2) DEFAULT 0.00;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN food_member_discount NUMERIC(10, 2) DEFAULT 0.00;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN is_express_delivery INTEGER DEFAULT 0;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN is_premium_member INTEGER DEFAULT 0;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN add_ons TEXT DEFAULT '[]';`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN preparation_minutes INTEGER DEFAULT 15;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN estimated_ready_at TEXT;`);
      await safeAlter(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_card_per_customer ON food_member_cards(customer_id) WHERE status = 'ACTIVE';`);
      await safeAlter(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_pending_app_per_customer ON food_member_applications(customer_id) WHERE status = 'PENDING_APPROVAL';`);
      await safeAlter(`CREATE INDEX IF NOT EXISTS idx_member_app_pay_ref ON food_member_applications(payment_reference);`);
      await safeAlter(`ALTER TABLE payments ADD COLUMN order_id TEXT;`);
      await safeAlter(`ALTER TABLE payments ADD COLUMN utr_number TEXT;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active';`);
      await safeAlter(`ALTER TABLE users ADD COLUMN blocked_at TEXT;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN blocked_by TEXT;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN deleted_at TEXT;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN profile_photo TEXT;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN password_change_required INTEGER DEFAULT 0;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN temp_password_expires_at INTEGER;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN loyalty_points INTEGER DEFAULT 0;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN loyalty_reward_balance NUMERIC(10, 2) DEFAULT 0.00;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN customer_wallet_balance NUMERIC(10, 2) DEFAULT 0.00;`);
      await safeAlter(`ALTER TABLE users ADD COLUMN layout_balance NUMERIC(10, 2) DEFAULT 0.00;`);
      await safeAlter(`ALTER TABLE tokens ADD COLUMN last_activity INTEGER;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN order_id TEXT;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN balance_before REAL;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN balance_after REAL;`);
      await safeAlter(`ALTER TABLE password_resets ADD COLUMN attempts INTEGER DEFAULT 0;`);
      await safeAlter(`ALTER TABLE password_resets ADD COLUMN is_verified INTEGER DEFAULT 0;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN status TEXT DEFAULT 'SUCCESS';`);
      await safeAlter(`ALTER TABLE food_member_cards ADD COLUMN reminded_7d_at TEXT;`);
      await safeAlter(`ALTER TABLE food_member_cards ADD COLUMN reminded_3d_at TEXT;`);
      await safeAlter(`ALTER TABLE food_member_cards ADD COLUMN reminded_1d_at TEXT;`);
      await safeAlter(`ALTER TABLE food_member_cards ADD COLUMN reminded_expired_at TEXT;`);
    }
  } catch (cErr) {
    console.error('Error initializing counters:', cErr);
  }

  // Safely enforce unique constraints for users table (mobile & email) without data loss
  try {
    const mobileDupesRes = await query(`SELECT mobile, COUNT(*) as c FROM users GROUP BY mobile HAVING COUNT(*) > 1;`);
    const emailDupesRes = await query(`SELECT LOWER(TRIM(email)) as email, COUNT(*) as c FROM users WHERE email IS NOT NULL AND TRIM(email) != '' GROUP BY LOWER(TRIM(email)) HAVING COUNT(*) > 1;`);

    if (mobileDupesRes.rows && mobileDupesRes.rows.length > 0) {
      console.warn('⚠️ Duplicate mobile numbers detected in users table — skipping unique mobile constraint creation to prevent data loss:', mobileDupesRes.rows);
    } else {
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile);`);
    }

    if (emailDupesRes.rows && emailDupesRes.rows.length > 0) {
      console.warn('⚠️ Duplicate email addresses detected in users table — skipping unique email constraint creation to prevent data loss:', emailDupesRes.rows);
    } else {
      if (usePg) {
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(LOWER(email)) WHERE email IS NOT NULL AND TRIM(email) != '';`);
      } else {
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email COLLATE NOCASE) WHERE email IS NOT NULL AND TRIM(email) != '';`);
      }
    }
  } catch (idxErr) {
    console.warn('Notice regarding unique index creation on users table:', idxErr.message);
  }

  console.log('PostgreSQL database schemas successfully initialized.');

  // Auto-seed from seed_data.json if database is fresh
  if (!autoSeedInProgress) {
    autoSeedInProgress = true;
    try {
      const tiffinCountRes = await query(`SELECT COUNT(*) as count FROM tiffins;`);
      const count = Number(tiffinCountRes.rows[0]?.count || tiffinCountRes.rows[0]?.['COUNT(*)'] || 0);
      if (count === 0) {
        console.log('Database empty on startup — running automated seed migration from seed_data.json...');
        try {
          const migrateModule = require('./migrate_to_postgres');
          if (typeof migrateModule === 'function') {
            await migrateModule();
          }
        } catch (seedErr) {
          console.error('Auto-seed migration error:', seedErr.message);
        }
      }
    } catch (seedErr) {
      console.error('Auto-seed check notice:', seedErr.message);
    } finally {
      autoSeedInProgress = false;
    }
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

// --- Add-ons Management Helper Methods ---
async function getAllAddons(includeDisabled = false) {
  const sql = includeDisabled 
    ? `SELECT * FROM add_ons ORDER BY display_order ASC, created_at DESC;`
    : `SELECT * FROM add_ons WHERE enabled = true AND available = true ORDER BY display_order ASC, created_at DESC;`;
  const res = await query(sql);
  return res.rows || [];
}

async function getAddonById(id) {
  const res = await query(`SELECT * FROM add_ons WHERE id = $1;`, [id]);
  return res.rows[0] || null;
}

async function createAddon({ name, price, description = '', available = true, enabled = true, category = 'Extras' }) {
  const addonId = `ao_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const sql = `
    INSERT INTO add_ons (id, name, price, description, available, enabled, category)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *;
  `;
  const params = [addonId, name, Number(price), description, Boolean(available), Boolean(enabled), category];
  const res = await query(sql, params);
  if (res.rows && res.rows.length > 0) return res.rows[0];
  return getAddonById(addonId);
}

async function updateAddon(id, data) {
  const existing = await getAddonById(id);
  if (!existing) return null;

  const name = data.name !== undefined ? data.name : existing.name;
  const price = data.price !== undefined ? Number(data.price) : existing.price;
  const description = data.description !== undefined ? data.description : existing.description;
  const available = data.available !== undefined ? Boolean(data.available) : existing.available;
  const enabled = data.enabled !== undefined ? Boolean(data.enabled) : existing.enabled;

  const sql = `
    UPDATE add_ons 
    SET name = $1, price = $2, description = $3, available = $4, enabled = $5, updated_at = CURRENT_TIMESTAMP
    WHERE id = $6
    RETURNING *;
  `;
  const res = await query(sql, [name, price, description, available, enabled, id]);
  if (res.rows && res.rows.length > 0) return res.rows[0];
  return getAddonById(id);
}

async function deleteAddon(id) {
  const res = await query(`DELETE FROM add_ons WHERE id = $1;`, [id]);
  return res.rowCount > 0;
}

async function getAddonAnalytics() {
  const sql = `
    SELECT 
      ao.id,
      ao.name,
      COUNT(oao.id) as total_orders,
      COALESCE(SUM(oao.quantity), 0) as total_quantity,
      COALESCE(SUM(oao.subtotal), 0) as total_revenue
    FROM add_ons ao
    LEFT JOIN order_add_ons oao ON ao.id = oao.add_on_id
    GROUP BY ao.id, ao.name
    ORDER BY total_revenue DESC;
  `;
  const res = await query(sql);
  return res.rows || [];
}

// --- Food Member Card Applications DB Helper Methods ---

async function getFoodMemberStateForCustomer(customerId) {
  const cardRes = await query(
    `SELECT * FROM food_member_cards WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1;`,
    [customerId]
  );
  const appRes = await query(
    `SELECT * FROM food_member_applications WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1;`,
    [customerId]
  );

  const card = cardRes.rows[0] || null;
  const application = appRes.rows[0] || null;

  let status = 'NOT_APPLIED';
  if (card) {
    const now = new Date();
    const until = new Date(card.valid_until);
    if (until < now) {
      status = 'EXPIRED';
    } else {
      status = card.status || 'ACTIVE';
    }
  } else if (application) {
    status = application.status || 'PENDING_APPROVAL';
  }

  return {
    hasCard: Boolean(card && status === 'ACTIVE'),
    card,
    application,
    status
  };
}

async function createFoodMemberApplication({ customer_id, customer_name, customer_mobile, fee_amount = 10.00, payment_method = 'Cash Payment' }) {
  // Clear any existing application records for this customer
  await query(`DELETE FROM food_member_cards WHERE customer_id = $1;`, [customer_id]).catch(() => {});
  await query(`DELETE FROM food_member_applications WHERE customer_id = $1;`, [customer_id]).catch(() => {});

  const appId = `fma_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const nowIso = new Date().toISOString();
  const sql = `
    INSERT INTO food_member_applications 
    (id, customer_id, customer_name, customer_mobile, fee_amount, payment_method, payment_status, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 'PENDING_APPROVAL', $7, $8);
  `;
  const params = [appId, customer_id, customer_name, customer_mobile, Number(fee_amount), payment_method, nowIso, nowIso];
  await query(sql, params);
  const selRes = await query(`SELECT * FROM food_member_applications WHERE id = $1;`, [appId]);
  return selRes.rows[0] || null;
}

async function getOwnerFoodMemberApplications(statusFilter = 'ALL') {
  let where = '';
  let params = [];

  if (statusFilter === 'PENDING_APPROVAL') {
    where = 'WHERE fma.status = $1';
    params.push('PENDING_APPROVAL');
  } else if (statusFilter === 'APPROVED') {
    where = 'WHERE fma.status = $1';
    params.push('APPROVED');
  } else if (statusFilter === 'REJECTED') {
    where = 'WHERE fma.status = $1';
    params.push('REJECTED');
  }

  const sql = `
    SELECT 
      fma.*,
      fmc.member_id,
      fmc.status as card_status,
      fmc.valid_from,
      fmc.valid_until
    FROM food_member_applications fma
    LEFT JOIN food_member_cards fmc ON fma.id = fmc.application_id
    ${where}
    ORDER BY fma.created_at DESC;
  `;

  const listRes = await query(sql, params);
  const apps = listRes.rows || [];

  // Stats counts
  const allRes = await query(`SELECT COUNT(*) as c FROM food_member_applications;`);
  const pendingRes = await query(`SELECT COUNT(*) as c FROM food_member_applications WHERE status = 'PENDING_APPROVAL';`);
  const approvedRes = await query(`SELECT COUNT(*) as c FROM food_member_applications WHERE status = 'APPROVED';`);
  const rejectedRes = await query(`SELECT COUNT(*) as c FROM food_member_applications WHERE status = 'REJECTED';`);

  const counts = {
    all: Number(allRes.rows[0]?.c || allRes.rows[0]?.['COUNT(*)'] || 0),
    pending: Number(pendingRes.rows[0]?.c || pendingRes.rows[0]?.['COUNT(*)'] || 0),
    approved: Number(approvedRes.rows[0]?.c || approvedRes.rows[0]?.['COUNT(*)'] || 0),
    rejected: Number(rejectedRes.rows[0]?.c || rejectedRes.rows[0]?.['COUNT(*)'] || 0)
  };

  return { apps, counts };
}

async function deleteFoodMemberApplication(id) {
  await query(`DELETE FROM food_member_cards WHERE application_id = $1;`, [id]);
  const res = await query(`DELETE FROM food_member_applications WHERE id = $1;`, [id]);
  return (res.rowCount !== undefined ? res.rowCount : 1) >= 0;
}

async function deleteAllFoodMemberApplications() {
  await query(`DELETE FROM food_member_cards;`);
  const res = await query(`DELETE FROM food_member_applications;`);
  return true;
}

async function verifyFoodMemberPayment(id) {
  await query(
    `UPDATE food_member_applications SET payment_status = 'VERIFIED', updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
    [id]
  );
  const selRes = await query(`SELECT * FROM food_member_applications WHERE id = $1;`, [id]);
  return selRes.rows[0] || null;
}

async function rejectFoodMemberPayment(id, reason = '') {
  await query(
    `UPDATE food_member_applications SET payment_status = 'REJECTED', status = 'REJECTED', rejection_reason = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;`,
    [reason, id]
  );
  const selRes = await query(`SELECT * FROM food_member_applications WHERE id = $1;`, [id]);
  return selRes.rows[0] || null;
}

async function approveFoodMemberCard(id) {
  const appRes = await query(`SELECT * FROM food_member_applications WHERE id = $1;`, [id]);
  const application = appRes.rows[0];
  if (!application) return null;

  const now = new Date();
  const validFrom = now.toISOString();
  const validUntil = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

  // Generate unique member ID (PMC1001, PMC1002, ...)
  const countRes = await query(`SELECT COUNT(*) as c FROM food_member_cards;`);
  const num = 1001 + Number(countRes.rows[0]?.c || countRes.rows[0]?.['COUNT(*)'] || 0);
  const memberId = `PMC${num}`;
  const qrCode = `PMC_QR_${memberId}_${Date.now()}`;
  const cardId = `fmc_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

  // 1. Update application status
  await query(
    `UPDATE food_member_applications SET status = 'APPROVED', payment_status = 'VERIFIED', updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
    [id]
  );

  // 2. Insert or update food member card
  const existingCardRes = await query(`SELECT * FROM food_member_cards WHERE application_id = $1;`, [id]);
  if (existingCardRes.rows && existingCardRes.rows.length > 0) {
    await query(
      `UPDATE food_member_cards SET status = 'ACTIVE', valid_from = $1, valid_until = $2, updated_at = CURRENT_TIMESTAMP WHERE application_id = $3;`,
      [validFrom, validUntil, id]
    );
  } else {
    await query(
      `INSERT INTO food_member_cards (id, member_id, customer_id, customer_name, customer_mobile, application_id, status, valid_from, valid_until, discount_amount, express_delivery_eligible, qr_verification_code)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, 5.00, true, $9);`,
      [cardId, memberId, application.customer_id, application.customer_name, application.customer_mobile, id, validFrom, validUntil, qrCode]
    );
  }

  return getFoodMemberStateForCustomer(application.customer_id);
}

async function rejectFoodMemberCard(id, reason = '') {
  await query(
    `UPDATE food_member_applications SET status = 'REJECTED', rejection_reason = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;`,
    [reason, id]
  );
  await query(
    `UPDATE food_member_cards SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE application_id = $1;`,
    [id]
  );
  return true;
}

async function suspendFoodMemberCard(id) {
  await query(
    `UPDATE food_member_cards SET status = 'SUSPENDED', updated_at = CURRENT_TIMESTAMP WHERE application_id = $1 OR id = $1;`,
    [id]
  );
  return true;
}

async function reactivateFoodMemberCard(id) {
  await query(
    `UPDATE food_member_cards SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE application_id = $1 OR id = $1;`,
    [id]
  );
  return true;
}

async function verifyFoodMemberQr(qrCodeInput) {
  if (!qrCodeInput || !qrCodeInput.trim()) {
    return {
      success: false,
      is_valid: false,
      status_code: 'INVALID',
      title: 'Invalid Premium Member Card',
      message: 'QR code could not be verified.'
    };
  }

  const rawInput = qrCodeInput.trim();
  let extractedToken = rawInput;

  // Extract core token if full URL or API path was scanned
  if (rawInput.includes('/verify/')) {
    const parts = rawInput.split('/verify/');
    if (parts[1]) extractedToken = parts[1].trim();
  }

  // Extract pattern if contains QR_FM_, PMC, or FM-
  const qrFmMatch = rawInput.match(/QR_FM_[A-Za-z0-9_]+/i);
  if (qrFmMatch) {
    extractedToken = qrFmMatch[0];
  } else {
    const memberIdMatch = rawInput.match(/(?:FM|PMC)-?\d+/i);
    if (memberIdMatch) {
      extractedToken = memberIdMatch[0].toUpperCase();
    }
  }

  // 1. Search food_member_cards by qr_verification_code, member_id, id, application_id, customer_mobile, or URL substring
  let cardRes = await query(
    `SELECT * FROM food_member_cards 
     WHERE LOWER(qr_verification_code) = LOWER($1) 
        OR LOWER(qr_verification_code) = LOWER($2)
        OR LOWER(member_id) = LOWER($1) 
        OR LOWER(member_id) = LOWER($2)
        OR id = $1 OR id = $2 
        OR application_id = $1 OR application_id = $2 
        OR customer_mobile = $1 OR customer_mobile = $2
        OR $1 LIKE '%' || qr_verification_code || '%'
        OR $2 LIKE '%' || qr_verification_code || '%'
     LIMIT 1;`,
    [rawInput, extractedToken]
  );

  let card = cardRes.rows ? cardRes.rows[0] : null;

  // 2. Fallback: match Member ID digits/pattern (e.g. PMC1001, pmc1001, 1001, PMC-1001, FM-1001)
  if (!card) {
    const digitsMatch = rawInput.match(/\d+/);
    if (digitsMatch) {
      const pmcId = `PMC${digitsMatch[0]}`;
      const fmId = `FM-${String(digitsMatch[0]).padStart(6, '0')}`;
      const fallbackRes = await query(`SELECT * FROM food_member_cards WHERE LOWER(member_id) = LOWER($1) OR LOWER(member_id) = LOWER($2) LIMIT 1;`, [pmcId, fmId]);
      card = fallbackRes.rows ? fallbackRes.rows[0] : null;
    }
  }

  // 3. Fallback: match application_id, customer_mobile, or customer_name in food_member_applications
  if (!card) {
    const appRes = await query(
      `SELECT * FROM food_member_applications 
       WHERE id = $1 OR id = $2 OR customer_mobile = $1 OR customer_mobile = $2 OR LOWER(customer_name) LIKE LOWER($3) 
       ORDER BY created_at DESC LIMIT 1;`,
      [rawInput, extractedToken, `%${extractedToken}%`]
    );
    if (appRes.rows && appRes.rows.length > 0) {
      const appRow = appRes.rows[0];
      let cardByApp = await query(`SELECT * FROM food_member_cards WHERE application_id = $1 OR customer_id = $2 OR customer_mobile = $3 LIMIT 1;`, [appRow.id, appRow.customer_id, appRow.customer_mobile]);
      card = cardByApp.rows ? cardByApp.rows[0] : null;

      // Auto-heal: If application is APPROVED but card row was missing, create card on the fly
      if (!card && appRow.status === 'APPROVED') {
        const now = new Date();
        const validFrom = now.toISOString();
        const validUntil = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
        const countRes = await query(`SELECT COUNT(*) as c FROM food_member_cards;`);
        const num = 1001 + Number(countRes.rows[0]?.c || countRes.rows[0]?.['COUNT(*)'] || 0);
        const memberId = `PMC${num}`;
        const qrCode = `PMC_QR_${memberId}_${Date.now()}`;
        const cardId = `fmc_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

        await query(
          `INSERT INTO food_member_cards (id, member_id, customer_id, customer_name, customer_mobile, application_id, status, valid_from, valid_until, discount_amount, express_delivery_eligible, qr_verification_code)
           VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, 5.00, true, $9);`,
          [cardId, memberId, appRow.customer_id, appRow.customer_name, appRow.customer_mobile, appRow.id, validFrom, validUntil, qrCode]
        );

        const newCardRes = await query(`SELECT * FROM food_member_cards WHERE id = $1;`, [cardId]);
        card = newCardRes.rows ? newCardRes.rows[0] : null;
      }
    }
  }

  // 4. Fallback: match customer account in users table by mobile or name
  if (!card) {
    const userRes = await query(
      `SELECT * FROM users WHERE mobile = $1 OR LOWER(name) LIKE LOWER($2) LIMIT 1;`,
      [cleanInput, `%${cleanInput}%`]
    );
    if (userRes.rows && userRes.rows.length > 0) {
      const u = userRes.rows[0];
      const cardByUser = await query(`SELECT * FROM food_member_cards WHERE customer_id = $1 OR customer_mobile = $2 LIMIT 1;`, [u.id, u.mobile]);
      card = cardByUser.rows ? cardByUser.rows[0] : null;
    }
  }

  if (!card) {
    return {
      success: false,
      is_valid: false,
      status_code: 'NOT_FOUND',
      title: 'Member Card Not Found',
      message: `No Premium Food Member Card record found for "${cleanInput}". Please check the ID or scan the QR code again.`
    };
  }

  // -----------------------------------------------------------------------
  // CRITICAL: STRICT DATE-BASED VALIDITY CALCULATION (STORED STATUS IS IGNORED)
  // -----------------------------------------------------------------------
  const now = new Date();

  // Helper to parse dates safely
  const parseDateObj = (dateVal) => {
    if (!dateVal) return null;
    if (dateVal instanceof Date) return dateVal;
    if (typeof dateVal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateVal.trim())) {
      const [y, m, d] = dateVal.trim().split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    const d = new Date(dateVal);
    return isNaN(d.getTime()) ? null : d;
  };

  const validFrom = parseDateObj(card.valid_from) || now;
  const validUntil = parseDateObj(card.valid_until) || now;

  // Set start of today & validFrom day (00:00:00.000)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const validFromStart = new Date(validFrom.getFullYear(), validFrom.getMonth(), validFrom.getDate(), 0, 0, 0, 0);

  // Set end of today & validUntil day (23:59:59.999) - INCLUSIVE of full Valid Until date!
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const validUntilEnd = new Date(validUntil.getFullYear(), validUntil.getMonth(), validUntil.getDate(), 23, 59, 59, 999);

  const formatDateDDMMYYYY = (d) => {
    const date = new Date(d);
    if (isNaN(date.getTime())) return 'N/A';
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  };

  const formattedValidFrom = formatDateDDMMYYYY(validFrom);
  const formattedValidUntil = formatDateDDMMYYYY(validUntil);
  const formattedToday = formatDateDDMMYYYY(now);

  let status_code = 'ACTIVE';
  let is_valid = true;
  let title = '🟢 MEMBER ACTIVE';
  let message = 'Membership is currently active.';

  if (todayStart < validFromStart) {
    status_code = 'NOT_YET_ACTIVE';
    is_valid = false;
    title = '🟡 MEMBERSHIP NOT YET ACTIVE';
    message = 'Membership has not started yet.';
  } else if (todayEnd > validUntilEnd) {
    status_code = 'EXPIRED';
    is_valid = false;
    title = '🔴 MEMBERSHIP EXPIRED';
    message = 'Membership has expired.';
  } else {
    status_code = 'ACTIVE';
    is_valid = true;
    title = '🟢 MEMBER ACTIVE';
    message = 'Membership is currently active.';
  }

  // Calculate Days Remaining (for active card: from todayStart to validUntilEnd inclusive)
  const msDiff = validUntilEnd.getTime() - todayStart.getTime();
  const daysRemaining = Math.max(1, Math.ceil(msDiff / (1000 * 60 * 60 * 24)));

  return {
    success: true,
    is_valid,
    status_code,
    title,
    message,
    member: {
      id: card.id,
      member_id: card.member_id,
      customer_name: card.customer_name || 'Member',
      customer_mobile: card.customer_mobile || '',
      valid_from: formattedValidFrom,
      valid_until: formattedValidUntil,
      expired_on: formattedValidUntil,
      days_remaining: daysRemaining,
      server_date: formattedToday
    }
  };
}

module.exports = {
  query,
  initDatabase,
  getNextCounter,
  executeTransaction,
  usePg: () => usePg,
  getAllAddons,
  getAddonById,
  createAddon,
  updateAddon,
  deleteAddon,
  getAddonAnalytics,
  getFoodMemberStateForCustomer,
  createFoodMemberApplication,
  getOwnerFoodMemberApplications,
  deleteFoodMemberApplication,
  deleteAllFoodMemberApplications,
  verifyFoodMemberPayment,
  rejectFoodMemberPayment,
  approveFoodMemberCard,
  rejectFoodMemberCard,
  suspendFoodMemberCard,
  reactivateFoodMemberCard,
  verifyFoodMemberQr
};


