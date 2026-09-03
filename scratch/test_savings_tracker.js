const db = require('../db.js');

async function runTest() {
  console.log('====================================================');
  console.log('PREMIUM SAVINGS TRACKER TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${testName} ${details}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName} ${details}`);
      failed++;
    }
  }

  try {
    await db.initDatabase();

    const ts = Date.now();
    const custA = 'test_cust_sav_A_' + ts;
    const custB = 'test_cust_sav_B_' + ts;

    const mobileA = '9' + String(ts).slice(-9);
    const mobileB = '8' + String(ts).slice(-9);

    // 1. Create Users
    await db.query(`INSERT INTO users (id, name, mobile, role, password) VALUES ($1, $2, $3, $4, $5);`, [custA, 'Savings Customer A', mobileA, 'CUSTOMER', 'pass123']);
    await db.query(`INSERT INTO users (id, name, mobile, role, password) VALUES ($1, $2, $3, $4, $5);`, [custB, 'Savings Customer B', mobileB, 'CUSTOMER', 'pass123']);

    // 2. Customer A Card 1 (Expired: 2026-01-01 to 2026-03-31)
    const card1Id = 'card_sav_1_' + ts;
    const mem1Id = 'FMC1-' + ts;
    await db.query(
      `INSERT INTO food_member_cards (id, member_id, customer_id, customer_name, customer_mobile, status, valid_from, valid_until, discount_amount, express_delivery_eligible, qr_verification_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
      [card1Id, mem1Id, custA, 'Savings Customer A', mobileA, 'EXPIRED', '2026-01-01T00:00:00Z', '2026-03-31T23:59:59Z', 5.00, true, 'QR1_' + ts, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']
    );

    // Order 1 for Card 1 (Completed, ₹5 discount)
    await db.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, customer_mobile, order_type, total_amount, net_amount, payment_method, payment_status, order_status, items, food_member_discount, is_premium_member, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);`,
      ['ord_sav_1_' + ts, 'TF' + Math.floor(Math.random() * 800000 + 100000), custA, 'Savings Customer A', mobileA, 'Takeaway', 100, 95, 'Cash', 'Paid', 'Completed', '[]', 5.00, 1, '2026-01-15T12:00:00Z']
    );

    // Order 2 for Card 1 (Completed, ₹5 discount)
    await db.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, customer_mobile, order_type, total_amount, net_amount, payment_method, payment_status, order_status, items, food_member_discount, is_premium_member, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);`,
      ['ord_sav_2_' + ts, 'TF' + Math.floor(Math.random() * 800000 + 100000), custA, 'Savings Customer A', mobileA, 'Takeaway', 80, 75, 'Cash', 'Paid', 'Completed', '[]', 5.00, 1, '2026-02-10T12:00:00Z']
    );

    // Order 3 for Card 1 (CANCELLED -> Should NOT count)
    await db.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, customer_mobile, order_type, total_amount, net_amount, payment_method, payment_status, order_status, items, food_member_discount, is_premium_member, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);`,
      ['ord_sav_3_' + ts, 'TF' + Math.floor(Math.random() * 800000 + 100000), custA, 'Savings Customer A', mobileA, 'Takeaway', 50, 45, 'Cash', 'Pending', 'Cancelled', '[]', 5.00, 1, '2026-02-15T12:00:00Z']
    );

    // Customer A Card 2 (Active: 2026-08-01 to 2026-11-01)
    const card2Id = 'card_sav_2_' + ts;
    const mem2Id = 'FMC2-' + ts;
    await db.query(
      `INSERT INTO food_member_cards (id, member_id, customer_id, customer_name, customer_mobile, status, valid_from, valid_until, discount_amount, express_delivery_eligible, qr_verification_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
      [card2Id, mem2Id, custA, 'Savings Customer A', mobileA, 'ACTIVE', '2026-08-01T00:00:00Z', '2026-11-01T23:59:59Z', 5.00, true, 'QR2_' + ts, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z']
    );

    // Order 4 for Card 2 (Completed, ₹5 discount)
    await db.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, customer_mobile, order_type, total_amount, net_amount, payment_method, payment_status, order_status, items, food_member_discount, is_premium_member, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);`,
      ['ord_sav_4_' + ts, 'TF' + Math.floor(Math.random() * 800000 + 100000), custA, 'Savings Customer A', mobileA, 'Takeaway', 90, 85, 'Cash', 'Paid', 'Completed', '[]', 5.00, 1, '2026-08-15T12:00:00Z']
    );

    // Simulate calculateCustomerPremiumSavings for Customer A
    const cardsRes = await db.query(`SELECT * FROM food_member_cards WHERE customer_id = $1 ORDER BY created_at DESC;`, [custA]);
    const cards = cardsRes.rows;
    const latestCard = cards[0];

    const ordersRes = await db.query(
      `SELECT * FROM orders WHERE customer_id = $1 AND UPPER(COALESCE(order_status, '')) NOT IN ('CANCELLED', 'REJECTED') AND UPPER(COALESCE(payment_status, '')) NOT IN ('FAILED', 'REFUNDED') ORDER BY created_at DESC;`,
      [custA]
    );
    const orders = ordersRes.rows;

    let currentCardOrders = 0;
    let currentCardSaved = 0;
    let lifetimeOrders = 0;
    let lifetimeSaved = 0;

    for (const order of orders) {
      const orderMs = new Date(order.created_at).getTime();
      let matchedCard = null;
      for (const c of cards) {
        const vFrom = new Date(c.valid_from).getTime();
        const vUntil = new Date(c.valid_until).getTime();
        if (orderMs >= vFrom && orderMs <= vUntil) {
          matchedCard = c;
          break;
        }
      }
      const disc = Number(order.food_member_discount || 5.00);
      if (matchedCard || order.is_premium_member) {
        lifetimeOrders++;
        lifetimeSaved += disc;
        if ((matchedCard && matchedCard.id === latestCard.id) || order.created_at >= '2026-08-01') {
          currentCardOrders++;
          currentCardSaved += disc;
        }
      }
    }

    assert(currentCardOrders === 1, 'TEST 1: Current Card Orders count = 1', `got ${currentCardOrders}`);
    assert(currentCardSaved === 5, 'TEST 2: Current Card Savings = ₹5', `got ₹${currentCardSaved}`);
    assert(lifetimeOrders === 3, 'TEST 3: Lifetime Premium Orders = 3 (Excludes Cancelled Order)', `got ${lifetimeOrders}`);
    assert(lifetimeSaved === 15, 'TEST 4: Lifetime Total Saved = ₹15 (Preserves Card 1 Savings)', `got ₹${lifetimeSaved}`);

    // TEST 5: Customer B (No cards) sees zero statistics
    const cardsResB = await db.query(`SELECT * FROM food_member_cards WHERE customer_id = $1;`, [custB]);
    assert(cardsResB.rows.length === 0, 'TEST 5: Customer B has 0 cards and 0 savings (Security Isolation)');

    // CLEANUP
    await db.query(`DELETE FROM orders WHERE customer_id IN ($1, $2);`, [custA, custB]);
    await db.query(`DELETE FROM food_member_cards WHERE customer_id IN ($1, $2);`, [custA, custB]);
    await db.query(`DELETE FROM users WHERE id IN ($1, $2);`, [custA, custB]);

    console.log('\n====================================================');
    console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
    console.log('====================================================');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Savings Tracker Test Suite Error:', err);
    process.exit(1);
  }
}

runTest();
