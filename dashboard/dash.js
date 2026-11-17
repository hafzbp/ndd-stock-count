/* Public live dashboard: no login. What it shows is set by Finance in Setup → Public dashboard. */
import { rpc } from "../js/api.js";
import { el, fmt, tsTxt } from "../js/ui.js";
import { renderDccStats } from "../js/dcc.js";

var $ = function (s) { return document.querySelector(s); };
var ST = { not_started: ["Not started", ""], counting: ["Counting", "warn"], submitted: ["Submitted ✓", "ok"] };

function bar(label, done, total, color) {
  var p = total ? Math.min(100, Math.round(done / total * 100)) : 0;
  return el("div", { class: "bar" }, el("div", { class: "l" }, el("span", { text: label }), el("span", { text: done + " / " + total + " SKU (" + p + "%)" })),
    el("div", { class: "t" }, el("i", { style: "width:" + p + "%;background:" + color })));
}
function kpi(v, l, cls) { return el("div", { class: "kpi" }, el("b", { class: cls || "", text: v }), el("span", { text: l })); }

function draw(d) {
  document.title = (d.title || "Stock Count") + " · Dashboard";
  $("#title").textContent = (d.title || "Stock Count") + " · Live dashboard";
  $("#sub").textContent = "Daily cycle count and monthly stock take · updated " + tsTxt(d.generatedAt);
  var mt = (d.take || "") + (d.scope === "partial" ? " · partial, " + d.skuCount + " SKUs" : "") + (d.mode === "single" ? " · single count" : "") + " · " + (d.status === "draft" ? "not started yet" : d.status === "closed" ? "counting closed" : "counting open") + " · updated " + tsTxt(d.generatedAt);
  var B = d.branches || [], app = $("#monthly"); app.innerHTML = "";
  app.append(el("h2", { class: "sec", text: "Monthly stock take · " + mt }));
  var sg = d.mode === "single";
  /* single count: one team, whichever role it picked */
  if (sg) B.forEach(function (b) { var s = [b.ops, b.fin]; b.one = s.indexOf("counting") >= 0 ? "counting" : s.indexOf("submitted") >= 0 ? "submitted" : "not_started"; b.oneDone = Math.max(b.opsDone, b.finDone); });
  var exp = 0, od = 0, fd = 0, both = 0, started = 0;
  if (sg) B.forEach(function (b) { exp += b.expected; od += b.oneDone; if (b.one === "submitted") both++; if (b.one !== "not_started") started++; });
  else B.forEach(function (b) { exp += b.expected; od += b.opsDone; fd += b.finDone; if (b.ops === "submitted" && b.fin === "submitted") both++; if (b.ops !== "not_started" || b.fin !== "not_started") started++; });
  var k = el("div", { class: "kpis" },
    kpi(B.length, "Branches"), kpi(started, "Started"), kpi(both, sg ? "Submitted" : "Both teams submitted"),
    kpi((exp ? Math.round(od / exp * 100) : 0) + "%", sg ? "Progress (SKUs)" : "Ops progress (SKUs)"), sg ? null : kpi((exp ? Math.round(fd / exp * 100) : 0) + "%", "Finance progress (SKUs)"));
  if (d.showVariance) {
    var vq = 0, rm = 0, over = 0, rc = 0; B.forEach(function (b) { var v = b.variance || {}; vq += v.varQ || 0; rm += v.varRM || 0; over += v.skuOver || 0; rc += (v.recount || 0) + (v.waiting || 0); });
    k.append(kpi(fmt(vq), "Net variance (PCS)", vq < 0 ? "neg" : vq > 0 ? "pos" : ""), kpi(over, "SKUs over tolerance", over ? "neg" : ""), kpi(rc, "Lines still recount / waiting"));
    if (d.level === "value") k.append(kpi("RM " + fmt(rm, 2), "Net variance value", rm < 0 ? "neg" : rm > 0 ? "pos" : ""));
  }
  app.append(k);
  if (d.status === "draft") app.append(el("div", { class: "note", text: "The stock take hasn't started yet. Progress shows here once counting is open." }));
  else if (!d.showVariance) app.append(el("div", { class: "note", text: d.level === "progress" ? "Showing counting progress. Variance is not published." : "Variance appears here after the admin closes counting." }));
  if (!B.length) { app.append(el("div", { class: "center muted", text: "No branches set up yet." })); return; }
  var g = el("div", { class: "grid" });
  B.forEach(function (b) {
    var c = el("div", { class: "card" },
      el("h2", {}, el("span", { text: b.branch }), el("span", { class: "small muted", text: b.updatedAt ? "last update " + tsTxt(b.updatedAt) : "" })),
      sg ? el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, el("span", { class: "pill " + ST[b.one][1], text: ST[b.one][0] }))
        : el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" },
        el("span", { class: "pill " + ST[b.ops][1], text: "Ops: " + ST[b.ops][0] }), el("span", { class: "pill " + ST[b.fin][1], text: "Finance: " + ST[b.fin][0] })),
      sg ? bar("Counted", b.oneDone, b.expected, "var(--ops)") : bar("Ops count", b.opsDone, b.expected, "var(--ops)"), sg ? null : bar("Finance check", b.finDone, b.expected, "var(--fin)"));
    if (b.variance) {
      var v = b.variance;
      c.append(el("div", { class: "vrow" },
        el("div", {}, el("b", { text: fmt(v.match) }), "lines match"),
        el("div", {}, el("b", { class: (v.recount + v.waiting) ? "neg" : "", text: fmt(v.recount + v.waiting) }), "recount / waiting"),
        el("div", {}, el("b", { class: v.skuOver ? "neg" : "", text: fmt(v.skuOver) }), "SKUs over tol."),
        el("div", {}, el("b", { class: v.varQ < 0 ? "neg" : v.varQ > 0 ? "pos" : "", text: fmt(v.varQ || 0) }), "variance PCS"),
        d.level === "value" ? el("div", {}, el("b", { class: v.varRM < 0 ? "neg" : v.varRM > 0 ? "pos" : "", text: fmt(v.varRM || 0, 2) }), "variance RM") : null,
        d.level === "value" ? el("div", {}, el("b", { text: fmt(v.sysRM || 0, 0) }), "system RM") : null));
    }
    g.append(c);
  });
  app.append(g);
}

var lastDcc = 0;
async function loadDcc() {
  var d = await rpc("public_dcc", {}), root = $("#dcc"); root.innerHTML = "";
  root.append(el("h2", { class: "sec", text: "Daily cycle count · this month" }));
  if (!(d.branches || []).some(function (b) { return b.universe; })) root.append(el("div", { class: "note", text: "Daily counts start after HQ uploads the first daily stock file." }));
  renderDccStats(root, d, {}); lastDcc = Date.now();
}
async function load() {
  try { if (Date.now() - lastDcc > 120000) await loadDcc(); var d = await rpc("public_dashboard", {}); draw(d); $("#live").textContent = "● Live"; $("#live").className = "pill ok"; }
  catch (e) { $("#live").textContent = "Offline - retrying"; $("#live").className = "pill warn"; if (!$("#app").children.length || /Loading/.test($("#app").textContent)) $("#app").innerHTML = '<div class="center muted">Can\'t reach the server. Retrying…</div>'; }
}
load(); setInterval(function () { if (!document.hidden) load(); }, 30000);
document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
