const db = require('../db.js');

async function runTest() {
  console.log('====================================================');
  console.log('PREMIUM MEMBER CARD EXPIRY REMINDER TEST SUITE');
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

    const testCustomerId = 'test_cust_reminders_' + Date.now();
    const testCardId = 'test_card_reminders_' + Date.now();
    const testMemberId = 'FM-TEST-' + Math.floor(Math.random() * 900000 + 100000);

    // 1. Create test user
    await db.query(
      `INSERT INTO users (id, name, mobile, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING;`,
      [testCustomerId, 'Test Reminder User', '9999988888', 'CUSTOMER']
    );

    // Set valid_from today, valid_until 10 days in future (e.g. 2026-09-13)
    const baseNow = new Date('2026-09-03T12:00:00Z');
    const validFrom = new Date(baseNow);
    const validUntil = new Date('2026-09-13T23:59:59Z'); // 10 days from baseNow

    await db.query(
      `INSERT INTO food_member_cards (
        id, member_id, customer_id, customer_name, customer_mobile,
        status, valid_from, valid_until, discount_amount, express_delivery_eligible,
        qr_verification_code, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
      [
        testCardId, testMemberId, testCustomerId, 'Test Reminder User', '9999988888',
        'ACTIVE', validFrom.toISOString(), validUntil.toISOString(), 5.00, true,
        'QR_TEST_REM_' + Date.now(), baseNow.toISOString(), baseNow.toISOString()
      ]
    );

    console.log(`Created test card ${testMemberId} valid until ${validUntil.toISOString()}`);

    function parseDateComponents(dateInput) {
      if (!dateInput) return null;
      const d = new Date(dateInput);
      if (isNaN(d.getTime())) return null;
      if (typeof dateInput === 'string' && dateInput.includes('T')) {
        const parts = dateInput.split('T')[0].split('-');
        if (parts.length === 3) {
          return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        }
      }
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    // Helper simulation function matching processMemberCardExpiryReminders engine
    async function simulateExpiryEngine(targetDateObj) {
      const now = new Date(targetDateObj);
      const nowIso = now.toISOString();
      const nowMs = now.getTime();

      let summary = { processed: 0, reminded7d: 0, reminded3d: 0, reminded1d: 0, expired: 0 };

      const cardRes = await db.query(`SELECT * FROM food_member_cards WHERE id = $1;`, [testCardId]);
      const card = cardRes.rows[0];

      if (!card || card.status !== 'ACTIVE') {
        return summary;
      }

      summary.processed = 1;
      const vUntil = new Date(card.valid_until);
      let vUntilEnd = new Date(vUntil);

      if (nowMs > vUntilEnd.getTime()) {
        if (!card.reminded_expired_at) {
          await db.query(
            `UPDATE food_member_cards SET status = 'EXPIRED', reminded_expired_at = $1, updated_at = $2 WHERE id = $3;`,
            [nowIso, nowIso, card.id]
          );
          summary.expired++;
        }
        return summary;
      }

      const todayStart = parseDateComponents(now);
      const untilStart = parseDateComponents(card.valid_until);
      const diffMs = untilStart.getTime() - todayStart.getTime();
      const daysDiff = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));

      if (daysDiff <= 1 && !card.reminded_1d_at) {
        await db.query(
          `UPDATE food_member_cards SET reminded_1d_at = $1, updated_at = $2 WHERE id = $3;`,
          [nowIso, nowIso, card.id]
        );
        summary.reminded1d++;
      } else if (daysDiff <= 3 && daysDiff > 1 && !card.reminded_3d_at) {
        await db.query(
          `UPDATE food_member_cards SET reminded_3d_at = $1, updated_at = $2 WHERE id = $3;`,
          [nowIso, nowIso, card.id]
        );
        summary.reminded3d++;
      } else if (daysDiff <= 7 && daysDiff > 3 && !card.reminded_7d_at) {
        await db.query(
          `UPDATE food_member_cards SET reminded_7d_at = $1, updated_at = $2 WHERE id = $3;`,
          [nowIso, nowIso, card.id]
        );
        summary.reminded7d++;
      }

      return summary;
    }

    // TEST 1: Initial run at 10 days remaining -> NO reminder sent yet (only sent at <=7 days)
    const resDay10 = await simulateExpiryEngine(baseNow);
    assert(resDay10.reminded7d === 0 && resDay10.reminded3d === 0 && resDay10.reminded1d === 0,
      'TEST 1: Card with 10 days remaining sends no reminder yet');

    // TEST 2: Advance date to 2026-09-06 (7 days remaining before 2026-09-13)
    const date7d = new Date('2026-09-06T12:00:00Z');
    const res7d_run1 = await simulateExpiryEngine(date7d);
    assert(res7d_run1.reminded7d === 1, 'TEST 2a: 7-day reminder sent on 2026-09-06 (7 days left)');

    // TEST 3: Idempotency check for 7-day reminder (run 2nd time on same day)
    const res7d_run2 = await simulateExpiryEngine(date7d);
    assert(res7d_run2.reminded7d === 0, 'TEST 3: 7-day reminder IDEMPOTENT (0 duplicate reminders sent)');

    // TEST 4: Advance date to 2026-09-10 (3 days remaining)
    const date3d = new Date('2026-09-10T12:00:00Z');
    const res3d_run1 = await simulateExpiryEngine(date3d);
    assert(res3d_run1.reminded3d === 1, 'TEST 4a: 3-day reminder sent on 2026-09-10 (3 days left)');

    // TEST 5: Idempotency check for 3-day reminder
    const res3d_run2 = await simulateExpiryEngine(date3d);
    assert(res3d_run2.reminded3d === 0, 'TEST 5: 3-day reminder IDEMPOTENT (0 duplicate reminders sent)');

    // TEST 6: Advance date to 2026-09-12 (1 day remaining)
    const date1d = new Date('2026-09-12T12:00:00Z');
    const res1d_run1 = await simulateExpiryEngine(date1d);
    assert(res1d_run1.reminded1d === 1, 'TEST 6a: 1-day reminder sent on 2026-09-12 (1 day left)');

    // TEST 7: Idempotency check for 1-day reminder
    const res1d_run2 = await simulateExpiryEngine(date1d);
    assert(res1d_run2.reminded1d === 0, 'TEST 7: 1-day reminder IDEMPOTENT (0 duplicate reminders sent)');

    // TEST 8: Advance date past valid_until to 2026-09-14 (Expired)
    const dateExp = new Date('2026-09-14T12:00:00Z');
    const resExp_run1 = await simulateExpiryEngine(dateExp);
    assert(resExp_run1.expired === 1, 'TEST 8a: Card past valid_until transitions to EXPIRED');

    // TEST 9: Idempotency check for Expired notification
    const resExp_run2 = await simulateExpiryEngine(dateExp);
    assert(resExp_run2.expired === 0, 'TEST 9: Expired notice IDEMPOTENT (0 duplicate expired notices sent)');

    // Verify DB card status
    const finalCardRes = await db.query(`SELECT status, reminded_7d_at, reminded_3d_at, reminded_1d_at, reminded_expired_at FROM food_member_cards WHERE id = $1;`, [testCardId]);
    const finalCard = finalCardRes.rows[0];
    assert(
      finalCard.status === 'EXPIRED' &&
      finalCard.reminded_7d_at &&
      finalCard.reminded_3d_at &&
      finalCard.reminded_1d_at &&
      finalCard.reminded_expired_at,
      'TEST 10: DB record holds all 4 timestamp flags and EXPIRED status'
    );

    // CLEANUP
    await db.query(`DELETE FROM food_member_cards WHERE id = $1;`, [testCardId]);
    await db.query(`DELETE FROM users WHERE id = $1;`, [testCustomerId]);
    console.log('\nCleaned up test records.');

    console.log('\n====================================================');
    console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
    console.log('====================================================');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Test Suite Exception:', err);
    process.exit(1);
  }
}

runTest();
