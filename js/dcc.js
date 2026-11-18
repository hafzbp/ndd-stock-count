/* Daily cycle count: shared pieces for the admin Dashboard tab, the HQ Daily tab, the supervisor screen
   and the public dashboard page. Rendering only - callers fetch the data. */
import { el, fmt } from "./ui.js";

export var ST = {
  ontime: ["On time", "ok"], late: ["Late", "warn"], missed: ["Missed", "bad"], progress: ["Counting", "warn"], todo: ["Not started", ""],
  skip: ["Skipped", "skip"], off: ["Off day", "off"], none: ["Nothing due", "off"], future: ["", "off"]
};
var WHY = { off: "Off day", monthly: "Monthly stock take", nostock: "No stock data", nothing: "Nothing due" };

/* status of one warehouse on one day, from admin_dcc_day / sup_day data */
export function dayStatus(r, date, today) {
  if (!r.take) return { t: WHY[r.why] || "Nothing due", c: "" };
  if (r.take.skipReason) return { t: "Skipped · " + r.take.skipReason, c: "" };
  if (r.submittedAt) return r.late ? { t: "Late", c: "warn" } : { t: "On time", c: "ok" };
  if (date < today) return { t: "Missed", c: "bad" };
  return r.started ? { t: "Counting", c: "warn" } : { t: "Not started", c: "" };
}

export var CLS = { A: "A · high value", B: "B · medium", C: "C · low", R: "Recount (yesterday out of tolerance)", S: "Added by supervisor" };
export function clsTag(c) { return el("span", { class: "cls cls-" + (c || "C"), title: CLS[c] || "", text: c || "" }); }

function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : null; }
function pctTxt(v) { return v == null ? "-" : v.toFixed(1) + "%"; }
function rm(v) { return v == null ? "-" : (v < 0 ? "-RM " : "RM ") + fmt(Math.abs(v), 0); }
function dd(d) { return Number(String(d).slice(8, 10)); }

/* small SVG line chart: series [{v:[numbers|null], color, dash}], labels [text], y range */
export function lineChart(series, labels, ymin, ymax, suffix, h) {
  var W = 600, H = h || 170, L = 34, B = 20, T = 8, R = 8, n = labels.length, NS = "http://www.w3.org/2000/svg";
  var x = function (i) { return L + (n <= 1 ? 0 : i * (W - L - R) / (n - 1)); }, y = function (v) { return T + (ymax - v) / (ymax - ymin) * (H - T - B); };
  var svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.setAttribute("class", "lc");
  function add(tag, a, txt) { var e = document.createElementNS(NS, tag); Object.keys(a).forEach(function (k) { e.setAttribute(k, a[k]); }); if (txt != null) e.textContent = txt; svg.appendChild(e); return e; }
  for (var k = 0; k <= 4; k++) { var v = ymin + (ymax - ymin) * k / 4, yy = y(v); add("line", { x1: L, x2: W - R, y1: yy, y2: yy, class: "g" }); add("text", { x: L - 4, y: yy + 3, "text-anchor": "end", class: "t" }, Math.round(v) + (suffix || "")); }
  var step = Math.max(1, Math.ceil(n / 10)); labels.forEach(function (l, i) { if (i % step === 0 || i === n - 1) add("text", { x: x(i), y: H - 5, "text-anchor": "middle", class: "t" }, l); });
  series.forEach(function (s) {
    var d = "", pen = false;
    s.v.forEach(function (v, i) { if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(Math.max(ymin, Math.min(ymax, v))).toFixed(1); pen = true; });
    if (d) add("path", { d: d, fill: "none", stroke: s.color, "stroke-width": s.w || 2, "stroke-dasharray": s.dash || "", "stroke-linejoin": "round", "stroke-linecap": "round" });
    var li = -1; s.v.forEach(function (v, i) { if (v != null) li = i; });
    if (li >= 0 && !s.dash) add("circle", { cx: x(li), cy: y(Math.max(ymin, Math.min(ymax, s.v[li]))), r: 3.5, fill: s.color });
  });
  return svg;
}

function kpi(v, l, s) { return el("div", { class: "stat" }, el("b", { text: v }), el("span", { text: l }), s ? el("div", { class: "small muted", text: s }) : null); }

/* st = admin_dcc_stats / public_dcc result. opts: { branch: name|null, target: 98 } */
export function ensureDccCss() { if (!document.getElementById("dcc-css")) document.head.append(el("style", { id: "dcc-css", text: DCC_CSS })); }
export function renderDccStats(root, st, opts) {
  opts = opts || {}; ensureDccCss();
  var target = opts.target || 98, inSet = function (n) { return (!opts.branch || n === opts.branch) && (!opts.only || opts.only.indexOf(n) >= 0); }, B = (st.branches || []).filter(function (b) { return inSet(b.branch); });
  var today = st.today, todayIdx = -1;
  if (B.length && B[0].cells) B[0].cells.forEach(function (c, i) { if (c.d === today) todayIdx = i; });
  var tdTot = 0, tdDone = 0, late = 0, missed = 0, uni = 0, cov = 0, ok = 0, n = 0, net = 0, abs = 0, pace = [];
  B.forEach(function (b) {
    (b.cells || []).forEach(function (c, i) {
      if (i === todayIdx && /ontime|late|progress|todo|missed/.test(c.st)) { tdTot++; if (c.st === "ontime" || c.st === "late") tdDone++; }
      if (c.st === "late") late++; if (c.st === "missed") missed++;
    });
    uni += b.universe; cov += Math.min(b.covered, b.universe); ok += b.ok; n += b.counted; net += b.net || 0; abs += b.abs || 0; if (b.pace != null) pace.push(b.pace);
  });
  var paceAvg = pace.length ? pace.reduce(function (a, x) { return a + x; }, 0) / pace.length : null, covP = pct(cov, uni), accP = pct(ok, n);
  if (!opts.noKpi) root.append(el("div", { class: "stats dccst" },
    kpi(todayIdx >= 0 ? tdDone + " / " + tdTot : "-", "Counted today", todayIdx >= 0 ? (tdTot - tdDone) + " still to submit" : "today is outside this period"),
    kpi(pctTxt(covP), "SKU coverage", paceAvg == null ? "" : "pace " + paceAvg.toFixed(0) + "% · " + (covP != null && covP >= paceAvg ? "on track" : "behind")),
    kpi(pctTxt(accP), "Accuracy (IRA)", "target " + target + "% · " + n + " SKU counts"),
    st.withRm ? kpi(rm(net), "Net variance", "absolute " + rm(abs)) : null,
    kpi(String(late + missed), "Late or missed days", late + " late · " + missed + " missed")));

  /* compliance grid */
  var days = (B[0] && B[0].cells) || [];
  var g = el("table", { class: "dccgrid" }), hr = el("tr", {}, el("th"));
  days.forEach(function (c) { hr.append(el("th", { text: String(dd(c.d)) })); });
  g.append(hr);
  B.forEach(function (b) {
    var tr = el("tr", {}, el("th", { class: "nm", text: b.branch.replace(/^NDD\s+/, "") }));
    b.cells.forEach(function (c) { tr.append(el("td", {}, el("i", { class: "c-" + c.st, title: b.branch + " · " + c.d + " · " + (ST[c.st] ? ST[c.st][0] : c.st) + (c.why ? " · " + c.why : "") }))); });
    g.append(tr);
  });
  root.append(el("div", { class: "card" }, el("h3", { text: "Compliance · warehouse × day" }),
    el("div", { class: "legend small muted" }, ["ontime", "late", "missed", "progress", "skip", "off"].map(function (k) { return el("span", {}, el("i", { class: "c-" + k }), k === "off" ? "Off day / nothing due" : ST[k][0]); })),
    el("div", { class: "tw" }, g)));

  /* trends (national) */
  var tr = st.trend || [], labels = tr.map(function (x) { return String(dd(x.d)); });
  var acc = tr.map(function (x) { return x.n ? Math.round(x.ok / x.n * 1000) / 10 : null; });
  var lo = Math.min.apply(null, acc.filter(function (v) { return v != null; }).concat([target - 4])); lo = Math.max(0, 100 - 4 * Math.ceil((100 - lo) / 4));
  var mon = String(st.to).slice(0, 7), mdays = new Date(Number(mon.slice(0, 4)), Number(mon.slice(5, 7)), 0).getDate();
  var covS = tr.map(function (x) { return st.universe ? Math.round(x.covered / st.universe * 1000) / 10 : null; }), ideal = tr.map(function (x) { return String(x.d).slice(0, 7) === mon ? Math.round(dd(x.d) / mdays * 1000) / 10 : null; });
  root.append(el("div", { class: "grid2" },
    el("div", { class: "card" }, el("h3", { text: "Accuracy trend" + (opts.only || opts.branch ? " (all warehouses)" : "") }), el("div", { class: "legend small muted" }, el("span", {}, el("i", { style: "background:#2a78d6" }), "Accuracy, all warehouses"), el("span", {}, "- - target " + target + "%")),
      lineChart([{ v: acc, color: "#2a78d6" }, { v: acc.map(function () { return target; }), color: "#898781", dash: "5 4", w: 1.5 }], labels, lo, 100, "%")),
    el("div", { class: "card" }, el("h3", { text: "Coverage this month" + (opts.only || opts.branch ? " (all warehouses)" : "") }), el("div", { class: "legend small muted" }, el("span", {}, el("i", { style: "background:#2a78d6" }), "SKUs counted at least once"), el("span", {}, "- - pace to 100%")),
      lineChart([{ v: covS, color: "#2a78d6" }, { v: ideal, color: "#898781", dash: "5 4", w: 1.5 }], labels, 0, 100, "%"))));

  /* per warehouse */
  var t = el("table", {}, el("tr", {}, ["Warehouse", "Coverage", "Pace", "Accuracy", st.withRm ? "Net var" : null, st.withRm ? "Abs var" : null, "On time", "Late", "Missed"].filter(Boolean).map(function (h, i) { return el("th", { class: i ? "n" : "", text: h }); })));
  B.forEach(function (b) {
    var cnt = { ontime: 0, late: 0, missed: 0 }; b.cells.forEach(function (c) { if (cnt[c.st] != null) cnt[c.st]++; });
    var cp = pct(Math.min(b.covered, b.universe), b.universe), ap = pct(b.ok, b.counted);
    t.append(el("tr", {}, el("td", { text: b.branch }),
      el("td", { class: "n", text: pctTxt(cp) + " (" + Math.min(b.covered, b.universe) + "/" + b.universe + ")" }), el("td", { class: "n muted", text: b.pace == null ? "-" : b.pace.toFixed(0) + "%" }),
      el("td", { class: "n" + (ap != null && ap < target ? " neg" : ""), text: pctTxt(ap) }),
      st.withRm ? el("td", { class: "n" + ((b.net || 0) < 0 ? " neg" : ""), text: rm(b.net) }) : null, st.withRm ? el("td", { class: "n", text: rm(b.abs) }) : null,
      el("td", { class: "n", text: String(cnt.ontime) }), el("td", { class: "n", text: String(cnt.late || "") }), el("td", { class: "n" + (cnt.missed ? " neg" : ""), text: String(cnt.missed || "") })));
  });
  root.append(el("div", { class: "card" }, el("h3", { text: "By warehouse" }), el("div", { class: "tw" }, t),
    el("p", { class: "small muted", text: "Coverage: SKUs counted at least once this month (daily or monthly count) out of the warehouse's SKUs with stock. Accuracy: SKU counts within tolerance of system stock." })));

  if (st.withRm && st.top) {
    var tt = el("table", {}, el("tr", {}, ["Warehouse", "SKU", "Var PCS", "Var RM", "Out of tolerance"].map(function (h, i) { return el("th", { class: i >= 2 ? "n" : "", text: h }); })));
    st.top.filter(function (x) { return inSet(x.branch); }).forEach(function (x) {
      tt.append(el("tr", {}, el("td", { text: x.branch }), el("td", { text: x.code + " " + (x.desc || "") }), el("td", { class: "n" + (x.varQ < 0 ? " neg" : ""), text: fmt(x.varQ) }),
        el("td", { class: "n" + ((x.varRm || 0) < 0 ? " neg" : ""), text: x.varRm == null ? "-" : fmt(x.varRm, 2) }), el("td", { class: "n" + (x.times > 1 ? " neg" : ""), text: x.times ? x.times + "×" : "" })));
    });
    if (!st.top.length) tt.append(el("tr", {}, el("td", { colspan: 5, class: "muted", text: "No variance in this period." })));
    root.append(el("div", { class: "card" }, el("h3", { text: "Top variance SKUs" }), el("div", { class: "tw" }, tt)));
  }
}

export var DCC_CSS = ".dccgrid{border-collapse:separate;border-spacing:2px}.dccgrid th{font-size:11px;font-weight:500;color:var(--mute);padding:0 2px;text-align:center}.dccgrid th.nm{text-align:left;padding-right:8px;white-space:nowrap}.dccgrid td{padding:0}.dccgrid th,.dccgrid td{border:0!important;background:transparent!important;line-height:1}.dccgrid tr{background:transparent!important}" +
  ".dccgrid i,.legend i{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:middle;background:var(--chip)}.legend{display:flex;flex-wrap:wrap;gap:12px;margin:4px 0 8px}.legend span{display:inline-flex;align-items:center;gap:5px}.legend i{width:10px;height:10px}" +
  ".c-ontime{background:#1D9E75!important}.c-late{background:#EF9F27!important}.c-missed{background:#E24B4A!important}.c-progress{background:#9FE1CB!important}.c-todo{background:transparent!important;border:1.5px dashed var(--mute)}.c-skip{background:#888780!important}.c-off,.c-none{background:var(--chip)!important}.c-future{background:transparent!important}" +
  ".grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.lc{width:100%;height:auto;display:block}.lc .g{stroke:var(--line);stroke-width:1}.lc .t{fill:var(--mute);font-size:11px}" +
  ".cls{display:inline-block;min-width:18px;text-align:center;font-size:11px;font-weight:700;border-radius:4px;padding:1px 4px;background:var(--chip);color:var(--ink)}.cls-A{background:#E6F1FB;color:#0C447C}.cls-B{background:#E1F5EE;color:#085041}.cls-R{background:#FCEBEB;color:#791F1F}.cls-S{background:#FAEEDA;color:#633806}";
