/* HQ admin: Today - the morning checklist, every warehouse's count today (most urgent first), what needs attention, KPI this month. */
import { S, hooks } from "./state.js";
import { rpc } from "./api.js";
import { el, fmt, msg, errText } from "./ui.js";
import { svg, ICON } from "./count.js";
import { reportDialog } from "./daily.js";

function tok() { return S.admin.token; }
function hhmm(ts) { return ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : ""; }
function longDate(s) { return new Date(s + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }); }
function minsTo(today, hm) { if (!hm) return null; return Math.round((new Date(today + "T" + hm + ":00") - new Date()) / 60000); }
function dur(m) { var h = Math.floor(Math.abs(m) / 60), x = Math.abs(m) % 60; return (h ? h + " h " : "") + x + " min"; }
function monthOf(s) { return s.slice(0, 8) + "01"; }
function prevMonth(m) { var d = new Date(m + "T00:00:00"); d.setMonth(d.getMonth() - 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01"; }

function load() {
  if (S.todayLoading) return; S.todayLoading = true;
  var T;
  rpc("admin_dcc_today", { p_token: tok(), p_date: null }).then(function (r) {
    T = r; S.todayT = r; S.todayAt = new Date(); var m = monthOf(r.today);
    return Promise.all([
      rpc("admin_kpi", { p_token: tok(), p_month: m }).then(function (k) { S.todayKpi = k; }),
      rpc("admin_kpi", { p_token: tok(), p_month: prevMonth(m) }).then(function (k) { S.todayKpiPrev = k; }),
      S.holidays ? null : rpc("admin_holidays", { p_token: tok() }).then(function (h) { S.holidays = h; })
    ]);
  }).then(function () { S.todayLoading = false; hooks.render(); }, function (e) { S.todayLoading = false; if (!S.todayT) msg("Can't load today", errText(e)); else hooks.render(); });
}

/* status of one warehouse today, from admin_dcc_today */
function stateOf(r, T) {
  var left = minsTo(T.today, r.to);
  if (r.status === "ontime") return { k: "ok", rank: 6, t: "Submitted · on time", c: "ok" };
  if (r.status === "late") return { k: "late", rank: 5, t: "Submitted · late", c: "warn" };
  if (r.status === "progress") return left != null && left < 0 ? { k: "over", rank: 1, t: "Still counting · past " + r.to, c: "bad" } : { k: "cnt", rank: 4, t: "Counting", c: "info" };
  if (r.status === "todo") return left != null && left < 60 ? { k: "risk", rank: 0, t: left < 0 ? "Not started · past " + r.to : "Not started · " + dur(left) + " left", c: "bad" } : { k: "nos", rank: 2, t: "Not started", c: "" };
  if (r.status === "skip") return { k: "skip", rank: 7, t: "Skipped" + (r.skipReason ? " · " + r.skipReason : ""), c: "" };
  if (r.status === "monthly") return { k: "mon", rank: 8, t: "Monthly stock take", c: "" };
  if (r.status === "off") return { k: "off", rank: 9, t: "Off day", c: "" };
  if (r.status === "missed") return { k: "risk", rank: 0, t: "Missed", c: "bad" };
  if (r.status === "nostock") return { k: "nol", rank: 3, t: "Not in the MB52", c: "warn" };
  return { k: "nil", rank: 8, t: "Nothing due", c: "" };
}

export function renderToday(app) {
  var T = S.todayT;
  if (!T) { app.append(el("p", { class: "center muted", text: "Loading…" })); load(); return; }
  if (!S.todayAt || new Date() - S.todayAt > 60000) setTimeout(load, 0);
  var rows = (T.rows || []).map(function (r) { return Object.assign({}, r, { s: stateOf(r, T) }); });
  rows.sort(function (a, b) { return a.s.rank - b.s.rank || a.branch.localeCompare(b.branch); });
  var due = rows.filter(function (r) { return ["ok", "late", "cnt", "over", "nos", "risk"].indexOf(r.s.k) >= 0; });
  var n = function (ks) { return rows.filter(function (r) { return ks.indexOf(r.s.k) >= 0; }).length; };
  var noList = rows.filter(function (r) { return r.s.k === "nol"; });
  var snap = T.snapshot || {}, upToday = snap.date === T.today;

  app.append(el("div", { class: "pagehead" },
    el("div", {}, el("div", { class: "small muted", text: "Today · updated " + hhmm(S.todayAt) }), el("h1", { text: longDate(T.today) })),
    el("div", { class: "row" },
      el("button", { class: "btn", text: "↻ Refresh", onclick: function () { S.todayAt = null; load(); } }),
      el("button", { class: "btn", text: "Export report", onclick: function () { reportDialog(T.today, rows.map(function (r) { return r.branch; })); } }),
      el("button", { class: "btn primary", text: "Upload MB52", onclick: function () { S.tab = "daily"; S.dcc = null; hooks.render(); window.scrollTo(0, 0); } }))));

  /* monthly stock take open: counting pauses daily, so say it first */
  var ti = S.adm && S.adm.takeInfo;
  if (ti && ti.status === "open") app.append(el("button", { class: "monbar", onclick: function () { S.tab = "home"; hooks.render(); } },
    el("span", {}, el("b", { text: "Monthly stock take is open · " + (ti.name || "") }), el("span", { class: "small", text: "Daily counts pause at the warehouses in it. Follow progress and recounts in Monthly." })), svg(ICON.next, 18)));

  /* morning checklist */
  var ck = el("div", { class: "checks" });
  function check(state, title, lines, link) {
    return el("div", { class: "ck " + state }, el("div", { class: "ckh" }, el("span", { class: "ckd" }, state === "ok" ? svg(ICON.check, 14) : "!"), el("b", { text: title })),
      lines.map(function (l) { return el("div", { class: l[1] || "small", text: l[0] }); }), link || null);
  }
  var mbOk = upToday && !noList.length;
  ck.append(check(mbOk ? "ok" : "warn", "Today's MB52", [
    [snap.date ? (upToday ? "Loaded · stock date today" : "Latest stock date " + snap.date) : "No daily stock uploaded yet", "small"],
    noList.length ? [noList.map(function (r) { return r.branch.replace(/^NDD\s+/i, ""); }).join(", ") + (noList.length > 1 ? " are" : " is") + " missing from the stock file", "small warnt"] : [upToday ? "Every working warehouse has a list" : "Counts compare to old stock until today's file is in", "small muted"]],
    !mbOk ? el("button", { class: "link strong", text: upToday ? "Upload a corrected file" : "Upload today's MB52", onclick: function () { S.tab = "daily"; hooks.render(); } }) : null));
  var listed = due.reduce(function (a, r) { return a + (r.listed || 0); }, 0), lists = due.filter(function (r) { return r.listed; }).length;
  var minS = (S.todayKpi && S.todayKpi.minSkus) || 10, small = due.filter(function (r) { return r.listed && r.listed < minS; }).length;
  ck.append(check(lists ? "ok" : "warn", "Daily lists", [[lists + " list" + (lists === 1 ? "" : "s") + " · " + listed + " SKUs", "small"], [small ? small + " list(s) under " + minS + " SKU" + (minS === 1 ? "" : "s") + " (warehouse has fewer SKUs)" : "Every list has at least " + minS + " SKU" + (minS === 1 ? "" : "s"), "small muted"]]));
  var soon = (S.holidays || []).filter(function (h) { var d = (new Date(h.day + "T00:00:00") - new Date(T.today + "T00:00:00")) / 864e5; return d >= 0 && d <= 45; });
  var nextM = new Date(T.today + "T00:00:00"); nextM.setMonth(nextM.getMonth() + 1);
  var nmName = nextM.toLocaleDateString("en-GB", { month: "long" }), nmKey = nextM.getFullYear() + "-" + String(nextM.getMonth() + 1).padStart(2, "0");
  var inNext = (S.holidays || []).filter(function (h) { return h.day.slice(0, 7) === nmKey; }).length;
  ck.append(check(inNext ? "ok" : "warn", "Holidays", [[soon.length ? soon.slice(0, 2).map(function (h) { return h.day.slice(8, 10) + "/" + h.day.slice(5, 7) + " " + (h.name || "Holiday"); }).join(" · ") : "None in the next 45 days", "small"],
    [inNext ? inNext + " entered for " + nmName : "None entered for " + nmName + ": unlisted holidays count as missed days in KPI001", inNext ? "small muted" : "small warnt"]],
    inNext ? null : el("button", { class: "link strong", text: "Add holidays", onclick: function () { S.tab = "setup"; hooks.render(); setTimeout(function () { var h = document.querySelector("#holidays"); if (h) h.scrollIntoView({ block: "start" }); }, 200); } })));
  app.append(ck);

  /* numbers */
  var stats = [[due.length, "Due today", ""], [n(["ok", "late"]), "Submitted", "okt"], [n(["cnt", "over"]), "Counting", "infot"], [n(["nos", "risk"]), "Not started", n(["risk"]) ? "badt" : ""], [noList.length, "No list", noList.length ? "warnt" : ""]];
  app.append(el("div", { class: "statrow" }, stats.map(function (x) { return el("div", { class: "stat2" }, el("b", { class: "num " + x[2], text: String(x[0]) }), el("span", { text: x[1] })); })));

  /* warehouses + attention */
  var wl = el("div", { class: "card whlist" }, el("div", { class: "row", style: "justify-content:space-between" }, el("h3", { style: "margin:0", text: "Warehouses today" }), el("span", { class: "small muted", text: "Most urgent first" })));
  rows.forEach(function (r) {
    var pct = r.listed ? Math.round((r.counted || 0) / r.listed * 100) : 0;
    wl.append(el("div", { class: "whrow" },
      el("div", { class: "whn" }, el("b", { text: r.branch }), el("span", { class: "small muted", text: [r.region, r.who].filter(Boolean).join(" · ") || " " })),
      el("span", { class: "pill " + r.s.c, text: r.s.t }),
      el("div", { class: "whp" }, r.listed ? el("div", { class: "prog" }, el("i", { style: "width:" + pct + "%" })) : null, el("span", { class: "small num", text: r.listed ? (r.counted || 0) + " / " + r.listed + " SKUs" : "—" })),
      el("span", { class: "small muted num whw", text: r.submittedAt ? "Sent " + hhmm(r.submittedAt) : r.from ? r.from + "–" + r.to : "" }),
      el("button", { class: "link strong", text: r.listed ? "Open" : "Details", onclick: function () { S.tab = "daily"; S.dccDate = T.today; S.dcc = null; S.dailySel = r.branch; hooks.render(); window.scrollTo(0, 0); } })));
  });
  if (!rows.length) wl.append(el("p", { class: "muted", text: "No warehouses yet. Upload an MB52 to add them." }));

  var side = el("div", { class: "side" });
  var att = [];
  rows.forEach(function (r) {
    if (r.s.k === "risk") att.push(["bad", r.branch + (r.status === "missed" ? " missed today" : " hasn't started"), r.s.t, "Supervisor can send the WhatsApp reminder"]);
    if (r.s.k === "over") att.push(["bad", r.branch + " still counting", "Window ended " + r.to + " · " + (r.counted || 0) + " / " + r.listed + " SKUs", "Will show as late"]);
  });
  if (noList.length) att.push(["warn", noList.length + " warehouse" + (noList.length > 1 ? "s" : "") + " without stock data", noList.map(function (r) { return r.branch; }).join(", "), "Check the MB52 has their plant"]);
  rows.forEach(function (r) { if (r.result && r.result.over + r.result.nis > 0 && (r.s.k === "ok" || r.s.k === "late")) att.push(["mute", r.branch + ": " + (r.result.over + r.result.nis) + " SKU" + (r.result.over + r.result.nis > 1 ? "s" : "") + " out of tolerance", "Counted again tomorrow (R)", ""]); });
  var ac = el("div", { class: "card" }, el("h3", { text: "Needs attention" }));
  if (!att.length) ac.append(el("p", { class: "muted small", text: "Nothing right now." }));
  att.slice(0, 8).forEach(function (a) { ac.append(el("div", { class: "att" }, el("i", { class: a[0] }), el("div", {}, el("b", { text: a[1] }), el("div", { class: "small muted", text: a[2] }), a[3] ? el("div", { class: "small", text: a[3] }) : null))); });
  side.append(ac);
  var K = S.todayKpi, KP = S.todayKpiPrev, kc = el("div", { class: "card" }, el("h3", { text: "KPI this month" }));
  if (K) {
    var p = 0, h = 0; (K.branches || []).forEach(function (b) { (b.cells || []).forEach(function (c) { if (["pass", "late", "under", "skip", "missed"].indexOf(c.st) >= 0) { h++; if (c.st === "pass") p++; } }); });
    var a1 = h ? p / h * 100 : null;
    kc.append(el("div", { class: "kmini" }, el("span", { text: "KPI001 daily count" }), el("b", { class: "num", text: a1 == null ? "-" : (Math.floor(a1 * 10) / 10).toFixed(1) + "%" })),
      el("div", { class: "prog" }, el("i", { style: "width:" + (a1 || 0) + "%;background:var(--info)" })),
      el("div", { class: "small muted", text: h ? p + " of " + h + " working days passed · target 100%" : "No working day finished yet this month" }));
  }
  if (KP) {
    var sys = 0, abs = 0; (KP.branches || []).forEach(function (b) { if (b.kpi2 && b.kpi2.sysRm) { sys += b.kpi2.sysRm; abs += b.kpi2.absRm; } });
    var a2 = sys ? (1 - abs / sys) * 100 : KP.kpi2Ira != null ? KP.kpi2Ira * 100 : null, mn = new Date(KP.month + "T00:00:00").toLocaleDateString("en-GB", { month: "short" });
    kc.append(el("div", { class: "kmini", style: "margin-top:12px;padding-top:12px;border-top:1px solid var(--chip)" }, el("span", { text: "KPI002 stock take (" + mn + ")" }), el("b", { class: "num", text: a2 == null ? "-" : (Math.floor(a2 * 100) / 100).toFixed(2) + "%" })),
      el("div", { class: "small " + (a2 == null ? "muted" : a2 >= 99.95 ? "okt" : "badt"), text: a2 == null ? "No month-end stock take marked" : a2 >= 99.95 ? "✓ On target (≥ 99.95%)" : "✕ Below target (99.95%)" }));
  }
  kc.append(el("button", { class: "link strong", style: "margin-top:8px", text: "Open dashboard", onclick: function () { S.tab = "dash"; hooks.render(); window.scrollTo(0, 0); } }));
  side.append(kc);
  app.append(el("div", { class: "split" }, wl, side));
}
