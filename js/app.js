/* App shell: start-up, header, tabs, Finance/owner login, sync loop. */
import { S, hooks, loadLocal, saveTokens, sync, flush, syncPill, cur, isAdmin, isOwner, anyDirty, backup } from "./state.js";
import { rpc } from "./api.js";
import { $, el, pill, msg, openModal, closeModal, errText, labelTables } from "./ui.js";
import { renderCount, withPin, loadMaster, loadBranch, roleName } from "./count.js";
import { renderMaster, loadAdmin } from "./master.js";
import { renderSetup } from "./setup.js";
import { sessRole } from "./pure.js";

function setHH() { var h = document.querySelector("header"); if (h) document.documentElement.style.setProperty("--hh", h.offsetHeight + "px"); }
window.addEventListener("resize", setHH);

function render() {
  setHH();
  var m = cur();
  $("#sub").textContent = m && m.member ? (m.branch + " · " + roleName(sessRole(m)) + " · " + m.member) : (isOwner() ? "Owner" : isAdmin() ? "Finance" : ((S.take && S.take.name) || "Stock take"));
  if (S.cfg && S.cfg.title) { $("#title").textContent = S.cfg.title; document.title = S.cfg.title; }
  drawHeader();
  if (!S.cfg) return;
  var app = $("#app"); app.innerHTML = ""; $("#foot").classList.add("hidden");
  if (S.tab === "master" && isAdmin()) renderMaster(app);
  else if (S.tab === "setup" && isAdmin()) renderSetup(app);
  else renderCount(app);
  labelTables();
}
hooks.render = render;
hooks.needPin = function (br) { withPin(br, function () { flush(); render(); }); };

function drawHeader() {
  var tabs = $("#tabs"); tabs.innerHTML = "";
  if (isAdmin()) {
    tabs.classList.remove("hidden");
    [["count", "Count"], ["master", "Master"], ["setup", "Setup"]].forEach(function (t) {
      tabs.append(el("button", { class: S.tab === t[0] ? "on" : "", text: t[1], onclick: function () { S.tab = t[0]; if (t[0] !== "count") loadAdmin().then(render, function (e) { adminErr(e); }); render(); window.scrollTo(0, 0); } }));
    });
  } else { tabs.classList.add("hidden"); S.tab = "count"; }
  var lk = $("#lockBtn");
  lk.textContent = isAdmin() ? "🔓 Lock" : "🔒 Finance";
}
function adminErr(e) {
  if (e && e.code === "AUTH") { S.admin = null; saveTokens(); S.tab = "count"; render(); msg("Signed out", "Your Finance login expired or the password was changed. Log in again."); }
  else msg("Can't load", errText(e));
}

function onLockBtn() {
  if (isAdmin()) {
    var t = S.admin.token; S.admin = null; S.adm = null; saveTokens(); S.tab = "count"; render();
    rpc("logout", { p_token: t }).catch(function () { });
    return;
  }
  openModal(function (sh) {
    var i = el("input", { type: "password", placeholder: "Finance or owner password", autocomplete: "current-password" }), err = el("div", { class: "small", style: "color:var(--bad);min-height:18px;margin-top:6px" });
    var go = el("button", { class: "btn primary", style: "flex:2", text: "Unlock", onclick: async function () {
      if (!i.value || go.disabled) return; go.disabled = true;
      try {
        var r = await rpc("admin_login", { p_password: i.value });
        if (!r.ok) { err.textContent = "Wrong password"; i.value = ""; return; }
        S.admin = { token: r.token, kind: r.kind }; saveTokens(); closeModal();
        S.tab = "master"; await loadAdmin(); await loadMaster().catch(function () { }); render();
      } catch (e) { err.textContent = errText(e); }
      finally { go.disabled = false; }
    } });
    i.addEventListener("keydown", function (e) { if (e.key === "Enter") go.click(); });
    sh.append(el("h3", { text: "🔒 Finance access" }), el("p", { class: "muted small", text: "Enter the Finance password (or the owner password) to open Master and Setup." }), i, err,
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
            S.tab = "setup"; await loadAdmin(); render();
            msg("Owner password set ✓", "Next in Setup: branches & team, branch PINs, Finance password, then upload MB52.");
          } catch (e) { err.textContent = errText(e); }
        } })));
  });
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
    if (S.saveErr && S.saveErr !== "PIN") { S.saveErr = null; flush(); }
    if (changed && S.tab === "count" && !document.querySelector("#modal.on") && !document.querySelector(".ssheet") && !document.querySelector(".scanov")) render();
    if (isAdmin() && S.tab === "master" && !document.querySelector("#modal.on")) { await loadAdmin(); render(); }
    syncPill();
  } catch (e) {
    if (e.code === "OFFLINE") pill(anyDirty() ? "Offline - kept on phone" : "Offline", "warn");
    else if (e.code === "AUTH" && isAdmin()) adminErr(e);
  } finally { syncing = false; }
}

async function init() {
  $("#lockBtn").addEventListener("click", onLockBtn);
  $("#modal").addEventListener("click", function (e) { if (e.target.id === "modal") closeModal(); });
  loadLocal();
  try { var c = localStorage.getItem("ndd2-cfg"); if (c) S.cfg = JSON.parse(c); } catch (e) { }
  if (S.cfg) render();
  var ok = await refreshCfg();
  if (!ok && !S.cfg) { fatal("Can't reach the server. Check the internet connection and reload."); return; }
  if (!ok) pill("Offline", "warn");
  try { await sync(); } catch (e) { }
  if (isAdmin()) { try { await loadAdmin(); } catch (e) { if (e.code === "AUTH") { S.admin = null; saveTokens(); } } }
  if (S.skus == null && (isAdmin() || Object.keys(S.tokens).length)) { try { await loadMaster(); } catch (e) { } }
  var m = cur(); if (m && !S.br[m.branch]) { try { await loadBranch(m.branch); } catch (e) { } }
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
