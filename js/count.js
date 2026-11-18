/* Counter screens: pick role/branch/names, count by SKU and batch, submit with signatures and photos. */
import { S, hooks, cur, touch, flush, schedule, tokenFor, saveTokens, backup, fromServer, isAdmin, isOwner, sessHasQty, store } from "./state.js";
import { rpc } from "./api.js";
import { $, el, fmt, MON, bLabel, nowIso, tsTxt, openModal, closeModal, msg, confirmBox, numPad, sigPad, toast, errText } from "./ui.js";
import { toPcs, hasQty, lk, monthOf, sessRole } from "./pure.js";
import { openScanner, openScanSheet } from "./scan.js";
import { photoBlock } from "./photos.js";

export var REMARKS = ["Damaged", "Expired", "Near expiry", "Wrong location"];
function singleMode() { return !!(S.take && S.take.mode === "single"); }
export function roleName(r) { return singleMode() ? "Count" : r === "fin" ? "Finance check" : "Ops count"; }
function roleOf(t) { return t.role || "Checker"; }

/* ---------- plant code (branch login) ---------- */
/* Pad for the SAP plant code. onOk(branch, take) after a successful login. wantBranch: only accept that branch. */
export function plantPad(title, sub, wantBranch, onOk, inline) {
  var v = "", d = el("div", { class: "disp", style: "letter-spacing:8px" }), err = el("div", { class: "small", style: "color:var(--bad);text-align:center;min-height:20px;margin-top:6px" });
  function draw() { d.textContent = v || "-"; } draw();
  var go = el("button", { class: "btn primary", style: "flex:2", text: "Next", onclick: async function () {
    if (!v || go.disabled) return; go.disabled = true; go.textContent = "Checking…";
    try {
      var r = await rpc("plant_login", { p_code: v });
      if (!r.ok) { v = ""; draw(); err.textContent = "No warehouse with that plant code"; return; }
      if (wantBranch && r.branch !== wantBranch) { v = ""; draw(); err.textContent = "That code is for " + r.branch + ", not " + wantBranch; return; }
      S.tokens[r.branch] = r.token; saveTokens(); S.saveErr = null;
      if (r.take) S.take = Object.assign({}, S.take || {}, r.take);
      if (!inline) closeModal();
      await loadMaster().catch(function () { });
      onOk(r.branch, r.take);
      flush();
    } catch (e) { err.textContent = errText(e); }
    finally { go.disabled = false; go.textContent = "Next"; }
  } });
  var pad = el("div", { class: "pad" }); "1 2 3 4 5 6 7 8 9 C 0 ⌫".split(" ").forEach(function (k) { pad.append(el("button", { text: k, "aria-label": k === "⌫" ? "delete" : k === "C" ? "clear" : k, onclick: function () { if (k === "C") v = ""; else if (k === "⌫") v = v.slice(0, -1); else if (v.length < 8) v += k; err.textContent = ""; draw(); } })); });
  var box = el("div", {}, el(inline ? "h2" : "h3", { text: title }), el("p", { class: "muted small", text: sub }), d, err, pad,
    el("div", { class: "row", style: "margin-top:12px" }, inline ? null : el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }), go));
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
    S.br[br] = r; S.recount[br] = r.recount || [];
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
  else if (m.status === "submitted") app.append(el("div", { class: "banner ok", text: "Submitted ✓ " + tsTxt(m.submittedAt) + ". Ask your admin to reopen if anything needs changing." }));
  if (S.take && S.take.kind === "daily") app.append(el("div", { class: "banner", style: "background:var(--chip);color:var(--ink)" }, "Today's cycle count · " + (bd.codes || []).length + " SKU(s) on the list"));
  else if (S.take && S.take.scope === "partial") app.append(el("div", { class: "banner", style: "background:var(--chip);color:var(--ink)" }, "Partial count · " + (bd.codes || []).length + " SKU(s) to count at this warehouse"));
  if (singleMode()) app.append(el("div", { class: "banner", style: "background:var(--okbg);color:var(--ok)" }, "COUNT - count every SKU and batch you find, then submit."));
  else app.append(el("div", { class: "banner", style: "background:" + (sessRole(m) === "fin" ? "var(--badbg);color:var(--accent)" : "var(--okbg);color:var(--ok)") },
    (sessRole(m) === "fin" ? "FINANCE CHECK" : "OPS COUNT") + " - count everything yourself. Do not share or compare numbers with the other team."));
  var nRc = Object.keys(rcMap()).length;
  if (nRc) app.append(el("div", { class: "banner bad" }, "⚠ Recount needed on " + nRc + " line(s). Tap the “Recount” filter, recount those batches and correct your numbers, then submit again."));
  var inSys = {}; (bd.codes || []).forEach(function (c) { inSys[c] = 1; });
  var skus = (S.skus || []).slice().sort(function (a, b) { return ((inSys[a.code] ? 0 : 1) - (inSys[b.code] ? 0 : 1)) || a.code.localeCompare(b.code); });
  var known = {}; skus.forEach(function (x) { known[x.code] = 1; }); (m.extraSkus || []).forEach(function (x) { if (!known[x.code]) { skus.push({ code: x.code, desc: (x.desc || "") + " (not on list)", per: null, perBox: null }); known[x.code] = 1; } });
  var expected = skus.filter(function (s) { return inSys[s.code]; });
  S.skuIndex = {}; skus.forEach(function (s) { S.skuIndex[s.code] = s; });
  var tb = el("div", { class: "toolbar" });
  var search = el("input", { type: "search", inputmode: "search", enterkeyhint: "search", placeholder: "Search SKU code or name, or scan", value: S.q,
    oninput: function (e) { S.q = e.target.value; clr.classList.toggle("hidden", !S.q); drawList(); window.scrollTo(0, 0); },
    onkeydown: function (e) { if (e.key === "Enter") { var v = search.value.trim(); if (S.barcodes[v] && !locked) { e.preventDefault(); S.q = ""; search.value = ""; clr.classList.add("hidden"); drawList(); openScanSheet(v, true); } } } });
  var clr = el("button", { class: "clr" + (S.q ? "" : " hidden"), text: "✕", "aria-label": "clear search", onclick: function () { S.q = ""; search.value = ""; clr.classList.add("hidden"); drawList(); search.focus(); } });
  S.searchEl = search;
  var seg = el("div", { class: "seg" });
  (nRc ? [["recount", "⚠ Recount"], ["todo", "To count"], ["done", "Counted"], ["all", "All"]] : [["todo", "To count"], ["done", "Counted"], ["all", "All"]]).forEach(function (f) { seg.append(el("button", { class: "chip" + (S.filter === f[0] ? " on" : ""), text: f[1], onclick: function () { S.filter = f[0]; hooks.render(); } })); });
  S.progTxt = el("div", { class: "small muted", style: "margin-top:6px" }); S.progBar = el("i"); S.expected = expected;
  tb.append(el("div", { class: "sbox" }, el("span", { class: "ico", text: "🔍" }), search, clr), seg, S.progTxt, el("div", { class: "prog" }, S.progBar)); app.append(tb); refreshProgress();
  if (!locked) app.append(el("button", { class: "sfab scan", "aria-label": "Scan barcode", onclick: function () { openScanner(); } }, el("span", { text: "▥" }), el("small", { text: "SCAN" })));
  app.append(el("button", { class: "sfab", text: "🔍", "aria-label": "Search SKU", onclick: function () { window.scrollTo({ top: 0, behavior: "smooth" }); setTimeout(function () { S.searchEl && S.searchEl.focus(); }, 250); } }));
  var list = el("div"); app.append(list);
  function drawList() {
    list.innerHTML = ""; var q = S.q.trim().toLowerCase();
    var words = q.split(/\s+/).filter(Boolean);
    var rows = skus.filter(function (s) {
      var toks = (s.code + " " + (s.desc || "")).toLowerCase().split(/[^a-z0-9.%]+/).filter(Boolean);
      return words.every(function (w) { return toks.some(function (t) { return t.indexOf(w) === 0; }); });
    });
    if (S.filter === "todo") rows = rows.filter(function (s) { return (inSys[s.code] || q) && !skuDone(s); });
    if (S.filter === "done") rows = rows.filter(skuDone);
    if (S.filter === "recount") rows = rows.filter(function (s) { return rcSku(s.code); });
    if (!skus.length) list.append(el("p", { class: "center muted", text: "SKU list not loaded yet - check back after your admin uploads it." }));
    else if (!rows.length) list.append(el("p", { class: "center muted", text: S.filter === "todo" && !q ? "All done 🎉 Use search or “All” for anything else on the floor." : "Nothing here." }));
    rows.slice(0, 300).forEach(function (s) { list.append(skuCard(s, locked)); });
    if (!locked) list.append(el("button", { class: "btn block", style: "margin-top:8px", text: "+ SKU not in the list", onclick: function () { addExtraSku(m); } }));
    if (rows.length > 300) list.append(el("p", { class: "center small muted", text: "Showing 300 of " + rows.length + ". Search to narrow." }));
  }
  drawList();
  $("#foot").classList.remove("hidden"); var fi = $("#footIn"); fi.innerHTML = "";
  var photoRule = photoNeed(m);
  fi.append(el("button", { class: "btn", text: "⚙", "aria-label": "Settings", onclick: function () {
      openModal(function (sh) {
        sh.append(el("h3", { text: "Settings" }),
          el("button", { class: "btn block", style: "margin-bottom:8px", text: "Switch person / warehouse", onclick: function () { closeModal(); S.step = "who"; S.start = { step: "code" }; hooks.render(); window.scrollTo(0, 0); } }),
          el("button", { class: "btn block", style: "margin-bottom:8px", text: "Change name(s)", disabled: locked, onclick: function () { closeModal(); editCounters(m, locked); } }),
          el("button", { class: "btn block", style: "margin-bottom:8px", text: "📷 Warehouse photos (" + (m.photos || 0) + ")", onclick: function () { closeModal(); photoModal(m, locked); } }),
          el("button", { class: "btn block", style: "margin-bottom:8px;color:var(--bad)", text: "Reset this count (delete all quantities)", disabled: locked, onclick: function () {
            closeModal();
            confirmBox("Reset this count?", "Deletes every quantity in " + m.branch + " · " + m.member + ". This can't be undone.", "Reset", function () { m.lines = {}; S.open = {}; touch(); hooks.render(); window.scrollTo(0, 0); });
          } }),
          el("button", { class: "btn block", style: "margin-top:10px", text: "Close", onclick: closeModal }));
      });
    } }),
    el("div", { class: "sp small muted", style: "line-height:1.3" }, el("div", { style: "font-weight:700", text: roleName(sessRole(m)).toUpperCase() }), el("div", { text: m.member })),
    photoRule.on ? el("button", { class: "btn", style: "padding:11px 12px", text: "📷 " + (m.photos || 0) + "/" + photoRule.min, "aria-label": "Warehouse photos", onclick: function () { photoModal(m, locked); } }) : null,
    locked ? null : el("button", { class: "btn primary", text: "Submit", onclick: function () { submitFlow(m, expected); } }));
}

export function photoNeed(m) {
  var c = S.cfg || {}, roles = c.photoRoles || [];
  return { on: roles.indexOf(sessRole(m)) >= 0, min: Number(c.photoMin) || 0, max: Number(c.photoMax) || 5 };
}
function photoModal(m, locked) {
  openModal(function (sh) {
    var pr = photoNeed(m);
    sh.append(el("h3", { text: "📷 Warehouse photos" }),
      el("p", { class: "muted small", text: pr.on ? "Take " + pr.min + " to " + pr.max + " photos of the warehouse condition. Required before submitting." : "Optional. Up to " + pr.max + " photos." }),
      photoBlock(m, locked, function () { hooks.render(); }),
      el("button", { class: "btn block", style: "margin-top:12px", text: "Done", onclick: function () { closeModal(); hooks.render(); } }));
  });
}

function submitFlow(m, expected) {
  var left = expected.filter(function (s) { return !skuDone(s); }).length;
  var counted = Object.keys(m.lines || {}).filter(function (k) { return hasQty(m.lines[k]); }).length;
  var pr = photoNeed(m);
  openModal(function (sh) {
    var who = (m.names && m.names.length) ? m.names : [m.member], pads = who.map(function (n) { return sigPad(n, function () { upd(); }); });
    var cb = el("input", { type: "checkbox", style: "width:22px;height:22px" }), note = el("div", { class: "small", style: "color:var(--bad);font-weight:600;min-height:18px" });
    var go = el("button", { class: "btn primary", style: "flex:1", text: "Yes, submit", disabled: true, onclick: async function () {
      if (go.disabled) return;
      var at = nowIso(); m.sign = {}; pads.forEach(function (p) { m.sign[p.name] = { img: p.png(), at: at }; });
      go.disabled = true; go.textContent = "Submitting…";
      try {
        await flush();
        var r = await rpc("counter_submit", { p_token: tokenFor(m.branch), p_device: S.device, p_id: m.id, p_data: dataOfLocal(m) });
        S.mine.sessions[m.id] = fromServer(r.session); backup();
        closeModal(); hooks.render(); window.scrollTo(0, 0); toast("Submitted ✓");
      } catch (e) {
        go.textContent = "Yes, submit"; upd();
        note.textContent = e.code === "OFFLINE" ? "No connection. Your counts are kept on this phone - try again when online." : errText(e);
      }
    } });
    var phBox = pr.on ? photoBlock(m, false, function () { upd(); }) : null;
    function upd() { go.disabled = !(cb.checked && pads.every(function (p) { return p.signed(); }) && (!pr.on || (m.photos || 0) >= pr.min)); }
    cb.addEventListener("change", upd);
    sh.append(el("h3", { text: "⚠️ Are you sure you want to submit?" }),
      el("div", { class: "banner warn", style: "margin:8px 0" }, "Once submitted, you CANNOT edit this count. Only your admin can reopen it."),
      el("p", { class: "small", text: m.branch + " · " + roleName(sessRole(m)) + " · " + m.member }),
      el("p", { class: "small", text: counted + " batch line(s) counted." }),
      left ? el("p", { class: "small", style: "color:var(--bad);font-weight:600", text: left + " SKU(s) in this branch are NOT counted yet. Not counted is not the same as zero - use 0 if there is no stock." }) : el("p", { class: "small", style: "color:var(--ok)", text: "All branch SKUs have a count." }),
      pr.on ? el("div", { class: "card", style: "padding:10px;margin:10px 0" }, el("div", { style: "font-weight:700", text: "📷 Warehouse photos (" + pr.min + "–" + pr.max + " required)" }), phBox) : null,
      el("label", { class: "row", style: "gap:10px;margin:12px 0;font-weight:600;flex-wrap:nowrap" }, cb, "I have checked all counts and want to submit."),
      el("p", { class: "small", style: "font-weight:600;margin:4px 0" }, who.length > 1 ? "Each counter signs below (finger or stylus):" : "Sign below (finger or stylus):"),
      el("div", {}, pads.map(function (p) { return p.node; })), note,
      el("div", { class: "row" }, el("button", { class: "btn", style: "flex:1", text: "Go back", onclick: closeModal }), go));
  });
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
export function refreshProgress() { if (!S.expected || !S.progTxt) return; var d = S.expected.filter(skuDone).length, p = S.expected.length ? Math.round(d / S.expected.length * 100) : 0; S.progTxt.textContent = d + " / " + S.expected.length + " SKUs counted (" + p + "%)"; S.progBar.style.width = p + "%"; }
function skuCard(s, locked) {
  var sum = skuSummary(s), open = !!S.open[s.code], card = el("div", { class: "sku" + (sum ? " done" : "") });
  function redraw() { var n = skuCard(s, locked); card.replaceWith(n); card = n; }
  card.append(el("div", { class: "skuh", onclick: function () { S.open[s.code] = !open; redraw(); } },
    el("div", { style: "flex:1" }, el("div", { class: "code" }, s.code, rcSku(s.code) ? el("span", { class: "pill bad", style: "margin-left:6px", text: "⚠ Recount" }) : null), el("div", { class: "desc", text: s.desc || "" })),
    el("div", { class: "tot" }, sum ? el("span", { style: "font-size:13px", text: sum.txt }) : el("span", { class: "muted", text: "-" }), el("small", { text: sum ? (sum.n + " batch" + (sum.n > 1 ? "es" : "")) : "tap to count" }))));
  if (!open) return card;
  var body = el("div", { class: "body" });
  skuBatches(s).forEach(function (b) { body.append(batchRow(s, b, locked, redraw)); });
  if (!locked) body.append(el("button", { class: "btn block", text: "+ Add batch date", onclick: function () {
    pickBatch(s, "", function (b) {
      if (lines()[lk(s.code, b)] || skuBatches(s).indexOf(b) >= 0) { msg("Already listed", "Batch " + bLabel(b) + " is already on this SKU."); return; }
      setLine(s, b, {}); redraw();
    });
  } }));
  card.append(body); return card;
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
  var sel = selected.slice(), wrap = el("div"), g = el("div", { class: "grid" }), more = el("div", { class: "grid hidden", style: "margin-top:8px" });
  function btn(n) { return el("button", { class: "big" + (sel.indexOf(n) >= 0 ? " on" : ""), text: n + (multi && sel.indexOf(n) >= 0 ? " ✓" : ""), onclick: function () { var i = sel.indexOf(n); if (multi) { if (i >= 0) sel.splice(i, 1); else sel.push(n); } else sel = [n]; draw(); onChange(sel.slice()); } }); }
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
function renderStart(app) {
  var ss = S.mine.sessions || {}, keys = Object.keys(ss), st = S.start || (S.start = { step: "code" });
  if (S.cfg && !S.cfg.ownerReady) {
    app.append(el("div", { class: "card center" },
      el("h2", { text: "Welcome - first-time setup" }),
      el("p", { class: "muted", text: "Nobody has set up this app yet. The owner sets a password with the one-time setup code, then sets up the first stock take." }),
      el("button", { class: "btn primary", text: "Start first-time setup", onclick: function () { if (hooks.openLogin) hooks.openLogin(true); } })));
    return;
  }
  function stepBar(n) {
    var labels = singleMode() ? ["Warehouse", "Name"] : ["Warehouse", "Team", "Name"]; if (singleMode() && n === 2) n = 1;
    return el("div", { class: "steps" }, labels.map(function (t, i) { return el("div", { class: "stp" + (i < n ? " done" : i === n ? " now" : "") }, el("i"), el("span", { text: t })); }));
  }
  function reset() { S.start = { step: "code" }; hooks.render(); window.scrollTo(0, 0); }

  if (st.step === "code") {
    if (S.take && S.take.status === "closed") keys = keys.filter(function (k) { return ss[k].dirty; });
    if (keys.length) {
      app.append(el("h2", { text: "Continue a count" }));
      var cg = el("div", { class: "grid", style: "margin-bottom:18px" });
      keys.forEach(function (k) {
        var x = ss[k], n = Object.keys(x.lines || {}).filter(function (j) { return hasQty(x.lines[j]); }).length;
        if (!x.dirty && S.take && S.take.status === "closed") return;   /* nothing left to do in a closed stock take */
        cg.append(el("button", { class: "big" + (S.mine.active === k ? " on" : ""), onclick: function () { withPin(x.branch, function () { S.mine.active = k; S.step = ""; S.start = null; backup(); hooks.render(); window.scrollTo(0, 0); schedule(200); }); } },
          el("div", { text: x.branch }), el("div", { class: "small", style: "font-weight:700;color:" + (sessRole(x) === "fin" ? "var(--accent)" : "var(--ok)"), text: roleName(sessRole(x)).toUpperCase() }),
          el("div", { class: "small muted", style: "font-weight:400", text: x.member }),
          el("div", { class: "small muted", style: "font-weight:400", text: n + " line" + (n === 1 ? "" : "s") + (x.status === "submitted" ? " · submitted ✓" : "") })));
      });
      app.append(cg, el("h2", { style: "margin-top:8px", text: "Or start a new count" }));
    }
    app.append(stepBar(0), el("div", { class: "card", style: "max-width:420px;margin:0 auto" },
      plantPad("Enter your warehouse plant code", "The SAP plant code of the warehouse you are counting, for example 1508.", null, function (br) {
        S.start = { step: "confirm", branch: br }; hooks.render(); window.scrollTo(0, 0);
      }, true)),
      el("p", { class: "center small", style: "margin-top:14px" }, el("button", { class: "link", text: "Warehouse supervisor? Log in here", onclick: function () { hooks.openSup && hooks.openSup(); } })));
    return;
  }
  if (st.step === "confirm") {
    var ts = tstatus();
    app.append(stepBar(0));
    if (ts !== "open") {
      app.append(el("div", { class: "card center" }, el("div", { class: "small muted", text: st.branch }),
        el("h2", { text: S.notOpenMsg ? (ts === "draft" ? "Nothing to count right now" : "Today's count is closed") : ts === "draft" ? "Counting hasn't started yet" : "Counting is closed" }),
        el("p", { class: "muted", text: S.notOpenMsg || (ts === "draft" ? "Your admin will open the stock take. Try again when they tell you it's open." : "This stock take is finished. Ask your admin if something still needs counting.") }),
        el("div", { class: "row", style: "justify-content:center" },
          el("button", { class: "btn primary", text: "Try again", onclick: async function () { S.notOpenMsg = ""; try { var bd = await rpc("counter_branch", { p_token: S.tokens[st.branch], p_branch: st.branch }); S.take = bd.take; } catch (e) { try { S.cfg = await rpc("public_config", {}); S.take = Object.assign({}, S.take || {}, S.cfg.take); } catch (e2) { } } hooks.render(); } }),
          el("button", { class: "btn", text: "Different warehouse", onclick: reset }))));
      return;
    }
    app.append(el("div", { class: "card center" }, el("div", { class: "small muted", text: "Your warehouse" }), el("h2", { style: "font-size:24px;margin:6px 0 14px", text: st.branch }),
      S.take && S.take.kind === "daily" ? el("p", { class: "small", text: "Today's cycle count: " + S.take.skuCount + " SKU(s) on the list." }) : S.take && S.take.scope === "partial" ? el("p", { class: "small", text: "Partial count: only the SKUs your admin picked." }) : null,
      el("div", { class: "row", style: "justify-content:center" },
        el("button", { class: "btn primary", text: "Yes, that's my warehouse", onclick: function () { if (singleMode()) { st.role = "ops"; st.names = st.names || []; st.step = "names"; } else st.step = "team"; hooks.render(); } }),
        el("button", { class: "btn", text: "No, enter again", onclick: reset }))));
    return;
  }
  if (st.step === "team") {
    app.append(stepBar(1), el("h2", { text: "Which team are you?" }), el("p", { class: "small muted", text: st.branch }));
    var rg = el("div", { class: "grid" });
    [["ops", "Operations", "Ops team counts the stock"], ["fin", "Finance", "Finance counts again, separately"]].forEach(function (r) {
      rg.append(el("button", { class: "big", onclick: function () {
        var other = Object.keys(S.mine.sessions).some(function (k2) { var x2 = S.mine.sessions[k2]; return x2.branch === st.branch && sessRole(x2) !== r[0] && sessHasQty(x2); });
        if (other && !isOwner()) { msg("Not allowed", "This phone already has a " + roleName(r[0] === "ops" ? "fin" : "ops") + " for " + st.branch + ". Ops and Finance must count on different phones so the two counts stay independent."); return; }
        st.role = r[0]; st.names = []; st.step = "names"; hooks.render();
      } }, el("div", { text: r[1] }), el("div", { class: "small muted", style: "font-weight:400", text: r[2] })));
    });
    app.append(rg, el("p", { class: "small", style: "margin:12px 0 0;color:var(--warn);font-weight:600", text: "Both teams count everything on their own. Do not share or compare numbers - the app compares them." }),
      el("button", { class: "link", text: "← Back", onclick: function () { st.step = "confirm"; hooks.render(); } }));
    return;
  }
  /* names */
  var role = st.role, names = st.names || [], list = namesFor(st.branch, role === "fin" ? "Checker" : "Counter");
  var startBtn = el("button", { class: "btn primary block", style: "margin-top:18px", text: "Start counting", onclick: go });
  function upd() { startBtn.disabled = !names.length; startBtn.textContent = names.length ? "Start " + roleName(role).toLowerCase() : (role === "fin" ? "Add your name first" : "Add at least one name"); }
  app.append(stepBar(2), el("h2", { text: role === "fin" ? "Your name" : "Who is counting?" }), el("p", { class: "small muted", text: st.branch + (singleMode() ? "" : " · " + (role === "fin" ? "Finance" : "Operations")) + (role === "ops" ? " · add everyone counting together on this phone" : "") }),
    peoplePicker(list.mine, list.others, role === "ops", names, function (v) { names = v; st.names = v; upd(); }), startBtn,
    el("button", { class: "link", text: "← Back", onclick: function () { st.step = singleMode() ? "confirm" : "team"; hooks.render(); } }));
  upd();
  async function go() {
    if (!names.length) return;
    var pickBr = st.branch;
    rememberNames(pickBr, role, names);
    var who = names.join(", "), data = { member: who, names: names.slice(), countedBy: role === "ops" ? who : "", startedAt: nowIso(), lines: {} };
    var existing = Object.keys(S.mine.sessions).filter(function (k2) { var x2 = S.mine.sessions[k2]; return x2.branch === pickBr && sessRole(x2) === role; })[0];
    if (existing) { var e0 = S.mine.sessions[existing]; data.lines = e0.lines; data.extraSkus = e0.extraSkus; data.startedAt = e0.startedAt; }
    startBtn.disabled = true;
    try {
      var s = await rpc("counter_start", { p_token: tokenFor(pickBr), p_device: S.device, p_branch: pickBr, p_role: role, p_data: data });
      var loc = fromServer(s);
      if (existing && S.mine.sessions[existing].dirty) { loc.lines = S.mine.sessions[existing].lines; loc.dirty = true; }
      S.mine.sessions[loc.id] = loc; S.mine.active = loc.id; S.step = ""; S.start = null; backup();
      if (loc.dirty) touch();
      await loadBranch(pickBr).catch(function () { });
      hooks.render(); window.scrollTo(0, 0);
    } catch (e) {
      startBtn.disabled = false;
      if (e.code === "AUTH") { delete S.tokens[pickBr]; saveTokens(); withPin(pickBr, go); return; }
      if (e.code === "NOT_OPEN" || e.code === "CLOSED") { var em = String(e.message || ""); S.notOpenMsg = /Nothing to count|skipped/.test(em) ? em.replace(/^(NOT OPEN|CLOSED):\s*/, "") : ""; S.take = Object.assign({}, S.take || {}, { status: e.code === "CLOSED" ? "closed" : "draft" }); st.step = "confirm"; hooks.render(); return; }
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
