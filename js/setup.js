/* Setup (Finance / owner): MB52, pcs factors, barcodes, rules, dashboard, PINs, team, passwords, stock takes, backup. */
import { S, hooks, isOwner } from "./state.js";
import { rpc } from "./api.js";
import { el, fmt, tsTxt, msg, confirmBox, openModal, closeModal, saveBlob, loadJs, errText, pill } from "./ui.js";
import { parseMB52, numv, parseBarcodeRows, mb52Names } from "./pure.js";
import { loadAdmin, branchesAdm, tolPct, currentTake } from "./master.js";

var V = new URL("../vendor/", import.meta.url).href;
async function xlsxLib() { if (typeof XLSX === "undefined") await loadJs(V + "xlsx.full.min.js"); return window.XLSX; }
function tok() { return S.admin.token; }
async function call(name, args, okMsg) {
  try { var r = await rpc(name, Object.assign({ p_token: tok() }, args)); await loadAdmin(); hooks.render(); if (okMsg) msg("Saved", typeof okMsg === "function" ? okMsg(r) : okMsg); return r; }
  catch (e) { msg("Save failed", errText(e)); throw e; }
}
function readSheet(file) {
  return new Promise(function (ok, no) {
    var rd = new FileReader();
    rd.onload = async function () {
      try { await xlsxLib(); var wb = XLSX.read(new Uint8Array(rd.result), { type: "array", raw: false }), ws = wb.Sheets[wb.SheetNames[0]]; ok(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" })); }
      catch (e) { no(e); }
    };
    rd.onerror = function () { no(new Error("Can't read file")); };
    rd.readAsArrayBuffer(file);
  });
}

/* MB52 upload card (used by the stock take wizard and when replacing the MB52 of an open stock take). */
export function mb52Card(title, onDone) {
  var A = S.adm, f = el("input", { type: "file", accept: ".xlsx,.xls,.csv" });
  var sysTxt = Object.keys(S.sysBy || {}).length ? Object.keys(S.sysBy).length + " branch(es) loaded" + (A.meta ? " · uploaded " + tsTxt(A.meta.loadedAt) : "") : "Nothing uploaded yet";
  var c = el("div", { class: "card" }, el("h3", { text: title }),
    el("p", { class: "small muted", text: "SAP MB52: Plant 1501-1515, tick Display Batch Stocks + No zero stock lines, Non-Hierarchical, Export → Spreadsheet. The branch comes from “Name 1” and its plant code becomes the counters' login. GOOD stock only: Blocked Stock, bad-stock locations (BS00/BS01/SH00) and Stock in Transit are left out." }), f,
    el("p", { class: "small", style: "margin-top:8px;font-weight:600", text: sysTxt }));
  f.addEventListener("change", async function () {
    var file = f.files[0]; if (!file) return;
    try {
      var rows = await readSheet(file);
      var known = {}, ign = ((S.adm.settings || {}).x_ignore_branches || []);
      (S.adm.branches || []).forEach(function (b) { if (b.active) known[b.name] = 1; }); ign.forEach(function (n) { known[n] = 1; });
      var names = mb52Names(rows, Object.keys(known)), fresh = names.filter(function (x) { return !x.known; });
      if (fresh.length) {
        var add = await askNewBranches(fresh);
        if (add === null) { f.value = ""; return; }
        if (add.length) await rpc("admin_add_branches", { p_token: tok(), p_branches: add });
        var skipNow = fresh.map(function (x) { return x.name; }).filter(function (n) { return add.indexOf(n) < 0; });
        if (skipNow.length) await rpc("admin_settings", { p_token: tok(), p_patch: { x_ignore_branches: ign.concat(skipNow) } });
        await loadAdmin();
      }
      var res = parseMB52(rows, branchesAdm()), plants = res.plants;
      var skip = Object.keys(res.skipped).map(function (k) { return k + " RM" + fmt(res.skipped[k], 2); }).join(", ");
      var ti = S.adm.takeInfo || {}, picked = ti.scope === "partial" ? (ti.skus || []) : null, inFile = {};
      Object.keys(res.byBr).forEach(function (b) { res.byBr[b].forEach(function (r) { inFile[r[0]] = 1; }); });
      var missingPicked = picked ? picked.filter(function (c0) { return !inFile[c0]; }) : [];
      confirmBox("Load MB52?", res.lines + " lines for " + Object.keys(res.byBr).length + " branch(es). Qty " + fmt(res.totQ, 0) + " PCS" + (res.hasValue ? ", RM " + fmt(res.totV, 2) : "") + "." +
        (skip ? "\nSKIPPED (branch not in list): " + skip : "") + (res.badBatches.length ? "\n" + res.badBatches.length + " batch value(s) not readable as dates: " + res.badBatches.slice(0, 8).join(", ") : "") +
        (res.transit ? "\nStock in transit left out: " + fmt(res.transit, 0) + " PCS" : "") + (res.format === "mb52" ? "\nGood stock only. Left out: blocked stock " + fmt(res.exBlkQ, 0) + " PCS (RM " + fmt(res.exBlkV, 2) + "), bad-stock locations BS/SH " + fmt(res.exBadQ, 0) + " PCS (RM " + fmt(res.exBadV, 2) + ")" : "") +
        (missingPicked.length ? "\n\n" + missingPicked.length + " picked SKU(s) are not in this MB52 at any branch: " + missingPicked.slice(0, 8).join(", ") : "") +
        (res.format === "report" ? "\n\nStock report format (SKU / Total in PCS). " + (res.hasValue ? "" : "It has no RM values, so variance shows in PCS only.") : "") +
        "\n\nReplaces system stock for these branches.", "Load", async function () {
          var skV = 0; Object.keys(res.skipped).forEach(function (k) { skV += res.skipped[k]; });
          pill("Loading MB52…");
          try {
            await rpc("admin_load_mb52", { p_token: tok(), p_payload: { meta: { goodV: res.totV, goodQ: res.totQ, blockedV: res.exBlkV, badLocV: res.exBadV, transitV: res.trV, skippedV: skV, skipped: Object.keys(res.skipped), lines: res.lines }, byBr: res.byBr, descs: res.descs, plants: plants } });
            await loadAdmin(); pill("Online", "ok");
            var noFac = (S.adm.skus || []).filter(function (s0) { return inFile[s0.code] && !s0.per; }).map(function (s0) { return s0.code; });
            msg("MB52 loaded", Object.keys(res.byBr).length + " branch(es), plant codes ready for counter login." + (noFac.length ? "\n\n" + noFac.length + " SKU(s) have no pcs per carton yet (" + noFac.slice(0, 6).join(", ") + (noFac.length > 6 ? "…" : "") + "). Add them in Settings → Pcs per Carton / Box, or counters can only count those in pieces." : ""));
            onDone && onDone();
          } catch (e) { pill("Error", "bad"); msg("Load failed", errText(e)); }
        });
    } catch (e) { msg("Can't read file", errText(e)); }
    f.value = "";
  });
  return c;
}

/* MB52 has branch names the app doesn't know yet: tick the ones to add. Resolves to [names] or null (cancel). */
function askNewBranches(list) {
  return new Promise(function (done) {
    openModal(function (sh) {
      var boxes = list.map(function (x) { var cb = el("input", { type: "checkbox", checked: /^NDD/i.test(x.name) }); cb._n = x.name; return cb; });
      sh.append(el("h3", { text: "New branches in this MB52" }),
        el("p", { class: "small muted", text: "These “Name 1” values are not in the app yet. Tick the ones that are NDD warehouses to count - their plant code becomes the counters' login. Unticked ones are skipped and won't be asked about again." }),
        el("div", { style: "max-height:50vh;overflow:auto;margin:8px 0" }, list.map(function (x, i) { return el("label", { class: "row", style: "gap:8px;padding:6px 0;border-bottom:1px solid var(--line)" }, boxes[i], el("span", { text: x.name }), el("span", { class: "small muted", text: "plant " + x.plant })); })),
        el("div", { class: "row", style: "margin-top:12px" },
          el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: function () { closeModal(); done(null); } }),
          el("button", { class: "btn primary", style: "flex:2", text: "Continue", onclick: function () { closeModal(); done(boxes.filter(function (b) { return b.checked; }).map(function (b) { return b._n; })); } })));
    });
  });
}

function card(title, sub) { var c = el("div", { class: "card" }, el("h3", { text: title }), sub ? el("p", { class: "small muted", text: sub }) : null); return c; }

export function renderSetup(app) {
  if (!S.adm) { app.append(el("p", { class: "center muted", text: "Loading…" })); loadAdmin().then(hooks.render); return; }
  var A = S.adm, st = A.settings || {}, tk = currentTake();
  app.append(el("div", { class: "banner warn", text: "Admin only. Settings that stay the same between stock takes. Counters never see system quantities." }));

  /* 2. factors */
  var fa = el("textarea", { placeholder: "Item Code\tPcs per CTN\tPcs per BOX\n650505\t240\t24" });
  var missing = (A.skus || []).filter(function (s) { return !s.per; }).length;
  app.append(el("div", { class: "card" }, el("h3", { text: "Pcs per Carton / Box" }),
    el("p", { class: "small muted", text: "Paste from Excel: Item Code | Pcs per CTN | Pcs per BOX. " + missing + " of " + (A.skus || []).length + " SKUs have no Pcs per CTN yet. Without it, cartons can't be converted to PCS for variance." }), fa,
    el("div", { class: "row", style: "justify-content:flex-end;margin-top:8px" }, el("button", { class: "btn primary", text: "Save factors", onclick: function () {
      var items = [], known = {}; (A.skus || []).forEach(function (s) { known[s.code] = 1; }); var unk = [];
      fa.value.split(/\r?\n/).forEach(function (line) {
        var p = line.split("\t").map(function (x) { return x.trim(); }); if (!p[0] || !/\d/.test((p[1] || "") + (p[2] || ""))) return;
        var a = numv(p[1]), b = numv(p[2]), it = { code: p[0] }; if (a > 0) it.per = a; if (b > 0) it.perBox = b; items.push(it); if (!known[p[0]]) unk.push(p[0]);
      });
      if (!items.length) { msg("Nothing to save", "Paste 3 columns from Excel first."); return; }
      call("admin_save_skus", { p_items: items }, items.length + " SKU(s) updated." + (unk.length ? " Added new: " + unk.slice(0, 10).join(", ") : "")).then(function () { fa.value = ""; });
    } }))));

  /* 3. barcodes */
  var bf = el("input", { type: "file", accept: ".xlsx,.xls,.csv" }), rep = el("input", { type: "checkbox" });
  var sugg = {}; (S.counts || []).forEach(function (d) { Object.keys(d.unknownBarcodes || {}).forEach(function (bc) { var c = d.unknownBarcodes[bc]; (sugg[bc] = sugg[bc] || {})[c] = (sugg[bc][c] || 0) + 1; }); });
  var sk = Object.keys(sugg);
  var bcCard = el("div", { class: "card" }, el("h3", { text: "Barcode master" }),
    el("p", { class: "small muted", text: A.barcodeCount + " barcode(s) loaded. Upload Excel/CSV with columns: Barcode | Item Code | UoM (PCS, BOX or CTN). Format the Barcode column as Text in Excel so long numbers aren't cut. One SKU can have several barcodes (e.g. piece and carton)." }),
    bf, el("label", { class: "row small", style: "gap:6px;margin-top:8px" }, rep, "Replace the whole list (otherwise add / update)"));
  bf.addEventListener("change", async function () {
    var file = bf.files[0]; if (!file) return;
    try {
      var rows = await readSheet(file), p = parseBarcodeRows(rows);
      var skuSet = {}; (A.skus || []).forEach(function (s) { skuSet[s.code] = 1; });
      var unknownSku = p.rows.filter(function (r) { return !skuSet[r.code]; });
      confirmBox("Load barcodes?", p.rows.length + " barcode(s) ready." + (p.bad.length ? "\n" + p.bad.length + " row(s) skipped: " + p.bad.slice(0, 6).join("; ") : "") + (unknownSku.length ? "\n" + unknownSku.length + " barcode(s) point to an Item Code not in the SKU list (e.g. " + unknownSku.slice(0, 3).map(function (r) { return r.code; }).join(", ") + ") - they load anyway." : "") + (rep.checked ? "\n\nREPLACES the current " + A.barcodeCount + " barcode(s)." : ""), "Load", function () {
        call("admin_save_barcodes", { p_rows: p.rows, p_replace: rep.checked }, function (n) { return n + " barcode(s) saved."; });
      });
    } catch (e) { msg("Can't read file", errText(e)); }
    bf.value = "";
  });
  if (sk.length) {
    var tb = el("table", {}, el("tr", {}, el("th", { text: "Barcode" }), el("th", { text: "Counters picked" })));
    sk.forEach(function (bc) { tb.append(el("tr", {}, el("td", { text: bc }), el("td", { text: Object.keys(sugg[bc]).map(function (c) { return c + (sugg[bc][c] > 1 ? " ×" + sugg[bc][c] : ""); }).join(", ") }))); });
    bcCard.append(el("p", { class: "small", style: "margin-top:12px;font-weight:600", text: "Barcodes counters linked during the count (" + sk.length + ")" }), el("div", { class: "tw keep", style: "max-height:240px" }, tb),
      el("div", { class: "row", style: "justify-content:flex-end;margin-top:8px" }, el("button", { class: "btn", text: "Add these to the master", onclick: function () {
        var rows = sk.filter(function (bc) { return Object.keys(sugg[bc]).length === 1; }).map(function (bc) { return { barcode: bc, code: Object.keys(sugg[bc])[0], uom: "PCS" }; });
        var amb = sk.length - rows.length;
        confirmBox("Add to barcode master?", rows.length + " barcode(s) as PCS." + (amb ? "\n" + amb + " skipped: counters picked different SKUs for the same barcode." : ""), "Add", function () { call("admin_save_barcodes", { p_rows: rows, p_replace: false }, function (n) { return n + " barcode(s) added."; }); });
      } })));
  }
  app.append(bcCard);

  /* tolerance */
  var ti = el("input", { type: "text", inputmode: "decimal", value: String(tolPct()), style: "max-width:100px" });
  app.append(el("div", { class: "card" }, el("h3", { text: "Accepted variance per SKU" }),
    el("p", { class: "small muted", text: "All batches of a SKU in a branch are added; if |physical − system| ≤ this % of system, the SKU is accepted (WITHIN). Otherwise OVER." }),
    el("div", { class: "row" }, ti, el("span", { text: "%" }), el("button", { class: "btn primary", text: "Save", onclick: function () {
      var v = Number(ti.value); if (isNaN(v) || v < 0 || v > 100) { msg("Enter 0-100"); return; }
      call("admin_settings", { p_patch: { tolerance: v } }, "Tolerance ±" + v + "% per SKU.");
    } }))));

  /* photos */
  var pmin = el("input", { type: "number", min: "0", max: "20", value: String(st.photo_min != null ? st.photo_min : 3), style: "max-width:80px" });
  var pmax = el("input", { type: "number", min: "1", max: "20", value: String(st.photo_max != null ? st.photo_max : 5), style: "max-width:80px" });
  var roles = st.photo_roles || ["ops", "fin"], rOps = el("input", { type: "checkbox", checked: roles.indexOf("ops") >= 0 }), rFin = el("input", { type: "checkbox", checked: roles.indexOf("fin") >= 0 });
  app.append(el("div", { class: "card" }, el("h3", { text: "Warehouse photos at submit" }),
    el("p", { class: "small muted", text: "Counters must add at least the minimum before they can submit. Maximum is the most they can add." }),
    el("div", { class: "row" }, el("span", { text: "Min" }), pmin, el("span", { text: "Max" }), pmax),
    el("div", { class: "row", style: "margin-top:8px" }, el("label", { class: "row small", style: "gap:6px" }, rOps, "Required for Ops"), el("label", { class: "row small", style: "gap:6px" }, rFin, "Required for Finance")),
    el("div", { class: "row", style: "justify-content:flex-end;margin-top:8px" }, el("button", { class: "btn primary", text: "Save", onclick: function () {
      var a = parseInt(pmin.value, 10), b = parseInt(pmax.value, 10);
      if (isNaN(a) || isNaN(b) || a < 0 || b < 1 || a > b || b > 20) { msg("Check the numbers", "Min 0-20, Max 1-20, Min not above Max."); return; }
      var rr = []; if (rOps.checked) rr.push("ops"); if (rFin.checked) rr.push("fin");
      call("admin_settings", { p_patch: { photo_min: a, photo_max: b, photo_roles: rr } }, "Photo rule saved. Phones pick it up when they reload.");
    } }))));

  /* dashboard */
  var dashUrl = new URL("dashboard/", location.href.replace(/[#?].*$/, "").replace(/[^/]*$/, "")).href;
  var lv = el("select", { style: "max-width:360px" }, [["progress", "Progress only"], ["qty", "Progress + variance in PCS (after closing)"], ["value", "Progress + variance in PCS and RM (after closing)"]].map(function (o) { return el("option", { value: o[0], text: o[1], selected: (st.dash_level || "progress") === o[0] }); }));
  app.append(el("div", { class: "card" }, el("h3", { text: "Public dashboard" }),
    el("p", { class: "small muted", text: "Anyone with the link can see it, no login. Variance only appears after you close the stock take. Change the level any time - the dashboard follows within 30 seconds." }),
    el("div", { class: "row" }, lv, el("button", { class: "btn primary", text: "Save", onclick: function () { call("admin_settings", { p_patch: { dash_level: lv.value } }, "Dashboard level saved."); } })),
    el("p", { class: "small", style: "margin-top:8px" }, "Link: ", el("a", { href: dashUrl, target: "_blank", rel: "noopener", text: dashUrl }))));

  /* branches + plant codes (read-only: they come from the MB52) */
  var pt = el("table", {}, el("tr", {}, el("th", { text: "Warehouse" }), el("th", { text: "Plant code (counter login)" })));
  (A.branches || []).filter(function (b) { return b.active; }).forEach(function (b) { pt.append(el("tr", {}, el("td", { text: b.name }), el("td", { text: (b.plants || []).join(", ") || "set by the next MB52 upload" }))); });
  app.append(el("div", { class: "card" }, el("h3", { text: "Warehouses and plant codes" }),
    el("p", { class: "small muted", text: "Counters log in with their warehouse's SAP plant code. Codes come from the MB52 upload (Plant + Name 1)." }),
    el("div", { class: "tw keep" }, pt)));

  renderTeam(app);

  /* owner only */
  if (!isOwner()) { app.append(el("p", { class: "small muted center", text: "Passwords and backup are managed by the owner." })); return; }
  var title = el("input", { type: "text", value: st.title || "NDD Stock Count", style: "max-width:320px" });
  app.append(el("div", { class: "card" }, el("h3", { text: "App name" }), el("div", { class: "row" }, title, el("button", { class: "btn primary", text: "Save", onclick: function () { var v = title.value.trim(); if (!v) return; call("admin_settings", { p_patch: { title: v } }, "Name saved."); } }))));

  var fp = el("input", { type: "text", placeholder: A.financeReady ? "•••••• (set - type a new one to change)" : "not set", style: "max-width:260px", autocomplete: "off" });
  app.append(el("div", { class: "card" }, el("h3", { text: "Admin password" }),
    el("p", { class: "small muted", text: "For other admins (for example Finance HQ): they tap 🔒 Admin and enter this. They can run stock takes but can't change passwords or download backups. Changing it logs out everyone who used the old one. Stored only as a hash - note it before saving. Blank + Save = turn off this login." }),
    el("div", { class: "row" }, fp, el("button", { class: "btn", text: "Generate", onclick: function () { var c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", o = ""; for (var i = 0; i < 10; i++) o += c[Math.floor(Math.random() * c.length)]; fp.value = o; } }),
      el("button", { class: "btn primary", text: "Save", onclick: function () {
        var v = fp.value.trim(); if (v && v.length < 6) { msg("Use at least 6 characters"); return; }
        call("owner_set_password", { p_which: "finance", p_password: v }, v ? "Send this password only to the admins who need it: " + v : "Admin password login turned off.");
      } }))));

  var op1 = el("input", { type: "password", placeholder: "New owner password (8+)", autocomplete: "new-password", style: "max-width:240px" }), op2 = el("input", { type: "password", placeholder: "Repeat", autocomplete: "new-password", style: "max-width:240px" });
  app.append(el("div", { class: "card" }, el("h3", { text: "Owner password" }), el("div", { class: "row" }, op1, op2, el("button", { class: "btn primary", text: "Change", onclick: function () {
    if (op1.value.length < 8) { msg("Use at least 8 characters"); return; } if (op1.value !== op2.value) { msg("Passwords don't match"); return; }
    call("owner_set_password", { p_which: "owner", p_password: op1.value }, "Owner password changed. Other owner logins were signed out.");
  } }))));

  app.append(el("div", { class: "card" }, el("h3", { text: "Backup" }),
    el("p", { class: "small muted", text: "The free Supabase plan has no automatic backups. Download one after every stock take and keep it safe (it contains all counts). Photos are not in the file." }),
    el("button", { class: "btn primary", text: "Download backup (.json)", onclick: async function () {
      try { var r = await rpc("owner_backup", { p_token: tok() }); saveBlob(new Blob([JSON.stringify(r)], { type: "application/json" }), "ndd-stock-count-backup-" + new Date().toISOString().slice(0, 10) + ".json"); }
      catch (e) { msg("Backup failed", errText(e)); }
    } })));
}

function renderTeam(app) {
  var A = S.adm;
  var rows = (A.team || []).map(function (t) { return { name: t.name, branch: t.branch, role: t.role === "Counter" ? "Counter" : "Checker" }; });
  var box = el("div");
  function brList() { return branchesAdm(); }
  function saveTeam(done) {
    var b = brList(); var tm = rows.filter(function (r) { return r.name; }).map(function (x) { return { name: x.name, branch: x.branch, role: x.role }; });
    return rpc("admin_save_team", { p_token: S.admin.token, p_branches: b, p_team: tm }).then(function () { return loadAdmin(); }).then(function () { done && done(); }).catch(function (e) { msg("Save failed", errText(e)); });
  }
  function edit(r, isNew) {
    var bl = brList();
    openModal(function (sh) {
      var nm = el("input", { type: "text", value: r.name, placeholder: "Full name" }), role = r.role;
      var seg = el("div", { class: "row", style: "gap:6px;margin:10px 0" }); function ds() { seg.innerHTML = ""; [["Counter", "Ops"], ["Checker", "Finance"]].forEach(function (o) { seg.append(el("button", { class: "chip" + (role === o[0] ? " on" : ""), text: o[1], onclick: function () { role = o[0]; ds(); } })); }); } ds();
      var bs = el("select", {}, bl.map(function (x) { return el("option", { value: x, text: x, selected: r.branch === x }); }));
      sh.append(el("h3", { text: isNew ? "Add person" : "Edit person" }), nm, seg, bs,
        el("div", { class: "row", style: "margin-top:12px" },
          isNew ? null : el("button", { class: "btn", style: "color:var(--bad)", text: "Remove", onclick: function () { rows.splice(rows.indexOf(r), 1); closeModal(); saveTeam(draw); } }),
          el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }),
          el("button", { class: "btn primary", style: "flex:1", text: "Save", onclick: function () {
            var n = nm.value.replace(/\s+/g, " ").trim(); if (!n) { nm.focus(); return; }
            if (rows.some(function (x) { return x !== r && x.branch === bs.value && x.name.toLowerCase() === n.toLowerCase(); })) { msg("Already listed", n + " is already in " + bs.value + "."); return; }
            r.name = n; r.role = role; r.branch = bs.value; if (isNew) rows.push(r); closeModal(); saveTeam(draw);
          } })));
      setTimeout(function () { if (isNew) nm.focus(); }, 100);
    });
  }
  function draw() {
    box.innerHTML = ""; var bl = brList();
    bl.forEach(function (b) {
      var mem = rows.filter(function (r) { return r.branch === b; }).sort(function (a, c) { return a.role === c.role ? 0 : a.role === "Checker" ? 1 : -1; });
      var line = el("div", { style: "display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)" }, el("b", { style: "font-size:13px;min-width:96px", text: b.replace(/^NDD /, "") }));
      mem.forEach(function (r) {
        line.append(el("button", { class: "chip", style: "padding:4px 10px;font-weight:500;" + (r.role === "Checker" ? "border-color:var(--bad)" : ""), onclick: function () { edit(r); } },
          r.name.split(" ").slice(0, 2).join(" "), el("span", { style: "font-size:10px;margin-left:4px;color:" + (r.role === "Checker" ? "var(--bad)" : "var(--mute)"), text: r.role === "Checker" ? "FIN" : "OPS" })));
      });
      if (!mem.some(function (r) { return r.role === "Checker"; })) line.append(el("span", { class: "small", style: "color:var(--bad)", text: "no Finance" }));
      line.append(el("button", { class: "chip", style: "padding:4px 10px", text: "+", onclick: function () { edit({ name: "", branch: b, role: "Counter" }, true); } }));
      box.append(line);
    });
    if (!bl.length) box.append(el("p", { class: "small muted", text: "No branches yet - upload the MB52 above and they are created from SAP “Name 1”." }));
    var lost = rows.filter(function (r) { return bl.indexOf(r.branch) < 0; });
    if (lost.length) box.append(el("p", { class: "small", style: "color:var(--bad)", text: "Not in a branch: " + lost.map(function (r) { return r.name; }).join(", ") + " - remove or move them." }));
  }
  var paste = el("textarea", { placeholder: "Paste 3 columns from Excel: Name | Branch | Role (Counter / Checker)", style: "min-height:70px" });
  var pasteBox = el("div", { class: "hidden", style: "margin-top:6px" }, paste, el("div", { class: "row", style: "justify-content:flex-end;margin-top:6px" }, el("button", { class: "btn", text: "Replace team with pasted list", onclick: function () {
    var tm = paste.value.split(/\r?\n/).map(function (x) { var q = x.split("\t"); var ro = (q[2] || "").trim().toLowerCase(); return { name: (q[0] || "").trim(), branch: (q[1] || "").trim(), role: /count|ops|oper/.test(ro) ? "Counter" : "Checker" }; }).filter(function (x) { return x.name; });
    if (!tm.length) { msg("Nothing to paste", "Copy the 3 columns from Excel first."); return; }
    var bl = brList(), bad = tm.filter(function (x) { return bl.indexOf(x.branch) < 0; }); if (bad.length) { msg("Branch not in list", bad.map(function (x) { return x.name + " → " + x.branch; }).join(", ")); return; }
    rows = tm; paste.value = ""; pasteBox.classList.add("hidden"); saveTeam(function () { draw(); msg("Saved", tm.length + " people."); });
  } })));
  draw();
  app.append(el("div", { class: "card" }, el("h3", { text: "Team (optional)" }),
    el("p", { class: "small muted", text: "Not required: counters can type their name and the phone remembers it. Add names here only if you want them to just tap. Branches come from the MB52 upload." }), box,
    el("div", { class: "row", style: "gap:14px;margin-top:8px" }, el("button", { class: "link", text: "Paste from Excel", onclick: function () { pasteBox.classList.toggle("hidden"); } })), pasteBox));
}
