/* My Warehouse for the people of an NDD: one login page for everyone (username + 6-digit PIN; HQ uses email +
   password on the same page). Today shows only the tasks of their roles; Stock is LSH; Count is the daily count.
   Done (or 5 minutes without use) logs out; the phone remembers the last username so only the PIN is needed. */
import { S, hooks, saveTokens, flush, store, backup, cur } from "./state.js";
import { rpc } from "./api.js";
import { el, msg, toast, errText, closeModal } from "./ui.js";
import { loadMaster, loadBranch, renderCount, svg, ICON } from "./count.js";
import { renderSup } from "./sup.js";
import { t } from "./i18n.js";
import { APP_VERSION } from "./config.js";
import { renderStock, loadLsh } from "./lsh.js";

var IDLE_MS = 5 * 60 * 1000, PIN_N = 6;
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

/* signed in (or choosing a first PIN, or counting a stock take opened by a staff member) */
export function whIn() { return !!(S.wh && (S.wh.person || S.wh.joined)); }
export function whMode() { return !!(S.wh && (whIn() || S.wh.pin)) && !(S.admin && S.admin.token); }
export function has(r) { var p = S.wh && S.wh.person; return !!p && (p.roles || []).some(function (x) { return r.indexOf(x) >= 0; }); }

export function initWH() {
  S.wh = { tab: "today", view: "", lang: store("mw-lang") || "en", user: store("mw-user") || null, login: {} };
  store("mw-device", null);   /* the device set-up of 2.18.0 is retired */
  var s = store("mw-sess");
  if (s && s.token && s.branch && s.person && Date.now() - (s.at || 0) < IDLE_MS) {
    S.wh.person = s.person; S.wh.token = s.token; S.wh.branch = s.branch; S.wh.lang = s.person.lang || S.wh.lang; S.wh.lastAct = s.at; S.wh.tab = s.tab || "today";
    S.tokens[s.branch] = s.token; if (has(["sup", "om"])) S.sup = { token: s.token, branch: s.branch, wh: true };
  } else if (s) { store("mw-sess", null); if (s.branch && S.tokens[s.branch] === s.token) { delete S.tokens[s.branch]; saveTokens(); } }
  ["pointerdown", "keydown"].forEach(function (ev) { document.addEventListener(ev, touchAct, true); });
  setInterval(function () { if (S.wh && S.wh.person && Date.now() - (S.wh.lastAct || 0) > IDLE_MS) signOut("idle"); }, 15000);
}
function touchAct() { if (!S.wh || !S.wh.person) return; S.wh.lastAct = Date.now(); saveSess(); }
function saveSess() { if (S.wh.person) store("mw-sess", { token: S.wh.token, person: S.wh.person, branch: S.wh.branch, at: S.wh.lastAct || Date.now(), tab: S.wh.tab }); else store("mw-sess", null); }

/* end the person's session without drawing (used by sign-out and by opening a stock take for helpers) */
async function endPerson() {
  var w = S.wh, tok = w.token;
  try { await flush(); } catch (e) { }
  if (S.tokens[w.branch] === tok) { delete S.tokens[w.branch]; saveTokens(); }
  if (S.sup && S.sup.wh) S.sup = null;
  S.mine.active = null; S.start = null; S.step = ""; backup();
  w.person = null; w.token = null; w.lsh = null; w.me = null; w.tab = "today"; w.view = ""; w.pin = null; saveSess();
  if (tok) rpc("logout", { p_token: tok }).catch(function () { });
}
export async function signOut(why) {
  var w = S.wh; if (!w) return;
  if (w.joined) {
    var jt = w.joinTok; w.joined = false; w.joinTok = null;
    try { await flush(); } catch (e) { }
    if (S.tokens[w.branch] === jt) { delete S.tokens[w.branch]; saveTokens(); }
    S.mine.active = null; S.start = { step: "code" }; S.step = ""; backup();
    if (jt) rpc("logout", { p_token: jt }).catch(function () { });
    hooks.render(); return;
  }
  if (!w.person && !w.pin) return;
  if (w.pin && w.pin.token) rpc("logout", { p_token: w.pin.token }).catch(function () { });
  await endPerson();
  S.start = { step: "code" }; S.plantPad = false; w.login = {};
  closeModal(); document.body.classList.remove("noscroll");
  var x = document.getElementById("skuv"); if (x) x.remove();
  hooks.render(); window.scrollTo(0, 0);
  if (why === "idle") toast(t("signedOutIdle"));
}

function hhmm(ts) { return ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : ""; }
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
  return w.branch || "";
}
export function whGo(tab) { S.wh.tab = tab; S.wh.view = ""; S.wh.lsh = null; saveSess(); if (tab === "count") prepCount(); hooks.render(); window.scrollTo(0, 0); }
hooks.whHome = function () { whGo("today"); };
hooks.whSignOut = function () { signOut(); };

/* ---------- render ---------- */
export function renderWH(app) {
  var w = S.wh;
  if (w.joined) { renderCount(app); return; }
  if (!w.person) { if (w.pin) renderPin(app); return; }
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

/* ---------- the first page: log in ---------- */
function langBtn() {
  var w = S.wh;
  return el("button", { class: "btn", style: "min-height:36px;padding:4px 12px", text: t("language"), onclick: function () { w.lang = w.lang === "ms" ? "en" : "ms"; w.langPicked = true; store("mw-lang", w.lang); hooks.render(); } });
}
export function renderLogin(app) {
  var w = S.wh, L = w.login || (w.login = {}), u = w.user;
  var wrap = el("div", { class: "cstart wh-login" });
  wrap.append(el("div", { class: "row", style: "justify-content:space-between;align-items:center;gap:8px" }, el("h2", { style: "margin:0", text: t("login") }), langBtn()));
  var card = el("div", { class: "card" });
  var err = el("div", { class: "wh-pinerr", role: "alert", text: L.err || "" });
  if (u && !L.other) {
    /* this phone remembers the last person: only the PIN */
    card.append(el("div", { class: "wh-pinbox", style: "padding:4px 0" },
      el("span", { class: "wh-av big", text: initials(u.name) }), el("h2", { style: "margin:6px 0 2px", text: t("hi", { name: u.name }) }),
      el("div", { class: "small muted", text: u.username + " · " + t("enterPin") })));
    var v = L.pin || "", dots = el("div", { class: "wh-dots", "aria-label": v.length + " of " + PIN_N });
    for (var i = 0; i < PIN_N; i++) dots.append(el("span", { class: i < v.length ? "on" : "" }));
    var pad = el("div", { class: "pad wh-pad" });
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].forEach(function (k) {
      if (!k) { pad.append(el("span")); return; }
      pad.append(el("button", { text: k, "aria-label": k === "⌫" ? "Delete" : k, disabled: L.busy, onclick: function () {
        var x = L.pin || ""; if (k === "⌫") x = x.slice(0, -1); else if (x.length < PIN_N) x += k;
        L.pin = x; L.err = ""; hooks.render();
        if (x.length === PIN_N) doLogin(u.username, x);
      } }));
    });
    card.append(dots, err, pad, el("p", { class: "center", style: "margin:14px 0 0" },
      el("button", { class: "link strong", text: t("otherUser", { name: u.name.split(" ")[0] }), onclick: function () { L.other = true; L.pin = ""; L.err = ""; L.u = ""; hooks.render(); } })),
      el("p", { class: "small muted center", style: "margin:8px 0 0", text: t("forgotPin") }));
  } else {
    card.append(el("p", { class: "small muted", style: "margin-top:0", text: t("loginSub") }));
    var ui = el("input", { value: L.u || "", placeholder: t("username"), autocomplete: "username", autocapitalize: "none", autocorrect: "off", spellcheck: "false", "aria-label": t("username") });
    var hq = (L.u || "").indexOf("@") >= 0;
    var pw = el("input", { type: "password", value: L.pw || "", placeholder: hq ? t("password") : t("pinOrPw"), autocomplete: "current-password", inputmode: hq ? "text" : "numeric", "aria-label": t("password") });
    ui.addEventListener("input", function () {
      L.u = ui.value; var h = ui.value.indexOf("@") >= 0;
      pw.setAttribute("inputmode", h ? "text" : "numeric"); pw.placeholder = h ? t("password") : t("pinOrPw");
    });
    pw.addEventListener("input", function () { L.pw = pw.value; });
    function go() { L.u = ui.value.trim(); L.pw = pw.value; if (!L.u || !L.pw) { L.err = t("wrongLogin"); hooks.render(); return; } doLogin(L.u, L.pw); }
    [ui, pw].forEach(function (x) { x.addEventListener("keydown", function (e) { if (e.key === "Enter") { if (x === ui) pw.focus(); else go(); } }); });
    card.append(ui, el("div", { style: "height:8px" }), pw, err,
      el("button", { class: "btn primary block big1", style: "margin-top:10px", text: L.busy ? "…" : t("login"), disabled: L.busy, onclick: go }),
      el("p", { class: "small muted center", style: "margin:10px 0 0", text: t("noUser") }));
    if (u) card.append(el("p", { class: "center", style: "margin:8px 0 0" }, el("button", { class: "link", text: t("back"), onclick: function () { L.other = false; L.err = ""; hooks.render(); } })));
    setTimeout(function () { if (document.activeElement === document.body) (L.u ? pw : ui).focus(); }, 60);
  }
  wrap.append(card,
    el("p", { class: "center", style: "margin-top:16px" }, el("button", { class: "link strong", text: t("usePlant"), onclick: function () { S.plantPad = true; store("mw-plant", 1); hooks.render(); window.scrollTo(0, 0); } })),
    el("p", { class: "center small muted", style: "margin-top:18px", text: "Version " + APP_VERSION }));
  app.append(wrap);
}
hooks.renderLogin = renderLogin;

async function doLogin(user, pass) {
  var w = S.wh, L = w.login;
  L.busy = true; L.err = ""; hooks.render();
  try {
    if (user.indexOf("@") >= 0) {
      var h = await hooks.hqSignIn(user, pass);
      L.busy = false; L.pin = "";
      if (!h.ok) { L.err = h.err; L.pw = ""; hooks.render(); return; }
      w.login = {}; return;
    }
    var r = await rpc("user_login", { p_user: user, p_pin: pass });
    L.busy = false; L.pin = ""; L.pw = "";
    if (!r.ok) {
      L.err = r.plant ? t("plantStill", { b: r.branch }) : r.lockedUntil ? t("locked", { t: hhmm(r.lockedUntil) }) : r.left != null ? t("wrongPin", { n: r.left }) : t("wrongLogin");
      hooks.render(); return;
    }
    w.branch = r.branch;
    if (r.mustChange) { w.pin = { step: "new", person: r.person, token: r.token, res: r, v: "" }; w.login = {}; hooks.render(); window.scrollTo(0, 0); return; }
    w.login = {}; startSession(r);
  } catch (e) { L.busy = false; L.pin = ""; L.err = e.code === "OFFLINE" ? t("offline") : errText(e); hooks.render(); }
}

/* ---------- first sign-in: choose your own PIN ---------- */
function renderPin(app) {
  var w = S.wh, st = w.pin, p = st.person;
  app.append(backRow(function () { signOut(); }, ""));
  var box = el("div", { class: "wh-pinbox" },
    el("span", { class: "wh-av big", text: initials(p.name) }), el("h2", { style: "margin:6px 0 2px", text: st.step === "again" ? t("repeatPin") : t("setPin") }),
    el("div", { class: "small muted", text: p.name + " · " + t("setPinSub", { n: PIN_N }) }));
  var dots = el("div", { class: "wh-dots", "aria-label": st.v.length + " of " + PIN_N });
  for (var i = 0; i < PIN_N; i++) dots.append(el("span", { class: i < st.v.length ? "on" : "" }));
  box.append(dots, el("div", { class: "wh-pinerr", role: "alert", text: st.err || "" }));
  var pad = el("div", { class: "pad wh-pad" });
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].forEach(function (k) {
    if (!k) { pad.append(el("span")); return; }
    pad.append(el("button", { text: k, "aria-label": k === "⌫" ? "Delete" : k, disabled: st.busy, onclick: function () {
      if (k === "⌫") st.v = st.v.slice(0, -1); else if (st.v.length < PIN_N) st.v += k;
      st.err = ""; hooks.render();
      if (st.v.length === PIN_N) submitPin();
    } }));
  });
  box.append(pad);
  app.append(box);
}
async function submitPin() {
  var st = S.wh.pin;
  if (st.step === "new") { st.first = st.v; st.v = ""; st.step = "again"; hooks.render(); return; }
  if (st.v !== st.first) { st.v = ""; st.first = ""; st.step = "new"; st.err = t("pinsDiffer"); hooks.render(); return; }
  try { st.busy = true; hooks.render(); await rpc("person_set_pin", { p_token: st.token, p_pin: st.v }); st.busy = false; startSession(st.res); }
  catch (e) { st.busy = false; st.v = ""; st.first = ""; st.step = "new"; st.err = e.code === "OFFLINE" ? t("offline") : errText(e); hooks.render(); }
}
async function startSession(r) {
  var w = S.wh;
  if (w.langPicked && w.lang !== r.person.lang) { r.person.lang = w.lang; rpc("person_set_lang", { p_token: r.token, p_lang: w.lang }).catch(function () { }); }
  w.langPicked = false;
  w.pin = null; w.person = r.person; w.token = r.token; w.branch = r.branch; w.lang = r.person.lang || w.lang; w.lastAct = Date.now(); w.tab = "today"; w.view = ""; w.lsh = null; w.me = null;
  w.user = { username: r.person.username, name: r.person.name }; store("mw-user", w.user); store("mw-lang", w.lang);
  S.tokens[w.branch] = r.token; saveTokens();
  if (has(["sup", "om"])) S.sup = { token: r.token, branch: w.branch, wh: true };
  S.start = null; S.plantPad = false; store("mw-plant", null);
  saveSess(); hooks.render(); window.scrollTo(0, 0);
  loadMaster().catch(function () { });
  loadBranch(w.branch).then(hooks.render, function () { });
  if (has(["lo", "om"])) loadLsh().then(hooks.render, function () { });
  if (S.mine && Object.keys(S.mine.sessions).some(function (k) { return S.mine.sessions[k].dirty; })) flush();
}

/* ---------- monthly stock take: a staff member opens counting on this phone for the helpers ---------- */
async function loadMe() {
  var w = S.wh;
  try { w.me = await rpc("wh_me", { p_token: w.token }); }
  catch (e) { w.me = { error: true }; if (e.code === "AUTH") { signOut(); return; } }
  hooks.render();
}
async function joinTake() {
  var w = S.wh;
  try {
    var r = await rpc("person_join_take", { p_token: w.token });
    await endPerson();
    w.joined = true; w.joinTok = r.token; w.branch = r.branch; S.tokens[r.branch] = r.token; saveTokens();
    S.take = r.take; S.start = { step: "confirm", branch: r.branch }; S.mine.active = null;
    await loadMaster().catch(function () { }); await loadBranch(r.branch).catch(function () { });
    hooks.render(); window.scrollTo(0, 0);
  } catch (e) { msg(t("joinTake"), errText(e)); w.me = null; hooks.render(); }
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
  if (has(["admin", "sup", "om"]) && !w.me && !w.meLoading) { w.meLoading = true; loadMe().finally(function () { w.meLoading = false; }); }
  if (w.me && w.me.stockTake && has(["admin", "sup", "om"])) cards.push(task("var(--infobg)", "var(--info)", WH_ICON.count, t("joinTake"), "", w.me.stockTake.name + " · " + t("joinTakeSub"), joinTake, "info"));
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

