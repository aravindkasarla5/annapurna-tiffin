const db = require('./db.js');

async function check() {
  try {
    const cards = await db.query('SELECT member_id, customer_name, customer_mobile, status, valid_from, valid_until FROM food_member_cards;');
    console.log('--- FOOD MEMBER CARDS ---');
    console.log(JSON.stringify(cards.rows, null, 2));

    const apps = await db.query('SELECT id, customer_name, customer_mobile, status FROM food_member_applications;');
    console.log('--- FOOD MEMBER APPLICATIONS ---');
    console.log(JSON.stringify(apps.rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Error querying cards:', err);
    process.exit(1);
  }
}

check();
