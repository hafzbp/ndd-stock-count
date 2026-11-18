/* HQ admin: Daily tab (today's counts per warehouse, daily stock upload, ABC plan) and Dashboard tab. */
import { S, hooks } from "./state.js";
import { rpc } from "./api.js";
import { el, fmt, tsTxt, msg, errText, openModal, closeModal } from "./ui.js";
import { loadAdmin } from "./master.js";
import { mb52Card } from "./setup.js";
import { dayStatus, clsTag, renderDccStats } from "./dcc.js";

function tok() { return S.admin.token; }
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
export function addDays(s, n) { var d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return iso(d); }
export function niceDate(s) { if (!s) return ""; var d = new Date(s + "T00:00:00"); return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }); }
function hhmm(ts) { return ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : ""; }

export async function loadDaily() {
  S.dcc = await rpc("admin_dcc_day", { p_token: tok(), p_date: S.dccDate || null });
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
  var t = el("table", {}, el("tr", {}, ["Warehouse", "Status", "SKUs counted", "Count window", "Submitted", ""].map(function (h, i) { return el("th", { class: i === 2 ? "n" : "", text: h }); })));
  rows.forEach(function (r, i) {
    var s = st[i], tk = r.take;
    t.append(el("tr", {}, el("td", { text: r.branch }), el("td", {}, el("span", { class: "pill " + s.c, text: s.t })),
      el("td", { class: "n", text: tk ? r.counted + " / " + tk.skuCount : "" }), el("td", { class: "muted", text: r.from + "-" + r.to }), el("td", { text: hhmm(r.submittedAt) }),
      el("td", { class: "row", style: "gap:6px;flex-wrap:nowrap" },
        tk ? el("button", { class: "link", text: "View", onclick: function () { S.viewTake = tk.id; S.mBranch = r.branch; S.tab = "master"; loadAdmin().then(hooks.render); window.scrollTo(0, 0); } }) : null,
        tk ? el("button", { class: "link", text: "List", onclick: function () { showList(r); } }) : null,
        el("button", { class: "link", text: "ABC", onclick: function () { showAbc(r.branch, tok()); } }))));
  });
  if (!rows.length) t.append(el("tr", {}, el("td", { colspan: 6, class: "muted", text: "No warehouses yet." })));
  app.append(el("div", { class: "card" }, el("div", { class: "row", style: "justify-content:space-between" }, el("h3", { style: "margin:0", text: "Daily counts · " + niceDate(d) }), nav),
    el("p", { class: "small muted", text: Object.keys(cnt).map(function (k) { return k + ": " + cnt[k]; }).join(" · ") }), el("div", { class: "tw" }, t)));
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
