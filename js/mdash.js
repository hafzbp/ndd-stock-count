/* Dashboard tab, "Monthly stock take" view: live while counting is open, final recap after close.
   Everything comes from admin_load (S.adm, S.counts, S.sysBy) - refreshed every 20 s by app.js while open.
   Live:   where the warehouses are (stage bar + tiles), one card per warehouse (Ops / Finance progress, result,
           photos, last activity), biggest differences, needs attention, live activity.
   Detail: one warehouse - timeline, numbers, SKUs that differ, warehouse photos, actions.
   Closed: IRA by value, net difference, sign-off per warehouse (lowest accuracy first), download all as ZIP. */
import { S, hooks } from "./state.js";
import { rpc } from "./api.js";
import { el, fmt, msg, confirmBox, openModal, closeModal, errText, toast, saveBlob } from "./ui.js";
import { hasQty, sessRole } from "./pure.js";
import { loadAdmin, variance, currentTake, isSingle, tolPct, sendRecount } from "./master.js";
import { exportXlsx, signoffPdf, zipLib } from "./export.js";
import { listPhotos } from "./photos.js";
import { deleteCountsModal } from "./hqreset.js";
import { overlaps } from "./home.js";
import { renderDash } from "./hqdash.js";

var TARGET = 99.95, IDLE_MIN = 30;
function tok() { return S.admin.token; }
function hm(ts) { return ts ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts)) : "-"; }
function dhm(ts) { return ts ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts)) : "-"; }
function ago(ts) { if (!ts) return ""; var m = Math.round((Date.now() - new Date(ts)) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.floor(m / 60) + " h " + (m % 60) + " min ago"; }
function dur(from) { var m = Math.max(0, Math.round((Date.now() - new Date(from)) / 60000)); return (m >= 60 ? Math.floor(m / 60) + " h " : "") + (m % 60) + " min"; }
function rm(v, sign) { if (v == null || isNaN(v)) return "-"; var r = Math.round(v); return (r < 0 ? "-RM " : sign && r > 0 ? "+RM " : "RM ") + fmt(Math.abs(r), 0); }
function ira(v) { return v == null ? "-" : (Math.floor(v * 100) / 100).toFixed(2) + "%"; }
function last(list) { return list.reduce(function (a, x) { var t = x.submittedAt && x.status === "submitted" ? x.submittedAt : x.updatedAt; return t && (!a || t > a) ? t : a; }, null); }
function names(list) { var o = {}; list.forEach(function (d) { ((d.names && d.names.length) ? d.names : [d.member]).forEach(function (n) { if (n) o[n] = 1; }); }); return Object.keys(o).join(", "); }

var CSS = [
  ".md-switch{display:inline-flex;background:var(--chip);border-radius:12px;padding:4px;gap:4px;margin:0 0 14px}",
  ".md-switch button{border:0;background:transparent;border-radius:9px;padding:8px 14px;font-size:13.5px;color:var(--ink);cursor:pointer}",
  ".md-switch button.on{background:var(--card);box-shadow:0 1px 2px rgba(0,0,0,.14);font-weight:600}",
  ".md-head{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:flex-start;justify-content:space-between;margin-bottom:12px}",
  ".md-head h2{margin:0 0 4px}.md-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}",
  ".md-live{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--mute)}.md-live i{width:8px;height:8px;border-radius:50%;background:var(--ok);display:inline-block}",
  ".md-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.md-filters select{max-width:180px}",
  ".md-stage{display:flex;height:30px;border-radius:8px;overflow:hidden;gap:2px;margin:10px 0 8px}",
  ".md-stage i{display:flex;align-items:center;justify-content:center;font-style:normal;font-size:12.5px;font-weight:700;min-width:22px}",
  ".md-key{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--mute)}.md-key span{display:inline-flex;align-items:center;gap:6px}.md-key b{color:var(--ink)}",
  ".md-key em{width:10px;height:10px;border-radius:3px;display:inline-block}",
  ".md-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:12px}",
  ".md-tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.md-tile span{font-size:12px;color:var(--mute);display:block}",
  ".md-tile b{font-size:22px;display:block;margin:2px 0}.md-tile small{font-size:12px;color:var(--mute)}",
  ".md-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px;align-items:start}",
  ".md-wh{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:12px;padding:12px 14px;cursor:pointer;text-align:left;font:inherit;color:inherit;width:100%}",
  ".md-wh:hover{box-shadow:0 2px 10px rgba(0,0,0,.08)}.md-wh .top{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}",
  ".md-wh .nm{font-weight:700;font-size:15px}.md-bar{margin:6px 0}.md-bar .lb{display:flex;justify-content:space-between;font-size:12.5px;gap:8px}",
  ".md-bar .tr{height:8px;background:var(--chip);border-radius:99px;overflow:hidden;margin:3px 0 2px}.md-bar .tr i{display:block;height:100%;border-radius:99px}",
  ".md-bar .who{font-size:12px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".md-res{display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--line);margin-top:8px;padding-top:8px;font-size:13px}",
  ".md-foot{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--mute);margin-top:6px}",
  ".md-rows>div{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--line)}",
  ".md-rows>div:last-child{border-bottom:0}.md-rows .g{flex:1 1 220px;min-width:0}.md-rows .g b{display:block}.md-rows .g small{color:var(--mute)}",
  ".md-rows .nums{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;align-items:center}.md-rows .nums span{white-space:nowrap}.md-rows .nums em{font-style:normal;color:var(--mute);font-size:11.5px;margin-right:3px}",
  ".md-att>div{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)}.md-att>div:last-child{border-bottom:0}",
  ".md-att .g{flex:1 1 240px}.md-att small{color:var(--mute);display:block}",
  ".md-feed{list-style:none;margin:0;padding:0}.md-feed li{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px}.md-feed li:last-child{border-bottom:0}",
  ".md-feed time{color:var(--mute);width:44px;flex:none}",
  ".md-tl{display:flex;flex-wrap:wrap;gap:0;margin:6px 0 4px}.md-tl>div{flex:1 1 110px;min-width:100px;position:relative;padding-top:30px;font-size:12.5px}",
  ".md-tl>div:before{content:'';position:absolute;top:11px;left:0;right:0;height:2px;background:var(--line)}.md-tl>div.done:before{background:var(--ok)}",
  ".md-tl i{position:absolute;top:0;left:0;width:24px;height:24px;border-radius:50%;background:var(--chip);color:var(--mute);font-style:normal;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;z-index:1}",
  ".md-tl .done i{background:var(--ok);color:var(--card)}.md-tl .now i{background:var(--warn);color:var(--card)}.md-tl small{display:block;color:var(--mute)}",
  ".md-ph{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:6px 0 12px}",
  ".md-ph a{display:block;aspect-ratio:4/3;border-radius:8px;overflow:hidden;background:var(--chip)}.md-ph img{width:100%;height:100%;object-fit:cover;display:block}",
  ".md-flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:4px 0 12px}",
  ".md-flow>div{display:flex;gap:10px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}",
  ".md-flow i{flex:none;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-style:normal;font-weight:700;font-size:13px;background:var(--chip);color:var(--mute)}",
  ".md-flow .done i{background:var(--ok);color:var(--card)}.md-flow .now i{background:var(--accent);color:var(--card)}.md-flow small{display:block;color:var(--mute)}",
  ".md-back{border:0;background:none;color:var(--info);font:inherit;cursor:pointer;padding:0;margin-bottom:8px}",
  ".md-pos{color:var(--ok)}.md-neg{color:var(--bad)}.md-wn{color:var(--warn)}",
  "@media (max-width:640px){.md-tile b{font-size:19px}.md-grid{grid-template-columns:1fr}.md-stage{height:26px}}"
].join("");
function ensureCss() { if (!document.getElementById("md-css")) document.head.append(el("style", { id: "md-css", text: CSS })); }

/* ---------- stage of one warehouse ---------- */
var STAGE = {
  nos: { label: "Not started", short: "Not started", pill: "bad", bar: "var(--chip)", ink: "var(--ink)", edge: "var(--bad)", rank: 0 },
  diff: { label: "Ops and Finance differ", short: "Differ - send recount", pill: "warn", bar: "var(--warn)", ink: "var(--card)", edge: "var(--warn)", rank: 1 },
  rc: { label: "Recount", short: "Recount", pill: "warn", bar: "var(--warnbg)", ink: "var(--warn)", edge: "var(--warn)", rank: 2 },
  opsd: { label: "Ops submitted", short: "Waiting for Finance", pill: "info", bar: "var(--info)", ink: "var(--card)", edge: "var(--info)", rank: 3 },
  find: { label: "Finance submitted", short: "Waiting for Ops", pill: "info", bar: "var(--info)", ink: "var(--card)", edge: "var(--info)", rank: 3 },
  cnt: { label: "Counting", short: "Counting", pill: "info", bar: "var(--infobg)", ink: "var(--info)", edge: "var(--line)", rank: 4 },
  done: { label: "Done", short: "Done", pill: "ok", bar: "var(--ok)", ink: "var(--card)", edge: "var(--ok)", rank: 5 }
};
var STAGE_ORDER = ["nos", "cnt", "opsd", "find", "diff", "rc", "done"];

function codesOf(list, exp) { var o = {}; list.forEach(function (d) { Object.keys(d.lines || {}).forEach(function (k) { var l = d.lines[k]; if (hasQty(l) && (!exp || exp[l.code])) o[l.code] = 1; }); }); return Object.keys(o).length; }

export function whState(b) {
  var docs = (S.counts || []).filter(function (d) { return d.branch === b; }), sg = isSingle();
  var ops = docs.filter(function (d) { return sessRole(d) === "ops"; }), fin = docs.filter(function (d) { return sessRole(d) === "fin"; });
  var exp = {}, sysV = 0, sysQ = 0; (S.sysBy[b] || []).forEach(function (r) { if (r[2] > 0) exp[r[0]] = 1; sysV += r[2] * (r[3] || 0); sysQ += r[2]; });
  var nExp = Object.keys(exp).length, V = variance(b), lc = {}, net = 0, G = V.skuGroups || {};
  V.forEach(function (o) { if (o.status !== "NOT COUNTED") lc[o.status] = (lc[o.status] || 0) + 1; if (o.vv) net += o.vv; });
  var over = Object.keys(G).filter(function (c) { return /^OVER/.test(G[c].flag); }).length;
  var sub = function (l) { return l.length && l.every(function (d) { return d.status === "submitted"; }); };
  var opsSub = sub(ops), finSub = sub(fin), rc = ((S.adm.recount || {})[b] || []).length, diffN = lc.RECOUNT || 0;
  var st;
  if (!docs.length) st = "nos";
  else if (sg) st = sub(docs) && !diffN ? "done" : "cnt";
  else if (opsSub && finSub) st = diffN || lc["WAITING OPS"] || lc["WAITING FINANCE"] ? "diff" : "done";
  else if (rc) st = "rc";
  else if (opsSub && !fin.length) st = "opsd";
  else if (finSub && !ops.length) st = "find";
  else st = "cnt";
  var lastAt = last(docs), counting = docs.filter(function (d) { return d.status !== "submitted"; });
  var idle = counting.length && lastAt && (Date.now() - new Date(last(counting))) / 60000 > IDLE_MIN ? Math.round((Date.now() - new Date(last(counting))) / 60000) : 0;
  return { b: b, st: st, docs: docs, ops: ops, fin: fin, nExp: nExp, opsN: codesOf(ops, exp), finN: codesOf(fin, exp), allN: codesOf(docs, exp), opsSub: opsSub, finSub: finSub,
    V: V, lc: lc, net: net, over: over, rc: rc, diffN: diffN, sysV: sysV, sysQ: sysQ, photos: docs.reduce(function (a, d) { return a + (d.photos || 0); }, 0),
    lastAt: lastAt, idle: idle, kpi: kpiOf(V) };
}

/* KPI002 rule (same as the server): per SKU |agreed value - system value|, an SKU nobody agreed on counts as not found */
function kpiOf(V) {
  var g = {}, sys = 0, abs = 0, net = 0;
  V.forEach(function (o) { var a = g[o.code] || (g[o.code] = { s: 0, p: 0 }); var c = o.cost || 0; a.s += (o.sys || 0) * c; if (o.counted) a.p += (o.phys || 0) * c; });
  Object.keys(g).forEach(function (c) { sys += g[c].s; abs += Math.abs(g[c].p - g[c].s); net += g[c].p - g[c].s; });
  /* net = counted value less system value, an uncounted batch counting as 0 found (same as the Excel Summary) */
  return { sys: sys, abs: abs, net: net, ira: sys ? (1 - abs / sys) * 100 : null };
}

function meta() {
  if (!S.meta && !S.metaLoading) { S.metaLoading = true; rpc("admin_branch_meta", { p_token: tok() }).then(function (r) { S.meta = r; S.metaLoading = false; hooks.render(); }, function () { S.metaLoading = false; S.meta = []; }); }
  var m = {}; (S.meta || []).forEach(function (x) { m[x.branch] = x; }); return m;
}
function branches() { var B = {}; (S.adm.branches || []).forEach(function (b) { if (b.active) B[b.name] = 1; }); Object.keys(S.sysBy || {}).forEach(function (b) { B[b] = 1; }); return Object.keys(B).filter(function (b) { return (S.sysBy[b] || []).length || (S.counts || []).some(function (d) { return d.branch === b; }); }).sort(); }

/* ---------- entry: Dashboard tab ---------- */
export function renderDashTab(app) {
  ensureCss();
  var t = currentTake();
  if (!S.dashView) S.dashView = t.status === "open" ? "monthly" : "daily";
  app.append(el("div", { class: "md-switch", role: "tablist" },
    [["monthly", "Monthly stock take"], ["daily", "Daily & KPI"]].map(function (x) {
      return el("button", { class: S.dashView === x[0] ? "on" : "", role: "tab", "aria-selected": S.dashView === x[0] ? "true" : "false", text: x[1], onclick: function () { S.dashView = x[0]; S.mdWh = null; hooks.render(); } });
    })));
  if (S.dashView === "daily") return renderDash(app);
  if (!S.adm) { app.append(el("p", { class: "muted", text: "Loading…" })); loadAdmin().then(hooks.render); return; }
  if (!t.id || t.status === "draft" || !t.openedAt) {
    app.append(el("div", { class: "card" }, el("h3", { text: "No monthly stock take running" }),
      el("p", { class: "muted", text: "This view goes live when counting is opened on the Monthly page, and shows the final results after closing." }),
      el("button", { class: "btn primary", text: "Go to Monthly", onclick: function () { S.tab = "home"; hooks.render(); } })));
    return;
  }
  if (S.viewTake && !S.mdWh) app.append(el("button", { class: "md-back", text: "← Back to the current stock take", onclick: function () { S.viewTake = null; S.adm = null; hooks.render(); } }));
  if (S.mdWh) return renderWarehouse(app, S.mdWh, t);
  if (t.status === "closed") return renderFinal(app, t);
  renderLive(app, t);
}

function headBlock(t, live) {
  var chips = [t.stockType === "bad" ? "Bad stock" : "Good stock", t.scope === "partial" ? "Partial · " + t.skuCount + " SKUs" : "Total · every SKU in the MB52",
    t.mode === "single" ? "Single count" : "Double count · Ops + Finance"];
  if (t.kpiMonth) chips.push("KPI002 · " + new Date(t.kpiMonth + "T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" }));
  return el("div", {},
    el("div", { class: "md-live" }, live ? el("i") : null, live ? "Live · updated " + hm(new Date().toISOString()) + " · refreshes every 20 s" : "Closed " + dhm(t.closedAt) + " · results locked"),
    el("h2", { style: "margin:4px 0 0", text: t.name }),
    el("div", { class: "md-chips" }, chips.map(function (c) { return el("span", { class: "pill", text: c }); })),
    el("p", { class: "small muted", style: "margin:6px 0 0", text: "Opened " + dhm(t.openedAt) + (live ? " · running " + dur(t.openedAt) : " · closed " + dhm(t.closedAt)) }));
}

function filters() {
  var M = meta(), F = S.mdF || (S.mdF = { region: "", nom: "" });
  var uniq = function (k) { var o = {}; (S.meta || []).forEach(function (x) { if (x[k]) o[x[k]] = 1; }); return Object.keys(o).sort(); };
  var sel = function (k, label) {
    var v = uniq(k); if (!v.length) return null;
    return el("select", { "aria-label": label, onchange: function (e) { F[k] = e.target.value; hooks.render(); } },
      el("option", { value: "", text: "All " + label.toLowerCase() + "s" }), v.map(function (x) { return el("option", { value: x, text: x, selected: F[k] === x }); }));
  };
  var keep = function (b) { var m = M[b] || {}; return (!F.region || m.region === F.region) && (!F.nom || m.nom === F.nom); };
  return { box: el("div", { class: "md-filters" }, sel("region", "Region"), sel("nom", "NOM")), keep: keep, M: M };
}

function tile(label, v, sub, cls) { return el("div", { class: "md-tile" }, el("span", { text: label }), el("b", { class: cls || "", text: v }), sub ? el("small", { text: sub }) : null); }

/* ---------- live ---------- */
function renderLive(app, t) {
  var f = filters(), sg = isSingle();
  var W = branches().filter(f.keep).map(whState);
  var cnt = {}; W.forEach(function (w) { cnt[w.st] = (cnt[w.st] || 0) + 1; });
  var done = cnt.done || 0, tot = function (k) { return W.reduce(function (a, w) { return a + w[k]; }, 0); };
  var expAll = tot("nExp"), opsAll = tot(sg ? "allN" : "opsN"), finAll = tot("finN"), diffAll = tot("diffN"), netAll = tot("net"), phAll = tot("photos");

  app.append(el("div", { class: "md-head" }, headBlock(t, true), el("div", { class: "md-filters" }, f.box,
    el("button", { class: "btn", text: "Export Excel", onclick: exportXlsx }))));

  /* where the warehouses are */
  var stage = el("div", { class: "md-stage", role: "img", "aria-label": STAGE_ORDER.filter(function (k) { return cnt[k]; }).map(function (k) { return cnt[k] + " " + STAGE[k].label; }).join(", ") });
  STAGE_ORDER.forEach(function (k) { if (cnt[k]) stage.append(el("i", { style: "flex:" + cnt[k] + ";background:" + STAGE[k].bar + ";color:" + STAGE[k].ink, text: String(cnt[k]) })); });
  app.append(el("div", { class: "card" },
    el("h3", { style: "margin:0", text: "Where the " + W.length + " warehouses are" }),
    el("p", { class: "small muted", style: "margin:2px 0 0", text: done + " of " + W.length + " done" + (sg ? "" : " (both teams submitted and agree)") + " · close counting when all are done" }),
    stage,
    el("div", { class: "md-key" }, STAGE_ORDER.filter(function (k) { return cnt[k]; }).map(function (k) { return el("span", {}, el("em", { style: "background:" + STAGE[k].bar + ";border:1px solid var(--line)" }), el("b", { text: String(cnt[k]) }), STAGE[k].label); })),
    el("div", { class: "md-tiles" },
      tile("Warehouses done", done + " / " + W.length, (cnt.nos || 0) + " not started"),
      tile(sg ? "SKUs counted" : "Ops counted", expAll ? Math.round(opsAll / expAll * 100) + "%" : "-", fmt(opsAll) + " of " + fmt(expAll) + " SKUs"),
      sg ? null : tile("Finance checked", expAll ? Math.round(finAll / expAll * 100) + "%" : "-", fmt(finAll) + " of " + fmt(expAll) + " SKUs"),
      sg ? null : tile("Ops ≠ Finance", fmt(diffAll) + " lines", diffAll ? "batches to recount" : "no differences so far", diffAll ? "md-wn" : ""),
      tile("Agreed vs system", rm(netAll, true), "net, agreed lines so far", netAll < -0.5 ? "md-neg" : ""),
      tile("Warehouse photos", fmt(phAll), "taken before counting"))));

  /* warehouses, most urgent first */
  W.sort(function (a, b) { return STAGE[a.st].rank - STAGE[b.st].rank || (b.idle - a.idle) || a.b.localeCompare(b.b); });
  var grid = el("div", { class: "md-grid" });
  W.forEach(function (w) { grid.append(whCard(w, f.M[w.b], sg)); });
  app.append(el("div", { class: "card" }, el("h3", { style: "margin:0", text: "Warehouses · most urgent first" }),
    el("p", { class: "small muted", style: "margin:2px 0 10px", text: "Tap a warehouse for its timeline, differences and photos." }), grid));

  app.append(diffCard(W, sg), attentionCard(W, t, sg), activityCard(W));
}

function bar(label, n, exp, who, color) {
  var p = exp ? Math.min(100, Math.round(n / exp * 100)) : 0;
  return el("div", { class: "md-bar" },
    el("div", { class: "lb" }, el("b", { text: label }), el("span", { text: fmt(n) + " / " + fmt(exp) + " SKUs · " + p + "%" })),
    el("div", { class: "tr", role: "progressbar", "aria-valuenow": String(p), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": label + " progress" }, el("i", { style: "width:" + p + "%;background:" + color })),
    el("div", { class: "who", text: who || "-" }));
}
function teamWho(list) { if (!list.length) return "Not started"; var s = list.every(function (d) { return d.status === "submitted"; }); return names(list) + (s ? " · sent " + hm(last(list)) : " · counting"); }

function whCard(w, m, sg) {
  var S0 = STAGE[w.st], min = Number((S.cfg || {}).photoMin) || 0;
  var res = w.st === "nos" ? ["Nothing counted yet", ""] : w.diffN ? [w.diffN + " line(s) Ops ≠ Finance", "md-wn"]
    : w.over ? [w.over + " SKU(s) over " + tolPct() + "%", "md-neg"] : [(w.st === "done" ? "IRA " + ira(w.kpi.ira) : "Within tolerance so far"), "md-pos"];
  var phLow = w.docs.some(function (d) { return (d.photos || 0) < min; });
  if (w.st === "nos") return el("button", { class: "md-wh nos", style: "border-left-color:" + S0.edge, "aria-label": w.b + ": not started", onclick: function () { S.mdWh = w.b; hooks.render(); window.scrollTo(0, 0); } },
    el("div", { class: "top", style: "margin:0" }, el("div", {}, el("div", { class: "nm", text: w.b }), el("div", { class: "small muted", text: [m && m.region, fmt(w.nExp) + " SKUs to count"].filter(Boolean).join(" · ") })),
      el("span", { class: "pill bad", text: "Not started" })));
  return el("button", { class: "md-wh", style: "border-left-color:" + S0.edge, "aria-label": w.b + ": " + S0.short, onclick: function () { S.mdWh = w.b; hooks.render(); window.scrollTo(0, 0); } },
    el("div", { class: "top" }, el("div", {}, el("div", { class: "nm", text: w.b }), m && (m.region || m.nom) ? el("div", { class: "small muted", text: [m.region, m.nom].filter(Boolean).join(" · ") }) : null),
      el("span", { class: "pill " + S0.pill, text: w.st === "rc" ? "Recount · " + w.rc + " lines" : S0.short })),
    sg ? bar("Count", w.allN, w.nExp, teamWho(w.docs), "var(--info)")
      : [bar("Ops", w.opsN, w.nExp, teamWho(w.ops), "var(--info)"), bar("Finance", w.finN, w.nExp, teamWho(w.fin), "var(--mon)")],
    el("div", { class: "md-res" }, el("span", { class: res[1], text: res[0] }), el("b", { class: w.net < -0.5 ? "md-neg" : "", text: w.docs.length ? rm(w.net, true) : "" })),
    el("div", { class: "md-foot" }, el("span", { class: phLow && w.docs.length ? "md-neg" : "", text: w.photos + " photo" + (w.photos === 1 ? "" : "s") }),
      el("span", { class: w.idle ? "md-wn" : "", text: w.idle ? "idle " + w.idle + " min" : w.lastAt ? "last activity " + hm(w.lastAt) : "no activity" })));
}

function diffCard(W, sg) {
  var rows = [];
  W.forEach(function (w) {
    var g = {};
    w.V.forEach(function (o) {
      var a = g[o.code] || (g[o.code] = { code: o.code, desc: o.desc, sys: 0, ops: 0, fin: 0, hasO: false, hasF: false, cost: 0, agreed: true, b: w.b });
      if (o.cost) a.cost = o.cost; if (o.status === "NOT COUNTED") return;   /* live: compare only the batches someone counted */
      a.sys += o.sys || 0; if (o.opsQ != null) { a.ops += o.opsQ; a.hasO = true; } if (o.finQ != null) { a.fin += o.finQ; a.hasF = true; }
      if (!o.counted) a.agreed = false;
    });
    Object.keys(g).forEach(function (c) {
      var a = g[c]; if (!a.hasO && !a.hasF) return;
      var q = a.hasO ? a.ops : a.fin;
      a.rm = (q - a.sys) * a.cost; a.of = !a.agreed && a.hasO && a.hasF && Math.abs(a.ops - a.fin) > 1e-9;
      if (Math.abs(a.rm) >= 1 || a.of) rows.push(a);
    });
  });
  rows.sort(function (x, y) { return Math.abs(y.rm) - Math.abs(x.rm); });
  var box = el("div", { class: "md-rows" });
  if (!rows.length) box.append(el("p", { class: "muted", text: "No differences yet." }));
  rows.slice(0, 10).forEach(function (a) {
    box.append(el("div", {}, el("div", { class: "g" }, el("b", { text: a.code + " · " + a.desc }), el("small", { text: a.b })),
      el("div", { class: "nums" }, el("span", {}, el("em", { text: "System" }), fmt(a.sys)),
        el("span", {}, el("em", { text: sg ? "Count" : "Ops" }), a.hasO ? fmt(a.ops) : "-"),
        sg ? null : el("span", {}, el("em", { text: "Finance" }), a.hasF ? fmt(a.fin) : "-"),
        el("span", { class: a.rm < 0 ? "md-neg" : "" }, el("em", { text: "Diff" }), rm(a.rm, true)),
        el("span", { class: "pill " + (a.of ? "warn" : a.agreed ? "" : "info"), text: a.of ? "Ops ≠ Finance" : a.agreed ? "Agreed" : "Waiting" }))));
  });
  return el("div", { class: "card" }, el("h3", { style: "margin:0", text: "Biggest differences so far" }),
    el("p", { class: "small muted", style: "margin:2px 0 6px", text: "Top 10 SKUs by RM, on the batches counted so far. Agreed = both teams have the same count (it can still differ from the system)." }), box);
}

function attentionCard(W, t, sg) {
  var items = [], openMin = (Date.now() - new Date(t.openedAt)) / 60000, min = Number((S.cfg || {}).photoMin) || 0;
  (S.late || []).forEach(function (x) { items.push(["bad", x.branch + ": counts arrived after closing", x.lines + " line(s) wait for you on the Monthly page", "Open Monthly", function () { S.tab = "home"; hooks.render(); }]); });
  var nos = W.filter(function (w) { return w.st === "nos"; });
  if (nos.length && openMin > 30) items.push(["bad", nos.length + " warehouse(s) not started", nos.map(function (w) { return w.b; }).join(", ") + " · open for " + dur(t.openedAt), "Copy reminder", function () { copy("Reminder: the month-end stock take is open. Please start counting now - " + nos.map(function (w) { return w.b; }).join(", ")); }]);
  W.filter(function (w) { return w.st === "diff"; }).forEach(function (w) { items.push(["warn", w.b + ": both teams submitted but " + w.diffN + " line(s) differ", "Send the recount list so both teams count those batches again", "Send recount", function () { sendRecount(w.b, w.V); }]); });
  W.filter(function (w) { return w.st === "rc"; }).forEach(function (w) { items.push(["warn", w.b + ": recount in progress", w.rc + " line(s) · both teams must submit again", "Open", function () { S.mdWh = w.b; hooks.render(); }]); });
  W.filter(function (w) { return w.idle; }).forEach(function (w) { items.push(["warn", w.b + ": no activity for " + w.idle + " min", "Last save " + hm(w.lastAt) + " - a phone may be offline or stuck", "Open", function () { S.mdWh = w.b; hooks.render(); }]); });
  if (!sg) W.filter(function (w) { return w.st === "opsd" || w.st === "find"; }).forEach(function (w) { items.push(["info", w.b + ": " + (w.st === "opsd" ? "Finance" : "Ops") + " not started", (w.st === "opsd" ? "Ops" : "Finance") + " submitted " + hm(last(w.docs)), null, null]); });
  overlaps().forEach(function (o) { items.push(["warn", o.branch + ": same batch counted on two phones", o.n + " batch(es) added up · by " + o.who.join(" + ") + " - check it wasn't counted twice", null, null]); });
  W.forEach(function (w) { w.docs.filter(function (d) { return (d.photos || 0) < min; }).forEach(function (d) { items.push(["warn", w.b + " " + (sessRole(d) === "fin" ? "Finance" : "Ops") + ": " + (d.photos || 0) + " of " + min + " photos", "Counting started before the photos (no signal) - they must add them before submitting", null, null]); }); });
  var box = el("div", { class: "md-att" });
  if (!items.length) box.append(el("p", { class: "muted", text: "Nothing needs you right now." }));
  items.forEach(function (x) {
    box.append(el("div", {}, el("span", { class: "pill " + x[0], text: x[0] === "bad" ? "Act now" : x[0] === "warn" ? "Check" : "Info" }),
      el("div", { class: "g" }, el("b", { text: x[1] }), el("small", { text: x[2] })), x[3] ? el("button", { class: "btn", text: x[3], onclick: x[4] }) : null));
  });
  return el("div", { class: "card" }, el("h3", { style: "margin:0 0 4px", text: "Needs attention" + (items.length ? " · " + items.length : "") }), box);
}
function copy(text) { try { navigator.clipboard.writeText(text).then(function () { toast("Copied - paste it in WhatsApp"); }); } catch (e) { msg("Copy this", text); } }

function activityCard(W) {
  var ev = [];
  W.forEach(function (w) {
    w.docs.forEach(function (d) {
      var who = (sessRole(d) === "fin" ? "Finance" : "Ops") + (d.member ? " · " + d.member : "");
      if (d.startedAt) ev.push([d.startedAt, w.b, who + " started"]);
      if (d.reopenedAt) ev.push([d.reopenedAt, w.b, who + " reopened for recount"]);
      if (d.status === "submitted" && d.submittedAt) ev.push([d.submittedAt, w.b, who + " submitted"]);
      else if (d.updatedAt && d.updatedAt !== d.startedAt) ev.push([d.updatedAt, w.b, who + " saved " + Object.keys(d.lines || {}).length + " line(s)"]);
    });
  });
  (S.late || []).forEach(function (x) { ev.push([x.at, x.branch, "late counts arrived after closing"]); });
  ev.sort(function (a, b) { return a[0] < b[0] ? 1 : -1; });
  var ul = el("ul", { class: "md-feed" });
  if (!ev.length) ul.append(el("li", { class: "muted", text: "No activity yet." }));
  ev.slice(0, 15).forEach(function (e) { ul.append(el("li", {}, el("time", { text: hm(e[0]) }), el("span", {}, el("b", { text: e[1] }), " · " + e[2]))); });
  return el("div", { class: "card" }, el("h3", { style: "margin:0 0 4px", text: "Live activity" }), ul);
}

/* ---------- one warehouse ---------- */
function renderWarehouse(app, b, t) {
  var w = whState(b), m = meta()[b] || {}, sg = isSingle(), S0 = STAGE[w.st];
  app.append(el("button", { class: "md-back", text: "← All warehouses", onclick: function () { S.mdWh = null; hooks.render(); } }),
    el("div", { class: "md-head" }, el("div", {},
      el("div", { class: "small muted", text: [m.region, m.nom].filter(Boolean).join(" · ") }),
      el("h2", { style: "margin:2px 0", text: b }), el("span", { class: "pill " + S0.pill, text: w.st === "rc" ? "Recount · " + w.rc + " lines" : S0.label })),
      el("div", { class: "md-filters" },
        el("button", { class: "btn", text: "Sign-off PDF", onclick: function () { signoffPdf(b); } }),
        !sg && t.status === "open" && (w.diffN || w.lc["WAITING OPS"] || w.lc["WAITING FINANCE"]) ? el("button", { class: "btn primary", text: "Send recount list", onclick: function () { sendRecount(b, w.V); } }) : null,
        t.status === "open" && w.docs.length ? el("button", { class: "btn", style: "color:var(--bad)", text: "Delete a count…", onclick: function () { deleteCountsModal(b, w.docs, function () { loadAdmin().then(hooks.render); }); } }) : null)));

  /* timeline */
  var first = function (l) { return l.reduce(function (a, d) { return d.startedAt && (!a || d.startedAt < a) ? d.startedAt : a; }, null); };
  var step = function (label, at, st, sub) { return el("div", { class: st }, el("i", { text: st === "done" ? "✓" : st === "now" ? "!" : "" }), el("b", { text: label }), el("small", { text: sub || (at ? hm(at) : "") })); };
  var steps = [step("Counting opened", t.openedAt, "done")];
  var team = function (l, nm) {
    var s = l.length && l.every(function (d) { return d.status === "submitted"; });
    steps.push(step(nm + " started", first(l), l.length ? "done" : "", l.length ? hm(first(l)) + " · " + names(l) : "not yet"));
    steps.push(step(nm + " submitted", s ? last(l) : null, s ? "done" : l.length ? "now" : "", s ? hm(last(l)) : l.length ? "counting" : ""));
  };
  if (sg) team(w.docs, "Count"); else { team(w.ops, "Ops"); team(w.fin, "Finance"); }
  if (w.rc || w.st === "diff") steps.push(step("Recount", null, "now", w.rc ? w.rc + " line(s) sent" : w.diffN + " line(s) to send"));
  steps.push(step("Done", null, w.st === "done" ? "done" : "", sg ? "count submitted" : "both teams agree"));
  app.append(el("div", { class: "card" }, el("h3", { style: "margin:0 0 6px", text: "Timeline" }), el("div", { class: "md-tl" }, steps)));

  /* numbers */
  var opsPh = w.ops.reduce(function (a, d) { return a + (d.photos || 0); }, 0), finPh = w.fin.reduce(function (a, d) { return a + (d.photos || 0); }, 0);
  app.append(el("div", { class: "md-tiles", style: "margin:0 0 12px" },
    tile("System stock (MB52)", rm(w.sysV), fmt(w.nExp) + " SKUs · " + fmt(w.sysQ) + " pcs"),
    tile("Agreed vs system", rm(w.net, true), w.over ? w.over + " SKU(s) over " + tolPct() + "%" : "agreed lines so far", w.net < -0.5 ? "md-neg" : ""),
    sg ? null : tile("Ops vs Finance", w.diffN ? w.diffN + " lines differ" : "No difference", (w.lc.MATCH || 0) + " lines agree", w.diffN ? "md-wn" : ""),
    tile("Photos", String(w.photos), sg ? "" : "Ops " + opsPh + " · Finance " + finPh)));

  /* SKUs */
  var g = {}; w.V.forEach(function (o) {
    var a = g[o.code] || (g[o.code] = { code: o.code, desc: o.desc, sys: 0, ops: 0, fin: 0, hasO: false, hasF: false, rm: 0, st: {}, flag: o.skuFlag });
    a.sys += o.sys || 0; if (o.opsQ != null) { a.ops += o.opsQ; a.hasO = true; } if (o.finQ != null) { a.fin += o.finQ; a.hasF = true; }
    if (o.vv) a.rm += o.vv; a.st[o.status] = 1;
  });
  var all = Object.keys(g).map(function (k) { var a = g[k]; a.state = a.st.RECOUNT ? "Recount" : a.st["WAITING OPS"] || a.st["WAITING FINANCE"] ? "Waiting" : a.st["NEEDS PCS FACTOR"] ? "Needs pcs factor" : a.st.MATCH ? "Agreed" : "Not counted"; return a; });
  var dif = all.filter(function (a) { return a.state !== "Agreed" && a.state !== "Not counted" || /^OVER/.test(a.flag) || Math.abs(a.rm) >= 1; });
  var showAll = S.mdAll, list = (showAll ? all : dif).sort(function (x, y) { return Math.abs(y.rm) - Math.abs(x.rm) || x.code.localeCompare(y.code); });
  var box = el("div", { class: "md-rows" });
  if (!list.length) box.append(el("p", { class: "muted", text: showAll ? "Nothing counted yet." : "No SKU differs." }));
  list.slice(0, 300).forEach(function (a) {
    box.append(el("div", {}, el("div", { class: "g" }, el("b", { text: a.code }), el("small", { text: a.desc })),
      el("div", { class: "nums" }, el("span", {}, el("em", { text: "System" }), fmt(a.sys)), el("span", {}, el("em", { text: sg ? "Count" : "Ops" }), a.hasO ? fmt(a.ops) : "-"),
        sg ? null : el("span", {}, el("em", { text: "Finance" }), a.hasF ? fmt(a.fin) : "-"),
        el("span", { class: a.rm < 0 ? "md-neg" : "" }, el("em", { text: "RM" }), a.rm ? rm(a.rm, true) : "-"),
        el("span", { class: "pill " + (a.state === "Recount" ? "warn" : a.state === "Agreed" ? (/^OVER/.test(a.flag) ? "bad" : "ok") : ""), text: a.state === "Agreed" && /^OVER/.test(a.flag) ? "Agreed · " + a.flag.toLowerCase() : a.state }))));
  });
  app.append(el("div", { class: "card" }, el("div", { class: "row", style: "justify-content:space-between;align-items:center" }, el("h3", { style: "margin:0", text: "SKUs" }),
    el("div", { class: "md-switch", style: "margin:0" }, el("button", { class: showAll ? "" : "on", text: "Differences " + dif.length, onclick: function () { S.mdAll = false; hooks.render(); } }),
      el("button", { class: showAll ? "on" : "", text: "All " + all.length, onclick: function () { S.mdAll = true; hooks.render(); } }))),
    el("p", { class: "small muted", style: "margin:4px 0 0", text: "Recount = Ops and Finance disagree on a batch, so both count it again. Agreed = both teams have the same count; it can still differ from the system." }), box));

  /* photos */
  var pc = el("div", { class: "card" }, el("h3", { style: "margin:0", text: "Warehouse photos · " + w.photos }),
    el("p", { class: "small muted", style: "margin:2px 0 6px", text: "Taken with the camera before counting; each is stamped with date, time, GPS and address. Tap to open full size." }));
  if (!w.docs.length) pc.append(el("p", { class: "muted", text: "No count yet." }));
  w.docs.forEach(function (d) {
    var grid = el("div", { class: "md-ph" });
    pc.append(el("b", { class: "small", text: (sessRole(d) === "fin" ? "Finance" : "Ops") + " · " + names([d]) }), grid);
    S.mdPh = S.mdPh || {};
    var fill = function (ps) { grid.innerHTML = ""; if (!ps.length) grid.append(el("span", { class: "small muted", text: "No photos." })); ps.forEach(function (p) { grid.append(el("a", { href: p.url, target: "_blank", rel: "noopener" }, el("img", { src: p.url, alt: "Warehouse photo", loading: "lazy" }))); }); };
    var c = S.mdPh[d.id];
    if (c && c.n === (d.photos || 0) && Date.now() - c.at < 45 * 60000) fill(c.ps);
    else { grid.append(el("span", { class: "small muted", text: "Loading…" })); listPhotos(d.id, tok()).then(function (ps) { S.mdPh[d.id] = { ps: ps, n: ps.length, at: Date.now() }; fill(ps); }, function (e) { grid.innerHTML = ""; grid.append(el("span", { class: "small md-neg", text: "Can't load photos: " + errText(e) })); }); }
  });
  app.append(pc);
}

/* ---------- final (closed) ---------- */
function renderFinal(app, t) {
  var f = filters(), W = branches().filter(f.keep).map(whState);
  var sys = 0, abs = 0, net = 0; W.forEach(function (w) { sys += w.kpi.sys; abs += w.kpi.abs; net += w.kpi.net; });
  var nat = sys ? (1 - abs / sys) * 100 : null, onT = W.filter(function (w) { return w.kpi.ira != null && Math.floor(w.kpi.ira * 100) / 100 >= TARGET; });
  var isFinal = function (w) { return w.st === "done"; }, nFinal = W.filter(isFinal).length;
  app.append(el("div", { class: "md-head" }, headBlock(t, false), f.box));
  if (S.adm.meta && S.adm.meta.imported) app.append(el("div", { class: "banner", text: "Imported from the previous app's result Excel (" + (S.adm.meta.source || "") + "). Counts and system stock are as in that file; warehouse photos and signatures are only in the previous app." }));
  if ((S.late || []).length) app.append(el("div", { class: "banner warn", text: (S.late || []).length + " count(s) arrived after closing and are not in these results yet. Take them in or ignore them on the Monthly page." }));
  app.append(el("div", { class: "md-flow" },
    el("div", { class: "done" }, el("i", { text: "✓" }), el("div", {}, el("b", { text: "Counting closed" }), el("small", { text: dhm(t.closedAt) + " · counts locked" }))),
    el("div", { class: nFinal === W.length ? "done" : "now" }, el("i", { text: nFinal === W.length ? "✓" : "!" }), el("div", {}, el("b", { text: nFinal + " of " + W.length + " final" }), el("small", { text: nFinal === W.length ? "every sign-off is final" : (W.length - nFinal) + " sign-off(s) will say DRAFT" }))),
    el("div", { class: "now" }, el("i", { text: "3" }), el("div", {}, el("b", { text: "Download the sign-offs" }), el("small", { text: "one ZIP with " + W.length + " PDFs, or one by one below" }))),
    el("div", {}, el("i", { text: "4" }), el("div", {}, el("b", { text: "Get them signed" }), el("small", { text: "branch manager and Finance HQ sign each PDF" })))));
  app.append(el("div", { class: "card" }, el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" },
    el("button", { class: "btn primary", text: "Download all sign-offs (ZIP)", onclick: function () { downloadAll(W.map(function (w) { return w.b; })); } }),
    el("button", { class: "btn", text: "Export Excel", onclick: exportXlsx })),
    el("div", { class: "md-tiles" },
      tile("IRA by value (KPI002)", ira(nat), "Target " + TARGET + "% · " + (nat == null ? "" : Math.floor(nat * 100) / 100 >= TARGET ? "on target" : "below target"), nat != null && Math.floor(nat * 100) / 100 < TARGET ? "md-neg" : "md-pos"),
      tile("System stock", "RM " + fmt(sys / 1e6, 2) + " M", W.reduce(function (a, w) { return a + w.nExp; }, 0) + " SKU lines at " + W.length + " warehouses"),
      tile("Net difference", rm(net, true), "absolute RM " + fmt(Math.round(abs), 0), net < -0.5 ? "md-neg" : ""),
      tile("Warehouses on target", onT.length + " / " + W.length, W.filter(function (w) { return onT.indexOf(w) < 0; }).map(function (w) { return w.b.replace(/^NDD /, ""); }).join(", ") || "all on target"))));
  var box = el("div", { class: "md-rows" });
  W.slice().sort(function (a, b) { return (a.kpi.ira == null ? 101 : a.kpi.ira) - (b.kpi.ira == null ? 101 : b.kpi.ira); }).forEach(function (w) {
    var m = f.M[w.b] || {}, low = w.kpi.ira != null && Math.floor(w.kpi.ira * 100) / 100 < TARGET;
    box.append(el("div", {}, el("div", { class: "g" }, el("b", { text: w.b }), el("small", { text: m.region || "" })),
      el("div", { class: "nums" }, el("span", { class: low ? "md-neg" : "md-pos" }, el("em", { text: "IRA" }), ira(w.kpi.ira)),
        el("span", { class: w.kpi.net < -0.5 ? "md-neg" : "" }, el("em", { text: "Net" }), rm(w.kpi.net, true)),
        el("span", {}, el("em", { text: "SKUs off" }), String(w.over)),
        el("span", { class: "pill " + (isFinal(w) ? "ok" : "warn"), text: isFinal(w) ? "Final" : "Draft · " + STAGE[w.st].short }),
        el("button", { class: "btn", text: "PDF", "aria-label": "Sign-off PDF " + w.b, onclick: function () { signoffPdf(w.b); } }),
        el("button", { class: "link", text: "Details", onclick: function () { S.mdWh = w.b; hooks.render(); window.scrollTo(0, 0); } }))));
  });
  app.append(el("div", { class: "card" }, el("h3", { style: "margin:0", text: "Sign-off per warehouse · lowest accuracy first" }),
    el("p", { class: "small muted", style: "margin:2px 0 6px", text: "Each PDF has the counts, differences, photos, both teams' signatures and boxes for the branch manager and Finance HQ." }), box));
  app.append(el("div", { class: "card" }, el("h3", { text: "Something still wrong?" }),
    el("p", { class: "small muted", text: "Reopen counting lets the warehouses change their counts again. Download the sign-offs again after closing." }),
    el("button", { class: "btn", text: "Reopen counting", onclick: function () {
      confirmBox("Reopen counting?", "Counters can change their counts again until you close it.", "Reopen", async function () { try { await rpc("admin_set_status", { p_token: tok(), p_status: "open" }); await loadAdmin(); hooks.render(); } catch (e) { msg("Can't reopen", errText(e)); } });
    } })));
}

async function downloadAll(list) {
  var prog = el("p", { class: "muted", text: "Starting…" }), stop = false;
  openModal(function (sh) { sh.append(el("h3", { text: "Preparing " + list.length + " sign-offs" }), prog, el("button", { class: "btn block", text: "Cancel", onclick: function () { stop = true; closeModal(); } })); }, "lock");
  try {
    var Z = await zipLib(), zip = new Z(), draft = [];
    for (var i = 0; i < list.length; i++) {
      if (stop) return;
      prog.textContent = (i + 1) + " of " + list.length + " · " + list[i];
      var r = await signoffPdf(list[i], true); zip.file(r.name, r.blob); if (!r.final) draft.push(list[i]);
    }
    prog.textContent = "Zipping…";
    var blob = await zip.generateAsync({ type: "blob" }), t = currentTake(), name = "SignOffs_" + String(t.name || "stock_take").replace(/[^\w]+/g, "_") + ".zip";
    window.__zip = { name: name, files: Object.keys(zip.files), draft: draft };
    saveBlob(blob, name); closeModal();
    msg("Saved ✓", name + "\n" + list.length + " PDFs." + (draft.length ? "\n\nMarked DRAFT: " + draft.join(", ") : ""));
  } catch (e) { closeModal(); msg("Couldn't make the ZIP", errText(e)); }
}
