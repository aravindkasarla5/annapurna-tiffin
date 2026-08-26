try { require('dotenv').config(); } catch (e) { }

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================================
// REAL-TIME NOTIFICATION DELIVERY LAYER (WebSocket + Web Push API)
// =========================================================================

const http = require('http');
const { WebSocketServer } = require('ws');
const webPush = require('web-push');

const server = http.createServer(app);

// Initialize Web Push VAPID keys safely
let vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (!vapidPublicKey || !vapidPrivateKey) {
  const vapidKeysPath = path.join(__dirname, 'vapid_keys.json');
  if (fs.existsSync(vapidKeysPath)) {
    try {
      const keys = JSON.parse(fs.readFileSync(vapidKeysPath, 'utf8'));
      vapidPublicKey = keys.publicKey;
      vapidPrivateKey = keys.privateKey;
    } catch (e) { }
  }
  if (!vapidPublicKey || !vapidPrivateKey) {
    const generated = webPush.generateVAPIDKeys();
    vapidPublicKey = generated.publicKey;
    vapidPrivateKey = generated.privateKey;
    try {
      fs.writeFileSync(vapidKeysPath, JSON.stringify(generated, null, 2), 'utf8');
    } catch (e) { }
  }
}

try {
  webPush.setVapidDetails(
    'mailto:support@annapurnatiffin.com',
    vapidPublicKey,
    vapidPrivateKey
  );
} catch (e) {
  console.warn('WebPush VAPID init notice:', e.message);
}

// Active WebSocket Clients Registry: Map<ws, { userId, role, isAlive }>
const activeWsClients = new Map();

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  try {
    const reqUrl = req.url || '';
    const queryStr = reqUrl.includes('?') ? reqUrl.substring(reqUrl.indexOf('?') + 1) : '';
    const urlParams = new URLSearchParams(queryStr);
    const token = urlParams.get('token');

    let authenticatedUser = null;
    if (token) {
      const tokenRes = await db.query('SELECT * FROM tokens WHERE token = $1;', [token]);
      const tokenEntry = tokenRes.rows[0];
      if (tokenEntry) {
        const userRes = await db.query('SELECT id, role FROM users WHERE id = $1;', [tokenEntry.user_id]);
        if (userRes.rows.length > 0) {
          authenticatedUser = userRes.rows[0];
        }
      }
      // Auto-heal matching token if tok_ format
      if (!authenticatedUser && typeof token === 'string' && token.startsWith('tok_')) {
        const usersRes = await db.query('SELECT id, role FROM users;');
        const matchingUser = usersRes.rows
          .sort((a, b) => b.id.length - a.id.length)
          .find(u => token.startsWith('tok_' + u.id + '_'));
        if (matchingUser) {
          authenticatedUser = matchingUser;
        }
      }
    }

    if (!authenticatedUser) {
      ws.close(4001, 'Unauthorized token');
      return;
    }

    ws.isAlive = true;
    activeWsClients.set(ws, {
      userId: authenticatedUser.id,
      role: authenticatedUser.role,
      ws: ws
    });

    ws.send(JSON.stringify({ type: 'CONNECTED', message: 'WebSocket real-time connected successfully' }));

    ws.on('pong', () => {
      const client = activeWsClients.get(ws);
      if (client) client.isAlive = true;
    });

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data && data.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG' }));
        }
      } catch (e) { }
    });

    ws.on('close', () => {
      activeWsClients.delete(ws);
    });

    ws.on('error', () => {
      activeWsClients.delete(ws);
    });
  } catch (err) {
    console.error('WS Connection error:', err.message);
    try { ws.close(1011, 'Internal Error'); } catch (e) { }
  }
});

// Ping-Pong Heartbeat Timer (every 30 seconds)
const heartbeatInterval = setInterval(() => {
  activeWsClients.forEach((client, ws) => {
    if (client.isAlive === false) {
      activeWsClients.delete(ws);
      return ws.terminate();
    }
    client.isAlive = false;
    try {
      ws.ping();
    } catch (e) {
      activeWsClients.delete(ws);
      ws.terminate();
    }
  });
}, 30000);

// Master Centralized Notification Engine Service (WebSocket + Web Push + PostgreSQL)
async function createAndDispatchNotification({
  target_role = 'CUSTOMER', // 'OWNER' or 'CUSTOMER'
  customer_id = null,
  title,
  message,
  type = 'ORDER', // 'ORDER', 'QUEUE', 'PAYMENT', 'PROMOTION', 'SYSTEM', 'SUPPORT', 'MENU', 'ACCOUNT'
  priority = 'NORMAL',
  action_url = null,
  related_order_id = null
}) {
  try {
    if (!title || !message) return null;

    const notifId = 'notif_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const dateTimeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const nowIso = new Date().toISOString();

    // Determine default action URL / deep link if not explicitly passed
    let finalUrl = action_url || '/';
    if (!action_url) {
      if (target_role === 'OWNER') {
        if (type === 'ORDER' || type === 'QUEUE') finalUrl = '/#secOwnerOrders';
        else if (type === 'PAYMENT') finalUrl = '/#secOwnerPayments';
        else if (type === 'SUPPORT') finalUrl = '/#secOwnerSupport';
        else finalUrl = '/#secOwnerDashboard';
      } else {
        if (type === 'QUEUE') finalUrl = '/#secQueueProgress';
        else if (type === 'ORDER') finalUrl = '/#secCustomerOrders';
        else if (type === 'PAYMENT') finalUrl = '/#secCustomerPayments';
        else if (type === 'SUPPORT') finalUrl = '/#secCustomerSupport';
        else finalUrl = '/#secCustomerHome';
      }
    }

    // 1. Save ONE single notification record in PostgreSQL source of truth
    await db.query(
      `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [notifId, target_role, customer_id || null, title, message, type, false, dateTimeStr, nowIso]
    );

    const notifRecord = {
      id: notifId,
      target_role,
      customer_id: customer_id || null,
      title,
      message,
      type,
      priority,
      action_url: finalUrl,
      url: finalUrl,
      related_order_id: related_order_id || null,
      is_read: false,
      date_time: dateTimeStr,
      created_at: nowIso
    };

    // 2. Multi-channel dispatch across WebSocket (Instant In-App) & Web Push (Background/Closed App)
    await dispatchRealTimeNotification(notifRecord);

    return notifRecord;
  } catch (err) {
    console.error('[Central Notification Service] Error creating notification:', err.message);
    return null;
  }
}

// Real-Time Notification Dispatch Engine (WebSocket + Web Push)
async function dispatchRealTimeNotification(notif) {
  if (!notif || !notif.id) return;

  const wsPayload = JSON.stringify({
    type: 'NOTIFICATION',
    data: notif
  });

  // 1. WebSocket Delivery (Instant when user is active & connected)
  let wsSentCount = 0;
  activeWsClients.forEach((client, ws) => {
    if (ws.readyState === 1) { // 1 = OPEN
      let isRecipient = false;
      if (notif.target_role === 'OWNER') {
        if (client.role === 'OWNER') isRecipient = true;
      } else if (notif.target_role === 'CUSTOMER') {
        if (client.role === 'CUSTOMER') {
          if (!notif.customer_id || String(notif.customer_id) === String(client.userId)) {
            isRecipient = true;
          }
        }
      }
      if (isRecipient) {
        try {
          ws.send(wsPayload);
          wsSentCount++;
        } catch (err) {
          console.error('[Notification Engine] WS Send error:', err.message);
        }
      }
    }
  });

  // 2. Web Push Delivery (Background / Closed PWA & Closed Website Delivery)
  try {
    let pushQuery = "";
    let pushParams = [];

    if (notif.target_role === 'OWNER') {
      pushQuery = "SELECT * FROM push_subscriptions WHERE UPPER(role) = 'OWNER' OR user_id IN (SELECT id FROM users WHERE UPPER(role) = 'OWNER');";
    } else if (notif.customer_id) {
      pushQuery = "SELECT * FROM push_subscriptions WHERE user_id = $1;";
      pushParams = [String(notif.customer_id)];
    } else {
      pushQuery = "SELECT * FROM push_subscriptions WHERE UPPER(role) = 'CUSTOMER' OR role IS NULL;";
    }

    const subRes = await db.query(pushQuery, pushParams);
    const subscriptions = subRes.rows || [];

    console.log(`[Notification Engine] Dispatching ID: ${notif.id} | Target: ${notif.target_role} | WS Connected: ${wsSentCount} | Push Subscriptions Found: ${subscriptions.length}`);

    const pushPayload = JSON.stringify({
      id: notif.id,
      title: notif.title || 'Annapurna Tiffin Center',
      message: notif.message || '',
      type: notif.type || 'INFO',
      priority: notif.priority || 'NORMAL',
      created_at: notif.created_at || notif.date_time || new Date().toISOString(),
      url: notif.action_url || notif.url || '/'
    });

    const pushUrgency = (notif.priority === 'HIGH' || notif.priority === 'CRITICAL') ? 'high' : 'normal';

    for (const subRow of subscriptions) {
      try {
        let subObj = subRow.subscription;
        if (typeof subObj === 'string') subObj = JSON.parse(subObj);
        await webPush.sendNotification(subObj, pushPayload, { TTL: 86400, urgency: pushUrgency });
        console.log(`[Web Push Engine] Push delivered successfully to sub_id: ${subRow.id} (user: ${subRow.user_id}, role: ${subRow.role})`);
      } catch (pushErr) {
        const statusCode = pushErr.statusCode || pushErr.status;
        console.warn(`[Web Push Engine] Push deliver notice for sub_id: ${subRow.id} (user: ${subRow.user_id}): ${pushErr.message} (HTTP ${statusCode || 'N/A'})`);
        if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 410) {
          await db.query("DELETE FROM push_subscriptions WHERE id = $1;", [subRow.id]);
          console.log(`[Web Push Engine] Cleaned invalid/expired push subscription: ${subRow.id}`);
        }
      }
    }
  } catch (err) {
    console.error('[Web Push Engine] Push Dispatch Error:', err.message);
  }
}


// WEB PUSH SUBSCRIPTION ENDPOINTS
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ success: true, publicKey: vapidPublicKey });
});

app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ success: false, message: "Invalid subscription payload." });
    }

    const subId = 'sub_' + crypto.randomBytes(12).toString('hex');
    const endpoint = subscription.endpoint;
    const subJson = JSON.stringify(subscription);

    await db.query(
      `INSERT INTO push_subscriptions (id, user_id, role, subscription, endpoint)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET subscription = EXCLUDED.subscription, user_id = EXCLUDED.user_id, role = EXCLUDED.role;`,
      [subId, req.user.id, req.user.role, subJson, endpoint]
    );

    res.json({ success: true, message: "Push notification subscription saved." });
  } catch (err) {
    console.error('Push Subscribe Error:', err);
    res.status(500).json({ success: false, message: "Failed to save push subscription." });
  }
});

app.post('/api/push/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1;', [endpoint]);
    } else {
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1;', [req.user.id]);
    }
    res.json({ success: true, message: "Push subscription removed." });
  } catch (err) {
    console.error('Push Unsubscribe Error:', err);
    res.status(500).json({ success: false, message: "Failed to remove push subscription." });
  }
});

// DIRECT END-TO-END BACKEND PUSH TEST ENDPOINT
app.post('/api/push/test-send', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    const subRes = await db.query(
      "SELECT * FROM push_subscriptions WHERE user_id = $1 OR (UPPER(role) = $2 AND role IS NOT NULL);",
      [String(userId), String(userRole).toUpperCase()]
    );
    const subscriptions = subRes.rows || [];

    if (subscriptions.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No active push subscription found for ${userRole} (ID: ${userId}). Please enable push notifications on your device first.`
      });
    }

    const testNotif = {
      id: 'notif_test_' + Date.now(),
      title: `🔔 Test Push Alert (${userRole})`,
      message: `Direct backend background push delivered successfully to your device! (${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })})`,
      type: 'INFO',
      created_at: new Date().toISOString(),
      url: '/'
    };

    const pushPayload = JSON.stringify(testNotif);
    let successCount = 0;
    const errors = [];

    for (const subRow of subscriptions) {
      try {
        let subObj = subRow.subscription;
        if (typeof subObj === 'string') subObj = JSON.parse(subObj);
        await webPush.sendNotification(subObj, pushPayload, { TTL: 86400, urgency: 'high' });
        successCount++;
        console.log(`[Direct Test Push] Success to sub_id: ${subRow.id}`);
      } catch (pushErr) {
        const statusCode = pushErr.statusCode || pushErr.status;
        errors.push({ subId: subRow.id, error: pushErr.message, statusCode });
        console.warn(`[Direct Test Push] Error for sub_id ${subRow.id}: ${pushErr.message} (HTTP ${statusCode})`);
        if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 410) {
          await db.query("DELETE FROM push_subscriptions WHERE id = $1;", [subRow.id]);
        }
      }
    }

    if (successCount > 0) {
      res.json({
        success: true,
        message: `Direct background push sent to ${successCount} device subscription(s). Close your browser/PWA now to test closed-app delivery!`,
        sentCount: successCount,
        totalSubscriptions: subscriptions.length
      });
    } else {
      res.status(500).json({
        success: false,
        message: "Failed to send background push notification.",
        errors: errors
      });
    }
  } catch (err) {
    console.error('Direct Test Push Error:', err);
    res.status(500).json({ success: false, message: "Internal error during direct push test." });
  }
});

// Helper function to create notification record in database and dispatch via WebSocket & Web Push
async function createAndDispatchNotification(notifData, dbClient = db) {
  try {
    const id = notifData.id || ('notif_' + Date.now() + '_' + Math.floor(Math.random() * 1000));
    const target_role = notifData.target_role || 'CUSTOMER';
    const customer_id = notifData.customer_id || null;
    const title = notifData.title || 'Notification';
    const message = notifData.message || '';
    const type = notifData.type || 'INFO';
    const is_read = notifData.is_read || false;
    const date_time = notifData.date_time || new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    // Deduplication check: Avoid duplicate notification records created within 5 seconds for the same target, title & order
    try {
      let dupCheckSql = `SELECT id, title, message, date_time FROM notifications WHERE target_role = $1 AND title = $2`;
      let dupParams = [target_role, title];
      if (customer_id) {
        dupCheckSql += ` AND customer_id = $3`;
        dupParams.push(customer_id);
      }
      dupCheckSql += ` ORDER BY created_at DESC LIMIT 1;`;
      const dupRes = await dbClient.query(dupCheckSql, dupParams);
      if (dupRes.rows && dupRes.rows.length > 0) {
        const lastNotif = dupRes.rows[0];
        const ageMs = Date.now() - new Date(lastNotif.created_at || Date.now()).getTime();
        if (ageMs < 5000) { // 5-second deduplication window
          console.log(`[Notification Engine] Deduplicated duplicate notification for ${target_role} (${title}).`);
          return lastNotif;
        }
      }
    } catch (dErr) {}

    const notifObj = { id, target_role, customer_id, title, message, type, is_read, date_time };

    await dbClient.query(
      `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [id, target_role, customer_id, title, message, type, is_read, date_time]
    );

    dispatchRealTimeNotification(notifObj);
    return notifObj;
  } catch (err) {
    console.error('Error creating notification:', err);
    return null;
  }
}

// =========================================================================
// SMART DUPLICATE PROTECTION & UTR DEDUPLICATION ENGINE
// =========================================================================

async function checkDuplicateUtr(utrNumber, currentOrderId = null) {
  if (!utrNumber || typeof utrNumber !== 'string') return null;
  const cleanUtr = utrNumber.trim();
  if (!cleanUtr || cleanUtr.length < 4) return null;

  try {
    // Search orders table
    let orderQuery = 'SELECT id, order_number FROM orders WHERE UPPER(utr_number) = UPPER($1)';
    let params = [cleanUtr];
    if (currentOrderId) {
      orderQuery += ' AND id != $2 AND order_number != $2';
      params.push(currentOrderId);
    }
    const oRes = await db.query(orderQuery, params);
    if (oRes.rows && oRes.rows.length > 0) {
      return oRes.rows[0].order_number;
    }

    // Search payments table
    let payQuery = 'SELECT order_number FROM payments WHERE UPPER(utr_number) = UPPER($1)';
    let payParams = [cleanUtr];
    if (currentOrderId) {
      payQuery += ' AND order_id != $2 AND order_number != $2';
      payParams.push(currentOrderId);
    }
    const pRes = await db.query(payQuery, payParams);
    if (pRes.rows && pRes.rows.length > 0) {
      return pRes.rows[0].order_number;
    }
  } catch (err) {
    console.error('Error checking duplicate UTR:', err.message);
  }

  return null;
}

// Global Idempotency Key Middleware (Middleware for API Mutations)
async function handleIdempotencyMiddleware(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const rawKey = req.headers['x-idempotency-key'] || req.headers['idempotency-key'] || (req.body && req.body.idempotency_key);
  if (!rawKey || typeof rawKey !== 'string') {
    return next();
  }

  const key = rawKey.trim();
  if (!key || key.length < 5) {
    return next();
  }

  const userId = req.user ? req.user.id : (req.body ? (req.body.customer_mobile || req.body.user_id || 'anonymous') : 'anonymous');
  const endpoint = (req.baseUrl || '') + (req.path || req.url || '');
  const reqBodyStr = JSON.stringify(req.body || {});
  const reqHash = crypto.createHash('md5').update(reqBodyStr).digest('hex');

  try {
    const existingRes = await db.query(
      'SELECT status, response_status, response_body, created_at FROM idempotency_keys WHERE user_id = $1 AND key = $2;',
      [userId, key]
    );

    if (existingRes.rows && existingRes.rows.length > 0) {
      const recorded = existingRes.rows[0];

      if (recorded.status === 'COMPLETED' && recorded.response_body) {
        console.log(`[Idempotency Engine] Duplicate request detected for key "${key}" (${endpoint}). Returning original cached result.`);
        try {
          const cachedJson = JSON.parse(recorded.response_body);
          res.setHeader('X-Idempotency-Replayed', 'true');
          return res.status(recorded.response_status || 200).json(cachedJson);
        } catch (parseErr) {}
      } else if (recorded.status === 'PROCESSING') {
        const ageMs = Date.now() - new Date(recorded.created_at || Date.now()).getTime();
        if (ageMs < 30000) {
          console.warn(`[Idempotency Engine] Concurrent request in progress for key "${key}" (${endpoint}).`);
          return res.status(409).json({
            success: false,
            message: "⚠️ Request is currently being processed. Please wait..."
          });
        }
      }
    }

    const recordId = 'idm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    await db.query(
      `INSERT INTO idempotency_keys (id, key, user_id, endpoint, request_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'PROCESSING')
       ON CONFLICT (id) DO NOTHING;`,
      [recordId, key, userId, endpoint, reqHash]
    ).catch(() => {});

    // Intercept res.json to capture response status & body upon completion
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      const responseStatus = res.statusCode || 200;
      const responseBodyStr = JSON.stringify(body);

      db.query(
        `UPDATE idempotency_keys
         SET status = 'COMPLETED', response_status = $1, response_body = $2, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3 AND key = $4;`,
        [responseStatus, responseBodyStr, userId, key]
      ).catch(err => {
        console.error('[Idempotency Engine] Error updating key record:', err.message);
      });

      return originalJson(body);
    };

    next();
  } catch (err) {
    console.error('[Idempotency Engine] Unexpected error:', err.message);
    next();
  }
}



/**
 * Saves a base64 encoded data URL or string to permanent disk storage
 * under public/uploads/<subfolder>/ and returns a relative URL path (/uploads/<subfolder>/...).
 */
async function saveBase64Image(base64Str, subfolder = 'screenshots') {
  if (!base64Str || typeof base64Str !== 'string') return null;
  const trimmed = base64Str.trim();
  if (!trimmed) return null;

  // If already a relative or full HTTP URL, return as-is
  if (trimmed.startsWith('/') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }

  // Preserve base64 Data URLs directly to guarantee permanent storage in PostgreSQL
  // across Render restarts and redeployments (never dependent on ephemeral container disk)
  if (trimmed.startsWith('data:image/')) {
    return trimmed;
  }

  if (trimmed.length < 500 && !trimmed.includes('\n')) return trimmed;
  return trimmed;
}

// Standardize Phone Normalization
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = phone.toString().replace(/[^0-9]/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

// Sanitize User Object for Client
function sanitizeUser(user) {
  if (!user) return null;
  const userSafe = { ...user };
  delete userSafe.password;

  if (typeof userSafe.cart === 'string') {
    try { userSafe.cart = JSON.parse(userSafe.cart); } catch (e) { userSafe.cart = []; }
  }
  if (!Array.isArray(userSafe.cart)) userSafe.cart = [];

  if (typeof userSafe.favorites === 'string') {
    try { userSafe.favorites = JSON.parse(userSafe.favorites); } catch (e) { userSafe.favorites = []; }
  }
  if (!Array.isArray(userSafe.favorites)) userSafe.favorites = [];

  userSafe.wallet_balance = Number(userSafe.wallet_balance || 0);
  userSafe.loyalty_points = Number(userSafe.loyalty_points || 0);
  userSafe.sound_enabled = userSafe.sound_enabled !== false;
  userSafe.password_change_required = Boolean(user.password_change_required);
  return userSafe;
}

// Generate Auth Token Helper (PostgreSQL Async)
async function generateToken(userId, role = 'CUSTOMER') {
  const userRes = await db.query('SELECT role FROM users WHERE id = $1;', [userId]);
  const userRole = userRes.rows.length > 0 ? userRes.rows[0].role : role;
  const token = 'tok_' + userId + '_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();

  await db.query(
    'INSERT INTO tokens (token, user_id, role, created_at, last_activity) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (token) DO UPDATE SET role = EXCLUDED.role, last_activity = EXCLUDED.last_activity;',
    [token, userId, userRole, now, now]
  );
  return token;
}

// Authentication Middleware (PostgreSQL Token Validation)
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const tokenHeader = req.headers['x-auth-token'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (tokenHeader) {
    token = tokenHeader;
  }

  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required. Please login." });
  }

  try {
    let tokenRes = await db.query('SELECT * FROM tokens WHERE token = $1;', [token]);
    let tokenEntry = tokenRes.rows[0];

    // AUTO-HEAL Token matching
    if (!tokenEntry && typeof token === 'string' && token.startsWith('tok_')) {
      const usersRes = await db.query('SELECT id, role FROM users;');
      const matchingUser = usersRes.rows
        .sort((a, b) => b.id.length - a.id.length)
        .find(u => token.startsWith('tok_' + u.id + '_'));
      if (matchingUser) {
        const now = Date.now();
        await db.query(
          'INSERT INTO tokens (token, user_id, role, created_at, last_activity) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (token) DO NOTHING;',
          [token, matchingUser.id, matchingUser.role, now, now]
        );
        tokenEntry = { token, user_id: matchingUser.id, role: matchingUser.role, last_activity: now, created_at: now };
      }
    }

    if (!tokenEntry) {
      return res.status(401).json({ success: false, message: "Session invalid or logged out. Please log in again." });
    }

    const userRes = await db.query('SELECT * FROM users WHERE id = $1;', [tokenEntry.user_id]);
    const user = userRes.rows[0];

    if (!user) {
      await db.query('DELETE FROM tokens WHERE token = $1;', [token]);
      return res.status(401).json({ success: false, message: "User account not found." });
    }

    if (user.role === 'CUSTOMER' && (user.status || '').toLowerCase() === 'blocked') {
      await db.query('DELETE FROM tokens WHERE token = $1;', [token]);
      return res.status(403).json({ success: false, message: "Your account has been blocked by the owner. Please contact support." });
    }

    // Customer-Only 20-minute inactivity check
    if (user.role === 'CUSTOMER') {
      const now = Date.now();
      let lastActivity = Number(tokenEntry.last_activity);
      if (!lastActivity || isNaN(lastActivity) || lastActivity <= 0) {
        lastActivity = Number(tokenEntry.created_at);
      }
      if (!lastActivity || isNaN(lastActivity) || lastActivity <= 0) {
        lastActivity = now;
      }
      const inactivityTimeoutMs = 20 * 60 * 1000; // 20 minutes

      if (now - lastActivity > inactivityTimeoutMs) {
        await db.query('DELETE FROM tokens WHERE token = $1;', [token]);
        return res.status(401).json({
          success: false,
          code: 'SESSION_EXPIRED',
          message: "You have been logged out due to 20 minutes of inactivity."
        });
      }

      // Update last_activity if request is NOT background polling
      const isBackgroundPoll = req.headers['x-background-poll'] === 'true';
      if (!isBackgroundPoll) {
        await db.query('UPDATE tokens SET last_activity = $1 WHERE token = $2;', [now, token]);
      }
    }

    req.user = user;
    req.token = token;

    // Forced Password Change Route Guard: Customer MUST change temporary password before accessing other features
    if (user.role === 'CUSTOMER' && Boolean(user.password_change_required)) {
      const reqPath = (req.baseUrl || '') + (req.path || '');
      const allowedPaths = ['/api/auth/change-password', '/api/auth/logout', '/api/auth/me'];
      const isAllowed = allowedPaths.some(p => reqPath.endsWith(p));
      if (!isAllowed) {
        return res.status(403).json({
          success: false,
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: "Your password was reset by the Owner. Please create a new password before continuing."
        });
      }
    }

    next();
  } catch (err) {
    console.error('Auth Middleware Error:', err);
    return res.status(500).json({ success: false, message: "Internal authentication error." });
  }
}

// Optional Auth Middleware
async function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const tokenHeader = req.headers['x-auth-token'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (tokenHeader) {
    token = tokenHeader;
  }

  if (token) {
    try {
      const tokenRes = await db.query('SELECT * FROM tokens WHERE token = $1;', [token]);
      const tokenEntry = tokenRes.rows[0];
      if (tokenEntry) {
        const userRes = await db.query('SELECT * FROM users WHERE id = $1;', [tokenEntry.user_id]);
        if (userRes.rows.length > 0) {
          req.user = userRes.rows[0];
          req.token = token;
        }
      }
    } catch (e) { }
  }
  next();
}

// Role Authorization Middleware
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    const isMatch = req.user.role === role || (role === 'CUSTOMER' && req.user.role === 'CUSTOMER');
    if (!isMatch) {
      return res.status(403).json({ success: false, message: `Access denied. ${role} permissions required.` });
    }
    next();
  };
}

// Robust PostgreSQL User Lookup Helper
async function findUserByIdentifier(rawIdentifier) {
  if (!rawIdentifier) return null;
  const str = rawIdentifier.toString().trim();
  if (!str) return null;

  const normPhone = normalizePhone(str);
  const cleanStr = str.toLowerCase();

  // Search by normalized phone or exact user ID or exact email or exact name
  const res = await db.query(
    `SELECT * FROM users 
     WHERE mobile = $1 
        OR REPLACE(REPLACE(REPLACE(mobile, '+', ''), ' ', ''), '-', '') LIKE '%' || $1 || '%'
        OR id = $2 
        OR LOWER(email) = LOWER($3) 
        OR LOWER(name) = LOWER($3)
     LIMIT 1;`,
    [normPhone || str, str, cleanStr]
  );

  if (res.rows.length > 0) return res.rows[0];

  // Secondary search matching raw mobile digits if 10-digit norm wasn't clean
  const allUsersRes = await db.query('SELECT * FROM users;');
  const fallback = allUsersRes.rows.find(u => {
    const uNorm = normalizePhone(u.mobile);
    return uNorm && normPhone && uNorm === normPhone;
  });

  return fallback || null;
}

// Check Password Match (Supports bcrypt hash and legacy plain text fallback)
function checkPasswordMatch(storedPassword, inputPassword) {
  const sPass = String(storedPassword || '').trim();
  const iPass = String(inputPassword || '').trim();
  if (!sPass || !iPass) return false;

  if (sPass.startsWith('$2a$') || sPass.startsWith('$2b$')) {
    try { return bcrypt.compareSync(iPass, sPass); } catch (e) { }
  }
  return sPass === iPass;
}

// =========================================================================
// AUTHENTICATION ROUTES
// =========================================================================

// AUTH 1. Register New Customer
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, mobile, password, confirm_password, confirmPassword, email, address } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Please enter your full name." });
    }

    if (req.body.role === 'OWNER') {
      return res.status(400).json({ success: false, message: "Owner registration is not allowed. Single owner account is maintained." });
    }

    // 1. Mobile validation — Exactly 10 digits, numbers only
    const rawMobile = (mobile || '').toString().trim();
    if (!/^\d{10}$/.test(rawMobile)) {
      return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
    }
    const cleanMobile = rawMobile;

    if (cleanMobile === '9392874900') {
      return res.status(400).json({ success: false, isDuplicate: true, duplicateType: 'MOBILE', message: "This mobile number is reserved for Hotel Owner. Please login." });
    }

    // 2. Email validation — Valid format required
    const cleanEmail = (email || '').toString().trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!cleanEmail || !emailRegex.test(cleanEmail)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }

    // 3. Password validation & Confirm password match
    const pass = (password || '').toString().trim();
    const cPass = (confirm_password !== undefined ? confirm_password : (confirmPassword !== undefined ? confirmPassword : '')).toString().trim();

    if (!pass) {
      return res.status(400).json({ success: false, message: "Please enter a password." });
    }
    if (pass.length < 4) {
      return res.status(400).json({ success: false, message: "Password must be at least 4 characters long." });
    }
    if (!cPass) {
      return res.status(400).json({ success: false, message: "Please confirm your password." });
    }
    if (pass !== cPass) {
      return res.status(400).json({ success: false, message: "Passwords do not match." });
    }

    // 4. Backend Database Uniqueness Checks (Mobile & Email)
    const existingMobileRes = await db.query('SELECT id FROM users WHERE mobile = $1 LIMIT 1;', [cleanMobile]);
    const existingMobile = existingMobileRes.rows.length > 0;

    const existingEmailRes = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND email IS NOT NULL AND TRIM(email) != \'\' LIMIT 1;', [cleanEmail]);
    const existingEmail = existingEmailRes.rows.length > 0;

    if (existingMobile && existingEmail) {
      return res.status(400).json({
        success: false,
        isDuplicate: true,
        duplicateType: 'BOTH',
        message: "You're already registered. Please login with your existing account."
      });
    }

    if (existingMobile) {
      return res.status(400).json({
        success: false,
        isDuplicate: true,
        duplicateType: 'MOBILE',
        message: "You're already registered with this mobile number. You can login now."
      });
    }

    if (existingEmail) {
      return res.status(400).json({
        success: false,
        isDuplicate: true,
        duplicateType: 'EMAIL',
        message: "You're already registered with this email address. You can login now."
      });
    }

    // Generate Unique Referral Code & Hashed Password
    const namePrefix = name.trim().replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5) || 'TIFFIN';
    const randomNum = Math.floor(10 + Math.random() * 90);
    const generatedRefCode = `${namePrefix}${randomNum}`;
    const hashedPassword = bcrypt.hashSync(pass, 10);

    const newUserId = 'usr_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const newUser = {
      id: newUserId,
      name: name.trim(),
      mobile: cleanMobile,
      password: hashedPassword,
      role: 'CUSTOMER',
      email: cleanEmail,
      address: (address || '').trim(),
      referral_code: generatedRefCode,
      referred_by: null,
      referred_by_code: null,
      wallet_balance: 0,
      loyalty_points: 0,
      cart: '[]',
      favorites: '[]',
      show_on_leaderboard: true,
      sound_enabled: true,
      created_at: new Date().toISOString()
    };

    // Handle Referral Code validation if provided
    const rawRefCode = (req.body.referral_code || '').toString().trim().toUpperCase().replace(/\s+/g, '');
    let referrer = null;
    let refMessage = '';

    if (rawRefCode) {
      const refUserRes = await db.query('SELECT * FROM users WHERE UPPER(referral_code) = $1 AND role = $2;', [rawRefCode, 'CUSTOMER']);
      referrer = refUserRes.rows[0];

      if (!referrer) {
        return res.status(400).json({ success: false, message: "Invalid referral code. Please check and try again." });
      }

      if (referrer.id === newUser.id || referrer.mobile === cleanMobile) {
        return res.status(400).json({ success: false, message: "Self-referral is not allowed." });
      }

      newUser.referred_by = referrer.id;
      newUser.referred_by_code = referrer.referral_code;
    }

    // Insert user into DB with race condition constraint violation handling
    try {
      await db.query(
        `INSERT INTO users (
          id, name, mobile, password, role, email, address, referral_code, 
          referred_by, referred_by_code, wallet_balance, loyalty_points, cart, favorites, show_on_leaderboard, sound_enabled
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);`,
        [
          newUser.id, newUser.name, newUser.mobile, newUser.password, newUser.role,
          newUser.email, newUser.address, newUser.referral_code, newUser.referred_by,
          newUser.referred_by_code, 0, 0, '[]', '[]', true, true
        ]
      );
    } catch (dbInsErr) {
      console.error('Registration Database Insert Constraint Notice:', dbInsErr.message);

      const dupMobCheck = await db.query('SELECT id FROM users WHERE mobile = $1 LIMIT 1;', [cleanMobile]);
      const dupEmailCheck = await db.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND email IS NOT NULL AND TRIM(email) != \'\' LIMIT 1;', [cleanEmail]);

      const isDupMob = dupMobCheck.rows.length > 0;
      const isDupEmail = dupEmailCheck.rows.length > 0;

      if (isDupMob && isDupEmail) {
        return res.status(400).json({
          success: false,
          isDuplicate: true,
          duplicateType: 'BOTH',
          message: "You're already registered. Please login with your existing account."
        });
      } else if (isDupMob) {
        return res.status(400).json({
          success: false,
          isDuplicate: true,
          duplicateType: 'MOBILE',
          message: "You're already registered with this mobile number. You can login now."
        });
      } else if (isDupEmail) {
        return res.status(400).json({
          success: false,
          isDuplicate: true,
          duplicateType: 'EMAIL',
          message: "You're already registered with this email address. You can login now."
        });
      }

      return res.status(400).json({
        success: false,
        isDuplicate: true,
        message: "You're already registered with this mobile number or email. You can login now."
      });
    }

    // Insert into referrals table after user row exists in database
    if (referrer) {
      const settingsRes = await db.query('SELECT referral FROM settings WHERE id = 1;');
      let settingsReferral = settingsRes.rows[0]?.referral || {};
      if (typeof settingsReferral === 'string') {
        try { settingsReferral = JSON.parse(settingsReferral); } catch (e) { }
      }
      const rawVal = Number(settingsReferral.referrer_reward);
      const rewardVal = (!isNaN(rawVal) && isFinite(rawVal) && rawVal > 0) ? rawVal : 10;

      await db.query(
        `INSERT INTO referrals (id, referrer_id, referrer_mobile, referrer_name, referred_id, referred_mobile, referred_name, status, reward_amount, date_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          'ref_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          referrer.id,
          referrer.mobile,
          referrer.name,
          newUser.id,
          newUser.mobile,
          newUser.name,
          'Pending',
          rewardVal,
          new Date().toLocaleString('en-IN')
        ]
      );
      refMessage = ` ₹${rewardVal} first-order referral linked successfully!`;
    }

    const token = await generateToken(newUser.id);
    const userSafe = sanitizeUser(newUser);

    res.json({
      success: true,
      token: token,
      user: userSafe,
      message: `Account created successfully. You can login now.${refMessage}`
    });
  } catch (err) {
    console.error('Registration Error:', err);
    res.status(500).json({ success: false, message: "Database server error during registration." });
  }
});

// AUTH 2. Login User (Unified Owner & Customer Authentication)
app.post('/api/auth/login', async (req, res) => {
  try {
    const rawIdentifier = (req.body.identifier || req.body.mobile || req.body.username || '').toString().trim();
    const password = (req.body.password || '').toString().trim();

    if (!rawIdentifier || !password) {
      return res.status(400).json({ success: false, message: "Username / Mobile / Email and password are required." });
    }

    const user = await findUserByIdentifier(rawIdentifier);

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid username or password." });
    }

    if (!checkPasswordMatch(user.password, password)) {
      return res.status(401).json({ success: false, message: "Invalid username or password." });
    }

    if (user.role === 'CUSTOMER' && (user.status || '').toLowerCase() === 'blocked') {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked by the owner. Please contact support."
      });
    }

    if (user.role === 'CUSTOMER' && Boolean(user.password_change_required) && user.temp_password_expires_at) {
      const expTime = Number(user.temp_password_expires_at);
      if (expTime > 0 && Date.now() > expTime) {
        return res.status(400).json({
          success: false,
          message: "Your temporary password has expired. Please contact the Owner again."
        });
      }
    }

    const token = await generateToken(user.id);
    const userSafe = sanitizeUser(user);

    res.json({
      success: true,
      token: token,
      user: userSafe,
      passwordChangeRequired: Boolean(user.password_change_required),
      message: user.role === 'OWNER' ? 'Welcome to Hotel Owner Dashboard!' : `Welcome back, ${user.name}!`
    });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ success: false, message: "Database server error during login." });
  }
});

// Helper: Send OTP via configured messaging providers (Email / WhatsApp / SMS)
async function sendOtpViaProvider({ user, otp, method = 'SMS' }) {
  const chosenMethod = (method || 'SMS').toUpperCase();

  // 1. Email Delivery via Nodemailer / SMTP
  if (chosenMethod === 'EMAIL') {
    if (!user.email || !user.email.includes('@')) {
      return { success: false, message: "No registered email address found for this customer account." };
    }

    const smtpHost = process.env.SMTP_HOST || process.env.EMAIL_HOST;
    const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
    const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
    const smtpPort = Number(process.env.SMTP_PORT || 587);

    if (!smtpHost || !smtpUser || !smtpPass) {
      console.warn('[OTP Delivery Notice]: SMTP credentials not set in environment.');
      return { success: false, message: "Email delivery service is currently not configured on server." };
    }

    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass }
      });

      const mailOptions = {
        from: `"${process.env.APP_NAME || 'Sri Lakshmi Annapurna Tiffin'}" <${smtpUser}>`,
        to: user.email,
        subject: '🔐 Your Password Reset OTP Code',
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px;">
            <h2 style="color: #d9531e; text-align: center;">Sri Lakshmi Annapurna Tiffin Center</h2>
            <hr style="border: none; border-top: 1px solid #eee;">
            <p>Hello <strong>${user.name || 'Valued Customer'}</strong>,</p>
            <p>You requested a password reset for your customer account (Mobile: <strong>${user.mobile}</strong>).</p>
            <div style="text-align: center; margin: 25px 0;">
              <span style="font-size: 2.2rem; font-weight: 900; letter-spacing: 6px; color: #d9531e; background: #fff3e0; padding: 10px 24px; border-radius: 8px; border: 1px dashed #d9531e; font-family: monospace;">${otp}</span>
            </div>
            <p style="font-size: 0.85rem; color: #666;">This OTP is valid for <strong>5 minutes</strong>. Do NOT share this OTP code with anyone.</p>
            <p style="font-size: 0.8rem; color: #999; text-align: center; margin-top: 20px;">If you did not request a password reset, please ignore this email.</p>
          </div>
        `
      };

      const info = await transporter.sendMail(mailOptions);
      console.log(`[Email OTP Success] Message accepted by SMTP provider ID: ${info.messageId}`);
      return { success: true, message: `OTP sent successfully to your registered email address.` };
    } catch (err) {
      console.error('[Email OTP Transport Error]:', err.message);
      return { success: false, message: "Unable to send OTP via email. Provider delivery failed." };
    }
  }

  // 2. WhatsApp Delivery via WhatsApp Cloud API / Twilio WhatsApp
  if (chosenMethod === 'WHATSAPP') {
    const waToken = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_API_KEY || process.env.WHATSAPP_CLOUD_API_TOKEN || process.env.META_WHATSAPP_TOKEN;
    const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_ID || process.env.META_PHONE_NUMBER_ID;

    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioWaFrom = process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE_NUMBER;

    if (waToken && waPhoneId) {
      try {
        const cleanMobile = user.mobile.replace(/[^0-9]/g, '').slice(-10);
        const formattedMobile = `91${cleanMobile}`;
        const waUrl = `https://graph.facebook.com/v18.0/${waPhoneId}/messages`;

        const payload = process.env.WHATSAPP_TEMPLATE_NAME ? {
          messaging_product: 'whatsapp',
          to: formattedMobile,
          type: 'template',
          template: {
            name: process.env.WHATSAPP_TEMPLATE_NAME,
            language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
            components: [
              {
                type: 'body',
                parameters: [{ type: 'text', text: otp }]
              }
            ]
          }
        } : {
          messaging_product: 'whatsapp',
          to: formattedMobile,
          type: 'text',
          text: {
            body: `🔐 Your Sri Lakshmi Annapurna Tiffin password reset OTP is ${otp}. Valid for 5 minutes. Do not share this code.`
          }
        };

        const response = await fetch(waUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${waToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (response.ok && data.messages && data.messages.length) {
          console.log(`[WhatsApp OTP Success] Message accepted by Meta WhatsApp API ID: ${data.messages[0].id}`);
          return { success: true, message: "OTP sent successfully to your WhatsApp number." };
        } else {
          console.error('[WhatsApp OTP Provider Error]:', JSON.stringify(data));
          return { success: false, message: "Unable to send OTP via WhatsApp. Provider rejected delivery." };
        }
      } catch (err) {
        console.error('[WhatsApp OTP Network Error]:', err.message);
        return { success: false, message: "Unable to send OTP via WhatsApp. Provider communication failed." };
      }
    } else if (twilioSid && twilioToken && twilioWaFrom) {
      try {
        const cleanNumber = user.mobile.replace(/[^0-9]/g, '').slice(-10);
        const formattedMobile = `+91${cleanNumber}`;
        const fromNum = twilioWaFrom.startsWith('whatsapp:') ? twilioWaFrom : `whatsapp:${twilioWaFrom}`;

        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
        const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');

        const params = new URLSearchParams();
        params.append('To', `whatsapp:${formattedMobile}`);
        params.append('From', fromNum);
        params.append('Body', `🔐 Your Sri Lakshmi Annapurna Tiffin password reset OTP is ${otp}. Valid for 5 minutes.`);

        const response = await fetch(twilioUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params
        });

        const data = await response.json();
        if (response.ok && data.sid) {
          console.log(`[WhatsApp Twilio Success] Message SID: ${data.sid}`);
          return { success: true, message: "OTP sent successfully to your WhatsApp number." };
        } else {
          console.error('[WhatsApp Twilio Error]:', JSON.stringify(data));
          return { success: false, message: "Unable to send OTP via WhatsApp. Provider rejected delivery." };
        }
      } catch (err) {
        console.error('[WhatsApp Twilio Network Error]:', err.message);
        return { success: false, message: "Unable to send OTP via WhatsApp. Provider communication failed." };
      }
    } else {
      console.warn('[OTP Delivery Notice]: WhatsApp API credentials not set in Render environment. Please set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.');
      const isDev = process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEV_OTP_FALLBACK === 'true';
      if (isDev) {
        console.log(`[DEV OTP FALLBACK - WHATSAPP]: OTP code for customer ${user.mobile} is: ${otp}`);
        return { success: true, devMode: true, message: "OTP sent successfully to your WhatsApp number (Development Mode)." };
      }
      return { success: false, message: "WhatsApp OTP is currently unavailable. Please try SMS OTP." };
    }
  }

  // 3. SMS Delivery via SMS Gateway (Twilio / Fast2SMS / MSG91 / 2Factor)
  if (chosenMethod === 'SMS') {
    const smsApiKey = process.env.SMS_API_KEY || process.env.FAST2SMS_API_KEY || process.env.FAST2SMS_KEY;
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_NUMBER || process.env.TWILIO_FROM;
    const msg91AuthKey = process.env.MSG91_AUTH_KEY;
    const twoFactorKey = process.env.TWOFACTOR_API_KEY || process.env.FACTOR2_API_KEY;

    if (twilioSid && twilioToken && twilioFrom) {
      try {
        const cleanNumber = user.mobile.replace(/[^0-9]/g, '').slice(-10);
        const formattedMobile = `+91${cleanNumber}`;
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
        const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');

        const params = new URLSearchParams();
        params.append('To', formattedMobile);
        params.append('From', twilioFrom);
        params.append('Body', `🔐 Your Sri Lakshmi Annapurna Tiffin password reset OTP is ${otp}. Valid for 5 minutes.`);

        const response = await fetch(twilioUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params
        });

        const data = await response.json();
        if (response.ok && data.sid) {
          console.log(`[SMS Twilio Success] Message SID: ${data.sid}`);
          return { success: true, message: "OTP sent successfully via SMS." };
        } else {
          console.error('[SMS Twilio Error]:', JSON.stringify(data));
          return { success: false, message: "Unable to send OTP via SMS. Provider rejected delivery." };
        }
      } catch (err) {
        console.error('[SMS Twilio Network Error]:', err.message);
        return { success: false, message: "Unable to send OTP via SMS. Provider communication failed." };
      }
    } else if (smsApiKey) {
      try {
        const cleanApiKey = smsApiKey.toString().trim();
        const cleanMobile = user.mobile.replace(/[^0-9]/g, '').slice(-10);
        const rawMsg = `🔐 Your Sri Lakshmi Annapurna Tiffin password reset OTP is ${otp}. Valid for 5 minutes. Do not share this code.`;

        // 1. Primary Request: Fast2SMS Quick SMS Route GET (route=q - works instantly without domain/DLT verification)
        const qUrl = `https://www.fast2sms.com/dev/bulkV2?authorization=${encodeURIComponent(cleanApiKey)}&route=q&message=${encodeURIComponent(rawMsg)}&language=english&flash=0&numbers=${cleanMobile}`;
        let response = await fetch(qUrl, { method: 'GET' });
        let data = await response.json();

        // 2. Fallback: Fast2SMS Dedicated OTP Route POST (route=otp)
        if (!response.ok || data.return !== true) {
          console.warn('[Fast2SMS Quick Route Notice]:', JSON.stringify(data), '- Attempting route=otp POST fallback...');
          const otpResp = await fetch('https://www.fast2sms.com/dev/bulkV2', {
            method: 'POST',
            headers: {
              'authorization': cleanApiKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              route: 'otp',
              variables_values: otp,
              numbers: cleanMobile
            })
          });
          const otpData = await otpResp.json();
          if (otpResp.ok && (otpData.return === true || otpData.status_code === 200)) {
            data = otpData;
            response = otpResp;
          }
        }

        if (response.ok && (data.return === true || data.status_code === 200)) {
          console.log(`[SMS Fast2SMS Success] Request ID: ${data.request_id || 'OK'}`);
          return { success: true, message: "OTP sent successfully via SMS." };
        } else {
          console.error('[SMS Fast2SMS Error]:', JSON.stringify(data));
          const detailErr = Array.isArray(data.message) ? data.message.join(' ') : (data.message || 'Provider rejected delivery');
          return { success: false, message: `Unable to send OTP via SMS (${detailErr}).` };
        }
      } catch (err) {
        console.error('[SMS Provider Network Error]:', err.message);
        return { success: false, message: "Unable to send OTP via SMS. Provider communication failed." };
      }
  } else if (twoFactorKey) {
    try {
      const cleanMobile = user.mobile.replace(/[^0-9]/g, '').slice(-10);
      const tfTemplate = process.env.TWOFACTOR_TEMPLATE_NAME ? `/${process.env.TWOFACTOR_TEMPLATE_NAME}` : '';
      const tfUrl = `https://2factor.in/API/V1/${twoFactorKey}/SMS/+91${cleanMobile}/${otp}${tfTemplate}`;
      const response = await fetch(tfUrl, { method: 'GET' });
      const data = await response.json();

      if (response.ok && (data.Status === 'Success' || data.status === 'Success')) {
        console.log(`[SMS 2Factor Success] Session ID: ${data.Details}`);
        return { success: true, message: "OTP sent successfully via SMS." };
      } else {
        console.error('[SMS 2Factor Error]:', JSON.stringify(data));
        return { success: false, message: "Unable to send OTP via SMS. Provider rejected delivery." };
      }
    } catch (err) {
      console.error('[SMS 2Factor Network Error]:', err.message);
      return { success: false, message: "Unable to send OTP via SMS. Provider communication failed." };
    }
  } else if (msg91AuthKey) {
    try {
      const cleanMobile = user.mobile.replace(/[^0-9]/g, '').slice(-10);
      const msg91TemplateId = process.env.MSG91_TEMPLATE_ID || '';
      const msg91Url = `https://control.msg91.com/api/v5/otp?template_id=${msg91TemplateId}&mobile=91${cleanMobile}&authkey=${msg91AuthKey}`;
      const response = await fetch(msg91Url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ OTP: otp })
      });
      const data = await response.json();

      if (response.ok && (data.type === 'success' || data.type === 'Success')) {
        console.log(`[SMS MSG91 Success] Request ID: ${data.message}`);
        return { success: true, message: "OTP sent successfully via SMS." };
      } else {
        console.error('[SMS MSG91 Error]:', JSON.stringify(data));
        return { success: false, message: "Unable to send OTP via SMS. Provider rejected delivery." };
      }
    } catch (err) {
      console.error('[SMS MSG91 Network Error]:', err.message);
      return { success: false, message: "Unable to send OTP via SMS. Provider communication failed." };
    }
  } else {
    console.warn('[OTP Delivery Notice]: No SMS Gateway credentials configured in Render environment. Please set FAST2SMS_API_KEY, TWOFACTOR_API_KEY, MSG91_AUTH_KEY, or TWILIO_ACCOUNT_SID.');
    const isDev = process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEV_OTP_FALLBACK === 'true';
    if (isDev) {
      console.log(`[DEV OTP FALLBACK - SMS]: OTP code for customer ${user.mobile} is: ${otp}`);
      return { success: true, devMode: true, message: "OTP sent successfully via SMS (Development Mode)." };
    }
    return { success: false, message: "Unable to send SMS OTP right now. Please try again later." };
  }
}

return { success: false, message: "Invalid delivery method selected." };
}

// AUTH 3a. Get Recovery Methods for Registered Customer
app.post('/api/auth/recovery-methods', async (req, res) => {
  try {
    const rawMobile = (req.body.mobile || req.body.identifier || '').toString().replace(/[^0-9]/g, '').trim();

    if (!rawMobile || rawMobile.length !== 10) {
      return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
    }

    const user = await findUserByIdentifier(rawMobile);
    if (!user || user.role !== 'CUSTOMER') {
      return res.status(404).json({ success: false, message: "No account was found for this mobile number." });
    }

    const maskedMobile = user.mobile.length >= 10 ? '******' + user.mobile.slice(-4) : user.mobile;
    let maskedEmail = null;
    if (user.email && user.email.includes('@')) {
      const parts = user.email.split('@');
      maskedEmail = parts[0].charAt(0) + '*****@' + parts[1];
    }

    const methods = [];
    const hasWaConfig = Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
    const hasSmsConfig = Boolean(process.env.TWILIO_ACCOUNT_SID || process.env.FAST2SMS_API_KEY);
    const hasEmailConfig = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);

    if (hasWaConfig) {
      methods.push({ type: 'WHATSAPP', label: `WhatsApp: ${maskedMobile}`, maskedTarget: maskedMobile });
    }
    if (hasSmsConfig || (!hasWaConfig && !hasEmailConfig)) {
      methods.push({ type: 'SMS', label: `SMS: ${maskedMobile}`, maskedTarget: maskedMobile });
    }
    if (user.email && user.email.includes('@') && hasEmailConfig) {
      methods.push({ type: 'EMAIL', label: `Email: ${maskedEmail}`, maskedTarget: maskedEmail });
    }

    res.json({
      success: true,
      data: {
        mobile: user.mobile,
        methods: methods
      }
    });
  } catch (err) {
    console.error('Recovery Methods Error:', err);
    res.status(500).json({ success: false, message: "Database server error." });
  }
});

// AUTH 3b. Forgot Password (Generate Crypto OTP & Send via Provider)
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const rawMobile = (req.body.mobile || req.body.identifier || '').toString().replace(/[^0-9]/g, '').trim();
    const method = (req.body.method || 'SMS').toString().trim().toUpperCase();

    if (!rawMobile || rawMobile.length !== 10) {
      return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
    }

    const user = await findUserByIdentifier(rawMobile);
    if (!user || user.role !== 'CUSTOMER') {
      return res.status(404).json({ success: false, message: "No account was found for this mobile number." });
    }

    // Rate-limiting check: enforce 30-second cooldown between OTP requests
    const existingReset = await db.query('SELECT * FROM password_resets WHERE user_id = $1;', [user.id]);
    if (existingReset.rows.length > 0) {
      const lastCreated = Number(existingReset.rows[0].created_at || 0);
      const secondsPassed = Math.floor((Date.now() - lastCreated) / 1000);
      if (secondsPassed < 30) {
        return res.status(429).json({
          success: false,
          message: `Please wait ${30 - secondsPassed} seconds before requesting a new OTP.`
        });
      }
    }

    // Cryptographically secure random 6-digit OTP
    const generatedOtp = crypto.randomInt(100000, 1000000).toString();

    // Attempt actual delivery via configured provider FIRST before recording successful timestamp
    const deliveryResult = await sendOtpViaProvider({ user, otp: generatedOtp, method });

    if (!deliveryResult.success) {
      return res.status(400).json({
        success: false,
        message: deliveryResult.message || "Unable to send OTP. Please try again."
      });
    }

    // Only update database reset state & cooldown timestamp upon verified provider acceptance
    const now = Date.now();
    await db.query(
      `INSERT INTO password_resets (user_id, otp, mobile, created_at, attempts, is_verified)
       VALUES ($1, $2, $3, $4, 0, false)
       ON CONFLICT (user_id) DO UPDATE SET otp = EXCLUDED.otp, created_at = EXCLUDED.created_at, attempts = 0, is_verified = false;`,
      [user.id, generatedOtp, user.mobile, now]
    );

    const maskedMobile = user.mobile.length >= 10 ? '******' + user.mobile.slice(-4) : user.mobile;
    res.json({
      success: true,
      message: `OTP sent successfully via ${method.toLowerCase()}.`,
      data: {
        mobile: user.mobile,
        maskedMobile,
        method: method
      }
    });
  } catch (err) {
    console.error('Forgot Password Error:', err);
    res.status(500).json({ success: false, message: "Unable to send OTP. Please try again." });
  }
});

// AUTH 3c. Verify OTP Code Server-Side
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const rawMobile = (req.body.mobile || req.body.identifier || '').toString().replace(/[^0-9]/g, '').trim();
    const inputOtp = (req.body.otp || '').toString().trim();

    if (!rawMobile || rawMobile.length !== 10 || !inputOtp || inputOtp.length !== 6) {
      return res.status(400).json({ success: false, message: "Valid 10-digit mobile number and 6-digit OTP code are required." });
    }

    const user = await findUserByIdentifier(rawMobile);
    if (!user || user.role !== 'CUSTOMER') {
      return res.status(404).json({ success: false, message: "No account was found for this mobile number." });
    }

    const resetRes = await db.query('SELECT * FROM password_resets WHERE user_id = $1;', [user.id]);
    if (!resetRes.rows.length) {
      return res.status(400).json({ success: false, message: "No active OTP request found. Please request a new OTP." });
    }

    const resetRecord = resetRes.rows[0];
    const createdTime = Number(resetRecord.created_at || 0);
    const expirationMs = 5 * 60 * 1000; // 5 minutes expiration limit

    if (Date.now() - createdTime > expirationMs) {
      return res.status(400).json({ success: false, message: "OTP has expired. Please request a new OTP." });
    }

    const currentAttempts = Number(resetRecord.attempts || 0);
    if (currentAttempts >= 5) {
      return res.status(429).json({ success: false, message: "Too many failed OTP attempts. Please request a new OTP." });
    }

    if (resetRecord.otp !== inputOtp) {
      await db.query('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = $1;', [user.id]);
      return res.status(400).json({ success: false, message: "OTP is incorrect. Please check and try again." });
    }

    // OTP is correct -> mark verified
    await db.query('UPDATE password_resets SET is_verified = true WHERE user_id = $1;', [user.id]);

    res.json({
      success: true,
      message: "OTP verified successfully.",
      data: {
        mobile: user.mobile
      }
    });
  } catch (err) {
    console.error('Verify OTP Error:', err);
    res.status(500).json({ success: false, message: "Database server error." });
  }
});

// AUTH 3d. Reset Password (After Server-Side OTP Verification)
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const rawMobile = (req.body.mobile || req.body.identifier || '').toString().replace(/[^0-9]/g, '').trim();
    const inputOtp = (req.body.otp || '').toString().trim();
    const newPassword = (req.body.new_password || req.body.password || '').toString().trim();

    if (!rawMobile || rawMobile.length !== 10 || !newPassword) {
      return res.status(400).json({ success: false, message: "Registered 10-digit mobile number and new password are required." });
    }

    if (newPassword.length < 4) {
      return res.status(400).json({ success: false, message: "Password must be at least 4 characters long." });
    }

    const user = await findUserByIdentifier(rawMobile);
    if (!user || user.role !== 'CUSTOMER') {
      return res.status(404).json({ success: false, message: "No account was found for this mobile number." });
    }

    const resetRes = await db.query('SELECT * FROM password_resets WHERE user_id = $1;', [user.id]);
    if (!resetRes.rows.length) {
      return res.status(400).json({ success: false, message: "No active OTP request found. Please request a new OTP." });
    }

    const resetRecord = resetRes.rows[0];
    const createdTime = Number(resetRecord.created_at || 0);
    const expirationMs = 10 * 60 * 1000; // 10 minutes overall window

    if (Date.now() - createdTime > expirationMs) {
      return res.status(400).json({ success: false, message: "OTP has expired. Please request a new OTP." });
    }

    const isVerified = resetRecord.is_verified === true || resetRecord.is_verified === 1 || resetRecord.is_verified === 'true';
    const isOtpMatch = inputOtp && resetRecord.otp === inputOtp;

    if (!isVerified && !isOtpMatch) {
      return res.status(400).json({ success: false, message: "OTP is incorrect. Please check and try again." });
    }

    // Update password securely using bcrypt
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    await db.query('UPDATE users SET password = $1 WHERE id = $2;', [hashedPassword, user.id]);

    // Immediately delete / invalidate OTP record after successful reset
    await db.query('DELETE FROM password_resets WHERE user_id = $1;', [user.id]);

    res.json({
      success: true,
      message: "Password reset successfully. Please login with your new password."
    });
  } catch (err) {
    console.error('Reset Password Error:', err);
    res.status(500).json({ success: false, message: "Database server error." });
  }
});

// AUTH 3.5 Forced Change Password (Customer Creates New Permanent Password)
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: "Current password, new password, and confirm password are required." });
    }

    // Verify customer's current / temporary password
    if (!checkPasswordMatch(req.user.password, currentPassword.trim())) {
      return res.status(400).json({ success: false, message: "Current password is incorrect." });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: "New password and confirm password do not match." });
    }

    if (newPassword.trim().length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters long." });
    }

    // New password MUST be different from current password
    if (checkPasswordMatch(req.user.password, newPassword.trim())) {
      return res.status(400).json({ success: false, message: "New password must be different from the current password." });
    }

    const hashedPassword = bcrypt.hashSync(newPassword.trim(), 10);

    await db.query(
      `UPDATE users SET password = $1, password_change_required = false, temp_password_expires_at = NULL WHERE id = $2;`,
      [hashedPassword, req.user.id]
    );

    const updatedUserRes = await db.query('SELECT * FROM users WHERE id = $1;', [req.user.id]);
    const userSafe = sanitizeUser(updatedUserRes.rows[0]);

    res.json({
      success: true,
      user: userSafe,
      message: "Password changed successfully."
    });
  } catch (err) {
    console.error('Change Password Error:', err);
    res.status(500).json({ success: false, message: "Unable to change password. Please try again." });
  }
});

// AUTH 4. Get Current User Profile (Me)
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  const userRes = await db.query('SELECT * FROM users WHERE id = $1;', [req.user.id]);
  res.json({
    success: true,
    user: sanitizeUser(userRes.rows[0] || req.user)
  });
});

// AUTH 5. Logout User
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  if (req.token) {
    await db.query('DELETE FROM tokens WHERE token = $1;', [req.token]);
  }
  res.json({ success: true, message: "Logged out successfully." });
});

// AUTH 6. Update Activity Timestamp (For explicit session extension)
app.post('/api/auth/activity', authenticateToken, async (req, res) => {
  const now = Date.now();
  if (req.token && req.user && req.user.role === 'CUSTOMER') {
    await db.query('UPDATE tokens SET last_activity = $1 WHERE token = $2;', [now, req.token]);
  }
  res.json({ success: true, timestamp: now });
});

// =========================================================================
// CUSTOMER PROFILE, CART & FAVORITES
// =========================================================================

app.get('/api/profile', authenticateToken, async (req, res) => {
  const userRes = await db.query('SELECT * FROM users WHERE id = $1;', [req.user.id]);
  res.json({ success: true, data: sanitizeUser(userRes.rows[0] || req.user) });
});

app.put('/api/profile', authenticateToken, async (req, res) => {
  try {
    const { name, email, address, sound_enabled } = req.body;
    const userRes = await db.query('SELECT * FROM users WHERE id = $1;', [req.user.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User profile not found." });
    }

    const u = userRes.rows[0];
    const newName = name ? name.trim() : u.name;
    const newEmail = email !== undefined ? email.trim() : u.email;
    const newAddress = address !== undefined ? address.trim() : u.address;
    const newSound = sound_enabled !== undefined ? Boolean(sound_enabled) : u.sound_enabled;

    await db.query(
      'UPDATE users SET name = $1, email = $2, address = $3, sound_enabled = $4 WHERE id = $5;',
      [newName, newEmail, newAddress, newSound, req.user.id]
    );

    const updatedRes = await db.query('SELECT * FROM users WHERE id = $1;', [req.user.id]);
    res.json({ success: true, data: sanitizeUser(updatedRes.rows[0]), message: "Profile details updated successfully." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Database update error." });
  }
});

app.patch('/api/profile/sound-settings', authenticateToken, async (req, res) => {
  const sound_enabled = Boolean(req.body.sound_enabled);
  await db.query('UPDATE users SET sound_enabled = $1 WHERE id = $2;', [sound_enabled, req.user.id]);
  res.json({ success: true, sound_enabled: sound_enabled, message: `Notification sound ${sound_enabled ? 'enabled' : 'disabled'}.` });
});

// POST /api/profile/photo - Upload or update user profile photo
app.post('/api/profile/photo', authenticateToken, async (req, res) => {
  try {
    const { photo } = req.body;
    if (!photo || typeof photo !== 'string') {
      return res.status(400).json({ success: false, message: "No image file provided." });
    }

    const trimmedPhoto = photo.trim();

    // Validate image MIME type (JPG, JPEG, PNG, WEBP)
    const validHeaderPattern = /^data:image\/(jpeg|jpg|png|webp);base64,/i;
    if (!validHeaderPattern.test(trimmedPhoto) && !trimmedPhoto.startsWith('/') && !trimmedPhoto.startsWith('http')) {
      return res.status(400).json({
        success: false,
        message: "Invalid image format. Only JPG, JPEG, PNG, and WEBP formats are allowed."
      });
    }

    // Validate maximum file size (~5MB raw image limit)
    if (trimmedPhoto.length > 7 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: "File size exceeds 5MB limit. Please choose a smaller image."
      });
    }

    // Save profile photo to user DB record
    await db.query('UPDATE users SET profile_photo = $1 WHERE id = $2;', [trimmedPhoto, req.user.id]);

    const updatedUserRes = await db.query('SELECT * FROM users WHERE id = $1;', [req.user.id]);
    const userSafe = sanitizeUser(updatedUserRes.rows[0]);

    res.json({
      success: true,
      profile_photo: userSafe.profile_photo,
      user: userSafe,
      message: "Profile photo updated successfully!"
    });
  } catch (err) {
    console.error('Error updating profile photo:', err);
    res.status(500).json({ success: false, message: "Failed to update profile photo." });
  }
});

// DELETE /api/profile/photo - Remove user profile photo
app.delete('/api/profile/photo', authenticateToken, async (req, res) => {
  try {
    await db.query('UPDATE users SET profile_photo = NULL WHERE id = $1;', [req.user.id]);

    const updatedUserRes = await db.query('SELECT * FROM users WHERE id = $1;', [req.user.id]);
    const userSafe = sanitizeUser(updatedUserRes.rows[0]);

    res.json({
      success: true,
      user: userSafe,
      message: "Profile photo removed successfully!"
    });
  } catch (err) {
    console.error('Error removing profile photo:', err);
    res.status(500).json({ success: false, message: "Failed to remove profile photo." });
  }
});

app.get('/api/cart', authenticateToken, async (req, res) => {
  const userRes = await db.query('SELECT cart FROM users WHERE id = $1;', [req.user.id]);
  let cart = [];
  try { cart = typeof userRes.rows[0]?.cart === 'string' ? JSON.parse(userRes.rows[0].cart) : (userRes.rows[0]?.cart || []); } catch (e) { }
  res.json({ success: true, data: cart });
});

app.post('/api/cart', authenticateToken, async (req, res) => {
  const cartJson = JSON.stringify(Array.isArray(req.body.cart) ? req.body.cart : []);
  await db.query('UPDATE users SET cart = $1 WHERE id = $2;', [cartJson, req.user.id]);
  res.json({ success: true, data: Array.isArray(req.body.cart) ? req.body.cart : [] });
});

app.get('/api/favorites', authenticateToken, async (req, res) => {
  const userRes = await db.query('SELECT favorites FROM users WHERE id = $1;', [req.user.id]);
  let favorites = [];
  try { favorites = typeof userRes.rows[0]?.favorites === 'string' ? JSON.parse(userRes.rows[0].favorites) : (userRes.rows[0]?.favorites || []); } catch (e) { }
  res.json({ success: true, data: favorites });
});

app.post('/api/favorites', authenticateToken, async (req, res) => {
  const favJson = JSON.stringify(Array.isArray(req.body.favorites) ? req.body.favorites : []);
  await db.query('UPDATE users SET favorites = $1 WHERE id = $2;', [favJson, req.user.id]);
  res.json({ success: true, data: Array.isArray(req.body.favorites) ? req.body.favorites : [] });
});

// =========================================================================
// SETTINGS & MENU API
// =========================================================================

app.get('/api/settings', async (req, res) => {
  try {
    const sRes = await db.query('SELECT * FROM settings WHERE id = 1;');
    if (sRes.rows.length === 0) {
      return res.json({ success: true, settings: {}, data: {} });
    }
    const s = sRes.rows[0];
    if (typeof s.referral === 'string') {
      try { s.referral = JSON.parse(s.referral); } catch (e) { }
    }

    // Conditional caching so the 2-second live polling does not re-download the
    // base64 QR scanner image every poll — it revalidates and only transfers the
    // full payload when the settings (e.g. a new scanner) actually changed.
    const body = JSON.stringify({ success: true, settings: s, data: s });
    const etag = '"' + String(s.upi_qr_updated_at || '') + '-' + crypto.createHash('md5').update(body).digest('hex').slice(0, 10) + '"';
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.set('ETag', etag);
    res.set('Cache-Control', 'no-cache');
    res.send(body);
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch settings." });
  }
});

const handleSaveSettings = async (req, res) => {
  try {
    const sRes = await db.query('SELECT * FROM settings WHERE id = 1;');
    const s = sRes.rows[0] || {};

    const {
      hotel_name, hotel_logo, phone, address, open_time, close_time,
      holidays, upi_id, upi_name, upi_qr_code, is_open, is_qr_pay_enabled,
      is_phonepe_enabled, description, referral,
      bank_name, bank_account, bank_ifsc, account_holder
    } = req.body;

    // Validate format of non-empty fields if provided
    const timeFormatRegex = /^(0?[1-9]|1[0-2]):[0-5][0-9]\s*(AM|PM|am|pm)$|^(0?[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/i;
    if (open_time !== undefined && open_time !== null) {
      const openStr = String(open_time).trim();
      if (openStr !== '' && !timeFormatRegex.test(openStr)) {
        return res.status(400).json({ success: false, message: "Invalid Opening Time format. Please enter a valid time (e.g. 06:00 AM or 06:00)." });
      }
    }
    if (close_time !== undefined && close_time !== null) {
      const closeStr = String(close_time).trim();
      if (closeStr !== '' && !timeFormatRegex.test(closeStr)) {
        return res.status(400).json({ success: false, message: "Invalid Closing Time format. Please enter a valid time (e.g. 10:00 PM or 22:00)." });
      }
    }

    // Validate Official Hotel UPI VPA Address if provided non-empty
    if (upi_id !== undefined && upi_id !== null) {
      const upiStr = String(upi_id).trim();
      const upiVpaRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9.\-_]{2,64}$/i;
      if (upiStr !== '' && !upiVpaRegex.test(upiStr)) {
        return res.status(400).json({ success: false, message: "Please enter a valid UPI VPA address." });
      }
    }

    const newHotelName = hotel_name !== undefined && hotel_name !== null ? hotel_name : (s.hotel_name || '');
    const newHotelLogo = hotel_logo !== undefined ? hotel_logo : s.hotel_logo;
    const newPhone = phone !== undefined && phone !== null ? phone : (s.phone || '');
    const newAddress = address !== undefined && address !== null ? address : (s.address || '');
    const newOpenTime = open_time !== undefined && open_time !== null ? open_time : (s.open_time || '');
    const newCloseTime = close_time !== undefined && close_time !== null ? close_time : (s.close_time || '');
    const newHolidays = holidays !== undefined && holidays !== null ? holidays : (s.holidays || '');
    const newUpiId = upi_id !== undefined && upi_id !== null ? upi_id : (s.upi_id || '9392974900@ybl');
    const newUpiName = upi_name !== undefined ? upi_name : (s.upi_name || newHotelName);

    const newBankName = bank_name !== undefined && bank_name !== null ? String(bank_name).trim() : (s.bank_name || '');
    const newBankAccount = bank_account !== undefined && bank_account !== null ? String(bank_account).trim() : (s.bank_account || '');
    const newBankIfsc = bank_ifsc !== undefined && bank_ifsc !== null ? String(bank_ifsc).trim().toUpperCase() : (s.bank_ifsc || '');
    const newAccountHolder = account_holder !== undefined && account_holder !== null ? String(account_holder).trim() : (s.account_holder || newUpiName);

    // QR scanner image is stored directly as a base64 data URL inside PostgreSQL
    // (never as an ephemeral file path). This guarantees the scanner remains visible
    // to the owner and customers even after server restarts / redeploys, and the old
    // scanner keeps displaying until the owner uploads a replacement.
    let rawQrCode = s.upi_qr_code || '';
    if (req.body.remove_qr === true) {
      rawQrCode = '';
    } else if (upi_qr_code && typeof upi_qr_code === 'string' && upi_qr_code.trim().length > 0) {
      const trimmedQr = upi_qr_code.trim();
      if (trimmedQr.startsWith('data:image/')) {
        const b64Marker = trimmedQr.indexOf('base64,');
        if (b64Marker !== -1) {
          const b64Length = trimmedQr.length - (b64Marker + 7);
          if (b64Length >= 50) {
            rawQrCode = trimmedQr;
          }
        }
      } else {
        rawQrCode = trimmedQr;
      }
    }
    const newUpiQrCode = rawQrCode;
    const qrChanged = newUpiQrCode !== (s.upi_qr_code || '');
    const newQrUpdatedAt = qrChanged ? Date.now() : (s.upi_qr_updated_at || Date.now());

    const newIsOpen = is_open !== undefined ? Boolean(is_open) : (s.is_open !== false);
    const newIsQrPay = is_qr_pay_enabled !== undefined ? Boolean(is_qr_pay_enabled) : (s.is_qr_pay_enabled !== false);
    const newIsPhonepe = is_phonepe_enabled !== undefined ? Boolean(is_phonepe_enabled) : (s.is_phonepe_enabled !== false);
    const newDesc = description !== undefined ? description : s.description;

    let newRef = s.referral;
    if (referral) {
      if (referral.referrer_reward !== undefined) {
        const rewardInput = referral.referrer_reward;
        const numReward = Number(rewardInput);
        if (
          rewardInput === null ||
          rewardInput === undefined ||
          rewardInput === '' ||
          isNaN(numReward) ||
          !isFinite(numReward) ||
          numReward <= 0
        ) {
          return res.status(400).json({
            success: false,
            message: "Invalid Referral Amount. Must be a valid positive monetary value greater than 0."
          });
        }
      }
      let existingRef = typeof s.referral === 'string' ? JSON.parse(s.referral) : (s.referral || {});
      newRef = { ...existingRef, ...referral };
    }

    await db.query(
      `INSERT INTO settings (
        id, hotel_name, hotel_logo, phone, address, open_time, close_time, 
        holidays, upi_id, upi_name, upi_qr_code, is_open, is_qr_pay_enabled, 
        is_phonepe_enabled, description, referral, upi_qr_updated_at,
        bank_name, bank_account, bank_ifsc, account_holder
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      ON CONFLICT (id) DO UPDATE SET
        hotel_name = EXCLUDED.hotel_name,
        hotel_logo = EXCLUDED.hotel_logo,
        phone = EXCLUDED.phone,
        address = EXCLUDED.address,
        open_time = EXCLUDED.open_time,
        close_time = EXCLUDED.close_time,
        holidays = EXCLUDED.holidays,
        upi_id = EXCLUDED.upi_id,
        upi_name = EXCLUDED.upi_name,
        upi_qr_code = EXCLUDED.upi_qr_code,
        is_open = EXCLUDED.is_open,
        is_qr_pay_enabled = EXCLUDED.is_qr_pay_enabled,
        is_phonepe_enabled = EXCLUDED.is_phonepe_enabled,
        description = EXCLUDED.description,
        referral = EXCLUDED.referral,
        upi_qr_updated_at = EXCLUDED.upi_qr_updated_at,
        bank_name = EXCLUDED.bank_name,
        bank_account = EXCLUDED.bank_account,
        bank_ifsc = EXCLUDED.bank_ifsc,
        account_holder = EXCLUDED.account_holder;`,
      [
        newHotelName, newHotelLogo, newPhone, newAddress, newOpenTime, newCloseTime,
        newHolidays, newUpiId, newUpiName, newUpiQrCode, newIsOpen, newIsQrPay,
        newIsPhonepe, newDesc, typeof newRef === 'object' ? JSON.stringify(newRef) : newRef,
        newQrUpdatedAt, newBankName, newBankAccount, newBankIfsc, newAccountHolder
      ]
    );

    const updated = await db.query('SELECT * FROM settings WHERE id = 1;');
    const updatedSettings = updated.rows[0];
    if (typeof updatedSettings.referral === 'string') {
      try { updatedSettings.referral = JSON.parse(updatedSettings.referral); } catch (e) { }
    }

    // Real-Time Notification on Hotel Open/Close Status Toggle
    if (s && s.is_open !== undefined && Boolean(s.is_open) !== newIsOpen) {
      const statusText = newIsOpen ? 'OPEN 🟢' : 'CLOSED 🔴';
      const notifObj = {
        id: 'notif_' + Date.now(),
        target_role: 'CUSTOMER',
        customer_id: null,
        title: `Tiffin Center is now ${statusText}`,
        message: newIsOpen ? "Sri Lakshmi Annapurna Tiffin Center is now OPEN and accepting orders!" : "Sri Lakshmi Annapurna Tiffin Center is now CLOSED.",
        type: 'INFO',
        is_read: false,
        date_time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
      };
      await createAndDispatchNotification(notifObj);
    }

    res.json({ success: true, settings: updatedSettings, data: updatedSettings, message: "Business settings updated successfully." });
  } catch (err) {
    console.error('Update Settings Error:', err);
    res.status(500).json({ success: false, message: "Database error updating business settings." });
  }
};

app.put('/api/settings', authenticateToken, requireRole('OWNER'), handleSaveSettings);
app.post('/api/settings', authenticateToken, requireRole('OWNER'), handleSaveSettings);
app.patch('/api/settings', authenticateToken, requireRole('OWNER'), handleSaveSettings);

// =========================================================================
// POSTGRESQL / DATABASE BACKUP EXPORT ENDPOINT (ADMIN/OWNER ONLY)
// =========================================================================
const { exportDatabase } = require('./backup_postgres');

app.get('/api/admin/export-database', authenticateToken, async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'OWNER') {
      return res.status(403).json({ success: false, message: "Access denied. Owner authorization required." });
    }

    const backupResult = await exportDatabase();
    const format = (req.query.format || 'json').toLowerCase();

    if (format === 'sql') {
      const sqlPath = backupResult.sqlPath;
      res.setHeader('Content-Type', 'application/sql');
      res.setHeader('Content-Disposition', `attachment; filename="postgres_backup_${Date.now()}.sql"`);
      return res.sendFile(sqlPath);
    } else {
      const jsonPath = backupResult.jsonPath;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="postgres_backup_${Date.now()}.json"`);
      return res.sendFile(jsonPath);
    }
  } catch (err) {
    console.error('Export Database Error:', err);
    res.status(500).json({ success: false, message: "Failed to export database backup: " + err.message });
  }
});

const defaultTiffinsList = [
  { id: "tf_1", name: "Idly (4 Pieces)", description: "Steaming soft rice cakes served with hot sambar and freshly ground coconut chutney.", price: 40, category: "Breakfast", image: "/images/idly_sambar.png", is_available: true },
  { id: "tf_2", name: "Medu Vada (2 Pieces)", description: "Crispy fried lentil doughnuts seasoned with pepper, curry leaves, served with chutneys.", price: 45, category: "Breakfast", image: "/images/medu_vada.png", is_available: true },
  { id: "tf_3", name: "Masala Dosa", description: "Golden crispy crepe smeared with red chutney and stuffed with spiced potato masala.", price: 70, category: "Breakfast", image: "/images/masala_dosa.png", is_available: true },
  { id: "tf_4", name: "Puri Sagu (3 Pieces)", description: "Fluffy puffed fried puri served with aromatic spicy potato and vegetable sagu curry.", price: 60, category: "Breakfast", image: "/images/puri_sagu.png", is_available: true },
  { id: "tf_5", name: "Ghee Ven Pongal", description: "Classic rice and moong dal porridge tempered with pure ghee, cashews, cumin, and pepper.", price: 55, category: "Breakfast", image: "https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?auto=format&fit=crop&w=500&q=80", is_available: true },
  { id: "tf_6", name: "Hot Rava Upma", description: "Savory roasted semolina cooked with mustard seeds, veggies, cashews, served with coconut chutney.", price: 35, category: "Breakfast", image: "https://images.unsplash.com/photo-1589301760014-d929f3979dbc?auto=format&fit=crop&w=500&q=80", is_available: true },
  { id: "tf_7", name: "Plain Dosa", description: "Thin and crispy South Indian rice crepe served with flavorful sambar and 2 chutneys.", price: 50, category: "Breakfast", image: "https://images.unsplash.com/photo-1668236543090-82eba5ee5976?auto=format&fit=crop&w=500&q=80", is_available: true },
  { id: "tf_8", name: "South Indian Mini Meals", description: "Authentic thali platter with Steamed Rice, Sambar, Rasam, Vegetable Poriyal, Curd, Papad, and Payasam.", price: 110, category: "Lunch", image: "/images/south_indian_meals.png", is_available: true },
  { id: "tf_9", name: "Tangy Lemon Rice", description: "Fragrant rice tossed with fresh lemon juice, crunchy peanuts, curry leaves, and green chillies.", price: 45, category: "Lunch", image: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=500&q=80", is_available: true },
  { id: "tf_10", name: "Seasoned Curd Rice", description: "Cooling soothing curd rice tempered with mustard, pomegranates, green chillies, and ginger.", price: 50, category: "Lunch", image: "https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?auto=format&fit=crop&w=500&q=80", is_available: true },
  { id: "tf_11", name: "Spicy Tomato Rice", description: "Flavorful spicy tomato cooked rice infused with South Indian spices, served with onion raita.", price: 50, category: "Lunch", image: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=500&q=80", is_available: true },
  { id: "tf_12", name: "Chapati (2 Pieces + Kurma)", description: "Soft whole wheat chapatis served with aromatic mixed vegetable spicy kurma curry.", price: 50, category: "Dinner", image: "https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?auto=format&fit=crop&w=500&q=80", is_available: true }
];

async function seedDefaultTiffins() {
  for (let t of defaultTiffinsList) {
    try {
      await db.query(
        `INSERT INTO tiffins (id, name, description, price, category, image, is_available)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING;`,
        [t.id, t.name, t.description, t.price, t.category, t.image, t.is_available]
      );
    } catch (e) { }
  }
}

async function seedOwnerUser() {
  try {
    await db.query(
      `INSERT INTO users (id, name, mobile, password, role, email, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING;`,
      ['usr_owner_1', 'Lakshmi Narayana (Owner)', '9392874900', '9392874900', 'OWNER', 'owner@annapurna.com', '#42, Temple Road, Bengaluru, KA']
    );
  } catch (e) { }
}

const getMenuHandler = async (req, res) => {
  let tRes = await db.query('SELECT * FROM tiffins ORDER BY created_at ASC;');
  if (!tRes.rows || tRes.rows.length === 0) {
    console.log('Menu table empty — seeding default tiffins list...');
    await seedDefaultTiffins();
    try {
      const migrate = require('./migrate_to_postgres');
      await migrate();
    } catch (e) { }
    tRes = await db.query('SELECT * FROM tiffins ORDER BY created_at ASC;');
  }
  res.json({ success: true, data: tRes.rows || [] });
};

app.get('/api/menu', getMenuHandler);
app.get('/api/tiffins', getMenuHandler);

app.post('/api/menu', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const { name, description, price, category, image, is_available } = req.body;
  if (!name || price === undefined) {
    return res.status(400).json({ success: false, message: "Item name and price are required." });
  }
  const id = 'tf_' + Date.now();
  const savedImage = (await saveBase64Image(image, 'tiffins')) || image || '/images/idly_sambar.png';
  await db.query(
    'INSERT INTO tiffins (id, name, description, price, category, image, is_available) VALUES ($1, $2, $3, $4, $5, $6, $7);',
    [id, name.trim(), (description || '').trim(), Number(price), category || 'Breakfast', savedImage, is_available !== false]
  );
  const newItem = await db.query('SELECT * FROM tiffins WHERE id = $1;', [id]);
  
  // Real-Time Notification to Customers
  const notifObj = {
    id: 'notif_' + Date.now(),
    target_role: 'CUSTOMER',
    customer_id: null,
    title: 'New Tiffin Available',
    message: `${name.trim()} has been added to today's menu.`,
    type: 'MENU',
    is_read: false,
    date_time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
  };
  await createAndDispatchNotification(notifObj);

  res.json({ success: true, data: newItem.rows[0], message: "Tiffin item added to menu successfully." });
});

app.put('/api/menu/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const { id } = req.params;
  const { name, description, price, category, image, is_available } = req.body;
  const savedImage = (await saveBase64Image(image, 'tiffins')) || image || '/images/idly_sambar.png';
  await db.query(
    'UPDATE tiffins SET name = $1, description = $2, price = $3, category = $4, image = $5, is_available = $6 WHERE id = $7;',
    [name.trim(), (description || '').trim(), Number(price), category, savedImage, Boolean(is_available), id]
  );
  const updated = await db.query('SELECT * FROM tiffins WHERE id = $1;', [id]);
  res.json({ success: true, data: updated.rows[0], message: "Tiffin item updated successfully." });
});

app.patch('/api/menu/:id/availability', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const { id } = req.params;
  const { is_available } = req.body;
  await db.query('UPDATE tiffins SET is_available = $1 WHERE id = $2;', [Boolean(is_available), id]);
  const updated = await db.query('SELECT * FROM tiffins WHERE id = $1;', [id]);
  res.json({ success: true, data: updated.rows[0], message: "Availability updated." });
});

app.delete('/api/menu/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const { id } = req.params;
  await db.query('DELETE FROM tiffins WHERE id = $1;', [id]);
  res.json({ success: true, message: "Item deleted from menu." });
});

// =========================================================================
// ORDERS & PAYMENTS API
// =========================================================================

app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    let queryStr = 'SELECT * FROM orders ORDER BY created_at DESC;';
    let params = [];
    if (req.user.role === 'CUSTOMER') {
      queryStr = 'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC;';
      params = [req.user.id];
    }
    const oRes = await db.query(queryStr, params);
    let revMap = new Map();
    try {
      let revQuery = 'SELECT * FROM reviews ORDER BY created_at DESC;';
      let revParams = [];
      if (req.user.role === 'CUSTOMER') {
        revQuery = 'SELECT * FROM reviews WHERE customer_id = $1 ORDER BY created_at DESC;';
        revParams = [req.user.id];
      }
      const revRes = await db.query(revQuery, revParams);
      (revRes.rows || []).forEach(r => {
        if (r.order_number && !revMap.has(r.order_number)) {
          revMap.set(r.order_number, r);
        }
      });
    } catch (rErr) { }

    const parsedOrders = oRes.rows.map(o => {
      if (typeof o.items === 'string') {
        try { o.items = JSON.parse(o.items); } catch (e) { o.items = []; }
      }
      const screenshot = o.payment_screenshot || o.screenshot_url || '';
      o.payment_screenshot = screenshot;
      o.screenshot_url = screenshot;
      o.review = revMap.get(o.order_number) || null;
      if (!o.pickup_pin) {
        const legacyPin = String(Math.floor(1000 + Math.random() * 9000));
        o.pickup_pin = legacyPin;
        db.query('UPDATE orders SET pickup_pin = $1 WHERE id = $2 AND (pickup_pin IS NULL OR pickup_pin = \'\');', [legacyPin, o.id]).catch(() => { });
      }
      o.pickup_pin_verified = Boolean(o.pickup_pin_verified);
      return o;
    });
    res.json({ success: true, data: parsedOrders });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error fetching orders." });
  }
});

// GET /api/customer/queue-progress - Dedicated Customer Queue Progress API
app.get('/api/customer/queue-progress', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const custId = req.user.id;
    
    // Fetch all active orders in kitchen queue
    const activeRes = await db.query(
      "SELECT id, order_number, customer_id, order_status, created_at, pickup_pin FROM orders WHERE order_status IN ('Received', 'Preparing', 'Ready') ORDER BY created_at ASC, id ASC;"
    );
    const activeOrders = activeRes.rows || [];

    const formatToken = (o) => {
      if (!o) return '';
      if (o.token_number) return o.token_number;
      if (o.queue_token) return o.queue_token;
      const num = (o.order_number || o.id || '').replace(/\D/g, '');
      return 'Q-' + (num || o.order_number || o.id);
    };

    // Find customer's active orders (most recent active order if multiple)
    const customerActiveOrders = activeOrders.filter(o => String(o.customer_id) === String(custId));

    if (customerActiveOrders.length === 0) {
      return res.json({
        success: true,
        data: {
          has_active_order: false,
          message: "You don't have an active order in the queue."
        }
      });
    }

    // Pick customer's latest active order
    const custOrder = customerActiveOrders[customerActiveOrders.length - 1];
    const custToken = formatToken(custOrder);

    // Determine currently serving token (order in 'Preparing' status, or earliest active order)
    const preparingOrder = activeOrders.find(o => o.order_status === 'Preparing') || activeOrders[0];
    const currentlyServingToken = preparingOrder ? formatToken(preparingOrder) : custToken;

    // Calculate orders ahead: count active orders placed BEFORE customer's active order
    const custOrderIndex = activeOrders.findIndex(o => String(o.id) === String(custOrder.id));
    const ordersAhead = custOrderIndex > 0 ? custOrderIndex : 0;

    // Safe, anonymous active queue representation (no PII)
    const activeQueueList = activeOrders.map((o, idx) => ({
      position: idx + 1,
      token: formatToken(o),
      status: o.order_status,
      is_customer: String(o.id) === String(custOrder.id)
    }));

    return res.json({
      success: true,
      data: {
        has_active_order: true,
        customer_token: custToken,
        order_id: custOrder.id,
        order_number: custOrder.order_number,
        order_status: custOrder.order_status,
        pickup_pin: custOrder.pickup_pin || '',
        currently_serving_token: currentlyServingToken,
        currently_serving_order_number: preparingOrder ? preparingOrder.order_number : custOrder.order_number,
        currently_serving_status: preparingOrder ? preparingOrder.order_status : custOrder.order_status,
        orders_ahead: ordersAhead,
        active_queue_list: activeQueueList
      }
    });
  } catch (err) {
    console.error("Error in /api/customer/queue-progress:", err.message);
    res.status(500).json({ success: false, message: "Error loading queue progress." });
  }
});


// POST /api/orders/:id/reorder - Perform Complete End-to-End Backend Database Reorder Operation
app.post('/api/orders/:id/reorder', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const sRes = await db.query('SELECT is_open FROM settings WHERE id = 1;');
    const settings = sRes.rows[0] || {};
    if (settings.is_open === false) {
      return res.status(400).json({ success: false, message: "Hotel is currently closed. Reorders are not being accepted at this time." });
    }

    const targetOrderId = req.params.id;

    // Backend Customer Ownership Guard: Ensure target order belongs to authenticated customer
    const orderRes = await db.query('SELECT * FROM orders WHERE (id = $1 OR order_number = $1) AND customer_id = $2;', [targetOrderId, req.user.id]);
    if (!orderRes.rows.length) {
      return res.status(403).json({ success: false, message: "Access denied. Order not found or does not belong to your account." });
    }

    const previousOrder = orderRes.rows[0];

    // Backend Order Status Guard: Reorder is allowed ONLY for completed orders
    const statusClean = (previousOrder.order_status || '').toLowerCase();
    const isCompleted = ['completed', 'delivered'].includes(statusClean);
    if (!isCompleted) {
      return res.status(400).json({
        success: false,
        message: `❌ Cannot reorder. Order #${previousOrder.order_number} has not reached Completed status (Current status: "${previousOrder.order_status}"). Reorder is available only after order completion.`
      });
    }
    let prevItems = previousOrder.items || [];
    if (typeof prevItems === 'string') {
      try { prevItems = JSON.parse(prevItems); } catch (e) { prevItems = []; }
    }

    if (!prevItems.length) {
      return res.status(400).json({ success: false, message: "Previous order has no items to reorder." });
    }

    // Fetch Current Menu from Database (Live Prices & Live Availability)
    const tiffinRes = await db.query('SELECT * FROM tiffins;');
    const currentMenu = tiffinRes.rows || [];

    const reorderableItems = [];
    const unavailableItems = [];

    prevItems.forEach(item => {
      const targetId = item.tiffin_id || item.id;
      const matched = currentMenu.find(m => m.id === targetId || (m.name && item.name && m.name.toLowerCase() === item.name.toLowerCase()));

      const isAvailable = matched ? (matched.is_available === true || matched.is_available === 1 || matched.is_available === 'true') : false;

      if (matched && isAvailable) {
        reorderableItems.push({
          tiffin_id: matched.id,
          id: matched.id,
          name: matched.name,
          price: Number(matched.price), // ALWAYS USE CURRENT PRICE
          quantity: Number(item.quantity || 1)
        });
      } else {
        unavailableItems.push(item.name || 'Item');
      }
    });

    if (!reorderableItems.length) {
      return res.status(400).json({
        success: false,
        message: `Cannot create reorder: All items from Order #${previousOrder.order_number} are currently unavailable or deleted.`
      });
    }

    // Calculate Grand Total using CURRENT prices
    let grandTotal = 0;
    reorderableItems.forEach(item => {
      grandTotal += Number(item.price) * Number(item.quantity);
    });

    // Generate NEW Unique Order Number & Order UUID
    const orderSeq = await db.getNextCounter('order_counter');
    const newOrderNum = 'TF' + orderSeq;
    const newOrderId = 'ord_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const pickupPin = String(Math.floor(1000 + Math.random() * 9000));
    const nowIso = new Date().toISOString();

    const orderType = req.body.order_type || previousOrder.order_type || 'Takeaway';
    const deliveryAddress = req.body.delivery_address || req.user.address || previousOrder.delivery_address || '';
    const notes = req.body.notes || `Reordered from #${previousOrder.order_number}`;
    const paymentMethod = req.body.payment_method || previousOrder.payment_method || 'Cash';
    const utrNumber = req.body.utr_number || null;
    const rawScreenshot = req.body.payment_screenshot || null;

    let savedScreenshotUrl = null;
    if (rawScreenshot) {
      if (typeof rawScreenshot === 'string' && rawScreenshot.startsWith('data:image/')) {
        try { savedScreenshotUrl = await saveBase64Image(rawScreenshot, 'screenshots'); } catch (e) { savedScreenshotUrl = null; }
      } else {
        savedScreenshotUrl = rawScreenshot;
      }
    }
    const permanentScreenshot = (rawScreenshot && typeof rawScreenshot === 'string' && rawScreenshot.startsWith('data:image/'))
      ? rawScreenshot
      : (savedScreenshotUrl || null);

    const isOnlinePay = paymentMethod === 'UPI' || paymentMethod === 'QRPay' || paymentMethod === 'PhonePe' || paymentMethod.includes('UPI');
    const paymentStatus = (isOnlinePay && (utrNumber || permanentScreenshot)) ? 'Pending Verification' : 'Pending';

    // Execute Atomic Transaction to Save New Order to Database
    let createdOrder = null;
    await db.executeTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO orders (
          id, order_number, customer_id, customer_name, customer_mobile, 
          order_type, delivery_address, notes, total_amount, used_wallet_amount, 
          net_amount, payment_method, payment_status, order_status, items,
          utr_number, payment_screenshot, screenshot_url, pickup_pin, pickup_pin_verified, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21);`,
        [
          newOrderId, newOrderNum, req.user.id, req.user.name, req.user.mobile,
          orderType, deliveryAddress, notes, grandTotal, 0, grandTotal,
          paymentMethod, paymentStatus, 'Received', JSON.stringify(reorderableItems),
          utrNumber, permanentScreenshot, permanentScreenshot, pickupPin, false, nowIso
        ]
      );

      // Create Payment Record for the NEW Order
      const newPayId = 'pay_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      await tx.query(
        `INSERT INTO payments (id, order_number, order_id, customer_id, customer_name, customer_mobile, amount, payment_method, payment_status, utr_number, screenshot_url, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
        [newPayId, newOrderNum, newOrderId, req.user.id, req.user.name, req.user.mobile, grandTotal, paymentMethod, paymentStatus, utrNumber, permanentScreenshot, `Reorder Payment for Order #${newOrderNum}`]
      );

      // Notify Owner of NEW Order
      await createAndDispatchNotification({
        target_role: 'OWNER',
        title: 'New Reorder Received',
        message: `New Reorder #${newOrderNum} placed by ${req.user.name} (₹${grandTotal}).`,
        type: 'ORDER',
        priority: 'HIGH',
        action_url: '/#secOwnerOrders',
        related_order_id: newOrderId
      });

      // Notify Customer with Pickup PIN
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: req.user.id,
        title: 'Reorder Placed Successfully',
        message: `🔐 Your Pickup PIN for New Reorder #${newOrderNum} is ${pickupPin}. Show this PIN when collecting your order.`,
        type: 'QUEUE',
        priority: 'NORMAL',
        action_url: '/#secQueueProgress',
        related_order_id: newOrderId
      });

      const createdRes = await tx.query('SELECT * FROM orders WHERE id = $1;', [newOrderId]);
      createdOrder = createdRes.rows[0];
    });

    res.json({
      success: true,
      message: `🎉 New Reorder #${newOrderNum} created successfully!`,
      data: {
        new_order: createdOrder,
        original_order_number: previousOrder.order_number,
        unavailableItems
      }
    });
  } catch (err) {
    console.error('Backend Reorder Error:', err);
    res.status(500).json({ success: false, message: "Database server error creating reorder." });
  }
});

// POST /api/orders/:id/reorder-items - Secure Backend Customer Ownership & Items Verification for Reorder
app.post('/api/orders/:id/reorder-items', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const orderId = req.params.id;
    const orderRes = await db.query('SELECT * FROM orders WHERE (id = $1 OR order_number = $1) AND customer_id = $2;', [orderId, req.user.id]);

    if (!orderRes.rows.length) {
      return res.status(403).json({ success: false, message: "Access denied. Order not found or does not belong to your account." });
    }

    const order = orderRes.rows[0];

    // Backend Order Status Guard: Reorder items allowed ONLY for completed orders
    const statusClean = (order.order_status || '').toLowerCase();
    const isCompleted = ['completed', 'delivered'].includes(statusClean);
    if (!isCompleted) {
      return res.status(400).json({
        success: false,
        message: `❌ Reorder is available ONLY AFTER the order is completed. Order #${order.order_number} status is currently "${order.order_status}".`
      });
    }
    let items = order.items || [];
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch (e) { items = []; }
    }

    // Query active menu to match current prices and availability
    const tiffinRes = await db.query('SELECT * FROM tiffins;');
    const currentMenu = tiffinRes.rows || [];

    const reorderableItems = [];
    const unavailableItems = [];

    items.forEach(item => {
      const targetId = item.tiffin_id || item.id;
      const matched = currentMenu.find(m => m.id === targetId || (m.name && item.name && m.name.toLowerCase() === item.name.toLowerCase()));

      const isAvailable = matched ? (matched.is_available === true || matched.is_available === 1 || matched.is_available === 'true') : false;

      if (matched && isAvailable) {
        reorderableItems.push({
          id: matched.id,
          name: matched.name,
          price: Number(matched.price),
          image: matched.image || '',
          quantity: Number(item.quantity || 1)
        });
      } else {
        unavailableItems.push(item.name || 'Item');
      }
    });

    res.json({
      success: true,
      data: {
        original_order_number: order.order_number,
        reorderableItems,
        unavailableItems
      }
    });
  } catch (err) {
    console.error('Reorder items error:', err);
    res.status(500).json({ success: false, message: "Error verifying reorder items." });
  }
});

// =========================================================================
// LOYALTY REWARDS SYSTEM BACKEND ENGINE & APIs
// =========================================================================

const DEFAULT_LOYALTY_CONFIG = {
  enabled: true,
  points_per_100: 10,
  spend_unit: 100,
  conversion_points: 100,
  conversion_reward: 10, // 100 points = ₹10 reward
  min_order_spend: 100,
  milestones: [100, 250, 500, 1000]
};

async function processOrderLoyaltyPoints(orderId, dbClient = db) {
  try {
    const oRes = await dbClient.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [orderId]);
    const order = oRes.rows[0];
    if (!order || !order.customer_id) return;

    const statusClean = (order.order_status || '').toLowerCase();
    if (!['completed', 'delivered'].includes(statusClean)) return;

    // Idempotency check: Ensure points are NEVER awarded twice for the same order
    const existingTx = await dbClient.query(
      "SELECT id FROM loyalty_transactions WHERE order_id = $1 AND type = 'EARNED';",
      [order.id]
    );
    if (existingTx.rows && existingTx.rows.length > 0) {
      return; // Already processed
    }

    const eligibleAmount = Number(order.net_amount || order.total_amount || 0);
    if (eligibleAmount < DEFAULT_LOYALTY_CONFIG.spend_unit) return;

    const pointsEarned = Math.floor(eligibleAmount / DEFAULT_LOYALTY_CONFIG.spend_unit) * DEFAULT_LOYALTY_CONFIG.points_per_100;
    if (pointsEarned <= 0) return;

    // Execute atomic update
    const txId = 'ltx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

    const userRes = await dbClient.query(
      'UPDATE users SET loyalty_points = COALESCE(loyalty_points, 0) + $1 WHERE id = $2 RETURNING loyalty_points;',
      [pointsEarned, order.customer_id]
    );

    const newBalance = Number(userRes.rows[0]?.loyalty_points || pointsEarned);

    await dbClient.query(
      `INSERT INTO loyalty_transactions (id, user_id, order_id, order_number, type, points, reward_amount, description, balance_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [
        txId,
        order.customer_id,
        order.id,
        order.order_number,
        'EARNED',
        pointsEarned,
        0,
        `Earned from Order #${order.order_number} (₹${eligibleAmount})`,
        newBalance
      ]
    );

    // Dispatch Real-Time WebSocket & Push Notification to Customer
    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      customer_id: order.customer_id,
      title: '🎁 Loyalty Points Earned!',
      message: `You earned ⭐ ${pointsEarned} Loyalty Points from Order #${order.order_number}.\nYour new balance: ⭐ ${newBalance} Points`,
      type: 'LOYALTY',
      priority: 'HIGH',
      action_url: '/#secCustomerLoyalty',
      related_order_id: order.id
    }, dbClient);

    // Check Milestone Achievements
    for (const milestone of DEFAULT_LOYALTY_CONFIG.milestones) {
      if (newBalance >= milestone) {
        try {
          const mCheck = await dbClient.query(
            'SELECT id FROM loyalty_milestones WHERE user_id = $1 AND milestone_points = $2;',
            [order.customer_id, milestone]
          );
          if (!mCheck.rows || mCheck.rows.length === 0) {
            const mId = 'lms_' + Date.now() + '_' + milestone;
            await dbClient.query(
              'INSERT INTO loyalty_milestones (id, user_id, milestone_points) VALUES ($1, $2, $3);',
              [mId, order.customer_id, milestone]
            );
            const rewardVal = (milestone / DEFAULT_LOYALTY_CONFIG.conversion_points) * DEFAULT_LOYALTY_CONFIG.conversion_reward;
            await createAndDispatchNotification({
              target_role: 'CUSTOMER',
              customer_id: order.customer_id,
              title: '🎉 Loyalty Milestone Reached!',
              message: `Congratulations! You reached ⭐ ${milestone} Loyalty Points! Available reward value: ₹${rewardVal}.`,
              type: 'LOYALTY',
              priority: 'HIGH',
              action_url: '/#secCustomerLoyalty'
            }, dbClient);
          }
        } catch (mErr) {
          // Ignore milestone duplicate if constraint hit
        }
      }
    }
  } catch (err) {
    console.error('Error processing loyalty points for order:', err.message);
  }
}

// GET /api/loyalty/summary - Fetch customer loyalty balance & config
app.get('/api/loyalty/summary', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const userRes = await db.query('SELECT loyalty_points, loyalty_reward_balance FROM users WHERE id = $1;', [req.user.id]);
    const u = userRes.rows[0] || {};
    const points = Number(u.loyalty_points || 0);
    const rewardBalance = Number(u.loyalty_reward_balance || 0);
    const potentialReward = Math.floor(points / DEFAULT_LOYALTY_CONFIG.conversion_points) * DEFAULT_LOYALTY_CONFIG.conversion_reward;

    res.json({
      success: true,
      data: {
        points,
        reward_balance: rewardBalance,
        potential_reward: potentialReward,
        config: DEFAULT_LOYALTY_CONFIG
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error fetching loyalty summary." });
  }
});

// GET /api/loyalty/history - Fetch customer loyalty transactions log
app.get('/api/loyalty/history', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const historyRes = await db.query(
      `SELECT id, type, points, reward_amount, description, balance_after, order_number, created_at
       FROM loyalty_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100;`,
      [req.user.id]
    );
    res.json({ success: true, data: historyRes.rows || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error fetching loyalty history." });
  }
});

// POST /api/loyalty/redeem - Redeem Loyalty Points for Reward Balance
app.post('/api/loyalty/redeem', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const pointsToRedeem = parseInt(req.body.points, 10);
    if (!pointsToRedeem || isNaN(pointsToRedeem) || pointsToRedeem < DEFAULT_LOYALTY_CONFIG.conversion_points) {
      return res.status(400).json({
        success: false,
        message: `Minimum redemption is ${DEFAULT_LOYALTY_CONFIG.conversion_points} points (₹${DEFAULT_LOYALTY_CONFIG.conversion_reward}).`
      });
    }

    if (pointsToRedeem % DEFAULT_LOYALTY_CONFIG.conversion_points !== 0) {
      return res.status(400).json({
        success: false,
        message: `Redemption points must be in multiples of ${DEFAULT_LOYALTY_CONFIG.conversion_points}.`
      });
    }

    let updatedUser = null;
    let rewardValue = 0;

    await db.executeTransaction(async (tx) => {
      // Lock user row
      const userRes = await tx.query('SELECT loyalty_points, loyalty_reward_balance FROM users WHERE id = $1 FOR UPDATE;', [req.user.id]);
      const userRow = userRes.rows[0];
      const currentPoints = Number(userRow?.loyalty_points || 0);
      const currentRewardBal = Number(userRow?.loyalty_reward_balance || 0);

      if (currentPoints < pointsToRedeem) {
        throw new Error(`Insufficient points balance. You have ⭐ ${currentPoints} points available.`);
      }

      rewardValue = (pointsToRedeem / DEFAULT_LOYALTY_CONFIG.conversion_points) * DEFAULT_LOYALTY_CONFIG.conversion_reward;
      const newPoints = currentPoints - pointsToRedeem;
      const newRewardBal = currentRewardBal + rewardValue;

      await tx.query(
        'UPDATE users SET loyalty_points = $1, loyalty_reward_balance = $2 WHERE id = $3;',
        [newPoints, newRewardBal, req.user.id]
      );

      const txId = 'ltx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      await tx.query(
        `INSERT INTO loyalty_transactions (id, user_id, type, points, reward_amount, description, balance_after)
         VALUES ($1, $2, 'REDEEMED', $3, $4, $5, $6);`,
        [
          txId,
          req.user.id,
          -pointsToRedeem,
          rewardValue,
          `Redeemed ${pointsToRedeem} points for ₹${rewardValue} reward`,
          newPoints
        ]
      );

      const rdmId = 'lrd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      await tx.query(
        `INSERT INTO loyalty_redemptions (id, user_id, points_redeemed, reward_amount, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE');`,
        [rdmId, req.user.id, pointsToRedeem, rewardValue]
      );

      updatedUser = {
        loyalty_points: newPoints,
        loyalty_reward_balance: newRewardBal
      };
    });

    if (updatedUser) {
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: req.user.id,
        title: '🎁 Reward Redeemed!',
        message: `${pointsToRedeem} Loyalty Points were redeemed for ₹${rewardValue}.\nRemaining balance: ⭐ ${updatedUser.loyalty_points} Points`,
        type: 'LOYALTY',
        priority: 'HIGH',
        action_url: '/#secCustomerLoyalty'
      });

      return res.json({
        success: true,
        message: `🎉 Successfully redeemed ${pointsToRedeem} points for ₹${rewardValue} reward balance!`,
        data: updatedUser
      });
    }
  } catch (err) {
    console.error('Loyalty Redemption Error:', err.message);
    return res.status(400).json({ success: false, message: err.message || "Failed to redeem loyalty points." });
  }
});

app.post('/api/orders', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const sRes = await db.query('SELECT is_open, is_qr_pay_enabled FROM settings WHERE id = 1;');
    const settings = sRes.rows[0] || {};

    if (!settings.is_open) {
      return res.status(400).json({ success: false, message: "Hotel is currently closed. Orders are not being accepted." });
    }

    const { order_type, delivery_address, notes, payment_method, items, used_wallet_amount, payment_screenshot, utr_number } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ success: false, message: "Ordered items are required." });
    }

    const isReferralPayment = payment_method === 'REFERRAL' || payment_method === 'Referral Wallet' || payment_method === 'referral';

    if ((payment_method === 'UPI (QR Pay)' || payment_method === 'UPI') && settings.is_qr_pay_enabled === false) {
      return res.status(400).json({ success: false, message: "QR Pay is currently disabled by hotel owner." });
    }

    let savedScreenshotUrl = null;
    if (payment_screenshot) {
      try {
        savedScreenshotUrl = await saveBase64Image(payment_screenshot, 'screenshots');
      } catch (uploadErr) {
        console.error('Payment screenshot upload error:', uploadErr);
        return res.status(400).json({ success: false, message: "Screenshot upload failed." });
      }
    }

    const cleanUtr = utr_number ? utr_number.trim() : null;
    if (cleanUtr) {
      const dupOrderNum = await checkDuplicateUtr(cleanUtr);
      if (dupOrderNum) {
        return res.status(400).json({
          success: false,
          isDuplicateUtr: true,
          message: `⚠️ This UTR (Transaction Ref: ${cleanUtr}) has already been submitted for Order #${dupOrderNum}. Please check your payment details or contact support.`
        });
      }
    }

    // Atomic Sequence Counter for Non-repeating Globally Unique Order ID (#TF1047, #TF1048...)
    const orderSeq = await db.getNextCounter('order_counter');
    const orderNum = 'TF' + orderSeq;

    let grand_total = 0;
    const formattedItems = items.map(item => {
      const itemTotal = Number(item.price) * Number(item.quantity);
      grand_total += itemTotal;
      return {
        tiffin_id: item.id || item.tiffin_id,
        name: item.name,
        price: Number(item.price),
        quantity: Number(item.quantity)
      };
    });

    const newOrderId = 'ord_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    let createdOrder = null;

    // Execute Order Creation within an Atomic Database Transaction
    await db.executeTransaction(async (tx) => {
      // 1. Fetch latest wallet balance inside transaction
      const userRes = await tx.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
      const currentWallet = Number(userRes.rows[0]?.wallet_balance || 0);

      let walletDeducted = 0;
      let finalPayMethod = payment_method || 'Cash';
      let finalPayStatus = 'Pending';
      let netAmount = grand_total;

      if (isReferralPayment) {
        // Backend Validation: Verify customer has sufficient Referral Wallet balance
        if (currentWallet < grand_total) {
          const err = new Error("Insufficient referral wallet balance.");
          err.isInsufficientWallet = true;
          err.currentWallet = currentWallet;
          err.requiredAmount = grand_total;
          throw err;
        }

        walletDeducted = grand_total;
        const remainingBal = currentWallet - grand_total;
        finalPayMethod = 'REFERRAL';
        finalPayStatus = 'REFERRAL';
        netAmount = grand_total; // Record total amount paid by wallet

        // Deduct exact order amount atomically from user's wallet
        await tx.query('UPDATE users SET wallet_balance = $1 WHERE id = $2;', [remainingBal, req.user.id]);

        // Insert Wallet Transaction Record
        await tx.query(
          `INSERT INTO wallet_transactions (id, user_id, amount, type, description, date_time, order_id, balance_before, balance_after, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
          [
            'wtx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            req.user.id,
            grand_total,
            'DEBIT',
            `Order Payment #${orderNum}`,
            new Date().toLocaleString('en-IN'),
            orderNum,
            currentWallet,
            remainingBal,
            'SUCCESS'
          ]
        );
      } else {
        // Partial wallet discount handling for Cash / UPI payment methods
        if (used_wallet_amount && Number(used_wallet_amount) > 0) {
          walletDeducted = Math.min(currentWallet, Number(used_wallet_amount), grand_total);
          if (walletDeducted > 0) {
            const remainingBal = currentWallet - walletDeducted;
            await tx.query('UPDATE users SET wallet_balance = $1 WHERE id = $2;', [remainingBal, req.user.id]);
            await tx.query(
              `INSERT INTO wallet_transactions (id, user_id, amount, type, description, date_time, order_id, balance_before, balance_after, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
              [
                'wtx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                req.user.id,
                walletDeducted,
                'DEBIT',
                `Redeemed on Order #${orderNum}`,
                new Date().toLocaleString('en-IN'),
                orderNum,
                currentWallet,
                remainingBal,
                'SUCCESS'
              ]
            );
          }
        }
        netAmount = Math.max(0, grand_total - walletDeducted);
        finalPayStatus = 'Pending';
      }

      // Check Active Premium Food Member Card Benefits (₹5 Discount & Express Delivery)
      let foodMemberDiscount = 0.00;
      let isExpressDelivery = false;
      let isPremiumMember = false;
      const requestedExpress = Boolean(req.body.is_express_delivery);

      const cardCheckRes = await tx.query(
        `SELECT * FROM food_member_cards WHERE customer_id = $1 AND status = 'ACTIVE';`,
        [req.user.id]
      );
      if (cardCheckRes.rows && cardCheckRes.rows.length > 0) {
        const activeMemberCard = cardCheckRes.rows[0];
        const expiryMs = new Date(activeMemberCard.valid_until).getTime();
        if (expiryMs > Date.now()) {
          foodMemberDiscount = 5.00;
          isPremiumMember = true;
          if (requestedExpress && activeMemberCard.express_delivery_eligible) {
            isExpressDelivery = true;
          }
          // Audit Log Member Discount Application
          logMemberCardAudit({
            customer_id: req.user.id,
            member_id: activeMemberCard.member_id,
            action: 'MEMBER_DISCOUNT_APPLIED',
            actor_role: 'CUSTOMER',
            actor_id: req.user.id,
            details: JSON.stringify({ discount_amount: 5.00, is_express: isExpressDelivery })
          });
        } else {
          await tx.query(`UPDATE food_member_cards SET status = 'EXPIRED', updated_at = $1 WHERE id = $2;`, [new Date().toISOString(), activeMemberCard.id]);
        }
      }

      if (foodMemberDiscount > 0) {
        netAmount = Math.max(0, netAmount - foodMemberDiscount);
      }

      // Create Order Record
      const nowIso = new Date().toISOString();
      const pickupPin = String(Math.floor(1000 + Math.random() * 9000));
      await tx.query(
        `INSERT INTO orders (
          id, order_number, customer_id, customer_name, customer_mobile, 
          order_type, delivery_address, notes, total_amount, used_wallet_amount, 
          net_amount, payment_method, payment_status, order_status, items,
          utr_number, payment_screenshot, screenshot_url, pickup_pin, pickup_pin_verified,
          food_member_discount, is_express_delivery, is_premium_member, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24);`,
        [
          newOrderId, orderNum, req.user.id, req.user.name, req.user.mobile,
          order_type || 'Takeaway', delivery_address || null, notes || null,
          grand_total, walletDeducted, netAmount, finalPayMethod,
          finalPayStatus, 'Received', JSON.stringify(formattedItems),
          cleanUtr, savedScreenshotUrl, savedScreenshotUrl, pickupPin, false,
          foodMemberDiscount, isExpressDelivery ? 1 : 0, isPremiumMember ? 1 : 0, nowIso
        ]
      );

      // Create Payment Record
      const newPayId = 'pay_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      await tx.query(
        `INSERT INTO payments (id, order_number, order_id, customer_id, customer_name, customer_mobile, amount, payment_method, payment_status, utr_number, screenshot_url, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
        [newPayId, orderNum, newOrderId, req.user.id, req.user.name, req.user.mobile, isReferralPayment ? grand_total : netAmount, finalPayMethod, finalPayStatus, cleanUtr, savedScreenshotUrl, `Payment for Order #${orderNum}`]
      );

      // Notify Owner
      const memberTag = isPremiumMember ? (isExpressDelivery ? ' ⭐ PREMIUM MEMBER 🚀 EXPRESS' : ' ⭐ PREMIUM MEMBER') : '';
      const notifMsg = isReferralPayment
        ? `Order #${orderNum}${memberTag} placed by ${req.user.name} using Referral Wallet (₹${grand_total}).`
        : `Order #${orderNum}${memberTag} placed by ${req.user.name} (₹${netAmount}).`;

      await createAndDispatchNotification({
        target_role: 'OWNER',
        title: 'New Order Received',
        message: notifMsg,
        type: 'ORDER',
        priority: 'HIGH',
        action_url: '/#secOwnerOrders',
        related_order_id: newOrderId
      });

      // Notify Customer with Pickup PIN
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: req.user.id,
        title: 'Order Placed Successfully',
        message: `🔐 Your Pickup PIN for Order #${orderNum} is ${pickupPin}. Show this PIN when collecting your order.`,
        type: 'QUEUE',
        priority: 'NORMAL',
        action_url: '/#secQueueProgress',
        related_order_id: newOrderId
      });

      // Fetch created order object
      const createdRes = await tx.query('SELECT * FROM orders WHERE id = $1;', [newOrderId]);
      createdOrder = createdRes.rows[0];
    });

    // Process Referral Reward on Customer First Order (outside main order creation tx to avoid circular locks)
    await checkAndProcessReferralReward(req.user.id, orderNum);

    if (createdOrder) {
      try { createdOrder.items = JSON.parse(createdOrder.items); } catch (e) { }
      createdOrder.payment_screenshot = createdOrder.payment_screenshot || createdOrder.screenshot_url || '';
      createdOrder.screenshot_url = createdOrder.screenshot_url || createdOrder.payment_screenshot || '';
    }

    // Retrieve updated wallet balance for customer response
    const updatedUserRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
    const updatedWalletBalance = Number(updatedUserRes.rows[0]?.wallet_balance || 0);

    res.json({
      success: true,
      data: createdOrder,
      wallet_balance: updatedWalletBalance,
      message: isReferralPayment
        ? `Order #${orderNum} paid successfully using Referral Wallet!`
        : `Order #${orderNum} placed successfully!`
    });
  } catch (err) {
    if (err.isInsufficientWallet) {
      return res.status(400).json({
        success: false,
        message: `Insufficient referral wallet balance. Your referral wallet balance is ₹${err.currentWallet}, but this order requires ₹${err.requiredAmount}.`,
        wallet_balance: err.currentWallet,
        required_amount: err.requiredAmount
      });
    }
    console.error('Order Creation Error:', err);
    res.status(500).json({ success: false, message: err.message || "Database server error creating order." });
  }
});

// =========================================================================
// CUSTOMER ORDER MODIFICATION & CANCELLATION API
// =========================================================================

// Helper to parse order creation timestamp robustly across database formats
function parseOrderCreatedAtMs(createdAt) {
  if (!createdAt) return Date.now();
  let d = new Date(createdAt);
  if (!isNaN(d.getTime())) {
    if (typeof createdAt === 'string' && createdAt.includes(' ') && !createdAt.includes('Z') && !createdAt.includes('+')) {
      const utcStr = createdAt.replace(' ', 'T') + 'Z';
      const utcD = new Date(utcStr);
      if (!isNaN(utcD.getTime())) return utcD.getTime();
    }
    return d.getTime();
  }
  return Date.now();
}

// PUT /api/orders/:id/modify - Modify an existing customer order within 3-minute window
app.put('/api/orders/:id/modify', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Order must contain at least one item." });
    }

    const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
    if (!oRes.rows || oRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    const order = oRes.rows[0];

    // Backend Ownership Check
    if (order.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "Access denied. You can only modify your own orders." });
    }

    // Backend 3-Minute Modification Window Check
    const createdAtMs = parseOrderCreatedAtMs(order.created_at);
    const elapsedMs = Date.now() - createdAtMs;
    if (elapsedMs >= 180000) {
      return res.status(400).json({
        success: false,
        message: "Modification window expired. Orders can only be modified within 3 minutes of placement."
      });
    }

    // Backend Order Status Check
    const statusLower = (order.order_status || '').toLowerCase();
    if (!['received', 'pending'].includes(statusLower)) {
      return res.status(400).json({
        success: false,
        message: `Order #${order.order_number} cannot be modified because its current status is "${order.order_status}".`
      });
    }

    // Fetch latest tiffins to recalculate authoritative price from DB
    const tiffinsRes = await db.query('SELECT id, name, price FROM tiffins;');
    const tiffinMap = new Map();
    (tiffinsRes.rows || []).forEach(t => tiffinMap.set(t.id, t));

    let grandTotal = 0;
    const formattedItems = [];

    for (const item of items) {
      const qty = Number(item.quantity || 0);
      if (qty <= 0) continue;

      const itemId = item.id || item.tiffin_id;
      const matchedTiffin = tiffinMap.get(itemId);
      const itemPrice = matchedTiffin ? Number(matchedTiffin.price) : Number(item.price || 0);

      if (itemPrice <= 0) continue;

      const itemTotal = itemPrice * qty;
      grandTotal += itemTotal;

      formattedItems.push({
        tiffin_id: itemId,
        name: matchedTiffin ? matchedTiffin.name : item.name,
        price: itemPrice,
        quantity: qty
      });
    }

    if (formattedItems.length === 0 || grandTotal <= 0) {
      return res.status(400).json({ success: false, message: "Modified order must contain at least one valid item." });
    }

    let updatedOrder = null;
    let updatedWalletBalance = 0;

    await db.executeTransaction(async (tx) => {
      const userRes = await tx.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
      const currentWallet = Number(userRes.rows[0]?.wallet_balance || 0);

      const isReferralPayment = (order.payment_method || '').toUpperCase() === 'REFERRAL' || (order.payment_status || '').toUpperCase() === 'REFERRAL';
      const originalWalletDeducted = Number(order.used_wallet_amount || 0);

      let newWalletDeducted = 0;
      let newNetAmount = grandTotal;

      if (isReferralPayment) {
        const maxAvailableWallet = currentWallet + originalWalletDeducted;
        if (grandTotal > maxAvailableWallet) {
          const err = new Error(`Insufficient referral wallet balance. Required: ₹${grandTotal}, Available: ₹${maxAvailableWallet}`);
          err.isInsufficientWallet = true;
          err.currentWallet = currentWallet;
          err.requiredAmount = grandTotal;
          throw err;
        }

        newWalletDeducted = grandTotal;
        const newWalletBal = maxAvailableWallet - grandTotal;
        newNetAmount = grandTotal;

        await tx.query('UPDATE users SET wallet_balance = $1 WHERE id = $2;', [newWalletBal, req.user.id]);

        const walletDiff = originalWalletDeducted - grandTotal;
        if (walletDiff !== 0) {
          await tx.query(
            `INSERT INTO wallet_transactions (id, user_id, amount, type, description, date_time, order_id, balance_before, balance_after, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
            [
              'wtx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
              req.user.id,
              Math.abs(walletDiff),
              walletDiff > 0 ? 'CREDIT' : 'DEBIT',
              `Order Modification Adjustment #${order.order_number}`,
              new Date().toLocaleString('en-IN'),
              order.order_number,
              currentWallet,
              newWalletBal,
              'SUCCESS'
            ]
          );
        }
      } else {
        if (originalWalletDeducted > 0) {
          const maxAvailableWallet = currentWallet + originalWalletDeducted;
          newWalletDeducted = Math.min(maxAvailableWallet, originalWalletDeducted, grandTotal);
          const newWalletBal = maxAvailableWallet - newWalletDeducted;
          newNetAmount = Math.max(0, grandTotal - newWalletDeducted);

          await tx.query('UPDATE users SET wallet_balance = $1 WHERE id = $2;', [newWalletBal, req.user.id]);
        }
      }

      await tx.query(
        `UPDATE orders SET items = $1, total_amount = $2, used_wallet_amount = $3, net_amount = $4 WHERE id = $5;`,
        [JSON.stringify(formattedItems), grandTotal, newWalletDeducted, newNetAmount, order.id]
      );

      await tx.query(
        `UPDATE payments SET amount = $1 WHERE order_number = $2;`,
        [isReferralPayment ? grandTotal : newNetAmount, order.order_number]
      );

      // Send Customer & Owner Notifications
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: req.user.id,
        title: 'Order Modified',
        message: `Order #${order.order_number} has been updated successfully. Total is now ₹${grandTotal}.`,
        type: 'ORDER',
        action_url: '/#secCustomerOrders',
        related_order_id: order.id
      });

      await createAndDispatchNotification({
        target_role: 'OWNER',
        title: 'Order Modified by Customer',
        message: `Order #${order.order_number} modified by ${req.user.name}. New total: ₹${grandTotal}.`,
        type: 'ORDER',
        action_url: '/#secOwnerOrders',
        related_order_id: order.id
      });

      const finalRes = await tx.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
      updatedOrder = finalRes.rows[0];
    });

    const userBalRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
    updatedWalletBalance = Number(userBalRes.rows[0]?.wallet_balance || 0);

    if (updatedOrder) {
      try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch (e) { }
    }

    res.json({
      success: true,
      data: updatedOrder,
      wallet_balance: updatedWalletBalance,
      message: `Order #${order.order_number} updated successfully!`
    });
  } catch (err) {
    if (err.isInsufficientWallet) {
      return res.status(400).json({
        success: false,
        message: err.message
      });
    }
    console.error('Order Modification Error:', err);
    res.status(500).json({ success: false, message: "Database server error modifying order." });
  }
});

// POST /api/orders/:id/cancel - Cancel a customer order atomically with reason and referral refund
app.post('/api/orders/:id/cancel', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const { id } = req.params;
    const rawReason = (req.body.reason || req.body.cancellation_reason || '').toString().trim();
    const cancellationReason = rawReason || 'Ordered by mistake';

    const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
    if (!oRes.rows || oRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    const order = oRes.rows[0];

    // Backend Ownership Check
    if (order.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "Access denied. You can only cancel your own orders." });
    }

    // Backend Status Check
    const currentStatus = (order.order_status || '').toLowerCase();
    if (currentStatus === 'cancelled') {
      return res.status(400).json({ success: false, message: `Order #${order.order_number} is already cancelled.` });
    }
    if (['preparing', 'ready', 'completed'].includes(currentStatus)) {
      return res.status(400).json({
        success: false,
        message: `Order #${order.order_number} cannot be cancelled because it is already "${order.order_status}".`
      });
    }

    let updatedOrder = null;
    let updatedWalletBalance = 0;

    await db.executeTransaction(async (tx) => {
      const userRes = await tx.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
      const currentWallet = Number(userRes.rows[0]?.wallet_balance || 0);

      const walletDeducted = Number(order.used_wallet_amount || 0);
      let newWalletBal = currentWallet;

      // Restore Referral Wallet Balance if wallet funds were used
      if (walletDeducted > 0) {
        newWalletBal = currentWallet + walletDeducted;
        await tx.query('UPDATE users SET wallet_balance = $1 WHERE id = $2;', [newWalletBal, req.user.id]);

        await tx.query(
          `INSERT INTO wallet_transactions (id, user_id, amount, type, description, date_time, order_id, balance_before, balance_after, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
          [
            'wtx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            req.user.id,
            walletDeducted,
            'CREDIT',
            `Refund for Cancelled Order #${order.order_number}`,
            new Date().toLocaleString('en-IN'),
            order.order_number,
            currentWallet,
            newWalletBal,
            'SUCCESS'
          ]
        );
      }

      // Update Order Status atomically
      const nowIso = new Date().toISOString();
      await tx.query(
        `UPDATE orders SET order_status = 'Cancelled', cancellation_reason = $1, cancelled_at = $2 WHERE id = $3;`,
        [cancellationReason, nowIso, order.id]
      );

      // Update Payment Status
      await tx.query(
        `UPDATE payments SET payment_status = 'Cancelled' WHERE order_number = $1;`,
        [order.order_number]
      );

      // Send Customer & Owner Notifications
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: req.user.id,
        title: 'Order Cancelled',
        message: `Order #${order.order_number} has been cancelled successfully.`,
        type: 'ORDER',
        action_url: '/#secCustomerOrders',
        related_order_id: order.id
      });

      await createAndDispatchNotification({
        target_role: 'OWNER',
        title: 'Order Cancelled by Customer',
        message: `Order #${order.order_number} was cancelled by customer (${cancellationReason}).`,
        type: 'ORDER',
        priority: 'HIGH',
        action_url: '/#secOwnerOrders',
        related_order_id: order.id
      });

      const finalRes = await tx.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
      updatedOrder = finalRes.rows[0];
    });

    const userBalRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
    updatedWalletBalance = Number(userBalRes.rows[0]?.wallet_balance || 0);

    if (updatedOrder) {
      try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch (e) { }
    }

    res.json({
      success: true,
      data: updatedOrder,
      wallet_balance: updatedWalletBalance,
      message: `Order #${order.order_number} cancelled successfully.`
    });
  } catch (err) {
    console.error('Order Cancellation Error:', err);
    res.status(500).json({ success: false, message: "Database server error cancelling order." });
  }
});
app.get('/api/wallet/transactions', authenticateToken, async (req, res) => {
  try {
    const txRes = await db.query(
      'SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC;',
      [req.user.id]
    );
    const uRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
    const wallet_balance = Number(uRes.rows[0]?.wallet_balance || 0);

    res.json({
      success: true,
      data: {
        wallet_balance,
        transactions: txRes.rows || []
      }
    });
  } catch (err) {
    console.error('Fetch Wallet Transactions Error:', err);
    res.status(500).json({ success: false, message: "Failed to fetch wallet transaction history." });
  }
});


app.post('/api/orders/:id/payment-proof', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_screenshot, utr_number } = req.body;

    const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
    if (!oRes.rows || oRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    const order = oRes.rows[0];

    if (req.user.role === 'CUSTOMER' && order.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "Unauthorized access to order." });
    }

    let savedScreenshotUrl = order.payment_screenshot || order.screenshot_url || null;
    if (payment_screenshot) {
      try {
        savedScreenshotUrl = await saveBase64Image(payment_screenshot, 'screenshots');
      } catch (uploadErr) {
        console.error('Payment screenshot upload error:', uploadErr);
        return res.status(400).json({ success: false, message: "Screenshot upload failed." });
      }
    }

    const cleanUtr = utr_number !== undefined && utr_number !== null ? utr_number.trim() : (order.utr_number || null);
    const permanentScreenshot = (payment_screenshot && typeof payment_screenshot === 'string' && payment_screenshot.startsWith('data:image/'))
      ? payment_screenshot
      : (savedScreenshotUrl || order.payment_screenshot || order.screenshot_url || null);

    await db.query(
      `UPDATE orders SET utr_number = $1, payment_screenshot = $2, screenshot_url = $3 WHERE id = $4;`,
      [cleanUtr, permanentScreenshot, savedScreenshotUrl || permanentScreenshot, order.id]
    );

    await db.query(
      `UPDATE payments SET utr_number = $1, screenshot_url = $2 WHERE order_number = $3 OR order_id = $4;`,
      [cleanUtr, permanentScreenshot || savedScreenshotUrl, order.order_number, order.id]
    );

    const updatedRes = await db.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
    const updatedOrder = updatedRes.rows[0];
    try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch (e) { }
    updatedOrder.payment_screenshot = updatedOrder.payment_screenshot || updatedOrder.screenshot_url || '';
    updatedOrder.screenshot_url = updatedOrder.screenshot_url || updatedOrder.payment_screenshot || '';

    res.json({
      success: true,
      data: updatedOrder,
      message: "Payment proof submitted successfully."
    });
  } catch (err) {
    console.error('Payment Proof Error:', err);
    res.status(500).json({ success: false, message: "Failed to save payment proof." });
  }
});

// =========================================================================
// REAL PHONEPE PAYMENT GATEWAY (PG v1) & APP-INTENT INTEGRATION
// =========================================================================

// PhonePe Credentials & Environment Configuration
const RAW_PHONEPE_MERCHANT_ID = (process.env.PHONEPE_MERCHANT_ID || '').trim();
const RAW_PHONEPE_SALT_KEY = (process.env.PHONEPE_SALT_KEY || '').trim();
const RAW_PHONEPE_SALT_INDEX = (process.env.PHONEPE_SALT_INDEX || '').trim();
const RAW_PHONEPE_ENV = (process.env.PHONEPE_ENV || process.env.PAYMENT_ENV || '').trim().toLowerCase();

// Default Sandbox Credentials (PhonePe Active Preprod Merchant)
const SANDBOX_MERCHANT_ID = 'PGTESTPAYUAT86';
const SANDBOX_SALT_KEY = '96434309-7796-489d-8924-ab56988a6076';
const SANDBOX_SALT_INDEX = '1';
const SANDBOX_BASE_URL = 'https://api-preprod.phonepe.com/apis/pg-sandbox';
const PRODUCTION_BASE_URL = 'https://api.phonepe.com/apis/hermes';

// Smart Resolution Logic: Auto-map deprecated PGTESTPAYUAT to active PGTESTPAYUAT86
let PHONEPE_MERCHANT_ID = RAW_PHONEPE_MERCHANT_ID;
if (!PHONEPE_MERCHANT_ID || PHONEPE_MERCHANT_ID === 'PGTESTPAYUAT') {
  PHONEPE_MERCHANT_ID = SANDBOX_MERCHANT_ID;
}

let PHONEPE_SALT_KEY = RAW_PHONEPE_SALT_KEY;
if (!PHONEPE_SALT_KEY || (PHONEPE_MERCHANT_ID === SANDBOX_MERCHANT_ID && PHONEPE_SALT_KEY === '099eb0cd-02fe-4e2a-b15e-b02c97693ec2')) {
  PHONEPE_SALT_KEY = SANDBOX_SALT_KEY;
}

let PHONEPE_SALT_INDEX = RAW_PHONEPE_SALT_INDEX || SANDBOX_SALT_INDEX;

const isSandboxMerchant = (PHONEPE_MERCHANT_ID === SANDBOX_MERCHANT_ID || PHONEPE_MERCHANT_ID.startsWith('PGTESTPAY'));
let PHONEPE_ENV = RAW_PHONEPE_ENV || (isSandboxMerchant ? 'test' : 'production');

let PHONEPE_BASE_URL = isSandboxMerchant ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL;
if (RAW_PHONEPE_ENV === 'production' && !isSandboxMerchant) {
  PHONEPE_BASE_URL = PRODUCTION_BASE_URL;
} else if (RAW_PHONEPE_ENV === 'test' || RAW_PHONEPE_ENV === 'sandbox') {
  PHONEPE_BASE_URL = SANDBOX_BASE_URL;
}
if (process.env.PHONEPE_HOST_URL) {
  PHONEPE_BASE_URL = process.env.PHONEPE_HOST_URL.trim();
}

// In-memory transaction status cache for PhonePe gateway verification
const phonePeTxnStore = new Map();

// Helper: Generate compact unique PhonePe transaction ID (strictly 1-38 chars max)
function generatePhonePeTxnId() {
  const prefix = 'PPTXN_';
  const timestamp = Date.now().toString();
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix}${timestamp}_${rand}`; // Exact length: 26 chars (well below PhonePe's 38 char limit)
}

// Safe diagnostic logger for PhonePe integration (Zero secret leakage)
function logPhonePeDiagnostic(category, details = {}) {
  const timestamp = new Date().toISOString();
  console.error(`🚨 [PHONEPE DIAGNOSTIC] [${timestamp}] [${category}]`, {
    environment: PHONEPE_ENV,
    merchantId: PHONEPE_MERCHANT_ID,
    isSandboxMerchant,
    txnId: details.txnId || 'N/A',
    httpStatus: details.httpStatus || 'N/A',
    phonePeCode: details.code || 'N/A',
    phonePeMessage: details.message || 'N/A',
    endpoint: details.endpoint || PHONEPE_BASE_URL,
    exceptionType: details.exceptionType || 'N/A',
    errorDetails: details.error || details.raw || 'N/A'
  });
}

function validatePhonePeConfig() {
  const missing = [];
  if (!PHONEPE_MERCHANT_ID) missing.push('PHONEPE_MERCHANT_ID');
  if (!PHONEPE_SALT_KEY) missing.push('PHONEPE_SALT_KEY');
  if (!PHONEPE_SALT_INDEX) missing.push('PHONEPE_SALT_INDEX');

  if (missing.length > 0) {
    logPhonePeDiagnostic('CONFIGURATION_ERROR', {
      error: `Missing required environment variables: ${missing.join(', ')}`
    });
    return { valid: false, message: `PHONEPE_CONFIGURATION_ERROR: ${missing.join(', ')} missing.` };
  }

  // Detect credential/environment mismatch (e.g. Custom Merchant ID with default Sandbox Salt Key)
  if (!isSandboxMerchant && PHONEPE_SALT_KEY === SANDBOX_SALT_KEY) {
    logPhonePeDiagnostic('CREDENTIAL_MISMATCH_WARNING', {
      error: `Custom merchant ID (${PHONEPE_MERCHANT_ID}) configured but PHONEPE_SALT_KEY is still default sandbox key. Please set PHONEPE_SALT_KEY in Render environment variables.`
    });
    return {
      valid: false,
      message: `PHONEPE_CONFIGURATION_MISMATCH: Custom Merchant ID '${PHONEPE_MERCHANT_ID}' detected, but PHONEPE_SALT_KEY environment variable is missing on server. Please configure your PhonePe merchant salt key in Render server environment variables.`
    };
  }

  if (isSandboxMerchant && PHONEPE_BASE_URL.includes('api.phonepe.com/apis/hermes')) {
    logPhonePeDiagnostic('ENDPOINT_MISMATCH_WARNING', {
      error: `Sandbox test merchant ID (${SANDBOX_MERCHANT_ID}) cannot be called against Production host (hermes).`
    });
    return {
      valid: false,
      message: `PHONEPE_CONFIGURATION_MISMATCH: Test Merchant ID '${SANDBOX_MERCHANT_ID}' cannot be used with Production API endpoint. Set PHONEPE_ENV=test or provide your live PhonePe merchant credentials in Render environment variables.`
    };
  }

  return { valid: true };
}

// Helper: Atomically update database status for order and payment record
async function updateDbOrderPaymentStatus(orderIdOrTxnId, newStatus, txnId = null) {
  const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR utr_number = $1 OR order_number = $1;', [orderIdOrTxnId]);
  if (!oRes.rows || !oRes.rows.length) return null;
  const order = oRes.rows[0];

  let mappedPayStatus = 'Processing';
  if (newStatus === 'Paid' || newStatus === 'SUCCESS' || newStatus === 'COMPLETED') mappedPayStatus = 'Paid';
  else if (newStatus === 'Cancelled' || newStatus === 'CANCELLED' || newStatus === 'USER_CANCELLED') mappedPayStatus = 'Cancelled';
  else if (newStatus === 'Failed' || newStatus === 'FAILED' || newStatus === 'DECLINED') mappedPayStatus = 'Failed';
  else mappedPayStatus = 'Processing';

  if (order.payment_status !== mappedPayStatus) {
    await db.query('UPDATE orders SET payment_status = $1 WHERE id = $2;', [mappedPayStatus, order.id]);
    await db.query('UPDATE payments SET payment_status = $1 WHERE order_id = $2 OR order_number = $3;', [mappedPayStatus, order.id, order.order_number]);
  }
  return order;
}

// Helper: Query official PhonePe Status API to verify real payment transaction
async function verifyPhonePeStatusWithApi(txnId) {
  const oRes = await db.query('SELECT * FROM orders WHERE utr_number = $1 OR id = $1 OR order_number = $1;', [txnId]);
  if (!oRes.rows || oRes.rows.length === 0) {
    return { success: false, verified: false, status: 'NOT_FOUND', message: "Order transaction record not found." };
  }

  const order = oRes.rows[0];
  try { order.items = JSON.parse(order.items); } catch (e) { }

  const targetTxnId = order.utr_number || txnId;
  const stringToHash = `/pg/v1/status/${PHONEPE_MERCHANT_ID}/${targetTxnId}${PHONEPE_SALT_KEY}`;
  const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
  const xVerify = sha256 + '###' + PHONEPE_SALT_INDEX;

  let statusOutcome = 'PROCESSING';
  let newPayStatus = 'Processing';

  try {
    const apiRes = await fetch(`${PHONEPE_BASE_URL}/pg/v1/status/${PHONEPE_MERCHANT_ID}/${targetTxnId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
        'X-MERCHANT-ID': PHONEPE_MERCHANT_ID,
        'accept': 'application/json'
      }
    });

    const apiJson = await apiRes.json();
    const rawCode = String(apiJson.code || apiJson.data?.responseCode || '').toUpperCase();
    const rawState = String(apiJson.data?.paymentState || '').toUpperCase();

    if (apiJson.success && (rawCode === 'PAYMENT_SUCCESS' || rawState === 'COMPLETED')) {
      statusOutcome = 'SUCCESS';
      newPayStatus = 'Paid';
    } else if (
      rawCode.includes('CANCEL') || rawCode.includes('DECLINE') || rawCode.includes('EXPIRE') ||
      rawState.includes('CANCEL') || rawState.includes('DECLINE') || rawState.includes('EXPIRE')
    ) {
      statusOutcome = 'CANCELLED';
      newPayStatus = 'Cancelled';
    } else if (
      rawCode.includes('FAIL') || rawCode.includes('ERROR') || rawCode.includes('TIMED_OUT') ||
      rawState.includes('FAIL')
    ) {
      statusOutcome = 'FAILED';
      newPayStatus = 'Failed';
    } else {
      statusOutcome = 'PROCESSING';
      newPayStatus = 'Processing';
    }
  } catch (err) {
    console.warn('PhonePe Status API verification call warning:', err.message);
    if (order.payment_status === 'Paid' || order.payment_status === 'Verified') {
      statusOutcome = 'SUCCESS';
      newPayStatus = 'Paid';
    } else if (order.payment_status === 'Cancelled') {
      statusOutcome = 'CANCELLED';
      newPayStatus = 'Cancelled';
    } else if (order.payment_status === 'Failed') {
      statusOutcome = 'FAILED';
      newPayStatus = 'Failed';
    }
  }

  await updateDbOrderPaymentStatus(order.id, newPayStatus, targetTxnId);

  phonePeTxnStore.set(targetTxnId, {
    txnId: targetTxnId,
    orderId: order.id,
    orderNumber: order.order_number,
    amount: order.net_amount,
    status: statusOutcome,
    updatedAt: Date.now()
  });

  const updatedRes = await db.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
  const updatedOrder = updatedRes.rows[0] || order;
  try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch (e) { }

  return {
    success: true,
    verified: statusOutcome === 'SUCCESS',
    status: statusOutcome,
    payment_status: newPayStatus,
    data: updatedOrder
  };
}

// POST /api/phonepe/initiate - Initiate REAL PhonePe payment (New Order or Pay Again Retry)
app.post('/api/phonepe/initiate', optionalAuth, async (req, res) => {
  try {
    const configCheck = validatePhonePeConfig();
    if (!configCheck.valid) {
      return res.status(500).json({
        success: false,
        code: 'PHONEPE_CONFIG_ERROR',
        message: configCheck.message
      });
    }

    const sRes = await db.query('SELECT is_open, is_phonepe_enabled, upi_id, upi_name FROM settings WHERE id = 1;');
    const settings = sRes.rows[0] || {};

    if (settings.is_phonepe_enabled === false) {
      return res.status(400).json({ success: false, message: "PhonePe payment method is currently disabled by hotel owner." });
    }

    const { order_id, order_number, customer_name, customer_mobile, order_type, delivery_address, notes, items, used_wallet_amount } = req.body;

    const customerId = req.user ? req.user.id : ('usr_guest_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4));
    const customerName = (req.user ? req.user.name : customer_name) || customer_name || 'Customer';
    const customerMobile = (req.user ? req.user.mobile : customer_mobile) || customer_mobile || '9999999999';

    let targetOrder = null;
    let txnId = '';
    let amountToPay = 0;

    // SCENARIO 1: PAY AGAIN / RETRY PHONEPE FOR AN EXISTING ORDER
    if (order_id || order_number) {
      const searchTarget = order_id || order_number;
      const existingRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [searchTarget]);
      if (!existingRes.rows || existingRes.rows.length === 0) {
        return res.status(404).json({ success: false, message: "Existing order not found for payment retry." });
      }
      targetOrder = existingRes.rows[0];

      if (req.user && targetOrder.customer_id && targetOrder.customer_id !== req.user.id) {
        return res.status(403).json({ success: false, message: "Unauthorized access to order." });
      }

      // Generate a new unique PhonePe transaction ID for this payment attempt (safely 26 chars <= 38)
      txnId = generatePhonePeTxnId();
      amountToPay = Number(targetOrder.net_amount || targetOrder.total_amount || 0);

      // Update payment status to Processing for retry attempt
      await db.query('UPDATE orders SET utr_number = $1, payment_status = $2, payment_method = $3 WHERE id = $4;', [txnId, 'Processing', 'UPI (PhonePe)', targetOrder.id]);
      await db.query('UPDATE payments SET utr_number = $1, payment_status = $2, payment_method = $3 WHERE order_id = $4 OR order_number = $5;', [txnId, 'Processing', 'UPI (PhonePe)', targetOrder.id, targetOrder.order_number]);

      phonePeTxnStore.set(txnId, {
        txnId,
        orderId: targetOrder.id,
        orderNumber: targetOrder.order_number,
        amount: amountToPay,
        status: 'PROCESSING',
        updatedAt: Date.now()
      });
    } else {
      // SCENARIO 2: NEW PHONEPE ORDER CREATION
      if (!settings.is_open) {
        return res.status(400).json({ success: false, message: "Hotel is currently closed. Orders are not being accepted." });
      }

      if (!items || !items.length) {
        return res.status(400).json({ success: false, message: "Ordered items are required." });
      }

      // Atomic Sequence Counter for Non-repeating Order ID
      const orderSeq = await db.getNextCounter('order_counter');
      const orderNum = 'TF' + orderSeq;
      const newOrderId = 'ord_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      txnId = generatePhonePeTxnId();

      // Fetch authoritative item pricing
      let grand_total = 0;
      const formattedItems = items.map(item => {
        const itemTotal = Number(item.price) * Number(item.quantity);
        grand_total += itemTotal;
        return {
          tiffin_id: item.id || item.tiffin_id,
          name: item.name,
          price: Number(item.price),
          quantity: Number(item.quantity)
        };
      });

      await db.executeTransaction(async (tx) => {
        let currentWallet = 0;
        if (req.user) {
          const userRes = await tx.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
          currentWallet = Number(userRes.rows[0]?.wallet_balance || 0);
        }

        let walletDeducted = 0;
        if (req.user && used_wallet_amount && Number(used_wallet_amount) > 0) {
          walletDeducted = Math.min(currentWallet, Number(used_wallet_amount), grand_total);
          if (walletDeducted > 0) {
            const remainingBal = currentWallet - walletDeducted;
            await tx.query('UPDATE users SET wallet_balance = $1 WHERE id = $2;', [remainingBal, req.user.id]);
            await tx.query(
              `INSERT INTO wallet_transactions (id, user_id, amount, type, description, date_time, order_id, balance_before, balance_after, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
              [
                'wtx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                req.user.id,
                walletDeducted,
                'DEBIT',
                `Redeemed on Order #${orderNum}`,
                new Date().toLocaleString('en-IN'),
                orderNum,
                currentWallet,
                remainingBal,
                'SUCCESS'
              ]
            );
          }
        }

        let foodMemberDiscount = 0.00;
        let isExpressDelivery = false;
        let isPremiumMember = false;
        const requestedExpress = Boolean(req.body.is_express_delivery);

        if (req.user) {
          const cardCheckRes = await tx.query(
            `SELECT * FROM food_member_cards WHERE customer_id = $1 AND status = 'ACTIVE';`,
            [req.user.id]
          );
          if (cardCheckRes.rows && cardCheckRes.rows.length > 0) {
            const activeMemberCard = cardCheckRes.rows[0];
            const expiryMs = new Date(activeMemberCard.valid_until).getTime();
            if (expiryMs > Date.now()) {
              foodMemberDiscount = 5.00;
              isPremiumMember = true;
              if (requestedExpress && activeMemberCard.express_delivery_eligible) {
                isExpressDelivery = true;
              }
            }
          }
        }

        let netAmount = Math.max(0, grand_total - walletDeducted);
        if (foodMemberDiscount > 0) {
          netAmount = Math.max(0, netAmount - foodMemberDiscount);
        }
        amountToPay = netAmount;

        const nowIso = new Date().toISOString();
        const pickupPin = String(Math.floor(1000 + Math.random() * 9000));

        await tx.query(
          `INSERT INTO orders (
            id, order_number, customer_id, customer_name, customer_mobile,
            order_type, delivery_address, notes, total_amount, used_wallet_amount,
            net_amount, payment_method, payment_status, order_status, items,
            utr_number, pickup_pin, pickup_pin_verified, food_member_discount, is_express_delivery, is_premium_member, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22);`,
          [
            newOrderId, orderNum, customerId, customerName, customerMobile,
            order_type || 'Takeaway', delivery_address || null, notes || null,
            grand_total, walletDeducted, netAmount, 'UPI (PhonePe)',
            'Processing', 'Received', JSON.stringify(formattedItems),
            txnId, pickupPin, false, foodMemberDiscount, isExpressDelivery ? 1 : 0, isPremiumMember ? 1 : 0, nowIso
          ]
        );

        const newPayId = 'pay_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
        await tx.query(
          `INSERT INTO payments (id, order_number, order_id, customer_id, customer_name, customer_mobile, amount, payment_method, payment_status, utr_number, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
          [newPayId, orderNum, newOrderId, customerId, customerName, customerMobile, netAmount, 'UPI (PhonePe)', 'Processing', txnId, `PhonePe Payment for Order #${orderNum}`]
        );

        const createdRes = await tx.query('SELECT * FROM orders WHERE id = $1;', [newOrderId]);
        targetOrder = createdRes.rows[0];
      });

      if (req.user) {
        await checkAndProcessReferralReward(req.user.id, targetOrder ? targetOrder.order_number : orderNum);
      }

      if (targetOrder) {
        try { targetOrder.items = JSON.parse(targetOrder.items); } catch (e) { }
      }

      phonePeTxnStore.set(txnId, {
        txnId,
        orderId: targetOrder ? targetOrder.id : newOrderId,
        orderNumber: targetOrder ? targetOrder.order_number : orderNum,
        amount: amountToPay,
        status: 'PROCESSING',
        updatedAt: Date.now()
      });
    }

    // Pre-flight validation guard for PhonePe merchantTransactionId (1 to 38 characters requirement)
    if (!txnId || typeof txnId !== 'string' || txnId.length > 38 || txnId.length < 1) {
      txnId = generatePhonePeTxnId();
    }

    // Resolve Official Merchant UPI VPA (from environment, settings.upi_id, or default 9392974900@ybl)
    const rawVpa = (process.env.PHONEPE_MERCHANT_VPA || settings.upi_id || '9392974900@ybl').trim();
    const vpaRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
    const merchantVpa = vpaRegex.test(rawVpa) ? rawVpa : '9392974900@ybl';

    // Determine domain host for callback & redirect
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const domainUrl = process.env.APP_URL || `${protocol}://${host}`;

    const amountInPaise = Math.round(amountToPay * 100);
    const redirectUrl = `${domainUrl}/api/phonepe/redirect?txnId=${encodeURIComponent(txnId)}`;
    const callbackUrl = `${domainUrl}/api/phonepe/callback`;

    const payload = {
      merchantId: PHONEPE_MERCHANT_ID,
      merchantTransactionId: txnId,
      merchantUserId: (req.user ? req.user.id : customerId) || ('MUID_' + Date.now()),
      amount: amountInPaise,
      redirectUrl: redirectUrl,
      redirectMode: 'POST',
      callbackUrl: callbackUrl,
      mobileNumber: (customerMobile || '9999999999').replace(/\D/g, '').slice(-10) || '9999999999',
      paymentInstrument: {
        type: 'PAY_PAGE'
      }
    };

    console.log(`[PhonePe Gateway] Initiating transaction ${txnId} | Amount: ₹${amountToPay} (${amountInPaise} paise) | MerchantID: ${PHONEPE_MERCHANT_ID} | MerchantVPA: ${merchantVpa} | ENV: ${PHONEPE_ENV}`);

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const stringToHash = base64Payload + '/pg/v1/pay' + PHONEPE_SALT_KEY;
    const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
    const xVerify = sha256 + '###' + PHONEPE_SALT_INDEX;

    let phonepeRedirectUrl = null;
    let pgMessage = "PhonePe payment gateway initiated.";
    let pgResponseStatus = null;
    let pgJson = null;

    try {
      const pgResponse = await fetch(`${PHONEPE_BASE_URL}/pg/v1/pay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': xVerify,
          'accept': 'application/json'
        },
        body: JSON.stringify({ request: base64Payload })
      });

      pgResponseStatus = pgResponse.status;
      pgJson = await pgResponse.json();

      if (pgResponse.ok && pgJson.success && pgJson.data?.instrumentResponse) {
        phonepeRedirectUrl = pgJson.data.instrumentResponse.redirectInfo?.url || pgJson.data.instrumentResponse.intentUrl || null;
        pgMessage = pgJson.message || pgMessage;
        console.log(`[PhonePe Gateway Success] TxnId: ${txnId} | MerchantVPA: ${merchantVpa} | Message: ${pgMessage}`);
      } else {
        logPhonePeDiagnostic('INITIATION_FAILURE', {
          txnId,
          httpStatus: pgResponseStatus,
          code: pgJson.code || pgJson.data?.responseCode,
          message: pgJson.message || 'PhonePe payment gateway initialization failed.',
          endpoint: `${PHONEPE_BASE_URL}/pg/v1/pay`,
          raw: pgJson
        });
      }
    } catch (pgErr) {
      logPhonePeDiagnostic('NETWORK_ERROR', {
        txnId,
        endpoint: `${PHONEPE_BASE_URL}/pg/v1/pay`,
        exceptionType: pgErr.name || 'FetchError',
        error: pgErr.message
      });

      return res.status(502).json({
        success: false,
        code: 'PHONEPE_NETWORK_ERROR',
        message: `Unable to connect to PhonePe gateway (${pgErr.message}). Please verify network connection and try again.`
      });
    }

    if (!phonepeRedirectUrl) {
      console.warn(`[PhonePe Gateway Notice] PG API did not return direct checkout URL (Status: ${pgResponseStatus}). Providing fallback URI for txn ${txnId}.`);
      phonepeRedirectUrl = redirectUrl;
    }

    res.json({
      success: true,
      redirectUrl: phonepeRedirectUrl,
      txnId,
      data: targetOrder,
      message: pgMessage
    });
  } catch (err) {
    logPhonePeDiagnostic('EXCEPTIONAL_FAILURE', {
      exceptionType: err.name || 'Error',
      error: err.message || err
    });
    res.status(500).json({ success: false, message: err.message || "Failed to initiate PhonePe payment." });
  }
});

// GET & POST /api/phonepe/redirect - Customer return redirect route from PhonePe
app.all('/api/phonepe/redirect', async (req, res) => {
  try {
    const txnId = req.query.txnId || req.body.txnId || req.body.merchantTransactionId;
    if (!txnId) {
      return res.redirect('/?phonepe_callback=1');
    }

    const verification = await verifyPhonePeStatusWithApi(txnId);
    let finalStatus = 'Processing';
    if (verification.verified && verification.status === 'SUCCESS') {
      finalStatus = 'Paid';
    } else if (verification.status === 'CANCELLED') {
      finalStatus = 'Cancelled';
    } else if (verification.status === 'FAILED') {
      finalStatus = 'Failed';
    } else {
      finalStatus = verification.payment_status || 'Processing';
    }

    res.redirect(`/?phonepe_callback=1&txnId=${encodeURIComponent(txnId)}&status=${encodeURIComponent(finalStatus)}`);
  } catch (err) {
    console.error('PhonePe Redirect Route Error:', err);
    res.redirect('/?phonepe_callback=1&status=Cancelled');
  }
});

// POST /api/phonepe/callback - Server-to-Server (S2S) Webhook callback from PhonePe
app.post('/api/phonepe/callback', async (req, res) => {
  try {
    const { response } = req.body;
    const xVerifyHeader = req.headers['x-verify'];

    if (!response) {
      return res.status(400).json({ success: false, message: "Response body payload required." });
    }

    if (xVerifyHeader) {
      const expectedHash = crypto.createHash('sha256').update(response + PHONEPE_SALT_KEY).digest('hex') + '###' + PHONEPE_SALT_INDEX;
      if (xVerifyHeader !== expectedHash) {
        console.warn('PhonePe Webhook Checksum validation failed.');
        return res.status(400).json({ success: false, message: "Invalid X-VERIFY checksum signature." });
      }
    }

    const decodedStr = Buffer.from(response, 'base64').toString('utf-8');
    const decodedJson = JSON.parse(decodedStr);
    const txnId = decodedJson.data?.merchantTransactionId;
    const code = decodedJson.code || decodedJson.data?.responseCode;
    const state = decodedJson.data?.paymentState;

    let newStatus = 'Processing';
    if (decodedJson.success && (code === 'PAYMENT_SUCCESS' || state === 'COMPLETED')) {
      newStatus = 'Paid';
    } else if (code === 'PAYMENT_ERROR' || code === 'PAYMENT_DECLINED' || state === 'FAILED') {
      newStatus = 'Failed';
    }

    if (txnId) {
      await updateDbOrderPaymentStatus(txnId, newStatus);
    }

    res.json({ success: true, message: "Callback processed successfully." });
  } catch (err) {
    console.error('PhonePe Callback Error:', err);
    res.status(500).json({ success: false, message: "Error processing PhonePe callback." });
  }
});

// GET /api/phonepe/status/:txnId - Backend verification of PhonePe payment result
app.get('/api/phonepe/status/:txnId', optionalAuth, async (req, res) => {
  try {
    const { txnId } = req.params;
    const result = await verifyPhonePeStatusWithApi(txnId);
    if (!result.success && result.status === 'NOT_FOUND') {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('PhonePe Status Verification Endpoint Error:', err);
    res.status(500).json({ success: false, message: "Error verifying PhonePe payment status." });
  }
});


// POST /api/orders/:id/processing-screenshot - Upload Screenshot specifically for 🟠 PAYMENT PROCESSING
app.post('/api/orders/:id/processing-screenshot', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_screenshot } = req.body;

    if (!payment_screenshot) {
      return res.status(400).json({ success: false, message: "Screenshot image is required." });
    }

    const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
    if (!oRes.rows || oRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    const order = oRes.rows[0];

    if (order.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "Unauthorized access to order." });
    }

    // Restriction check: ONLY allowed for PROCESSING / Pending status
    const currentPayStatus = (order.payment_status || '').toLowerCase();
    const isAllowedState = currentPayStatus.includes('processing') || currentPayStatus.includes('pending') || currentPayStatus === 'processing';
    if (!isAllowedState) {
      return res.status(400).json({
        success: false,
        message: `Processing screenshot upload is only allowed when payment status is "🟠 Payment Processing". Current status: ${order.payment_status}`
      });
    }

    let savedScreenshotUrl = await saveBase64Image(payment_screenshot, 'screenshots');
    const permanentScreenshot = (payment_screenshot && typeof payment_screenshot === 'string' && payment_screenshot.startsWith('data:image/'))
      ? payment_screenshot
      : (savedScreenshotUrl || order.payment_screenshot || order.screenshot_url || null);

    await db.query(
      `UPDATE orders SET payment_screenshot = $1, screenshot_url = $2 WHERE id = $3;`,
      [permanentScreenshot, savedScreenshotUrl || permanentScreenshot, order.id]
    );

    await db.query(
      `UPDATE payments SET screenshot_url = $1 WHERE order_number = $2 OR order_id = $3;`,
      [permanentScreenshot || savedScreenshotUrl, order.order_number, order.id]
    );

    const updatedRes = await db.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
    const updatedOrder = updatedRes.rows[0];
    try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch (e) { }
    updatedOrder.payment_screenshot = updatedOrder.payment_screenshot || updatedOrder.screenshot_url || '';
    updatedOrder.screenshot_url = updatedOrder.screenshot_url || updatedOrder.payment_screenshot || '';

    res.json({
      success: true,
      data: updatedOrder,
      message: "Processing payment screenshot uploaded successfully!"
    });
  } catch (err) {
    console.error('Processing Screenshot Upload Error:', err);
    res.status(500).json({ success: false, message: "Failed to upload processing payment screenshot." });
  }
});

app.patch('/api/orders/:id/status', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const { id } = req.params;
  const { order_status, payment_status, rejection_reason } = req.body;

  const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
  const order = oRes.rows[0];
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found." });
  }

  const newOrderStatus = order_status || order.order_status;
  let newPaymentStatus = payment_status || order.payment_status;
  const newRejectionReason = rejection_reason !== undefined ? rejection_reason : order.rejection_reason;
  let pinVerified = Boolean(order.pickup_pin_verified);

  // Duplicate Action Protection: If order status and payment status are already identical, return cached order directly
  if (order.order_status === newOrderStatus && order.payment_status === newPaymentStatus && newRejectionReason === order.rejection_reason) {
    try { order.items = JSON.parse(order.items); } catch (e) { }
    return res.json({ success: true, data: order, message: `Order #${order.order_number} status is already ${newOrderStatus}.` });
  }

  // 🚨 ONLINE PAYMENT VERIFICATION: Owner/Kitchen Operator cannot mark an ONLINE PAYMENT order as "Ready" until payment is verified!
  if (newOrderStatus === 'Ready') {
    const payMethod = (order.payment_method || '').toLowerCase().trim();
    const isCod = payMethod.includes('cash') || payMethod.includes('cod');
    if (!isCod) {
      const payStatus = (order.payment_status || '').toLowerCase().trim();
      const isVerified = payStatus.includes('paid') || payStatus.includes('verified') || payStatus === 'referral' || payMethod === 'referral';
      if (!isVerified) {
        return res.status(400).json({
          success: false,
          message: "⚠️ Payment Verification Required\nPlease verify the online payment first, then mark this order as Ready to Serve."
        });
      }
    }
  }

  // 🚨 CRITICAL PIN ENFORCEMENT: Completing an order requires valid Pickup PIN verification!
  if (newOrderStatus === 'Completed') {
    if (!pinVerified) {
      const inputPin = String(req.body.pin || '').trim();
      if (!inputPin) {
        return res.status(400).json({
          success: false,
          require_pin: true,
          message: "❌ Pickup PIN verification required! Please enter the customer's 4-digit Pickup PIN to complete this order."
        });
      }

      if (inputPin !== String(order.pickup_pin || '').trim()) {
        return res.status(400).json({
          success: false,
          require_pin: true,
          message: "❌ Incorrect Pickup PIN. Please ask the customer to provide the correct PIN."
        });
      }

      // PIN is correct! Mark verified
      pinVerified = true;
      if (newPaymentStatus === 'Pending' || newPaymentStatus === 'Cash Pending') {
        newPaymentStatus = (order.payment_method || '').toLowerCase().includes('cash') ? 'Cash Received' : 'Paid';
      }
    }
  }

  await db.query('UPDATE orders SET order_status = $1, payment_status = $2, rejection_reason = $3, pickup_pin_verified = $4 WHERE id = $5;', [newOrderStatus, newPaymentStatus, newRejectionReason, pinVerified, order.id]);
  await db.query('UPDATE payments SET payment_status = $1 WHERE order_number = $2;', [newPaymentStatus, order.order_number]);

  // Process Customer Loyalty Points if Order reaches Completed / Delivered status
  if (['completed', 'delivered'].includes(newOrderStatus.toLowerCase())) {
    await processOrderLoyaltyPoints(order.id);
  }

  // Dispatch Customer Notification on Status Update
  if (order.customer_id) {
    let actionUrl = '/#secCustomerOrders';
    if (newOrderStatus === 'Preparing' || newOrderStatus === 'Ready') {
      actionUrl = '/#secQueueProgress';
    }
    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      customer_id: order.customer_id,
      title: order_status ? `Order #${order.order_number} is ${newOrderStatus}` : `Payment Updated`,
      message: order_status
        ? `Your order #${order.order_number} status is now "${newOrderStatus}".`
        : `Payment status for Order #${order.order_number} is updated to "${newPaymentStatus}".`,
      type: newOrderStatus === 'Preparing' || newOrderStatus === 'Ready' ? 'QUEUE' : 'ORDER',
      priority: newOrderStatus === 'Ready' ? 'HIGH' : 'NORMAL',
      action_url: actionUrl,
      related_order_id: order.id
    });
  }

  const updatedRes = await db.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
  const updatedOrder = updatedRes.rows[0];
  try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch (e) { }

  res.json({ success: true, data: updatedOrder, message: `Order #${order.order_number} status updated to ${newOrderStatus}.` });
});

// PATCH Payment Verify Route for Owner
app.patch('/api/orders/:id/payment-verify', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const { id } = req.params;
  const { payment_status } = req.body;

  const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
  const order = oRes.rows[0];
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found." });
  }

  const newPaymentStatus = payment_status || order.payment_status;
  await db.query('UPDATE orders SET payment_status = $1 WHERE id = $2;', [newPaymentStatus, order.id]);
  await db.query('UPDATE payments SET payment_status = $1 WHERE order_number = $2;', [newPaymentStatus, order.order_number]);

  // Dispatch Customer Notification
  if (order.customer_id) {
    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      customer_id: order.customer_id,
      title: 'Payment Status Updated',
      message: `Payment status for Order #${order.order_number} updated to "${newPaymentStatus}".`,
      type: 'PAYMENT',
      priority: 'HIGH',
      action_url: '/#secCustomerPayments',
      related_order_id: order.id
    });
  }

  const updatedRes = await db.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
  const updatedOrder = updatedRes.rows[0];
  try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch (e) { }

  res.json({ success: true, data: updatedOrder, message: `Order #${order.order_number} payment status updated to ${newPaymentStatus}.` });
});

// POST /api/orders/:id/verify-pin - Owner Pickup PIN Verification
app.post('/api/orders/:id/verify-pin', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const inputPin = String(req.body.pin || '').trim();

    if (!inputPin || inputPin.length !== 4 || !/^\d{4}$/.test(inputPin)) {
      return res.status(400).json({
        success: false,
        message: "❌ Incorrect Pickup PIN. Please enter customer's 4-digit Pickup PIN."
      });
    }

    const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
    const order = oRes.rows[0];
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const currentStatus = (order.order_status || '').toLowerCase();
    const isCancelledOrRejected = ['cancelled', 'rejected', 'customer_cancelled', 'owner_rejected'].includes(currentStatus);
    const isAlreadyCompleted = ['completed', 'delivered'].includes(currentStatus) || Boolean(order.pickup_pin_verified);

    if (isCancelledOrRejected) {
      return res.status(400).json({
        success: false,
        message: "Cannot verify PIN for cancelled or rejected orders."
      });
    }

    if (isAlreadyCompleted) {
      return res.status(400).json({
        success: false,
        message: "This order has already been completed and verified."
      });
    }

    const orderPin = String(order.pickup_pin || '').trim();
    if (!orderPin || inputPin !== orderPin) {
      return res.status(400).json({
        success: false,
        message: "❌ Incorrect Pickup PIN. Please ask the customer to provide the correct PIN."
      });
    }

    // PIN Verification Succeeds: Update order status atomically
    await db.query(
      "UPDATE orders SET pickup_pin_verified = true, order_status = 'Completed' WHERE id = $1;",
      [order.id]
    );

    // If payment status is Pending, update payment status to Paid
    const currentPayStatus = (order.payment_status || '').toLowerCase();
    if (currentPayStatus.includes('pending')) {
      await db.query("UPDATE orders SET payment_status = 'Paid' WHERE id = $1;", [order.id]);
      await db.query("UPDATE payments SET payment_status = 'Paid' WHERE order_number = $1;", [order.order_number]);
    }

    // Process Customer Loyalty Points on PIN Completion
    await processOrderLoyaltyPoints(order.id);

    // Notify Customer
    if (order.customer_id) {
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: order.customer_id,
        title: `Order #${order.order_number} Completed`,
        message: `Your order #${order.order_number} has been verified with Pickup PIN and marked completed!`,
        type: 'ORDER',
        priority: 'HIGH',
        action_url: '/#secCustomerOrders',
        related_order_id: order.id
      });
    }

    const updatedRes = await db.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
    const updatedOrder = updatedRes.rows[0];
    if (updatedOrder) {
      try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch (e) { }
      updatedOrder.pickup_pin_verified = true;
    }

    res.json({
      success: true,
      data: updatedOrder,
      message: `✅ Pickup PIN Verified. Order #${order.order_number} marked completed!`
    });
  } catch (err) {
    console.error('Error verifying pickup PIN:', err);
    res.status(500).json({ success: false, message: "Server error verifying pickup PIN." });
  }
});

app.delete('/api/orders/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const { id } = req.params;
  const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
  const order = oRes.rows[0];
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found." });
  }
  await db.query('DELETE FROM orders WHERE id = $1;', [order.id]);
  await db.query('DELETE FROM payments WHERE order_number = $1;', [order.order_number]);
  res.json({ success: true, message: `Order #${order.order_number} deleted successfully.` });
});

// GET /api/orders/:id/invoice - Secure Digital Invoice Endpoint (Completed Orders Only)
app.get('/api/orders/:id/invoice', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
    const order = oRes.rows[0];

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    // Security Check 1: Owner or Order Customer Ownership
    if (req.user.role === 'CUSTOMER' && order.customer_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only download invoices for your own orders."
      });
    }

    // Security Check 2: Completed / Delivered Status Only
    const statusClean = (order.order_status || '').toLowerCase();
    const isCompleted = ['completed', 'delivered'].includes(statusClean) || Boolean(order.pickup_pin_verified);

    if (!isCompleted) {
      return res.status(400).json({
        success: false,
        message: "❌ Digital Invoice is available ONLY AFTER the order is completed."
      });
    }

    // Retrieve business settings for invoice header
    const sRes = await db.query('SELECT * FROM settings LIMIT 1;');
    const settings = sRes.rows[0] || {};

    let parsedItems = [];
    try {
      parsedItems = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
    } catch (e) {
      parsedItems = [];
    }

    const invoiceData = {
      invoice_number: `INV-${order.order_number}`,
      order_number: order.order_number,
      order_id: order.id,
      order_date: order.created_at || new Date().toISOString(),
      order_type: order.order_type || 'Takeaway',
      delivery_address: order.delivery_address || '',
      hotel_name: settings.hotel_name || 'Sri Lakshmi Annapurna Tiffin Center',
      hotel_phone: settings.phone || '+91 9392874900',
      hotel_address: settings.address || '#42, Temple Road, Near Gandhi Circle, Bengaluru, KA',
      customer_name: order.customer_name || 'Valued Customer',
      customer_mobile: order.customer_mobile || '',
      items: parsedItems,
      total_amount: order.total_amount || 0,
      used_wallet_amount: order.used_wallet_amount || 0,
      net_amount: order.net_amount || order.total_amount || 0,
      payment_method: order.payment_method || 'Cash',
      payment_status: order.payment_status || 'Paid',
      utr_number: order.utr_number || '',
      pickup_pin: order.pickup_pin || '',
      pickup_pin_verified: Boolean(order.pickup_pin_verified),
      order_status: order.order_status || 'Completed'
    };

    res.json({
      success: true,
      data: invoiceData,
      filename: `Sri-Lakshmi-Annapurna-Invoice-${order.order_number}.pdf`
    });
  } catch (err) {
    console.error('Error generating digital invoice:', err);
    res.status(500).json({ success: false, message: "Server error generating invoice." });
  }
});

// =========================================================================
// PAYMENTS API
// =========================================================================

app.get('/api/payments', authenticateToken, async (req, res) => {
  let queryStr = 'SELECT * FROM payments ORDER BY created_at DESC;';
  let params = [];
  if (req.user.role === 'CUSTOMER') {
    queryStr = 'SELECT * FROM payments WHERE customer_id = $1 ORDER BY created_at DESC;';
    params = [req.user.id];
  }
  const pRes = await db.query(queryStr, params);
  const mappedPayments = pRes.rows.map(p => ({
    ...p,
    payment_screenshot: p.payment_screenshot || p.screenshot_url || '',
    screenshot_url: p.screenshot_url || p.payment_screenshot || ''
  }));
  res.json({ success: true, data: mappedPayments });
});

app.patch('/api/payments/:id/status', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const { id } = req.params;
  const { payment_status } = req.body;
  await db.query('UPDATE payments SET payment_status = $1 WHERE id = $2;', [payment_status, id]);
  const pRes = await db.query('SELECT * FROM payments WHERE id = $1;', [id]);
  if (pRes.rows.length > 0) {
    await db.query('UPDATE orders SET payment_status = $1 WHERE order_number = $2;', [payment_status, pRes.rows[0].order_number]);
  }
  res.json({ success: true, data: pRes.rows[0], message: "Payment status updated." });
});

app.delete('/api/payments/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM payments WHERE id = $1;', [id]);
    res.json({ success: true, message: "Payment record deleted successfully." });
  } catch (err) {
    console.error("Error deleting payment record:", err);
    res.status(500).json({ success: false, message: "Failed to delete payment record." });
  }
});

app.delete('/api/payments', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    await db.query('DELETE FROM payments;');
    res.json({ success: true, message: "All payment records deleted successfully." });
  } catch (err) {
    console.error("Error deleting all payment records:", err);
    res.status(500).json({ success: false, message: "Failed to delete all payment records." });
  }
});

// =========================================================================
// STATS & ANALYTICS
// =========================================================================

app.get('/api/stats', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const ordersRes = await db.query('SELECT * FROM orders;');
  const allOrders = ordersRes.rows || [];

  const validOrders = allOrders.filter(o => !['Rejected', 'Cancelled'].includes(o.order_status));
  const totalRevenue = validOrders.reduce((sum, o) => sum + Number(o.net_amount || o.total_amount || 0), 0);
  const usersRes = await db.query("SELECT COUNT(*) FROM users WHERE role = 'CUSTOMER';");

  res.json({
    success: true,
    data: {
      total_revenue: totalRevenue,
      total_sales: totalRevenue,
      total_orders: allOrders.length,
      active_orders: allOrders.filter(o => ['Received', 'Preparing', 'Ready'].includes(o.order_status)).length,
      completed_orders: allOrders.filter(o => o.order_status === 'Completed').length,
      rejected_orders: allOrders.filter(o => ['Rejected', 'Cancelled'].includes(o.order_status)).length,
      total_customers: Number(usersRes.rows[0]?.count || 0)
    }
  });
});

// =========================================================================
// REFERRAL & EARN SYSTEM API
// =========================================================================

async function checkAndProcessReferralReward(customerId, orderNum) {
  try {
    const refRes = await db.query("SELECT * FROM referrals WHERE referred_id = $1 AND status = 'Pending' LIMIT 1;", [customerId]);
    if (!refRes.rows || refRes.rows.length === 0) return;
    const refRecord = refRes.rows[0];

    // Check if this is customer's first order
    const orderCountRes = await db.query("SELECT COUNT(*) FROM orders WHERE customer_id = $1 AND order_number != $2 AND order_status != 'Cancelled';", [customerId, orderNum]);
    const previousOrdersCount = Number(orderCountRes.rows[0]?.count || 0);

    if (previousOrdersCount === 0) {
      // Get currently configured Owner referral amount dynamically
      const settingsRes = await db.query('SELECT referral FROM settings WHERE id = 1;');
      let settingsReferral = settingsRes.rows[0]?.referral || {};
      if (typeof settingsReferral === 'string') {
        try { settingsReferral = JSON.parse(settingsReferral); } catch (e) { }
      }

      const activeRewardAmt = Number(settingsReferral.referrer_reward);
      const rewardAmt = (!isNaN(activeRewardAmt) && isFinite(activeRewardAmt) && activeRewardAmt > 0)
        ? activeRewardAmt
        : Number(refRecord.reward_amount || 10);

      // Update referral to Completed with the dynamic reward amount used
      await db.query("UPDATE referrals SET status = 'Completed', order_number = $1, reward_amount = $2 WHERE id = $3;", [orderNum, rewardAmt, refRecord.id]);

      // Credit Referrer Wallet
      if (refRecord.referrer_id) {
        await db.query("UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2;", [rewardAmt, refRecord.referrer_id]);

        // Record Wallet Transaction
        await db.query(
          "INSERT INTO wallet_transactions (id, user_id, amount, type, description, date_time) VALUES ($1, $2, $3, $4, $5, $6);",
          ['wtx_' + Date.now(), refRecord.referrer_id, rewardAmt, 'CREDIT', `Referral reward for ${refRecord.referred_name || 'friend'}'s first order (#${orderNum})`, new Date().toLocaleString('en-IN')]
        );

        // Send Notification to Referrer
        await createAndDispatchNotification({
          target_role: 'CUSTOMER',
          customer_id: refRecord.referrer_id,
          title: 'Referral Reward Earned! 🎉',
          message: `You earned ₹${rewardAmt} because ${refRecord.referred_name || 'your friend'} placed their first order!`,
          type: 'PROMOTION',
          priority: 'NORMAL',
          action_url: '/#secCustomerReferral'
        });
      }
    }
  } catch (err) {
    console.error('Process Referral Reward Error:', err);
  }
}

app.get('/api/referrals/stats', authenticateToken, async (req, res) => {
  try {
    const userRes = await db.query('SELECT referral_code, wallet_balance, show_on_leaderboard FROM users WHERE id = $1;', [req.user.id]);
    const user = userRes.rows[0] || req.user;

    const historyRes = await db.query('SELECT * FROM referrals WHERE referrer_id = $1 ORDER BY created_at DESC;', [req.user.id]);
    const history = historyRes.rows || [];

    const completed = history.filter(r => r.status === 'Completed');
    const pending = history.filter(r => r.status === 'Pending');
    const totalRewards = completed.reduce((sum, r) => sum + Number(r.reward_amount || 30), 0);

    res.json({
      success: true,
      data: {
        referral_code: user.referral_code || 'TIFFIN10',
        wallet_balance: Number(user.wallet_balance || 0),
        total_referrals: history.length,
        completed_referrals: completed.length,
        pending_referrals: pending.length,
        total_rewards_earned: totalRewards,
        history: history,
        show_on_leaderboard: user.show_on_leaderboard !== false
      }
    });
  } catch (err) {
    console.error('Fetch Referral Stats Error:', err);
    res.status(500).json({ success: false, message: "Failed to fetch referral stats." });
  }
});

app.get('/api/referrals/leaderboard', async (req, res) => {
  try {
    const lbRes = await db.query(`
      SELECT u.id, u.name, u.referral_code, 
             COUNT(r.id) FILTER (WHERE r.status = 'Completed') AS completed_count,
             COALESCE(SUM(r.reward_amount) FILTER (WHERE r.status = 'Completed'), 0) AS total_earned
      FROM users u
      LEFT JOIN referrals r ON u.id = r.referrer_id
      WHERE u.role = 'CUSTOMER' AND u.show_on_leaderboard = true
      GROUP BY u.id, u.name, u.referral_code
      HAVING COUNT(r.id) FILTER (WHERE r.status = 'Completed') > 0
      ORDER BY completed_count DESC, total_earned DESC
      LIMIT 10;
    `);

    res.json({ success: true, data: lbRes.rows || [] });
  } catch (err) {
    console.error('Fetch Leaderboard Error:', err);
    res.json({ success: true, data: [] });
  }
});

// =========================================================================
// PREMIUM FOOD MEMBER CARD SYSTEM ENGINE (₹10 / 3-MONTH MEMBERSHIP)
// =========================================================================

function addExactThreeCalendarMonths(fromDate = new Date()) {
  const target = new Date(fromDate);
  const currentMonth = target.getMonth();
  const currentDay = target.getDate();
  
  target.setMonth(currentMonth + 3);
  if (target.getDate() !== currentDay && target.getDate() < 5) {
    target.setDate(0);
  }
  return target;
}

async function logMemberCardAudit({ customer_id, member_id, action, actor_role, actor_id, details }) {
  try {
    const id = 'audit_fm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    await db.query(
      `INSERT INTO member_card_audit_logs (id, customer_id, member_id, action, actor_role, actor_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [id, customer_id || null, member_id || null, action, actor_role || 'SYSTEM', actor_id || null, details || null, new Date().toISOString()]
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

// 1. GET /api/food-member/status - Fetch Customer Membership & Application State with Dynamic Expiration
app.get('/api/food-member/status', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.id;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    // Check for Active / Expired / Suspended Card
    const cardRes = await db.query(
      `SELECT * FROM food_member_cards WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1;`,
      [customerId]
    );

    let card = cardRes.rows && cardRes.rows.length > 0 ? cardRes.rows[0] : null;

    if (card && card.status === 'ACTIVE') {
      const expiryMs = new Date(card.valid_until).getTime();
      if (expiryMs <= nowMs) {
        // Automatically expire card if valid_until has passed
        await db.query(
          `UPDATE food_member_cards SET status = 'EXPIRED', updated_at = $1 WHERE id = $2;`,
          [nowIso, card.id]
        );
        card.status = 'EXPIRED';
        await logMemberCardAudit({
          customer_id: customerId,
          member_id: card.member_id,
          action: 'MEMBERSHIP_EXPIRED',
          actor_role: 'SYSTEM',
          details: 'Membership auto-expired past 3 calendar months.'
        });
        await createAndDispatchNotification({
          target_role: 'CUSTOMER',
          customer_id: customerId,
          title: '⚠️ Premium Food Membership Expired',
          message: 'Your 3-month Premium Food Membership has expired. Click Buy Again ₹10 to renew!',
          type: 'MEMBER_CARD',
          priority: 'NORMAL',
          action_url: '/#secCustomerMemberCard'
        });
      }
    }

    // Fetch Latest Application
    const appRes = await db.query(
      `SELECT * FROM food_member_applications WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1;`,
      [customerId]
    );
    let application = appRes.rows && appRes.rows.length > 0 ? appRes.rows[0] : null;

    let overallStatus = 'NO_APPLICATION';
    if (card && card.status === 'ACTIVE') {
      overallStatus = 'ACTIVE';
    } else if (card && card.status === 'SUSPENDED') {
      overallStatus = 'SUSPENDED';
    } else if (application && application.status === 'PENDING_APPROVAL') {
      overallStatus = 'PENDING_APPROVAL';
    } else if (card && card.status === 'EXPIRED') {
      overallStatus = 'EXPIRED';
    } else if (application && application.status === 'REJECTED') {
      overallStatus = 'REJECTED';
    }

    res.json({
      success: true,
      status: overallStatus,
      card,
      application,
      benefits: {
        discount_amount: 5.00,
        express_delivery_eligible: true
      }
    });
  } catch (err) {
    console.error('Fetch Food Member Status Error:', err);
    res.status(500).json({ success: false, message: "Failed to load member status." });
  }
});

// 2. POST /api/food-member/apply - Customer Application with ₹10 Verified Payment
app.post('/api/food-member/apply', authenticateToken, async (req, res) => {
  try {
    const { payment_method, utr_number, payment_screenshot, is_cash_paid } = req.body;
    const customerId = req.user.id;
    const nowIso = new Date().toISOString();

    // Verification 1: Customer does not already have an active card
    const activeCardRes = await db.query(
      `SELECT * FROM food_member_cards WHERE customer_id = $1 AND status = 'ACTIVE' AND valid_until > $2;`,
      [customerId, nowIso]
    );
    if (activeCardRes.rows && activeCardRes.rows.length > 0) {
      return res.status(400).json({
        success: false,
        code: 'ACTIVE_EXISTS',
        message: 'You already have an active Premium Food Member Card.'
      });
    }

    // Verification 2: Customer does not already have a pending application
    const pendingAppRes = await db.query(
      `SELECT * FROM food_member_applications WHERE customer_id = $1 AND status = 'PENDING_APPROVAL';`,
      [customerId]
    );
    if (pendingAppRes.rows && pendingAppRes.rows.length > 0) {
      return res.status(400).json({
        success: false,
        code: 'PENDING_EXISTS',
        message: 'Your Premium Food Member Card application is already submitted and pending Owner approval.'
      });
    }

    const isCash = is_cash_paid === true || is_cash_paid === 'true' || payment_method === 'Cash Paid';
    let cleanUtr = null;
    let finalPayMethod = payment_method || 'UPI (QR Pay)';

    if (isCash) {
      finalPayMethod = 'Cash Paid';
      cleanUtr = 'Cash Payment';
    } else {
      // Online Payment: UTR MUST BE REQUIRED AND STRICTLY NUMERIC ONLY (/^\d+$/)
      if (!utr_number || !utr_number.toString().trim()) {
        return res.status(400).json({ success: false, message: "UTR / Transaction ID is required for online payment." });
      }
      cleanUtr = utr_number.toString().trim();
      if (!/^\d+$/.test(cleanUtr)) {
        return res.status(400).json({ success: false, message: "Please enter a valid numeric UTR / Transaction ID." });
      }

      // Verification 3: Duplicate Payment UTR check
      const dupRes = await db.query(
        `SELECT id FROM food_member_applications WHERE payment_reference = $1;`,
        [cleanUtr]
      );
      if (dupRes.rows && dupRes.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: "This UTR / Transaction ID has already been used."
        });
      }
    }

    let savedScreenshotUrl = null;
    if (payment_screenshot) {
      if (!payment_screenshot.startsWith('data:image/')) {
        return res.status(400).json({ success: false, message: "Invalid image format. Allowed formats: JPG, JPEG, PNG, WEBP." });
      }
      try {
        savedScreenshotUrl = await saveBase64Image(payment_screenshot, 'screenshots');
      } catch (uploadErr) {
        console.error('Member screenshot upload error:', uploadErr);
      }
    }

    const appId = 'app_fm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const payRef = cleanUtr;

    try {
      await db.executeTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO food_member_applications (
            id, customer_id, customer_name, customer_mobile, fee_amount, 
            payment_method, payment_status, payment_reference, screenshot_url, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
          [
            appId, customerId, req.user.name, req.user.mobile, 10.00,
            finalPayMethod, 'VERIFICATION_PENDING', payRef, savedScreenshotUrl,
            'PENDING_APPROVAL', nowIso, nowIso
          ]
        );

        // Record in payments table so Owner payment history shows the ₹10 fee
        const payId = 'pay_fm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
        await tx.query(
          `INSERT INTO payments (id, order_number, order_id, customer_id, customer_name, customer_mobile, amount, payment_method, payment_status, utr_number, screenshot_url, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
          [
            payId, 'MEMBERSHIP_₹10', appId, customerId, req.user.name, req.user.mobile,
            10.00, finalPayMethod, 'Pending Verification', payRef, savedScreenshotUrl,
            'Premium Food Member Card Membership Fee (₹10)'
          ]
        );
      });
    } catch (txErr) {
      await logMemberCardAudit({
        customer_id: customerId,
        action: 'DUPLICATE_REQUEST_BLOCKED',
        actor_role: 'CUSTOMER',
        actor_id: customerId,
        details: `Duplicate application request blocked by database constraint (Ref: ${payRef})`
      });
      return res.status(400).json({
        success: false,
        code: 'DUPLICATE_APPLICATION_BLOCKED',
        message: 'A membership application is already in progress for your account.'
      });
    }

    await logMemberCardAudit({
      customer_id: customerId,
      action: 'APPLICATION_CREATED',
      actor_role: 'CUSTOMER',
      actor_id: customerId,
      details: `Submitted ₹10 membership application (Ref: ${payRef})`
    });

    await logMemberCardAudit({
      customer_id: customerId,
      action: 'MEMBERSHIP_PAYMENT_VERIFIED',
      actor_role: 'SYSTEM',
      details: `₹10 payment verified for application ${appId}`
    });

    // Notify Owner
    await createAndDispatchNotification({
      target_role: 'OWNER',
      title: '🍽️ New Food Member Application',
      message: `New Premium Food Member Card application submitted by ${req.user.name} (₹10 Paid).`,
      type: 'MEMBER_CARD',
      priority: 'HIGH',
      action_url: '/#secOwnerMemberCardApprovals'
    });

    const newAppRes = await db.query(`SELECT * FROM food_member_applications WHERE id = $1;`, [appId]);

    res.json({
      success: true,
      message: "Your Premium Food Member Card application has been submitted successfully. Please wait for Owner approval.",
      application: newAppRes.rows[0]
    });
  } catch (err) {
    console.error('Apply Food Member Error:', err);
    res.status(500).json({ success: false, message: err.message || "Failed to submit membership application." });
  }
});

// 3. GET /api/food-member/owner/applications - Owner List Applications
app.get('/api/food-member/owner/applications', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { status } = req.query;
    let querySql = `
      SELECT a.*, 
             c.member_id, c.status as card_status, c.valid_from, c.valid_until, c.qr_verification_code
      FROM food_member_applications a
      LEFT JOIN food_member_cards c ON c.application_id = a.id
    `;
    const params = [];
    if (status && status !== 'ALL') {
      querySql += ` WHERE a.status = $1`;
      params.push(status);
    }
    querySql += ` ORDER BY a.created_at DESC;`;

    const result = await db.query(querySql, params);

    // Calculate count stats across all status categories
    const countsRes = await db.query(`
      SELECT 
        COUNT(*) as total_all,
        COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as total_pending,
        COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as total_approved,
        COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) as total_rejected
      FROM food_member_applications;
    `);

    const counts = (countsRes.rows && countsRes.rows.length > 0) ? {
      all: parseInt(countsRes.rows[0].total_all || 0, 10),
      pending: parseInt(countsRes.rows[0].total_pending || 0, 10),
      approved: parseInt(countsRes.rows[0].total_approved || 0, 10),
      rejected: parseInt(countsRes.rows[0].total_rejected || 0, 10)
    } : { all: 0, pending: 0, approved: 0, rejected: 0 };

    res.json({ success: true, counts, data: result.rows || [] });
  } catch (err) {
    console.error('Fetch Owner Applications Error:', err);
    res.status(500).json({ success: false, message: "Failed to fetch membership applications." });
  }
});

// 4. POST /api/food-member/owner/approve/:id - Owner Approve Application
app.post('/api/food-member/owner/approve/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const appId = req.params.id;
    const now = new Date();
    const nowIso = now.toISOString();

    const appRes = await db.query(`SELECT * FROM food_member_applications WHERE id = $1;`, [appId]);
    if (!appRes.rows || appRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Application not found." });
    }
    const application = appRes.rows[0];

    if (application.status !== 'PENDING_APPROVAL') {
      return res.status(400).json({ success: false, message: `Application status is already ${application.status}.` });
    }

    let createdCard = null;

    await db.executeTransaction(async (tx) => {
      // 1. Update application status to APPROVED
      await tx.query(
        `UPDATE food_member_applications SET status = 'APPROVED', updated_at = $1 WHERE id = $2;`,
        [nowIso, appId]
      );

      // 2. Generate unique Member ID via atomic counter (e.g., FM-000125)
      const memberSeq = await db.getNextCounter('member_counter');
      const memberId = 'FM-' + String(memberSeq).padStart(6, '0');

      // 3. Calculate exact 3 CALENDAR MONTHS validity
      const validFrom = now;
      const validUntil = addExactThreeCalendarMonths(now);

      const qrCode = 'QR_FM_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      const cardId = 'card_fm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

      // 4. Create Food Member Card
      await tx.query(
        `INSERT INTO food_member_cards (
          id, member_id, customer_id, customer_name, customer_mobile, application_id,
          status, valid_from, valid_until, discount_amount, express_delivery_eligible,
          qr_verification_code, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);`,
        [
          cardId, memberId, application.customer_id, application.customer_name, application.customer_mobile,
          appId, 'ACTIVE', validFrom.toISOString(), validUntil.toISOString(), 5.00, true,
          qrCode, nowIso, nowIso
        ]
      );

      const cardResult = await tx.query(`SELECT * FROM food_member_cards WHERE id = $1;`, [cardId]);
      createdCard = cardResult.rows[0];
    });

    const formattedExpiry = new Date(createdCard.valid_until).toLocaleDateString('en-IN');

    await logMemberCardAudit({
      customer_id: application.customer_id,
      member_id: createdCard.member_id,
      action: 'APPLICATION_APPROVED',
      actor_role: 'OWNER',
      actor_id: req.user.id,
      details: `Approved application ${appId}`
    });

    await logMemberCardAudit({
      customer_id: application.customer_id,
      member_id: createdCard.member_id,
      action: 'CARD_GENERATED',
      actor_role: 'SYSTEM',
      details: `Generated card ${createdCard.member_id} valid until ${formattedExpiry}`
    });

    await logMemberCardAudit({
      customer_id: application.customer_id,
      member_id: createdCard.member_id,
      action: 'MEMBERSHIP_ACTIVATED',
      actor_role: 'OWNER',
      details: `Membership activated`
    });

    // Notify Customer
    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      customer_id: application.customer_id,
      title: '🎉 Premium Food Member Card Approved!',
      message: `Your Premium Food Member Card (${createdCard.member_id}) is now active until ${formattedExpiry}. Enjoy ₹5 OFF & Express Delivery!`,
      type: 'MEMBER_CARD',
      priority: 'HIGH',
      action_url: '/#secCustomerMemberCard'
    });

    res.json({
      success: true,
      message: `Premium Food Member Card (${createdCard.member_id}) approved and activated successfully!`,
      card: createdCard
    });
  } catch (err) {
    console.error('Approve Member Card Error:', err);
    res.status(500).json({ success: false, message: err.message || "Failed to approve member card." });
  }
});

// 5. POST /api/food-member/owner/reject/:id - Owner Reject Application
app.post('/api/food-member/owner/reject/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const appId = req.params.id;
    const { rejection_reason } = req.body;
    const nowIso = new Date().toISOString();

    const appRes = await db.query(`SELECT * FROM food_member_applications WHERE id = $1;`, [appId]);
    if (!appRes.rows || appRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Application not found." });
    }
    const application = appRes.rows[0];

    await db.query(
      `UPDATE food_member_applications 
       SET status = 'REJECTED', rejection_reason = $1, refund_status = 'PENDING', updated_at = $2 
       WHERE id = $3;`,
      [rejection_reason || 'Rejected by Owner', nowIso, appId]
    );

    await logMemberCardAudit({
      customer_id: application.customer_id,
      action: 'APPLICATION_REJECTED',
      actor_role: 'OWNER',
      actor_id: req.user.id,
      details: `Rejected application ${appId}. Reason: ${rejection_reason || 'None'}`
    });

    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      customer_id: application.customer_id,
      title: '❌ Premium Food Member Application Rejected',
      message: 'Your Premium Food Member Card application was rejected. Please contact the Owner regarding your ₹10 membership payment.',
      type: 'MEMBER_CARD',
      priority: 'HIGH',
      action_url: '/#secCustomerMemberCard'
    });

    res.json({
      success: true,
      message: "Application rejected."
    });
  } catch (err) {
    console.error('Reject Member Application Error:', err);
    res.status(500).json({ success: false, message: "Failed to reject application." });
  }
});

// 5B. POST /api/food-member/owner/verify-payment/:id - Owner Verify ₹10 Payment Proof
app.post('/api/food-member/owner/verify-payment/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const appId = req.params.id;
    const nowIso = new Date().toISOString();

    const appRes = await db.query(`SELECT * FROM food_member_applications WHERE id = $1;`, [appId]);
    if (!appRes.rows || appRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Application not found." });
    }
    const application = appRes.rows[0];

    if (application.payment_status === 'VERIFIED') {
      return res.status(400).json({ success: false, message: "Payment proof is already verified." });
    }

    await db.executeTransaction(async (tx) => {
      await tx.query(
        `UPDATE food_member_applications SET payment_status = 'VERIFIED', updated_at = $1 WHERE id = $2;`,
        [nowIso, appId]
      );
      await tx.query(
        `UPDATE payments SET payment_status = 'Verified', notes = '₹10 Membership Payment Proof VERIFIED by Owner' WHERE order_id = $1;`,
        [appId]
      );
    });

    await logMemberCardAudit({
      customer_id: application.customer_id,
      action: 'MEMBERSHIP_PAYMENT_VERIFIED',
      actor_role: 'OWNER',
      actor_id: req.user.id,
      details: `₹10 payment proof verified for application ${appId}`
    });

    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      customer_id: application.customer_id,
      title: '🎉 ₹10 Premium Food Card Payment Verified!',
      message: 'Your ₹10 Premium Food Member Card payment proof has been verified by the Owner. Your membership card is awaiting final approval.',
      type: 'MEMBER_CARD',
      priority: 'HIGH',
      action_url: '/#secCustomerMemberCard'
    });

    res.json({
      success: true,
      message: "₹10 Payment proof verified successfully! Application is ready for final approval."
    });
  } catch (err) {
    console.error('Verify Payment Proof Error:', err);
    res.status(500).json({ success: false, message: "Failed to verify payment proof." });
  }
});

// 5C. POST /api/food-member/owner/reject-payment/:id - Owner Reject Payment Proof
app.post('/api/food-member/owner/reject-payment/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const appId = req.params.id;
    const { rejection_reason } = req.body;
    const nowIso = new Date().toISOString();

    if (!rejection_reason || !rejection_reason.trim()) {
      return res.status(400).json({ success: false, message: "Please provide a rejection reason." });
    }

    const appRes = await db.query(`SELECT * FROM food_member_applications WHERE id = $1;`, [appId]);
    if (!appRes.rows || appRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Application not found." });
    }
    const application = appRes.rows[0];

    await db.executeTransaction(async (tx) => {
      await tx.query(
        `UPDATE food_member_applications SET payment_status = 'REJECTED', rejection_reason = $1, updated_at = $2 WHERE id = $3;`,
        [rejection_reason.trim(), nowIso, appId]
      );
      await tx.query(
        `UPDATE payments SET payment_status = 'Rejected', notes = $1 WHERE order_id = $2;`,
        [`₹10 Payment Proof REJECTED: ${rejection_reason.trim()}`, appId]
      );
    });

    await logMemberCardAudit({
      customer_id: application.customer_id,
      action: 'MEMBERSHIP_PAYMENT_REJECTED',
      actor_role: 'OWNER',
      actor_id: req.user.id,
      details: `Payment proof rejected for application ${appId}. Reason: ${rejection_reason.trim()}`
    });

    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      customer_id: application.customer_id,
      title: '❌ Premium Food Card Payment Proof Rejected',
      message: `Your ₹10 payment proof was rejected. Reason: ${rejection_reason.trim()}. Please submit a valid payment screenshot and UTR.`,
      type: 'MEMBER_CARD',
      priority: 'HIGH',
      action_url: '/#secCustomerMemberCard'
    });

    res.json({
      success: true,
      message: "Payment proof rejected."
    });
  } catch (err) {
    console.error('Reject Payment Proof Error:', err);
    res.status(500).json({ success: false, message: "Failed to reject payment proof." });
  }
});

// 5D. POST /api/food-member/resubmit-proof - Customer Resubmit Payment Proof
app.post('/api/food-member/resubmit-proof', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const customerId = req.user.id;
    const { payment_method, utr_number, payment_screenshot } = req.body;
    const nowIso = new Date().toISOString();

    const appRes = await db.query(
      `SELECT * FROM food_member_applications WHERE customer_id = $1 AND (payment_status = 'REJECTED' OR status = 'REJECTED');`,
      [customerId]
    );

    if (!appRes.rows || appRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: "No rejected application eligible for resubmission." });
    }

    const application = appRes.rows[0];
    const cleanUtr = utr_number ? utr_number.trim() : null;

    if (cleanUtr) {
      const dupRes = await db.query(
        `SELECT id FROM food_member_applications WHERE payment_reference = $1 AND id != $2;`,
        [cleanUtr, application.id]
      );
      if (dupRes.rows && dupRes.rows.length > 0) {
        return res.status(400).json({ success: false, message: `⚠️ This Payment UTR (${cleanUtr}) has already been used by another application.` });
      }
    }

    let savedScreenshotUrl = application.screenshot_url;
    if (payment_screenshot) {
      if (!payment_screenshot.startsWith('data:image/')) {
        return res.status(400).json({ success: false, message: "Invalid image format. Allowed formats: JPG, JPEG, PNG, WEBP." });
      }
      savedScreenshotUrl = await saveBase64Image(payment_screenshot, 'screenshots');
    }

    const payRef = cleanUtr || application.payment_reference;

    await db.executeTransaction(async (tx) => {
      await tx.query(
        `UPDATE food_member_applications SET 
          payment_method = $1, payment_status = 'VERIFICATION_PENDING', payment_reference = $2, 
          screenshot_url = $3, status = 'PENDING_APPROVAL', rejection_reason = NULL, updated_at = $4 
         WHERE id = $5;`,
        [payment_method || 'UPI', payRef, savedScreenshotUrl, nowIso, application.id]
      );
    });

    await logMemberCardAudit({
      customer_id: customerId,
      action: 'PAYMENT_PROOF_RESUBMITTED',
      actor_role: 'CUSTOMER',
      actor_id: customerId,
      details: `Resubmitted ₹10 payment proof for application ${application.id} (Ref: ${payRef})`
    });

    await createAndDispatchNotification({
      target_role: 'OWNER',
      title: '🔔 Resubmitted Payment Proof',
      message: `Resubmitted ₹10 Premium Food Card payment proof by ${req.user.name} requires verification.`,
      type: 'MEMBER_CARD',
      priority: 'HIGH',
      action_url: '/#secOwnerMemberCardApprovals'
    });

    res.json({
      success: true,
      message: "Your payment proof has been re-submitted successfully. Please wait for Owner verification."
    });
  } catch (err) {
    console.error('Resubmit Payment Proof Error:', err);
    res.status(500).json({ success: false, message: "Failed to resubmit payment proof." });
  }
});

// 6. POST /api/food-member/owner/suspend/:id & reactivate/:id - Owner Card Controls
app.post('/api/food-member/owner/suspend/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const cardId = req.params.id;
    const nowIso = new Date().toISOString();
    await db.query(`UPDATE food_member_cards SET status = 'SUSPENDED', updated_at = $1 WHERE id = $2;`, [nowIso, cardId]);
    res.json({ success: true, message: "Member card suspended." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to suspend card." });
  }
});

app.post('/api/food-member/owner/reactivate/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const cardId = req.params.id;
    const nowIso = new Date().toISOString();
    await db.query(`UPDATE food_member_cards SET status = 'ACTIVE', updated_at = $1 WHERE id = $2;`, [nowIso, cardId]);
    res.json({ success: true, message: "Member card reactivated." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to reactivate card." });
  }
});

// 6B. DELETE /api/food-member/owner/application/:id - Owner Delete Individual Member Application/Card Record
app.delete('/api/food-member/owner/application/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const appId = req.params.id;

    const appRes = await db.query(`SELECT * FROM food_member_applications WHERE id = $1;`, [appId]);
    if (!appRes.rows || appRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Application record not found." });
    }
    const application = appRes.rows[0];

    await db.executeTransaction(async (tx) => {
      await tx.query(`DELETE FROM food_member_cards WHERE application_id = $1 OR customer_id = $2;`, [appId, application.customer_id]);
      await tx.query(`DELETE FROM food_member_applications WHERE id = $1;`, [appId]);
    });

    await logMemberCardAudit({
      customer_id: application.customer_id,
      action: 'APPLICATION_DELETED',
      actor_role: 'OWNER',
      actor_id: req.user.id,
      details: `Owner deleted membership record ${appId}`
    });

    // Notify Customer about card removal
    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      customer_id: application.customer_id,
      title: '❌ Premium Food Member Card Status',
      message: 'Your Food Member Card has been removed by the Owner. Please contact the Owner for more information.',
      type: 'MEMBER_CARD',
      priority: 'HIGH'
    });

    res.json({
      success: true,
      message: "Premium Food Member record deleted successfully."
    });
  } catch (err) {
    console.error('Delete Member Record Error:', err);
    res.status(500).json({ success: false, message: "Failed to delete membership record." });
  }
});

// 6C. DELETE /api/food-member/owner/applications/all - Owner Delete All Member Applications/Cards Records
app.delete('/api/food-member/owner/applications/all', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    await db.executeTransaction(async (tx) => {
      await tx.query(`DELETE FROM food_member_cards;`);
      await tx.query(`DELETE FROM food_member_applications;`);
    });

    await logMemberCardAudit({
      customer_id: null,
      action: 'ALL_APPLICATIONS_DELETED',
      actor_role: 'OWNER',
      actor_id: req.user.id,
      details: `Owner cleared all Premium Food Member Card records`
    });

    res.json({
      success: true,
      message: "All Premium Food Member Card records cleared successfully."
    });
  } catch (err) {
    console.error('Delete All Member Records Error:', err);
    res.status(500).json({ success: false, message: "Failed to clear membership records." });
  }
});

// 7. GET /api/food-member/verify/:code - Public Verification Endpoint
app.get('/api/food-member/verify/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const cardRes = await db.query(
      `SELECT member_id, customer_name, status, valid_from, valid_until, discount_amount, express_delivery_eligible
       FROM food_member_cards 
       WHERE qr_verification_code = $1 OR member_id = $1;`,
      [code]
    );

    if (!cardRes.rows || cardRes.rows.length === 0) {
      return res.json({ valid: false, message: "Invalid or non-existent Food Member Card." });
    }

    const card = cardRes.rows[0];
    const isExpired = new Date(card.valid_until).getTime() <= Date.now();
    const isVerifiedActive = card.status === 'ACTIVE' && !isExpired;

    res.json({
      valid: isVerifiedActive,
      status: isExpired ? 'EXPIRED' : card.status,
      member_id: card.member_id,
      customer_name: card.customer_name,
      valid_from: card.valid_from,
      valid_until: card.valid_until,
      benefits: "₹5 OFF + Express Delivery"
    });
  } catch (err) {
    res.status(500).json({ valid: false, message: "Verification error." });
  }
});

app.post('/api/referrals/privacy', authenticateToken, async (req, res) => {
  try {
    const { show_on_leaderboard } = req.body;
    const newState = Boolean(show_on_leaderboard);
    await db.query('UPDATE users SET show_on_leaderboard = $1 WHERE id = $2;', [newState, req.user.id]);
    res.json({ success: true, message: `Leaderboard privacy updated.` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to update privacy settings." });
  }
});

// =========================================================================
// OWNER-ONLY CUSTOMER ACCOUNT MANAGEMENT ENDPOINTS
// =========================================================================

// 1. Fetch All Customer Accounts with Statistics & Order Counts
app.get('/api/owner/customers', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'OWNER') {
      return res.status(403).json({ success: false, message: "Unauthorized access. Owner privileges required." });
    }

    const { status, search, sort } = req.query;

    let queryStr = `
      SELECT u.id, u.name, u.email, u.mobile, u.address, u.referral_code, COALESCE(u.status, 'active') as status, 
             u.blocked_at, u.blocked_by, u.created_at,
             COUNT(o.id) as total_orders,
             MAX(o.created_at) as last_order_date,
             COALESCE(SUM(o.net_amount), 0) as total_spent
      FROM users u
      LEFT JOIN orders o ON o.customer_id = u.id
      WHERE u.role = 'CUSTOMER' AND (u.status IS NULL OR u.status != 'deleted')
    `;
    let params = [];

    if (status && status !== 'All') {
      params.push(status.toLowerCase());
      queryStr += ` AND LOWER(COALESCE(u.status, 'active')) = $${params.length}`;
    }

    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      queryStr += ` AND (LOWER(u.name) LIKE $${params.length} OR LOWER(COALESCE(u.email, '')) LIKE $${params.length} OR u.mobile LIKE $${params.length} OR LOWER(COALESCE(u.referral_code, '')) LIKE $${params.length})`;
    }

    queryStr += ` GROUP BY u.id, u.name, u.email, u.mobile, u.address, u.referral_code, u.status, u.blocked_at, u.blocked_by, u.created_at`;

    if (sort === 'oldest') {
      queryStr += ` ORDER BY u.created_at ASC;`;
    } else {
      queryStr += ` ORDER BY u.created_at DESC;`;
    }

    const cRes = await db.query(queryStr, params);
    res.json({ success: true, data: cRes.rows || [] });
  } catch (err) {
    console.error('Fetch Owner Customers Error:', err);
    res.status(500).json({ success: false, message: "Error fetching customer accounts." });
  }
});

// 2. Fetch Single Customer Details, Profile & Recent Orders
app.get('/api/owner/customers/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'OWNER') {
      return res.status(403).json({ success: false, message: "Unauthorized access. Owner privileges required." });
    }

    const { id } = req.params;
    const uRes = await db.query('SELECT * FROM users WHERE id = $1 AND role = $2;', [id, 'CUSTOMER']);
    if (!uRes.rows || !uRes.rows.length) {
      return res.status(404).json({ success: false, message: "Customer account not found." });
    }

    const customer = sanitizeUser(uRes.rows[0]);
    const ordersRes = await db.query('SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC;', [id]);
    const orders = ordersRes.rows || [];

    const totalOrders = orders.length;
    const completedOrders = orders.filter(o => o.order_status === 'Delivered' || o.order_status === 'Completed').length;
    const pendingOrders = orders.filter(o => ['Received', 'Accepted', 'Preparing', 'Out for Delivery'].includes(o.order_status)).length;
    const cancelledOrders = orders.filter(o => o.order_status === 'Cancelled' || o.order_status === 'Rejected').length;
    const totalSpent = orders.reduce((sum, o) => sum + Number(o.net_amount || 0), 0);

    res.json({
      success: true,
      data: {
        customer,
        stats: {
          totalOrders,
          completedOrders,
          pendingOrders,
          cancelledOrders,
          totalSpent
        },
        recentOrders: orders.slice(0, 10)
      }
    });
  } catch (err) {
    console.error('Fetch Customer Details Error:', err);
    res.status(500).json({ success: false, message: "Error fetching customer details." });
  }
});

// 3. Update Customer Status (Block / Unblock)
app.patch('/api/owner/customers/:id/status', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'OWNER') {
      return res.status(403).json({ success: false, message: "Unauthorized access. Owner privileges required." });
    }

    const { id } = req.params;
    const { status } = req.body;
    const newStatus = (status || '').toLowerCase().trim();

    if (!['active', 'blocked'].includes(newStatus)) {
      return res.status(400).json({ success: false, message: "Invalid status value. Allowed: active, blocked." });
    }

    const uRes = await db.query('SELECT id, name, role FROM users WHERE id = $1 AND role = $2;', [id, 'CUSTOMER']);
    if (!uRes.rows || !uRes.rows.length) {
      return res.status(404).json({ success: false, message: "Customer account not found." });
    }

    const blockedAt = newStatus === 'blocked' ? new Date().toISOString() : null;
    const blockedBy = newStatus === 'blocked' ? req.user.name : null;

    await db.query(
      `UPDATE users SET status = $1, blocked_at = $2, blocked_by = $3 WHERE id = $4 AND role = 'CUSTOMER';`,
      [newStatus, blockedAt, blockedBy, id]
    );

    // Invalidate sessions immediately if blocked
    if (newStatus === 'blocked') {
      await db.query('DELETE FROM tokens WHERE user_id = $1;', [id]);
    }

    res.json({
      success: true,
      message: newStatus === 'blocked' ? 'Customer blocked successfully.' : 'Customer unblocked successfully.'
    });
  } catch (err) {
    console.error('Update Customer Status Error:', err);
    res.status(500).json({ success: false, message: "Error updating customer account status." });
  }
});

// 4. Delete Customer Account Safely (Preserve Order & Payment History)
app.delete('/api/owner/customers/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'OWNER') {
      return res.status(403).json({ success: false, message: "Unauthorized access. Owner privileges required." });
    }

    const { id } = req.params;
    const uRes = await db.query('SELECT id, name, role FROM users WHERE id = $1 AND role = $2;', [id, 'CUSTOMER']);
    if (!uRes.rows || !uRes.rows.length) {
      return res.status(404).json({ success: false, message: "Customer account not found." });
    }

    const custName = uRes.rows[0].name;

    // Disassociate orders and payments customer_id reference to preserve order/financial history
    await db.query('UPDATE orders SET customer_id = NULL WHERE customer_id = $1;', [id]);
    await db.query('UPDATE payments SET customer_id = NULL WHERE customer_id = $1;', [id]);

    // Delete active sessions and customer user record
    await db.query('DELETE FROM tokens WHERE user_id = $1;', [id]);
    await db.query('DELETE FROM users WHERE id = $1 AND role = $2;', [id, 'CUSTOMER']);

    res.json({
      success: true,
      message: `Customer account deleted successfully.`
    });
  } catch (err) {
    console.error('Delete Customer Account Error:', err);
    res.status(500).json({ success: false, message: "Error deleting customer account." });
  }
});

// 5. Owner Reset Customer Password (Generates Secure Temporary Password)
app.post('/api/owner/customers/:id/reset-password', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'OWNER') {
      return res.status(403).json({ success: false, message: "Unauthorized access. Owner privileges required." });
    }

    const { id } = req.params;
    const uRes = await db.query('SELECT id, name, mobile, role FROM users WHERE id = $1 AND role = $2;', [id, 'CUSTOMER']);
    if (!uRes.rows || !uRes.rows.length) {
      return res.status(404).json({ success: false, message: "Customer account not found." });
    }

    const customer = uRes.rows[0];

    // Generate secure random temporary password (8 characters: upper, lower, numbers)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let tempPassword = '';
    const randomBytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
      tempPassword += chars[randomBytes[i] % chars.length];
    }

    const hashedPassword = bcrypt.hashSync(tempPassword, 10);
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

    await db.query(
      `UPDATE users SET password = $1, password_change_required = true, temp_password_expires_at = $2 WHERE id = $3 AND role = 'CUSTOMER';`,
      [hashedPassword, expiresAt, id]
    );

    // Invalidate existing sessions for customer so they must log in with temporary password
    await db.query('DELETE FROM tokens WHERE user_id = $1;', [id]);

    // Record audit log safely (WITHOUT sensitive plaintext password)
    console.log(`[AUDIT EVENT] Customer password reset by Owner: Customer ID ${customer.id} (${customer.name}, ${customer.mobile}) by Owner ${req.user.name} at ${new Date().toISOString()}`);

    try {
      const nowStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const resetNotif = {
        id: 'ntf_' + Date.now(),
        target_role: 'OWNER',
        customer_id: id,
        title: 'Customer Password Reset',
        message: `Password manually reset by Owner for customer ${customer.name} (${customer.mobile}).`,
        type: 'INFO',
        is_read: false,
        date_time: nowStr
      };
      await db.query(
        `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [resetNotif.id, resetNotif.target_role, resetNotif.customer_id, resetNotif.title, resetNotif.message, resetNotif.type, resetNotif.is_read, resetNotif.date_time]
      );
      dispatchRealTimeNotification(resetNotif);
    } catch (nErr) {
      // Non-blocking audit log catch
    }

    res.json({
      success: true,
      temporaryPassword: tempPassword,
      customer: {
        id: customer.id,
        name: customer.name,
        mobile: customer.mobile
      },
      message: "Customer password reset successfully."
    });
  } catch (err) {
    console.error('Reset Customer Password Error:', err);
    res.status(500).json({ success: false, message: "Error resetting customer password." });
  }
});

// =========================================================================
// SUPPORT TICKETS & MESSAGES API
// =========================================================================

app.get('/api/support/faqs', async (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 1, question: "What are your opening hours?", answer: "We are open 7 days a week from 06:30 AM to 10:30 PM." },
      { id: 2, question: "How does QR Pay payment work?", answer: "Scan our official UPI QR code at checkout, make the payment via any UPI app (GPay/PhonePe/Paytm), enter the UTR / Transaction ID and upload the payment screenshot." },
      { id: 3, question: "How does the Referral & Earn program work?", answer: "Share your referral code with friends. When they register and place their first order, you receive ₹30 added to your wallet!" },
      { id: 4, question: "Can I cancel my order?", answer: "Orders can be cancelled before the hotel begins preparing your tiffins. Contact support or call helpline +91 9392874900 for assistance." }
    ]
  });
});

app.get('/api/support/tickets', authenticateToken, async (req, res) => {
  try {
    let queryStr = 'SELECT * FROM support_tickets ORDER BY created_at DESC;';
    let params = [];
    if (req.user.role === 'CUSTOMER') {
      queryStr = 'SELECT * FROM support_tickets WHERE customer_id = $1 ORDER BY created_at DESC;';
      params = [req.user.id];
    }
    const tRes = await db.query(queryStr, params);
    const tickets = tRes.rows || [];

    for (let t of tickets) {
      const mRes = await db.query('SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY created_at ASC;', [t.id]);
      t.messages = mRes.rows || [];
    }

    res.json({ success: true, data: tickets });
  } catch (err) {
    console.error('Fetch Support Tickets Error:', err);
    res.status(500).json({ success: false, message: "Error fetching support tickets." });
  }
});

app.post('/api/support/tickets', authenticateToken, async (req, res) => {
  try {
    const { subject, message, order_number, category } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, message: "Ticket message is required." });
    }
    const ticketId = 'tkt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const ticketNum = await db.getNextCounter('ticket_counter');

    await db.query(
      `INSERT INTO support_tickets (id, ticket_number, customer_id, customer_name, customer_mobile, order_number, category, subject, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [ticketId, ticketNum, req.user.id, req.user.name, req.user.mobile, order_number || null, category || 'General', subject || 'Support Request', 'Open']
    );

    // Initial message in support_messages
    await db.query(
      `INSERT INTO support_messages (id, ticket_id, sender_role, sender_name, message, date_time)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      ['msg_' + Date.now(), ticketId, req.user.role, req.user.name, message.trim(), new Date().toLocaleString('en-IN')]
    );

    // Notify Owner
    const tktNotif = {
      id: 'notif_' + Date.now(),
      target_role: 'OWNER',
      customer_id: req.user.id,
      title: 'New Support Ticket',
      message: `Ticket #${ticketNum} created by ${req.user.name}: "${subject}"`,
      type: 'SUPPORT',
      is_read: false,
      date_time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    };
    await db.query(
      `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [tktNotif.id, tktNotif.target_role, tktNotif.customer_id, tktNotif.title, tktNotif.message, tktNotif.type, tktNotif.is_read, tktNotif.date_time]
    );
    dispatchRealTimeNotification(tktNotif);

    const createdRes = await db.query('SELECT * FROM support_tickets WHERE id = $1;', [ticketId]);
    res.json({ success: true, data: createdRes.rows[0], message: `Support ticket #${ticketNum} created successfully.` });
  } catch (err) {
    console.error('Create Ticket Error:', err);
    res.status(500).json({ success: false, message: "Error creating support ticket." });
  }
});

app.get('/api/support/tickets/:id/messages', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const mRes = await db.query('SELECT * FROM support_messages WHERE ticket_id = $1 OR ticket_id = (SELECT id FROM support_tickets WHERE ticket_number::text = $1 LIMIT 1) ORDER BY created_at ASC;', [id]);
    res.json({ success: true, data: mRes.rows || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error fetching ticket messages." });
  }
});

app.post('/api/support/tickets/:id/messages', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: "Message content cannot be empty." });
    }

    const tRes = await db.query('SELECT * FROM support_tickets WHERE id = $1 OR ticket_number::text = $1;', [id]);
    if (!tRes.rows || tRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Ticket not found." });
    }
    const ticket = tRes.rows[0];

    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const senderRole = req.user.role;
    const senderName = req.user.name;

    await db.query(
      `INSERT INTO support_messages (id, ticket_id, sender_role, sender_name, message, date_time)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [msgId, ticket.id, senderRole, senderName, message.trim(), new Date().toLocaleString('en-IN')]
    );

    await db.query('UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = $1;', [ticket.id]);

    // Send Notification to recipient
    if (senderRole === 'OWNER') {
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: ticket.customer_id,
        title: 'Support Ticket Reply',
        message: `Hotel Owner replied to ticket #${ticket.ticket_number}: "${message.slice(0, 50)}..."`,
        type: 'SUPPORT',
        action_url: '/#secCustomerSupport'
      });
    } else if (senderRole === 'CUSTOMER') {
      await createAndDispatchNotification({
        target_role: 'OWNER',
        title: 'New Support Ticket Reply',
        message: `${ticket.customer_name} replied to ticket #${ticket.ticket_number}`,
        type: 'SUPPORT',
        priority: 'HIGH',
        action_url: '/#secOwnerSupport'
      });
    }

    const updatedMsgs = await db.query('SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY created_at ASC;', [ticket.id]);
    res.json({ success: true, data: updatedMsgs.rows, message: "Message sent successfully." });
  } catch (err) {
    console.error('Send Ticket Message Error:', err);
    res.status(500).json({ success: false, message: "Failed to send message." });
  }
});

app.patch('/api/support/tickets/:id/status', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    await db.query('UPDATE support_tickets SET status = $1 WHERE id = $2 OR ticket_number::text = $2;', [status || 'Resolved', id]);
    const updated = await db.query('SELECT * FROM support_tickets WHERE id = $1 OR ticket_number::text = $1;', [id]);
    res.json({ success: true, data: updated.rows[0], message: `Ticket status updated to ${status}.` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error updating ticket status." });
  }
});

app.delete('/api/support/tickets/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM support_tickets WHERE id = $1 OR ticket_number::text = $1;', [id]);
    res.json({ success: true, message: "Support ticket deleted permanently." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete support ticket." });
  }
});

// =========================================================================
// CUSTOMER HISTORY DELETION & REVIEWS API
// =========================================================================

app.delete('/api/customer/orders/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM orders WHERE (id = $1 OR order_number = $1) AND customer_id = $2;', [id, req.user.id]);
    res.json({ success: true, message: "Order removed from history." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to remove order." });
  }
});

app.delete('/api/customer/orders', authenticateToken, async (req, res) => {
  try {
    await db.query("DELETE FROM orders WHERE customer_id = $1 AND order_status IN ('Delivered', 'Cancelled', 'Rejected');", [req.user.id]);
    res.json({ success: true, message: "Order history cleared." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to clear order history." });
  }
});

app.delete('/api/customer/payments/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM payments WHERE id = $1 AND customer_id = $2;', [id, req.user.id]);
    res.json({ success: true, message: "Payment log deleted." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete payment." });
  }
});

app.delete('/api/customer/payments', authenticateToken, async (req, res) => {
  try {
    await db.query('DELETE FROM payments WHERE customer_id = $1;', [req.user.id]);
    res.json({ success: true, message: "Payment history cleared." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to clear payment history." });
  }
});

app.get('/api/reviews/stats', async (req, res) => {
  try {
    const rRes = await db.query('SELECT rating FROM reviews WHERE is_visible = true;');
    const rows = rRes.rows || [];
    const total = rows.length;
    const avg = total > 0 ? (rows.reduce((s, r) => s + Number(r.rating || 5), 0) / total).toFixed(1) : "5.0";
    res.json({ success: true, data: { average_rating: Number(avg), total_reviews: total } });
  } catch (err) {
    res.json({ success: true, data: { average_rating: 5.0, total_reviews: 0 } });
  }
});

app.get('/api/reviews', optionalAuth, async (req, res) => {
  try {
    let queryStr = 'SELECT * FROM reviews WHERE is_visible = true ORDER BY created_at DESC;';
    if (req.user && req.user.role === 'OWNER') {
      queryStr = 'SELECT * FROM reviews ORDER BY created_at DESC;';
    }
    const rRes = await db.query(queryStr);
    res.json({ success: true, data: rRes.rows || [] });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

app.post('/api/reviews', authenticateToken, async (req, res) => {
  try {
    const { order_number, rating, comment } = req.body;
    const numRating = Number(rating);

    if (!numRating || isNaN(numRating) || numRating < 1 || numRating > 5) {
      return res.status(400).json({ success: false, message: "Please select a valid 1-5 star rating." });
    }

    if (!order_number) {
      return res.status(400).json({ success: false, message: "Order number is required." });
    }

    // Verify order exists and belongs to authenticated customer
    const orderRes = await db.query('SELECT * FROM orders WHERE order_number = $1;', [order_number]);
    const order = orderRes.rows[0];
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    if (req.user.role === 'CUSTOMER' && order.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "Access denied. You can only review your own orders." });
    }

    // Check if review already exists for this order
    const existingRevRes = await db.query(
      'SELECT * FROM reviews WHERE order_number = $1 AND customer_id = $2;',
      [order_number, req.user.id]
    );

    const nowFormatted = new Date().toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    let reviewData;
    if (existingRevRes.rows && existingRevRes.rows.length > 0) {
      // Update existing review
      const existingRev = existingRevRes.rows[0];
      await db.query(
        `UPDATE reviews SET rating = $1, comment = $2, is_visible = true, date_time = $3 WHERE id = $4;`,
        [numRating, comment || '', nowFormatted, existingRev.id]
      );
      reviewData = {
        ...existingRev,
        rating: numRating,
        comment: comment || '',
        date_time: nowFormatted
      };
      return res.json({
        success: true,
        message: "Your review has been updated successfully!",
        data: reviewData
      });
    } else {
      // Insert new review
      const revId = 'rev_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      await db.query(
        `INSERT INTO reviews (id, order_number, customer_id, customer_name, rating, comment, is_visible, date_time)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7);`,
        [revId, order_number, req.user.id, req.user.name, numRating, comment || '', nowFormatted]
      );
      reviewData = {
        id: revId,
        order_number: order_number,
        customer_id: req.user.id,
        customer_name: req.user.name,
        rating: numRating,
        comment: comment || '',
        is_visible: true,
        date_time: nowFormatted
      };
      return res.json({
        success: true,
        message: "Thank you for your feedback! Review submitted successfully.",
        data: reviewData
      });
    }
  } catch (err) {
    console.error('Error in POST /api/reviews:', err);
    return res.status(500).json({ success: false, message: "Failed to submit review. Please try again." });
  }
});

app.patch('/api/reviews/:id/visibility', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { is_visible } = req.body;
    await db.query('UPDATE reviews SET is_visible = $1 WHERE id = $2;', [Boolean(is_visible), id]);
    res.json({ success: true, message: "Review visibility updated." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to update review visibility." });
  }
});

app.post('/api/reviews/:id/reply', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reply } = req.body;
    await db.query('UPDATE reviews SET owner_reply = $1, reply_date_time = $2 WHERE id = $3;', [reply || '', new Date().toLocaleString('en-IN'), id]);
    res.json({ success: true, message: "Owner reply published." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to post reply." });
  }
});

app.delete('/api/reviews/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM reviews WHERE id = $1;', [id]);
    res.json({ success: true, message: "Review deleted." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to delete review." });
  }
});

// =========================================================================
// NOTIFICATIONS API
// =========================================================================

// GET /api/notifications/diagnostics - Centralized Notification Diagnostics Endpoint
app.get('/api/notifications/diagnostics', authenticateToken, async (req, res) => {
  try {
    const notifCount = await db.query('SELECT COUNT(*) FROM notifications;');
    const pushCount = await db.query('SELECT COUNT(*) FROM push_subscriptions;');
    const ownerSubs = await db.query("SELECT COUNT(*) FROM push_subscriptions WHERE UPPER(role) = 'OWNER';");
    const custSubs = await db.query("SELECT COUNT(*) FROM push_subscriptions WHERE UPPER(role) = 'CUSTOMER';");
    
    let activeWsCount = 0;
    let wsOwnerCount = 0;
    let wsCustCount = 0;

    activeWsClients.forEach((client, ws) => {
      if (ws.readyState === 1) {
        activeWsCount++;
        if (client.role === 'OWNER') wsOwnerCount++;
        else wsCustCount++;
      }
    });

    res.json({
      success: true,
      data: {
        total_notifications_in_db: Number(notifCount.rows[0]?.count || 0),
        total_push_subscriptions: Number(pushCount.rows[0]?.count || 0),
        owner_push_subscriptions: Number(ownerSubs.rows[0]?.count || 0),
        customer_push_subscriptions: Number(custSubs.rows[0]?.count || 0),
        active_websocket_connections: activeWsCount,
        active_websocket_owners: wsOwnerCount,
        active_websocket_customers: wsCustCount,
        vapid_configured: Boolean(vapidPublicKey)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/notifications', authenticateToken, async (req, res) => {

  try {
    let queryStr = "SELECT * FROM notifications WHERE target_role = 'OWNER' ORDER BY created_at DESC;";
    let params = [];
    if (req.user.role === 'CUSTOMER') {
      queryStr = "SELECT * FROM notifications WHERE target_role = 'CUSTOMER' AND (customer_id = $1 OR customer_id IS NULL) ORDER BY created_at DESC;";
      params = [req.user.id];
    }
    const nRes = await db.query(queryStr, params);
    res.json({ success: true, data: nRes.rows });
  } catch (err) {
    console.error('Fetch Notifications Error:', err);
    res.status(500).json({ success: false, message: "Failed to fetch notifications." });
  }
});

app.patch('/api/notifications/read-all', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'CUSTOMER') {
      await db.query("UPDATE notifications SET is_read = true WHERE target_role = 'CUSTOMER' AND (customer_id = $1 OR customer_id IS NULL);", [req.user.id]);
    } else {
      await db.query("UPDATE notifications SET is_read = true WHERE target_role = 'OWNER';");
    }
    res.json({ success: true, message: "Notifications marked as read." });
  } catch (err) {
    console.error('Read All Notifications Error:', err);
    res.status(500).json({ success: false, message: "Failed to mark notifications read." });
  }
});

app.patch('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.role === 'CUSTOMER') {
      await db.query(
        "UPDATE notifications SET is_read = true WHERE id = $1 AND target_role = 'CUSTOMER' AND (customer_id = $2 OR customer_id IS NULL);",
        [id, req.user.id]
      );
    } else {
      await db.query("UPDATE notifications SET is_read = true WHERE id = $1 AND target_role = 'OWNER';", [id]);
    }
    res.json({ success: true, message: "Notification marked as read." });
  } catch (err) {
    console.error('Read Notification Error:', err);
    res.status(500).json({ success: false, message: "Failed to mark notification as read." });
  }
});

app.delete('/api/notifications/clear-all', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'CUSTOMER') {
      await db.query(
        "DELETE FROM notifications WHERE target_role = 'CUSTOMER' AND (customer_id = $1 OR customer_id IS NULL);",
        [req.user.id]
      );
    } else {
      await db.query("DELETE FROM notifications WHERE target_role = 'OWNER';");
    }
    res.json({ success: true, message: "All notifications cleared permanently from database." });
  } catch (err) {
    console.error('Clear All Notifications Error:', err);
    res.status(500).json({ success: false, message: "Failed to clear notifications." });
  }
});

app.delete('/api/notifications/clear', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'CUSTOMER') {
      await db.query(
        "DELETE FROM notifications WHERE target_role = 'CUSTOMER' AND (customer_id = $1 OR customer_id IS NULL);",
        [req.user.id]
      );
    } else {
      await db.query("DELETE FROM notifications WHERE target_role = 'OWNER';");
    }
    res.json({ success: true, message: "All notifications cleared permanently from database." });
  } catch (err) {
    console.error('Clear Notifications Error:', err);
    res.status(500).json({ success: false, message: "Failed to clear notifications." });
  }
});

app.delete('/api/notifications/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.role === 'CUSTOMER') {
      await db.query(
        "DELETE FROM notifications WHERE id = $1 AND target_role = 'CUSTOMER' AND (customer_id = $2 OR customer_id IS NULL);",
        [id, req.user.id]
      );
    } else {
      await db.query("DELETE FROM notifications WHERE id = $1 AND target_role = 'OWNER';", [id]);
    }
    res.json({ success: true, message: "Notification deleted permanently from database." });
  } catch (err) {
    console.error('Delete Notification Error:', err);
    res.status(500).json({ success: false, message: "Failed to delete notification." });
  }
});

// Catch-all SPA route to serve index.html for root and client routes
// Missing images/assets return a real 404 (instead of the HTML shell) so broken
// image links never render as blank/broken QR scanner images.
app.get('*', (req, res) => {
  const acceptsHtml = (req.headers.accept || '').includes('text/html');
  if (!acceptsHtml) {
    return res.status(404).json({ success: false, message: 'Not found.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server & Initialize PostgreSQL Database
server.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  try {
    await db.initDatabase();
    const tiffinCheck = await db.query('SELECT COUNT(*) FROM tiffins;');
    const tCount = Number(tiffinCheck.rows[0]?.count || 0);
    if (tCount === 0) {
      console.log('PostgreSQL database empty — populating seed data from seed_data.json...');
      const migrate = require('./migrate_to_postgres');
      await migrate();
    }
  } catch (err) {
    console.error('PostgreSQL Database Initialization Notice:', err.message);
  }
});
