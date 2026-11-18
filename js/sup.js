/* NDD supervisor (plant code + PIN): today's daily count at their warehouse, add SKUs, skip a day, history, ABC plan. */
import { S, hooks } from "./state.js";
import { rpc } from "./api.js";
import { $, el, fmt, bLabel, msg, confirmBox, openModal, closeModal, errText, toast } from "./ui.js";
import { variance } from "./pure.js";
import { dayStatus, clsTag } from "./dcc.js";
import { showAbc, niceDate } from "./daily.js";

export function loadSupTok() { try { S.sup = JSON.parse(localStorage.getItem("ndd2-sup") || "null"); } catch (e) { S.sup = null; } }
function saveSup() { if (S.sup) localStorage.setItem("ndd2-sup", JSON.stringify(S.sup)); else localStorage.removeItem("ndd2-sup"); }
function hhmm(ts) { return ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : ""; }

export function supLogin() {
  openModal(function (sh) {
    var pc = el("input", { inputmode: "numeric", placeholder: "Plant code", autocomplete: "off" }), pin = el("input", { type: "password", inputmode: "numeric", placeholder: "Supervisor PIN", autocomplete: "off" });
    var err = el("div", { class: "small", style: "color:var(--bad);min-height:18px" });
    async function go() {
      err.textContent = "";
      try {
        var r = await rpc("sup_login", { p_code: pc.value.trim(), p_pin: pin.value.trim() });
        if (!r.ok) { err.textContent = "Wrong plant code or PIN."; return; }
        S.sup = { token: r.token, branch: r.branch }; saveSup(); closeModal();
        if (r.mustChange) changePin(true); else { S.tab = "sup"; S.supDay = null; hooks.render(); }
      } catch (e) { err.textContent = errText(e); }
    }
    sh.append(el("h3", { text: "Supervisor login" }), el("p", { class: "small muted", text: "Your warehouse plant code and the PIN from HQ." }), pc, el("div", { style: "height:8px" }), pin, err,
      el("div", { class: "row", style: "justify-content:flex-end" }, el("button", { class: "btn", text: "Cancel", onclick: closeModal }), el("button", { class: "btn primary", text: "Log in", onclick: go })));
    setTimeout(function () { pc.focus(); }, 50);
  });
}

function changePin(first) {
  openModal(function (sh) {
    var a = el("input", { type: "password", inputmode: "numeric", placeholder: "New PIN (6-8 digits)" }), b = el("input", { type: "password", inputmode: "numeric", placeholder: "Repeat new PIN" });
    var err = el("div", { class: "small", style: "color:var(--bad);min-height:18px" });
    sh.append(el("h3", { text: first ? "Choose your own PIN" : "Change PIN" }), el("p", { class: "small muted", text: first ? "The PIN from HQ is for the first login only. Pick a new one that only you know." : "6 to 8 digits." }), a, el("div", { style: "height:8px" }), b, err,
      el("div", { class: "row", style: "justify-content:flex-end" }, first ? null : el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", text: "Save PIN", onclick: async function () {
          if (a.value !== b.value) { err.textContent = "The two PINs are different."; return; }
          try { await rpc("sup_change_pin", { p_token: S.sup.token, p_branch: S.sup.branch, p_pin: a.value }); closeModal(); toast("PIN saved"); S.tab = "sup"; S.supDay = null; hooks.render(); }
          catch (e) { err.textContent = errText(e); }
        } })));
  }, first);
}

export function supLogout() {
  var t = S.sup && S.sup.token; S.sup = null; S.supDay = null; saveSup(); S.tab = "count"; hooks.render();
  if (t) rpc("logout", { p_token: t }).catch(function () { });
}

async function load(date) {
  try { S.supDay = await rpc("sup_day", { p_token: S.sup.token, p_branch: S.sup.branch, p_date: date || null }); hooks.render(); }
  catch (e) { if (e.code === "AUTH") { msg("Logged out", "Your supervisor login expired. Log in again."); supLogout(); } else msg("Can't load", errText(e)); }
}

export function renderSup(app) {
  if (!S.sup) { S.tab = "count"; hooks.render(); return; }
  var D = S.supDay;
  if (!D) { app.append(el("p", { class: "center muted", text: "Loading…" })); load(); return; }
  var ti = D.takeInfo, isToday = D.date === D.today, docs = (D.sessions || []).map(function (s) { var d = s.data || {}; return { id: s.id, branch: s.branch, role: s.role, member: d.member || "", names: d.names || [], lines: d.lines || {}, status: s.status, submittedAt: s.submittedAt }; });
  var sub = docs.filter(function (x) { return x.status === "submitted"; }).map(function (x) { return x.submittedAt; }).sort()[0];
  var started = docs.some(function (x) { return Object.keys(x.lines).length; });
  var s = dayStatus({ take: ti, why: D.monthlyOpen ? "monthly" : "nothing", submittedAt: sub, started: started, late: false }, D.date, D.today);

  app.append(el("div", { class: "card row", style: "justify-content:space-between" },
    el("div", {}, el("div", { class: "small muted", text: "Supervisor" }), el("h2", { style: "margin:2px 0", text: D.branch }), el("div", { class: "small", text: niceDate(D.date) })),
    el("div", { class: "row" },
      el("button", { class: "btn", text: "This month's plan", onclick: function () { showAbc(D.branch, S.sup.token); } }),
      el("button", { class: "btn", text: "Change PIN", onclick: function () { changePin(false); } }),
      el("button", { class: "btn", text: "↻", title: "Refresh", onclick: function () { load(D.date); } }))));

  if (!isToday) app.append(el("div", { class: "banner warn row", style: "justify-content:space-between" }, el("span", { text: "Past day (read-only)" }), el("button", { class: "btn", text: "Back to today", onclick: function () { load(); } })));
  else app.append(guide(D, s));

  if (!ti) {
    app.append(el("div", { class: "card center" }, el("h2", { text: D.monthlyOpen ? "Monthly stock take is open" : "Nothing to count" }),
      el("p", { class: "muted", text: D.monthlyOpen ? "Daily counts pause while the monthly stock take is open at this warehouse." : "No daily count is planned for this day (off day, no stock data from HQ yet, or nothing due)." })));
  } else {
    var plan = ti.plan || {}, sm = {}; (D.skus || []).forEach(function (k) { sm[k.code] = k; });
    var V = variance((D.sys || {})[D.branch] || [], docs, sm, Number((D.settings || {}).tolerance) || 2, true);
    var counted = {}; V.forEach(function (o) { if (o.status === "MATCH") counted[o.code] = 1; });
    app.append(el("div", { class: "stats" },
      el("div", { class: "stat" }, el("b", { text: s.t.split(" · ")[0] }), el("span", { text: "Status" })),
      el("div", { class: "stat" }, el("b", { text: Object.keys(counted).length + " / " + ti.skuCount }), el("span", { text: "SKUs counted" })),
      el("div", { class: "stat" }, el("b", { text: sub ? hhmm(sub) : "-" }), el("span", { text: "Submitted" })),
      el("div", { class: "stat" }, el("b", { text: docs.map(function (x) { return (x.names.length ? x.names : [x.member]).join(", "); }).join(" · ") || "-" }), el("span", { text: "Counted by" }))));
    if (ti.skipReason) app.append(el("div", { class: "banner warn" }, "Skipped: " + ti.skipReason));
    if (isToday && ti.status === "open") app.append(el("div", { class: "row", style: "margin-bottom:12px" },
      el("button", { class: "btn", text: "+ Add SKU to today", onclick: function () { addSku(D); } }),
      started ? null : el("button", { class: "btn", text: "Skip today", onclick: function () { skipDay(D); } })));

    var t = el("table", {}, el("tr", {}, ["", "Item", "Description", "Batch", "Counted", "System", "Var", "Var RM", "Result"].map(function (h, i) { return el("th", { class: i >= 4 && i <= 7 ? "n" : "", text: h }); })));
    Object.keys(plan).sort(function (a, b) { return (plan[a] + a).localeCompare(plan[b] + b); }).forEach(function (code) {
      var ls = V.filter(function (o) { return o.code === code; });
      if (!ls.length) ls = [{ code: code, batch: "", status: "NOT COUNTED", skuFlag: "NOT COUNTED" }];
      ls.forEach(function (o, i) {
        t.append(el("tr", {}, el("td", {}, i ? null : clsTag(plan[code])), el("td", { text: i ? "" : code }), el("td", { text: i ? "" : ((sm[code] || {}).desc || "") }), el("td", { text: bLabel(o.batch) }),
          el("td", { class: "n", text: o.phys == null ? "" : fmt(o.phys) }), el("td", { class: "n", text: fmt(o.sys) }), el("td", { class: "n" + (o.v < 0 ? " neg" : ""), text: o.v == null ? "" : fmt(o.v) }),
          el("td", { class: "n" + (o.vv < 0 ? " neg" : ""), text: o.vv == null ? "" : fmt(o.vv, 2) }),
          el("td", {}, i ? null : el("span", { class: "pill " + ({ OK: "ok", WITHIN: "ok", OVER: "bad", "NOT IN SYSTEM": "bad", PENDING: "warn" }[o.skuFlag] || ""), text: o.skuFlag === "NOT COUNTED" ? "not counted" : o.skuFlag }))));
      });
    });
    app.append(el("div", { class: "card" }, el("h3", { text: "Today's list" }),
      el("div", { class: "legend small muted", style: "display:flex;flex-wrap:wrap;gap:10px;margin-bottom:8px" }, ["A", "B", "C", "R", "S"].map(function (c) { return el("span", {}, clsTag(c), " " + { A: "high value", B: "medium", C: "low", R: "recount", S: "added by you" }[c]); })),
      el("div", { class: "tw" }, t)));
  }

  var h = el("table", {}, el("tr", {}, ["Date", "Status", "Counted", "Accuracy", ""].map(function (x, i) { return el("th", { class: i === 2 || i === 3 ? "n" : "", text: x }); })));
  (D.history || []).forEach(function (x) {
    var st = x.skip ? "Skipped" : x.submittedAt ? "Submitted " + hhmm(x.submittedAt) : x.date < D.today ? "Missed" : x.status === "open" ? "Open" : "Closed";
    h.append(el("tr", {}, el("td", { text: niceDate(x.date) }), el("td", {}, el("span", { class: "pill " + (x.skip ? "" : x.submittedAt ? "ok" : x.date < D.today ? "bad" : "warn"), text: st })),
      el("td", { class: "n", text: x.counted + " / " + x.skus }), el("td", { class: "n", text: x.counted ? Math.round(x.ok / x.counted * 100) + "%" : "-" }),
      el("td", {}, x.date === D.date ? el("span", { class: "small muted", text: "showing" }) : el("button", { class: "link", text: "View", onclick: function () { load(x.date); } }))));
  });
  if (!(D.history || []).length) h.append(el("tr", {}, el("td", { colspan: 5, class: "muted", text: "No daily counts yet." })));
  app.append(el("div", { class: "card" }, el("h3", { text: "Last 30 days" }), el("div", { class: "tw" }, h)));
}

function addSku(D) {
  openModal(function (sh) {
    var all = (D.skus || []), q = el("input", { placeholder: "Search SKU code or name" }), list = el("div", { style: "max-height:50vh;overflow:auto" });
    function draw() {
      var v = q.value.trim().toLowerCase(), plan = (D.takeInfo || {}).plan || {}; list.replaceChildren();
      all.filter(function (k) { return !plan[k.code] && (!v || (k.code + " " + (k.desc || "")).toLowerCase().indexOf(v) >= 0); }).slice(0, 40).forEach(function (k) {
        list.append(el("button", { class: "big", style: "width:100%;margin-bottom:6px", onclick: async function () {
          try { await rpc("sup_add_sku", { p_token: S.sup.token, p_branch: D.branch, p_code: k.code }); closeModal(); toast(k.code + " added to today"); load(); }
          catch (e) { msg("Can't add", errText(e)); }
        } }, el("div", { text: k.code }), el("div", { class: "small muted", text: k.desc || "" })));
      });
    }
    q.addEventListener("input", draw);
    sh.append(el("h3", { text: "Add a SKU to today's count" }), el("p", { class: "small muted", text: "For example a SKU you suspect is wrong, or after a complaint. HQ sees what you added." }), q, el("div", { style: "height:8px" }), list,
      el("div", { class: "row", style: "justify-content:flex-end;margin-top:8px" }, el("button", { class: "btn", text: "Close", onclick: closeModal })));
    draw(); setTimeout(function () { q.focus(); }, 50);
  });
}

function skipDay(D) {
  openModal(function (sh) {
    var r = el("textarea", { rows: 3, placeholder: "Why can't the count happen today?" }), err = el("div", { class: "small", style: "color:var(--bad);min-height:18px" });
    sh.append(el("h3", { text: "Skip today's count?" }), el("p", { class: "small muted", text: "HQ sees the reason. The SKUs move to the next working days." }), r, err,
      el("div", { class: "row", style: "justify-content:flex-end" }, el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", text: "Skip today", onclick: async function () {
          try { await rpc("sup_skip", { p_token: S.sup.token, p_branch: D.branch, p_reason: r.value }); closeModal(); load(); }
          catch (e) { err.textContent = errText(e); }
        } })));
  });
}

/* "What to do today": one card that tells the supervisor the next step for today's status. */
function guide(D, s) {
  var ti = D.takeInfo, w = D.window || {}, link = location.origin + location.pathname.replace(/index\.html$/, "");
  var c = el("div", { class: "card guide" }, el("h3", { text: "What to do today" }));
  function steps(list) { c.append(el("ol", { class: "steps-ol" }, list.map(function (x) { return el("li", {}, x); }))); }
  if (!ti) {
    c.append(el("p", { text: D.monthlyOpen ? "The monthly stock take is open, so there is no daily count today. Your team counts the monthly stock take instead." :
      "Nothing to count today (off day, nothing due, or HQ hasn't uploaded today's stock yet). Nothing for you to do." }));
  } else if (ti.skipReason) {
    c.append(el("p", { text: "Today's count was skipped: " + ti.skipReason + ". The SKUs move to the next working days." }));
  } else if (s.t === "On time" || s.t === "Late") {
    steps(["Done for today ✓ - submitted" + (s.t === "Late" ? " (after " + (w.to || "the window") + ", so it shows as late)" : "") + ".",
      "Look at SKUs marked OVER in the list below: they are counted again tomorrow automatically.",
      "Nothing else to do."]);
  } else {
    var n = ti.skuCount, msgTxt = "Today's cycle count - " + D.branch + ": " + n + " SKU(s).\nOpen " + link + " , enter plant code " + (w.plant || "") + " and count the list" + (w.to ? " before " + w.to : "") + ", then submit.";
    steps([
      el("span", {}, "Send the counter today's task: ", el("button", { class: "link", text: "copy message", onclick: function () { copy(msgTxt); } }), " or ", el("a", { href: "https://wa.me/?text=" + encodeURIComponent(msgTxt), target: "_blank", rel: "noopener", text: "send on WhatsApp" }), "."),
      "The counter opens the app on their phone, enters plant code " + (w.plant || "") + " and counts the " + n + " SKU(s) below" + (w.to ? ", before " + w.to : "") + ".",
      "Come back here after they submit to check the result. You can watch progress live (↻).",
      "Can't count today? Use “Skip today” with a reason. Need an extra SKU checked? Use “+ Add SKU to today”."]);
    if (s.t === "Counting") c.append(el("p", { class: "small", style: "margin:8px 0 0", text: "Counting has started - waiting for the counter to submit." }));
  }
  c.append(el("p", { class: "small muted", style: "margin:10px 0 0", text: "You don't start counts yourself: the daily list is made automatically every working day from HQ's stock upload (most valuable SKUs more often), and HQ starts the monthly full stock take." }));
  return c;
}
function copy(t) {
  try { navigator.clipboard.writeText(t).then(function () { toast("Message copied"); }, function () { msg("Message for the counter", t); }); }
  catch (e) { msg("Message for the counter", t); }
}
