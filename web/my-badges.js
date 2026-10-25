/* Monster Rangers - My Badges (loaded from GitHub via jsDelivr, like the Coffin Canyon apps).
   Draws the Ranger's collection and the "Register a badge" form. It holds NO secrets and decides NOTHING:
   a claim is just a record Odoo stamps with the logged-in user; the checker (Cloudflare Worker) does the checking.
   Page needs:  <div id="mr-badges-app"></div>  then this script. */
(function () {
  "use strict";
  var ROOT = document.getElementById("mr-badges-app");
  if (!ROOT || ROOT.getAttribute("data-ready")) return;
  ROOT.setAttribute("data-ready", "1");
  var PAGE = 48, POLL_MS = 700, POLL_MAX = 40;      // 40 x 0.7s = 28 seconds, then we say "still checking"
  var state = { regs: [], shown: PAGE, filter: "", busy: false };

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
  function css() {
    if (document.getElementById("mr-badges-css")) return;
    var s = document.createElement("style"); s.id = "mr-badges-css";
    s.textContent =
      "#mr-badges-app{font-size:1.1rem;line-height:1.5;max-width:1100px;margin:0 auto}" +
      "#mr-badges-app .mrb-top{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-end;justify-content:space-between;margin-bottom:1rem}" +
      "#mr-badges-app .mrb-total{font-size:1.4rem;font-weight:700}" +
      "#mr-badges-app form{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}" +
      "#mr-badges-app input[type=text],#mr-badges-app input[type=search]{flex:1 1 16rem;padding:.7rem .9rem;font-size:1.1rem;border:2px solid #8a7a88;border-radius:.4rem}" +
      "#mr-badges-app button{padding:.7rem 1.2rem;font-size:1.1rem;border-radius:.4rem;border:0;background:var(--primary,#c8693a);color:#fff;cursor:pointer}" +
      "#mr-badges-app button[disabled]{opacity:.55;cursor:wait}" +
      "#mr-badges-app .mrb-msg{min-height:1.5rem;padding:.6rem .9rem;border-radius:.4rem;margin-bottom:1rem}" +
      "#mr-badges-app .mrb-msg.ok{background:#e3f4e1}#mr-badges-app .mrb-msg.warn{background:#fff1d6}#mr-badges-app .mrb-msg.bad{background:#fbe0e0}" +
      "#mr-badges-app .mrb-msg img{width:72px;height:72px;object-fit:contain;vertical-align:middle;margin-right:.8rem}" +
      "#mr-badges-app .mrb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:1rem}" +
      "#mr-badges-app .mrb-card{border:1px solid #c9bfc7;border-radius:.6rem;padding:.8rem;text-align:center;background:#fff;color:#222}" +
      "#mr-badges-app .mrb-card img{width:100%;max-width:120px;height:120px;object-fit:contain}" +
      "#mr-badges-app .mrb-card b{display:block;margin-top:.4rem;font-size:1rem}" +
      "#mr-badges-app .mrb-card small{color:#555}";
    document.head.appendChild(s);
  }
  function imgUrl(pid) { return "/web/image/product.template/" + pid + "/image_256"; }
  function say(kind, text, pid) {
    var box = ROOT.querySelector(".mrb-msg"); box.className = "mrb-msg " + kind; box.textContent = "";
    if (pid) { var im = h("img", { src: imgUrl(pid), alt: "" }); box.appendChild(im); }
    box.appendChild(document.createTextNode(text));
  }
  function render() {
    var total = state.regs.reduce(function (a, r) { return a + (r.x_points || 0); }, 0);
    ROOT.querySelector(".mrb-total").textContent = state.regs.length + (state.regs.length === 1 ? " badge" : " badges") + " · " + total + " points";
    var f = state.filter.toLowerCase();
    var list = state.regs.filter(function (r) { return !f || (r.x_product_id && r.x_product_id[1].toLowerCase().indexOf(f) > -1); });
    var grid = ROOT.querySelector(".mrb-grid"); grid.textContent = "";
    list.slice(0, state.shown).forEach(function (r) {
      var name = r.x_product_id ? r.x_product_id[1].replace(/ Spirit Badge$/, "") : "Badge";
      grid.appendChild(h("div", { class: "mrb-card" }, [
        h("img", { src: r.x_product_id ? imgUrl(r.x_product_id[0]) : "", alt: "", loading: "lazy" }),
        h("b", { text: name }), h("small", { text: (r.x_points || 0) + " pts" })]));
    });
    var more = ROOT.querySelector(".mrb-more");
    more.style.display = list.length > state.shown ? "" : "none";
    if (!list.length) grid.appendChild(h("p", { text: state.regs.length ? "No badges match that search." : "No badges yet. Enter a badge code above to add your first one!" }));
  }
  function load() {
    return rpc("x_badge_registration", "search_read", [[["x_status", "=", "active"]]],
      { fields: ["x_product_id", "x_points", "x_registered_at"], order: "x_registered_at desc, id desc", limit: 2000 })
      .then(function (rows) { state.regs = rows; render(); });
  }
  function poll(id, n) {
    return rpc("x_badge_claim", "read", [[id]], { fields: ["x_status", "x_message", "x_product_id", "x_points"] }).then(function (r) {
      var c = r[0] || {};
      if (c.x_status === "pending" || c.x_status === "processing") {
        if (n >= POLL_MAX) { say("warn", "Still checking... your badge will show up in a moment. You can refresh the page."); return; }
        return new Promise(function (ok) { setTimeout(ok, POLL_MS); }).then(function () { return poll(id, n + 1); });
      }
      var pid = c.x_product_id && c.x_product_id[0];
      if (c.x_status === "registered") { say("ok", (c.x_product_id ? c.x_product_id[1] + " – " : "") + (c.x_message || "Badge added!") + " +" + (c.x_points || 0) + " points", pid); return load(); }
      if (c.x_status === "already") { say("warn", c.x_message || "You already have this badge.", pid); return; }
      say("bad", c.x_message || "Something went wrong. Please try again.");
    });
  }
  function submit(ev) {
    ev.preventDefault();
    if (state.busy) return;
    var input = ROOT.querySelector("input[name=code]"), btn = ROOT.querySelector("button[type=submit]");
    var code = input.value.trim();                                  // never change the letters: codes are case sensitive
    if (!code) { say("warn", "Please type the code from your badge."); return; }
    if (code.length > 64) { say("bad", "That code is too long."); return; }
    state.busy = true; btn.disabled = true; say("warn", "Checking your badge...");
    rpc("x_badge_claim", "create", [{ x_code: code }]).then(function (id) { input.value = ""; return poll(id, 0); })
      .catch(function () { say("bad", "We couldn't reach the badge checker. Nothing was changed. Please try again."); })
      .then(function () { state.busy = false; btn.disabled = false; });
  }
  function build() {
    css(); ROOT.textContent = "";
    var form = h("form", { novalidate: "novalidate" }, [
      h("input", { type: "text", name: "code", placeholder: "Type your badge code", autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false", "aria-label": "Badge code", maxlength: "64" }),
      h("button", { type: "submit", text: "Register badge" })]);
    form.addEventListener("submit", submit);
    var search = h("input", { type: "search", placeholder: "Search my badges", "aria-label": "Search my badges" });
    search.addEventListener("input", function () { state.filter = search.value; state.shown = PAGE; render(); });
    var more = h("button", { type: "button", class: "mrb-more", text: "Show more" }); more.style.display = "none";
    more.addEventListener("click", function () { state.shown += PAGE; render(); });
    ROOT.appendChild(h("div", { class: "mrb-top" }, [h("div", { class: "mrb-total", text: "" }), search]));
    ROOT.appendChild(form);
    var msg = h("div", { class: "mrb-msg", "aria-live": "polite", role: "status" }); ROOT.appendChild(msg);
    ROOT.appendChild(h("div", { class: "mrb-grid" })); ROOT.appendChild(more);
    return load();
  }
  whoAmI().then(function (s) {
    var loggedIn = s && s.uid && !s.is_public && !s.is_website_user;
    if (!loggedIn) {
      css(); ROOT.textContent = "";
      ROOT.appendChild(h("p", { text: "Please log in to see your badges and register new ones." }));
      var a = h("a", { href: "/web/login?redirect=" + encodeURIComponent(location.pathname), text: "Log in or sign up", class: "btn btn-primary" }); ROOT.appendChild(a); return;
    }
    return build().catch(function () { css(); ROOT.textContent = "Your badges could not be loaded right now. Please try again in a moment."; });
  });
})();
