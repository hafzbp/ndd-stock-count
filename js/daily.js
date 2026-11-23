/* HQ admin: Daily tab (today's counts per warehouse, daily stock upload, ABC plan) and Dashboard tab. */
import { S, hooks } from "./state.js";
import { rpc } from "./api.js";
import { el, fmt, tsTxt, msg, errText, openModal, closeModal } from "./ui.js";
import { loadAdmin } from "./master.js";
import { mb52Card } from "./setup.js";
import { dayStatus, clsTag, renderDccStats } from "./dcc.js";
import { exportDailyReport, dailyPdf, dailySkus, dailyTotals } from "./export.js";

function tok() { return S.admin.token; }
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
export function addDays(s, n) { var d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return iso(d); }
export function niceDate(s) { if (!s) return ""; var d = new Date(s + "T00:00:00"); return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }); }
function hhmm(ts) { return ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : ""; }

export async function loadDaily() {
  S.dcc = await rpc("admin_dcc_day", { p_token: tok(), p_date: S.dccDate || null });
  S.dailyDet = null;
  if (!S.dccDate) S.dccDate = S.dcc.date;
  return S.dcc;
}

export function renderDaily(app) {
  if (!S.dcc || S.dcc.date !== (S.dccDate || S.dcc.date)) { app.append(el("p", { class: "center muted", text: "Loading…" })); loadDaily().then(hooks.render, function (e) { msg("Can't load", errText(e)); }); return; }
  var D = S.dcc, today = D.today, d = D.date, snap = D.snapshot;
  if ((S.adm && S.adm.settings && S.adm.settings.dcc_enabled) === false) app.append(el("div", { class: "banner warn" }, "Daily counts are switched off (Settings → Daily cycle count)."));

  /* daily stock upload */
  var di = el("input", { type: "date", value: today, max: today, style: "max-width:170px" });
  var stale = !snap || snap.date < addDays(today, -1);
  app.append(mb52Card("Daily stock (MB52)", function () { S.dcc = null; hooks.render(); }, { daily: {
    date: function () { return di.value || today; },
    info: snap ? "Latest: stock date " + niceDate(snap.date) + " · uploaded " + tsTxt(snap.loadedAt) : "No daily stock uploaded yet - daily counts start after the first upload.",
    extra: el("div", {}, stale ? el("div", { class: "banner warn", style: "margin:6px 0" }, snap ? "The latest stock is older than yesterday. Upload today's MB52 so counts compare to current stock." : "Upload the MB52 to start daily counts.") : null,
      el("div", { class: "row", style: "margin:6px 0" }, el("span", { class: "small", text: "Stock date (the day the MB52 was pulled)" }), di)) } }));

  /* day overview */
  var rows = D.rows || [], st = rows.map(function (r) { return dayStatus(r, d, today); });
  var cnt = {}; st.forEach(function (x) { var k = x.t.split(" · ")[0]; cnt[k] = (cnt[k] || 0) + 1; });
  var nav = el("div", { class: "row", style: "flex-wrap:nowrap;gap:6px" },
    el("button", { class: "btn", text: "‹", title: "Previous day", onclick: function () { S.dccDate = addDays(d, -1); S.dcc = null; hooks.render(); } }),
    el("input", { type: "date", value: d, max: today, style: "width:160px", onchange: function (e) { if (e.target.value) { S.dccDate = e.target.value; S.dcc = null; hooks.render(); } } }),
    el("button", { class: "btn", text: "›", title: "Next day", disabled: d >= today, onclick: function () { S.dccDate = addDays(d, 1); S.dcc = null; hooks.render(); } }),
    d !== today ? el("button", { class: "btn", text: "Today", onclick: function () { S.dccDate = today; S.dcc = null; hooks.render(); } }) : null,
    el("button", { class: "btn", text: "↻", title: "Refresh", onclick: function () { S.dcc = null; hooks.render(); } }));
  var sel = rows.filter(function (r) { return r.branch === S.dailySel; })[0] || rows.filter(function (r) { return r.take; })[0] || rows[0];
  var list = el("div", { class: "wrows" });
  rows.forEach(function (r, i) {
    var s = st[i], tk = r.take;
    list.append(el("button", { class: "wrow" + (sel === r ? " on" : ""), "aria-pressed": sel === r ? "true" : "false", onclick: function () { S.dailySel = r.branch; hooks.render(); if (window.innerWidth < 860) setTimeout(function () { var x = document.querySelector(".detail"); if (x) x.scrollIntoView({ block: "start", behavior: "smooth" }); }, 50); } },
      el("span", { class: "whn" }, el("b", { text: r.branch }), el("span", { class: "small muted", text: (r.from || "") + "–" + (r.to || "") })),
      el("span", { class: "pill " + s.c, text: s.t }),
      el("span", { class: "small num wx", text: tk ? r.counted + " / " + tk.skuCount + " SKUs" : "" }),
      el("span", { class: "small muted num wx", text: r.submittedAt ? "Sent " + hhmm(r.submittedAt) : "" }),
      el("span", { class: "muted", "aria-hidden": "true", text: "›" })));
  });
  if (!rows.length) list.append(el("p", { class: "muted", text: "No warehouses yet." }));
  var left = el("div", { class: "card" }, el("div", { class: "row", style: "justify-content:space-between" }, el("h3", { style: "margin:0", text: "Daily counts · " + niceDate(d) }),
      el("div", { class: "row", style: "gap:6px" }, nav, el("button", { class: "btn", text: "⬇ Export report", onclick: function () { reportDialog(today, rows.map(function (r) { return r.branch; })); } }))),
    el("p", { class: "small muted", text: Object.keys(cnt).map(function (k) { return k + ": " + cnt[k]; }).join(" · ") }), list);
  app.append(el("div", { class: "split" }, left, sel ? detailPanel(sel, st[rows.indexOf(sel)], d) : el("div")));
}

/* right-hand panel: one warehouse on one day */
function detailPanel(r, s, d) {
  var tk = r.take, key = d + "|" + r.branch, c = el("div", { class: "card detail" });
  c.append(el("div", { class: "small muted", text: niceDate(d) }), el("h3", { style: "margin:2px 0 6px;font-size:18px", text: r.branch }), el("span", { class: "pill " + s.c, text: s.t }));
  if (!tk) { c.append(el("p", { class: "muted small", text: s.t === "Off day" ? "Not a working day for this warehouse." : "No daily list for this day." }),
    el("div", { class: "dacts" }, el("button", { class: "btn", text: "ABC plan", onclick: function () { showAbc(r.branch, tok()); } }))); return c; }
  var D = S.dailyDet && S.dailyDet.key === key ? S.dailyDet : null;
  if (!D) {
    c.append(el("p", { class: "muted small", text: "Loading…" }));
    if (S.dailyDetLoading !== key) { S.dailyDetLoading = key;
      rpc("admin_dcc_report", { p_token: tok(), p_from: d, p_to: d, p_branch: r.branch }).then(function (rr) { S.dailyDet = { key: key, t: (rr.takes || [])[0] || null }; S.dailyDetLoading = null; hooks.render(); },
        function (e) { S.dailyDetLoading = null; S.dailyDet = { key: key, err: errText(e) }; hooks.render(); }); }
  } else if (D.err) c.append(el("p", { class: "small badt", text: "Can't load: " + D.err }));
  else if (D.t) {
    var t = D.t, o = dailyTotals(t), sk = dailySkus(t);
    c.append(el("div", { class: "small muted", style: "margin-top:8px", text: [t.who ? "Counted by " + t.who : "", t.submittedAt ? "sent " + hhmm(t.submittedAt) : "", t.photos ? t.photos + " photo" + (t.photos > 1 ? "s" : "") : ""].filter(Boolean).join(" · ") || "Nobody has counted yet" }),
      el("div", { class: "dstats" }, el("div", {}, el("b", { class: "num okt", text: String(o.ok + o.within) }), el("span", { text: "OK / within" })),
        el("div", {}, el("b", { class: "num " + (o.over + o.nis ? "badt" : ""), text: String(o.over + o.nis) }), el("span", { text: "Out of tolerance" })),
        el("div", {}, el("b", { class: "num", text: String(o.notCounted) }), el("span", { text: "Not counted" }))),
      el("div", { class: "row", style: "justify-content:space-between" }, el("span", { class: "small muted", text: "Net variance" }), el("b", { class: "num " + (o.net < 0 ? "badt" : ""), text: (o.net < 0 ? "-RM " : "RM ") + fmt(Math.abs(o.net), 0) })));
    var iss = sk.filter(function (g) { return g.flag === "OVER" || g.flag === "NOT IN SYSTEM"; }).sort(function (a, b) { return Math.abs(b.vv || 0) - Math.abs(a.vv || 0); });
    if (iss.length) {
      var box = el("div", { style: "margin-top:10px" }, el("div", { class: "small", style: "font-weight:700;margin-bottom:2px", text: "Out of tolerance · counted again tomorrow" }));
      iss.slice(0, 6).forEach(function (g) { box.append(el("div", { class: "issue" }, el("span", {}, el("b", { text: g.code + " " }), el("span", { class: "muted", text: g.desc })), el("span", { class: "num badt", style: "white-space:nowrap", text: (g.v > 0 ? "+" : "") + fmt(g.v || 0) + " pcs" }))); });
      if (iss.length > 6) box.append(el("div", { class: "small muted", text: "+ " + (iss.length - 6) + " more in the PDF" }));
      c.append(box);
    }
  }
  c.append(el("div", { class: "dacts" },
    el("button", { class: "btn primary", text: "Sign-off PDF", onclick: function () { dailyPdf(r.branch, d); } }),
    el("button", { class: "btn", text: "View counts", onclick: function () { S.viewTake = tk.id; S.mBranch = r.branch; S.tab = "master"; loadAdmin().then(hooks.render); window.scrollTo(0, 0); } }),
    el("button", { class: "btn", text: "List", onclick: function () { showList(r); } }),
    el("button", { class: "btn", text: "ABC", onclick: function () { showAbc(r.branch, tok()); } })));
  return c;
}

/* period + warehouse for the daily Excel report */
export function reportDialog(today, branches, from, to, only) {
  openModal(function (sh) {
    var f = el("input", { type: "date", value: from || today.slice(0, 8) + "01", max: today }), t = el("input", { type: "date", value: to || today, max: today });
    var w = el("select", {}, [el("option", { value: "", text: "All warehouses" })].concat(branches.map(function (b) { return el("option", { value: b, text: b, selected: only && only.length === 1 && only[0] === b }); })));
    var err = el("p", { class: "small", style: "color:var(--bad)" });
    sh.append(el("h3", { text: "Daily cycle count report (Excel)" }),
      el("p", { class: "small muted", text: "Summary per warehouse per working day, every SKU line counted, and SKUs out of tolerance again and again. Up to 2 months." }),
      el("label", { class: "small", text: "From" }), f, el("label", { class: "small", text: "To" }), t, el("label", { class: "small", text: "Warehouse" }), w, err,
      el("div", { class: "row", style: "margin-top:10px" }, el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", text: "Export", onclick: function () {
          if (!f.value || !t.value || t.value < f.value) { err.textContent = "Pick a valid period."; return; }
          if ((new Date(t.value) - new Date(f.value)) / 864e5 > 62) { err.textContent = "Pick at most 2 months."; return; }
          exportDailyReport(f.value, t.value, w.value ? [w.value] : (only || null));
        } })));
  });
}

function showList(r) {
  var p = r.take.plan || {};
  openModal(function (sh) {
    sh.append(el("h3", { text: r.branch + " · " + niceDate(r.take.countDate) }),
      el("p", { class: "small muted", text: "Today's list, picked by the system: SKUs most overdue against their monthly target come first (A before B before C), plus yesterday's out-of-tolerance SKUs (R) and SKUs added by the supervisor (S)." }),
      el("div", {}, Object.keys(p).sort().map(function (c) { return el("div", { class: "row", style: "padding:4px 0;border-bottom:1px solid var(--line)" }, clsTag(p[c]), el("span", { text: c + " " + ((skuDesc(c)) || "") })); })),
      el("div", { class: "row", style: "justify-content:flex-end;margin-top:10px" }, el("button", { class: "btn", text: "Close", onclick: closeModal })));
  });
}
function skuDesc(c) { var s = ((S.adm && S.adm.skus) || []).filter(function (x) { return x.code === c; })[0]; return s && s.desc; }

/* ABC plan of a warehouse this month (admin or supervisor token) */
export async function showAbc(branch, token) {
  try {
    var a = await rpc("admin_abc", { p_token: token, p_branch: branch });
    var tg = a.target || {}, t = el("table", {}, el("tr", {}, ["Class", "SKU", "Share of value", "Counted / target", "Last counted"].map(function (h, i) { return el("th", { class: i === 2 || i === 3 ? "n" : "", text: h }); })));
    a.rows.forEach(function (x) { var tgt = tg[x.cls] || 1; t.append(el("tr", {}, el("td", {}, clsTag(x.cls)), el("td", { text: x.code + " " + (x.desc || "") }), el("td", { class: "n", text: fmt(x.share, 1) + "%" }), el("td", { class: "n" + (x.counted >= tgt ? "" : " muted"), text: x.counted + " / " + tgt }), el("td", { text: x.last || "-" }))); });
    if (!a.rows.length) t.append(el("tr", {}, el("td", { colspan: 5, class: "muted", text: "No ABC yet for this month - it is worked out from the first daily stock upload." })));
    openModal(function (sh) {
      sh.append(el("h3", { text: branch + " · ABC " + String(a.month).slice(0, 7) }),
        el("p", { class: "small muted", text: "SKUs sorted by stock value. A = the SKUs that make up the first 80% of value, B = the next 15%, C = the rest. Monthly counts: A " + (tg.A || 4) + "×, B " + (tg.B || 2) + "×, C " + (tg.C || 1) + "×. Worked out on the 1st of the month from the latest stock upload." }),
        el("div", { class: "tw", style: "max-height:60vh;overflow:auto" }, t),
        el("div", { class: "row", style: "justify-content:flex-end;margin-top:10px" }, el("button", { class: "btn", text: "Close", onclick: closeModal })));
    });
  } catch (e) { msg("Can't load", errText(e)); }
}

/* Dashboard tab */
export { renderDash } from "./hqdash.js";
