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

/** rows: array of arrays incl. header (MB52 non-hierarchical, batch stocks). branches: valid branch names. */
export function parseMB52(rows, branches) {
  var hr = -1; for (var i = 0; i < Math.min(rows.length, 30); i++) { var h = rows[i].map(function (x) { return String(x == null ? "" : x).trim(); }); if (h.indexOf("Plant") >= 0 && h.indexOf("Material") >= 0) { hr = i; break; } }
  if (hr < 0) throw new Error('No header row with "Plant" and "Material".');
  var H = rows[hr].map(function (x) { return String(x == null ? "" : x).trim(); }), col = function (n) { return H.indexOf(n); };
  ["Plant", "Material", "Batch", "Unrestricted"].forEach(function (n) { if (col(n) < 0) throw new Error('Missing column "' + n + '". Run MB52 with Display Batch Stocks ticked + Non-Hierarchical.'); });
  /* GOOD stock only: Blocked Stock column and bad-stock locations (BS*, SH*, "Bad"/"Dmg") are excluded */
  var qc = ["Unrestricted", "Restricted-Use Stock", "Quality Inspection"].map(col), vc = ["Value Unrestricted", "Value Restricted", "Value in QualInsp."].map(col);
  var bqc = col("Blocked Stock"), bvc = col("Value BlockedStock"), exQ = 0, exV = 0, exB = 0, exBV = 0, trV = 0;
  function badLoc(sl, ds) { return /^(BS|SH)/i.test(sl) || /bad|dmg|damage|shtg/i.test(ds); }
  var brSet = {}; branches.forEach(function (b) { brSet[b] = 1; });
  var agg = {}, descs = {}, skipped = {}, bad = {}, transit = 0, n = 0;
  for (var r = hr + 1; r < rows.length; r++) {
    var row = rows[r];
    var plant = String(row[col("Plant")] || "").trim(), mat = String(row[col("Material")] || "").trim(); if (!plant || !mat) continue;
    var name = col("Name 1") >= 0 ? String(row[col("Name 1")] || "").trim() : "";
    if (col("Material Description") >= 0 && row[col("Material Description")]) descs[mat] = String(row[col("Material Description")]).trim();
    if (col("Stock in Transit") >= 0) transit += numv(row[col("Stock in Transit")]); if (col("Value in Transit") >= 0) trV += numv(row[col("Value in Transit")]);
    var q = 0, v = 0; qc.forEach(function (c) { if (c >= 0) q += numv(row[c]); }); vc.forEach(function (c) { if (c >= 0) v += numv(row[c]); });
    if (bqc >= 0) { exB += numv(row[bqc]); exBV += bvc >= 0 ? numv(row[bvc]) : 0; }
    var slc = col("Storage Location") >= 0 ? String(row[col("Storage Location")] || "").trim() : "", sld = col("Descr. of Storage Loc.") >= 0 ? String(row[col("Descr. of Storage Loc.")] || "") : "";
    if (badLoc(slc, sld)) { exQ += q; exV += v; continue; }
    if (!q) continue;
    if (!brSet[name]) { var k0 = plant + (name ? " " + name : ""); skipped[k0] = (skipped[k0] || 0) + v; continue; }
    var rb = row[col("Batch")], b = monthOf(normBatch(rb)); if (b && !isMonthB(b)) bad[b] = 1;
    var key = name + "|" + mat + "|" + b, A = agg[key] || (agg[key] = { br: name, code: mat, b: b, q: 0, v: 0, sl: {} });
    A.q += q; A.v += v; n++; var sl = col("Storage Location") >= 0 ? String(row[col("Storage Location")] || "").trim() : ""; if (sl) A.sl[sl] = 1;
  }
  var byBr = {}; Object.keys(agg).forEach(function (k) { var A = agg[k]; (byBr[A.br] = byBr[A.br] || []).push([A.code, A.b, Math.round(A.q * 1000) / 1000, A.q ? Math.round(A.v / A.q * 1e6) / 1e6 : 0, Object.keys(A.sl).sort().join(",")]); });
  Object.keys(byBr).forEach(function (b) { byBr[b].sort(function (x, y) { return (x[0] + x[1]).localeCompare(y[0] + y[1]); }); });
  var totQ = 0, totV = 0; Object.keys(agg).forEach(function (k) { totQ += agg[k].q; totV += agg[k].v; });
  return { trV: trV, exBadQ: exQ, exBadV: exV, exBlkQ: exB, exBlkV: exBV, byBr: byBr, descs: descs, skipped: skipped, badBatches: Object.keys(bad), transit: transit, rowsUsed: n, lines: Object.keys(agg).length, totQ: totQ, totV: totV };
}

/** Distinct "Name 1" values (branch names) in an MB52 sheet, with their plant. */
export function mb52Names(rows) {
  for (var i = 0; i < Math.min(rows.length, 30); i++) {
    var h = rows[i].map(function (x) { return String(x == null ? "" : x).trim(); });
    if (h.indexOf("Plant") >= 0 && h.indexOf("Material") >= 0) {
      var pc = h.indexOf("Plant"), nc = h.indexOf("Name 1"), out = {};
      if (nc < 0) return [];
      for (var r = i + 1; r < rows.length; r++) { var n = String(rows[r][nc] || "").trim(), p = String(rows[r][pc] || "").trim(); if (n && !out[n]) out[n] = p; }
      return Object.keys(out).sort().map(function (n) { return { name: n, plant: out[n] }; });
    }
  }
  return [];
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
export function variance(sysRows, docs, sm, tolPct) {
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
    o.status = (!co && !cf) ? "NOT COUNTED" : ((co && !co.ok) || (cf && !cf.ok)) ? "NEEDS PCS FACTOR" : !cf ? "WAITING FINANCE" : !co ? "WAITING OPS" : Math.abs(o.opsQ - o.finQ) < 1e-9 ? "MATCH" : "RECOUNT";
    o.counted = o.status === "MATCH"; o.phys = o.counted ? o.opsQ : null;
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
