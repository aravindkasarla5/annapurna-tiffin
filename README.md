# 🍲 Sri Lakshmi Annapurna Tiffin Center

> **Modern mobile-first web application for an authentic South Indian tiffin & meals restaurant in Bengaluru, India.**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.19-blue)](https://expressjs.com)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## 🌟 Features

### Customer Side
- 🍽️ Browse today's menu with search & category filters
- 🛒 Add to cart, choose Takeaway or Dine-in
- 💳 Pay via UPI (screenshot upload) or Cash
- 📦 Track live order status in real-time
- 🎁 Referral program with ₹30 wallet rewards
- 🎧 Customer support tickets & AI quick assistant
- 📊 Payment history with CSV download & PDF invoices

### Owner / Admin Side
- 📊 Live KPI dashboard (orders, revenue, active orders)
- 📋 Full orders management with status updates
- 🍽️ Menu management (add, edit, toggle availability, delete)
- 💰 UPI payment verification panel
- ⚙️ Hotel settings management
- 🎁 Referral program configuration

---

## 🚀 Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express.js |
| Frontend | Vanilla HTML5, CSS3, JavaScript |
| Database | JSON flat-file (db.json) |
| Fonts | Google Fonts (Outfit) |
| Icons | Font Awesome 6.4 |

---

## 📦 Installation & Local Setup

`ash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/annapurna-tiffin.git
cd annapurna-tiffin

# 2. Install dependencies
npm install

# 3. Start the server
npm start

# 4. Open in browser
# http://localhost:3000
`

---

## 🔑 Default Login Credentials

| Role | Mobile | Password |
|------|--------|----------|
| Customer | 9845012345 | customer123 |
| Owner | 9876543210 | owner123 |

> **Owner Secret Key:** 1234

---

## 🌐 Deployment (Render.com)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your GitHub repo
4. Set:
   - **Build Command:** 
pm install
   - **Start Command:** 
pm start
   - **Environment:** Node
5. Click **Deploy** — your site will be live in ~2 minutes!

---

## 📁 Project Structure

`
tiffin/
├── server.js          # Express backend + all REST API routes
├── db.json            # JSON database (auto-created on first run)
├── package.json       # Project config
└── public/
    ├── index.html     # Single-page application shell
    ├── css/
    │   └── styles.css # Complete design system
    ├── js/
    │   └── app.js     # All client-side logic
    └── images/        # Food photos & logo
`

---

## 📞 Contact

- 📍 #42, Temple Road, Near Gandhi Circle, Bengaluru, KA
- 📞 +91 98765 43210
- ✉️ support@annapurna.com
- ⏰ Open: 06:30 AM – 10:30 PM (7 days/week)

---

*Made with ❤️ for authentic South Indian food lovers*
