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
const crypto = require("crypto");

let APP_READY = false;

const app = express();

const nanoid = (size = 7) => {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(size);
  let out = "";
  for (let i = 0; i < size; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
};

// --- Configuration ---
const SESSION_SECRET = process.env.SESSION_SECRET;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required. Set SESSION_SECRET in the environment before starting the server.");
}
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function sendTelegramAlert(message) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.warn("Telegram alert skipped: missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID");
      return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(message)}`;
    await fetch(url);
    console.log("Telegram alert sent");
  } catch (error) {
    console.error("Telegram error:", error.message);
  }
}

// --- MySQL Connection Pool ---
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 5,
  connectTimeout: 20000,
  ssl: { rejectUnauthorized: false }
});

// Test Database Connection
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log("MySQL connected successfully");
    connection.release();
    setTimeout(async () => {
      await initDB();
      APP_READY = true;
      console.log("APP READY = true");
    }, 5000);
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
    try {
      await pool.query("ALTER TABLE users ADD COLUMN referral_code VARCHAR(32) NULL");
    } catch (e) {}
    try {
      await pool.query("ALTER TABLE users ADD COLUMN referred_by VARCHAR(32) NULL");
    } catch (e) {}
    try {
      await pool.query("CREATE UNIQUE INDEX idx_users_referral_code ON users (referral_code)");
    } catch (e) {}

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
    try {
      await pool.query("ALTER TABLE services ADD COLUMN selling_rate DECIMAL(10,2) DEFAULT 0.00");
    } catch (e) {}

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
        provider_service_id INT DEFAULT 0,
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
    try {
      await pool.query("ALTER TABLE orders ADD COLUMN provider_service_id INT DEFAULT 0");
    } catch (e) {}
    try {
      await pool.query("ALTER TABLE orders ADD COLUMN refill_days INT DEFAULT 0");
    } catch (e) {}
    try {
      await pool.query("ALTER TABLE orders ADD COLUMN refill_requested TINYINT(1) DEFAULT 0");
    } catch (e) {}
    try {
      await pool.query("ALTER TABLE orders ADD COLUMN claimed_at DATETIME NULL DEFAULT NULL");
    } catch (e) {}

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

    // Affiliate Visits Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS affiliate_visits (
        id INT AUTO_INCREMENT PRIMARY KEY,
        referral_code VARCHAR(32) NOT NULL,
        ip VARCHAR(64),
        user_agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Fund Requests Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fund_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        requested_amount DECIMAL(10,2) NOT NULL,
        approved_amount DECIMAL(10,2) DEFAULT NULL,
        txn_id VARCHAR(255) NOT NULL,
        method VARCHAR(50) DEFAULT 'UPI',
        status VARCHAR(50) DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try {
      await pool.query("CREATE UNIQUE INDEX idx_fund_requests_txn_id ON fund_requests (txn_id)");
    } catch (e) {}
    try {
      await pool.query("ALTER TABLE fund_requests ADD COLUMN requested_amount DECIMAL(10,2) NOT NULL");
    } catch (e) {}
    try {
      await pool.query("ALTER TABLE fund_requests ADD COLUMN approved_amount DECIMAL(10,2) DEFAULT NULL");
    } catch (e) {}
    try {
      await pool.query("ALTER TABLE fund_requests ADD COLUMN txn_id VARCHAR(255) NOT NULL");
    } catch (e) {}
    try {
      await pool.query("ALTER TABLE fund_requests ADD COLUMN method VARCHAR(50) DEFAULT 'UPI'");
    } catch (e) {}
    try {
      await pool.query("ALTER TABLE fund_requests ADD COLUMN status VARCHAR(50) DEFAULT 'pending'");
    } catch (e) {}
    try {
      await pool.query("ALTER TABLE fund_requests ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP");
    } catch (e) {}

    // Affiliate Earnings Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS affiliate_earnings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        referrer_user_id INT NOT NULL,
        referred_user_id INT NOT NULL,
        order_id INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        status VARCHAR(20) NOT NULL DEFAULT 'approved',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_affiliate_order (order_id)
      )
    `);
    try {
      await pool.query("ALTER TABLE affiliate_earnings ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'approved'");
    } catch (e) {}

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
      const adminReferralCode = nanoid(7);
      await pool.query(
        "INSERT INTO users (username, password, is_admin, api_key, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, NULL)",
        ['admin', hash, 1, key, adminReferralCode]
      );
      console.log("Admin account created: admin / admin123");
    }

  } catch (err) {
    console.error("DB Init Error:", err);
  }
}

// --- Multer Storage for Image Uploads ---
const ALLOWED_UPLOAD_MIME_TYPES = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};
const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './public/uploads/landing';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safeExt = ALLOWED_UPLOAD_MIME_TYPES[file.mimetype] || ".bin";
    const randomPart = crypto.randomBytes(16).toString("hex");
    cb(null, `img-${Date.now()}-${randomPart}${safeExt}`);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_UPLOAD_MIME_TYPES[file.mimetype]) {
      return cb(new Error("Invalid file type. Only JPG, JPEG, PNG, WEBP are allowed."));
    }
    return cb(null, true);
  }
});

// --- Passport Configuration ---
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${BASE_URL}/auth/google/callback`,
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
          const referralCode = await generateUniqueReferralCode();
          
          const [result] = await pool.query(
            "INSERT INTO users (google_id, email, username, balance, currency, is_admin, is_developer, api_key, referral_code, referred_by) VALUES (?, ?, ?, 0.00, 'INR', 0, 0, ?, ?, NULL)",
            [googleId, email, name, apiKey, referralCode]
          );

          const [newUserRows] = await pool.query("SELECT * FROM users WHERE id = ?", [result.insertId]);
          return done(null, newUserRows[0]);

        } catch (err) {
          return done(err);
        }
      }
    )
  );
} else {
  console.log("Google OAuth disabled - env vars missing");
}

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
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie;
  if (raw) {
    const parts = raw.split("; ");
    for (const part of parts) {
      const idx = part.indexOf("=");
      if (idx > -1) {
        const key = decodeURIComponent(part.slice(0, idx));
        const val = decodeURIComponent(part.slice(idx + 1));
        req.cookies[key] = val;
      }
    }
  }
  next();
});

if (IS_PRODUCTION) {
  app.set("trust proxy", 1);
}

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());
app.use((req, res, next) => {
  if (!req.user && req.session?.user) req.user = req.session.user;
  next();
});

app.set('view engine', 'ejs');

// Force UTF-8 responses.
app.use((req, res, next) => {
  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  next();
});
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

async function generateUniqueReferralCode() {
  for (let i = 0; i < 12; i++) {
    const code = nanoid(7);
    const [rows] = await pool.query(
      "SELECT id FROM users WHERE LOWER(referral_code) = LOWER(?) LIMIT 1",
      [code]
    );
    if (!rows.length) return code;
  }
  throw new Error("Unable to generate unique referral code");
}

// --- CRON JOB ---
cron.schedule('*/2 * * * *', async () => {
  if (!APP_READY) {
    console.log("CRON skipped - app not ready");
    return;
  }

  console.log("Cron: Auto processing queued pending orders");

  try {
    const [orders] = await pool.query(`
      SELECT o.*, s.provider_service_id, s.provider_id, p.url, p.api_key, p.balance
      FROM orders o
      JOIN services s ON s.id = o.service_id
      JOIN providers p ON p.id = s.provider_id
      WHERE o.status = 'pending'
        AND o.provider_order_id IS NULL
        AND o.claimed_at IS NULL
        AND p.status = 1
      LIMIT 20
    `);

    console.log("Orders found:", orders.length);

    for (const order of orders) {
      try {
        const [claimResult] = await pool.query(
          `UPDATE orders
           SET claimed_at = NOW()
           WHERE id = ?
             AND status = 'pending'
             AND provider_order_id IS NULL
             AND claimed_at IS NULL`,
          [order.id]
        );

        if (!claimResult || claimResult.affectedRows !== 1) {
          console.log("Skip already claimed/processed order:", order.id);
          continue;
        }

        console.log("Retrying order:", order.id);

        if (Number(order.balance || 0) < Number(order.charge || 0)) {
          await pool.query("UPDATE orders SET claimed_at = NULL WHERE id = ?", [order.id]);
          console.log("Provider balance low, keep queued:", order.id);
          continue;
        }

        const resp = await axios.post(order.url, {
          key: order.api_key,
          action: "add",
          service: order.provider_service_id,
          link: order.link,
          quantity: order.quantity
        });

        if (resp.data && resp.data.order) {
          await pool.query(
            "UPDATE orders SET provider_order_id=?, status='processing' WHERE id=?",
            [resp.data.order, order.id]
          );

          console.log("SUCCESS placed:", order.id);
        } else {
          await pool.query("UPDATE orders SET claimed_at = NULL WHERE id = ?", [order.id]);
          console.log("Provider rejected:", order.id, resp.data);
        }

      } catch (err) {
        await pool.query("UPDATE orders SET claimed_at = NULL WHERE id = ?", [order.id]);
        console.log("Retry failed:", order.id, err.response?.data || err.message);
      }
    }

  } catch (err) {
    console.log("Cron fatal error:", err.message);
  }
});

const normalizeOrderStatus = (raw = "") => {
  const s = String(raw).trim().toLowerCase();

  if (["completed", "complete", "success"].includes(s)) return "Completed";
  if (["processing", "in progress", "inprogress", "pending"].includes(s)) return "Processing";
  if (["partial"].includes(s)) return "Partial";
  if (["canceled", "cancelled", "failed", "error"].includes(s)) return "Canceled";

  return "Processing";
};

cron.schedule("*/3 * * * *", async () => {
  if (!APP_READY) return;

  try {
    const [orders] = await pool.query(`
      SELECT o.id, o.user_id, o.charge, o.provider_order_id, o.status,
             s.provider_id, p.url, p.api_key
      FROM orders o
      JOIN services s ON s.id = o.service_id
      JOIN providers p ON p.id = s.provider_id
      WHERE LOWER(o.status) IN ('processing', 'queued')
        AND o.provider_order_id IS NOT NULL
        AND o.provider_order_id != 0
        AND p.status = 1
      LIMIT 100
    `);

    for (const o of orders) {
      // Never downgrade a completed order in case of stale read/race.
      if ((o.status || "").toLowerCase() === "completed") continue;

      try {
        const resp = await axios.post(o.url, {
          key: o.api_key,
          action: "status",
          order: o.provider_order_id
        });

        const nextStatus = normalizeOrderStatus(resp?.data?.status);

        const [updateRes] = await pool.query(
          `UPDATE orders
           SET status = ?, 
               start_count = COALESCE(?, start_count),
               remains = COALESCE(?, remains)
           WHERE id = ? AND LOWER(status) != 'completed'`,
          [
            nextStatus,
            resp?.data?.start_count ?? null,
            resp?.data?.remains ?? null,
            o.id
          ]
        );

        if (nextStatus === "Completed" && updateRes.affectedRows > 0) {
          const [[referredUser]] = await pool.query(
            "SELECT id, referred_by FROM users WHERE id = ? LIMIT 1",
            [o.user_id]
          );

          if (referredUser?.referred_by) {
            const [refRows] = await pool.query(
              "SELECT id FROM users WHERE LOWER(referral_code) = LOWER(?) LIMIT 1",
              [referredUser.referred_by]
            );

            if (refRows.length && refRows[0].id !== o.user_id) {
              const commission = Number((Number(o.charge || 0) * 0.10).toFixed(2));
              if (commission > 0) {
                await pool.query(
                  `INSERT INTO affiliate_earnings
                   (referrer_user_id, referred_user_id, order_id, amount, status)
                   VALUES (?, ?, ?, ?, 'approved')
                   ON DUPLICATE KEY UPDATE amount = amount`,
                  [refRows[0].id, o.user_id, o.id, commission]
                );
              }
            }
          }
        }
      } catch (e) {
        console.log("Order status sync failed:", o.id, e.response?.data || e.message);
      }
    }
  } catch (e) {
    console.log("Processing cron error:", e.message);
  }
});

cron.schedule('0 3 * * *', async () => {
  if (!APP_READY) {
    console.log("CRON skipped - app not ready");
    return;
  }

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
app.post('/api/admin/landing-upload', requireAdmin, (req, res) => {
    upload.single('image')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).json({ error: "File too large. Max size is 5MB." });
        }
        return res.status(400).json({ error: err.message || "Invalid upload file." });
      }

      if (!req.file) return res.status(400).json({error: 'No file'});
      return res.json({ url: '/uploads/landing/' + req.file.filename });
    });
});

// Auth Page
app.get('/auth', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('layout', { body: 'auth', pageTitle: 'Login / Signup' });
});

app.get('/login', (req, res) => {
  res.redirect('/auth');
});

app.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.redirect('/auth');
});

app.get("/ref/:code", async (req, res) => {
  const code = String(req.params.code || "").trim().toLowerCase();
  if (!code) return res.redirect("/signup");

  try {
    const [users] = await pool.query(
      "SELECT id, referral_code FROM users WHERE LOWER(referral_code) = LOWER(?) LIMIT 1",
      [code]
    );

    if (!users.length) return res.redirect("/signup");

    const canonicalCode = users[0].referral_code;

    await pool.query(
      "INSERT INTO affiliate_visits (referral_code, ip, user_agent) VALUES (?, ?, ?)",
      [canonicalCode, req.ip, req.headers["user-agent"] || ""]
    );

    res.cookie("ref", canonicalCode, {
      maxAge: 1000 * 60 * 60 * 24 * 30,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });

    return res.redirect("/signup");
  } catch (err) {
    console.error("REF ROUTE ERROR:", err.message);
    return res.redirect("/signup");
  }
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
    const referralCode = await generateUniqueReferralCode();
    const refCode = String(req.cookies?.ref || "").trim().toLowerCase();

    let referredBy = null;
    if (refCode) {
      const [refRows] = await pool.query(
        "SELECT id, referral_code FROM users WHERE LOWER(referral_code) = LOWER(?) LIMIT 1",
        [refCode]
      );
      if (refRows.length) {
        referredBy = refRows[0].referral_code;
      }
    }

    if (referredBy && referredBy.toLowerCase() === referralCode.toLowerCase()) {
      referredBy = null;
    }

    const [result] = await pool.query(
      "INSERT INTO users (username, password, api_key, referral_code, referred_by) VALUES (?, ?, ?, ?, ?)", 
      [username, hash, apiKey, referralCode, referredBy]
    );

    req.session.userId = result.insertId;
    req.session.user = { id: result.insertId, username, is_admin: 0, balance: 0, referral_code: referralCode };
    req.session.isAdmin = 0;
    res.clearCookie("ref");

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
      "SELECT balance, referral_code FROM users WHERE id = ?",
      [userId]
    );
    req.session.user.balance = user.balance;

    const [statsRows] = await pool.query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN LOWER(status) = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN LOWER(status) = 'completed' THEN 1 ELSE 0 END) as completed
       FROM orders
       WHERE user_id = ?`,
      [userId]
    );
    let stats = statsRows[0];
    if (!stats) stats = { total: 0, pending: 0, completed: 0 };

    const [recentOrders] = await pool.query(
      "SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 5",
      [userId]
    );

    const referralCode = user?.referral_code || "";
    const affiliate = {
      referralCode,
      referralLink: referralCode ? `${BASE_URL}/ref/${referralCode}` : "",
      visits: 0,
      referrals: 0,
      totalEarnings: 0,
      availableEarnings: 0
    };

    if (referralCode) {
      const [[visitRow]] = await pool.query(
        "SELECT COUNT(*) AS c FROM affiliate_visits WHERE LOWER(referral_code) = LOWER(?)",
        [referralCode]
      );
      const [[refRow]] = await pool.query(
        "SELECT COUNT(*) AS c FROM users WHERE LOWER(referred_by) = LOWER(?)",
        [referralCode]
      );
      const [[earningRow]] = await pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM affiliate_earnings WHERE referrer_user_id = ?",
        [userId]
      );

      affiliate.visits = Number(visitRow?.c || 0);
      affiliate.referrals = Number(refRow?.c || 0);
      affiliate.totalEarnings = Number(earningRow?.s || 0);
      affiliate.availableEarnings = affiliate.totalEarnings;
    }

    res.render('layout', {
      body: 'dashboard',
      pageTitle: 'Dashboard',
      stats,
      recentOrders: recentOrders || [],
      affiliate
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

// Affiliate Dashboard Route
app.get("/affiliate", async (req, res) => {
  if (!req.user) return res.redirect("/login");

  try {
    const userId = req.user.id;
    let referralCode = req.user.referral_code;

    if (!referralCode) {
      referralCode = await generateUniqueReferralCode();
      await pool.query("UPDATE users SET referral_code = ? WHERE id = ?", [referralCode, userId]);
      if (req.session?.user) req.session.user.referral_code = referralCode;
      if (req.user) req.user.referral_code = referralCode;
    }

    // Visits
    const [[visits]] = await pool.query(
      "SELECT COUNT(*) AS total FROM affiliate_visits WHERE referral_code = ?",
      [referralCode]
    );

    // Registrations
    const [[registrations]] = await pool.query(
      "SELECT COUNT(*) AS total FROM users WHERE referred_by = ?",
      [referralCode]
    );

    // Earnings
    const [[earnings]] = await pool.query(
      `SELECT 
        COALESCE(SUM(amount),0) AS total,
        COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0) AS approved,
        COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END),0) AS pending
      FROM affiliate_earnings
      WHERE referrer_user_id = ?`,
      [userId]
    );

    const conversion =
      Number(visits.total) > 0
        ? ((Number(registrations.total) / Number(visits.total)) * 100).toFixed(2)
        : "0.00";

    res.render("layout", {
      body: "affiliate",
      pageTitle: "Affiliate Dashboard",
      affiliate: {
        refLink: `https://bananasmm.onrender.com/ref/${referralCode}`,
        visits: Number(visits.total || 0),
        registrations: Number(registrations.total || 0),
        conversion,
        totalEarnings: Number(earnings.total || 0),
        approvedEarnings: Number(earnings.approved || 0),
        pendingEarnings: Number(earnings.pending || 0)
      }
    });
  } catch (err) {
    console.error("AFFILIATE DASHBOARD ERROR:", err.message);
    return res.redirect("/dashboard");
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

    if (!service) {
      return res.status(400).json({ error: "Invalid service" });
    }

    if (!link) {
      return res.status(400).json({ error: "Invalid link" });
    }
    try {
      const parsed = new URL(link);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({ error: "Invalid link" });
      }
    } catch (e) {
      return res.status(400).json({ error: "Invalid link" });
    }

    // âŒ block if quantity less than provider min
if (service.min && Number(quantity) < Number(service.min)) {
  return res.status(400).json({
    error: `Minimum quantity for this service is ${service.min}`
  });
}

// âŒ block if quantity more than provider max
if (service.max && Number(quantity) > Number(service.max)) {
  return res.status(400).json({
    error: `Maximum quantity for this service is ${service.max}`
  });
}

    // 2. Calculate charge using selling_rate
    charge = (Number(service.selling_rate) / 1000) * Number(quantity);

    const [[provider]] = await pool.query(
      "SELECT * FROM providers WHERE id = ?",
      [service.provider_id]
    );
    if (!provider) {
      return res.status(500).json({
        success: false,
        message: "Internal server error"
      });
    }

    let connection;
    let txStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      txStarted = true;

      // 3. Lock user row and re-check balance inside transaction
      const [[user]] = await connection.query(
        "SELECT * FROM users WHERE id = ? FOR UPDATE",
        [userId]
      );

      if (!user || Number(user.balance) < charge) {
        await connection.rollback();
        txStarted = false;
        return res.status(400).json({ error: "Insufficient balance" });
      }

      // 4. Deduct balance
      await connection.query(
        "UPDATE users SET balance = balance - ? WHERE id = ?",
        [charge, userId]
      );

      // 5. Create order in DB as pending
      const [orderResult] = await connection.query(
        `INSERT INTO orders 
         (user_id, service_id, provider_service_id, link, quantity, charge, status, provider_order_id) 
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)`,
        [
          userId,
          service_id,
          service.provider_service_id,
          link,
          quantity,
          charge
        ]
      );

      await connection.commit();
      txStarted = false;
      orderId = orderResult.insertId;
    } catch (txErr) {
      if (connection && txStarted) {
        try {
          await connection.rollback();
        } catch (_) {}
      }
      console.error("PLACE ORDER TX ERROR:", txErr.response?.data || txErr.message);
      return res.status(500).json({
        success: false,
        message: "Internal server error"
      });
    } finally {
      if (connection) connection.release();
    }

    if (Number(provider.balance || 0) < Number(charge || 0)) {
      return res.json({
        success: true,
        message: "Order placed successfully and queued for processing",
        order_id: orderId
      });
    }

    try {
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

      // 6. Provider success -> update status
      await pool.query(
        "UPDATE orders SET provider_order_id = ?, status = 'processing' WHERE id = ?",
        [apiRes.data.order, orderId]
      );

      return res.json({
        success: true,
        message: "Order placed successfully",
        order_id: orderId
      });
    } catch (err) {
      console.error("Provider order failed:", err.response?.data || err.message);
      return res.json({
        success: true,
        message: "Order queued and will be processed shortly",
        order_id: orderId
      });
    }

  } catch (err) {
    console.error("PLACE ORDER ERROR:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
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
    const [fundHistory] = await pool.query(
      `SELECT 
         id,
         requested_amount AS amount,
         method AS payment_method,
         txn_id,
         status,
         created_at
       FROM fund_requests
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.session.userId]
    );
    res.render('layout', {
      body: 'funds',
      pageTitle: 'Add Funds',
      fundHistory: fundHistory || []
    });
  } catch (err) {
    res.render('layout', { body: 'funds', pageTitle: 'Add Funds', fundHistory: [] });
  }
});

// API: Fund Request (SECURE - DUPLICATE SAFE)
app.post("/api/fund-request", requireAuth, async (req, res) => {
  let { amount, txn_id } = req.body;
  const userId = req.session.userId;

  txn_id = txn_id ? txn_id.trim().toUpperCase() : "";

  if (!amount || Number(amount) < 10) {
    return res.json({
      success: false,
      error: "Minimum fund amount is Rs.10"
    });
  }

  if (!txn_id || txn_id.length < 6) {
    return res.json({
      success: false,
      error: "Invalid Transaction ID"
    });
  }

  try {
    const [exists] = await pool.query(
      "SELECT id FROM fund_requests WHERE txn_id = ? LIMIT 1",
      [txn_id]
    );

    if (exists.length > 0) {
      return res.json({
        success: false,
        error: "Transaction already submitted"
      });
    }

    await pool.query(
      `INSERT INTO fund_requests 
       (user_id, requested_amount, txn_id, method, status)
       VALUES (?, ?, ?, 'UPI', 'pending')`,
      [userId, amount, txn_id]
    );

    const [userRows] = await pool.query(
      "SELECT username FROM users WHERE id = ? LIMIT 1",
      [userId]
    );
    const username = userRows[0]?.username || `User#${userId}`;
    const safeAmount = Number(amount || 0).toFixed(2);
    const message = `
🔔 New Fund Request

User: ${username}
Amount: ₹${safeAmount}

Check Banana SMM Admin Panel
`;

    await sendTelegramAlert(message);

    return res.json({ success: true });
  } catch (err) {
    console.error("FUND REQUEST ERROR:", err.message);

    if (err.code === "ER_DUP_ENTRY") {
      return res.json({
        success: false,
        error: "Transaction already submitted"
      });
    }

    return res.status(500).json({
      success: false,
      error: "Server error. Try again."
    });
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
        AND LOWER(status) IN ('processing','completed')
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
      WHERE LOWER(o.status) IN ('processing','completed')
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

app.get('/admin/user/:id', requireAdmin, async (req, res) => {
  const userId = req.params.id;

  try {
    const [userRows] = await pool.query(
      "SELECT id, username, email, balance, created_at FROM users WHERE id = ? LIMIT 1",
      [userId]
    );

    if (!userRows.length) {
      return res.status(404).render('layout', {
        body: 'admin-user-detail',
        pageTitle: 'User Detail',
        inspectedUser: null,
        orders: [],
        error: 'User not found'
      });
    }

    const [orders] = await pool.query(
      `SELECT o.id,
              COALESCE(s.name, CONCAT('Service #', o.service_id)) AS service_name,
              o.quantity,
              o.status,
              o.created_at
       FROM orders o
       LEFT JOIN services s ON s.id = o.service_id
       WHERE o.user_id = ?
       ORDER BY o.id DESC`,
      [userId]
    );

    return res.render('layout', {
      body: 'admin-user-detail',
      pageTitle: `User ${userRows[0].username}`,
      inspectedUser: userRows[0],
      orders,
      error: null
    });
  } catch (err) {
    console.error("ADMIN USER DETAIL ERROR:", err.message);
    return res.status(500).render('layout', {
      body: 'admin-user-detail',
      pageTitle: 'User Detail',
      inspectedUser: null,
      orders: [],
      error: 'Server error'
    });
  }
});

app.get("/admin/test-services", requireAdmin, async (req, res) => {
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

app.get("/test-db", requireAdmin, async (req, res) => {
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

    // 1ï¸âƒ£ Add balance to user (session sync)
    const approvedAmount = approved_amount;
    const userId = reqData.user_id;

    // 2ï¸âƒ£ Refresh session balance immediately
    const [[updatedUser]] = await pool.query(
      "SELECT balance FROM users WHERE id = ?",
      [userId]
    );

    // 3ï¸âƒ£ Update session (only if same user is in session)
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

    // 1ï¸âƒ£ Update fund request
    await pool.query(
      `UPDATE fund_requests 
       SET approved_amount=?, status='approved' 
       WHERE id=?`,
      [approved_amount, request_id]
    );

    // 2ï¸âƒ£ Credit user balance
    await pool.query(
      "UPDATE users SET balance = balance + ? WHERE id=?",
      [approved_amount, reqData.user_id]
    );

    // 1ï¸âƒ£ Add balance to user (session sync)
    const approvedAmount = approved_amount;
    const userId = reqData.user_id;

    // 2ï¸âƒ£ Refresh session balance immediately
    const [[updatedUser]] = await pool.query(
      "SELECT balance FROM users WHERE id = ?",
      [userId]
    );

    // 3ï¸âƒ£ Update session (only if same user is in session)
    if (req.session.user && req.session.user.id === userId) {
      req.session.user.balance = updatedUser.balance;
    }

    // 3ï¸âƒ£ Insert transaction log
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


// --- Start Server ---
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});




