/* Excel master file and sign-off PDF. Same layout and formulas as the original app. */
import { S } from "./state.js";
import { el, fmt, bLabel, tsTxt, nowIso, openModal, closeModal, msg, saveBlob, loadJs, errText } from "./ui.js";
import { monthOf, hasQty, sessRole } from "./pure.js";
import { variance, branchesAdm, skuMap, tolPct, currentTake, isSingle, docsFrom } from "./master.js";
import { rpc } from "./api.js";
import { listPhotos } from "./photos.js";

var V = new URL("../vendor/", import.meta.url).href;
function roleName(r) { return r === "fin" ? "Finance check" : "Ops count"; }

export async function zipLib() { if (typeof JSZip === "undefined") await loadJs(V + "jszip.min.js"); return window.JSZip; }
export async function xlsxLib() { if (typeof XLSX === "undefined") await loadJs(V + "xlsx.full.min.js"); return window.XLSX; }
async function pdfLibs() {
  if (!(window.jspdf && window.jspdf.jsPDF)) await loadJs(V + "jspdf.umd.min.js");
  if (!window.jspdf.jsPDF.API.autoTable) await loadJs(V + "jspdf.plugin.autotable.min.js");
  return window.jspdf.jsPDF;
}

export async function exportXlsx() {
  openModal(function (sh) { sh.append(el("h3", { text: "Preparing Excel…" }), el("p", { class: "muted", text: "Building the master file." })); });
  var wb;
  try { await xlsxLib(); wb = buildWorkbook(); }
  catch (e) { return fail(e); }
  var buf = XLSX.write(wb, { bookType: "xlsx", type: "array" }), d = new Date(), st = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") + "_" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
  var fname = "NDD_Stock_Count_Master_" + st + ".xlsx";
  saveBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fname);
  openModal(function (sh) {
    sh.append(el("h3", { text: "Exported ✓" }), el("p", { class: "muted", text: fname + " - check your Downloads folder." }),
      el("button", { class: "btn block", style: "margin-bottom:8px", text: "Copy Variance table (paste into Excel)", onclick: function () {
        var tsv = XLSX.utils.sheet_to_csv(wb.Sheets["Variance"], { FS: "\t" });
        navigator.clipboard.writeText(tsv).then(function () { msg("Copied", "Open Excel, click A1, press Ctrl+V."); }, function () { msg("Copy blocked", "Your browser blocked the clipboard."); });
      } }),
      el("button", { class: "btn block", text: "OK", onclick: closeModal }));
  });
}
function fail(e) { openModal(function (sh) { sh.append(el("h3", { text: "Export didn't go through" }), el("p", { class: "muted", text: errText(e) }), el("button", { class: "btn block", text: "Close", onclick: closeModal })); }); }

export function buildWorkbook() {
  var wb = XLSX.utils.book_new(), sm = skuMap(), br = branchesAdm();
  var c = [["Branch", "Role", "Name(s)", "Item Code", "Description", "Batch (MM/YYYY)", "Carton", "Box", "Pieces", "Pcs per CTN", "Pcs per BOX", "Total (PCS)", "Remarks", "Status", "Last Update"]];
  S.counts.forEach(function (d) {
    Object.keys(d.lines || {}).forEach(function (k) {
      var l = d.lines[k]; if (!hasQty(l) && !l.remark) return;
      c.push([d.branch, roleName(sessRole(d)), d.member || "", l.code, (sm[l.code] || {}).desc || "", l.batch ? bLabel(monthOf(l.batch)) : "", l.ctn == null ? "" : l.ctn, l.box == null ? "" : l.box, l.pcs == null ? "" : l.pcs, (sm[l.code] || {}).per || "", (sm[l.code] || {}).perBox || "", null, l.remark || "", d.status || "", tsTxt(l.t || d.updatedAt)]);
    });
  });
  var cs = XLSX.utils.aoa_to_sheet(c.map(function (row) { return row.map(function (x) { return x == null ? "" : x; }); })), cn = c.length;
  for (var i = 2; i <= cn; i++) { ["G", "H", "I", "J", "K"].forEach(function (cl) { var cc = cs[cl + i]; if (cc && cc.v === "") delete cs[cl + i]; }); cs["L" + i] = { t: "n", f: "G" + i + "*J" + i + "+H" + i + "*K" + i + "+I" + i, z: "#,##0" }; }
  var ct = cn + 2; cs["A" + ct] = { t: "s", v: "TOTAL" }; ["G", "H", "I", "L"].forEach(function (cl) { cs[cl + ct] = { t: "n", f: "SUM(" + cl + "2:" + cl + cn + ")", z: "#,##0" }; });
  cs["!ref"] = "A1:O" + ct; cs["!cols"] = [16, 13, 26, 10, 40, 12, 8, 8, 8, 10, 10, 12, 24, 10, 16].map(function (w) { return { wch: w }; }); XLSX.utils.book_append_sheet(wb, cs, "Counts");
  var hdr = ["Branch", "Item Code", "Description", "Batch (MM/YYYY)", "Ops Carton", "Ops Box", "Ops Pieces", "Fin Carton", "Fin Box", "Fin Pieces", "Pcs per CTN", "Pcs per BOX", "Ops (PCS)", "Finance (PCS)", "Count Check", "Agreed (PCS)", "System (PCS)", "Variance (PCS)", "Unit Cost (RM)", "Variance Value (RM)", "SKU Var %", "SKU Result", "Remarks", "Counted By (Ops)", "Checked By (Finance)"];
  var vs = XLSX.utils.aoa_to_sheet([hdr]), r = 2, rowsAll = [];
  br.forEach(function (b) { variance(b).forEach(function (o) { rowsAll.push([b, o]); }); });
  var LR = Math.max(rowsAll.length + 1, 2), R1 = function (cl) { return "$" + cl + "$2:$" + cl + "$" + LR; };
  rowsAll.forEach(function (p) {
    var b = p[0], o = p[1], qo = o.q.ops, qf = o.q.fin;
    var row = [b, o.code, o.desc, o.batch ? bLabel(o.batch) : "", qo.ctn, qo.box, qo.pcs, qf.ctn, qf.box, qf.pcs, o.per, o.perBox, null, null, null, null, o.sys, null, o.cost, null, null, null, o.rmk.join(" | "), Object.keys(o.who.ops).join(", "), Object.keys(o.who.fin).join(", ")];
    XLSX.utils.sheet_add_aoa(vs, [row.map(function (x) { return x == null ? "" : x; })], { origin: "A" + r });
    ["E", "F", "G", "H", "I", "J", "K", "L", "Q", "S"].forEach(function (cl) { var cc = vs[cl + r]; if (cc && cc.v === "") delete vs[cl + r]; });
    if (qo.has) vs["M" + r] = { t: "n", f: "E" + r + "*K" + r + "+F" + r + "*L" + r + "+G" + r };
    if (qf.has) vs["N" + r] = { t: "n", f: "H" + r + "*K" + r + "+I" + r + "*L" + r + "+J" + r };
    vs["O" + r] = isSingle() ? { t: "s", f: 'IF(AND(M' + r + '="",N' + r + '=""),"NOT COUNTED",IF(OR(M' + r + '="",N' + r + '=""),"MATCH",IF(M' + r + '=N' + r + ',"MATCH","RECOUNT")))' }
      : { t: "s", f: 'IF(AND(M' + r + '="",N' + r + '=""),"NOT COUNTED",IF(M' + r + '="",IF(N' + r + '=0,"MATCH","WAITING OPS"),IF(N' + r + '="",IF(M' + r + '=0,"MATCH","WAITING FINANCE"),IF(M' + r + '=N' + r + ',"MATCH","RECOUNT"))))' };
    vs["P" + r] = { t: "n", f: 'IF(O' + r + '="MATCH",IF(M' + r + '="",N' + r + ',M' + r + '),"")' };
    vs["R" + r] = { t: "n", f: 'IF(P' + r + '="","",P' + r + '-Q' + r + ')' };
    vs["T" + r] = { t: "n", f: 'IF(OR(R' + r + '="",S' + r + '=""),"",R' + r + '*S' + r + ')', z: "#,##0.00" };
    var crit = R1("A") + ",A" + r + "," + R1("B") + ",B" + r;
    var pend = "COUNTIFS(" + crit + "," + R1("O") + ',"RECOUNT")+COUNTIFS(' + crit + "," + R1("O") + ',"WAITING*")';
    var sysS = "SUMIFS(" + R1("Q") + "," + crit + ")", agS = "SUMIFS(" + R1("P") + "," + crit + ")", mt = "COUNTIFS(" + crit + "," + R1("O") + ',"MATCH")';
    vs["U" + r] = { t: "n", f: "IF(OR(" + pend + ">0," + mt + "=0," + sysS + '=0),"",(' + agS + "-" + sysS + ")/" + sysS + ")", z: "0.00%" };
    vs["V" + r] = { t: "s", f: "IF(" + pend + '>0,"PENDING",IF(' + mt + '=0,"NOT COUNTED",IF(U' + r + '="","",IF(ABS(U' + r + ')<=Summary!$M$1,"WITHIN","OVER"))))' };
    r++;
  });
  var VT = LR + 2; vs["A" + VT] = { t: "s", v: "TOTAL" }; ["E", "F", "G", "H", "I", "J", "M", "N", "P", "Q", "R", "T"].forEach(function (cl) { vs[cl + VT] = { t: "n", f: "SUM(" + cl + "2:" + cl + LR + ")", z: (cl === "T" ? "#,##0.00" : "#,##0.###") }; });
  vs["!ref"] = "A1:Y" + VT; vs["!cols"] = [16, 10, 40, 12, 9, 8, 9, 9, 8, 9, 10, 10, 11, 12, 16, 12, 12, 12, 11, 15, 10, 12, 26, 26, 20].map(function (w) { return { wch: w }; });
  XLSX.utils.book_append_sheet(wb, vs, "Variance");
  var su = XLSX.utils.aoa_to_sheet([["Branch", "Lines", "Match", "Recount", "Waiting", "Not Counted", "System (PCS)", "Agreed (PCS)", "Variance Value (RM)", "Lines in SKUs OVER"]]);
  var rg = function (cl) { return "Variance!$" + cl + "$2:$" + cl + "$" + LR; };
  br.forEach(function (b, ix) {
    var x = ix + 2; su["A" + x] = { t: "s", v: b };
    su["B" + x] = { t: "n", f: "COUNTIF(" + rg("A") + ",A" + x + ")" };
    [["C", "MATCH"], ["D", "RECOUNT"], ["E", "WAITING*"], ["F", "NOT COUNTED"]].forEach(function (q) { su[q[0] + x] = { t: "n", f: "COUNTIFS(" + rg("A") + ",A" + x + "," + rg("O") + ',"' + q[1] + '")' }; });
    su["G" + x] = { t: "n", f: "SUMIFS(" + rg("Q") + "," + rg("A") + ",A" + x + ")" }; su["H" + x] = { t: "n", f: "SUMIFS(" + rg("P") + "," + rg("A") + ",A" + x + ")" };
    su["I" + x] = { t: "n", f: "SUMIFS(" + rg("T") + "," + rg("A") + ",A" + x + ")", z: "#,##0.00" }; su["J" + x] = { t: "n", f: "COUNTIFS(" + rg("A") + ",A" + x + "," + rg("V") + ',"OVER")' };
  });
  var t = br.length + 2; su["A" + t] = { t: "s", v: "TOTAL" }; ["B", "C", "D", "E", "F", "G", "H", "I", "J"].forEach(function (cl) { su[cl + t] = { t: "n", f: "SUM(" + cl + "2:" + cl + (t - 1) + ")" }; });
  su["A" + (t + 2)] = { t: "s", v: "CHECKS (should be 0)" };
  su["A" + (t + 3)] = { t: "s", v: "Summary system total less Variance sheet total" }; su["B" + (t + 3)] = { t: "n", f: "ROUND(G" + t + "-SUM(" + rg("Q") + "),3)" };
  su["A" + (t + 4)] = { t: "s", v: "Summary agreed total less Variance sheet total" }; su["B" + (t + 4)] = { t: "n", f: "ROUND(H" + t + "-SUM(" + rg("P") + "),3)" };
  su["A" + (t + 5)] = { t: "s", v: "Lines still RECOUNT or WAITING (must be 0 before sign-off)" }; su["B" + (t + 5)] = { t: "n", f: "D" + t + "+E" + t };
  su["L1"] = { t: "s", v: "Tolerance per SKU" }; su["M1"] = { t: "n", v: tolPct() / 100, z: "0.0%" };
  var me = S.adm && S.adm.meta, tr = t + 7, ref = "A1:M" + (t + 5), tkx = currentTake();
  su["L2"] = { t: "s", v: "Stock take" }; su["M2"] = { t: "s", v: (tkx.name || "") + (tkx.stockType === "bad" ? " - BAD STOCK" : "") + (tkx.scope === "partial" ? " (partial, " + tkx.skuCount + " SKUs)" : " (total)") + (tkx.mode === "single" ? ", single count" : ", double count") };
  if (me && tkx.scope === "partial") { su["A" + tr] = { t: "s", v: "MB52 tie-out not applicable: partial count compares only the picked SKUs." }; ref = "A1:M" + tr; me = null; }
  if (me) {
    var isBadT = (me.data && me.data.stockType || me.stockType) === "bad" || tkx.stockType === "bad", md = me.data || me;
    var tie = [["MB52 TIE-OUT (value, RM) - upload of " + tsTxt(me.loadedAt), null],
      isBadT ? ["Bad stock used as System (locations BS00/BS01/SH00, unrestricted + restricted + QI)", me.goodV] : ["Good stock used as System (unrestricted + restricted + QI)", me.goodV],
      ["Excluded: Blocked Stock", me.blockedV],
      isBadT ? ["Excluded: good stock, and bad stock of plants not in the branch list", (md.goodStockV || 0) + Math.max(0, (me.badLocV || 0) - (me.goodV || 0))] : ["Excluded: bad-stock locations BS00/BS01/SH00", me.badLocV],
      ["Excluded: Stock in Transit", me.transitV],
      ["Excluded: plants not in branch list" + (me.skipped && me.skipped.length ? " (" + me.skipped.join(", ") + ")" : ""), me.skippedV],
      ["Total MB52 value (should equal the MB52 file total)", null],
      ["Check: System value on Variance sheet less " + (isBadT ? "bad" : "good") + " stock used (should be 0; rounding under RM10 ignored)", null]];
    tie.forEach(function (rw, ix) { var x = tr + ix; su["A" + x] = { t: "s", v: rw[0] }; if (rw[1] != null) su["B" + x] = { t: "n", v: Math.round(rw[1] * 100) / 100, z: "#,##0.00" }; });
    su["B" + (tr + 6)] = { t: "n", f: "SUM(B" + (tr + 1) + ":B" + (tr + 5) + ")", z: "#,##0.00" };
    su["B" + (tr + 7)] = { t: "n", f: "IF(ABS(SUMPRODUCT((" + rg("Q") + "<>\"\")*1," + rg("Q") + "," + rg("S") + ")-B" + (tr + 1) + ")<10,0,ROUND(SUMPRODUCT((" + rg("Q") + "<>\"\")*1," + rg("Q") + "," + rg("S") + ")-B" + (tr + 1) + ",2))", z: "#,##0.00" };
    ref = "A1:M" + (tr + 7);
  }
  su["!ref"] = ref; su["!cols"] = [{ wch: 48 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 9 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 2 }, { wch: 18 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, su, "Summary");
  return wb;
}

function logoData() {
  return fetch("assets/logo.png").then(function (r) { return r.ok ? r.blob() : null; }).then(function (bl) {
    return bl ? new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { res(null); }; fr.readAsDataURL(bl); }) : null;
  }).catch(function () { return null; });
}

/* Warehouse photos for the sign-off PDF: each session's photos as JPEG data plus their pixel size. */
function imgData(url) {
  return fetch(url).then(function (r) { if (!r.ok) throw new Error("photo " + r.status); return r.blob(); }).then(function (bl) {
    return new Promise(function (ok, no) { var fr = new FileReader(); fr.onload = function () { var im = new Image(); im.onload = function () { ok({ data: fr.result, w: im.naturalWidth, h: im.naturalHeight }); }; im.onerror = no; im.src = fr.result; }; fr.onerror = no; fr.readAsDataURL(bl); });
  });
}
async function sessionPhotos(ses) {
  var out = [], miss = 0;
  for (var i = 0; i < ses.length; i++) {
    var x = ses[i]; if (!x.photos) continue;
    var ps; try { ps = await listPhotos(x.id, S.admin.token); } catch (e) { miss += x.photos; continue; }
    for (var j = 0; j < ps.length; j++) { try { var im = await imgData(ps[j].url); im.who = (sessRole(x) === "fin" ? "Finance" : "Ops") + " · " + (x.member || ""); out.push(im); } catch (e) { miss++; } }
  }
  out.miss = miss; return out;
}
function photoPages(d, W, list, sg) {
  d.addPage(); var y = 16;
  d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("Warehouse photos (" + list.length + ")", 14, y); d.setFont("helvetica", "normal");
  d.setFontSize(8); d.setTextColor(90); d.text("Taken in the app with the phone camera. Date, time, GPS and address are stamped on each photo.", 14, y + 5); d.setTextColor(0);
  if (list.miss) { d.setTextColor(180, 0, 0); d.text(list.miss + " photo(s) could not be loaded into this PDF - see them in the app.", 14, y + 9); d.setTextColor(0); }
  y += 13;
  var cw = (W - 28 - 6) / 2, col = 0, rowH = 0;
  list.forEach(function (im) {
    var h = Math.min(cw * im.h / im.w, 118), w = h * im.w / im.h;
    if (col === 0 && y + h + 6 > 285) { d.addPage(); y = 16; }
    var x = 14 + col * (cw + 6) + (cw - w) / 2;
    try { d.addImage(im.data, "JPEG", x, y, w, h); } catch (e) { }
    if (!sg) { d.setFontSize(7.5); d.setTextColor(90); d.text(im.who, 14 + col * (cw + 6), y + h + 4); d.setTextColor(0); }
    rowH = Math.max(rowH, h + 7);
    if (col === 1) { y += rowH; rowH = 0; col = 0; } else col = 1;
  });
}

/* quiet = for "Download all": no modals, returns { blob, name, final } instead of saving */
export async function signoffPdf(b, quiet) {
  if (!quiet) openModal(function (sh) { sh.append(el("h3", { text: "Preparing sign-off PDF…" }), el("p", { class: "muted", text: b })); });
  var J; try { J = await pdfLibs(); } catch (e) { if (quiet) throw e; return fail(e); }
  var Vr = variance(b), ses = S.counts.filter(function (d) { return d.branch === b; }), ops = ses.filter(function (d) { return sessRole(d) === "ops"; }), fin = ses.filter(function (d) { return sessRole(d) === "fin"; });
  var lc = {}, sk = {}, sysV = 0, agV = 0, vv = 0; Vr.forEach(function (o) { lc[o.status] = (lc[o.status] || 0) + 1; sysV += (o.sys || 0) * (o.cost || 0); if (o.counted) agV += (o.phys || 0) * (o.cost || 0); vv += o.vv || 0; });
  var G = Vr.skuGroups || {}; Object.keys(G).forEach(function (c) { var f = G[c].flag; sk[f] = (sk[f] || 0) + 1; });
  var sg = isSingle(), allSub = (sg ? ses.length : ops.length && fin.length) && ses.every(function (d) { return d.status === "submitted"; }), open = (lc.RECOUNT || 0) + (lc["WAITING OPS"] || 0) + (lc["WAITING FINANCE"] || 0) + (lc["NEEDS PCS FACTOR"] || 0), final = allSub && !open;
  var title = (S.adm.settings && S.adm.settings.title) || "NDD Stock Count", tk = currentTake();
  var d = new J({ unit: "mm", format: "a4" }), W = 210, y = 16, F = function (n) { return fmt(n); }, R = function (n) { return n == null ? "" : fmt(n, 2); };
  /* company header: logo + name, red rule */
  var logo = await logoData(), lx = 14;
  if (logo) { try { d.addImage(logo, "PNG", 14, 8, 19.5, 12); lx = 37; } catch (e) { } }
  d.setFont("helvetica", "bold"); d.setFontSize(14); d.text("Nabati Food Malaysia", lx, 14.5);
  d.setFont("helvetica", "normal"); d.setFontSize(8.5); d.setTextColor(110); d.text("Stock count sign-off", lx, 19); d.setTextColor(0);
  d.setDrawColor(181, 18, 27); d.setLineWidth(0.6); d.line(14, 23, W - 14, 23); d.setLineWidth(0.2); d.setDrawColor(0); y = 31;
  d.setFont("helvetica", "bold"); d.setFontSize(15); d.text(title + " - Count Sign-off" + (tk.stockType === "bad" ? " - BAD STOCK" : ""), 14, y); y += 7;
  /* warehouse + stock take name on their own line (wrapped if long), dates on the next - a long name used to run into the dates */
  d.setFontSize(12); var hl = d.splitTextToSize(b + (tk.name ? "  ·  " + tk.name : ""), W - 28); d.text(hl, 14, y); y += 5.2 * hl.length;
  d.setFont("helvetica", "normal"); d.setFontSize(9);
  var subs = ses.map(function (x) { return x.submittedAt || ""; }).filter(Boolean).sort();
  d.text("Count submitted: " + (subs.length ? tsTxt(subs[0]) + (subs.length > 1 ? " to " + tsTxt(subs[subs.length - 1]) : "") : "-") + "     Generated: " + tsTxt(nowIso()), 14, y); y += 5;
  if (!final) { d.setTextColor(200, 0, 0); d.setFont("helvetica", "bold"); d.text("DRAFT - not final: " + (!allSub ? "not all counts submitted. " : "") + (open ? open + " line(s) still RECOUNT / WAITING." : ""), 14, y); d.setTextColor(0); d.setFont("helvetica", "normal"); y += 5; }
  if (tk.scope === "partial") { d.setFont("helvetica", "bold"); d.text("Partial count: " + tk.skuCount + " picked SKU(s) only.", 14, y); d.setFont("helvetica", "normal"); y += 5; }
  d.text("Quantities in PCS. " + (sg ? "Single count: one team counted; its count is the agreed count." : "Double count: Operations and Finance counted separately; only MATCH lines are agreed.") + (tk.stockType === "bad" ? " System = SAP MB52 bad-stock locations BS00, BS01, SH00 only (good and blocked stock excluded)." : " System = SAP MB52 good stock (bad/blocked excluded).") + " Tolerance ±" + tolPct() + "% per SKU.", 14, y, { maxWidth: W - 28 }); y += 9;
  d.autoTable({ startY: y, theme: "grid", styles: { fontSize: 9, cellPadding: 1.6 }, headStyles: { fillColor: [60, 60, 60] }, head: [["Summary", "Value"]],
    body: [[sg ? "Lines - COUNTED" : "Lines - MATCH", F(lc.MATCH || 0)], ["Lines - RECOUNT / WAITING", F(open)], ["Lines - NOT COUNTED (system stock, nobody counted)", F(lc["NOT COUNTED"] || 0)],
      ["SKUs - OK / WITHIN " + tolPct() + "%", F((sk.OK || 0) + (sk["WITHIN " + tolPct() + "%"] || 0))], ["SKUs - OVER " + tolPct() + "%", F(sk["OVER " + tolPct() + "%"] || 0)], ["SKUs - PENDING / NOT COUNTED / NOT IN SYSTEM", F((sk.PENDING || 0) + (sk["NOT COUNTED"] || 0) + (sk["NOT IN SYSTEM"] || 0))],
      ["System value (RM)", R(sysV)], ["Agreed count value (RM)", R(agV)], ["Net variance on agreed lines (RM)", R(vv)],
      sg ? ["Warehouse photos", String(ses.reduce(function (a, x) { return a + (x.photos || 0); }, 0))] : ["Warehouse photos (Ops / Finance)", ops.reduce(function (a, x) { return a + (x.photos || 0); }, 0) + " / " + fin.reduce(function (a, x) { return a + (x.photos || 0); }, 0)]],
    columnStyles: { 1: { halign: "right", cellWidth: 45 } }, margin: { left: 14, right: 14 } });
  y = d.lastAutoTable.finalY + 7;
  var okL = function (o) { return (o.status === "MATCH" || o.status === "NOT COUNTED") && (o.skuFlag === "OK" || /^WITHIN/.test(o.skuFlag)); };
  var row = sg ? function (o) { return [o.code, o.desc, bLabel(o.batch), o.status === "MATCH" ? "COUNTED" : o.status, F(o.phys), F(o.sys), F(o.v), R(o.vv), o.skuFlag]; }
    : function (o) { return [o.code, o.desc, bLabel(o.batch), F(o.opsQ), F(o.finQ), o.status, F(o.phys), F(o.sys), F(o.v), R(o.vv), o.skuFlag]; };
  var head = sg ? [["Item", "Description", "Batch", "Check", "Counted", "System", "Var", "Var RM", "SKU result"]] : [["Item", "Description", "Batch", "Ops", "Fin", "Check", "Agreed", "System", "Var", "Var RM", "SKU result"]];
  var cs = sg ? { 0: { cellWidth: 13 }, 1: { cellWidth: 54 }, 2: { cellWidth: 13 }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" } }
    : { 0: { cellWidth: 13 }, 1: { cellWidth: 44 }, 2: { cellWidth: 13 }, 3: { halign: "right" }, 4: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" }, 8: { halign: "right" }, 9: { halign: "right" } };
  var ex = Vr.filter(function (o) { return !okL(o); });
  d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("Exceptions (" + ex.length + " line(s))", 14, y); d.setFont("helvetica", "normal");
  d.autoTable({ startY: y + 2, theme: "grid", styles: { fontSize: 7, cellPadding: 1.2 }, headStyles: { fillColor: [60, 60, 60] }, head: head, body: ex.length ? ex.map(row) : [head[0].map(function (x, i) { return i === 1 ? "No exceptions" : ""; })], columnStyles: cs, margin: { left: 14, right: 14 } });
  y = d.lastAutoTable.finalY + 8;
  if (y > 200) { d.addPage(); y = 18; }
  d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("Declaration", 14, y); y += 5; d.setFont("helvetica", "normal"); d.setFontSize(9);
  d.text("We confirm the quantities above were physically counted by us at " + b + (sg ? ", and that the count was done without reference to the system quantity." : ", and that the count was done without reference to the other team's figures or the system quantity."), 14, y, { maxWidth: W - 28 }); y += 11;
  var box = function (role, name, img, at) {
    if (y > 262) { d.addPage(); y = 18; } d.setDrawColor(150); d.rect(14, y, W - 28, 24); d.setFontSize(8); d.setTextColor(90); d.text(role, 16, y + 4); d.setTextColor(0); d.setFontSize(10); d.text(name || "Name:", 16, y + 11);
    d.setFontSize(8); d.text(at ? "Signed in app: " + tsTxt(at) : "Date:", 16, y + 19); if (img) { try { d.addImage(img, "JPEG", W - 14 - 62, y + 2, 60, 18); } catch (e) { } } else { d.line(W - 14 - 62, y + 19, W - 16, y + 19); d.text("Signature", W - 14 - 62, y + 22); } y += 27;
  };
  var signs = function (list, role) { if (!list.length) { box(role, "", "", ""); return; } list.forEach(function (x) { var nm = (x.names && x.names.length) ? x.names : [x.member]; nm.forEach(function (n) { var s = (x.sign || {})[n]; box(role, n, s && s.img, s && s.at); }); }); };
  if (sg) signs(ses, "Counted by"); else { signs(ops, "Counted by - Operations"); signs(fin, "Checked by - Finance"); }
  box("Branch Manager / Person in charge", "", "", ""); box("Reviewed by - Finance HQ", "", "", "");
  var pics = await sessionPhotos(ses); if (pics.length || pics.miss) photoPages(d, W, pics, sg);
  var cnt = Vr.filter(function (o) { return o.status !== "NOT COUNTED"; });
  d.addPage(); d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("Appendix - all counted lines (" + cnt.length + ")", 14, 16); d.setFont("helvetica", "normal");
  d.autoTable({ startY: 19, theme: "grid", styles: { fontSize: 7, cellPadding: 1.2 }, headStyles: { fillColor: [60, 60, 60] }, head: head, body: cnt.map(row), columnStyles: cs, margin: { left: 14, right: 14 } });
  var n = d.getNumberOfPages(); for (var i = 1; i <= n; i++) { d.setPage(i); d.setFontSize(7); d.setTextColor(120); d.text(b + " - page " + i + " of " + n, W - 14, 290, { align: "right" }); d.setTextColor(0); }
  var fname = "SignOff_" + b.replace(/\s+/g, "_") + "_" + new Date().toISOString().slice(0, 10) + ".pdf";
  if (quiet) return { blob: d.output("blob"), name: fname, final: !!final };
  window.__pdf = d.output("datauristring");
  saveBlob(d.output("blob"), fname);
  openModal(function (sh) { sh.append(el("h3", { text: "Saved ✓" }), el("p", { class: "muted", text: fname + (final ? "" : " (marked DRAFT)") }), el("button", { class: "btn block", text: "OK", onclick: closeModal })); });
}

/* ================= Daily cycle count: Excel report + sign-off PDF ================= */
var CLS = { A: "A", B: "B", C: "C", R: "R (recount)", S: "S (supervisor added)" };
var DAYST = { ontime: "On time", late: "Late", missed: "Missed", progress: "Counting", todo: "Not started", skip: "Skipped", off: "Off day", none: "Nothing due", future: "" };
function kl(ts) { return ts ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts)) : ""; }
function hm(ts) { return ts ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts)) : ""; }
function dayTxt(s) { if (!s) return ""; var d = new Date(s + "T00:00:00"); return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }); }
function r2(n) { return n == null || isNaN(n) ? null : Math.round(n * 100) / 100; }
/* A daily count is per SKU: a batch the counter did not find in a counted SKU counts as 0 (same rule as the server's sku_var). */
function skuCounted(l) { return l.flag !== "NOT COUNTED" && l.flag !== "PENDING"; }
export function lineVals(l) {
  if (!skuCounted(l)) return { counted: false, phys: null, v: null, vv: null };
  var ph = l.status === "NOT COUNTED" ? 0 : Number(l.phys) || 0, v = ph - (Number(l.sys) || 0);
  return { counted: true, found: l.status !== "NOT COUNTED", phys: ph, v: v, vv: l.cost == null ? null : v * Number(l.cost) };
}
/* one row per SKU from the batch lines of a daily count */
export function dailySkus(t) {
  var by = {}, order = [];
  (t.lines || []).forEach(function (l) {
    var g = by[l.code]; if (!g) { g = by[l.code] = { code: l.code, desc: l.desc || "", cls: (t.plan || {})[l.code] || "", sys: 0, phys: 0, v: null, vv: null, flag: l.flag, pct: l.pct == null ? null : Number(l.pct) * 100, counted: skuCounted(l), cost: l.cost }; order.push(l.code); }
    var x = lineVals(l); g.sys += Number(l.sys) || 0;
    if (x.counted) { g.phys += x.phys; g.v = (g.v || 0) + x.v; if (x.vv != null) g.vv = (g.vv || 0) + x.vv; }
  });
  return order.map(function (k) { return by[k]; });
}
/* totals of one daily count */
export function dailyTotals(t) {
  var sk = dailySkus(t), o = { listed: t.listed || 0, counted: 0, ok: 0, within: 0, over: 0, nis: 0, notCounted: 0, sysRm: 0, net: 0, abs: 0 };
  sk.forEach(function (g) {
    if (g.flag === "OK") o.ok++; else if (g.flag === "WITHIN") o.within++; else if (g.flag === "OVER") o.over++; else if (g.flag === "NOT IN SYSTEM") o.nis++; else o.notCounted++;
    if (g.counted) { o.counted++; o.sysRm += g.sys * (g.cost || 0); o.net += g.vv || 0; o.abs += Math.abs(g.vv || 0); }
  });
  o.acc = o.counted ? Math.round((o.ok + o.within) / o.counted * 1000) / 10 : null;
  return o;
}
function dayState(t) { if (!t) return ""; if (t.skipReason) return "skip"; if (t.submittedAt) return t.late ? "late" : "ontime"; return null; }

/* Excel: Summary (warehouse x working day), Detail (every SKU batch), Repeat variance, Notes */
export async function exportDailyReport(from, to, only) {
  openModal(function (sh) { sh.append(el("h3", { text: "Preparing daily report…" }), el("p", { class: "muted", text: dayTxt(from) + " to " + dayTxt(to) })); });
  var R, ST;
  try {
    var res = await Promise.all([rpc("admin_dcc_report", { p_token: S.admin.token, p_from: from, p_to: to }), rpc("admin_dcc_stats", { p_token: S.admin.token, p_from: from, p_to: to }), xlsxLib()]);
    R = res[0]; ST = res[1];
  } catch (e) { return fail(e); }
  var inSet = function (b) { return !only || only.indexOf(b) >= 0; }, tol = Number(R.tolerance) || 2, by = {};
  (R.takes || []).forEach(function (t) { by[t.branch + "|" + t.date] = t; });
  var sum = [["Date", "Warehouse", "Region", "NOM", "Status", "Count window", "MB52 stock date", "Started", "Submitted", "Minutes", "Counted by",
    "SKUs on list", "SKUs counted", "OK", "Within " + tol + "%", "Over " + tol + "%", "Not in system", "Not counted", "Accuracy %", "System value counted (RM)", "Net variance (RM)", "Absolute variance (RM)", "Photos", "Skip reason / note"]];
  var meta = {}; (R.takes || []).forEach(function (t) { meta[t.branch] = t; });
  (ST.branches || []).filter(function (b) { return inSet(b.branch); }).forEach(function (b) {
    (b.cells || []).forEach(function (c) {
      if (c.st === "future") return;
      var t = by[b.branch + "|" + c.d], m = t || meta[b.branch] || {}, o = t ? dailyTotals(t) : null, st = dayState(t) || c.st;
      var mins = t && t.startedAt && t.submittedAt ? Math.round((new Date(t.submittedAt) - new Date(t.startedAt)) / 60000) : null;
      sum.push([c.d, b.branch, m.region || "", m.nom || "", DAYST[st] || st, t ? t.from + "-" + t.to : "", t && t.snapDate || "", hm(t && t.startedAt), hm(t && t.submittedAt), mins, t && t.who || "",
        o ? o.listed : null, o ? o.counted : null, o ? o.ok : null, o ? o.within : null, o ? o.over : null, o ? o.nis : null, o ? o.notCounted : null, o ? o.acc : null,
        o ? r2(o.sysRm) : null, o ? r2(o.net) : null, o ? r2(o.abs) : null, t ? t.photos : null, (t && t.skipReason) || c.why || ""]);
    });
  });
  var det = [["Date", "Warehouse", "Item", "Description", "Class", "Batch", "System PCS", "Counted PCS", "Var PCS", "Var RM", "Unit cost (RM)", "SKU var %", "SKU result", "Counted by"]], rep = {};
  (R.takes || []).filter(function (t) { return inSet(t.branch); }).forEach(function (t) {
    (t.lines || []).forEach(function (l) {
      var x = lineVals(l);
      det.push([t.date, t.branch, l.code, l.desc || "", CLS[(t.plan || {})[l.code]] || (t.plan || {})[l.code] || "", l.batch ? bLabel(l.batch) : "", Number(l.sys) || 0, x.counted ? x.phys : null,
        x.counted ? x.v : null, x.counted ? r2(x.vv) : null, r2(l.cost), l.pct == null ? null : Math.round(Number(l.pct) * 10000) / 100, l.flag, x.counted ? (x.found ? (t.who || "") : "batch not found") : ""]);
    });
    dailySkus(t).forEach(function (g) {
      var k = t.branch + "|" + g.code, x = rep[k] || (rep[k] = { b: t.branch, c: g.code, d: g.desc, n: 0, times: 0, net: 0, abs: 0, last: "" });
      if (!g.counted) return;
      x.n++; if (g.flag === "OVER" || g.flag === "NOT IN SYSTEM") { x.times++; x.last = t.date > x.last ? t.date : x.last; } x.net += g.v || 0; x.abs += Math.abs(g.vv || 0);
    });
  });
  var rp = [["Warehouse", "Item", "Description", "Times counted", "Times out of tolerance", "Net var PCS", "Absolute var RM", "Last out of tolerance"]];
  Object.keys(rep).map(function (k) { return rep[k]; }).filter(function (x) { return x.times >= 2; }).sort(function (a, b) { return b.times - a.times || b.abs - a.abs; })
    .forEach(function (x) { rp.push([x.b, x.c, x.d, x.n, x.times, r2(x.net), r2(x.abs), x.last]); });
  if (rp.length === 1) rp.push(["No SKU was out of tolerance twice in this period."]);
  var notes = [["NDD Stock Count - Daily cycle count report"], ["Period", from + " to " + to], ["Warehouses", only ? only.join(", ") : "All"], ["Generated", kl(nowIso())], ["Tolerance", "±" + tol + "% per SKU"], [],
    ["Status", "On time = submitted inside the count window; Late = after the window end; Missed = working day with nothing submitted; Skipped = supervisor gave a reason; Off day / Nothing due = no count planned."],
    ["Accuracy %", "SKUs exact or within tolerance, out of SKUs counted."], ["Class", "A = top 80% of stock value, B = next 15%, C = the rest, R = recount of yesterday's out-of-tolerance SKU, S = added by the supervisor."],
    ["System stock", "SAP MB52 good stock of the stock date shown (bad-stock locations, blocked stock and transit left out)."], ["Var", "Counted minus system. Daily counts are per SKU: a batch in the system that the counter did not find counts as 0 (Detail: 'batch not found'). Var RM uses the MB52 unit value; empty when the MB52 had no values."]];
  var wb = XLSX.utils.book_new(), add = function (name, aoa, widths) { var ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = widths.map(function (w) { return { wch: w }; }); if (aoa.length > 1 && aoa[0].length > 1) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) }; XLSX.utils.book_append_sheet(wb, ws, name); };
  add("Summary", sum, [11, 18, 10, 14, 11, 12, 12, 8, 9, 8, 22, 9, 9, 6, 9, 9, 9, 9, 9, 14, 12, 12, 7, 26]);
  add("Detail", det, [11, 18, 10, 34, 9, 9, 10, 10, 9, 10, 10, 9, 12, 22]);
  add("Repeat variance", rp, [18, 10, 34, 10, 12, 10, 12, 14]);
  add("Notes", notes, [16, 110]);
  var buf = XLSX.write(wb, { bookType: "xlsx", type: "array" }), fname = "DCC_Report_" + from + "_to_" + to + (only && only.length === 1 ? "_" + only[0].replace(/\s+/g, "_") : "") + ".xlsx";
  window.__xlsx = { sheets: wb.SheetNames, summary: sum, detail: det.length, repeat: rp };
  saveBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), fname);
  openModal(function (sh) { sh.append(el("h3", { text: "Exported ✓" }), el("p", { class: "muted", text: fname + " - " + (sum.length - 1) + " warehouse-days, " + (det.length - 1) + " SKU lines." }), el("button", { class: "btn block", text: "OK", onclick: closeModal })); });
}

/* Daily sign-off PDF: one warehouse, one day */
export async function dailyPdf(branch, date) {
  openModal(function (sh) { sh.append(el("h3", { text: "Preparing daily sign-off PDF…" }), el("p", { class: "muted", text: branch + " · " + dayTxt(date) })); });
  var J, t, ses;
  try {
    var rr = await rpc("admin_dcc_report", { p_token: S.admin.token, p_from: date, p_to: date, p_branch: branch });
    t = (rr.takes || [])[0]; if (!t) throw new Error("No daily count for " + branch + " on " + dayTxt(date) + ".");
    var res = await Promise.all([rpc("admin_load", { p_token: S.admin.token, p_take: t.id }), pdfLibs()]);
    ses = docsFrom(res[0].sessions).filter(function (x) { return x.branch === branch; }); J = res[1]; t.tol = Number(rr.tolerance) || 2;
  } catch (e) { return fail(e); }
  var tol = t.tol, sk = dailySkus(t), o = dailyTotals(t), F = function (n) { return n == null ? "" : fmt(n); }, R = function (n) { return n == null ? "" : fmt(n, 2); };
  var d = new J({ unit: "mm", format: "a4" }), W = 210, y;
  var logo = await logoData(), lx = 14;
  if (logo) { try { d.addImage(logo, "PNG", 14, 8, 19.5, 12); lx = 37; } catch (e) { } }
  d.setFont("helvetica", "bold"); d.setFontSize(14); d.text("Nabati Food Malaysia", lx, 14.5);
  d.setFont("helvetica", "normal"); d.setFontSize(8.5); d.setTextColor(110); d.text("Daily cycle count sign-off", lx, 19); d.setTextColor(0);
  d.setDrawColor(181, 18, 27); d.setLineWidth(0.6); d.line(14, 23, W - 14, 23); d.setLineWidth(0.2); d.setDrawColor(0); y = 31;
  d.setFont("helvetica", "bold"); d.setFontSize(15); d.text(branch + " - Daily Cycle Count", 14, y); y += 7;
  d.setFontSize(12); d.text(dayTxt(date), 14, y); d.setFont("helvetica", "normal"); d.setFontSize(9); d.text("Generated: " + kl(nowIso()), W - 14, y, { align: "right" }); y += 6;
  var status = t.skipReason ? "Skipped - " + t.skipReason : t.submittedAt ? (t.late ? "Submitted LATE" : "Submitted on time") + " at " + hm(t.submittedAt) : "NOT SUBMITTED";
  if (!t.submittedAt) { d.setTextColor(200, 0, 0); d.setFont("helvetica", "bold"); d.text("DRAFT - " + (t.skipReason ? "the supervisor skipped this day: " + t.skipReason : "this count was not submitted."), 14, y); d.setTextColor(0); d.setFont("helvetica", "normal"); y += 5; }
  var mins = t.startedAt && t.submittedAt ? Math.round((new Date(t.submittedAt) - new Date(t.startedAt)) / 60000) : null;
  d.autoTable({ startY: y, theme: "plain", styles: { fontSize: 9, cellPadding: 0.8 }, columnStyles: { 0: { fontStyle: "bold", cellWidth: 38 } }, margin: { left: 14, right: 14 },
    body: [["Status", status], ["Count window", t.from + " - " + t.to + (t.region || t.nom ? "     Region: " + (t.region || "-") + "   NOM: " + (t.nom || "-") : "")],
      ["Counted by", (t.who || "-") + (t.startedAt ? "   ·   started " + hm(t.startedAt) + (mins != null ? ", took " + mins + " min" : "") : "")],
      ["System stock", "SAP MB52 good stock of " + (t.snapDate ? dayTxt(t.snapDate) : "-") + " (bad-stock locations, blocked stock and transit left out). Quantities in PCS. Tolerance ±" + tol + "% per SKU."]] });
  y = d.lastAutoTable.finalY + 4;
  var cc = {}; Object.keys(t.plan || {}).forEach(function (k) { var c = t.plan[k]; cc[c] = (cc[c] || 0) + 1; });
  d.autoTable({ startY: y, theme: "grid", styles: { fontSize: 9, cellPadding: 1.6 }, headStyles: { fillColor: [60, 60, 60] }, head: [["Summary", "Value"]], margin: { left: 14, right: 14 }, columnStyles: { 1: { halign: "right", cellWidth: 55 } },
    body: [["SKUs on today's list" + (Object.keys(cc).length ? " (" + ["A", "B", "C", "R", "S"].filter(function (k) { return cc[k]; }).map(function (k) { return k + " " + cc[k]; }).join(", ") + ")" : ""), F(o.listed)],
      ["SKUs counted", F(o.counted)], ["SKUs OK / within " + tol + "%", F(o.ok + o.within)], ["SKUs over " + tol + "% (recounted next working day)", F(o.over)], ["SKUs not in system (found, no SAP stock)", F(o.nis)], ["SKUs not counted", F(o.notCounted)],
      ["Accuracy (OK + within, of counted)", o.acc == null ? "-" : o.acc.toFixed(1) + "%"], ["System value of counted SKUs (RM)", R(o.sysRm)], ["Net variance (RM)", R(o.net)], ["Absolute variance (RM)", R(o.abs)], ["Warehouse photos", F(t.photos)]] });
  y = d.lastAutoTable.finalY + 7;
  var head = [["Item", "Description", "Class", "System", "Counted", "Var", "Var %", "Var RM", "Result"]];
  var rowOf = function (g) { return [g.code, g.desc, g.cls, F(g.sys), g.counted ? F(g.phys) : "-", g.counted ? F(g.v) : "-", g.pct == null ? "" : fmt(g.pct, 1) + "%", g.counted ? R(g.vv) : "", g.flag === "WITHIN" ? "WITHIN " + tol + "%" : g.flag === "OVER" ? "OVER " + tol + "%" : g.flag]; };
  var cs = { 0: { cellWidth: 14 }, 1: { cellWidth: 60 }, 2: { cellWidth: 11 }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" } };
  var paint = function (h) { if (h.section !== "body") return; var v = h.row.raw[8] || ""; if (/^OVER|NOT IN SYSTEM|NOT COUNTED/.test(v)) h.cell.styles.textColor = [180, 0, 0]; };
  var ex = sk.filter(function (g) { return g.flag !== "OK" && g.flag !== "WITHIN"; });
  d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("Exceptions (" + ex.length + " SKU" + (ex.length === 1 ? "" : "s") + ")", 14, y); d.setFont("helvetica", "normal");
  d.autoTable({ startY: y + 2, theme: "grid", styles: { fontSize: 7.5, cellPadding: 1.2 }, headStyles: { fillColor: [60, 60, 60] }, head: head, body: ex.length ? ex.map(rowOf) : [["", "No exceptions - every SKU counted is within tolerance.", "", "", "", "", "", "", ""]], columnStyles: cs, margin: { left: 14, right: 14 }, didParseCell: paint });
  y = d.lastAutoTable.finalY + 7;
  if (y > 230) { d.addPage(); y = 18; }
  d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("All SKUs on today's list (" + sk.length + ")", 14, y); d.setFont("helvetica", "normal");
  d.autoTable({ startY: y + 2, theme: "grid", styles: { fontSize: 7.5, cellPadding: 1.2 }, headStyles: { fillColor: [60, 60, 60] }, head: head, body: sk.map(rowOf), columnStyles: cs, margin: { left: 14, right: 14 }, didParseCell: paint });
  y = d.lastAutoTable.finalY + 8;
  if (y > 205) { d.addPage(); y = 18; }
  d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("Declaration", 14, y); y += 5; d.setFont("helvetica", "normal"); d.setFontSize(9);
  d.text("I confirm the quantities above were physically counted at " + branch + " on " + dayTxt(date) + ", without reference to the system quantity.", 14, y, { maxWidth: W - 28 }); y += 10;
  var box = function (role, name, img, at) {
    if (y > 262) { d.addPage(); y = 18; } d.setDrawColor(150); d.rect(14, y, W - 28, 24); d.setFontSize(8); d.setTextColor(90); d.text(role, 16, y + 4); d.setTextColor(0); d.setFontSize(10); d.text(name || "Name:", 16, y + 11);
    d.setFontSize(8); d.text(at ? "Signed in app: " + kl(at) : "Date:", 16, y + 19); if (img) { try { d.addImage(img, "JPEG", W - 14 - 62, y + 2, 60, 18); } catch (e) { } } else { d.line(W - 14 - 62, y + 19, W - 16, y + 19); d.text("Signature", W - 14 - 62, y + 22); } y += 27;
  };
  var signed = 0;
  ses.filter(function (x) { return x.status === "submitted"; }).forEach(function (x) { ((x.names && x.names.length) ? x.names : [x.member]).forEach(function (n) { var s = (x.sign || {})[n]; box("Counted by", n, s && s.img, s && s.at); signed++; }); });
  if (!signed) box("Counted by", "", "", "");
  box("Checked by - Warehouse supervisor", "", "", "");
  var pics = await sessionPhotos(ses); if (pics.length || pics.miss) photoPages(d, W, pics, true);
  var cnt = (t.lines || []).filter(function (l) { return lineVals(l).counted; });
  if (cnt.length) {
    d.addPage(); d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("Appendix - counted SKUs by batch (" + cnt.length + " line" + (cnt.length === 1 ? "" : "s") + ")", 14, 16); d.setFont("helvetica", "normal");
    d.setFontSize(8); d.setTextColor(90); d.text("A batch in the system that was not found counts as 0.", 14, 20); d.setTextColor(0);
    d.autoTable({ startY: 22, theme: "grid", styles: { fontSize: 7, cellPadding: 1.2 }, headStyles: { fillColor: [60, 60, 60] }, head: [["Item", "Description", "Batch", "System", "Counted", "Var", "Var RM", "Note"]],
      body: cnt.map(function (l) { var x = lineVals(l); return [l.code, l.desc || "", l.batch ? bLabel(l.batch) : "", F(l.sys), F(x.phys), F(x.v), R(x.vv), x.found ? "" : "not found"]; }), columnStyles: { 0: { cellWidth: 14 }, 1: { cellWidth: 62 }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" } }, margin: { left: 14, right: 14 } });
  }
  var n = d.getNumberOfPages(); for (var i = 1; i <= n; i++) { d.setPage(i); d.setFontSize(7); d.setTextColor(120); d.text(branch + " · " + date + " - page " + i + " of " + n, W - 14, 290, { align: "right" }); d.setTextColor(0); }
  var fname = "DCC_SignOff_" + branch.replace(/\s+/g, "_") + "_" + date + ".pdf";
  window.__pdf = d.output("datauristring");
  saveBlob(d.output("blob"), fname);
  openModal(function (sh) { sh.append(el("h3", { text: "Saved ✓" }), el("p", { class: "muted", text: fname + (t.submittedAt ? "" : " (marked DRAFT)") }), el("button", { class: "btn block", text: "OK", onclick: closeModal })); });
}
