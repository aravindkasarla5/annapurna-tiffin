const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Default Initial Database Seed Data
const defaultSeed = {
  users: [
    {
      id: "usr_cust_1",
      name: "Ramesh Kumar",
      mobile: "9845012345",
      password: "customer123",
      role: "CUSTOMER",
      email: "ramesh.k@example.com",
      address: "#12, 4th Cross, Gandhi Nagar, Bengaluru, KA"
    },
    {
      id: "usr_owner_1",
      name: "Lakshmi Narayana (Owner)",
      mobile: "9876543210",
      password: "owner123",
      role: "OWNER",
      email: "owner@annapurna.com",
      address: "#42, Temple Road, Bengaluru, KA"
    }
  ],
  settings: {
    hotel_name: "Sri Lakshmi Annapurna Tiffin Center",
    hotel_logo: "/images/tiffin_logo.png",
    phone: "+91 98765 43210",
    address: "#42, Temple Road, Near Gandhi Circle, Bengaluru, KA",
    open_time: "06:30 AM",
    close_time: "10:30 PM",
    holidays: "None (Open 7 Days)",
    upi_id: "annapurna.tiffin@upi",
    upi_name: "Annapurna Tiffin Center",
    is_open: true,
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
      id: "tf_11",
      name: "Spicy Tomato Rice",
      description: "Flavorful spicy tomato cooked rice infused with South Indian spices, served with onion raita.",
      price: 50,
      category: "Lunch",
      image: "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=500&q=80",
      is_available: true
    },
    {
      id: "tf_12",
      name: "Chapati (2 Pieces + Kurma)",
      description: "Soft whole wheat chapatis served with aromatic mixed vegetable spicy kurma curry.",
      price: 50,
      category: "Dinner",
      image: "https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?auto=format&fit=crop&w=500&q=80",
      is_available: true
    }
  ],
  orders: [
    {
      id: "ord_1001",
      order_number: "TF1024",
      customer_name: "Ramesh Kumar",
      customer_mobile: "+91 98450 12345",
      order_type: "Takeaway",
      notes: "Please pack sambar separately in extra bag",
      payment_method: "UPI",
      payment_status: "Paid",
      order_status: "Completed",
      items: [
        { tiffin_id: "tf_3", name: "Masala Dosa", price: 70, quantity: 2 },
        { tiffin_id: "tf_1", name: "Idly (4 Pieces)", price: 40, quantity: 1 }
      ],
      grand_total: 180,
      created_at: new Date(Date.now() - 7200000).toISOString()
    },
    {
      id: "ord_1002",
      order_number: "TF1025",
      customer_name: "Priya Sharma",
      customer_mobile: "+91 97312 88990",
      order_type: "Dine-in",
      notes: "Extra coconut chutney please",
      payment_method: "Cash",
      payment_status: "Pending",
      order_status: "Preparing",
      items: [
        { tiffin_id: "tf_1", name: "Idly (4 Pieces)", price: 40, quantity: 2 },
        { tiffin_id: "tf_2", name: "Medu Vada (2 Pieces)", price: 45, quantity: 1 }
      ],
      grand_total: 125,
      created_at: new Date(Date.now() - 1800000).toISOString()
    }
  ],
  payments: [
    {
      id: "pay_1",
      order_number: "TF1024",
      customer_name: "Ramesh Kumar",
      amount: 180,
      payment_method: "Online Payment / UPI",
      payment_status: "Paid",
      date_time: new Date(Date.now() - 7200000).toLocaleString('en-IN')
    },
    {
      id: "pay_2",
      order_number: "TF1025",
      customer_name: "Priya Sharma",
      amount: 125,
      payment_method: "Cash",
      payment_status: "Pending",
      date_time: new Date(Date.now() - 1800000).toLocaleString('en-IN')
    }
  ],
  notifications: [
    {
      id: "notif_1",
      target_role: "CUSTOMER",
      order_number: "TF1024",
      message: "Your order #TF1024 has been completed. Thank you for dining with us!",
      is_read: false,
      created_at: new Date(Date.now() - 7200000).toISOString()
    },
    {
      id: "notif_2",
      target_role: "OWNER",
      order_number: "TF1025",
      message: "New order #TF1025 received from Priya Sharma (₹125)",
      is_read: false,
      created_at: new Date(Date.now() - 1800000).toISOString()
    }
  ],
  order_counter: 1026,
  ticket_counter: 1003,
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
      "id": "faq_3",
      "category": "Payments & Refunds",
      "question": "What payment methods do you accept?",
      "answer": "We accept Google Pay, PhonePe, Paytm, BHIM UPI payments directly to our UPI ID (annapurna.tiffin@upi) as well as Cash on pickup or dine-in."
    },
    {
      "id": "faq_4",
      "category": "Payments & Refunds",
      "question": "What happens if my payment succeeded but order status is pending?",
      "answer": "Our system automatically syncs payments within a few seconds. If any issue occurs, simply click 'Raise Support Ticket' with your Order ID, or call our support helpline (+91 98765 43210)."
    },
    {
      "id": "faq_5",
      "category": "Food Quality & Customization",
      "question": "Can I request extra sambar, chutneys, or mild spice levels?",
      "answer": "Yes! When placing your order, enter your special instructions in the 'Order Notes' field (e.g. 'Pack extra coconut chutney', 'Make dosa extra crispy', 'Less spicy sagu')."
    },
    {
      "id": "faq_6",
      "category": "Bulk & Catering Orders",
      "question": "Do you accept catering for family functions, office breakfast, or events?",
      "answer": "Yes, we specialize in bulk tiffin boxes and party catering for 10 to 500+ guests with pure ghee South Indian delicacies. Submit a inquiry ticket under 'Bulk & Catering Inquiry' or call us directly."
    }
  ],
  support_tickets: [
    {
      id: "tkt_1001",
      ticket_number: "TKT-1001",
      user_id: "usr_cust_1",
      customer_name: "Ramesh Kumar",
      customer_mobile: "9845012345",
      order_number: "TF1024",
      category: "Food Quality & Packaging",
      subject: "Request for extra chutney in takeaway package",
      priority: "Medium",
      status: "Resolved",
      created_at: new Date(Date.now() - 7200000).toISOString(),
      updated_at: new Date(Date.now() - 5400000).toISOString(),
      messages: [
        {
          id: "msg_1",
          sender_role: "CUSTOMER",
          sender_name: "Ramesh Kumar",
          message: "Hi, for order #TF1024 could you please add an extra container of coconut chutney? Thanks!",
          timestamp: new Date(Date.now() - 7200000).toISOString()
        },
        {
          id: "msg_2",
          sender_role: "OWNER",
          sender_name: "Lakshmi Narayana (Owner)",
          message: "Hello Ramesh! Noted, we have packed an extra container of freshly ground coconut chutney with your Masala Dosa order.",
          timestamp: new Date(Date.now() - 5400000).toISOString()
        }
      ]
    },
    {
      id: "tkt_1002",
      ticket_number: "TKT-1002",
      user_id: "usr_1786420826993",
      customer_name: "Ananya Rao",
      customer_mobile: "9123456789",
      order_number: "TF1028",
      category: "Takeaway & Delay",
      subject: "Estimated pickup time inquiry",
      priority: "High",
      status: "In Progress",
      created_at: new Date(Date.now() - 1800000).toISOString(),
      updated_at: new Date(Date.now() - 1200000).toISOString(),
      messages: [
        {
          id: "msg_3",
          sender_role: "CUSTOMER",
          sender_name: "Ananya Rao",
          message: "Hi team, I placed order #TF1028 for Medu Vada. Is it ready for pickup now?",
          timestamp: new Date(Date.now() - 1800000).toISOString()
        },
        {
          id: "msg_4",
          sender_role: "OWNER",
          sender_name: "Lakshmi Narayana (Owner)",
          message: "Hi Ananya, your order is ready and hot at the counter! You can pick it up anytime.",
          timestamp: new Date(Date.now() - 1200000).toISOString()
        }
      ]
    }
  ]
};

// Database Initialization & JSON persistence helper
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    saveDB(defaultSeed);
    return defaultSeed;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    const db = { ...defaultSeed, ...data };
    if (!db.faqs || !db.faqs.length) db.faqs = defaultSeed.faqs;
    if (!db.support_tickets) db.support_tickets = defaultSeed.support_tickets;
    if (!db.ticket_counter) db.ticket_counter = 1003;
    if (!db.referrals) db.referrals = [];
    if (!db.wallet_transactions) db.wallet_transactions = [];
    if (!db.reviews) db.reviews = [];
    if (!db.settings.referral) db.settings.referral = defaultSeed.settings.referral;
    return db;
  } catch (err) {
    console.error('Error reading db.json, resetting to seed:', err);
    saveDB(defaultSeed);
    return defaultSeed;
  }
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving db.json:', err);
  }
}

// REST API ROUTES

// AUTH 1. Register User (Customer / Owner)
app.post('/api/auth/register', (req, res) => {
  const db = loadDB();
  const { name, mobile, password, role, email, address, secret_key } = req.body;

  if (!name || !mobile || !password || !role) {
    return res.status(400).json({ success: false, message: "Name, mobile, password, and role are required." });
  }

  const cleanMobile = mobile.replace(/[^0-9]/g, '');

  if (role === 'OWNER' && secret_key && secret_key !== '1234') {
    return res.status(400).json({ success: false, message: "Invalid Hotel Owner Security Key. (Default: 1234)" });
  }

  const existing = (db.users || []).find(u => u.mobile.replace(/[^0-9]/g, '') === cleanMobile && u.role === role);
  if (existing) {
    return res.status(400).json({ success: false, message: `Mobile number already registered as ${role}. Please login.` });
  }

  // Generate Unique Referral Code for Customer
  const namePrefix = name.trim().replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5) || 'TIFFIN';
  const randomNum = Math.floor(10 + Math.random() * 90);
  const generatedRefCode = `${namePrefix}${randomNum}`;

  const newUser = {
    id: 'usr_' + Date.now(),
    name: name.trim(),
    mobile: mobile.trim(),
    password: password.trim(),
    role: role,
    email: (email || '').trim(),
    address: (address || '').trim(),
    referral_code: generatedRefCode,
    referred_by: null,
    wallet_balance: 0,
    show_on_leaderboard: true,
    created_at: new Date().toISOString()
  };

  // Handle Referral Code submitted during registration
  const submittedRefCode = (req.body.referral_code || '').trim().toUpperCase();
  let refMessage = '';

  if (submittedRefCode && role === 'CUSTOMER') {
    const referrer = (db.users || []).find(u => u.referral_code === submittedRefCode && u.role === 'CUSTOMER');
    if (referrer) {
      if (referrer.mobile.replace(/[^0-9]/g, '') === cleanMobile) {
        return res.status(400).json({ success: false, message: "Self-referral is not allowed." });
      }
      newUser.referred_by = referrer.mobile;
      if (!db.referrals) db.referrals = [];
      db.referrals.unshift({
        id: 'ref_' + Date.now(),
        referrer_mobile: referrer.mobile,
        referred_mobile: newUser.mobile,
        referred_name: newUser.name,
        order_number: null,
        status: 'Pending',
        reward_amount: Number(db.settings.referral?.referrer_reward || 30),
        date_time: new Date().toLocaleString('en-IN')
      });
      refMessage = ` ₹30 first-order referral discount applied!`;
    } else {
      return res.status(400).json({ success: false, message: "Invalid referral code. Please check and try again." });
    }
  }

  if (!db.users) db.users = [];
  db.users.push(newUser);
  saveDB(db);

  const userSafe = { ...newUser };
  delete userSafe.password;

  res.json({
    success: true,
    user: userSafe,
    message: `Account registered successfully as ${role === 'CUSTOMER' ? 'Customer' : 'Hotel Owner / Admin'}!${refMessage}`
  });
});

// AUTH 2. Login User (Customer / Owner)
app.post('/api/auth/login', (req, res) => {
  const db = loadDB();
  const { mobile, password, role } = req.body;

  if (!mobile || !password || !role) {
    return res.status(400).json({ success: false, message: "Mobile, password, and role are required." });
  }

  const cleanMobile = mobile.replace(/[^0-9]/g, '');
  const user = (db.users || []).find(u => 
    u.mobile.replace(/[^0-9]/g, '') === cleanMobile && 
    u.password === password.trim() && 
    u.role === role
  );

  if (!user) {
    return res.status(401).json({ 
      success: false, 
      message: `Invalid credentials or mobile number not registered as ${role}.` 
    });
  }

  const userSafe = { ...user };
  delete userSafe.password;

  res.json({
    success: true,
    user: userSafe,
    message: `Welcome back, ${user.name}!`
  });
});

// 1. GET Settings
app.get('/api/settings', (req, res) => {
  const db = loadDB();
  res.json({ success: true, data: db.settings });
});

// 1b. GET Owner Dashboard KPI Stats
app.get('/api/stats', (req, res) => {
  const db = loadDB();
  const allOrders = db.orders || [];

  const activeOrders = allOrders.filter(o => ['Received', 'Preparing', 'Ready'].includes(o.order_status));
  const completedOrders = allOrders.filter(o => o.order_status === 'Completed');
  const rejectedOrders = allOrders.filter(o => ['Rejected', 'Cancelled'].includes(o.order_status));
  const validOrders = allOrders.filter(o => !['Rejected', 'Cancelled'].includes(o.order_status));

  const totalSales = validOrders.reduce((sum, o) => sum + (Number(o.grand_total) || 0), 0);

  res.json({
    success: true,
    data: {
      total_orders: allOrders.length,
      active_orders: activeOrders.length,
      completed_orders: completedOrders.length,
      rejected_orders: rejectedOrders.length,
      total_sales: totalSales
    }
  });
});

// 2. PUT Update Settings
app.put('/api/settings', (req, res) => {
  const db = loadDB();
  db.settings = { ...db.settings, ...req.body };
  saveDB(db);
  res.json({ success: true, data: db.settings, message: "Hotel settings updated successfully." });
});

// 3. GET Menu Items
app.get('/api/menu', (req, res) => {
  const db = loadDB();
  res.json({ success: true, data: db.tiffins });
});

// 4. POST Add Tiffin Item
app.post('/api/menu', (req, res) => {
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

// 5. PUT Update Tiffin Item
app.put('/api/menu/:id', (req, res) => {
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

// 6. PATCH Toggle Tiffin Availability
app.patch('/api/menu/:id/availability', (req, res) => {
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

// 7. DELETE Tiffin Item
app.delete('/api/menu/:id', (req, res) => {
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

// 8. GET Orders
app.get('/api/orders', (req, res) => {
  const db = loadDB();
  res.json({ success: true, data: db.orders });
});

// 9. POST Create Order (Customer)
app.post('/api/orders', (req, res) => {
  const db = loadDB();

  // Check if hotel is open
  if (!db.settings.is_open) {
    return res.status(400).json({ success: false, message: "Hotel is currently closed. Orders are not being accepted." });
  }

  const { customer_name, customer_mobile, order_type, delivery_address, notes, payment_method, payment_screenshot, utr_number, items, used_wallet_amount } = req.body;

  if (!customer_name || !customer_mobile || !items || !items.length) {
    return res.status(400).json({ success: false, message: "Name, mobile, and ordered items are required." });
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

  // Handle Wallet Balance Redemption
  let walletDeducted = 0;
  const cleanMobile = customer_mobile.replace(/[^0-9]/g, '');
  const customerUser = (db.users || []).find(u => u.mobile.replace(/[^0-9]/g, '') === cleanMobile);

  if (used_wallet_amount && Number(used_wallet_amount) > 0 && customerUser) {
    const maxWalletUse = Math.min(Number(customerUser.wallet_balance || 0), Number(used_wallet_amount), grand_total);
    if (maxWalletUse > 0) {
      walletDeducted = maxWalletUse;
      customerUser.wallet_balance = (customerUser.wallet_balance || 0) - walletDeducted;
      grand_total = Math.max(0, grand_total - walletDeducted);

      if (!db.wallet_transactions) db.wallet_transactions = [];
      db.wallet_transactions.unshift({
        id: 'wtx_' + Date.now(),
        customer_mobile: customerUser.mobile,
        type: 'DEBIT',
        amount: walletDeducted,
        description: `Redeemed on Order #${orderNum}`,
        date_time: new Date().toLocaleString('en-IN')
      });
    }
  }

  const isUPI = (payment_method || '').includes('UPI') || (payment_method || '').includes('Online');
  const initialPaymentStatus = isUPI ? 'Verification Pending (UPI)' : 'Pending';

  const newOrder = {
    id: 'ord_' + Date.now(),
    order_number: orderNum,
    customer_name: customer_name.trim(),
    customer_mobile: customer_mobile.trim(),
    order_type: order_type || 'Takeaway',
    delivery_address: (delivery_address || '').trim() || (order_type === 'Delivery' ? 'Home Delivery Address' : 'Counter Pickup'),
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

  // Record payment
  db.payments.unshift({
    id: 'pay_' + Date.now(),
    order_number: orderNum,
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
    target_role: 'OWNER',
    order_number: orderNum,
    message: ownerMsg,
    is_read: false,
    created_at: new Date().toISOString()
  });

  // Customer Notification
  db.notifications.unshift({
    id: 'notif_' + (Date.now() + 1),
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

// 9b. PATCH Owner Verify UPI Payment
app.patch('/api/orders/:id/payment-verify', (req, res) => {
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

  // Customer notification
  db.notifications.unshift({
    id: 'notif_' + Date.now(),
    target_role: 'CUSTOMER',
    order_number: order.order_number,
    message: `Payment update for Order #${order.order_number}: Marked as ${validStatus}!`,
    is_read: false,
    created_at: new Date().toISOString()
  });

  saveDB(db);
  res.json({ success: true, data: order, message: `Payment for Order #${order.order_number} marked as ${validStatus}.` });
});

// 10. PATCH Order Status (Owner)
app.patch('/api/orders/:id/status', (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const { order_status } = req.body;

  const order = db.orders.find(o => o.id === id || o.order_number === id);
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found." });
  }

  order.order_status = order_status;
  if (order_status === 'Completed' && order.payment_method === 'Cash') {
    order.payment_status = 'Cash Received';
    const payItem = db.payments.find(p => p.order_number === order.order_number);
    if (payItem) payItem.payment_status = 'Cash Received';
  }

  // Check Referral Reward Trigger upon Order Completion
  if (order_status === 'Completed' && db.settings.referral?.enabled !== false) {
    const cleanCustMobile = order.customer_mobile.replace(/[^0-9]/g, '');
    const pendingRef = (db.referrals || []).find(r => 
      r.referred_mobile.replace(/[^0-9]/g, '') === cleanCustMobile && 
      r.status === 'Pending'
    );

    if (pendingRef) {
      const referrerUser = (db.users || []).find(u => u.mobile.replace(/[^0-9]/g, '') === pendingRef.referrer_mobile.replace(/[^0-9]/g, ''));
      if (referrerUser) {
        const rewardVal = Number(pendingRef.reward_amount || db.settings.referral?.referrer_reward || 30);
        referrerUser.wallet_balance = (referrerUser.wallet_balance || 0) + rewardVal;
        
        pendingRef.status = 'Completed';
        pendingRef.order_number = order.order_number;

        if (!db.wallet_transactions) db.wallet_transactions = [];
        db.wallet_transactions.unshift({
          id: 'wtx_' + Date.now(),
          customer_mobile: referrerUser.mobile,
          type: 'CREDIT',
          amount: rewardVal,
          description: `Referral Reward for friend ${order.customer_name}'s first order #${order.order_number}`,
          date_time: new Date().toLocaleString('en-IN')
        });

        // Check Milestone Bonuses (5 & 10 referrals)
        const completedRefsCount = db.referrals.filter(r => 
          r.referrer_mobile.replace(/[^0-9]/g, '') === referrerUser.mobile.replace(/[^0-9]/g, '') && 
          r.status === 'Completed'
        ).length;

        let bonusMsg = '';
        if (completedRefsCount === 5) {
          referrerUser.wallet_balance += 100;
          db.wallet_transactions.unshift({
            id: 'wtx_' + (Date.now() + 1),
            customer_mobile: referrerUser.mobile,
            type: 'CREDIT',
            amount: 100,
            description: `🏆 Referral Champion Bonus (5 Friends Reached!)`,
            date_time: new Date().toLocaleString('en-IN')
          });
          bonusMsg = ' Plus ₹100 Milestone Bonus added!';
        } else if (completedRefsCount === 10) {
          referrerUser.wallet_balance += 250;
          db.wallet_transactions.unshift({
            id: 'wtx_' + (Date.now() + 2),
            customer_mobile: referrerUser.mobile,
            type: 'CREDIT',
            amount: 250,
            description: `🏆 Master Referrer Milestone Bonus (10 Friends Reached!)`,
            date_time: new Date().toLocaleString('en-IN')
          });
          bonusMsg = ' Plus ₹250 Milestone Bonus added!';
        }

        // Notify Referrer
        db.notifications.unshift({
          id: 'notif_' + Date.now(),
          target_role: 'CUSTOMER',
          order_number: order.order_number,
          message: `🎉 Referral Reward! Your friend ${order.customer_name} completed order #${order.order_number}. ₹${rewardVal} added to your Referral Wallet!${bonusMsg}`,
          is_read: false,
          created_at: new Date().toISOString()
        });
      }
    }
  } else if (order_status === 'Rejected' || order_status === 'Cancelled') {
    const cleanCustMobile = order.customer_mobile.replace(/[^0-9]/g, '');
    const pendingRef = (db.referrals || []).find(r => 
      r.referred_mobile.replace(/[^0-9]/g, '') === cleanCustMobile && 
      r.status === 'Pending'
    );
    if (pendingRef) {
      pendingRef.status = 'Cancelled';
    }
  }

  // Create Customer Notification
  let notifMsg = `Your order #${order.order_number} status updated to ${order_status}.`;
  if (order_status === 'Preparing') notifMsg = `Your order #${order.order_number} is being prepared! 🍳`;
  if (order_status === 'Ready') notifMsg = `Your order #${order.order_number} is ready for ${order.order_type === 'Dine-in' ? 'table serving' : 'pickup'}! 🔔`;
  if (order_status === 'Completed') notifMsg = `Your order #${order.order_number} has been completed. Enjoy your meal! 🎉`;
  if (order_status === 'Rejected') notifMsg = `Your order #${order.order_number} was rejected by the hotel.`;

  db.notifications.unshift({
    id: 'notif_' + Date.now(),
    target_role: 'CUSTOMER',
    order_number: order.order_number,
    message: notifMsg,
    is_read: false,
    created_at: new Date().toISOString()
  });

  saveDB(db);
  res.json({ success: true, data: order, message: `Order #${order.order_number} marked as ${order_status}.` });
});

// 10b. DELETE Order Record
app.delete('/api/orders/:id', (req, res) => {
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

// 11. GET Payments
app.get('/api/payments', (req, res) => {
  const db = loadDB();
  const { customer_mobile, role } = req.query;
  let list = db.payments || [];

  if (role === 'CUSTOMER' || customer_mobile) {
    if (customer_mobile) {
      const cleanMobile = customer_mobile.replace(/[^0-9]/g, '');
      list = list.filter(p => {
        if (p.customer_mobile && p.customer_mobile.replace(/[^0-9]/g, '') === cleanMobile) return true;
        const matchingOrder = (db.orders || []).find(o => o.order_number === p.order_number);
        if (matchingOrder && matchingOrder.customer_mobile.replace(/[^0-9]/g, '') === cleanMobile) return true;
        return false;
      });
    }
  }

  res.json({ success: true, data: list });
});

// 12. PATCH Payment Status
app.patch('/api/payments/:id/status', (req, res) => {
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

// 13. GET Notifications
app.get('/api/notifications', (req, res) => {
  const db = loadDB();
  const { role } = req.query;
  let list = db.notifications;
  if (role) {
    list = list.filter(n => n.target_role === role.toUpperCase());
  }
  res.json({ success: true, data: list });
});

// 14. PATCH Mark Notifications Read
app.patch('/api/notifications/read-all', (req, res) => {
  const db = loadDB();
  const { role } = req.body;
  db.notifications.forEach(n => {
    if (!role || n.target_role === role.toUpperCase()) {
      n.is_read = true;
    }
  });
  saveDB(db);
  res.json({ success: true, message: "Notifications marked as read." });
});

// 15. GET Dashboard Stats (Owner)
app.get('/api/stats', (req, res) => {
  const db = loadDB();
  const today = new Date().toDateString();

  const todayOrders = db.orders.filter(o => new Date(o.created_at).toDateString() === today);
  const pendingOrders = db.orders.filter(o => o.order_status === 'Received');
  const preparingOrders = db.orders.filter(o => o.order_status === 'Preparing');
  const completedOrders = db.orders.filter(o => o.order_status === 'Completed');

  const todaySales = db.orders.reduce((acc, o) => {
    if (o.order_status === 'Completed' || o.payment_status === 'Paid' || o.payment_status === 'Cash Received') {
      return acc + o.grand_total;
    }
    return acc;
  }, 0);

  res.json({
    success: true,
    data: {
      todays_orders: todayOrders.length || db.orders.length,
      pending_orders: pendingOrders.length,
      preparing_orders: preparingOrders.length,
      completed_orders: completedOrders.length,
      todays_sales: todaySales
    }
  });
});

// 16. GET Support FAQs
app.get('/api/support/faqs', (req, res) => {
  const db = loadDB();
  res.json({ success: true, data: db.faqs || [] });
});

// 17. GET Support Tickets
app.get('/api/support/tickets', (req, res) => {
  const db = loadDB();
  const { user_id, mobile, role } = req.query;
  let list = db.support_tickets || [];

  if (role === 'CUSTOMER') {
    if (user_id || mobile) {
      const cleanMobile = (mobile || '').replace(/[^0-9]/g, '');
      list = list.filter(t => 
        (user_id && t.user_id === user_id) || 
        (cleanMobile && t.customer_mobile.replace(/[^0-9]/g, '') === cleanMobile)
      );
    }
  }

  // Sort by updated_at descending
  list.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

  res.json({ success: true, data: list });
});

// 18. POST Create Support Ticket
app.post('/api/support/tickets', (req, res) => {
  const db = loadDB();
  const { user_id, customer_name, customer_mobile, order_number, category, subject, priority, message } = req.body;

  if (!customer_name || !customer_mobile || !subject || !message) {
    return res.status(400).json({ success: false, message: "Name, mobile, subject, and message are required." });
  }

  if (!db.ticket_counter) db.ticket_counter = 1003;
  const tktNum = `TKT-${db.ticket_counter}`;
  db.ticket_counter += 1;

  const now = new Date().toISOString();
  const newTicket = {
    id: 'tkt_' + Date.now(),
    ticket_number: tktNum,
    user_id: user_id || ('usr_' + Date.now()),
    customer_name: customer_name.trim(),
    customer_mobile: customer_mobile.trim(),
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
        sender_name: customer_name.trim(),
        message: message.trim(),
        timestamp: now
      }
    ]
  };

  if (!db.support_tickets) db.support_tickets = [];
  db.support_tickets.unshift(newTicket);

  // Notifications
  db.notifications.unshift({
    id: 'notif_' + Date.now(),
    target_role: 'OWNER',
    order_number: newTicket.order_number,
    message: `🆘 New support ticket #${tktNum} from ${newTicket.customer_name}: "${subject}"`,
    is_read: false,
    created_at: now
  });

  db.notifications.unshift({
    id: 'notif_' + (Date.now() + 1),
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

// 19. POST Add Reply Message to Support Ticket
app.post('/api/support/tickets/:id/messages', (req, res) => {
  const db = loadDB();
  const { id } = req.params;
  const { sender_role, sender_name, message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, message: "Message content cannot be empty." });
  }

  const ticket = (db.support_tickets || []).find(t => t.id === id || t.ticket_number === id);
  if (!ticket) {
    return res.status(404).json({ success: false, message: "Support ticket not found." });
  }

  const now = new Date().toISOString();
  const newMsg = {
    id: 'msg_' + Date.now(),
    sender_role: sender_role || 'CUSTOMER',
    sender_name: (sender_name || (sender_role === 'OWNER' ? 'Lakshmi Narayana (Owner)' : 'Customer')).trim(),
    message: message.trim(),
    timestamp: now
  };

  ticket.messages.push(newMsg);
  ticket.updated_at = now;

  if (sender_role === 'OWNER' && ticket.status === 'Open') {
    ticket.status = 'In Progress';
  }

  // Create notifications
  if (sender_role === 'OWNER') {
    db.notifications.unshift({
      id: 'notif_' + Date.now(),
      target_role: 'CUSTOMER',
      order_number: ticket.order_number,
      message: `💬 Hotel reply on Ticket #${ticket.ticket_number}: "${message.trim().slice(0, 45)}..."`,
      is_read: false,
      created_at: now
    });
  } else {
    db.notifications.unshift({
      id: 'notif_' + Date.now(),
      target_role: 'OWNER',
      order_number: ticket.order_number,
      message: `💬 New message on Ticket #${ticket.ticket_number} from ${sender_name || 'Customer'}`,
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

// 20. PATCH Support Ticket Status
app.patch('/api/support/tickets/:id/status', (req, res) => {
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

// 21. DELETE Support Ticket
app.delete('/api/support/tickets/:id', (req, res) => {
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

// 22. GET Customer Referral Stats & Wallet
app.get('/api/referrals/stats', (req, res) => {
  const db = loadDB();
  const { customer_mobile } = req.query;

  if (!customer_mobile) {
    return res.status(400).json({ success: false, message: "Customer mobile number is required." });
  }

  const cleanMobile = customer_mobile.replace(/[^0-9]/g, '');
  const user = (db.users || []).find(u => u.mobile.replace(/[^0-9]/g, '') === cleanMobile);

  if (!user) {
    return res.status(404).json({ success: false, message: "Customer account not found." });
  }

  // Ensure user has a referral_code
  if (!user.referral_code) {
    const namePrefix = user.name.trim().replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5) || 'TIFFIN';
    user.referral_code = `${namePrefix}${Math.floor(10 + Math.random() * 90)}`;
    saveDB(db);
  }

  const userReferrals = (db.referrals || []).filter(r => r.referrer_mobile.replace(/[^0-9]/g, '') === cleanMobile);
  const totalCount = userReferrals.length;
  const completedCount = userReferrals.filter(r => r.status === 'Completed').length;
  const pendingCount = userReferrals.filter(r => r.status === 'Pending').length;
  const totalEarned = userReferrals.filter(r => r.status === 'Completed').reduce((s, r) => s + Number(r.reward_amount || 30), 0);

  const walletTx = (db.wallet_transactions || []).filter(w => w.customer_mobile.replace(/[^0-9]/g, '') === cleanMobile);

  res.json({
    success: true,
    data: {
      referral_code: user.referral_code,
      wallet_balance: Number(user.wallet_balance || 0),
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

// 23. GET Monthly Top Referrers Leaderboard
app.get('/api/referrals/leaderboard', (req, res) => {
  const db = loadDB();
  const customerMap = {};

  (db.referrals || []).filter(r => r.status === 'Completed').forEach(r => {
    const cleanMobile = r.referrer_mobile.replace(/[^0-9]/g, '');
    if (!customerMap[cleanMobile]) {
      customerMap[cleanMobile] = { mobile: cleanMobile, count: 0, rewards: 0 };
    }
    customerMap[cleanMobile].count += 1;
    customerMap[cleanMobile].rewards += Number(r.reward_amount || 30);
  });

  let leaderboard = Object.values(customerMap).map(item => {
    const user = (db.users || []).find(u => u.mobile.replace(/[^0-9]/g, '') === item.mobile);
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

// 24. PATCH Customer Leaderboard Privacy Toggle
app.patch('/api/referrals/privacy', (req, res) => {
  const db = loadDB();
  const { customer_mobile, show_on_leaderboard } = req.body;
  if (!customer_mobile) {
    return res.status(400).json({ success: false, message: "Mobile number is required." });
  }

  const cleanMobile = customer_mobile.replace(/[^0-9]/g, '');
  const user = (db.users || []).find(u => u.mobile.replace(/[^0-9]/g, '') === cleanMobile);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found." });
  }

  user.show_on_leaderboard = Boolean(show_on_leaderboard);
  saveDB(db);
  res.json({ success: true, message: `Leaderboard visibility updated to ${user.show_on_leaderboard ? 'Public' : 'Anonymous'}.` });
});

// 25. POST Owner Save Referral Program Settings
app.post('/api/owner/referrals/settings', (req, res) => {
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

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Sri Lakshmi Annapurna Tiffin Center Server Running `);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(`====================================================`);
});

// =========================================================================
// POST-ORDER REVIEW & RATING API ENDPOINTS
// =========================================================================

// 26. POST Submit Order Review & Rating
app.post('/api/reviews', (req, res) => {
  const db = loadDB();
  const { order_number, customer_name, customer_mobile, rating, comment, issues, is_public } = req.body;

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
    customer_name: (customer_name || 'Valued Customer').trim(),
    customer_mobile: (customer_mobile || '').trim(),
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
      target_role: 'OWNER',
      order_number: order_number,
      message: ownerAlert,
      is_read: false,
      created_at: new Date().toISOString()
    });

    // Auto-create a high priority support ticket for low ratings if issues reported
    if (!db.ticket_counter) db.ticket_counter = 1003;
    const tktNum = `TKT-${db.ticket_counter}`;
    db.ticket_counter += 1;

    db.support_tickets.unshift({
      id: 'tkt_' + Date.now(),
      ticket_number: tktNum,
      user_id: 'usr_' + Date.now(),
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
      target_role: 'OWNER',
      order_number: order_number,
      message: `🌟 5-Star Review Received! Order #${order_number} rated ${numRating}/5 stars by ${newReview.customer_name}!`,
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

// 27. GET Order Reviews
app.get('/api/reviews', (req, res) => {
  const db = loadDB();
  const { public_only, mobile } = req.query;
  let list = db.reviews || [];

  if (public_only === 'true') {
    list = list.filter(r => r.is_public && r.rating >= 4);
  }

  if (mobile) {
    const cleanMobile = mobile.replace(/[^0-9]/g, '');
    list = list.filter(r => r.customer_mobile.replace(/[^0-9]/g, '') === cleanMobile);
  }

  res.json({ success: true, data: list });
});

// 28. GET Review Statistics & Metrics
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

// Start the Server
app.listen(PORT, () => {
  console.log(`✅ Sri Lakshmi Annapurna Tiffin Center server running on port ${PORT}`);
  console.log(`🌐 Open: http://localhost:${PORT}`);
});
