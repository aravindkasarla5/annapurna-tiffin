const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  
  await db.query(
    'INSERT INTO tokens (token, user_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (token) DO UPDATE SET role = EXCLUDED.role;',
    [token, userId, userRole, Date.now()]
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
        await db.query(
          'INSERT INTO tokens (token, user_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (token) DO NOTHING;',
          [token, matchingUser.id, matchingUser.role, Date.now()]
        );
        tokenEntry = { token, user_id: matchingUser.id, role: matchingUser.role };
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
    return uNorm && uNorm === normPhone;
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

    // Handle Referral Code if provided
    const rawRefCode = (req.body.referral_code || '').toString().trim().toUpperCase().replace(/\s+/g, '');
    let refMessage = '';

    if (rawRefCode) {
      const refUserRes = await db.query('SELECT * FROM users WHERE UPPER(referral_code) = $1 AND role = $2;', [rawRefCode, 'CUSTOMER']);
      const referrer = refUserRes.rows[0];

      if (referrer) {
        if (referrer.id === newUser.id || referrer.mobile === cleanMobile) {
          return res.status(400).json({ success: false, message: "Self-referral is not allowed." });
        }
        newUser.referred_by = referrer.id;
        newUser.referred_by_code = referrer.referral_code;

        const settingsRes = await db.query('SELECT referral FROM settings WHERE id = 1;');
        const settingsReferral = settingsRes.rows[0]?.referral || {};
        const rewardVal = Number(settingsReferral.referrer_reward || 30);

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
      } else {
        return res.status(400).json({ success: false, message: "Invalid referral code. Please check and try again." });
      }
    }

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
      return res.json({ success: true, settings: {} });
    }
    const s = sRes.rows[0];
    if (typeof s.referral === 'string') {
      try { s.referral = JSON.parse(s.referral); } catch (e) {}
    }
    res.json({ success: true, settings: s });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch settings." });
  }
});

app.put('/api/settings', authenticateToken, requireRole('OWNER'), async (req, res) => {
  try {
    const sRes = await db.query('SELECT * FROM settings WHERE id = 1;');
    const s = sRes.rows[0] || {};

    const {
      hotel_name, hotel_logo, phone, address, open_time, close_time,
      holidays, upi_id, upi_name, upi_qr_code, is_open, is_qr_pay_enabled,
      is_phonepe_enabled, description, referral
    } = req.body;

    const newHotelName = hotel_name !== undefined ? hotel_name : s.hotel_name;
    const newHotelLogo = hotel_logo !== undefined ? hotel_logo : s.hotel_logo;
    const newPhone = phone !== undefined ? phone : s.phone;
    const newAddress = address !== undefined ? address : s.address;
    const newOpenTime = open_time !== undefined ? open_time : s.open_time;
    const newCloseTime = close_time !== undefined ? close_time : s.close_time;
    const newHolidays = holidays !== undefined ? holidays : s.holidays;
    const newUpiId = upi_id !== undefined ? upi_id : s.upi_id;
    const newUpiName = upi_name !== undefined ? upi_name : s.upi_name;
    const newUpiQrCode = upi_qr_code !== undefined ? upi_qr_code : s.upi_qr_code;
    const newIsOpen = is_open !== undefined ? Boolean(is_open) : s.is_open;
    const newIsQrPay = is_qr_pay_enabled !== undefined ? Boolean(is_qr_pay_enabled) : s.is_qr_pay_enabled;
    const newIsPhonepe = is_phonepe_enabled !== undefined ? Boolean(is_phonepe_enabled) : s.is_phonepe_enabled;
    const newDesc = description !== undefined ? description : s.description;

    let newRef = s.referral;
    if (referral) {
      let existingRef = typeof s.referral === 'string' ? JSON.parse(s.referral) : (s.referral || {});
      newRef = { ...existingRef, ...referral };
    }

    await db.query(
      `INSERT INTO settings (
        id, hotel_name, hotel_logo, phone, address, open_time, close_time, 
        holidays, upi_id, upi_name, upi_qr_code, is_open, is_qr_pay_enabled, 
        is_phonepe_enabled, description, referral
      ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
        referral = EXCLUDED.referral;`,
      [
        newHotelName, newHotelLogo, newPhone, newAddress, newOpenTime, newCloseTime,
        newHolidays, newUpiId, newUpiName, newUpiQrCode, newIsOpen, newIsQrPay,
        newIsPhonepe, newDesc, JSON.stringify(newRef)
      ]
    );

    const updated = await db.query('SELECT * FROM settings WHERE id = 1;');
    res.json({ success: true, settings: updated.rows[0], message: "Business settings updated successfully." });
  } catch (err) {
    console.error('Update Settings Error:', err);
    res.status(500).json({ success: false, message: "Failed to save settings." });
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

app.get('/api/menu', async (req, res) => {
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
});

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
    const parsedOrders = oRes.rows.map(o => {
      if (typeof o.items === 'string') {
        try { o.items = JSON.parse(o.items); } catch (e) { o.items = []; }
      }
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

    const { order_type, delivery_address, notes, payment_method, items, used_wallet_amount } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({ success: false, message: "Ordered items are required." });
    }

    if ((payment_method === 'UPI (QR Pay)' || payment_method === 'UPI') && settings.is_qr_pay_enabled === false) {
      return res.status(400).json({ success: false, message: "QR Pay is currently disabled by hotel owner." });
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

    // Handle Wallet Balance Redemption
    let walletDeducted = 0;
    const userRes = await db.query('SELECT wallet_balance FROM users WHERE id = $1;', [req.user.id]);
    const currentWallet = Number(userRes.rows[0]?.wallet_balance || 0);

    if (used_wallet_amount && Number(used_wallet_amount) > 0) {
      walletDeducted = Math.min(currentWallet, Number(used_wallet_amount), grand_total);
      if (walletDeducted > 0) {
        const remainingBal = currentWallet - walletDeducted;
        await db.query('UPDATE users SET wallet_balance = $1 WHERE id = $2;', [remainingBal, req.user.id]);
        await db.query(
          'INSERT INTO wallet_transactions (id, user_id, amount, type, description, date_time) VALUES ($1, $2, $3, $4, $5, $6);',
          ['wtx_' + Date.now(), req.user.id, walletDeducted, 'DEBIT', `Redeemed on Order #${orderNum}`, new Date().toLocaleString('en-IN')]
        );
      }
    }

    const netAmount = Math.max(0, grand_total - walletDeducted);
    const newOrderId = 'ord_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

    await db.query(
      `INSERT INTO orders (
        id, order_number, customer_id, customer_name, customer_mobile, 
        order_type, delivery_address, notes, total_amount, used_wallet_amount, 
        net_amount, payment_method, payment_status, order_status, items
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15);`,
      [
        newOrderId, orderNum, req.user.id, req.user.name, req.user.mobile,
        order_type || 'Takeaway', delivery_address || null, notes || null,
        grand_total, walletDeducted, netAmount, payment_method || 'Cash',
        payment_method === 'Cash' ? 'Pending' : 'Pending', 'Received', JSON.stringify(formattedItems)
      ]
    );

    // Create Payment Record
    const newPayId = 'pay_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    await db.query(
      `INSERT INTO payments (id, order_number, customer_id, customer_name, customer_mobile, amount, payment_method, payment_status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [newPayId, orderNum, req.user.id, req.user.name, req.user.mobile, netAmount, payment_method || 'Cash', 'Pending', `Payment for Order #${orderNum}`]
    );

    // Notify Owner
    await db.query(
      `INSERT INTO notifications (id, target_role, customer_id, title, message, type, is_read, date_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      ['notif_' + Date.now(), 'OWNER', req.user.id, 'New Order Received', `Order #${orderNum} placed by ${req.user.name} (₹${netAmount}).`, 'ORDER', false, new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })]
    );

    const createdRes = await db.query('SELECT * FROM orders WHERE id = $1;', [newOrderId]);
    const createdOrder = createdRes.rows[0];
    try { createdOrder.items = JSON.parse(createdOrder.items); } catch(e) {}

    res.json({
      success: true,
      data: createdOrder,
      message: `Order #${orderNum} placed successfully!`
    });
  } catch (err) {
    console.error('Order Creation Error:', err);
    res.status(500).json({ success: false, message: "Database server error creating order." });
  }
});

app.patch('/api/orders/:id/status', authenticateToken, requireRole('OWNER'), async (req, res) => {
  const { id } = req.params;
  const { order_status, payment_status } = req.body;

  const oRes = await db.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1;', [id]);
  const order = oRes.rows[0];
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found." });
  }

  const newOrderStatus = order_status || order.order_status;
  const newPaymentStatus = payment_status || order.payment_status;

  await db.query('UPDATE orders SET order_status = $1, payment_status = $2 WHERE id = $3;', [newOrderStatus, newPaymentStatus, order.id]);
  await db.query('UPDATE payments SET payment_status = $1 WHERE order_number = $2;', [newPaymentStatus, order.order_number]);

  const updatedRes = await db.query('SELECT * FROM orders WHERE id = $1;', [order.id]);
  const updatedOrder = updatedRes.rows[0];
  try { updatedOrder.items = JSON.parse(updatedOrder.items); } catch(e) {}

  res.json({ success: true, data: updatedOrder, message: `Order #${order.order_number} status updated to ${newOrderStatus}.` });
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
  res.json({ success: true, data: pRes.rows });
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
  const allOrders = ordersRes.rows;

  const validOrders = allOrders.filter(o => !['Rejected', 'Cancelled'].includes(o.order_status));
  const totalRevenue = validOrders.reduce((sum, o) => sum + Number(o.net_amount || 0), 0);
  const usersRes = await db.query("SELECT COUNT(*) FROM users WHERE role = 'CUSTOMER';");

  res.json({
    success: true,
    data: {
      total_revenue: totalRevenue,
      total_orders: allOrders.length,
      active_orders: allOrders.filter(o => ['Received', 'Preparing', 'Ready'].includes(o.order_status)).length,
      completed_orders: allOrders.filter(o => o.order_status === 'Completed').length,
      total_customers: Number(usersRes.rows[0]?.count || 0)
    }
  });
});

// =========================================================================
// NOTIFICATIONS API
// =========================================================================

app.get('/api/notifications', authenticateToken, async (req, res) => {
  let queryStr = "SELECT * FROM notifications WHERE target_role = 'OWNER' ORDER BY created_at DESC;";
  let params = [];
  if (req.user.role === 'CUSTOMER') {
    queryStr = "SELECT * FROM notifications WHERE target_role = 'CUSTOMER' AND (customer_id = $1 OR customer_id IS NULL) ORDER BY created_at DESC;";
    params = [req.user.id];
  }
  const nRes = await db.query(queryStr, params);
  res.json({ success: true, data: nRes.rows });
});

app.patch('/api/notifications/read-all', authenticateToken, async (req, res) => {
  if (req.user.role === 'CUSTOMER') {
    await db.query("UPDATE notifications SET is_read = true WHERE target_role = 'CUSTOMER' AND (customer_id = $1 OR customer_id IS NULL);", [req.user.id]);
  } else {
    await db.query("UPDATE notifications SET is_read = true WHERE target_role = 'OWNER';");
  }
  res.json({ success: true, message: "Notifications marked as read." });
});

// Catch-all SPA route to serve index.html for root and client routes
app.get('*', (req, res) => {
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
