// Monster Rangers badge checker (Cloudflare Worker).
// Odoo pings /hook/<HOOK_SECRET> the moment a Badge Claim is created. We never trust the ping's contents:
// we re-read the claim from Odoo, find out WHO made it from Odoo's own create_uid, check the code, and write the result back.
// The secret code never leaves Odoo/this Worker. A once-a-minute sweeper picks up any claim that was missed.

const MAX_FAILS = 5;            // wrong codes allowed ...
const FAIL_WINDOW_MIN = 15;     // ... per this many minutes, per Ranger
const MSG = {
  invalid: "That code was not recognized. Check the characters and try again.",
  locked: "Too many tries. Please wait 15 minutes and try again.",
  already: "You already have this badge.",
  ok: "Badge added to your collection!",
  error: "We couldn't register that one automatically. Central Command will take a look.",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
  const user = userId ? (await o("res.users", "read", [[userId]], { fields: ["partner_id", "active"] }))[0] : null;
  if (!user || !user.active || !user.partner_id) return finish("error", MSG.error);
  const partnerId = user.partner_id[0];

  const code = (c.x_code || "").trim();
  if (!code || code.length > 64) return finish("invalid", MSG.invalid);

  const fails = await o("x_badge_claim", "search_count", [[["create_uid", "=", userId], ["x_status", "in", ["invalid", "locked"]],
    ["create_date", ">", odooTime(Date.now() - FAIL_WINDOW_MIN * 60000)]]]);
  if (fails >= MAX_FAILS) return finish("locked", MSG.locked);

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
