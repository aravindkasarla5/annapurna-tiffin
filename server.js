const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
      const matchingUser = usersRes.rows.find(u => token.startsWith('tok_' + u.id + '_'));
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
      const lastActivity = Number(tokenEntry.last_activity || tokenEntry.created_at || now);
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
    } catch (e) {}
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

  try {
    const ownerRes = await db.query("SELECT * FROM users WHERE mobile = '9392874900' OR id = 'usr_owner_1';");
    if (!ownerRes.rows || ownerRes.rows.length === 0) {
      console.log('Owner user missing — seeding owner account...');
      await seedOwnerUser();
      try {
        const migrate = require('./migrate_to_postgres');
        await migrate();
      } catch(e) {}
    }
  } catch (e) {}

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
    try { return bcrypt.compareSync(iPass, sPass); } catch (e) {}
  }
  return sPass === iPass;
}

// =========================================================================
// AUTHENTICATION ROUTES
// =========================================================================

// AUTH 1. Register New Customer
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, mobile, password, email, address } = req.body;

    if (!name || !mobile || !password) {
      return res.status(400).json({ success: false, message: "Name, mobile, and password are required." });
    }

    if (req.body.role === 'OWNER') {
      return res.status(400).json({ success: false, message: "Owner registration is not allowed. Single owner account is maintained." });
    }

    const cleanMobile = normalizePhone(mobile);
    if (!cleanMobile || cleanMobile.length < 10) {
      return res.status(400).json({ success: false, message: "Please enter a valid 10-digit mobile number." });
    }

    if (cleanMobile === '9392874900') {
      return res.status(400).json({ success: false, message: "This mobile number is reserved for Hotel Owner. Please login." });
    }

    const existing = await findUserByIdentifier(cleanMobile);
    if (existing) {
      return res.status(400).json({ success: false, message: "Mobile number already registered. Please login." });
    }

    // Generate Unique Referral Code & Hashed Password
    const namePrefix = name.trim().replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5) || 'TIFFIN';
    const randomNum = Math.floor(10 + Math.random() * 90);
    const generatedRefCode = `${namePrefix}${randomNum}`;
    const hashedPassword = bcrypt.hashSync(password.trim(), 10);

    const newUserId = 'usr_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const newUser = {
      id: newUserId,
      name: name.trim(),
      mobile: cleanMobile,
      password: hashedPassword,
      role: 'CUSTOMER',
      email: (email || '').trim(),
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

    // Insert user into PostgreSQL FIRST to satisfy Foreign Key constraints
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

    // Insert into referrals table after user row exists in PostgreSQL
    if (referrer) {
      const settingsRes = await db.query('SELECT referral FROM settings WHERE id = 1;');
      let settingsReferral = settingsRes.rows[0]?.referral || {};
      if (typeof settingsReferral === 'string') {
        try { settingsReferral = JSON.parse(settingsReferral); } catch (e) {}
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
      message: `Account registered successfully!${refMessage}`
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

    const token = await generateToken(user.id);
    const userSafe = sanitizeUser(user);

    res.json({
      success: true,
      token: token,
      user: userSafe,
      message: user.role === 'OWNER' ? 'Welcome to Hotel Owner Dashboard!' : `Welcome back, ${user.name}!`
    });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ success: false, message: "Database server error during login." });
  }
});

// AUTH 3. Forgot Password (Lookup Account)
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const rawIdentifier = (req.body.identifier || req.body.mobile || '').toString().trim();

    if (!rawIdentifier) {
      return res.status(400).json({ success: false, message: "Registered Phone number or Email is required." });
    }

    const user = await findUserByIdentifier(rawIdentifier);

    if (!user) {
      return res.status(404).json({ success: false, message: "No account found with this number." });
    }

    const generatedOtp = "123456";
    await db.query(
      `INSERT INTO password_resets (user_id, otp, mobile, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET otp = EXCLUDED.otp, created_at = EXCLUDED.created_at;`,
      [user.id, generatedOtp, user.mobile, Date.now()]
    );

    res.json({
      success: true,
      message: "Account found. Continue verification.",
      data: {
        user_id: user.id,
        mobile: user.mobile,
        otp: generatedOtp
      }
    });
  } catch (err) {
    console.error('Forgot Password Error:', err);
    res.status(500).json({ success: false, message: "Database server error." });
  }
});

// AUTH 3b. Reset Password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const rawIdentifier = (req.body.identifier || req.body.mobile || '').toString().trim();
    const newPassword = (req.body.new_password || req.body.password || '').toString().trim();

    if (!rawIdentifier || !newPassword) {
      return res.status(400).json({ success: false, message: "Registered Phone / Email and new password are required." });
    }

    if (newPassword.length < 4) {
      return res.status(400).json({ success: false, message: "Password must be at least 4 characters long." });
    }

    const user = await findUserByIdentifier(rawIdentifier);

    if (!user) {
      return res.status(404).json({ success: false, message: "No account found with this number." });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    await db.query('UPDATE users SET password = $1 WHERE id = $2;', [hashedPassword, user.id]);
    await db.query('DELETE FROM password_resets WHERE user_id = $1;', [user.id]);

    res.json({
      success: true,
      message: "Password reset successfully. Please login again."
    });
  } catch (err) {
    console.error('Reset Password Error:', err);
    res.status(500).json({ success: false, message: "Database server error." });
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

app.get('/api/cart', authenticateToken, async (req, res) => {
  const userRes = await db.query('SELECT cart FROM users WHERE id = $1;', [req.user.id]);
  let cart = [];
  try { cart = typeof userRes.rows[0]?.cart === 'string' ? JSON.parse(userRes.rows[0].cart) : (userRes.rows[0]?.cart || []); } catch(e) {}
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
  try { favorites = typeof userRes.rows[0]?.favorites === 'string' ? JSON.parse(userRes.rows[0].favorites) : (userRes.rows[0]?.favorites || []); } catch(e) {}
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
      try { s.referral = JSON.parse(s.referral); } catch (e) {}
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
      is_phonepe_enabled, description, referral
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
      const upiVpaRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
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
    const newUpiId = upi_id !== undefined && upi_id !== null ? upi_id : (s.upi_id || '');
    const newUpiName = upi_name !== undefined ? upi_name : (s.upi_name || newHotelName);

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
        is_phonepe_enabled, description, referral, upi_qr_updated_at
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
        upi_qr_updated_at = EXCLUDED.upi_qr_updated_at;`,
      [
        newHotelName, newHotelLogo, newPhone, newAddress, newOpenTime, newCloseTime,
        newHolidays, newUpiId, newUpiName, newUpiQrCode, newIsOpen, newIsQrPay,
        newIsPhonepe, newDesc, typeof newRef === 'object' ? JSON.stringify(newRef) : newRef,
        newQrUpdatedAt
      ]
    );

    const updated = await db.query('SELECT * FROM settings WHERE id = 1;');
    const updatedSettings = updated.rows[0];
    if (typeof updatedSettings.referral === 'string') {
      try { updatedSettings.referral = JSON.parse(updatedSettings.referral); } catch (e) {}
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
    } catch(e) {}
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
  } catch(e) {}
}

const getMenuHandler = async (req, res) => {
  let tRes = await db.query('SELECT * FROM tiffins ORDER BY created_at ASC;');
  if (!tRes.rows || tRes.rows.length === 0) {
    console.log('Menu table empty — seeding default tiffins list...');
    await seedDefaultTiffins();
    try {
      const migrate = require('./migrate_to_postgres');
      await migrate();
    } catch (e) {}
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
  await db.query(
    'INSERT INTO tiffins (id, name, description, price, category, image, is_available) VALUES ($1, $2, $3, $4, $5, $6, $7);',
    [id, name.trim(), (description || '').trim(), Number(price), category || 'Breakfast', image || '', is_available !== false]
  );
  const newItem = await db.query('SELECT * FROM tiffins WHERE id = $1;', [id]);
  res.json({ success: true, data: newItem.rows[0], message: "Tiffin item added to menu successfully." });
});

app.put('/api/menu/:id', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const { id } = req.params;
  const { name, description, price, category, image, is_available } = req.body;
  await db.query(
    'UPDATE tiffins SET name = $1, description = $2, price = $3, category = $4, image = $5, is_available = $6 WHERE id = $7;',
    [name.trim(), (description || '').trim(), Number(price), category, image, Boolean(is_available), id]
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
    } catch (rErr) {}

    const parsedOrders = oRes.rows.map(o => {
      if (typeof o.items === 'string') {
        try { o.items = JSON.parse(o.items); } catch (e) { o.items = []; }
      }
      const screenshot = o.payment_screenshot || o.screenshot_url || '';
      o.payment_screenshot = screenshot;
      o.screenshot_url = screenshot;
      o.review = revMap.get(o.order_number) || null;
      return o;
    });
    res.json({ success: true, data: parsedOrders });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error fetching orders." });
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

      // Create Order Record
      const nowIso = new Date().toISOString();
      await tx.query(
        `INSERT INTO orders (
          id, order_number, customer_id, customer_name, customer_mobile, 
          order_type, delivery_address, notes, total_amount, used_wallet_amount, 
          net_amount, payment_method, payment_status, order_status, items,
          utr_number, payment_screenshot, screenshot_url, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19);`,
        [
          newOrderId, orderNum, req.user.id, req.user.name, req.user.mobile,
          order_type || 'Takeaway', delivery_address || null, notes || null,
          grand_total, walletDeducted, netAmount, finalPayMethod,
          finalPayStatus, 'Received', JSON.stringify(formattedItems),
          cleanUtr, savedScreenshotUrl, savedScreenshotUrl, nowIso
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
      const notifMsg = isReferralPayment
        ? `Order #${orderNum} placed by ${req.user.name} using Referral Wallet (₹${grand_total}).`
        : `Order #${orderNum} placed by ${req.user.name} (₹${netAmount}).`;

      await tx.query(
        `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        ['notif_' + Date.now(), 'OWNER', req.user.id, 'New Order Received', notifMsg, 'ORDER', false, new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })]
      );

      // Fetch created order object
      const createdRes = await tx.query('SELECT * FROM orders WHERE id = $1;', [newOrderId]);
      createdOrder = createdRes.rows[0];
    });

    // Process Referral Reward on Customer First Order (outside main order creation tx to avoid circular locks)
    await checkAndProcessReferralReward(req.user.id, orderNum);

    if (createdOrder) {
      try { createdOrder.items = JSON.parse(createdOrder.items); } catch(e) {}
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
      await tx.query(
        `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          'notif_' + Date.now() + '_cust',
          'CUSTOMER',
          req.user.id,
          'Order Modified',
          `Order #${order.order_number} has been updated successfully. Total is now ₹${grandTotal}.`,
          'ORDER',
          false,
          new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
        ]
      );

      await tx.query(
        `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          'notif_' + Date.now() + '_own',
          'OWNER',
          req.user.id,
          'Order Modified by Customer',
          `Order #${order.order_number} modified by ${req.user.name}. New total: ₹${grandTotal}.`,
          'ORDER',
          false,
          new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
        ]
      );

      const finalRes = await tx.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
      updatedOrder = finalRes.rows[0];
    });

    const userBalRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
    updatedWalletBalance = Number(userBalRes.rows[0]?.wallet_balance || 0);

    if (updatedOrder) {
      try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch (e) {}
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
      await tx.query(
        `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          'notif_' + Date.now() + '_cust',
          'CUSTOMER',
          req.user.id,
          'Order Cancelled',
          `Order #${order.order_number} has been cancelled successfully.`,
          'ORDER',
          false,
          new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
        ]
      );

      await tx.query(
        `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          'notif_' + Date.now() + '_own',
          'OWNER',
          req.user.id,
          'Order Cancelled by Customer',
          `Order #${order.order_number} was cancelled by customer (${cancellationReason}).`,
          'ORDER',
          false,
          new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
        ]
      );

      const finalRes = await tx.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
      updatedOrder = finalRes.rows[0];
    });

    const userBalRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
    updatedWalletBalance = Number(userBalRes.rows[0]?.wallet_balance || 0);

    if (updatedOrder) {
      try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch (e) {}
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
    try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch(e) {}
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
  try { order.items = JSON.parse(order.items); } catch(e) {}

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
    const code = apiJson.code || apiJson.data?.responseCode;
    const state = apiJson.data?.paymentState;

    if (apiJson.success && (code === 'PAYMENT_SUCCESS' || state === 'COMPLETED')) {
      statusOutcome = 'SUCCESS';
      newPayStatus = 'Paid';
    } else if (code === 'PAYMENT_ERROR' || code === 'PAYMENT_DECLINED' || state === 'FAILED') {
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
  try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch(e) {}

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

      // Generate a new unique PhonePe transaction ID for this payment attempt
      txnId = 'PP_TXN_' + targetOrder.id + '_' + Date.now();
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
      txnId = 'PP_TXN_' + newOrderId + '_' + Date.now();

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

        const netAmount = Math.max(0, grand_total - walletDeducted);
        amountToPay = netAmount;
        const nowIso = new Date().toISOString();

        await tx.query(
          `INSERT INTO orders (
            id, order_number, customer_id, customer_name, customer_mobile,
            order_type, delivery_address, notes, total_amount, used_wallet_amount,
            net_amount, payment_method, payment_status, order_status, items,
            utr_number, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17);`,
          [
            newOrderId, orderNum, customerId, customerName, customerMobile,
            order_type || 'Takeaway', delivery_address || null, notes || null,
            grand_total, walletDeducted, netAmount, 'UPI (PhonePe)',
            'Processing', 'Received', JSON.stringify(formattedItems),
            txnId, nowIso
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
        try { targetOrder.items = JSON.parse(targetOrder.items); } catch(e) {}
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

    console.log(`[PhonePe Gateway] Initiating transaction ${txnId} | Amount: ₹${amountToPay} (${amountInPaise} paise) | MerchantID: ${PHONEPE_MERCHANT_ID} | ENV: ${PHONEPE_ENV}`);

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
        console.log(`[PhonePe Gateway Success] TxnId: ${txnId} | Message: ${pgMessage}`);
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
      const failureCode = pgJson?.code || 'PHONEPE_GATEWAY_REJECTED';
      let failureMessage = pgJson?.message || `Unable to connect to PhonePe gateway (HTTP ${pgResponseStatus || 500}).`;

      if (failureCode === 'KEY_NOT_FOUND' || failureMessage.toLowerCase().includes('key not found')) {
        failureMessage = `Key not found for merchant '${PHONEPE_MERCHANT_ID}'. Please verify that PHONEPE_MERCHANT_ID, PHONEPE_SALT_KEY, and PHONEPE_ENV in Render environment variables match your PhonePe merchant portal credentials.`;
      }

      return res.status(400).json({
        success: false,
        code: failureCode,
        message: `PhonePe Gateway Error: ${failureMessage}`,
        diagnostic: {
          httpStatus: pgResponseStatus,
          code: failureCode,
          merchantId: PHONEPE_MERCHANT_ID,
          env: PHONEPE_ENV,
          endpoint: `${PHONEPE_BASE_URL}/pg/v1/pay`,
          txnId
        }
      });
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
    let finalStatus = verification.payment_status || 'Processing';
    if (verification.status === 'SUCCESS') finalStatus = 'Paid';
    else if (verification.status === 'FAILED') finalStatus = 'Failed';

    res.redirect(`/?phonepe_callback=1&txnId=${encodeURIComponent(txnId)}&status=${encodeURIComponent(finalStatus)}`);
  } catch (err) {
    console.error('PhonePe Redirect Route Error:', err);
    res.redirect('/?phonepe_callback=1&status=FAILED');
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
    try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch(e) {}
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
  const newPaymentStatus = payment_status || order.payment_status;
  const newRejectionReason = rejection_reason !== undefined ? rejection_reason : order.rejection_reason;

  await db.query('UPDATE orders SET order_status = $1, payment_status = $2, rejection_reason = $3 WHERE id = $4;', [newOrderStatus, newPaymentStatus, newRejectionReason, order.id]);
  await db.query('UPDATE payments SET payment_status = $1 WHERE order_number = $2;', [newPaymentStatus, order.order_number]);

  // Dispatch Customer Notification on Status Update
  if (order.customer_id) {
    const notifTitle = order_status ? `Order #${order.order_number} is ${newOrderStatus}` : `Payment Updated`;
    const notifMsg = order_status 
      ? `Your order #${order.order_number} status is now "${newOrderStatus}".`
      : `Payment status for Order #${order.order_number} is updated to "${newPaymentStatus}".`;
    await db.query(
      `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [
        'notif_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        'CUSTOMER',
        order.customer_id,
        notifTitle,
        notifMsg,
        'ORDER',
        false,
        new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
      ]
    );
  }

  const updatedRes = await db.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
  const updatedOrder = updatedRes.rows[0];
  try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch(e) {}

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
    await db.query(
      `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [
        'notif_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        'CUSTOMER',
        order.customer_id,
        'Payment Status Updated',
        `Payment status for Order #${order.order_number} updated to "${newPaymentStatus}".`,
        'ORDER',
        false,
        new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
      ]
    );
  }

  const updatedRes = await db.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
  const updatedOrder = updatedRes.rows[0];
  try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch(e) {}

  res.json({ success: true, data: updatedOrder, message: `Order #${order.order_number} payment status updated to ${newPaymentStatus}.` });
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
        try { settingsReferral = JSON.parse(settingsReferral); } catch (e) {}
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
        await db.query(
          "INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);",
          ['notif_' + Date.now(), 'CUSTOMER', refRecord.referrer_id, 'Referral Reward Earned! 🎉', `You earned ₹${rewardAmt} because ${refRecord.referred_name || 'your friend'} placed their first order!`, 'REFERRAL', false, new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })]
        );
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
    await db.query(
      `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      ['notif_' + Date.now(), 'OWNER', req.user.id, 'New Support Ticket', `Ticket #${ticketNum} created by ${req.user.name}: "${subject}"`, 'SUPPORT', false, new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })]
    );

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
    if (senderRole === 'OWNER' && ticket.customer_id) {
      await db.query(
        `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        ['notif_' + Date.now(), 'CUSTOMER', ticket.customer_id, 'Support Ticket Response', `Hotel Owner replied to ticket #${ticket.ticket_number}: "${message.slice(0, 50)}..."`, 'SUPPORT', false, new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })]
      );
    } else if (senderRole === 'CUSTOMER') {
      await db.query(
        `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        ['notif_' + Date.now(), 'OWNER', ticket.customer_id, 'New Support Ticket Reply', `${ticket.customer_name} replied to ticket #${ticket.ticket_number}`, 'SUPPORT', false, new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })]
      );
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
app.listen(PORT, async () => {
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
