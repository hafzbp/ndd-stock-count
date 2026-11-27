/* KPI section of the HQ Dashboard + the "Demo data" generator.
   KPI001 Daily Cycle Count: days passed / HKE (working days that count). A day passes when the daily count is
   submitted the same day with at least the minimum SKUs (setting, default 10). Target 100%.
   KPI002 Stock Take: IRA by value from the month-end stock take = 1 - sum |SKU variance RM| / system RM. Target 99.95%.
   Data: admin_kpi (server) or demoKpi() (made up, client only - nothing is written). */
import { el, fmt, msg, errText, openModal, closeModal, saveBlob } from "./ui.js";

var T1 = 100, T2 = 99.95, MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/* day result of KPI001: label, colour var, counts in HKE, is a pass */
export var K1 = {
  pass: ["Passed", "--k-pass"], late: ["Submitted after the day", "--k-late"], under: ["Under minimum SKUs", "--k-under"],
  skip: ["Skipped by supervisor", "--k-skip"], missed: ["Not submitted", "--k-miss"],
  pending: ["Today, not submitted yet", ""], future: ["Coming working day", ""],
  off: ["Off day", ""], holiday: ["Holiday", ""], monthly: ["Monthly stock take open", ""], nolist: ["No daily list (no MB52)", ""]
};
var FAILS = ["late", "under", "skip", "missed"], HKE = ["pass"].concat(FAILS);

function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function monTxt(m) { return MON[Number(String(m).slice(5, 7)) - 1] + " " + String(m).slice(0, 4); }
function monShort(m) { return MON[Number(String(m).slice(5, 7)) - 1] + " " + String(m).slice(2, 4); }
function dTxt(d) { return Number(String(d).slice(8, 10)) + " " + MON[Number(String(d).slice(5, 7)) - 1]; }
function pct1(a, b) { return b ? a / b * 100 : null; }
function p1(v) { return v == null ? "-" : (Math.floor(v * 10) / 10).toFixed(1) + "%"; }          // floor: 99.96 never shows as 100.0
function p2(v) { return v == null ? "-" : (Math.floor(v * 100) / 100).toFixed(2) + "%"; }        // IRA: floor so 99.949 shows 99.94 (below target)
function rm(v) { return v == null ? "-" : (v < 0 ? "-RM " : "RM ") + fmt(Math.abs(v), 0); }
function short(n) { return String(n).replace(/^NDD\s+/i, ""); }
function months(today) { var out = [], d = new Date(today.slice(0, 7) + "-01T00:00:00"); for (var i = 0; i < 6; i++) { out.push(iso(d)); d.setMonth(d.getMonth() - 1); } return out; }

/* ---------- tooltip (hover on desktop, tap on iPad) ---------- */
function tipEl() { var t = document.getElementById("kpi-tip"); if (!t) { t = el("div", { id: "kpi-tip", role: "tooltip" }); document.body.append(t); } return t; }
function hideTip() { var t = document.getElementById("kpi-tip"); if (t) t.style.display = "none"; }
function showTip(ev, lines) {
  var t = tipEl(); t.replaceChildren(); [].concat(lines).forEach(function (l, i) { t.append(el("div", { class: i ? "" : "h", text: l })); });
  t.style.display = "block";
  var x = ev.clientX + 14, y = ev.clientY + 14, w = t.offsetWidth, h = t.offsetHeight;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14; if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
  t.style.left = Math.max(8, x) + "px"; t.style.top = Math.max(8, y) + "px";
}
function tip(node, lines) {
  node.addEventListener("mousemove", function (e) { showTip(e, typeof lines === "function" ? lines() : lines); });
  node.addEventListener("mouseleave", hideTip);
  node.addEventListener("click", function (e) { e.stopPropagation(); showTip(e, typeof lines === "function" ? lines() : lines); });
  return node;
}
if (typeof document !== "undefined") document.addEventListener("click", hideTip);

/* ---------- line chart with a hover column per point ---------- */
var NS = "http://www.w3.org/2000/svg";
function svgEl(tag, a, txt) { var e = document.createElementNS(NS, tag); Object.keys(a || {}).forEach(function (k) { e.setAttribute(k, a[k]); }); if (txt != null) e.textContent = txt; return e; }
function lineChart(o) {   // o: labels, series [{name, v, color, dash}], ymin, ymax, ticks, fmtY, fmtV, tipHead(i)
  var W = o.w || 600, H = o.h || 180, L = 46, Bm = 22, Tm = 10, R = 12, n = o.labels.length;
  var x = function (i) { return L + (n <= 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1)); }, y = function (v) { return Tm + (o.ymax - Math.max(o.ymin, Math.min(o.ymax, v))) / (o.ymax - o.ymin) * (H - Tm - Bm); };
  var s = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "kc" });
  o.ticks.forEach(function (v) { s.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "g" }), svgEl("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "t" }, o.fmtY(v))); });
  var step = Math.max(1, Math.ceil(n / 12));
  o.labels.forEach(function (l, i) { if (i % step === 0 || i === n - 1) s.append(svgEl("text", { x: x(i), y: H - 6, "text-anchor": "middle", class: "t" }, l)); });
  o.series.forEach(function (se) {
    var d = "", pen = false;
    se.v.forEach(function (v, i) { if (v == null) { if (!o.join) pen = false; return; } d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); pen = true; });
    if (d) s.append(svgEl("path", { d: d, fill: "none", stroke: se.color, "stroke-width": se.dash ? 1.5 : 2, "stroke-dasharray": se.dash || "", "stroke-linejoin": "round", "stroke-linecap": "round" }));
    if (!se.dash) se.v.forEach(function (v, i) { if (v != null && (n <= 12 || i === n - 1)) s.append(svgEl("circle", { cx: x(i), cy: y(v), r: 4, fill: se.color, stroke: "var(--card)", "stroke-width": 2 })); });
  });
  var guide = svgEl("line", { y1: Tm, y2: H - Bm, class: "gd", style: "display:none" }); s.append(guide);
  var colW = n <= 1 ? W - L - R : (W - L - R) / (n - 1);
  o.labels.forEach(function (l, i) {
    var r = svgEl("rect", { x: x(i) - colW / 2, y: 0, width: colW, height: H - Bm, fill: "transparent" });
    tip(r, function () {
      guide.setAttribute("x1", x(i)); guide.setAttribute("x2", x(i)); guide.style.display = "";
      return [o.tipHead(i)].concat(o.series.map(function (se) { return se.name + ": " + (se.v[i] == null ? "-" : o.fmtV(se.v[i])); }));
    });
    r.addEventListener("mouseleave", function () { guide.style.display = "none"; });
    s.append(r);
  });
  return s;
}
function legend(items) { return el("div", { class: "kl" }, items.map(function (it) { return el("span", {}, el("i", { class: it.line ? "ln" + (it.dash ? " ds" : "") : "", style: (it.line ? "border-color:" : "background:") + it.color }), it.label); })); }

/* ---------- KPI maths from admin_kpi branches ---------- */
export function kpi1Of(b) {
  var c = { pass: 0, late: 0, under: 0, skip: 0, missed: 0, pending: 0, future: 0, off: 0, holiday: 0, monthly: 0, nolist: 0 };
  (b.cells || []).forEach(function (x) { c[x.st] = (c[x.st] || 0) + 1; });
  c.hke = c.pass + c.late + c.under + c.skip + c.missed; c.left = c.pending + c.future; c.ach = pct1(c.pass, c.hke);
  return c;
}
export function pubView(K) {
  var sys = 0, abs = 0; (K.branches || []).forEach(function (b) { if (b.kpi2 && b.kpi2.sysRm != null) { sys += b.kpi2.sysRm; abs += b.kpi2.absRm; } });
  return Object.assign({}, K, { full: false, kpi2Ira: sys ? 1 - abs / sys : K.kpi2Ira, kpi2Take: K.kpi2Take ? { name: K.kpi2Take.name, closedAt: K.kpi2Take.closedAt } : null,
    branches: (K.branches || []).map(function (b) { return Object.assign({}, b, { top: [], kpi2: b.kpi2 ? { ira: b.kpi2.ira, skus: b.kpi2.skus, sysRm: null, absRm: null } : null }); }) });
}
export function kpi2Of(b) { return b.kpi2 && b.kpi2.ira != null ? b.kpi2.ira * 100 : null; }

/* ---------- the section ---------- */
/* ctx: { today, month, setMonth(m), data (admin_kpi / public_kpi / demoKpi result, null while loading), inScope(name), filtered, pub, demo, exportLib } */
export function kpiMonths(today) { return months(today); }
export function renderKpi(app, ctx) {
  var mons = months(ctx.today), pub = !!ctx.pub, inScope = ctx.inScope || function () { return true; };
  var head = el("div", { class: "kh" }, el("h2", { text: "KPI · " + monTxt(ctx.month) }),
    el("select", { style: "max-width:150px", "aria-label": "KPI month", onchange: function (e) { ctx.setMonth(e.target.value); } }, mons.map(function (m) { return el("option", { value: m, text: monTxt(m), selected: m === ctx.month }); })));
  app.append(head);
  var K = ctx.data;
  if (!K) { app.append(el("p", { class: "muted small", text: "Loading KPI…" })); return; }
  if (pub) K = pubView(K);   // never any RM or SKU on the public page, whatever the data holds
  if (!pub && ctx.exportLib) head.append(el("button", { class: "btn", text: "⬇ KPI Excel", title: "KPI001 + KPI002 for " + monTxt(K.month) + (ctx.filtered ? " (warehouses in view)" : ""), onclick: function () { exportKpi(K, inScope, ctx.exportLib, ctx.demo); } }));
  ctx = Object.assign({}, ctx, { inScope: inScope });

  var B = (K.branches || []).filter(function (b) { return ctx.inScope(b.branch); });
  var k1 = B.map(function (b) { return { b: b, c: kpi1Of(b) }; }), tot = { pass: 0, hke: 0, left: 0 }, why = { late: 0, under: 0, skip: 0, missed: 0 };
  k1.forEach(function (x) { tot.pass += x.c.pass; tot.hke += x.c.hke; tot.left += x.c.left; FAILS.forEach(function (f) { why[f] += x.c[f]; }); });
  var a1 = pct1(tot.pass, tot.hke), met1 = k1.filter(function (x) { return x.c.hke && x.c.pass === x.c.hke; }).length, with1 = k1.filter(function (x) { return x.c.hke; }).length;
  var k2 = B.filter(function (b) { return kpi2Of(b) != null; }), sys = 0, abs = 0;
  k2.forEach(function (b) { sys += b.kpi2.sysRm; abs += b.kpi2.absRm; });
  var a2 = pub ? (K.kpi2Ira == null || !k2.length ? null : K.kpi2Ira * 100) : sys ? (1 - abs / sys) * 100 : null, met2 = k2.filter(function (b) { return kpi2Of(b) >= T2 - 1e-9; }).length;
  var fails = tot.hke - tot.pass;

  /* tiles */
  var tile = function (big, label, sub, state) {
    return el("div", { class: "stat kt" }, el("span", { class: "kpi-id", text: label[0] }), el("b", { class: state === "bad" ? "neg" : "", text: big }), el("span", { text: label[1] }),
      sub ? el("div", { class: "small muted", text: sub }) : null,
      state ? el("span", { class: "pill " + state, text: state === "ok" ? "✓ On target" : "✕ Below target" }) : null);
  };
  app.append(el("div", { class: "stats dccst", style: "grid-template-columns:repeat(auto-fit,minmax(170px,1fr))" },
    tile(p1(a1), ["KPI001", "Daily cycle count"], tot.pass + " of " + tot.hke + " working days passed · target " + T1 + "%", a1 == null ? "" : a1 >= T1 ? "ok" : "bad"),
    tile(with1 ? met1 + " / " + with1 : "-", ["KPI001", "Warehouses at 100%"], fails ? fails + " day" + (fails > 1 ? "s" : "") + " failed · " + tot.left + " working days left" : tot.left + " working days left"),
    tile(a2 == null ? "-" : p2(a2), ["KPI002", "Stock take IRA (value)"], K.kpi2Hidden ? "Not published" : a2 == null ? "No month-end stock take marked yet" : "target ≥ " + T2 + "%" + (pub ? "" : " · |var| " + rm(abs) + " of " + rm(sys)), a2 == null ? "" : a2 >= T2 - 1e-9 ? "ok" : "bad"),
    tile(k2.length ? met2 + " / " + k2.length : "-", ["KPI002", "Warehouses ≥ " + T2 + "%"], K.kpi2Take ? (K.kpi2Take.name || "") + (K.kpi2Take.closedAt ? " · closed " + dTxt(iso(new Date(K.kpi2Take.closedAt))) : "") : "")));

  /* ===== KPI001 card ===== */
  var c1 = el("div", { class: "card" }, el("h3", {}, el("span", { class: "kpi-id", text: "KPI001" }), " Daily cycle count"),
    el("p", { class: "small muted", style: "margin:0 0 10px", text: "A working day passes when the count is submitted the same day with at least " + K.minSkus + " SKUs. Achievement = days passed ÷ HKE (working days so far, without holidays, monthly stock take days and days with no daily list). Target " + T1 + "%." }));
  var segs = ["pass"].concat(FAILS), keyItems = segs.map(function (s) { return { color: "var(" + K1[s][1] + ")", label: K1[s][0] }; });
  c1.append(legend(keyItems));
  var bars = el("div", { class: "kb" }), sorted = k1.slice().sort(function (a, b) { return (a.c.ach == null ? 999 : a.c.ach) - (b.c.ach == null ? 999 : b.c.ach) || a.b.branch.localeCompare(b.b.branch); });
  sorted.forEach(function (x) {
    var c = x.c, track = el("div", { class: "trk" });
    if (c.hke) segs.forEach(function (s) {
      if (!c[s]) return;
      track.append(tip(el("i", { style: "width:" + (c[s] / c.hke * 100) + "%;background:var(" + K1[s][1] + ")" }), [x.b.branch, K1[s][0] + ": " + c[s] + " of " + c.hke + " days"]));
    });
    else track.append(el("em", { class: "small muted", text: "no working day yet" }));
    var lines = function () { return [x.b.branch + " · " + p1(c.ach), "Passed " + c.pass + " of " + c.hke + " days (HKE)"].concat(FAILS.filter(function (f) { return c[f]; }).map(function (f) { return K1[f][0] + ": " + c[f]; })).concat(["Working days left: " + c.left]); };
    bars.append(tip(el("span", { class: "nm", text: short(x.b.branch) }), lines), track,
      el("span", { class: "v" + (c.ach != null && c.ach < T1 ? " neg" : ""), text: p1(c.ach) }), el("span", { class: "d small muted", text: c.pass + "/" + c.hke }));
  });
  c1.append(bars);

  /* fail reasons */
  if (fails) {
    var fr = el("div", { class: "kfr" }, el("span", { class: "small muted", text: "Why days failed: " }));
    FAILS.forEach(function (f) { if (why[f]) fr.append(el("span", { class: "kchip" }, el("i", { style: "background:var(" + K1[f][1] + ")" }), K1[f][0] + " ", el("b", { text: String(why[f]) }))); });
    c1.append(fr);
  }

  /* calendar heatmap */
  var days = (B[0] && B[0].cells) || [], g = el("table", { class: "kcal" }), hr = el("tr", {}, el("th"));
  days.forEach(function (c) { var dw = new Date(c.d + "T00:00:00").getDay(); hr.append(el("th", { class: dw === 0 ? "sun" : "", text: String(Number(c.d.slice(8, 10))) })); });
  g.append(hr);
  sorted.forEach(function (x) {
    var tr = el("tr", {}, el("th", { class: "nm", text: short(x.b.branch) }));
    (x.b.cells || []).forEach(function (c) {
      var lab = K1[c.st] ? K1[c.st][0] : c.st, mark = { holiday: "H", monthly: "M", nolist: "N" }[c.st] || "";
      var info = [x.b.branch + " · " + dTxt(c.d), lab + (c.why ? " · " + c.why : "")];
      if (c.sub) info.push("Submitted " + new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(c.sub)));
      if (c.skus != null && HKE.indexOf(c.st) >= 0 && c.st !== "missed" && c.st !== "skip") info.push(c.skus + " SKUs counted (min " + K.minSkus + ")");
      tr.append(el("td", {}, tip(el("i", { class: "k-" + c.st, text: mark }), info)));
    });
    g.append(tr);
  });
  c1.append(el("h4", { text: "Day by day" }),
    el("div", { class: "kl" }, segs.map(function (s) { return el("span", {}, el("i", { class: "k-" + s }), K1[s][0]); }).concat([
      el("span", {}, el("i", { class: "k-pending" }), "Today / to come"), el("span", {}, el("i", { class: "k-off" }), "Off day"),
      el("span", {}, el("i", { class: "k-holiday", text: "H" }), "Holiday"), el("span", {}, el("i", { class: "k-monthly", text: "M" }), "Monthly stock take"),
      el("span", {}, el("i", { class: "k-nolist", text: "N" }), "No list (no MB52)")])),
    el("div", { class: "tw" }, g));

  /* trends: daily pass rate this month + 6 months */
  var dl = days.map(function (c) { return String(Number(c.d.slice(8, 10))); }), dv = days.map(function (c, i) {
    var p = 0, h = 0; B.forEach(function (b) { var s = b.cells[i] && b.cells[i].st; if (HKE.indexOf(s) >= 0) { h++; if (s === "pass") p++; } }); return h ? p / h * 100 : null;
  });
  var lo1 = Math.min.apply(null, dv.filter(function (v) { return v != null; }).concat([80])); lo1 = Math.max(0, Math.floor(lo1 / 10) * 10);
  var tr6 = (K.trend || []).slice(), tl = tr6.map(function (t) { return monShort(t.month); }), tv = tr6.map(function (t) { return t.hke ? t.pass / t.hke * 100 : null; });
  var lo6 = Math.min.apply(null, tv.filter(function (v) { return v != null; }).concat([80])); lo6 = Math.max(0, Math.floor(lo6 / 10) * 10);
  var tk = function (lo) { var a = []; for (var v = lo; v <= 100; v += (100 - lo) / 4) a.push(v); return a; };
  var blue = "var(--k-line)", grey = "var(--mute)";
  c1.append(el("div", { class: "grid2", style: "margin-top:12px" },
    el("div", {}, el("h4", { text: "Share of warehouses passing, per day" }), legend([{ line: 1, color: blue, label: "Passed ÷ warehouses due" }, { line: 1, dash: 1, color: grey, label: "Target " + T1 + "%" }]),
      lineChart({ labels: dl, join: true, series: [{ name: "Passed", v: dv, color: blue }, { name: "Target", v: dv.map(function () { return T1; }), color: grey, dash: "5 4" }],
        ymin: lo1, ymax: 100, ticks: tk(lo1), fmtY: function (v) { return Math.round(v) + "%"; }, fmtV: function (v) { return p1(v); }, tipHead: function (i) { return days[i] ? dTxt(days[i].d) : ""; } })),
    el("div", {}, el("h4", { text: "Achievement, last 6 months" + (ctx.filtered ? " (all warehouses)" : "") }), legend([{ line: 1, color: blue, label: "KPI001 achievement" }, { line: 1, dash: 1, color: grey, label: "Target " + T1 + "%" }]),
      lineChart({ labels: tl, series: [{ name: "Achievement", v: tv, color: blue }, { name: "Target", v: tv.map(function () { return T1; }), color: grey, dash: "5 4" }],
        ymin: lo6, ymax: 100, ticks: tk(lo6), fmtY: function (v) { return Math.round(v) + "%"; }, fmtV: function (v) { return p1(v); }, tipHead: function (i) { return monTxt(tr6[i].month) + " · " + tr6[i].pass + "/" + tr6[i].hke + " days"; } }))));
  app.append(c1);

  /* ===== KPI002 card ===== */
  var c2 = el("div", { class: "card" }, el("h3", {}, el("span", { class: "kpi-id", text: "KPI002" }), " Stock take (end of month)"),
    el("p", { class: "small muted", style: "margin:0 0 10px", text: "IRA by value = 1 − Σ |physical − SAP| value per SKU ÷ SAP value, from the good-stock stock take marked as month-end for " + monTxt(K.month) + ". A SKU nobody counted counts as not found. Target ≥ " + T2 + "%." }));
  if (K.kpi2Hidden) {
    c2.append(el("div", { class: "banner warn", text: "The stock take result is published here when HQ sets the public dashboard to show values." }));
  } else if (!k2.length) {
    c2.append(el("div", { class: "banner warn", text: pub ? "No month-end stock take result for " + monTxt(K.month) + " yet." : K.kpi2Take ? "The month-end stock take has no warehouse in view." : "No month-end stock take is marked for " + monTxt(K.month) + " yet. When you create the monthly stock take, tick \"Month-end stock take (KPI002)\" - its result shows here once it is closed." }));
  } else {
    var ir = k2.map(function (b) { return { b: b, v: kpi2Of(b) }; }).sort(function (a, b) { return a.v - b.v; });
    var mn = Math.min.apply(null, ir.map(function (x) { return x.v; })), lo = Math.min(99.8, Math.floor((mn - 0.02) * 10) / 10);
    var w = function (v) { return Math.max(0, Math.min(100, (v - lo) / (100 - lo) * 100)); };
    c2.append(legend([{ color: "var(--k-pass)", label: "On target (≥ " + T2 + "%)" }, { color: "var(--k-miss)", label: "Below target" }, { line: 1, color: "var(--ink)", label: "Target line" }]));
    var ib = el("div", { class: "kb kb2" });
    ir.forEach(function (x) {
      var ok = x.v >= T2 - 1e-9, k = x.b.kpi2;
      var lines = [x.b.branch + " · IRA " + p2(x.v)].concat(pub ? [] : ["SAP value " + rm(k.sysRm), "|Variance| " + rm(k.absRm)]).concat([k.skus + " SKUs"]);
      ib.append(tip(el("span", { class: "nm", text: short(x.b.branch) }), lines),
        tip(el("div", { class: "trk" }, el("i", { style: "width:" + w(x.v) + "%;background:var(" + (ok ? "--k-pass" : "--k-miss") + ")" }), el("b", { style: "left:" + w(T2) + "%" })), lines),
        el("span", { class: "v" + (ok ? "" : " neg"), text: p2(x.v) }), el("span", { class: "d small muted", text: ok ? "✓" : "✕" }));
    });
    var ax = el("div", { class: "kax" }, el("span"), el("div", {}, [lo, lo + (100 - lo) / 2, 100].map(function (v, i) { return el("span", { style: "left:" + (i * 50) + "%", text: v.toFixed(2) + "%" }); })), el("span"), el("span"));
    c2.append(ib, ax, el("p", { class: "small muted", style: "margin:2px 0 0", text: "Axis starts at " + lo.toFixed(2) + "% (not 0) so differences near the target are visible." }));

    var t2 = el("table", {}, el("tr", {}, (pub ? ["Warehouse", "SKUs", "IRA", ""] : ["Warehouse", "SKUs", "SAP value", "|Variance|", "IRA", ""]).map(function (h, i, a) { return el("th", { class: i && i < a.length - 1 ? "n" : "", text: h }); })));
    ir.slice().reverse().forEach(function (x) {
      var ok = x.v >= T2 - 1e-9;
      t2.append(el("tr", {}, el("td", { text: x.b.branch }), el("td", { class: "n", text: String(x.b.kpi2.skus) }), pub ? null : el("td", { class: "n", text: rm(x.b.kpi2.sysRm) }), pub ? null : el("td", { class: "n", text: rm(x.b.kpi2.absRm) }),
        el("td", { class: "n" + (ok ? "" : " neg"), text: p2(x.v) }), el("td", {}, el("span", { class: "pill " + (ok ? "ok" : "bad"), text: ok ? "✓ On target" : "✕ Below" }))));
    });
    if (!pub) t2.append(el("tr", { class: "tot" }, el("td", { text: "Total" }), el("td"), el("td", { class: "n", text: rm(sys) }), el("td", { class: "n", text: rm(abs) }), el("td", { class: "n" + (a2 >= T2 - 1e-9 ? "" : " neg"), text: p2(a2) }), el("td")));

    var top = []; k2.forEach(function (b) { (b.top || []).forEach(function (t) { top.push(Object.assign({ branch: b.branch }, t)); }); });
    top.sort(function (a, b) { return Math.abs(b.varRm) - Math.abs(a.varRm); }); top = top.slice(0, 10);
    var t3 = el("table", {}, el("tr", {}, ["Warehouse", "SKU", "Var PCS", "Var RM"].map(function (h, i) { return el("th", { class: i >= 2 ? "n" : "", text: h }); })));
    top.forEach(function (t) { t3.append(el("tr", {}, el("td", { text: short(t.branch) }), el("td", { text: t.code + " " + (t.desc || "") }), el("td", { class: "n" + (t.varQ < 0 ? " neg" : ""), text: fmt(t.varQ) }), el("td", { class: "n" + (t.varRm < 0 ? " neg" : ""), text: fmt(t.varRm, 2) }))); });
    if (!top.length) t3.append(el("tr", {}, el("td", { colspan: 4, class: "muted", text: "No variance." })));

    var iv = tr6.map(function (t) { return t.ira == null ? null : t.ira * 100; }), ivs = iv.filter(function (v) { return v != null; });
    var ilo = Math.min(99.8, Math.floor((Math.min.apply(null, ivs.concat([99.9])) - 0.02) * 10) / 10);
    c2.append(el("h4", { text: "By warehouse" }), el("div", { class: "tw" }, t2),
      pub ? null : el("h4", { text: "Biggest SKU variances (value)" }), pub ? null : el("div", { class: "tw" }, t3),
      el("h4", { text: "IRA, last 6 months" + (ctx.filtered ? " (all warehouses)" : "") }),
      legend([{ line: 1, color: blue, label: "KPI002 IRA" }, { line: 1, dash: 1, color: grey, label: "Target " + T2 + "%" }]),
      lineChart({ labels: tl, w: 960, h: 190, series: [{ name: "IRA", v: iv, color: blue }, { name: "Target", v: iv.map(function () { return T2; }), color: grey, dash: "5 4" }],
        ymin: ilo, ymax: 100, ticks: [ilo, ilo + (100 - ilo) / 2, 100], fmtY: function (v) { return v.toFixed(2) + "%"; }, fmtV: function (v) { return p2(v); },
        tipHead: function (i) { return monTxt(tr6[i].month) + (tr6[i].ira == null ? " · no month-end stock take" : ""); } }));
  }
  app.append(c2);
}

/* ---------- KPI Excel ---------- */
export async function exportKpi(K, inScope, xlsxLib, demo) {
  try { await xlsxLib(); } catch (e) { return msg("Can't export", errText(e)); }
  var B = (K.branches || []).filter(function (b) { return inScope(b.branch); });
  var s1 = [["Warehouse", "Region", "NOM", "HKE (working days so far)", "Passed", "Submitted after the day", "Under min SKUs", "Skipped", "Not submitted", "Achievement %", "Working days left", "Holidays", "Monthly stock take days", "Days with no list"]];
  B.forEach(function (b) { var c = kpi1Of(b); s1.push([b.branch, b.region || "", b.nom || "", c.hke, c.pass, c.late, c.under, c.skip, c.missed, c.ach == null ? null : Math.round(c.ach * 100) / 100, c.left, c.holiday, c.monthly, c.nolist]); });
  var days = (B[0] && B[0].cells) || [], s2 = [["Warehouse"].concat(days.map(function (c) { return c.d; }))];
  B.forEach(function (b) { s2.push([b.branch].concat((b.cells || []).map(function (c) { return K1[c.st] ? K1[c.st][0] : c.st; }))); });
  var s3 = [["Warehouse", "SKUs", "SAP value (RM)", "Absolute variance (RM)", "IRA %", "On target (≥ " + T2 + "%)"]];
  B.forEach(function (b) { var v = kpi2Of(b); if (v == null) return; s3.push([b.branch, b.kpi2.skus, b.kpi2.sysRm, b.kpi2.absRm, Math.round(v * 10000) / 10000, v >= T2 - 1e-9 ? "Yes" : "No"]); });
  if (s3.length === 1) s3.push(["No month-end stock take marked for this month."]);
  var s4 = [["Warehouse", "Item", "Description", "Var PCS", "Var RM"]];
  B.forEach(function (b) { (b.top || []).forEach(function (t) { s4.push([b.branch, t.code, t.desc || "", t.varQ, t.varRm]); }); });
  var notes = [["My Warehouse - KPI report" + (demo ? " (DEMO DATA - made up)" : "")], ["Month", monTxt(K.month)], ["As of", K.today], ["Minimum SKUs a day", K.minSkus], [],
    ["KPI001", "Daily cycle count. A working day passes when the count is submitted the same day (Malaysia time) with at least the minimum SKUs counted. Achievement = passed ÷ HKE. Target " + T1 + "%."],
    ["HKE", "Working days of the warehouse so far, without off days, holidays, days a monthly stock take was open and days with no daily list (no MB52 uploaded). A day the supervisor skipped counts as failed."],
    ["KPI002", "Stock take at month end. IRA = 1 − Σ |physical − SAP| RM per SKU ÷ SAP value (good stock). A SKU nobody counted counts as not found. Target ≥ " + T2 + "%."],
    ["Stock take used", K.kpi2Take ? K.kpi2Take.name : "none marked"]];
  var wb = XLSX.utils.book_new(), add = function (n, a, w) { var ws = XLSX.utils.aoa_to_sheet(a); ws["!cols"] = w.map(function (x) { return { wch: x }; }); XLSX.utils.book_append_sheet(wb, ws, n); };
  add("KPI001", s1, [20, 12, 14, 12, 8, 12, 10, 9, 10, 12, 10, 9, 12, 10]);
  add("KPI001 by day", s2, [20].concat(days.map(function () { return 12; })));
  add("KPI002", s3, [20, 8, 16, 16, 10, 12]);
  add("KPI002 top SKUs", s4, [20, 12, 36, 10, 12]);
  add("Notes", notes, [16, 110]);
  var fname = "KPI_" + K.month.slice(0, 7) + (demo ? "_DEMO" : "") + ".xlsx", buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  window.__kpiXlsx = { sheets: wb.SheetNames, kpi1: s1, kpi2: s3 };
  saveBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fname);
  openModal(function (sh) { sh.append(el("h3", { text: "Exported ✓" }), el("p", { class: "muted", text: fname }), el("button", { class: "btn block", text: "OK", onclick: closeModal })); });
}

/* =================== DEMO DATA (client only, nothing is saved) =================== */
var DEMO_BR = [
  ["NDD Shah Alam", "Central", "NOM Peninsular", 1.00, 0.995, 3.8e6], ["NDD Semenyih", "Central", "NOM Peninsular", 0.97, 0.990, 2.9e6],
  ["NDD Johor", "Southern", "NOM Peninsular", 0.95, 0.985, 3.1e6], ["NDD Melaka", "Southern", "NOM Peninsular", 0.99, 0.992, 1.4e6],
  ["NDD Penang", "Northern", "NOM Peninsular", 0.93, 0.980, 2.6e6],
  ["NDD Kelantan", "East Coast", "NOM Peninsular", 0.88, 0.970, 1.2e6, [7, 1, 2, 3, 4]], ["NDD Terengganu", "East Coast", "NOM Peninsular", 0.96, 0.985, 1.1e6, [7, 1, 2, 3, 4]],
  ["NDD Sabah", "Sabah", "NOM East Malaysia", 0.94, 0.982, 2.2e6], ["NDD Keningau", "Sabah", "NOM East Malaysia", 0.85, 0.965, 0.6e6],
  ["NDD Kuching", "Sarawak", "NOM East Malaysia", 0.99, 0.993, 2.0e6], ["NDD Miri", "Sarawak", "NOM East Malaysia", 0.92, 0.978, 0.9e6],
  ["NDD Sibu", "Sarawak", "NOM East Malaysia", 0.90, 0.975, 0.8e6]
].map(function (r) { return { name: r[0], region: r[1], nom: r[2], rel: r[3], acc: r[4], val: r[5], days: r[6] || [1, 2, 3, 4, 5, 6] }; });
var DEMO_SKU = [["310101", "Wafer Cheese 45g x 20"], ["310205", "Wafer Choco 45g x 20"], ["320110", "Roll Wafer Cheese 18g x 10"], ["330417", "Cheese Sandwich Biscuit 8 x 10"],
  ["340022", "Choco Stick 16g x 20"], ["350318", "Corn Snack Cheese 55g x 30"], ["310944", "Wafer Cheese Family 145g x 12"], ["360051", "Chocolate Wafer Bar 21g x 24"],
  ["320388", "Roll Wafer Choco 18g x 10"], ["370202", "Cream Biscuit Vanilla 8 x 10"], ["380119", "Jelly Drink 150ml x 24"], ["390707", "Wafer Cheese Mini 8g x 30"]];
var NAMES = ["Aiman", "Siti", "Hafiz R.", "Nurul", "Faizal", "Aina", "Daniel", "Mei Ling", "Kumar", "Syafiq", "Farah", "Jason", "Izzat", "Liyana", "Rizal", "Wani", "Adam", "Priya", "Hakim", "Zara", "Amir", "Chong", "Dayang", "Gary", "Huda", "Ikram"];

function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rnd(seed) { var a = hash(seed); return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function addD(s, n) { var d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return iso(d); }
function lastDay(m) { var d = new Date(m + "T00:00:00"); d.setMonth(d.getMonth() + 1); d.setDate(0); return iso(d); }
function holidayOf(m) { var r = rnd("hol" + m); if (r() >= 0.6) return null; var d = m.slice(0, 8) + String(8 + Math.floor(r() * 14)).padStart(2, "0"); while ([0, 5, 6].indexOf(new Date(d + "T00:00:00").getDay()) >= 0) d = addD(d, 1); return d; }
function isWork(b, d) { var w = new Date(d + "T00:00:00").getDay() || 7; return b.days.indexOf(w) >= 0; }
function lastWork(b, m) { var d = lastDay(m); while (!isWork(b, d)) d = addD(d, -1); return d; }

/* one warehouse-day of the demo world */
function demoDay(b, d, today) {
  var m = d.slice(0, 8) + "01", r = rnd(b.name + d), listed = 10 + Math.floor(r() * 7);
  if (!isWork(b, d)) return { st: "off" };
  if (d === holidayOf(m)) return { st: "holiday", why: "Public holiday (demo)" };
  if (d === lastWork(b, m)) return { st: "monthly" };
  if (d > today) return { st: "future" };
  var u = r(), base = { listed: listed, skus: listed, from: "07:30", to: "10:00" };
  var mk = function (st, extra) { return Object.assign({}, base, { st: st }, extra || {}); };
  if (d === today) return u < 0.55 ? mk("pass", { sub: d + "T09:" + String(10 + Math.floor(r() * 45)).padStart(2, "0") + ":00+08:00" }) : mk("pending", { skus: u < 0.8 ? Math.floor(listed * r()) : 0 });
  if (r() < 0.01) return { st: "nolist" };
  if (u < b.rel) return mk("pass", { sub: d + "T0" + (8 + Math.floor(r() * 2)) + ":" + String(Math.floor(r() * 59)).padStart(2, "0") + ":00+08:00" });
  var f = r();
  if (f < 0.35) return mk("late", { sub: addD(d, 1) + "T08:15:00+08:00" });
  if (f < 0.6) return mk("under", { skus: 5 + Math.floor(r() * 4), sub: d + "T09:40:00+08:00" });
  if (f < 0.75) return mk("skip", { why: ["Stock transfer audit", "Short of staff", "Truck loading all morning"][Math.floor(r() * 3)], skus: 0 });
  return mk("missed", { skus: 0 });
}
function monthDays(m) { var out = [], d = m, e = lastDay(m); while (d <= e) { out.push(d); d = addD(d, 1); } return out; }

function demoKpi1Month(b, m, today) { return monthDays(m).map(function (d) { var x = demoDay(b, d, today); return { d: d, st: x.st, skus: x.skus == null ? null : x.skus, sub: x.sub || null, why: x.why || null }; }); }
function demoKpi2(b, m) {
  var r = rnd("k2" + b.name + m), sys = Math.round(b.val * (0.85 + r() * 0.3)), ira = Math.min(0.99998, 0.9992 + (b.acc - 0.96) * 0.02 + (r() - 0.5) * 0.0006);
  var abs = Math.round(sys * (1 - ira) * 100) / 100, n = 4 + Math.floor(r() * 2), left = abs, top = [];
  for (var i = 0; i < n; i++) {
    var s = DEMO_SKU[Math.floor(r() * DEMO_SKU.length)], part = i === n - 1 ? left * 0.6 : left * (0.35 + r() * 0.2), sign = r() < 0.65 ? -1 : 1;
    left -= part; top.push({ code: s[0], desc: s[1], varQ: sign * Math.max(1, Math.round(part / (40 + r() * 60))), varRm: Math.round(sign * part * 100) / 100 });
  }
  top.sort(function (a, b2) { return Math.abs(b2.varRm) - Math.abs(a.varRm); });
  return { kpi2: { sysRm: sys, absRm: abs, skus: 120 + Math.floor(r() * 140), ira: Math.round(ira * 1e6) / 1e6 }, top: top };
}
export function demoKpi(today, month) {
  var trend = months(today).reverse().map(function (m) {
    var p = 0, h = 0, sys = 0, abs = 0;
    DEMO_BR.forEach(function (b) { demoKpi1Month(b, m, today).forEach(function (c) { if (HKE.indexOf(c.st) >= 0) { h++; if (c.st === "pass") p++; } }); var k = demoKpi2(b, m).kpi2; sys += k.sysRm; abs += k.absRm; });
    return { month: m, pass: p, hke: h, ira: Math.round((1 - abs / sys) * 1e6) / 1e6 };
  });
  return {
    month: month, today: today, minSkus: 10, demo: true, trend: trend,
    kpi2Take: { id: "demo", name: "Month-end stock take " + monTxt(month) + " (demo)", closedAt: lastDay(month) + "T18:00:00+08:00" },
    branches: DEMO_BR.map(function (b) { var k2 = demoKpi2(b, month); return { branch: b.name, region: b.region, nom: b.nom, cells: demoKpi1Month(b, month, today), kpi2: k2.kpi2, top: k2.top }; })
  };
}

/* the operations sections of the dashboard (admin_dcc_stats / insights / today shapes) */
var OPS = { pass: "ontime", under: "ontime", late: "late", missed: "missed", skip: "skip", pending: "todo" };
function dayRes(b, d, x) {
  var r = rnd("res" + b.name + d), n = x.skus || 0, over = 0, nis = 0, within = 0;
  for (var i = 0; i < n; i++) { var u = r(); if (u > b.acc) { if (r() < 0.2) nis++; else over++; } else if (u > b.acc - 0.08) within++; }
  var val = n * (900 + r() * 2600), net = -Math.round((over + nis) * (60 + r() * 400) * (r() < 0.7 ? 1 : -1)), abs = Math.abs(net) + Math.round(within * (5 + r() * 30));
  return { n: n, ok: n - over - nis - within, within: within, over: over, nis: nis, net: net, abs: abs, val: val, mins: 35 + Math.floor(r() * 70), who: NAMES[hash(b.name) % NAMES.length] + (r() < 0.5 ? ", " + NAMES[(hash(b.name) + 7) % NAMES.length] : "") };
}
export function demoOps(today, from, to) {
  var mStart = to.slice(0, 8) + "01", mEnd = lastDay(mStart), dates = []; for (var d = from; d <= to; d = addD(d, 1)) dates.push(d);
  var trend = {}, top = [], counters = {}, abc = [], mix = [], repeat = [], rows = [];
  var branches = DEMO_BR.map(function (b) {
    var uni = 130 + (hash(b.name) % 130), ok = 0, n = 0, net = 0, abs = 0, cells = [];
    dates.forEach(function (d) {
      var x = demoDay(b, d, today), st = OPS[x.st] || (x.st === "future" ? "future" : "off"), t = trend[d] = trend[d] || { d: d, ok: 0, n: 0, covered: 0 };
      if (x.st === "pending" && x.skus) st = "progress";
      cells.push({ d: d, st: st, why: x.why || null });
      if (/ontime|late/.test(st)) {
        var rr = dayRes(b, d, x); ok += rr.ok + rr.within; n += rr.n; net += rr.net; abs += rr.abs; t.ok += rr.ok + rr.within; t.n += rr.n;
        var who = rr.who.split(", "); who.forEach(function (w) { var c = counters[w] = counters[w] || { name: w, br: {}, days: 0, skus: 0, ok: 0, n: 0, minutes: 0 }; c.br[b.name] = 1; c.days++; c.skus += rr.n; c.ok += rr.ok + rr.within; c.n += rr.n; c.minutes += rr.mins; });
      }
    });
    var wd = monthDays(mStart).filter(function (d) { return isWork(b, d); }), gone = wd.filter(function (d) { return d <= to; }).length, pace = wd.length ? gone / wd.length * 100 : null;
    var covered = Math.min(uni, Math.round(uni * (pace / 100) * (0.75 + b.rel * 0.3)));
    dates.forEach(function (d) { if (d.slice(0, 7) === to.slice(0, 7)) trend[d].covered += Math.round(covered * (Number(d.slice(8, 10)) / Number(to.slice(8, 10)))); });
    var r = rnd("ins" + b.name + to);
    mix.push({ branch: b.name, ok: Math.round(n * b.acc * 0.9), within: Math.round(n * b.acc * 0.1), over: Math.round(n * (1 - b.acc) * 0.8), nis: Math.round(n * (1 - b.acc) * 0.2) });
    [["A", 0.2, 4], ["B", 0.25, 2], ["C", 0.55, 1]].forEach(function (k) { var sk = Math.round(uni * k[1]), times = Math.round(sk * k[2] * (pace / 100) * (0.8 + b.rel * 0.25)); abc.push({ branch: b.name, cls: k[0], skus: sk, times: times, once: Math.min(sk, Math.round(times * 0.8)), target: k[2], pace: pace }); });
    if (r() < 0.55) for (var i = 0; i < 1 + Math.floor(r() * 2); i++) { var s = DEMO_SKU[Math.floor(r() * DEMO_SKU.length)]; repeat.push({ branch: b.name, code: s[0], desc: s[1], times: 2 + Math.floor(r() * 3), netQ: -Math.round(2 + r() * 40), absRm: Math.round(80 + r() * 1500), last: addD(to, -Math.floor(r() * 6)) }); }
    for (var j = 0; j < 2; j++) { var s2 = DEMO_SKU[Math.floor(r() * DEMO_SKU.length)], q = Math.round((r() - 0.7) * 60); top.push({ branch: b.name, code: s2[0], desc: s2[1], varQ: q, varRm: Math.round(q * (20 + r() * 50) * 100) / 100, times: 1 + Math.floor(r() * 3) }); }
    /* today's row */
    var x = demoDay(b, today, today), rr2 = /pass|late|under/.test(x.st) ? dayRes(b, today, x) : null, status = x.st === "pass" ? "ontime" : x.st === "pending" ? (x.skus ? "progress" : "todo") : x.st === "off" ? "off" : x.st === "holiday" ? "nothing" : x.st === "monthly" ? "monthly" : (OPS[x.st] || "nothing");
    rows.push({ branch: b.name, region: b.region, nom: b.nom, status: status, from: "07:30", to: "10:00", snapDate: today, startedAt: x.sub ? today + "T08:05:00+08:00" : x.skus ? today + "T08:20:00+08:00" : null,
      submittedAt: x.sub || null, minutes: rr2 ? rr2.mins : null, listed: x.listed || 0, counted: rr2 ? rr2.n : (x.skus || 0), result: rr2 ? { ok: rr2.ok, within: rr2.within, over: rr2.over, nis: rr2.nis } : null, who: rr2 ? rr2.who : "", skipReason: x.st === "skip" ? x.why : null });
    return { branch: b.name, cells: cells, universe: uni, covered: covered, ok: ok, counted: n, net: net, abs: abs, pace: pace };
  });
  top.sort(function (a, b) { return Math.abs(b.varRm) - Math.abs(a.varRm); });
  var uniAll = branches.reduce(function (a, b) { return a + b.universe; }, 0);
  return {
    stats: { from: from, to: to, today: today, withRm: true, universe: uniAll, branches: branches, trend: dates.map(function (d) { return trend[d]; }).filter(function (t) { return t.d <= today; }), top: top.slice(0, 15) },
    ins: { month: mStart, mix: mix, abc: abc, repeat: repeat.sort(function (a, b) { return b.times - a.times; }),
      counters: Object.keys(counters).map(function (k) { var c = counters[k]; return { name: c.name, branches: Object.keys(c.br).join(", "), days: c.days, skus: c.skus, ok: c.ok, n: c.n, minutes: c.minutes }; }).sort(function (a, b) { return b.skus - a.skus; }) },
    today: { date: today, today: today, now: new Date().toISOString(), snapshot: { date: today }, rows: rows }
  };
}

export var KPI_CSS =
  ":root{--k-pass:#1D9E75;--k-late:#EF9F27;--k-under:#378ADD;--k-skip:#D4537E;--k-miss:#A32D2D;--k-line:#2a78d6}" +
  "@media (prefers-color-scheme:dark){:root{--k-late:#BA7517;--k-line:#5b9ee9}}" +
  ".kh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0 10px}.kh h2{margin:0;font-size:19px;flex:1}" +
  ".kpi-id{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.04em;padding:2px 6px;border-radius:4px;background:var(--chip);color:var(--ink);vertical-align:middle}" +
  ".stat.kt{display:flex;flex-direction:column;gap:3px;align-items:flex-start}.stat.kt .pill{margin-top:4px}" +
  ".kl{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--mute);margin:2px 0 10px}.kl span{display:inline-flex;align-items:center;gap:5px}" +
  ".kl i{display:inline-block;width:11px;height:11px;border-radius:3px;font-style:normal;font-size:8.5px;line-height:11px;text-align:center;font-weight:700}.kl i.ln{width:16px;height:0;border-top:2px solid;border-radius:0}.kl i.ln.ds{border-top-style:dashed}" +
  ".kb{display:grid;grid-template-columns:minmax(80px,max-content) 1fr 56px 40px;gap:7px 10px;align-items:center;font-size:13px}" +
  ".kb .trk{position:relative;display:flex;gap:2px;height:14px;background:var(--chip);border-radius:0 4px 4px 0}.kb .trk i{display:block;height:100%;cursor:default}.kb .trk i:last-child{border-radius:0 4px 4px 0}" +
  ".kb .v{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}.kb .d{text-align:right;font-variant-numeric:tabular-nums}.kb .nm{cursor:default}" +
  ".kb2 .trk{display:block}.kb2 .trk i{position:absolute;left:0;top:0;bottom:0}.kb2 .trk b{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--ink)}" +
  ".kax{display:grid;grid-template-columns:minmax(80px,max-content) 1fr 56px 40px;gap:0 10px;font-size:11px;color:var(--mute);margin-top:4px}.kax div{position:relative;height:14px}.kax div span{position:absolute;transform:translateX(-50%);white-space:nowrap}.kax div span:first-child{transform:none}.kax div span:last-child{transform:translateX(-100%)}" +
  ".kfr{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}.kchip{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;border:1px solid var(--line);border-radius:99px;padding:3px 10px}.kchip i{width:9px;height:9px;border-radius:2px;display:inline-block}" +
  ".card h4{font-size:13.5px;margin:14px 0 4px}" +
  ".kcal{border-collapse:separate;border-spacing:2px}.kcal th{font-size:10.5px;font-weight:500;color:var(--mute);padding:0;text-align:center;min-width:16px}.kcal th.sun{color:var(--bad)}.kcal th.nm{text-align:left;padding-right:8px;white-space:nowrap;font-size:12px;color:var(--ink)}.kcal td{padding:0}" +
  ".kcal i,.kl i[class^=k-]{display:block;width:16px;height:16px;border-radius:3px;font-style:normal;font-size:9.5px;font-weight:700;line-height:16px;text-align:center;color:var(--mute);cursor:default}.kl i[class^=k-]{display:inline-block;width:13px;height:13px;line-height:13px;font-size:8.5px}" +
  ".k-pass{background:var(--k-pass)}.k-late{background:var(--k-late)}.k-under{background:var(--k-under)}.k-skip{background:var(--k-skip)}.k-missed{background:var(--k-miss)}" +
  ".k-pending,.k-future{background:transparent;border:1.5px dashed var(--mute);box-sizing:border-box}.k-off{background:var(--chip);opacity:.55}.k-holiday,.k-monthly,.k-nolist{background:var(--chip)}" +
  ".kc{width:100%;height:auto;display:block;overflow:visible}.kc .g{stroke:var(--line);stroke-width:1}.kc .t{fill:var(--mute);font-size:11px}.kc .gd{stroke:var(--mute);stroke-width:1;stroke-dasharray:3 3}" +
  "#kpi-tip{position:fixed;z-index:50;display:none;pointer-events:none;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:12.5px;box-shadow:0 4px 16px rgba(0,0,0,.18);max-width:280px}#kpi-tip .h{font-weight:700;margin-bottom:2px}" +
  ".tot td{font-weight:700;border-top:2px solid var(--line)}.demo-bar{display:flex;gap:10px;align-items:center}";
