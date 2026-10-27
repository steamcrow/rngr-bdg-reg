/* Monster Rangers - Ranger Card (loaded from GitHub via jsDelivr, only on the account page /my).
   A virtual membership card at the top of the Odoo account page: Ranger Persona name, Branch, Barrow, Order of Obscuria (OoO) status.
   It holds NO secrets and decides NOTHING: every change is a request record that Odoo stamps with the logged-in user,
   and the checker (Cloudflare Worker) validates it against fixed lists and saves it. */
(function () {
  "use strict";
  if (!/^\/my(\/home)?\/?$/.test(location.pathname)) return;
  var WORKER = String(window.MR_WORKER || "https://rngr-badge-checker-live.steamcrow-rangers.workers.dev").replace(/\/$/, "");
  var POLL_MS = 700, POLL_MAX = 40;                                   // 40 x 0.7s = 28 seconds, then we say "still saving"
  var JOIN_URL = "/order-of-obscuria", MANAGE_URL = "/my/orders";     // where the OoO chip sends non-members / members

  function rpc(model, method, args, kwargs) {
    return fetch("/web/dataset/call_kw/" + model + "/" + method, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { model: model, method: method, args: args || [], kwargs: kwargs || {} } })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error((j.error.data && j.error.data.message) || j.error.message || "error");
      return j.result;
    });
  }
  function whoAmI() {
    return fetch("/web/session/get_session_info", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: {} }) })
      .then(function (r) { return r.json(); }).then(function (j) { return j.result || {}; }).catch(function () { return {}; });
  }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") el.textContent = attrs[k]; else if (k === "class") el.className = attrs[k]; else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  /* PLACEHOLDER Order of Obscuria seal: swap this one function for real art later. The leaderboard has its own copy. */
  function oooIcon() {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "22"); svg.setAttribute("height", "22"); svg.setAttribute("aria-hidden", "true");
    var c = document.createElementNS(NS, "circle"); c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "10.5");
    c.setAttribute("fill", "#4b2a5c"); c.setAttribute("stroke", "#e7b64a"); c.setAttribute("stroke-width", "1.5"); svg.appendChild(c);
    var t = document.createElementNS(NS, "text"); t.setAttribute("x", "12"); t.setAttribute("y", "15.2"); t.setAttribute("text-anchor", "middle");
    t.setAttribute("font-size", "8.5"); t.setAttribute("font-weight", "700"); t.setAttribute("fill", "#e7b64a"); t.setAttribute("font-family", "sans-serif");
    t.textContent = "OoO"; svg.appendChild(t);
    return svg;
  }
  function css() {
    if (document.getElementById("mr-card-css")) return;
    var s = document.createElement("style"); s.id = "mr-card-css";
    s.textContent =
      "#mr-card-app{margin:0 0 2rem;font-size:1.05rem;line-height:1.5}" +
      "#mr-card-app .mrc-card{border:2px dashed var(--mr-line,#b9aab6);background:var(--mr-card-bg,#fff);border-radius:.6rem;padding:1.2rem 1.5rem 1.4rem}" +
      "#mr-card-app .mrc-kicker{font-family:var(--mr-font-head,inherit);font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:.95rem;opacity:.8;margin:0}" +
      "#mr-card-app .mrc-top{display:flex;flex-wrap:wrap;gap:.8rem 1.5rem;align-items:flex-end;justify-content:space-between;margin:.2rem 0 .6rem}" +
      "#mr-card-app .mrc-name{font-family:var(--mr-font-head,inherit);font-weight:700;text-transform:uppercase;letter-spacing:.02em;font-size:2rem;line-height:1.1;margin:0;overflow-wrap:anywhere}" +
      "#mr-card-app .mrc-name.mrc-none{opacity:.55}" +
      "#mr-card-app .mrc-ooo{display:inline-flex;align-items:center;gap:.5rem;padding:.35rem .8rem;border-radius:2rem;text-decoration:none;font-weight:700;font-size:.95rem;border:2px solid var(--mr-line,#b9aab6);color:var(--mr-ink,#222)}" +
      "#mr-card-app .mrc-ooo.yes{background:#f3e9f7;border-color:#4b2a5c}" +
      "#mr-card-app .mrc-ooo small{font-weight:400;text-decoration:underline}" +
      "#mr-card-app .mrc-facts{display:flex;flex-wrap:wrap;gap:.4rem 1.6rem;margin:0 0 1rem;padding:0;list-style:none}" +
      "#mr-card-app .mrc-facts b{font-family:var(--mr-font-head,inherit);text-transform:uppercase;letter-spacing:.03em;margin-right:.3rem}" +
      "#mr-card-app form{margin:0;border-top:2px dashed var(--mr-stitch,#d8cfd6);padding-top:1rem}" +
      "#mr-card-app .mrc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.9rem 1.2rem}" +
      "#mr-card-app label{display:block;font-weight:700;margin:0 0 .25rem}" +
      "#mr-card-app input[type=text],#mr-card-app select{width:100%;padding:.6rem .8rem;font-size:1.05rem;border:2px solid var(--mr-field-line,#8a7a88);border-radius:.4rem;background:var(--mr-input-bg,#fff);color:inherit}" +
      "#mr-card-app .mrc-check{display:flex;gap:.5rem;align-items:center;margin:.9rem 0 0}" +
      "#mr-card-app .mrc-check label{margin:0;font-weight:400}" +
      "#mr-card-app .mrc-actions{display:flex;flex-wrap:wrap;gap:.8rem 1.2rem;align-items:center;margin-top:1rem}" +
      "#mr-card-app button[disabled]{opacity:.55;cursor:wait}" +
      "#mr-card-app .mrc-msg{margin:.9rem 0 0;padding:.7rem 1rem;border-radius:.4rem}" +
      "#mr-card-app .mrc-msg:empty{display:none}" +
      "#mr-card-app .mrc-msg.ok{background:#e3f4e1}#mr-card-app .mrc-msg.warn{background:#fff1d6}#mr-card-app .mrc-msg.bad{background:#fbe0e0}" +
      "#mr-card-app .mrc-help{font-size:.9rem;opacity:.85;margin:.8rem 0 0}";
    document.head.appendChild(s);
  }
  // a request record is saved by Odoo, the checker handles it within a second or two; we watch until it is no longer pending
  function pollRec(model, id, n) {
    return rpc(model, "read", [[id]], { fields: ["x_status", "x_message"] }).then(function (r) {
      var c = r[0] || {};
      if (c.x_status === "pending" || c.x_status === "processing") {
        if (n >= POLL_MAX) return { ok: false, message: "Still saving... please check again in a minute." };
        return new Promise(function (go) { setTimeout(go, POLL_MS); }).then(function () { return pollRec(model, id, n + 1); });
      }
      return { ok: c.x_status === "ok", message: c.x_message || "Something went wrong. Please try again." };
    });
  }
  function mount() {
    var host = document.querySelector(".o_portal_my_home") || document.querySelector("#wrap .o_portal_wrap") || document.querySelector("#wrap") || document.querySelector("main");
    if (!host) return null;
    var box = h("section", { id: "mr-card-app", "aria-label": "Your Ranger Card" });
    host.insertBefore(box, host.firstChild);
    return box;
  }
  function readProfile() {
    return rpc("x_badge_profile", "search_read", [[]], { fields: ["x_nickname", "x_show", "x_branch", "x_barrow", "x_ooo"], limit: 1 }).then(function (rows) { return rows[0] || {}; });
  }
  function select(id, label, choices, current, blank) {
    var sel = h("select", { id: id, name: id });
    sel.appendChild(h("option", { value: "", text: blank }));
    var list = (choices || []).slice();
    if (current && list.indexOf(current) < 0) list.push(current);          // an older choice that is no longer on the list stays visible
    list.forEach(function (v) { sel.appendChild(h("option", { value: v, text: v })); });
    sel.value = current || "";
    return h("div", {}, [h("label", { for: id, text: label }), sel]);
  }
  function draw(box, st, flash) {
    css(); box.textContent = "";
    var p = st.profile, nick = p.x_nickname || "", member = !!p.x_ooo;
    var chip = h("a", { class: "mrc-ooo " + (member ? "yes" : "no"), href: member ? MANAGE_URL : JOIN_URL }, [
      member ? oooIcon() : null,
      h("span", { text: member ? "OoO Member" : "Not an OoO Member" }),
      h("small", { text: member ? "Manage membership" : "Join the Order of Obscuria" })]);
    var facts = h("ul", { class: "mrc-facts" }, [
      h("li", {}, [h("b", { text: "Branch" }), document.createTextNode(p.x_branch || "not chosen yet")]),
      h("li", {}, [h("b", { text: "Barrow" }), document.createTextNode(p.x_barrow || "not chosen yet")]),
      h("li", {}, [h("b", { text: "Glory" }), document.createTextNode(String(st.points))]),
      h("li", {}, [h("b", { text: "Badges" }), h("a", { href: "/my-badges", text: String(st.count) })])]);

    var persona = h("input", { type: "text", id: "mrc-persona", name: "persona", maxlength: "24", autocomplete: "off", spellcheck: "false", placeholder: "Your Ranger Persona name" });
    persona.value = nick;
    var cb = h("input", { type: "checkbox", id: "mrc-show", name: "show" }); cb.checked = !!p.x_show;
    var branch = select("mrc-branch", "Ranger Branch", st.opts && st.opts.branches, p.x_branch, "Choose a Branch");
    var barrow = select("mrc-barrow", "Barrow (your local troop)", st.opts && st.opts.barrows, p.x_barrow, "Choose a Barrow");
    var msg = h("div", { class: "mrc-msg", "aria-live": "polite", role: "status" });
    var btn = h("button", { type: "submit", class: "btn btn-primary", text: "Save my Ranger Card" });
    var form = h("form", { novalidate: "novalidate" }, [
      h("div", { class: "mrc-grid" }, [h("div", {}, [h("label", { for: "mrc-persona", text: "Ranger Persona name" }), persona]), branch, barrow]),
      h("div", { class: "mrc-check" }, [cb, h("label", { for: "mrc-show", text: "Show me on the Glory Leaderboard" })]),
      h("div", { class: "mrc-actions" }, [btn, h("a", { href: "/leaderboard", text: "See the Glory Leaderboard" })]), msg]);
    function say(kind, text) { msg.className = "mrc-msg " + kind; msg.textContent = text; }
    var busy = false;
    form.addEventListener("submit", function (ev) {
      ev.preventDefault(); if (busy) return;
      var name = persona.value.replace(/\s+/g, " ").trim();
      var bv = form.querySelector("#mrc-branch").value, wv = form.querySelector("#mrc-barrow").value;
      var nickChanged = name !== nick || cb.checked !== !!p.x_show;
      var cardChanged = bv !== (p.x_branch || "") || wv !== (p.x_barrow || "");
      if (!nickChanged && !cardChanged) { say("warn", "Nothing to save yet. Change something first."); return; }
      if (nickChanged && cb.checked && !name) { say("warn", "Type a Ranger Persona name first, or untick the leaderboard box."); return; }
      busy = true; btn.disabled = true; say("warn", "Saving...");
      var results = [], chain = Promise.resolve();
      if (nickChanged) chain = chain.then(function () { return rpc("x_badge_nick", "create", [{ x_nickname: name, x_show: cb.checked }]); })
        .then(function (id) { return pollRec("x_badge_nick", id, 0); }).then(function (r) { results.push(r); });
      if (cardChanged) chain = chain.then(function () { return rpc("x_badge_card", "create", [{ x_branch: bv, x_barrow: wv }]); })
        .then(function (id) { return pollRec("x_badge_card", id, 0); }).then(function (r) { results.push(r); });
      chain.then(function () {
        var bad = results.filter(function (r) { return !r.ok; })[0];
        var text = bad ? bad.message : (results.length > 1 ? "Saved! Your Ranger Card is up to date." : results[0].message);
        return readProfile().then(function (np) { st.profile = np; draw(box, st, { kind: bad ? "bad" : "ok", text: text }); });
      }).catch(function () {
        busy = false; btn.disabled = false; say("bad", "We couldn't reach the badge desk. Nothing was changed. Please try again.");
      });
    });
    var help = h("p", { class: "mrc-help", text: "Your Persona name is the only name other Rangers see. Your real name and email are never shown. You can belong to more than one Branch, but your card shows one: pick the one you want to show off." +
      (st.opts ? "" : " (The Branch and Barrow lists couldn't be loaded right now. Please refresh in a minute to change them.)") });
    var card = h("div", { class: "mrc-card", id: "ranger-card" }, [
      h("p", { class: "mrc-kicker", text: "Monster Rangers Ranger Card" }),
      h("div", { class: "mrc-top" }, [h("h2", { class: "mrc-name" + (nick ? "" : " mrc-none"), text: nick || "No Persona name yet" }), chip]),
      facts, form, help]);
    box.appendChild(card);
    if (flash) say(flash.kind, flash.text);
  }
  function start() {
    whoAmI().then(function (me) {
      if (!me.uid || me.is_public || me.is_website_user) return;                    // only logged-in Rangers get a card
      var box = mount(); if (!box) return;
      var optsP = fetch(WORKER + "/card-options").then(function (r) { if (!r.ok) throw new Error("opts"); return r.json(); }).catch(function () { return null; });
      var regsP = me.partner_id ? rpc("x_badge_registration", "search_read", [[["x_status", "=", "active"], ["x_partner_id", "=", me.partner_id]]], { fields: ["x_points"], limit: 5000 }) : Promise.resolve([]);
      return Promise.all([readProfile(), regsP, optsP]).then(function (v) {
        var pts = 0; v[1].forEach(function (r) { pts += r.x_points || 0; });
        draw(box, { profile: v[0], points: pts, count: v[1].length, opts: v[2] });
      }).catch(function () { if (box.parentNode) box.parentNode.removeChild(box); });   // the card tables are not installed on this site yet: show nothing
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
