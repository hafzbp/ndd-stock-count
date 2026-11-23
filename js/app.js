/* App shell: start-up, header, tabs, admin/owner login, sync loop, in-app browser screen. */
import { S, hooks, loadLocal, saveTokens, sync, flush, syncPill, cur, isAdmin, isOwner, anyDirty, backup, tabGuard } from "./state.js";
import { rpc } from "./api.js";
import { $, el, pill, msg, openModal, closeModal, errText, labelTables, confirmBox, toast } from "./ui.js";
import { renderCount, withPin, loadMaster, loadBranch, roleName, kindShort } from "./count.js";
import { renderMaster, loadAdmin } from "./master.js";
import { renderSetup } from "./setup.js";
import { renderHome } from "./home.js";
import { renderDaily, renderDash } from "./daily.js";
import { renderSup, supLogin, supLogout, loadSupTok } from "./sup.js";
import { renderToday } from "./today.js";
import { svg, ICON } from "./count.js";
import { sessRole } from "./pure.js";

function setHH() { var h = document.querySelector("header"); if (h) document.documentElement.style.setProperty("--hh", h.offsetHeight + "px"); }
window.addEventListener("resize", setHH);

function render() {
  setHH();
  var m = cur();
  $("#sub").textContent = m && m.member ? (kindShort() + " · " + m.branch + " · " + (S.take && S.take.mode === "single" ? "" : roleName(sessRole(m)) + " · ") + m.member) : (isOwner() ? "Owner" : isAdmin() ? "Admin" : supMode() ? "Supervisor · " + S.sup.branch : ((S.take && S.take.name) || "Stock take"));
  if (S.cfg && S.cfg.title) { $("#title").textContent = S.cfg.title; document.title = S.cfg.title; }
  drawHeader();
  if (!S.cfg) return;
  var app = $("#app"); app.innerHTML = ""; $("#foot").classList.add("hidden");
  if (inAppGate(app)) return;
  document.body.classList.toggle("adminui", isAdmin() && S.tab !== "count");
  if (S.tab === "today" && isAdmin()) renderToday(app);
  else if (S.tab === "daily" && isAdmin()) renderDaily(app);
  else if (S.tab === "dash" && isAdmin()) renderDash(app);
  else if (S.tab === "sup" && supMode()) renderSup(app);
  else if (S.tab === "home" && isAdmin()) renderHome(app);
  else if (S.tab === "master" && isAdmin()) renderMaster(app);
  else if (S.tab === "setup" && isAdmin()) renderSetup(app);
  else renderCount(app);
  labelTables();
}
hooks.render = render;
hooks.openLogin = function (first) { if (first) bootstrap(); else onLockBtn(); };
hooks.needPin = function (br) { withPin(br, function () { flush(); render(); }); };
hooks.openSup = supLogin;
function supMode() { return !isAdmin() && !!S.sup; }

function drawHeader() {
  var tabs = $("#tabs"); tabs.innerHTML = "";
  if (isAdmin()) {
    tabs.classList.remove("hidden");
    var IC = { today: ICON.home, daily: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>', home: '<path d="M4 7l8-4 8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4M4 17l8 4 8-4"/>',
      master: '<path d="M4 6h16M4 12h16M4 18h10"/>', dash: '<path d="M4 19h16M7 16V9M12 16V5M17 16v-4"/>', setup: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>', count: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1h11"/>' };
    [["today", "Today"], ["daily", "Daily"], ["home", "Monthly"], ["master", "Master"], ["dash", "Dashboard"], ["setup", "Settings"], ["count", "Count"]].forEach(function (t) {
      tabs.append(el("button", { class: S.tab === t[0] ? "on" : "", "aria-current": S.tab === t[0] ? "page" : null, onclick: function () {
        S.tab = t[0]; if (t[0] === "home" || t[0] === "daily") S.viewTake = null; if (t[0] === "daily") S.dcc = null; if (t[0] === "dash") S.dashData = null; if (t[0] === "today") S.todayAt = null;
        if (t[0] !== "count") loadAdmin().then(render, function (e) { adminErr(e); }); render(); window.scrollTo(0, 0); } }, svg(IC[t[0]], 18), t[1]));
    });
  } else if (supMode()) {
    tabs.classList.remove("hidden");
    [["sup", "My warehouse"], ["count", "Count"]].forEach(function (t) {
      tabs.append(el("button", { class: S.tab === t[0] ? "on" : "", text: t[1], onclick: function () { S.tab = t[0]; if (t[0] === "sup") S.supDay = null; render(); window.scrollTo(0, 0); } }));
    });
    if (S.tab !== "sup" && S.tab !== "count") S.tab = "sup";
  } else { tabs.classList.add("hidden"); S.tab = "count"; }
  var lk = $("#lockBtn"), cm = counterMode() && !supMode();
  $("#dashBtn").style.display = cm || isAdmin() ? "none" : "";
  if (supMode()) { lk.replaceChildren("Log out"); lk.title = "Log out of the supervisor view"; }
  else if (cm) { lk.replaceChildren("Log out"); lk.title = "Log out of " + cur().branch + " (your counts stay saved)"; }
  else { lk.replaceChildren(svg(isAdmin() ? '<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 17l5-5-5-5M15 12H4"/>' : '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>', 16), el("span", { class: "lbl", text: isAdmin() ? " Log out" : " Admin" })); lk.title = isAdmin() ? "Log out" : "Admin login"; }
}
/* a counter is inside a count on this phone: header shows only Log out */
/* also without a plant-code login (e.g. a count opened while logged in as admin): there must always be a way out */
function counterMode() { return !isAdmin() && !!cur(); }

async function counterLogout(done) {
  var m = cur(), br = m.branch;
  async function go() {
    clearTimeout(S.timer); if (S.tokens[br]) { try { await flush(); } catch (e) { } }   /* no login: unsent changes wait on the phone */
    S.saveErr = null;
    /* stock take closed: counts are on the server, so the phone forgets them (unsent changes stay) */
    if (S.take && S.take.status === "closed") Object.keys(S.mine.sessions).forEach(function (k) { var x = S.mine.sessions[k]; if (x.branch === br && !x.dirty) delete S.mine.sessions[k]; });
    var waiting = Object.keys(S.mine.sessions).filter(function (k) { var x = S.mine.sessions[k]; return x.branch === br && x.dirty; }).length;
    var t = S.tokens[br]; delete S.tokens[br]; saveTokens();
    S.mine.active = null; S.start = { step: "code" }; S.step = ""; backup(); render(); window.scrollTo(0, 0);
    if (t) rpc("logout", { p_token: t }).catch(function () { });
    if (waiting) msg("Logged out", "Some changes have not uploaded yet (no signal). They are kept on this phone and upload as soon as you log in again with the plant code. Don't clear the browser data on this phone.");
    else toast(done ? "Done. Thank you!" : "Logged out. Your counts are saved.");
  }
  if (done) go();
  else confirmBox("Log out of " + br + "?", "Your counts stay saved. To continue later, open the app and log in again with the plant code - you carry on where you stopped.", "Log out", go);
}
hooks.counterLogout = counterLogout;
function adminErr(e) {
  if (e && e.code === "AUTH") { S.admin = null; saveTokens(); S.tab = "count"; render(); msg("Signed out", "Your admin login expired or the password was changed. Log in again."); }
  else msg("Can't load", errText(e));
}

function onLockBtn() {
  if (supMode()) { supLogout(); return; }
  if (counterMode()) { counterLogout(); return; }
  if (isAdmin()) {
    var t = S.admin.token; S.admin = null; S.adm = null; S.viewTake = null; S.wiz = null; S.wizNew = false; saveTokens(); S.tab = "count";
    /* a count opened under the admin login has no plant-code login on this phone: leave it (it stays under "Continue a count") */
    var m = cur(); if (m && !S.tokens[m.branch]) { S.mine.active = null; S.start = { step: "code" }; S.step = ""; backup(); }
    render(); window.scrollTo(0, 0);
    rpc("logout", { p_token: t }).catch(function () { });
    return;
  }
  openModal(function (sh) {
    var i = el("input", { type: "password", placeholder: "Admin or owner password", autocomplete: "current-password" }), err = el("div", { class: "small", style: "color:var(--bad);min-height:18px;margin-top:6px" });
    var go = el("button", { class: "btn primary", style: "flex:2", text: "Unlock", onclick: async function () {
      if (!i.value || go.disabled) return; go.disabled = true;
      try {
        var r = await rpc("admin_login", { p_password: i.value });
        if (!r.ok) { err.textContent = "Wrong password"; i.value = ""; return; }
        S.admin = { token: r.token, kind: r.kind }; saveTokens(); closeModal();
        S.dcc = null; S.viewTake = null; await loadAdmin(); await loadMaster().catch(function () { });
        S.tab = S.adm && S.adm.takeInfo && S.adm.takeInfo.status === "open" ? "home" : "today"; S.todayT = null; render();
      } catch (e) { err.textContent = errText(e); }
      finally { go.disabled = false; }
    } });
    i.addEventListener("keydown", function (e) { if (e.key === "Enter") go.click(); });
    sh.append(el("h3", { text: "Admin login" }), el("p", { class: "muted small", text: "Enter the admin password (or the owner password) to set up and run stock takes." }), i, err,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }), go),
      S.cfg && !S.cfg.ownerReady ? el("button", { class: "link", style: "margin-top:10px", text: "First time? Set the owner password with the setup code", onclick: bootstrap }) : null);
    setTimeout(function () { i.focus(); }, 100);
  });
}
function bootstrap() {
  openModal(function (sh) {
    var c = el("input", { type: "text", placeholder: "Setup code", autocomplete: "off" }), p1 = el("input", { type: "password", placeholder: "New owner password (8+ characters)", autocomplete: "new-password" }), p2 = el("input", { type: "password", placeholder: "Repeat password", autocomplete: "new-password" });
    var err = el("div", { class: "small", style: "color:var(--bad);min-height:18px;margin-top:6px" });
    sh.append(el("h3", { text: "Set owner password" }), el("p", { class: "muted small", text: "One time only. The setup code works once." }), c, el("div", { style: "height:8px" }), p1, el("div", { style: "height:8px" }), p2, err,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", style: "flex:2", text: "Save", onclick: async function () {
          if (p1.value.length < 8) { err.textContent = "Use at least 8 characters"; return; }
          if (p1.value !== p2.value) { err.textContent = "Passwords don't match"; return; }
          try {
            var r = await rpc("owner_bootstrap", { p_code: c.value.trim(), p_password: p1.value });
            if (!r.ok) { err.textContent = "Wrong or used setup code"; return; }
            S.admin = { token: r.token, kind: r.kind }; saveTokens(); S.cfg.ownerReady = true; closeModal();
            S.tab = "home"; await loadAdmin(); render();
            msg("Owner password set ✓", "Next: set up the first stock take - name and type, pick SKUs if partial, upload the MB52, then open counting.");
          } catch (e) { err.textContent = errText(e); }
        } })));
  });
}

/* Opened inside WhatsApp / Instagram / Facebook: the camera often doesn't work there. */
function inApp() { return /WhatsApp|Instagram|FBAN|FBAV|FB_IAB|Line\/|TikTok|; wv\)/i.test(navigator.userAgent); }
function inAppGate(app) {
  if (!inApp() || sessionStorage.getItem("ndd2-inapp-ok")) return false;
  var android = /Android/i.test(navigator.userAgent), url = location.href;
  var intent = "intent://" + url.replace(/^https?:\/\//, "") + "#Intent;scheme=https;package=com.android.chrome;end";
  app.append(el("div", { class: "card gate" },
    el("div", { class: "big-ico", text: "🌐" }),
    el("h2", { text: "Open in " + (android ? "Chrome" : "Safari") + " first" }),
    el("p", { class: "muted", text: "This page is open inside another app (like WhatsApp). The camera for scanning usually doesn't work here." }),
    android ? el("a", { class: "btn primary block", href: intent, style: "text-decoration:none;display:block;text-align:center" }, "Open in Chrome")
      : el("p", { style: "font-weight:600", text: "Tap ··· or the share icon, then “Open in Safari”." }),
    el("button", { class: "btn block", style: "margin-top:8px", text: "Copy link", onclick: function () { (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { msg("Link copied", "Paste it into Chrome or Safari."); }, function () { msg("Copy this link", url); }); } }),
    el("button", { class: "link", style: "margin-top:10px", text: "Continue here anyway", onclick: function () { sessionStorage.setItem("ndd2-inapp-ok", "1"); render(); } })));
  return true;
}

async function refreshCfg() {
  try { S.cfg = await rpc("public_config", {}); if (S.cfg.take) S.take = Object.assign({}, S.take || {}, S.cfg.take); localStorage.setItem("ndd2-cfg", JSON.stringify(S.cfg)); return true; }
  catch (e) { return false; }
}

var syncing = false;
async function tick() {
  if (syncing || document.hidden) return; syncing = true;
  try {
    await refreshCfg();
    var changed = await sync();
    /* the daily list can grow during the day (supervisor adds SKUs): keep the counter's list current */
    var cm0 = cur(); if (cm0 && S.tab === "count" && S.tokens[cm0.branch]) { var before = JSON.stringify((S.br[cm0.branch] || {}).codes || []); try { await loadBranch(cm0.branch); if (JSON.stringify((S.br[cm0.branch] || {}).codes || []) !== before) changed = true; } catch (e) { } }
    if (S.saveErr && S.saveErr !== "PIN") { S.saveErr = null; flush(); }
    if (S.goneNote) { S.goneNote = false; closeModal(); var sv = document.getElementById("skuv"); if (sv) { sv.remove(); document.body.classList.remove("noscroll"); } S.openSku = null; render(); msg("Count removed by HQ", "HQ deleted this count or stopped today's count. Enter the plant code to see what to do next."); }
    if (changed && S.tab === "count" && !document.querySelector("#modal.on") && !document.querySelector(".ssheet") && !document.querySelector(".scanov") && !document.querySelector("#skuv")) render();
    if (isAdmin() && (S.tab === "master" || (S.tab === "home" && S.adm && S.adm.takeInfo && S.adm.takeInfo.status === "open")) && !document.querySelector("#modal.on")) { await loadAdmin(); render(); }
    if (isAdmin() && S.tab === "daily" && S.dcc && S.dcc.date === S.dcc.today && !document.querySelector("#modal.on") && !document.activeElement.matches("input,select")) { S.dcc = null; render(); }
    syncPill();
  } catch (e) {
    if (e.code === "OFFLINE") pill(anyDirty() ? "Offline - kept on phone" : "Offline", "warn");
    else if (e.code === "AUTH" && isAdmin()) adminErr(e);
  } finally { syncing = false; }
}

async function init() {
  $("#lockBtn").addEventListener("click", onLockBtn);
  if (/[?&]api=/.test(location.search)) $("#dashBtn").href = "dashboard/" + location.search;
  $("#modal").addEventListener("click", function (e) { if (e.target.id === "modal" && !e.target.classList.contains("lock")) closeModal(); });
  loadLocal(); loadSupTok();
  tabGuard(function () {
    closeModal();
    openModal(function (sh) {
      sh.append(el("h3", { text: "Open in another tab" }),
        el("p", { class: "muted", text: "The app was opened again in another tab or window on this phone. Count in ONE tab only, otherwise counts overwrite each other. This tab has stopped saving - your counts so far are safe." }),
        el("button", { class: "btn primary block", text: "Use this tab instead", onclick: function () { location.reload(); } }));
    }, "lock");
  });
  try { var c = localStorage.getItem("ndd2-cfg"); if (c) S.cfg = JSON.parse(c); } catch (e) { }
  if (S.cfg) render();
  var ok = await refreshCfg();
  if (!ok && !S.cfg) { fatal("Can't reach the server. Check the internet connection and reload."); return; }
  if (!ok) pill("Offline", "warn");
  try { await sync(); } catch (e) { }
  if (isAdmin()) { try { await loadAdmin(); } catch (e) { if (e.code === "AUTH") { S.admin = null; saveTokens(); } } }
  if (S.skus == null && (isAdmin() || Object.keys(S.tokens).length)) { try { await loadMaster(); } catch (e) { } }
  var m = cur(); if (m) { try { await loadBranch(m.branch); } catch (e) { } }
  if (supMode() && S.tab === "count" && !cur()) S.tab = "sup";
  render(); syncPill();
  if (anyDirty()) flush();
  setInterval(tick, 20000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });
  window.addEventListener("online", function () { S.saveErr = null; flush(); tick(); });
}
window.addEventListener("beforeunload", function (e) { if (anyDirty() || S.saving) { backup(); e.preventDefault(); e.returnValue = ""; } });
function fatal(m) { $("#sub").textContent = ""; $("#app").innerHTML = ""; $("#app").append(el("div", { class: "card center" }, el("p", { text: m }), el("button", { class: "btn", text: "Reload", onclick: function () { location.reload(); } }))); pill("Offline", "bad"); }

new MutationObserver(function () { clearTimeout(window.__lt); window.__lt = setTimeout(labelTables, 30); }).observe(document.documentElement, { childList: true, subtree: true });
init().catch(function (e) { console.error(e); fatal("Something went wrong. Reload the page."); });
