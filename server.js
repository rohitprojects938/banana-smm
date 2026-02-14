const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

console.log("ENV CHECK:", process.env.GOOGLE_CLIENT_ID);

const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const axios = require("axios");
const cron = require("node-cron");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const multer = require("multer");
const fs = require("fs");

const app = express();

// --- Configuration ---
const PORT = 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'secure-smm-saas-key-2026';

// --- MySQL Connection Pool ---
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test Database Connection
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log("MySQL connected successfully");
    connection.release();
    initDB(); // Initialize tables after connection
  } catch (error) {
    console.error("MySQL connection error:", error.message);
  }
})();

// --- Database Schema Initialization (MySQL) ---
async function initDB() {
  try {
    // Users Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255),
        email VARCHAR(255),
        password VARCHAR(255),
        balance DECIMAL(10,2) DEFAULT 0.00,
        currency VARCHAR(10) DEFAULT 'INR',
        is_admin TINYINT(1) DEFAULT 0,
        is_developer TINYINT(1) DEFAULT 0,
        api_key VARCHAR(255),
        google_id VARCHAR(255) UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Services Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS services (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category VARCHAR(255),
        name VARCHAR(255),
        rate DECIMAL(10,2),
        min INT,
        max INT,
        provider_id INT DEFAULT 0,
        provider_service_id INT DEFAULT 0,
        status TINYINT(1) DEFAULT 1
      )
    `);

    // Providers Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS providers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255),
        url TEXT,
        api_key VARCHAR(255),
        balance DECIMAL(10,2) DEFAULT 0,
        status TINYINT(1) DEFAULT 1
      )
    `);

    // Orders Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        service_id INT,
        link TEXT,
        quantity INT,
        charge DECIMAL(10,2),
        start_count INT DEFAULT 0,
        remains INT DEFAULT 0,
        status VARCHAR(50) DEFAULT 'Pending',
        provider_order_id INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Transactions Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        amount DECIMAL(10,2),
        type VARCHAR(50),
        txn_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Site Settings Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        \`key\` VARCHAR(255) UNIQUE NOT NULL,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Default Landing Config
    const defaultLandingConfig = {
      sections: [
        { id: 'navbar', name: 'Navigation Bar', enabled: true },
        { id: 'hero', name: 'Hero Section', enabled: true },
        { id: 'trusted', name: 'Trusted By Logos', enabled: true },
        { id: 'features', name: 'Features Grid', enabled: true },
        { id: 'services', name: 'Services Tabs', enabled: true },
        { id: 'tutorial', name: 'How It Works', enabled: true },
        { id: 'api', name: 'API Section', enabled: true },
        { id: 'reviews', name: 'Reviews', enabled: true },
        { id: 'faq', name: 'FAQ Section', enabled: true },
        { id: 'cta', name: 'Final CTA', enabled: true },
        { id: 'footer', name: 'Footer', enabled: true }
      ],
      content: {
        brand_name: "Banana SMM",
        hero_headline: "Skyrocket Your Social Presence with Banana SMM Instantly",
        hero_subheadline: "The secret weapon for 10,000+ Indian Creators & Agencies. Get instant non-drop followers, likes, and views starting at just ₹1.",
        hero_cta_primary: "Get Started",
        hero_cta_secondary: "Explore Services",
        cta_headline: "Start Growing Today with Banana SMM",
        whatsapp_number: "919999999999"
      }
    };

    await pool.query(`
      INSERT INTO site_settings (\`key\`, value) 
      VALUES ('landing_page_config', ?) 
      ON DUPLICATE KEY UPDATE value = value
    `, [JSON.stringify(defaultLandingConfig)]);

    // Seed Admin
    const [adminRows] = await pool.query("SELECT id FROM users WHERE username='admin'");
    if (adminRows.length === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      const key = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
      await pool.query(
        "INSERT INTO users (username, password, is_admin, api_key) VALUES (?, ?, ?, ?)",
        ['admin', hash, 1, key]
      );
      console.log("Admin account created: admin / admin123");
    }

  } catch (err) {
    console.error("DB Init Error:", err);
  }
}

// --- Multer Storage for Image Uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './public/uploads/landing';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, 'img-' + Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// --- Passport Configuration ---
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
        const name = profile.displayName || "Google User";

        // Check if user exists
        const [rows] = await pool.query("SELECT * FROM users WHERE google_id = ?", [googleId]);
        
        if (rows.length > 0) {
          return done(null, rows[0]);
        }

        // Create new user
        const apiKey = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
        
        const [result] = await pool.query(
          "INSERT INTO users (google_id, email, username, balance, currency, is_admin, is_developer, api_key) VALUES (?, ?, ?, 0.00, 'INR', 0, 0, ?)",
          [googleId, email, name, apiKey]
        );

        const [newUserRows] = await pool.query("SELECT * FROM users WHERE id = ?", [result.insertId]);
        return done(null, newUserRows[0]);

      } catch (err) {
        return done(err);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
    done(null, rows[0]);
  } catch (err) {
    done(err, null);
  }
});

// --- Middleware ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

app.set('view engine', 'ejs');

// --- Global View Variables ---
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.path = req.path;

  // SAFE fallback so EJS never crashes
  res.locals.data = {
    brand_name: "Banana SMM",
    hero_headline: "Skyrocket Your Social Presence with Banana SMM Instantly",
    hero_subheadline: "The secret weapon for 10,000+ Indian Creators & Agencies."
  };

  next();
});


// --- Helpers ---
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect('/auth');
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.userId || !req.session.isAdmin) return res.redirect('/dashboard');
  next();
};

// --- CRON JOB ---
cron.schedule('*/2 * * * *', async () => {
  console.log("Cron: Auto processing pending manual orders");

  try {
    const [orders] = await pool.query(`
      SELECT o.*, s.provider_service_id, s.provider_id, p.url, p.api_key
      FROM orders o
      JOIN services s ON s.id = o.service_id
      JOIN providers p ON p.id = s.provider_id
      WHERE o.status = 'Pending Manual'
        AND p.status = 1
      LIMIT 20
    `);

    console.log("Orders found:", orders.length);

    for (const order of orders) {
      try {
        console.log("Retrying order:", order.id);

        const resp = await axios.post(order.url, {
          key: order.api_key,
          action: "add",
          service: order.provider_service_id,
          link: order.link,
          quantity: order.quantity
        });

        if (resp.data && resp.data.order) {
          await pool.query(
            "UPDATE orders SET provider_order_id=?, status='Processing' WHERE id=?",
            [resp.data.order, order.id]
          );

          console.log("SUCCESS placed:", order.id);
        } else {
          console.log("Provider rejected:", order.id, resp.data);
        }

      } catch (err) {
        console.log("Retry failed:", order.id, err.response?.data || err.message);
      }
    }

  } catch (err) {
    console.log("Cron fatal error:", err.message);
  }
});

cron.schedule('0 3 * * *', async () => {
  console.log("CRON: Checking negative margin services");

  try {
    // 1. Check negative margin
    const [lossRows] = await pool.query(`
      SELECT id, name, rate, selling_rate
      FROM services
      WHERE selling_rate < rate
    `);

    if (lossRows.length === 0) {
      console.log("CRON: No loss services found");
      return;
    }

    console.log(`CRON: Found ${lossRows.length} loss services`);

    // 2. Auto-fix
    await pool.query(`
      UPDATE services
      SET selling_rate = ROUND(rate * 1.6, 2)
      WHERE selling_rate < rate
    `);

    console.log("CRON: Loss services auto-fixed with 60% margin");

  } catch (err) {
    console.error("CRON margin fix error:", err.message);
  }
});



// --- Helper to get landing config ---
async function getLandingConfig(cb) {
  try {
    const [rows] = await pool.query("SELECT value FROM site_settings WHERE `key` = 'landing_page_config'");
    
    // Default fallback (same as in initDB)
    const fallback = {
      sections: [], 
      content: {
        brand_name: "Banana SMM",
        hero_headline: "Skyrocket Your Social Presence with Banana SMM Instantly",
        hero_subheadline: "The secret weapon for 10,000+ Indian Creators & Agencies."
      }
    };

    if (rows.length === 0 || !rows[0].value) {
      return cb(fallback);
    }

    try {
      const parsed = JSON.parse(rows[0].value);
      return cb(parsed);
    } catch (e) {
      console.log("Landing config JSON parse error:", e);
      return cb(fallback);
    }
  } catch (err) {
    console.log("Landing config read error:", err);
    return cb({ sections: [], content: {} });
  }
}

// ------------------------------
// ROUTES
// ------------------------------

// Landing page
app.get("/", (req, res) => {
  getLandingConfig((config) => {
    res.render("landing", {
      landing: config,
      user: req.session.userId ? { username: req.session.user?.username || req.session.username } : null
    });
  });
});

// Admin Landing Editor Page
app.get("/admin/landing-editor", requireAdmin, (req, res) => {
  getLandingConfig((config) => {
    res.render("admin/landing_editor", { landing: config });
  });
});

// Save Landing Editor Data
app.post("/admin/save-landing", requireAdmin, async (req, res) => {
  // Use generic key/value logic for saving full config from editor
  // Editor sends full object { sections: [], content: {} }
  try {
    const configStr = JSON.stringify(req.body);
    await pool.query(
      "INSERT INTO site_settings (`key`, value) VALUES ('landing_page_config', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [configStr]
    );
    res.json({ success: true, message: "Saved" });
  } catch (err) {
    console.log("Landing save error:", err);
    res.status(500).json({ success: false, message: "Save failed" });
  }
});

// API: Save Landing Config (Duplicate route for consistency with previous prompt requirement)
app.post('/api/admin/landing-config', requireAdmin, async (req, res) => {
    try {
      const configStr = JSON.stringify(req.body);
      await pool.query(
        "INSERT INTO site_settings (`key`, value) VALUES ('landing_page_config', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
        [configStr]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
});

// API: Upload Image
app.post('/api/admin/landing-upload', requireAdmin, upload.single('image'), (req, res) => {
    if(!req.file) return res.status(400).json({error: 'No file'});
    res.json({ url: '/uploads/landing/' + req.file.filename });
});

// Auth Page
app.get('/auth', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('layout', { body: 'auth', pageTitle: 'Login / Signup' });
});

// Google Auth
app.get('/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account'
  })
);


app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/auth' }),
  (req, res) => {
    // Session Bridge
    req.session.userId = req.user.id;
    req.session.user = req.user;
    req.session.isAdmin = req.user.is_admin;
    res.redirect('/dashboard');
  }
);

// Signup
app.post('/auth/signup', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('layout', { body: 'auth', pageTitle: 'Login / Signup', error: 'All fields required' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const apiKey = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

    const [result] = await pool.query(
      "INSERT INTO users (username, password, api_key) VALUES (?, ?, ?)", 
      [username, hash, apiKey]
    );

    req.session.userId = result.insertId;
    req.session.user = { id: result.insertId, username, is_admin: 0, balance: 0 };
    req.session.isAdmin = 0;

    res.redirect('/dashboard');
  } catch (err) {
    return res.render('layout', { body: 'auth', pageTitle: 'Login / Signup', error: 'Username taken' });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);
    const user = rows[0];

    if (!user) {
      return res.render('layout', { body: 'auth', pageTitle: 'Login / Signup', error: 'Invalid credentials' });
    }

    if (!user.password) { // Google users might have empty password
       return res.render('layout', { body: 'auth', pageTitle: 'Login / Signup', error: 'Please login with Google' });
    }

    if (!(await bcrypt.compare(password, user.password))) {
      return res.render('layout', { body: 'auth', pageTitle: 'Login / Signup', error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.user = user;
    req.session.isAdmin = user.is_admin;

    res.redirect('/dashboard');
  } catch (err) {
    return res.render('layout', { body: 'auth', pageTitle: 'Login / Signup', error: 'Server error' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Dashboard
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    const [[user]] = await pool.query(
      "SELECT balance FROM users WHERE id = ?",
      [userId]
    );
    req.session.user.balance = user.balance;

    const [statsRows] = await pool.query(
      "SELECT count(*) as total, sum(case when status='Pending' then 1 else 0 end) as pending, sum(case when status='Completed' then 1 else 0 end) as completed FROM orders WHERE user_id = ?",
      [userId]
    );
    let stats = statsRows[0];
    if (!stats) stats = { total: 0, pending: 0, completed: 0 };

    const [recentOrders] = await pool.query(
      "SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 5",
      [userId]
    );

    res.render('layout', {
      body: 'dashboard',
      pageTitle: 'Dashboard',
      stats,
      recentOrders: recentOrders || []
    });
  } catch (err) {
    console.error(err);
    res.redirect('/auth');
  }
});

// New Order Page
app.get('/order/new', requireAuth, async (req, res) => {
  try {
    const [services] = await pool.query("SELECT * FROM services WHERE status=1 ORDER BY category");
    res.render('layout', { body: 'order_new', pageTitle: 'New Order', services: services || [] });
  } catch (err) {
    console.error(err);
    res.render('layout', { body: 'order_new', pageTitle: 'New Order', services: [] });
  }
});



app.post("/api/place-order", requireAuth, async (req, res) => {
  const { service_id, link, quantity } = req.body;
  const userId = req.session.userId;

  let charge = 0;
  let orderId = null;

  try {
    // 1. Get service
    const [[service]] = await pool.query(
      "SELECT * FROM services WHERE id = ? AND status = 1",
      [service_id]
    );

    // ❌ block if quantity less than provider min
if (service.min && Number(quantity) < Number(service.min)) {
  return res.status(400).json({
    error: `Minimum quantity for this service is ${service.min}`
  });
}

// ❌ block if quantity more than provider max
if (service.max && Number(quantity) > Number(service.max)) {
  return res.status(400).json({
    error: `Maximum quantity for this service is ${service.max}`
  });
}


    if (!service) {
      return res.status(400).json({ error: "Invalid service" });
    }

    // 2. Calculate charge using selling_rate
    charge = (Number(service.selling_rate) / 1000) * Number(quantity);

    // 3. Get user
    const [[user]] = await pool.query(
      "SELECT * FROM users WHERE id = ?",
      [userId]
    );

    if (Number(user.balance) < charge) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // 4. Deduct balance
    await pool.query(
      "UPDATE users SET balance = balance - ? WHERE id = ?",
      [charge, userId]
    );

    // 5. Create order in DB as Queued
   // 5. Create order in DB as Queued
const [orderResult] = await pool.query(
  `INSERT INTO orders 
   (user_id, service_id, provider_service_id, link, quantity, charge, status) 
   VALUES (?, ?, ?, ?, ?, ?, 'Queued')`,
  [
    userId,
    service_id,
    service.provider_service_id,
    link,
    quantity,
    charge
  ]
);


    orderId = orderResult.insertId;

    // 6. Try placing order to provider
    const [[provider]] = await pool.query(
      "SELECT * FROM providers WHERE id = ?",
      [service.provider_id]
    );

    const apiRes = await axios.post(provider.url, {
      key: provider.api_key,
      action: "add",
      service: service.provider_service_id,
      link,
      quantity
    });

    if (!apiRes.data || !apiRes.data.order) {
      throw new Error("Provider order failed");
    }

    // 7. Provider success -> update status
    await pool.query(
      "UPDATE orders SET provider_order_id = ?, status = 'Processing' WHERE id = ?",
      [apiRes.data.order, orderId]
    );

    return res.json({ success: true, order_id: orderId });

  } catch (err) {
    console.error("PLACE ORDER ERROR:", err.response?.data || err.message);

    // If provider failed, keep order saved and mark manual
    if (orderId) {
      await pool.query(
        "UPDATE orders SET status = 'Pending Manual' WHERE id = ?",
        [orderId]
      );
    }

    // Always show success to user
    return res.json({
      success: true,
      order_id: orderId,
      message: "Order received successfully. It will be processed shortly."
    });
  }
});


// Orders
app.get('/orders', requireAuth, async (req, res) => {
  try {
    const [orders] = await pool.query("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC", [req.session.userId]);
    res.render('layout', { body: 'orders', pageTitle: 'Order History', orders: orders || [] });
  } catch (err) {
    res.render('layout', { body: 'orders', pageTitle: 'Order History', orders: [] });
  }
});

// Funds
app.get('/funds', requireAuth, async (req, res) => {
  try {
    const [txs] = await pool.query("SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC", [req.session.userId]);
    res.render('layout', { body: 'funds', pageTitle: 'Add Funds', transactions: txs || [] });
  } catch (err) {
    res.render('layout', { body: 'funds', pageTitle: 'Add Funds', transactions: [] });
  }
});

// API: Fund Request
app.post("/api/fund-request", requireAuth, async (req, res) => {
  const { amount, txn_id } = req.body;
  const userId = req.session.userId;

  if (!amount || Number(amount) < 10) {
    return res.status(400).json({
      success: false,
      message: "Minimum fund amount is ₹10"
    });
  }

  if (!txn_id) {
    return res.status(400).json({
      success: false,
      message: "Transaction ID required"
    });
  }

  try {
    await pool.query(
      `INSERT INTO fund_requests 
       (user_id, requested_amount, txn_id, status) 
       VALUES (?, ?, ?, 'pending')`,
      [userId, amount, txn_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("FUND REQUEST ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// API: UPI Submit
app.post("/api/funds/upi-submit", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const { amount, txn_id } = req.body;

  if (!amount || amount < 1 || !txn_id) {
    return res.status(400).json({ error: "Invalid data" });
  }

  try {
    // Prevent duplicate txn id
    const [exists] = await pool.query(
      "SELECT id FROM fund_requests WHERE txn_id = ?",
      [txn_id]
    );

    if (exists.length) {
      return res.status(400).json({ error: "Transaction ID already used" });
    }

    // Insert fund request
    await pool.query(
      `INSERT INTO fund_requests 
       (user_id, requested_amount, txn_id, method, status)
       VALUES (?, ?, ?, 'UPI', 'pending')`,
      [userId, amount, txn_id]
    );

    return res.json({
      success: true,
      message: "Payment submitted. Awaiting verification."
    });

  } catch (err) {
    console.error("UPI submit error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// API Docs
app.get('/api-docs', requireAuth, (req, res) => {
  res.render('layout', { body: 'api_docs', pageTitle: 'Developer API' });
});
// ==============================
// Admin Dashboard
// ==============================
app.get('/admin', requireAdmin, async (req, res) => {
  try {

    // -------- Base Data --------
    const [users] = await pool.query("SELECT * FROM users");
    const [services] = await pool.query("SELECT * FROM services");
    const [providers] = await pool.query("SELECT * FROM providers");

    const [orders] = await pool.query(`
      SELECT o.*, s.name AS service_name
      FROM orders o
      LEFT JOIN services s ON s.id = o.service_id
      ORDER BY o.id DESC
    `);

    // -------- Today Orders --------
    const [[todayOrdersRow]] = await pool.query(`
      SELECT COUNT(*) as c
      FROM orders
      WHERE DATE(created_at) = CURDATE()
    `);

    // -------- Today Revenue --------
    const [[todayRevenueRow]] = await pool.query(`
      SELECT SUM(charge) as s
      FROM orders
      WHERE DATE(created_at) = CURDATE()
        AND status IN ('Processing','Completed')
    `);

    // -------- Status Distribution --------
    const [statusRows] = await pool.query(`
      SELECT status, COUNT(*) as c
      FROM orders
      GROUP BY status
    `);

    // -------- Top Services Usage --------
    const [topServices] = await pool.query(`
      SELECT s.name, COUNT(*) as c
      FROM orders o
      JOIN services s ON s.id = o.service_id
      GROUP BY o.service_id
      ORDER BY c DESC
      LIMIT 5
    `);

    // -------- Last 7 Days Orders --------
    const [dailyOrders] = await pool.query(`
      SELECT DATE(created_at) d, COUNT(*) c
      FROM orders
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(created_at)
      ORDER BY d
    `);

    // -------- Profit Analytics --------
    const [[profitRow]] = await pool.query(`
      SELECT
        SUM(o.charge) as revenue,
        SUM((s.rate/1000)*o.quantity) as provider_cost
      FROM orders o
      JOIN services s ON s.id = o.service_id
      WHERE o.status IN ('Processing','Completed')
    `);

    const totalRevenue = Number(profitRow?.revenue || 0);
    const providerCost = Number(profitRow?.provider_cost || 0);
    const totalProfit = totalRevenue - providerCost;

    // -------- Per Service Revenue --------
    const [serviceRevenue] = await pool.query(`
      SELECT s.name, SUM(o.charge) as revenue
      FROM orders o
      JOIN services s ON s.id = o.service_id
      GROUP BY o.service_id
      ORDER BY revenue DESC
      LIMIT 7
    `);

    // -------- Top Users Leaderboard --------
    const [topUsers] = await pool.query(`
      SELECT u.username, SUM(o.charge) as spend
      FROM orders o
      JOIN users u ON u.id = o.user_id
      GROUP BY o.user_id
      ORDER BY spend DESC
      LIMIT 5
    `);

    const [fundRequests] = await pool.query(
      `SELECT fr.*, u.username 
       FROM fund_requests fr
       JOIN users u ON u.id = fr.user_id
       ORDER BY fr.id DESC`
    );

    // -------- Provider Balance Auto Fetch --------
    let providerBalance = null;

    try {
      const [provRows] = await pool.query(
        "SELECT * FROM providers WHERE status=1 LIMIT 1"
      );

      if (provRows.length) {
        const p = provRows[0];

        const balRes = await axios.post(p.url, {
          key: p.api_key,
          action: "balance"
        });

        providerBalance = balRes.data.balance || null;

        await pool.query(
          "UPDATE providers SET balance=? WHERE id=?",
          [providerBalance, p.id]
        );
      }
    } catch (e) {
      console.log("Provider balance fetch fail");
    }

    // -------- Render --------
    res.render('layout', {
      body: 'admin',
      pageTitle: 'Admin Control',

      users,
      services,
      providers,
      orders,

      todayOrders: todayOrdersRow?.c || 0,
      todayRevenue: todayRevenueRow?.s || 0,

      totalRevenue,
      providerCost,
      totalProfit,

      statusRows,
      dailyOrders,
      topServices,
      serviceRevenue,
      topUsers,
      fundRequests,
      providerBalance
    });

  } catch (err) {
    console.error("ADMIN PAGE ERROR:", err);

    res.render('layout', {
      body: 'admin',
      pageTitle: 'Admin Control',

      users: [],
      services: [],
      providers: [],
      orders: [],

      todayOrders: 0,
      todayRevenue: 0,
      totalRevenue: 0,
      providerCost: 0,
      totalProfit: 0,

      statusRows: [],
      dailyOrders: [],
      topServices: [],
      serviceRevenue: [],
      topUsers: [],
      fundRequests: [],
      providerBalance: null
    });
  }
});

app.get("/admin/test-services", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM providers WHERE status = 1 LIMIT 1"
    );

    if (!rows.length) {
      return res.status(404).send("No active provider found");
    }

    const provider = rows[0];

    const response = await axios.post(provider.url, {
      key: provider.api_key,
      action: "services"
    });

    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("API error");
  }
});

app.get("/test-db", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.send("DB working");
  } catch (err) {
    console.error(err);
    res.status(500).send("DB error");
  }
});
// Sync services from provider to local DB
app.get("/admin/sync-services", requireAdmin, async (req, res) => {
  try {
    // 1. Get active provider
    const [rows] = await pool.query(
      "SELECT * FROM providers WHERE status = 1 LIMIT 1"
    );

    if (!rows.length) {
      return res.status(404).send("No active provider found");
    }

    const provider = rows[0];

    // 2. Fetch services from provider API
    const response = await axios.post(provider.url, {
      key: provider.api_key,
      action: "services"
    });

    const services = response.data;

    // 3. Insert / Update services in DB
    for (const s of services) {
      await pool.query(
        `
        INSERT INTO services 
          (category, name, rate, min, max, provider_id, provider_service_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          category = VALUES(category),
          name = VALUES(name),
          rate = VALUES(rate),
          min = VALUES(min),
          max = VALUES(max),
          status = 1
        `,
        [
          s.category || "Other",
          s.name,
          s.rate,
          s.min,
          s.max,
          provider.id,
          s.service
        ]
      );
    }

    res.send("Services synced successfully");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Service sync failed");
  }
});

app.post('/admin/update-order', requireAdmin, async (req, res) => {
  const { order_id, provider_order_id, status } = req.body;

  await pool.query(
    `UPDATE orders 
     SET provider_order_id = ?, status = ?
     WHERE id = ?`,
    [provider_order_id, status, order_id]
  );

  res.redirect('/admin');
});

app.post("/admin/funds/approve", requireAdmin, async (req, res) => {
  const { id, approved_amount } = req.body;

  if (!approved_amount || Number(approved_amount) < 10) {
    return res.send("Minimum approval amount is ₹10");
  }

  try {
    const [rows] = await pool.query(
      "SELECT * FROM fund_requests WHERE id=? AND status='pending'",
      [id]
    );

    if (!rows.length) {
      return res.send("Invalid or already processed request");
    }

    const reqData = rows[0];

    // Update request
    await pool.query(
      `UPDATE fund_requests 
       SET approved_amount=?, status='approved'
       WHERE id=?`,
      [approved_amount, id]
    );

    // Credit user balance
    await pool.query(
      "UPDATE users SET balance = balance + ? WHERE id=?",
      [approved_amount, reqData.user_id]
    );

    // 1️⃣ Add balance to user (session sync)
    const approvedAmount = approved_amount;
    const userId = reqData.user_id;

    // 2️⃣ Refresh session balance immediately
    const [[updatedUser]] = await pool.query(
      "SELECT balance FROM users WHERE id = ?",
      [userId]
    );

    // 3️⃣ Update session (only if same user is in session)
    if (req.session.user && req.session.user.id === userId) {
      req.session.user.balance = updatedUser.balance;
    }

    // Log transaction
    await pool.query(
      `INSERT INTO transactions (user_id, amount, type, txn_id, status)
       VALUES (?, ?, 'credit', 'Fund Approved', 'Completed')`,
      [reqData.user_id, approved_amount]
    );

    res.redirect("/admin");

  } catch (err) {
    console.error(err);
    res.redirect("/admin");
  }
});

app.post("/admin/funds/reject", requireAdmin, async (req, res) => {
  const { id } = req.body;

  try {
    const [rows] = await pool.query(
      "SELECT * FROM fund_requests WHERE id=? AND status='pending'",
      [id]
    );

    if (!rows.length) {
      return res.send("Invalid or already processed request");
    }

    await pool.query(
      "UPDATE fund_requests SET status='rejected' WHERE id=?",
      [id]
    );

    res.redirect("/admin");
  } catch (err) {
    console.error(err);
    res.redirect("/admin");
  }
});

app.post("/admin/approve-fund", requireAdmin, async (req, res) => {
  const { request_id, approved_amount } = req.body;

  try {
    const [[reqData]] = await pool.query(
      "SELECT * FROM fund_requests WHERE id=? AND status='pending'",
      [request_id]
    );

    if (!reqData) return res.redirect("/admin");

    // 1️⃣ Update fund request
    await pool.query(
      `UPDATE fund_requests 
       SET approved_amount=?, status='approved' 
       WHERE id=?`,
      [approved_amount, request_id]
    );

    // 2️⃣ Credit user balance
    await pool.query(
      "UPDATE users SET balance = balance + ? WHERE id=?",
      [approved_amount, reqData.user_id]
    );

    // 1️⃣ Add balance to user (session sync)
    const approvedAmount = approved_amount;
    const userId = reqData.user_id;

    // 2️⃣ Refresh session balance immediately
    const [[updatedUser]] = await pool.query(
      "SELECT balance FROM users WHERE id = ?",
      [userId]
    );

    // 3️⃣ Update session (only if same user is in session)
    if (req.session.user && req.session.user.id === userId) {
      req.session.user.balance = updatedUser.balance;
    }

    // 3️⃣ Insert transaction log
    await pool.query(
      `INSERT INTO transactions 
       (user_id, amount, type, txn_id, status) 
       VALUES (?, ?, 'credit', ?, 'Completed')`,
      [reqData.user_id, approved_amount, reqData.txn_id]
    );

    res.redirect("/admin");
  } catch (err) {
    console.error("APPROVE FUND ERROR:", err.message);
    res.redirect("/admin");
  }
});


app.get("/change-admin-pass", async (req, res) => {
  const hash = await bcrypt.hash("Alinna@123", 10); // ← yaha new password likho

  await pool.query(
    "UPDATE users SET password=? WHERE username='admin'",
    [hash]
  );

  res.send("Admin password changed");
});



// --- Start Server ---
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
