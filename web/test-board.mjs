import { JSDOM } from "jsdom"; import fs from "fs";
const src = fs.readFileSync("leaderboard.js", "utf8"); let fails = 0; const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run({ rows, session = { uid: 4, is_public: true }, nick = "", boardFail = false, noBoard = false }) {
  const dom = new JSDOM('<body><div id="mr-board-app" ' + (noBoard ? "" : 'data-board="https://w.example/board"') + '></div></body>', { url: "https://monsterrangers.com/leaderboard", runScripts: "outside-only" });
  const w = dom.window;
  w.fetch = async (url) => ({ ok: !boardFail, json: async () => url.includes("get_session_info") ? { result: session } : url.includes("x_badge_profile") ? { result: nick ? [{ x_nickname: nick }] : [] } : { rows } });
  w.eval(src); await sleep(50); return w.document;
}
let d = await run({ rows: [{ rank: 1, name: "Moss Fox", points: 335 }, { rank: 2, name: "<img src=x onerror=1>", points: 200 }, { rank: 2, name: "Wren", points: 200 }, { rank: 4, name: "Pip", points: 5 }] });
ok("shows one row per Ranger with rank and Glory", d.querySelectorAll("tbody tr").length === 4 && d.querySelector("tbody tr").textContent.includes("#1") && d.querySelector("td.mrl-num").textContent === "335");
ok("names are plain text, never HTML", !d.querySelector("td img") && d.body.textContent.includes("<img"));
ok("tied Rangers share a rank", d.querySelectorAll("tbody tr")[1].textContent.includes("#2") && d.querySelectorAll("tbody tr")[2].textContent.includes("#2"));
ok("logged-out visitors see the board and a join link", d.querySelector("a[href*='ranger-nickname']") && !d.querySelector(".mrl-me"));
d = await run({ rows: [{ rank: 1, name: "Moss Fox", points: 1 }, { rank: 2, name: "Wren", points: 1 }], session: { uid: 9 }, nick: "Wren" });
ok("a logged-in Ranger's own row is highlighted", d.querySelector(".mrl-me") && /Wren/.test(d.querySelector(".mrl-me").textContent) && /You/.test(d.querySelector(".mrl-me").textContent));
d = await run({ rows: [] }); ok("empty board invites the first Ranger", /first/i.test(d.body.textContent));
d = await run({ rows: [], boardFail: true }); ok("board down -> friendly message", /couldn't be loaded/.test(d.body.textContent));
d = await run({ rows: [], noBoard: true }); ok("missing address -> not set up message", /not set up/.test(d.body.textContent));
console.log(fails ? fails + " FAILED" : "ALL PASSED");
