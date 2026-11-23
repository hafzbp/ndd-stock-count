/* Master (Finance): progress per branch, Ops vs Finance vs SAP, recount, reopen, close, export. */
import { S, hooks } from "./state.js";
import { rpc } from "./api.js";
import { el, fmt, bLabel, tsTxt, msg, confirmBox, errText } from "./ui.js";
import { variance as varianceCore, lk, hasQty, sessRole } from "./pure.js";
import { exportXlsx, signoffPdf } from "./export.js";
import { showGallery } from "./photos.js";

export async function loadAdmin() {
  var res = await Promise.all([rpc("admin_load", { p_token: S.admin.token, p_take: S.viewTake || null }),
    rpc("admin_late", { p_token: S.admin.token, p_take: S.viewTake || null }).catch(function () { return []; })]);
  var r = res[0]; S.late = res[1] || [];
  S.adm = r;
  S.admin.kind = r.kind;
  S.counts = docsFrom(r.sessions);
  S.sysBy = r.sys || {};
  return r;
}
/* count sessions from admin_load as the documents the variance and the PDFs use */
export function docsFrom(sessions) {
  return (sessions || []).map(function (s) {
    var d = s.data || {};
    return { id: s.id, branch: s.branch, role: s.role, member: d.member || "", names: d.names || [], lines: d.lines || {}, extraSkus: d.extraSkus || [],
      sign: d.sign || null, unknownBarcodes: d.unknownBarcodes || {}, status: s.status, submittedAt: s.submittedAt, updatedAt: s.updatedAt, photos: s.photos || 0, device: s.device };
  });
}
export function branchesAdm() { return ((S.adm && S.adm.branches) || []).filter(function (b) { return b.active; }).map(function (b) { return b.name; }); }
export function skuMap() { var m = {}; ((S.adm && S.adm.skus) || []).forEach(function (s) { m[s.code] = s; }); return m; }
export function tolPct() { var t = S.adm && S.adm.settings && Number(S.adm.settings.tolerance); return (t != null && !isNaN(t)) ? t : 2; }
export function currentTake() { return (S.adm && S.adm.takeInfo) || {}; }
function ro() { return !!S.viewTake; }
export function isSingle() { var t = currentTake(); return !!(t && t.mode === "single"); }
export function variance(br) { return varianceCore(S.sysBy[br] || [], S.counts.filter(function (d) { return d.branch === br; }), skuMap(), tolPct(), isSingle()); }
function roleName(r) { return r === "fin" ? "Finance check" : "Ops count"; }

function sessCell(x) {
  if (!x.length) return el("td", {}, el("span", { class: "pill", text: "Not started" }));
  var allSub = x.every(function (d) { return d.status === "submitted"; });
  var by = {}, order = []; x.forEach(function (d) { ((d.names && d.names.length) ? d.names : [d.member || "?"]).forEach(function (n) { if (!by[n]) { by[n] = {}; order.push(n); } by[n][d.id] = 1; }); });
  var used = {}; x.forEach(function (d) { if (Object.keys(d.lines || {}).some(function (j) { return hasQty(d.lines[j]); })) ((d.names && d.names.length) ? d.names : [d.member || "?"]).forEach(function (n) { (used[n] = used[n] || {})[d.id] = 1; }); });
  var dup = order.filter(function (n) { return used[n] && Object.keys(used[n]).length > 1; });
  return el("td", {}, el("div", {}, el("div", { class: "small", text: order.join(" · ") }),
    dup.map(function (n) { return el("div", { class: "small", style: "color:var(--bad);font-weight:600;white-space:normal;max-width:260px", text: "⚠ " + n + " is on " + Object.keys(used[n]).length + " phones - check the same stock isn't counted twice" }); }),
    el("span", { class: "pill " + (allSub ? "ok" : "warn"), text: allSub ? "Submitted" : "Counting" }),
    x.map(function (d) { return el("button", { class: "link", style: "margin-left:6px", text: "📷 " + (d.photos || 0), title: "Warehouse photos", onclick: function () { showGallery(d, S.admin.token); } }); }),
    ro() ? null : x.filter(function (d) { return d.status === "submitted"; }).map(function (d) { return el("button", { class: "link", style: "margin-left:6px", text: "reopen", onclick: function () { reopenSess(d); } }); })));
}
async function reopenSess(d) {
  try { await rpc("admin_reopen", { p_token: S.admin.token, p_id: d.id }); await loadAdmin(); hooks.render(); }
  catch (e) { msg("Failed", errText(e)); }
}
function sendRecount(b, V) {
  var items = V.filter(function (o) { return o.status === "RECOUNT" || /^WAITING/.test(o.status); }).map(function (o) { return lk(o.code, o.batch); });
  confirmBox(items.length ? "Send recount list?" : "Clear recount list?", items.length ? items.length + " line(s) at " + b + " where Ops and Finance differ, or only one team counted. Both teams see which SKU/batch to recount (not the numbers), and their submitted counts are reopened." : "No lines need a recount at " + b + ". This clears the recount banner on both teams' phones.", items.length ? "Send" : "Clear", async function () {
    try { await rpc("admin_send_recount", { p_token: S.admin.token, p_branch: b, p_items: items }); await loadAdmin(); hooks.render(); msg("Sent", "Recount list sent to " + b + "."); }
    catch (e) { msg("Failed", errText(e)); }
  });
}
function stat(n, l) { return el("div", { class: "stat" }, el("b", { text: fmt(n) }), el("span", { text: l })); }

export function renderMaster(app) {
  if (!S.adm) { app.append(el("p", { class: "center muted", text: "Loading…" })); loadAdmin().then(hooks.render, function (e) { msg("Can't load", errText(e)); }); return; }
  var br = branchesAdm(), docs = S.counts, tk = currentTake();
  if (ro() && tk.kind === "daily") app.append(el("div", { class: "banner warn row", style: "justify-content:space-between" }, el("span", { text: "Daily count (read-only): " + (tk.branch || "") + " · " + (tk.name || "").replace(/^Daily /, "") }),
    el("button", { class: "btn", text: "Back to Daily", onclick: function () { S.viewTake = null; S.tab = "daily"; loadAdmin().then(hooks.render); } })));
  else if (ro()) app.append(el("div", { class: "banner warn row", style: "justify-content:space-between" }, el("span", { text: "History (read-only): " + (tk.name || "") }),
    el("button", { class: "btn", text: "Back to current", onclick: function () { S.viewTake = null; loadAdmin().then(hooks.render); } })));
  else if (tk.status === "draft") { app.append(el("div", { class: "card center" }, el("h2", { text: "Counting isn't open yet" }), el("p", { class: "muted", text: "Finish setting up " + (tk.name || "the stock take") + " in the Stock take tab, then open counting." }), el("button", { class: "btn primary", text: "Go to setup", onclick: function () { S.tab = "home"; hooks.render(); } }))); return; }
  br = br.filter(function (b) { return (S.sysBy[b] || []).length || docs.some(function (d) { return d.branch === b; }); });
  var sg = isSingle();
  var both = br.filter(function (b) { var x = docs.filter(function (d) { return d.branch === b; }); return sg ? (x.length && x.every(function (d) { return d.status === "submitted"; })) : (x.some(function (d) { return sessRole(d) === "ops" && d.status === "submitted"; }) && x.some(function (d) { return sessRole(d) === "fin" && d.status === "submitted"; })); }).length;
  var started = br.filter(function (b) { return docs.some(function (d) { return d.branch === b; }); }).length;
  app.append(el("div", { class: "stats" }, stat(br.length, "Warehouses"), stat(started, "Started"), stat(both, sg ? "Submitted" : "Both teams submitted"), stat(tk.scope === "partial" ? tk.skuCount : (S.adm.skus || []).length, tk.scope === "partial" ? "SKUs picked" : "SKUs")));
  app.append(el("div", { class: "card row", style: "justify-content:space-between" },
    el("div", {}, el("b", { text: (tk.name || "") + (tk.stockType === "bad" ? " · BAD STOCK" : "") + " · " + (tk.status === "closed" ? "Closed" : "Open") + (tk.scope === "partial" ? " · Partial" : "") }), el("div", { class: "small muted", text: sg ? "Single count: one team's count is the agreed count, compared to SAP." : "Double count: Ops vs Finance must MATCH before a line is compared to SAP." })),
    el("div", { class: "row" }, !ro() && tk.status === "closed" ? el("button", { class: "btn", text: "Start new stock take", title: "This stock take stays in History", onclick: function () { S.wizNew = true; S.wiz = null; S.tab = "home"; hooks.render(); window.scrollTo(0, 0); } }) : null,
      ro() ? null : el("button", { class: "btn", text: tk.status === "closed" ? "Reopen counting" : "Close counting", onclick: function () {
        var to = tk.status === "closed" ? "open" : "closed";
        confirmBox(to === "closed" ? "Close counting?" : "Reopen counting?", to === "closed" ? "Counters can't change anything after this. You can reopen later." : "Counters can change their counts again until you close it.", to === "closed" ? "Close" : "Reopen", async function () {
          try { await rpc("admin_set_status", { p_token: S.admin.token, p_status: to }); await loadAdmin(); hooks.render(); } catch (e) { msg("Failed", errText(e)); }
        });
      } }),
      el("button", { class: "btn", text: "↻", title: "Refresh", onclick: function () { loadAdmin().then(hooks.render); } }),
      el("button", { class: "btn primary", text: "Export to Excel", onclick: exportXlsx }))));
  var heads = sg ? ["Warehouse", "Count", "Counted lines", "Recount", "Last update", ""] : ["Warehouse", "Ops count", "Finance check", "Match", "Recount", "Waiting", "Last update", ""];
  var t = el("table", {}, el("tr", {}, heads.map(function (h) { return el("th", { class: /^(Match|Recount|Waiting|Counted lines)$/.test(h) ? "n" : "", text: h }); })));
  br.forEach(function (b) {
    var x = docs.filter(function (d) { return d.branch === b; }), V = x.length ? variance(b) : [], c = { MATCH: 0, RECOUNT: 0, W: 0 };
    V.forEach(function (o) { if (o.status === "MATCH") c.MATCH++; else if (o.status === "RECOUNT") c.RECOUNT++; else if (/^WAITING/.test(o.status)) c.W++; });
    var canRc = !ro() && (sg ? c.RECOUNT > 0 : x.some(function (d) { return sessRole(d) === "ops"; }) && x.some(function (d) { return sessRole(d) === "fin"; }));
    t.append(el("tr", {}, el("td", { text: b }), sg ? sessCell(x) : sessCell(x.filter(function (d) { return sessRole(d) === "ops"; })), sg ? null : sessCell(x.filter(function (d) { return sessRole(d) === "fin"; })),
      el("td", { class: "n", text: c.MATCH || "" }), el("td", { class: "n" + (c.RECOUNT ? " neg" : ""), text: c.RECOUNT || "" }), sg ? null : el("td", { class: "n", text: c.W || "" }),
      el("td", { text: tsTxt(x.map(function (d) { return d.updatedAt || ""; }).sort().pop()) }),
      el("td", {}, canRc ? el("button", { class: "btn", style: "padding:6px 10px", text: (c.RECOUNT + c.W) ? "Send recount list (" + (c.RECOUNT + c.W) + ")" : "Clear recount list", onclick: function () { sendRecount(b, V); } }) : null)));
  });
  app.append(el("div", { class: "card" }, el("h3", { text: sg ? "Progress" : "Progress - Ops count vs Finance check" }), el("div", { class: "tw" }, t)));
  if (!S.mBranch || br.indexOf(S.mBranch) < 0) S.mBranch = br[0] || "";
  var sel = el("select", { style: "max-width:240px", onchange: function (e) { S.mBranch = e.target.value; hooks.render(); } }, br.map(function (b) { return el("option", { value: b, text: b, selected: b === S.mBranch }); }));
  var chk = el("label", { class: "row small", style: "gap:6px" }, el("input", { type: "checkbox", checked: S.mOnly, onchange: function (e) { S.mOnly = e.target.checked; hooks.render(); } }), "Exceptions only");
  var vc = el("div", { class: "card" }, el("h3", { text: sg ? "Count vs SAP (PCS)" : "Ops vs Finance, then agreed count vs SAP (PCS)" }), el("div", { class: "row", style: "margin-bottom:10px" }, sel, chk, el("button", { class: "btn", text: "Sign-off PDF", onclick: function () { signoffPdf(S.mBranch); } })));
  if (S.mBranch) {
    var V = variance(S.mBranch), tot = { sys: 0, phys: 0, vv: 0 }, cnt = {}, lc = {}, G = V.skuGroups || {};
    V.forEach(function (o) { tot.sys += o.sys || 0; tot.phys += o.phys || 0; tot.vv += o.vv || 0; lc[o.status] = (lc[o.status] || 0) + 1; });
    Object.keys(G).forEach(function (c) { var f = G[c].flag; cnt[f] = (cnt[f] || 0) + 1; });
    vc.append(el("p", { class: "small muted", text: "Lines - " + Object.keys(lc).map(function (k) { return (sg && k === "MATCH" ? "COUNTED" : k) + ": " + lc[k]; }).join(" · ") }),
      el("p", { class: "small muted", text: "SKUs - " + Object.keys(cnt).map(function (k) { return k + ": " + cnt[k]; }).join(" · ") + " · Variance value RM " + fmt(tot.vv, 2) + " (agreed lines) · Tolerance ±" + tolPct() + "% per SKU" }));
    var ok = function (o) { return (o.status === "MATCH" || o.status === "NOT COUNTED") && (o.skuFlag === "OK" || /^WITHIN/.test(o.skuFlag)); };
    var rows = S.mOnly ? V.filter(function (o) { return !ok(o); }) : V;
    var hd = sg ? ["Item", "Description", "Batch", "Count check", "Counted (PCS)", "System", "Var", "Var RM", "SKU Var %", "SKU Result", "Remarks"] : ["Item", "Description", "Batch", "Ops (PCS)", "Finance (PCS)", "Count check", "Agreed", "System", "Var", "Var RM", "SKU Var %", "SKU Result", "Remarks"];
    var vt = el("table", {}, el("tr", {}, hd.map(function (h) { return el("th", { class: /PCS\)$|^(Agreed|System|Var|Var RM|SKU Var %)$/.test(h) ? "n" : "", text: h }); })));
    var stCls = function (st) { return st === "MATCH" ? "ok" : st === "RECOUNT" ? "bad" : "warn"; };
    rows.slice(0, 1500).forEach(function (o) {
      vt.append(el("tr", {}, el("td", { text: o.code }), el("td", { text: o.desc }), el("td", { text: bLabel(o.batch) }),
        sg ? null : el("td", { class: "n", text: fmt(o.opsQ) }), sg ? null : el("td", { class: "n", text: fmt(o.finQ) }),
        el("td", {}, o.status === "NOT COUNTED" ? el("span", { class: "muted small", text: "not counted" }) : el("span", { class: "pill " + stCls(o.status), text: sg && o.status === "MATCH" ? "COUNTED" : o.status })),
        el("td", { class: "n", text: fmt(o.phys) }), el("td", { class: "n", text: fmt(o.sys) }),
        el("td", { class: "n " + (o.v < 0 ? "neg" : o.v > 0 ? "pos" : ""), text: fmt(o.v) }), el("td", { class: "n " + (o.vv < 0 ? "neg" : o.vv > 0 ? "pos" : ""), text: fmt(o.vv, 2) }),
        el("td", { class: "n " + (o.skuPct < 0 ? "neg" : o.skuPct > 0 ? "pos" : ""), text: o.skuPct == null ? "" : fmt(o.skuPct * 100, 2) + "%" }),
        el("td", {}, el("span", { class: "pill " + (o.skuFlag === "OK" || /^WITHIN/.test(o.skuFlag) ? "ok" : /^OVER/.test(o.skuFlag) ? "bad" : "warn"), text: o.skuFlag })),
        el("td", { text: o.rmk.join(" | ") })));
    });
    vt.append(el("tr", { class: "tot" }, el("td", { text: "TOTAL" }), el("td"), el("td"), sg ? null : el("td"), sg ? null : el("td"), el("td"), el("td", { class: "n", text: fmt(tot.phys) }), el("td", { class: "n", text: fmt(tot.sys) }), el("td"), el("td", { class: "n", text: fmt(tot.vv, 2) }), el("td"), el("td"), el("td")));
    vc.append(el("div", { class: "tw", style: "max-height:60vh" }, vt));
  }
  app.append(vc);
}

