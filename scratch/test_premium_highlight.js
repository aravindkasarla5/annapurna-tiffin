const db = require('../db.js');

function parseDateComponents(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  // Handle ISO string vs local date parts consistently
  if (typeof dateInput === 'string' && dateInput.includes('T')) {
    const parts = dateInput.split('T')[0].split('-');
    if (parts.length === 3) {
      return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function calculateRemainingDays(validUntilStr, currentDateObj) {
  const now = currentDateObj || new Date();
  const validUntil = new Date(validUntilStr);
  let validUntilEnd = new Date(validUntil);
  if (typeof validUntilStr === 'string' && validUntilStr.length <= 10) {
    validUntilEnd.setHours(23, 59, 59, 999);
  }

  if (now > validUntilEnd) {
    return { isHighlight: false, text: '' };
  }

  const todayStart = parseDateComponents(now);
  const untilStart = parseDateComponents(validUntilStr);

  const diffMs = untilStart.getTime() - todayStart.getTime();
  const daysDiff = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));

  const dayLabel = daysDiff === 1 ? 'day' : 'days';
  return {
    isHighlight: true,
    daysRemaining: daysDiff,
    text: `🟢 ${daysDiff} ${dayLabel} remaining`
  };
}

function checkCardValidity(card, currentDateObj) {
  if (!card) return false;
  const now = currentDateObj || new Date();
  const vFrom = new Date(card.valid_from);
  const vUntil = new Date(card.valid_until);
  let vUntilEnd = new Date(vUntil);
  if (typeof card.valid_until === 'string' && card.valid_until.length <= 10) {
    vUntilEnd.setHours(23, 59, 59, 999);
  }
  return vFrom <= now && now <= vUntilEnd;
}

async function runTests() {
  console.log('==================================================');
  console.log('PREMIUM MEMBER ORDER HIGHLIGHT TEST SUITE');
  console.log('==================================================\n');

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

  // TEST 1 & 2: Remaining days math for valid card
  const today = new Date('2026-09-03T12:00:00Z');
  const validUntil1 = '2026-10-20T23:59:59Z';
  const rem1 = calculateRemainingDays(validUntil1, today);
  assert(rem1.isHighlight === true && rem1.daysRemaining === 47 && rem1.text === '🟢 47 days remaining',
    'TEST 1 & 2: Valid Until 20/10/2026 on 03/09/2026', `got ${rem1.text}`);

  // TEST 3: Card expired (Today > Valid Until)
  const pastToday = new Date('2026-10-01T12:00:00Z');
  const expiredUntil = '2026-09-30T23:59:59Z';
  const remExpired = calculateRemainingDays(expiredUntil, pastToday);
  assert(remExpired.isHighlight === false,
    'TEST 3: Expired card on 01/10/2026 displays normal order (isHighlight=false)');

  // TEST 4: Repurchased card valid dates
  const newCardToday = new Date('2026-12-06T12:00:00Z');
  const newValidUntil = '2027-03-05T23:59:59Z';
  const remNewCard = calculateRemainingDays(newValidUntil, newCardToday);
  assert(remNewCard.isHighlight === true && remNewCard.daysRemaining === 89 && remNewCard.text === '🟢 89 days remaining',
    'TEST 4: Repurchased card on 06/12/2026 valid until 05/03/2027', `got ${remNewCard.text}`);

  // TEST 5: Multiple historical cards - selection logic
  const historicalCards = [
    { member_id: 'PMC1001', valid_from: '2026-01-01T00:00:00Z', valid_until: '2026-03-31T23:59:59Z' },
    { member_id: 'PMC1002', valid_from: '2026-09-01T00:00:00Z', valid_until: '2026-11-30T23:59:59Z' }
  ];
  const testNow = new Date('2026-09-03T12:00:00Z');
  const activeCard = historicalCards.find(c => checkCardValidity(c, testNow));
  assert(activeCard && activeCard.member_id === 'PMC1002',
    'TEST 5: Ignore expired PMC1001, select active PMC1002');

  // TEST 6: Customer with no card
  assert(!checkCardValidity(null, testNow), 'TEST 6: No card returns false');

  // TEST 7: Membership starts in future
  const futureCard = { valid_from: '2026-10-01T00:00:00Z', valid_until: '2026-12-31T23:59:59Z' };
  assert(!checkCardValidity(futureCard, new Date('2026-09-20T12:00:00Z')),
    'TEST 7: Future card not valid before valid_from');

  // TEST 8: Today equals Valid From
  const sameStartCard = { valid_from: '2026-09-03T00:00:00Z', valid_until: '2026-09-30T23:59:59Z' };
  assert(checkCardValidity(sameStartCard, new Date('2026-09-03T10:00:00Z')),
    'TEST 8: Today equals Valid From is valid');

  // TEST 9: Today equals Valid Until (inclusive)
  const sameEndCard = { valid_from: '2026-09-01T00:00:00Z', valid_until: '2026-09-03T23:59:59Z' };
  assert(checkCardValidity(sameEndCard, new Date('2026-09-03T10:00:00Z')),
    'TEST 9: Today equals Valid Until is valid');

  // TEST 10: Today is one day after Valid Until
  assert(!checkCardValidity(sameEndCard, new Date('2026-09-04T00:00:01Z')),
    'TEST 10: Today after Valid Until is expired');

  // TEST 12: Singular/Plural remaining days
  const oneDayRem = calculateRemainingDays('2026-09-04T23:59:59Z', new Date('2026-09-03T12:00:00Z'));
  assert(oneDayRem.text === '🟢 1 day remaining', 'TEST 12a: 1 day remaining (singular)', `got ${oneDayRem.text}`);

  const zeroDayRem = calculateRemainingDays('2026-09-03T23:59:59Z', new Date('2026-09-03T12:00:00Z'));
  assert(zeroDayRem.text === '🟢 0 days remaining', 'TEST 12b: 0 days remaining', `got ${zeroDayRem.text}`);

  console.log('\n==================================================');
  console.log(`RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('==================================================');
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
