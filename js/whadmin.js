/* HQ side of My Warehouse: Stock (LSH vs SAP, staging, opening stock), People (login per NDD, people,
   PINs, LSH on/off) and HQ accounts (superadmin). */
import { S, hooks } from "./state.js";
import { rpc } from "./api.js";
import { el, msg, toast, errText, openModal, closeModal, confirmBox } from "./ui.js";

var ROLES = [["lo", "Logistic Officer"], ["admin", "Warehouse Admin"], ["sup", "Supervisor"], ["om", "Ops Manager"]];
var REASONS = [["sap", "SAP late or wrong"], ["lsh_error", "LSH input error"], ["not_recorded", "Not recorded in LSH"], ["physical", "Missing or extra (count confirms)"]];
function tok() { return S.admin && S.admin.token; }
function H() { return S.hq || (S.hq = {}); }
function sk(code) { var a = ((S.adm && S.adm.skus) || S.skus || []); for (var i = 0; i < a.length; i++) if (a[i].code === code) return a[i]; return { code: code }; }
function ctn(code, q) { var s = sk(code); if (q == null) return ""; if (!s.per) return Number(q).toLocaleString("en-MY") + " pcs"; var c = Math.trunc(q / s.per), r = Math.round(Math.abs(q - c * s.per)); return (q < 0 && c === 0 ? "−" : "") + (c ? c.toLocaleString("en-MY") + " ctn" : "") + (r ? (c ? " " : "") + r + " pcs" : c ? "" : "0"); }
function signed(code, q) { return (q > 0 ? "+" : "") + ctn(code, q); }
function hhmm(ts) { return ts ? new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : ""; }
function age(ts) { var h = Math.floor((Date.now() - new Date(ts)) / 3600000); return h >= 48 ? Math.floor(h / 24) + " days" : h + " h"; }
function pill(txt, tone) { return el("span", { class: "pill " + (tone || ""), text: txt }); }
async function load(key, fn) {
  try { H()[key] = await fn(); } catch (e) { H()[key] = { error: errText(e) }; if (e.code === "AUTH" && hooks.adminAuth) hooks.adminAuth(e); }
  hooks.render();
}

/* ---------- Overview card (Today tab) ---------- */
export function lshOverviewCard(app) {
  var L = H().lsh;
  if (!L) { load("lsh", function () { return rpc("admin_lsh", { p_token: tok() }); }); return; }
  if (L.error) return;
  var on = (L.branches || []).filter(function (b) { return b.lsh; });
  if (!on.length) return;
  var c = el("div", { class: "card" }, el("div", { class: "row", style: "justify-content:space-between;align-items:baseline" }, el("h3", { style: "margin:0", text: "Stock (LSH) · " + on.length + " NDD" }), el("button", { class: "link", text: "Open Stock", onclick: function () { S.tab = "stock"; hooks.render(); } })));
  on.forEach(function (b) {
    var late = (b.stg || []).filter(function (x) { return x.waiting > 0 && Date.now() - new Date(x.firstAt) > 864e5; }).length;
    c.append(el("div", { class: "row", style: "justify-content:space-between;padding:8px 0;border-top:1px solid var(--line);flex-wrap:wrap;gap:6px" },
      el("b", { text: b.branch }),
      el("span", { class: "row", style: "gap:6px;flex-wrap:wrap" },
        b.todayClosed ? pill("Day closed " + hhmm(b.closedAt).slice(-5) + (b.late ? " · late" : ""), b.late ? "warn" : "ok") : pill("Day open", ""),
        b.open ? pill(b.open + " open differences", "bad") : pill("No open differences", "ok"),
        late ? pill(late + " invoice(s) in staging > 24 h", "bad") : null)));
  });
  app.append(c);
}

/* ---------- Stock ---------- */
export function renderHqStock(app) {
  var h = H(), L = h.lsh;
  if (!L) { app.append(el("p", { class: "center muted", text: "Loading…" })); load("lsh", function () { return rpc("admin_lsh", { p_token: tok() }); }); return; }
  if (L.error) { app.append(el("div", { class: "card", text: L.error })); return; }
  var on = (L.branches || []).filter(function (b) { return b.lsh; });
  if (!on.length) { app.append(el("div", { class: "card" }, el("h3", { text: "Stock (LSH) is not on for any warehouse" }), el("p", { class: "muted", text: "Switch it on per NDD in Setup → People. It needs the username and PIN login." }))); return; }
  var br = h.stBr && on.some(function (b) { return b.branch === h.stBr; }) ? h.stBr : on[0].branch; h.stBr = br;
  var b = on.find(function (x) { return x.branch === br; });
  var view = h.stView || "recon";
  var top = el("div", { class: "row", style: "gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px" });
  var sel = el("select", { "aria-label": "Warehouse", style: "max-width:280px", onchange: function () { h.stBr = sel.value; h.recon = null; hooks.render(); } }, on.map(function (x) { return el("option", { value: x.branch, text: x.branch, selected: x.branch === br }); }));
  top.append(sel);
  [["recon", "LSH vs SAP"], ["staging", "Staging and deliveries"], ["opening", "Opening and reset"]].forEach(function (v) { top.append(el("button", { class: "btn" + (view === v[0] ? " primary" : ""), text: v[1], onclick: function () { h.stView = v[0]; hooks.render(); } })); });
  top.append(el("button", { class: "btn", text: "Refresh", onclick: function () { h.lsh = null; h.recon = null; hooks.render(); } }));
  app.append(top);
  var stats = el("div", { class: "stats" });
  function st(n, l) { stats.append(el("div", { class: "stat" }, el("b", { text: String(n) }), el("span", { text: l }))); }
  st(b.todayClosed ? "Closed" : "Open", "Today" + (b.closedAt ? " · " + hhmm(b.closedAt).slice(-5) : ""));
  st(b.open, "Open differences"); st(b.explained, "Explained"); st((b.stg || []).length, "Invoices in staging");
  if (b.onTime) st(b.onTime.days - b.onTime.late + " of " + b.onTime.days, "Days closed on time");
  app.append(stats);
  if (!b.started) app.append(el("div", { class: "banner warn", text: "No opening stock yet for " + br + ". Set it in “Opening and reset” before the first day." }));
  if (view === "staging") return stagingView(app, on);
  if (view === "opening") return openingView(app, b, L);
  reconView(app, br);
}
function reconView(app, br) {
  var h = H(), R = h.recon;
  if (!R || R.branch !== br || (h.reconDay && R.day !== h.reconDay)) { app.append(el("p", { class: "muted", text: "Loading…" })); load("recon", function () { return rpc("admin_lsh_recon", { p_token: tok(), p_branch: br, p_day: h.reconDay || null }); }); return; }
  if (R.error) { app.append(el("div", { class: "card", text: R.error })); return; }
  if (!R.day) { app.append(el("div", { class: "card muted", text: "No comparison yet. It is built when the day is closed and HQ uploads the evening MB52 (after the cut-off)." })); return; }
  var head = el("div", { class: "row", style: "gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0" }, el("b", { text: "Day" }),
    el("select", { "aria-label": "Day", style: "max-width:200px", onchange: function (e) { h.reconDay = e.target.value; hooks.render(); } }, (R.days || []).map(function (d) { return el("option", { value: d, text: d, selected: d === R.day }); })),
    el("span", { class: "small muted", text: "LSH closed " + hhmm(R.closedAt) + " vs MB52 of that evening. Good stock vs MW00/MW01, bad stock vs BS00/BS01/SH00. Staging is left out." }));
  app.append(head);
  var f = h.reconF || "diff", rows = (R.rows || []).filter(function (r) { return f === "all" || (f === "diff" ? r.status !== "match" : r.status === "open"); });
  var chips = el("div", { class: "row", style: "gap:6px;margin:6px 0" });
  [["diff", "Differences"], ["open", "Open"], ["all", "All"]].forEach(function (c) { chips.append(el("button", { class: "btn" + (f === c[0] ? " primary" : ""), style: "min-height:34px;padding:4px 12px", text: c[1], onclick: function () { h.reconF = c[0]; hooks.render(); } })); });
  app.append(chips);
  var tb = el("table", { class: "tbl" }), th = el("tr");
  ["SKU", "Area", "LSH", "SAP", "Diff", "Daily count", "Reason", ""].forEach(function (x) { th.append(el("th", { text: x })); });
  tb.append(el("thead", {}, th));
  var body = el("tbody");
  rows.forEach(function (r) {
    var dc = R.dcc && R.dcc[r.code] && r.area === "gs" ? R.dcc[r.code] : null;
    var tr = el("tr", {},
      el("td", {}, el("b", { text: r.descr || r.code }), el("div", { class: "small muted", text: r.code + (r.since && r.since !== R.day ? " · since " + r.since : "") })),
      el("td", { text: r.area === "gs" ? "Good" : "Bad" }), el("td", { class: "num", text: ctn(r.code, r.lsh) }), el("td", { class: "num", text: ctn(r.code, r.sap) }),
      el("td", { class: "num", style: "font-weight:800", text: r.diff ? signed(r.code, r.diff) : "0" }),
      el("td", { class: "num small", text: dc ? ctn(r.code, dc.count) + (dc.diff ? " (" + signed(r.code, dc.diff) + " vs LSH)" : " ✓") : "–" }),
      el("td", {}, r.status === "match" ? pill("Match", "ok") : r.reason ? el("span", {}, pill((REASONS.find(function (x) { return x[0] === r.reason; }) || [])[1] || r.reason, "warn"), el("div", { class: "small muted", text: (r.note || "") + (r.setBy ? " · " + r.setBy : "") })) : pill("Open" + (r.dueAt ? " · due " + hhmm(r.dueAt) : ""), "bad")),
      el("td", {}, r.status === "match" ? null : el("button", { class: "btn", style: "min-height:34px;padding:4px 10px", text: "Reason", onclick: function () { reasonSheet(R, r); } })));
    body.append(tr);
  });
  if (!rows.length) body.append(el("tr", {}, el("td", { colspan: "8", class: "muted", text: "Nothing here." })));
  tb.append(body);
  app.append(el("div", { class: "card", style: "overflow-x:auto;padding:0" }, tb));
}
function reasonSheet(R, r) {
  var pick = r.reason;
  openModal(function (sh) {
    var n = el("input", { placeholder: "Note or document (optional)", value: r.note || "" }), g = el("div", { class: "wh-reasons" });
    REASONS.forEach(function (x) { g.append(el("button", { class: "big" + (pick === x[0] ? " on" : ""), text: x[1], onclick: function (e) { pick = x[0]; g.querySelectorAll("button").forEach(function (b) { b.classList.remove("on"); }); e.currentTarget.classList.add("on"); } })); });
    sh.append(el("h3", { text: (r.descr || r.code) + " · " + (r.area === "gs" ? "Good" : "Bad") }), el("p", { class: "small muted", text: "LSH " + ctn(r.code, r.lsh) + " · SAP " + ctn(r.code, r.sap) + " · diff " + signed(r.code, r.diff) }), g, el("div", { style: "height:8px" }), n,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", style: "flex:2", text: "Save", onclick: async function () {
          if (!pick) return; try { await rpc("lsh_reason", { p_token: tok(), p_branch: R.branch, p_day: R.day, p_code: r.code, p_area: r.area, p_reason: pick, p_note: n.value }); closeModal(); H().recon = null; H().lsh = null; toast("Saved"); hooks.render(); } catch (e) { msg("Can't save", errText(e)); }
        } })));
  });
}
function stagingView(app, on) {
  var all = [];
  on.forEach(function (b) { (b.stg || []).forEach(function (x) { all.push(Object.assign({ branch: b.branch }, x)); }); });
  all.sort(function (a, b) { return String(a.firstAt || a.failedAt).localeCompare(String(b.firstAt || b.failedAt)); });
  var wait = all.filter(function (x) { return x.waiting > 0; }), back = all.filter(function (x) { return x.failed > 0; });
  var old = wait.filter(function (x) { return Date.now() - new Date(x.firstAt) > 864e5; });
  app.append(el("p", { class: "small muted", text: "All LSH warehouses. Invoiced in SAP, still in the warehouse; oldest first. “Loaded” is the last thing LSH sees: delivered or not comes with ePOD." }));
  var stats = el("div", { class: "stats" });
  [[wait.length, "Waiting to load"], [old.length, "Waiting over 24 h"], [back.length, "Came back, waiting SAP reversal"]].forEach(function (x) { stats.append(el("div", { class: "stat" }, el("b", { text: String(x[0]) }), el("span", { text: x[1] }))); });
  app.append(stats);
  var tb = el("table", { class: "tbl" });
  tb.append(el("thead", {}, el("tr", {}, ["Invoice", "NDD", "SKUs", "Since", "Status"].map(function (x) { return el("th", { text: x }); }))));
  var body = el("tbody");
  all.forEach(function (x) {
    var late = x.waiting > 0 && Date.now() - new Date(x.firstAt) > 864e5;
    body.append(el("tr", {}, el("td", { style: "font-weight:700", text: x.doc }), el("td", { text: x.branch.replace(/^NDD /, "") }), el("td", { class: "num", text: String(x.lines.length) }),
      el("td", { class: "small", text: hhmm(x.firstAt || x.failedAt) }),
      el("td", {}, x.failed > 0 ? pill("Came back · " + (x.reason || "").replace(/_/g, " ") + " · waiting reversal", "warn") : pill("Waiting · " + age(x.firstAt), late ? "bad" : ""))));
  });
  if (!all.length) body.append(el("tr", {}, el("td", { colspan: "5", class: "muted", text: "Staging is empty." })));
  tb.append(body); app.append(el("div", { class: "card", style: "overflow-x:auto;padding:0" }, tb));
}
function openingView(app, b, L) {
  var c = el("div", { class: "card" }, el("h3", { text: "Opening stock and reset · " + b.branch }),
    el("p", { class: "small muted", text: "Sets LSH to physical or SAP stock. Each SKU gets a “stock reset” entry for the difference, so the history shows how far LSH had drifted. A stock take sets only the SKUs it counted, in the area it counted (good or bad). An MB52 sets good and bad stock." }));
  var src = el("select", { "aria-label": "Source" });
  (L.takes || []).forEach(function (x) { src.append(el("option", { value: "take|" + x.id, text: "Stock take: " + x.name + (x.stockType === "bad" ? " (bad stock)" : "") })); });
  (L.snapshots || []).forEach(function (x) { src.append(el("option", { value: "snapshot|" + x.id, text: "MB52 of " + x.date + " (loaded " + hhmm(x.loadedAt) + ")" })); });
  c.append(src, el("div", { class: "row", style: "justify-content:flex-end;margin-top:10px" }, el("button", { class: "btn primary", text: "Set LSH to this", onclick: function () {
    var v = src.value.split("|"); if (!v[1]) return;
    confirmBox("Reset LSH of " + b.branch + "?", src.options[src.selectedIndex].text + "\n\nLSH stock becomes this from now on. Entries already made stay in the history.", "Reset", async function () {
      try { var r = await rpc("admin_lsh_reset", { p_token: tok(), p_branch: b.branch, p_source: v[0], p_ref: v[1], p_at: null }); H().lsh = null; H().recon = null; msg("Done", r.lines + " SKU line(s) adjusted. " + r.label); hooks.render(); }
      catch (e) { msg("Can't reset", errText(e)); }
    });
  } })));
  app.append(c);
}

/* ---------- Setup → People ---------- */
export function renderPeopleAdmin(app) {
  var h = H(), L = h.lsh;
  if (!L) { app.append(el("p", { class: "center muted", text: "Loading…" })); load("lsh", function () { return rpc("admin_lsh", { p_token: tok() }); }); return; }
  if (L.error) { app.append(el("div", { class: "card", text: L.error })); return; }
  app.append(el("div", { class: "banner", text: "Warehouses on “Username and PIN” log in on the first page with their own username; the others keep the plant code. Stock (LSH) needs Username and PIN." }));
  var tb = el("table", { class: "tbl" });
  tb.append(el("thead", {}, el("tr", {}, ["Warehouse", "Login", "Stock (LSH)", "Cut-off", "People", ""].map(function (x) { return el("th", { text: x }); }))));
  var body = el("tbody");
  (L.branches || []).forEach(function (b) {
    var mode = el("select", { "aria-label": "Login " + b.branch }, [["plant", "Plant code"], ["people", "Username and PIN"]].map(function (o) { return el("option", { value: o[0], text: o[1], selected: b.loginMode === o[0] }); }));
    var lsh = el("input", { type: "checkbox", checked: b.lsh, "aria-label": "LSH " + b.branch });
    var cut = el("input", { type: "time", value: b.cutoff || "16:00", style: "width:140px" });
    body.append(el("tr", {}, el("td", {}, el("b", { text: b.branch }), el("div", { class: "small muted", text: b.plant || "" })), el("td", {}, mode), el("td", {}, lsh), el("td", {}, cut),
      el("td", {}, el("button", { class: "link", text: String(b.people), onclick: function () { h.pBr = b.branch; h.people = null; hooks.render(); } })),
      el("td", {}, el("button", { class: "btn", style: "min-height:34px;padding:4px 10px", text: "Save", onclick: async function () {
        try { await rpc("admin_lsh_branch", { p_token: tok(), p_branch: b.branch, p_login_mode: mode.value, p_lsh: lsh.checked, p_cutoff: cut.value }); h.lsh = null; toast("Saved"); hooks.render(); } catch (e) { msg("Can't save", errText(e)); }
      } }))));
  });
  tb.append(body); app.append(el("div", { class: "card", style: "overflow-x:auto;padding:0" }, tb));
  peopleCard(app);
}
function peopleCard(app) {
  var h = H(), all = h.lsh.branches || [], names = all.map(function (b) { return b.branch; });
  var br = h.pBr || ((all.find(function (b) { return b.loginMode === "people"; }) || all[0] || {}).branch); h.pBr = br;
  var c = el("div", { class: "card" });
  var sel = el("select", { "aria-label": "Warehouse", style: "max-width:280px", onchange: function () { h.pBr = sel.value; h.people = null; hooks.render(); } }, names.map(function (n) { return el("option", { value: n, text: n, selected: n === br }); }));
  c.append(el("div", { class: "row", style: "justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap" }, el("h3", { style: "margin:0", text: "People" }), sel,
    el("button", { class: "btn primary", text: "Add person", onclick: function () { personSheet(br, null); } })));
  if (!h.people || h.people.br !== br) { c.append(el("p", { class: "muted", text: "Loading…" })); app.append(c); load("people", async function () { var x = await rpc("wh_people", { p_token: tok(), p_branch: br }); return { br: br, list: x }; }); return; }
  if (h.people.error) { c.append(el("p", { text: h.people.error })); app.append(c); return; }
  var tb = el("table", { class: "tbl" });
  tb.append(el("thead", {}, el("tr", {}, ["Name", "Username", "Roles", "PIN", ""].map(function (x) { return el("th", { text: x }); }))));
  var body = el("tbody");
  h.people.list.forEach(function (p) {
    body.append(el("tr", { style: p.active ? "" : "opacity:.5" }, el("td", {}, el("b", { text: p.name }), p.active ? null : el("div", { class: "small", text: "switched off" })), el("td", { style: "font-family:ui-monospace,monospace", text: p.username || "" }),
      el("td", { class: "small", text: p.roles.map(function (r) { return (ROLES.find(function (x) { return x[0] === r; }) || [r, r])[1]; }).join(", ") + (p.actingOmUntil ? " · acting OM until " + p.actingOmUntil : "") }),
      el("td", {}, p.locked ? pill("Locked", "bad") : p.pinSet ? pill("Set", "ok") : pill("Temporary", "warn")),
      el("td", { class: "row", style: "gap:6px;flex-wrap:wrap" },
        el("button", { class: "btn", style: "min-height:34px;padding:4px 10px", text: "Edit", onclick: function () { personSheet(br, p); } }),
        el("button", { class: "btn", style: "min-height:34px;padding:4px 10px", text: "Reset PIN", onclick: function () { confirmBox("Reset " + p.name + "'s PIN?", "They get a temporary PIN and choose their own at the next sign-in.", "Reset", async function () { try { var r = await rpc("wh_person_reset", { p_token: tok(), p_id: p.id }); msg("Temporary PIN for " + r.name, "Username: " + r.username + "\nPIN: " + r.tempPin + "\n\nGive it to " + r.name + " in person. It works once."); h.people = null; hooks.render(); } catch (e) { msg("Can't reset", errText(e)); } }); } }),
        p.locked ? el("button", { class: "btn", style: "min-height:34px;padding:4px 10px", text: "Unlock", onclick: async function () { try { await rpc("wh_person_unlock", { p_token: tok(), p_id: p.id }); h.people = null; hooks.render(); } catch (e) { msg("Can't unlock", errText(e)); } } }) : null)));
  });
  if (!h.people.list.length) body.append(el("tr", {}, el("td", { colspan: "5", class: "muted", text: "Nobody yet. Add the Ops Manager first; they can then add their team." })));
  tb.append(body); c.append(el("div", { style: "overflow-x:auto" }, tb)); app.append(c);
}
function personSheet(br, p) {
  openModal(function (sh) {
    var n = el("input", { value: p ? p.name : "", placeholder: "Name as people call them, e.g. Ravi K." }), roles = {}, err = el("div", { class: "small", style: "color:var(--bad);min-height:18px" });
    var un = el("input", { value: p ? p.username : "", placeholder: "Username (empty: made from the name, e.g. ravi." + (plantOf(br) || "1503") + ")", autocapitalize: "none", autocorrect: "off", spellcheck: "false" });
    (p ? p.roles : []).forEach(function (r) { roles[r] = 1; });
    var g = el("div", { class: "wh-reasons", style: "margin-top:8px" });
    ROLES.forEach(function (r) { var b = el("button", { class: "big" + (roles[r[0]] ? " on" : ""), text: r[1], onclick: function () { if (roles[r[0]]) delete roles[r[0]]; else roles[r[0]] = 1; b.classList.toggle("on"); } }); g.append(b); });
    var act = el("input", { type: "checkbox", checked: p ? p.active : true }), until = el("input", { type: "date", value: p && p.actingOmUntil || "" });
    sh.append(el("h3", { text: p ? "Edit " + p.name : "Add a person · " + br }), n, el("div", { style: "height:8px" }), un, g,
      el("label", { class: "row", style: "gap:8px;margin-top:10px" }, act, el("span", { text: "Active (can sign in)" })),
      el("label", { class: "small muted", style: "display:block;margin-top:10px" }, "Acting Ops Manager until (optional, e.g. while the OM is on leave)", until), err,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", style: "flex:2", text: "Save", onclick: async function () {
          try {
            var r = await rpc("wh_person_save", { p_token: tok(), p_branch: br, p_id: p ? p.id : null, p_name: n.value, p_username: un.value, p_roles: Object.keys(roles), p_active: act.checked, p_acting_om_until: until.value || null });
            closeModal(); H().people = null; H().lsh = null; hooks.render();
            if (r.tempPin) msg("Login for " + r.name, "Username: " + r.username + "\nTemporary PIN: " + r.tempPin + "\n\nGive it to " + r.name + " in person. At the first login they choose their own 6-digit PIN.");
            else toast("Saved");
          } catch (e) { err.textContent = errText(e); }
        } })));
  });
}
function plantOf(br) { var b = ((H().lsh || {}).branches || []).find(function (x) { return x.branch === br; }); return b && b.plant; }

/* ---------- Setup → HQ accounts ---------- */
export function renderHqAccounts(app) {
  var h = H();
  if (!h.me) { app.append(el("p", { class: "center muted", text: "Loading…" })); load("me", function () { return rpc("hq_me", { p_token: tok() }); }); return; }
  if (h.me.error) { app.append(el("div", { class: "card", text: h.me.error })); return; }
  var me = h.me, isSuper = me.user && me.user.role === "superadmin", canMakeFirst = me.shared && me.kind === "owner" && !me.superExists;
  var c = el("div", { class: "card" }, el("h3", { text: "You" }),
    el("p", { text: me.user ? me.user.name + " · " + me.user.email + " · " + me.user.role : "Signed in with the shared " + me.kind + " password" }),
    me.user ? el("button", { class: "btn", text: "Change my password", onclick: function () { hooks.hqPassword && hooks.hqPassword(false); } }) : null);
  app.append(c);
  if (canMakeFirst) {
    app.append(el("div", { class: "card" }, el("h3", { text: "Make the first superadmin" }), el("p", { class: "small muted", text: "Named accounts replace the shared passwords. Start with your own superadmin account; then add the others from it." }),
      el("button", { class: "btn primary", text: "Make my superadmin account", onclick: function () { accountSheet(null, true); } })));
    return;
  }
  if (!isSuper) { app.append(el("p", { class: "muted", text: "Only a superadmin manages HQ accounts." })); return; }
  if (!h.accounts) { load("accounts", function () { return rpc("hq_users_list", { p_token: tok() }); }); app.append(el("p", { class: "muted", text: "Loading…" })); return; }
  var a = el("div", { class: "card" }, el("div", { class: "row", style: "justify-content:space-between;align-items:center" }, el("h3", { style: "margin:0", text: "HQ accounts" }), el("button", { class: "btn primary", text: "Add account", onclick: function () { accountSheet(null, false); } })));
  (h.accounts.error ? [] : h.accounts).forEach(function (u) {
    a.append(el("div", { class: "row", style: "justify-content:space-between;padding:8px 0;border-top:1px solid var(--line);gap:8px;flex-wrap:wrap;" + (u.active ? "" : "opacity:.5") },
      el("div", {}, el("b", { text: u.name + " · " + u.role }), el("div", { class: "small muted", text: u.email + " · last login " + (u.lastLogin ? hhmm(u.lastLogin) : "never") })),
      el("span", { class: "row", style: "gap:6px" }, el("button", { class: "btn", text: "Edit", onclick: function () { accountSheet(u, false); } }),
        el("button", { class: "btn", text: "Reset password", onclick: function () { confirmBox("Reset " + u.name + "'s password?", "They get a temporary password and choose their own at the next login.", "Reset", async function () { try { var r = await rpc("hq_user_reset", { p_token: tok(), p_id: u.id }); msg("Temporary password for " + r.email, r.tempPassword + "\n\nSend it privately. It must be changed at the first login."); } catch (e) { msg("Can't reset", errText(e)); } }); } }))));
  });
  app.append(a);
  var sw = el("input", { type: "checkbox", checked: me.sharedLogin });
  app.append(el("div", { class: "card" }, el("h3", { text: "Shared passwords" }), el("p", { class: "small muted", text: "The old shared owner and finance passwords. Switch them off once everyone at HQ has a named account; anyone still signed in with them is signed out." }),
    el("label", { class: "row", style: "gap:8px" }, sw, el("span", { text: "Allow the shared passwords" })),
    el("button", { class: "btn", style: "margin-top:8px", text: "Save", onclick: async function () { try { await rpc("hq_shared_login", { p_token: tok(), p_on: sw.checked }); h.me = null; toast("Saved"); hooks.render(); } catch (e) { msg("Can't save", errText(e)); } } })));
}
function accountSheet(u, first) {
  openModal(function (sh) {
    var e = el("input", { type: "email", placeholder: "Email", value: u ? u.email : "" }), n = el("input", { placeholder: "Name", value: u ? u.name : "" });
    var r = el("select", {}, (first ? [["superadmin", "Superadmin"]] : [["superadmin", "Superadmin: everything, manages HQ accounts"], ["admin", "HQ admin: runs stock takes, LSH, setup"], ["finance", "HQ Finance: results, KPI, signed copies"]]).map(function (x) { return el("option", { value: x[0], text: x[1], selected: u ? u.role === x[0] : x[0] === "admin" }); }));
    var act = el("input", { type: "checkbox", checked: u ? u.active : true }), err = el("div", { class: "small", style: "color:var(--bad);min-height:18px" });
    sh.append(el("h3", { text: first ? "Your superadmin account" : u ? "Edit " + u.name : "Add an HQ account" }), e, el("div", { style: "height:8px" }), n, el("div", { style: "height:8px" }), r,
      u ? el("label", { class: "row", style: "gap:8px;margin-top:8px" }, act, el("span", { text: "Active" })) : null, err,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", style: "flex:2", text: "Save", onclick: async function () {
          try {
            var x = await rpc("hq_user_save", { p_token: tok(), p_id: u ? u.id : null, p_email: e.value, p_name: n.value, p_role: r.value, p_active: act.checked });
            closeModal(); H().accounts = null; H().me = null; hooks.render();
            if (x.tempPassword) msg("Temporary password for " + x.email, x.tempPassword + "\n\n" + (first ? "Log out, then log in with your email and this password. You'll choose your own password right away." : "Send it privately. It must be changed at the first login."));
            else toast("Saved");
          } catch (ex) { err.textContent = errText(ex); }
        } })));
  });
}
