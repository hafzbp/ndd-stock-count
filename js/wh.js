/* My Warehouse on the shared warehouse device: set the device up once for an NDD, then each person taps their
   name and enters their PIN. Today shows only the tasks of their roles; Stock is LSH; Count is the daily count.
   Done (or 5 minutes without use) goes back to the people screen; nothing typed is lost. */
import { S, hooks, saveTokens, flush, store, backup, cur } from "./state.js";
import { rpc } from "./api.js";
import { el, msg, toast, errText, openModal, closeModal, confirmBox } from "./ui.js";
import { loadMaster, loadBranch, renderCount, timeLeft, svg, ICON } from "./count.js";
import { renderSup } from "./sup.js";
import { t } from "./i18n.js";
import { renderStock, loadLsh, ctnOf, fmtCtn } from "./lsh.js";

var IDLE_MS = 5 * 60 * 1000;
export var WH_ICON = {
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"/>',
  count: '<path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  truck: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  alert: '<path d="M12 8v5M12 16.5h.01"/><circle cx="12" cy="12" r="9"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'
};

export function whEnrolled() { return !!(S.wh && S.wh.key); }
export function whMode() { return whEnrolled() && !(S.admin && S.admin.token); }
export function whIn() { return !!(S.wh && (S.wh.person || S.wh.joined)); }
export function has(r) { var p = S.wh && S.wh.person; return !!p && (p.roles || []).some(function (x) { return r.indexOf(x) >= 0; }); }

export function initWH() {
  var d = store("mw-device"); S.wh = d && d.key ? Object.assign({ tab: "today", view: "" }, d) : { tab: "today", view: "" };
  S.wh.lang = store("mw-lang") || "en";
  var s = store("mw-sess");
  if (d && s && s.token && Date.now() - (s.at || 0) < IDLE_MS) {
    S.wh.person = s.person; S.wh.token = s.token; S.wh.lang = s.person.lang; S.wh.lastAct = s.at; S.wh.tab = s.tab || "today";
    S.tokens[d.branch] = s.token; if (has(["sup", "om"])) S.sup = { token: s.token, branch: d.branch, wh: true };
  } else if (s) { store("mw-sess", null); if (d && S.tokens[d.branch] === (s && s.token)) { delete S.tokens[d.branch]; saveTokens(); } }
  ["pointerdown", "keydown"].forEach(function (ev) { document.addEventListener(ev, touchAct, true); });
  setInterval(function () { if (S.wh && S.wh.person && Date.now() - (S.wh.lastAct || 0) > IDLE_MS) signOut("idle"); }, 15000);
}
function touchAct() { if (!S.wh || !S.wh.person) return; S.wh.lastAct = Date.now(); saveSess(); }
function saveSess() { if (S.wh.person) store("mw-sess", { token: S.wh.token, person: S.wh.person, at: S.wh.lastAct || Date.now(), tab: S.wh.tab }); else store("mw-sess", null); }

export async function signOut(why) {
  var w = S.wh; if (!w) return;
  if (w.joined) {
    var jt = w.joinTok; w.joined = false; w.joinTok = null;
    try { await flush(); } catch (e) { }
    if (S.tokens[w.branch] === jt) { delete S.tokens[w.branch]; saveTokens(); }
    S.mine.active = null; S.start = null; S.step = ""; backup();
    if (jt) rpc("logout", { p_token: jt }).catch(function () { });
    hooks.render(); return;
  }
  if (!w.person) return;
  var tok = w.token;
  try { await flush(); } catch (e) { }
  if (S.tokens[w.branch] === tok) { delete S.tokens[w.branch]; saveTokens(); }
  if (S.sup && S.sup.wh) S.sup = null;
  S.mine.active = null; S.start = null; S.step = ""; backup();
  w.person = null; w.token = null; w.lsh = null; w.tab = "today"; w.view = ""; w.pin = null; saveSess();
  if (tok) rpc("logout", { p_token: tok }).catch(function () { });
  closeModal(); document.body.classList.remove("noscroll");
  var x = document.getElementById("skuv"); if (x) x.remove();
  hooks.render(); window.scrollTo(0, 0);
  if (why === "idle") toast(t("signedOutIdle"));
}

function hhmm(ts) { return ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : ""; }
function roleTxt(p) { return (p.roles || []).map(function (r) { return t("roles_" + r); }).join(" · "); }
function initials(n) { return String(n || "?").split(/\s+/).map(function (x) { return x[0]; }).join("").slice(0, 2).toUpperCase(); }

/* ---------- header tabs (app.js draws them) ---------- */
export function whTabs() {
  if (!S.wh || !S.wh.person) return [];
  var out = [["today", t("today"), WH_ICON.home]];
  if (has(["lo", "om"])) out.push(["stock", t("stock"), WH_ICON.box]);
  if (has(["admin", "sup", "om"])) out.push(["count", t("count"), WH_ICON.count]);
  return out;
}
export function whSub() {
  var w = S.wh; if (!w) return "";
  if (w.person) return w.branch + " · " + w.person.name;
  if (w.joined) return w.branch + " · " + t("joinTake");
  return w.branch + " · " + (w.label || "");
}
export function whGo(tab) { S.wh.tab = tab; S.wh.view = ""; S.wh.lsh = null; saveSess(); if (tab === "count") prepCount(); hooks.render(); window.scrollTo(0, 0); }
hooks.whHome = function () { whGo("today"); };
hooks.whSignOut = function () { signOut(); };

/* ---------- render ---------- */
export function renderWH(app) {
  var w = S.wh;
  if (w.joined) { renderCount(app); return; }
  if (!w.person) { if (w.pin) renderPin(app); else renderPeople(app); return; }
  if (w.tab === "stock" && has(["lo", "om"])) { renderStock(app); return; }
  if (w.tab === "count" && has(["admin", "sup", "om"])) {
    if (w.view === "sup" && S.sup) { app.append(backRow(function () { w.view = ""; hooks.render(); })); renderSup(app); return; }
    renderCount(app);
    if (S.sup && !cur()) app.append(el("p", { class: "center", style: "margin-top:16px" }, el("button", { class: "link strong", text: "Supervisor: today's list, add a SKU or skip the day", onclick: function () { w.view = "sup"; S.supDay = null; hooks.render(); } })));
    return;
  }
  renderToday(app);
}
export function backRow(fn, label) { return el("div", { class: "rhead" }, el("button", { class: "iconbtn", "aria-label": t("back"), onclick: fn }, svg(ICON.back, 22)), el("div", { class: "rt", text: label || "" })); }

/* ---------- people screen ---------- */
async function loadInfo() {
  try { S.wh.info = await rpc("device_info", { p_key: S.wh.key }); S.wh.err = null; S.wh.branch = S.wh.info.branch; }
  catch (e) {
    if (e.code === "AUTH") { store("mw-device", null); store("mw-sess", null); S.wh = { tab: "today", view: "" }; msg(t("setupDevice"), errText(e)); }
    else S.wh.err = e.code === "OFFLINE" ? t("offline") : errText(e);
  }
  hooks.render();
}
function renderPeople(app) {
  var w = S.wh, info = w.info;
  if (!info && !w.loading) { w.loading = true; loadInfo().finally(function () { w.loading = false; }); }
  var head = el("div", { class: "wh-ppl-head" }, el("div", {}, el("h2", { style: "margin:0", text: t("whoAreYou") }), el("div", { class: "muted small", text: t("tapName") })),
    el("button", { class: "btn", text: t("language"), onclick: function () { w.lang = w.lang === "ms" ? "en" : "ms"; w.langPicked = true; store("mw-lang", w.lang); hooks.render(); } }));
  app.append(head);
  if (w.err) app.append(el("div", { class: "card", style: "color:var(--bad)", text: w.err }));
  if (!info) { app.append(el("div", { class: "center muted", text: "…" })); return; }
  if (info.stockTake) app.append(el("button", { class: "wh-task", style: "margin-bottom:12px;width:100%", onclick: joinTake },
    el("span", { class: "wh-ic", style: "background:var(--infobg);color:var(--info)" }, svg(WH_ICON.count, 22)),
    el("span", { class: "wh-tx" }, el("b", { text: t("joinTake") }), el("span", { class: "small muted", text: info.stockTake.name + " · " + t("joinTakeSub") })), svg(ICON.next, 18)));
  var g = el("div", { class: "wh-people" });
  (info.people || []).forEach(function (p) {
    g.append(el("button", { class: "wh-person" + (p.locked ? " locked" : ""), onclick: function () { w.pin = { person: p, v: "", step: "pin" }; if (!w.langPicked) w.lang = p.lang || w.lang; hooks.render(); } },
      el("span", { class: "wh-av", text: initials(p.name) }), el("b", { text: p.name }), el("span", { class: "small muted", text: roleTxt(p) }),
      p.locked ? el("span", { class: "small", style: "color:var(--bad);font-weight:700", text: "🔒" }) : null));
  });
  if (!(info.people || []).length) app.append(el("div", { class: "card muted", text: "No people yet. HQ or the Ops Manager adds them in Setup." }));
  app.append(g, el("p", { class: "center small muted", style: "margin-top:18px", text: info.branch + " · " + (info.label || "") }));
}

/* ---------- PIN ---------- */
function pinLen(p) { return (p.roles || []).indexOf("om") >= 0 ? 6 : 4; }
function renderPin(app) {
  var w = S.wh, st = w.pin, p = st.person, n = pinLen(p);
  var title = st.step === "new" ? t("setPin") : st.step === "again" ? t("repeatPin") : t("pinFor", { name: p.name });
  app.append(backRow(function () { w.pin = null; hooks.render(); }, ""));
  var box = el("div", { class: "wh-pinbox" },
    el("span", { class: "wh-av big", text: initials(p.name) }), el("h2", { style: "margin:6px 0 2px", text: title }),
    el("div", { class: "small muted", text: st.step === "pin" ? roleTxt(p) : t("setPinSub", { n: n }) }));
  var dots = el("div", { class: "wh-dots", "aria-label": st.v.length + " of " + n });
  for (var i = 0; i < n; i++) dots.append(el("span", { class: i < st.v.length ? "on" : "" }));
  box.append(dots, el("div", { class: "wh-pinerr", role: "alert", text: st.err || "" }));
  var pad = el("div", { class: "pad wh-pad" });
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].forEach(function (k) {
    if (!k) { pad.append(el("span")); return; }
    pad.append(el("button", { text: k, "aria-label": k === "⌫" ? "Delete" : k, disabled: st.busy, onclick: function () {
      if (k === "⌫") st.v = st.v.slice(0, -1); else if (st.v.length < n) st.v += k;
      st.err = ""; hooks.render();
      if (st.v.length === n) submitPin();
    } }));
  });
  box.append(pad);
  if (st.step === "pin") box.append(el("p", { class: "small muted center", style: "margin-top:12px", text: t("forgotPin") }));
  app.append(box);
}
async function submitPin() {
  var w = S.wh, st = w.pin, p = st.person;
  if (st.step === "new") { st.first = st.v; st.v = ""; st.step = "again"; hooks.render(); return; }
  if (st.step === "again") {
    if (st.v !== st.first) { st.v = ""; st.first = ""; st.step = "new"; st.err = t("pinsDiffer"); hooks.render(); return; }
    try { st.busy = true; await rpc("person_set_pin", { p_token: st.token, p_pin: st.v }); st.busy = false; startSession(st.res); }
    catch (e) { st.busy = false; st.v = ""; st.first = ""; st.step = "new"; st.err = errText(e); hooks.render(); }
    return;
  }
  st.busy = true; hooks.render();
  try {
    var r = await rpc("person_login", { p_key: w.key, p_person: p.id, p_pin: st.v });
    st.busy = false;
    if (!r.ok) {
      st.v = "";
      st.err = r.lockedUntil ? t("locked", { t: hhmm(r.lockedUntil) }) : r.gone ? "Not active any more." : t("wrongPin", { n: r.left });
      if (r.lockedUntil || r.gone) { w.info = null; }
      hooks.render(); return;
    }
    if (r.mustChange) { st.res = r; st.token = r.token; st.v = ""; st.step = "new"; st.err = ""; hooks.render(); return; }
    startSession(r);
  } catch (e) { st.busy = false; st.v = ""; st.err = e.code === "OFFLINE" ? t("offline") : errText(e); hooks.render(); }
}
async function startSession(r) {
  var w = S.wh;
  if (w.langPicked && w.lang !== r.person.lang) { r.person.lang = w.lang; rpc("person_set_lang", { p_token: r.token, p_lang: w.lang }).catch(function () { }); }
  w.langPicked = false;
  w.pin = null; w.person = r.person; w.token = r.token; w.lang = r.person.lang || w.lang; w.lastAct = Date.now(); w.tab = "today"; w.view = ""; w.lsh = null;
  S.tokens[w.branch] = r.token; saveTokens();
  if (has(["sup", "om"])) S.sup = { token: r.token, branch: w.branch, wh: true };
  saveSess(); hooks.render(); window.scrollTo(0, 0);
  loadMaster().catch(function () { });
  loadBranch(w.branch).then(hooks.render, function () { });
  if (has(["lo", "om"])) loadLsh().then(hooks.render, function () { });
  if (S.mine && Object.keys(S.mine.sessions).some(function (k) { return S.mine.sessions[k].dirty; })) flush();
}

/* ---------- monthly stock take, joined from the people screen ---------- */
async function joinTake() {
  try {
    var r = await rpc("device_join_take", { p_key: S.wh.key });
    S.wh.joined = true; S.wh.joinTok = r.token; S.tokens[r.branch] = r.token; saveTokens();
    S.take = r.take; S.start = { step: "confirm", branch: r.branch }; S.mine.active = null;
    await loadMaster().catch(function () { }); await loadBranch(r.branch).catch(function () { });
    hooks.render(); window.scrollTo(0, 0);
  } catch (e) { msg(t("joinTake"), errText(e)); S.wh.info = null; hooks.render(); }
}

/* ---------- count: the signed-in person counts; no plant code, no name picking ---------- */
export function prepCount() {
  var w = S.wh, m = cur();
  if (m && m.branch === w.branch) return;
  S.mine.active = null; S.step = "";
  S.start = { step: "confirm", branch: w.branch, role: "ops", names: [w.person.name] };
}

/* ---------- Today ---------- */
function minsLeft(L) {
  var n = new Date(L.now || Date.now()), kl = new Date(n.getTime() + 8 * 3600000), p = String(L.cutoff || "16:00").split(":");
  return Number(p[0]) * 60 + Number(p[1]) - (kl.getUTCHours() * 60 + kl.getUTCMinutes());
}
function leftTxt(L) { var m = minsLeft(L); if (m < 0) return t("late"); return t("timeLeft", { h: Math.floor(m / 60), m: m % 60 }); }
function task(icBg, icFg, ic, title, right, sub, onclick, rightCls) {
  return el("button", { class: "wh-task", onclick: onclick },
    el("span", { class: "wh-ic", style: "background:" + icBg + ";color:" + icFg }, svg(ic, 22)),
    el("span", { class: "wh-tx" }, el("span", { class: "wh-tl" }, el("b", { text: title }), right ? el("span", { class: "wh-due " + (rightCls || ""), text: right }) : null),
      sub ? el("span", { class: "small muted", text: sub }) : null),
    svg(ICON.next, 18));
}
function renderToday(app) {
  var w = S.wh, L = w.lsh, br = S.br[w.branch] || {}, tk = br.take || S.take || {}, cards = [];
  if (has(["lo", "om"]) && !L && !w.lshLoading) { w.lshLoading = true; loadLsh().then(hooks.render, function () { }).finally(function () { w.lshLoading = false; }); }
  if (has(["admin", "sup", "om"]) && tk.kind === "daily" && tk.status === "open") {
    var m = Object.keys(S.mine.sessions).map(function (k) { return S.mine.sessions[k]; }).filter(function (x) { return x.branch === w.branch; })[0];
    var sub = m && m.status === "submitted" ? "✓" : t("skusToCount", { n: tk.skuCount || 0 });
    if (!(m && m.status === "submitted")) cards.push(task("var(--infobg)", "var(--info)", WH_ICON.count, t("dailyCount"), tk.countTo ? t("byTime", { t: tk.countTo }) : "", sub, function () { whGo("count"); }, "info"));
  }
  if (L && L.enabled) {
    var wn = L.warnings || {};
    if (has(["lo", "om"]) && wn.stgOld) cards.push(task("var(--badbg)", "var(--bad)", WH_ICON.truck, t("stgLate"), "", t("stgLateSub", { n: wn.stgOld }), function () { S.wh.tab = "stock"; S.wh.view = "staging"; hooks.render(); }, "bad"));
    if (has(["lo", "om"]) && wn.failedWaiting) cards.push(task("var(--warnbg)", "var(--warn)", WH_ICON.truck, t("failedWait"), "", t("failedWaitSub", { n: wn.failedWaiting }), function () { S.wh.tab = "stock"; S.wh.view = "staging"; hooks.render(); }, "warn"));
    var pend = (L.pending || []).filter(function (x) { return !x.mine && !x.byOm; });
    if (has(["om"]) && pend.length) cards.push(task("var(--warnbg)", "var(--warn)", WH_ICON.alert, t("toApprove"), "", t("toApproveSub", { n: pend.length }), function () { S.wh.tab = "stock"; S.wh.view = "approve"; hooks.render(); }, "warn"));
    var open = (L.diffs || []).filter(function (d) { return d.status === "open"; });
    if (has(["om"]) && open.length) cards.push(task("var(--warnbg)", "var(--warn)", WH_ICON.alert, t("diffs"), L.cutoff ? t("byTime", { t: L.cutoff }) : "", t("diffsSub", { n: open.length }), function () { S.wh.tab = "stock"; S.wh.view = "diffs"; hooks.render(); }, "warn"));
    if (has(["om"]) && !L.todayClosed) cards.push(task("var(--chip)", "var(--ink)", WH_ICON.lock, t("closeDay"), L.cutoff, leftTxt(L), function () { S.wh.tab = "stock"; S.wh.view = "close"; hooks.render(); }, minsLeft(L) < 0 ? "bad" : minsLeft(L) < 60 ? "warn" : ""));
  }
  app.append(el("div", { class: "wh-hello" }, el("h2", { style: "margin:0", text: cards.length === 1 ? t("oneThing") : cards.length ? t("thingsToday", { n: cards.length }) : t("nothingToday") }),
    cards.length ? el("div", { class: "small muted", text: t("inTimeOrder") }) : null));
  cards.forEach(function (c) { app.append(c); });
  if (has(["lo", "om"]) && L && L.enabled) {
    app.append(el("button", { class: "btn primary block big1", style: "margin-top:6px", onclick: function () { S.wh.tab = "stock"; S.wh.view = "pick"; hooks.render(); } }, svg('<path d="M12 5v14M5 12h14"/>', 20), t("recordMove")));
    if (L.todayClosed) app.append(el("p", { class: "small muted center", text: t("dayClosed", { t: hhmm(L.closedAt) }) + (L.closedBy ? " · " + L.closedBy : "") }));
    var nMoves = (L.entries || []).filter(function (e) { return e.status === "ok"; }).length;
    app.append(el("div", { class: "card", style: "margin-top:14px" }, el("b", { text: t("doneToday") }),
      el("div", { class: "wh-kv" }, el("span", { text: t("movesToday") }), el("b", { text: String(nMoves) }))));
  } else if (has(["lo"]) && L && !L.enabled) app.append(el("div", { class: "card muted", text: t("noLsh") }));
}

/* ---------- setting a device up: plant code, the Ops Manager's name and PIN, a label ---------- */
export function openSetup(plant) {
  var st = { plant: plant || "", step: plant ? "loading" : "plant", oms: [], om: null, pin: "", label: "" };
  function draw() {
    openModal(function (sh) {
      var err = el("div", { class: "wh-pinerr", role: "alert", text: st.err || "" });
      sh.append(el("h3", { text: t("setupDevice") }), el("p", { class: "small muted", text: t("setupSub") }));
      if (st.step === "plant" || st.step === "loading") {
        var i = el("input", { inputmode: "numeric", value: st.plant, placeholder: t("plantCode"), autocomplete: "off" });
        sh.append(i, err, el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: t("cancel"), onclick: closeModal }),
          el("button", { class: "btn primary", style: "flex:2", text: t("next"), onclick: function () { st.plant = i.value.trim(); find(); } })));
        setTimeout(function () { i.focus(); }, 50);
      } else if (st.step === "om") {
        sh.append(el("p", { style: "font-weight:700;margin:0 0 8px", text: st.branch }));
        var g = el("div", { class: "wh-people" });
        st.oms.forEach(function (o) { g.append(el("button", { class: "wh-person", onclick: function () { st.om = o; st.step = "pin"; st.pin = ""; st.err = ""; draw(); } }, el("span", { class: "wh-av", text: initials(o.name) }), el("b", { text: o.name }), el("span", { class: "small muted", text: t("roles_om") }))); });
        if (!st.oms.length) sh.append(el("p", { class: "muted", text: "No Ops Manager set up for " + st.branch + " yet. HQ adds one in Setup → People." }));
        sh.append(g, err, el("button", { class: "btn block", style: "margin-top:10px", text: t("cancel"), onclick: closeModal }));
      } else if (st.step === "pin") {
        var lab = el("input", { value: st.label || "Device " + (new Date().getMonth() + 1) + "-" + new Date().getDate(), placeholder: "Device name, e.g. Tablet 1" });
        var dots = el("div", { class: "wh-dots" }); for (var k = 0; k < 6; k++) dots.append(el("span", { class: k < st.pin.length ? "on" : "" }));
        var pad = el("div", { class: "pad wh-pad" });
        ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].forEach(function (x) {
          if (!x) { pad.append(el("span")); return; }
          pad.append(el("button", { text: x, onclick: function () { st.label = lab.value; if (x === "⌫") st.pin = st.pin.slice(0, -1); else if (st.pin.length < 6) st.pin += x; st.err = ""; if (st.pin.length === 6) save(); else draw(); } }));
        });
        sh.append(el("p", { style: "font-weight:700;margin:0 0 6px", text: t("pinFor", { name: st.om.name }) }), dots, err, pad, el("div", { style: "height:10px" }), lab,
          el("button", { class: "btn block", style: "margin-top:10px", text: t("back"), onclick: function () { st.step = "om"; draw(); } }));
      }
    }, "lock");
  }
  async function find() {
    st.err = ""; st.step = "loading";
    try {
      var r = await rpc("device_setup_start", { p_plant: st.plant });
      if (r.notYet) { st.step = "plant"; st.err = r.branch + " still uses the plant code. HQ switches it to name and PIN in Setup first."; return draw(); }
      if (!r.ok) { st.step = "plant"; st.err = "No warehouse with that plant code"; return draw(); }
      st.branch = r.branch; st.oms = r.oms; st.step = "om"; draw();
    } catch (e) { st.step = "plant"; st.err = errText(e); draw(); }
  }
  async function save() {
    try {
      var r = await rpc("device_setup", { p_plant: st.plant, p_person: st.om.id, p_pin: st.pin, p_label: st.label });
      if (!r.ok) { st.pin = ""; st.err = "Wrong PIN, or this person can't set up devices."; return draw(); }
      store("mw-device", { key: r.key, deviceId: r.deviceId, branch: r.branch, label: st.label });
      S.wh = { key: r.key, deviceId: r.deviceId, branch: r.branch, label: st.label, tab: "today", view: "", lang: S.wh && S.wh.lang || "en" };
      S.mine.active = null; S.start = null; closeModal(); hooks.render(); window.scrollTo(0, 0);
      toast("✓ " + r.branch);
    } catch (e) { st.pin = ""; st.err = errText(e); draw(); }
  }
  if (plant) find(); else draw();
}
hooks.whSetup = openSetup;
