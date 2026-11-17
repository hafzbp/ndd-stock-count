/* Excel master file and sign-off PDF. Same layout and formulas as the original app. */
import { S } from "./state.js";
import { el, fmt, bLabel, tsTxt, nowIso, openModal, closeModal, msg, saveBlob, loadJs, errText } from "./ui.js";
import { monthOf, hasQty, sessRole } from "./pure.js";
import { variance, branchesAdm, skuMap, tolPct, currentTake } from "./master.js";

var V = new URL("../vendor/", import.meta.url).href;
function roleName(r) { return r === "fin" ? "Finance check" : "Ops count"; }

async function xlsxLib() { if (typeof XLSX === "undefined") await loadJs(V + "xlsx.full.min.js"); return window.XLSX; }
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
    vs["O" + r] = { t: "s", f: 'IF(AND(M' + r + '="",N' + r + '=""),"NOT COUNTED",IF(M' + r + '="",IF(N' + r + '=0,"MATCH","WAITING OPS"),IF(N' + r + '="",IF(M' + r + '=0,"MATCH","WAITING FINANCE"),IF(M' + r + '=N' + r + ',"MATCH","RECOUNT"))))' };
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
  su["L2"] = { t: "s", v: "Stock take" }; su["M2"] = { t: "s", v: (tkx.name || "") + (tkx.scope === "partial" ? " (partial, " + tkx.skuCount + " SKUs)" : " (total)") };
  if (me && tkx.scope === "partial") { su["A" + tr] = { t: "s", v: "MB52 tie-out not applicable: partial count compares only the picked SKUs." }; ref = "A1:M" + tr; me = null; }
  if (me) {
    var tie = [["MB52 TIE-OUT (value, RM) - upload of " + tsTxt(me.loadedAt), null],
      ["Good stock used as System (unrestricted + restricted + QI)", me.goodV],
      ["Excluded: Blocked Stock", me.blockedV],
      ["Excluded: bad-stock locations BS00/BS01/SH00", me.badLocV],
      ["Excluded: Stock in Transit", me.transitV],
      ["Excluded: plants not in branch list" + (me.skipped && me.skipped.length ? " (" + me.skipped.join(", ") + ")" : ""), me.skippedV],
      ["Total MB52 value (should equal the MB52 file total)", null],
      ["Check: System value on Variance sheet less good stock used (should be 0; rounding under RM10 ignored)", null]];
    tie.forEach(function (rw, ix) { var x = tr + ix; su["A" + x] = { t: "s", v: rw[0] }; if (rw[1] != null) su["B" + x] = { t: "n", v: Math.round(rw[1] * 100) / 100, z: "#,##0.00" }; });
    su["B" + (tr + 6)] = { t: "n", f: "SUM(B" + (tr + 1) + ":B" + (tr + 5) + ")", z: "#,##0.00" };
    su["B" + (tr + 7)] = { t: "n", f: "IF(ABS(SUMPRODUCT((" + rg("Q") + "<>\"\")*1," + rg("Q") + "," + rg("S") + ")-B" + (tr + 1) + ")<10,0,ROUND(SUMPRODUCT((" + rg("Q") + "<>\"\")*1," + rg("Q") + "," + rg("S") + ")-B" + (tr + 1) + ",2))", z: "#,##0.00" };
    ref = "A1:M" + (tr + 7);
  }
  su["!ref"] = ref; su["!cols"] = [{ wch: 48 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 9 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 2 }, { wch: 18 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, su, "Summary");
  return wb;
}

export async function signoffPdf(b) {
  openModal(function (sh) { sh.append(el("h3", { text: "Preparing sign-off PDF…" }), el("p", { class: "muted", text: b })); });
  var J; try { J = await pdfLibs(); } catch (e) { return fail(e); }
  var Vr = variance(b), ses = S.counts.filter(function (d) { return d.branch === b; }), ops = ses.filter(function (d) { return sessRole(d) === "ops"; }), fin = ses.filter(function (d) { return sessRole(d) === "fin"; });
  var lc = {}, sk = {}, sysV = 0, agV = 0, vv = 0; Vr.forEach(function (o) { lc[o.status] = (lc[o.status] || 0) + 1; sysV += (o.sys || 0) * (o.cost || 0); if (o.counted) agV += (o.phys || 0) * (o.cost || 0); vv += o.vv || 0; });
  var G = Vr.skuGroups || {}; Object.keys(G).forEach(function (c) { var f = G[c].flag; sk[f] = (sk[f] || 0) + 1; });
  var allSub = ops.length && fin.length && ses.every(function (d) { return d.status === "submitted"; }), open = (lc.RECOUNT || 0) + (lc["WAITING OPS"] || 0) + (lc["WAITING FINANCE"] || 0) + (lc["NEEDS PCS FACTOR"] || 0), final = allSub && !open;
  var title = (S.adm.settings && S.adm.settings.title) || "NDD Stock Count", tk = currentTake();
  var d = new J({ unit: "mm", format: "a4" }), W = 210, y = 16, F = function (n) { return fmt(n); }, R = function (n) { return n == null ? "" : fmt(n, 2); };
  d.setFont("helvetica", "bold"); d.setFontSize(15); d.text(title + " - Count Sign-off", 14, y); y += 7;
  d.setFontSize(12); d.text(b + (tk.name ? "  ·  " + tk.name : ""), 14, y); d.setFont("helvetica", "normal"); d.setFontSize(9);
  var subs = ses.map(function (x) { return x.submittedAt || ""; }).filter(Boolean).sort();
  d.text("Count submitted: " + (subs.length ? tsTxt(subs[0]) + (subs.length > 1 ? " to " + tsTxt(subs[subs.length - 1]) : "") : "-") + "     Generated: " + tsTxt(nowIso()), W - 14, y, { align: "right" }); y += 5;
  if (!final) { d.setTextColor(200, 0, 0); d.setFont("helvetica", "bold"); d.text("DRAFT - not final: " + (!allSub ? "not all counts submitted. " : "") + (open ? open + " line(s) still RECOUNT / WAITING." : ""), 14, y); d.setTextColor(0); d.setFont("helvetica", "normal"); y += 5; }
  if (tk.scope === "partial") { d.setFont("helvetica", "bold"); d.text("Partial count: " + tk.skuCount + " picked SKU(s) only.", 14, y); d.setFont("helvetica", "normal"); y += 5; }
  d.text("Quantities in PCS. Double count: Operations and Finance counted separately; only MATCH lines are agreed. System = SAP MB52 good stock (bad/blocked excluded). Tolerance ±" + tolPct() + "% per SKU.", 14, y, { maxWidth: W - 28 }); y += 9;
  d.autoTable({ startY: y, theme: "grid", styles: { fontSize: 9, cellPadding: 1.6 }, headStyles: { fillColor: [60, 60, 60] }, head: [["Summary", "Value"]],
    body: [["Lines - MATCH", F(lc.MATCH || 0)], ["Lines - RECOUNT / WAITING", F(open)], ["Lines - NOT COUNTED (system stock, nobody counted)", F(lc["NOT COUNTED"] || 0)],
      ["SKUs - OK / WITHIN " + tolPct() + "%", F((sk.OK || 0) + (sk["WITHIN " + tolPct() + "%"] || 0))], ["SKUs - OVER " + tolPct() + "%", F(sk["OVER " + tolPct() + "%"] || 0)], ["SKUs - PENDING / NOT COUNTED / NOT IN SYSTEM", F((sk.PENDING || 0) + (sk["NOT COUNTED"] || 0) + (sk["NOT IN SYSTEM"] || 0))],
      ["System value (RM)", R(sysV)], ["Agreed count value (RM)", R(agV)], ["Net variance on agreed lines (RM)", R(vv)],
      ["Warehouse photos (Ops / Finance)", ops.reduce(function (a, x) { return a + (x.photos || 0); }, 0) + " / " + fin.reduce(function (a, x) { return a + (x.photos || 0); }, 0)]],
    columnStyles: { 1: { halign: "right", cellWidth: 45 } }, margin: { left: 14, right: 14 } });
  y = d.lastAutoTable.finalY + 7;
  var okL = function (o) { return (o.status === "MATCH" || o.status === "NOT COUNTED") && (o.skuFlag === "OK" || /^WITHIN/.test(o.skuFlag)); };
  var row = function (o) { return [o.code, o.desc, bLabel(o.batch), F(o.opsQ), F(o.finQ), o.status, F(o.phys), F(o.sys), F(o.v), R(o.vv), o.skuFlag]; };
  var head = [["Item", "Description", "Batch", "Ops", "Fin", "Check", "Agreed", "System", "Var", "Var RM", "SKU result"]];
  var cs = { 0: { cellWidth: 13 }, 1: { cellWidth: 44 }, 2: { cellWidth: 13 }, 3: { halign: "right" }, 4: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" }, 8: { halign: "right" }, 9: { halign: "right" } };
  var ex = Vr.filter(function (o) { return !okL(o); });
  d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("Exceptions (" + ex.length + " line(s))", 14, y); d.setFont("helvetica", "normal");
  d.autoTable({ startY: y + 2, theme: "grid", styles: { fontSize: 7, cellPadding: 1.2 }, headStyles: { fillColor: [60, 60, 60] }, head: head, body: ex.length ? ex.map(row) : [["", "No exceptions", "", "", "", "", "", "", "", "", ""]], columnStyles: cs, margin: { left: 14, right: 14 } });
  y = d.lastAutoTable.finalY + 8;
  if (y > 200) { d.addPage(); y = 18; }
  d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("Declaration", 14, y); y += 5; d.setFont("helvetica", "normal"); d.setFontSize(9);
  d.text("We confirm the quantities above were physically counted by us at " + b + ", and that the count was done without reference to the other team's figures or the system quantity.", 14, y, { maxWidth: W - 28 }); y += 11;
  var box = function (role, name, img, at) {
    if (y > 262) { d.addPage(); y = 18; } d.setDrawColor(150); d.rect(14, y, W - 28, 24); d.setFontSize(8); d.setTextColor(90); d.text(role, 16, y + 4); d.setTextColor(0); d.setFontSize(10); d.text(name || "Name:", 16, y + 11);
    d.setFontSize(8); d.text(at ? "Signed in app: " + tsTxt(at) : "Date:", 16, y + 19); if (img) { try { d.addImage(img, "JPEG", W - 14 - 62, y + 2, 60, 18); } catch (e) { } } else { d.line(W - 14 - 62, y + 19, W - 16, y + 19); d.text("Signature", W - 14 - 62, y + 22); } y += 27;
  };
  var signs = function (list, role) { if (!list.length) { box(role, "", "", ""); return; } list.forEach(function (x) { var nm = (x.names && x.names.length) ? x.names : [x.member]; nm.forEach(function (n) { var s = (x.sign || {})[n]; box(role, n, s && s.img, s && s.at); }); }); };
  signs(ops, "Counted by - Operations"); signs(fin, "Checked by - Finance");
  box("Branch Manager / Person in charge", "", "", ""); box("Reviewed by - Finance HQ", "", "", "");
  var cnt = Vr.filter(function (o) { return o.status !== "NOT COUNTED"; });
  d.addPage(); d.setFont("helvetica", "bold"); d.setFontSize(11); d.text("Appendix - all counted lines (" + cnt.length + ")", 14, 16); d.setFont("helvetica", "normal");
  d.autoTable({ startY: 19, theme: "grid", styles: { fontSize: 7, cellPadding: 1.2 }, headStyles: { fillColor: [60, 60, 60] }, head: head, body: cnt.map(row), columnStyles: cs, margin: { left: 14, right: 14 } });
  var n = d.getNumberOfPages(); for (var i = 1; i <= n; i++) { d.setPage(i); d.setFontSize(7); d.setTextColor(120); d.text(b + " - page " + i + " of " + n, W - 14, 290, { align: "right" }); d.setTextColor(0); }
  var fname = "SignOff_" + b.replace(/\s+/g, "_") + "_" + new Date().toISOString().slice(0, 10) + ".pdf";
  window.__pdf = d.output("datauristring");
  saveBlob(d.output("blob"), fname);
  openModal(function (sh) { sh.append(el("h3", { text: "Saved ✓" }), el("p", { class: "muted", text: fname + (final ? "" : " (marked DRAFT)") }), el("button", { class: "btn block", text: "OK", onclick: closeModal })); });
}
