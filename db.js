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
    converted = converted.replace(/ON CONFLICT[\s\S]*/gi, '');
  } else if (converted.toUpperCase().includes('ON CONFLICT') && converted.toUpperCase().includes('DO NOTHING')) {
    converted = converted.replace(/INSERT INTO/gi, 'INSERT OR IGNORE INTO');
    converted = converted.replace(/ON CONFLICT[\s\S]*/gi, '');
  }
  return converted.trim();
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
        sqliteDb.run(cleanSql, params, function(err) {
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
    // PostgreSQL/SQLite schema column migration adjustments
    if (usePg) {
      try {
        await query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_number VARCHAR(100);`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason TEXT;`);
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;`);
        await query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255) DEFAULT '';`);
        await query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS bank_account VARCHAR(100) DEFAULT '';`);
        await query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(50) DEFAULT '';`);
        await query(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS account_holder VARCHAR(255) DEFAULT '';`);
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
        await query(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_activity BIGINT;`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS order_id VARCHAR(100);`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_before NUMERIC(10, 2);`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_after NUMERIC(10, 2);`);
        await query(`ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;`);
        await query(`ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;`);
        await query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'SUCCESS';`);
      } catch (aErr) {
        console.warn('PostgreSQL DDL Notice:', aErr.message);
      }
    } else {
      const safeAlter = async (sql) => { try { await query(sql); } catch(e) {} };
      await safeAlter(`ALTER TABLE reviews ADD COLUMN order_number TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN cancellation_reason TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN rejection_reason TEXT;`);
      await safeAlter(`ALTER TABLE orders ADD COLUMN cancelled_at TEXT;`);
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
      await safeAlter(`ALTER TABLE tokens ADD COLUMN last_activity INTEGER;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN order_id TEXT;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN balance_before REAL;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN balance_after REAL;`);
      await safeAlter(`ALTER TABLE password_resets ADD COLUMN attempts INTEGER DEFAULT 0;`);
      await safeAlter(`ALTER TABLE password_resets ADD COLUMN is_verified INTEGER DEFAULT 0;`);
      await safeAlter(`ALTER TABLE wallet_transactions ADD COLUMN status TEXT DEFAULT 'SUCCESS';`);
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

module.exports = {
  query,
  initDatabase,
  getNextCounter,
  executeTransaction,
  usePg: () => usePg
};

