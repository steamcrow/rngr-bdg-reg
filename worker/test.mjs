import { processClaim, processReclaim, syncRetired, processNick, buildBoard, checkNick, sweep } from "./src/index.js";
// ---- a tiny pretend Odoo ----
const db = {
  "res.users": { 7: { id: 7, partner_id: [70, "Ranger A"], active: true }, 8: { id: 8, partner_id: [80, "Ranger B"], active: true } },
  "product.template": { 100: { id: 100, name: "Yes Planchette", x_studio_badge_secret_code: "@ffirm", x_studio_badge_point_value: 10 },
                        101: { id: 101, name: "Dup A", x_studio_badge_secret_code: "twin", x_studio_badge_point_value: 10 },
                        102: { id: 102, name: "Dup B", x_studio_badge_secret_code: "twin", x_studio_badge_point_value: 10 } },
  "x_badge_claim": {}, "x_badge_registration": {}, "x_badge_nick": {}, "x_badge_profile": {}, "x_badge_reclaim": {}, "mail.mail": {}, "product.public.category": { 2: { id: 2, name: "Everything" }, 4: { id: 4, name: "Spirit Badges" }, 47: { id: 47, name: "all-products" } }, "product.ribbon": { 5: { id: 5, name: "<p>Retired</p>" }, 6: { id: 6, name: "NEW" } },
};
let seq = 1000, nowMs = Date.now();
const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const newClaim = (uid, code, ageMs = 0, status = "pending") => { const id = ++seq; db.x_badge_claim[id] = { id, x_code: code, x_status: status, create_uid: [uid, "u"], create_date: stamp(nowMs - ageMs), write_date: stamp(nowMs - ageMs) }; return id; };
const m2o = (r) => { const o = { ...r }; for (const f of ["x_partner_id", "x_product_id"]) if (typeof o[f] === "number") o[f] = [o[f], "n"]; return o; };
const match = (r, d) => d.every(([f, op, v]) => { const x = r[f]; if (Array.isArray(x) && f === "public_categ_ids") return op === "in" ? v.some((i) => x.includes(i)) : op === "not in" ? !v.some((i) => x.includes(i)) : false; const xv = Array.isArray(x) ? x[0] : x;
  return op === "=" ? xv === v : op === "!=" ? xv !== v : op === "<=" ? xv <= v : op === "in" ? v.includes(xv) : op === ">" ? xv > v : op === "<" ? xv < v : false; });
globalThis.fetch = async (url, init) => {
  const { params } = JSON.parse(init.body); const [service, method, args] = [params.service, params.method, params.args];
  let result;
  if (service === "common") result = 1;
  else { const [, , , model, m, a, kw = {}] = args; const t = db[model];
    if (m === "read") result = a[0].map((i) => m2o(t[i])).filter(Boolean);
    else if (m === "search") result = Object.values(t).filter((r) => match(r, a[0])).map((r) => r.id).sort((x, y) => x - y);
    else if (m === "search_read") result = Object.values(t).filter((r) => match(r, a[0])).map(m2o);
    else if (m === "search_count") result = Object.values(t).filter((r) => match(r, a[0])).length;
    else if (m === "write") { for (const i of a[0]) { const vals = { ...a[1] }; if (vals.public_categ_ids) { let cur = [...(t[i].public_categ_ids || [])]; for (const [cmd, id] of vals.public_categ_ids) cur = cmd === 3 ? cur.filter((x) => x !== id) : cur.includes(id) ? cur : [...cur, id]; vals.public_categ_ids = cur; } Object.assign(t[i], vals); } result = true; }
    else if (m === "fields_get") result = { website_ribbon_id: { type: "many2one", relation: "product.ribbon" }, name: { type: "char" } };
    else if (m === "unlink") { for (const i of a[0]) delete t[i]; result = true; }
    else if (m === "send") result = true;
    else if (m === "create") { const mk = (v) => { const id = ++seq; t[id] = { id, ...v, create_date: stamp(Date.now()) }; return id; }; result = Array.isArray(a[0]) ? a[0].map(mk) : mk(a[0]); }
    else throw new Error("unknown " + m); }
  return { json: async () => ({ result }) };
};
// a tiny pretend D1 database (only the questions the Worker asks)
const d1 = { members: [], unlocks: [], claims: [] };
const fakeDB = { prepare(sql) { const q = sql.replace(/\s+/g, " ").trim(); return { bind(...v) { const run = () => {
  const one = (list, f) => list.find(f) || null;
  if (q.startsWith("SELECT wp_user_id, partner_id, expires_at, used FROM claims")) return { first: one(d1.claims, (c) => c.token_hash === v[0]) };
  if (q.startsWith("SELECT wp_user_id, claimed_by FROM members WHERE wp_user_id")) return { first: one(d1.members, (m) => m.wp_user_id === v[0]) };
  if (q.startsWith("UPDATE claims SET used = 1")) { const c = one(d1.claims, (x) => x.token_hash === v[0] && !x.used); if (c) c.used = 1; return { run: { meta: { changes: c ? 1 : 0 } } }; }
  if (q.startsWith("UPDATE claims SET used = 0")) { const c = one(d1.claims, (x) => x.token_hash === v[0]); if (c) c.used = 0; return { run: { meta: { changes: 1 } } }; }
  if (q.startsWith("SELECT product_id, unlocked_at FROM unlocks")) return { all: { results: d1.unlocks.filter((u) => u.wp_user_id === v[0]) } };
  if (q.startsWith("UPDATE members SET claimed_by")) { const m = one(d1.members, (x) => x.wp_user_id === v[2]); if (m) { m.claimed_by = v[0]; m.claimed_at = v[1]; } return { run: { meta: { changes: 1 } } }; }
  if (q.startsWith("SELECT wp_user_id, username, email, display_name, claimed_by FROM members WHERE lower(username)")) return { first: one(d1.members, (m) => m.username.toLowerCase() === v[0] || (m.email || "").toLowerCase() === v[0]) };
  if (q.startsWith("SELECT COUNT(*) AS n FROM claims")) return { first: { n: d1.claims.filter((c) => c.wp_user_id === v[0] && c.created_at > v[1]).length } };
  if (q.startsWith("INSERT INTO claims")) { d1.claims.push({ token_hash: v[0], wp_user_id: v[1], partner_id: v[2], expires_at: v[3], used: 0, created_at: v[4] }); return { run: { meta: { changes: 1 } } }; }
  throw new Error("fake D1 does not know: " + q); };
  return { first: async () => run().first, all: async () => run().all, run: async () => run().run }; } }; } };
const env = { ODOO_URL: "http://x", ODOO_DB: "d", ODOO_USER: "u", ODOO_API_KEY: "k", DB: fakeDB, SITE_URL: "https://site.example" };
const regs = (p) => Object.values(db.x_badge_registration).filter((r) => r.x_partner_id === p && r.x_status !== "revoked").length;
let fails = 0; const ok = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); if (!cond) fails++; };

let c = newClaim(7, "@ffirm"); await processClaim(env, c);
ok("valid code registers", db.x_badge_claim[c].x_status === "registered" && regs(70) === 1 && db.x_badge_claim[c].x_points === 10);
ok("code is wiped from the claim", db.x_badge_claim[c].x_code === false);
c = newClaim(7, "@ffirm"); await processClaim(env, c);
ok("same code again -> already, no second badge", db.x_badge_claim[c].x_status === "already" && regs(70) === 1);
c = newClaim(8, "@ffirm"); await processClaim(env, c);
ok("a different Ranger can have the same badge", db.x_badge_claim[c].x_status === "registered" && regs(80) === 1);
c = newClaim(7, "nope"); await processClaim(env, c);
ok("wrong code -> invalid, nothing created", db.x_badge_claim[c].x_status === "invalid" && regs(70) === 1);
c = newClaim(7, "twin"); await processClaim(env, c);
ok("code on two products -> needs review, nothing awarded", db.x_badge_claim[c].x_status === "error" && regs(70) === 1);
c = newClaim(7, "   "); await processClaim(env, c);
ok("blank code -> invalid", db.x_badge_claim[c].x_status === "invalid");
c = newClaim(7, "x".repeat(200)); await processClaim(env, c);
ok("absurdly long code -> invalid", db.x_badge_claim[c].x_status === "invalid");
for (let i = 0; i < 5; i++) await processClaim(env, newClaim(8, "bad" + i));
c = newClaim(8, "@ffirm"); await processClaim(env, c);
ok("after 5 wrong tries the Ranger is locked out", db.x_badge_claim[c].x_status === "locked");
// new accounts get a tighter leash
db["res.users"][9] = { id: 9, partner_id: [90, "New Ranger"], active: true, create_date: stamp(Date.now() - 3600000) };
for (let i = 0; i < 3; i++) await processClaim(env, newClaim(9, "guess" + i));
c = newClaim(9, "@ffirm"); await processClaim(env, c);
ok("a brand-new account is locked after only 3 wrong tries", db.x_badge_claim[c].x_status === "locked" && regs(90) === 0);
// being locked does not extend the lock: wrong tries from 20 minutes ago no longer count
db["res.users"][11] = { id: 11, partner_id: [110, "Old Ranger"], active: true, create_date: stamp(Date.now() - 90 * 86400000) };
for (let i = 0; i < 5; i++) newClaim(11, "old" + i, 20 * 60000, "invalid");
c = newClaim(11, "@ffirm"); await processClaim(env, c);
ok("wrong tries older than 15 minutes stop counting", db.x_badge_claim[c].x_status === "registered");
// daily cap: 15 wrong tries spread over the day locks even if the last 15 minutes are quiet
db["res.users"][12] = { id: 12, partner_id: [120, "Slow Guesser"], active: true, create_date: stamp(Date.now() - 90 * 86400000) };
for (let i = 0; i < 15; i++) newClaim(12, "slow" + i, 3 * 3600000, "invalid");
c = newClaim(12, "@ffirm"); await processClaim(env, c);
ok("slow guessing hits the 24-hour cap", db.x_badge_claim[c].x_status === "locked");
// swarm of fake accounts: new accounts are paused, established Rangers are not
for (let u = 20; u < 40; u++) for (let i = 0; i < 4; i++) newClaim(u, "swarm", 60000, "invalid");
db["res.users"][13] = { id: 13, partner_id: [130, "Newer"], active: true, create_date: stamp(Date.now() - 600000) };
c = newClaim(13, "@ffirm"); await processClaim(env, c);
ok("during a site-wide guessing swarm, NEW accounts are paused", db.x_badge_claim[c].x_status === "locked" && /busy/.test(db.x_badge_claim[c].x_message));
db["res.users"][14] = { id: 14, partner_id: [140, "Veteran"], active: true, create_date: stamp(Date.now() - 400 * 86400000) };
c = newClaim(14, "@ffirm"); await processClaim(env, c);
ok("... but established Rangers still register normally", db.x_badge_claim[c].x_status === "registered");
// race: two claims for a new badge processed at once
db["product.template"][103] = { id: 103, name: "Race", x_studio_badge_secret_code: "race", x_studio_badge_point_value: 25 };
const r1 = newClaim(7, "race"), r2 = newClaim(7, "race");
await Promise.all([processClaim(env, r1), processClaim(env, r2)]);
const raceRegs = Object.values(db.x_badge_registration).filter((r) => r.x_partner_id === 70 && r.x_product_id === 103 && r.x_status === "active").length;
ok("two simultaneous claims leave exactly ONE active registration", raceRegs === 1);
// claim already handled is not redone
c = newClaim(7, "@ffirm", 0, "registered"); await processClaim(env, c);
ok("an already-finished claim is left alone", db.x_badge_claim[c].x_status === "registered");
// sweeper picks up an old pending claim
c = newClaim(7, "@ffirm", 60000); await sweep(env);
ok("sweeper finishes a forgotten pending claim", db.x_badge_claim[c].x_status !== "pending");

// ---- Ranger Nicknames and the Glory Leaderboard ----
const newNick = (uid, name, show = true) => { const id = ++seq; db.x_badge_nick[id] = { id, x_nickname: name, x_show: show, x_status: "pending", create_uid: [uid, "u"], create_date: stamp(Date.now()) }; return id; };
const prof = (p) => Object.values(db.x_badge_profile).find((r) => r.x_partner_id === p);
let n = newNick(7, "  Moss   Fox "); await processNick(env, n);
ok("good nickname is saved and shown", db.x_badge_nick[n].x_status === "ok" && prof(70).x_nickname === "Moss Fox" && prof(70).x_show === true && prof(70).x_nick_key === "mossfox");
n = newNick(8, "moss-fox"); await processNick(env, n);
ok("same name (any spacing or case) is taken", db.x_badge_nick[n].x_status === "taken" && !prof(80));
for (let u = 20; u < 40; u++) db["res.users"][u] = { id: u, partner_id: [u * 10, "R" + u], active: true };
let ui = 20;
for (const bad of ["ab", "x".repeat(25), "<b>hi</b>", "Fu(k", "-Dash", "a@b.com", "Admin", "Monster Rangers", "Sh1t Head", "NAZI Dave"]) {
  const bu = ui++; n = newNick(bu, bad); await processNick(env, n); ok("rejects " + JSON.stringify(bad), db.x_badge_nick[n].x_status === "invalid" && !prof(bu * 10));
}
ok("a name containing 'cock' as part of a real word is fine (Peacock)", !!checkNick("Peacock").name);
n = newNick(8, "Wren", true); await processNick(env, n);
ok("second Ranger saves a different name", db.x_badge_nick[n].x_status === "ok" && prof(80).x_nickname === "Wren");
n = newNick(7, "", false); await processNick(env, n);
ok("an empty name with the box unticked just hides the Ranger", db.x_badge_nick[n].x_status === "ok" && prof(70).x_show === false && prof(70).x_nickname === "Moss Fox");
n = newNick(7, "", true); await processNick(env, n);
ok("an empty name with the box ticked is refused", db.x_badge_nick[n].x_status === "invalid");
prof(80).x_blocked = true; n = newNick(8, "Wren Two"); await processNick(env, n);
ok("a staff-blocked profile cannot change its name", db.x_badge_nick[n].x_status === "invalid" && prof(80).x_nickname === "Wren");
prof(80).x_blocked = false;
for (let i = 0; i < 8; i++) { n = newNick(11, "Spam" + i); await processNick(env, n); }
ok("name changes are capped per day", db.x_badge_nick[n].x_status === "invalid" && /try again tomorrow/.test(db.x_badge_nick[n].x_message));

prof(70).x_show = true; prof(80).x_show = true;
let b = await buildBoard(env);
ok("board lists opted-in Rangers by points, best first, with ranks", b.rows[0].name === "Moss Fox" && b.rows[0].points === 35 && b.rows[0].badges === 2 && b.rows[0].rank === 1 && b.rows[1].rank === 2 && b.rows[2].rank === 2 && b.rows[1].points === 10);
ok("board never contains real names, emails or partner ids", !JSON.stringify(b).match(/Ranger A|partner|@/));
prof(70).x_show = false; b = await buildBoard(env);
ok("hidden Rangers are not on the board", b.rows.every((r) => r.name !== "Moss Fox"));
prof(70).x_show = true; prof(70).x_blocked = true; b = await buildBoard(env);
ok("blocked Rangers are not on the board", b.rows.every((r) => r.name !== "Moss Fox"));

// ---- RETIRED ribbon ----
const P = db["product.template"];
Object.assign(P, { 200: { id: 200, name: "Sold out badge", x_studio_badge_secret_code: "s1", is_storable: true, qty_available: 0, website_ribbon_id: false },
  201: { id: 201, name: "In stock badge", x_studio_badge_secret_code: "s2", is_storable: true, qty_available: 12, website_ribbon_id: false },
  202: { id: 202, name: "Back in stock", x_studio_badge_secret_code: "s3", is_storable: true, qty_available: 3, website_ribbon_id: 5 },
  203: { id: 203, name: "Not a badge", x_studio_badge_secret_code: false, is_storable: true, qty_available: 0, website_ribbon_id: false },
  204: { id: 204, name: "Untracked badge", x_studio_badge_secret_code: "s4", is_storable: false, qty_available: 0, website_ribbon_id: false } });
P[200].public_categ_ids = [2, 4, 47]; P[202].public_categ_ids = [4, 2];
for (const id of [100, 101, 102]) Object.assign(P[id], { is_storable: false, qty_available: 0 });
const rr = await syncRetired(env);
ok("sold-out badge gets the RETIRED ribbon", P[200].website_ribbon_id === 5);
ok("badge with stock is left alone", P[201].website_ribbon_id === false);
ok("badge back in stock loses the ribbon", P[202].website_ribbon_id === false);
ok("non-badges and untracked badges are never touched", P[203].website_ribbon_id === false && P[204].website_ribbon_id === false);
ok("sync reports what it did", rr.retired === 1 && rr.restored === 1);
ok("retired badge leaves Everything and all-products but stays in Spirit Badges", JSON.stringify(P[200].public_categ_ids) === "[4]");
ok("a badge back in stock rejoins all-products", P[202].public_categ_ids.includes(47) && P[202].public_categ_ids.includes(4));

// ---- Reclaiming old badges ----
d1.members.push({ wp_user_id: 500, username: "LadyDrac", email: "Old.Email@Example.com", display_name: "Lady Drac", claimed_by: null },
                { wp_user_id: 501, username: "taken", email: "t@example.com", display_name: "T", claimed_by: 999 });
d1.unlocks.push({ wp_user_id: 500, product_id: 100, unlocked_at: "2019-05-01 10:00:00" }, { wp_user_id: 500, product_id: 101, unlocked_at: "2019-06-01 10:00:00" },
                { wp_user_id: 500, product_id: 777, unlocked_at: "2019-07-01 10:00:00" }, { wp_user_id: 501, product_id: 100, unlocked_at: "2019-05-01 10:00:00" });
Object.assign(P[100], { x_studio_badge_point_value: 10 }); Object.assign(P[101], { x_studio_badge_point_value: 25 });   // 777 = an archived product: not in P, so it is skipped
const newReclaim = (uid, lookup, token = false) => { const id = ++seq; db.x_badge_reclaim[id] = { id, x_lookup: lookup, x_token: token, x_status: "pending", create_uid: [uid, "u"], create_date: stamp(Date.now()) }; return id; };
for (let u = 40; u < 50; u++) db["res.users"][u] = { id: u, partner_id: [u * 10, "R" + u], active: true };
let r = newReclaim(40, "ladydrac"); await processReclaim(env, r);
const mails = Object.values(db["mail.mail"]);
ok("asking for a link emails the address ON THE OLD ACCOUNT", mails.length === 1 && mails[0].email_to === "Old.Email@Example.com" && db.x_badge_reclaim[r].x_status === "sent");
const token = (mails[0].body_html.match(/reclaim=([0-9a-f]{48})/) || [])[1];
ok("the email carries a one-time link to the site", !!token && mails[0].body_html.includes("https://site.example/my-badges?reclaim="));
ok("the stored token is hashed, never the raw token", d1.claims.length === 1 && d1.claims[0].token_hash !== token && d1.claims[0].token_hash.length === 64);
r = newReclaim(41, "nobody-here"); await processReclaim(env, r);
ok("an unknown name gets the SAME friendly answer and no email", db.x_badge_reclaim[r].x_status === "sent" && db.x_badge_reclaim[r].x_message === db.x_badge_reclaim[Object.keys(db.x_badge_reclaim)[0]].x_message && Object.keys(db["mail.mail"]).length === 1);
r = newReclaim(41, "taken"); await processReclaim(env, r);
ok("an old account already claimed by someone else gets no email", Object.keys(db["mail.mail"]).length === 1 && db.x_badge_reclaim[r].x_status === "sent");
r = newReclaim(42, token); await processReclaim(env, r);
r = newReclaim(42, "x", token); await processReclaim(env, r);
ok("a different logged-in account cannot use someone else's link", db.x_badge_reclaim[r].x_status === "invalid" && !Object.values(db.x_badge_registration).some((g) => g.x_partner_id === 420));
r = newReclaim(40, "x", token); await processReclaim(env, r);
const mine = Object.values(db.x_badge_registration).filter((g) => g.x_partner_id === 400 && g.x_source === "legacy_wordpress");
ok("the right account gets its old badges back", db.x_badge_reclaim[r].x_status === "restored" && mine.length === 2 && db.x_badge_reclaim[r].x_count === 2);
ok("restored badges carry CURRENT point values, old date and a legacy key", mine.find((g) => g.x_product_id === 101).x_points === 25 && mine[0].x_registered_at.startsWith("2019") && mine[0].x_legacy_key === "wp500-" + mine[0].x_product_id);
ok("archived badges are skipped, not restored", !mine.some((g) => g.x_product_id === 777));
ok("the old account is marked as claimed", d1.members[0].claimed_by === 400);
ok("the link code is wiped from the request", db.x_badge_reclaim[r].x_token === false);
r = newReclaim(40, "x", token); await processReclaim(env, r);
ok("a link can only be used once", db.x_badge_reclaim[r].x_status === "invalid" && Object.values(db.x_badge_registration).filter((g) => g.x_partner_id === 400 && g.x_source === "legacy_wordpress").length === 2);
r = newReclaim(43, "x", "g".repeat(48)); await processReclaim(env, r);
ok("a made-up token is refused", db.x_badge_reclaim[r].x_status === "invalid");
// expired links and already-owned badges
d1.members.push({ wp_user_id: 502, username: "oldtimer", email: "o@example.com", display_name: "O", claimed_by: null }); d1.unlocks.push({ wp_user_id: 502, product_id: 100, unlocked_at: "2018-01-01 00:00:00" }, { wp_user_id: 502, product_id: 101, unlocked_at: "2018-01-02 00:00:00" });
r = newReclaim(44, "o@example.com"); await processReclaim(env, r);
const tok2 = Object.values(db["mail.mail"]).at(-1).body_html.match(/reclaim=([0-9a-f]{48})/)[1];
ok("lookup by email works, any capitals", db.x_badge_reclaim[r].x_status === "sent" && Object.keys(db["mail.mail"]).length === 2);
d1.claims.at(-1).expires_at = Math.floor(Date.now() / 1000) - 5;
r = newReclaim(44, "x", tok2); await processReclaim(env, r);
ok("an expired link is refused", db.x_badge_reclaim[r].x_status === "invalid");
r = newReclaim(44, "oldtimer"); await processReclaim(env, r);
const tok3 = Object.values(db["mail.mail"]).at(-1).body_html.match(/reclaim=([0-9a-f]{48})/)[1];
db.x_badge_registration[++seq] = { id: seq, x_partner_id: 440, x_product_id: 100, x_status: "active", x_points: 10 };
r = newReclaim(44, "x", tok3); await processReclaim(env, r);
ok("a badge the Ranger already owns is not doubled", Object.values(db.x_badge_registration).filter((g) => g.x_partner_id === 440 && g.x_product_id === 100).length === 1 && db.x_badge_reclaim[r].x_count === 1);
// too many link emails for one old account
d1.members.push({ wp_user_id: 503, username: "popular", email: "p@example.com", display_name: "P", claimed_by: null });
for (let i = 0; i < 5; i++) await processReclaim(env, newReclaim(45, "popular"));
ok("at most 3 emails per old account per day", Object.values(db["mail.mail"]).filter((m) => m.email_to === "p@example.com").length === 3);
for (let i = 0; i < 7; i++) await processReclaim(env, newReclaim(46, "nobody" + i));
r = newReclaim(46, "ladydrac"); await processReclaim(env, r);
ok("a Ranger can only ask so many times a day", db.x_badge_reclaim[r].x_status === "locked");
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
