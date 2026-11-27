/* LSH on the warehouse device: record movements by document, staging, failed deliveries, undo and corrections,
   closing the day (Ops Manager) and explaining differences with SAP. Quantities are typed as cartons, boxes and packs
   with the product's pictures and stored in pcs. */
import { S, hooks, store } from "./state.js";
import { rpc } from "./api.js";
import { el, msg, toast, errText, openModal, closeModal, confirmBox, numPad } from "./ui.js";
import { svg, ICON } from "./count.js";
import { openScanner } from "./scan.js";
import { t } from "./i18n.js";
import { has, backRow, WH_ICON } from "./wh.js";

var PHOTOS = { "340019": ["ctn", "box", "pcs"], "340020": ["ctn", "box", "pcs"], "342208": ["ctn", "pcs"], "331117": ["ctn", "pcs"], "340905": ["pcs"] };
export function photo(code, u) { var p = PHOTOS[code]; if (!p) return null; if (u && p.indexOf(u) < 0) return null; return "assets/sku/" + code + "-" + (u || p[p.length - 1]) + ".webp"; }
function thumb(code, cls) { var u = photo(code); return u ? el("img", { class: cls || "wh-th", src: u, alt: "", loading: "lazy" }) : el("span", { class: (cls || "wh-th") + " code", text: code }); }
function sku(code) { return (S.skuIndex && S.skuIndex[code]) || (S.skus || []).find(function (s) { return s.code === code; }) || { code: code, desc: "" }; }
export function ctnOf(code, pcs) { var s = sku(code); return s.per ? pcs / s.per : null; }
export function fmtCtn(code, pcs) {
  var s = sku(code); if (pcs == null) return "";
  if (!s.per) return pcs.toLocaleString("en-MY") + " pcs";
  var c = Math.trunc(pcs / s.per), r = Math.round(pcs - c * s.per);
  return (c ? c.toLocaleString("en-MY") + " " + t("ctn") : "") + (r ? (c ? " " : "") + r + " pcs" : c ? "" : "0 " + t("ctn"));
}
function hhmm(ts) { return ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : ""; }
function ageTxt(ts) { if (!ts) return ""; var h = Math.floor((Date.now() - new Date(ts)) / 3600000); return h >= 48 ? t("ageDays", { d: Math.floor(h / 24) }) : t("age", { h: h }); }
function go(view) { S.wh.view = view; hooks.render(); window.scrollTo(0, 0); }

export async function loadLsh() {
  if (!S.wh || !S.wh.token) return;
  try { S.wh.lsh = await rpc("lsh_today", { p_token: S.wh.token }); }
  catch (e) { if (e.code === "AUTH" && hooks.whSignOut) hooks.whSignOut(); else throw e; }
}
async function act(fn, okMsg) {
  try { var r = await fn(); if (okMsg) toast(okMsg); await loadLsh(); hooks.render(); return r; }
  catch (e) { msg("Can't save", e.code === "OFFLINE" ? t("offline") : errText(e)); throw e; }
}

/* ---------- stock home ---------- */
export function renderStock(app) {
  var w = S.wh, L = w.lsh, v = w.view;
  if (!L) { if (!w.lshLoading) { w.lshLoading = true; loadLsh().then(hooks.render, function (e) { msg("Can't load", errText(e)); }).finally(function () { w.lshLoading = false; }); } app.append(el("div", { class: "center muted", text: "…" })); return; }
  if (!L.enabled) { app.append(el("div", { class: "card muted", text: t("noLsh") })); return; }
  if (v === "pick") return renderPick(app);
  if (v === "form") return renderForm(app);
  if (v === "staging") return renderStaging(app);
  if (v === "inv") return renderInvoice(app);
  if (v === "entries") return renderEntries(app, true);
  if (v === "close" && has(["om"])) return renderClose(app);
  if (v === "approve" && has(["om"])) return renderApprove(app);
  if (v === "diffs" && has(["om"])) return renderDiffs(app);
  var tot = { gs: 0, stg: 0, bs: 0 }, raw = { gs: 0, stg: 0, bs: 0 };
  Object.keys(L.byCode || {}).forEach(function (c) { var a = L.byCode[c]; ["gs", "stg", "bs"].forEach(function (k) { if (a[k]) { var x = ctnOf(c, a[k]); if (x != null) tot[k] += x; else raw[k] += a[k]; } }); });
  var stg = L.staging || [];
  app.append(el("div", { class: "wh-tiles" },
    tile(t("good"), tot.gs, raw.gs, ""), tile(t("staging"), tot.stg, raw.stg, "warn", stg.length + " inv", function () { go("staging"); }), tile(t("bad"), tot.bs, raw.bs, "bad")));
  var dr = store(draftKey());
  if (dr && dr.type) app.append(el("div", { class: "card", style: "border-color:var(--warn)" }, el("b", { text: t("unsaved") + ": " + t("t_" + dr.type) + (dr.doc ? " · " + dr.doc : "") }),
    el("div", { class: "row", style: "gap:8px;margin-top:8px" }, el("button", { class: "btn", style: "flex:1", text: t("discard"), onclick: function () { w.form = null; store(draftKey(), null); hooks.render(); } }),
      el("button", { class: "btn primary", style: "flex:2", text: t("continueEntry"), onclick: function () { w.form = dr; go("form"); } }))));
  app.append(el("button", { class: "btn primary block big1", onclick: function () { go("pick"); } }, svg('<path d="M12 5v14M5 12h14"/>', 20), t("recordMove")));
  var late = stg.filter(function (x) { return x.waiting > 0 && Date.now() - new Date(x.firstAt) > 864e5; }).length;
  var list = el("div", { class: "card wh-list", style: "margin-top:12px;padding:0" });
  list.append(row(t("stagingTitle"), stg.length + " inv" + (late ? " · " + late + " > 24 h" : ""), function () { go("staging"); }, late ? "bad" : ""));
  list.append(row(t("entriesToday"), String((L.entries || []).length), function () { go("entries"); }));
  if (has(["om"])) {
    var pend = (L.pending || []).filter(function (x) { return !x.mine && !x.byOm; }).length, open = (L.diffs || []).filter(function (d) { return d.status === "open"; }).length;
    list.append(row(t("toApprove"), String(pend), function () { go("approve"); }, pend ? "warn" : ""));
    list.append(row(t("diffTitle"), String(open), function () { go("diffs"); }, open ? "warn" : ""));
    list.append(row(t("closeTitle"), L.todayClosed ? t("dayClosed", { t: hhmm(L.closedAt) }) : L.cutoff, function () { go("close"); }));
  }
  app.append(list);
  renderEntries(app, false);
}
function tile(label, c, raw, tone, sub, onclick) {
  var n = Math.round(c).toLocaleString("en-MY") + (raw ? " +" + raw + " pcs" : "");
  return el(onclick ? "button" : "div", { class: "wh-tile " + (tone || ""), onclick: onclick }, el("span", { class: "small", style: "font-weight:700", text: label }), el("b", { text: n }), el("span", { class: "small", text: t("ctn") + (sub ? " · " + sub : "") }));
}
function row(a, b, fn, tone) { return el("button", { class: "wh-row", onclick: fn }, el("b", { text: a }), el("span", { class: "wh-due " + (tone || ""), text: b }), svg(ICON.next, 16)); }

/* ---------- pick a movement ---------- */
function renderPick(app) {
  var TYPES = [["receive", WH_ICON.truck], ["invoice", WH_ICON.box], ["load", WH_ICON.truck], ["fail_back", WH_ICON.undo], ["return", WH_ICON.undo], ["to_bs", WH_ICON.alert], ["transfer_out", WH_ICON.truck]];
  app.append(backRow(function () { go(""); }, t("recordMove")));
  var g = el("div", { class: "wh-types" });
  TYPES.forEach(function (x) {
    g.append(el("button", { class: "wh-type", onclick: function () { if (x[0] === "load") return go("staging"); startForm(x[0]); } },
      el("span", { class: "wh-ic" }, svg(x[1], 22)), el("b", { text: t("t_" + x[0]) }), el("span", { class: "small muted", text: t("s_" + x[0]) })));
  });
  app.append(g);
}

/* ---------- the entry form: document, SKUs, check, save ---------- */
function draftKey() { return "mw-draft-" + (S.wh.person && S.wh.person.id); }
function saveDraft() { store(draftKey(), S.wh.form || null); }
export function startForm(type, preset) {
  S.wh.form = Object.assign({ type: type, doc: "", ref: "", reason: "", note: "", lines: [], step: "doc" }, preset || {});
  saveDraft(); go("form");
}
function renderForm(app) {
  var w = S.wh, f = w.form || store(draftKey());
  if (!f) return go("pick");
  w.form = f;
  app.append(backRow(function () { if (f.step === "lines" && f.type !== "reversal" && f.type !== "redeliver") { f.step = "doc"; saveDraft(); hooks.render(); } else { w.form = null; saveDraft(); go(f.type === "reversal" || f.type === "redeliver" ? "staging" : "pick"); } }, t("t_" + f.type)));
  if (f.step === "doc") return formDoc(app, f);
  formLines(app, f);
}
function field(label, input) { return el("label", { class: "wh-field" }, el("span", { text: label }), input); }
function formDoc(app, f) {
  var doc = el("input", { value: f.doc, inputmode: f.type === "to_bs" ? "text" : "numeric", autocomplete: "off", placeholder: "", oninput: function () { f.doc = doc.value.trim(); saveDraft(); } });
  var err = el("div", { class: "wh-pinerr", role: "alert" });
  app.append(field(t("doc_" + f.type), doc));
  var note;
  if (f.type === "to_bs") { note = el("input", { value: f.note, oninput: function () { f.note = note.value; saveDraft(); } }); app.append(field(t("note"), note)); }
  app.append(err, el("button", { class: "btn primary block big1", text: t("next"), onclick: async function (e) {
    f.doc = doc.value.trim();
    if (f.type === "to_bs" ? !(f.doc || (f.note || "").trim()) : !f.doc) { err.textContent = t("doc_" + f.type); doc.focus(); return; }
    if (f.type === "fail_back") {
      var b = e.currentTarget; b.disabled = true;
      try {
        var rows = await rpc("lsh_invoice", { p_token: S.wh.token, p_doc: f.doc });
        var can = rows.filter(function (r) { return r.canFail > 0; });
        if (!can.length) { err.textContent = t("nothingOut"); b.disabled = false; return; }
        f.max = {}; f.lines = can.map(function (r) { f.max[r.code] = r.canFail; return { code: r.code, qty: 0 }; });
      } catch (x) { err.textContent = errText(x); b.disabled = false; return; }
    }
    f.step = "lines"; saveDraft(); hooks.render(); window.scrollTo(0, 0);
  } }));
  setTimeout(function () { doc.focus(); }, 60);
}
function formLines(app, f) {
  var fixed = f.type === "fail_back" || f.type === "reversal" || f.type === "redeliver";
  app.append(el("div", { class: "wh-docline" }, el("span", { class: "small muted", text: t("doc_" + f.type) }), el("b", { text: f.doc || "-" })));
  if (f.type === "reversal") {
    var ref = el("input", { value: f.ref, inputmode: "numeric", oninput: function () { f.ref = ref.value.trim(); saveDraft(); } });
    app.append(field(t("refNo"), ref));
  }
  if (f.type === "fail_back") {
    app.append(el("h3", { class: "sect", text: t("why") }));
    var rg = el("div", { class: "wh-reasons" });
    ["outlet_closed", "refused", "wrong_item", "no_time", "other"].forEach(function (r) {
      rg.append(el("button", { class: "big" + (f.reason === r ? " on" : ""), "aria-pressed": String(f.reason === r), text: t("r_" + r), onclick: function () { f.reason = r; saveDraft(); hooks.render(); } }));
    });
    app.append(rg);
  }
  app.append(el("h3", { class: "sect", text: fixed ? t("invoiceLines") : t("lines") }));
  var list = el("div", { class: "card wh-list", style: "padding:0" });
  if (!f.lines.length) list.append(el("div", { class: "muted", style: "padding:14px", text: t("noLines") }));
  f.lines.forEach(function (l, i) {
    var s = sku(l.code);
    var r = el("div", { class: "wh-line" }, thumb(l.code),
      el("div", { class: "wh-tx" }, el("b", { text: s.desc || l.code }), el("span", { class: "small muted", text: l.code + (fixed && f.max ? " · " + t("maxOut", { n: fmtCtn(l.code, f.max[l.code]) }) : "") })),
      el("button", { class: "wh-qty" + (l.qty ? "" : " zero"), text: l.qty ? fmtCtn(l.code, l.qty) : "0", onclick: function () { qtySheet(l.code, l.qty, fixed && f.max ? f.max[l.code] : null, function (q) { l.qty = q; saveDraft(); hooks.render(); }); } }));
    if (!fixed) r.append(el("button", { class: "iconbtn", "aria-label": "Remove", onclick: function () { f.lines.splice(i, 1); saveDraft(); hooks.render(); } }, svg(ICON.close, 18)));
    list.append(r);
    if (f.type === "receive") list.append(el("label", { class: "wh-toggle" }, el("input", { type: "checkbox", checked: l.area === "bs", onchange: function (e) { l.area = e.target.checked ? "bs" : "gs"; saveDraft(); } }), el("span", { text: t("damaged") })));
    if (f.type === "return") {
      var tg = el("div", { class: "wh-seg" });
      [["bs", t("badCond")], ["gs", t("goodCond")]].forEach(function (o) { tg.append(el("button", { class: (l.area || "bs") === o[0] ? "on" : "", text: o[1], onclick: function () { l.area = o[0]; saveDraft(); hooks.render(); } })); });
      list.append(el("div", { style: "padding:0 14px 10px" }, tg));
    }
  });
  app.append(list);
  if (!fixed) app.append(el("div", { class: "row", style: "gap:8px;margin-top:10px" },
    el("button", { class: "btn", style: "flex:1", onclick: function () { scanAdd(f); } }, svg('<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M11 8v8M15 8v8"/>', 18), " " + t("scan")),
    el("button", { class: "btn", style: "flex:1", text: "+ " + t("addSku"), onclick: function () { pickSku(f); } })));
  var note = el("input", { value: f.type === "to_bs" ? "" : f.note, oninput: function () { f.note = note.value; saveDraft(); } });
  if (f.type !== "to_bs") app.append(el("div", { style: "margin-top:10px" }, field(t("noteOpt"), note)));
  var lines = f.lines.filter(function (l) { return l.qty > 0; });
  var tot = lines.reduce(function (a, l) { var c = ctnOf(l.code, l.qty); return a + (c || 0); }, 0);
  var ok = lines.length && (f.type !== "fail_back" || f.reason) && (f.type !== "reversal" || f.ref);
  var btn = el("button", { class: "btn primary block big1", disabled: !ok, text: t("saveEntry") + (lines.length ? " · " + lines.length + " SKU · " + (Math.round(tot * 10) / 10).toLocaleString("en-MY") + " " + t("ctn") : ""), onclick: function () { saveForm(f, btn); } });
  app.append(el("div", { style: "height:12px" }), btn);
}
async function saveForm(f, btn) {
  var lines = f.lines.filter(function (l) { return l.qty > 0; }).map(function (l) { return { code: l.code, qty: l.qty, area: l.area || (f.type === "return" ? "bs" : "gs") }; });
  btn.disabled = true;
  try {
    var r = await rpc("lsh_add", { p_token: S.wh.token, p: { type: f.type, doc: f.doc, ref: f.ref, reason: f.reason, note: f.note, lines: lines } });
    S.wh.form = null; saveDraft();
    if (r.negative && r.negative.length) msg(t("saved"), t("negWarn", { c: r.negative.map(function (x) { return x.code; }).join(", ") }));
    else toast("✓ " + t("saved"));
    await loadLsh(); go("");
  } catch (e) { btn.disabled = false; msg("Can't save", e.code === "OFFLINE" ? t("offline") : errText(e)); }
}

/* ---------- picking a SKU: scan or search ---------- */
function addLine(f, code, uom) {
  var ex = f.lines.find(function (l) { return l.code === code; });
  qtySheet(code, ex ? ex.qty : 0, null, function (q) { if (ex) ex.qty = q; else f.lines.push({ code: code, qty: q, area: f.type === "return" ? "bs" : "gs" }); saveDraft(); hooks.render(); }, uom);
}
function scanAdd(f) {
  S.scanHook = function (bc) {
    S.scanHook = null;
    var m = S.barcodes[bc];
    if (m && m.alts && m.alts.length > 1) pickSku(f);
    else if (m && m.code) addLine(f, m.code, m.uom);
    else msg(t("scan"), "Barcode " + bc + " is not in the master. Search the SKU instead.");
  };
  openScanner();
}
function pickSku(f) {
  openModal(function (sh) {
    var q = el("input", { type: "search", placeholder: t("search"), autocomplete: "off" }), res = el("div", { class: "wh-results" });
    function draw() {
      var s = q.value.trim().toLowerCase(); res.innerHTML = "";
      (S.skus || []).filter(function (x) { return !s || x.code.toLowerCase().indexOf(s) >= 0 || (x.desc || "").toLowerCase().indexOf(s) >= 0; }).slice(0, 40).forEach(function (x) {
        res.append(el("button", { class: "wh-line", onclick: function () { closeModal(); addLine(f, x.code); } }, thumb(x.code), el("div", { class: "wh-tx" }, el("b", { text: x.desc || x.code }), el("span", { class: "small muted", text: x.code }))));
      });
    }
    q.addEventListener("input", draw); draw();
    sh.append(el("h3", { text: t("addSku") }), q, res, el("button", { class: "btn block", style: "margin-top:10px", text: t("cancel"), onclick: closeModal }));
    setTimeout(function () { q.focus(); }, 60);
  });
}

/* ---------- quantity: cartons, boxes, packs, with pictures ---------- */
export function qtySheet(code, start, max, onOk) {
  var s = sku(code), per = Number(s.per) || 0, pb = Number(s.perBox) || 0, total = Number(start) || 0;
  var v = { ctn: per ? Math.trunc(total / per) : 0 }; var rest = total - v.ctn * per;
  v.box = pb ? Math.trunc(rest / pb) : 0; v.pcs = rest - v.box * pb;
  openModal(function (sh) {
    var err = el("div", { class: "wh-pinerr", role: "alert" }), tot = el("b", { class: "wh-total" });
    function pcs() { return v.ctn * per + v.box * pb + v.pcs; }
    function draw() { var p = pcs(); tot.textContent = fmtCtn(code, p) + (per ? " · " + p.toLocaleString("en-MY") + " pcs" : ""); err.textContent = max != null && p > max ? t("maxOut", { n: fmtCtn(code, max) }) : ""; }
    var head = el("div", { class: "wh-skuhead" }, thumb(code, "wh-th big"), el("div", {}, el("b", { text: s.desc || code }), el("div", { class: "small muted", text: code + (per ? " · 1 " + t("ctn") + " = " + (pb ? per / pb + " " + t("boxes").toLowerCase() + " = " : "") + per + " pcs" : "") })));
    sh.append(head);
    [["ctn", t("cartons"), per], ["box", t("boxes"), pb], ["pcs", t("packs"), 1]].forEach(function (u) {
      if (!u[2]) return;
      var n = el("button", { class: "wh-n", text: String(v[u[0]]), onclick: function () { numPad(u[1], v[u[0]] || null, function (x) { v[u[0]] = Math.max(0, Math.round(x || 0)); n.textContent = String(v[u[0]]); draw(); }); } });
      var img = photo(code, u[0]);
      sh.append(el("div", { class: "wh-unit" }, img ? el("img", { src: img, alt: u[1], class: "wh-uimg" }) : el("span", { class: "wh-uimg none" }),
        el("b", { style: "flex:1", text: u[1] }),
        el("button", { class: "wh-step", "aria-label": "Less " + u[1], onclick: function () { v[u[0]] = Math.max(0, v[u[0]] - 1); n.textContent = String(v[u[0]]); draw(); } }, "−"), n,
        el("button", { class: "wh-step plus", "aria-label": "More " + u[1], onclick: function () { v[u[0]]++; n.textContent = String(v[u[0]]); draw(); } }, "+")));
    });
    sh.append(el("div", { class: "wh-kv", style: "margin-top:8px" }, el("span", { text: t("total") }), tot), err,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: t("cancel"), onclick: closeModal }),
        el("button", { class: "btn primary", style: "flex:2", text: "OK", onclick: function () { var p = pcs(); if (max != null && p > max) return; closeModal(); onOk(p); } })));
    draw();
  });
}

/* ---------- staging ---------- */
function renderStaging(app) {
  var w = S.wh, L = w.lsh, sel = w.stgSel || (w.stgSel = {});
  app.append(backRow(function () { w.stgSel = {}; go(""); }, t("stagingTitle")));
  app.append(el("div", { class: "wh-note", text: t("stagingSub") }));
  var wait = (L.staging || []).filter(function (x) { return x.waiting > 0; }), back = (L.staging || []).filter(function (x) { return x.failed > 0; });
  app.append(el("h3", { class: "sect", text: t("waitingLoad") + " · " + wait.length }));
  if (wait.length) app.append(el("p", { class: "small muted", style: "margin:0 0 6px", text: t("tickInvoices") }));
  var list = el("div", { class: "card wh-list", style: "padding:0" });
  wait.forEach(function (x) {
    var late = Date.now() - new Date(x.firstAt) > 864e5;
    list.append(el("div", { class: "wh-line" },
      el("input", { type: "checkbox", class: "wh-chk", checked: !!sel[x.doc], "aria-label": "Invoice " + x.doc, onchange: function (e) { if (e.target.checked) sel[x.doc] = 1; else delete sel[x.doc]; hooks.render(); } }),
      el("button", { class: "wh-tx link0", onclick: function () { w.inv = x.doc; go("inv"); } }, el("b", { text: "INV " + x.doc }), el("span", { class: "small muted", text: x.lines.filter(function (l) { return l.waiting > 0; }).length + " SKU" })),
      el("span", { class: "wh-due " + (late ? "bad" : ""), text: ageTxt(x.firstAt) })));
  });
  if (!wait.length) list.append(el("div", { class: "muted", style: "padding:14px", text: "—" }));
  app.append(list);
  var n = Object.keys(sel).filter(function (d) { return wait.some(function (x) { return x.doc === d; }); });
  if (wait.length) app.append(el("button", { class: "btn primary block big1", style: "margin-top:10px", disabled: !n.length, text: t("loadSel", { n: n.length }), onclick: function (e) {
    var b = e.currentTarget; confirmBox(t("t_load"), n.map(function (d) { return "INV " + d; }).join("\n"), t("t_load"), async function () {
      b.disabled = true; try { await act(function () { return rpc("lsh_load", { p_token: w.token, p_docs: n }); }, "✓ " + t("saved")); w.stgSel = {}; hooks.render(); } catch (x) { b.disabled = false; }
    });
  } }));
  app.append(el("h3", { class: "sect", text: t("cameBack") + " · " + back.length }));
  var bl = el("div", { class: "card wh-list", style: "padding:0" });
  back.forEach(function (x) {
    bl.append(el("button", { class: "wh-line", onclick: function () { w.inv = x.doc; go("inv"); } }, el("div", { class: "wh-tx" }, el("b", { text: "INV " + x.doc }), el("span", { class: "small muted", text: t("r_" + (x.reason || "other")) })),
      el("span", { class: "wh-due warn", text: t("waitingRev") }), svg(ICON.next, 16)));
  });
  if (!back.length) bl.append(el("div", { class: "muted", style: "padding:14px", text: "—" }));
  app.append(bl);
}
function renderInvoice(app) {
  var w = S.wh, x = (w.lsh.staging || []).find(function (s) { return s.doc === w.inv; });
  app.append(backRow(function () { go("staging"); }, "INV " + w.inv));
  if (!x) { app.append(el("div", { class: "card muted", text: "—" })); return; }
  var list = el("div", { class: "card wh-list", style: "padding:0" });
  x.lines.forEach(function (l) {
    var s = sku(l.code);
    list.append(el("div", { class: "wh-line" }, thumb(l.code), el("div", { class: "wh-tx" }, el("b", { text: s.desc || l.code }), el("span", { class: "small muted", text: l.code })),
      el("div", { style: "text-align:right" }, l.waiting ? el("div", { class: "small", text: t("waitingLoad") + ": " + fmtCtn(l.code, l.waiting) }) : null, l.failed ? el("div", { class: "small", style: "color:var(--warn);font-weight:700", text: t("cameBack") + ": " + fmtCtn(l.code, l.failed) }) : null)));
  });
  app.append(list);
  if (x.failed > 0) {
    var max = {}; x.lines.forEach(function (l) { if (l.failed > 0) max[l.code] = l.failed; });
    var preset = function () { return { doc: x.doc, step: "lines", max: max, lines: x.lines.filter(function (l) { return l.failed > 0; }).map(function (l) { return { code: l.code, qty: l.failed }; }) }; };
    app.append(el("div", { class: "row", style: "gap:8px;margin-top:12px" },
      el("button", { class: "btn primary", style: "flex:1", text: t("t_reversal"), onclick: function () { startForm("reversal", preset()); } }),
      el("button", { class: "btn", style: "flex:1", text: t("t_redeliver"), onclick: function () { startForm("redeliver", preset()); } })));
  }
  if (x.waiting > 0) app.append(el("button", { class: "btn block", style: "margin-top:8px", text: t("t_load"), onclick: function () { w.stgSel = {}; w.stgSel[x.doc] = 1; go("staging"); } }));
}

/* ---------- entries: undo for 10 minutes, then a correction ---------- */
function renderEntries(app, full) {
  var w = S.wh, L = w.lsh, list = (L.entries || []).slice(0, full ? 200 : 4);
  if (full) app.append(backRow(function () { go(""); }, t("entriesToday")));
  else app.append(el("div", { class: "row", style: "justify-content:space-between;align-items:baseline;margin-top:14px" }, el("h3", { style: "margin:0", text: t("entriesToday") }), (L.entries || []).length > 4 ? el("button", { class: "link", text: t("seeAll"), onclick: function () { go("entries"); } }) : null));
  var box = el("div", { class: "card wh-list", style: "padding:0" });
  if (!list.length) box.append(el("div", { class: "muted", style: "padding:14px", text: t("noEntries") }));
  list.forEach(function (e) {
    var first = e.lines[0] || {}, more = e.lines.length > 1 ? " +" + (e.lines.length - 1) : "";
    var r = el("div", { class: "wh-line" + (e.status !== "ok" ? " dim" : "") }, thumb(first.code),
      el("div", { class: "wh-tx" }, el("b", { text: t("t_" + e.type) + (e.doc ? " · " + e.doc : "") }),
        el("span", { class: "small muted", text: hhmm(e.at) + " · " + t("by", { n: e.by }) + " · " + (sku(first.code).desc || first.code) + more + (e.status === "undone" ? " · " + t("undone") : e.status === "pending" ? " · pending" : e.status === "rejected" ? " · rejected" : "") })),
      el("b", { class: "small", text: fmtCtn(first.code, first.qty) }));
    if (full && e.status === "ok" && e.canUndo) r.append(el("button", { class: "btn", style: "padding:6px 10px;min-height:36px", text: t("undo"), onclick: function () { confirmBox(t("undo") + "?", t("t_" + e.type) + " " + (e.doc || ""), t("undo"), function () { act(function () { return rpc("lsh_undo", { p_token: w.token, p_entry: e.entry }); }, t("undone")); }); } }));
    else if (full && e.status === "ok" && e.type !== "reset" && e.type !== "correction") r.append(el("button", { class: "btn", style: "padding:6px 10px;min-height:36px", text: t("askFix"), onclick: function () { askFix(e); } }));
    box.append(r);
  });
  app.append(box);
}
function askFix(e, nq0, why0) {
  var nq = nq0 || {}; if (!nq0) e.lines.forEach(function (l) { nq[l.code + "|" + l.from + "|" + l.to] = l.qty; });
  openModal(function (sh) {
    var why = el("input", { placeholder: t("fixWhy"), value: why0 || "" }), err = el("div", { class: "wh-pinerr" });
    sh.append(el("h3", { text: t("askFix") }), el("p", { class: "small muted", text: t("t_" + e.type) + " · " + (e.doc || "") + " · " + hhmm(e.at) }));
    e.lines.forEach(function (l) {
      var k = l.code + "|" + l.from + "|" + l.to, b = el("button", { class: "wh-qty", text: fmtCtn(l.code, nq[k]), onclick: function () { var w0 = why.value; closeModal(); qtySheet(l.code, nq[k], null, function (q) { nq[k] = q; askFix(e, nq, w0); }); } });
      sh.append(el("div", { class: "wh-line" }, thumb(l.code), el("div", { class: "wh-tx" }, el("b", { text: sku(l.code).desc || l.code }), el("span", { class: "small muted", text: "was " + fmtCtn(l.code, l.qty) })), b));
    });
    sh.append(why, err, el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: t("cancel"), onclick: closeModal }),
      el("button", { class: "btn primary", style: "flex:2", text: t("save"), onclick: async function () {
        if (!why.value.trim()) { err.textContent = t("fixWhy"); return; }
        var lines = [];
        e.lines.forEach(function (l) {
          var d = nq[l.code + "|" + l.from + "|" + l.to] - l.qty; if (!d) return;
          if (["gs", "stg", "bs"].indexOf(l.to) >= 0) lines.push({ code: l.code, qty: d, area: l.to });
          if (["gs", "stg", "bs"].indexOf(l.from) >= 0) lines.push({ code: l.code, qty: -d, area: l.from });
        });
        if (!lines.length) { err.textContent = "Change a quantity first"; return; }
        closeModal(); act(function () { return rpc("lsh_correct", { p_token: S.wh.token, p: { fixes: e.entry, reason: why.value.trim(), doc: e.doc, lines: lines } }); }, t("fixSent"));
      } })));
  });
}

/* ---------- Ops Manager: close, approve, differences ---------- */
function renderClose(app) {
  var w = S.wh, L = w.lsh, wn = L.warnings || {};
  app.append(backRow(function () { go(""); }, t("closeTitle")));
  if (L.todayClosed) { app.append(el("div", { class: "card center" }, el("h2", { text: "✓ " + t("dayClosed", { t: hhmm(L.closedAt) }) }), el("p", { class: "muted", text: L.closedBy || "" }))); return; }
  var tot = { gs: 0, stg: 0, bs: 0 };
  Object.keys(L.byCode || {}).forEach(function (c) { var a = L.byCode[c]; ["gs", "stg", "bs"].forEach(function (k) { tot[k] += ctnOf(c, a[k] || 0) || 0; }); });
  app.append(el("div", { class: "card" }, el("b", { text: t("closingStock") }),
    el("div", { class: "wh-kv" }, el("span", { text: t("good") }), el("b", { text: Math.round(tot.gs).toLocaleString("en-MY") + " " + t("ctn") })),
    el("div", { class: "wh-kv" }, el("span", { text: t("bad") }), el("b", { text: Math.round(tot.bs).toLocaleString("en-MY") + " " + t("ctn") })),
    el("div", { class: "wh-kv", style: "color:var(--warn)" }, el("span", { text: t("staging") }), el("b", { text: Math.round(tot.stg).toLocaleString("en-MY") + " " + t("ctn") }))));
  var ck = el("div", { class: "card", style: "padding:0" });
  function c(ok, a) { ck.append(el("div", { class: "wh-line" }, el("span", { style: "color:" + (ok ? "var(--ok)" : "var(--warn)") }, svg(ok ? WH_ICON.check : WH_ICON.alert, 18)), el("span", { class: "wh-tx", text: a }))); }
  c(!wn.stgOld, wn.stgOld ? t("stgLateSub", { n: wn.stgOld }) : t("stgLate") + ": 0");
  c(!wn.failedWaiting, wn.failedWaiting ? t("failedWaitSub", { n: wn.failedWaiting }) : t("failedWait") + ": 0");
  c(!wn.pending, t("toApprove") + ": " + (wn.pending || 0));
  app.append(ck, el("p", { class: "small muted", text: t("closeWarn") }));
  var fb = (L.staging || []).filter(function (x) { return x.failed > 0; });
  if (fb.length) app.append(el("button", { class: "btn block", text: t("copyList"), onclick: function () {
    var txt = "LSH " + L.branch + " " + L.today + "\n" + t("failedWait") + ":\n" + fb.map(function (x) { return "- INV " + x.doc + " (" + t("r_" + (x.reason || "other")) + ")"; }).join("\n");
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { toast(t("copied")); }, function () { msg(t("copyList"), txt); });
  } }));
  app.append(el("button", { class: "btn primary block big1", style: "margin-top:10px", text: t("closeBtn"), onclick: function () { pinConfirm(t("closePin"), 6, async function (pin) {
    await act(function () { return rpc("lsh_close_day", { p_token: w.token, p_pin: pin }); }, t("closedOk")); go("");
  }); } }));
}
function pinConfirm(title, n, fn) {
  var v = "";
  openModal(function (sh) {
    var dots = el("div", { class: "wh-dots" }), err = el("div", { class: "wh-pinerr" });
    function draw() { dots.innerHTML = ""; for (var i = 0; i < n; i++) dots.append(el("span", { class: i < v.length ? "on" : "" })); }
    var pad = el("div", { class: "pad wh-pad" });
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].forEach(function (k) {
      if (!k) { pad.append(el("span")); return; }
      pad.append(el("button", { text: k, onclick: async function () {
        if (k === "⌫") v = v.slice(0, -1); else if (v.length < n) v += k; draw(); err.textContent = "";
        if (v.length === n) { var p = v; v = ""; try { closeModal(); await fn(p); } catch (e) { } }
      } }));
    });
    sh.append(el("h3", { text: title }), dots, err, pad, el("button", { class: "btn block", style: "margin-top:10px", text: t("cancel"), onclick: closeModal }));
    draw();
  });
}
function lineTxt(l) { var sign = l.from === "in" ? "+" : l.to === "out" ? "−" : ""; var a = l.from === "in" ? l.to : l.to === "out" ? l.from : l.from + "→" + l.to; return sign + fmtCtn(l.code, l.qty) + " " + (a === "gs" ? t("good") : a === "bs" ? t("bad") : a === "stg" ? t("staging") : a) + " · " + (sku(l.code).desc || l.code); }
function renderApprove(app) {
  var w = S.wh, L = w.lsh, list = (L.pending || []).filter(function (x) { return !x.mine && !x.byOm; });
  app.append(backRow(function () { go(""); }, t("toApprove")));
  if (!list.length) app.append(el("div", { class: "card muted", text: "—" }));
  list.forEach(function (p) {
    app.append(el("div", { class: "card" }, el("b", { text: p.by + " · " + hhmm(p.at) }), el("p", { style: "margin:4px 0 8px", text: "“" + (p.reason || "") + "”" }),
      el("div", {}, p.lines.map(function (l) { return el("div", { class: "small", text: lineTxt(l) }); })),
      el("div", { class: "row", style: "gap:8px;margin-top:10px" },
        el("button", { class: "btn", style: "flex:1", text: t("reject"), onclick: function () { pinGate(function () { return rpc("lsh_decide", { p_token: w.token, p_entry: p.entry, p_ok: false }); }); } }),
        el("button", { class: "btn primary", style: "flex:1", text: t("approve"), onclick: function () { pinGate(function () { return rpc("lsh_decide", { p_token: w.token, p_entry: p.entry, p_ok: true }); }); } }))));
  });
}
function pinGate(fn) { act(fn, "✓ " + t("saved")); }
function renderDiffs(app) {
  var w = S.wh, L = w.lsh, list = L.diffs || [];
  app.append(backRow(function () { go(""); }, t("diffTitle")));
  if (L.reconDay) app.append(el("p", { class: "small muted", text: t("diffSub", { d: L.reconDay, t: L.cutoff }) }));
  if (!list.length) app.append(el("div", { class: "card muted", text: "—" }));
  list.forEach(function (d) {
    var card = el("div", { class: "card" }, el("div", { class: "wh-line", style: "padding:0;border:0" }, thumb(d.code), el("div", { class: "wh-tx" }, el("b", { text: d.descr || d.code }), el("span", { class: "small muted", text: d.code + " · " + t("area_" + d.area) })),
      el("span", { class: "wh-due " + (d.status === "open" ? "bad" : "warn"), text: d.status === "open" ? "open" : t("explained") })),
      el("div", { class: "wh-cmp" }, el("span", {}, t("lsh"), el("b", { text: fmtCtn(d.code, d.lsh) })), el("span", {}, t("sap"), el("b", { text: fmtCtn(d.code, d.sap) })), el("span", {}, t("diff"), el("b", { text: (d.diff > 0 ? "+" : d.diff < 0 ? "−" : "") + fmtCtn(d.code, Math.abs(d.diff)) }))));
    if (d.reason) card.append(el("p", { class: "small", style: "margin:6px 0 0", text: t("rs_" + d.reason) + (d.note ? " · " + d.note : "") + (d.setBy ? " · " + d.setBy : "") }));
    var rg = el("div", { class: "wh-reasons", style: "margin-top:8px" });
    ["sap", "lsh_error", "not_recorded", "physical"].forEach(function (r) {
      rg.append(el("button", { class: "big" + (d.reason === r ? " on" : ""), onclick: function () {
        openModal(function (sh) {
          var n = el("input", { placeholder: t("noteOpt"), value: d.note || "" });
          sh.append(el("h3", { text: t("rs_" + r) }), el("p", { class: "small muted", text: t("rso_" + r) }), n,
            el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: t("cancel"), onclick: closeModal }),
              el("button", { class: "btn primary", style: "flex:2", text: t("save"), onclick: function () { closeModal(); act(function () { return rpc("lsh_reason", { p_token: w.token, p_branch: L.branch, p_day: L.reconDay, p_code: d.code, p_area: d.area, p_reason: r, p_note: n.value }); }, "✓ " + t("saved")); } })));
        });
      } }, el("div", { text: t("rs_" + r) }), el("div", { class: "small muted", style: "font-weight:400", text: t("rso_" + r) })));
    });
    card.append(rg); app.append(card);
  });
}
