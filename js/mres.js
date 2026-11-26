/* Final-results cards shared by the admin Dashboard (js/mdash.js) and the public dashboard (dashboard/dash.js).
   They draw from the saved results ("snapshot", see resultsSnapshot in mdash.js):
     d.skus  = [{c, d, b, sq, pq, cnt}]      one row per SKU and warehouse with a difference (qty in pieces)
     d.rm.skuV = [[sysRM, countedRM], ...]  same order as d.skus (money; only there when RM may be shown)
     d.wh[i].q  = {short, excess} pieces, d.wh[i].rm = {short, excess, ...} RM
   Short / excess are per SKU within a warehouse (same as the KPI): short = counted below SAP, excess = above. */
import { el, fmt } from "./ui.js";

var CSS = [
  ".mr-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px 12px;flex-wrap:wrap;margin-bottom:6px}.mr-head h3{margin:0}",
  ".mr-ctl{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.mr-ctl select{font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink);max-width:100%}",
  ".mr-seg{display:inline-flex;background:var(--chip);border-radius:10px;padding:3px;gap:3px}.mr-seg button{font:inherit;font-size:13px;border:0;background:transparent;color:var(--ink);border-radius:8px;padding:5px 12px;cursor:pointer}",
  ".mr-seg button.on{background:var(--card);box-shadow:0 1px 2px rgba(0,0,0,.14);font-weight:600}.mr-seg button:disabled{opacity:.45;cursor:not-allowed}",
  ".mr-list>div{display:grid;grid-template-columns:26px 1fr;gap:2px 10px;padding:9px 0;border-bottom:1px solid var(--line)}.mr-list>div:last-child{border-bottom:0}",
  ".mr-list .rk{font-weight:700;color:var(--mute);font-variant-numeric:tabular-nums;padding-top:1px}.mr-list .g b{display:block}.mr-list .g small{color:var(--mute)}",
  ".mr-list .n{grid-column:2;display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;align-items:center}.mr-list .n span{white-space:nowrap}.mr-list .n em{font-style:normal;color:var(--mute);font-size:11.5px;margin-right:3px}",
  ".mr-list .bar{grid-column:2;height:6px;border-radius:99px;background:var(--chip);overflow:hidden;display:flex}.mr-list .bar i{display:block;height:100%}",
  ".mr-se{display:flex;flex-direction:column;gap:7px}.mr-se>div{display:grid;grid-template-columns:110px 1fr 190px;gap:10px;align-items:center;font-size:13px}",
  ".mr-se .tr{display:grid;grid-template-columns:1fr 1fr;height:12px;position:relative}.mr-se .tr span{display:flex;height:100%;background:var(--chip)}.mr-se .tr span:first-child{justify-content:flex-end;border-radius:99px 0 0 99px}.mr-se .tr span:last-child{border-radius:0 99px 99px 0}",
  ".mr-se .tr i{display:block;height:100%}.mr-se .tr span:first-child i{border-radius:99px 0 0 99px}.mr-se .tr span:last-child i{border-radius:0 99px 99px 0}.mr-se .tr u{position:absolute;left:50%;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--ink);opacity:.5}",
  ".mr-se .v{text-align:right;font-variant-numeric:tabular-nums;line-height:1.25;white-space:nowrap}.mr-se .v small{display:block;color:var(--mute);font-size:11.5px}.mr-se .hd{color:var(--mute);font-size:11.5px}",
  ".mr-key{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--mute);margin:2px 0 10px}.mr-key em{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}",
  ".mr-tot{border-top:1px solid var(--line);margin-top:10px;padding-top:8px;font-size:13px;display:flex;gap:6px 16px;flex-wrap:wrap}",
  ".mr-neg{color:var(--bad)}.mr-pill{font-size:11.5px;padding:2px 8px;border-radius:99px;background:var(--chip);color:var(--mute);font-weight:600}.mr-pill.s{background:color-mix(in srgb,var(--bad) 16%,var(--card));color:var(--bad)}.mr-pill.e{background:color-mix(in srgb,var(--info) 16%,var(--card));color:var(--info)}",
  "@media (max-width:640px){.mr-se>div{grid-template-columns:76px 1fr;gap:4px 8px}.mr-se .v{grid-column:2;text-align:left;display:flex;gap:10px}.mr-se .v small{display:inline}.mr-se .hd{display:none}}"
].join("\n");
export function ensureMrCss() { if (!document.getElementById("mr-css")) document.head.append(el("style", { id: "mr-css", text: CSS })); }

var SHORT = "var(--bad)", EXCESS = "var(--info)";
function rmTxt(v, sign) { if (v == null || isNaN(v)) return "-"; var r = Math.round(v); return (r < 0 ? "-RM " : sign && r > 0 ? "+RM " : "RM ") + fmt(Math.abs(r)); }
function qTxt(v, sign) { if (v == null || isNaN(v)) return "-"; var r = Math.round(v); return (r < 0 ? "-" : sign && r > 0 ? "+" : "") + fmt(Math.abs(r)) + " pcs"; }
function kTxt(v, unit, sign) {   // short form for the bars: RM 146k / 1.2M pcs
  if (v == null) return "-"; var a = Math.abs(v), s = v < -0.5 ? "-" : sign && v > 0.5 ? "+" : "";
  var n = a >= 1e6 ? fmt(a / 1e6, 2) + "M" : a >= 1e4 ? fmt(a / 1e3, 0) + "k" : fmt(Math.round(a));
  return unit === "value" ? s + "RM " + n : s + n + " pcs";
}
export function hasSkus(d) { return !!(d && d.skus); }

function seg(unit, canValue, onUnit) {
  return el("div", { class: "mr-seg", role: "group", "aria-label": "Show by" },
    [["qty", "Qty"], ["value", "Value"]].map(function (x) {
      return el("button", { class: unit === x[0] ? "on" : "", "aria-pressed": unit === x[0] ? "true" : "false", disabled: x[0] === "value" && !canValue, title: x[0] === "value" && !canValue ? "RM is not published on this dashboard" : "", text: x[1],
        onclick: function () { if (unit !== x[0]) onUnit(x[0]); } });
    }));
}

/* Top N SKUs by difference: all warehouses added up (or one warehouse), ranked by the absolute difference */
export function topSkusCard(d, st, onChange, N) {
  ensureMrCss(); N = N || 10;
  var canValue = !!(d.rm && d.rm.skuV), unit = st.unit === "value" && canValue ? "value" : "qty", wh = st.wh || "";
  var whs = (d.wh || []).map(function (w) { return w.b; }).sort();
  var head = el("div", { class: "mr-head" }, el("h3", { text: "Top " + N + " SKUs by difference" }),
    el("div", { class: "mr-ctl" },
      el("select", { "aria-label": "Warehouse", onchange: function (e) { onChange({ unit: unit, wh: e.target.value }); } },
        el("option", { value: "", text: "All warehouses" }), whs.map(function (b) { return el("option", { value: b, selected: b === wh, text: b }); })),
      seg(unit, canValue, function (u) { onChange({ unit: u, wh: wh }); })));
  var card = el("div", { class: "card" }, head);
  if (!hasSkus(d)) { card.append(el("p", { class: "small muted", text: "These results were saved before this list existed. Open them once in the app (Dashboard → Monthly) to update." })); return card; }
  var V = (d.rm && d.rm.skuV) || [], g = {};
  d.skus.forEach(function (r, i) {
    if (wh && r.b !== wh) return;
    var dq = (r.cnt ? r.pq : 0) - r.sq, v = V[i] || [0, 0], dv = (r.cnt ? v[1] : 0) - v[0];
    var x = g[r.c] || (g[r.c] = { c: r.c, d: r.d, sq: 0, pq: 0, sv: 0, pv: 0, sh: 0, ex: 0, wh: [], nc: 0 });
    var dd = unit === "value" ? dv : dq;
    x.sq += r.sq; x.pq += r.cnt ? r.pq : 0; x.sv += v[0]; x.pv += r.cnt ? v[1] : 0;
    if (dd < 0) x.sh += dd; else x.ex += dd;
    if (Math.abs(dd) >= 0.5) x.wh.push([r.b, dd]); if (!r.cnt) x.nc++;
  });
  var L = Object.keys(g).map(function (k) { var x = g[k]; x.abs = x.ex - x.sh; return x; }).filter(function (x) { return x.abs >= 0.5; })
    .sort(function (a, b) { return b.abs - a.abs; }).slice(0, N);
  var tot = 0; Object.keys(g).forEach(function (k) { tot += g[k].ex - g[k].sh; });
  var top = L.reduce(function (a, x) { return a + x.abs; }, 0), mx = L.length ? L[0].abs : 1, T = unit === "value" ? rmTxt : qTxt;
  card.append(el("p", { class: "small muted", style: "margin:0 0 4px", text: (wh || "All warehouses") + " · ranked by " + (unit === "value" ? "RM" : "pieces") + ", plus and minus per warehouse added up" +
    (tot ? " · these " + L.length + " are " + Math.round(top / tot * 100) + "% of all the difference" : "") }),
    el("div", { class: "mr-key" }, el("span", {}, el("em", { style: "background:" + SHORT }), "Short (less than SAP)"), el("span", {}, el("em", { style: "background:" + EXCESS }), "Excess (more than SAP)")));
  var box = el("div", { class: "mr-list" });
  L.forEach(function (x, i) {
    var both = x.sh < -0.5 && x.ex > 0.5, net = x.ex + x.sh, mixed = both && Math.min(-x.sh, x.ex) >= 0.2 * Math.max(-x.sh, x.ex);
    var where = wh ? "" : x.wh.sort(function (a, b) { return Math.abs(b[1]) - Math.abs(a[1]); }).map(function (w) { return w[0].replace(/^NDD /, ""); });
    box.append(el("div", {},
      el("span", { class: "rk", text: String(i + 1) }),
      el("div", { class: "g" }, el("b", { text: x.c + " · " + x.d }), where ? el("small", { text: where.slice(0, 3).join(", ") + (where.length > 3 ? " +" + (where.length - 3) + " more" : "") }) : null),
      el("div", { class: "bar", "aria-hidden": "true" }, el("i", { style: "width:" + (-x.sh / mx * 100) + "%;background:" + SHORT }), el("i", { style: "width:" + (x.ex / mx * 100) + "%;background:" + EXCESS })),
      el("div", { class: "n" },
        el("span", {}, el("em", { text: "System" }), unit === "value" ? rmTxt(x.sv) : qTxt(x.sq)),
        el("span", {}, el("em", { text: "Counted" }), x.nc && !x.pq ? "-" : unit === "value" ? rmTxt(x.pv) : qTxt(x.pq)),
        both ? el("span", {}, el("em", { text: "Short" }), el("b", { class: "mr-neg", text: T(x.sh, true) })) : null,
        both ? el("span", {}, el("em", { text: "Excess" }), el("b", { text: T(x.ex, true) })) : null,
        el("span", {}, el("em", { text: both ? "Net" : "Diff" }), el("b", { class: net < -0.5 ? "mr-neg" : "", text: T(net, true) })),
        el("span", { class: "mr-pill " + (mixed ? "" : net < 0 ? "s" : "e"), text: x.nc && !x.pq ? "Not counted" : mixed ? "Short + excess" : net < 0 ? "Short" : "Excess" }))));
  });
  if (!L.length) box.append(el("p", { class: "muted", text: "No differences." }));
  card.append(box);
  return card;
}

/* Short vs excess per warehouse: a bar to the left for what is missing, to the right for what is extra */
export function shortExcessCard(d, st, onChange) {
  ensureMrCss();
  var canValue = !!(d.wh || []).some(function (w) { return w.rm && w.rm.short != null; }), unit = st.unit === "value" && canValue ? "value" : "qty";
  var get = function (w) { var o = unit === "value" ? (w.rm || {}) : (w.q || {}); return { s: o.short, e: o.excess }; };
  var card = el("div", { class: "card" }, el("div", { class: "mr-head" }, el("h3", { text: "Short vs excess per warehouse" }), el("div", { class: "mr-ctl" }, seg(unit, canValue, function (u) { onChange({ unit: u, wh: st.wh }); }))));
  if (!(d.wh || []).some(function (w) { return w.q; })) { card.append(el("p", { class: "small muted", text: "These results were saved before this view existed. Open them once in the app (Dashboard → Monthly) to update." })); return card; }
  var W = (d.wh || []).map(function (w) { var x = get(w); return { b: w.b, s: x.s || 0, e: x.e || 0 }; }).sort(function (a, b) { return (b.e - b.s) - (a.e - a.s); });
  var mx = W.reduce(function (a, w) { return Math.max(a, -w.s, w.e); }, 1), S0 = 0, E0 = 0;
  card.append(el("p", { class: "small muted", style: "margin:0 0 4px", text: "Net hides problems: a warehouse can be close to zero net and still have big gaps both ways. Per SKU, " + (unit === "value" ? "in RM" : "in pieces") + "." }),
    el("div", { class: "mr-key" }, el("span", {}, el("em", { style: "background:" + SHORT }), "Short (less than SAP)"), el("span", {}, el("em", { style: "background:" + EXCESS }), "Excess (more than SAP)")));
  var box = el("div", { class: "mr-se" });
  box.append(el("div", { class: "hd", "aria-hidden": "true" }, el("span"), el("span", { style: "display:flex;justify-content:space-between" }, el("span", { text: "← short" }), el("span", { text: "excess →" })), el("span", { style: "text-align:right", text: "short · excess · net" })));
  W.forEach(function (w) {
    S0 += w.s; E0 += w.e;
    box.append(el("div", { role: "img", "aria-label": w.b + ": short " + kTxt(w.s, unit) + ", excess " + kTxt(w.e, unit) },
      el("span", { text: w.b.replace(/^NDD /, "") }),
      el("span", { class: "tr" }, el("span", {}, el("i", { style: "width:" + (-w.s / mx * 100) + "%;background:" + SHORT })), el("span", {}, el("i", { style: "width:" + (w.e / mx * 100) + "%;background:" + EXCESS })), el("u")),
      el("span", { class: "v" }, el("span", {}, el("b", { class: w.s < -0.5 ? "mr-neg" : "", text: kTxt(w.s, unit) }), " · ", el("b", { text: kTxt(w.e, unit, true) })), el("small", { text: "net " + kTxt(w.s + w.e, unit, true) }))));
  });
  var T = unit === "value" ? rmTxt : qTxt;
  card.append(box, el("div", { class: "mr-tot" }, el("b", { text: "All warehouses" }), el("span", {}, "Short ", el("b", { class: "mr-neg", text: T(S0, true) })), el("span", {}, "Excess ", el("b", { text: T(E0, true) })), el("span", {}, "Net ", el("b", { class: S0 + E0 < -0.5 ? "mr-neg" : "", text: T(S0 + E0, true) }))));
  return card;
}
