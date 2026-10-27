/* Monster Rangers - Glory Leaderboard (loaded from GitHub via jsDelivr).
   Shows the Top 100 Rangers who chose to appear: Ranger Nickname + Glory points. Anyone can see it, no login needed.
   The list comes from the badge checker (a Cloudflare Worker) that rebuilds it at most once every 5 minutes,
   so visitors never put load on Odoo. Real names and emails are never in the list.
   Page needs:  <div id="mr-board-app" data-board="https://YOUR-WORKER/board"></div>  then this script. */
(function () {
  "use strict";
  var ROOT = document.getElementById("mr-board-app");
  if (!ROOT || ROOT.getAttribute("data-ready")) return;
  ROOT.setAttribute("data-ready", "1");
  var BOARD = ROOT.getAttribute("data-board");

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") el.textContent = attrs[k]; else if (k === "class") el.className = attrs[k]; else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  /* PLACEHOLDER Order of Obscuria seal (swap for real art later). The Membership Card page has its own copy. */
  function oooIcon() {
    var NS = "http://www.w3.org/2000/svg", wrap = h("span", { class: "mrl-ooo", role: "img", "aria-label": "Order of Obscuria Member", title: "Order of Obscuria Member" });
    var svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "20"); svg.setAttribute("height", "20"); svg.setAttribute("aria-hidden", "true");
    var c = document.createElementNS(NS, "circle"); c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "10.5"); c.setAttribute("fill", "#4b2a5c"); c.setAttribute("stroke", "#e7b64a"); c.setAttribute("stroke-width", "1.5"); svg.appendChild(c);
    var t = document.createElementNS(NS, "text"); t.setAttribute("x", "12"); t.setAttribute("y", "15.2"); t.setAttribute("text-anchor", "middle"); t.setAttribute("font-size", "8.5"); t.setAttribute("font-weight", "700"); t.setAttribute("fill", "#e7b64a"); t.setAttribute("font-family", "sans-serif"); t.textContent = "OoO"; svg.appendChild(t);
    wrap.appendChild(svg); return wrap;
  }
  function css() {
    if (document.getElementById("mr-board-css")) return;
    var s = document.createElement("style"); s.id = "mr-board-css";
    s.textContent =
      "#mr-board-app{font-size:1.05rem;line-height:1.5;max-width:900px;margin:0 auto}" +
      "#mr-board-app .mrl-panel{border:2px dashed var(--mr-line,#b9aab6);background:var(--mr-card-bg,#fff);border-radius:.5rem;padding:.4rem 1.4rem 1rem;margin-bottom:1.5rem}" +
      "#mr-board-app table{width:100%;border-collapse:collapse}" +
      "#mr-board-app th{font-family:var(--mr-font-head,inherit);font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:.95rem;text-align:left;padding:.9rem .5rem .6rem;border-bottom:2px dashed var(--mr-line,#b9aab6)}" +
      "#mr-board-app th.mrl-num,#mr-board-app td.mrl-num{text-align:right}" +
      "#mr-board-app td{padding:.65rem .5rem;border-bottom:1px dashed var(--mr-stitch,#d8cfd6)}" +
      "#mr-board-app tr:last-child td{border-bottom:0}" +
      "#mr-board-app td.mrl-rank{font-family:var(--mr-font-head,inherit);font-weight:700;font-size:1.25rem;width:4rem;white-space:nowrap}" +
      "#mr-board-app tr.mrl-top td.mrl-rank{color:var(--mr-orange-ink,#a8470f)}" +
      "#mr-board-app td.mrl-name{font-weight:700;overflow-wrap:anywhere}" +
      "#mr-board-app td.mrl-num{font-family:var(--mr-font-head,inherit);font-weight:700;font-size:1.25rem;white-space:nowrap}" +
      "#mr-board-app tr.mrl-me td{background:rgba(220,107,33,.12)}" +
      "#mr-board-app .mrl-you{font-weight:400;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;margin-left:.5rem;color:var(--mr-orange-ink,#a8470f)}" +
      "#mr-board-app .mrl-ooo{display:inline-block;vertical-align:-.3em;margin-left:.45rem;line-height:0}" +
      "#mr-board-app .mrl-note{font-size:.9rem;opacity:.85}";
    document.head.appendChild(s);
  }
  function mine() {                                          // if the visitor is logged in and on the board, we can highlight their row
    return fetch("/web/session/get_session_info", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {} }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var s = j.result || {}; if (!s.uid || s.is_public || s.is_website_user) return "";
        return fetch("/web/dataset/call_kw/x_badge_profile/search_read", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { model: "x_badge_profile", method: "search_read", args: [[]], kwargs: { fields: ["x_nickname"], limit: 1 } } }) })
          .then(function (r) { return r.json(); }).then(function (k) { return (k.result && k.result[0] && k.result[0].x_nickname) || ""; });
      }).catch(function () { return ""; });
  }
  function draw(data, me) {
    ROOT.textContent = "";
    var rows = (data && data.rows) || [];
    if (!rows.length) {
      ROOT.appendChild(h("p", { text: "No Rangers on the board yet. Be the first! Set up your Membership Card." }));
    } else {
      var body = h("tbody");
      rows.forEach(function (r) {
        var isMe = me && r.name === me;
        var nameCell = h("td", { class: "mrl-name", text: r.name });
        if (r.ooo) nameCell.appendChild(oooIcon());
        if (isMe) nameCell.appendChild(h("span", { class: "mrl-you", text: "You" }));
        body.appendChild(h("tr", { class: (r.rank <= 3 ? "mrl-top " : "") + (isMe ? "mrl-me" : "") }, [
          h("td", { class: "mrl-rank", text: "#" + r.rank }), nameCell, h("td", { class: "mrl-num", text: String(r.points) })]));
      });
      var table = h("table", {}, [h("thead", {}, [h("tr", {}, [h("th", { scope: "col", text: "Rank" }), h("th", { scope: "col", text: "Ranger" }), h("th", { scope: "col", class: "mrl-num", text: "Glory" })])]), body]);
      ROOT.appendChild(h("div", { class: "mrl-panel" }, [table]));
    }
    var join = h("p", { class: "mrl-note" }, [document.createTextNode("Want to be on the board? "),
      h("a", { href: "/my#ranger-card", text: "Pick a Ranger Persona name" }), document.createTextNode(" on your Membership Card. The board refreshes about every five minutes, and your real name is never shown.")]);
    ROOT.appendChild(join);
  }
  css();
  ROOT.appendChild(h("p", { text: "Loading the board..." }));
  if (!BOARD) { ROOT.textContent = "The leaderboard is not set up yet."; return; }
  Promise.all([fetch(BOARD).then(function (r) { if (!r.ok) throw new Error("board"); return r.json(); }), mine()])
    .then(function (v) { draw(v[0], v[1]); })
    .catch(function () { ROOT.textContent = "The leaderboard couldn't be loaded right now. Please try again in a few minutes."; });
})();
