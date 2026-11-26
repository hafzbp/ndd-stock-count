/* Signed sign-off copies: the scanned, signed sign-off PDF of each warehouse, kept with the stock take.
   Stored in the private "signoffs" bucket through the photos edge function (admin only):
   signed_upload gives a one-time upload URL, the browser PUTs the PDF there, signed_commit records it. */
import { S, hooks } from "./state.js";
import { fn } from "./api.js";
import { SUPABASE_KEY } from "./config.js";
import { el, fmt, msg, openModal, closeModal, errText, toast, confirmBox } from "./ui.js";
import { zipLib } from "./export.js";

var MAX = 50 * 1024 * 1024;
function tok() { return S.admin.token; }
export function mb(n) { return n >= 1048576 ? fmt(n / 1048576, 1) + " MB" : fmt(Math.max(1, Math.round(n / 1024))) + " KB"; }

/* list for a stock take, cached; calls hooks.render once loaded */
export function signedFor(takeId) {
  var c = S.signed || (S.signed = {});
  if (!c[takeId] && !c["_l" + takeId]) {
    c["_l" + takeId] = 1;
    fn("photos", { action: "signed_list", token: tok(), take_id: takeId }).then(function (r) { c[takeId] = r.copies || []; delete c["_l" + takeId]; hooks.render(); },
      function () { c[takeId] = []; delete c["_l" + takeId]; });
  }
  var m = {}; (c[takeId] || []).forEach(function (x) { m[x.branch] = x; }); return m;
}
export async function refreshSigned(takeId) {
  var r = await fn("photos", { action: "signed_list", token: tok(), take_id: takeId });
  (S.signed || (S.signed = {}))[takeId] = r.copies || []; return r.copies || [];
}
export async function signedBlob(x) { var r = await fetch(x.url); if (!r.ok) throw new Error("Couldn't download the signed copy of " + x.branch); return await r.blob(); }

async function upload(takeId, branch, file) {
  var u = await fn("photos", { action: "signed_upload", token: tok(), take_id: takeId, branch: branch, size: file.size });
  /* same request as supabase-js uploadToSignedUrl: multipart with the file in the "" field */
  var fd = new FormData(); fd.append("cacheControl", "3600"); fd.append("", file.type === "application/pdf" ? file : new File([file], file.name, { type: "application/pdf" }));
  var put = await fetch(u.url, { method: "PUT", headers: { "x-upsert": "false", apikey: SUPABASE_KEY }, body: fd });
  if (!put.ok) { var t = ""; try { t = (await put.json()).message || ""; } catch (e) { } throw new Error("Upload failed (" + put.status + ") " + t); }
  await fn("photos", { action: "signed_commit", token: tok(), take_id: takeId, branch: branch, path: u.path, name: file.name, size: file.size });
}

/* filename → warehouse: the warehouse name without "NDD", with or without spaces ("Shah Alam", "shahalam", "SHAH_ALAM") */
export function matchBranch(name, list) {
  var n = " " + String(name || "").toLowerCase().replace(/\.pdf$/, "").replace(/[^a-z0-9]+/g, " ") + " ", best = "", bl = 0;
  list.forEach(function (b) {
    var k = b.toLowerCase().replace(/^ndd\s+/, "").replace(/[^a-z0-9]+/g, " ").trim(); if (!k) return;
    if ((n.indexOf(" " + k + " ") >= 0 || n.replace(/ /g, "").indexOf(k.replace(/ /g, "")) >= 0) && k.length > bl) { best = b; bl = k.length; }
  });
  return best;
}

async function pdfsFrom(files) {
  var out = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (/\.zip$/i.test(f.name)) {
      var Z = await zipLib(), z = await Z.loadAsync(f), names = Object.keys(z.files).filter(function (k) { return !z.files[k].dir && /\.pdf$/i.test(k) && !/(^|\/)(__MACOSX|\.)/.test(k); });
      for (var j = 0; j < names.length; j++) {
        var b = await z.files[names[j]].async("blob");
        out.push(new File([b], names[j].split("/").pop(), { type: "application/pdf" }));
      }
    } else if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") out.push(f);
  }
  return out;
}

/* the dialog: one row per warehouse; add several PDFs or a ZIP at once */
export function signedDialog(takeId, branches, readOnly) {
  var have = {}; ((S.signed || {})[takeId] || []).forEach(function (x) { have[x.branch] = x; });
  openModal(function (sh) {
    var inp = el("input", { type: "file", accept: ".pdf,.zip,application/pdf,application/zip", multiple: true, style: "display:none", onchange: async function () {
      var fl = Array.prototype.slice.call(inp.files || []); inp.value = ""; if (!fl.length) return;
      try { var pdfs = await pdfsFrom(fl); if (!pdfs.length) return msg("No PDF found", "Choose PDF files, or a ZIP with PDFs inside."); matchStep(takeId, branches, pdfs); }
      catch (e) { msg("Can't read the file", errText(e)); }
    } });
    var rows = el("div", { class: "md-rows" });
    branches.forEach(function (b) {
      var x = have[b];
      rows.append(el("div", {},
        el("div", { class: "g" }, el("b", { text: b }), el("small", { text: x ? "✓ " + x.name + " · " + mb(x.size) : "No signed copy yet" })),
        el("div", { class: "nums" },
          x ? el("a", { class: "btn", href: x.url, target: "_blank", rel: "noopener", text: "Open" }) : null,
          readOnly ? null : el("button", { class: "btn", text: x ? "Replace" : "Attach PDF", onclick: function () {
            var one = el("input", { type: "file", accept: ".pdf,application/pdf", style: "display:none", onchange: function () { var f = one.files && one.files[0]; if (f) matchStep(takeId, branches, [f], b); } });
            document.body.append(one); one.click(); setTimeout(function () { one.remove(); }, 60000);
          } }),
          x && !readOnly ? el("button", { class: "btn", style: "color:var(--bad)", text: "Remove", onclick: function () {
            confirmBox("Remove the signed copy of " + b + "?", x.name + " is deleted from the app. The PDFs the app makes itself stay.", "Remove", async function () {
              try { await fn("photos", { action: "signed_delete", token: tok(), take_id: takeId, branch: b }); await refreshSigned(takeId); toast("Removed"); signedDialog(takeId, branches); hooks.render(); }
              catch (e) { msg("Couldn't remove", errText(e)); }
            });
          } }) : null)));
    });
    var n = Object.keys(have).filter(function (b) { return branches.indexOf(b) >= 0; }).length;
    sh.append(el("h3", { text: "Signed sign-off copies · " + n + " of " + branches.length }),
      el("p", { class: "small muted", text: "The scanned sign-off each warehouse signed. Download all sign-offs puts them in the ZIP next to the PDFs the app makes. PDF only, up to 50 MB each." }),
      readOnly ? null : el("div", { class: "row", style: "gap:8px;margin:6px 0 10px" }, el("button", { class: "btn primary", text: "Add several PDFs or a ZIP…", onclick: function () { inp.click(); } }), inp),
      rows, el("button", { class: "btn block", style: "margin-top:12px", text: "Done", onclick: closeModal }));
  }, "wide");
}

function matchStep(takeId, branches, pdfs, only) {
  var have = {}; ((S.signed || {})[takeId] || []).forEach(function (x) { have[x.branch] = x; });
  var pick = pdfs.map(function (f) { return only || matchBranch(f.name, branches); });
  openModal(function (sh) {
    var list = el("div", { class: "md-rows" }), note = el("p", { class: "small", style: "margin:8px 0 0" }), go = el("button", { class: "btn primary", text: "Upload" });
    function check() {
      var seen = {}, dup = [], none = 0, big = 0, rep = [];
      pick.forEach(function (b, i) { if (pdfs[i].size > MAX) { big++; return; } if (!b) { none++; return; } if (seen[b]) dup.push(b); seen[b] = 1; if (have[b]) rep.push(b); });
      var n = pick.filter(function (b, i) { return b && pdfs[i].size <= MAX; }).length;
      note.textContent = [dup.length ? "Two files for " + dup.join(", ") + " - keep one." : "", none ? none + " file(s) not matched - pick the warehouse or leave them out." : "", big ? big + " file(s) over 50 MB are left out - compress the scan first." : "",
        rep.length ? "Replaces the copy already there for " + rep.join(", ") + "." : ""].filter(Boolean).join(" ");
      note.style.color = dup.length ? "var(--bad)" : "var(--mute)";
      go.disabled = !!dup.length || !n; go.textContent = "Upload " + n + " PDF" + (n === 1 ? "" : "s");
    }
    pdfs.forEach(function (f, i) {
      var sel = el("select", { "aria-label": "Warehouse for " + f.name, onchange: function (e) { pick[i] = e.target.value; check(); } },
        el("option", { value: "", text: "- leave out -" }), branches.map(function (b) { return el("option", { value: b, text: b, selected: pick[i] === b }); }));
      list.append(el("div", {}, el("div", { class: "g" }, el("b", { text: f.name }), el("small", { class: f.size > MAX ? "md-neg" : "", text: mb(f.size) + (f.size > MAX ? " · too big" : f.size > 20 * 1048576 ? " · big scan, slow on a phone" : "") })), el("div", { class: "nums" }, sel)));
    });
    go.onclick = async function () {
      var todo = pdfs.map(function (f, i) { return [f, pick[i]]; }).filter(function (x) { return x[1] && x[0].size <= MAX; }), done = 0, bad = [];
      go.disabled = true;
      for (var k = 0; k < todo.length; k++) {
        go.textContent = "Uploading " + (k + 1) + " of " + todo.length + " · " + todo[k][1] + "…";
        try { await upload(takeId, todo[k][1], todo[k][0]); done++; } catch (e) { bad.push(todo[k][1] + ": " + errText(e)); }
      }
      await refreshSigned(takeId).catch(function () { });
      hooks.render();
      if (bad.length) msg(done + " uploaded, " + bad.length + " failed", bad.join("\n"));
      else { toast(done + " signed cop" + (done === 1 ? "y" : "ies") + " saved ✓"); signedDialog(takeId, branches); }
    };
    sh.append(el("h3", { text: "Which warehouse is each PDF?" }),
      el("p", { class: "small muted", text: "Matched by file name. Check each one before uploading." }), list, note,
      el("div", { class: "row", style: "gap:8px;margin-top:12px" }, go, el("button", { class: "btn", text: "Back", onclick: function () { signedDialog(takeId, branches); } })));
    check();
  }, "wide");
}
