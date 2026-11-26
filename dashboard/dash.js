/* Public live dashboard: no login. What it shows is set by Finance in Setup → Public dashboard. */
import { rpc } from "../js/api.js";
import { el, fmt, tsTxt } from "../js/ui.js";
import { renderDccStats, ensureDccCss } from "../js/dcc.js";
import { renderKpi, kpiMonths, demoKpi, demoOps, KPI_CSS } from "../js/kpi.js";

var $ = function (s) { return document.querySelector(s); };
var ST = { not_started: ["Not started", ""], counting: ["Counting", "warn"], submitted: ["Submitted ✓", "ok"] };

function bar(label, done, total, color) {
  var p = total ? Math.min(100, Math.round(done / total * 100)) : 0;
  return el("div", { class: "bar" }, el("div", { class: "l" }, el("span", { text: label }), el("span", { text: done + " / " + total + " SKU (" + p + "%)" })),
    el("div", { class: "t" }, el("i", { style: "width:" + p + "%;background:" + color })));
}
function kpi(v, l, cls) { return el("div", { class: "kpi" }, el("b", { class: cls || "", text: v }), el("span", { text: l })); }

/* tabs: Daily & KPI | Monthly stock take. #monthly / #daily in the link, else the last one picked, else Monthly while counting is open */
var PICKED = /^#(daily|monthly)$/.test(location.hash) ? location.hash.slice(1) : (function () { try { return localStorage.getItem("ndd2-dtab"); } catch (e) { return null; } })();
function setTab(t, keep) {
  if (keep) PICKED = t; document.body.setAttribute("data-tab", t);
  document.querySelectorAll("#dtabs button").forEach(function (b) { var on = b.getAttribute("data-t") === t; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
  if (keep) { try { localStorage.setItem("ndd2-dtab", t); } catch (e) { } history.replaceState(null, "", "#" + t); window.scrollTo(0, 0); }
}
document.querySelectorAll("#dtabs button").forEach(function (b) { b.addEventListener("click", function () { setTab(b.getAttribute("data-t"), true); }); });
setTab(PICKED || "daily");
function liveDot(on) { var b = document.querySelector("#dtabs button[data-t=monthly]"); if (!b) return; var i = b.querySelector("i"); if (on && !i) b.append(el("i", { title: "Counting now" })); if (!on && i) i.remove(); }

function draw(d) {
  if (!PICKED && !draw.once) setTab(d.status === "open" ? "monthly" : "daily"); draw.once = 1;
  liveDot(d.status === "open");
  document.title = (d.title || "Stock Count") + " · Dashboard";
  $("#title").textContent = (d.title || "Stock Count") + " · Live dashboard";
  $("#sub").textContent = "Daily cycle count and monthly stock take · updated " + tsTxt(d.generatedAt);
  var mt = (d.take || "") + (d.scope === "partial" ? " · partial, " + d.skuCount + " SKUs" : "") + (d.mode === "single" ? " · single count" : "") + " · " + (d.status === "draft" ? "not started yet" : d.status === "closed" ? "counting closed" : "counting open") + " · updated " + tsTxt(d.generatedAt);
  pr.live = d.take || "";
  if (pr.sel) return;   // a closed stock take's results are on show
  var B = d.branches || [], app = $("#monthly"); app.innerHTML = "";
  if (pr.list && pr.list.length) app.append(prPicker());
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

/* ?demo=1 shows made-up data (client only) to present the dashboard; nothing is fetched or saved for it */
var DEMO = /[?&]demo=1\b/.test(location.search);
function todayKL() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date()); }
var kpiMonth = null, kpiData = null, kpiToday = null;
function drawKpi() {
  var root = $("#kpi"); root.innerHTML = "";
  if (DEMO) root.append(el("div", { class: "banner warn" }, el("b", { text: "Demo data. " }), "Made-up numbers to show how the dashboard works. Nothing here is real."));
  renderKpi(root, { pub: true, demo: DEMO, today: kpiToday, month: kpiMonth, data: kpiData,
    setMonth: function (m) { kpiMonth = m; kpiData = null; drawKpi(); loadKpi(); } });
}
async function loadKpi() {
  kpiToday = kpiToday || todayKL(); if (!kpiMonth) kpiMonth = kpiMonths(kpiToday)[0];
  var m = kpiMonth, d = DEMO ? demoKpi(kpiToday, m) : await rpc("public_kpi", { p_month: m });
  if (m !== kpiMonth) return;   // the month changed while loading
  kpiData = d; kpiToday = d.today || kpiToday; drawKpi();
}

var lastDcc = 0;
async function loadDcc() {
  if (Date.now() - lastDcc > 120000 || !kpiData) { try { await loadKpi(); } catch (e) { $("#kpi").innerHTML = ""; $("#kpi").append(el("div", { class: "note", text: "KPI can't load right now." })); } }
  var t = todayKL(), d = DEMO ? Object.assign(demoOps(t, t.slice(0, 8) + "01", t).stats, { withRm: false, top: null }) : await rpc("public_dcc", {}), root = $("#dcc"); root.innerHTML = "";
  root.append(el("h2", { class: "sec", text: "Daily cycle count · this month" }));
  if (!(d.branches || []).some(function (b) { return b.universe; })) root.append(el("div", { class: "note", text: "Daily counts start after HQ uploads the first daily stock file." }));
  renderDccStats(root, d, {}); lastDcc = Date.now();
}
if (!document.getElementById("kpi-css")) { ensureDccCss(); document.head.append(el("style", { id: "kpi-css", text: KPI_CSS })); }
async function load() {
  try { if (Date.now() - lastDcc > 120000) await loadDcc(); await prLoadList(); var d = await rpc("public_dashboard", {}); draw(d); $("#live").textContent = "● Live"; $("#live").className = "pill ok"; }
  catch (e) { $("#live").textContent = "Offline - retrying"; $("#live").className = "pill warn"; if (!$("#app").children.length || /Loading/.test($("#app").textContent)) $("#app").innerHTML = '<div class="center muted">Can\'t reach the server. Retrying…</div>'; }
}

/* ---------- monthly results: pick a closed stock take; RM only after the owner/Finance password ---------- */
var PR_CSS = [
  ":root{--info:#2563eb}@media (prefers-color-scheme:dark){:root{--info:#8ab4f8}}",
  ".pr-wn{color:var(--warn)!important}.pr-pick{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:18px 0 4px}.pr-pick select{flex:1 1 260px;max-width:680px;min-width:0}.pr-pick label{font-size:13px;color:var(--mute)}",
  ".pr-hero{display:flex;gap:18px;flex-wrap:wrap;align-items:stretch}.pr-hero>div:first-child{min-width:220px;display:flex;flex-direction:column;gap:2px}",
  ".pr-hero .big{font-size:46px;line-height:1.05;font-weight:800;font-variant-numeric:tabular-nums}",
  ".pr-tiles{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.pr-tile{border:1px solid var(--line);border-radius:10px;padding:10px 12px}.pr-tile span{font-size:12px;color:var(--mute);display:block}.pr-tile b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.pr-tile small{font-size:11.5px;color:var(--mute)}",
  ".pr-stack{display:flex;gap:2px;border-radius:99px;overflow:hidden;background:var(--chip)}.pr-stack i{display:block;height:100%}",
  ".pr-key{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--mute);margin-top:6px}.pr-key em{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}.pr-key b{color:var(--ink);margin-right:3px}",
  ".pr-ira{display:flex;flex-direction:column;gap:6px}.pr-row{display:grid;grid-template-columns:110px 1fr 68px;gap:10px;align-items:center;font-size:13px}.pr-row .tr{position:relative;height:10px;background:var(--chip);border-radius:99px}.pr-row .tr i{position:absolute;left:0;top:0;bottom:0;border-radius:99px}",
  ".pr-row .tr u{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--ink);opacity:.55}.pr-row .tr small{position:absolute;left:18px;top:-2px;font-size:11px;color:var(--mute);line-height:14px}.pr-row b{text-align:right;font-variant-numeric:tabular-nums}",
  ".pr-axis .tr{background:none;height:14px}.pr-axis .tr small{left:auto;transform:translateX(-50%);top:0}",
  ".pr-wh{border-left:4px solid var(--line)}.pr-wh .top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.pr-wh .ira{font-size:28px;font-weight:800;font-variant-numeric:tabular-nums;margin:6px 0}",
  ".pr-money{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;border-top:1px solid var(--line);margin-top:10px;padding-top:8px;font-size:13px}",
  ".pr-rows>div{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line)}.pr-rows>div:last-child{border-bottom:0}.pr-rows .g{flex:1 1 220px;min-width:0}.pr-rows .g b{display:block}.pr-rows .g small{color:var(--mute)}.pr-rows .n{display:flex;gap:12px;flex-wrap:wrap;font-size:13px}.pr-rows .n em{font-style:normal;color:var(--mute);font-size:11.5px;margin-right:3px}",
  ".pr-lock{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.pr-lock input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);min-width:0;flex:1 1 200px;max-width:280px}",
  ".pr-btn{font:inherit;font-weight:600;padding:8px 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}.pr-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}",
  ".pr-c-OK{background:var(--ok)}.pr-c-WITHIN{background:color-mix(in srgb,var(--ok) 45%,var(--card))}.pr-c-OVER{background:var(--bad)}.pr-c-NIS{background:var(--info)}.pr-c-NC{background:color-mix(in srgb,var(--mute) 45%,var(--card))}.pr-c-PEND{background:var(--warn)}",
  "@media (max-width:560px){.pr-row{grid-template-columns:84px 1fr 58px;gap:8px}.pr-hero .big{font-size:38px}}"
].join("\n");
var PR_RES = [["OK", "Exact", "OK"], ["WITHIN", "Within tolerance", "WITHIN"], ["OVER", "Over tolerance", "OVER"], ["NOT IN SYSTEM", "Not in SAP", "NIS"], ["NOT COUNTED", "Not counted", "NC"], ["PENDING", "Pending", "PEND"]];
var pr = { list: null, listAt: 0, sel: "", data: {}, pw: null, rm: false, ask: false, err: "", busy: false, live: "" };
function prIra(v) { return v == null ? "-" : (Math.floor(v * 100) / 100).toFixed(2) + "%"; }
function prOn(v, T) { return v != null && Math.floor(v * 100) / 100 >= T; }
function prCls(v, T) { return v == null ? "" : prOn(v, T) ? "pos" : v >= 99 ? "pr-wn" : "neg"; }
function prCol(v, T) { return prOn(v, T) ? "var(--ok)" : (v || 0) >= 99 ? "var(--warn)" : "var(--bad)"; }
function prRm(v, sign) { if (v == null) return "-"; var r = Math.round(v); return (r < 0 ? "-RM " : sign && r > 0 ? "+RM " : "RM ") + fmt(Math.abs(r)); }
function prDhm(t) { return t ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t)) : "-"; }
function prM(v) { return "RM " + fmt(v / 1e6, 2) + " M"; }
function prDate(t) { return t ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kuala_Lumpur" }) : ""; }
function prBar(c, h) {
  var b = el("div", { class: "pr-stack", style: "height:" + (h || 10) + "px", role: "img", "aria-label": PR_RES.filter(function (r) { return c[r[0]]; }).map(function (r) { return c[r[0]] + " " + r[1]; }).join(", ") });
  PR_RES.forEach(function (r) { if (c[r[0]]) b.append(el("i", { class: "pr-c-" + r[2], style: "flex:" + c[r[0]], title: c[r[0]] + " " + r[1] })); });
  return b;
}
function prKey(c) { return el("div", { class: "pr-key" }, PR_RES.filter(function (r) { return c[r[0]]; }).map(function (r) { return el("span", {}, el("em", { class: "pr-c-" + r[2] }), el("b", { text: String(c[r[0]]) }), r[1]); })); }
function adminTok() { try { var a = JSON.parse(localStorage.getItem("ndd2-admin") || "null"); return a && a.token && (a.kind === "owner" || a.kind === "finance") ? a.token : null; } catch (e) { return null; } }

async function prLoadList(force) {
  if (DEMO) { pr.list = []; return; }
  if (!force && pr.list && Date.now() - pr.listAt < 120000) return;
  try { pr.list = await rpc("public_results_list", {}); pr.listAt = Date.now(); } catch (e) { pr.list = pr.list || []; }
}
function prPicker() {
  if (!pr.list || !pr.list.length) return null;
  var sel = el("select", { id: "pr-take", "aria-label": "Monthly results to show", onchange: function (e) { pr.sel = e.target.value; pr.ask = false; pr.err = ""; showMonthly(); } },
    el("option", { value: "", text: "Live · " + (pr.live || "current stock take") }),
    pr.list.map(function (x) { return el("option", { value: x.id, selected: pr.sel === x.id, text: "Results · " + x.name + " · closed " + prDate(x.closedAt) + (x.imported && !/previous app/i.test(x.name) ? " (previous app)" : "") }); }));
  return el("div", { class: "pr-pick" }, el("label", { for: "pr-take", text: "Showing" }), sel);
}
async function prFetch(id) {
  var args = { p_take: id };
  if (pr.rm) { var at = adminTok(); if (pr.pw) args.p_password = pr.pw; else if (at) args.p_token = at; }
  var d = await rpc("public_results", args);
  if (d.wrongPassword) throw new Error("wrong password");
  if (pr.rm && !d.withRM) { pr.rm = false; pr.ask = true; }   // the saved login has expired: ask for the password
  pr.data[id + (d.withRM ? "|rm" : "")] = d; return d;
}
async function showMonthly() {
  var app = $("#monthly");
  if (!pr.sel) { app.innerHTML = ""; app.append(el("div", { class: "center muted", text: "Loading…" })); return load(); }
  var key = pr.sel + (pr.rm ? "|rm" : ""), d = pr.data[key];
  if (!d) {
    app.innerHTML = ""; var pk = prPicker(); if (pk) app.append(pk); app.append(el("div", { class: "center muted", text: "Loading results…" }));
    try { d = await prFetch(pr.sel); } catch (e) { app.lastChild.textContent = "Can't load these results: " + ((e && e.message) || e); return; }
  }
  drawResults(d);
}
function lockBox(d) {
  if (d.withRM) return el("button", { class: "pr-btn", text: "Hide RM", onclick: function () { pr.rm = false; pr.pw = null; pr.ask = false; showMonthly(); } });
  if (!pr.ask) return el("button", { class: "pr-btn", text: "Show RM…", onclick: async function () {
    if (adminTok()) { pr.rm = true; try { var x = await prFetch(pr.sel); if (x.withRM) return drawResults(x); } catch (e) { pr.rm = false; } }
    pr.ask = true; pr.err = ""; drawResults(d); setTimeout(function () { var i = $("#pr-pw"); if (i) i.focus(); }, 30);
  } });
  var inp = el("input", { id: "pr-pw", type: "password", autocomplete: "current-password", placeholder: "Owner or Finance password", "aria-label": "Owner or Finance password" });
  var go = async function () {
    if (!inp.value || pr.busy) return; pr.busy = true; pr.err = "";
    try { pr.pw = inp.value; pr.rm = true; var x = await prFetch(pr.sel); pr.ask = false; drawResults(x); }
    catch (e) { pr.pw = null; pr.rm = false; pr.err = /LOCKED/.test(e.message) ? "Too many wrong passwords. Wait 15 minutes." : /wrong password/i.test(e.message) ? "Wrong password." : (e.message || String(e)); drawResults(d); setTimeout(function () { var i = $("#pr-pw"); if (i) i.focus(); }, 30); }
    finally { pr.busy = false; }
  };
  inp.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  return el("div", {}, el("form", { class: "pr-lock", onsubmit: function (e) { e.preventDefault(); go(); } }, inp, el("button", { class: "pr-btn primary", type: "submit", text: "Show RM" }),
      el("button", { class: "pr-btn", type: "button", text: "Cancel", onclick: function () { pr.ask = false; pr.err = ""; drawResults(d); } })),
    el("div", { class: "small " + (pr.err ? "neg" : "muted"), style: "margin-top:4px", text: pr.err || "Money values need the owner or Finance password. It is kept only while this tab is open." }));
}
function drawResults(d) {
  if (!document.getElementById("pr-css")) document.head.append(el("style", { id: "pr-css", text: PR_CSS }));
  var app = $("#monthly"), T = d.target || 99.95, W = d.wh || [], k = d.take || {}, rmOn = !!d.withRM, R = d.rm || {};
  app.innerHTML = ""; var pk = prPicker(); if (pk) app.append(pk);
  var chips = [k.stockType === "bad" ? "Bad stock" : "Good stock", k.scope === "partial" ? "Partial · " + (k.skuCount || "") + " SKUs" : "Total · every SKU in the MB52", k.mode === "single" ? "Single count" : "Double count"];
  if (k.imported) chips.push("Imported from the previous app");
  app.append(el("h2", { class: "sec", style: "margin-top:8px", text: "Final results · " + k.name }),
    el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:12px" }, chips.map(function (c) { return el("span", { class: "pill", text: c }); }),
      el("span", { class: "small muted", text: "Opened " + prDhm(k.openedAt) + " · closed " + prDhm(k.closedAt) + " · results locked" })));
  var nC = function (key) { return W.reduce(function (a, w) { return a + ((w.res || {})[key] || 0); }, 0); };
  var res = d.res || {}, tot = Object.keys(res).reduce(function (a, x) { return a + res[x]; }, 0);
  var tiles = rmOn ? [["System stock (SAP)", prM(R.sys), W.length + " warehouses"], ["Counted", prM(R.counted), W.filter(function (w) { return w.final; }).length + " of " + W.length + " sign-offs final"],
      ["Net difference", prRm(R.net, true), R.net < -0.5 ? "less found than SAP" : "more found than SAP", R.net < -0.5 ? "neg" : ""], ["Absolute difference", prRm(R.abs), "plus and minus per SKU added up"]]
    : [["Warehouses on target", (d.nat || {}).onTarget + " of " + W.length, "IRA ≥ " + T + "%"], ["SKUs exact or within tolerance", fmt(nC("OK") + nC("WITHIN")), "of " + fmt(tot) + " SKUs"],
      ["SKUs over tolerance", fmt(nC("OVER")), "difference bigger than " + d.tol + "%", nC("OVER") ? "neg" : ""], ["Warehouses not counted", fmt(W.filter(function (w) { return !w.counted; }).length), "every SKU counts as not found", W.some(function (w) { return !w.counted; }) ? "neg" : ""]];
  var nat = (d.nat || {}).ira;
  app.append(el("div", { class: "card" },
    el("div", { class: "pr-hero" },
      el("div", {}, el("span", { class: "small muted", text: "IRA by value (KPI002 rule)" }), el("b", { class: "big " + prCls(nat, T), text: prIra(nat) }),
        el("span", { class: "small muted", text: "Target " + T + "% · " + (d.nat || {}).onTarget + " of " + W.length + " warehouses on target" })),
      el("div", { class: "pr-tiles" }, tiles.map(function (x) { return el("div", { class: "pr-tile" }, el("span", { text: x[0] }), el("b", { class: x[3] || "", text: x[1] }), el("small", { text: x[2] })); }))),
    el("div", { style: "margin-top:14px" }, el("div", { class: "small", style: "display:flex;justify-content:space-between;margin-bottom:4px" }, el("b", { text: "SKU results, all warehouses" }), el("span", { class: "muted", text: fmt(tot) + " SKUs" })), prBar(res, 14), prKey(res)),
    el("div", { style: "margin-top:12px" }, lockBox(d))));

  /* IRA per warehouse, axis 90-100 % */
  var AX = 90, pos = function (v) { return Math.max(0, Math.min(100, (v - AX) / (100 - AX) * 100)); };
  var rows = W.slice().sort(function (a, b) { return (a.ira == null ? 101 : a.ira) - (b.ira == null ? 101 : b.ira); });
  var box = el("div", { class: "pr-ira" });
  box.append(el("div", { class: "pr-row pr-axis", "aria-hidden": "true" }, el("span"), el("span", { class: "tr" }, [90, 92, 94, 96, 98, 100].map(function (t) { return el("small", { style: "left:" + pos(t) + "%", text: t + "%" }); })), el("span")));
  rows.forEach(function (w) {
    var v = w.ira == null ? 0 : Math.max(0, w.ira);
    box.append(el("div", { class: "pr-row", role: "img", "aria-label": w.b + " IRA " + prIra(w.ira) }, el("span", { text: w.b.replace(/^NDD /, "") }),
      el("span", { class: "tr" }, el("i", { style: "width:" + Math.max(pos(v), 1.5) + "%;background:" + prCol(w.ira, T) }), el("u", { style: "left:" + pos(T) + "%" }), v < AX ? el("small", { text: "below " + AX + "%" }) : null),
      el("b", { class: prCls(w.ira, T), text: prIra(w.ira) })));
  });
  app.append(el("div", { class: "card" }, el("h3", { text: "IRA by value per warehouse" }), el("p", { class: "small muted", style: "margin:-4px 0 10px", text: "Axis from 90% to 100% so small gaps show; the dark line is the " + T + "% target." }), box));

  var g = el("div", { class: "grid" });
  rows.forEach(function (w) {
    var c = w.res || {};
    g.append(el("div", { class: "card pr-wh", style: "border-left-color:" + prCol(w.ira, T) },
      el("div", { class: "top" }, el("div", {}, el("b", { text: w.b }), el("div", { class: "small muted", text: fmt(w.nSku) + " SKUs in SAP" })),
        el("span", { class: "pill " + (w.final ? "ok" : "warn"), text: !w.counted ? "Not counted" : w.final ? "Final" : "Draft" })),
      el("div", { class: "ira " + prCls(w.ira, T), text: prIra(w.ira) }), prBar(c, 10), prKey(c),
      rmOn && w.rm ? el("div", { class: "pr-money" }, el("span", {}, el("span", { class: "muted", text: "Net " }), el("b", { class: w.rm.net < -0.5 ? "neg" : "", text: prRm(w.rm.net, true) })), el("span", {}, el("span", { class: "muted", text: "Absolute " }), el("b", { text: prRm(w.rm.abs) }))) : null));
  });
  app.append(el("h2", { class: "sec", text: "Warehouses · lowest accuracy first" }), g);

  if (rmOn && (R.top || []).length) {
    var L = el("div", { class: "pr-rows" });
    R.top.forEach(function (a) {
      L.append(el("div", {}, el("div", { class: "g" }, el("b", { text: a.code + " · " + a.desc }), el("small", { text: a.b })),
        el("div", { class: "n" }, el("span", {}, el("em", { text: "System" }), fmt(Math.round(a.sys))), el("span", {}, el("em", { text: "Counted" }), a.counted == null ? "-" : fmt(Math.round(a.counted))),
          el("span", { class: a.rm < 0 ? "neg" : "" }, el("em", { text: "Diff" }), prRm(a.rm, true)), el("span", { class: "pill " + (a.counted == null ? "" : a.rm < 0 ? "bad" : "ok"), text: a.counted == null ? "Not counted" : a.rm < 0 ? "Short" : "Excess" }))));
    });
    app.append(el("div", { class: "card", style: "margin-top:12px" }, el("h3", { text: "Biggest differences" }), el("p", { class: "small muted", style: "margin:-4px 0 6px", text: "Top 12 SKUs by RM, all batches together." }), L));
  }
}

load(); setInterval(function () { if (!document.hidden) load(); }, 30000);
document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
