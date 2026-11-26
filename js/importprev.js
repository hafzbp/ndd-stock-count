/* Import the result Excel of the previous (artifact) stock-count app as a closed monthly stock take.
   Reads sheets Counts (who keyed what), Variance (system stock + unit cost per batch) and Summary (MB52 tie-out),
   shows what will be imported, then calls admin_import_take. Same rules as tools/import_prev_result.py. */
import { S, hooks } from "./state.js";
import { rpc } from "./api.js";
import { el, fmt, msg, openModal, closeModal, errText, toast } from "./ui.js";
import { xlsxLib } from "./export.js";
import { loadAdmin } from "./master.js";

var MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function p2(n) { return String(n).padStart(2, "0"); }
/* "25 Nov, 10:01 am" (Malaysia time, no year) → ISO */
function ts(s, year) {
  var m = /(\d+) (\w{3}), (\d+):(\d+) ([ap]m)/.exec(s || ""); if (!m || !MON[m[2]]) return null;
  var h = (+m[3] % 12) + (m[5] === "pm" ? 12 : 0);
  return year + "-" + p2(MON[m[2]]) + "-" + p2(+m[1]) + "T" + p2(h) + ":" + m[4] + ":00+08:00";
}
function batch(b) { b = b == null ? "" : String(b).trim(); var m = /^(\d{2})\/(\d{4})$/.exec(b); return m ? m[2] + "-" + m[1] : b; }
function num(x) { return x === null || x === undefined || x === "" ? null : Number(x); }

export function parsePrev(wb, fileName) {
  var X = window.XLSX, need = ["Counts", "Variance", "Summary"];
  need.forEach(function (n) { if (!wb.Sheets[n]) throw new Error("This isn't a result Excel from the previous app: sheet \"" + n + "\" is missing."); });
  var rows = function (n) { return X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }); };
  var C = rows("Counts"), V = rows("Variance"), SU = rows("Summary");
  if (String(C[0][2]) !== "Name(s)" || String(V[0][16]) !== "System (PCS)" || String(V[0][18]) !== "Unit Cost (RM)") throw new Error("The columns of Counts / Variance are not the ones this import knows.");
  C = C.slice(1).filter(function (r) { return r[0] && r[0] !== "TOTAL"; });
  V = V.slice(1).filter(function (r) { return r[0] && r[0] !== "TOTAL"; });
  var now = new Date(), year = now.getFullYear(), tie = {}, loaded = null;
  SU.forEach(function (r) {
    var a = String(r[0] || "");
    if (/^MB52 TIE-OUT/.test(a)) loaded = a.split("upload of ").pop();
    else if (/^(Good|Bad) stock used as System/.test(a)) tie.goodV = r[1];
    else if (/^Excluded: Blocked/.test(a)) tie.blockedV = r[1];
    else if (/^Excluded: bad-stock/.test(a)) tie.badLocV = r[1];
    else if (/^Excluded: Stock in Transit/.test(a)) tie.transitV = r[1];
    else if (/^Excluded: plants not in branch list/.test(a)) tie.skippedV = r[1];
  });
  var t0 = ts(loaded, year) || ts(C[0] && C[0][14], year);
  if (t0 && new Date(t0) > new Date(now.getTime() + 86400000)) { year--; t0 = ts(loaded, year) || ts(C[0][14], year); }
  var skus = {}, sys = [], sess = {}, times = [];
  V.forEach(function (r) {
    var code = String(r[1]);
    if (!skus[code]) skus[code] = { code: code, desc: r[2] || "", per: num(r[10]), box: num(r[11]) };
    if (r[16] !== null) sys.push({ b: r[0], c: code, bt: batch(r[3]), q: Number(r[16]), u: num(r[18]) });
    else if (r[18] !== null) sys.push({ b: r[0], c: code, bt: batch(r[3]), q: 0, u: num(r[18]) });   /* counted, SAP none: keep the file's cost */
  });
  C.forEach(function (r) {
    var k = r[0] + "|" + (r[2] || ""), s = sess[k] || (sess[k] = { branch: r[0], member: r[2] || "", lines: {}, t: [] });
    var t = ts(r[14], year); if (t) { s.t.push(t); times.push(t); }
    var code = String(r[3]), b = batch(r[5]);
    s.lines[code + "|" + b] = { code: code, batch: b, ctn: num(r[6]), box: num(r[7]), pcs: num(r[8]), per: num(r[9]), perBox: num(r[10]), total: num(r[11]), remark: r[12] || "", t: t };
    if (!skus[code]) skus[code] = { code: code, desc: r[4] || "", per: num(r[9]), box: num(r[10]) };
  });
  times.sort();
  var src = String(fileName || "").replace(/^[0-9a-f]{8}-/, "");
  var sessions = Object.keys(sess).sort().map(function (k, i) {
    var s = sess[k], tt = s.t.slice().sort();
    return { branch: s.branch, member: s.member, device: "import-" + (Date.now() % 1e8) + "-" + i, lines: s.lines, start: tt[0] || t0, end: tt[tt.length - 1] || t0 };
  });
  var d0 = new Date(t0 || times[0] || now);
  return {
    name: "Month-end stock take " + d0.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "Asia/Kuala_Lumpur" }) + " (previous app)",
    opened: t0 || times[0], closed: times[times.length - 1] || t0, loaded: t0 || times[0], source: src,
    meta: Object.assign(tie, { imported: true, source: src, skipped: [], stockType: "good" }),
    skus: Object.keys(skus).map(function (k) { return skus[k]; }), sys: sys, sessions: sessions
  };
}

/* per warehouse: counts, lines, system value - shown before importing */
function summary(P) {
  var by = {}, known = {}; (S.adm.branches || []).forEach(function (b) { known[b.name] = 1; });
  P.sys.forEach(function (r) { var a = by[r.b] || (by[r.b] = { n: 0, l: 0, v: 0 }); a.v += r.q * (r.u || 0); });
  P.sessions.forEach(function (s) { var a = by[s.branch] || (by[s.branch] = { n: 0, l: 0, v: 0 }); a.n++; a.l += Object.keys(s.lines).length; });
  return Object.keys(by).sort().map(function (b) { return { b: b, known: !!known[b], n: by[b].n, l: by[b].l, v: by[b].v }; });
}

export function importPrevDialog() {
  var inp = el("input", { type: "file", accept: ".xlsx,.xls", "aria-label": "Result Excel" });
  openModal(function (sh) {
    sh.append(el("h3", { text: "Import a result from the previous app" }),
      el("p", { class: "small muted", text: "The Excel the previous stock-count app exported (sheets Counts, Variance, Summary). It becomes a closed monthly stock take here, with the same counts and system stock, so it shows on the dashboard. Photos and signatures stay in the previous app." }),
      inp, el("button", { class: "btn block", style: "margin-top:12px", text: "Cancel", onclick: closeModal }));
  });
  inp.onchange = async function () {
    var f = inp.files[0]; if (!f) return;
    try {
      await xlsxLib();
      var wb = window.XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: "array" }), P = parsePrev(wb, f.name), rows = summary(P);
      closeModal(); confirmImport(P, rows);
    } catch (e) { closeModal(); msg("Can't read this file", errText(e)); }
  };
}

function confirmImport(P, rows) {
  var name = el("input", { value: P.name, "aria-label": "Stock take name" }), lines = 0, val = 0;
  rows.forEach(function (r) { if (r.known) { lines += r.l; val += r.v; } });
  openModal(function (sh) {
    sh.append(el("h3", { text: "Import this stock take?" }),
      el("label", { class: "small muted", text: "Name" }), name,
      el("p", { class: "small", style: "margin:10px 0 4px", text: "Counted " + new Date(P.opened).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " · " + fmt(lines) + " count lines · system stock RM " + fmt(Math.round(val)) }),
      el("div", { class: "md-rows", style: "max-height:300px;overflow:auto" }, rows.map(function (r) {
        return el("div", {}, el("div", { class: "g" }, el("b", { text: r.b }), el("small", { text: r.known ? (r.n ? r.n + " count(s) · " + r.l + " lines" : "no count in the file") : "not a warehouse in this app - skipped" })),
          el("div", { class: "nums" }, el("span", { text: "RM " + fmt(Math.round(r.v)) })));
      })),
      el("p", { class: "small muted", text: "It is saved as Closed, single count, not linked to KPI002. Nothing else changes." }),
      el("div", { class: "row", style: "gap:8px;margin-top:10px" },
        el("button", { class: "btn", text: "Cancel", onclick: closeModal }),
        el("button", { class: "btn primary", text: "Import", onclick: async function (e) {
          e.target.disabled = true; P.name = name.value.trim() || P.name;
          try {
            var r = await rpc("admin_import_take", { p_token: S.admin.token, p_payload: P });
            closeModal(); S.viewTake = r.take; await loadAdmin(); S.tab = "dash"; S.dashView = "monthly"; S.mdWh = null; hooks.render(); window.scrollTo(0, 0);
            toast("Imported" + (r.skipped && r.skipped.length ? " · skipped " + r.skipped.join(", ") : ""));
          } catch (err) { e.target.disabled = false; msg("Import failed", errText(err)); }
        } })));
  });
}
