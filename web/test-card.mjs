import { JSDOM } from "jsdom"; import fs from "fs";
const src = fs.readFileSync("ranger-card.js", "utf8");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPTS = { branches: ["Crows", "Psychics", "Sea Rangers"], barrows: ["AZ", "CO", "Barrowless"] };
async function run({ session = { uid: 9, is_public: false, partner_id: 90 }, profile = {}, regs = [{ x_points: 10 }, { x_points: 25 }], path = "/my", noModel = false, optsFail = false, nickFlow = [{ x_status: "ok", x_message: "Saved!" }], cardFlow = [{ x_status: "ok", x_message: "Card saved." }], createFail = false } = {}) {
  const dom = new JSDOM('<body><div id="wrap"><div class="o_portal_my_home"><h3>Documents</h3></div></div></body>', { url: "https://monsterrangers.com" + path, runScripts: "outside-only" });
  const w = dom.window; const calls = []; let nr = 0, cr = 0; let prof = profile;
  w.MR_WORKER = "https://w.example";
  w.fetch = async (url, init) => {
    if (url === "https://w.example/card-options") { if (optsFail) throw new Error("net"); return { ok: true, json: async () => OPTS }; }
    const body = JSON.parse(init.body); let result;
    if (url.includes("get_session_info")) result = session;
    else { const m = url.split("/call_kw/")[1]; calls.push([m, body.params]);
      if (createFail && m.endsWith("/create")) throw new Error("net");
      if (m === "x_badge_profile/search_read") { if (noModel) return { json: async () => ({ error: { message: "no model" } }) }; result = Object.keys(prof).length ? [prof] : []; }
      else if (m === "x_badge_registration/search_read") result = regs;
      else if (m === "x_badge_nick/create") result = 66;
      else if (m === "x_badge_card/create") result = 67;
      else if (m === "x_badge_nick/read") result = [nickFlow[Math.min(nr++, nickFlow.length - 1)]];
      else if (m === "x_badge_card/read") { result = [cardFlow[Math.min(cr++, cardFlow.length - 1)]]; if (cardFlow[0].x_status === "ok") prof = { ...prof, x_branch: "Psychics", x_barrow: "CO" }; } }
    return { json: async () => ({ result }) };
  };
  w.eval(src); await sleep(80);
  return { w, calls, doc: w.document, setProfile: (p) => { prof = p; } };
}
const submit = async (t) => { t.doc.querySelector("#mr-card-app form").dispatchEvent(new t.w.Event("submit", { cancelable: true })); await sleep(120); };
const A = { x_nickname: "Wren", x_show: true, x_branch: "Crows", x_barrow: "AZ", x_ooo: true };

let t = await run({ session: { uid: 4, is_public: true } });
ok("logged-out visitor gets no card", !t.doc.querySelector("#mr-card-app"));
t = await run({ profile: A, path: "/my/orders" });
ok("the card only appears on the account page, not other /my pages", !t.doc.querySelector("#mr-card-app"));
t = await run({ profile: A });
ok("the card sits at the top of the account page", t.doc.querySelector(".o_portal_my_home").firstChild.id === "mr-card-app");
ok("shows the Persona name", t.doc.querySelector(".mrc-name").textContent === "Wren");
ok("an OoO Member sees the member chip with the seal, linking to their subscriptions", /OoO Member/.test(t.doc.querySelector(".mrc-ooo").textContent) && !/Not an/.test(t.doc.querySelector(".mrc-ooo").textContent) && t.doc.querySelector(".mrc-ooo").getAttribute("href") === "/my/orders" && !!t.doc.querySelector(".mrc-ooo svg"));
ok("Branch and Barrow drop-downs list the Worker's lists, with the saved choice selected", t.doc.querySelector("#mrc-branch").value === "Crows" && t.doc.querySelector("#mrc-barrow").value === "AZ" && t.doc.querySelectorAll("#mrc-branch option").length === 4 && t.doc.querySelectorAll("#mrc-barrow option").length === 4);
ok("shows Glory and badge totals for their own badges", /Glory\s*35/.test(t.doc.querySelector(".mrc-facts").textContent) && /Badges\s*2/.test(t.doc.querySelector(".mrc-facts").textContent));
ok("only this Ranger's registrations are asked for", t.calls.find((c) => c[0] === "x_badge_registration/search_read")[1].args[0].some((d) => d[0] === "x_partner_id" && d[2] === 90));
ok("leaderboard box is ticked when they are on the board", t.doc.querySelector("#mrc-show").checked === true);

t = await run({ profile: { x_nickname: "Pip", x_ooo: false } });
ok("a non-member sees 'Not an OoO Member' with a link to join, and no seal", /Not an OoO Member/.test(t.doc.querySelector(".mrc-ooo").textContent) && t.doc.querySelector(".mrc-ooo").getAttribute("href") === "/order-of-obscuria" && !t.doc.querySelector(".mrc-ooo svg"));
t = await run({ profile: {} });
ok("a brand-new Ranger sees an empty card they can fill in", /No Persona name yet/.test(t.doc.querySelector(".mrc-name").textContent) && /Not an OoO Member/.test(t.doc.querySelector(".mrc-ooo").textContent));
ok("names are never drawn as HTML", (await run({ profile: { x_nickname: "<img src=x onerror=1>" } })).doc.querySelector("#mr-card-app img") === null);

t = await run({ profile: A });
await submit(t);
ok("saving with nothing changed asks them to change something and sends nothing", /Nothing to save/.test(t.doc.querySelector(".mrc-msg").textContent) && !t.calls.some((c) => c[0].endsWith("/create")));
t.doc.querySelector("#mrc-branch").value = "Psychics"; t.doc.querySelector("#mrc-barrow").value = "CO";
await submit(t);
const cc = t.calls.find((c) => c[0] === "x_badge_card/create");
ok("changing Branch and Barrow sends one card request with both values", cc && cc[1].args[0].x_branch === "Psychics" && cc[1].args[0].x_barrow === "CO" && !t.calls.some((c) => c[0] === "x_badge_nick/create"));
ok("after saving, the card shows the new Branch and Barrow and the checker's message", /Branch\s*Psychics/.test(t.doc.querySelector(".mrc-facts").textContent) && /Barrow\s*CO/.test(t.doc.querySelector(".mrc-facts").textContent) && /Card saved/.test(t.doc.querySelector(".mrc-msg").textContent));

t = await run({ profile: A });
t.doc.querySelector("#mrc-persona").value = "  Wren   Two "; t.doc.querySelector("#mrc-show").checked = false;
await submit(t);
const nc = t.calls.find((c) => c[0] === "x_badge_nick/create");
ok("changing the Persona name sends a nickname request, tidied, with the leaderboard choice", nc && nc[1].args[0].x_nickname === "Wren Two" && nc[1].args[0].x_show === false && !t.calls.some((c) => c[0] === "x_badge_card/create"));

t = await run({ profile: { x_ooo: false } });
t.doc.querySelector("#mrc-show").checked = true; await submit(t);
ok("asking to be on the board without a name warns and sends nothing", /Type a Ranger Persona name/.test(t.doc.querySelector(".mrc-msg").textContent) && !t.calls.some((c) => c[0].endsWith("/create")));

t = await run({ profile: A, cardFlow: [{ x_status: "invalid", x_message: "That Branch or Barrow isn't on the list." }] });
t.doc.querySelector("#mrc-branch").value = "Psychics"; await submit(t);
ok("a refusal from the checker is shown as a problem", t.doc.querySelector(".mrc-msg.bad") && /isn't on the list/.test(t.doc.querySelector(".mrc-msg").textContent));
t = await run({ profile: A, createFail: true });
t.doc.querySelector("#mrc-branch").value = "Psychics"; await submit(t);
ok("a network failure says nothing was changed", /Nothing was changed/.test(t.doc.querySelector(".mrc-msg").textContent) && !t.doc.querySelector("#mr-card-app button").disabled);

t = await run({ noModel: true });
ok("card tables not installed yet -> no card, page still works", !t.doc.querySelector("#mr-card-app") && !!t.doc.querySelector(".o_portal_my_home h3"));
t = await run({ profile: A, optsFail: true });
ok("lists unavailable -> card still shows, with a note, current choices kept", !!t.doc.querySelector(".mrc-card") && /couldn't be loaded/.test(t.doc.querySelector(".mrc-help").textContent) && t.doc.querySelector("#mrc-branch").value === "Crows");
console.log(fails ? fails + " FAILED" : "ALL PASSED"); process.exit(fails ? 1 : 0);
