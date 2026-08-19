const fs = require('fs');
const path = require('path');
const db = require('./db');

async function migrate() {
  console.log('======================================================');
  console.log('   STARTING ONE-TIME db.json TO POSTGRESQL MIGRATION  ');
  console.log('======================================================\n');

  let targetFile = path.join(__dirname, 'db.json');
  if (!fs.existsSync(targetFile)) {
    targetFile = path.join(__dirname, 'seed_data.json');
  }

  if (!fs.existsSync(targetFile)) {
    console.warn('Notice: Neither db.json nor seed_data.json found at:', targetFile);
    return;
  }

  console.log('Loading database migration source from:', targetFile);
  const raw = fs.readFileSync(targetFile, 'utf8');
  const dbData = JSON.parse(raw);

  // Initialize DB tables
  await db.initDatabase();

  const report = {
    users: 0,
    settings: 0,
    tiffins: 0,
    orders: 0,
    payments: 0,
    referrals: 0,
    wallet_transactions: 0,
    notifications: 0,
    support_tickets: 0,
    support_messages: 0,
    reviews: 0,
    tokens: 0
  };

  // 1. Migrate Users
  if (dbData.users && Array.isArray(dbData.users)) {
    for (let u of dbData.users) {
      try {
        const cartJson = JSON.stringify(u.cart || []);
        const favJson = JSON.stringify(u.favorites || []);
        await db.query(
          `INSERT INTO users (
            id, name, mobile, password, role, email, address, referral_code, 
            referred_by, referred_by_code, wallet_balance, loyalty_points, 
            cart, favorites, show_on_leaderboard, sound_enabled, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
          ON CONFLICT (id) DO NOTHING;`,
          [
            u.id,
            u.name || 'User',
            u.mobile,
            u.password,
            u.role || 'CUSTOMER',
            u.email || null,
            u.address || null,
            u.referral_code || null,
            u.referred_by || null,
            u.referred_by_code || null,
            Number(u.wallet_balance || 0),
            Number(u.loyalty_points || 0),
            cartJson,
            favJson,
            u.show_on_leaderboard !== false,
            u.sound_enabled !== false,
            u.created_at || new Date().toISOString()
          ]
        );
        report.users++;
      } catch (err) {
        console.error(`Failed to migrate user ${u.id} (${u.mobile}):`, err.message);
      }
    }
  }

  // 2. Migrate Settings
  if (dbData.settings) {
    const s = dbData.settings;
    try {
      const refJson = JSON.stringify(s.referral || {});
      await db.query(
        `INSERT INTO settings (
          id, hotel_name, hotel_logo, phone, address, open_time, close_time, 
          holidays, upi_id, upi_name, upi_qr_code, is_open, is_qr_pay_enabled, 
          is_phonepe_enabled, description, referral, upi_qr_updated_at
        ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO NOTHING;`,
        [
          s.hotel_name || 'Sri Lakshmi Annapurna Tiffin Center',
          s.hotel_logo || '/images/tiffin_logo.png',
          s.phone || '+91 9392874900',
          s.address || '#42, Temple Road, Near Gandhi Circle, Bengaluru, KA',
          s.open_time || '06:30 AM',
          s.close_time || '10:30 PM',
          s.holidays || 'None (Open 7 Days)',
          s.upi_id || 'annapurna.tiffin@upi',
          s.upi_name || 'Annapurna Tiffin Center',
          s.upi_qr_code || '/images/tiffin_logo.png',
          s.is_open !== false,
          s.is_qr_pay_enabled !== false,
          s.is_phonepe_enabled !== false,
          s.description || '',
          refJson,
          s.upi_qr_updated_at || Date.now()
        ]
      );
      report.settings++;
    } catch (err) {
      console.error('Failed to migrate settings:', err.message);
    }
  }

  // 3. Migrate Tiffins
  if (dbData.tiffins && Array.isArray(dbData.tiffins)) {
    for (let t of dbData.tiffins) {
      try {
        await db.query(
          `INSERT INTO tiffins (id, name, description, price, category, image, is_available)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             price = EXCLUDED.price,
             category = EXCLUDED.category,
             image = EXCLUDED.image,
             is_available = EXCLUDED.is_available;`,
          [
            t.id,
            t.name,
            t.description || '',
            Number(t.price),
            t.category || 'Breakfast',
            t.image || '',
            t.is_available !== false
          ]
        );
        report.tiffins++;
      } catch (err) {
        console.error(`Failed to migrate tiffin ${t.id}:`, err.message);
      }
    }
  }

  // 4. Migrate Orders
  if (dbData.orders && Array.isArray(dbData.orders)) {
    for (let o of dbData.orders) {
      try {
        const itemsJson = JSON.stringify(o.items || []);
        await db.query(
          `INSERT INTO orders (
            id, order_number, customer_id, customer_name, customer_mobile, 
            order_type, delivery_address, notes, total_amount, used_wallet_amount, 
            net_amount, payment_method, payment_status, order_status, items, 
            cancellation_reason, utr_number, payment_screenshot, screenshot_url, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
          ON CONFLICT (id) DO NOTHING;`,
          [
            o.id,
            o.order_number,
            o.customer_id,
            o.customer_name || 'Customer',
            o.customer_mobile || '',
            o.order_type || 'Takeaway',
            o.delivery_address || null,
            o.notes || null,
            Number(o.total_amount || o.grand_total || 0),
            Number(o.used_wallet_amount || o.wallet_deducted || 0),
            Number(o.net_amount || o.grand_total || 0),
            o.payment_method || 'Cash',
            o.payment_status || 'Pending',
            o.order_status || 'Received',
            itemsJson,
            o.cancellation_reason || null,
            o.utr_number || null,
            o.payment_screenshot || o.screenshot_url || null,
            o.screenshot_url || o.payment_screenshot || null,
            o.created_at || new Date().toISOString()
          ]
        );
        report.orders++;
      } catch (err) {
        console.error(`Failed to migrate order ${o.id}:`, err.message);
      }
    }
  }

  // 5. Migrate Payments
  if (dbData.payments && Array.isArray(dbData.payments)) {
    for (let p of dbData.payments) {
      try {
        await db.query(
          `INSERT INTO payments (
            id, order_number, customer_id, customer_name, customer_mobile, 
            amount, payment_method, payment_status, utr_number, screenshot_url, notes, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO NOTHING;`,
          [
            p.id,
            p.order_number,
            p.customer_id || null,
            p.customer_name || 'Customer',
            p.customer_mobile || '',
            Number(p.amount || 0),
            p.payment_method || 'Cash',
            p.payment_status || 'Pending',
            p.utr_number || null,
            p.screenshot_url || null,
            p.notes || null,
            p.created_at || new Date().toISOString()
          ]
        );
        report.payments++;
      } catch (err) {
        console.error(`Failed to migrate payment ${p.id}:`, err.message);
      }
    }
  }

  // 6. Migrate Referrals
  if (dbData.referrals && Array.isArray(dbData.referrals)) {
    for (let r of dbData.referrals) {
      try {
        await db.query(
          `INSERT INTO referrals (
            id, referrer_id, referrer_mobile, referrer_name, referred_id, 
            referred_mobile, referred_name, order_number, status, reward_amount, date_time, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO NOTHING;`,
          [
            r.id,
            r.referrer_id,
            r.referrer_mobile || '',
            r.referrer_name || '',
            r.referred_id,
            r.referred_mobile || '',
            r.referred_name || '',
            r.order_number || null,
            r.status || 'Pending',
            Number(r.reward_amount || 30),
            r.date_time || '',
            r.created_at || new Date().toISOString()
          ]
        );
        report.referrals++;
      } catch (err) {
        console.error(`Failed to migrate referral ${r.id}:`, err.message);
      }
    }
  }

  // 7. Migrate Wallet Transactions
  if (dbData.wallet_transactions && Array.isArray(dbData.wallet_transactions)) {
    for (let w of dbData.wallet_transactions) {
      try {
        await db.query(
          `INSERT INTO wallet_transactions (id, user_id, amount, type, description, date_time, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING;`,
          [
            w.id,
            w.user_id,
            Number(w.amount),
            w.type || 'CREDIT',
            w.description || '',
            w.date_time || '',
            w.created_at || new Date().toISOString()
          ]
        );
        report.wallet_transactions++;
      } catch (err) {
        console.error(`Failed to migrate wallet transaction ${w.id}:`, err.message);
      }
    }
  }

  // 8. Migrate Notifications
  if (dbData.notifications && Array.isArray(dbData.notifications)) {
    for (let n of dbData.notifications) {
      try {
        await db.query(
          `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING;`,
          [
            n.id,
            n.target_role || 'CUSTOMER',
            n.customer_id || null,
            n.title || 'Notification',
            n.message || '',
            n.type || 'INFO',
            Boolean(n.is_read),
            n.date_time || '',
            n.created_at || new Date().toISOString()
          ]
        );
        report.notifications++;
      } catch (err) {
        console.error(`Failed to migrate notification ${n.id}:`, err.message);
      }
    }
  }

  // 9. Migrate Support Tickets & Messages
  if (dbData.support_tickets && Array.isArray(dbData.support_tickets)) {
    for (let t of dbData.support_tickets) {
      try {
        await db.query(
          `INSERT INTO support_tickets (
            id, ticket_number, user_id, customer_id, customer_name, customer_mobile, 
            subject, category, priority, status, order_number, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (id) DO NOTHING;`,
          [
            t.id,
            t.ticket_number || `TKT_${t.id}`,
            t.user_id || t.customer_id,
            t.customer_id,
            t.customer_name || 'Customer',
            t.customer_mobile || '',
            t.subject || 'Support Ticket',
            t.category || 'General Inquiry',
            t.priority || 'Medium',
            t.status || 'Open',
            t.order_number || null,
            t.created_at || new Date().toISOString(),
            t.updated_at || new Date().toISOString()
          ]
        );
        report.support_tickets++;

        if (t.messages && Array.isArray(t.messages)) {
          for (let m of t.messages) {
            await db.query(
              `INSERT INTO support_messages (id, ticket_id, sender_role, sender_name, message, date_time, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (id) DO NOTHING;`,
              [
                m.id || `msg_${Date.now()}_${Math.random()}`,
                t.id,
                m.sender_role || 'CUSTOMER',
                m.sender_name || 'User',
                m.message || '',
                m.date_time || '',
                m.created_at || new Date().toISOString()
              ]
            );
            report.support_messages++;
          }
        }
      } catch (err) {
        console.error(`Failed to migrate ticket ${t.id}:`, err.message);
      }
    }
  }

  // 10. Migrate Reviews
  if (dbData.reviews && Array.isArray(dbData.reviews)) {
    for (let r of dbData.reviews) {
      try {
        await db.query(
          `INSERT INTO reviews (id, customer_id, customer_name, rating, comment, is_visible, owner_reply, reply_date_time, date_time, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO NOTHING;`,
          [
            r.id,
            r.customer_id || null,
            r.customer_name || 'Customer',
            Number(r.rating || 5),
            r.comment || '',
            r.is_visible !== false,
            r.owner_reply || null,
            r.reply_date_time || null,
            r.date_time || '',
            r.created_at || new Date().toISOString()
          ]
        );
        report.reviews++;
      } catch (err) {
        console.error(`Failed to migrate review ${r.id}:`, err.message);
      }
    }
  }

  // 11. Migrate Active Tokens
  if (dbData.tokens && typeof dbData.tokens === 'object') {
    for (let tok in dbData.tokens) {
      try {
        const val = dbData.tokens[tok];
        const uId = typeof val === 'string' ? val : val.user_id;
        const role = typeof val === 'object' && val.role ? val.role : 'CUSTOMER';
        const createdAt = typeof val === 'object' && val.created_at ? val.created_at : Date.now();
        await db.query(
          `INSERT INTO tokens (token, user_id, role, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (token) DO NOTHING;`,
          [tok, uId, role, createdAt]
        );
        report.tokens++;
      } catch (err) {
        console.error(`Failed to migrate token ${tok}:`, err.message);
      }
    }
  }

  // 12. Set Sequence Counters for Order & Ticket IDs
  // Only update counters if seed value is GREATER than what is already in DB — 
  // never lower counters as that would generate duplicate Order/Ticket numbers.
  const maxOrderNum = Number(dbData.order_counter || 1045);
  const maxTicketNum = Number(dbData.ticket_counter || 1005);
  const existingOrderCounter = await db.query("SELECT current_value FROM counters WHERE name = 'order_counter';");
  const existingTicketCounter = await db.query("SELECT current_value FROM counters WHERE name = 'ticket_counter';");
  const currentOrderVal = Number(existingOrderCounter.rows[0]?.current_value || 0);
  const currentTicketVal = Number(existingTicketCounter.rows[0]?.current_value || 0);
  if (maxOrderNum > currentOrderVal) {
    await db.query(`UPDATE counters SET current_value = $1 WHERE name = 'order_counter';`, [maxOrderNum]);
  }
  if (maxTicketNum > currentTicketVal) {
    await db.query(`UPDATE counters SET current_value = $1 WHERE name = 'ticket_counter';`, [maxTicketNum]);
  }

  console.log('\n======================================================');
  console.log('   MIGRATION COMPLETED SUCCESSFULLY!');
  console.log('======================================================');
  console.table(report);
  console.log(`Global order_counter set to: ${maxOrderNum}`);
  console.log(`Global ticket_counter set to: ${maxTicketNum}`);
  console.log('======================================================\n');
  return report;
}

module.exports = migrate;

if (require.main === module) {
  migrate().catch(err => {
    console.error('Migration execution failed:', err);
    process.exit(1);
  });
}
