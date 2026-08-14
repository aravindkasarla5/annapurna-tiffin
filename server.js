const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Default Initial Database Seed Data (No Demo Customer Data in Production)
const defaultSeed = {
  users: [
    {
      id: "usr_owner_1",
      name: "Lakshmi Narayana (Owner)",
      mobile: "9392874900",
      password: "9392874900",
      role: "OWNER",
      email: "owner@annapurna.com",
      address: "#42, Temple Road, Bengaluru, KA"
    }
  ],
  settings: {
    hotel_name: "Sri Lakshmi Annapurna Tiffin Center",
    hotel_logo: "/images/tiffin_logo.png",
    phone: "+91 9392874900",
    address: "#42, Temple Road, Near Gandhi Circle, Bengaluru, KA",
    open_time: "06:30 AM",
    close_time: "10:30 PM",
    holidays: "None (Open 7 Days)",
    upi_id: "annapurna.tiffin@upi",
    upi_name: "Annapurna Tiffin Center",
    is_open: true,
    is_qr_pay_enabled: true,
    is_phonepe_enabled: true,
    description: "Fresh, hot, and authentic South Indian tiffins served daily with traditional family love.",
    referral: {
      enabled: true,
      referrer_reward: 30,
      new_customer_discount: 30,
      min_order_value: 150,
      monthly_limit: 500,
      milestones: [
        { count: 1, bonus: 0 },
        { count: 5, bonus: 100 },
        { count: 10, bonus: 250 }
      ]
    }
  },
  tiffins: [
    {
      id: "tf_1",
      name: "Idly (4 Pieces)",
      description: "Steaming soft rice cakes served with hot sambar and freshly ground coconut chutney.",
      price: 40,
      category: "Breakfast",
      image: "/images/idly_sambar.png",
      is_available: true
    },
    {
      id: "tf_2",
      name: "Medu Vada (2 Pieces)",
      description: "Crispy fried lentil doughnuts seasoned with pepper, curry leaves, served with chutneys.",
      price: 45,
      category: "Breakfast",
      image: "/images/medu_vada.png",
      is_available: true
    },
    {
      id: "tf_3",
      name: "Masala Dosa",
      description: "Golden crispy crepe smeared with red chutney and stuffed with spiced potato masala.",
      price: 70,
      category: "Breakfast",
      image: "/images/masala_dosa.png",
      is_available: true
    },
    {
      id: "tf_4",
      name: "Puri Sagu (3 Pieces)",
      description: "Fluffy puffed fried puri served with aromatic spicy potato and vegetable sagu curry.",
      price: 60,
      category: "Breakfast",
      image: "/images/puri_sagu.png",
      is_available: true
    },
    {
      id: "tf_5",
      name: "Ghee Ven Pongal",
      description: "Classic rice and moong dal porridge tempered with pure ghee, cashews, cumin, and pepper.",
      price: 55,
      category: "Breakfast",
      image: "https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?auto=format&fit=crop&w=500&q=80",
      is_available: true
    },
    {
      id: "tf_6",
      name: "Hot Rava Upma",
      description: "Savory roasted semolina cooked with mustard seeds, veggies, cashews, served with coconut chutney.",
      price: 35,
      category: "Breakfast",
      image: "https://images.unsplash.com/photo-1589301760014-d929f3979dbc?auto=format&fit=crop&w=500&q=80",
      is_available: true
    },
    {
      id: "tf_7",
      name: "Plain Dosa",
      description: "Thin and crispy South Indian rice crepe served with flavorful sambar and 2 chutneys.",
      price: 50,
      category: "Breakfast",
      image: "https://images.unsplash.com/photo-1668236543090-82eba5ee5976?auto=format&fit=crop&w=500&q=80",
      is_available: true
    },
    {
      id: "tf_8",
      name: "South Indian Mini Meals",
      description: "Authentic thali platter with Steamed Rice, Sambar, Rasam, Vegetable Poriyal, Curd, Papad, and Payasam.",
      price: 110,
      category: "Lunch",
      image: "/images/south_indian_meals.png",
      is_available: true
    },
    {
      id: "tf_9",
      name: "Tangy Lemon Rice",
      description: "Fragrant rice tossed with fresh lemon juice, crunchy peanuts, curry leaves, and green chillies.",
      price: 45,
      category: "Lunch",
      image: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=500&q=80",
      is_available: true
    },
    {
      id: "tf_10",
      name: "Seasoned Curd Rice",
      description: "Cooling soothing curd rice tempered with mustard, pomegranates, green chillies, and ginger.",
      price: 50,
      category: "Lunch",
      image: "https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?auto=format&fit=crop&w=500&q=80",
      is_available: true
    },
    {
      "id": "tf_11",
      "name": "Spicy Tomato Rice",
      "description": "Flavorful spicy tomato cooked rice infused with South Indian spices, served with onion raita.",
      "price": 50,
      "category": "Lunch",
      "image": "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=500&q=80",
      "is_available": true
    },
    {
      "id": "tf_12",
      "name": "Chapati (2 Pieces + Kurma)",
      "description": "Soft whole wheat chapatis served with aromatic mixed vegetable spicy kurma curry.",
      "price": 50,
      "category": "Dinner",
      "image": "https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?auto=format&fit=crop&w=500&q=80",
      "is_available": true
    }
  ],
  orders: [],
  payments: [],
  notifications: [],
  order_counter: 1001,
  ticket_counter: 1001,
  faqs: [
    {
      id: "faq_1",
      category: "Ordering & Pickup",
      question: "What are your operating hours for fresh tiffins?",
      answer: "Our kitchen opens early at 06:30 AM every morning serving steaming hot tiffins, and remains open until 10:30 PM, 7 days a week including public holidays."
    },
    {
      id: "faq_2",
      category: "Ordering & Pickup",
      question: "How do I place a takeaway or dine-in order?",
      answer: "Simply select your items from our menu, add to cart, select Takeaway or Dine-in, choose your payment method (UPI/Cash), and place your order. You can track order status live in real-time!"
    },
    {
      id: "faq_3",
      category: "Payments & Refunds",
      question: "What payment methods do you accept?",
      answer: "We accept Google Pay, PhonePe, Paytm, BHIM UPI payments directly to our UPI ID (annapurna.tiffin@upi) as well as Cash on pickup or dine-in."
    },
    {
      id: "faq_4",
      category: "Payments & Refunds",
      question: "What happens if my payment succeeded but order status is pending?",
      answer: "Our system automatically syncs payments within a few seconds. If any issue occurs, simply click 'Raise Support Ticket' with your Order ID, or call our support helpline (+91 9392874900)."
    },
    {
      id: "faq_5",
      category: "Food Quality & Customization",
      question: "Can I request extra sambar, chutneys, or mild spice levels?",
      answer: "Yes! When placing your order, enter your special instructions in the 'Order Notes' field (e.g. 'Pack extra coconut chutney', 'Make dosa extra crispy', 'Less spicy sagu')."
    },
    {
      id: "faq_6",
      category: "Bulk & Catering Orders",
      question: "Do you accept catering for family functions, office breakfast, or events?",
      answer: "Yes, we specialize in bulk tiffin boxes and party catering for 10 to 500+ guests with pure ghee South Indian delicacies. Submit a inquiry ticket under 'Bulk & Catering Inquiry' or call us directly."
    }
  ],
  support_tickets: [],
  referrals: [],
  wallet_transactions: [],
  reviews: [],
  tokens: {}
};

// Database Initialization & JSON persistence helper
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    console.log('db.json not found — creating fresh database from seed data...');
    saveDB(defaultSeed);
    return JSON.parse(JSON.stringify(defaultSeed));
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    const db = { ...defaultSeed, ...data };
    if (!db.users || !db.users.length) db.users = defaultSeed.users;
    if (!db.faqs || !db.faqs.length) db.faqs = defaultSeed.faqs;
    if (!db.tiffins || !db.tiffins.length) db.tiffins = defaultSeed.tiffins;
    if (!db.orders) db.orders = [];
    if (!db.payments) db.payments = [];
    if (!db.notifications) db.notifications = [];
    if (!db.support_tickets) db.support_tickets = [];
    if (!db.referrals) db.referrals = [];
    if (!db.wallet_transactions) db.wallet_transactions = [];
    if (!db.reviews) db.reviews = [];
    if (!db.tokens) db.tokens = {};
    if (!db.order_counter) db.order_counter = 1001;
    if (!db.ticket_counter) db.ticket_counter = 1001;
    if (!db.settings.referral) db.settings.referral = defaultSeed.settings.referral;
    if (typeof db.settings.is_qr_pay_enabled === 'undefined') db.settings.is_qr_pay_enabled = true;
    if (typeof db.settings.is_phonepe_enabled === 'undefined') db.settings.is_phonepe_enabled = true;
    return db;
  } catch (err) {
    console.error('Error reading db.json, resetting to seed:', err);
    saveDB(defaultSeed);
    return JSON.parse(JSON.stringify(defaultSeed));
  }
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving db.json:', err);
  }
}

// 30 Minutes Inactivity Timeout for all users (Customer & Owner)
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Generate Auth Token Helper
function generateToken(userId, role = 'CUSTOMER') {
  const db = loadDB();
  const user = (db.users || []).find(u => u.id === userId);
  const userRole = user ? user.role : role;
  const token = 'tok_' + userId + '_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  if (!db.tokens) db.tokens = {};
  db.tokens[token] = {
    user_id: userId,
    role: userRole,
    created_at: Date.now(),
    last_activity: Date.now()
  };
  saveDB(db);
  return token;
}

// Authentication Middleware
function authenticateToken(req, res, next) {
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

  const db = loadDB();
  const tokenEntry = db.tokens ? db.tokens[token] : null;

  if (!tokenEntry) {
    return res.status(401).json({ success: false, expired: true, message: "Your session has expired. Please log in again." });
  }

  const userId = typeof tokenEntry === 'string' ? tokenEntry : tokenEntry.user_id;

  const user = (db.users || []).find(u => u.id === userId);
  if (!user) {
    if (db.tokens && db.tokens[token]) {
      delete db.tokens[token];
      saveDB(db);
    }
    return res.status(401).json({ success: false, message: "User account not found." });
  }

  // Enforce session expiration for ALL logged in users (Customer & Owner)
  const lastActivity = (typeof tokenEntry === 'object' && tokenEntry.last_activity) ? tokenEntry.last_activity : Date.now();
  const isBackgroundPoll = req.headers['x-background-poll'] === 'true';
  const idleDuration = Date.now() - lastActivity;

  if (idleDuration > SESSION_TIMEOUT_MS) {
    delete db.tokens[token];
    saveDB(db);
    return res.status(401).json({
      success: false,
      expired: true,
      message: "Your session has expired. Please log in again."
    });
  }

  // Update last_activity ONLY for user-initiated non-polling requests
  if (!isBackgroundPoll) {
    if (typeof tokenEntry === 'object') {
      tokenEntry.last_activity = Date.now();
    } else {
      db.tokens[token] = {
        user_id: userId,
        role: user.role,
        created_at: Date.now(),
        last_activity: Date.now()
      };
    }
    saveDB(db);
  }

  req.user = user;
  req.token = token;
  next();
}

// Optional Auth Middleware (attaches req.user if token provided)
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const tokenHeader = req.headers['x-auth-token'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (tokenHeader) {
    token = tokenHeader;
  }

  if (token) {
    const db = loadDB();
    const tokenEntry = db.tokens ? db.tokens[token] : null;
    if (tokenEntry) {
      const userId = typeof tokenEntry === 'string' ? tokenEntry : tokenEntry.user_id;
      const user = (db.users || []).find(u => u.id === userId);
      if (user) {
        const lastActivity = (typeof tokenEntry === 'object' && tokenEntry.last_activity) ? tokenEntry.last_activity : Date.now();
        const idleDuration = Date.now() - lastActivity;
        if (idleDuration > SESSION_TIMEOUT_MS) {
          delete db.tokens[token];
          saveDB(db);
          return next();
        }
        if (req.headers['x-background-poll'] !== 'true') {
          if (typeof tokenEntry === 'object') {
            tokenEntry.last_activity = Date.now();
          } else {
            db.tokens[token] = {
              user_id: userId,
              role: user.role,
              created_at: Date.now(),
              last_activity: Date.now()
            };
          }
          saveDB(db);
        }
        req.user = user;
        req.token = token;
      }
    }
  }
  next();
}

// Role Authorization Middleware
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    if (req.user.role !== role) {
      return res.status(403).json({ success: false, message: `Access denied. ${role} permissions required.` });
    }
    next();
  };
}

// Sanitize User Object for Client
function sanitizeUser(user) {
  const userSafe = { ...user };
  delete userSafe.password;
  if (!userSafe.cart) userSafe.cart = [];
  if (!userSafe.favorites) userSafe.favorites = [];
  if (userSafe.loyalty_points === undefined) userSafe.loyalty_points = 0;
  return userSafe;
}

// =========================================================================
// REST API ROUTES
// =========================================================================

function normalizePhone(phone) {
  if (!phone) return '';
  let digits = phone.toString().replace(/[^0-9]/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

// AUTH 1. Register New Customer
app.post('/api/auth/register', (req, res) => {
  const db = loadDB();
  const { name, mobile, password, email, address } = req.body;

  if (!name || !mobile || !password) {
    return res.status(400).json({ success: false, message: "Name, mobile, and password are required." });
  }

  if (req.body.role === 'OWNER') {
    return res.status(400).json({ success: false, message: "Owner registration is not allowed. Single owner account is maintained." });
  }

  const cleanMobile = normalizePhone(mobile);

  if (cleanMobile === '9392874900') {
    return res.status(400).json({ success: false, message: "This mobile number is reserved for Hotel Owner. Please login." });
  }

  const existing = (db.users || []).find(u => normalizePhone(u.mobile) === cleanMobile);
  if (existing) {
    return res.status(400).json({ success: false, message: "Mobile number already registered. Please login." });
  }

  // Generate Unique Referral Code for Customer
  const namePrefix = name.trim().replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5) || 'TIFFIN';
  const randomNum = Math.floor(10 + Math.random() * 90);
  const generatedRefCode = `${namePrefix}${randomNum}`;

  const newUserId = 'usr_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const newUser = {
    id: newUserId,
    name: name.trim(),
    mobile: cleanMobile || mobile.trim(),
    password: password.trim(),
    role: 'CUSTOMER',
    email: (email || '').trim(),
    address: (address || '').trim(),
    referral_code: generatedRefCode,
    referred_by: null,
    wallet_balance: 0,
    loyalty_points: 0,
    cart: [],
    favorites: [],
    show_on_leaderboard: true,
    created_at: new Date().toISOString()
  };

  // Handle Referral Code submitted during registration
  const rawRefCode = (req.body.referral_code || '').toString().trim();
  const submittedRefCode = rawRefCode.toUpperCase().replace(/\s+/g, '');
  let refMessage = '';

  if (submittedRefCode) {
    const referrer = (db.users || []).find(u => 
      u.role === 'CUSTOMER' && 
      u.referral_code && 
      u.referral_code.toString().trim().toUpperCase().replace(/\s+/g, '') === submittedRefCode
    );

    if (referrer) {
      if (referrer.id === newUser.id || normalizePhone(referrer.mobile) === cleanMobile) {
        return res.status(400).json({ success: false, message: "Self-referral is not allowed." });
      }
      newUser.referred_by = referrer.id;
      newUser.referred_by_code = referrer.referral_code;

      const rewardVal = Number(db.settings.referral?.referrer_reward || 30);
      if (!db.referrals) db.referrals = [];
      db.referrals.unshift({
        id: 'ref_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        referrer_id: referrer.id,
        referrer_mobile: referrer.mobile,
        referrer_name: referrer.name,
        referred_id: newUser.id,
        referred_mobile: newUser.mobile,
        referred_name: newUser.name,
        order_number: null,
        status: 'Pending',
        reward_amount: rewardVal,
        date_time: new Date().toLocaleString('en-IN'),
        created_at: new Date().toISOString()
      });
      refMessage = ` ₹${rewardVal} first-order referral linked successfully!`;
    } else {
      return res.status(400).json({ success: false, message: "Invalid referral code. Please check and try again." });
    }
  }

  if (!db.users) db.users = [];
  db.users.push(newUser);
  saveDB(db);

  const token = generateToken(newUser.id);
  const userSafe = sanitizeUser(newUser);

  res.json({
    success: true,
    token: token,
    user: userSafe,
    message: `Account registered successfully!${refMessage}`
  });
});

// AUTH 2. Login User (Unified Owner & Customer Authentication)
app.post('/api/auth/login', (req, res) => {
  const db = loadDB();
  const rawIdentifier = (req.body.identifier || req.body.mobile || req.body.username || '').toString().trim();
  const password = (req.body.password || '').toString().trim();

  if (!rawIdentifier || !password) {
    return res.status(400).json({ success: false, message: "Username / Mobile / Email and password are required." });
  }

  const cleanIdentifier = rawIdentifier.toLowerCase();
  const normPhone = normalizePhone(rawIdentifier);

  const user = (db.users || []).find(u => {
    const normUserPhone = normalizePhone(u.mobile);
    const uEmail = (u.email || '').toLowerCase().trim();
    const uName = (u.name || '').toLowerCase().trim();

    if (normPhone && normPhone.length >= 7 && normUserPhone === normPhone) return true;
    if (cleanIdentifier && uEmail && uEmail === cleanIdentifier) return true;
    if (cleanIdentifier && uName && uName === cleanIdentifier) return true;

    return false;
  });

  if (!user) {
    return res.status(401).json({ 
      success: false, 
      message: "Invalid username or password." 
    });
  }

  if (user.password.trim() !== password) {
    return res.status(401).json({ 
      success: false, 
      message: "Invalid username or password." 
    });
  }

  const token = generateToken(user.id);
  const userSafe = sanitizeUser(user);

  res.json({
    success: true,
    token: token,
    user: userSafe,
    message: user.role === 'OWNER' ? 'Welcome to Hotel Owner Dashboard!' : `Welcome back, ${user.name}!`
  });
});

// AUTH 3. Forgot Password (Lookup Account & Verification OTP)
app.post('/api/auth/forgot-password', (req, res) => {
  const db = loadDB();
  const rawIdentifier = (req.body.identifier || req.body.mobile || '').toString().trim();

  if (!rawIdentifier) {
    return res.status(400).json({ success: false, message: "Registered Phone number or Email is required." });
  }

  const cleanIdentifier = rawIdentifier.toLowerCase();
  const normPhone = normalizePhone(rawIdentifier);

  const user = (db.users || []).find(u => {
    const normUserPhone = normalizePhone(u.mobile);
    const uEmail = (u.email || '').toLowerCase().trim();
    if (normPhone && normPhone.length >= 7 && normUserPhone === normPhone) return true;
    if (cleanIdentifier && uEmail && uEmail === cleanIdentifier) return true;
    return false;
  });

  if (!user) {
    return res.status(404).json({ success: false, message: "No account found with this number." });
  }

  const generatedOtp = "123456";
  if (!db.password_resets) db.password_resets = {};
  db.password_resets[user.id] = {
    otp: generatedOtp,
    user_id: user.id,
    mobile: user.mobile,
    created_at: Date.now()
  };
  saveDB(db);

  res.json({
    success: true,
    message: "Account found. Continue verification.",
    data: {
      user_id: user.id,
      mobile: user.mobile,
      otp: generatedOtp
    }
  });
});

// AUTH 3b. Reset Password (Update Customer Password)
app.post('/api/auth/reset-password', (req, res) => {
  const db = loadDB();
  const rawIdentifier = (req.body.identifier || req.body.mobile || '').toString().trim();
  const otp = (req.body.otp || '123456').toString().trim();
  const newPassword = (req.body.new_password || req.body.password || '').toString().trim();

  if (!rawIdentifier || !newPassword) {
    return res.status(400).json({ success: false, message: "Registered Phone / Email and new password are required." });
  }

  if (newPassword.length < 4) {
    return res.status(400).json({ success: false, message: "Password must be at least 4 characters long." });
  }

  const cleanIdentifier = rawIdentifier.toLowerCase();
  const normPhone = normalizePhone(rawIdentifier);

  const user = (db.users || []).find(u => {
    const normUserPhone = normalizePhone(u.mobile);
    const uEmail = (u.email || '').toLowerCase().trim();
    if (normPhone && normPhone.length >= 7 && normUserPhone === normPhone) return true;
    if (cleanIdentifier && uEmail && uEmail === cleanIdentifier) return true;
    return false;
  });

  if (!user) {
    return res.status(404).json({ success: false, message: "No account found with this number." });
  }

  // Update password ONLY for this matched customer account
  user.password = newPassword;
  if (db.password_resets && db.password_resets[user.id]) {
    delete db.password_resets[user.id];
  }
  saveDB(db);

  res.json({
    success: true,
    message: "Password reset successfully. Please login again."
  });
});

// AUTH 4. Get Current User Profile (Me)
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: sanitizeUser(req.user)
  });
});

// AUTH 5. Logout User
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  const db = loadDB();
  if (db.tokens && req.token) {
    delete db.tokens[req.token];
    saveDB(db);
  }
  res.json({ success: true, message: "Logged out successfully." });
});

// =========================================================================
// CUSTOMER PROFILE & STATE ISOLATION (CART & FAVORITES)
// =========================================================================

// GET Customer Profile
app.get('/api/profile', authenticateToken, (req, res) => {
  res.json({
    success: true,
    data: sanitizeUser(req.user)
  });
});

// PUT Update Customer Profile
app.put('/api/profile', authenticateToken, (req, res) => {
  const db = loadDB();
  const userIndex = db.users.findIndex(u => u.id === req.user.id);
  if (userIndex === -1) {
    return res.status(404).json({ success: false, message: "User profile not found." });
  }

  const { name, email, address } = req.body;
  if (name) db.users[userIndex].name = name.trim();
  if (email !== undefined) db.users[userIndex].email = email.trim();
  if (address !== undefined) db.users[userIndex].address = address.trim();

  saveDB(db);
  res.json({
    success: true,
    data: sanitizeUser(db.users[userIndex]),
    message: "Profile details updated successfully."
  });
});

// GET Customer Cart
app.get('/api/cart', authenticateToken, (req, res) => {
  res.json({
    success: true,
    data: req.user.cart || []
  });
});

// POST Save Customer Cart
app.post('/api/cart', authenticateToken, (req, res) => {
  const db = loadDB();
  const userIndex = db.users.findIndex(u => u.id === req.user.id);
  if (userIndex !== -1) {
    db.users[userIndex].cart = Array.isArray(req.body.cart) ? req.body.cart : [];
    saveDB(db);
  }
  res.json({ success: true, data: db.users[userIndex]?.cart || [] });
});

// GET Customer Favorites
app.get('/api/favorites', authenticateToken, (req, res) => {
  res.json({
    success: true,
    data: req.user.favorites || []
  });
});

// POST Save Customer Favorites
app.post('/api/favorites', authenticateToken, (req, res) => {
  const db = loadDB();
  const userIndex = db.users.findIndex(u => u.id === req.user.id);
  if (userIndex !== -1) {
    db.users[userIndex].favorites = Array.isArray(req.body.favorites) ? req.body.favorites : [];
    saveDB(db);
  }
  res.json({ success: true, data: db.users[userIndex]?.favorites || [] });
});

// =========================================================================
// PUBLIC HOTEL DATA (SETTINGS & MENU & FAQS)
// =========================================================================

// 1. GET Settings (Public)
app.get('/api/settings', (req, res) => {
  const db = loadDB();
  res.json({ success: true, data: db.settings });
});

// 2. PUT / POST Update Settings (Owner Only)
const updateSettingsHandler = (req, res) => {
  try {
    const db = loadDB();
    const settingsData = { ...req.body };

    // Handle base64 QR code image upload to permanent disk storage
    if (settingsData.upi_qr_code && settingsData.upi_qr_code.startsWith('data:image/')) {
      const matches = settingsData.upi_qr_code.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const uploadDir = path.join(__dirname, 'public', 'images', 'qr_uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        // Clean up previous uploaded QR files to avoid storage clutter
        try {
          const files = fs.readdirSync(uploadDir);
          files.forEach(f => {
            if (f.startsWith('qr_scanner_')) {
              try { fs.unlinkSync(path.join(uploadDir, f)); } catch (e) {}
            }
          });
        } catch (e) {
          console.warn('Old QR file cleanup warning:', e.message);
        }

        const timestamp = Date.now();
        const fileName = `qr_scanner_${timestamp}.${ext}`;
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, buffer);

        settingsData.upi_qr_code = `/images/qr_uploads/${fileName}`;
        settingsData.upi_qr_updated_at = timestamp;
      }
    } else if (settingsData.upi_qr_code === '') {
      settingsData.upi_qr_updated_at = Date.now();
    } else if (settingsData.upi_qr_code && !settingsData.upi_qr_updated_at) {
      settingsData.upi_qr_updated_at = Date.now();
    }

    if (typeof settingsData.is_qr_pay_enabled !== 'undefined') {
      settingsData.is_qr_pay_enabled = settingsData.is_qr_pay_enabled === true || settingsData.is_qr_pay_enabled === 'true';
    }
    if (typeof settingsData.is_phonepe_enabled !== 'undefined') {
      settingsData.is_phonepe_enabled = settingsData.is_phonepe_enabled === true || settingsData.is_phonepe_enabled === 'true';
    }

    const isPaymentToggleOnly = (typeof req.body.is_qr_pay_enabled !== 'undefined' || typeof req.body.is_phonepe_enabled !== 'undefined') && !req.body.hotel_name;

    db.settings = { ...db.settings, ...settingsData };
    saveDB(db);

    res.json({
      success: true,
      data: db.settings,
      message: isPaymentToggleOnly ? "Payment settings updated successfully." : "Business settings updated successfully."
    });
  } catch (err) {
    console.error('Error saving business settings:', err);
    res.status(500).json({
      success: false,
      message: "Unable to save changes. Please try again."
    });
  }
};

app.put('/api/settings', authenticateToken, requireRole('OWNER'), updateSettingsHandler);
app.post('/api/settings', authenticateToken, requireRole('OWNER'), updateSettingsHandler);

// =========================================================================
// PHONEPE DIRECT PAYMENT INTEGRATION ENDPOINTS
// =========================================================================

// 2b-1. Initiate PhonePe Payment (Authenticated Customer)
app.post('/api/phonepe/initiate', authenticateToken, requireRole('CUSTOMER'), (req, res) => {
  try {
    const db = loadDB();
    const { items, order_type, delivery_address, notes, customer_name, customer_mobile, used_wallet_amount } = req.body;

    if (db.settings?.is_phonepe_enabled === false) {
      return res.status(400).json({ success: false, message: "PhonePe payment is currently disabled by hotel owner." });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Cart is empty. Please add items to place order." });
    }

    // Calculate item totals & grand total
    let grand_total = items.reduce((sum, item) => sum + (Number(item.price || 0) * Number(item.quantity || 1)), 0);
    const walletUsed = Math.min(Number(used_wallet_amount) || 0, grand_total);
    grand_total = Math.max(0, grand_total - walletUsed);

    const txnId = `PP_TXN_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;

    if (!db.pending_phonepe_orders) db.pending_phonepe_orders = [];

    const pendingOrder = {
      txnId,
      customer_id: req.user.id,
      customer_name: customer_name || req.user.name || 'Valued Customer',
      customer_mobile: customer_mobile || req.user.mobile,
      order_type: orderTypeValid(order_type),
      delivery_address: delivery_address || 'Counter Pickup',
      notes: notes || '',
      used_wallet_amount: walletUsed,
      items,
      grand_total,
      status: 'PENDING',
      created_at: new Date().toISOString()
    };

    db.pending_phonepe_orders.push(pendingOrder);
    saveDB(db);

    res.json({
      success: true,
      txnId,
      redirectUrl: `/api/phonepe/pay?txnId=${txnId}`
    });
  } catch (err) {
    console.error('Error initiating PhonePe payment:', err);
    res.status(500).json({ success: false, message: "Unable to initiate PhonePe payment. Please try again." });
  }
});

function orderTypeValid(t) {
  return ['Takeaway', 'Delivery', 'Dine-in'].includes(t) ? t : 'Takeaway';
}

// 2b-2. PhonePe Payment Interface View (Simulated PhonePe Gateway Screen)
app.get('/api/phonepe/pay', (req, res) => {
  const { txnId } = req.query;
  const db = loadDB();
  const pending = (db.pending_phonepe_orders || []).find(p => p.txnId === txnId);

  if (!pending) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head><title>PhonePe Payment - Not Found</title></head>
      <body style="font-family: sans-serif; background: #0f0a1c; color: #FFF; text-align: center; padding: 3rem;">
        <h2 style="color: #FF5252;">Transaction Not Found</h2>
        <p>This PhonePe payment transaction has expired or is invalid.</p>
        <a href="/" style="color: #8e44ad; text-decoration: none; font-weight: bold;">Return to Annapurna Tiffin Center</a>
      </body>
      </html>
    `);
  }

  const hotelName = db.settings?.hotel_name || 'Sri Lakshmi Annapurna Tiffin Center';

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>PhonePe Payment Gateway</title>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
        body { background: #0b0714; color: #FFFFFF; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .pp-card { background: #170d2b; border: 1.5px solid #5f259f; border-radius: 20px; width: 100%; max-width: 440px; padding: 28px 24px; box-shadow: 0 20px 50px rgba(95, 37, 159, 0.4); text-align: center; }
        .pp-badge { background: #5f259f; color: #FFF; padding: 6px 16px; border-radius: 20px; font-size: 0.85rem; font-weight: 800; display: inline-flex; align-items: center; gap: 8px; margin-bottom: 20px; }
        .merchant-title { font-size: 1.1rem; color: #D1C4E9; margin-bottom: 4px; }
        .amount-box { background: rgba(95, 37, 159, 0.25); border: 1px solid #8e44ad; border-radius: 14px; padding: 18px; margin: 20px 0; }
        .amount-val { font-size: 2.6rem; color: #FFFFFF; font-weight: 800; }
        .btn-pay { width: 100%; background: linear-gradient(135deg, #5f259f, #8e44ad); color: #FFF; border: none; padding: 14px; border-radius: 12px; font-weight: 800; font-size: 1rem; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; box-shadow: 0 8px 20px rgba(95, 37, 159, 0.5); margin-bottom: 12px; transition: transform 0.2s; }
        .btn-pay:hover { transform: translateY(-2px); }
        .btn-cancel { width: 100%; background: rgba(229,57,53,0.15); color: #FF5252; border: 1px solid rgba(229,57,53,0.4); padding: 12px; border-radius: 12px; font-weight: 700; font-size: 0.9rem; cursor: pointer; margin-bottom: 10px; }
        .btn-fail { width: 100%; background: transparent; color: #B39DDB; border: none; padding: 8px; font-size: 0.8rem; cursor: pointer; text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="pp-card">
        <div class="pp-badge"><i class="fa-solid fa-mobile-screen-button"></i> PhonePe Secure Payment Gateway</div>
        <div class="merchant-title">${hotelName}</div>
        <div style="font-size: 0.8rem; color: #B39DDB;">Order Ref: #${pending.txnId}</div>

        <div class="amount-box">
          <div style="font-size: 0.8rem; color: #D1C4E9; text-transform: uppercase; letter-spacing: 0.5px;">Payable Order Amount</div>
          <div class="amount-val">₹${pending.grand_total}</div>
        </div>

        <form action="/api/phonepe/process" method="POST" style="margin-bottom: 10px;">
          <input type="hidden" name="txnId" value="${txnId}">
          <input type="hidden" name="status" value="SUCCESS">
          <button type="submit" class="btn-pay">
            <i class="fa-solid fa-circle-check" style="color: #00E676; font-size: 1.2rem;"></i>
            Complete PhonePe Payment (₹${pending.grand_total})
          </button>
        </form>

        <form action="/api/phonepe/process" method="POST" style="margin-bottom: 10px;">
          <input type="hidden" name="txnId" value="${txnId}">
          <input type="hidden" name="status" value="CANCELLED">
          <button type="submit" class="btn-cancel">
            <i class="fa-solid fa-ban"></i> Cancel Payment & Return
          </button>
        </form>

        <form action="/api/phonepe/process" method="POST">
          <input type="hidden" name="txnId" value="${txnId}">
          <input type="hidden" name="status" value="FAILED">
          <button type="submit" class="btn-fail">Simulate Payment Failure / Bank Decline</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// 2b-3. Process PhonePe Gateway Payment Result & Redirect Customer
app.post('/api/phonepe/process', express.urlencoded({ extended: true }), (req, res) => {
  const { txnId, status } = req.body;
  const db = loadDB();
  const pending = (db.pending_phonepe_orders || []).find(p => p.txnId === txnId);

  if (pending) {
    pending.status = status || 'FAILED';
    saveDB(db);
  }

  res.redirect(`/?phonepe_callback=1&status=${status || 'FAILED'}&txnId=${txnId}`);
});

// 2b-4. Verify PhonePe Payment & Auto-Create Order (Backend Verification)
app.get('/api/phonepe/status/:txnId', authenticateToken, (req, res) => {
  const { txnId } = req.params;
  const db = loadDB();

  // Check if order was ALREADY created for this txnId to prevent duplicate orders
  const existingOrder = (db.orders || []).find(o => o.utr_number === `PHONEPE_${txnId}`);
  if (existingOrder) {
    return res.json({
      success: true,
      verified: true,
      message: "Payment Successful! Your order has been placed.",
      data: existingOrder
    });
  }

  const pendingIndex = (db.pending_phonepe_orders || []).findIndex(p => p.txnId === txnId);
  if (pendingIndex === -1) {
    return res.status(404).json({
      success: false,
      verified: false,
      status: 'NOT_FOUND',
      message: "Payment Failed. Your order was not placed."
    });
  }

  const pending = db.pending_phonepe_orders[pendingIndex];

  if (pending.status === 'SUCCESS') {
    // Generate next order number
    const maxNumber = (db.orders || []).reduce((max, o) => {
      const num = parseInt((o.order_number || '').replace(/[^0-9]/g, '')) || 1000;
      return num > max ? num : max;
    }, 1000);
    const order_number = `TF${maxNumber + 1}`;

    const newOrder = {
      id: `ord_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      order_number: order_number,
      customer_id: pending.customer_id,
      customer_name: pending.customer_name,
      customer_mobile: pending.customer_mobile,
      order_type: pending.order_type,
      delivery_address: pending.delivery_address,
      notes: pending.notes || '',
      order_status: 'Received',
      payment_status: 'Paid',
      payment_method: 'UPI (PhonePe)',
      payment_screenshot: '',
      utr_number: `PHONEPE_${txnId}`,
      items: pending.items,
      grand_total: pending.grand_total,
      used_wallet_amount: pending.used_wallet_amount || 0,
      created_at: new Date().toISOString()
    };

    if (!db.orders) db.orders = [];
    db.orders.unshift(newOrder);

    // Create payment record
    const newPayment = {
      id: `pay_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      order_number: order_number,
      customer_id: pending.customer_id,
      customer_name: pending.customer_name,
      customer_mobile: pending.customer_mobile,
      amount: pending.grand_total,
      payment_method: 'UPI (PhonePe)',
      utr_number: `PHONEPE_${txnId}`,
      payment_screenshot: '',
      payment_status: 'Paid',
      date_time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    };
    if (!db.payments) db.payments = [];
    db.payments.unshift(newPayment);

    // Deduct referral wallet balance if used
    if (pending.used_wallet_amount > 0) {
      const user = (db.users || []).find(u => u.id === pending.customer_id);
      if (user) {
        user.wallet_balance = Math.max(0, (user.wallet_balance || 0) - pending.used_wallet_amount);
      }
    }

    // Remove pending record
    db.pending_phonepe_orders.splice(pendingIndex, 1);
    saveDB(db);

    return res.json({
      success: true,
      verified: true,
      message: "Payment Successful! Your order has been placed.",
      data: newOrder
    });
  } else if (pending.status === 'CANCELLED') {
    db.pending_phonepe_orders.splice(pendingIndex, 1);
    saveDB(db);
    return res.json({
      success: false,
      verified: false,
      status: 'CANCELLED',
      message: "Payment Cancelled. Your order was not placed."
    });
  } else {
    db.pending_phonepe_orders.splice(pendingIndex, 1);
    saveDB(db);
    return res.json({
      success: false,
      verified: false,
      status: 'FAILED',
      message: "Payment Failed. Your order was not placed."
    });
  }
});

// 3. GET Owner Dashboard KPI Stats (Owner Only)
app.get('/api/stats', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const allOrders = db.orders || [];

  const activeOrders = allOrders.filter(o => ['Received', 'Preparing', 'Ready'].includes(o.order_status));
  const completedOrders = allOrders.filter(o => o.order_status === 'Completed');
  const rejectedOrders = allOrders.filter(o => ['Rejected', 'Cancelled'].includes(o.order_status));
  const validOrders = allOrders.filter(o => !['Rejected', 'Cancelled'].includes(o.order_status));

  const totalSales = validOrders.reduce((sum, o) => sum + (Number(o.grand_total) || 0), 0);
  const totalCustomers = (db.users || []).filter(u => u.role === 'CUSTOMER').length;

  res.json({
    success: true,
    data: {
      total_orders: allOrders.length,
      active_orders: activeOrders.length,
      completed_orders: completedOrders.length,
      rejected_orders: rejectedOrders.length,
      total_sales: totalSales,
      total_customers: totalCustomers
    }
  });
});

// 4. GET Menu Items (Public)
app.get('/api/menu', (req, res) => {
  const db = loadDB();
  res.json({ success: true, data: db.tiffins });
});

// 5. POST Add Tiffin Item (Owner Only)
app.post('/api/menu', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { name, description, price, category, image, is_available } = req.body;
  if (!name || !price || !category) {
    return res.status(400).json({ success: false, message: "Name, price, and category are required." });
  }

  const newItem = {
    id: 'tf_' + Date.now(),
    name: name.trim(),
    description: (description || '').trim(),
    price: Number(price),
    category: category,
    image: image || '/images/idly_sambar.png',
    is_available: is_available !== undefined ? Boolean(is_available) : true
  };

  db.tiffins.unshift(newItem);
  saveDB(db);

  res.json({ success: true, data: newItem, message: `${newItem.name} has been added successfully.` });
});

// 6. PUT Update Tiffin Item (Owner Only)
app.put('/api/menu/:id', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const index = db.tiffins.findIndex(item => item.id === id);

  if (index === -1) {
    return res.status(404).json({ success: false, message: "Tiffin item not found." });
  }

  db.tiffins[index] = {
    ...db.tiffins[index],
    ...req.body,
    price: Number(req.body.price || db.tiffins[index].price)
  };

  saveDB(db);
  res.json({ success: true, data: db.tiffins[index], message: `${db.tiffins[index].name} updated successfully.` });
});

// 7. PATCH Toggle Tiffin Availability (Owner Only)
app.patch('/api/menu/:id/availability', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const { is_available } = req.body;

  const item = db.tiffins.find(item => item.id === id);
  if (!item) {
    return res.status(404).json({ success: false, message: "Tiffin item not found." });
  }

  item.is_available = Boolean(is_available);
  saveDB(db);

  res.json({
    success: true,
    data: item,
    message: `${item.name} availability set to ${item.is_available ? 'AVAILABLE' : 'NOT AVAILABLE'}`
  });
});

// 8. DELETE Tiffin Item (Owner Only)
app.delete('/api/menu/:id', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const item = db.tiffins.find(item => item.id === id);
  
  if (!item) {
    return res.status(404).json({ success: false, message: "Tiffin item not found." });
  }

  db.tiffins = db.tiffins.filter(item => item.id !== id);
  saveDB(db);

  res.json({ success: true, message: `${item.name} deleted successfully.` });
});

// =========================================================================
// ORDERS & PAYMENTS (STRICT DATA ISOLATION)
// =========================================================================

// 9. GET Orders (Customer gets OWN orders only; Owner gets ALL orders)
app.get('/api/orders', authenticateToken, (req, res) => {
  const db = loadDB();
  let ordersList = db.orders || [];

  if (req.user.role === 'CUSTOMER') {
    ordersList = ordersList.filter(o => o.customer_id === req.user.id);
  }

  res.json({ success: true, data: ordersList });
});

// 10. POST Create Order (Customer Only — Uses Authenticated User ID)
app.post('/api/orders', authenticateToken, requireRole('CUSTOMER'), (req, res) => {
  const db = loadDB();

  const { order_type, delivery_address, notes, payment_method, payment_screenshot, utr_number, items, used_wallet_amount } = req.body;

  if (!items || !items.length) {
    return res.status(400).json({ success: false, message: "Ordered items are required." });
  }

  // Check if payment method is QR Pay and if enabled
  if ((payment_method === 'UPI (QR Pay)' || payment_method === 'UPI') && db.settings?.is_qr_pay_enabled === false) {
    return res.status(400).json({ success: false, message: "QR Pay is currently disabled by hotel owner." });
  }

  const orderNum = 'TF' + db.order_counter;
  db.order_counter += 1;

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

  // Handle Wallet Balance Redemption for Authenticated User
  let walletDeducted = 0;
  const customerUser = db.users.find(u => u.id === req.user.id);

  if (used_wallet_amount && Number(used_wallet_amount) > 0 && customerUser) {
    const maxWalletUse = Math.min(Number(customerUser.wallet_balance || 0), Number(used_wallet_amount), grand_total);
    if (maxWalletUse > 0) {
      walletDeducted = maxWalletUse;
      customerUser.wallet_balance = (customerUser.wallet_balance || 0) - walletDeducted;
      grand_total = Math.max(0, grand_total - walletDeducted);

      if (!db.wallet_transactions) db.wallet_transactions = [];
      db.wallet_transactions.unshift({
        id: 'wtx_' + Date.now(),
        customer_id: customerUser.id,
        customer_mobile: customerUser.mobile,
        type: 'DEBIT',
        amount: walletDeducted,
        description: `Redeemed on Order #${orderNum}`,
        date_time: new Date().toLocaleString('en-IN')
      });
    }
  }

  // Award Loyalty Points for order (1 point per ₹10 spent)
  if (customerUser) {
    const earnedPoints = Math.floor(grand_total / 10);
    customerUser.loyalty_points = (customerUser.loyalty_points || 0) + earnedPoints;
  }

  const isUPI = (payment_method || '').includes('UPI') || (payment_method || '').includes('Online');
  const initialPaymentStatus = isUPI ? 'Verification Pending (UPI)' : 'Pending';

  const newOrder = {
    id: 'ord_' + Date.now(),
    order_number: orderNum,
    customer_id: req.user.id, // STRICT ISOLATION IDENTIFIER
    customer_name: req.user.name,
    customer_mobile: req.user.mobile,
    order_type: order_type || 'Takeaway',
    delivery_address: (delivery_address || '').trim() || (order_type === 'Delivery' ? (req.user.address || 'Home Delivery Address') : 'Counter Pickup'),
    notes: (notes || '').trim(),
    payment_method: payment_method || 'Cash',
    payment_status: initialPaymentStatus,
    payment_screenshot: payment_screenshot || '',
    utr_number: (utr_number || '').trim(),
    used_wallet_amount: walletDeducted,
    order_status: 'Received',
    items: formattedItems,
    grand_total: grand_total,
    created_at: new Date().toISOString()
  };

  db.orders.unshift(newOrder);

  // Clear customer cart on successful order
  if (customerUser) {
    customerUser.cart = [];
  }

  // Record payment linked to customer_id
  db.payments.unshift({
    id: 'pay_' + Date.now(),
    order_number: orderNum,
    customer_id: req.user.id,
    customer_name: newOrder.customer_name,
    customer_mobile: newOrder.customer_mobile,
    amount: grand_total,
    payment_method: isUPI ? 'Online Payment / UPI' : 'Cash',
    payment_status: initialPaymentStatus,
    utr_number: newOrder.utr_number,
    payment_screenshot: newOrder.payment_screenshot,
    date_time: new Date().toLocaleString('en-IN')
  });

  // Owner Notification
  const ownerMsg = isUPI && newOrder.utr_number
    ? `New order #${orderNum} received! UPI Verification Pending (UTR: ${newOrder.utr_number}, ₹${grand_total})`
    : `New order #${orderNum} received from ${newOrder.customer_name} (₹${grand_total})`;

  db.notifications.unshift({
    id: 'notif_' + Date.now(),
    customer_id: null,
    target_role: 'OWNER',
    order_number: orderNum,
    message: ownerMsg,
    is_read: false,
    created_at: new Date().toISOString()
  });

  // Customer Notification (Linked to customer_id)
  db.notifications.unshift({
    id: 'notif_' + (Date.now() + 1),
    customer_id: req.user.id,
    target_role: 'CUSTOMER',
    order_number: orderNum,
    message: `Your order #${orderNum} has been placed! ${isUPI ? 'UPI Payment verification in progress.' : ''}`,
    is_read: false,
    created_at: new Date().toISOString()
  });

  saveDB(db);

  res.json({
    success: true,
    data: newOrder,
    message: `Order #${orderNum} placed successfully!`
  });
});

// 11. PATCH Owner Verify UPI Payment (Owner Only)
app.patch('/api/orders/:id/payment-verify', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const { payment_status } = req.body;

  const order = db.orders.find(o => o.id === id || o.order_number === id);
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found." });
  }

  const validStatus = payment_status || 'Paid';
  order.payment_status = validStatus;

  // Sync db.payments
  const payRecord = db.payments.find(p => p.order_number === order.order_number);
  if (payRecord) {
    payRecord.payment_status = validStatus;
  }

  // Customer notification linked to customer_id
  db.notifications.unshift({
    id: 'notif_' + Date.now(),
    customer_id: order.customer_id,
    target_role: 'CUSTOMER',
    order_number: order.order_number,
    message: `Payment update for Order #${order.order_number}: Marked as ${validStatus}!`,
    is_read: false,
    created_at: new Date().toISOString()
  });

  saveDB(db);
  res.json({ success: true, data: order, message: `Payment for Order #${order.order_number} marked as ${validStatus}.` });
});

// 12. PATCH Order Status (Owner Only)
app.patch('/api/orders/:id/status', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const { order_status, rejection_reason } = req.body;

  const order = db.orders.find(o => o.id === id || o.order_number === id);
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found." });
  }

  order.order_status = order_status;

  if (order_status === 'Rejected') {
    if (rejection_reason !== undefined && rejection_reason !== null) {
      order.rejection_reason = rejection_reason.toString().trim();
    }
  } else if (['Received', 'Preparing', 'Ready', 'Completed'].includes(order_status)) {
    if (order.rejection_reason) {
      order.previous_rejection_reason = order.rejection_reason;
      delete order.rejection_reason;
    }
  }

  if (order_status === 'Completed' && order.payment_method === 'Cash') {
    order.payment_status = 'Cash Received';
    const payItem = db.payments.find(p => p.order_number === order.order_number);
    if (payItem) payItem.payment_status = 'Cash Received';
  }

  // Check Referral Reward Trigger upon Order Completion
  if (order_status === 'Completed' && db.settings.referral?.enabled !== false) {
    const custPhone = normalizePhone(order.customer_mobile || '');
    const pendingRef = (db.referrals || []).find(r => 
      r.status === 'Pending' &&
      (r.referred_id === order.customer_id || (custPhone && normalizePhone(r.referred_mobile) === custPhone))
    );

    if (pendingRef) {
      const refPhone = normalizePhone(pendingRef.referrer_mobile || '');
      const referrerUser = (db.users || []).find(u => 
        u.id === pendingRef.referrer_id || (refPhone && normalizePhone(u.mobile) === refPhone)
      );

      if (referrerUser) {
        const rewardVal = Number(pendingRef.reward_amount || db.settings.referral?.referrer_reward || 30);
        referrerUser.wallet_balance = (Number(referrerUser.wallet_balance) || 0) + rewardVal;
        
        pendingRef.status = 'Completed';
        pendingRef.order_id = order.id;
        pendingRef.order_number = order.order_number;
        pendingRef.reward_date = new Date().toLocaleString('en-IN');

        if (!db.wallet_transactions) db.wallet_transactions = [];
        db.wallet_transactions.unshift({
          id: 'wtx_' + Date.now(),
          user_id: referrerUser.id,
          customer_id: referrerUser.id,
          customer_mobile: referrerUser.mobile,
          type: 'CREDIT',
          amount: rewardVal,
          description: `Referral reward earned from ${order.customer_name || 'friend'}'s first completed order (#${order.order_number})`,
          date_time: new Date().toLocaleString('en-IN'),
          created_at: new Date().toISOString()
        });

        // Check Milestone Bonuses (5 & 10 completed referrals)
        const refUserPhone = normalizePhone(referrerUser.mobile);
        const completedRefsCount = db.referrals.filter(r => 
          r.status === 'Completed' &&
          (r.referrer_id === referrerUser.id || (refUserPhone && normalizePhone(r.referrer_mobile) === refUserPhone))
        ).length;

        let bonusMsg = '';
        if (completedRefsCount === 5) {
          referrerUser.wallet_balance = (Number(referrerUser.wallet_balance) || 0) + 100;
          db.wallet_transactions.unshift({
            id: 'wtx_' + (Date.now() + 1),
            user_id: referrerUser.id,
            customer_id: referrerUser.id,
            customer_mobile: referrerUser.mobile,
            type: 'CREDIT',
            amount: 100,
            description: `🏆 Referral Champion Bonus (5 Friends Reached!)`,
            date_time: new Date().toLocaleString('en-IN'),
            created_at: new Date().toISOString()
          });
          bonusMsg = ' Plus ₹100 Milestone Bonus added!';
        } else if (completedRefsCount === 10) {
          referrerUser.wallet_balance = (Number(referrerUser.wallet_balance) || 0) + 250;
          db.wallet_transactions.unshift({
            id: 'wtx_' + (Date.now() + 2),
            user_id: referrerUser.id,
            customer_id: referrerUser.id,
            customer_mobile: referrerUser.mobile,
            type: 'CREDIT',
            amount: 250,
            description: `🏆 Master Referrer Milestone Bonus (10 Friends Reached!)`,
            date_time: new Date().toLocaleString('en-IN'),
            created_at: new Date().toISOString()
          });
          bonusMsg = ' Plus ₹250 Milestone Bonus added!';
        }

        // Notify Referrer
        if (!db.notifications) db.notifications = [];
        db.notifications.unshift({
          id: 'notif_' + Date.now(),
          user_id: referrerUser.id,
          customer_id: referrerUser.id,
          target_role: 'CUSTOMER',
          order_number: order.order_number,
          message: `🎉 Referral Reward! Your friend ${order.customer_name || 'friend'} completed order #${order.order_number}. ₹${rewardVal} added to your Referral Wallet!${bonusMsg}`,
          is_read: false,
          created_at: new Date().toISOString()
        });
      }
    }
  }

  // Create Customer Notification
  let notifMsg = `Your order #${order.order_number} status updated to ${order_status}.`;
  if (order_status === 'Preparing') notifMsg = `Your order #${order.order_number} is being prepared! 🍳`;
  if (order_status === 'Ready') notifMsg = `Your order #${order.order_number} is ready for ${order.order_type === 'Dine-in' ? 'table serving' : 'pickup'}! 🔔`;
  if (order_status === 'Completed') notifMsg = `Your order #${order.order_number} has been completed. Enjoy your meal! 🎉`;
  if (order_status === 'Rejected') {
    const reasonTxt = order.rejection_reason ? ` Reason: "${order.rejection_reason}"` : '';
    notifMsg = `Your order #${order.order_number} was rejected by the hotel.${reasonTxt}`;
  }

  db.notifications.unshift({
    id: 'notif_' + Date.now(),
    customer_id: order.customer_id,
    target_role: 'CUSTOMER',
    order_number: order.order_number,
    message: notifMsg,
    is_read: false,
    created_at: new Date().toISOString()
  });

  saveDB(db);
  res.json({ success: true, data: order, message: `Order #${order.order_number} marked as ${order_status}.` });
});

// 13. DELETE Order Record (Owner Only)
app.delete('/api/orders/:id', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const order = db.orders.find(o => o.id === id || o.order_number === id);

  if (!order) {
    return res.status(404).json({ success: false, message: "Order record not found." });
  }

  db.orders = db.orders.filter(o => o.id !== order.id && o.order_number !== order.order_number);
  db.payments = db.payments.filter(p => p.order_number !== order.order_number);
  saveDB(db);

  res.json({ success: true, message: `Order #${order.order_number} deleted successfully.` });
});

// =========================================================================
// CUSTOMER HISTORY DELETION (Customer can delete ONLY their own records)
// =========================================================================

// 13a. DELETE Single Customer Order (Customer Only — Ownership enforced)
app.delete('/api/customer/orders/:id', authenticateToken, requireRole('CUSTOMER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const order = db.orders.find(o => o.id === id || o.order_number === id);

  if (!order) {
    return res.status(404).json({ success: false, message: "Order record not found." });
  }

  // Strict ownership check: customer_id must match authenticated user
  if (order.customer_id !== req.user.id) {
    return res.status(403).json({ success: false, message: "You can only delete your own order records." });
  }

  db.orders = db.orders.filter(o => o.id !== order.id);
  db.payments = db.payments.filter(p => p.order_number !== order.order_number);
  saveDB(db);

  res.json({ success: true, message: `Order #${order.order_number} deleted from your history.` });
});

// 13b. DELETE All Customer Orders (Customer Only — Deletes only authenticated user's orders)
app.delete('/api/customer/orders', authenticateToken, requireRole('CUSTOMER'), (req, res) => {
  const db = loadDB();
  const userId = req.user.id;

  // Collect order numbers belonging to this customer (for payment cleanup)
  const customerOrderNumbers = (db.orders || [])
    .filter(o => o.customer_id === userId)
    .map(o => o.order_number);

  const deletedCount = customerOrderNumbers.length;

  if (deletedCount === 0) {
    return res.json({ success: true, message: "No order history to delete." });
  }

  // Remove all orders belonging to this customer
  db.orders = db.orders.filter(o => o.customer_id !== userId);

  // Remove associated payment records
  db.payments = db.payments.filter(p => !customerOrderNumbers.includes(p.order_number));

  saveDB(db);
  res.json({ success: true, message: `${deletedCount} order(s) deleted from your history.` });
});

// 13c. DELETE Single Customer Payment (Customer Only — Ownership enforced)
app.delete('/api/customer/payments/:id', authenticateToken, requireRole('CUSTOMER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const payment = db.payments.find(p => p.id === id);

  if (!payment) {
    return res.status(404).json({ success: false, message: "Payment record not found." });
  }

  // Strict ownership check via customer_id or matching order's customer_id
  const isOwner = payment.customer_id === req.user.id;
  const matchingOrder = (db.orders || []).find(o => o.order_number === payment.order_number);
  const isOrderOwner = matchingOrder && matchingOrder.customer_id === req.user.id;

  if (!isOwner && !isOrderOwner) {
    return res.status(403).json({ success: false, message: "You can only delete your own payment records." });
  }

  db.payments = db.payments.filter(p => p.id !== payment.id);
  saveDB(db);

  res.json({ success: true, message: `Payment record for Order #${payment.order_number} deleted.` });
});

// 13d. DELETE All Customer Payments (Customer Only — Deletes only authenticated user's payments)
app.delete('/api/customer/payments', authenticateToken, requireRole('CUSTOMER'), (req, res) => {
  const db = loadDB();
  const userId = req.user.id;

  // Find all payments belonging to this customer
  const customerPayments = (db.payments || []).filter(p => {
    if (p.customer_id === userId) return true;
    const matchingOrder = (db.orders || []).find(o => o.order_number === p.order_number);
    if (matchingOrder && matchingOrder.customer_id === userId) return true;
    return false;
  });

  const deletedCount = customerPayments.length;

  if (deletedCount === 0) {
    return res.json({ success: true, message: "No payment history to delete." });
  }

  const paymentIds = customerPayments.map(p => p.id);
  db.payments = db.payments.filter(p => !paymentIds.includes(p.id));
  saveDB(db);

  res.json({ success: true, message: `${deletedCount} payment record(s) deleted from your history.` });
});

// 14. GET Payments (Customer gets OWN payments only; Owner gets ALL payments)
app.get('/api/payments', authenticateToken, (req, res) => {
  const db = loadDB();
  let list = db.payments || [];

  if (req.user.role === 'CUSTOMER') {
    list = list.filter(p => p.customer_id === req.user.id || (db.orders.find(o => o.order_number === p.order_number)?.customer_id === req.user.id));
  }

  res.json({ success: true, data: list });
});

// 15. PATCH Payment Status (Owner Only)
app.patch('/api/payments/:id/status', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const { payment_status } = req.body;

  const payment = db.payments.find(p => p.id === id);
  if (!payment) {
    return res.status(404).json({ success: false, message: "Payment record not found." });
  }

  payment.payment_status = payment_status;
  
  // Sync order payment status
  const order = db.orders.find(o => o.order_number === payment.order_number);
  if (order) {
    order.payment_status = payment_status;
  }

  saveDB(db);
  res.json({ success: true, data: payment, message: `Payment status updated to ${payment_status}.` });
});

// =========================================================================
// NOTIFICATIONS (STRICT DATA ISOLATION)
// =========================================================================

// 16. GET Notifications (Customer gets OWN notifications; Owner gets OWNER notifications)
app.get('/api/notifications', authenticateToken, (req, res) => {
  const db = loadDB();
  let list = db.notifications || [];

  if (req.user.role === 'CUSTOMER') {
    list = list.filter(n => n.target_role === 'CUSTOMER' && (n.customer_id === req.user.id || (!n.customer_id && n.created_at >= req.user.created_at)));
  } else {
    list = list.filter(n => n.target_role === 'OWNER');
  }

  res.json({ success: true, data: list });
});

// 17. PATCH Mark Notifications Read
app.patch('/api/notifications/read-all', authenticateToken, (req, res) => {
  const db = loadDB();
  (db.notifications || []).forEach(n => {
    if (req.user.role === 'CUSTOMER' && n.target_role === 'CUSTOMER' && (n.customer_id === req.user.id || !n.customer_id)) {
      n.is_read = true;
    } else if (req.user.role === 'OWNER' && n.target_role === 'OWNER') {
      n.is_read = true;
    }
  });
  saveDB(db);
  res.json({ success: true, message: "Notifications marked as read." });
});

// 17.1 DELETE Clear All Notifications
app.delete('/api/notifications/clear-all', authenticateToken, (req, res) => {
  const db = loadDB();
  if (req.user.role === 'CUSTOMER') {
    db.notifications = (db.notifications || []).filter(n => n.target_role !== 'CUSTOMER' || (n.customer_id && n.customer_id !== req.user.id));
  } else {
    db.notifications = (db.notifications || []).filter(n => n.target_role !== 'OWNER');
  }
  saveDB(db);
  res.json({ success: true, message: "All notifications cleared." });
});

// 17.2 DELETE Single Notification
app.delete('/api/notifications/:id', authenticateToken, (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  db.notifications = (db.notifications || []).filter(n => n.id !== id);
  saveDB(db);
  res.json({ success: true, message: "Notification deleted." });
});

// =========================================================================
// SUPPORT SYSTEM & TICKETS
// =========================================================================

// 18. GET Support FAQs (Public)
app.get('/api/support/faqs', (req, res) => {
  const db = loadDB();
  res.json({ success: true, data: db.faqs || [] });
});

// 19. GET Support Tickets (Customer gets OWN tickets; Owner gets ALL tickets)
app.get('/api/support/tickets', authenticateToken, (req, res) => {
  const db = loadDB();
  let list = db.support_tickets || [];

  if (req.user.role === 'CUSTOMER') {
    list = list.filter(t => t.customer_id === req.user.id || t.user_id === req.user.id);
  }

  // Sort by updated_at descending
  list.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

  res.json({ success: true, data: list });
});

// 20. POST Create Support Ticket (Customer or User)
app.post('/api/support/tickets', authenticateToken, (req, res) => {
  const db = loadDB();
  const { order_number, category, subject, priority, message } = req.body;

  if (!subject || !message) {
    return res.status(400).json({ success: false, message: "Subject and message are required." });
  }

  if (!db.ticket_counter) db.ticket_counter = 1001;
  const tktNum = `TKT-${db.ticket_counter}`;
  db.ticket_counter += 1;

  const now = new Date().toISOString();
  const newTicket = {
    id: 'tkt_' + Date.now(),
    ticket_number: tktNum,
    user_id: req.user.id,
    customer_id: req.user.id,
    customer_name: req.user.name,
    customer_mobile: req.user.mobile,
    order_number: (order_number || 'General Inquiry').trim(),
    category: category || 'General Inquiry',
    subject: subject.trim(),
    priority: priority || 'Medium',
    status: 'Open',
    created_at: now,
    updated_at: now,
    messages: [
      {
        id: 'msg_' + Date.now(),
        sender_role: 'CUSTOMER',
        sender_name: req.user.name,
        message: message.trim(),
        timestamp: now
      }
    ]
  };

  if (!db.support_tickets) db.support_tickets = [];
  db.support_tickets.unshift(newTicket);

  // Owner Notification
  db.notifications.unshift({
    id: 'notif_' + Date.now(),
    customer_id: null,
    target_role: 'OWNER',
    order_number: newTicket.order_number,
    message: `🆘 New support ticket #${tktNum} from ${newTicket.customer_name}: "${subject}"`,
    is_read: false,
    created_at: now
  });

  // Customer Notification
  db.notifications.unshift({
    id: 'notif_' + (Date.now() + 1),
    customer_id: req.user.id,
    target_role: 'CUSTOMER',
    order_number: newTicket.order_number,
    message: `Support ticket #${tktNum} created! Our hotel support team will assist you shortly.`,
    is_read: false,
    created_at: now
  });

  saveDB(db);

  res.json({
    success: true,
    data: newTicket,
    message: `Support ticket #${tktNum} created successfully!`
  });
});

// 21. POST Add Reply Message to Support Ticket
app.post('/api/support/tickets/:id/messages', authenticateToken, (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, message: "Message content cannot be empty." });
  }

  const ticket = (db.support_tickets || []).find(t => t.id === id || t.ticket_number === id);
  if (!ticket) {
    return res.status(404).json({ success: false, message: "Support ticket not found." });
  }

  // Access check for customer
  if (req.user.role === 'CUSTOMER' && ticket.customer_id !== req.user.id && ticket.user_id !== req.user.id) {
    return res.status(403).json({ success: false, message: "Forbidden. Ticket does not belong to you." });
  }

  const now = new Date().toISOString();
  const senderRole = req.user.role;
  const senderName = req.user.name;

  const newMsg = {
    id: 'msg_' + Date.now(),
    sender_role: senderRole,
    sender_name: senderName,
    message: message.trim(),
    timestamp: now
  };

  ticket.messages.push(newMsg);
  ticket.updated_at = now;

  if (senderRole === 'OWNER' && ticket.status === 'Open') {
    ticket.status = 'In Progress';
  }

  // Notifications
  if (senderRole === 'OWNER') {
    db.notifications.unshift({
      id: 'notif_' + Date.now(),
      customer_id: ticket.customer_id,
      target_role: 'CUSTOMER',
      order_number: ticket.order_number,
      message: `💬 Hotel reply on Ticket #${ticket.ticket_number}: "${message.trim().slice(0, 45)}..."`,
      is_read: false,
      created_at: now
    });
  } else {
    db.notifications.unshift({
      id: 'notif_' + Date.now(),
      customer_id: null,
      target_role: 'OWNER',
      order_number: ticket.order_number,
      message: `💬 New message on Ticket #${ticket.ticket_number} from ${senderName}`,
      is_read: false,
      created_at: now
    });
  }

  saveDB(db);

  res.json({
    success: true,
    data: ticket,
    message: "Message sent successfully."
  });
});

// 22. PATCH Support Ticket Status (Owner Only)
app.patch('/api/support/tickets/:id/status', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const { status } = req.body;

  const ticket = (db.support_tickets || []).find(t => t.id === id || t.ticket_number === id);
  if (!ticket) {
    return res.status(404).json({ success: false, message: "Support ticket not found." });
  }

  ticket.status = status;
  ticket.updated_at = new Date().toISOString();

  // Notify customer
  db.notifications.unshift({
    id: 'notif_' + Date.now(),
    customer_id: ticket.customer_id,
    target_role: 'CUSTOMER',
    order_number: ticket.order_number,
    message: `Ticket #${ticket.ticket_number} status updated to ${status}.`,
    is_read: false,
    created_at: new Date().toISOString()
  });

  saveDB(db);

  res.json({
    success: true,
    data: ticket,
    message: `Ticket #${ticket.ticket_number} status updated to ${status}.`
  });
});

// 23. DELETE Support Ticket (Owner Only)
app.delete('/api/support/tickets/:id', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const ticket = (db.support_tickets || []).find(t => t.id === id || t.ticket_number === id);

  if (!ticket) {
    return res.status(404).json({ success: false, message: "Support ticket not found." });
  }

  db.support_tickets = (db.support_tickets || []).filter(t => t.id !== ticket.id && t.ticket_number !== ticket.ticket_number);
  saveDB(db);

  res.json({ success: true, message: `Support ticket #${ticket.ticket_number} deleted successfully.` });
});

// =========================================================================
// REFERRAL SYSTEM & WALLET API ENDPOINTS
// =========================================================================

// 24. GET Customer Referral Stats & Wallet (Strictly for Authenticated User)
app.get('/api/referrals/stats', authenticateToken, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);

  if (!user) {
    return res.status(404).json({ success: false, message: "Customer account not found." });
  }

  // Ensure user has a referral_code
  if (!user.referral_code) {
    const namePrefix = user.name.trim().replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5) || 'TIFFIN';
    user.referral_code = `${namePrefix}${Math.floor(10 + Math.random() * 90)}`;
    saveDB(db);
  }

  const cleanMobile = user.mobile.replace(/[^0-9]/g, '');
  const userReferrals = (db.referrals || []).filter(r => r.referrer_id === user.id || r.referrer_mobile.replace(/[^0-9]/g, '') === cleanMobile);
  const totalCount = userReferrals.length;
  const completedCount = userReferrals.filter(r => r.status === 'Completed').length;
  const pendingCount = userReferrals.filter(r => r.status === 'Pending').length;
  const totalEarned = userReferrals.filter(r => r.status === 'Completed').reduce((s, r) => s + Number(r.reward_amount || 30), 0);

  const walletTx = (db.wallet_transactions || []).filter(w => w.customer_id === user.id || w.customer_mobile.replace(/[^0-9]/g, '') === cleanMobile);

  res.json({
    success: true,
    data: {
      referral_code: user.referral_code,
      wallet_balance: Number(user.wallet_balance || 0),
      loyalty_points: Number(user.loyalty_points || 0),
      show_on_leaderboard: user.show_on_leaderboard !== false,
      total_referrals: totalCount,
      completed_referrals: completedCount,
      pending_referrals: pendingCount,
      total_rewards_earned: totalEarned,
      history: userReferrals,
      wallet_transactions: walletTx,
      settings: db.settings.referral || defaultSeed.settings.referral
    }
  });
});

// 25. GET Monthly Top Referrers Leaderboard (Public)
app.get('/api/referrals/leaderboard', (req, res) => {
  const db = loadDB();
  const customerMap = {};

  (db.referrals || []).filter(r => r.status === 'Completed').forEach(r => {
    const key = r.referrer_id || r.referrer_mobile.replace(/[^0-9]/g, '');
    if (!customerMap[key]) {
      customerMap[key] = { key: key, count: 0, rewards: 0 };
    }
    customerMap[key].count += 1;
    customerMap[key].rewards += Number(r.reward_amount || 30);
  });

  let leaderboard = Object.values(customerMap).map(item => {
    const user = (db.users || []).find(u => u.id === item.key || u.mobile.replace(/[^0-9]/g, '') === item.key);
    const showPublic = user ? user.show_on_leaderboard !== false : true;
    let displayName = 'Anonymous Customer';
    if (user && showPublic) {
      const parts = user.name.trim().split(' ');
      displayName = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
    }
    return {
      name: displayName,
      is_anonymous: !showPublic,
      count: item.count,
      rewards: item.rewards
    };
  });

  leaderboard.sort((a, b) => b.count - a.count || b.rewards - a.rewards);
  leaderboard = leaderboard.slice(0, 10);

  res.json({ success: true, data: leaderboard });
});

// 26. PATCH Customer Leaderboard Privacy Toggle
app.patch('/api/referrals/privacy', authenticateToken, (req, res) => {
  const db = loadDB();
  const { show_on_leaderboard } = req.body;
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found." });
  }

  user.show_on_leaderboard = Boolean(show_on_leaderboard);
  saveDB(db);
  res.json({ success: true, message: `Leaderboard visibility updated to ${user.show_on_leaderboard ? 'Public' : 'Anonymous'}.` });
});

// 27. POST Owner Save Referral Program Settings (Owner Only)
app.post('/api/owner/referrals/settings', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { enabled, referrer_reward, new_customer_discount, min_order_value, monthly_limit } = req.body;

  if (!db.settings.referral) db.settings.referral = defaultSeed.settings.referral;

  db.settings.referral = {
    ...db.settings.referral,
    enabled: enabled !== undefined ? Boolean(enabled) : db.settings.referral.enabled,
    referrer_reward: referrer_reward !== undefined ? Number(referrer_reward) : db.settings.referral.referrer_reward,
    new_customer_discount: new_customer_discount !== undefined ? Number(new_customer_discount) : db.settings.referral.new_customer_discount,
    min_order_value: min_order_value !== undefined ? Number(min_order_value) : db.settings.referral.min_order_value,
    monthly_limit: monthly_limit !== undefined ? Number(monthly_limit) : db.settings.referral.monthly_limit
  };

  saveDB(db);
  res.json({ success: true, data: db.settings.referral, message: "Referral program settings saved successfully." });
});

// =========================================================================
// POST-ORDER REVIEW & RATING API ENDPOINTS
// =========================================================================

// 28. POST Submit Order Review & Rating
app.post('/api/reviews', authenticateToken, (req, res) => {
  const db = loadDB();
  const { order_number, rating, comment, issues, is_public } = req.body;

  if (!order_number || !rating) {
    return res.status(400).json({ success: false, message: "Order number and star rating are required." });
  }

  const numRating = Number(rating);
  if (isNaN(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ success: false, message: "Rating must be between 1 and 5 stars." });
  }

  const newReview = {
    id: 'rev_' + Date.now(),
    order_number: (order_number || '').trim(),
    customer_id: req.user.id,
    customer_name: req.user.name,
    customer_mobile: req.user.mobile,
    rating: numRating,
    comment: (comment || '').trim(),
    issues: Array.isArray(issues) ? issues : [],
    is_public: Boolean(is_public),
    created_at: new Date().toISOString()
  };

  if (!db.reviews) db.reviews = [];
  db.reviews.unshift(newReview);

  // Mark matching order as reviewed
  const order = (db.orders || []).find(o => o.order_number === order_number);
  if (order) {
    order.has_reviewed = true;
  }

  // Handle 1-3 Stars Low Rating (Internal Warning & Support Ticket Alert)
  if (numRating <= 3) {
    const issueStr = newReview.issues.length ? ` (Issues: ${newReview.issues.join(', ')})` : '';
    const ownerAlert = `⚠️ Low Rating Alert! Order #${order_number} was rated ${numRating}/5 stars by ${newReview.customer_name}${issueStr}. Feedback: "${newReview.comment || 'No detailed comment'}"`;

    db.notifications.unshift({
      id: 'notif_' + Date.now(),
      customer_id: null,
      target_role: 'OWNER',
      order_number: order_number,
      message: ownerAlert,
      is_read: false,
      created_at: new Date().toISOString()
    });

    if (!db.ticket_counter) db.ticket_counter = 1001;
    const tktNum = `TKT-${db.ticket_counter}`;
    db.ticket_counter += 1;

    db.support_tickets.unshift({
      id: 'tkt_' + Date.now(),
      ticket_number: tktNum,
      user_id: req.user.id,
      customer_id: req.user.id,
      customer_name: newReview.customer_name,
      customer_mobile: newReview.customer_mobile,
      order_number: order_number,
      category: 'Food Quality & Customer Feedback',
      subject: `Order #${order_number} Rating Follow-up (${numRating}/5 Stars)`,
      priority: 'High',
      status: 'Open',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      messages: [
        {
          id: 'msg_' + Date.now(),
          sender_role: 'CUSTOMER',
          sender_name: newReview.customer_name,
          message: `Order #${order_number} feedback (${numRating} stars). ${issueStr}. Comment: "${newReview.comment || 'N/A'}"`,
          timestamp: new Date().toISOString()
        }
      ]
    });
  } else {
    // 4-5 Stars Thank You Notification
    db.notifications.unshift({
      id: 'notif_' + Date.now(),
      customer_id: null,
      target_role: 'OWNER',
      order_number: order_number,
      message: `🌟 Review Received! Order #${order_number} rated ${numRating}/5 stars by ${newReview.customer_name}!`,
      is_read: false,
      created_at: new Date().toISOString()
    });
  }

  saveDB(db);

  res.json({
    success: true,
    data: newReview,
    message: numRating >= 4
      ? "❤️ Thank you for your wonderful review! We're glad you enjoyed your food!"
      : "We sincerely apologize for your experience. Our owner team has received your feedback and will look into it immediately."
  });
});

// 29. GET Order Reviews (Public or Customer Filtered)
app.get('/api/reviews', optionalAuth, (req, res) => {
  const db = loadDB();
  const { public_only } = req.query;
  let list = db.reviews || [];

  if (public_only === 'true') {
    list = list.filter(r => r.is_public && r.rating >= 4);
  } else if (req.user && req.user.role === 'CUSTOMER') {
    list = list.filter(r => r.customer_id === req.user.id);
  }

  res.json({ success: true, data: list });
});

// 30. GET Review Statistics & Metrics (Public)
app.get('/api/reviews/stats', (req, res) => {
  const db = loadDB();
  const reviews = db.reviews || [];

  const total = reviews.length;
  if (!total) {
    return res.json({
      success: true,
      data: {
        average_rating: 5.0,
        total_reviews: 0,
        rating_counts: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
        recent_reviews: []
      }
    });
  }

  const sum = reviews.reduce((s, r) => s + (Number(r.rating) || 5), 0);
  const avg = (sum / total).toFixed(1);

  const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  reviews.forEach(r => {
    const star = Math.min(5, Math.max(1, Math.round(r.rating)));
    counts[star] = (counts[star] || 0) + 1;
  });

  res.json({
    success: true,
    data: {
      average_rating: Number(avg),
      total_reviews: total,
      rating_counts: counts,
      recent_reviews: reviews.slice(0, 8)
    }
  });
});

// 31. PATCH Toggle Review Public Visibility (Owner Only)
app.patch('/api/reviews/:id/visibility', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const { is_public } = req.body;

  const review = (db.reviews || []).find(r => r.id === id);
  if (!review) {
    return res.status(404).json({ success: false, message: "Review not found." });
  }

  review.is_public = typeof is_public === 'boolean' ? is_public : !review.is_public;
  saveDB(db);

  res.json({
    success: true,
    data: review,
    message: review.is_public ? "Review is now featured publicly on website!" : "Review hidden from public view."
  });
});

// 32. POST Reply to Customer Review (Owner Only)
app.post('/api/reviews/:id/reply', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const { reply_message } = req.body;

  if (!reply_message || !reply_message.trim()) {
    return res.status(400).json({ success: false, message: "Reply message cannot be empty." });
  }

  const review = (db.reviews || []).find(r => r.id === id);
  if (!review) {
    return res.status(404).json({ success: false, message: "Review not found." });
  }

  review.owner_reply = {
    message: reply_message.trim(),
    created_at: new Date().toISOString()
  };
  saveDB(db);

  res.json({
    success: true,
    data: review,
    message: "Owner reply posted successfully!"
  });
});

// 33. DELETE Review (Owner Only)
app.delete('/api/reviews/:id', authenticateToken, requireRole('OWNER'), (req, res) => {
  const db = loadDB();
  const { id } = req.params;

  const initialCount = (db.reviews || []).length;
  db.reviews = (db.reviews || []).filter(r => r.id !== id);

  if (db.reviews.length === initialCount) {
    return res.status(404).json({ success: false, message: "Review not found." });
  }

  saveDB(db);

  res.json({
    success: true,
    message: "Review deleted successfully."
  });
});

// 34. Download System Documentation PDF
app.get('/api/download-documentation-pdf', (req, res) => {
  const pdfPath = path.join(__dirname, 'public', 'Sri_Lakshmi_Annapurna_Tiffin_Center_Documentation.pdf');
  if (fs.existsSync(pdfPath)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Sri_Lakshmi_Annapurna_Tiffin_Center_Documentation.pdf"');
    res.sendFile(pdfPath);
  } else {
    res.status(404).json({ success: false, message: "Documentation PDF file not found." });
  }
});

// Start the Server
const server = app.listen(PORT, () => {
  console.log(`✅ Sri Lakshmi Annapurna Tiffin Center server running on port ${PORT}`);
  console.log(`🌐 Open: http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Please free the port and restart.`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});
