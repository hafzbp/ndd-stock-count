/* HQ Dashboard tab: what needs attention, today per warehouse, accuracy, results, counters, ABC coverage,
   repeat-variance SKUs, plus the shared trend/compliance views (dcc.js). Filters: period, region, NOM, warehouse. */
import { S, hooks } from "./state.js";
import { rpc } from "./api.js";
import { el, fmt, msg, errText } from "./ui.js";
import { renderDccStats, ensureDccCss, ST } from "./dcc.js";

var TARGET = 98;
function tok() { return S.admin.token; }
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function addDays(s, n) { var d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return iso(d); }
function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : null; }
function pctTxt(v) { return v == null ? "-" : v.toFixed(1) + "%"; }
function rm(v) { return v == null ? "-" : (v < 0 ? "-RM " : "RM ") + fmt(Math.abs(v), 0); }
function hm(ts) { return ts ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts)) : "-"; }
function nowMin(ts) { var p = hm(ts).split(":"); return Number(p[0]) * 60 + Number(p[1]); }
function toMin(t) { var p = String(t || "00:00").split(":"); return Number(p[0]) * 60 + Number(p[1]); }
function shortDate(s) { if (!s) return "-"; var d = new Date(s + "T00:00:00"); return d.getDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]; }
function kpi(v, l, s, cls) { return el("div", { class: "stat" }, el("b", { class: cls || "", text: v }), el("span", { text: l }), s ? el("div", { class: "small muted", text: s }) : null); }
function card(title, sub) { var c = el("div", { class: "card" }, el("h3", { text: title })); if (sub) c.append(el("p", { class: "small muted", style: "margin:0 0 8px", text: sub })); return c; }
function table(head, numFrom) { return el("table", {}, el("tr", {}, head.map(function (h, i) { return el("th", { class: i >= numFrom ? "n" : "", text: h }); }))); }

var CSS = ".hq-att li{margin:4px 0;list-style:none}.hq-att{padding:0;margin:0}.hq-att .pill{margin-right:8px}" +
  ".hq-bars{display:grid;grid-template-columns:minmax(90px,max-content) 1fr 54px;gap:6px 10px;align-items:center;font-size:13px}" +
  ".hq-bars .tr{position:relative;height:12px;background:var(--chip);border-radius:0 4px 4px 0}.hq-bars .tr i{position:absolute;left:0;top:0;bottom:0;border-radius:0 4px 4px 0;background:var(--info)}" +
  ".hq-bars .tr i.low{background:var(--bad)}.hq-bars .tr b{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);opacity:.55}" +
  ".hq-mix{display:flex;height:18px;border-radius:4px;overflow:hidden;gap:2px;margin:6px 0 8px}.hq-mix i{display:block}" +
  ".hq-key{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:var(--mute)}.hq-key span{display:inline-flex;align-items:center;gap:5px}.hq-key i{width:10px;height:10px;border-radius:2px;display:inline-block}" +
  ".hq-later{border-style:dashed}";
function ensureCss() { ensureDccCss(); if (!document.getElementById("hq-css")) document.head.append(el("style", { id: "hq-css", text: CSS })); }

export function renderDash(app) {
  ensureCss();
  var today = (S.dashToday && S.dashToday.today) || (S.dcc && S.dcc.today) || iso(new Date());
  if (!S.dashP) S.dashP = { per: "mtd", br: "", region: "", nom: "" };
  var P = S.dashP, first = today.slice(0, 8) + "01";
  var from = P.per === "7d" ? addDays(today, -6) : P.per === "lm" ? addDays(first, -1).slice(0, 8) + "01" : first;
  var to = P.per === "lm" ? addDays(first, -1) : today, key = from + to;

  var rows = (S.dashToday && S.dashToday.rows) || [];
  var meta = {}; rows.forEach(function (r) { meta[r.branch] = r; });
  var vals = function (k) { var o = {}; rows.forEach(function (r) { if (r[k]) o[r[k]] = 1; }); return Object.keys(o).sort(); };
  var pick = function (val, label, opts, onc) {
    return el("select", { style: "max-width:200px", onchange: function (e) { onc(e.target.value); hooks.render(); } },
      [el("option", { value: "", text: label })].concat(opts.map(function (o) { return el("option", { value: o, text: o, selected: val === o }); })));
  };
  var inScope = function (n) { var m = meta[n] || {}; return (!P.region || m.region === P.region) && (!P.nom || m.nom === P.nom) && (!P.br || n === P.br); };
  var names = rows.map(function (r) { return r.branch; }).filter(function (n) { var m = meta[n]; return (!P.region || m.region === P.region) && (!P.nom || m.nom === P.nom); });
  if (P.br && names.indexOf(P.br) < 0) P.br = "";
  app.append(el("div", { class: "row", style: "margin-bottom:10px" },
    el("select", { style: "max-width:170px", onchange: function (e) { P.per = e.target.value; S.dashData = null; S.dashIns = null; hooks.render(); } },
      [["mtd", "This month"], ["7d", "Last 7 days"], ["lm", "Last month"]].map(function (o) { return el("option", { value: o[0], text: o[1], selected: P.per === o[0] }); })),
    vals("region").length ? pick(P.region, "All regions", vals("region"), function (v) { P.region = v; }) : null,
    vals("nom").length ? pick(P.nom, "All NOMs", vals("nom"), function (v) { P.nom = v; }) : null,
    pick(P.br, "All warehouses", names, function (v) { P.br = v; }),
    el("button", { class: "btn", text: "↻", title: "Refresh", onclick: function () { S.dashData = null; S.dashIns = null; S.dashToday = null; hooks.render(); } }),
    el("a", { class: "link small", href: "dashboard/", target: "_blank", rel: "noopener", text: "Public view (no RM) ↗" })));

  if (!S.dashData || S.dashKey !== key || !S.dashIns || !S.dashToday) {
    app.append(el("p", { class: "center muted", text: "Loading…" }));
    if (S.dashLoading) return;
    S.dashLoading = true;
    Promise.all([
      S.dashData && S.dashKey === key ? S.dashData : rpc("admin_dcc_stats", { p_token: tok(), p_from: from, p_to: to }),
      S.dashIns && S.dashKey === key ? S.dashIns : rpc("admin_dcc_insights", { p_token: tok(), p_from: from, p_to: to }),
      S.dashToday || rpc("admin_dcc_today", { p_token: tok() })
    ]).then(function (r) { S.dashData = r[0]; S.dashIns = r[1]; S.dashToday = r[2]; S.dashKey = key; S.dashLoading = false; hooks.render(); },
      function (e) { S.dashLoading = false; msg("Can't load", errText(e)); });
    return;
  }

  var st = S.dashData, ins = S.dashIns, T = S.dashToday, only = rows.map(function (r) { return r.branch; }).filter(inScope);
  var R = rows.filter(function (r) { return inScope(r.branch); }), B = (st.branches || []).filter(function (b) { return inScope(b.branch); });
  var now = nowMin(T.now), isToday = T.date === T.today;

  /* ---- KPIs ---- */
  var due = R.filter(function (r) { return /ontime|late|progress|todo|missed/.test(r.status); });
  var cnt = function (s) { return R.filter(function (r) { return r.status === s; }).length; };
  var ok = 0, n = 0, net = 0, abs = 0, uni = 0, cov = 0, paces = [];
  B.forEach(function (b) { ok += b.ok; n += b.counted; net += b.net || 0; abs += b.abs || 0; uni += b.universe; cov += Math.min(b.covered, b.universe); if (b.pace != null) paces.push(b.pace); });
  var accP = pct(ok, n), covP = pct(cov, uni), pace = paces.length ? paces.reduce(function (a, x) { return a + x; }, 0) / paces.length : null;
  var ends = due.filter(function (r) { return r.status === "todo"; }).map(function (r) { return r.to; }).sort();
  app.append(el("div", { class: "stats dccst", style: "grid-template-columns:repeat(auto-fit,minmax(140px,1fr))" },
    kpi(String(due.length), "Due today", R.length + " warehouses in view"),
    kpi(String(cnt("ontime") + cnt("late")), "Submitted", cnt("ontime") + " on time · " + cnt("late") + " late"),
    kpi(String(cnt("progress")), "Counting", "started, not submitted"),
    kpi(String(cnt("todo")), "Not started", ends.length ? "first window ends " + ends[0] : "", cnt("todo") ? "neg" : ""),
    kpi(pctTxt(accP), "Accuracy (IRA)", "target " + TARGET + "% · " + n + " SKU counts", accP != null && accP < TARGET ? "neg" : ""),
    kpi(pctTxt(covP), "SKU coverage", pace == null ? "" : "pace " + pace.toFixed(0) + "% · " + (covP != null && covP >= pace ? "on track" : "behind")),
    kpi(rm(net), "Net variance", "absolute " + rm(abs))));

  /* ---- needs attention ---- */
  var att = [];
  if (isToday && T.snapshot && T.snapshot.date < T.today) att.push(["bad", "MB52", "Today's stock isn't uploaded yet. Counts compare to the stock of " + shortDate(T.snapshot.date) + "."]);
  R.forEach(function (r) {
    var left = toMin(r.to) - now;
    if (isToday && r.status === "todo") att.push([left <= 60 ? "bad" : "warn", "Not started", r.branch + " · window ends " + r.to + (left > 0 ? " (" + left + " min left)" : " (ended)")]);
    if (isToday && r.status === "progress" && left < 0) att.push(["warn", "Still counting", r.branch + " · window ended " + r.to + ", " + r.counted + " of " + r.listed + " SKUs counted"]);
    if (r.status === "skip") att.push(["", "Skipped", r.branch + " · " + (r.skipReason || "")]);
  });
  var nost = R.filter(function (r) { return r.status === "nostock"; }).map(function (r) { return r.branch.replace(/^NDD\s+/, ""); });
  if (nost.length) att.push(["warn", "No stock data", nost.length + " warehouse" + (nost.length > 1 ? "s aren't" : " isn't") + " in any uploaded MB52: " + nost.join(", ")]);
  B.forEach(function (b) {
    var mi = (b.cells || []).filter(function (c) { return c.st === "missed"; }).length, ap = pct(b.ok, b.counted);
    if (mi) att.push(["bad", "Missed", b.branch + " · " + mi + " day" + (mi > 1 ? "s" : "") + " in this period"]);
    if (ap != null && ap < TARGET) att.push(["warn", "Below target", b.branch + " · accuracy " + pctTxt(ap) + " (" + b.counted + " SKU counts)"]);
    if (b.pace != null && b.universe && pct(Math.min(b.covered, b.universe), b.universe) < b.pace - 10) att.push(["warn", "Coverage behind", b.branch + " · " + pctTxt(pct(Math.min(b.covered, b.universe), b.universe)) + " counted, pace " + b.pace.toFixed(0) + "%"]);
  });
  var rep = (ins.repeat || []).filter(function (x) { return inScope(x.branch); });
  if (rep.length) att.push(["warn", "Repeat variance", rep.length + " SKU" + (rep.length > 1 ? "s" : "") + " out of tolerance 2+ times - see the list below"]);
  var ac = card("Needs attention");
  ac.append(att.length ? el("ul", { class: "hq-att" }, att.map(function (a) { return el("li", {}, el("span", { class: "pill " + a[0], text: a[1] }), a[2]); }))
    : el("p", { class: "small", style: "color:var(--ok);margin:0", text: "Nothing needs attention ✓" }));
  if (att.length) ac.style.borderColor = "var(--bad)";
  app.append(ac);

  /* ---- today per warehouse ---- */
  var order = { todo: 0, missed: 0, progress: 1, late: 2, ontime: 3, skip: 4, monthly: 5, nostock: 5, off: 6, nothing: 6 };
  var tt = table(["Warehouse", "Window", "MB52", "Started", "Submitted", "Took", "SKUs", "OK", "Over", "Counted by", "Status"], 5);
  R.slice().sort(function (a, b) { return (order[a.status] - order[b.status]) || a.branch.localeCompare(b.branch); }).forEach(function (r) {
    var s = ST[r.status] || [{ monthly: "Monthly stock take", nostock: "No stock data", nothing: "Nothing due" }[r.status] || r.status, "off"];
    var res = r.result || {}, stale = r.snapDate && r.snapDate < T.date;
    tt.append(el("tr", {}, el("td", { text: r.branch }), el("td", { class: "muted", text: r.from + "-" + r.to }),
      el("td", { class: stale ? "neg" : "muted", text: r.snapDate ? shortDate(r.snapDate) : "-" }),
      el("td", { text: hm(r.startedAt) }), el("td", { text: hm(r.submittedAt) }),
      el("td", { class: "n", text: r.minutes != null ? r.minutes + " min" : "-" }),
      el("td", { class: "n", text: r.listed ? r.counted + " / " + r.listed : "-" }),
      el("td", { class: "n", text: r.result ? String(res.ok + res.within) : "-" }),
      el("td", { class: "n" + (res.over ? " neg" : ""), text: r.result ? String(res.over + res.nis) : "-" }),
      el("td", { class: "small", text: r.who || "" }),
      el("td", {}, el("span", { class: "pill " + (s[1] === "ok" || s[1] === "warn" || s[1] === "bad" ? s[1] : ""), text: s[0] || "-" }))));
  });
  app.append((function () { var c = card(isToday ? "Today per warehouse" : "Per warehouse · " + shortDate(T.date), "OK = exact or within tolerance. Over = outside tolerance or not in system; those SKUs are recounted the next working day."); c.append(el("div", { class: "tw" }, tt)); return c; })());

  /* ---- accuracy by warehouse (worst first) + result mix ---- */
  var accRows = B.filter(function (b) { return b.counted; }).map(function (b) { return { b: b.branch, p: pct(b.ok, b.counted), n: b.counted }; }).sort(function (a, b) { return a.p - b.p; });
  var bars = el("div", { class: "hq-bars" });
  accRows.forEach(function (x) {
    bars.append(el("span", { text: x.b.replace(/^NDD\s+/, "") }), el("div", { class: "tr", title: x.n + " SKU counts" }, el("i", { class: x.p < TARGET ? "low" : "", style: "width:" + x.p + "%" }), el("b", { style: "left:" + TARGET + "%" })),
      el("span", { class: "n", style: "text-align:right", text: pctTxt(x.p) }));
  });
  var mix = { ok: 0, within: 0, over: 0, nis: 0 }; (ins.mix || []).filter(function (x) { return inScope(x.branch); }).forEach(function (x) { mix.ok += x.ok; mix.within += x.within; mix.over += x.over; mix.nis += x.nis; });
  var mt = mix.ok + mix.within + mix.over + mix.nis, segs = [["ok", "Exact match", "var(--ok)"], ["within", "Within tolerance", "var(--info)"], ["over", "Over tolerance", "var(--bad)"], ["nis", "Not in system", "var(--warn)"]];
  var mixC = card("Result by SKU", "All SKU counts in the period, compared with MB52.");
  if (mt) {
    mixC.append(el("div", { class: "hq-mix" }, segs.filter(function (s) { return mix[s[0]]; }).map(function (s) { return el("i", { title: s[1] + ": " + mix[s[0]], style: "width:" + (mix[s[0]] / mt * 100) + "%;background:" + s[2] }); })),
      el("div", { class: "hq-key" }, segs.map(function (s) { return el("span", {}, el("i", { style: "background:" + s[2] }), s[1] + " " + mix[s[0]] + " (" + Math.round(mix[s[0]] / mt * 100) + "%)"); })));
  } else mixC.append(el("p", { class: "muted small", text: "No submitted counts in this period yet." }));
  var accC = card("Accuracy by warehouse", "Worst first. The line marks the " + TARGET + "% target.");
  accC.append(accRows.length ? bars : el("p", { class: "muted small", text: "No submitted counts in this period yet." }));
  app.append(el("div", { class: "grid2" }, accC, mixC));

  /* ---- counters + ABC coverage ---- */
  var cs = (ins.counters || []).filter(function (c) { return c.branches.split(", ").some(inScope); });
  var speeds = cs.filter(function (c) { return c.minutes > 0; }).map(function (c) { return c.skus / c.minutes * 60; }).sort(function (a, b) { return a - b; }), med = speeds.length ? speeds[Math.floor(speeds.length / 2)] : null;
  var ct = table(["Counter", "Warehouse", "Days", "SKUs", "Accuracy", "SKU / hour"], 2);
  cs.forEach(function (c) {
    var ap = pct(c.ok, c.n), sp = c.minutes > 0 ? c.skus / c.minutes * 60 : null, flag = ap != null && ap < TARGET && sp != null && med != null && sp > med;
    ct.append(el("tr", {}, el("td", {}, c.name, flag ? el("span", { class: "pill warn", style: "margin-left:6px", title: "Faster than most but below the accuracy target", text: "check" }) : null),
      el("td", { class: "small", text: c.branches }), el("td", { class: "n", text: String(c.days) }), el("td", { class: "n", text: String(c.skus) }),
      el("td", { class: "n" + (ap != null && ap < TARGET ? " neg" : ""), text: pctTxt(ap) }), el("td", { class: "n", text: sp == null ? "-" : sp.toFixed(1) })));
  });
  if (!cs.length) ct.append(el("tr", {}, el("td", { colspan: 6, class: "muted", text: "No submitted counts in this period yet." })));
  var ccC = card("Counters", "Everyone named on a submitted daily count. \"check\" = faster than most but below the accuracy target.");
  ccC.append(el("div", { class: "tw" }, ct));

  var abc = {}; (ins.abc || []).filter(function (x) { return inScope(x.branch); }).forEach(function (x) {
    var a = abc[x.cls] = abc[x.cls] || { skus: 0, times: 0, once: 0, target: x.target, pw: 0 }; a.skus += x.skus; a.times += x.times; a.once += x.once; a.pw += (x.pace || 0) * x.skus;
  });
  var at = table(["Class", "SKUs", "Target", "Done", "Seen", ""], 1);
  ["A", "B", "C"].forEach(function (k) {
    var a = abc[k]; if (!a) return;
    var avg = a.skus ? a.times / a.skus : 0, exp = a.target * (a.skus ? a.pw / a.skus : 0) / 100, onPace = avg >= exp * 0.9;
    at.append(el("tr", {}, el("td", { title: ({ A: "Top 80% of stock value", B: "Next 15% of value", C: "The rest" })[k], text: k }), el("td", { class: "n", text: String(a.skus) }),
      el("td", { class: "n", text: a.target + "×" }), el("td", { class: "n", text: avg.toFixed(1) + "×" }), el("td", { class: "n", text: pctTxt(pct(a.once, a.skus)) }),
      el("td", {}, el("span", { class: "pill " + (onPace ? "ok" : "warn"), text: onPace ? "On pace" : "Behind", title: "Expected by now: " + exp.toFixed(1) + "×" }))));
  });
  if (!Object.keys(abc).length) at.append(el("tr", {}, el("td", { colspan: 6, class: "muted", text: "No ABC yet for this month - it comes from the first daily stock upload." })));
  var abcC = card("ABC coverage · " + shortDate(ins.month).replace(/^1 /, ""), "Target = counts per SKU per month (A = top 80% of value, B = next 15%, C = the rest). Done = average so far. Seen = SKUs counted at least once. On pace compares Done with the share of working days gone.");
  abcC.append(el("div", { class: "tw" }, at));
  app.append(el("div", { class: "grid2" }, ccC, abcC));

  /* ---- repeat variance ---- */
  var rt = table(["Warehouse", "SKU", "Times out", "Net var PCS", "Abs var RM", "Last"], 2);
  rep.forEach(function (x) {
    rt.append(el("tr", {}, el("td", { text: x.branch }), el("td", { text: x.code + " " + (x.desc || "") }), el("td", { class: "n neg", text: x.times + "×" }),
      el("td", { class: "n" + (x.netQ < 0 ? " neg" : ""), text: fmt(x.netQ) }), el("td", { class: "n", text: rm(x.absRm) }), el("td", { class: "n", text: shortDate(x.last) })));
  });
  if (!rep.length) rt.append(el("tr", {}, el("td", { colspan: 6, class: "muted", text: "No SKU was out of tolerance twice in this period." })));
  var rc = card("Repeat variance SKUs", "Out of tolerance two or more times in the period: look for the root cause (picking, location, unit, master data).");
  rc.append(el("div", { class: "tw" }, rt)); app.append(rc);

  /* ---- shared views: compliance grid, trends, by warehouse, top variance ---- */
  var root = el("div"); app.append(root);
  renderDccStats(root, st, { only: only, noKpi: true, target: TARGET });

  app.append(el("div", { class: "card hq-later" }, el("h3", { class: "muted", text: "Bad stock (later phase)" }),
    el("p", { class: "small muted", style: "margin:0", text: "The same views for bad stock once it is counted: progress, accuracy and value per warehouse." })));
}
