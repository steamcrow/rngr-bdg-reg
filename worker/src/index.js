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
const BOARD_SIZE = 100;         // Glory Leaderboard length
const BOARD_CACHE_SEC = 300;    // the board is built once per 5 minutes and kept at Cloudflare's edge: visitors never touch Odoo
const NICK_MAX_PER_DAY = 6;     // nickname save attempts per Ranger per 24 hours
const NICK_RESERVED = ["admin", "administrator", "staff", "moderator", "mod", "support", "monsterrangers", "monsterranger", "steamcrow", "centralcommand", "official", "claude", "anthropic", "system", "odoo"];
const NICK_BLOCKED = ["fuck", "shit", "cunt", "bitch", "nigg", "fagg", "retard", "nazi", "hitler", "whore", "porn", "kkk"];   // staff can also hide any row by ticking Blocked on the profile
const MSG = {
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
  async scheduled(event, env, ctx) { ctx.waitUntil(sweep(env)); },
};

export async function sweep(env) {
  const o = odoo(env);
  const fresh = await o("x_badge_claim", "search", [[["x_status", "=", "pending"], ["create_date", "<", odooTime(Date.now() - 8000)]]], { limit: 20 });
  for (const id of fresh) await processClaim(env, id).catch((e) => console.log("sweep error", id, e.message));
  const stale = await o("x_badge_claim", "search", [[["x_status", "=", "processing"], ["write_date", "<", odooTime(Date.now() - 120000)]]], { limit: 20 });
  for (const id of stale) await processClaim(env, id, true).catch((e) => console.log("sweep error", id, e.message));
  const nicks = await o("x_badge_nick", "search", [[["x_status", "=", "pending"], ["create_date", "<", odooTime(Date.now() - 8000)]]], { limit: 20 }).catch(() => []);
  for (const id of nicks) await processNick(env, id).catch((e) => console.log("sweep nick error", id, e.message));
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
