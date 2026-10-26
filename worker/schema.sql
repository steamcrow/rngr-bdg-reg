-- Old-site badge history for the "reclaim my badges" flow. Lives in Cloudflare D1 (private to the account), NOT in Odoo.
CREATE TABLE IF NOT EXISTS members (
  wp_user_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  claimed_by INTEGER,          -- Odoo partner id that now owns this old account's badges
  claimed_at INTEGER
);
CREATE INDEX IF NOT EXISTS members_username ON members (lower(username));
CREATE INDEX IF NOT EXISTS members_email ON members (lower(email));
CREATE TABLE IF NOT EXISTS unlocks (
  wp_user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,   -- the CURRENT Odoo badge product
  unlocked_at TEXT,
  PRIMARY KEY (wp_user_id, product_id)
);
CREATE TABLE IF NOT EXISTS claims (   -- one row per emailed link; only a hash of the link code is kept
  token_hash TEXT PRIMARY KEY,
  wp_user_id INTEGER NOT NULL,
  partner_id INTEGER NOT NULL,   -- the site account that asked: only that account can use the link
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_wp ON claims (wp_user_id, created_at);
