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

// HTTP Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// In-Memory Rate Limiter Engine
const rateLimitMap = new Map();

// Periodic cleanup of expired rate limit records
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, 10 * 60 * 1000);

function createRateLimiter(options) {
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const maxRequests = options.max || 15;
  const message = options.message || "Too many requests, please try again later.";
  const keyPrefix = options.prefix || 'rl';

  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const userId = req.user ? req.user.id : '';
    const key = `${keyPrefix}:${ip}:${userId}`;
    const now = Date.now();

    let record = rateLimitMap.get(key);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      rateLimitMap.set(key, record);
      return next();
    }

    record.count++;
    if (record.count > maxRequests) {
      const retryAfterSec = Math.ceil((record.resetTime - now) / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({
        success: false,
        message,
        retryAfterSeconds: retryAfterSec
      });
    }

    next();
  };
}

const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 15, prefix: 'auth', message: 'Too many authentication attempts. Please try again in 15 minutes.' });
const otpLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, prefix: 'otp', message: 'Too many OTP verification attempts. Please try again in 15 minutes.' });
const orderLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, prefix: 'order', message: 'Order submission rate limit exceeded. Please wait a moment.' });

// HTML Sanitization Helper for XSS Prevention
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

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Base64 Image Persistence & Upload Security Helper
async function saveBase64Image(base64Data, subfolder = 'screenshots') {
  if (!base64Data) return null;
  if (!base64Data.startsWith('data:image/')) return base64Data;

  try {
    const uploadsDir = path.join(__dirname, 'public', 'uploads', subfolder);
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const matches = base64Data.match(/^data:image\/([a-zA-Z0-9+\-+.]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return base64Data;
    }

    const rawExt = matches[1].toLowerCase();
    const allowedExts = ['jpeg', 'jpg', 'png', 'webp'];
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;

    if (!allowedExts.includes(ext)) {
      console.warn('Blocked upload of unauthorized format:', rawExt);
      return null;
    }

    const buffer = Buffer.from(matches[2], 'base64');
    if (buffer.length > 5 * 1024 * 1024) {
      console.warn('Blocked upload exceeding 5MB size limit:', buffer.length);
      return null;
    }

    // Generate safe alphanumeric random filename to prevent path traversal
    const safeRandomHex = crypto.randomBytes(8).toString('hex');
    const fileName = `proof_${Date.now()}_${safeRandomHex}.${ext}`;
    const filePath = path.join(uploadsDir, fileName);

    fs.writeFileSync(filePath, buffer);
    return `/uploads/${subfolder}/${fileName}`;
  } catch (err) {
    console.error('saveBase64Image persistence notice:', err);
    return base64Data;
  }
}

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
async function createAndDispatchNotification(notifData, dbClient = db) {
  try {
    if (!notifData) return null;
    const title = notifData.title || 'Notification';
    const message = notifData.message || '';
    if (!title || !message) return null;

    const target_role = notifData.target_role || 'CUSTOMER';
    const customer_id = notifData.customer_id || null;
    const type = notifData.type || 'INFO';
    const priority = notifData.priority || 'NORMAL';
    const action_url = notifData.action_url || notifData.url || null;
    const related_order_id = notifData.related_order_id || null;
    const is_read = notifData.is_read || false;
    const notifId = notifData.id || ('notif_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7));
    const dateTimeStr = notifData.date_time || new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const nowIso = notifData.created_at || new Date().toISOString();

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

    const activeDb = dbClient || db;

    // Deduplication check: Avoid duplicate notification records created within 5 seconds for the same target, title & customer
    try {
      let dupCheckSql = `SELECT id, title, message, date_time, created_at FROM notifications WHERE target_role = $1 AND title = $2`;
      let dupParams = [target_role, title];
      if (customer_id) {
        dupCheckSql += ` AND customer_id = $3`;
        dupParams.push(customer_id);
      }
      dupCheckSql += ` ORDER BY created_at DESC LIMIT 1;`;
      const dupRes = await activeDb.query(dupCheckSql, dupParams);
      if (dupRes.rows && dupRes.rows.length > 0) {
        const lastNotif = dupRes.rows[0];
        const ageMs = Date.now() - new Date(lastNotif.created_at || Date.now()).getTime();
        if (ageMs < 5000) { // 5-second deduplication window
          console.log(`[Notification Engine] Deduplicated duplicate notification for ${target_role} (${title}).`);
          return lastNotif;
        }
      }
    } catch (dErr) { }

    // 1. Save ONE single notification record in PostgreSQL source of truth
    try {
      await activeDb.query(
        `INSERT INTO notifications (id, target_role, customer_id, title, message, type, priority, action_url, related_order_id, is_read, date_time, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
        [notifId, target_role, customer_id || null, title, message, type, priority, finalUrl, related_order_id || null, is_read, dateTimeStr, nowIso]
      );
    } catch (dbErr) {
      // Fallback if priority/action_url columns haven't migrated yet
      await activeDb.query(
        `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [notifId, target_role, customer_id || null, title, message, type, is_read, dateTimeStr, nowIso]
      );
    }

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
      is_read: Boolean(is_read),
      date_time: dateTimeStr,
      created_at: nowIso
    };

    // 2. Multi-channel dispatch across WebSocket (Instant In-App) & Web Push (Background/Closed App)
    // Non-blocking call to ensure fast HTTP response times
    dispatchRealTimeNotification(notifRecord).catch(err => {
      console.warn('[Central Notification Service] Non-blocking dispatch warning:', err.message);
    });

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
      body: notif.message || '',
      type: notif.type || 'INFO',
      priority: notif.priority || 'NORMAL',
      created_at: notif.created_at || notif.date_time || new Date().toISOString(),
      url: notif.action_url || notif.url || '/',
      action_url: notif.action_url || notif.url || '/',
      related_order_id: notif.related_order_id || null,
      icon: '/images/tiffin_logo.png',
      badge: '/images/icon-192.png'
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

// Master Notification Engine Service (defined above at line 276)

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
      const existingOrderNum = oRes.rows[0].order_number;
      logSecurityEvent({
        event_type: 'DUPLICATE_PAYMENT',
        risk_level: 'HIGH',
        order_id: currentOrderId,
        details: `Duplicate UTR reference "${cleanUtr}" submitted for order ${currentOrderId || 'N/A'} (Already used in Order ${existingOrderNum})`
      });
      return existingOrderNum;
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
      const existingOrderNum = pRes.rows[0].order_number;
      logSecurityEvent({
        event_type: 'DUPLICATE_PAYMENT',
        risk_level: 'HIGH',
        order_id: currentOrderId,
        details: `Duplicate UTR reference "${cleanUtr}" submitted for order ${currentOrderId || 'N/A'} (Already used in Payment for Order ${existingOrderNum})`
      });
      return existingOrderNum;
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
  const tokenQuery = req.query.token || req.query.t_auth;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (tokenHeader) {
    token = tokenHeader;
  } else if (tokenQuery) {
    token = tokenQuery;
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
app.post('/api/auth/register', authLimiter, async (req, res) => {
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
app.post('/api/auth/login', authLimiter, async (req, res) => {
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
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
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
app.post('/api/auth/verify-otp', otpLimiter, async (req, res) => {
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
app.post('/api/auth/reset-password', otpLimiter, async (req, res) => {
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

    let cardMap = new Map();
    try {
      const cardsRes = await db.query('SELECT customer_id, valid_from, valid_until, status FROM food_member_cards ORDER BY valid_until DESC, created_at DESC;');
      const now = new Date();
      (cardsRes.rows || []).forEach(c => {
        if (c.customer_id && !cardMap.has(c.customer_id)) {
          const vFrom = new Date(c.valid_from);
          const vUntil = new Date(c.valid_until);
          let vUntilEnd = new Date(vUntil);
          if (typeof c.valid_until === 'string' && c.valid_until.length <= 10) {
            vUntilEnd.setHours(23, 59, 59, 999);
          }
          if (vFrom <= now && now <= vUntilEnd) {
            cardMap.set(c.customer_id, c);
          }
        }
      });
    } catch (cErr) { }

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
      const activeCard = cardMap.get(o.customer_id) || null;
      o.customer_card_valid_until = activeCard ? activeCard.valid_until : null;
      o.customer_card_valid_from = activeCard ? activeCard.valid_from : null;
      o.customer_is_currently_premium = Boolean(activeCard);
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
      "SELECT id, order_number, customer_id, order_status, created_at, pickup_pin, preparation_minutes, estimated_ready_at FROM orders WHERE order_status IN ('Received', 'Preparing', 'Ready') ORDER BY created_at ASC, id ASC;"
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
        preparation_minutes: custOrder.preparation_minutes || 15,
        estimated_ready_at: custOrder.estimated_ready_at || new Date(new Date(custOrder.created_at || Date.now()).getTime() + (custOrder.preparation_minutes || 15) * 60000).toISOString(),
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

app.post('/api/orders', authenticateToken, requireRole('CUSTOMER'), orderLimiter, async (req, res) => {
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

    // Process optional Add-ons with Server-Side Price Protection
    const reqAddons = req.body.add_ons || [];
    let formattedAddons = [];
    let addonsTotal = 0;

    if (Array.isArray(reqAddons) && reqAddons.length > 0) {
      for (const addonReq of reqAddons) {
        const addonId = addonReq.add_on_id || addonReq.id;
        const qty = Math.min(10, Math.max(1, parseInt(addonReq.quantity || '1', 10)));
        if (!addonId) continue;

        const dbAddonRes = await db.query(
          `SELECT * FROM add_ons WHERE id = $1 AND enabled = true;`,
          [addonId]
        );
        if (!dbAddonRes.rows || dbAddonRes.rows.length === 0) {
          return res.status(400).json({ success: false, message: `Selected extra add-on is disabled or unavailable.` });
        }
        const dbAddon = dbAddonRes.rows[0];

        if (!dbAddon.available) {
          return res.status(400).json({ success: false, message: `Add-on "${dbAddon.name}" is currently out of stock / unavailable.` });
        }

        const unitPrice = Number(dbAddon.price || 0);
        const subtotal = unitPrice * qty;
        addonsTotal += subtotal;

        formattedAddons.push({
          add_on_id: dbAddon.id,
          add_on_name: dbAddon.name,
          quantity: qty,
          unit_price: unitPrice,
          subtotal: subtotal
        });
      }
    }

    grand_total += addonsTotal;

    // Process Delivery Zone & Address Snapshot if Order Type is Delivery
    let deliveryFeeAmount = 0.00;
    let deliveryZoneId = null;
    let deliveryZoneName = null;
    let deliveryAddressSnapshotJson = null;
    let finalDeliveryAddressText = delivery_address || '';

    if ((order_type || '').toLowerCase() === 'delivery') {
      const addressId = req.body.address_id;
      let selectedAddressRecord = null;
      let profileFallbackAddress = null;

      // Priority 1: Customer explicitly selected delivery address
      if (addressId && addressId !== 'profile_address') {
        const addrRes = await db.query(
          `SELECT * FROM customer_addresses WHERE id = $1 AND customer_id = $2;`,
          [addressId, req.user.id]
        );
        if (addrRes.rows && addrRes.rows.length > 0) {
          selectedAddressRecord = addrRes.rows[0];
        } else {
          return res.status(400).json({ success: false, message: 'Selected delivery address not found.' });
        }
      }

      // Priority 2: Customer default delivery address (if no address explicitly selected)
      if (!selectedAddressRecord && !addressId) {
        const defaultAddrRes = await db.query(
          `SELECT * FROM customer_addresses WHERE customer_id = $1 AND is_default = true LIMIT 1;`,
          [req.user.id]
        );
        if (defaultAddrRes.rows && defaultAddrRes.rows.length > 0) {
          selectedAddressRecord = defaultAddrRes.rows[0];
        }
      }

      // Priority 3: Fallback to Customer Profile Delivery Address (if no selected/default address)
      if (!selectedAddressRecord) {
        const userRes = await db.query(`SELECT id, name, mobile, address FROM users WHERE id = $1;`, [req.user.id]);
        const uProfile = userRes.rows[0];
        const profAddr = (uProfile && uProfile.address) ? uProfile.address.trim() : '';

        if (profAddr) {
          const pinMatch = profAddr.match(/\b\d{6}\b/);
          const extractedPin = pinMatch ? pinMatch[0] : '';
          profileFallbackAddress = {
            id: 'profile_address',
            address_type: 'Profile Address',
            full_name: uProfile.name || req.user.name,
            mobile_number: uProfile.mobile || req.user.mobile,
            address_line1: profAddr,
            address_line2: '',
            area: '',
            city: '',
            state: '',
            pincode: extractedPin,
            landmark: '',
            delivery_instructions: '',
            is_profile_fallback: true
          };
        }
      }

      const finalAddrObj = selectedAddressRecord || profileFallbackAddress;

      // Priority 4: If no address exists anywhere, require customer to add an address
      if (!finalAddrObj) {
        return res.status(400).json({
          success: false,
          message: 'Please add a delivery address before placing your order.'
        });
      }

      // Run Delivery Zone Compatibility Check on finalAddrObj
      const pincode = (finalAddrObj.pincode || '').trim();
      const activeZonesRes = await db.query(`SELECT * FROM delivery_zones WHERE status = 'ACTIVE';`);
      let matchedZone = null;

      for (const z of (activeZonesRes.rows || [])) {
        let pinList = [];
        try {
          pinList = typeof z.pincodes === 'string' ? JSON.parse(z.pincodes) : (z.pincodes || []);
        } catch (e) {
          pinList = [];
        }
        if (Array.isArray(pinList) && pincode && pinList.map(p => String(p).trim()).includes(pincode)) {
          matchedZone = z;
          break;
        }
      }

      if (activeZonesRes.rows && activeZonesRes.rows.length > 0 && !matchedZone) {
        if (!pincode && activeZonesRes.rows.length === 1) {
          matchedZone = activeZonesRes.rows[0];
        } else {
          return res.status(400).json({ success: false, message: 'Sorry, delivery is currently unavailable at this location.' });
        }
      }

      if (matchedZone) {
        const minOrder = Number(matchedZone.min_order_amount || 0);
        if (grand_total < minOrder) {
          return res.status(400).json({ success: false, message: `Minimum order for this delivery zone is ₹${minOrder}.` });
        }

        deliveryFeeAmount = Number(matchedZone.delivery_fee || 0);
        deliveryZoneId = matchedZone.id;
        deliveryZoneName = matchedZone.zone_name;
      }

      deliveryAddressSnapshotJson = JSON.stringify({
        address_id: finalAddrObj.id,
        address_type: finalAddrObj.address_type,
        full_name: finalAddrObj.full_name,
        mobile_number: finalAddrObj.mobile_number,
        address_line1: finalAddrObj.address_line1,
        address_line2: finalAddrObj.address_line2 || '',
        area: finalAddrObj.area || '',
        city: finalAddrObj.city || '',
        state: finalAddrObj.state || '',
        pincode: finalAddrObj.pincode || '',
        landmark: finalAddrObj.landmark || '',
        delivery_instructions: finalAddrObj.delivery_instructions || '',
        source: finalAddrObj.id === 'profile_address' ? 'Profile Delivery Address' : (finalAddrObj.is_default ? 'Default Address' : 'Saved Address')
      });

      if (finalAddrObj.id === 'profile_address') {
        finalDeliveryAddressText = `${finalAddrObj.full_name} (${finalAddrObj.mobile_number}), ${finalAddrObj.address_line1}`;
      } else {
        finalDeliveryAddressText = `${finalAddrObj.full_name} (${finalAddrObj.mobile_number}), ${finalAddrObj.address_line1}${finalAddrObj.address_line2 ? ', ' + finalAddrObj.address_line2 : ''}, ${finalAddrObj.area}, ${finalAddrObj.city}, ${finalAddrObj.state} - ${finalAddrObj.pincode}${finalAddrObj.landmark ? ' (Landmark: ' + finalAddrObj.landmark + ')' : ''}`;
      }

      grand_total += deliveryFeeAmount;
    }

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
        `SELECT * FROM food_member_cards WHERE customer_id = $1 ORDER BY valid_until DESC, created_at DESC;`,
        [req.user.id]
      );
      const nowDate = new Date();
      let activeMemberCard = null;

      for (const card of (cardCheckRes.rows || [])) {
        const vFrom = new Date(card.valid_from);
        const vUntil = new Date(card.valid_until);
        let vUntilEnd = new Date(vUntil);
        if (typeof card.valid_until === 'string' && card.valid_until.length <= 10) {
          vUntilEnd.setHours(23, 59, 59, 999);
        }
        if (vFrom <= nowDate && nowDate <= vUntilEnd) {
          activeMemberCard = card;
          break;
        }
      }

      if (activeMemberCard) {
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
      }

      // Apply Premium Discount to Net Amount if applicable
      if (foodMemberDiscount > 0 && netAmount > 5.00) {
        netAmount = Math.max(0, netAmount - foodMemberDiscount);
      }

      // Create Order Record with Add-ons & Live Preparation Time
      const nowIso = new Date().toISOString();
      const pickupPin = String(Math.floor(1000 + Math.random() * 9000));
      const initialPrepMins = Math.min(180, Math.max(1, parseInt(req.body.preparation_minutes || '15', 10)));
      const estimatedReadyAt = new Date(Date.now() + initialPrepMins * 60000).toISOString();

      await tx.query(
        `INSERT INTO orders (
          id, order_number, customer_id, customer_name, customer_mobile, 
          order_type, delivery_address, notes, total_amount, used_wallet_amount, 
          net_amount, payment_method, payment_status, order_status, items, add_ons,
          utr_number, payment_screenshot, screenshot_url, pickup_pin, pickup_pin_verified,
          food_member_discount, is_express_delivery, is_premium_member, preparation_minutes, estimated_ready_at,
          delivery_address_json, delivery_fee, delivery_zone_id, delivery_zone_name, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31);`,
        [
          newOrderId, orderNum, req.user.id, req.user.name, req.user.mobile,
          order_type || 'Takeaway', finalDeliveryAddressText || null, notes || null,
          grand_total, walletDeducted, netAmount, finalPayMethod,
          finalPayStatus, 'Received', JSON.stringify(formattedItems), JSON.stringify(formattedAddons),
          cleanUtr, savedScreenshotUrl, savedScreenshotUrl, pickupPin, false,
          foodMemberDiscount, isExpressDelivery ? 1 : 0, isPremiumMember ? 1 : 0,
          initialPrepMins, estimatedReadyAt,
          deliveryAddressSnapshotJson, deliveryFeeAmount, deliveryZoneId, deliveryZoneName, nowIso
        ]
      );

      // Insert into order_add_ons table for structured querying
      for (const ao of formattedAddons) {
        await tx.query(
          `INSERT INTO order_add_ons (id, order_id, add_on_id, add_on_name, quantity, unit_price, subtotal, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
          [
            'oao_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            newOrderId, ao.add_on_id, ao.add_on_name, ao.quantity, ao.unit_price, ao.subtotal, nowIso
          ]
        );
      }

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

      // Automatic Refund Request creation for paid orders
      try {
        const netPaid = Number(order.net_amount || order.total_amount || 0);
        const payStatus = (order.payment_status || '').toLowerCase();
        const payMethod = (order.payment_method || '').toLowerCase();

        if (netPaid > 0 && (payStatus.includes('paid') || payStatus.includes('verified') || payMethod.includes('upi') || payMethod.includes('card') || payMethod.includes('online'))) {
          await createRefundRecord({
            order_id: order.id,
            customer_id: req.user.id,
            refund_amount: netPaid,
            reason: `Order #${order.order_number} cancelled: ${cancellationReason}`,
            actor_type: 'CUSTOMER',
            actor_id: req.user.id
          });
        }
      } catch (refErr) {
        console.warn('Auto refund creation notice:', refErr.message);
      }

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
            `SELECT * FROM food_member_cards WHERE customer_id = $1 ORDER BY valid_until DESC, created_at DESC;`,
            [req.user.id]
          );
          const nowDate = new Date();
          let activeMemberCard = null;

          for (const card of (cardCheckRes.rows || [])) {
            const vFrom = new Date(card.valid_from);
            const vUntil = new Date(card.valid_until);
            let vUntilEnd = new Date(vUntil);
            if (typeof card.valid_until === 'string' && card.valid_until.length <= 10) {
              vUntilEnd.setHours(23, 59, 59, 999);
            }
            if (vFrom <= nowDate && nowDate <= vUntilEnd) {
              activeMemberCard = card;
              break;
            }
          }

          if (activeMemberCard) {
            foodMemberDiscount = 5.00;
            isPremiumMember = true;
            if (requestedExpress && activeMemberCard.express_delivery_eligible) {
              isExpressDelivery = true;
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

function parseDateComponents(dateInput) {
  if (!dateInput) return new Date();
  if (dateInput instanceof Date) {
    return new Date(dateInput.getFullYear(), dateInput.getMonth(), dateInput.getDate());
  }
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return new Date();
  if (typeof dateInput === 'string' && dateInput.includes('T')) {
    const parts = dateInput.split('T')[0].split('-');
    if (parts.length === 3) {
      return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// =========================================================================
// AUTOMATIC & IDEMPOTENT PREMIUM MEMBER CARD EXPIRY REMINDERS ENGINE
// =========================================================================

async function processMemberCardExpiryReminders(targetDateObj = null) {
  const now = targetDateObj ? new Date(targetDateObj) : new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  let summary = {
    processed: 0,
    reminded7d: 0,
    reminded3d: 0,
    reminded1d: 0,
    expired: 0,
    errors: 0
  };

  try {
    const cardRes = await db.query(
      `SELECT * FROM food_member_cards WHERE status = 'ACTIVE';`
    );
    const activeCards = cardRes.rows || [];
    summary.processed = activeCards.length;

    for (const card of activeCards) {
      try {
        const validUntil = new Date(card.valid_until);
        let validUntilEnd = new Date(validUntil);
        if (typeof card.valid_until === 'string' && card.valid_until.length <= 10) {
          validUntilEnd.setHours(23, 59, 59, 999);
        }

        const formattedExpiry = validUntil.toLocaleDateString('en-IN');

        // Check if card has expired
        if (nowMs > validUntilEnd.getTime()) {
          if (!card.reminded_expired_at) {
            await db.query(
              `UPDATE food_member_cards SET status = 'EXPIRED', reminded_expired_at = $1, updated_at = $2 WHERE id = $3;`,
              [nowIso, nowIso, card.id]
            );
            card.status = 'EXPIRED';
            await logMemberCardAudit({
              customer_id: card.customer_id,
              member_id: card.member_id,
              action: 'MEMBERSHIP_EXPIRED',
              actor_role: 'SYSTEM',
              details: `Membership auto-expired on ${formattedExpiry}.`
            });
            await createAndDispatchNotification({
              target_role: 'CUSTOMER',
              customer_id: card.customer_id,
              title: '🔴 Premium Food Membership Expired',
              message: `Your Premium Food Member Card (${card.member_id}) has expired. Click Buy Again ₹10 to reactivate your benefits!`,
              type: 'MEMBER_CARD',
              priority: 'HIGH',
              action_url: '/#secCustomerMemberCard'
            });
            summary.expired++;
          } else {
            await db.query(
              `UPDATE food_member_cards SET status = 'EXPIRED', updated_at = $1 WHERE id = $2 AND status != 'EXPIRED';`,
              [nowIso, card.id]
            );
          }
          continue;
        }

        // Calculate days remaining (consistent date component diff)
        const todayStart = parseDateComponents(now);
        const untilStart = parseDateComponents(card.valid_until);
        const diffMs = untilStart.getTime() - todayStart.getTime();
        const daysDiff = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));

        // 1-Day Tier (<= 1 day remaining)
        if (daysDiff <= 1 && !card.reminded_1d_at) {
          const dayLabel = daysDiff === 1 ? 'tomorrow' : 'today';
          await db.query(
            `UPDATE food_member_cards SET reminded_1d_at = $1, updated_at = $2 WHERE id = $3;`,
            [nowIso, nowIso, card.id]
          );
          await logMemberCardAudit({
            customer_id: card.customer_id,
            member_id: card.member_id,
            action: 'REMINDER_1D_SENT',
            actor_role: 'SYSTEM',
            details: `Sent 1-day expiry reminder (expires ${dayLabel})`
          });
          await createAndDispatchNotification({
            target_role: 'CUSTOMER',
            customer_id: card.customer_id,
            title: `🚨 Final Reminder: Premium Card Expires ${dayLabel === 'tomorrow' ? 'Tomorrow' : 'Today'}`,
            message: `Your Premium Food Member Card (${card.member_id}) expires ${dayLabel}! Renew for ₹10 to keep your ₹5 OFF & Express Delivery benefits.`,
            type: 'MEMBER_CARD',
            priority: 'HIGH',
            action_url: '/#secCustomerMemberCard'
          });
          summary.reminded1d++;
        }
        // 3-Day Tier (<= 3 days remaining)
        else if (daysDiff <= 3 && daysDiff > 1 && !card.reminded_3d_at) {
          await db.query(
            `UPDATE food_member_cards SET reminded_3d_at = $1, updated_at = $2 WHERE id = $3;`,
            [nowIso, nowIso, card.id]
          );
          await logMemberCardAudit({
            customer_id: card.customer_id,
            member_id: card.member_id,
            action: 'REMINDER_3D_SENT',
            actor_role: 'SYSTEM',
            details: `Sent 3-day expiry reminder (${daysDiff} days remaining)`
          });
          await createAndDispatchNotification({
            target_role: 'CUSTOMER',
            customer_id: card.customer_id,
            title: `⚠️ Premium Member Card Expiring Soon`,
            message: `Only 3 days left on your Premium Food Member Card (${card.member_id}). Don't lose your discount & express delivery benefits!`,
            type: 'MEMBER_CARD',
            priority: 'NORMAL',
            action_url: '/#secCustomerMemberCard'
          });
          summary.reminded3d++;
        }
        // 7-Day Tier (<= 7 days remaining)
        else if (daysDiff <= 7 && daysDiff > 3 && !card.reminded_7d_at) {
          await db.query(
            `UPDATE food_member_cards SET reminded_7d_at = $1, updated_at = $2 WHERE id = $3;`,
            [nowIso, nowIso, card.id]
          );
          await logMemberCardAudit({
            customer_id: card.customer_id,
            member_id: card.member_id,
            action: 'REMINDER_7D_SENT',
            actor_role: 'SYSTEM',
            details: `Sent 7-day expiry reminder (${daysDiff} days remaining)`
          });
          await createAndDispatchNotification({
            target_role: 'CUSTOMER',
            customer_id: card.customer_id,
            title: `⏳ Premium Member Card Expiry Notice`,
            message: `Your Premium Food Member Card (${card.member_id}) expires in 7 days on ${formattedExpiry}. Renew now to keep enjoying ₹5 OFF & Express Delivery!`,
            type: 'MEMBER_CARD',
            priority: 'NORMAL',
            action_url: '/#secCustomerMemberCard'
          });
          summary.reminded7d++;
        }
      } catch (cardErr) {
        console.error(`Error processing card expiry reminder for ${card.id}:`, cardErr);
        summary.errors++;
      }
    }
  } catch (err) {
    console.error('Master processMemberCardExpiryReminders error:', err);
  }

  return summary;
}

// Endpoint to manually or test trigger expiry reminder processing (Owner Only)
app.post('/api/food-member/process-expiry-reminders', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const summary = await processMemberCardExpiryReminders(req.body?.targetDate);
    res.json({
      success: true,
      message: 'Member card expiry reminders processed successfully.',
      summary
    });
  } catch (err) {
    console.error('Process Expiry Reminders API Error:', err);
    res.status(500).json({ success: false, message: 'Failed to process card expiry reminders.' });
  }
});

// Calculate dynamic Premium Savings Tracker metrics for customer
async function calculateCustomerPremiumSavings(customerId) {
  const now = new Date();
  const nowMs = now.getTime();

  try {
    const cardsRes = await db.query(
      `SELECT * FROM food_member_cards WHERE customer_id = $1 ORDER BY created_at DESC;`,
      [String(customerId)]
    );
    const cards = cardsRes.rows || [];

    if (cards.length === 0) {
      return {
        has_any_card: false,
        is_current_active: false,
        current_card_id: null,
        current_card_member_id: null,
        current_card_orders: 0,
        current_card_saved: 0.00,
        current_card_valid_until: null,
        current_card_days_remaining: 0,
        current_card_status: 'NO_CARD',
        lifetime_orders: 0,
        lifetime_saved: 0.00,
        savings_breakdown: []
      };
    }

    const latestCard = cards[0];
    const latestValidFrom = new Date(latestCard.valid_from);
    const latestValidUntil = new Date(latestCard.valid_until);
    let latestValidUntilEnd = new Date(latestValidUntil);
    if (typeof latestCard.valid_until === 'string' && latestCard.valid_until.length <= 10) {
      latestValidUntilEnd.setHours(23, 59, 59, 999);
    }

    let isCurrentActive = false;
    let currentCardStatus = 'EXPIRED';
    let currentDaysRemaining = 0;

    if (nowMs < latestValidFrom.getTime()) {
      currentCardStatus = 'NOT_STARTED';
    } else if (nowMs <= latestValidUntilEnd.getTime()) {
      isCurrentActive = true;
      currentCardStatus = 'ACTIVE';
      const todayStart = parseDateComponents(now);
      const untilStart = parseDateComponents(latestCard.valid_until);
      const diffMs = untilStart.getTime() - todayStart.getTime();
      currentDaysRemaining = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
    } else {
      currentCardStatus = 'EXPIRED';
      currentDaysRemaining = 0;
    }

    const ordersRes = await db.query(
      `SELECT id, order_number, created_at, food_member_discount, is_premium_member, order_status, payment_status, total_amount, net_amount
       FROM orders
       WHERE customer_id = $1
         AND UPPER(COALESCE(order_status, '')) NOT IN ('CANCELLED', 'REJECTED')
         AND UPPER(COALESCE(payment_status, '')) NOT IN ('FAILED', 'REFUNDED')
       ORDER BY created_at DESC;`,
      [String(customerId)]
    );
    const orders = ordersRes.rows || [];

    let currentCardOrders = 0;
    let currentCardSaved = 0;
    let lifetimeOrders = 0;
    let lifetimeSaved = 0;
    const savingsBreakdown = [];

    for (const order of orders) {
      const orderDate = new Date(order.created_at);
      const orderMs = orderDate.getTime();

      let matchedCard = null;
      for (const c of cards) {
        const vFrom = new Date(c.valid_from).getTime();
        const vUntil = new Date(c.valid_until);
        if (typeof c.valid_until === 'string' && c.valid_until.length <= 10) {
          vUntil.setHours(23, 59, 59, 999);
        }
        const vUntilMs = vUntil.getTime();

        if (orderMs >= vFrom && orderMs <= vUntilMs) {
          matchedCard = c;
          break;
        }
      }

      const explicitDiscount = Number(order.food_member_discount || 0);
      const isExplicitPremium = Boolean(order.is_premium_member || explicitDiscount > 0);

      if (matchedCard || isExplicitPremium) {
        const discountAmount = explicitDiscount > 0 ? explicitDiscount : 5.00;
        const associatedCard = matchedCard || latestCard;

        lifetimeOrders++;
        lifetimeSaved += discountAmount;

        if (associatedCard.id === latestCard.id) {
          currentCardOrders++;
          currentCardSaved += discountAmount;
        }

        savingsBreakdown.push({
          order_id: order.id,
          order_number: order.order_number || order.id,
          order_date: order.created_at,
          discount_amount: discountAmount,
          card_id: associatedCard.id,
          member_id: associatedCard.member_id
        });
      }
    }

    return {
      has_any_card: true,
      is_current_active: isCurrentActive,
      current_card_id: latestCard.id,
      current_card_member_id: latestCard.member_id,
      current_card_orders: currentCardOrders,
      current_card_saved: Number(currentCardSaved.toFixed(2)),
      current_card_valid_until: latestCard.valid_until,
      current_card_days_remaining: currentDaysRemaining,
      current_card_status: currentCardStatus,
      lifetime_orders: lifetimeOrders,
      lifetime_saved: Number(lifetimeSaved.toFixed(2)),
      savings_breakdown: savingsBreakdown
    };
  } catch (err) {
    console.error('calculateCustomerPremiumSavings error:', err);
    return {
      has_any_card: false,
      is_current_active: false,
      current_card_id: null,
      current_card_member_id: null,
      current_card_orders: 0,
      current_card_saved: 0.00,
      current_card_valid_until: null,
      current_card_days_remaining: 0,
      current_card_status: 'ERROR',
      lifetime_orders: 0,
      lifetime_saved: 0.00,
      savings_breakdown: []
    };
  }
}

// 1. GET /api/food-member/status - Fetch Customer Membership & Application State with Dynamic Expiration
app.get('/api/food-member/status', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.id;
    
    // Process any pending reminders and auto-expiry idempotently
    await processMemberCardExpiryReminders();

    // Check for Active / Expired / Suspended Card
    const cardRes = await db.query(
      `SELECT * FROM food_member_cards WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1;`,
      [customerId]
    );

    let card = cardRes.rows && cardRes.rows.length > 0 ? cardRes.rows[0] : null;

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

    const savingsTracker = await calculateCustomerPremiumSavings(customerId);

    res.json({
      success: true,
      status: overallStatus,
      card,
      application,
      benefits: {
        discount_amount: overallStatus === 'ACTIVE' ? 5.00 : 0.00,
        express_delivery_eligible: overallStatus === 'ACTIVE'
      },
      savings_tracker: savingsTracker
    });
  } catch (err) {
    console.error('Fetch Food Member Status Error:', err);
    res.status(500).json({ success: false, message: "Failed to load member status." });
  }
});

// 2. POST /api/food-member/apply - Customer Application with Cash Payment (Pending Owner Verification)
app.post('/api/food-member/apply', authenticateToken, async (req, res) => {
  try {
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

    const finalPayMethod = 'Cash Payment';
    const appId = 'app_fm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const payRef = 'CASH_' + Date.now();

    try {
      await db.executeTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO food_member_applications (
            id, customer_id, customer_name, customer_mobile, fee_amount, 
            payment_method, payment_status, payment_reference, screenshot_url, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
          [
            appId, customerId, req.user.name, req.user.mobile, 10.00,
            finalPayMethod, 'VERIFICATION_PENDING', payRef, null,
            'PENDING_APPROVAL', nowIso, nowIso
          ]
        );

        // Record in payments table as Pending Verification so Owner payment history tracks it
        const payId = 'pay_fm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
        await tx.query(
          `INSERT INTO payments (id, order_number, order_id, customer_id, customer_name, customer_mobile, amount, payment_method, payment_status, utr_number, screenshot_url, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
          [
            payId, 'MEMBERSHIP_₹10', appId, customerId, req.user.name, req.user.mobile,
            10.00, finalPayMethod, 'Pending Verification', payRef, null,
            'Premium Food Member Card Membership Fee (₹10 Cash Payment)'
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
      details: `Submitted ₹10 membership cash application (Ref: ${payRef})`
    });

    // Notify Owner of Cash Payment Application
    await createAndDispatchNotification({
      target_role: 'OWNER',
      title: '🍽️ New Food Member Application',
      message: `New Premium Food Member Card application submitted by ${req.user.name} (💵 Cash Payment Pending).`,
      type: 'MEMBER_CARD',
      priority: 'HIGH',
      action_url: '/#secOwnerMemberCardApprovals'
    });

    const newAppRes = await db.query(`SELECT * FROM food_member_applications WHERE id = $1;`, [appId]);

    res.json({
      success: true,
      message: "Please visit the Owner and pay the Premium Food Member Card amount in cash. Your payment will remain pending until the Owner verifies your payment.",
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
             p.screenshot_url as payment_ledger_screenshot,
             c.id as card_id, c.member_id, 
             COALESCE(c.status, CASE WHEN a.status = 'APPROVED' THEN 'ACTIVE' ELSE a.status END) as card_status, 
             c.valid_from, c.valid_until, c.qr_verification_code
      FROM food_member_applications a
      LEFT JOIN payments p ON p.order_id = a.id
      LEFT JOIN food_member_cards c ON c.id = (
        SELECT id FROM food_member_cards 
        WHERE application_id = a.id OR customer_id = a.customer_id 
        ORDER BY created_at DESC LIMIT 1
      )
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

// Dedicated Authenticated Route: Serve Payment Proof Screenshot for Owner
app.get('/api/food-member/owner/screenshot/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const appId = req.params.id;
    console.log(`[DEBUG] Payment proof request started for application: ${appId}`);

    const appRes = await db.query(
      `SELECT a.id, a.screenshot_url, p.screenshot_url as payment_ledger_screenshot, c.application_id
       FROM food_member_applications a
       LEFT JOIN payments p ON (p.order_id = a.id OR p.customer_id = a.customer_id)
       LEFT JOIN food_member_cards c ON (c.application_id = a.id OR c.customer_id = a.customer_id)
       WHERE a.id = $1 OR a.customer_id = $1 OR c.id = $1 OR c.application_id = $1 OR p.id = $1 OR p.order_id = $1
       ORDER BY a.created_at DESC LIMIT 1;`,
      [appId]
    );

    let rawScreenshot = null;
    if (appRes.rows && appRes.rows.length > 0) {
      const record = appRes.rows[0];
      rawScreenshot = record.screenshot_url || record.payment_ledger_screenshot;
    }

    if (!rawScreenshot) {
      // Fallback 1: Query payments table directly
      const payRes = await db.query(
        `SELECT screenshot_url FROM payments WHERE order_id = $1 OR id = $1 ORDER BY created_at DESC LIMIT 1;`,
        [appId]
      );
      if (payRes.rows && payRes.rows.length > 0) {
        rawScreenshot = payRes.rows[0].screenshot_url;
      }
    }

    if (!rawScreenshot) {
      console.log(`[DEBUG] Payment proof reference is empty for application ${appId}`);
      return res.status(404).json({ success: false, message: "⚠️ Payment screenshot not available for this record." });
    }

    console.log(`[DEBUG] Found raw screenshot reference type: ${rawScreenshot.startsWith('data:image/') ? 'Base64 Data URI' : 'File Path'}`);

    if (rawScreenshot.startsWith('data:image/')) {
      const matches = rawScreenshot.match(/^data:image\/([a-zA-Z0-9+\-+.]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const mimeType = `image/${matches[1] === 'jpg' ? 'jpeg' : matches[1]}`;
        const imageBuffer = Buffer.from(matches[2], 'base64');
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        console.log(`[DEBUG] Serving base64 image, size: ${imageBuffer.length} bytes, content-type: ${mimeType}`);
        return res.status(200).send(imageBuffer);
      }
    }

    if (rawScreenshot.startsWith('http://') || rawScreenshot.startsWith('https://')) {
      return res.redirect(rawScreenshot);
    }

    let cleanedPath = rawScreenshot.replace(/^[\/\\]+/, '');
    const candidatePaths = [
      path.join(__dirname, 'public', cleanedPath),
      path.join(__dirname, cleanedPath),
      path.join(__dirname, 'public', 'uploads', 'screenshots', path.basename(cleanedPath)),
      path.join(__dirname, 'public', 'uploads', path.basename(cleanedPath))
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        console.log(`[DEBUG] File found on disk at ${p}. Sending file response.`);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.status(200).sendFile(p);
      }
    }

    console.log(`[DEBUG] File not found on disk for rawScreenshot: ${rawScreenshot}`);
    return res.status(404).json({ success: false, message: "⚠️ Screenshot file unavailable on server disk." });
  } catch (err) {
    console.error('Fetch Owner Payment Screenshot Error:', err);
    res.status(500).json({ success: false, message: "❌ Failed to retrieve payment screenshot." });
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

    if (application.payment_status !== 'VERIFIED') {
      return res.status(400).json({
        success: false,
        message: "⚠️ Payment verification required. Please verify the cash payment before approving the Premium Food Member Card."
      });
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

// 5D. POST /api/food-member/owner/reapprove/:id - Owner Re-Approve Rejected Application
app.post('/api/food-member/owner/reapprove/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const appId = req.params.id;
    const now = new Date();
    const nowIso = now.toISOString();

    // 1. Validate application existence
    const appRes = await db.query(`SELECT * FROM food_member_applications WHERE id = $1;`, [appId]);
    if (!appRes.rows || appRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Application not found." });
    }
    const application = appRes.rows[0];

    // 2. Validate current status is REJECTED
    if (application.status !== 'REJECTED') {
      return res.status(400).json({ success: false, message: `Only rejected applications can be re-approved. Current status is ${application.status}.` });
    }

    // 3. Verify payment info & UTR presence
    if (!application.payment_reference) {
      return res.status(400).json({ success: false, message: "Invalid application record: UTR / Payment Reference is missing." });
    }

    // 4. Verify customer does not already have an active card
    const activeCardCheck = await db.query(
      `SELECT id FROM food_member_cards WHERE customer_id = $1 AND status = 'ACTIVE' AND valid_until > $2;`,
      [application.customer_id, nowIso]
    );
    if (activeCardCheck.rows && activeCardCheck.rows.length > 0) {
      return res.status(400).json({ success: false, message: "Customer already has an active Premium Food Member Card." });
    }

    let createdOrUpdatedCard = null;

    await db.executeTransaction(async (tx) => {
      // Update application status to APPROVED and payment_status to VERIFIED
      await tx.query(
        `UPDATE food_member_applications 
         SET status = 'APPROVED', payment_status = 'VERIFIED', rejection_reason = NULL, updated_at = $1 
         WHERE id = $2;`,
        [nowIso, appId]
      );

      // Check if a card record already exists for this application
      const existingCardRes = await tx.query(`SELECT * FROM food_member_cards WHERE application_id = $1;`, [appId]);
      
      const validFrom = now;
      const validUntil = addExactThreeCalendarMonths(now);

      if (existingCardRes.rows && existingCardRes.rows.length > 0) {
        // Update existing card to ACTIVE with 3 months validity from re-approval
        const existingCard = existingCardRes.rows[0];
        await tx.query(
          `UPDATE food_member_cards 
           SET status = 'ACTIVE', valid_from = $1, valid_until = $2, updated_at = $3 
           WHERE id = $4;`,
          [validFrom.toISOString(), validUntil.toISOString(), nowIso, existingCard.id]
        );
        const cardRes = await tx.query(`SELECT * FROM food_member_cards WHERE id = $1;`, [existingCard.id]);
        createdOrUpdatedCard = cardRes.rows[0];
      } else {
        // Generate atomic Member ID and create new card
        const memberSeq = await db.getNextCounter('member_counter');
        const memberId = 'FM-' + String(memberSeq).padStart(6, '0');
        const qrCode = 'QR_FM_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const cardId = 'card_fm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

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

        const cardRes = await tx.query(`SELECT * FROM food_member_cards WHERE id = $1;`, [cardId]);
        createdOrUpdatedCard = cardRes.rows[0];
      }
    });

    const formattedExpiry = new Date(createdOrUpdatedCard.valid_until).toLocaleDateString('en-IN');

    // Audit logs
    await logMemberCardAudit({
      customer_id: application.customer_id,
      member_id: createdOrUpdatedCard.member_id,
      action: 'APPLICATION_REAPPROVED',
      actor_role: 'OWNER',
      actor_id: req.user.id,
      details: `Re-approved application ${appId}`
    });

    await logMemberCardAudit({
      customer_id: application.customer_id,
      member_id: createdOrUpdatedCard.member_id,
      action: 'MEMBERSHIP_ACTIVATED',
      actor_role: 'OWNER',
      details: `Membership re-activated until ${formattedExpiry}`
    });

    // Notify Customer
    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      customer_id: application.customer_id,
      title: '🎉 Premium Food Member Card Re-Approved!',
      message: `Your Premium Food Member Card (${createdOrUpdatedCard.member_id}) has been re-approved by the Owner. Your Premium Food Member benefits are active again until ${formattedExpiry}!`,
      type: 'MEMBER_CARD',
      priority: 'HIGH',
      action_url: '/#secCustomerMemberCard'
    });

    res.json({
      success: true,
      message: `Premium Food Member Card (${createdOrUpdatedCard.member_id}) re-approved and activated successfully!`,
      card: createdOrUpdatedCard
    });
  } catch (err) {
    console.error('Re-approve Member Card Error:', err);
    res.status(500).json({ success: false, message: err.message || "Failed to re-approve member card." });
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

// 6. POST /api/food-member/owner/suspend/:id & reactivate/:id / unsuspend/:id - Owner Card Controls
app.post('/api/food-member/owner/suspend/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const targetId = req.params.id;
    const nowIso = new Date().toISOString();

    const appRes = await db.query(
      `SELECT customer_id FROM food_member_applications WHERE id = $1;`,
      [targetId]
    );
    const customerId = (appRes.rows && appRes.rows.length > 0) ? appRes.rows[0].customer_id : targetId;

    await db.query(
      `UPDATE food_member_cards 
       SET status = 'SUSPENDED', updated_at = $1 
       WHERE id = $2 OR application_id = $2 OR customer_id = $2 OR customer_id = $3;`,
      [nowIso, targetId, customerId]
    );

    const cardRes = await db.query(
      `SELECT * FROM food_member_cards WHERE id = $1 OR application_id = $1 OR customer_id = $1 OR customer_id = $2 ORDER BY created_at DESC LIMIT 1;`,
      [targetId, customerId]
    );

    if (cardRes.rows && cardRes.rows.length > 0) {
      const card = cardRes.rows[0];
      await logMemberCardAudit({
        customer_id: card.customer_id,
        member_id: card.member_id,
        action: 'CARD_SUSPENDED',
        actor_role: 'OWNER',
        actor_id: req.user.id,
        details: 'Member card suspended by owner'
      });

      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: card.customer_id,
        title: '🔒 Premium Food Member Card Suspended',
        message: 'Your Food Member Card has been suspended by the Owner. Please contact the Owner.',
        type: 'MEMBER_CARD',
        priority: 'HIGH',
        action_url: '/#secCustomerMemberCard'
      });
    }

    res.json({ success: true, message: "✅ Premium Food Member Card suspended." });
  } catch (err) {
    console.error('Suspend card error:', err);
    res.status(500).json({ success: false, message: "Failed to suspend card." });
  }
});

app.post(['/api/food-member/owner/reactivate/:id', '/api/food-member/owner/unsuspend/:id'], authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const targetId = req.params.id;
    const nowIso = new Date().toISOString();

    const appRes = await db.query(
      `SELECT customer_id FROM food_member_applications WHERE id = $1;`,
      [targetId]
    );
    const customerId = (appRes.rows && appRes.rows.length > 0) ? appRes.rows[0].customer_id : targetId;

    await db.query(
      `UPDATE food_member_cards 
       SET status = 'ACTIVE', updated_at = $1 
       WHERE id = $2 OR application_id = $2 OR customer_id = $2 OR customer_id = $3;`,
      [nowIso, targetId, customerId]
    );

    const cardRes = await db.query(
      `SELECT * FROM food_member_cards WHERE id = $1 OR application_id = $1 OR customer_id = $1 OR customer_id = $2 ORDER BY created_at DESC LIMIT 1;`,
      [targetId, customerId]
    );

    if (cardRes.rows && cardRes.rows.length > 0) {
      const card = cardRes.rows[0];
      await logMemberCardAudit({
        customer_id: card.customer_id,
        member_id: card.member_id,
        action: 'CARD_REACTIVATED',
        actor_role: 'OWNER',
        actor_id: req.user.id,
        details: 'Member card unsuspended by owner'
      });

      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: card.customer_id,
        title: '✅ Premium Food Member Card Activated',
        message: 'Your Premium Food Member Card has been reactivated. Enjoy your benefits!',
        type: 'MEMBER_CARD',
        priority: 'HIGH',
        action_url: '/#secCustomerMemberCard'
      });
    }

    res.json({ success: true, message: "✅ Premium Food Member Card activated successfully." });
  } catch (err) {
    console.error('Reactivate/Unsuspend card error:', err);
    res.status(500).json({ success: false, message: "Failed to activate card." });
  }
});

// 6B. DELETE /api/food-member/owner/application/:id - Owner Delete Individual Member Application/Card Record
app.delete('/api/food-member/owner/application/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const targetId = req.params.id;

    // Find in applications
    const appRes = await db.query(
      `SELECT * FROM food_member_applications WHERE id = $1 OR customer_id = $1;`, 
      [targetId]
    );
    // Find in cards
    const cardRes = await db.query(
      `SELECT * FROM food_member_cards WHERE id = $1 OR application_id = $1 OR customer_id = $1;`, 
      [targetId]
    );

    const application = (appRes.rows && appRes.rows.length > 0) ? appRes.rows[0] : null;
    const card = (cardRes.rows && cardRes.rows.length > 0) ? cardRes.rows[0] : null;

    const appId = application ? application.id : (card ? card.application_id : targetId);
    const customerId = application ? application.customer_id : (card ? card.customer_id : null);
    const cardId = card ? card.id : null;

    await db.executeTransaction(async (tx) => {
      if (appId) {
        await tx.query(`DELETE FROM food_member_cards WHERE application_id = $1 OR id = $1;`, [appId]);
        await tx.query(`DELETE FROM food_member_applications WHERE id = $1;`, [appId]);
      }
      if (cardId) {
        await tx.query(`DELETE FROM food_member_cards WHERE id = $1;`, [cardId]);
      }
      if (targetId) {
        await tx.query(`DELETE FROM food_member_cards WHERE id = $1 OR application_id = $1;`, [targetId]);
        await tx.query(`DELETE FROM food_member_applications WHERE id = $1;`, [targetId]);
      }
    });

    if (customerId) {
      await logMemberCardAudit({
        customer_id: customerId,
        action: 'APPLICATION_DELETED',
        actor_role: 'OWNER',
        actor_id: req.user.id,
        details: `Owner deleted membership record ${targetId}`
      });

      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: customerId,
        title: '❌ Premium Food Member Card Status',
        message: 'Your Food Member Card has been removed by the Owner. Please contact the Owner for more information.',
        type: 'MEMBER_CARD',
        priority: 'HIGH'
      });
    }

    res.json({
      success: true,
      message: "✅ Food Member Card deleted successfully."
    });
  } catch (err) {
    console.error('Delete Member Record Error:', err);
    res.status(500).json({ success: false, message: "Failed to delete membership record: " + (err.message || '') });
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
    res.status(500).json({ success: false, message: "Failed to clear membership records: " + (err.message || '') });
  }
});

// 6D. POST /api/food-member/owner/verify-qr - Owner-Only QR Code Verification
app.post('/api/food-member/owner/verify-qr', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { qr_code, member_id } = req.body;
    const input = (qr_code || member_id || '').toString().trim();
    const result = await db.verifyFoodMemberQr(input);
    res.json(result);
  } catch (err) {
    console.error('Owner Verify QR Error:', err);
    res.status(500).json({
      success: false,
      is_valid: false,
      status_code: 'INVALID',
      title: 'Invalid Premium Member Card',
      message: 'QR code could not be verified: ' + (err.message || '')
    });
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
      await createAndDispatchNotification({
        target_role: 'OWNER',
        customer_id: id,
        title: 'Customer Password Reset',
        message: `Password manually reset by Owner for customer ${customer.name} (${customer.mobile}).`,
        type: 'INFO',
        priority: 'NORMAL',
        action_url: '/#secOwnerSupport'
      });
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
    await createAndDispatchNotification({
      target_role: 'OWNER',
      customer_id: req.user.id,
      title: 'New Support Ticket',
      message: `Ticket #${ticketNum} created by ${req.user.name}: "${subject}"`,
      type: 'SUPPORT',
      priority: 'HIGH',
      action_url: '/#secOwnerSupport'
    });

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

// =========================================================================
// CENTRAL SECURITY EVENT & AUDIT LOGGING ENGINE
// =========================================================================

async function logSecurityEvent({
  event_type = 'SUSPICIOUS_ACTIVITY',
  risk_level = 'LOW',
  customer_id = null,
  order_id = null,
  payment_id = null,
  details = '',
  internal_note = ''
}) {
  try {
    const id = 'sec_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const nowIso = new Date().toISOString();
    await db.query(
      `INSERT INTO security_events (id, event_type, risk_level, customer_id, order_id, payment_id, details, status, internal_note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW', $8, $9, $9);`,
      [id, event_type, risk_level, customer_id, order_id, payment_id, details, internal_note, nowIso]
    );

    const eventObj = { id, event_type, risk_level, customer_id, order_id, payment_id, details, status: 'NEW', internal_note, created_at: nowIso, updated_at: nowIso };

    // Broadcast Security Alert live to connected Owner WebSocket clients
    activeWsClients.forEach((client, ws) => {
      if (ws.readyState === 1 && client.role === 'OWNER') {
        try { ws.send(JSON.stringify({ type: 'SECURITY_ALERT', data: eventObj })); } catch (e) {}
      }
    });

    // Send real-time Push Alert to Owner for HIGH or CRITICAL risk events
    if (risk_level === 'HIGH' || risk_level === 'CRITICAL') {
      await createAndDispatchNotification({
        target_role: 'OWNER',
        title: `🚨 Security Alert (${risk_level})`,
        message: `${event_type.replace(/_/g, ' ')}: ${details || 'Unusual security event logged.'}`,
        type: 'SYSTEM',
        priority: risk_level === 'CRITICAL' ? 'CRITICAL' : 'HIGH'
      });
    }

    return eventObj;
  } catch (err) {
    console.error('[Security Engine Log Notice]:', err.message);
    return null;
  }
}

async function logOwnerAuditAction({
  actor_id = null,
  actor_name = 'Owner',
  action,
  resource_type = null,
  resource_id = null,
  details = '',
  ip_address = null
}) {
  try {
    if (!action) return;
    const id = 'aud_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const nowIso = new Date().toISOString();
    await db.query(
      `INSERT INTO owner_audit_logs (id, actor_id, actor_name, action, resource_type, resource_id, details, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [id, actor_id, actor_name, action, resource_type, resource_id, details, ip_address, nowIso]
    );
  } catch (err) {
    console.error('[Audit Log Notice]:', err.message);
  }
}

// Helper: Format Menu Poll & Calculate Real-Time Stats & Winners
async function updateAndFormatPoll(poll) {
  if (!poll) return null;
  const now = new Date();
  const startAt = new Date(poll.start_at);
  const endAt = new Date(poll.end_at);

  let currentStatus = poll.status;
  if (currentStatus !== 'CANCELLED' && currentStatus !== 'COMPLETED' && currentStatus !== 'CLOSED') {
    if (now < startAt) {
      currentStatus = 'SCHEDULED';
    } else if (now >= startAt && now <= endAt) {
      currentStatus = 'ACTIVE';
    } else if (now > endAt) {
      currentStatus = 'CLOSED';
    }
  }

  if (currentStatus !== poll.status) {
    await db.query('UPDATE menu_polls SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2;', [currentStatus, poll.id]);
    poll.status = currentStatus;
  }

  const optRes = await db.query(
    `SELECT o.id as option_id, o.poll_id, o.food_id, t.name as food_name, t.description as food_description, t.price as food_price, t.image as food_image, t.is_available
     FROM menu_poll_options o
     LEFT JOIN tiffins t ON o.food_id = t.id
     WHERE o.poll_id = $1;`,
    [poll.id]
  );
  const options = optRes.rows || [];

  const voteRes = await db.query(
    `SELECT option_id, COUNT(*) as vote_count FROM menu_poll_votes WHERE poll_id = $1 GROUP BY option_id;`,
    [poll.id]
  );
  const voteMap = {};
  let totalVotes = 0;
  (voteRes.rows || []).forEach(r => {
    const count = Number(r.vote_count || r.c || 0);
    voteMap[r.option_id] = count;
    totalVotes += count;
  });

  let maxVotes = -1;
  let leadingOptions = [];

  const formattedOptions = options.map(opt => {
    const count = voteMap[opt.option_id] || 0;
    const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;

    if (count > maxVotes) {
      maxVotes = count;
      leadingOptions = [{ option_id: opt.option_id, food_id: opt.food_id, food_name: opt.food_name, votes: count, percentage: pct }];
    } else if (count === maxVotes && count > 0) {
      leadingOptions.push({ option_id: opt.option_id, food_id: opt.food_id, food_name: opt.food_name, votes: count, percentage: pct });
    }

    return {
      id: opt.option_id,
      food_id: opt.food_id,
      food_name: opt.food_name || 'Menu Dish',
      description: opt.food_description || '',
      price: Number(opt.food_price || 0),
      image: opt.food_image || '',
      is_available: opt.is_available !== false,
      votes: count,
      percentage: pct
    };
  });

  let isTie = false;
  let winner = null;

  if (poll.winner_food_id) {
    const winOpt = formattedOptions.find(o => o.food_id === poll.winner_food_id);
    if (winOpt) {
      winner = {
        food_id: winOpt.food_id,
        food_name: winOpt.food_name,
        votes: winOpt.votes,
        percentage: winOpt.percentage,
        selection_type: poll.winner_selection_type || 'AUTOMATIC'
      };
    }
  } else if (totalVotes > 0 && leadingOptions.length > 0) {
    if (leadingOptions.length === 1) {
      winner = leadingOptions[0];
      if (currentStatus === 'CLOSED' || currentStatus === 'COMPLETED') {
        await db.query(
          `UPDATE menu_polls SET winner_food_id = $1, status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND (winner_food_id IS NULL OR status = 'CLOSED');`,
          [winner.food_id, poll.id]
        );
        poll.status = 'COMPLETED';
        poll.winner_food_id = winner.food_id;
      }
    } else if (leadingOptions.length > 1) {
      isTie = true;
    }
  }

  return {
    id: poll.id,
    question: poll.question || "Choose Tomorrow's Special",
    start_at: poll.start_at,
    end_at: poll.end_at,
    status: poll.status,
    winner_food_id: poll.winner_food_id || (winner ? winner.food_id : null),
    winner_selection_type: poll.winner_selection_type || 'AUTOMATIC',
    tomorrow_special_published: Boolean(poll.tomorrow_special_published),
    created_at: poll.created_at,
    total_votes: totalVotes,
    options: formattedOptions,
    is_tie: isTie,
    leading_options: leadingOptions,
    winner: winner
  };
}

// =========================================================================
// CUSTOMER MENU VOTING API ENDPOINTS
// =========================================================================

// 1. Create Menu Voting Poll (Owner Only)
app.post('/api/menu-voting/polls', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { question, start_at, end_at, food_ids } = req.body;
    const pollQuestion = (question || "Choose Tomorrow's Special").trim();

    if (!Array.isArray(food_ids) || food_ids.length < 2) {
      return res.status(400).json({ success: false, message: "A minimum of 2 food options is required." });
    }

    if (food_ids.length > 5) {
      return res.status(400).json({ success: false, message: "Maximum 5 food options are allowed." });
    }

    const startDate = new Date(start_at);
    const endDate = new Date(end_at);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid start or end voting date/time." });
    }

    if (endDate <= startDate) {
      return res.status(400).json({ success: false, message: "Voting end time must be after start time." });
    }

    // Verify all selected food items exist in tiffins table
    const placeholders = food_ids.map((_, i) => `$${i + 1}`).join(', ');
    const foodCheckRes = await db.query(`SELECT id FROM tiffins WHERE id IN (${placeholders});`, food_ids);
    if (!foodCheckRes.rows || foodCheckRes.rows.length < 2) {
      return res.status(400).json({ success: false, message: "One or more selected menu dishes are invalid." });
    }

    const pollId = 'poll_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const nowIso = new Date().toISOString();

    let initialStatus = 'SCHEDULED';
    const now = new Date();
    if (now >= startDate && now <= endDate) initialStatus = 'ACTIVE';

    await db.query(
      `INSERT INTO menu_polls (id, question, start_at, end_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6);`,
      [pollId, pollQuestion, startDate.toISOString(), endDate.toISOString(), initialStatus, nowIso]
    );

    for (let fId of food_ids) {
      const optId = 'opt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      await db.query(
        `INSERT INTO menu_poll_options (id, poll_id, food_id, created_at)
         VALUES ($1, $2, $3, $4);`,
        [optId, pollId, fId, nowIso]
      );
    }

    const pollRes = await db.query('SELECT * FROM menu_polls WHERE id = $1;', [pollId]);
    const formattedPoll = await updateAndFormatPoll(pollRes.rows[0]);

    // Dispatch WebSocket Notification for new poll
    activeWsClients.forEach((client, ws) => {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'POLL_CREATED', data: formattedPoll })); } catch (e) {}
      }
    });

    // Notify Customers if poll is currently Active
    if (initialStatus === 'ACTIVE') {
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        title: '🗳️ New Menu Vote!',
        message: 'Choose tomorrow’s special. Cast your vote now!',
        type: 'MENU',
        action_url: '/#secCustomerHome'
      });
    }

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name,
      action: 'CREATE_MENU_POLL',
      resource_type: 'MENU_POLL',
      resource_id: pollId,
      details: `Created menu poll: "${pollQuestion}" with ${food_ids.length} options`
    });

    res.json({ success: true, poll: formattedPoll, message: "Menu voting poll created successfully." });
  } catch (err) {
    console.error('Create Poll Error:', err);
    res.status(500).json({ success: false, message: "Failed to create menu voting poll." });
  }
});

// 2. List Polls (Owner Only)
app.get('/api/menu-voting/polls', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { status, search } = req.query;
    let sql = 'SELECT * FROM menu_polls';
    let params = [];
    let conditions = [];

    if (status && status !== 'ALL') {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status.toUpperCase());
    }

    if (search && search.trim()) {
      conditions.push(`LOWER(question) LIKE $${params.length + 1}`);
      params.push(`%${search.trim().toLowerCase()}%`);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC;';

    const pollRes = await db.query(sql, params);
    const formattedPolls = [];
    for (let p of (pollRes.rows || [])) {
      const f = await updateAndFormatPoll(p);
      if (f) formattedPolls.push(f);
    }

    res.json({ success: true, data: formattedPolls });
  } catch (err) {
    console.error('List Polls Error:', err);
    res.status(500).json({ success: false, message: "Failed to fetch menu voting polls." });
  }
});

// 3. Get Active Poll for Customer
app.get('/api/menu-voting/active', optionalAuth, async (req, res) => {
  try {
    const pollRes = await db.query("SELECT * FROM menu_polls WHERE status IN ('ACTIVE', 'SCHEDULED') ORDER BY created_at DESC LIMIT 1;");
    if (!pollRes.rows || pollRes.rows.length === 0) {
      return res.json({ success: true, poll: null });
    }

    const formatted = await updateAndFormatPoll(pollRes.rows[0]);
    if (!formatted || formatted.status !== 'ACTIVE') {
      return res.json({ success: true, poll: null });
    }

    let userVote = null;
    if (req.user) {
      const vRes = await db.query('SELECT option_id FROM menu_poll_votes WHERE poll_id = $1 AND customer_id = $2;', [formatted.id, req.user.id]);
      if (vRes.rows.length > 0) userVote = vRes.rows[0].option_id;
    }

    res.json({
      success: true,
      poll: formatted,
      has_voted: Boolean(userVote),
      voted_option_id: userVote
    });
  } catch (err) {
    console.error('Get Active Poll Error:', err);
    res.status(500).json({ success: false, message: "Failed to load active poll." });
  }
});

// 4. Get Single Poll Detail & Real-Time Results
app.get('/api/menu-voting/polls/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const pollRes = await db.query('SELECT * FROM menu_polls WHERE id = $1;', [id]);
    if (!pollRes.rows || pollRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Poll not found." });
    }

    const formatted = await updateAndFormatPoll(pollRes.rows[0]);
    let userVote = null;
    if (req.user) {
      const vRes = await db.query('SELECT option_id FROM menu_poll_votes WHERE poll_id = $1 AND customer_id = $2;', [formatted.id, req.user.id]);
      if (vRes.rows.length > 0) userVote = vRes.rows[0].option_id;
    }

    res.json({
      success: true,
      poll: formatted,
      has_voted: Boolean(userVote),
      voted_option_id: userVote
    });
  } catch (err) {
    console.error('Get Poll Detail Error:', err);
    res.status(500).json({ success: false, message: "Failed to load poll details." });
  }
});

// 5. Submit Customer Vote (Strict Server-Side Authentication & Closed Protection)
app.post('/api/menu-voting/polls/:id/vote', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { option_id } = req.body;
    const customerId = req.user.id;

    if (!option_id) {
      return res.status(400).json({ success: false, message: "Please select a food dish option to vote." });
    }

    const pollRes = await db.query('SELECT * FROM menu_polls WHERE id = $1;', [id]);
    if (!pollRes.rows || pollRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Voting poll not found." });
    }

    const poll = pollRes.rows[0];
    const formatted = await updateAndFormatPoll(poll);

    const now = new Date();
    const startAt = new Date(poll.start_at);
    const endAt = new Date(poll.end_at);

    if (!formatted || formatted.status !== 'ACTIVE' || now < startAt || now > endAt) {
      if (now > endAt && poll.status === 'ACTIVE') {
        try {
          await db.query("UPDATE menu_polls SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP WHERE id = $1;", [id]);
          activeWsClients.forEach((client, ws) => {
            if (ws.readyState === 1) {
              try { ws.send(JSON.stringify({ type: 'POLL_CLOSED', data: { id, status: 'CLOSED' } })); } catch (e) {}
            }
          });
        } catch (e) {}
      }
      return res.status(400).json({
        success: false,
        message: "🗳️ Voting Closed. Voting for tomorrow’s special has ended."
      });
    }

    // Verify selected option belongs to this poll
    const optCheck = await db.query('SELECT id FROM menu_poll_options WHERE id = $1 AND poll_id = $2;', [option_id, id]);
    if (!optCheck.rows || optCheck.rows.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid poll option selected." });
    }

    // SERVER-SIDE VOTE DUP CHECK
    const existingVoteRes = await db.query('SELECT option_id FROM menu_poll_votes WHERE poll_id = $1 AND customer_id = $2;', [id, customerId]);
    if (existingVoteRes.rows && existingVoteRes.rows.length > 0) {
      await logSecurityEvent({
        event_type: 'REWARD_ABUSE',
        risk_level: 'MEDIUM',
        customer_id: customerId,
        details: `Customer attempt to submit duplicate vote for poll ${id}`
      });
      return res.status(400).json({
        success: false,
        code: 'DUPLICATE_VOTE',
        message: "✅ You have already voted in this poll. Duplicate votes are strictly prevented."
      });
    }

    const voteId = 'vote_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    try {
      await db.query(
        `INSERT INTO menu_poll_votes (id, poll_id, option_id, customer_id, created_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP);`,
        [voteId, id, option_id, customerId]
      );
    } catch (vErr) {
      // Database Unique Constraint catch fallback
      return res.status(400).json({
        success: false,
        code: 'DUPLICATE_VOTE',
        message: "✅ Your vote has already been recorded."
      });
    }

    // Fetch updated live results
    const updatedPoll = await updateAndFormatPoll(pollRes.rows[0]);

    // Broadcast live WebSocket Vote Update to all connected clients
    activeWsClients.forEach((client, ws) => {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'VOTE_UPDATE', poll_id: id, poll: updatedPoll })); } catch (e) {}
      }
    });

    const votedOption = updatedPoll.options.find(o => o.id === option_id);

    res.json({
      success: true,
      message: `✅ Your vote has been recorded. You voted for ${votedOption ? votedOption.food_name : 'your selected dish'}.`,
      poll: updatedPoll,
      voted_option_id: option_id
    });
  } catch (err) {
    console.error('Submit Vote Error:', err);
    res.status(500).json({ success: false, message: "Failed to submit vote." });
  }
});

// 6. Close Poll Manually (Owner Only)
app.post('/api/menu-voting/polls/:id/close', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const pollCheck = await db.query('SELECT * FROM menu_polls WHERE id = $1;', [id]);
    if (!pollCheck.rows.length) return res.status(404).json({ success: false, message: "Poll not found." });

    await db.query("UPDATE menu_polls SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP WHERE id = $1;", [id]);
    const freshRes = await db.query('SELECT * FROM menu_polls WHERE id = $1;', [id]);
    const updatedPoll = await updateAndFormatPoll(freshRes.rows[0]);

    activeWsClients.forEach((client, ws) => {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'POLL_CLOSED', data: updatedPoll })); } catch (e) {}
      }
    });

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name,
      action: 'CLOSE_MENU_POLL',
      resource_type: 'MENU_POLL',
      resource_id: id,
      details: `Closed voting for poll "${updatedPoll.question}"`
    });

    res.json({ success: true, poll: updatedPoll, message: "Poll closed successfully." });
  } catch (err) {
    console.error('Close Poll Error:', err);
    res.status(500).json({ success: false, message: "Failed to close poll." });
  }
});

// 7. Cancel Poll (Owner Only)
app.post('/api/menu-voting/polls/:id/cancel', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const pollCheck = await db.query('SELECT * FROM menu_polls WHERE id = $1;', [id]);
    if (!pollCheck.rows.length) return res.status(404).json({ success: false, message: "Poll not found." });

    await db.query("UPDATE menu_polls SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1;", [id]);
    const freshRes = await db.query('SELECT * FROM menu_polls WHERE id = $1;', [id]);
    const updatedPoll = await updateAndFormatPoll(freshRes.rows[0]);

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name,
      action: 'CANCEL_MENU_POLL',
      resource_type: 'MENU_POLL',
      resource_id: id,
      details: `Cancelled poll "${updatedPoll.question}"`
    });

    res.json({ success: true, poll: updatedPoll, message: "Poll cancelled." });
  } catch (err) {
    console.error('Cancel Poll Error:', err);
    res.status(500).json({ success: false, message: "Failed to cancel poll." });
  }
});

// 8. Select Winner in Case of a Tie (Owner Only)
app.post('/api/menu-voting/polls/:id/select-winner', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { food_id } = req.body;

    if (!food_id) return res.status(400).json({ success: false, message: "Selected food item is required." });

    const pollRes = await db.query('SELECT * FROM menu_polls WHERE id = $1;', [id]);
    if (!pollRes.rows.length) return res.status(404).json({ success: false, message: "Poll not found." });

    await db.query(
      `UPDATE menu_polls
       SET winner_food_id = $1, winner_selection_type = 'MANUAL_TIE', status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2;`,
      [food_id, id]
    );

    const updatedPoll = await updateAndFormatPoll(pollRes.rows[0]);

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name,
      action: 'SELECT_TIE_WINNER',
      resource_type: 'MENU_POLL',
      resource_id: id,
      details: `Owner manually broke tie and selected winner dish ID ${food_id}`
    });

    res.json({ success: true, poll: updatedPoll, message: "Winner dish selected successfully." });
  } catch (err) {
    console.error('Select Winner Error:', err);
    res.status(500).json({ success: false, message: "Failed to set poll winner." });
  }
});

// 9. Publish Winner as Tomorrow's Special (Owner Only)
app.post('/api/menu-voting/polls/:id/publish-special', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const pollRes = await db.query('SELECT * FROM menu_polls WHERE id = $1;', [id]);
    if (!pollRes.rows.length) return res.status(404).json({ success: false, message: "Poll not found." });

    const poll = pollRes.rows[0];
    const formatted = await updateAndFormatPoll(poll);

    const winnerFoodId = formatted.winner_food_id || (formatted.winner ? formatted.winner.food_id : null);
    if (!winnerFoodId) {
      return res.status(400).json({ success: false, message: "Cannot publish Tomorrow's Special before a winner is selected." });
    }

    await db.query('UPDATE menu_polls SET tomorrow_special_published = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1;', [id]);

    const winnerName = formatted.winner ? formatted.winner.food_name : 'Selected Special';

    // Broadcast push notification to all customers
    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      title: '🏆 Tomorrow’s Special Selected!',
      message: `${winnerName} has won the customer vote and is selected as tomorrow’s special!`,
      type: 'MENU',
      action_url: '/#secCustomerHome'
    });

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name,
      action: 'PUBLISH_TOMORROW_SPECIAL',
      resource_type: 'MENU_POLL',
      resource_id: id,
      details: `Published "${winnerName}" as Tomorrow's Special`
    });

    res.json({ success: true, poll: formatted, message: `"${winnerName}" set as Tomorrow's Special successfully.` });
  } catch (err) {
    console.error('Publish Special Error:', err);
    res.status(500).json({ success: false, message: "Failed to publish Tomorrow's Special." });
  }
});

// 10. Delete Poll Safely (Owner Only)
app.delete('/api/menu-voting/polls/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM menu_polls WHERE id = $1;', [id]);

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name,
      action: 'DELETE_MENU_POLL',
      resource_type: 'MENU_POLL',
      resource_id: id,
      details: `Deleted menu voting poll ID ${id}`
    });

    res.json({ success: true, message: "Poll deleted successfully." });
  } catch (err) {
    console.error('Delete Poll Error:', err);
    res.status(500).json({ success: false, message: "Failed to delete poll." });
  }
});

// 11. Customer Vote History
app.get('/api/menu-voting/my-votes', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const vRes = await db.query(
      `SELECT v.id as vote_id, v.created_at as voted_at, p.id as poll_id, p.question, p.status, p.winner_food_id, t.name as my_voted_food
       FROM menu_poll_votes v
       JOIN menu_polls p ON v.poll_id = p.id
       JOIN menu_poll_options o ON v.option_id = o.id
       JOIN tiffins t ON o.food_id = t.id
       WHERE v.customer_id = $1
       ORDER BY v.created_at DESC;`,
      [req.user.id]
    );
    res.json({ success: true, data: vRes.rows || [] });
  } catch (err) {
    console.error('My Votes Error:', err);
    res.status(500).json({ success: false, message: "Failed to load voting history." });
  }
});


// =========================================================================
// SECURITY & ANTI-FRAUD CENTER API ENDPOINTS (OWNER ONLY)
// =========================================================================

// 1. Dashboard KPI Stats & Security Status Calculation
app.get('/api/security/dashboard-stats', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const todayStartIso = new Date(new Date().setHours(0,0,0,0)).toISOString();

    const unresolvedRes = await db.query("SELECT risk_level, COUNT(*) as c FROM security_events WHERE status IN ('NEW', 'UNDER_REVIEW') GROUP BY risk_level;");
    let criticalUnresolved = 0;
    let highUnresolved = 0;
    let mediumUnresolved = 0;
    let totalUnresolved = 0;

    (unresolvedRes.rows || []).forEach(r => {
      const cnt = Number(r.c || 0);
      totalUnresolved += cnt;
      if (r.risk_level === 'CRITICAL') criticalUnresolved += cnt;
      if (r.risk_level === 'HIGH') highUnresolved += cnt;
      if (r.risk_level === 'MEDIUM') mediumUnresolved += cnt;
    });

    let securityStatus = 'PROTECTED';
    let statusLabel = '🟢 Protected';
    if (criticalUnresolved > 0) {
      securityStatus = 'CRITICAL';
      statusLabel = '🔴 Critical Issues';
    } else if (highUnresolved >= 3 || mediumUnresolved >= 5) {
      securityStatus = 'ATTENTION';
      statusLabel = '🟡 Attention Required';
    }

    const typeRes = await db.query("SELECT event_type, COUNT(*) as c FROM security_events WHERE status IN ('NEW', 'UNDER_REVIEW') GROUP BY event_type;");
    let duplicateAttempts = 0;
    let paymentIssues = 0;
    let rewardIssues = 0;

    (typeRes.rows || []).forEach(r => {
      const cnt = Number(r.c || 0);
      if (['DUPLICATE_ORDER', 'DUPLICATE_PAYMENT', 'REWARD_ABUSE', 'REFERRAL_ABUSE', 'PREMIUM_CARD_ABUSE'].includes(r.event_type)) {
        duplicateAttempts += cnt;
      }
      if (['DUPLICATE_PAYMENT', 'PAYMENT_MISMATCH', 'PAYMENT_FAIL'].includes(r.event_type)) {
        paymentIssues += cnt;
      }
      if (['REWARD_ABUSE', 'REFERRAL_ABUSE', 'PREMIUM_CARD_ABUSE'].includes(r.event_type)) {
        rewardIssues += cnt;
      }
    });

    const todayRes = await db.query("SELECT COUNT(*) as c FROM security_events WHERE created_at >= $1;", [todayStartIso]);
    const eventsToday = Number(todayRes.rows[0]?.c || 0);

    const blockedRes = await db.query("SELECT COUNT(*) as c FROM security_events WHERE status = 'RESOLVED' OR event_type LIKE 'DUPLICATE_%';");
    const blockedAttempts = Number(blockedRes.rows[0]?.c || 0);

    res.json({
      success: true,
      data: {
        security_status: securityStatus,
        status_label: statusLabel,
        suspicious_activities_count: totalUnresolved,
        blocked_attempts: blockedAttempts,
        duplicate_attempts: duplicateAttempts,
        payment_issues: paymentIssues,
        reward_issues: rewardIssues,
        events_today: eventsToday
      }
    });
  } catch (err) {
    console.error('Security Dashboard Stats Error:', err);
    res.status(500).json({ success: false, message: "Failed to load security stats." });
  }
});

// 2. List Security Events (Paginated + Filtered)
app.get('/api/security/events', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const { status, risk_level, event_type, search } = req.query;

    let sql = `SELECT s.*, u.name as customer_name, u.mobile as customer_mobile
               FROM security_events s
               LEFT JOIN users u ON s.customer_id = u.id`;
    let countSql = `SELECT COUNT(*) as c FROM security_events s LEFT JOIN users u ON s.customer_id = u.id`;
    let params = [];
    let conditions = [];

    if (status && status !== 'ALL') {
      conditions.push(`s.status = $${params.length + 1}`);
      params.push(status.toUpperCase());
    }

    if (risk_level && risk_level !== 'ALL') {
      conditions.push(`s.risk_level = $${params.length + 1}`);
      params.push(risk_level.toUpperCase());
    }

    if (event_type && event_type !== 'ALL') {
      conditions.push(`s.event_type = $${params.length + 1}`);
      params.push(event_type.toUpperCase());
    }

    if (search && search.trim()) {
      const q = `%${search.trim().toLowerCase()}%`;
      conditions.push(`(LOWER(s.id) LIKE $${params.length + 1} OR LOWER(s.details) LIKE $${params.length + 1} OR LOWER(s.order_id) LIKE $${params.length + 1} OR LOWER(s.payment_id) LIKE $${params.length + 1} OR LOWER(u.name) LIKE $${params.length + 1} OR u.mobile LIKE $${params.length + 1})`);
      params.push(q);
    }

    if (conditions.length > 0) {
      const whereClause = ' WHERE ' + conditions.join(' AND ');
      sql += whereClause;
      countSql += whereClause;
    }

    sql += ` ORDER BY s.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2};`;
    const queryParams = [...params, limit, offset];

    const [dataRes, countRes] = await Promise.all([
      db.query(sql, queryParams),
      db.query(countSql, params)
    ]);

    const totalRecords = Number(countRes.rows[0]?.c || 0);
    const totalPages = Math.ceil(totalRecords / limit);

    res.json({
      success: true,
      data: dataRes.rows || [],
      pagination: {
        page,
        limit,
        totalRecords,
        totalPages
      }
    });
  } catch (err) {
    console.error('List Security Events Error:', err);
    res.status(500).json({ success: false, message: "Failed to load security events." });
  }
});

// 3. View Single Security Event Detail
app.get('/api/security/events/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const eRes = await db.query(
      `SELECT s.*, u.name as customer_name, u.mobile as customer_mobile, u.email as customer_email
       FROM security_events s
       LEFT JOIN users u ON s.customer_id = u.id
       WHERE s.id = $1;`,
      [id]
    );
    if (!eRes.rows || eRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Security event record not found." });
    }
    res.json({ success: true, data: eRes.rows[0] });
  } catch (err) {
    console.error('Get Security Event Detail Error:', err);
    res.status(500).json({ success: false, message: "Failed to fetch security event details." });
  }
});

// 4. Update Security Event Status / Internal Notes (Owner Action)
app.patch('/api/security/events/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, internal_note } = req.body;

    const eRes = await db.query('SELECT * FROM security_events WHERE id = $1;', [id]);
    if (!eRes.rows || eRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Security event record not found." });
    }

    const current = eRes.rows[0];
    const newStatus = status ? status.toUpperCase() : current.status;
    const newNote = internal_note !== undefined ? internal_note : current.internal_note;

    await db.query(
      `UPDATE security_events
       SET status = $1, internal_note = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3;`,
      [newStatus, newNote, id]
    );

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name,
      action: 'UPDATE_SECURITY_EVENT',
      resource_type: 'SECURITY_EVENT',
      resource_id: id,
      details: `Updated security event ${id} status to ${newStatus}`
    });

    const updated = await db.query('SELECT * FROM security_events WHERE id = $1;', [id]);
    res.json({ success: true, data: updated.rows[0], message: `Security event status updated to ${newStatus}.` });
  } catch (err) {
    console.error('Update Security Event Error:', err);
    res.status(500).json({ success: false, message: "Failed to update security event status." });
  }
});

// 5. List Owner Audit Logs (Paginated)
app.get('/api/security/audit-logs', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const { search } = req.query;
    let sql = 'SELECT * FROM owner_audit_logs';
    let countSql = 'SELECT COUNT(*) as c FROM owner_audit_logs';
    let params = [];

    if (search && search.trim()) {
      const q = `%${search.trim().toLowerCase()}%`;
      sql += ' WHERE (LOWER(action) LIKE $1 OR LOWER(details) LIKE $1 OR LOWER(actor_name) LIKE $1 OR LOWER(resource_id) LIKE $1)';
      countSql += ' WHERE (LOWER(action) LIKE $1 OR LOWER(details) LIKE $1 OR LOWER(actor_name) LIKE $1 OR LOWER(resource_id) LIKE $1)';
      params.push(q);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2};`;
    const queryParams = [...params, limit, offset];

    const [dataRes, countRes] = await Promise.all([
      db.query(sql, queryParams),
      db.query(countSql, params)
    ]);

    const totalRecords = Number(countRes.rows[0]?.c || 0);
    const totalPages = Math.ceil(totalRecords / limit);

    res.json({
      success: true,
      data: dataRes.rows || [],
      pagination: {
        page,
        limit,
        totalRecords,
        totalPages
      }
    });
  } catch (err) {
    console.error('List Audit Logs Error:', err);
    res.status(500).json({ success: false, message: "Failed to fetch audit logs." });
  }
});

// =========================================================================
// 💸 REFUND TRACKING SYSTEM BACKEND MODULE
// =========================================================================

// Helper function to atomically create a refund record & timeline event
async function createRefundRecord({
  order_id,
  customer_id,
  refund_amount,
  reason,
  actor_type = 'SYSTEM',
  actor_id = null,
  non_refundable_amount = 0.00
}) {
  const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [order_id]);
  if (!oRes.rows || oRes.rows.length === 0) {
    throw new Error('Order not found for refund creation.');
  }
  const order = oRes.rows[0];

  const custId = customer_id || order.customer_id;

  // Fetch customer details if available
  let custName = order.customer_name || 'Customer';
  let custMobile = order.customer_mobile || '';
  if (custId) {
    const uRes = await db.query('SELECT name, mobile FROM users WHERE id = $1;', [custId]);
    if (uRes.rows && uRes.rows[0]) {
      custName = uRes.rows[0].name || custName;
      custMobile = uRes.rows[0].mobile || custMobile;
    }
  }

  const originalPaid = Number(order.net_amount || order.total_amount || 0);

  // Check already refunded amount for this order
  const refRes = await db.query(
    `SELECT SUM(refund_amount) as total_refunded FROM refunds WHERE order_id = $1 AND status NOT IN ('REFUND_REJECTED', 'REFUND_CANCELLED', 'REFUND_FAILED');`,
    [order.id]
  );
  const alreadyRefunded = Number(refRes.rows[0]?.total_refunded || 0);
  const remainingRefundable = Math.max(0, originalPaid - alreadyRefunded);

  let reqAmount = Number(refund_amount || 0);
  if (reqAmount <= 0) reqAmount = remainingRefundable;

  if (reqAmount <= 0) {
    throw new Error('No refundable amount remaining for this order.');
  }

  if (reqAmount > remainingRefundable + 0.01) {
    throw new Error(`Requested refund amount (₹${reqAmount}) exceeds remaining refundable amount (₹${remainingRefundable}).`);
  }

  const refundType = (reqAmount >= originalPaid - 0.01) ? 'FULL' : 'PARTIAL';
  const refundId = 'rf_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const refundRef = `RFN-${order.order_number}-${Math.floor(1000 + Math.random() * 9000)}`;

  const nowIso = new Date().toISOString();
  const expDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  // Retrieve UTR or payment reference
  const payRef = order.utr_number || order.payment_reference || order.id;
  const payMethod = order.payment_method || 'UPI';

  let createdRefund = null;

  await db.executeTransaction(async (tx) => {
    // Insert into refunds table
    const insertRes = await tx.query(
      `INSERT INTO refunds (
        id, refund_reference, order_id, order_number, payment_id, customer_id, customer_name, customer_mobile,
        original_amount, refund_amount, non_refundable_amount, refund_type, reason, status,
        payment_method, payment_reference, expected_completion_date, last_updated_message, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING *;`,
      [
        refundId, refundRef, order.id, order.order_number, order.id, custId, custName, custMobile,
        originalPaid, reqAmount, Number(non_refundable_amount || 0), refundType, reason || 'Order cancelled',
        'REFUND_REQUESTED', payMethod, payRef, expDate, 'Refund request submitted to system.', nowIso, nowIso
      ]
    );

    createdRefund = insertRes.rows[0] || { id: refundId, refund_reference: refundRef };

    // Insert into refund_events timeline
    await tx.query(
      `INSERT INTO refund_events (
        id, refund_id, event_type, previous_status, new_status, message, amount, actor_type, actor_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [
        'rfe_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        refundId, 'REQUESTED', null, 'REFUND_REQUESTED', 'Refund request received.', reqAmount, actor_type, actor_id, nowIso
      ]
    );
  });

  // Log owner audit log
  await logOwnerAuditAction({
    actor_id: actor_id || custId,
    actor_name: custName,
    action: 'CREATE_REFUND_REQUEST',
    resource_type: 'refunds',
    resource_id: refundId,
    details: `Refund request created for Order #${order.order_number} (Amount: ₹${reqAmount})`
  });

  // Dispatch Customer Notification
  if (custId) {
    await createAndDispatchNotification({
      target_role: 'CUSTOMER',
      customer_id: custId,
      title: '💸 Refund Request Received',
      message: `Refund request of ₹${reqAmount} received for Order #${order.order_number}.`,
      type: 'PAYMENT',
      action_url: `/#secCustomerOrders`,
      related_order_id: order.id
    });
  }

  // Broadcast WebSocket update
  activeWsClients.forEach((info, ws) => {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({
          type: 'REFUND_UPDATE',
          data: { refund_id: refundId, order_id: order.id, status: 'REFUND_REQUESTED' }
        }));
      } catch (e) {}
    }
  });

  return createdRefund;
}

// POST /api/refunds/request - Create a new refund request
app.post('/api/refunds/request', authenticateToken, async (req, res) => {
  try {
    const { order_id, refund_amount, reason, non_refundable_amount } = req.body;
    if (!order_id) {
      return res.status(400).json({ success: false, message: 'Order ID is required.' });
    }

    const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [order_id]);
    if (!oRes.rows || oRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    const order = oRes.rows[0];

    // Customer role ownership check
    if (req.user.role === 'CUSTOMER' && order.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    // Check existing active refund
    const existingRef = await db.query(
      `SELECT * FROM refunds WHERE order_id = $1 AND status NOT IN ('REFUND_REJECTED', 'REFUND_CANCELLED', 'REFUND_FAILED');`,
      [order.id]
    );
    if (existingRef.rows && existingRef.rows.length > 0) {
      return res.json({
        success: true,
        message: 'Active refund request already exists.',
        data: existingRef.rows[0]
      });
    }

    const created = await createRefundRecord({
      order_id: order.id,
      customer_id: order.customer_id,
      refund_amount,
      reason: reason || 'Refund requested by user',
      actor_type: req.user.role,
      actor_id: req.user.id,
      non_refundable_amount
    });

    res.json({
      success: true,
      message: '💸 Refund request submitted successfully.',
      data: created
    });
  } catch (err) {
    console.error('Request Refund Error:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to request refund.' });
  }
});

// GET /api/refunds/my-refunds - Customer Refunds list
app.get('/api/refunds/my-refunds', authenticateToken, requireRole('CUSTOMER'), async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '10', 10);
    const offset = (page - 1) * limit;

    const countRes = await db.query('SELECT COUNT(*) as total FROM refunds WHERE customer_id = $1;', [req.user.id]);
    const totalRecords = parseInt(countRes.rows[0]?.total || '0', 10);

    const listRes = await db.query(
      `SELECT * FROM refunds WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3;`,
      [req.user.id, limit, offset]
    );

    res.json({
      success: true,
      data: listRes.rows || [],
      pagination: { page, limit, totalRecords, totalPages: Math.ceil(totalRecords / limit) || 1 }
    });
  } catch (err) {
    console.error('Get My Refunds Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch refunds.' });
  }
});

// GET /api/refunds/:id - Fetch single refund with full event timeline history
app.get('/api/refunds/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const rRes = await db.query(
      'SELECT * FROM refunds WHERE id = $1 OR refund_reference = $1 OR order_id = $1 OR order_number = $1 LIMIT 1;',
      [id]
    );
    if (!rRes.rows || rRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Refund record not found.' });
    }
    const refund = rRes.rows[0];

    // Customer Ownership Verification
    if (req.user.role === 'CUSTOMER' && refund.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "Access denied. You can only view your own refunds." });
    }

    const eventsRes = await db.query('SELECT * FROM refund_events WHERE refund_id = $1 ORDER BY created_at ASC;', [refund.id]);
    refund.timeline = eventsRes.rows || [];

    res.json({ success: true, data: refund });
  } catch (err) {
    console.error('Get Refund Details Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch refund details.' });
  }
});

// GET /api/refunds/owner/stats - Owner Refund Dashboard Summary KPI Metrics
app.get('/api/refunds/owner/stats', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const statsRes = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= $1) as today_count,
        COUNT(*) FILTER (WHERE status IN ('REFUND_REQUESTED', 'REFUND_UNDER_REVIEW')) as pending_count,
        COUNT(*) FILTER (WHERE status IN ('REFUND_APPROVED', 'REFUND_INITIATED', 'REFUND_PROCESSING')) as processing_count,
        COUNT(*) FILTER (WHERE status = 'REFUND_COMPLETED') as completed_count,
        COUNT(*) FILTER (WHERE status = 'REFUND_FAILED') as failed_count,
        COALESCE(SUM(refund_amount) FILTER (WHERE status = 'REFUND_COMPLETED'), 0) as total_refunded_amount
      FROM refunds;
    `, [todayStart.toISOString()]);

    const s = statsRes.rows[0] || {};
    res.json({
      success: true,
      data: {
        refunds_today: parseInt(s.today_count || '0', 10),
        pending_refunds: parseInt(s.pending_count || '0', 10),
        processing_refunds: parseInt(s.processing_count || '0', 10),
        completed_refunds: parseInt(s.completed_count || '0', 10),
        failed_refunds: parseInt(s.failed_count || '0', 10),
        total_refunded: parseFloat(s.total_refunded_amount || '0')
      }
    });
  } catch (err) {
    console.error('Get Refund Stats Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch refund statistics.' });
  }
});

// GET /api/refunds/owner/all - Owner List & Search Refunds Endpoint
app.get('/api/refunds/owner/all', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '15', 10);
    const offset = (page - 1) * limit;

    const statusFilter = req.query.status || 'ALL';
    const refundType = req.query.refund_type || 'ALL';
    const search = (req.query.search || '').toString().trim();

    let whereConditions = [];
    let queryParams = [];
    let paramCounter = 1;

    if (statusFilter !== 'ALL') {
      whereConditions.push(`status = $${paramCounter}`);
      queryParams.push(statusFilter);
      paramCounter++;
    }

    if (refundType !== 'ALL') {
      whereConditions.push(`refund_type = $${paramCounter}`);
      queryParams.push(refundType);
      paramCounter++;
    }

    if (search) {
      whereConditions.push(`(
        order_number ILIKE $${paramCounter} OR
        refund_reference ILIKE $${paramCounter} OR
        customer_name ILIKE $${paramCounter} OR
        customer_mobile ILIKE $${paramCounter} OR
        payment_reference ILIKE $${paramCounter}
      )`);
      queryParams.push(`%${search}%`);
      paramCounter++;
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) as total FROM refunds ${whereClause};`;
    const countRes = await db.query(countSql, queryParams);
    const totalRecords = parseInt(countRes.rows[0]?.total || '0', 10);

    const listSql = `
      SELECT * FROM refunds ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1};
    `;
    const listRes = await db.query(listSql, [...queryParams, limit, offset]);

    res.json({
      success: true,
      data: listRes.rows || [],
      pagination: { page, limit, totalRecords, totalPages: Math.ceil(totalRecords / limit) || 1 }
    });
  } catch (err) {
    console.error('Owner List Refunds Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch refunds list.' });
  }
});

// PATCH /api/refunds/owner/:id/status - Update Refund Status (Owner Controlled Transition)
app.patch('/api/refunds/owner/:id/status', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, message, last_updated_message } = req.body;

    const rRes = await db.query('SELECT * FROM refunds WHERE id = $1 OR refund_reference = $1;', [id]);
    if (!rRes.rows || rRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Refund record not found.' });
    }
    const refund = rRes.rows[0];

    const prevStatus = refund.status;
    const newStatus = (status || prevStatus).toUpperCase();
    const nowIso = new Date().toISOString();

    let completedAt = refund.completed_at;
    if (newStatus === 'REFUND_COMPLETED' && !completedAt) {
      completedAt = nowIso;
    }

    const updateMsg = last_updated_message || message || `Refund status changed to ${newStatus.replace(/_/g, ' ')}`;

    await db.executeTransaction(async (tx) => {
      await tx.query(
        `UPDATE refunds SET status = $1, last_updated_message = $2, updated_at = $3, completed_at = $4 WHERE id = $5;`,
        [newStatus, updateMsg, nowIso, completedAt, refund.id]
      );

      await tx.query(
        `INSERT INTO refund_events (
          id, refund_id, event_type, previous_status, new_status, message, amount, actor_type, actor_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [
          'rfe_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
          refund.id, newStatus.replace('REFUND_', ''), prevStatus, newStatus, updateMsg, refund.refund_amount, 'OWNER', req.user.id, nowIso
        ]
      );
    });

    // Owner Audit Log
    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name || 'Owner',
      action: 'UPDATE_REFUND_STATUS',
      resource_type: 'refunds',
      resource_id: refund.id,
      details: `Updated refund ${refund.refund_reference} status: ${prevStatus} -> ${newStatus}`
    });

    // Notify Customer of Status Update
    if (refund.customer_id) {
      const statusLabels = {
        'REFUND_UNDER_REVIEW': '🔵 Refund Under Review',
        'REFUND_APPROVED': '🟠 Refund Approved',
        'REFUND_INITIATED': '🔵 Refund Initiated',
        'REFUND_PROCESSING': '🟣 Refund Processing',
        'REFUND_COMPLETED': '🟢 Refund Completed',
        'REFUND_FAILED': '🔴 Refund Failed',
        'REFUND_REJECTED': '⚫ Refund Rejected'
      };
      const title = statusLabels[newStatus] || '💸 Refund Status Updated';
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: refund.customer_id,
        title,
        message: `Order #${refund.order_number}: ₹${refund.refund_amount} refund status is now "${newStatus.replace('REFUND_', '').replace(/_/g, ' ')}".`,
        type: 'PAYMENT',
        action_url: `/#secCustomerOrders`,
        related_order_id: refund.order_id
      });
    }

    // Broadcast WebSocket Update
    activeWsClients.forEach((info, ws) => {
      if (ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({
            type: 'REFUND_UPDATE',
            data: { refund_id: refund.id, status: newStatus }
          }));
        } catch (e) {}
      }
    });

    res.json({
      success: true,
      message: `Refund status updated to ${newStatus.replace(/_/g, ' ')}.`,
      data: { id: refund.id, status: newStatus, updated_at: nowIso }
    });
  } catch (err) {
    console.error('Update Refund Status Error:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to update refund status.' });
  }
});

// POST /api/refunds/owner/:id/retry - Retry Failed Refund
app.post('/api/refunds/owner/:id/retry', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const rRes = await db.query('SELECT * FROM refunds WHERE id = $1 OR refund_reference = $1;', [id]);
    if (!rRes.rows || rRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Refund record not found.' });
    }
    const refund = rRes.rows[0];

    if (refund.status !== 'REFUND_FAILED') {
      return res.status(400).json({ success: false, message: `Only failed refunds can be retried. Current status: ${refund.status}` });
    }

    const nowIso = new Date().toISOString();
    await db.executeTransaction(async (tx) => {
      await tx.query(
        `UPDATE refunds SET status = 'REFUND_INITIATED', last_updated_message = 'Refund retry initiated by owner', updated_at = $1 WHERE id = $2;`,
        [nowIso, refund.id]
      );
      await tx.query(
        `INSERT INTO refund_events (
          id, refund_id, event_type, previous_status, new_status, message, amount, actor_type, actor_id, created_at
        ) VALUES ($1, $2, 'RETRY', 'REFUND_FAILED', 'REFUND_INITIATED', 'Refund retry initiated by owner', $3, 'OWNER', $4, $5);`,
        ['rfe_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6), refund.id, refund.refund_amount, req.user.id, nowIso]
      );
    });

    res.json({
      success: true,
      message: 'Refund retry initiated successfully.',
      data: { id: refund.id, status: 'REFUND_INITIATED' }
    });
  } catch (err) {
    console.error('Retry Refund Error:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to retry refund.' });
  }
});

// Helper to record owner actions into owner_audit_logs table
async function logOwnerAuditAction({ actor_id, actor_name, action, resource_type, resource_id, details, ip_address }) {
  try {
    const id = 'audit_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const nowIso = new Date().toISOString();
    await db.query(
      `INSERT INTO owner_audit_logs (id, actor_id, actor_name, action, resource_type, resource_id, details, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [id, actor_id || null, actor_name || null, action, resource_type || null, resource_id || null, details || null, ip_address || null, nowIso]
    );
  } catch (err) {
    console.error('Audit Log Notice:', err.message);
  }
}

// =========================================================================
// 🥘 ADD-ONS / EXTRA ITEMS BACKEND MODULE
// =========================================================================

// GET /api/add-ons - Fetch active add-ons list (or all add-ons for Owner)
app.get('/api/add-ons', async (req, res) => {
  try {
    const includeDisabled = req.query.include_disabled === 'true';

    let sql = `SELECT * FROM add_ons WHERE enabled = true AND available = true ORDER BY display_order ASC, name ASC;`;
    if (includeDisabled) {
      sql = `SELECT * FROM add_ons ORDER BY display_order ASC, name ASC;`;
    }

    const r = await db.query(sql);
    res.json({ success: true, data: r.rows || [] });
  } catch (err) {
    console.error('Get Add-ons Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch add-ons.' });
  }
});

// POST /api/add-ons - Owner Create New Add-on
app.post('/api/add-ons', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { name, price, description, available, category, display_order } = req.body;

    const cleanName = (name || '').trim();
    const numPrice = Number(price);

    if (!cleanName) {
      return res.status(400).json({ success: false, message: 'Add-on name is required.' });
    }
    if (isNaN(numPrice) || numPrice <= 0) {
      return res.status(400).json({ success: false, message: 'Add-on price must be a valid number greater than ₹0.' });
    }

    const id = 'addon_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const nowIso = new Date().toISOString();

    await db.query(
      `INSERT INTO add_ons (id, name, price, description, available, enabled, category, display_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9);`,
      [
        id, cleanName, numPrice, (description || '').trim(),
        available !== false, (category || 'Extras').trim(),
        parseInt(display_order || '0', 10), nowIso, nowIso
      ]
    );

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name || 'Owner',
      action: 'CREATE_ADDON',
      resource_type: 'add_ons',
      resource_id: id,
      details: `Created new Add-on "${cleanName}" (Price: ₹${numPrice})`
    });

    res.json({
      success: true,
      message: `🥘 Add-on "${cleanName}" created successfully!`,
      data: { id, name: cleanName, price: numPrice }
    });
  } catch (err) {
    console.error('Create Add-on Error:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to create add-on.' });
  }
});

// PATCH /api/add-ons/:id - Owner Edit / Toggle Add-on
app.patch('/api/add-ons/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, description, available, enabled, display_order } = req.body;

    const existingRes = await db.query('SELECT * FROM add_ons WHERE id = $1;', [id]);
    if (!existingRes.rows || existingRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Add-on item not found.' });
    }
    const current = existingRes.rows[0];

    const newName = name !== undefined ? String(name).trim() : current.name;
    const newPrice = price !== undefined ? Number(price) : Number(current.price);
    const newDesc = description !== undefined ? String(description).trim() : current.description;
    const newAvail = available !== undefined ? Boolean(available) : Boolean(current.available);
    const newEnabled = enabled !== undefined ? Boolean(enabled) : Boolean(current.enabled);
    const newOrder = display_order !== undefined ? parseInt(display_order, 10) : current.display_order;

    if (!newName) {
      return res.status(400).json({ success: false, message: 'Add-on name cannot be empty.' });
    }
    if (isNaN(newPrice) || newPrice <= 0) {
      return res.status(400).json({ success: false, message: 'Add-on price must be greater than ₹0.' });
    }

    const nowIso = new Date().toISOString();
    await db.query(
      `UPDATE add_ons SET name = $1, price = $2, description = $3, available = $4, enabled = $5, display_order = $6, updated_at = $7 WHERE id = $8;`,
      [newName, newPrice, newDesc, newAvail, newEnabled, newOrder, nowIso, id]
    );

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name || 'Owner',
      action: 'UPDATE_ADDON',
      resource_type: 'add_ons',
      resource_id: id,
      details: `Updated Add-on "${newName}" (Price: ₹${newPrice}, Available: ${newAvail}, Enabled: ${newEnabled})`
    });

    res.json({
      success: true,
      message: `🥘 Add-on "${newName}" updated successfully!`,
      data: { id, name: newName, price: newPrice, available: newAvail, enabled: newEnabled }
    });
  } catch (err) {
    console.error('Update Add-on Error:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to update add-on.' });
  }
});

// DELETE /api/add-ons/:id - Owner Delete Add-on
app.delete('/api/add-ons/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const nowIso = new Date().toISOString();

    try {
      await db.query('DELETE FROM add_ons WHERE id = $1;', [id]);
    } catch (dbErr) {
      await db.query('UPDATE add_ons SET enabled = false, available = false, updated_at = $1 WHERE id = $2;', [nowIso, id]);
    }

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name || 'Owner',
      action: 'DELETE_ADDON',
      resource_type: 'add_ons',
      resource_id: id,
      details: `Deleted add-on ${id}`
    });

    res.json({ success: true, message: 'Add-on item deleted successfully.' });
  } catch (err) {
    console.error('Delete Add-on Error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete add-on.' });
  }
});

// GET /api/add-ons/analytics - Owner Add-on Sales Performance & Revenue
app.get('/api/add-ons/analytics', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const salesRes = await db.query(`
      SELECT
        add_on_id,
        add_on_name,
        SUM(quantity) as total_sold,
        SUM(subtotal) as total_revenue
      FROM order_add_ons
      GROUP BY add_on_id, add_on_name
      ORDER BY total_sold DESC;
    `);

    res.json({ success: true, data: salesRes.rows || [] });
  } catch (err) {
    console.error('Add-on Analytics Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch add-on analytics.' });
  }
});

// =========================================================================
// 🗳️ MENU VOTING BACKEND MODULE ("Choose Tomorrow's Special")
// =========================================================================

// Helper to format a single menu poll object with options, votes, and winner stats
async function formatMenuPoll(pollRow, reqUserId = null) {
  try {
    const optionsRes = await db.query(
      `SELECT o.id, o.food_id, t.name as food_name, t.description, t.price, t.image,
              (SELECT COUNT(*) FROM menu_poll_votes v WHERE v.option_id = o.id) as votes
       FROM menu_poll_options o
       JOIN tiffins t ON o.food_id = t.id
       WHERE o.poll_id = $1
       ORDER BY o.created_at ASC;`,
      [pollRow.id]
    );

    const rawOptions = optionsRes.rows || [];
    let totalVotes = 0;
    rawOptions.forEach(opt => {
      opt.votes = Number(opt.votes || 0);
      totalVotes += opt.votes;
    });

    const options = rawOptions.map(opt => ({
      id: opt.id,
      food_id: opt.food_id,
      food_name: opt.food_name,
      description: opt.description || '',
      price: Number(opt.price || 0),
      food_price: Number(opt.price || 0),
      image: opt.image || '/images/idly_sambar.png',
      food_image: opt.image || '/images/idly_sambar.png',
      votes: opt.votes,
      votes_count: opt.votes,
      percentage: totalVotes > 0 ? Math.round((opt.votes / totalVotes) * 100) : 0,
      vote_percentage: totalVotes > 0 ? Math.round((opt.votes / totalVotes) * 100) : 0
    }));

    let hasVoted = false;
    let votedOptionId = null;
    if (reqUserId) {
      const userVoteRes = await db.query(
        `SELECT option_id FROM menu_poll_votes WHERE poll_id = $1 AND customer_id = $2 LIMIT 1;`,
        [pollRow.id, reqUserId]
      );
      if (userVoteRes.rows && userVoteRes.rows.length > 0) {
        hasVoted = true;
        votedOptionId = userVoteRes.rows[0].option_id;
      }
    }

    // Determine highest vote / winner / tie
    let maxVotes = 0;
    options.forEach(o => { if (o.votes > maxVotes) maxVotes = o.votes; });
    const leading = maxVotes > 0 ? options.filter(o => o.votes === maxVotes) : [];
    const isTie = leading.length > 1;

    let winner = null;
    if (pollRow.winner_food_id) {
      winner = options.find(o => o.food_id === pollRow.winner_food_id) || null;
    } else if (leading.length === 1) {
      winner = leading[0];
    }

    // Auto-update poll status based on current time window if needed
    const now = new Date();
    const startAt = new Date(pollRow.start_at);
    const endAt = new Date(pollRow.end_at);
    let currentStatus = pollRow.status;

    if (currentStatus === 'ACTIVE' || currentStatus === 'SCHEDULED') {
      if (now < startAt) {
        currentStatus = 'SCHEDULED';
      } else if (now >= startAt && now <= endAt) {
        currentStatus = 'ACTIVE';
      } else if (now > endAt) {
        currentStatus = 'CLOSED';
        try {
          await db.query(`UPDATE menu_polls SET status = 'CLOSED', updated_at = NOW() WHERE id = $1;`, [pollRow.id]);
        } catch (e) { }
      }
    }

    return {
      id: pollRow.id,
      question: pollRow.question || "Choose Tomorrow's Special",
      start_at: pollRow.start_at,
      end_at: pollRow.end_at,
      status: currentStatus,
      winner_food_id: pollRow.winner_food_id || (winner ? winner.food_id : null),
      winner_selection_type: pollRow.winner_selection_type || 'AUTOMATIC',
      tomorrow_special_published: Boolean(pollRow.tomorrow_special_published),
      total_votes: totalVotes,
      options,
      has_voted: hasVoted,
      voted_option_id: votedOptionId,
      is_tie: isTie,
      leading_options: isTie ? leading : [],
      winner
    };
  } catch (err) {
    console.error('formatMenuPoll error:', err);
    return null;
  }
}

// GET /api/menu-voting/active - Fetch active poll for Customer
app.get('/api/menu-voting/active', async (req, res) => {
  try {
    let reqUserId = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      try {
        const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET || 'annapurna_secret_key_2026');
        reqUserId = decoded.id;
      } catch (e) {
        try {
          const tokRes = await db.query('SELECT user_id FROM tokens WHERE token = $1;', [token]);
          if (tokRes.rows && tokRes.rows.length > 0) reqUserId = tokRes.rows[0].user_id;
        } catch (e2) { }
      }
    }

    const pollRes = await db.query(
      `SELECT * FROM menu_polls WHERE status IN ('ACTIVE', 'SCHEDULED') ORDER BY created_at DESC LIMIT 1;`
    );

    if (!pollRes.rows || pollRes.rows.length === 0) {
      return res.json({ success: true, poll: null });
    }

    const formatted = await formatMenuPoll(pollRes.rows[0], reqUserId);
    if (!formatted || formatted.status !== 'ACTIVE') {
      return res.json({ success: true, poll: null });
    }

    res.json({
      success: true,
      poll: formatted,
      has_voted: formatted ? formatted.has_voted : false,
      voted_option_id: formatted ? formatted.voted_option_id : null
    });
  } catch (err) {
    console.error('Get active menu voting error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch active menu vote.' });
  }
});

// POST /api/menu-voting/polls/:pollId/vote - Customer Submit Vote
app.post('/api/menu-voting/polls/:pollId/vote', authenticateToken, async (req, res) => {
  try {
    const { pollId } = req.params;
    const { option_id } = req.body;
    const customer_id = req.user.id;

    if (!option_id) {
      return res.status(400).json({ success: false, message: 'Option ID is required to vote.' });
    }

    const pollRes = await db.query(`SELECT * FROM menu_polls WHERE id = $1;`, [pollId]);
    if (!pollRes.rows || pollRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Menu voting poll not found.' });
    }
    const poll = pollRes.rows[0];
    const formatted = await formatMenuPoll(poll, customer_id);

    const now = new Date();
    const startAt = new Date(poll.start_at);
    const endAt = new Date(poll.end_at);

    if (!formatted || formatted.status !== 'ACTIVE' || now < startAt || now > endAt) {
      if (now > endAt && poll.status === 'ACTIVE') {
        try {
          await db.query("UPDATE menu_polls SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP WHERE id = $1;", [pollId]);
          activeWsClients.forEach((client, ws) => {
            if (ws.readyState === 1) {
              try { ws.send(JSON.stringify({ type: 'POLL_CLOSED', data: { id: pollId, status: 'CLOSED' } })); } catch (e) {}
            }
          });
        } catch (e) {}
      }
      return res.status(400).json({
        success: false,
        message: '🗳️ Voting Closed. Voting for tomorrow’s special has ended.'
      });
    }

    const optRes = await db.query(`SELECT * FROM menu_poll_options WHERE id = $1 AND poll_id = $2;`, [option_id, pollId]);
    if (!optRes.rows || optRes.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid voting option selected.' });
    }

    // Check if user already voted
    const existingVote = await db.query(`SELECT * FROM menu_poll_votes WHERE poll_id = $1 AND customer_id = $2;`, [pollId, customer_id]);
    if (existingVote.rows && existingVote.rows.length > 0) {
      const formattedPoll = await formatMenuPoll(poll, customer_id);
      return res.json({
        success: true,
        message: 'You have already voted in this poll.',
        poll: formattedPoll,
        voted_option_id: existingVote.rows[0].option_id
      });
    }

    const voteId = 'vote_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const nowIso = new Date().toISOString();

    await db.query(
      `INSERT INTO menu_poll_votes (id, poll_id, option_id, customer_id, created_at) VALUES ($1, $2, $3, $4, $5);`,
      [voteId, pollId, option_id, customer_id, nowIso]
    );

    const updatedFormatted = await formatMenuPoll(poll, customer_id);

    res.json({
      success: true,
      message: '✅ Your vote has been recorded!',
      poll: updatedFormatted,
      voted_option_id: option_id
    });
  } catch (err) {
    console.error('Vote Error:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to submit vote.' });
  }
});

// GET /api/menu-voting/polls - Owner List Menu Voting Polls
app.get('/api/menu-voting/polls', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { status, search } = req.query;

    let sql = `SELECT * FROM menu_polls WHERE 1=1`;
    const params = [];

    if (status && status !== 'ALL') {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }

    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      sql += ` AND LOWER(question) LIKE LOWER($${params.length})`;
    }

    sql += ` ORDER BY created_at DESC;`;

    const r = await db.query(sql, params);
    const polls = r.rows || [];

    const formattedPolls = [];
    for (const pollRow of polls) {
      const f = await formatMenuPoll(pollRow, req.user.id);
      if (f) formattedPolls.push(f);
    }

    res.json({ success: true, data: formattedPolls });
  } catch (err) {
    console.error('Get Owner Polls Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch menu voting polls.' });
  }
});

// POST /api/menu-voting/polls - Owner Create New Menu Vote Poll
app.post('/api/menu-voting/polls', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { question, start_at, end_at, food_ids } = req.body;

    const cleanQuestion = (question || '').trim() || "Choose Tomorrow's Special";
    const foodIds = Array.isArray(food_ids) ? food_ids.filter(id => Boolean(id)) : [];

    if (foodIds.length < 2) {
      return res.status(400).json({ success: false, message: 'Please select at least 2 food items for the poll.' });
    }
    if (foodIds.length > 5) {
      return res.status(400).json({ success: false, message: 'Maximum 5 food items allowed per poll.' });
    }

    const now = new Date();
    const startObj = start_at ? new Date(start_at) : now;
    const endObj = end_at ? new Date(end_at) : new Date(now.getTime() + 24 * 60 * 60 * 1000);

    if (isNaN(startObj.getTime()) || isNaN(endObj.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid start or end date/time.' });
    }
    if (endObj <= startObj) {
      return res.status(400).json({ success: false, message: 'Voting end time must be after start time.' });
    }

    let initialStatus = 'ACTIVE';
    if (now < startObj) {
      initialStatus = 'SCHEDULED';
    } else if (now > endObj) {
      initialStatus = 'CLOSED';
    }

    const pollId = 'poll_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const nowIso = now.toISOString();

    await db.query(
      `INSERT INTO menu_polls (id, question, start_at, end_at, status, winner_selection_type, tomorrow_special_published, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'AUTOMATIC', false, $6, $7);`,
      [pollId, cleanQuestion, startObj.toISOString(), endObj.toISOString(), initialStatus, nowIso, nowIso]
    );

    for (const foodId of foodIds) {
      const optId = 'opt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
      await db.query(
        `INSERT INTO menu_poll_options (id, poll_id, food_id, created_at) VALUES ($1, $2, $3, $4);`,
        [optId, pollId, foodId, nowIso]
      );
    }

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name || 'Owner',
      action: 'CREATE_MENU_POLL',
      resource_type: 'menu_polls',
      resource_id: pollId,
      details: `Created menu vote poll "${cleanQuestion}" with ${foodIds.length} dishes`
    });

    res.json({
      success: true,
      message: '🗳️ Menu voting poll created successfully!',
      data: { id: pollId, question: cleanQuestion, status: initialStatus }
    });
  } catch (err) {
    console.error('Create Poll Error:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to create menu voting poll.' });
  }
});

// POST /api/menu-voting/polls/:pollId/close - Owner Close Poll
app.post('/api/menu-voting/polls/:pollId/close', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { pollId } = req.params;
    const nowIso = new Date().toISOString();

    await db.query(`UPDATE menu_polls SET status = 'CLOSED', updated_at = $1 WHERE id = $2;`, [nowIso, pollId]);

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name || 'Owner',
      action: 'CLOSE_MENU_POLL',
      resource_type: 'menu_polls',
      resource_id: pollId,
      details: `Closed voting poll ${pollId}`
    });

    res.json({ success: true, message: 'Voting poll closed successfully.' });
  } catch (err) {
    console.error('Close Poll Error:', err);
    res.status(500).json({ success: false, message: 'Failed to close voting poll.' });
  }
});

// POST /api/menu-voting/polls/:pollId/cancel - Owner Cancel Poll
app.post('/api/menu-voting/polls/:pollId/cancel', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { pollId } = req.params;
    const nowIso = new Date().toISOString();

    await db.query(`UPDATE menu_polls SET status = 'CANCELLED', updated_at = $1 WHERE id = $2;`, [nowIso, pollId]);

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name || 'Owner',
      action: 'CANCEL_MENU_POLL',
      resource_type: 'menu_polls',
      resource_id: pollId,
      details: `Cancelled voting poll ${pollId}`
    });

    res.json({ success: true, message: 'Voting poll cancelled.' });
  } catch (err) {
    console.error('Cancel Poll Error:', err);
    res.status(500).json({ success: false, message: 'Failed to cancel voting poll.' });
  }
});

// POST /api/menu-voting/polls/:pollId/select-winner - Owner Resolve Tie / Select Winner
app.post('/api/menu-voting/polls/:pollId/select-winner', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { pollId } = req.params;
    const { food_id } = req.body;
    const nowIso = new Date().toISOString();

    if (!food_id) {
      return res.status(400).json({ success: false, message: 'Food ID is required to select winner.' });
    }

    await db.query(
      `UPDATE menu_polls SET winner_food_id = $1, status = 'COMPLETED', winner_selection_type = 'MANUAL', updated_at = $2 WHERE id = $3;`,
      [food_id, nowIso, pollId]
    );

    res.json({ success: true, message: 'Winner dish selected successfully!' });
  } catch (err) {
    console.error('Select Winner Error:', err);
    res.status(500).json({ success: false, message: 'Failed to select winner.' });
  }
});

// POST /api/menu-voting/polls/:pollId/publish-special - Owner Set Winner as Tomorrow's Special
app.post('/api/menu-voting/polls/:pollId/publish-special', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { pollId } = req.params;
    const nowIso = new Date().toISOString();

    await db.query(
      `UPDATE menu_polls SET tomorrow_special_published = true, status = 'COMPLETED', updated_at = $1 WHERE id = $2;`,
      [nowIso, pollId]
    );

    res.json({ success: true, message: "✨ Winning dish set as Tomorrow's Special!" });
  } catch (err) {
    console.error('Publish Special Error:', err);
    res.status(500).json({ success: false, message: 'Failed to publish special.' });
  }
});

// DELETE /api/menu-voting/polls/:pollId - Owner Delete Poll
app.delete('/api/menu-voting/polls/:pollId', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { pollId } = req.params;

    await db.query(`DELETE FROM menu_polls WHERE id = $1;`, [pollId]);

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name || 'Owner',
      action: 'DELETE_MENU_POLL',
      resource_type: 'menu_polls',
      resource_id: pollId,
      details: `Deleted voting poll ${pollId}`
    });

    res.json({ success: true, message: 'Voting poll deleted successfully.' });
  } catch (err) {
    console.error('Delete Poll Error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete voting poll.' });
  }
});

// PATCH /api/orders/:id/preparation-time - Owner Update Order Live Preparation Time
app.patch('/api/orders/:id/preparation-time', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const prepMinutes = parseInt(req.body.preparation_minutes, 10);

    if (isNaN(prepMinutes) || prepMinutes < 1 || prepMinutes > 180) {
      return res.status(400).json({
        success: false,
        message: 'Invalid preparation time. Please enter a valid number of minutes between 1 and 180.'
      });
    }

    const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
    if (!oRes.rows || oRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    const order = oRes.rows[0];

    const estimatedReadyAt = new Date(Date.now() + prepMinutes * 60000).toISOString();

    await db.query(
      `UPDATE orders SET preparation_minutes = $1, estimated_ready_at = $2 WHERE id = $3;`,
      [prepMinutes, estimatedReadyAt, order.id]
    );

    // Broadcast WebSocket event to all connected clients
    activeWsClients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: 'PREPARATION_TIME_UPDATE',
          data: {
            order_id: order.id,
            order_number: order.order_number,
            customer_id: order.customer_id,
            preparation_minutes: prepMinutes,
            estimated_ready_at: estimatedReadyAt
          }
        }));
      }
    });

    // Notify Customer via Notification Engine
    if (order.customer_id) {
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: order.customer_id,
        title: `⏱️ Preparation Time Updated`,
        message: `Estimated preparation time for Order #${order.order_number} has been updated to ${prepMinutes} minutes.`,
        type: 'QUEUE',
        priority: 'HIGH',
        action_url: '/#secQueueProgress',
        related_order_id: order.id
      });
    }

    await logOwnerAuditAction({
      actor_id: req.user.id,
      actor_name: req.user.name || 'Owner',
      action: 'UPDATE_PREP_TIME',
      resource_type: 'orders',
      resource_id: order.id,
      details: `Updated Order #${order.order_number} prep time to ${prepMinutes} mins (Estimated ready at ${estimatedReadyAt})`
    });

    res.json({
      success: true,
      message: `⏱️ Preparation time updated to ${prepMinutes} minutes.`,
      data: {
        id: order.id,
        order_number: order.order_number,
        preparation_minutes: prepMinutes,
        estimated_ready_at: estimatedReadyAt
      }
    });
  } catch (err) {
    console.error('Update Preparation Time Error:', err);
    res.status(500).json({ success: false, message: 'Failed to update preparation time.' });
  }
});

// =========================================================================
// 🧠 OWNER BUSINESS COPILOT READ-ONLY ANALYTICS MODULE
// =========================================================================

app.get('/api/owner/business-copilot/analytics', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const range = (req.query.range || 'today').toLowerCase().trim();
    const now = new Date();

    let currentStart, currentEnd, prevStart, prevEnd;

    if (range === 'yesterday') {
      currentStart = new Date(now);
      currentStart.setDate(currentStart.getDate() - 1);
      currentStart.setHours(0, 0, 0, 0);

      currentEnd = new Date(now);
      currentEnd.setDate(currentEnd.getDate() - 1);
      currentEnd.setHours(23, 59, 59, 999);

      prevStart = new Date(now);
      prevStart.setDate(prevStart.getDate() - 2);
      prevStart.setHours(0, 0, 0, 0);

      prevEnd = new Date(now);
      prevEnd.setDate(prevEnd.getDate() - 2);
      prevEnd.setHours(23, 59, 59, 999);
    } else if (range === '7days') {
      currentEnd = new Date(now);
      currentStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      prevEnd = new Date(currentStart.getTime() - 1);
      prevStart = new Date(prevEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (range === '30days') {
      currentEnd = new Date(now);
      currentStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      prevEnd = new Date(currentStart.getTime() - 1);
      prevStart = new Date(prevEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else {
      // Default: Today
      currentStart = new Date(now);
      currentStart.setHours(0, 0, 0, 0);
      currentEnd = new Date(now);

      prevStart = new Date(now);
      prevStart.setDate(prevStart.getDate() - 1);
      prevStart.setHours(0, 0, 0, 0);

      prevEnd = new Date(now);
      prevEnd.setDate(prevEnd.getDate() - 1);
      prevEnd.setHours(23, 59, 59, 999);
    }

    const curStartIso = currentStart.toISOString();
    const curEndIso = currentEnd.toISOString();
    const prevStartIso = prevStart.toISOString();
    const prevEndIso = prevEnd.toISOString();

    // 1. Fetch Orders for Current & Previous Comparison Period
    const curOrdersRes = await db.query(
      `SELECT * FROM orders WHERE created_at >= $1 AND created_at <= $2;`,
      [curStartIso, curEndIso]
    );
    const prevOrdersRes = await db.query(
      `SELECT * FROM orders WHERE created_at >= $1 AND created_at <= $2;`,
      [prevStartIso, prevEndIso]
    );

    const curOrders = curOrdersRes.rows || [];
    const prevOrders = prevOrdersRes.rows || [];

    const curValidOrders = curOrders.filter(o => !['Cancelled', 'Rejected'].includes(o.order_status));
    const prevValidOrders = prevOrders.filter(o => !['Cancelled', 'Rejected'].includes(o.order_status));

    // Sales Calculations
    const curSales = curValidOrders.reduce((sum, o) => sum + Number(o.net_amount || o.total_amount || 0), 0);
    const prevSales = prevValidOrders.reduce((sum, o) => sum + Number(o.net_amount || o.total_amount || 0), 0);

    const salesGrowthPct = prevSales > 0
      ? Math.round(((curSales - prevSales) / prevSales) * 100 * 10) / 10
      : (curSales > 0 ? 100 : 0);

    // Orders Count Calculations
    const curOrderCount = curValidOrders.length;
    const prevOrderCount = prevValidOrders.length;

    const orderGrowthPct = prevOrderCount > 0
      ? Math.round(((curOrderCount - prevOrderCount) / prevOrderCount) * 100 * 10) / 10
      : (curOrderCount > 0 ? 100 : 0);

    // Average Order Value (AOV)
    const curAov = curOrderCount > 0 ? Math.round((curSales / curOrderCount) * 100) / 100 : 0;
    const prevAov = prevOrderCount > 0 ? Math.round((prevSales / prevOrderCount) * 100) / 100 : 0;
    const aovGrowthPct = prevAov > 0
      ? Math.round(((curAov - prevAov) / prevAov) * 100 * 10) / 10
      : (curAov > 0 ? 100 : 0);

    // 2. Customer Registration & Retention Metrics
    const curNewUsersRes = await db.query(
      `SELECT COUNT(*) as c FROM users WHERE role = 'CUSTOMER' AND created_at >= $1 AND created_at <= $2;`,
      [curStartIso, curEndIso]
    );
    const curNewCustomers = Number(curNewUsersRes.rows[0]?.c || 0);

    const prevNewUsersRes = await db.query(
      `SELECT COUNT(*) as c FROM users WHERE role = 'CUSTOMER' AND created_at >= $1 AND created_at <= $2;`,
      [prevStartIso, prevEndIso]
    );
    const prevNewCustomers = Number(prevNewUsersRes.rows[0]?.c || 0);

    const customerGrowthPct = prevNewCustomers > 0
      ? Math.round(((curNewCustomers - prevNewCustomers) / prevNewCustomers) * 100 * 10) / 10
      : (curNewCustomers > 0 ? 100 : 0);

    // Customer Retention Analysis
    const orderingCustIds = Array.from(new Set(curValidOrders.map(o => o.customer_id).filter(Boolean)));
    let repeatCustomersCount = 0;

    if (orderingCustIds.length > 0) {
      const priorOrdersRes = await db.query(
        `SELECT DISTINCT customer_id FROM orders WHERE customer_id = ANY($1) AND created_at < $2;`,
        [orderingCustIds, curStartIso]
      );
      repeatCustomersCount = (priorOrdersRes.rows || []).length;
    }

    const repeatOrderRatePct = orderingCustIds.length > 0
      ? Math.round((repeatCustomersCount / orderingCustIds.length) * 100)
      : 0;

    // 3. Refund Metrics
    const curRefundsRes = await db.query(
      `SELECT COALESCE(SUM(refund_amount), 0) as total, COUNT(*) as count FROM refunds WHERE status = 'REFUND_COMPLETED' AND created_at >= $1 AND created_at <= $2;`,
      [curStartIso, curEndIso]
    );
    const curRefundTotal = Number(curRefundsRes.rows[0]?.total || 0);
    const curRefundCount = Number(curRefundsRes.rows[0]?.count || 0);

    const pendingRefundsRes = await db.query(
      `SELECT COUNT(*) as c FROM refunds WHERE status IN ('REFUND_REQUESTED', 'REFUND_PROCESSING');`
    );
    const pendingRefundsCount = Number(pendingRefundsRes.rows[0]?.c || 0);

    const failedRefundsRes = await db.query(
      `SELECT COUNT(*) as c FROM refunds WHERE status = 'REFUND_FAILED';`
    );
    const failedRefundsCount = Number(failedRefundsRes.rows[0]?.c || 0);

    // 4. Payment Overview Metrics
    const successfulPayCount = curValidOrders.length;
    const pendingPayCount = curValidOrders.filter(o => o.payment_status === 'Pending').length;
    const failedPayCount = curOrders.filter(o => (o.payment_status || '').toLowerCase().includes('failed')).length;

    // 5. Best-Selling Food Items Analysis
    const foodMap = {};
    curValidOrders.forEach(o => {
      let itemsList = [];
      try {
        itemsList = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
      } catch (e) {}

      if (Array.isArray(itemsList)) {
        itemsList.forEach(item => {
          const name = item.name || 'Unknown Item';
          const qty = Number(item.quantity || 1);
          const price = Number(item.price || 0);
          if (!foodMap[name]) {
            foodMap[name] = { name, quantity: 0, revenue: 0 };
          }
          foodMap[name].quantity += qty;
          foodMap[name].revenue += (qty * price);
        });
      }
    });

    const bestSellers = Object.values(foodMap).sort((a, b) => b.quantity - a.quantity);

    // 6. Popular Add-ons Analysis
    const addonMap = {};
    curValidOrders.forEach(o => {
      let addonsList = [];
      try {
        addonsList = typeof o.add_ons === 'string' ? JSON.parse(o.add_ons) : (o.add_ons || []);
      } catch (e) {}

      if (Array.isArray(addonsList)) {
        addonsList.forEach(ao => {
          const name = ao.add_on_name || ao.name || 'Extra Add-on';
          const qty = Number(ao.quantity || 1);
          const subtotal = Number(ao.subtotal || (qty * Number(ao.unit_price || 0)));
          if (!addonMap[name]) {
            addonMap[name] = { name, quantity: 0, revenue: 0 };
          }
          addonMap[name].quantity += qty;
          addonMap[name].revenue += subtotal;
        });
      }
    });

    const popularAddons = Object.values(addonMap).sort((a, b) => b.quantity - a.quantity);

    // 7. Hourly Peak Demand Breakdown
    const hourlyCounts = Array(24).fill(0);
    curValidOrders.forEach(o => {
      const dt = new Date(o.created_at);
      const hr = dt.getHours();
      if (hr >= 0 && hr < 24) {
        hourlyCounts[hr]++;
      }
    });

    let peakHourIndex = 8; // Default 8 AM
    let maxHourlyCount = 0;
    hourlyCounts.forEach((cnt, hr) => {
      if (cnt > maxHourlyCount) {
        maxHourlyCount = cnt;
        peakHourIndex = hr;
      }
    });

    const formatHour = (h) => {
      const ampm = h >= 12 ? 'PM' : 'AM';
      const displayH = h % 12 === 0 ? 12 : h % 12;
      const nextH = (h + 1) % 12 === 0 ? 12 : (h + 1) % 12;
      const nextAmpm = (h + 1) >= 12 ? 'PM' : 'AM';
      return `${displayH}:00 ${ampm} – ${nextH}:00 ${nextAmpm}`;
    };

    const peakDemandWindowStr = formatHour(peakHourIndex);

    // 8. Algorithmic Smart Alerts & Explainable Business Recommendations
    const smartAlerts = [];
    const recommendations = [];

    // Alert: High Sales Growth
    if (salesGrowthPct >= 15) {
      smartAlerts.push({
        type: 'SUCCESS',
        icon: '📈',
        message: `Today's sales volume is ${salesGrowthPct}% higher than the previous period!`
      });
    } else if (salesGrowthPct <= -15 && curOrderCount > 0) {
      smartAlerts.push({
        type: 'WARNING',
        icon: '📉',
        message: `Sales volume is currently ${Math.abs(salesGrowthPct)}% lower than the comparison period.`
      });
    }

    // Alert: High Refunds
    if (curRefundTotal > 0 && curSales > 0 && (curRefundTotal / curSales) > 0.05) {
      smartAlerts.push({
        type: 'DANGER',
        icon: '⚠️',
        message: `Refund total (₹${curRefundTotal}) exceeds 5% of gross sales for this period.`
      });
    }

    // Recommendation 1: Prepare More Top Seller
    if (bestSellers.length > 0) {
      const topFood = bestSellers[0];
      const sharePct = curOrderCount > 0 ? Math.round((topFood.quantity / curValidOrders.length) * 100) : 0;
      recommendations.push({
        title: `Prepare More ${topFood.name}`,
        suggested_action: `Consider increasing tomorrow's kitchen preparation quantity for ${topFood.name}.`,
        reason: `${topFood.name} generated ${topFood.quantity} orders (₹${topFood.revenue.toLocaleString('en-IN')}) in this period.`,
        confidence: sharePct > 40 ? 'High' : 'Medium'
      });
    }

    // Recommendation 2: Peak Demand Preparation
    if (maxHourlyCount > 0) {
      recommendations.push({
        title: `Pre-Prepare Items Before ${peakDemandWindowStr.split('–')[0].trim()}`,
        suggested_action: `Kitchen receives peak ordering volume during ${peakDemandWindowStr}. Pre-cook popular items before peak hours.`,
        reason: `${maxHourlyCount} orders were placed during the ${peakDemandWindowStr} window.`,
        confidence: maxHourlyCount >= 5 ? 'High' : 'Medium'
      });
    }

    // Recommendation 3: Add-on Promotion
    if (popularAddons.length > 0) {
      const topAddon = popularAddons[0];
      recommendations.push({
        title: `Promote ${topAddon.name}`,
        suggested_action: `Feature ${topAddon.name} prominently during checkout to increase average order value.`,
        reason: `${topAddon.name} was added to ${topAddon.quantity} orders generating ₹${topAddon.revenue.toLocaleString('en-IN')}.`,
        confidence: 'Medium'
      });
    }

    // 9. Tomorrow's Demand Estimate (Forecast)
    const demandForecast = bestSellers.slice(0, 4).map(item => {
      const avgDaily = Math.ceil(item.quantity / (range === '30days' ? 30 : range === '7days' ? 7 : 1));
      const minEst = Math.max(5, Math.floor(avgDaily * 0.9));
      const maxEst = Math.ceil(avgDaily * 1.25);
      return {
        name: item.name,
        estimated_range: `${minEst}–${maxEst} portions`,
        daily_average: avgDaily
      };
    });

    res.json({
      success: true,
      data: {
        range,
        period_label: range === 'yesterday' ? 'Yesterday' : range === '7days' ? 'Last 7 Days' : range === '30days' ? 'Last 30 Days' : 'Today',
        last_updated: new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
        kpis: {
          sales: { current: curSales, previous: prevSales, growth_pct: salesGrowthPct },
          orders: { current: curOrderCount, previous: prevOrderCount, growth_pct: orderGrowthPct },
          new_customers: { current: curNewCustomers, previous: prevNewCustomers, growth_pct: customerGrowthPct },
          refunds: { current: curRefundTotal, count: curRefundCount, pending: pendingRefundsCount, failed: failedRefundsCount },
          aov: { current: curAov, previous: prevAov, growth_pct: aovGrowthPct },
          peak_demand: { window: peakDemandWindowStr, count: maxHourlyCount }
        },
        best_sellers: bestSellers,
        popular_addons: popularAddons,
        hourly_demand: hourlyCounts.map((cnt, hr) => ({ hour: hr, label: `${hr}:00`, count: cnt })),
        customer_retention: {
          new_customers: curNewCustomers,
          active_customers: orderingCustIds.length,
          repeat_customers: repeatCustomersCount,
          repeat_order_rate_pct: repeatOrderRatePct
        },
        payment_overview: {
          successful: successfulPayCount,
          pending: pendingPayCount,
          failed: failedPayCount
        },
        smart_alerts: smartAlerts,
        recommendations: recommendations,
        demand_forecast: demandForecast
      }
    });
  } catch (err) {
    console.error('Business Copilot Analytics Error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate Business Copilot analytics.' });
  }
});

// =========================================================================
// 🛒 SMART CART OPTIMIZER MODULE
// =========================================================================

// GET /api/smart-cart-offers - Fetch active smart cart offers for customer cart evaluation
app.get('/api/smart-cart-offers', async (req, res) => {
  try {
    const oRes = await db.query(
      `SELECT * FROM smart_cart_offers WHERE status = 'Active' ORDER BY discount_amount DESC, min_quantity ASC;`
    );
    res.json({ success: true, data: oRes.rows || [] });
  } catch (err) {
    console.error('Fetch Smart Cart Offers Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch smart cart offers.' });
  }
});

// GET /api/owner/smart-cart-offers - Fetch all smart cart offers for owner management
app.get('/api/owner/smart-cart-offers', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const oRes = await db.query(`SELECT * FROM smart_cart_offers ORDER BY created_at DESC;`);
    res.json({ success: true, data: oRes.rows || [] });
  } catch (err) {
    console.error('Fetch Owner Smart Cart Offers Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch smart cart offers.' });
  }
});

// POST /api/owner/smart-cart-offers - Owner Create New Smart Cart Offer
app.post('/api/owner/smart-cart-offers', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { offer_name, min_quantity, eligible_item_name, discount_amount, status } = req.body;

    if (!offer_name || !eligible_item_name || !min_quantity || !discount_amount) {
      return res.status(400).json({ success: false, message: 'Please provide Offer Name, Eligible Item, Min Quantity, and Discount Amount.' });
    }

    const minQty = Math.max(1, parseInt(min_quantity, 10));
    const discAmount = Math.max(0.5, parseFloat(discount_amount));
    const offerId = 'sco_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const nowIso = new Date().toISOString();

    await db.query(
      `INSERT INTO smart_cart_offers (id, offer_name, min_quantity, eligible_item_name, discount_amount, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7);`,
      [offerId, offer_name.trim(), minQty, eligible_item_name.trim(), discAmount, status || 'Active', nowIso]
    );

    res.json({ success: true, message: 'Smart Cart Offer created successfully!', data: { id: offerId } });
  } catch (err) {
    console.error('Create Smart Cart Offer Error:', err);
    res.status(500).json({ success: false, message: 'Failed to create smart cart offer.' });
  }
});

// PATCH /api/owner/smart-cart-offers/:id - Owner Update / Toggle Smart Cart Offer
app.patch('/api/owner/smart-cart-offers/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    const { offer_name, min_quantity, eligible_item_name, discount_amount, status } = req.body;

    const oRes = await db.query(`SELECT * FROM smart_cart_offers WHERE id = $1;`, [id]);
    if (!oRes.rows || oRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Smart Cart Offer not found.' });
    }
    const offer = oRes.rows[0];

    const newName = offer_name !== undefined ? offer_name.trim() : offer.offer_name;
    const newMinQty = min_quantity !== undefined ? Math.max(1, parseInt(min_quantity, 10)) : offer.min_quantity;
    const newItemName = eligible_item_name !== undefined ? eligible_item_name.trim() : offer.eligible_item_name;
    const newDiscount = discount_amount !== undefined ? Math.max(0.5, parseFloat(discount_amount)) : offer.discount_amount;
    const newStatus = status !== undefined ? status : offer.status;
    const nowIso = new Date().toISOString();

    await db.query(
      `UPDATE smart_cart_offers SET offer_name = $1, min_quantity = $2, eligible_item_name = $3, discount_amount = $4, status = $5, updated_at = $6 WHERE id = $7;`,
      [newName, newMinQty, newItemName, newDiscount, newStatus, nowIso, id]
    );

    res.json({ success: true, message: 'Smart Cart Offer updated successfully.' });
  } catch (err) {
    console.error('Update Smart Cart Offer Error:', err);
    res.status(500).json({ success: false, message: 'Failed to update smart cart offer.' });
  }
});

// DELETE /api/owner/smart-cart-offers/:id - Owner Delete Smart Cart Offer
app.delete('/api/owner/smart-cart-offers/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.query(`DELETE FROM smart_cart_offers WHERE id = $1;`, [id]);
    res.json({ success: true, message: 'Smart Cart Offer deleted.' });
  } catch (err) {
    console.error('Delete Smart Cart Offer Error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete smart cart offer.' });
  }
});

// POST /api/smart-cart-analytics/track - Track Impression or Recommendation Acceptance
app.post('/api/smart-cart-analytics/track', async (req, res) => {
  try {
    const { event_type, offer_id } = req.body;
    if (!['IMPRESSION', 'ACCEPTED'].includes(event_type)) {
      return res.status(400).json({ success: false, message: 'Invalid event_type.' });
    }

    const eventId = 'sca_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const custId = req.user ? req.user.id : null;
    const nowIso = new Date().toISOString();

    await db.query(
      `INSERT INTO smart_cart_analytics (id, event_type, offer_id, customer_id, created_at)
       VALUES ($1, $2, $3, $4, $5);`,
      [eventId, event_type, offer_id || null, custId, nowIso]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Track Smart Cart Analytics Error:', err);
    res.status(500).json({ success: false, message: 'Failed to track analytics.' });
  }
});

// GET /api/owner/smart-cart-offers/analytics - Owner Read-Only Performance Analytics
app.get('/api/owner/smart-cart-offers/analytics', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const impRes = await db.query(`SELECT COUNT(*) as c FROM smart_cart_analytics WHERE event_type = 'IMPRESSION';`);
    const accRes = await db.query(`SELECT COUNT(*) as c FROM smart_cart_analytics WHERE event_type = 'ACCEPTED';`);

    const impressions = Number(impRes.rows[0]?.c || 0);
    const accepted = Number(accRes.rows[0]?.c || 0);
    const conversionRatePct = impressions > 0 ? Math.round((accepted / impressions) * 100 * 10) / 10 : 0;

    const acceptedOffersRes = await db.query(`
      SELECT o.discount_amount, o.min_quantity
      FROM smart_cart_analytics a
      JOIN smart_cart_offers o ON a.offer_id = o.id
      WHERE a.event_type = 'ACCEPTED';
    `);

    let totalSavings = 0;
    let itemsSold = 0;
    (acceptedOffersRes.rows || []).forEach(row => {
      totalSavings += Number(row.discount_amount || 0);
      itemsSold += Number(row.min_quantity || 1);
    });

    res.json({
      success: true,
      data: {
        impressions,
        accepted,
        conversion_rate_pct: conversionRatePct,
        items_sold: itemsSold,
        total_savings: totalSavings
      }
    });
  } catch (err) {
    console.error('Smart Cart Analytics Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch analytics.' });
  }
});

// =========================================================================
// 🤖 AI ORDER ASSISTANT MODULE
// =========================================================================

// POST /api/customer/ai-order-assistant - Natural Language Recommendation Engine
app.post('/api/customer/ai-order-assistant', async (req, res) => {
  try {
    let rawPrompt = (req.body.prompt || '').toString().trim();
    if (!rawPrompt) {
      return res.status(400).json({ success: false, message: 'Please type your request (e.g. Breakfast for 3 people under ₹200).' });
    }

    // Security & Prompt Injection Guardrails
    rawPrompt = rawPrompt.substring(0, 300); // Limit length
    const injectionPatterns = [/ignore previous/i, /system prompt/i, /drop table/i, /database/i, /admin/i, /secret/i];
    for (let p of injectionPatterns) {
      if (p.test(rawPrompt)) {
        return res.json({
          success: true,
          message: "🤖 I am focused strictly on recommending food from our delicious tiffin menu. How can I help you order today?",
          options: []
        });
      }
    }

    // 1. Extract Budget
    let budget = null;
    const budgetMatch = rawPrompt.match(/(?:under|within|for|budget|\u20b9|rs\.?|in)?\s*(\d{2,4})/i);
    if (budgetMatch) {
      const parsedB = parseInt(budgetMatch[1], 10);
      if (parsedB >= 30 && parsedB <= 2000) budget = parsedB;
    }

    // 2. Extract People Count
    let people = 2; // default 2 people
    const peopleMatch = rawPrompt.match(/(\d+)\s*(?:people|persons|pax|members|friends)/i);
    if (peopleMatch) {
      people = Math.min(15, Math.max(1, parseInt(peopleMatch[1], 10)));
    }

    // 3. Retrieve Live Available Menu & Add-ons from DB
    const tiffinsRes = await db.query(`SELECT * FROM tiffins WHERE is_available = true ORDER BY price ASC;`);
    const addonsRes = await db.query(`SELECT * FROM add_ons WHERE available = true AND enabled = true ORDER BY price ASC;`);

    const availableTiffins = tiffinsRes.rows || [];
    const availableAddons = addonsRes.rows || [];

    if (availableTiffins.length === 0) {
      return res.json({
        success: false,
        message: "🏪 The restaurant menu is currently undergoing updates. Please try again shortly."
      });
    }

    // Check if requested budget is too low for the requested headcount
    const minPrice = availableTiffins[0]?.price || 30;
    const minRequiredBudget = minPrice * Math.ceil(people * 0.75);

    if (budget !== null && budget < minRequiredBudget) {
      return res.json({
        success: true,
        message: `🤖 I couldn't find a suitable combination for ${people} people under ₹${budget}.`,
        suggested_budget: Math.ceil(minRequiredBudget / 10) * 10,
        options: []
      });
    }

    // 4. Deterministic Combination Generator
    const options = [];
    const effectiveBudget = budget || 500;

    // Option 1: Idly + Vada Combo
    const idly = availableTiffins.find(t => t.name.toLowerCase().includes('idly')) || availableTiffins[0];
    const vada = availableTiffins.find(t => t.name.toLowerCase().includes('vada')) || availableTiffins[1] || availableTiffins[0];

    if (idly && vada) {
      const idlyQty = Math.max(2, people * 2);
      const vadaQty = Math.max(1, people);
      const subtotal = (idly.price * idlyQty) + (vada.price * vadaQty);

      if (subtotal <= effectiveBudget) {
        options.push({
          id: 'ai_opt_1',
          title: '🥇 Best Value Combination',
          total: subtotal,
          items: [
            { id: idly.id, name: idly.name, quantity: idlyQty, price: Number(idly.price), image: idly.image_url },
            { id: vada.id, name: vada.name, quantity: vadaQty, price: Number(vada.price), image: vada.image_url }
          ],
          explanation: `Generous breakfast for ${people} people (${idlyQty} ${idly.name} & ${vadaQty} ${vada.name}).`
        });
      }
    }

    // Option 2: Dosa & Tiffin Variety
    const dosa = availableTiffins.find(t => t.name.toLowerCase().includes('dosa')) || availableTiffins[availableTiffins.length - 1];
    if (dosa && idly) {
      const dosaQty = Math.max(1, Math.floor(people * 0.8));
      const idlyQty2 = Math.max(2, Math.floor(people * 1.2));
      const subtotal = (dosa.price * dosaQty) + (idly.price * idlyQty2);

      if (subtotal <= effectiveBudget) {
        options.push({
          id: 'ai_opt_2',
          title: '🥈 Balanced Variety Combo',
          total: subtotal,
          items: [
            { id: dosa.id, name: dosa.name, quantity: dosaQty, price: Number(dosa.price), image: dosa.image_url },
            { id: idly.id, name: idly.name, quantity: idlyQty2, price: Number(idly.price), image: idly.image_url }
          ],
          explanation: `Delicious mix of crispy ${dosa.name} (${dosaQty}) and soft ${idly.name} (${idlyQty2}).`
        });
      }
    }

    // Option 3: Budget Meal
    const cheapestItem = availableTiffins[0];
    if (cheapestItem) {
      const cheapQty = Math.max(2, Math.ceil(people * 1.5));
      let subtotal = cheapestItem.price * cheapQty;
      const opt3Items = [{ id: cheapestItem.id, name: cheapestItem.name, quantity: cheapQty, price: Number(cheapestItem.price), image: cheapestItem.image_url }];

      if (availableAddons.length > 0 && subtotal + availableAddons[0].price <= effectiveBudget) {
        const extra = availableAddons[0];
        opt3Items.push({ id: extra.id, name: extra.name, quantity: 1, price: Number(extra.price), image: '/images/idly_sambar.png' });
        subtotal += Number(extra.price);
      }

      if (subtotal <= effectiveBudget) {
        options.push({
          id: 'ai_opt_3',
          title: '🥉 Budget Saver Meal',
          total: subtotal,
          items: opt3Items,
          explanation: `Economical meal for ${people} people under ₹${effectiveBudget}.`
        });
      }
    }

    // Log Query into Analytics
    const eventId = 'aia_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const custId = req.user ? req.user.id : null;
    const nowIso = new Date().toISOString();
    await db.query(
      `INSERT INTO ai_assistant_analytics (id, query_text, budget, people_count, customer_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [eventId, rawPrompt, budget, people, custId, nowIso]
    ).catch(() => {});

    res.json({
      success: true,
      message: `🤖 I found ${options.length} great meal option${options.length !== 1 ? 's' : ''} for ${people} people${budget ? ` under ₹${budget}` : ''}:`,
      options
    });
  } catch (err) {
    console.error('AI Order Assistant Error:', err);
    res.status(500).json({ success: false, message: 'AI Order Assistant is currently unavailable. You can continue ordering from our menu.' });
  }
});

// GET /api/owner/ai-assistant/analytics - Owner Read-Only Analytics
app.get('/api/owner/ai-assistant/analytics', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const totalQueriesRes = await db.query(`SELECT COUNT(*) as c FROM ai_assistant_analytics;`);
    const acceptedRes = await db.query(`SELECT COUNT(*) as c FROM ai_assistant_analytics WHERE selected_option_id IS NOT NULL;`);
    const avgBudgetRes = await db.query(`SELECT AVG(budget) as b FROM ai_assistant_analytics WHERE budget IS NOT NULL;`);

    const totalQueries = Number(totalQueriesRes.rows[0]?.c || 0);
    const acceptedCount = Number(acceptedRes.rows[0]?.c || 0);
    const conversionRatePct = totalQueries > 0 ? Math.round((acceptedCount / totalQueries) * 100 * 10) / 10 : 0;
    const avgBudget = Math.round(Number(avgBudgetRes.rows[0]?.b || 180));

    res.json({
      success: true,
      data: {
        total_queries: totalQueries,
        accepted_count: acceptedCount,
        conversion_rate_pct: conversionRatePct,
        avg_requested_budget: avgBudget
      }
    });
  } catch (err) {
    console.error('AI Assistant Analytics Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch AI assistant analytics.' });
  }
});

// =========================================================================
// 🥘 ADD-ONS MANAGEMENT ENDPOINTS
// =========================================================================

// GET /api/add-ons - List Add-ons (Public / Owner)
app.get('/api/add-ons', async (req, res) => {
  try {
    const includeDisabled = req.query.include_disabled === 'true';
    const addons = await db.getAllAddons(includeDisabled);
    res.json({ success: true, data: addons });
  } catch (err) {
    console.error('GET /api/add-ons error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch add-ons.' });
  }
});

// GET /api/add-ons/analytics - Add-on Analytics (Owner)
app.get('/api/add-ons/analytics', async (req, res) => {
  try {
    const analytics = await db.getAddonAnalytics();
    res.json({ success: true, data: analytics });
  } catch (err) {
    console.error('GET /api/add-ons/analytics error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch add-on analytics.' });
  }
});

// POST /api/add-ons - Create New Add-on
app.post('/api/add-ons', async (req, res) => {
  try {
    const { name, price, description, available } = req.body;
    if (!name || price === undefined || price === null || price === '') {
      return res.status(400).json({ success: false, message: 'Name and price are required.' });
    }
    const addon = await db.createAddon({ name, price: Number(price), description, available });
    res.status(201).json({ success: true, message: 'Add-on created successfully!', data: addon });
  } catch (err) {
    console.error('POST /api/add-ons error:', err);
    res.status(500).json({ success: false, message: 'Failed to create add-on.' });
  }
});

// PATCH /api/add-ons/:id - Update Add-on
app.patch('/api/add-ons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await db.updateAddon(id, req.body);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Add-on item not found.' });
    }
    res.json({ success: true, message: 'Add-on updated successfully!', data: updated });
  } catch (err) {
    console.error('PATCH /api/add-ons/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to update add-on.' });
  }
});

// DELETE /api/add-ons/:id - Delete Add-on
app.delete('/api/add-ons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await db.deleteAddon(id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Add-on item not found or already deleted.' });
    }
    res.json({ success: true, message: 'Add-on item deleted successfully!' });
  } catch (err) {
    console.error('DELETE /api/add-ons/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete add-on item.' });
  }
});

// =========================================================================
// 💳 PREMIUM FOOD MEMBER CARD ENDPOINTS
// =========================================================================

// Customer - Get Member Card State
app.get('/api/food-member/status', authenticateToken, async (req, res) => {
  try {
    const state = await db.getFoodMemberStateForCustomer(req.user.id);
    res.json({ success: true, ...state });
  } catch (err) {
    console.error('GET /api/food-member/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch food member status.' });
  }
});

// Customer - Apply for ₹10 Premium Member Card
app.post('/api/food-member/apply', authenticateToken, async (req, res) => {
  try {
    const customer = req.user;
    const { payment_method = 'Cash Payment' } = req.body;
    const appRecord = await db.createFoodMemberApplication({
      customer_id: customer.id,
      customer_name: customer.name,
      customer_mobile: customer.mobile,
      fee_amount: 10.00,
      payment_method
    });
    res.json({ success: true, message: 'Application submitted successfully!', data: appRecord });
  } catch (err) {
    console.error('POST /api/food-member/apply error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit application.' });
  }
});

// Owner - List Member Applications
app.get('/api/food-member/owner/applications', authenticateToken, async (req, res) => {
  try {
    const statusFilter = req.query.status || 'ALL';
    const result = await db.getOwnerFoodMemberApplications(statusFilter);
    res.json({ success: true, data: result.apps, counts: result.counts });
  } catch (err) {
    console.error('GET /api/food-member/owner/applications error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch applications.' });
  }
});

// Owner - Delete Single Application Record
app.delete('/api/food-member/owner/application/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.deleteFoodMemberApplication(id);
    res.json({ success: true, message: 'Premium Food Member Card deleted successfully.' });
  } catch (err) {
    console.error('DELETE /api/food-member/owner/application/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete record.' });
  }
});

// Owner - Delete All Member Application Records
app.delete('/api/food-member/owner/applications/all', authenticateToken, async (req, res) => {
  try {
    await db.deleteAllFoodMemberApplications();
    res.json({ success: true, message: 'All Premium Food Card records deleted successfully.' });
  } catch (err) {
    console.error('DELETE /api/food-member/owner/applications/all error:', err);
    res.status(500).json({ success: false, message: 'Failed to clear records.' });
  }
});

// Owner - Verify Payment (both url styles)
app.post(['/api/food-member/owner/verify-payment/:id', '/api/food-member/owner/application/:id/verify-payment'], authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await db.verifyFoodMemberPayment(id);
    res.json({ success: true, message: 'Payment verified successfully.', data: updated });
  } catch (err) {
    console.error('POST verify-payment error:', err);
    res.status(500).json({ success: false, message: 'Failed to verify payment.' });
  }
});

// Owner - Reject Payment
app.post(['/api/food-member/owner/reject-payment/:id', '/api/food-member/owner/application/:id/reject-payment'], authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rejection_reason, reason } = req.body;
    const updated = await db.rejectFoodMemberPayment(id, rejection_reason || reason || '');
    res.json({ success: true, message: 'Payment rejected.', data: updated });
  } catch (err) {
    console.error('POST reject-payment error:', err);
    res.status(500).json({ success: false, message: 'Failed to reject payment.' });
  }
});

// Owner - Approve Card
app.post(['/api/food-member/owner/approve/:id', '/api/food-member/owner/application/:id/approve'], authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const state = await db.approveFoodMemberCard(id);
    res.json({ success: true, message: 'Member Card approved successfully!', data: state });
  } catch (err) {
    console.error('POST approve error:', err);
    res.status(500).json({ success: false, message: 'Failed to approve card.' });
  }
});

// Owner - Reject Card
app.post(['/api/food-member/owner/reject/:id', '/api/food-member/owner/application/:id/reject'], authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rejection_reason, reason } = req.body;
    await db.rejectFoodMemberCard(id, rejection_reason || reason || '');
    res.json({ success: true, message: 'Member Card rejected.' });
  } catch (err) {
    console.error('POST reject error:', err);
    res.status(500).json({ success: false, message: 'Failed to reject card.' });
  }
});

// Owner - Verify Food Member QR Code / Member ID (Strict Date-Based Verification)
app.post('/api/food-member/owner/verify-qr', authenticateToken, async (req, res) => {
  try {
    const { qr_code, member_id, qr_data } = req.body;
    const input = qr_code || member_id || qr_data || '';
    const result = await db.verifyFoodMemberQr(input);
    res.json(result);
  } catch (err) {
    console.error('POST /api/food-member/owner/verify-qr error:', err);
    res.status(500).json({
      success: false,
      is_valid: false,
      status_code: 'INVALID',
      title: '⚠️ SERVER ERROR',
      message: 'Failed to verify member card.'
    });
  }
});

// Owner - Suspend Card
app.post(['/api/food-member/owner/suspend/:id', '/api/food-member/owner/application/:id/suspend'], authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.suspendFoodMemberCard(id);
    res.json({ success: true, message: 'Member Card suspended.' });
  } catch (err) {
    console.error('POST suspend error:', err);
    res.status(500).json({ success: false, message: 'Failed to suspend card.' });
  }
});

// Owner - Reactivate / Unsuspend Card
app.post(['/api/food-member/owner/unsuspend/:id', '/api/food-member/owner/reactivate/:id', '/api/food-member/owner/application/:id/reactivate'], authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await db.reactivateFoodMemberCard(id);
    res.json({ success: true, message: 'Member Card reactivated.' });
  } catch (err) {
    console.error('POST reactivate error:', err);
    res.status(500).json({ success: false, message: 'Failed to reactivate card.' });
  }
});

// Owner - Re-approve Card
app.post(['/api/food-member/owner/reapprove/:id', '/api/food-member/owner/application/:id/reapprove'], authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const state = await db.approveFoodMemberCard(id);
    res.json({ success: true, message: 'Member Card re-approved successfully!', data: state });
  } catch (err) {
    console.error('POST reapprove error:', err);
    res.status(500).json({ success: false, message: 'Failed to re-approve card.' });
  }
});

/* ============================================================
   🧺 SUBSCRIPTION MEAL PLANS + 🎫 DIGITAL MEAL PASS MODULE
   ============================================================ */

// Helper middleware for owner check
function requireOwnerOrKitchen(req, res, next) {
  if (!req.user || (req.user.role !== 'OWNER' && req.user.role !== 'KITCHEN')) {
    return res.status(403).json({ success: false, message: "Access denied. Owner or Kitchen privileges required." });
  }
  next();
}

function requireOwnerOnly(req, res, next) {
  if (!req.user || req.user.role !== 'OWNER') {
    return res.status(403).json({ success: false, message: "Access denied. Owner privileges required." });
  }
  next();
}

// ------------------------------------------------------------
// PART A & B: OWNER SUBSCRIPTION PLAN MANAGEMENT
// ------------------------------------------------------------

// GET /api/owner/subscription-plans - List all plans for Owner
app.get('/api/owner/subscription-plans', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const plansRes = await db.query('SELECT * FROM subscription_plans ORDER BY duration_days ASC, created_at DESC;');
    res.json({ success: true, plans: plansRes.rows || [] });
  } catch (err) {
    console.error('Error fetching owner subscription plans:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch subscription plans.' });
  }
});

// POST /api/owner/subscription-plans - Create new Subscription Plan
app.post('/api/owner/subscription-plans', authenticateToken, requireOwnerOnly, async (req, res) => {
  try {
    const { name, meal_type = 'Breakfast', duration_days, included_meals, price, description = '', is_active = true } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Plan name is required.' });
    }
    const parsedDuration = parseInt(duration_days, 10);
    if (isNaN(parsedDuration) || parsedDuration <= 0) {
      return res.status(400).json({ success: false, message: 'Duration must be a positive whole number of days.' });
    }
    const parsedMeals = parseInt(included_meals, 10);
    if (isNaN(parsedMeals) || parsedMeals <= 0) {
      return res.status(400).json({ success: false, message: 'Included meals must be a positive whole number.' });
    }
    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ success: false, message: 'Price must be a valid non-negative amount.' });
    }

    const planId = 'plan_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const nowIso = new Date().toISOString();

    await db.query(
      `INSERT INTO subscription_plans (id, name, meal_type, duration_days, included_meals, price, description, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [planId, name.trim(), meal_type.trim(), parsedDuration, parsedMeals, parsedPrice, (description || '').trim(), is_active !== false, nowIso, nowIso]
    );

    const createdRes = await db.query('SELECT * FROM subscription_plans WHERE id = $1;', [planId]);
    res.json({ success: true, message: 'Subscription plan created successfully.', plan: createdRes.rows[0] });
  } catch (err) {
    console.error('Error creating subscription plan:', err);
    res.status(500).json({ success: false, message: 'Failed to create subscription plan.' });
  }
});

// PUT /api/owner/subscription-plans/:id - Update Subscription Plan
app.put('/api/owner/subscription-plans/:id', authenticateToken, requireOwnerOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, meal_type, duration_days, included_meals, price, description, is_active } = req.body;

    const existingRes = await db.query('SELECT * FROM subscription_plans WHERE id = $1;', [id]);
    if (!existingRes.rows || existingRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Subscription plan not found.' });
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Plan name is required.' });
    }
    const parsedDuration = parseInt(duration_days, 10);
    if (isNaN(parsedDuration) || parsedDuration <= 0) {
      return res.status(400).json({ success: false, message: 'Duration must be a positive whole number of days.' });
    }
    const parsedMeals = parseInt(included_meals, 10);
    if (isNaN(parsedMeals) || parsedMeals <= 0) {
      return res.status(400).json({ success: false, message: 'Included meals must be a positive whole number.' });
    }
    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ success: false, message: 'Price must be a valid non-negative amount.' });
    }

    const nowIso = new Date().toISOString();

    await db.query(
      `UPDATE subscription_plans
       SET name = $1, meal_type = $2, duration_days = $3, included_meals = $4, price = $5, description = $6, is_active = $7, updated_at = $8
       WHERE id = $9;`,
      [name.trim(), (meal_type || 'Breakfast').trim(), parsedDuration, parsedMeals, parsedPrice, (description || '').trim(), is_active !== false, nowIso, id]
    );

    const updatedRes = await db.query('SELECT * FROM subscription_plans WHERE id = $1;', [id]);
    res.json({ success: true, message: 'Subscription plan updated successfully.', plan: updatedRes.rows[0] });
  } catch (err) {
    console.error('Error updating subscription plan:', err);
    res.status(500).json({ success: false, message: 'Failed to update subscription plan.' });
  }
});

// PATCH /api/owner/subscription-plans/:id/status - Activate / Deactivate Plan
app.patch('/api/owner/subscription-plans/:id/status', authenticateToken, requireOwnerOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    const existingRes = await db.query('SELECT * FROM subscription_plans WHERE id = $1;', [id]);
    if (!existingRes.rows || existingRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Subscription plan not found.' });
    }

    const nowIso = new Date().toISOString();
    await db.query('UPDATE subscription_plans SET is_active = $1, updated_at = $2 WHERE id = $3;', [!!is_active, nowIso, id]);

    res.json({ success: true, message: `Subscription plan ${is_active ? 'activated' : 'deactivated'} successfully.` });
  } catch (err) {
    console.error('Error toggling plan status:', err);
    res.status(500).json({ success: false, message: 'Failed to update plan status.' });
  }
});

// ------------------------------------------------------------
// PART C, D, E, F, G, H, I, J: CUSTOMER MEAL PLANS & PURCHASE
// ------------------------------------------------------------

// GET /api/subscription-plans - Customer view active plans
app.get('/api/subscription-plans', async (req, res) => {
  try {
    const plansRes = await db.query('SELECT * FROM subscription_plans WHERE is_active = true ORDER BY duration_days ASC, price ASC;');
    res.json({ success: true, plans: plansRes.rows || [] });
  } catch (err) {
    console.error('Error fetching customer meal plans:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch meal plans.' });
  }
});

// POST /api/subscriptions/purchase - Initiate Subscription Purchase (Online or Cash)
app.post('/api/subscriptions/purchase', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.id;
    const {
      plan_id,
      payment_method = 'ONLINE',
      utr_number = '',
      payment_screenshot = null,
      auto_confirm = false
    } = req.body;

    const normalizedPaymentMethod = (payment_method || 'ONLINE').toUpperCase() === 'CASH' ? 'CASH' : 'ONLINE';

    if (!plan_id) {
      return res.status(400).json({ success: false, message: 'Plan ID is required.' });
    }

    // Server-side authoritative lookup
    const planRes = await db.query('SELECT * FROM subscription_plans WHERE id = $1;', [plan_id]);
    if (!planRes.rows || planRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Selected subscription plan does not exist.' });
    }
    const plan = planRes.rows[0];
    if (!plan.is_active) {
      return res.status(400).json({ success: false, message: 'This plan is currently inactive and unavailable for new purchases.' });
    }

    // Save screenshot if provided as base64
    let savedScreenshotUrl = null;
    if (payment_screenshot && typeof payment_screenshot === 'string' && payment_screenshot.startsWith('data:image/')) {
      try {
        savedScreenshotUrl = await saveBase64Image(payment_screenshot, 'screenshots');
      } catch (imgErr) {
        console.error('Subscription proof save notice:', imgErr.message);
      }
    } else if (payment_screenshot && typeof payment_screenshot === 'string') {
      savedScreenshotUrl = payment_screenshot;
    }

    const cleanUtr = (utr_number || '').trim();

    // Idempotency check: check if user has an existing PENDING_PAYMENT for this exact plan in the last 5 minutes
    const pendingRes = await db.query(
      `SELECT * FROM subscriptions WHERE customer_id = $1 AND plan_id = $2 AND status = 'PENDING_PAYMENT' ORDER BY created_at DESC LIMIT 1;`,
      [customerId, plan.id]
    );

    let sub;
    if (pendingRes.rows && pendingRes.rows.length > 0) {
      sub = pendingRes.rows[0];
      if (cleanUtr || savedScreenshotUrl) {
        await db.query(
          `UPDATE subscriptions SET utr_number = $1, payment_screenshot = $2, updated_at = $3 WHERE id = $4;`,
          [cleanUtr, savedScreenshotUrl, new Date().toISOString(), sub.id]
        );
        const updatedSubRes = await db.query('SELECT * FROM subscriptions WHERE id = $1;', [sub.id]);
        sub = updatedSubRes.rows[0];
      }
    } else {
      const seqNum = await db.getNextCounter('subscription_seq');
      const subFormattedId = 'SUB-' + String(seqNum).padStart(6, '0');
      const dbId = 'sub_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
      const payRef = cleanUtr || ('PAY_SUB_' + seqNum + '_' + Date.now());
      const nowIso = new Date().toISOString();

      await db.query(
        `INSERT INTO subscriptions (
          id, subscription_id, customer_id, customer_name, customer_mobile, plan_id, plan_name,
          meal_type, duration_days, total_meals, used_meals, purchase_price, payment_reference,
          payment_method, utr_number, payment_screenshot, payment_status, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13, $14, $15, 'PENDING', 'PENDING_PAYMENT', $16, $17);`,
        [
          dbId, subFormattedId, customerId, req.user.name, req.user.mobile, plan.id, plan.name,
          plan.meal_type, plan.duration_days, plan.included_meals, plan.price, payRef,
          normalizedPaymentMethod, cleanUtr, savedScreenshotUrl, nowIso, nowIso
        ]
      );

      // Record in main payments table for owner awareness
      const payId = 'pay_sub_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
      await db.query(
        `INSERT INTO payments (id, order_number, order_id, customer_id, customer_name, customer_mobile, amount, payment_method, payment_status, utr_number, screenshot_url, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending Verification', $9, $10, $11);`,
        [
          payId, subFormattedId, dbId, customerId, req.user.name, req.user.mobile,
          plan.price, normalizedPaymentMethod, cleanUtr || payRef, savedScreenshotUrl,
          `Subscription Purchase: ${plan.name} (${plan.duration_days} Days)`
        ]
      );

      const newSubRes = await db.query('SELECT * FROM subscriptions WHERE id = $1;', [dbId]);
      sub = newSubRes.rows[0];
    }

    if (normalizedPaymentMethod === 'CASH' || (!auto_confirm && req.body.require_verification !== false)) {
      // Dispatch Real-time Notification to Owner
      try {
        await createAndDispatchNotification({
          target_role: 'OWNER',
          title: `🧺 New Subscription Payment Verification (${normalizedPaymentMethod})`,
          message: `🧺 New subscription payment proof uploaded by ${req.user.name} requires verification.`,
          type: 'SUBSCRIPTION'
        });
      } catch (nErr) {
        console.error('Notification dispatch error:', nErr.message);
      }

      return res.json({
        success: true,
        subscription: sub,
        payment_method: normalizedPaymentMethod,
        status: 'PENDING_PAYMENT',
        message: normalizedPaymentMethod === 'CASH'
          ? 'Cash payment selected. Your subscription will be activated after the owner confirms your payment.'
          : 'Online payment proof submitted. Your subscription will be activated after owner verifies your payment.'
      });
    }

    // Online Instant Activation Handling (for confirmed payment)
    const result = await db.executeTransaction(async (tx) => {
      const now = new Date();
      const startDateIso = now.toISOString();
      const expiryDate = new Date(now.getTime() + (plan.duration_days * 24 * 60 * 60 * 1000));
      const expiryDateIso = expiryDate.toISOString();

      await tx.query(
        `UPDATE subscriptions
         SET status = 'ACTIVE', payment_status = 'VERIFIED', start_date = $1, expiry_date = $2, updated_at = $3
         WHERE id = $4;`,
        [startDateIso, expiryDateIso, startDateIso, sub.id]
      );

      await tx.query(
        `UPDATE payments SET payment_status = 'Paid' WHERE order_id = $1 OR order_number = $2;`,
        [sub.id, sub.subscription_id]
      );

      // Generate Meal Passes
      const passes = [];
      for (let i = 1; i <= plan.included_meals; i++) {
        const passSeqNum = await db.getNextCounter('mealpass_seq');
        const passFormattedId = 'MP-' + String(passSeqNum).padStart(6, '0');
        const passDbId = 'pass_' + Date.now() + '_' + i + '_' + crypto.randomBytes(4).toString('hex');
        const secureToken = 'MP_TOK_' + crypto.randomBytes(24).toString('hex');

        await tx.query(
          `INSERT INTO subscription_meal_passes (id, pass_id, subscription_id, customer_id, meal_number, secure_token, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'AVAILABLE', $7);`,
          [passDbId, passFormattedId, sub.id, customerId, i, secureToken, startDateIso]
        );
        passes.push({ pass_id: passFormattedId, meal_number: i, secure_token: secureToken, status: 'AVAILABLE' });
      }

      const activeSubRes = await tx.query('SELECT * FROM subscriptions WHERE id = $1;', [sub.id]);
      return { subscription: activeSubRes.rows[0], passes_count: passes.length };
    });

    // Dispatch Notification to Customer
    try {
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: customerId,
        title: '🎉 Subscription Activated!',
        message: '🎉 Subscription activated successfully!',
        type: 'SUBSCRIPTION'
      });
    } catch (nErr) {
      console.error('Notification dispatch error:', nErr.message);
    }

    return res.json({
      success: true,
      subscription: result.subscription,
      payment_method: 'ONLINE',
      status: 'ACTIVE',
      passes_count: result.passes_count,
      message: '🎉 Subscription activated successfully!'
    });
  } catch (err) {
    console.error('Error initiating subscription purchase:', err);
    res.status(500).json({ success: false, message: 'Failed to process subscription purchase request.' });
  }
});

// Helper route handler for Owner confirming subscription payment (Online or Cash)
const handleOwnerConfirmSubscriptionPayment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Subscription ID is required.' });
    }

    const result = await db.executeTransaction(async (tx) => {
      const subRes = await tx.query(
        'SELECT * FROM subscriptions WHERE id = $1 OR subscription_id = $1;',
        [id]
      );
      if (!subRes.rows || subRes.rows.length === 0) {
        throw new Error('Subscription record not found.');
      }
      const sub = subRes.rows[0];

      // Idempotency check: If already active, return cleanly
      if (sub.status === 'ACTIVE') {
        return { already_active: true, subscription: sub };
      }

      if (sub.status !== 'PENDING_PAYMENT' && sub.status !== 'FAILED' && sub.status !== 'REJECTED' && sub.status !== 'CANCELLED') {
        throw new Error(`Cannot confirm payment for subscription in status '${sub.status}'.`);
      }

      const now = new Date();
      const startDateIso = now.toISOString();
      const expiryDate = new Date(now.getTime() + (sub.duration_days * 24 * 60 * 60 * 1000));
      const expiryDateIso = expiryDate.toISOString();

      await tx.query(
        `UPDATE subscriptions
         SET status = 'ACTIVE', payment_status = 'VERIFIED', start_date = $1, expiry_date = $2, updated_at = $3
         WHERE id = $4;`,
        [startDateIso, expiryDateIso, startDateIso, sub.id]
      );

      await tx.query(
        `UPDATE payments SET payment_status = 'Paid' WHERE order_id = $1 OR order_number = $2;`,
        [sub.id, sub.subscription_id]
      );

      // Generate meal passes if not generated already
      const passesRes = await tx.query('SELECT COUNT(*) as cnt FROM subscription_meal_passes WHERE subscription_id = $1;', [sub.id]);
      const passesCount = parseInt(passesRes.rows[0]?.cnt || '0', 10);

      if (passesCount === 0) {
        for (let i = 1; i <= sub.total_meals; i++) {
          const passSeqNum = await db.getNextCounter('mealpass_seq');
          const passFormattedId = 'MP-' + String(passSeqNum).padStart(6, '0');
          const passDbId = 'pass_' + Date.now() + '_' + i + '_' + crypto.randomBytes(4).toString('hex');
          const secureToken = 'MP_TOK_' + crypto.randomBytes(24).toString('hex');

          await tx.query(
            `INSERT INTO subscription_meal_passes (id, pass_id, subscription_id, customer_id, meal_number, secure_token, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'AVAILABLE', $7);`,
            [passDbId, passFormattedId, sub.id, sub.customer_id, i, secureToken, startDateIso]
          );
        }
      }

      const activeSubRes = await tx.query('SELECT * FROM subscriptions WHERE id = $1;', [sub.id]);
      return { already_active: false, subscription: activeSubRes.rows[0] };
    });

    // Real-time Notification to Customer
    try {
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: result.subscription.customer_id,
        title: '🎉 Subscription Activated!',
        message: '🎉 Subscription activated successfully!',
        type: 'SUBSCRIPTION'
      });
    } catch (nErr) {
      console.error('Notification error:', nErr.message);
    }

    res.json({
      success: true,
      message: result.already_active ? 'Subscription is active.' : '🎉 Subscription activated successfully!',
      subscription: result.subscription
    });
  } catch (err) {
    console.error('Error confirming subscription payment:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to confirm payment.' });
  }
};

app.post('/api/owner/subscriptions/:id/confirm-cash', authenticateToken, requireOwnerOrKitchen, handleOwnerConfirmSubscriptionPayment);
app.post('/api/owner/subscriptions/:id/confirm-payment', authenticateToken, requireOwnerOrKitchen, handleOwnerConfirmSubscriptionPayment);

// Helper route handler for Owner rejecting subscription payment (Online or Cash)
const handleOwnerRejectSubscriptionPayment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Subscription ID is required.' });
    }

    const subRes = await db.query('SELECT * FROM subscriptions WHERE id = $1 OR subscription_id = $1;', [id]);
    if (!subRes.rows || subRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Subscription record not found.' });
    }
    const sub = subRes.rows[0];

    await db.query(`UPDATE subscriptions SET status = 'FAILED', payment_status = 'FAILED', updated_at = $1 WHERE id = $2;`, [new Date().toISOString(), sub.id]);
    await db.query(`UPDATE payments SET payment_status = 'Failed' WHERE order_id = $1 OR order_number = $2;`, [sub.id, sub.subscription_id]);

    // Real-time Notification to Customer
    try {
      await createAndDispatchNotification({
        target_role: 'CUSTOMER',
        customer_id: sub.customer_id,
        title: '❌ Subscription Payment Failed',
        message: '❌ Subscription payment failed.',
        type: 'SUBSCRIPTION'
      });
    } catch (nErr) {
      console.error('Notification error:', nErr.message);
    }

    const updatedSubRes = await db.query('SELECT * FROM subscriptions WHERE id = $1;', [sub.id]);
    res.json({
      success: true,
      message: 'Subscription payment failed.',
      subscription: updatedSubRes.rows[0]
    });
  } catch (err) {
    console.error('Error rejecting subscription payment:', err);
    res.status(500).json({ success: false, message: 'Failed to reject payment request.' });
  }
};

app.post('/api/owner/subscriptions/:id/reject-cash', authenticateToken, requireOwnerOrKitchen, handleOwnerRejectSubscriptionPayment);
app.post('/api/owner/subscriptions/:id/reject-payment', authenticateToken, requireOwnerOrKitchen, handleOwnerRejectSubscriptionPayment);

// DELETE /api/owner/subscriptions/:id - Owner Delete Subscription Record
app.delete('/api/owner/subscriptions/:id', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Subscription ID is required.' });
    }

    const subRes = await db.query('SELECT * FROM subscriptions WHERE id = $1 OR subscription_id = $1;', [id]);
    if (!subRes.rows || subRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Subscription record not found.' });
    }
    const sub = subRes.rows[0];

    // Delete associated meal pass redemptions first
    await db.query(`DELETE FROM subscription_redemptions WHERE subscription_id = $1 OR meal_pass_id IN (SELECT id FROM subscription_meal_passes WHERE subscription_id = $1);`, [sub.id]);
    // Delete associated meal passes
    await db.query('DELETE FROM subscription_meal_passes WHERE subscription_id = $1;', [sub.id]);
    // Delete associated payments
    await db.query('DELETE FROM payments WHERE order_id = $1 OR order_number = $2;', [sub.id, sub.subscription_id]);
    // Delete subscription record
    await db.query('DELETE FROM subscriptions WHERE id = $1;', [sub.id]);

    res.json({
      success: true,
      message: `Subscription ${sub.subscription_id || sub.id} deleted successfully.`
    });
  } catch (err) {
    console.error('Error deleting owner subscription:', err);
    res.status(500).json({ success: false, message: 'Failed to delete subscription record.' });
  }
});

// DELETE /api/subscriptions/passes/bulk-delete - Bulk Delete USED or EXPIRED Meal Passes
app.delete('/api/subscriptions/passes/bulk-delete', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body || {};
    const targetStatus = (status || '').toUpperCase();

    let allowedStatuses = [];
    if (targetStatus === 'USED') {
      allowedStatuses = ['USED'];
    } else if (targetStatus === 'EXPIRED') {
      allowedStatuses = ['EXPIRED'];
    } else if (targetStatus === 'ALL_INACTIVE' || targetStatus === 'ALL') {
      allowedStatuses = ['USED', 'EXPIRED'];
    } else {
      return res.status(400).json({ success: false, message: 'Must specify status: USED, EXPIRED, or ALL_INACTIVE.' });
    }

    const isOwnerOrKitchen = req.user.role === 'OWNER' || req.user.role === 'ADMIN' || req.user.role === 'KITCHEN';

    let passQuery = 'SELECT id FROM subscription_meal_passes WHERE status IN (' + allowedStatuses.map((_, i) => `$${i + 1}`).join(', ') + ')';
    let passParams = [...allowedStatuses];

    if (!isOwnerOrKitchen) {
      passParams.push(req.user.id);
      passQuery += ` AND customer_id = $${passParams.length}`;
    }

    const passesToDel = await db.query(passQuery, passParams);
    const passIds = (passesToDel.rows || []).map(p => p.id);

    if (passIds.length === 0) {
      return res.json({ success: true, message: 'No matching USED or EXPIRED passes found to delete.', deleted_count: 0 });
    }

    for (const pId of passIds) {
      await db.query('DELETE FROM subscription_redemptions WHERE meal_pass_id = $1;', [pId]);
      await db.query('DELETE FROM subscription_meal_passes WHERE id = $1;', [pId]);
    }

    res.json({
      success: true,
      message: `Successfully deleted ${passIds.length} meal pass(es).`,
      deleted_count: passIds.length
    });
  } catch (err) {
    console.error('Error bulk deleting meal passes:', err);
    res.status(500).json({ success: false, message: 'Failed to delete meal passes.' });
  }
});

// DELETE /api/subscriptions/passes/:id - Delete single meal pass (USED or EXPIRED only)
app.delete('/api/subscriptions/passes/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Meal pass ID is required.' });
    }

    const passRes = await db.query('SELECT * FROM subscription_meal_passes WHERE id = $1 OR pass_id = $1;', [id]);
    if (!passRes.rows || passRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Meal pass not found.' });
    }
    const pass = passRes.rows[0];

    const isOwnerOrKitchen = req.user.role === 'OWNER' || req.user.role === 'ADMIN' || req.user.role === 'KITCHEN';
    if (!isOwnerOrKitchen && pass.customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized to delete this meal pass.' });
    }

    if (pass.status !== 'USED' && pass.status !== 'EXPIRED') {
      return res.status(400).json({ success: false, message: 'Only USED or EXPIRED meal passes can be deleted to protect active balances.' });
    }

    await db.query('DELETE FROM subscription_redemptions WHERE meal_pass_id = $1;', [pass.id]);
    await db.query('DELETE FROM subscription_meal_passes WHERE id = $1;', [pass.id]);

    res.json({
      success: true,
      message: `Meal pass ${pass.pass_id} deleted successfully.`
    });
  } catch (err) {
    console.error('Error deleting meal pass:', err);
    res.status(500).json({ success: false, message: 'Failed to delete meal pass.' });
  }
});

// POST /api/subscriptions/confirm-payment - Verification & Generation of Meal Passes
// PART G, M: IDEMPOTENCY & PASS GENERATION
app.post('/api/subscriptions/confirm-payment', authenticateToken, async (req, res) => {
  try {
    const { subscription_id, id, utr_number, payment_screenshot } = req.body;
    const targetId = id || subscription_id;

    if (!targetId) {
      return res.status(400).json({ success: false, message: 'Subscription ID is required.' });
    }

    // Atomic transaction for activation & meal pass generation
    const result = await db.executeTransaction(async (tx) => {
      const subRes = await tx.query(
        'SELECT * FROM subscriptions WHERE (id = $1 OR subscription_id = $1) AND customer_id = $2;',
        [targetId, req.user.id]
      );
      if (!subRes.rows || subRes.rows.length === 0) {
        throw new Error('Subscription record not found.');
      }
      const sub = subRes.rows[0];

      // PART G: IDEMPOTENCY CHECK - If already ACTIVE, return cleanly without duplicate pass generation
      if (sub.status === 'ACTIVE') {
        const existingPasses = await tx.query('SELECT * FROM subscription_meal_passes WHERE subscription_id = $1 ORDER BY meal_number ASC;', [sub.id]);
        return { already_active: true, subscription: sub, passes_count: existingPasses.rows.length };
      }

      const now = new Date();
      const startDateIso = now.toISOString();
      const expiryDate = new Date(now.getTime() + (sub.duration_days * 24 * 60 * 60 * 1000));
      const expiryDateIso = expiryDate.toISOString();

      // Update UTR/screenshot if provided
      if (utr_number) {
        await tx.query('UPDATE subscriptions SET payment_reference = $1 WHERE id = $2;', [utr_number.trim(), sub.id]);
        await tx.query('UPDATE payments SET utr_number = $1 WHERE order_id = $2 OR order_number = $3;', [utr_number.trim(), sub.id, sub.subscription_id]);
      }

      // Activate Subscription
      await tx.query(
        `UPDATE subscriptions
         SET status = 'ACTIVE', payment_status = 'VERIFIED', start_date = $1, expiry_date = $2, updated_at = $3
         WHERE id = $4;`,
        [startDateIso, expiryDateIso, startDateIso, sub.id]
      );
      await tx.query(
        `UPDATE payments SET payment_status = 'Paid' WHERE order_id = $1 OR order_number = $2;`,
        [sub.id, sub.subscription_id]
      );

      // PART M: Generate Unique Meal Passes for each included meal
      const passes = [];
      for (let i = 1; i <= sub.total_meals; i++) {
        const passSeqNum = await db.getNextCounter('mealpass_seq');
        const passFormattedId = 'MP-' + String(passSeqNum).padStart(6, '0');
        const passDbId = 'pass_' + Date.now() + '_' + i + '_' + crypto.randomBytes(4).toString('hex');
        // PART O: Cryptographically secure random token reference ONLY
        const secureToken = 'MP_TOK_' + crypto.randomBytes(24).toString('hex');

        await tx.query(
          `INSERT INTO subscription_meal_passes (id, pass_id, subscription_id, customer_id, meal_number, secure_token, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'AVAILABLE', $7);`,
          [passDbId, passFormattedId, sub.id, sub.customer_id, i, secureToken, startDateIso]
        );
        passes.push({ pass_id: passFormattedId, meal_number: i, secure_token: secureToken, status: 'AVAILABLE' });
      }

      const activeSubRes = await tx.query('SELECT * FROM subscriptions WHERE id = $1;', [sub.id]);
      return { already_active: false, subscription: activeSubRes.rows[0], passes_count: passes.length };
    });

    res.json({
      success: true,
      message: result.already_active ? 'Subscription is active.' : 'Subscription activated successfully! Meal passes generated.',
      subscription: result.subscription,
      passes_count: result.passes_count
    });
  } catch (err) {
    console.error('Error confirming subscription payment:', err);
    res.status(400).json({ success: false, message: err.message || 'Payment confirmation failed.' });
  }
});

// ------------------------------------------------------------
// PART K, L, N: CUSTOMER DASHBOARD & MEAL PASSES
// ------------------------------------------------------------

// GET /api/subscriptions/my-subscriptions - Customer Subscriptions Dashboard
app.get('/api/subscriptions/my-subscriptions', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { q = '', status = 'ALL' } = req.query;

    const nowIso = new Date().toISOString();
    // Auto-expire outdated active subscriptions
    await db.query(`UPDATE subscriptions SET status = 'EXPIRED' WHERE customer_id = $1 AND status = 'ACTIVE' AND expiry_date < $2;`, [customerId, nowIso]);
    // Auto-complete fully used active subscriptions
    await db.query(`UPDATE subscriptions SET status = 'COMPLETED' WHERE customer_id = $1 AND status = 'ACTIVE' AND used_meals >= total_meals;`, [customerId]);

    let queryText = 'SELECT * FROM subscriptions WHERE customer_id = $1';
    const params = [customerId];

    if (status && status !== 'ALL') {
      params.push(status.toUpperCase());
      queryText += ` AND UPPER(status) = $${params.length}`;
    }

    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      queryText += ` AND (LOWER(plan_name) LIKE LOWER($${params.length}) OR LOWER(subscription_id) LIKE LOWER($${params.length}))`;
    }

    queryText += ' ORDER BY created_at DESC;';

    const subRes = await db.query(queryText, params);
    const subscriptions = (subRes.rows || []).map(s => {
      const total = parseInt(s.total_meals, 10);
      const used = parseInt(s.used_meals, 10);
      const remaining = Math.max(0, total - used);
      
      let effectiveStatus = s.status;
      if (s.status === 'ACTIVE' && remaining <= 0 && total > 0) {
        effectiveStatus = 'COMPLETED';
      }

      let daysRemaining = 0;
      if (s.expiry_date && effectiveStatus === 'ACTIVE') {
        const diffMs = new Date(s.expiry_date).getTime() - Date.now();
        daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      }

      return {
        ...s,
        status: effectiveStatus,
        total_meals: total,
        used_meals: used,
        remaining_meals: remaining,
        days_remaining: daysRemaining
      };
    });

    res.json({ success: true, subscriptions });
  } catch (err) {
    console.error('Error fetching customer subscriptions:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch your subscriptions.' });
  }
});

// DELETE /api/subscriptions/my-subscriptions/:id - Customer Delete Subscription (COMPLETED, EXPIRED, REJECTED, CANCELLED only)
app.delete('/api/subscriptions/my-subscriptions/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: 'Subscription ID is required.' });
    }

    const subRes = await db.query('SELECT * FROM subscriptions WHERE (id = $1 OR subscription_id = $1) AND customer_id = $2;', [id, req.user.id]);
    if (!subRes.rows || subRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Subscription record not found.' });
    }
    const sub = subRes.rows[0];

    const total = parseInt(sub.total_meals, 10);
    const used = parseInt(sub.used_meals, 10);
    const remaining = Math.max(0, total - used);

    // Only allow deletion if subscription is COMPLETED, EXPIRED, FAILED/REJECTED, CANCELLED, or remaining === 0
    const isDeletable = sub.status === 'COMPLETED' || sub.status === 'EXPIRED' || sub.status === 'FAILED' || sub.status === 'REJECTED' || sub.status === 'CANCELLED' || remaining <= 0;

    if (!isDeletable) {
      return res.status(400).json({ success: false, message: 'Active subscriptions with remaining meals cannot be deleted.' });
    }

    // Delete associated meal pass redemptions first
    await db.query(`DELETE FROM subscription_redemptions WHERE subscription_id = $1 OR meal_pass_id IN (SELECT id FROM subscription_meal_passes WHERE subscription_id = $1);`, [sub.id]);
    // Delete associated meal passes
    await db.query('DELETE FROM subscription_meal_passes WHERE subscription_id = $1;', [sub.id]);
    // Delete associated payments
    await db.query('DELETE FROM payments WHERE order_id = $1 OR order_number = $2;', [sub.id, sub.subscription_id]);
    // Delete subscription record
    await db.query('DELETE FROM subscriptions WHERE id = $1;', [sub.id]);

    res.json({ success: true, message: `Subscription ${sub.subscription_id || sub.id} deleted successfully.` });
  } catch (err) {
    console.error('Error deleting customer subscription:', err);
    res.status(500).json({ success: false, message: 'Failed to delete subscription.' });
  }
});

// GET /api/subscriptions/my-passes - Customer Meal Passes
app.get('/api/subscriptions/my-passes', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.id;
    const { subscription_id, status = 'ALL' } = req.query;

    let queryText = `
      SELECT p.*, s.plan_name, s.subscription_id as sub_formatted_id, s.expiry_date, s.status as sub_status
      FROM subscription_meal_passes p
      JOIN subscriptions s ON p.subscription_id = s.id
      WHERE p.customer_id = $1
    `;
    const params = [customerId];

    if (subscription_id) {
      params.push(subscription_id);
      queryText += ` AND (p.subscription_id = $${params.length} OR s.subscription_id = $${params.length})`;
    }

    if (status && status !== 'ALL') {
      params.push(status.toUpperCase());
      queryText += ` AND UPPER(p.status) = $${params.length}`;
    }

    queryText += ' ORDER BY p.meal_number ASC, p.created_at DESC;';

    const passesRes = await db.query(queryText, params);
    const passes = passesRes.rows || [];

    res.json({ success: true, passes });
  } catch (err) {
    console.error('Error fetching customer meal passes:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch meal passes.' });
  }
});

// ------------------------------------------------------------
// PART P, Q, R, S, T, U, V, W, X: OWNER SCANNER, VERIFICATION & REDEMPTION
// ------------------------------------------------------------

// POST /api/subscriptions/verify-pass - Owner Scans QR Token
app.post('/api/subscriptions/verify-pass', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ success: false, code: 'INVALID_PASS', message: 'Invalid meal pass token.' });
    }

    const cleanToken = token.trim();

    // 1. Check Pass Existence
    const passRes = await db.query(
      `SELECT p.*, s.subscription_id as sub_formatted_id, s.customer_name, s.customer_mobile, s.plan_name,
              s.total_meals, s.used_meals, s.expiry_date, s.status as sub_status, s.payment_status
       FROM subscription_meal_passes p
       JOIN subscriptions s ON p.subscription_id = s.id
       WHERE p.secure_token = $1 OR p.pass_id = $1;`,
      [cleanToken]
    );

    if (!passRes.rows || passRes.rows.length === 0) {
      return res.status(404).json({ success: false, code: 'INVALID_PASS', message: 'Invalid meal pass.' });
    }

    const pass = passRes.rows[0];

    // PART T: Check Already Used
    if (pass.status === 'USED') {
      const redemptionRes = await db.query('SELECT * FROM subscription_redemptions WHERE meal_pass_id = $1 ORDER BY redeemed_at DESC LIMIT 1;', [pass.id]);
      const redemption = redemptionRes.rows[0] || {};
      const redeemedFormattedDate = redemption.redeemed_at
        ? new Date(redemption.redeemed_at).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
        : (pass.redeemed_at ? new Date(pass.redeemed_at).toLocaleString('en-IN') : 'Recently');

      return res.status(400).json({
        success: false,
        code: 'ALREADY_USED',
        message: 'This meal pass has already been redeemed.',
        pass_number: `#${pass.meal_number}`,
        redeemed_at: redeemedFormattedDate,
        customer_name: pass.customer_name,
        plan_name: pass.plan_name,
        subscription_id: pass.sub_formatted_id
      });
    }

    // PART V: Check Subscription Active & Not Expired
    if (pass.sub_status !== 'ACTIVE') {
      return res.status(400).json({ success: false, code: 'INACTIVE_SUBSCRIPTION', message: 'Subscription is not active.' });
    }

    if (pass.expiry_date && new Date(pass.expiry_date).getTime() < Date.now()) {
      return res.status(400).json({ success: false, code: 'EXPIRED', message: 'Subscription has expired.' });
    }

    // PART W: Check Zero Meals Remaining
    const total = parseInt(pass.total_meals, 10);
    const used = parseInt(pass.used_meals, 10);
    const remaining = Math.max(0, total - used);

    if (remaining <= 0) {
      return res.status(400).json({ success: false, code: 'NO_MEALS', message: 'No subscription meals remaining.' });
    }

    // Valid Verification Output for Owner Review
    res.json({
      success: true,
      verified: true,
      pass_id: pass.id,
      pass_formatted_id: pass.pass_id,
      meal_number: pass.meal_number,
      customer_name: pass.customer_name,
      customer_mobile: pass.customer_mobile,
      plan_name: pass.plan_name,
      subscription_id: pass.sub_formatted_id,
      total_meals: total,
      used_meals: used,
      remaining_meals: remaining,
      expiry_date: pass.expiry_date,
      status: 'AVAILABLE'
    });
  } catch (err) {
    console.error('Error verifying meal pass:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Something went wrong while verifying meal pass.' });
  }
});

// POST /api/subscriptions/redeem-pass - Owner Confirms Meal Pass Redemption
// PART U: CONCURRENT REDEMPTION PROTECTION & ATOMIC DATABASE UPDATE
app.post('/api/subscriptions/redeem-pass', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const { token, pass_id } = req.body;
    const searchToken = (token || pass_id || '').trim();

    if (!searchToken) {
      return res.status(400).json({ success: false, message: 'Pass identifier or token is required.' });
    }

    // Execute atomic transaction for redemption
    const result = await db.executeTransaction(async (tx) => {
      // 1. Fetch and Lock Pass
      const passRes = await tx.query(
        `SELECT p.*, s.id as sub_db_id, s.subscription_id as sub_formatted_id, s.customer_id, s.customer_name,
                s.customer_mobile, s.plan_name, s.total_meals, s.used_meals, s.expiry_date, s.status as sub_status
         FROM subscription_meal_passes p
         JOIN subscriptions s ON p.subscription_id = s.id
         WHERE p.secure_token = $1 OR p.pass_id = $1 OR p.id = $1;`,
        [searchToken]
      );

      if (!passRes.rows || passRes.rows.length === 0) {
        throw { code: 'INVALID_PASS', message: 'Invalid meal pass.' };
      }

      const pass = passRes.rows[0];

      // PART T: Double Redemption Guard
      if (pass.status !== 'AVAILABLE') {
        const redemptionRes = await tx.query('SELECT redeemed_at FROM subscription_redemptions WHERE meal_pass_id = $1 LIMIT 1;', [pass.id]);
        const redeemedAtStr = redemptionRes.rows[0]?.redeemed_at
          ? new Date(redemptionRes.rows[0].redeemed_at).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
          : 'Recently';
        throw { code: 'ALREADY_USED', message: 'This meal pass has already been redeemed.', redeemed_at: redeemedAtStr, meal_number: pass.meal_number };
      }

      if (pass.sub_status !== 'ACTIVE') {
        throw { code: 'INACTIVE_SUBSCRIPTION', message: 'Subscription is not active.' };
      }

      if (pass.expiry_date && new Date(pass.expiry_date).getTime() < Date.now()) {
        throw { code: 'EXPIRED', message: 'Subscription has expired.' };
      }

      const total = parseInt(pass.total_meals, 10);
      const currentUsed = parseInt(pass.used_meals, 10);
      if (currentUsed >= total) {
        throw { code: 'NO_MEALS', message: 'No subscription meals remaining.' };
      }

      // Generate Redemption Sequence
      const redSeqNum = await db.getNextCounter('redemption_seq');
      const redFormattedId = 'RED-' + String(redSeqNum).padStart(6, '0');
      const redDbId = 'red_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
      const nowIso = new Date().toISOString();

      // ATOMIC UPDATE: Meal Pass AVAILABLE -> USED (Row-matching lock)
      const updatePassRes = await tx.query(
        `UPDATE subscription_meal_passes
         SET status = 'USED', redeemed_at = $1, redemption_id = $2
         WHERE id = $3 AND status = 'AVAILABLE';`,
        [nowIso, redDbId, pass.id]
      );

      if (updatePassRes.rowCount === 0) {
        // Concurrent scanner lost the race
        throw { code: 'ALREADY_USED', message: 'This meal pass was just redeemed by another request.' };
      }

      // Increment Subscription used_meals
      await tx.query(
        `UPDATE subscriptions
         SET used_meals = used_meals + 1, updated_at = $1
         WHERE id = $2 AND used_meals < total_meals;`,
        [nowIso, pass.sub_db_id]
      );

      // Create Redemption Audit Record
      await tx.query(
        `INSERT INTO subscription_redemptions (
          id, redemption_reference, meal_pass_id, subscription_id, customer_id, customer_name,
          customer_mobile, plan_name, meal_number, redeemed_at, redeemed_by, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'SUCCESS');`,
        [
          redDbId, redFormattedId, pass.id, pass.sub_db_id, pass.customer_id, pass.customer_name,
          pass.customer_mobile, pass.plan_name, pass.meal_number, nowIso, req.user.name || 'Owner'
        ]
      );

      const newUsed = currentUsed + 1;
      const newRemaining = Math.max(0, total - newUsed);

      // Auto-set status to COMPLETED if all meals used
      if (newRemaining <= 0) {
        await tx.query(
          `UPDATE subscriptions SET status = 'COMPLETED', updated_at = $1 WHERE id = $2;`,
          [nowIso, pass.sub_db_id]
        );
      }

      return {
        redemption_reference: redFormattedId,
        pass_number: pass.meal_number,
        customer_name: pass.customer_name,
        plan_name: pass.plan_name,
        subscription_id: pass.sub_formatted_id,
        total_meals: total,
        used_meals: newUsed,
        remaining_meals: newRemaining,
        customer_id: pass.customer_id
      };
    });

    // Broadcast Real-time WebSocket event to Customer Dashboard
    try {
      const wsPayload = JSON.stringify({
        type: 'MEAL_PASS_REDEEMED',
        customerId: result.customer_id,
        subscriptionId: result.subscription_id,
        usedMeals: result.used_meals,
        remainingMeals: result.remaining_meals
      });
      activeWsClients.forEach((client, ws) => {
        if (ws.readyState === 1 && client.userId === result.customer_id) {
          ws.send(wsPayload);
        }
      });
    } catch (wsErr) {
      console.warn('WS Broadcast notice:', wsErr.message);
    }

    res.json({
      success: true,
      message: 'Meal pass redeemed successfully!',
      redemption: result
    });
  } catch (err) {
    if (err && err.code) {
      return res.status(400).json({
        success: false,
        code: err.code,
        message: err.message,
        redeemed_at: err.redeemed_at,
        pass_number: err.meal_number
      });
    }
    console.error('Error redeeming meal pass:', err);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Failed to process meal redemption.' });
  }
});

// ------------------------------------------------------------
// PART Y, Z: OWNER SUBSCRIBERS, PASSES & REDEMPTIONS (SEARCH, FILTER, SORT, PAGINATION)
// ------------------------------------------------------------

// GET /api/owner/subscribers - Subscriber List with Search, Multi-Filter, Sorting & Pagination
app.get('/api/owner/subscribers', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const {
      q = '',
      status = 'ALL',
      plan_id = 'ALL',
      expiry = 'ALL',
      sort = 'newest',
      page = 1,
      limit = 20
    } = req.query;

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (parsedPage - 1) * parsedLimit;

    let whereConditions = [];
    let params = [];

    // Search filter
    if (q && q.trim()) {
      const searchVal = `%${q.trim().toLowerCase()}%`;
      params.push(searchVal);
      whereConditions.push(
        `(LOWER(customer_name) LIKE $${params.length} OR LOWER(customer_mobile) LIKE $${params.length} OR LOWER(subscription_id) LIKE $${params.length} OR LOWER(plan_name) LIKE $${params.length})`
      );
    }

    // Status filter
    if (status && status !== 'ALL') {
      const targetStatus = status.toUpperCase();
      if (targetStatus === 'FAILED' || targetStatus === 'REJECTED') {
        whereConditions.push(`(UPPER(status) = 'FAILED' OR UPPER(status) = 'REJECTED')`);
      } else {
        params.push(targetStatus);
        whereConditions.push(`UPPER(status) = $${params.length}`);
      }
    }

    // Plan filter
    if (plan_id && plan_id !== 'ALL') {
      params.push(plan_id);
      whereConditions.push(`(plan_id = $${params.length} OR LOWER(plan_name) LIKE LOWER($${params.length}))`);
    }

    // Expiry filter
    if (expiry === 'EXPIRING_SOON') {
      const threeDaysLater = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const nowIso = new Date().toISOString();
      params.push(nowIso, threeDaysLater);
      whereConditions.push(`(status = 'ACTIVE' AND expiry_date >= $${params.length - 1} AND expiry_date <= $${params.length})`);
    } else if (expiry === 'EXPIRED') {
      const nowIso = new Date().toISOString();
      params.push(nowIso);
      whereConditions.push(`(status = 'EXPIRED' OR expiry_date < $${params.length})`);
    }

    const whereClause = whereConditions.length > 0 ? ' WHERE ' + whereConditions.join(' AND ') : '';

    // Sorting
    let orderByClause = ' ORDER BY created_at DESC';
    switch (sort) {
      case 'oldest':
        orderByClause = ' ORDER BY created_at ASC';
        break;
      case 'expiry_soonest':
        orderByClause = ' ORDER BY expiry_date ASC';
        break;
      case 'expiry_latest':
        orderByClause = ' ORDER BY expiry_date DESC';
        break;
      case 'most_meals':
        orderByClause = ' ORDER BY (total_meals - used_meals) DESC';
        break;
      case 'least_meals':
        orderByClause = ' ORDER BY (total_meals - used_meals) ASC';
        break;
      case 'highest_price':
        orderByClause = ' ORDER BY purchase_price DESC';
        break;
      case 'lowest_price':
        orderByClause = ' ORDER BY purchase_price ASC';
        break;
      default:
        orderByClause = ' ORDER BY created_at DESC';
    }

    // Count Total
    const countSql = `SELECT COUNT(*) as total FROM subscriptions${whereClause};`;
    const countRes = await db.query(countSql, params);
    const totalRecords = parseInt(countRes.rows[0]?.total || '0', 10);

    // Auto-complete fully used active subscriptions
    await db.query("UPDATE subscriptions SET status = 'COMPLETED' WHERE status = 'ACTIVE' AND used_meals >= total_meals;");

    // Fetch Paginated Records
    const limitParamIdx = params.length + 1;
    const offsetParamIdx = params.length + 2;
    const dataSql = `SELECT * FROM subscriptions${whereClause}${orderByClause} LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx};`;
    const dataParams = [...params, parsedLimit, offset];

    const dataRes = await db.query(dataSql, dataParams);

    const subscribers = (dataRes.rows || []).map(s => {
      const total = parseInt(s.total_meals, 10);
      const used = parseInt(s.used_meals, 10);
      const remaining = Math.max(0, total - used);
      let effectiveStatus = s.status;
      if (s.status === 'ACTIVE' && remaining <= 0 && total > 0) {
        effectiveStatus = 'COMPLETED';
      }

      return {
        ...s,
        status: effectiveStatus,
        total_meals: total,
        used_meals: used,
        remaining_meals: remaining
      };
    });

    res.json({
      success: true,
      subscribers,
      pagination: {
        total: totalRecords,
        page: parsedPage,
        limit: parsedLimit,
        total_pages: Math.ceil(totalRecords / parsedLimit) || 1
      }
    });
  } catch (err) {
    console.error('Error fetching subscribers list:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch subscribers list.' });
  }
});

// GET /api/owner/subscription-passes - Meal Passes Management
app.get('/api/owner/subscription-passes', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const { q = '', status = 'ALL', plan_id = 'ALL', page = 1, limit = 20 } = req.query;

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (parsedPage - 1) * parsedLimit;

    let whereConditions = [];
    let params = [];

    if (q && q.trim()) {
      const searchVal = `%${q.trim().toLowerCase()}%`;
      params.push(searchVal);
      whereConditions.push(
        `(LOWER(p.pass_id) LIKE $${params.length} OR LOWER(s.subscription_id) LIKE $${params.length} OR LOWER(s.customer_name) LIKE $${params.length} OR LOWER(s.customer_mobile) LIKE $${params.length})`
      );
    }

    if (status && status !== 'ALL') {
      params.push(status.toUpperCase());
      whereConditions.push(`UPPER(p.status) = $${params.length}`);
    }

    if (plan_id && plan_id !== 'ALL') {
      params.push(plan_id);
      whereConditions.push(`(s.plan_id = $${params.length} OR LOWER(s.plan_name) LIKE LOWER($${params.length}))`);
    }

    const whereClause = whereConditions.length > 0 ? ' WHERE ' + whereConditions.join(' AND ') : '';

    const countSql = `
      SELECT COUNT(*) as total
      FROM subscription_meal_passes p
      JOIN subscriptions s ON p.subscription_id = s.id
      ${whereClause};
    `;
    const countRes = await db.query(countSql, params);
    const totalRecords = parseInt(countRes.rows[0]?.total || '0', 10);

    params.push(parsedLimit, offset);
    const dataSql = `
      SELECT p.*, s.subscription_id as sub_formatted_id, s.customer_name, s.customer_mobile, s.plan_name
      FROM subscription_meal_passes p
      JOIN subscriptions s ON p.subscription_id = s.id
      ${whereClause}
      ORDER BY p.created_at DESC, p.meal_number ASC
      LIMIT $${params.length - 1} OFFSET $${params.length};
    `;
    const dataRes = await db.query(dataSql, params);

    res.json({
      success: true,
      passes: dataRes.rows || [],
      pagination: {
        total: totalRecords,
        page: parsedPage,
        limit: parsedLimit,
        total_pages: Math.ceil(totalRecords / parsedLimit) || 1
      }
    });
  } catch (err) {
    console.error('Error fetching subscription passes:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch meal passes.' });
  }
});

// GET /api/owner/subscription-redemptions - Redemption Audit Logs
app.get('/api/owner/subscription-redemptions', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const { q = '', date_range = 'ALL', page = 1, limit = 20 } = req.query;

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (parsedPage - 1) * parsedLimit;

    let whereConditions = [];
    let params = [];

    if (q && q.trim()) {
      const searchVal = `%${q.trim().toLowerCase()}%`;
      params.push(searchVal);
      whereConditions.push(
        `(LOWER(redemption_reference) LIKE $${params.length} OR LOWER(customer_name) LIKE $${params.length} OR LOWER(customer_mobile) LIKE $${params.length} OR LOWER(plan_name) LIKE $${params.length})`
      );
    }

    if (date_range === 'TODAY') {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      params.push(startOfDay.toISOString());
      whereConditions.push(`redeemed_at >= $${params.length}`);
    } else if (date_range === '7DAYS') {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      params.push(sevenDaysAgo.toISOString());
      whereConditions.push(`redeemed_at >= $${params.length}`);
    } else if (date_range === '30DAYS') {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      params.push(thirtyDaysAgo.toISOString());
      whereConditions.push(`redeemed_at >= $${params.length}`);
    }

    const whereClause = whereConditions.length > 0 ? ' WHERE ' + whereConditions.join(' AND ') : '';

    const countSql = `SELECT COUNT(*) as total FROM subscription_redemptions${whereClause};`;
    const countRes = await db.query(countSql, params);
    const totalRecords = parseInt(countRes.rows[0]?.total || '0', 10);

    params.push(parsedLimit, offset);
    const dataSql = `SELECT * FROM subscription_redemptions${whereClause} ORDER BY redeemed_at DESC LIMIT $${params.length - 1} OFFSET $${params.length};`;
    const dataRes = await db.query(dataSql, params);

    res.json({
      success: true,
      redemptions: dataRes.rows || [],
      pagination: {
        total: totalRecords,
        page: parsedPage,
        limit: parsedLimit,
        total_pages: Math.ceil(totalRecords / parsedLimit) || 1
      }
    });
  } catch (err) {
    console.error('Error fetching redemptions:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch redemption logs.' });
  }
});

/* ============================================================
   📍 CUSTOMER DELIVERY ADDRESS MANAGEMENT ENDPOINTS
   ============================================================ */

// GET /api/addresses - List Customer's Saved Addresses
app.get('/api/addresses', authenticateToken, async (req, res) => {
  try {
    const addressesRes = await db.query(
      `SELECT * FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at DESC;`,
      [req.user.id]
    );
    res.json({
      success: true,
      addresses: addressesRes.rows || []
    });
  } catch (err) {
    console.error('Error fetching addresses:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch saved addresses.' });
  }
});

// POST /api/addresses - Add New Delivery Address
app.post('/api/addresses', authenticateToken, async (req, res) => {
  try {
    let {
      address_type = 'Home',
      full_name,
      mobile_number,
      address_line1,
      address_line2 = '',
      area,
      city,
      state,
      pincode,
      landmark = '',
      delivery_instructions = '',
      is_default = false
    } = req.body;

    full_name = (full_name || '').trim();
    mobile_number = (mobile_number || '').trim();
    address_line1 = (address_line1 || '').trim();
    address_line2 = (address_line2 || '').trim();
    area = (area || '').trim();
    city = (city || '').trim();
    state = (state || '').trim();
    pincode = (pincode || '').trim();
    landmark = (landmark || '').trim();
    delivery_instructions = (delivery_instructions || '').trim();

    if (!full_name || !mobile_number || !address_line1 || !area || !city || !state || !pincode) {
      return res.status(400).json({ success: false, message: 'Please fill all required address fields.' });
    }

    // Validate Indian PIN Code Format (6 digits)
    const pinRegex = /^[1-9][0-9]{5}$/;
    if (!pinRegex.test(pincode)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid 6-digit Indian PIN code.' });
    }

    // Address Count Limit Check (Max 15)
    const countRes = await db.query(`SELECT COUNT(*) as total FROM customer_addresses WHERE customer_id = $1;`, [req.user.id]);
    const currentCount = parseInt(countRes.rows[0]?.total || '0', 10);
    if (currentCount >= 15) {
      return res.status(400).json({ success: false, message: 'Address limit reached. Please delete an existing address before adding another.' });
    }

    const setAsDefault = Boolean(is_default || currentCount === 0);

    if (setAsDefault) {
      await db.query(`UPDATE customer_addresses SET is_default = false WHERE customer_id = $1;`, [req.user.id]);
    }

    const addrId = 'addr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const nowIso = new Date().toISOString();

    await db.query(
      `INSERT INTO customer_addresses (
        id, customer_id, address_type, full_name, mobile_number, address_line1, address_line2,
        area, city, state, pincode, landmark, delivery_instructions, is_default, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);`,
      [
        addrId, req.user.id, address_type || 'Home', full_name, mobile_number, address_line1, address_line2,
        area, city, state, pincode, landmark, delivery_instructions, setAsDefault, nowIso, nowIso
      ]
    );

    const newAddrRes = await db.query(`SELECT * FROM customer_addresses WHERE id = $1;`, [addrId]);
    res.json({
      success: true,
      message: '🎉 Address saved successfully.',
      address: newAddrRes.rows[0]
    });
  } catch (err) {
    console.error('Error adding address:', err);
    res.status(500).json({ success: false, message: 'Failed to save address.' });
  }
});

// PUT /api/addresses/:id - Edit Saved Address (Strict Ownership Check)
app.put('/api/addresses/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const addrCheck = await db.query(`SELECT * FROM customer_addresses WHERE id = $1;`, [id]);
    if (!addrCheck.rows || addrCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Address not found.' });
    }

    if (addrCheck.rows[0].customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized. You do not own this address.' });
    }

    let {
      address_type = 'Home',
      full_name,
      mobile_number,
      address_line1,
      address_line2 = '',
      area,
      city,
      state,
      pincode,
      landmark = '',
      delivery_instructions = '',
      is_default = false
    } = req.body;

    full_name = (full_name || '').trim();
    mobile_number = (mobile_number || '').trim();
    address_line1 = (address_line1 || '').trim();
    address_line2 = (address_line2 || '').trim();
    area = (area || '').trim();
    city = (city || '').trim();
    state = (state || '').trim();
    pincode = (pincode || '').trim();
    landmark = (landmark || '').trim();
    delivery_instructions = (delivery_instructions || '').trim();

    if (!full_name || !mobile_number || !address_line1 || !area || !city || !state || !pincode) {
      return res.status(400).json({ success: false, message: 'Please fill all required address fields.' });
    }

    const pinRegex = /^[1-9][0-9]{5}$/;
    if (!pinRegex.test(pincode)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid 6-digit Indian PIN code.' });
    }

    const setAsDefault = Boolean(is_default);

    if (setAsDefault) {
      await db.query(`UPDATE customer_addresses SET is_default = false WHERE customer_id = $1;`, [req.user.id]);
    }

    const nowIso = new Date().toISOString();

    await db.query(
      `UPDATE customer_addresses SET
        address_type = $1, full_name = $2, mobile_number = $3, address_line1 = $4, address_line2 = $5,
        area = $6, city = $7, state = $8, pincode = $9, landmark = $10, delivery_instructions = $11,
        is_default = $12, updated_at = $13
      WHERE id = $14 AND customer_id = $15;`,
      [
        address_type || 'Home', full_name, mobile_number, address_line1, address_line2,
        area, city, state, pincode, landmark, delivery_instructions,
        setAsDefault, nowIso, id, req.user.id
      ]
    );

    res.json({
      success: true,
      message: 'Address updated successfully.'
    });
  } catch (err) {
    console.error('Error updating address:', err);
    res.status(500).json({ success: false, message: 'Failed to update address.' });
  }
});

// DELETE /api/addresses/:id - Delete Address (Auto-promotes new default if needed)
app.delete('/api/addresses/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const addrCheck = await db.query(`SELECT * FROM customer_addresses WHERE id = $1;`, [id]);
    if (!addrCheck.rows || addrCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Address not found.' });
    }

    if (addrCheck.rows[0].customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized. You do not own this address.' });
    }

    const wasDefault = Boolean(addrCheck.rows[0].is_default);

    await db.query(`DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2;`, [id, req.user.id]);

    // If default address was deleted, auto-promote most recently created remaining address
    if (wasDefault) {
      const remainRes = await db.query(
        `SELECT id FROM customer_addresses WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1;`,
        [req.user.id]
      );
      if (remainRes.rows && remainRes.rows.length > 0) {
        await db.query(`UPDATE customer_addresses SET is_default = true WHERE id = $1;`, [remainRes.rows[0].id]);
      }
    }

    res.json({
      success: true,
      message: 'Address deleted successfully.'
    });
  } catch (err) {
    console.error('Error deleting address:', err);
    res.status(500).json({ success: false, message: 'Failed to delete address.' });
  }
});

// PATCH /api/addresses/:id/set-default - Set Specific Address as Default
app.patch('/api/addresses/:id/set-default', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const addrCheck = await db.query(`SELECT * FROM customer_addresses WHERE id = $1;`, [id]);
    if (!addrCheck.rows || addrCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Address not found.' });
    }

    if (addrCheck.rows[0].customer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized. You do not own this address.' });
    }

    await db.query(`UPDATE customer_addresses SET is_default = false WHERE customer_id = $1;`, [req.user.id]);
    await db.query(`UPDATE customer_addresses SET is_default = true WHERE id = $1 AND customer_id = $2;`, [id, req.user.id]);

    res.json({
      success: true,
      message: '⭐ Default address updated.'
    });
  } catch (err) {
    console.error('Error setting default address:', err);
    res.status(500).json({ success: false, message: 'Failed to set default address.' });
  }
});

/* ============================================================
   🗺️ OWNER DELIVERY ZONE MANAGEMENT ENDPOINTS
   ============================================================ */

// GET /api/owner/delivery-zones - List Delivery Zones (Owner)
app.get('/api/owner/delivery-zones', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const { q = '', status = 'ALL' } = req.query;
    let whereConditions = [];
    let params = [];

    if (q && q.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      whereConditions.push(`(COALESCE(LOWER(zone_name), '') LIKE $${params.length} OR COALESCE(LOWER(description), '') LIKE $${params.length} OR COALESCE(LOWER(pincodes::text), '') LIKE $${params.length})`);
    }

    if (status && status !== 'ALL') {
      params.push(status.toUpperCase());
      whereConditions.push(`UPPER(status) = $${params.length}`);
    }

    const whereClause = whereConditions.length > 0 ? ' WHERE ' + whereConditions.join(' AND ') : '';
    const zonesRes = await db.query(`SELECT * FROM delivery_zones${whereClause} ORDER BY created_at DESC;`, params);

    res.json({
      success: true,
      zones: zonesRes.rows || []
    });
  } catch (err) {
    console.error('Error fetching delivery zones:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch delivery zones.' });
  }
});

// POST /api/owner/delivery-zones - Create Delivery Zone with Duplicate PIN Check
app.post('/api/owner/delivery-zones', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    let {
      zone_name,
      description = '',
      pincodes = [],
      delivery_fee = 0,
      min_order_amount = 0,
      max_order_amount = null,
      status = 'ACTIVE'
    } = req.body;

    zone_name = (zone_name || '').trim();
    description = (description || '').trim();
    const fee = Math.max(0, parseFloat(delivery_fee || '0') || 0);
    const minOrder = Math.max(0, parseFloat(min_order_amount || '0') || 0);
    const maxOrder = max_order_amount ? Math.max(0, parseFloat(max_order_amount) || 0) : null;

    if (!zone_name) {
      return res.status(400).json({ success: false, message: 'Zone name is required.' });
    }

    // Parse PIN codes array
    let rawPins = [];
    if (Array.isArray(pincodes)) {
      rawPins = pincodes;
    } else if (typeof pincodes === 'string') {
      rawPins = pincodes.split(',').map(s => s.trim());
    }

    const cleanPins = Array.from(new Set(rawPins.map(p => String(p).trim()).filter(p => /^[1-9][0-9]{5}$/.test(p))));

    if (cleanPins.length === 0) {
      return res.status(400).json({ success: false, message: 'Please provide at least one valid 6-digit Indian PIN code.' });
    }

    // SERVER DUPLICATE CHECK: Verify PIN codes against existing ACTIVE delivery zones
    if (status === 'ACTIVE') {
      const activeZonesRes = await db.query(`SELECT id, zone_name, pincodes FROM delivery_zones WHERE status = 'ACTIVE';`);
      for (const az of (activeZonesRes.rows || [])) {
        let existingPins = [];
        try {
          existingPins = typeof az.pincodes === 'string' ? JSON.parse(az.pincodes) : (az.pincodes || []);
        } catch (e) {
          existingPins = [];
        }
        for (const p of cleanPins) {
          if (existingPins.map(x => String(x).trim()).includes(p)) {
            return res.status(400).json({
              success: false,
              message: `PIN code ${p} is already assigned to active delivery zone "${az.zone_name}".`
            });
          }
        }
      }
    }

    const zoneId = 'zone_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const nowIso = new Date().toISOString();

    await db.query(
      `INSERT INTO delivery_zones (id, zone_name, description, pincodes, delivery_fee, min_order_amount, max_order_amount, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [zoneId, zone_name, description, JSON.stringify(cleanPins), fee, minOrder, maxOrder, status || 'ACTIVE', nowIso, nowIso]
    );

    const newZoneRes = await db.query(`SELECT * FROM delivery_zones WHERE id = $1;`, [zoneId]);
    res.json({
      success: true,
      message: '🗺️ Delivery zone created successfully.',
      zone: newZoneRes.rows[0]
    });
  } catch (err) {
    console.error('Error creating delivery zone:', err);
    res.status(500).json({ success: false, message: 'Failed to create delivery zone.' });
  }
});

// PUT /api/owner/delivery-zones/:id - Edit Delivery Zone
app.put('/api/owner/delivery-zones/:id', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const { id } = req.params;
    const zoneCheck = await db.query(`SELECT * FROM delivery_zones WHERE id = $1;`, [id]);
    if (!zoneCheck.rows || zoneCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Delivery zone not found.' });
    }

    let {
      zone_name,
      description = '',
      pincodes = [],
      delivery_fee = 0,
      min_order_amount = 0,
      max_order_amount = null,
      status = 'ACTIVE'
    } = req.body;

    zone_name = (zone_name || '').trim();
    description = (description || '').trim();
    const fee = Math.max(0, parseFloat(delivery_fee || '0') || 0);
    const minOrder = Math.max(0, parseFloat(min_order_amount || '0') || 0);
    const maxOrder = max_order_amount ? Math.max(0, parseFloat(max_order_amount) || 0) : null;

    if (!zone_name) {
      return res.status(400).json({ success: false, message: 'Zone name is required.' });
    }

    let rawPins = [];
    if (Array.isArray(pincodes)) {
      rawPins = pincodes;
    } else if (typeof pincodes === 'string') {
      rawPins = pincodes.split(',').map(s => s.trim());
    }

    const cleanPins = Array.from(new Set(rawPins.map(p => String(p).trim()).filter(p => /^[1-9][0-9]{5}$/.test(p))));

    if (cleanPins.length === 0) {
      return res.status(400).json({ success: false, message: 'Please provide at least one valid 6-digit Indian PIN code.' });
    }

    // SERVER DUPLICATE CHECK: Verify PIN codes against OTHER active delivery zones
    if (status === 'ACTIVE') {
      const activeZonesRes = await db.query(`SELECT id, zone_name, pincodes FROM delivery_zones WHERE status = 'ACTIVE' AND id != $1;`, [id]);
      for (const az of (activeZonesRes.rows || [])) {
        let existingPins = [];
        try {
          existingPins = typeof az.pincodes === 'string' ? JSON.parse(az.pincodes) : (az.pincodes || []);
        } catch (e) {
          existingPins = [];
        }
        for (const p of cleanPins) {
          if (existingPins.map(x => String(x).trim()).includes(p)) {
            return res.status(400).json({
              success: false,
              message: `PIN code ${p} is already assigned to active delivery zone "${az.zone_name}".`
            });
          }
        }
      }
    }

    const nowIso = new Date().toISOString();

    await db.query(
      `UPDATE delivery_zones SET
        zone_name = $1, description = $2, pincodes = $3, delivery_fee = $4,
        min_order_amount = $5, max_order_amount = $6, status = $7, updated_at = $8
      WHERE id = $9;`,
      [zone_name, description, JSON.stringify(cleanPins), fee, minOrder, maxOrder, status || 'ACTIVE', nowIso, id]
    );

    res.json({
      success: true,
      message: 'Delivery zone updated successfully.'
    });
  } catch (err) {
    console.error('Error updating delivery zone:', err);
    res.status(500).json({ success: false, message: 'Failed to update delivery zone.' });
  }
});

// PATCH /api/owner/delivery-zones/:id/status - Toggle Zone Active/Inactive
app.patch('/api/owner/delivery-zones/:id/status', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const newStatus = (status || 'ACTIVE').toUpperCase();

    const zoneCheck = await db.query(`SELECT * FROM delivery_zones WHERE id = $1;`, [id]);
    if (!zoneCheck.rows || zoneCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Delivery zone not found.' });
    }

    const targetZone = zoneCheck.rows[0];

    // If activating, check PIN codes against other active zones
    if (newStatus === 'ACTIVE') {
      let cleanPins = [];
      try {
        cleanPins = typeof targetZone.pincodes === 'string' ? JSON.parse(targetZone.pincodes) : (targetZone.pincodes || []);
      } catch (e) {
        cleanPins = [];
      }

      const activeZonesRes = await db.query(`SELECT id, zone_name, pincodes FROM delivery_zones WHERE status = 'ACTIVE' AND id != $1;`, [id]);
      for (const az of (activeZonesRes.rows || [])) {
        let existingPins = [];
        try {
          existingPins = typeof az.pincodes === 'string' ? JSON.parse(az.pincodes) : (az.pincodes || []);
        } catch (e) {
          existingPins = [];
        }
        for (const p of cleanPins) {
          if (existingPins.map(x => String(x).trim()).includes(p)) {
            return res.status(400).json({
              success: false,
              message: `Cannot activate zone. PIN code ${p} is already assigned to active zone "${az.zone_name}".`
            });
          }
        }
      }
    }

    const nowIso = new Date().toISOString();
    await db.query(`UPDATE delivery_zones SET status = $1, updated_at = $2 WHERE id = $3;`, [newStatus, nowIso, id]);

    res.json({
      success: true,
      message: `Delivery zone status updated to ${newStatus}.`
    });
  } catch (err) {
    console.error('Error toggling zone status:', err);
    res.status(500).json({ success: false, message: 'Failed to update zone status.' });
  }
});

// DELETE /api/owner/delivery-zones/:id - Delete Delivery Zone
app.delete('/api/owner/delivery-zones/:id', authenticateToken, requireOwnerOrKitchen, async (req, res) => {
  try {
    const { id } = req.params;
    const zoneCheck = await db.query(`SELECT * FROM delivery_zones WHERE id = $1;`, [id]);
    if (!zoneCheck.rows || zoneCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Delivery zone not found.' });
    }

    await db.query(`DELETE FROM delivery_zones WHERE id = $1;`, [id]);

    res.json({
      success: true,
      message: 'Delivery zone deleted successfully.'
    });
  } catch (err) {
    console.error('Error deleting delivery zone:', err);
    res.status(500).json({ success: false, message: 'Failed to delete delivery zone.' });
  }
});

/* ============================================================
   📍 PINCODE LOOKUP & DELIVERY ZONE CHECK ENDPOINT
   ============================================================ */

// POST /api/delivery-zones/check-pincode - Match PIN code to active delivery zone
app.post('/api/delivery-zones/check-pincode', async (req, res) => {
  try {
    const { pincode, address_id } = req.body;
    let targetPin = (pincode || '').trim();

    if (address_id === 'profile_address' && req.user) {
      const uRes = await db.query(`SELECT address FROM users WHERE id = $1;`, [req.user.id]);
      if (uRes.rows && uRes.rows[0] && uRes.rows[0].address) {
        const pinMatch = uRes.rows[0].address.match(/\b\d{6}\b/);
        if (pinMatch) targetPin = pinMatch[0];
      }
    } else if (address_id) {
      const addrRes = await db.query(`SELECT pincode FROM customer_addresses WHERE id = $1;`, [address_id]);
      if (addrRes.rows && addrRes.rows.length > 0) {
        targetPin = (addrRes.rows[0].pincode || '').trim();
      }
    }

    if (!targetPin) {
      return res.status(400).json({ success: false, message: 'PIN code or Address ID is required.' });
    }

    const activeZonesRes = await db.query(`SELECT * FROM delivery_zones WHERE status = 'ACTIVE';`);
    let matchedZone = null;

    for (const z of (activeZonesRes.rows || [])) {
      let pinList = [];
      try {
        pinList = typeof z.pincodes === 'string' ? JSON.parse(z.pincodes) : (z.pincodes || []);
      } catch (e) {
        pinList = [];
      }
      if (Array.isArray(pinList) && pinList.map(p => String(p).trim()).includes(targetPin)) {
        matchedZone = z;
        break;
      }
    }

    if (matchedZone) {
      return res.json({
        success: true,
        available: true,
        zone: {
          id: matchedZone.id,
          zone_name: matchedZone.zone_name,
          delivery_fee: Number(matchedZone.delivery_fee || 0),
          min_order_amount: Number(matchedZone.min_order_amount || 0)
        },
        delivery_fee: Number(matchedZone.delivery_fee || 0)
      });
    }

    res.json({
      success: true,
      available: false,
      message: '🚫 Sorry, delivery is currently unavailable at this location.'
    });
  } catch (err) {
    console.error('Error checking pincode delivery zone:', err);
    res.status(500).json({ success: false, message: 'Failed to verify delivery zone.' });
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

    // Start background cron interval for automatic & idempotent card expiry reminders (Every 1 hour)
    setInterval(() => {
      processMemberCardExpiryReminders().catch(err => console.error('[Background Expiry Engine] Error:', err.message));
    }, 3600000);

    // Initial check 10 seconds after server startup
    setTimeout(() => {
      processMemberCardExpiryReminders().catch(err => console.error('[Background Expiry Engine Initial] Error:', err.message));
    }, 10000);
  } catch (err) {
    console.error('PostgreSQL Database Initialization Notice:', err.message);
  }
});
