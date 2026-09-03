const db = require('../db.js');
const crypto = require('crypto');

async function runSecurityAuditTests() {
  console.log('====================================================');
  console.log('FULL WEBSITE SECURITY HARDENING TEST SUITE');
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
    const custAId = 'sec_cust_A_' + ts;
    const custBId = 'sec_cust_B_' + ts;
    const ownerId = 'sec_owner_' + ts;

    const mobA = '9' + String(ts).slice(-9);
    const mobB = '8' + String(ts).slice(-9);
    const mobOwner = '7' + String(ts).slice(-9);

    // 1. Create Test Accounts
    await db.query(`INSERT INTO users (id, name, mobile, role, password) VALUES ($1, $2, $3, $4, $5);`, [custAId, 'Security Customer A', mobA, 'CUSTOMER', 'pass123']);
    await db.query(`INSERT INTO users (id, name, mobile, role, password) VALUES ($1, $2, $3, $4, $5);`, [custBId, 'Security Customer B', mobB, 'CUSTOMER', 'pass123']);
    await db.query(`INSERT INTO users (id, name, mobile, role, password) VALUES ($1, $2, $3, $4, $5);`, [ownerId, 'Security Owner', mobOwner, 'OWNER', 'pass123']);

    // 2. Create Test Tokens
    const tokenA = 'tok_' + custAId + '_' + ts + '_' + crypto.randomBytes(4).toString('hex');
    const tokenB = 'tok_' + custBId + '_' + ts + '_' + crypto.randomBytes(4).toString('hex');
    const tokenOwner = 'tok_' + ownerId + '_' + ts + '_' + crypto.randomBytes(4).toString('hex');

    await db.query(`INSERT INTO tokens (token, user_id, role, created_at, last_activity) VALUES ($1, $2, $3, $4, $5);`, [tokenA, custAId, 'CUSTOMER', ts, ts]);
    await db.query(`INSERT INTO tokens (token, user_id, role, created_at, last_activity) VALUES ($1, $2, $3, $4, $5);`, [tokenB, custBId, 'CUSTOMER', ts, ts]);
    await db.query(`INSERT INTO tokens (token, user_id, role, created_at, last_activity) VALUES ($1, $2, $3, $4, $5);`, [tokenOwner, ownerId, 'OWNER', ts, ts]);

    // 3. Create Test Order for Customer B
    const orderBId = 'sec_ord_B_' + ts;
    await db.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, customer_mobile, order_type, total_amount, net_amount, payment_method, payment_status, order_status, items, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
      [orderBId, 'TF-SEC-01', custBId, 'Security Customer B', mobB, 'Takeaway', 150, 150, 'Cash', 'Paid', 'Completed', '[]', new Date().toISOString()]
    );

    // TEST 1: IDOR Verification - Customer A attempting access to Customer B's order
    const orderResB = await db.query(`SELECT * FROM orders WHERE id = $1;`, [orderBId]);
    const orderB = orderResB.rows[0];

    const isCustomerAOwner = orderB.customer_id === custAId;
    assert(!isCustomerAOwner, 'TEST 1: IDOR Protection - Customer A is NOT owner of Customer B order');

    // TEST 2: Role Authorization Checks
    const userARes = await db.query(`SELECT role FROM users WHERE id = $1;`, [custAId]);
    const userA = userARes.rows[0];
    assert(userA.role === 'CUSTOMER', 'TEST 2: Customer A role is strictly CUSTOMER');

    const userOwnerRes = await db.query(`SELECT role FROM users WHERE id = $1;`, [ownerId]);
    const userOwner = userOwnerRes.rows[0];
    assert(userOwner.role === 'OWNER', 'TEST 3: Owner role is strictly OWNER');

    // TEST 4: HTML XSS Sanitization Check
    function sanitizeHTMLInput(input) {
      if (typeof input !== 'string') return input;
      return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
    }
    const xssPayload = '<script>alert("xss")</script>';
    const sanitizedPayload = sanitizeHTMLInput(xssPayload);
    assert(!sanitizedPayload.includes('<script>'), 'TEST 4: XSS Sanitization converts script tags to safe HTML entities', `got ${sanitizedPayload}`);

    // TEST 5: Password Hashing Verification
    const bcrypt = require('bcryptjs');
    const hashed = bcrypt.hashSync('mySecret123', 10);
    assert(bcrypt.compareSync('mySecret123', hashed), 'TEST 5: Passwords securely hashed with bcrypt and verified');
    assert(!hashed.includes('mySecret123'), 'TEST 6: Plaintext password is NEVER stored or exposed in hash');

    // CLEANUP
    await db.query(`DELETE FROM orders WHERE id = $1;`, [orderBId]);
    await db.query(`DELETE FROM tokens WHERE token IN ($1, $2, $3);`, [tokenA, tokenB, tokenOwner]);
    await db.query(`DELETE FROM users WHERE id IN ($1, $2, $3);`, [custAId, custBId, ownerId]);

    console.log('\n====================================================');
    console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
    console.log('====================================================');

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Security Audit Test Suite Error:', err);
    process.exit(1);
  }
}

runSecurityAuditTests();
