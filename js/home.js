/* Admin home: the current stock take.
   Draft  → 4-step wizard (name + Total/Partial, pick SKUs, upload MB52, open counting)
   Open   → progress per warehouse, WhatsApp message, close
   Closed → results, export, reopen, start a new one
   Below: history of earlier stock takes. */
import { S, hooks, isOwner } from "./state.js";
import { rpc, fn } from "./api.js";
import { el, fmt, tsTxt, msg, confirmBox, openModal, closeModal, errText, toast } from "./ui.js";
import { hasQty, sessRole } from "./pure.js";
import { loadAdmin, variance, branchesAdm } from "./master.js";
import { mb52Card } from "./setup.js";
import { exportXlsx } from "./export.js";
import { deleteCountsModal, resetTake } from "./hqreset.js";

function tok() { return S.admin.token; }
function info() { return (S.adm && S.adm.takeInfo) || {}; }
function appUrl() { return location.href.replace(/[#?].*$/, "").replace(/[^/]*$/, ""); }
function single(t) { return (t || info()).mode === "single"; }
function typeTxt(t) { return (t.scope === "partial" ? "Partial · " + t.skuCount + " SKUs" : "Total") + " · " + (t.mode === "single" ? "Single count" : "Double count"); }
function stateTag(s) { return el("span", { class: "state " + s, text: s === "open" ? "Open" : s === "closed" ? "Closed" : "Draft" }); }

export function waMessage() {
  var t = info(), c = S.cfg || {}, rule = (c.photoRoles || []).length ? "\nBefore you count: take " + (c.photoMin || 3) + "-" + (c.photoMax || 5) + " photos of the warehouse." : "";
  return "Stock take: " + (t.name || "") + (t.stockType === "bad" ? " - BAD STOCK only (locations BS00, BS01, SH00)" : "") + (t.scope === "partial" ? " (partial, " + t.skuCount + " SKUs)" : "") +
    "\n1. Open this link in Chrome or Safari (not inside WhatsApp): " + appUrl() +
    "\n2. Enter your warehouse plant code (for example 1508)" +
    (single(t) ? "\n3. Type your name, start counting" : "\n3. Pick your team, type your name, start counting") + rule;
}
function messageBox() {
  var ta = el("textarea", { readonly: true, style: "min-height:130px;font-family:inherit;font-size:13.5px" }); ta.value = waMessage();
  return el("div", {}, ta, el("div", { class: "row", style: "margin-top:8px" },
    el("button", { class: "btn", text: "Copy", onclick: function () { ta.select(); (navigator.clipboard ? navigator.clipboard.writeText(ta.value) : Promise.reject()).then(function () { toast("Copied"); }, function () { try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Select the text and copy it"); } }); } }),
    el("a", { class: "btn", href: "https://wa.me/?text=" + encodeURIComponent(ta.value), target: "_blank", rel: "noopener", style: "text-decoration:none" }, "Send via WhatsApp")));
}

/* per-warehouse progress from the loaded admin data */
function progressRows() {
  return branchesAdm().map(function (b) {
    var codes = {}; (S.sysBy[b] || []).forEach(function (r) { codes[r[0]] = 1; });
    var exp = Object.keys(codes).length, ses = S.counts.filter(function (d) { return d.branch === b; });
    function side(role) {
      var x = ses.filter(function (d) { return !role || sessRole(d) === role; }), done = {};
      x.forEach(function (d) { Object.keys(d.lines || {}).forEach(function (k) { var l = d.lines[k]; if (hasQty(l) && codes[l.code]) done[l.code] = 1; }); });
      return { st: !x.length ? "Not started" : x.every(function (d) { return d.status === "submitted"; }) ? "Submitted" : "Counting", n: Object.keys(done).length, photos: x.reduce(function (a, d) { return a + (d.photos || 0); }, 0) };
    }
    return { b: b, exp: exp, ops: side("ops"), fin: side("fin"), all: side(null) };
  }).filter(function (r) { return r.exp > 0 || r.all.st !== "Not started"; });
}
function progressTable() {
  var sg = single(), rows = progressRows(), box = el("div", { class: "mcards" });
  var pc = function (s) { return s === "Submitted" ? "ok" : s === "Counting" ? "warn" : ""; };
  var line = function (label, x, exp) {
    var p = exp ? Math.round(x.n / exp * 100) : 0;
    return el("div", {}, el("div", { class: "row", style: "justify-content:space-between" }, el("span", { class: "small muted", text: label }), el("span", { class: "pill " + pc(x.st), text: x.st })),
      el("div", { class: "prog", style: "height:6px;margin-top:5px" }, el("i", { style: "width:" + p + "%" })),
      el("div", { class: "small num", style: "margin-top:3px", text: x.n + " / " + exp + " SKUs · " + x.photos + " photo" + (x.photos === 1 ? "" : "s") }));
  };
  rows.forEach(function (r) {
    var mine = (S.counts || []).filter(function (d) { return d.branch === r.b; });
    box.append(el("div", { class: "mcard" }, el("b", { text: r.b }), sg ? line("Count", r.all, r.exp) : [line("Ops count", r.ops, r.exp), line("Finance check", r.fin, r.exp)],
      mine.length ? el("button", { class: "link", style: "align-self:flex-start;font-size:13px", text: "Delete a count…", onclick: function () { deleteCountsModal(r.b, mine, function () { loadAdmin().then(hooks.render); }); } }) : null));
  });
  if (!rows.length) box.append(el("p", { class: "muted", text: "No warehouse has SKUs to count yet." }));
  return box;
}

export function renderHome(app) {
  if (!S.adm || S.viewTake) { S.viewTake = null; app.append(el("p", { class: "center muted", text: "Loading…" })); loadAdmin().then(hooks.render, function (e) { msg("Can't load", errText(e)); }); return; }
  var t = info();
  if (t.status === "draft" || S.wizNew) renderWizard(app, t);
  else if (t.status === "open") renderOpen(app, t);
  else renderClosed(app, t);
  renderHistory(app);
}

/* ---------------- Draft: wizard ---------------- */
function kpiDefault() { var d = new Date(); if (d.getDate() <= 10) d.setMonth(d.getMonth() - 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01"; }
function renderWizard(app, t) {
  var fresh = S.wizNew;
  var W = S.wiz && S.wiz.id === (fresh ? "new" : t.id) ? S.wiz : (S.wiz = {
    id: fresh ? "new" : t.id, step: 1,
    name: fresh ? "" : t.name, scope: fresh ? "total" : (t.scope || "total"), mode: fresh ? "double" : (t.mode || "double"), stype: fresh ? "good" : (t.stockType || "good"), kpi: fresh ? false : !!t.kpiMonth, kpiMon: (!fresh && t.kpiMonth) || kpiDefault(), skus: fresh ? {} : (t.skus || []).reduce(function (o, c) { o[c] = 1; return o; }, {})
  });
  var hasSys = !fresh && Object.keys(S.sysBy || {}).length > 0, partial = W.scope === "partial", nSku = Object.keys(W.skus).length;
  var steps = [[1, "Name and type", W.name ? (W.stype === "bad" ? "Bad stock · " : "Good stock · ") + (W.kpi && W.stype === "good" ? "KPI · " : "") + (partial ? "Partial" : "Total") + " · " + (W.mode === "single" ? "Single" : "Double") : "Not set"], [2, "Pick SKUs", partial ? nSku + " picked" : "Not needed (Total)"], [3, "Upload MB52", hasSys ? Object.keys(S.sysBy).length + " warehouses" : "Not yet"], [4, "Open counting", "Review and open"]];
  app.append(el("div", { class: "row", style: "justify-content:space-between;margin-bottom:6px" }, el("h2", { style: "margin:0", text: fresh ? "New stock take" : "Set up the stock take" }), stateTag("draft")));
  if (fresh) app.append(el("p", { class: "small muted", text: "The last stock take stays in History below." }));
  var bar = el("div", { class: "wiz" });
  steps.forEach(function (s) {
    var can = s[0] === 1 || (!fresh && W.name && (s[0] !== 2 || partial));
    bar.append(el("button", { class: (W.step === s[0] ? "now " : "") + (s[0] === 1 && W.name && !fresh ? "done " : s[0] === 2 && partial && nSku && !fresh ? "done " : s[0] === 3 && hasSys ? "done " : ""), disabled: !can,
      onclick: function () { W.step = s[0]; hooks.render(); } }, el("b", { text: s[0] + ". " + s[1] }), s[2]));
  });
  app.append(bar);
  var c = el("div", { class: "card" }); app.append(c);
  async function save(next) {
    try {
      var skus = partial ? Object.keys(W.skus) : [];
      await rpc("admin_draft", { p_token: tok(), p_name: W.name, p_scope: W.scope, p_skus: skus });
      await rpc("admin_set_mode", { p_token: tok(), p_mode: W.mode });
      await rpc("admin_set_stock_type", { p_token: tok(), p_type: W.stype });
      S.wizNew = false; await loadAdmin();
      if ((W.kpi && W.stype === "good") || info().kpiMonth) { await rpc("admin_set_kpi_month", { p_token: tok(), p_take: info().id, p_month: W.kpi && W.stype === "good" ? W.kpiMon : null }); S.kpi = null; await loadAdmin(); } S.wiz = Object.assign(W, { id: info().id, step: next }); hooks.render(); window.scrollTo(0, 0);
    } catch (e) { msg("Can't save", errText(e)); }
  }

  if (W.step === 1) {
    var nm = el("input", { type: "text", value: W.name, placeholder: "Cycle count Nov week 4", oninput: function (e) { W.name = e.target.value; } });
    var ch = el("div", { class: "grid", style: "margin-top:12px" });
    [["total", "Total", "Count every SKU in the MB52"], ["partial", "Partial", "Count only the SKUs you pick"]].forEach(function (o) {
      ch.append(el("button", { class: "choice" + (W.scope === o[0] ? " on" : ""), onclick: function () { W.scope = o[0]; hooks.render(); } }, el("b", { text: o[1] }), el("div", { class: "small muted", text: o[2] })));
    });
    var stc = el("div", { class: "grid", style: "margin-top:6px" });
    [["good", "Good stock", "Sellable stock in the normal locations (MW00, MW01). The usual stock take."], ["bad", "Bad stock", "Damaged, expired and short stock in the bad-stock locations BS00, BS01, SH00 only."]].forEach(function (o) {
      stc.append(el("button", { class: "choice" + (W.stype === o[0] ? " on" : ""), onclick: function () { W.stype = o[0]; hooks.render(); } }, el("b", { text: o[1] }), el("div", { class: "small muted", text: o[2] })));
    });
    var mc = el("div", { class: "grid", style: "margin-top:6px" });
    [["double", "Double count", "Ops and Finance count separately. A line is agreed only when both match. For full stock takes and audits."], ["single", "Single count", "One team counts. Its count is the agreed count. Faster, but no second check."]].forEach(function (o) {
      mc.append(el("button", { class: "choice" + (W.mode === o[0] ? " on" : ""), onclick: function () { W.mode = o[0]; hooks.render(); } }, el("b", { text: o[1] }), el("div", { class: "small muted", text: o[2] })));
    });
    var mo = function (off) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + off); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01"; };
    var mt = function (m) { return new Date(m + "T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }); };
    var kc = el("input", { type: "checkbox", checked: W.kpi && W.stype === "good", disabled: W.stype !== "good", onchange: function (e) { W.kpi = e.target.checked; } });
    var ks = el("select", { style: "max-width:180px", disabled: W.stype !== "good", onchange: function (e) { W.kpiMon = e.target.value; } }, [mo(-1), mo(0)].concat(W.kpiMon && [mo(-1), mo(0)].indexOf(W.kpiMon) < 0 ? [W.kpiMon] : []).map(function (m) { return el("option", { value: m, text: mt(m), selected: m === W.kpiMon }); }));
    var kpiBox = el("div", { class: "kpibox" }, el("label", { class: "row", style: "gap:8px;flex-wrap:nowrap" }, kc, el("span", {}, el("b", { text: "Month-end stock take (KPI002)" }), el("span", { class: "small muted", text: W.stype === "good" ? " - its result is the stock take IRA of the month on the KPI dashboard" : " - good stock only" }))),
      el("div", { class: "row", style: "margin:6px 0 0 28px" }, el("span", { class: "small", text: "For" }), ks));
    c.append(el("h3", { text: "1. Name and type" }), el("p", { class: "small muted", text: "Counters see this name. The type decides which SKUs they count." }), nm,
      el("p", { class: "small", style: "margin:14px 0 0;font-weight:600", text: "Which stock?" }), stc,
      kpiBox,
      el("p", { class: "small", style: "margin:14px 0 0;font-weight:600", text: "Which SKUs?" }), ch,
      el("p", { class: "small", style: "margin:14px 0 0;font-weight:600", text: "How many teams count?" }), mc,
      el("div", { class: "row", style: "justify-content:flex-end;margin-top:14px" }, fresh ? el("button", { class: "btn", text: "Cancel", onclick: function () { S.wizNew = false; S.wiz = null; hooks.render(); } }) : null,
        el("button", { class: "btn primary", text: "Save and continue", onclick: function () {
          W.name = nm.value.trim(); if (!W.name) { nm.focus(); return; }
          var go = function () { save(W.scope === "partial" ? 2 : 3); };
          if (hasSys && W.stype !== (t.stockType || "good")) confirmBox("Change to " + (W.stype === "bad" ? "bad" : "good") + " stock?", "The MB52 already loaded is " + (W.stype === "bad" ? "good" : "bad") + " stock. It will be removed, and you upload the MB52 again in step 3.", "Change", go);
          else go();
        } })));
    return;
  }
  if (W.step === 2) {
    var q = el("input", { type: "search", placeholder: "Search SKU code or name" }), list = el("div", { class: "skulist" }), cnt = el("b");
    var all = (S.adm.skus || []).slice();
    function visible() { var w = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean); return all.filter(function (s) { var x = (s.code + " " + (s.desc || "")).toLowerCase(); return w.every(function (y) { return x.indexOf(y) >= 0; }); }); }
    function draw() {
      list.innerHTML = ""; var v = visible();
      v.forEach(function (s) {
        var cb = el("input", { type: "checkbox", checked: !!W.skus[s.code], onchange: function () { if (cb.checked) W.skus[s.code] = 1; else delete W.skus[s.code]; upd(); } });
        list.append(el("label", {}, cb, el("div", {}, el("div", { text: s.desc || s.code }), el("div", { class: "small muted", text: s.code + (s.per ? " · " + s.per + " pcs/ctn" : " · no pcs/ctn yet") }))));
      });
      if (!v.length) list.append(el("p", { class: "center muted", text: "No SKU matches." }));
    }
    function upd() { cnt.textContent = Object.keys(W.skus).length + " of " + all.length + " selected"; }
    q.addEventListener("input", draw);
    c.append(el("h3", { text: "2. Pick SKUs" }), el("p", { class: "small muted", text: "The same SKUs are counted at every warehouse. A warehouse only sees the picked SKUs it actually has in the MB52." }),
      q, el("div", { class: "row", style: "margin-top:8px;justify-content:space-between" }, cnt,
        el("div", { class: "row" }, el("button", { class: "link", text: "Select all shown", onclick: function () { visible().forEach(function (s) { W.skus[s.code] = 1; }); draw(); upd(); } }),
          el("button", { class: "link", text: "Clear all", onclick: function () { W.skus = {}; draw(); upd(); } }))), list,
      el("div", { class: "row", style: "justify-content:flex-end;margin-top:12px" }, el("button", { class: "btn", text: "Back", onclick: function () { W.step = 1; hooks.render(); } }),
        el("button", { class: "btn primary", text: "Save and continue", onclick: function () { if (!Object.keys(W.skus).length) { msg("Pick at least one SKU"); return; } save(3); } })));
    draw(); upd();
    return;
  }
  if (W.step === 3) {
    c.append(el("h3", { text: "3. Upload the SAP MB52" }), el("p", { class: "small muted", text: "System stock on the count day. It is only used to compare - counters never see these numbers." }));
    app.append(mb52Card("MB52 file", function () { hooks.render(); }));
    if (hasSys) app.append(el("div", { class: "card" }, el("h3", { text: "Warehouses ready" }), readyTable()));
    app.append(el("div", { class: "row", style: "justify-content:flex-end" }, el("button", { class: "btn", text: "Back", onclick: function () { W.step = partial ? 2 : 1; hooks.render(); } }),
      el("button", { class: "btn primary", text: "Continue", disabled: !hasSys, onclick: function () { W.step = 4; hooks.render(); } })));
    return;
  }
  /* step 4 */
  var c2 = S.cfg || {};
  c.append(el("h3", { text: "4. Review and open counting" }),
    el("div", { class: "stats", style: "margin-top:8px" },
      el("div", { class: "stat" }, el("b", { text: t.name }), el("span", { text: "Name" })),
      el("div", { class: "stat" }, el("b", { class: t.stockType === "bad" ? "neg" : "", text: t.stockType === "bad" ? "Bad stock" : "Good stock" }), el("span", { text: t.stockType === "bad" ? "BS00, BS01, SH00 only" : "Normal locations" })),
      el("div", { class: "stat" }, el("b", { text: t.scope === "partial" ? "Partial" : "Total" }), el("span", { text: t.scope === "partial" ? t.skuCount + " SKUs picked" : "All SKUs in MB52" })),
      el("div", { class: "stat" }, el("b", { text: single(t) ? "Single" : "Double" }), el("span", { text: single(t) ? "One team counts" : "Ops + Finance must match" })),
      el("div", { class: "stat" }, el("b", { text: progressRows().length }), el("span", { text: "Warehouses with SKUs to count" })),
      el("div", { class: "stat" }, el("b", { text: (c2.photoMin || 0) + "–" + (c2.photoMax || 5) }), el("span", { text: "Photos per count" }))),
    readyTable(),
    el("h3", { style: "margin-top:14px", text: "Message for the warehouses" }),
    el("p", { class: "small muted", text: "One message for every warehouse. Send it after you open counting." }), messageBox(),
    el("div", { class: "row", style: "justify-content:flex-end;margin-top:14px" }, el("button", { class: "btn", text: "Back", onclick: function () { W.step = 3; hooks.render(); } }),
      el("button", { class: "btn primary", text: "Open counting", onclick: function () {
        confirmBox("Open counting?", "Counters can log in with their plant code and start counting " + t.name + ".", "Open", async function () {
          try { await rpc("admin_set_status", { p_token: tok(), p_status: "open" }); await loadAdmin(); S.wiz = null; hooks.render(); window.scrollTo(0, 0); toast("Counting is open"); }
          catch (e) { msg("Can't open", errText(e)); }
        });
      } })));
}
function readyTable() {
  var t = el("table", {}, el("tr", {}, el("th", { text: "Warehouse" }), el("th", { text: "Plant code (login)" }), el("th", { class: "n", text: "SKUs to count" })));
  var byName = {}; (S.adm.branches || []).forEach(function (b) { byName[b.name] = b; });
  progressRows().forEach(function (r) { t.append(el("tr", {}, el("td", { text: r.b }), el("td", { text: ((byName[r.b] || {}).plants || []).join(", ") || "missing" }), el("td", { class: "n", text: r.exp }))); });
  return el("div", { class: "tw keep", style: "margin-top:10px" }, t);
}


/* ---------------- Things HQ must decide before trusting the result ---------------- */
/* Counts that reached the server after counting closed (the phone was offline). */
function lateCard() {
  var L = S.late || []; if (!L.length) return null;
  var c = el("div", { class: "card", style: "border-color:var(--warn)" }, el("h3", { text: "⚠ Counts that arrived after closing" }),
    el("p", { class: "small muted", text: "These phones were offline when counting closed. Their last counts are NOT in the result yet. Take them in (the result, Excel and sign-offs update) or ignore them." }));
  L.forEach(function (x) {
    var who = x.branch + " · " + (x.role === "fin" ? "Finance" : "Ops") + (x.member ? " · " + x.member : "");
    c.append(el("div", { class: "wrow" }, el("div", { class: "grow" }, el("b", { text: who }),
      el("div", { class: "small muted", text: x.lines + " line(s) new or changed" + (x.removed ? ", " + x.removed + " removed" : "") + " · sent " + tsTxt(x.at) })),
      el("div", { class: "row", style: "gap:6px" },
        el("button", { class: "btn primary", text: "Take in", onclick: function () { resolveLate(x, true); } }),
        el("button", { class: "btn", text: "Ignore", onclick: function () { resolveLate(x, false); } }))));
  });
  return c;
}
function resolveLate(x, take) {
  confirmBox(take ? "Take these counts in?" : "Ignore these counts?", take ? "The count of " + x.branch + " (" + (x.role === "fin" ? "Finance" : "Ops") + ") is replaced with what the phone sent. Download the sign-off again afterwards." : "What the phone sent after closing is dropped. The result stays as it is.", take ? "Take in" : "Ignore", async function () {
    try { await rpc("admin_late_resolve", { p_token: tok(), p_session: x.session, p_take: take }); await loadAdmin(); hooks.render(); toast(take ? "Counts taken in" : "Ignored"); } catch (e) { msg("Failed", errText(e)); }
  });
}
/* Two phones of the same team in one warehouse that both counted the same batch: the app adds them up.
   Fine when each counted a different pallet, wrong when they counted the same one twice. */
export function overlaps() {
  var by = {};
  (S.counts || []).forEach(function (d) {
    Object.keys(d.lines || {}).forEach(function (k) { if (!hasQty(d.lines[k])) return; var g = d.branch + "|" + d.role; ((by[g] = by[g] || {})[k] = by[g][k] || []).push(d.member || "?"); });
  });
  var out = [];
  Object.keys(by).forEach(function (g) { var n = Object.keys(by[g]).filter(function (k) { return by[g][k].length > 1; }); if (n.length) { var p = g.split("|"); out.push({ branch: p[0], role: p[1], n: n.length, keys: n, who: by[g][n[0]] }); } });
  return out;
}
function overlapCard() {
  var O = overlaps(); if (!O.length) return null;
  return el("div", { class: "card", style: "border-color:var(--warn)" }, el("h3", { text: "⚠ Same batch counted on two phones" }),
    el("p", { class: "small muted", text: "In these warehouses two phones of the same team both counted the same SKU + batch. The app ADDS them up. That is right if each counted a different stack, wrong if they counted the same stock twice - check with the warehouse." }),
    O.map(function (o) { return el("div", { class: "wrow" }, el("div", { class: "grow" }, el("b", { text: o.branch + " · " + (o.role === "fin" ? "Finance" : "Ops") }),
      el("div", { class: "small muted", text: o.n + " batch(es), e.g. " + o.keys.slice(0, 3).map(function (k) { return k.replace("|", " / "); }).join(", ") + " · by " + o.who.join(" + ") }))); }));
}

/* ---------------- Open ---------------- */
function renderOpen(app, t) {
  var sg = single(t), rows = progressRows(), done = function (r) { return sg ? r.all.st === "Submitted" : r.ops.st === "Submitted" && r.fin.st === "Submitted"; }, both = rows.filter(done).length;
  app.append(el("div", { class: "row", style: "justify-content:space-between;margin-bottom:6px" }, el("h2", { style: "margin:0", text: t.name + (t.stockType === "bad" ? " · Bad stock" : "") }), stateTag("open")),
    el("p", { class: "small muted", text: typeTxt(t) + " · open since " + tsTxt(t.openedAt) + " · updates every 20 seconds" }),
    el("div", { class: "stats" },
      el("div", { class: "stat" }, el("b", { text: rows.length }), el("span", { text: "Warehouses" })),
      el("div", { class: "stat" }, el("b", { text: rows.filter(function (r) { return r.all.st !== "Not started"; }).length }), el("span", { text: "Started" })),
      el("div", { class: "stat" }, el("b", { text: both }), el("span", { text: sg ? "Submitted" : "Both teams submitted" })),
      el("div", { class: "stat" }, el("b", { text: rows.filter(function (r) { return r.all.st === "Not started"; }).length }), el("span", { text: "Not started" }))),
    lateCard(), overlapCard(),
    el("div", { class: "card" }, el("h3", { text: "Progress" }), progressTable()),
    el("div", { class: "card" }, el("h3", { text: "Next" }),
      el("div", { class: "row" },
        el("button", { class: "btn primary", text: "Live dashboard", onclick: function () { S.tab = "dash"; S.dashView = "monthly"; S.mdWh = null; hooks.render(); window.scrollTo(0, 0); } }),
        el("button", { class: "btn", text: "Check results and recounts", onclick: function () { S.tab = "master"; hooks.render(); window.scrollTo(0, 0); } }),
        el("button", { class: "btn", text: "Message for warehouses", onclick: function () { openModal(function (sh) { sh.append(el("h3", { text: "Message for the warehouses" }), messageBox(), el("button", { class: "btn block", style: "margin-top:10px", text: "Close", onclick: closeModal })); }); } }),
        el("button", { class: "btn", text: "Replace MB52", onclick: function () { openModal(function (sh) { sh.append(mb52Card("Replace the MB52", function () { closeModal(); hooks.render(); }), el("button", { class: "btn block", text: "Cancel", onclick: closeModal })); }); } }),
        el("button", { class: "btn", style: "color:var(--bad)", text: "Stop & reset…", title: "Delete every count and go back to Draft", onclick: function () { resetTake(t, function () { loadAdmin().then(function () { hooks.render(); window.scrollTo(0, 0); }); }); } }),
        el("button", { class: "btn", style: "color:var(--bad)", text: "Close counting", onclick: function () {
          var open = rows.filter(function (r) { return !done(r); }).map(function (r) { return r.b; });
          confirmBox("Close counting?", (open.length ? "Not everyone has submitted yet: " + open.join(", ") + ".\n\n" : "") + "Counters can't change anything after this. A phone that is offline right now keeps its unsent counts; they come back here as 'counts that arrived after closing' for you to take in or ignore. Results, Excel, sign-off PDFs and the dashboard variance use what is saved now. You can reopen later.", "Close", async function () {
            try { await rpc("admin_set_status", { p_token: tok(), p_status: "closed" }); await loadAdmin(); hooks.render(); window.scrollTo(0, 0); } catch (e) { msg("Can't close", errText(e)); }
          });
        } }))));
}

/* ---------------- Closed ---------------- */
function renderClosed(app, t) {
  var tbl = el("table", {}, el("tr", {}, ["Warehouse", "Match", "Recount / waiting", "SKUs over", "Variance PCS", "Variance RM"].map(function (h, i) { return el("th", { class: i ? "n" : "", text: h }); })));
  var tot = { m: 0, r: 0, o: 0, q: 0, v: 0 };
  progressRows().forEach(function (r) {
    var V = variance(r.b), m = 0, rc = 0, q = 0, v = 0, G = V.skuGroups || {}, over = Object.keys(G).filter(function (c) { return /^OVER/.test(G[c].flag); }).length;
    V.forEach(function (o) { if (o.status === "MATCH") m++; else if (o.status !== "NOT COUNTED") rc++; q += o.v || 0; v += o.vv || 0; });
    tot.m += m; tot.r += rc; tot.o += over; tot.q += q; tot.v += v;
    tbl.append(el("tr", {}, el("td", { text: r.b }), el("td", { class: "n", text: m }), el("td", { class: "n" + (rc ? " neg" : ""), text: rc }), el("td", { class: "n" + (over ? " neg" : ""), text: over }), el("td", { class: "n " + (q < 0 ? "neg" : q > 0 ? "pos" : ""), text: fmt(q) }), el("td", { class: "n " + (v < 0 ? "neg" : v > 0 ? "pos" : ""), text: fmt(v, 2) })));
  });
  tbl.append(el("tr", { class: "tot" }, el("td", { text: "TOTAL" }), el("td", { class: "n", text: tot.m }), el("td", { class: "n", text: tot.r }), el("td", { class: "n", text: tot.o }), el("td", { class: "n", text: fmt(tot.q) }), el("td", { class: "n", text: fmt(tot.v, 2) })));
  app.append(el("div", { class: "row", style: "justify-content:space-between;margin-bottom:6px" }, el("h2", { style: "margin:0", text: t.name + (t.stockType === "bad" ? " · Bad stock" : "") }), stateTag("closed")),
    el("p", { class: "small muted", text: typeTxt(t) + " · closed " + tsTxt(t.closedAt) }),
    lateCard(), overlapCard(),
    el("div", { class: "card" }, el("h3", { text: "Results" }), el("div", { class: "tw" }, tbl)),
    el("div", { class: "card" }, el("h3", { text: "Next" }),
      el("div", { class: "row" },
        el("button", { class: "btn primary", text: "Final results & all sign-offs", onclick: function () { S.tab = "dash"; S.dashView = "monthly"; S.mdWh = null; hooks.render(); window.scrollTo(0, 0); } }),
        el("button", { class: "btn", text: "Export to Excel", onclick: exportXlsx }),
        el("button", { class: "btn", text: "Sign-off PDF per warehouse", onclick: function () { S.tab = "master"; hooks.render(); window.scrollTo(0, 0); } }),
        el("button", { class: "btn", text: "Reopen counting", onclick: function () {
          confirmBox("Reopen counting?", "Counters can change their counts again until you close it.", "Reopen", async function () { try { await rpc("admin_set_status", { p_token: tok(), p_status: "open" }); await loadAdmin(); hooks.render(); } catch (e) { msg("Can't reopen", errText(e)); } });
        } }),
        el("button", { class: "btn", text: "Start new stock take", onclick: function () { S.wizNew = true; S.wiz = null; hooks.render(); window.scrollTo(0, 0); } }),
        isOwner() ? el("button", { class: "btn", style: "color:var(--bad)", text: "Delete", onclick: function () { deleteTake(t); } }) : null)));
}

/* ---------------- History ---------------- */
function renderHistory(app) {
  var cur = S.adm.current, past = (S.adm.takes || []).filter(function (x) { return x.id !== cur; });
  if (!past.length) return;
  var t = el("table", {}, el("tr", {}, ["Stock take", "Type", "Status", "Opened", "Closed", ""].map(function (h) { return el("th", { text: h }); })));
  past.forEach(function (x) {
    t.append(el("tr", {}, el("td", { text: x.name }), el("td", { text: (x.scope === "partial" ? "Partial (" + x.skuCount + ")" : "Total") + (x.mode === "single" ? " · Single" : " · Double") }), el("td", {}, stateTag(x.status)),
      el("td", { text: tsTxt(x.openedAt) }), el("td", { text: tsTxt(x.closedAt) }),
      el("td", { class: "row", style: "gap:10px;flex-wrap:nowrap" }, el("button", { class: "link", text: "View (read-only)", onclick: async function () { try { S.viewTake = x.id; await loadAdmin(); S.tab = "master"; hooks.render(); window.scrollTo(0, 0); } catch (e) { S.viewTake = null; msg("Can't load", errText(e)); } } }),
        isOwner() && x.status !== "open" ? el("button", { class: "link", style: "color:var(--bad)", text: "Delete", onclick: function () { deleteTake(x); } }) : null)));
  });
  app.append(el("div", { class: "card", style: "margin-top:18px" }, el("h3", { text: "History" }), el("div", { class: "tw" }, t)));
}

/* Owner: delete a closed (or never opened) stock take with its counts, results and photos. */
function deleteTake(x) {
  openModal(function (sh) {
    var inp = el("input", { placeholder: "Type the stock take name to confirm" }), err = el("div", { class: "small", style: "color:var(--bad);min-height:18px" });
    sh.append(el("h3", { text: "Delete “" + x.name + "”?" }),
      el("p", { class: "small", text: "All counts, results, recount lists and warehouse photos of this stock take are deleted for good. It can't be undone. Download the Excel or sign-off PDFs first if you need them." }),
      inp, err,
      el("div", { class: "row", style: "justify-content:flex-end" }, el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn", style: "color:var(--bad)", text: "Delete for good", onclick: async function () {
          if (inp.value.trim() !== x.name) { err.textContent = "Type the name exactly: " + x.name; return; }
          try {
            var r = await rpc("owner_delete_take", { p_token: S.admin.token, p_take: x.id });
            if (r.paths && r.paths.length) { try { await fn("photos", { action: "remove_paths", token: S.admin.token, paths: r.paths }); } catch (e) { } }
            closeModal(); S.viewTake = null; S.wiz = null; S.wizNew = false; await loadAdmin(); hooks.render(); toast("“" + r.name + "” deleted");
          } catch (e) { err.textContent = errText(e); }
        } })));
  });
}
