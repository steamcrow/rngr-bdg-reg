import { JSDOM } from "jsdom"; import fs from "fs";
const src = fs.readFileSync("my-badges.js", "utf8");
let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run({ session, regs = [], claimFlow = [], rpcFail = false }) {
  const dom = new JSDOM('<body><div id="mr-badges-app"></div></body>', { url: "https://monsterrangers.com/my-badges", runScripts: "outside-only" });
  const w = dom.window; const calls = []; let claimReads = 0;
  w.fetch = async (url, init) => {
    const body = JSON.parse(init.body); let result;
    if (url.includes("get_session_info")) result = session;
    else { const m = url.split("/call_kw/")[1]; calls.push([m, body.params]);
      if (rpcFail && m.endsWith("/create")) throw new Error("net");
      if (m === "x_badge_registration/search_read") result = regs;
      else if (m === "x_badge_claim/create") result = 55;
      else if (m === "x_badge_claim/read") result = [claimFlow[Math.min(claimReads++, claimFlow.length - 1)]]; }
    return { json: async () => ({ result }) };
  };
  w.eval(src); await sleep(60);
  return { w, calls, doc: w.document };
}
const typeAndSubmit = async (doc, w, v) => { doc.querySelector("input[name=code]").value = v; doc.querySelector("form").dispatchEvent(new w.Event("submit", { cancelable: true })); };

let t = await run({ session: { uid: 4, is_public: true } });
ok("logged-out visitor sees a login link, no form", t.doc.querySelector("a[href*='/web/login']") && !t.doc.querySelector("form"));

t = await run({ session: { uid: 9, is_public: false }, regs: [{ x_product_id: [100, "Yes Planchette Spirit Badge"], x_points: 10 }, { x_product_id: [101, "Cargo Tiger Spirit Badge"], x_points: 25 }] });
ok("collection shows 2 badges and 35 points", /2 badges/.test(t.doc.querySelector(".mrb-total").textContent) && /35 points/.test(t.doc.querySelector(".mrb-total").textContent));
ok("badge cards drawn with the 'Spirit Badge' suffix trimmed", t.doc.querySelectorAll(".mrb-card").length === 2 && t.doc.querySelector(".mrb-card b").textContent === "Yes Planchette");
ok("badge pictures come from Odoo", t.doc.querySelector(".mrb-card img").getAttribute("src") === "/web/image/product.template/100/image_256");

await typeAndSubmit(t.doc, t.w, "  @ffirm@tiv3 ");
await sleep(50);
const created = t.calls.find((c) => c[0] === "x_badge_claim/create");
ok("code is sent trimmed but with its letters untouched", created && created[1].args[0].x_code === "@ffirm@tiv3");
ok("only the code is sent (no user or partner id)", created && Object.keys(created[1].args[0]).join() === "x_code");

t = await run({ session: { uid: 9 }, regs: [], claimFlow: [{ x_status: "pending" }, { x_status: "processing" }, { x_status: "registered", x_message: "Badge added to your collection!", x_product_id: [100, "Yes Planchette Spirit Badge"], x_points: 10 }] });
await typeAndSubmit(t.doc, t.w, "good"); await sleep(2000);
ok("waits through pending, then shows success with the badge", /Yes Planchette.*Badge added.*\+10 points/.test(t.doc.querySelector(".mrb-msg").textContent) && t.doc.querySelector(".mrb-msg.ok img"));
ok("collection reloaded after success", t.calls.filter((c) => c[0] === "x_badge_registration/search_read").length >= 2);
ok("button is usable again", !t.doc.querySelector("button[type=submit]").disabled);

t = await run({ session: { uid: 9 }, claimFlow: [{ x_status: "invalid", x_message: "That code was not recognized. Check the characters and try again." }] });
await typeAndSubmit(t.doc, t.w, "wrong"); await sleep(100);
ok("wrong code shows the friendly message", t.doc.querySelector(".mrb-msg.bad") && /not recognized/.test(t.doc.querySelector(".mrb-msg").textContent));

t = await run({ session: { uid: 9 }, claimFlow: [{ x_status: "already", x_message: "You already have this badge.", x_product_id: [100, "X"] }] });
await typeAndSubmit(t.doc, t.w, "dup"); await sleep(100);
ok("already-owned shows a gentle notice", t.doc.querySelector(".mrb-msg.warn") && /already/.test(t.doc.querySelector(".mrb-msg").textContent));

t = await run({ session: { uid: 9 }, rpcFail: true });
await typeAndSubmit(t.doc, t.w, "x"); await sleep(100);
ok("network failure says nothing changed and re-enables the button", /Nothing was changed/.test(t.doc.querySelector(".mrb-msg").textContent) && !t.doc.querySelector("button[type=submit]").disabled);

t = await run({ session: { uid: 9 } });
await typeAndSubmit(t.doc, t.w, "   ");
ok("blank code is stopped before anything is sent", !t.calls.find((c) => c[0] === "x_badge_claim/create"));

const many = Array.from({ length: 130 }, (_, i) => ({ x_product_id: [i + 1, "Badge " + i + " Spirit Badge"], x_points: 10 }));
t = await run({ session: { uid: 9 }, regs: many });
ok("large collections show 48 at first with a Show more button", t.doc.querySelectorAll(".mrb-card").length === 48 && t.doc.querySelector(".mrb-more").style.display !== "none");
t.doc.querySelector(".mrb-more").click(); ok("Show more adds 48", t.doc.querySelectorAll(".mrb-card").length === 96);
const s = t.doc.querySelector("input[type=search]"); s.value = "Badge 12"; s.dispatchEvent(new t.w.Event("input"));
ok("search narrows the list", t.doc.querySelectorAll(".mrb-card").length === 11);

t = await run({ session: { uid: 9 }, regs: [{ x_product_id: [1, "<img src=x onerror=alert(1)> Spirit Badge"], x_points: 1 }] });
ok("badge names are shown as plain text, never as HTML", !t.doc.querySelector(".mrb-card b img") && t.doc.querySelector(".mrb-card b").textContent.includes("<img"));
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0);
