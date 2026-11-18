/* Pure logic, no DOM. Ported 1:1 from the original NDD Stock Count app and unit-tested in tests/. */

export function normBatch(v) {
  if (v == null) return "";
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0");
  var s = String(v).trim(); if (!s) return "";
  if (typeof v === "number") { if (s.length === 7 || s.length === 5) s = "0" + s; }
  s = s.replace(/\.$/, "");
  function ok(y, m, d) { y = +y; m = +m; d = +d; if (y < 2020 || y > 2035 || m < 1 || m > 12 || d < 1 || d > 31) return ""; var dt = new Date(y, m - 1, d); if (dt.getMonth() !== m - 1) return ""; return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0"); }
  var m, r;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)) && (r = ok(m[1], m[2], m[3]))) return r;
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/)) && (r = ok(m[3], m[2], m[1]))) return r;
  if (/^\d{8}$/.test(s)) { if (s.slice(0, 2) === "20" && (r = ok(s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)))) return r; if ((r = ok(s.slice(4, 8), s.slice(2, 4), s.slice(0, 2)))) return r; }
  if (/^\d{6}$/.test(s) && (r = ok("20" + s.slice(4, 6), s.slice(2, 4), s.slice(0, 2)))) return r;
  return s;
}
export function isDateB(b) { return /^\d{4}-\d{2}-\d{2}$/.test(b); }
/* batches are counted by month: YYYY-MM-DD -> YYYY-MM */
export function monthOf(b) { b = b == null ? "" : String(b); return isDateB(b) ? b.slice(0, 7) : b; }
export function isMonthB(b) { return /^\d{4}-\d{2}$/.test(b); }
export function numv(v) { if (typeof v === "number") return v; var s = String(v == null ? "" : v).replace(/,/g, "").trim(); if (!s) return 0; if (/-$/.test(s)) s = "-" + s.slice(0, -1); var n = Number(s); return isNaN(n) ? 0 : n; }

/* Column names accepted for each field (case and spaces don't matter). Two layouts work:
   SAP MB52 (Material, Name 1, Unrestricted, values...) and the stock report (SKU, PLANT DISCRIPTION, Total in PCS). */
var COLS = {
  plant: ["Plant"], name: ["Name 1", "Plant Discription", "Plant Description", "Plant Name"],
  material: ["Material", "SKU", "Material Number", "Item Code"], desc: ["Material Description", "Description"],
  sloc: ["Storage Location", "Storage Loc.", "SLoc"], slocDesc: ["Descr. of Storage Loc."], batch: ["Batch"],
  unr: ["Unrestricted"], rst: ["Restricted-Use Stock"], qi: ["Quality Inspection"], pcs: ["Total in PCS", "Total PCS", "Qty in PCS", "Quantity"],
  vUnr: ["Value Unrestricted"], vRst: ["Value Restricted"], vQi: ["Value in QualInsp."], blk: ["Blocked Stock"], vBlk: ["Value BlockedStock"],
  transit: ["Stock in Transit"], vTransit: ["Value in Transit"]
};
function normH(x) { return String(x == null ? "" : x).trim().toLowerCase().replace(/\s+/g, " "); }
function findHeader(rows) {
  for (var i = 0; i < Math.min(rows.length, 30); i++) {
    var h = rows[i].map(normH);
    if (h.indexOf("plant") >= 0 && COLS.material.some(function (m) { return h.indexOf(normH(m)) >= 0; })) {
      var col = {}; Object.keys(COLS).forEach(function (k) { col[k] = -1; COLS[k].some(function (n) { var j = h.indexOf(normH(n)); if (j >= 0) { col[k] = j; return true; } return false; }); });
      return { row: i, col: col };
    }
  }
  return null;
}
function canon(branches) { var m = {}; branches.forEach(function (b) { m[normH(b)] = b; }); return m; }

/** rows: array of arrays incl. header. branches: valid branch names (matched ignoring case/spaces).
    plantMap (optional): { plantCode: branchName } - a known plant code wins over the name in the file. */
export function parseMB52(rows, branches, plantMap) {
  var hd = findHeader(rows);
  if (!hd) throw new Error('No header row with "Plant" and "Material" (or "SKU").');
  var c = hd.col, hr = hd.row, mb52 = c.unr >= 0;
  if (c.batch < 0) throw new Error('Missing column "Batch".');
  if (!mb52 && c.pcs < 0) throw new Error('Missing a quantity column: "Unrestricted" (SAP MB52) or "Total in PCS" (stock report).');
  function v(row, k) { return c[k] >= 0 ? row[c[k]] : ""; }
  /* byBr = GOOD stock; byBrBad = bad-stock locations (BS*, SH*, "Bad"/"Dmg"). The Blocked Stock column is left out of both. */
  var exQ = 0, exV = 0, exB = 0, exBV = 0, trV = 0;
  function badLoc(sl, ds) { return /^(BS|SH)/i.test(sl) || /bad|dmg|damage|shtg/i.test(ds); }
  var brMap = canon(branches);
  var agg = {}, aggB = {}, descs = {}, skipped = {}, bad = {}, transit = 0, n = 0, plants = {};
  for (var r = hr + 1; r < rows.length; r++) {
    var row = rows[r];
    var plant = String(v(row, "plant") || "").trim().replace(/\.0$/, ""), mat = String(v(row, "material") || "").trim().replace(/\.0$/, ""); if (!plant || !mat) continue;
    var raw = String(v(row, "name") || "").trim(), byPlant = plantMap && plantMap[plant], name = byPlant || brMap[normH(raw)] || raw;
    if (v(row, "desc")) descs[mat] = String(v(row, "desc")).trim();
    transit += numv(v(row, "transit")); trV += numv(v(row, "vTransit"));
    var q = mb52 ? numv(v(row, "unr")) + numv(v(row, "rst")) + numv(v(row, "qi")) : numv(v(row, "pcs"));
    var val = numv(v(row, "vUnr")) + numv(v(row, "vRst")) + numv(v(row, "vQi"));
    exB += numv(v(row, "blk")); exBV += numv(v(row, "vBlk"));
    var slc = String(v(row, "sloc") || "").trim(), sld = String(v(row, "slocDesc") || ""), isBad = badLoc(slc, sld);
    if (isBad) { exQ += q; exV += val; }
    if (!q) continue;
    if (!byPlant && !brMap[normH(raw)]) { if (!isBad) { var k0 = plant + (raw ? " " + raw : ""); skipped[k0] = (skipped[k0] || 0) + val; } continue; }
    (plants[name] = plants[name] || {})[plant] = 1;
    var b = monthOf(normBatch(v(row, "batch"))); if (b && !isMonthB(b)) bad[b] = 1;
    var G = isBad ? aggB : agg, key = name + "|" + mat + "|" + b, A = G[key] || (G[key] = { br: name, code: mat, b: b, q: 0, v: 0, sl: {} });
    A.q += q; A.v += val; if (!isBad) n++; if (slc) A.sl[slc] = 1;
  }
  function group(G) {
    var out = {}; Object.keys(G).forEach(function (k) { var A = G[k]; (out[A.br] = out[A.br] || []).push([A.code, A.b, Math.round(A.q * 1000) / 1000, A.q ? Math.round(A.v / A.q * 1e6) / 1e6 : 0, Object.keys(A.sl).sort().join(",")]); });
    Object.keys(out).forEach(function (b) { out[b].sort(function (x, y) { return (x[0] + x[1]).localeCompare(y[0] + y[1]); }); });
    return out;
  }
  var byBr = group(agg), byBrBad = group(aggB);
  var totQ = 0, totV = 0; Object.keys(agg).forEach(function (k) { totQ += agg[k].q; totV += agg[k].v; });
  var badQ = 0, badV = 0; Object.keys(aggB).forEach(function (k) { badQ += aggB[k].q; badV += aggB[k].v; });
  var pl = {}; Object.keys(plants).forEach(function (b) { pl[b] = Object.keys(plants[b]).sort(); });
  return { format: mb52 ? "mb52" : "report", hasValue: c.vUnr >= 0, trV: trV, exBadQ: exQ, exBadV: exV, exBlkQ: exB, exBlkV: exBV, byBr: byBr, descs: descs, skipped: skipped, plants: pl,
    badBatches: Object.keys(bad), transit: transit, rowsUsed: n, lines: Object.keys(agg).length, totQ: totQ, totV: totV,
    byBrBad: byBrBad, badLines: Object.keys(aggB).length, badQ: badQ, badV: badV };
}

/** Distinct branch names (Name 1 / PLANT DISCRIPTION) in the file with their plant, matched to known branches ignoring case. */
export function mb52Names(rows, branches, plantMap) {
  var hd = findHeader(rows); if (!hd) return [];
  var m = canon(branches || []), out = {};
  for (var r = hd.row + 1; r < rows.length; r++) {
    var raw = hd.col.name >= 0 ? String(rows[r][hd.col.name] || "").trim() : "", p = String(rows[r][hd.col.plant] || "").trim().replace(/\.0$/, "");
    var bp = plantMap && plantMap[p]; if (!raw && !bp) continue; var n = bp || m[normH(raw)] || raw;
    if (!out[n]) out[n] = { name: n, plant: p, known: !!(bp || m[normH(raw)]) };
  }
  return Object.keys(out).sort().map(function (k) { return out[k]; });
}

/** PCS from carton/box/pieces. returns {qty, ok} - qty null if nothing entered; ok false if a factor is missing */
export function toPcs(l, sku) {
  if (!l || (l.ctn == null && l.box == null && l.pcs == null)) return { qty: null, ok: true };
  var q = l.pcs || 0, ok = true;
  if (l.ctn) { if (sku && sku.per) q += l.ctn * sku.per; else ok = false; }
  if (l.box) { if (sku && sku.perBox) q += l.box * sku.perBox; else ok = false; }
  return { qty: ok ? q : null, ok: ok };
}
export function hasQty(l) { return !!l && (l.ctn != null || l.box != null || l.pcs != null); }
export function lk(code, b) { return code + "|" + (b || ""); }
export function sessRole(x) { return x && x.role === "fin" ? "fin" : "ops"; }

/* calculator: digits, . + − × ÷ with normal precedence; no eval */
export function calc(expr) {
  var t = expr.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  if (!t) return null; if (/[+\-*/.]$/.test(t)) t = t.slice(0, -1);
  var toks = t.match(/\d+(\.\d+)?|\.\d+|[+\-*/]/g); if (!toks || toks.join("") !== t) return NaN;
  var terms = [], cur = null, op = "+", mul = null;
  function flush() { if (cur == null) return; terms.push(op === "-" ? -cur : cur); }
  for (var i = 0; i < toks.length; i++) {
    var k = toks[i];
    if (/[+-]/.test(k)) { flush(); op = k; cur = null; mul = null; }
    else if (/[*/]/.test(k)) { mul = k; }
    else { var n = Number(k); if (cur == null || mul == null) cur = n; else { cur = mul === "*" ? cur * n : (n === 0 ? NaN : cur / n); mul = null; } }
  }
  flush(); var s = terms.reduce(function (a, b) { return a + b; }, 0); return Math.round(s * 1000) / 1000;
}

/**
 * Ops vs Finance vs SAP for one branch.
 * sysRows: [[code,batch,qty,cost,sloc]], docs: sessions of that branch ({role,lines,names,member,extraSkus}),
 * sm: {code: sku}, tolPct: number (e.g. 2)
 */
/* single = single-count mode: one team's count is the agreed count (if both teams counted a line, they must still match) */
export function variance(sysRows, docs, sm, tolPct, single) {
  var out = {};
  function blank(code, b) { return { code: code, batch: b, sys: null, cost: null, q: { ops: { ctn: null, box: null, pcs: null, has: false }, fin: { ctn: null, box: null, pcs: null, has: false } }, rmk: [], who: { ops: {}, fin: {} } }; }
  (sysRows || []).forEach(function (r) { var mb = monthOf(r[1]), k = lk(r[0], mb), o = out[k] || (out[k] = blank(r[0], mb)); o.sys = (o.sys || 0) + r[2]; if (r[3]) o.cost = r[3]; });
  docs.forEach(function (d) {
    var role = sessRole(d); Object.keys(d.lines || {}).forEach(function (k0) {
      var l = d.lines[k0]; if (!hasQty(l) && !l.remark) return;
      var mb = monthOf(l.batch), k = lk(l.code, mb), o = out[k] || (out[k] = blank(l.code, mb)), q = o.q[role];
      if (hasQty(l)) { q.has = true; q.ctn = (q.ctn || 0) + (l.ctn || 0); q.box = (q.box || 0) + (l.box || 0); q.pcs = (q.pcs || 0) + (l.pcs || 0); }
      if (l.remark) o.rmk.push((role === "fin" ? "Fin: " : "Ops: ") + l.remark); (d.names || [d.member || "?"]).forEach(function (n) { o.who[role][n] = 1; });
    });
  });
  var costBy = {}, exD = {}; Object.keys(out).forEach(function (k) { if (out[k].cost) costBy[out[k].code] = out[k].cost; });
  docs.forEach(function (d) { (d.extraSkus || []).forEach(function (x) { if (!exD[x.code]) exD[x.code] = (x.desc || "") + " (NOT ON SKU LIST)"; }); });
  var list = Object.keys(out).map(function (k) {
    var o = out[k], s = sm[o.code] || {};
    if (!o.cost && costBy[o.code]) o.cost = costBy[o.code];
    o.desc = s.desc || exD[o.code] || "(not on SKU list)"; o.per = s.per || ""; o.perBox = s.perBox || "";
    var co = o.q.ops.has ? toPcs(o.q.ops, s) : null, cf = o.q.fin.has ? toPcs(o.q.fin, s) : null;
    /* a counted 0 on one side matches a blank on the other (nothing there) */
    if (!co && cf && cf.ok && cf.qty === 0) co = { ok: true, qty: 0 }; if (!cf && co && co.ok && co.qty === 0) cf = { ok: true, qty: 0 };
    o.opsQ = co && co.ok ? co.qty : null; o.finQ = cf && cf.ok ? cf.qty : null;
    o.status = (!co && !cf) ? "NOT COUNTED" : ((co && !co.ok) || (cf && !cf.ok)) ? "NEEDS PCS FACTOR" : (single && !(co && cf)) ? "MATCH" : !cf ? "WAITING FINANCE" : !co ? "WAITING OPS" : Math.abs(o.opsQ - o.finQ) < 1e-9 ? "MATCH" : "RECOUNT";
    o.counted = o.status === "MATCH"; o.phys = o.counted ? (co ? o.opsQ : o.finQ) : null;
    o.v = o.counted ? o.phys - (o.sys || 0) : null; o.vv = (o.v != null && o.cost) ? o.v * o.cost : null;
    return o;
  }).sort(function (a, b) { return (a.code + a.batch).localeCompare(b.code + b.batch); });
  return skuTolerance(list, tolPct);
}

/* SKU level: agreed (MATCH) batches added vs all system batches; any RECOUNT/WAITING line = PENDING */
export function skuTolerance(list, tolPct) {
  var tol = tolPct / 100, g = {};
  list.forEach(function (o) {
    var a = g[o.code] || (g[o.code] = { sys: 0, phys: 0, cnt: false, pending: false }); a.sys += o.sys || 0;
    if (o.counted) { a.cnt = true; a.phys += o.phys || 0; } else if (o.status !== "NOT COUNTED") a.pending = true;
  });
  Object.keys(g).forEach(function (c) {
    var a = g[c]; a.v = a.phys - a.sys; a.pct = (a.sys && !a.pending && a.cnt) ? a.v / a.sys : null;
    a.flag = a.pending ? "PENDING" : !a.cnt ? "NOT COUNTED" : !a.sys ? (a.phys ? "NOT IN SYSTEM" : "OK") : Math.abs(a.v / a.sys) <= tol + 1e-12 ? (Math.abs(a.v) < 1e-9 ? "OK" : "WITHIN " + tolPct + "%") : "OVER " + tolPct + "%";
  });
  list.forEach(function (o) { var a = g[o.code]; o.skuPct = a.pct; o.skuV = a.v; o.skuFlag = a.flag; });
  list.skuGroups = g; return list;
}

/* Barcode master paste/upload rows -> [{barcode, code, uom}] ; accepts header row or none */
export function parseBarcodeRows(rows) {
  var out = [], bad = [];
  var start = 0;
  if (rows.length && rows[0].some(function (x) { return /barcode|ean|item|uom/i.test(String(x)); })) start = 1;
  for (var i = start; i < rows.length; i++) {
    var r = rows[i] || []; var bc = String(r[0] == null ? "" : r[0]).trim(), code = String(r[1] == null ? "" : r[1]).trim(), uom = String(r[2] == null ? "" : r[2]).trim().toUpperCase() || "PCS";
    if (!bc && !code) continue;
    if (/E\+/i.test(bc)) { bad.push(bc + " (Excel turned it into a number: format the column as Text)"); continue; }
    bc = bc.replace(/\.0+$/, "");
    if (uom === "CARTON" || uom === "CS" || uom === "CAR") uom = "CTN"; if (uom === "PC" || uom === "EA" || uom === "PIECE") uom = "PCS";
    if (!bc || !code || ["PCS", "BOX", "CTN"].indexOf(uom) < 0) { bad.push((bc || "?") + " / " + (code || "?") + " / " + uom); continue; }
    out.push({ barcode: bc, code: code, uom: uom });
  }
  return { rows: out, bad: bad };
}
