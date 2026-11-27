/* Counter screens: pick role/branch/names, count by SKU and batch, submit with signatures and photos. */
import { S, hooks, cur, touch, flush, schedule, tokenFor, saveTokens, backup, fromServer, isAdmin, isOwner, sessHasQty, store } from "./state.js";
import { rpc } from "./api.js";
import { $, el, fmt, MON, bLabel, nowIso, tsTxt, openModal, closeModal, msg, confirmBox, numPad, sigPad, toast, errText } from "./ui.js";
import { toPcs, hasQty, lk, monthOf, sessRole } from "./pure.js";
import { openScanner, openScanSheet } from "./scan.js";
import { photoBlock } from "./photos.js";
import { APP_VERSION } from "./config.js";

export var REMARKS = ["Damaged", "Expired", "Near expiry", "Wrong location"];
function singleMode() { return !!(S.take && S.take.mode === "single"); }
export function roleName(r) { return singleMode() ? "Count" : r === "fin" ? "Finance check" : "Ops count"; }

/* Daily cycle count vs monthly stock take: one big coloured label so the counter always knows which one this is. */
var WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayTxt(d) { if (!d) return ""; var x = new Date(d + "T00:00:00"); return isNaN(x) ? d : WD[x.getDay()] + " " + x.getDate() + " " + MN[x.getMonth()]; }
export function kindShort() { return S.take && S.take.kind === "daily" ? "Daily count" : S.take && S.take.stockType === "bad" ? "Bad stock take" : "Monthly stock take"; }
export function kindLabel(n) {
  var t = S.take || {};
  if (t.kind === "daily") {
    var parts = [dayTxt(t.countDate), (n == null ? t.skuCount : n) + " SKU" + ((n == null ? t.skuCount : n) === 1 ? "" : "s")];
    if (t.countTo) parts.push("finish by " + t.countTo);
    return el("div", { class: "kind kind-daily" }, el("b", { text: "DAILY CYCLE COUNT" }), el("span", { text: parts.join(" · ") }));
  }
  var bad = t.stockType === "bad", sub = [t.name || "Stock take", singleMode() ? "single count" : "Ops + Finance count separately"];
  if (bad) sub.splice(1, 0, "only stock in the bad-stock locations BS00, BS01, SH00");
  if (t.scope === "partial") sub.push(n == null ? "only the SKUs on your list" : "only " + n + " SKU" + (n === 1 ? "" : "s") + " on your list");
  return el("div", { class: "kind " + (bad ? "kind-bad" : "kind-monthly") }, el("b", { text: bad ? "MONTHLY STOCK TAKE · BAD STOCK" : "MONTHLY STOCK TAKE" }), el("span", { text: sub.join(" · ") }));
}
function roleOf(t) { return t.role || "Checker"; }

/* ---------- plant code (branch login) ---------- */
/* Pad for the SAP plant code. onOk(branch, take) after a successful login. wantBranch: only accept that branch. */
export function plantPad(title, sub, wantBranch, onOk, inline) {
  var v = "", d = el("div", { class: "codebox", "aria-live": "polite" }), err = el("div", { class: "small", style: "color:var(--bad);min-height:20px;margin-top:6px;font-weight:600" });
  function draw() {
    d.innerHTML = ""; var n = Math.max(4, v.length);
    for (var i = 0; i < n; i++) d.append(el("span", { class: i === v.length ? "now" : v[i] ? "set" : "", text: v[i] || "" }));
    d.setAttribute("aria-label", v ? "Plant code " + v.split("").join(" ") : "No plant code yet");
  } draw();
  var go = el("button", { class: "btn primary big1", style: "flex:2", text: "Next", onclick: function () { login(); } });
  async function login(code) {
    if (code) { v = code; draw(); }
    if (!v || go.disabled) return; go.disabled = true; go.textContent = "Checking…";
    try {
      var r = await rpc("plant_login", { p_code: v });
      if (!r.ok && r.people) { var l0 = store("ndd2-last"); if (l0 && l0.code === v) store("ndd2-last", null); store("mw-plant", null); v = ""; draw(); err.textContent = r.branch + " now logs in with a username and PIN."; err.append(el("br"), el("button", { class: "link strong", text: "Go to log in", onclick: function () { closeModal(); S.plantPad = false; S.start = { step: "code" }; hooks.render(); window.scrollTo(0, 0); } })); return; }
      if (!r.ok) { v = ""; draw(); err.textContent = "No warehouse with that plant code"; return; }
      if (wantBranch && r.branch !== wantBranch) { v = ""; draw(); err.textContent = "That code is for " + r.branch + ", not " + wantBranch; return; }
      S.tokens[r.branch] = r.token; saveTokens(); S.saveErr = null; S.lastLogin = { code: v, branch: r.branch }; S.waitBy = S.waitBy || {}; S.waitBy[r.branch] = r.wait || null;
      if (r.take) S.take = Object.assign({}, S.take || {}, r.take);
      if (!inline) closeModal();
      await loadMaster().catch(function () { });
      onOk(r.branch, r.take);
      flush();
    } catch (e) { err.textContent = errText(e); }
    finally { go.disabled = false; go.textContent = "Next"; }
  }
  var pad = el("div", { class: "pad" }); "1 2 3 4 5 6 7 8 9 C 0 ⌫".split(" ").forEach(function (k) { pad.append(el("button", { text: k, "aria-label": k === "⌫" ? "delete" : k === "C" ? "clear" : k, onclick: function () { if (k === "C") v = ""; else if (k === "⌫") v = v.slice(0, -1); else if (v.length < 8) v += k; err.textContent = ""; draw(); } })); });
  var box = el("div", { class: "plantpad" }, el(inline ? "h2" : "h3", { text: title }), el("p", { class: "muted", style: "margin:0 0 14px", text: sub }), d, err, pad,
    el("div", { class: "row", style: "margin-top:12px" }, inline ? null : el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }), go));
  box.login = login;
  if (inline) return box;
  openModal(function (sh) { sh.append(box); });
}
/* Re-open access to a branch (token missing or expired) with its plant code. */
export function withPin(br, fn) {
  if (tokenFor(br)) return fn();
  plantPad("🔒 " + br, "Enter the plant code of " + br + " again.", br, function () { fn(); });
}

export async function loadMaster() {
  var tok = isAdmin() ? S.admin.token : Object.keys(S.tokens).map(function (b) { return S.tokens[b]; })[0];
  if (!tok) return;
  try {
    var r = await rpc("counter_master", { p_token: tok });
    S.skus = r.skus; S.barcodes = r.barcodes || {}; S.team = r.team || [];
    store("ndd2-master", { skus: S.skus, barcodes: S.barcodes, team: S.team, at: nowIso() });
  } catch (e) { if (!S.skus) throw e; }
}
export async function loadBranch(br) {
  var tok = tokenFor(br); if (!tok) return;
  try {
    var r = await rpc("counter_branch", { p_token: tok, p_branch: br });
    S.br[br] = r; S.recount[br] = r.recount || []; S.waitBy = S.waitBy || {}; S.waitBy[br] = r.wait || null;
    store("ndd2-br", S.br);
  } catch (e) {
    if (e.code === "AUTH") { delete S.tokens[br]; saveTokens(); }
    if (!S.br[br]) S.br[br] = null;
    throw e;
  }
}

function branches() { return ((S.cfg && S.cfg.branches) || []).slice(); }
function team() { return S.team || []; }
function tstatus() { return (S.take && S.take.status) || "open"; }
function closed() { return tstatus() !== "open"; }
function rcMap() { var o = {}; ((cur() && S.recount[cur().branch]) || []).forEach(function (k) { o[k] = 1; }); return o; }
function rcSku(code) { var r = rcMap(); return Object.keys(r).some(function (k) { return k.split("|")[0] === code; }); }

/* ===== COUNTER ===== */
export function renderCount(app) {
  if (!cur() || S.step === "who") return renderStart(app);
  var m = cur(), bd = S.br[m.branch];
  if (bd === undefined || !S.skus) {
    app.append(el("p", { class: "center muted", text: "Loading branch list…" }));
    withPin(m.branch, function () { Promise.all([S.skus ? null : loadMaster(), loadBranch(m.branch)]).then(hooks.render, function (e) { app.innerHTML = ""; app.append(el("div", { class: "card center" }, el("p", { text: errText(e) }), el("button", { class: "btn", text: "Try again", onclick: hooks.render }))); }); });
    return;
  }
  bd = bd || { codes: [], batches: {} };
  var locked = m.status === "submitted" || (closed() && !isAdmin());
  if (closed() && !isAdmin() && tstatus() === "draft") app.append(el("div", { class: "banner warn", text: "Counting hasn't started yet. Your admin will open it." }));
  else if (closed() && !isAdmin()) {
    /* counting closed: say so plainly and give one clear way out (the count is already on the server) */
    app.append(el("div", { class: "card center" }, el("h2", { style: "margin:0 0 6px", text: "Counting is closed" }),
      el("p", { class: "muted", text: "Your counts for " + m.branch + " are saved. Nothing else to do here." }),
      el("button", { class: "btn primary", text: "Done - back to start", onclick: function () { if (hooks.counterLogout) hooks.counterLogout(true); } })));
  }
  else if (m.status === "submitted" && !isAdmin()) app.append(doneCard(m));
  else if (m.status === "submitted") app.append(el("div", { class: "banner ok", text: "Submitted ✓ " + tsTxt(m.submittedAt) + "." }));
  /* warehouse photos come first: a blocking step before counting starts */
  var prG = photoNeed(m);
  if (!locked && !isAdmin() && prG.on && prG.min && Math.max(m.photos || 0, (S.photoN || {})[m.id] || 0) < prG.min && !(S.photoLater || {})[m.id] && !$("#modal").classList.contains("on")) setTimeout(function () { photoGate(m); }, 0);
  var nRc = Object.keys(rcMap()).length;
  var inSys = {}; (bd.codes || []).forEach(function (c) { inSys[c] = 1; });
  var skus = (S.skus || []).slice().sort(function (a, b) { return ((rcSku(a.code) ? 0 : 1) - (rcSku(b.code) ? 0 : 1)) || ((inSys[a.code] ? 0 : 1) - (inSys[b.code] ? 0 : 1)) || a.code.localeCompare(b.code); });
  var known = {}; skus.forEach(function (x) { known[x.code] = 1; }); (m.extraSkus || []).forEach(function (x) { if (!known[x.code]) { skus.push({ code: x.code, desc: (x.desc || "") + " (not on list)", per: null, perBox: null }); known[x.code] = 1; } });
  var expected = skus.filter(function (s) { return inSys[s.code]; });
  S.skuIndex = {}; skus.forEach(function (s) { S.skuIndex[s.code] = s; });

  /* header card: what this is, progress, time left, filters */
  var t = S.take || {}, tl = timeLeft(t), role = sessRole(m);
  var tag = t.kind === "daily" ? el("span", { class: "kind-daily ktag", text: "DAILY CYCLE COUNT" }) : el("span", { class: (t.stockType === "bad" ? "kind-bad" : "kind-monthly") + " ktag", text: (t.stockType === "bad" ? "MONTHLY STOCK TAKE · BAD STOCK" : "MONTHLY STOCK TAKE") + (t.scope === "partial" ? " · only " + expected.length + " SKU" + (expected.length === 1 ? "" : "s") + " on your list" : "") });
  var head = el("div", { class: "chead" });
  head.append(el("div", { class: "row", style: "justify-content:space-between;flex-wrap:nowrap" },
    el("div", { style: "min-width:0" }, tag, el("div", { class: "rt", text: m.branch }), el("div", { class: "small muted", style: "white-space:nowrap;overflow:hidden;text-overflow:ellipsis", text: (singleMode() ? "" : roleName(role) + " · ") + m.member }))));
  if (!singleMode()) head.append(el("div", { class: "roleline " + (role === "fin" ? "fin" : "ops"), text: (role === "fin" ? "FINANCE CHECK" : "OPS COUNT") + " - count everything yourself. Do not share or compare numbers with the other team." }));
  else if (t.kind !== "daily") head.append(el("div", { class: "roleline ops", text: "COUNT - count every SKU and batch you find, then submit." }));
  S.progTxt = el("b", { class: "num" }); S.progBar = el("i"); S.expected = expected;
  head.append(el("div", { class: "row", style: "justify-content:space-between;margin-top:10px;flex-wrap:nowrap;gap:10px" }, S.progTxt,
    tl ? el("span", { class: "small num deadline" + (tl.late ? " late" : ""), text: tl.txt }) : null), el("div", { class: "prog" }, S.progBar));
  var cnt = { todo: expected.filter(function (s) { return !skuDone(s); }).length, done: skus.filter(skuDone).length, all: skus.length, recount: skus.filter(function (s) { return rcSku(s.code); }).length };
  var seg = el("div", { class: "seg", role: "tablist" });
  (nRc ? [["recount", "⚠ Recount"], ["todo", "To count"], ["done", "Counted"], ["all", "All"]] : [["todo", "To count"], ["done", "Counted"], ["all", "All"]]).forEach(function (f) {
    seg.append(el("button", { class: "chip" + (S.filter === f[0] ? " on" : ""), role: "tab", "aria-selected": String(S.filter === f[0]), "data-n": String(cnt[f[0]]), text: f[1], onclick: function () { S.filter = f[0]; hooks.render(); } }));
  });
  head.append(seg); app.append(head); refreshProgress();
  if (nRc) app.append(el("div", { class: "banner bad" }, "⚠ Recount needed on " + nRc + " line(s). Tap the “Recount” filter, recount those batches and correct your numbers, then submit again."));

  var search = el("input", { type: "search", inputmode: "search", enterkeyhint: "search", placeholder: "Search code or name, or scan", value: S.q, "aria-label": "Search SKU",
    oninput: function (e) { S.q = e.target.value; clr.classList.toggle("hidden", !S.q); drawList(); },
    onkeydown: function (e) { if (e.key === "Enter") { var v = search.value.trim(); if (S.barcodes[v] && !locked) { e.preventDefault(); S.q = ""; search.value = ""; clr.classList.add("hidden"); drawList(); openScanSheet(v, true); } } } });
  var clr = el("button", { class: "clr" + (S.q ? "" : " hidden"), text: "✕", "aria-label": "clear search", onclick: function () { S.q = ""; search.value = ""; clr.classList.add("hidden"); drawList(); search.focus(); } });
  S.searchEl = search;
  var nextBox = el("div"), list = el("div", { class: "skulist2" });
  app.append(nextBox, el("div", { class: "sbox" }, el("span", { class: "ico" }, svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>', 18)), search, clr), list);
  function drawList() {
    list.innerHTML = ""; nextBox.innerHTML = ""; var q = S.q.trim().toLowerCase();
    var words = q.split(/\s+/).filter(Boolean);
    var rows = skus.filter(function (s) {
      var toks = (s.code + " " + (s.desc || "")).toLowerCase().split(/[^a-z0-9.%]+/).filter(Boolean);
      return words.every(function (w) { return toks.some(function (t2) { return t2.indexOf(w) === 0; }); });
    });
    if (S.filter === "todo") rows = rows.filter(function (s) { return (inSys[s.code] || q) && !skuDone(s); });
    if (S.filter === "done") rows = rows.filter(skuDone);
    if (S.filter === "recount") rows = rows.filter(function (s) { return rcSku(s.code); });
    S.navList = rows.map(function (s) { return s.code; });
    if (S.filter === "todo" && !q && rows.length && !locked) {
      var nx = rows[0];
      nextBox.append(el("button", { class: "nextup", onclick: function () { openSku(nx); } },
        el("span", { class: "nxt" }, el("small", { text: "NEXT UP" }), el("b", { text: nx.desc || nx.code }), el("span", { class: "small num", text: nx.code + (rcSku(nx.code) ? " · recount" : "") })),
        el("span", { class: "nxb", text: "Count" })));
    }
    if (!skus.length) list.append(el("p", { class: "center muted", text: "SKU list not loaded yet - check back after your admin uploads it." }));
    else if (!rows.length) list.append(el("div", { class: "empty" }, el("b", { text: S.filter === "todo" && !q ? "All done 🎉" : "Nothing here." }),
      S.filter === "todo" && !q && !locked ? el("span", { text: "Check your counts, then tap Review & submit." }) : null));
    rows.slice(0, 300).forEach(function (s) { list.append(skuCard(s, locked)); });
    if (!locked) list.append(el("button", { class: "btn block", style: "margin-top:10px", text: "+ SKU not in the list", onclick: function () { addExtraSku(m); } }));
    if (rows.length > 300) list.append(el("p", { class: "center small muted", text: "Showing 300 of " + rows.length + ". Search to narrow." }));
  }
  drawList();
  if (S.openSku && S.skuIndex[S.openSku]) openSku(S.skuIndex[S.openSku]);

  /* bottom bar: menu, scan, review & submit */
  $("#foot").classList.remove("hidden"); var fi = $("#footIn"); fi.innerHTML = "";
  var photoRule = photoNeed(m);
  fi.append(el("button", { class: "btn iconbtn2", "aria-label": "More: names, photos, switch warehouse", onclick: function () {
      openModal(function (sh) {
        sh.append(el("h3", { text: "More" }),
          el("button", { class: "btn block", style: "margin-bottom:8px", text: "Switch person / warehouse", onclick: function () { closeModal(); S.step = "who"; S.start = { step: "code" }; hooks.render(); window.scrollTo(0, 0); } }),
          el("button", { class: "btn block", style: "margin-bottom:8px", text: "Change name(s)", disabled: locked, onclick: function () { closeModal(); editCounters(m, locked); } }),
          el("button", { class: "btn block", style: "margin-bottom:8px", text: "📷 Warehouse photos (" + (m.photos || 0) + ")", onclick: function () { closeModal(); photoModal(m, locked); } }),
          el("button", { class: "btn block", style: "margin-bottom:8px;color:var(--bad)", text: "Reset this count (delete all quantities)", disabled: locked, onclick: function () {
            closeModal();
            confirmBox("Reset this count?", "Deletes every quantity in " + m.branch + " · " + m.member + ". This can't be undone.", "Reset", function () { m.lines = {}; S.open = {}; touch(); hooks.render(); window.scrollTo(0, 0); });
          } }),
          el("button", { class: "btn block", style: "margin-top:10px", text: "Close", onclick: closeModal }));
      });
    } }, svg(ICON.more, 22)));
  if (locked) fi.append(el("div", { class: "sp small muted", text: m.status === "submitted" ? "Sent to HQ · read only" : "Read only" }));
  else fi.append(el("button", { class: "btn primary scanbtn", "aria-label": "Scan barcode", onclick: function () { openScanner(); } }, svg(ICON.scan, 22), el("span", { text: "Scan" })),
    el("button", { class: "btn revbtn", onclick: function () { submitFlow(m, expected); } }, el("span", { text: "Review & submit" }),
      photoRule.on ? el("small", { class: "num", text: "📷 " + (m.photos || 0) + "/" + photoRule.min }) : null));
}

/* after submit: a clear receipt and one way out */
function doneCard(m) {
  var n = Object.keys(m.lines || {}).filter(function (k) { return hasQty(m.lines[k]); }), skuN = {}; n.forEach(function (k) { skuN[m.lines[k].code] = 1; });
  var t = S.take || {}, late = t.kind === "daily" && t.countTo && m.submittedAt && new Date(m.submittedAt) > new Date(t.countDate + "T" + t.countTo + ":00");
  return el("div", { class: "donecard" },
    el("span", { class: "dico" }, svg(ICON.check, 40)),
    el("h2", { text: "Count submitted" }),
    el("span", { class: "pill " + (late ? "warn" : "ok"), text: "Submitted ✓ " + tsTxt(m.submittedAt) + (t.kind === "daily" ? (late ? " · late" : " · on time") : "") }),
    el("div", { class: "receipt" },
      el("div", {}, el("span", { text: "Warehouse" }), el("b", { text: m.branch })),
      el("div", {}, el("span", { text: "Count" }), el("b", { text: kindShort() + (t.kind === "daily" ? " · " + dayTxt(t.countDate) : "") })),
      el("div", {}, el("span", { text: "SKUs counted" }), el("b", { text: String(Object.keys(skuN).length) })),
      el("div", {}, el("span", { text: "Counted by" }), el("b", { text: m.member || "" })),
      el("div", {}, el("span", { text: "Photos" }), el("b", { text: String(m.photos || 0) }))),
    el("p", { class: "small muted", text: "Your supervisor and HQ can see it now. Need to change something? Ask HQ to reopen the count." }),
    el("button", { class: "btn primary block big1", style: "background:var(--ink);border-color:var(--ink);color:var(--bg)", text: "Done · log out", onclick: function () { if (hooks.counterLogout) hooks.counterLogout(true); } }));
}

/* one SKU, full screen: every batch, steppers, total, remarks; Save & back to list (one SKU at a time, on purpose) */
export function openSku(s) {
  var m = cur(); if (!m) return;
  S.openSku = s.code;
  var locked = m.status === "submitted" || (closed() && !isAdmin());
  var old = document.getElementById("skuv"); if (old) old.remove();
  var v = el("div", { id: "skuv", role: "dialog", "aria-modal": "true", "aria-label": s.desc || s.code });
  document.body.append(v); document.body.classList.add("noscroll");
  function close() { S.openSku = null; v.remove(); document.body.classList.remove("noscroll"); hooks.render(); }
  function draw() {
    v.innerHTML = "";
    var sum = skuSummary(s);
    v.append(el("div", { class: "svtop" },
      el("button", { class: "iconbtn", "aria-label": "Back to list", onclick: close }, svg(ICON.close, 22)),
      el("span", { class: "small muted", text: locked ? "Read only" : "Counts save as you type" }),
      el("span", { style: "width:44px" })));
    var conv = []; if (s.per) conv.push("1 carton = " + fmt(s.per) + " pcs"); if (s.perBox) conv.push("1 box = " + fmt(s.perBox) + " pcs");
    var bodyEl = el("div", { class: "svbody" },
      el("div", { class: "row", style: "gap:6px" }, el("span", { class: "small muted num", text: s.code }), rcSku(s.code) ? el("span", { class: "pill bad", text: "⚠ Recount" }) : null),
      el("h1", { class: "svname", text: s.desc || s.code }),
      el("div", { class: "small muted", text: conv.join(" · ") || "No carton factor yet - count in pieces" }));
    var bl = skuBatches(s); if (!bl.length && !locked) bl = [""];
    bl.forEach(function (b) { bodyEl.append(batchRow(s, b, locked, draw)); });
    if (!locked) bodyEl.append(el("button", { class: "btn block", text: "+ Add batch date", onclick: function () {
      pickBatch(s, "", function (b) {
        if (lines()[lk(s.code, b)] || skuBatches(s).indexOf(b) >= 0) { msg("Already listed", "Batch " + bLabel(b) + " is already on this SKU."); return; }
        setLine(s, b, {}); draw();
      });
    } }));
    if (sum && bl.length > 1) bodyEl.append(el("div", { class: "svtotal" }, el("span", { text: "SKU total" }), el("b", { text: sum.txt })));
    v.append(bodyEl);
    var foot = el("div", { class: "svfoot" });
    if (locked) foot.append(el("button", { class: "btn block big1", text: "Back to list", onclick: close }));
    else {
      foot.append(el("button", { class: "btn primary block big1", onclick: function () { if (skuSummary(s)) toast("Saved: " + s.code + " · " + skuSummary(s).txt); close(); } }, el("span", { text: "Save & back to list" })));
      if (!sum) foot.append(el("button", { class: "link strong zero", text: "None on the floor (count as 0)", onclick: function () {
        var b0 = skuBatches(s)[0] || ""; setLine(s, b0, { ctn: null, box: null, pcs: 0 }); toast(s.code + " counted as 0"); close();
      } }));
    }
    v.append(foot);
  }
  draw();
}

export function photoNeed(m) {
  var c = S.cfg || {}, roles = c.photoRoles || [];
  return { on: roles.indexOf(sessRole(m)) >= 0, min: Number(c.photoMin) || 0, max: Number(c.photoMax) || 5 };
}
function photoModal(m, locked) {
  openModal(function (sh) {
    var pr = photoNeed(m);
    sh.append(el("h3", { text: "📷 Warehouse photos" }),
      el("p", { class: "muted small", text: pr.on ? "Take " + pr.min + " to " + pr.max + " photos of the warehouse condition. Required before counting." : "Optional. Up to " + pr.max + " photos." }),
      photoBlock(m, locked, function () { hooks.render(); }),
      el("button", { class: "btn block", style: "margin-top:12px", text: "Done", onclick: function () { closeModal(); hooks.render(); } }));
  });
}

/* Before counting: take the warehouse photos. Can't be closed until the minimum is in.
   Only way past without photos: no connection (photos can't upload) - then they are asked again at Review & submit. */
function photoGate(m) {
  if ($("#modal").classList.contains("on")) return;
  var pr = photoNeed(m);
  openModal(function (sh) {
    var body = el("div", {}, el("p", { class: "muted small", text: "Getting ready…" }));
    var go = el("button", { class: "btn primary block big1", text: "Start counting", disabled: true, onclick: function () { if (go.disabled) return; closeModal(); hooks.render(); } });
    var off = el("div", { class: "small", style: "margin-top:10px;display:none" }, el("span", { class: "muted", text: "No signal here? " }),
      el("button", { class: "link strong", text: "Count first, take photos before submitting", onclick: function () { S.photoLater = S.photoLater || {}; S.photoLater[m.id] = 1; closeModal(); hooks.render(); } }));
    function upd() {
      var live = S.mine.sessions[m.id] || m, n = Math.max(live.photos || 0, (S.photoN || {})[m.id] || 0); go.disabled = n < pr.min;
      go.textContent = n < pr.min ? (pr.min - n) + " more photo" + (pr.min - n > 1 ? "s" : "") + " needed" : "Start counting";
      go.className = "btn block big1" + (n < pr.min ? "" : " primary");
      off.style.display = navigator.onLine === false ? "" : "none";
    }
    sh.append(el("div", { class: "gateic" }, "📷"), el("h3", { style: "font-size:20px", text: "First: warehouse photos" }),
      el("p", { class: "muted small", style: "margin:0 0 6px", text: "Take " + pr.min + " to " + pr.max + " photos of the warehouse condition before you count. Camera only; each photo gets the date, time and location." }),
      body, el("div", { style: "height:10px" }), go, off,
      el("p", { class: "center", style: "margin:12px 0 0" }, el("button", { class: "link", text: "Wrong warehouse? Log out", onclick: function () { closeModal(); if (hooks.counterLogout) hooks.counterLogout(); } })));
    function build() { body.innerHTML = ""; body.append(photoBlock(m, false, upd)); upd(); }
    /* the count must be on the server before photos can attach to it */
    var t0 = Date.now();
    (function wait() {
      if (!m.dirty) return build();
      flush(); if (Date.now() - t0 > 8000) { body.innerHTML = ""; body.append(el("p", { class: "small", style: "color:var(--warn)", text: "Can't reach the server yet - check the connection." })); off.style.display = ""; setTimeout(function () { t0 = Date.now(); wait(); }, 3000); return; }
      setTimeout(wait, 400);
    })();
    upd();
  }, "lock");
}

function submitFlow(m, expected) {
  var notDone = expected.filter(function (s) { return !skuDone(s); });
  var L = m.lines || {}, keys = Object.keys(L).filter(function (k) { return hasQty(L[k]); });
  var skuN = {}; keys.forEach(function (k) { skuN[L[k].code] = 1; });
  var zero = Object.keys(skuN).filter(function (c) { return keys.filter(function (k) { return L[k].code === c; }).every(function (k) { var l = L[k]; return !(l.ctn || l.box || l.pcs); }); });
  var rem = keys.filter(function (k) { return L[k].remark; }).length, extra = (m.extraSkus || []).length;
  var pr = photoNeed(m), tst = $("#toast"); if (tst) tst.classList.remove("on");
  openModal(function (sh) {
    var who = (m.names && m.names.length) ? m.names : [m.member], pads = who.map(function (n) { return sigPad(n, function () { upd(); }); });
    var cb = el("input", { type: "checkbox", style: "width:22px;height:22px;flex-shrink:0;margin:0" }), note = el("div", { class: "small", style: "color:var(--bad);font-weight:600;min-height:18px" });
    var go = el("button", { class: "btn primary block big1", text: "Submit count", disabled: true, onclick: async function () {
      if (go.disabled) return;
      var at = nowIso(); m.sign = {}; pads.forEach(function (p) { m.sign[p.name] = { img: p.png(), at: at }; });
      go.disabled = true; go.textContent = "Submitting…";
      try {
        await flush();
        var r = await rpc("counter_submit", { p_token: tokenFor(m.branch), p_device: S.device, p_id: m.id, p_data: dataOfLocal(m) });
        S.mine.sessions[m.id] = fromServer(r.session); backup();
        closeModal(); hooks.render(); window.scrollTo(0, 0);
      } catch (e) {
        go.textContent = "Submit count"; upd();
        note.textContent = e.code === "OFFLINE" ? "No connection. Your counts are kept on this phone - try again when online." : errText(e);
      }
    } });
    var dots = {};
    function dot(k, n) { return dots[k] = el("span", { class: "rdot", text: String(n) }); }
    function setDot(k, ok, n) { var d = dots[k]; if (!d) return; d.classList.toggle("ok", ok); d.innerHTML = ""; if (ok) d.append(svg(ICON.check, 15)); else d.textContent = String(n); }
    var phBox = pr.on ? photoBlock(m, false, function () { upd(); }) : null, phCount = el("span", { class: "rcount num" });
    var sgCount = el("span", { class: "rcount num" });
    function upd() {
      var phOk = !pr.on || (m.photos || 0) >= pr.min, sgOk = pads.every(function (p) { return p.signed(); });
      go.disabled = !(cb.checked && sgOk && phOk);
      setDot("ph", phOk, 2); setDot("sg", sgOk, pr.on ? 3 : 2);
      phCount.textContent = (m.photos || 0) + " of " + pr.min + "–" + pr.max; phCount.classList.toggle("ok", phOk);
      var ns = pads.filter(function (p) { return p.signed(); }).length; sgCount.textContent = ns + " of " + pads.length; sgCount.classList.toggle("ok", sgOk);
    }
    cb.addEventListener("change", upd);
    var c1 = el("div", { class: "rsec" }, el("div", { class: "rsh" }, dot("ct", 1), el("b", { text: "Counts" }), el("span", { class: "rcount num" + (notDone.length ? "" : " ok"), text: (expected.length - notDone.length) + " of " + expected.length })));
    var facts = el("div", { class: "rfacts" });
    if (notDone.length) facts.append(el("div", { class: "warnline" }, el("span", { text: notDone.length + " SKU" + (notDone.length > 1 ? "s" : "") + " NOT counted yet" }),
      el("button", { class: "link strong", text: "Count them", onclick: function () { closeModal(); S.filter = "todo"; hooks.render(); window.scrollTo(0, 0); } })),
      el("div", { class: "small muted", text: "Not counted is not the same as zero - use 0 if there is no stock." }));
    else facts.append(el("div", { class: "okline", text: "All SKUs on your list have a count." }));
    facts.append(el("div", {}, el("span", { text: "Batch lines counted" }), el("b", { class: "num", text: String(keys.length) })));
    if (zero.length) facts.append(el("div", {}, el("span", { text: "Counted as zero" }), el("b", { class: "num", text: zero.length + " SKU" + (zero.length > 1 ? "s" : "") })));
    if (extra) facts.append(el("div", {}, el("span", { text: "Not on the list, added" }), el("b", { class: "num", text: extra + " SKU" + (extra > 1 ? "s" : "") })));
    if (rem) facts.append(el("div", {}, el("span", { text: "Remarks" }), el("b", { class: "num", text: String(rem) })));
    c1.append(facts); setTimeout(function () { setDot("ct", !notDone.length, 1); }, 0);
    var secs = [c1];
    if (pr.on) secs.push(el("div", { class: "rsec" }, el("div", { class: "rsh" }, dot("ph", 2), el("b", { text: "Warehouse photos" }), phCount),
      el("div", { class: "small muted", style: "margin:-2px 0 8px", text: "Camera only. Each photo is stamped with the date, time, GPS and address." }), phBox));
    secs.push(el("div", { class: "rsec" }, el("div", { class: "rsh" }, dot("sg", pr.on ? 3 : 2), el("b", { text: who.length > 1 ? "Everyone signs" : "Sign" }), sgCount),
      el("div", { class: "small muted", style: "margin:-2px 0 8px", text: "Finger or stylus" }), el("div", {}, pads.map(function (p) { return p.node; }))));
    sh.append(el("div", { class: "rvtop" }, el("button", { class: "iconbtn", "aria-label": "Back to the list", onclick: closeModal }, svg(ICON.back, 22)), el("h3", { text: "Review & submit" })),
      el("p", { class: "small muted", style: "margin:0 0 10px", text: m.branch + " · " + roleName(sessRole(m)) + " · " + m.member }));
    secs.forEach(function (x) { sh.append(x); });
    sh.append(el("div", { class: "rvfoot" }, el("label", { class: "row", style: "gap:10px;flex-wrap:nowrap;align-items:flex-start;font-weight:600;line-height:1.35" }, cb, "I have checked all counts. After submitting, only HQ can reopen this count."), note, go));
    upd();
  }, "full");
}
function dataOfLocal(m) { return { member: m.member || "", names: m.names || [], countedBy: m.countedBy || "", lines: m.lines || {}, extraSkus: m.extraSkus || [], sign: m.sign || null, startedAt: m.startedAt || "", unknownBarcodes: m.unknownBarcodes || {} }; }

function addExtraSku(m) {
  openModal(function (sh) {
    var c = el("input", { type: "text", inputmode: "numeric", placeholder: "SKU code (from the label)" }), d = el("input", { type: "text", placeholder: "Description (optional)" });
    sh.append(el("h3", { text: "SKU not in the list" }), el("p", { class: "muted small", text: "Only for stock on the floor that isn't in the list. Count it in Pieces. Your admin will check it." }), c, el("div", { style: "height:8px" }), d,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", style: "flex:1", text: "Add", onclick: function () {
          var code = c.value.trim(); if (!code) { c.focus(); return; }
          var ex = (S.skus || []).some(function (x) { return x.code === code; }); closeModal();
          if (!ex) { m.extraSkus = m.extraSkus || []; if (!m.extraSkus.some(function (x) { return x.code === code; })) m.extraSkus.push({ code: code, desc: d.value.trim() }); touch(); }
          S.q = code; S.filter = "all"; S.open[code] = true; hooks.render();
        } })));
    setTimeout(function () { c.focus(); }, 100);
  });
}
export function lines() { var c = cur(); return (c && c.lines) || {}; }
function skuLines(code) { var L = lines(); return Object.keys(L).map(function (k) { return L[k]; }).filter(function (l) { return l.code === code; }); }
function skuDone(s) { return skuLines(s.code).some(hasQty); }
function skuSummary(s) {
  var c = 0, b = 0, p = 0, n = 0, t = 0, ok = true; skuLines(s.code).forEach(function (l) { if (!hasQty(l)) return; n++; c += l.ctn || 0; b += l.box || 0; p += l.pcs || 0; var cv = toPcs(l, s); if (cv.ok) t += cv.qty; else ok = false; });
  if (n && ok) return { txt: fmt(t) + " PCS", n: n };
  if (!n) return null; var o = []; if (c) o.push(fmt(c) + " ctn"); if (b) o.push(fmt(b) + " box"); if (p) o.push(fmt(p) + " pcs"); if (!o.length) o.push("0"); return { txt: o.join(" · "), n: n };
}
export function skuBatches(s) {
  var bd = S.br[cur().branch] || {}, list = [];
  ((bd.batches || {})[s.code] || []).forEach(function (b) { b = monthOf(b); if (list.indexOf(b) < 0) list.push(b); });
  skuLines(s.code).forEach(function (l) { if (list.indexOf(l.batch || "") < 0) list.push(l.batch || ""); });
  return list.sort();
}
export function refreshProgress() { if (!S.expected || !S.progTxt) return; var d = S.expected.filter(skuDone).length, p = S.expected.length ? Math.round(d / S.expected.length * 100) : 0; S.progTxt.textContent = d + " / " + S.expected.length + " SKUs counted"; S.progBar.style.width = p + "%"; }
function skuCard(s, locked) {
  var sum = skuSummary(s), rc = rcSku(s.code);
  return el("div", { class: "sku" + (sum ? " done" : "") },
    el("button", { class: "skuh", onclick: function () { openSku(s); } },
      el("span", { class: "sbadge" + (rc ? " rc" : sum ? " ok" : "") }, rc ? "R" : sum ? svg(ICON.check, 15) : ""),
      el("span", { class: "sinfo" }, el("span", { class: "desc", text: s.desc || s.code }), el("span", { class: "code", text: s.code + (rc ? " · recount" : "") + (sum && sum.n > 1 ? " · " + sum.n + " batches" : "") })),
      el("span", { class: "tot" + (sum ? " ok" : " todo") }, sum ? sum.txt : "To count")));
}
function batchRow(s, b, locked, redraw) {
  var k = lk(s.code, b), l = lines()[k] || { code: s.code, batch: b, ctn: null, box: null, pcs: null, remark: "" }, rc = rcMap();
  var box = el("div", { class: "batch", style: rc[k] ? "border:2px solid var(--bad)" : "" });
  if (rc[k]) box.append(el("div", { class: "small", style: "color:var(--bad);font-weight:700;margin-bottom:4px", text: "⚠ Recount this batch" }));
  box.append(el("div", { class: "bh" },
    el("button", { class: "link", style: "font-weight:700;color:var(--ink);font-size:15px;text-decoration:none", text: "📅 " + bLabel(b) + (locked ? "" : " ✎"), disabled: locked, onclick: function () {
      pickBatch(s, b, function (nb) {
        if (nb === b) return; if (skuBatches(s).indexOf(nb) >= 0) { msg("Already listed", "Batch " + bLabel(nb) + " is already on this SKU."); return; }
        var L = lines(), c0 = L[k] || l; delete L[k]; L[lk(s.code, nb)] = { code: s.code, batch: nb, ctn: c0.ctn, box: c0.box, pcs: c0.pcs, remark: c0.remark || "" }; touch(); redraw(); refreshProgress();
      });
    } }),
    (locked || !lines()[k]) ? null : el("button", { class: "link", text: "clear", onclick: function () { confirmBox("Clear this batch?", bLabel(b), "Clear", function () { delete lines()[k]; touch(); redraw(); refreshProgress(); }); } })));
  function stepper(lab, f) {
    var v = l[f];
    var fac = f === "ctn" ? s.per : f === "box" ? s.perBox : 1;
    return el("div", { class: "step" }, el("span", { class: "lab" }, el("div", { text: lab }), f !== "pcs" && fac ? el("div", { style: "font-weight:400;font-size:11px", text: "×" + fac }) : null),
      el("button", { text: "−", disabled: locked, "aria-label": "minus " + lab, onclick: function () { var o = {}; o[f] = Math.max(0, (v || 0) - 1); setLine(s, b, o); redraw(); } }),
      el("div", { class: "val" + (v == null ? " blank" : ""), text: v == null ? "0" : fmt(v), onclick: function () { if (locked) return; numPad(s.code + " · " + lab, v, function (n) { var o = {}; o[f] = n; setLine(s, b, o); redraw(); }, "Batch " + bLabel(b)); } }),
      el("button", { class: "plus", text: "+", disabled: locked, "aria-label": "plus " + lab, onclick: function () { var o = {}; o[f] = (v || 0) + 1; setLine(s, b, o); redraw(); } }));
  }
  box.append(stepper("Carton", "ctn")); if (s.perBox || l.box) box.append(stepper("Box", "box")); box.append(stepper("Pieces", "pcs"));
  if (hasQty(l)) {
    var cv = toPcs(l, s), parts = []; if (l.ctn) parts.push(fmt(l.ctn) + " × " + fmt(s.per || 0)); if (l.box) parts.push(fmt(l.box) + " × " + fmt(s.perBox || 0)); if (l.pcs) parts.push(fmt(l.pcs));
    box.append(el("div", { style: "margin-top:6px;padding:8px 10px;border-radius:9px;background:" + (cv.ok ? "var(--okbg)" : "var(--warnbg)") + ";color:" + (cv.ok ? "var(--ok)" : "var(--warn)") + ";font-weight:700;display:flex;justify-content:space-between" },
      el("span", { style: "font-weight:400", text: parts.join(" + ") || "0" }), el("span", { text: cv.ok ? "= " + fmt(cv.qty) + " PCS" : "No conversion - tell your admin" })));
  }
  var c1 = (l.remark || "").split(" | ").filter(Boolean), rms = el("div", { class: "rms" + (c1.length ? "" : " hidden") });
  REMARKS.forEach(function (r) { var on = c1.indexOf(r) >= 0; rms.append(el("button", { class: "chip rm" + (on ? " on" : ""), text: r, disabled: locked, onclick: function () { var c = c1.slice(); if (on) c.splice(c.indexOf(r), 1); else c.push(r); setLine(s, b, { remark: c.join(" | ") }); redraw(); } })); });
  if (!c1.length && !locked) box.append(el("button", { class: "link", text: "+ remark (damaged / expired…)", onclick: function (e) { rms.classList.remove("hidden"); e.target.remove(); } }));
  box.append(rms); return box;
}
export function setLine(s, b, patch) {
  var c = cur(), L = c.lines = c.lines || {}, k = lk(s.code, b), l = L[k] || { code: s.code, batch: b, ctn: null, box: null, pcs: null, remark: "" };
  for (var p in patch) l[p] = patch[p]; l.t = nowIso(); L[k] = l; touch(); refreshProgress();
  /* "Continue as last time" is kept only once this warehouse has a real count on this phone */
  if (S.lastLogin && S.lastLogin.branch === c.branch && hasQty(l)) { store("ndd2-last", S.lastLogin); S.lastLogin = null; }
}
export function pickBatch(s, cur0, done) {
  var m = /^(\d{4})-(\d{2})/.exec(cur0 || ""), now = new Date(), yr = m ? +m[1] : now.getFullYear() + 1, sel = m ? +m[2] : 0;
  openModal(function (sh) {
    var yrow = el("div", { class: "row", style: "margin:6px 0 10px;gap:6px" }), mg = el("div", { class: "pad", style: "grid-template-columns:repeat(4,1fr)" });
    function draw() {
      yrow.innerHTML = ""; mg.innerHTML = "";
      for (var y = now.getFullYear() - 2; y <= now.getFullYear() + 3; y++) (function (y) { yrow.append(el("button", { class: "chip" + (y === yr ? " on" : ""), text: String(y), onclick: function () { yr = y; draw(); } })); })(y);
      MON.forEach(function (nm, i) {
        mg.append(el("button", { style: (i + 1 === sel && m && +m[1] === yr) ? "background:var(--accent);color:#fff;border-color:var(--accent)" : "",
          onclick: function () { closeModal(); done(yr + "-" + String(i + 1).padStart(2, "0")); } }, el("div", { text: nm, style: "font-size:17px" }), el("div", { text: String(i + 1).padStart(2, "0"), style: "font-size:11px;font-weight:400;opacity:.7" })));
      });
    }
    draw();
    sh.append(el("h3", { text: "Batch month / year" }), el("p", { class: "muted small", text: s.code + " · " + (s.desc || "") }),
      el("div", { class: "small muted", text: "1. Year" }), yrow, el("div", { class: "small muted", text: "2. Month" }), mg,
      el("div", { class: "row", style: "margin-top:12px" },
        el("button", { class: "btn", style: "flex:1", text: "No date on box", onclick: function () { closeModal(); done(""); } }),
        el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal })));
  });
}
function peoplePicker(mine, others, multi, selected, onChange) {
  var sel = selected.slice(), wrap = el("div"), g = el("div", { class: "chiprow" }), more = el("div", { class: "chiprow hidden", style: "margin-top:8px" });
  function btn(n) { return el("button", { class: "big namechip" + (sel.indexOf(n) >= 0 ? " on" : ""), "aria-pressed": String(sel.indexOf(n) >= 0), text: (sel.indexOf(n) >= 0 ? "✓ " : "") + n, onclick: function () { var i = sel.indexOf(n); if (multi) { if (i >= 0) sel.splice(i, 1); else sel.push(n); } else sel = [n]; draw(); onChange(sel.slice()); } }); }
  var typed = el("input", { type: "text", placeholder: "Type a name" });
  function draw() {
    g.innerHTML = ""; more.innerHTML = "";
    var extra = sel.filter(function (n) { return mine.indexOf(n) < 0 && others.indexOf(n) < 0; });
    mine.concat(extra).forEach(function (n) { g.append(btn(n)); }); others.filter(function (n) { return mine.indexOf(n) < 0; }).forEach(function (n) { more.append(btn(n)); });
  }
  draw();
  function addTyped() { var n = typed.value.replace(/\s+/g, " ").trim(); if (!n) return; if (multi) { if (sel.indexOf(n) < 0) sel.push(n); } else sel = [n]; typed.value = ""; draw(); onChange(sel.slice()); }
  typed.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addTyped(); } });
  var typeRow = el("div", { class: "row", style: "margin-top:8px;flex-wrap:nowrap" }, typed, el("button", { class: "btn", text: "Add", onclick: addTyped }));
  if (!mine.length) {
    typed.placeholder = "Type your name, then Add"; wrap.append(g, typeRow);
    if (others.length) wrap.append(el("button", { class: "link", text: "Or pick from other branches", onclick: function (e) { more.classList.remove("hidden"); e.target.remove(); } }), more);
    return wrap;
  }
  wrap.append(g, el("button", { class: "link", text: "Not listed? Type a name", onclick: function (e) { more.classList.remove("hidden"); e.target.replaceWith(typeRow); } }), more);
  return wrap;
}
/* names typed on this phone are remembered per branch + role */
function rememberNames(br, role, names) {
  var k = "ndd2-names", m = store(k) || {}, key = br + "|" + role, cur0 = m[key] || [];
  names.forEach(function (n) { if (cur0.indexOf(n) < 0) cur0.push(n); }); m[key] = cur0.slice(-12); store(k, m);
}
function namesFor(br, role) {
  var tm = team().filter(function (t) { return roleOf(t) === role; });
  var mine = [], others = []; tm.forEach(function (t) { var a = t.branch === br ? mine : others; if (a.indexOf(t.name) < 0) a.push(t.name); });
  var rem = ((store("ndd2-names") || {})[br + "|" + (role === "Checker" ? "fin" : "ops")] || []);
  rem.forEach(function (n) { if (mine.indexOf(n) < 0) mine.push(n); });
  return { mine: mine, others: others };
}
/* time left until the daily count window ends (phone clock, Malaysia) */
export function timeLeft(t) {
  t = t || S.take || {};
  if (t.kind !== "daily" || !t.countTo || !t.countDate) return null;
  var end = new Date(t.countDate + "T" + t.countTo + ":00"), mins = Math.round((end - new Date()) / 60000);
  if (isNaN(mins)) return null;
  if (mins < 0) return { late: true, txt: "Past " + t.countTo + " · submit now", short: "past " + t.countTo };
  var h = Math.floor(mins / 60), m = mins % 60;
  return { late: false, txt: (h ? h + " h " : "") + m + " min left · finish by " + t.countTo, short: (h ? h + " h " : "") + m + " min" };
}
function svg(path, size) {
  var x = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  x.setAttribute("width", size || 20); x.setAttribute("height", size || 20); x.setAttribute("viewBox", "0 0 24 24"); x.setAttribute("fill", "none");
  x.setAttribute("stroke", "currentColor"); x.setAttribute("stroke-width", "2"); x.setAttribute("stroke-linecap", "round"); x.setAttribute("stroke-linejoin", "round"); x.setAttribute("aria-hidden", "true");
  x.innerHTML = path; return x;
}
export var ICON = {
  back: '<path d="M15 6l-6 6 6 6"/>', next: '<path d="M9 6l6 6-6 6"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>', home: '<path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-7h6v7"/>',
  check: '<path d="M5 12l5 5L20 7"/>', more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  scan: '<path d="M4 7V5a1 1 0 011-1h2M17 4h2a1 1 0 011 1v2M20 17v2a1 1 0 01-1 1h-2M7 20H5a1 1 0 01-1-1v-2"/><path d="M8 8v8M11 8v8M14 8v8M17 8v8"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'
};
export { svg };

function renderStart(app) {
  var ss = S.mine.sessions || {}, keys = Object.keys(ss), st = S.start || (S.start = { step: "code" });
  if (S.cfg && !S.cfg.ownerReady) {
    app.append(el("div", { class: "card center" },
      el("h2", { text: "Welcome - first-time setup" }),
      el("p", { class: "muted", text: "Nobody has set up this app yet. The owner sets a password with the one-time setup code, then sets up the first stock take." }),
      el("button", { class: "btn primary", text: "Start first-time setup", onclick: function () { if (hooks.openLogin) hooks.openLogin(true); } })));
    return;
  }
  function reset() { if (S.wh && (S.wh.person || S.wh.joined) && hooks.whHome) { if (S.wh.joined) { hooks.whSignOut && hooks.whSignOut(); return; } hooks.whHome(); return; } S.start = { step: "code" }; hooks.render(); window.scrollTo(0, 0); }
  if (S.wh && (S.wh.person || S.wh.joined) && st.step === "code") { st = S.start = S.wh.person ? { step: "confirm", branch: S.wh.branch, role: "ops", names: [S.wh.person.name] } : { step: "confirm", branch: S.wh.branch }; }

  if (st.step === "code") {
    if (S.take && S.take.status === "closed") keys = keys.filter(function (k) { return ss[k].dirty; });
    keys = keys.filter(function (k) { return ss[k].dirty || !(S.take && S.take.status === "closed"); });
    /* the first page is the login; a phone that counts with a plant code (or has a count to continue) opens on the plant code */
    if (S.plantPad == null) S.plantPad = !!store("mw-plant") || !!store("ndd2-last") || keys.length > 0;
    if (!S.plantPad && hooks.renderLogin) { hooks.renderLogin(app); return; }
    var wrap = el("div", { class: "cstart" });
    wrap.append(el("p", { class: "center", style: "margin:0 0 12px" }, el("button", { class: "link strong", text: "Have a username? Log in", onclick: function () { S.plantPad = false; store("mw-plant", null); hooks.render(); window.scrollTo(0, 0); } })));
    var last = store("ndd2-last"), pp = plantPad("Start counting", "Enter your warehouse plant code, for example 1508.", null, function (br) {
      S.start = { step: "confirm", branch: br }; hooks.render(); window.scrollTo(0, 0);
    }, true);
    if (keys.length) {
      wrap.append(el("h2", { text: "Continue a count" }));
      var cg = el("div", { class: "resume" });
      keys.forEach(function (k) {
        var x = ss[k], n = Object.keys(x.lines || {}).filter(function (j) { return hasQty(x.lines[j]); }).length;
        cg.append(el("button", { class: "big rcard" + (S.mine.active === k ? " on" : ""), onclick: function () { withPin(x.branch, function () { S.mine.active = k; S.step = ""; S.start = null; backup(); hooks.render(); window.scrollTo(0, 0); schedule(200); }); } },
          el("span", { class: "ric" }, svg(ICON.home)),
          el("span", { class: "rtx" }, el("span", { class: "rt", text: x.branch }),
            el("span", { class: "small muted", text: roleName(sessRole(x)) + " · " + x.member + " · " + n + " line" + (n === 1 ? "" : "s") + (x.status === "submitted" ? " · submitted ✓" : "") })),
          svg(ICON.next, 18)));
      });
      wrap.append(cg, el("h2", { style: "margin-top:20px", text: "Or start a new count" }));
    } else if (last && last.code) {
      wrap.append(el("div", { class: "lastrow" },
        el("button", { class: "big rcard", onclick: function () { pp.login(last.code); } },
          el("span", { class: "ric" }, svg(ICON.home)),
          el("span", { class: "rtx" }, el("span", { class: "small muted", text: "Continue as last time" }), el("span", { class: "rt", text: last.branch + " · " + last.code })),
          svg(ICON.next, 18)),
        el("button", { class: "iconbtn lastx", "aria-label": "Remove " + last.branch + " shortcut", onclick: function () {
          confirmBox("Remove this shortcut?", last.branch + " · " + last.code + "\n\nOnly the “Continue as last time” shortcut is removed from this phone. Counts already sent are not affected.", "Remove", function () { store("ndd2-last", null); hooks.render(); });
        } }, svg(ICON.close, 18))));
    }
    wrap.append(el("div", { class: "card padcard" }, pp),
      el("p", { class: "center", style: "margin-top:14px" }, el("button", { class: "link strong", text: "Warehouse supervisor? Log in here", onclick: function () { hooks.openSup && hooks.openSup(); } })),
      el("p", { class: "center small muted", style: "margin-top:18px", text: "Version " + APP_VERSION }));
    app.append(wrap);
    return;
  }

  /* ---- ready: warehouse + what today's count is + team + names, on one screen ---- */
  var ts = tstatus(), t = S.take || {};
  var top = el("div", { class: "rhead" },
    el("button", { class: "iconbtn", "aria-label": S.wh && S.wh.person ? "Back to Today" : "Different warehouse", onclick: reset }, svg(ICON.back, 22)),
    el("div", {}, el("div", { class: "rt", text: st.branch }), el("div", { class: "small muted", text: "Your warehouse" })));
  app.append(top);
  var wt = (S.waitBy || {})[st.branch];
  if (wt) {
    /* daily counts are released by HQ's MB52 of the day; HQ can also stop a warehouse's count */
    app.append(el("div", { class: "card center waitcard" },
      el("div", { class: "gateic", style: "margin:0 auto 10px" }, wt === "stopped" ? "⏹" : "⏳"),
      el("h2", { text: wt === "stopped" ? "HQ stopped today's count" : "Today's list isn't ready yet" }),
      el("p", { class: "muted", text: wt === "stopped" ? "There is no daily count at " + st.branch + " today. Ask HQ if this is a mistake." : "HQ hasn't uploaded today's stock (MB52) yet. You can start as soon as it's in." }),
      el("div", { class: "row", style: "justify-content:center" },
        el("button", { class: "btn primary", text: "Check again", onclick: async function (e) { var bt = e.currentTarget; bt.disabled = true; bt.textContent = "Checking…"; try { await loadBranch(st.branch); S.take = (S.br[st.branch] || {}).take || S.take; } catch (x) { } hooks.render(); } }),
        el("button", { class: "btn", text: S.wh && S.wh.person ? "Back to Today" : "Different warehouse", onclick: reset }))));
    return;
  }
  if (ts !== "open") {
    app.append(el("div", { class: "card center" },
      el("h2", { text: S.notOpenMsg ? (ts === "draft" ? "Nothing to count right now" : "Today's count is closed") : ts === "draft" ? "Counting hasn't started yet" : "Counting is closed" }),
      el("p", { class: "muted", text: S.notOpenMsg || (ts === "draft" ? "Your admin will open the stock take. Try again when they tell you it's open." : "This stock take is finished. Ask your admin if something still needs counting.") }),
      el("div", { class: "row", style: "justify-content:center" },
        el("button", { class: "btn primary", text: "Try again", onclick: async function () { S.notOpenMsg = ""; try { var bd = await rpc("counter_branch", { p_token: S.tokens[st.branch], p_branch: st.branch }); S.take = bd.take; S.waitBy = S.waitBy || {}; S.waitBy[st.branch] = bd.wait || null; } catch (e) { try { S.cfg = await rpc("public_config", {}); S.take = Object.assign({}, S.take || {}, S.cfg.take); } catch (e2) { } } hooks.render(); } }),
        el("button", { class: "btn", text: S.wh && S.wh.person ? "Back to Today" : "Different warehouse", onclick: reset }))));
    return;
  }
  if (singleMode() && !st.role) { st.role = "ops"; st.names = st.names || []; }
  var daily = t.kind === "daily", n = t.skuCount, tl = timeLeft(t), pr = S.cfg || {};
  var task = el("div", { class: "task" }, kindLabel());
  var body = el("div", { class: "tbody" });
  body.append(el("div", { class: "tbig" }, el("b", { text: daily || t.scope === "partial" ? String(n || 0) : "All" }), el("span", { text: daily ? "SKUs to count today" : t.scope === "partial" ? "SKUs on your list" : "SKUs with stock in this warehouse" })));
  var facts = el("div", { class: "facts" });
  if (daily) facts.append(el("div", {}, el("small", { text: "Finish by" }), el("b", { text: t.countTo || "-" })), el("div", { class: tl && tl.late ? "late" : "" }, el("small", { text: "Time left" }), el("b", { text: tl ? tl.short : "-" })));
  else facts.append(el("div", {}, el("small", { text: "Count" }), el("b", { text: singleMode() ? "Single" : "Ops + Finance" })), el("div", {}, el("small", { text: "Stock" }), el("b", { text: t.stockType === "bad" ? "Bad stock" : "Good stock" })));
  body.append(facts);
  var nPh = (pr.photoRoles || []).length ? Number(pr.photoMin) || 0 : 0;
  body.append(el("div", { class: "todo" }, el("small", { text: "What you'll do" }),
    nPh ? el("div", {}, el("i", { text: "1" }), "Take " + nPh + " photos of the warehouse first") : null,
    el("div", {}, el("i", { text: nPh ? "2" : "1" }), daily ? "Count " + (n || 0) + " SKUs, every batch you find" : "Count every SKU and batch on your list"),
    el("div", {}, el("i", { text: nPh ? "3" : "2" }), "Check, everyone signs, then submit")));
  task.append(body); app.append(task);

  if (!singleMode()) {
    app.append(el("h2", { class: "sect", text: "Which team are you?" }));
    var rg = el("div", { class: "grid2c" });
    [["ops", "Operations", "Ops team counts the stock"], ["fin", "Finance", "Finance counts again, separately"]].forEach(function (r) {
      rg.append(el("button", { class: "big" + (st.role === r[0] ? " on" : ""), "aria-pressed": String(st.role === r[0]), onclick: function () {
        var other = Object.keys(S.mine.sessions).some(function (k2) { var x2 = S.mine.sessions[k2]; return x2.branch === st.branch && sessRole(x2) !== r[0] && sessHasQty(x2); });
        if (other && !isOwner()) { msg("Not allowed", "This phone already has a " + roleName(r[0] === "ops" ? "fin" : "ops") + " for " + st.branch + ". Ops and Finance must count on different phones so the two counts stay independent."); return; }
        if (st.role !== r[0]) st.names = []; st.role = r[0]; hooks.render();
      } }, el("div", { text: r[1] }), el("div", { class: "small muted", style: "font-weight:400", text: r[2] })));
    });
    app.append(rg, el("p", { class: "small", style: "margin:8px 0 0;color:var(--warn);font-weight:600", text: "Both teams count everything on their own. Do not share or compare numbers - the app compares them." }));
  }
  var role = st.role, names = st.names || [];
  var startBtn = el("button", { class: "btn primary block big1", text: "Start counting", onclick: go });
  function upd() {
    startBtn.disabled = !role || !names.length;
    var lab = singleMode() ? "Start count" : role === "fin" ? "Start finance check" : "Start ops count";
    startBtn.textContent = !role ? "Pick your team first" : names.length ? lab + (role === "ops" && names.length > 1 ? " · " + names.length + " people" : "") : (role === "fin" ? "Add your name first" : "Pick who is counting");
  }
  if (role) {
    var list = namesFor(st.branch, role === "fin" ? "Checker" : "Counter");
    app.append(el("div", { class: "sect row", style: "justify-content:space-between;align-items:baseline" }, el("h2", { style: "margin:0", text: role === "fin" ? "Your name" : "Who is counting?" }),
      el("span", { class: "small muted", text: role === "ops" ? "Tap everyone counting on this phone" : "" })),
      peoplePicker(list.mine, list.others, role === "ops", names, function (v) { names = v; st.names = v; upd(); }));
  }
  upd();
  $("#foot").classList.remove("hidden"); var fi = $("#footIn"); fi.innerHTML = ""; fi.append(startBtn);
  async function go() {
    if (!names.length || !role) return;
    var pickBr = st.branch;
    rememberNames(pickBr, role, names);
    var who = names.join(", "), data = { member: who, names: names.slice(), countedBy: role === "ops" ? who : "", startedAt: nowIso(), lines: {} };
    var existing = Object.keys(S.mine.sessions).filter(function (k2) { var x2 = S.mine.sessions[k2]; return x2.branch === pickBr && sessRole(x2) === role; })[0];
    if (existing) { var e0 = S.mine.sessions[existing]; data.lines = e0.lines; data.extraSkus = e0.extraSkus; data.startedAt = e0.startedAt; }
    startBtn.disabled = true;
    try {
      var s2 = await rpc("counter_start", { p_token: tokenFor(pickBr), p_device: S.device, p_branch: pickBr, p_role: role, p_data: data });
      var loc = fromServer(s2);
      if (existing && S.mine.sessions[existing].dirty) { loc.lines = S.mine.sessions[existing].lines; loc.dirty = true; }
      S.mine.sessions[loc.id] = loc; S.mine.active = loc.id; S.step = ""; S.start = null; S.filter = "todo";
      if (S.take && S.take.id && S.mine.takeId !== S.take.id) { S.mine.takeId = S.take.id; S.mine.resetId = S.take.resetId; }
      backup();
      if (loc.dirty) touch();
      await loadBranch(pickBr).catch(function () { });
      hooks.render(); window.scrollTo(0, 0);
    } catch (e) {
      startBtn.disabled = false;
      if (e.code === "AUTH") { delete S.tokens[pickBr]; saveTokens(); withPin(pickBr, go); return; }
      if (e.code === "NOT_OPEN" || e.code === "CLOSED") { var em = String(e.message || ""); S.notOpenMsg = /Nothing to count|skipped/.test(em) ? em.replace(/^(NOT OPEN|CLOSED):\s*/, "") : ""; S.take = Object.assign({}, S.take || {}, { status: e.code === "CLOSED" ? "closed" : "draft" }); st.step = "confirm"; await loadBranch(pickBr).catch(function () { }); hooks.render(); return; }
      msg(e.code === "NOT_ALLOWED" ? "Not allowed" : "Can't start", errText(e));
    }
  }
}
function editCounters(m, locked) {
  if (locked) return; var r = sessRole(m), list = namesFor(m.branch, r === "fin" ? "Checker" : "Counter"), sel = (m.names && m.names.slice()) || (m.member ? m.member.split(/,\s*/) : []);
  openModal(function (sh) {
    sh.append(el("h3", { text: r === "fin" ? "Your name - Finance" : "Counter(s) - Operations" }), peoplePicker(list.mine, list.others, r === "ops", sel, function (v) { sel = v; }),
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", style: "flex:1", text: "Save", onclick: function () { if (!sel.length) return; m.names = sel; m.member = sel.join(", "); if (r === "ops") m.countedBy = m.member; closeModal(); touch(); hooks.render(); } })));
  });
}
