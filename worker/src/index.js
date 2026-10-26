// Monster Rangers badge checker (Cloudflare Worker).
// Odoo pings /hook/<HOOK_SECRET> the moment a Badge Claim is created. We never trust the ping's contents:
// we re-read the claim from Odoo, find out WHO made it from Odoo's own create_uid, check the code, and write the result back.
// The secret code never leaves Odoo/this Worker. A once-a-minute sweeper picks up any claim that was missed.

// Guessing limits (only WRONG codes count; being told "locked" never extends the lock)
const MAX_FAILS = 5;            // wrong codes allowed per 15 minutes, per Ranger
const FAIL_WINDOW_MIN = 15;
const MAX_FAILS_DAY = 15;       // ... and per 24 hours, per Ranger
const NEW_DAYS = 7;             // an account younger than this is "new"
const NEW_MAX_FAILS = 3;        // new accounts: 3 wrong per 15 minutes
const NEW_MAX_FAILS_DAY = 6;    // new accounts: 6 wrong per 24 hours
const NEW_GLOBAL_MAX = 60;      // if the whole site gets this many wrong codes in 10 minutes, NEW accounts are paused
const GLOBAL_WINDOW_MIN = 10;   // (established Rangers are never affected, so a swarm of fake accounts can't block them)
const SHOP_CATEGORIES = ["Everything", "all-products"];   // shop categories a RETIRED badge is taken out of
const RECLAIM_MAX_PER_DAY = 5;       // reclaim requests per Ranger per 24 hours
const RECLAIM_SENDS_PER_OLD_ACCOUNT = 3;   // links emailed for one old account per 24 hours
const RECLAIM_LINK_MIN = 60;         // a link works for one hour
const BOARD_SIZE = 100;         // Glory Leaderboard length
const BOARD_CACHE_SEC = 300;    // the board is built once per 5 minutes and kept at Cloudflare's edge: visitors never touch Odoo
const NICK_MAX_PER_DAY = 6;     // nickname save attempts per Ranger per 24 hours
const NICK_RESERVED = ["admin", "administrator", "staff", "moderator", "mod", "support", "monsterrangers", "monsterranger", "steamcrow", "centralcommand", "official", "claude", "anthropic", "system", "odoo"];
const NICK_BLOCKED = ["fuck", "shit", "cunt", "bitch", "nigg", "fagg", "retard", "nazi", "hitler", "whore", "porn", "kkk"];   // staff can also hide any row by ticking Blocked on the profile
const MSG = {
  reclaimSent: "If that matches an old Monster Rangers account, we've sent a link to the email address on it. The link works for one hour. Check your spam folder too.",
  reclaimBad: "That link didn't work. It may have expired, or you may be logged in with a different account than the one that asked for it. Please ask for a new link.",
  reclaimLimit: "That's a lot of tries today. Please try again tomorrow.",
  nickOk: "Saved! You'll appear on the Glory Leaderboard within about five minutes.",
  nickHidden: "Saved. You are hidden from the Glory Leaderboard.",
  nickBad: "Nicknames are 3 to 24 letters, numbers, spaces, dots or dashes, and must start and end with a letter or number.",
  nickRude: "Please pick a different nickname. Central Command keeps the board friendly.",
  nickTaken: "Another Ranger already has that nickname. Try a different one.",
  nickLimit: "That's a lot of changes today. Please try again tomorrow.",
  nickReview: "Central Command is reviewing your nickname. Please contact us if you have questions.",
  invalid: "That code was not recognized. Check the characters and try again.",
  locked: "Too many tries. Please wait a while and try again.",
  busy: "The badge desk is busy right now. Please try again in a few minutes.",
  already: "You already have this badge.",
  ok: "Badge added to your collection!",
  error: "We couldn't register that one automatically. Central Command will take a look.",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/board") return board(request, env, ctx);
    if (request.method === "POST" && url.pathname === `/reclaim/${env.HOOK_SECRET}`) {
      let rb; try { rb = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
      const rid = parseInt(rb._id ?? rb.id, 10);
      if (!rid) return new Response("bad request", { status: 400 });
      ctx.waitUntil(processReclaim(env, rid).catch((e) => console.log("reclaim error", rid, e.message)));
      return new Response("ok");
    }
    if (request.method === "POST" && url.pathname === `/nick/${env.HOOK_SECRET}`) {
      let nb; try { nb = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
      const nid = parseInt(nb._id ?? nb.id, 10);
      if (!nid) return new Response("bad request", { status: 400 });
      ctx.waitUntil(processNick(env, nid).catch((e) => console.log("nick error", nid, e.message)));
      return new Response("ok");
    }
    if (request.method !== "POST" || url.pathname !== `/hook/${env.HOOK_SECRET}`) return new Response("not found", { status: 404 });
    let body; try { body = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
    const id = parseInt(body._id ?? body.id, 10);
    if (!id) return new Response("bad request", { status: 400 });
    ctx.waitUntil(processClaim(env, id).catch((e) => console.log("claim error", id, e.message)));
    return new Response("ok");
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
    if (new Date(event.scheduledTime).getUTCMinutes() % 15 === 0) ctx.waitUntil(syncRetired(env).catch((e) => console.log("retired sync error", e.message)));   // every 15 minutes
  },
};

export async function sweep(env) {
  const o = odoo(env);
  const fresh = await o("x_badge_claim", "search", [[["x_status", "=", "pending"], ["create_date", "<", odooTime(Date.now() - 8000)]]], { limit: 20 });
  for (const id of fresh) await processClaim(env, id).catch((e) => console.log("sweep error", id, e.message));
  const stale = await o("x_badge_claim", "search", [[["x_status", "=", "processing"], ["write_date", "<", odooTime(Date.now() - 120000)]]], { limit: 20 });
  for (const id of stale) await processClaim(env, id, true).catch((e) => console.log("sweep error", id, e.message));
  const recl = await o("x_badge_reclaim", "search", [[["x_status", "=", "pending"], ["create_date", "<", odooTime(Date.now() - 8000)]]], { limit: 20 }).catch(() => []);
  for (const id of recl) await processReclaim(env, id).catch((e) => console.log("sweep reclaim error", id, e.message));
  const nicks = await o("x_badge_nick", "search", [[["x_status", "=", "pending"], ["create_date", "<", odooTime(Date.now() - 8000)]]], { limit: 20 }).catch(() => []);
  for (const id of nicks) await processNick(env, id).catch((e) => console.log("sweep nick error", id, e.message));
}

// ---- RETIRED ribbon: a badge with no stock left wears the RETIRED ribbon; when stock comes back the ribbon comes off ----
// (The site theme hides ribboned products everywhere except the Spirit Badges directory.)
export async function syncRetired(env) {
  const o = odoo(env);
  const ribbons = await o("product.ribbon", "search_read", [[]], { fields: ["name"] });
  const rib = ribbons.find((r) => String(r.name || "").replace(/<[^>]*>/g, "").trim().toUpperCase() === "RETIRED");
  if (!rib) return { skipped: "no RETIRED ribbon" };
  const meta = await o("product.template", "fields_get", [], { attributes: ["type", "relation"] });
  const field = Object.keys(meta).find((k) => meta[k].type === "many2one" && meta[k].relation === "product.ribbon");
  if (!field) return { skipped: "no ribbon field" };
  const badge = [["x_studio_badge_secret_code", "!=", false], ["is_storable", "=", true]];
  const toRetire = await o("product.template", "search", [[...badge, ["qty_available", "<=", 0], [field, "!=", rib.id]]], { limit: 200 });
  if (toRetire.length) await o("product.template", "write", [toRetire, { [field]: rib.id }]);
  const toRestore = await o("product.template", "search", [[...badge, ["qty_available", ">", 0], [field, "=", rib.id]]], { limit: 200 });
  if (toRestore.length) await o("product.template", "write", [toRestore, { [field]: false }]);
  // Retired badges leave the everyday shop categories ("Everything", "all-products") but stay in Spirit Badges, so only the directory lists them.
  const cats = await o("product.public.category", "search_read", [[["name", "in", SHOP_CATEGORIES]]], { fields: ["name"] });
  const catIds = cats.map((c) => c.id);
  let left = 0, back = 0;
  if (catIds.length) {
    const stillIn = await o("product.template", "search", [[...badge, [field, "=", rib.id], ["public_categ_ids", "in", catIds]]], { limit: 200 });
    if (stillIn.length) { await o("product.template", "write", [stillIn, { public_categ_ids: catIds.map((i) => [3, i]) }]); left = stillIn.length; }
    const allProducts = cats.find((c) => c.name === "all-products");
    if (allProducts) {
      const returned = toRestore.length ? await o("product.template", "search", [[["id", "in", toRestore], ["public_categ_ids", "not in", [allProducts.id]]]]) : [];
      if (returned.length) { await o("product.template", "write", [returned, { public_categ_ids: [[4, allProducts.id]] }]); back = returned.length; }
    }
  }
  return { retired: toRetire.length, restored: toRestore.length, leftShop: left, backInShop: back };
}

// ---- Reclaiming old badges ----
// Old history (members + which badges they unlocked) lives in Cloudflare D1, NOT in Odoo.
// Step 1: a Ranger types an old username/email -> we email a one-time link to the address ON THE OLD ACCOUNT (never to anything they typed).
// Step 2: the Ranger, logged in as the SAME site account that asked, opens the link -> their old badges become normal registrations.
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const escHtml = (t) => String(t || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export async function processReclaim(env, id, stale = false) {
  const o = odoo(env);
  let c = null;
  for (const wait of [0, 300, 700, 1500, 3000]) {
    if (wait) await sleep(wait);
    const r = await o("x_badge_reclaim", "read", [[id]], { fields: ["x_lookup", "x_token", "x_status", "create_uid"] }).catch(() => []);
    if (r.length) { c = r[0]; break; }
  }
  if (!c) return;
  if (c.x_status !== "pending" && !(stale && c.x_status === "processing")) return;
  await o("x_badge_reclaim", "write", [[id], { x_status: "processing" }]);
  const finish = (status, message, extra = {}) => o("x_badge_reclaim", "write", [[id], { x_status: status, x_message: message, x_token: false, x_lookup: false, ...extra }]);   // the link code and what they typed are wiped from the request
  const userId = c.create_uid && c.create_uid[0];
  const user = userId ? (await o("res.users", "read", [[userId]], { fields: ["partner_id", "active"] }))[0] : null;
  if (!user || !user.active || !user.partner_id || !env.DB) return finish("error", MSG.error);
  const partnerId = user.partner_id[0];
  if ((await o("x_badge_reclaim", "search_count", [[["create_uid", "=", userId], ["create_date", ">", odooTime(Date.now() - 86400000)]]])) > RECLAIM_MAX_PER_DAY) return finish("locked", MSG.reclaimLimit);
  const now = Math.floor(Date.now() / 1000);

  if ((c.x_token || "").trim()) {                                    // ---- step 2: redeem the emailed link ----
    const token = c.x_token.trim();
    if (!/^[0-9a-f]{48}$/.test(token)) return finish("invalid", MSG.reclaimBad);
    const hash = await sha256(token);
    const claim = await env.DB.prepare("SELECT wp_user_id, partner_id, expires_at, used FROM claims WHERE token_hash = ?1").bind(hash).first();
    if (!claim || claim.used || claim.expires_at < now || claim.partner_id !== partnerId) return finish("invalid", MSG.reclaimBad);
    const member = await env.DB.prepare("SELECT wp_user_id, claimed_by FROM members WHERE wp_user_id = ?1").bind(claim.wp_user_id).first();
    if (!member || (member.claimed_by && member.claimed_by !== partnerId)) return finish("invalid", MSG.reclaimBad);
    const used = await env.DB.prepare("UPDATE claims SET used = 1 WHERE token_hash = ?1 AND used = 0").bind(hash).run();   // single use, race-safe
    if (!used.meta || used.meta.changes !== 1) return finish("invalid", MSG.reclaimBad);
    try {
      const rows = (await env.DB.prepare("SELECT product_id, unlocked_at FROM unlocks WHERE wp_user_id = ?1").bind(claim.wp_user_id).all()).results || [];
      const ids = rows.map((r) => r.product_id);
      const prods = ids.length ? await o("product.template", "search_read", [[["id", "in", ids]]], { fields: ["x_studio_badge_point_value"], limit: 2000 }) : [];   // active products only
      const pts = new Map(prods.map((p) => [p.id, p.x_studio_badge_point_value || 0]));
      const have = ids.length ? await o("x_badge_registration", "search_read", [[["x_partner_id", "=", partnerId], ["x_product_id", "in", ids], ["x_status", "=", "active"]]], { fields: ["x_product_id"], limit: 2000 }) : [];
      const owned = new Set(have.map((r) => r.x_product_id[0]));
      const fresh = rows.filter((r) => pts.has(r.product_id) && !owned.has(r.product_id));
      if (fresh.length) await o("x_badge_registration", "create", [fresh.map((r) => ({ x_partner_id: partnerId, x_product_id: r.product_id,
        x_registered_at: r.unlocked_at || odooTime(Date.now()), x_source: "legacy_wordpress", x_status: "active", x_points: pts.get(r.product_id), x_legacy_key: `wp${claim.wp_user_id}-${r.product_id}` }))]);
      await env.DB.prepare("UPDATE members SET claimed_by = ?1, claimed_at = ?2 WHERE wp_user_id = ?3").bind(partnerId, now, claim.wp_user_id).run();
      const total = fresh.reduce((a, r) => a + pts.get(r.product_id), 0);
      return finish("restored", fresh.length ? `Welcome back, Ranger! ${fresh.length} badge${fresh.length === 1 ? "" : "s"} restored.` : "Everything from that old account is already in your collection.", { x_count: fresh.length, x_points: total });
    } catch (e) {
      await env.DB.prepare("UPDATE claims SET used = 0 WHERE token_hash = ?1").bind(hash).run();   // let them try the same link again
      console.log("restore failed", e.message); return finish("error", MSG.error);
    }
  }

  // ---- step 1: look up the old account and email the link ----
  const q = (c.x_lookup || "").trim().toLowerCase();
  if (q.length < 3 || q.length > 120) return finish("invalid", "Please type your old username or the email address you used on the old site.");
  const member = await env.DB.prepare("SELECT wp_user_id, username, email, display_name, claimed_by FROM members WHERE lower(username) = ?1 OR lower(email) = ?1 ORDER BY wp_user_id LIMIT 1").bind(q).first();
  const generic = () => finish("sent", MSG.reclaimSent);              // same answer whether or not an account matched, so nobody can use this box to look up members
  if (!member || (member.claimed_by && member.claimed_by !== partnerId) || !member.email) return generic();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM claims WHERE wp_user_id = ?1 AND created_at > ?2").bind(member.wp_user_id, now - 86400).first();
  if (recent && recent.n >= RECLAIM_SENDS_PER_OLD_ACCOUNT) return generic();
  const bytes = crypto.getRandomValues(new Uint8Array(24)); const token = hex(bytes);
  await env.DB.prepare("INSERT INTO claims (token_hash, wp_user_id, partner_id, expires_at, used, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5)")
    .bind(await sha256(token), member.wp_user_id, partnerId, now + RECLAIM_LINK_MIN * 60, now).run();
  const link = `${String(env.SITE_URL || "").replace(/\/$/, "")}/my-badges?reclaim=${token}`;
  const mailId = await o("mail.mail", "create", [{ subject: "Reclaim your old Monster Rangers badges", email_to: member.email, auto_delete: true,
    body_html: `<p>Hello ${escHtml(member.display_name || member.username)},</p><p>Someone (hopefully you) asked to bring the badges from your old Monster Rangers account into the new site.</p>` +
      `<p><a href="${link}" style="background:#dc6b21;color:#ffffff;padding:10px 18px;border-radius:4px;text-decoration:none;font-weight:bold">Reclaim my badges</a></p>` +
      `<p>Open this link while you are logged in to the new site with the account you want the badges on. It works once and expires in one hour.</p><p>If this wasn't you, just ignore this email. Nothing will change.</p>` }]);
  await o("mail.mail", "send", [[mailId]]);
  return generic();
}

// ---- Ranger Nicknames: a Ranger asks for a name (a request record), we check it and, if it passes, save it on their profile ----
export const nickKey = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
export function checkNick(raw) {
  const name = (raw || "").replace(/\s+/g, " ").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,22}[A-Za-z0-9]$/.test(name)) return { bad: MSG.nickBad };
  const flat = nickKey(name).replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t");
  if (NICK_RESERVED.includes(nickKey(name)) || NICK_BLOCKED.some((w) => flat.includes(w))) return { bad: MSG.nickRude };
  return { name, key: nickKey(name) };
}
export async function processNick(env, id, stale = false) {
  const o = odoo(env);
  let c = null;
  for (const wait of [0, 300, 700, 1500, 3000]) {
    if (wait) await sleep(wait);
    const r = await o("x_badge_nick", "read", [[id]], { fields: ["x_nickname", "x_show", "x_status", "create_uid"] }).catch(() => []);
    if (r.length) { c = r[0]; break; }
  }
  if (!c) return;
  if (c.x_status !== "pending" && !(stale && c.x_status === "processing")) return;
  await o("x_badge_nick", "write", [[id], { x_status: "processing" }]);
  const finish = (status, message) => o("x_badge_nick", "write", [[id], { x_status: status, x_message: message }]);
  const userId = c.create_uid && c.create_uid[0];
  const user = userId ? (await o("res.users", "read", [[userId]], { fields: ["partner_id", "active"] }))[0] : null;
  if (!user || !user.active || !user.partner_id) return finish("error", MSG.error);
  const partnerId = user.partner_id[0];
  if ((await o("x_badge_nick", "search_count", [[["create_uid", "=", userId], ["create_date", ">", odooTime(Date.now() - 86400000)]]])) > NICK_MAX_PER_DAY) return finish("invalid", MSG.nickLimit);

  const mine = (await o("x_badge_profile", "search_read", [[["x_partner_id", "=", partnerId]]], { fields: ["x_nickname", "x_blocked"], order: "id" }))[0];
  if (mine && mine.x_blocked) return finish("invalid", MSG.nickReview);
  const raw = (c.x_nickname || "").trim();
  if (!raw) {                                              // no name at all: only allowed as "hide me"
    if (c.x_show || !mine) return finish("invalid", MSG.nickBad);
    await o("x_badge_profile", "write", [[mine.id], { x_show: false }]);
    return finish("ok", MSG.nickHidden);
  }
  const chk = checkNick(raw);
  if (chk.bad) return finish("invalid", chk.bad);
  const clash = await o("x_badge_profile", "search", [[["x_nick_key", "=", chk.key], ["x_partner_id", "!=", partnerId]]], { limit: 1 });
  if (clash.length) return finish("taken", MSG.nickTaken);
  const vals = { x_nickname: chk.name, x_nick_key: chk.key, x_show: !!c.x_show };
  let pid;
  if (mine) { pid = mine.id; await o("x_badge_profile", "write", [[pid], vals]); }
  else pid = await o("x_badge_profile", "create", [{ x_partner_id: partnerId, ...vals }]);
  const dup = await o("x_badge_profile", "search", [[["x_nick_key", "=", chk.key]]], { order: "id" });    // two Rangers saving the same name at once: the oldest keeps it
  if (dup.length > 1 && dup[0] !== pid) {
    if (mine) await o("x_badge_profile", "write", [[pid], { x_nickname: mine.x_nickname || false, x_nick_key: nickKey(mine.x_nickname || ""), x_show: false }]);
    else await o("x_badge_profile", "unlink", [[pid]]);
    return finish("taken", MSG.nickTaken);
  }
  return finish("ok", vals.x_show ? MSG.nickOk : MSG.nickHidden);
}

// ---- The Glory Leaderboard: public, read-only, built from Odoo at most once per BOARD_CACHE_SEC and cached at the edge ----
export async function buildBoard(env) {
  const o = odoo(env);
  const profs = await o("x_badge_profile", "search_read", [[["x_show", "=", true], ["x_blocked", "!=", true], ["x_nickname", "!=", false]]], { fields: ["x_partner_id", "x_nickname"], limit: 5000 });
  const ids = profs.map((p) => p.x_partner_id[0]);
  const dom = [["x_status", "=", "active"], ["x_partner_id", "in", ids]];
  const tally = new Map();                                  // partner id -> { points, badges }
  if (ids.length) {
    let groups;
    try { groups = await o("x_badge_registration", "read_group", [dom, ["x_points:sum"], ["x_partner_id"]], { lazy: false }); }
    catch { groups = null; }
    if (groups) for (const g of groups) tally.set(g.x_partner_id[0], { points: g.x_points || 0, badges: g.__count ?? g.x_partner_id_count ?? 0 });
    else {                                                  // fallback: add them up ourselves
      const rows = await o("x_badge_registration", "search_read", [dom], { fields: ["x_partner_id", "x_points"], limit: 50000 });
      for (const r of rows) { const t = tally.get(r.x_partner_id[0]) || { points: 0, badges: 0 }; t.points += r.x_points || 0; t.badges += 1; tally.set(r.x_partner_id[0], t); }
    }
  }
  const list = profs.map((p) => ({ name: p.x_nickname, points: (tally.get(p.x_partner_id[0]) || { points: 0 }).points, badges: (tally.get(p.x_partner_id[0]) || { badges: 0 }).badges }))
    .filter((r) => r.points > 0).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)).slice(0, BOARD_SIZE);
  let rank = 0, last = null, shown = 0;
  return { updated: new Date().toISOString(), rows: list.map((r) => { shown++; if (r.points !== last) { rank = shown; last = r.points; } return { rank, name: r.name, points: r.points, badges: r.badges }; }) };
}
async function board(request, env, ctx) {
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": `public, max-age=${BOARD_CACHE_SEC}` };
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL(request.url).origin + "/board");
  const hit = cache ? await cache.match(key) : null;
  if (hit) return new Response(hit.body, { status: 200, headers });
  try {
    const res = new Response(JSON.stringify(await buildBoard(env)), { status: 200, headers });
    if (cache) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (e) { console.log("board error", e.message); return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { ...headers, "cache-control": "no-store" } }); }
}

export async function processClaim(env, id, stale = false) {
  const o = odoo(env);
  let c = null;
  for (const wait of [0, 300, 700, 1500, 3000]) {          // the ping can arrive a moment before Odoo has saved the claim
    if (wait) await sleep(wait);
    const r = await o("x_badge_claim", "read", [[id]], { fields: ["x_code", "x_status", "create_uid"] }).catch(() => []);
    if (r.length) { c = r[0]; break; }
  }
  if (!c) return;
  if (c.x_status !== "pending" && !(stale && c.x_status === "processing")) return;   // already handled
  await o("x_badge_claim", "write", [[id], { x_status: "processing" }]);

  const finish = (status, message, extra = {}) =>
    o("x_badge_claim", "write", [[id], { x_status: status, x_message: message, x_code: false, ...extra }]);   // the code is wiped from the claim
  const userId = c.create_uid && c.create_uid[0];
  const user = userId ? (await o("res.users", "read", [[userId]], { fields: ["partner_id", "active", "create_date"] }))[0] : null;
  if (!user || !user.active || !user.partner_id) return finish("error", MSG.error);
  const partnerId = user.partner_id[0];

  const code = (c.x_code || "").trim();
  if (!code || code.length > 64) return finish("invalid", MSG.invalid);

  const isNew = !!user.create_date && Date.parse(user.create_date.replace(" ", "T") + "Z") > Date.now() - NEW_DAYS * 86400000;
  const wrong = (mins) => o("x_badge_claim", "search_count", [[["create_uid", "=", userId], ["x_status", "=", "invalid"],
    ["create_date", ">", odooTime(Date.now() - mins * 60000)]]]);
  if ((await wrong(FAIL_WINDOW_MIN)) >= (isNew ? NEW_MAX_FAILS : MAX_FAILS) || (await wrong(1440)) >= (isNew ? NEW_MAX_FAILS_DAY : MAX_FAILS_DAY)) return finish("locked", MSG.locked);
  if (isNew) {
    const all = await o("x_badge_claim", "search_count", [[["x_status", "=", "invalid"], ["create_date", ">", odooTime(Date.now() - GLOBAL_WINDOW_MIN * 60000)]]]);
    if (all >= NEW_GLOBAL_MAX) return finish("locked", MSG.busy);
  }

  const prods = await o("product.template", "search_read", [[["x_studio_badge_secret_code", "=", code]]],
    { fields: ["name", "x_studio_badge_point_value"] });              // active products only; archived aliases are ignored
  if (prods.length === 0) return finish("invalid", MSG.invalid);
  if (prods.length > 1) { console.log("CONFLICT: code matches", prods.map((p) => p.id)); return finish("error", MSG.error); }
  const p = prods[0], pts = p.x_studio_badge_point_value || 0;

  const find = () => o("x_badge_registration", "search", [[["x_partner_id", "=", partnerId], ["x_product_id", "=", p.id], ["x_status", "=", "active"]]], { order: "id" });
  if ((await find()).length) return finish("already", MSG.already, { x_product_id: p.id });
  await o("x_badge_registration", "create", [{ x_partner_id: partnerId, x_product_id: p.id, x_registered_at: odooTime(Date.now()),
    x_source: "website_code", x_status: "active", x_points: pts, x_claim_id: id }]);
  const all = await find();                                          // two quick submits can both pass the check: keep the oldest, revoke the rest
  if (all.length > 1) await o("x_badge_registration", "write", [all.slice(1), { x_status: "revoked" }]);
  return finish("registered", MSG.ok, { x_product_id: p.id, x_points: pts });
}

// ---- Odoo JSON-RPC helpers ----
let _uid = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const odooTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
async function rpc(env, service, method, args) {
  const r = await fetch(env.ODOO_URL.replace(/\/$/, "") + "/jsonrpc", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }) });
  const j = await r.json();
  if (j.error) throw new Error((j.error.data && j.error.data.message) || j.error.message);
  return j.result;
}
function odoo(env) {
  return async (model, method, args, kwargs = {}) => {
    if (!_uid) { _uid = await rpc(env, "common", "authenticate", [env.ODOO_DB, env.ODOO_USER, env.ODOO_API_KEY, {}]); if (!_uid) throw new Error("Odoo login failed"); }
    return rpc(env, "object", "execute_kw", [env.ODOO_DB, _uid, env.ODOO_API_KEY, model, method, args, kwargs]);
  };
}
