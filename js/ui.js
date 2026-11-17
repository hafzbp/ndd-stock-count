/* DOM helpers shared by every screen. */
import { calc } from "./pure.js";

export function $(s) { return document.querySelector(s); }

/* Like the original app: append() accepts arrays and skips null/false. */
(function () {
  var o = Element.prototype.append;
  Element.prototype.append = function () {
    var a = [];
    (function f(x) { for (var i = 0; i < x.length; i++) { var c = x[i]; if (c == null || c === false) continue; if (Array.isArray(c)) f(c); else a.push(c); } })(arguments);
    return o.apply(this, a);
  };
})();

export function el(tag, a) {
  var e = document.createElement(tag); a = a || {};
  for (var k in a) {
    var v = a[k]; if (v == null || v === false) continue;
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v;
    else if (k.indexOf("on") === 0 && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
  return e;
}
function add(e, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
  e.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
}

export function fmt(n, d) { return (n == null || n === "" || isNaN(n)) ? "" : Number(n).toLocaleString("en-MY", { minimumFractionDigits: d || 0, maximumFractionDigits: d == null ? 3 : d }); }
export var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function bLabel(b) { if (!b) return "No date"; var m = /^(\d{4})-(\d{2})/.exec(b); return m ? (m[2] + "/" + m[1]) : b; }
export function keyOf(s) { return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x"; }
export function nowIso() { return new Date().toISOString(); }
export function tsTxt(i) { return i ? new Date(i).toLocaleString("en-MY", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : ""; }

export function pill(t, c) { var p = $("#pill"); if (!p) return; p.textContent = t; p.className = "pill " + (c || ""); }

var modalStack = 0;
export function openModal(build) { var sh = $("#sheet"); sh.innerHTML = ""; build(sh); $("#modal").classList.add("on"); modalStack++; }
export function closeModal() { $("#modal").classList.remove("on"); }
export function msg(t, body) { openModal(function (sh) { sh.append(el("h3", { text: t }), body ? el("p", { class: "muted", style: "white-space:pre-line", text: body }) : null, el("button", { class: "btn block", text: "OK", onclick: closeModal })); }); }
export function confirmBox(t, body, ok, fn) {
  openModal(function (sh) {
    sh.append(el("h3", { text: t }), el("p", { class: "muted", style: "white-space:pre-line", text: body }),
      el("div", { class: "row", style: "justify-content:flex-end" }, el("button", { class: "btn", text: "Cancel", onclick: closeModal }), el("button", { class: "btn primary", text: ok, onclick: function () { closeModal(); fn(); } })));
  });
}
export function toast(t) { var x = $("#toast"); if (!x) return; x.textContent = t; x.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(function () { x.classList.remove("on"); }, 2400); }
export function errText(e) { return (e && e.message) || String(e); }

export function numPad(title, start, onOk, sub) {
  var v = start == null ? "" : String(start);
  openModal(function (sh) {
    var d = el("div", { class: "disp", style: "font-size:28px" }), res = el("div", { class: "small", style: "text-align:right;min-height:20px;margin-top:4px;font-weight:600" });
    function val() { return calc(v); }
    function draw() {
      d.textContent = v === "" ? "0" : v; var r = val(), hasOp = /[+−×÷]/.test(v);
      res.textContent = !hasOp ? "" : (r == null || isNaN(r)) ? "-" : (r < 0 ? "Can't be negative" : "= " + r.toLocaleString("en-MY")); res.style.color = (r < 0 || isNaN(r)) && hasOp ? "var(--bad)" : "var(--ok)";
    }
    draw();
    var pad = el("div", { class: "pad", style: "grid-template-columns:repeat(4,1fr)" });
    ["7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "C", "0", "⌫", "+"].forEach(function (k) {
      var isOp = /[+−×÷]/.test(k);
      pad.append(el("button", {
        text: k, style: isOp ? "background:var(--card);color:var(--accent)" : "", onclick: function () {
          if (k === "C") v = ""; else if (k === "⌫") v = v.slice(0, -1);
          else if (isOp) { if (v === "" && k !== "−") return; if (/[+−×÷]$/.test(v)) v = v.slice(0, -1); if (v !== "" || k !== "−") v += k; }
          else { if (v.length >= 24) return; var lastNum = v.split(/[+−×÷]/).pop(); if (lastNum === "0") v = v.slice(0, -1); v += k; }
          draw();
        }
      }));
    });
    var eq = el("button", { class: "btn", style: "flex:1", text: "=", onclick: function () { var r = val(); if (r != null && !isNaN(r) && r >= 0) { v = String(r); draw(); } } });
    sh.append(el("h3", { text: title }), sub ? el("p", { class: "muted small", text: sub }) : null, d, res, pad,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn", style: "flex:1", text: "Cancel", onclick: closeModal }), eq,
        el("button", {
          class: "btn primary", style: "flex:2", text: "OK", onclick: function () {
            var r = val();
            if (v !== "" && (r == null || isNaN(r))) { res.textContent = "Check the sum"; res.style.color = "var(--bad)"; return; }
            if (r < 0) { res.textContent = "Can't be negative"; res.style.color = "var(--bad)"; return; }
            closeModal(); onOk(v === "" ? null : r);
          }
        })));
  });
}

export function sigPad(name, onchg) {
  var c = el("canvas", { width: 600, height: 180, style: "width:100%;height:110px;border:1px dashed var(--line);border-radius:10px;background:#fff;touch-action:none;display:block" }),
    x = c.getContext("2d"), drawn = false, dn = false, last = null; x.lineWidth = 3; x.lineCap = "round"; x.lineJoin = "round"; x.strokeStyle = "#111";
  function pt(e) { var r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; }
  c.addEventListener("pointerdown", function (e) { dn = true; last = pt(e); c.setPointerCapture && c.setPointerCapture(e.pointerId); e.preventDefault(); });
  c.addEventListener("pointermove", function (e) { if (!dn) return; var p = pt(e); x.beginPath(); x.moveTo(last[0], last[1]); x.lineTo(p[0], p[1]); x.stroke(); last = p; if (!drawn) { drawn = true; onchg && onchg(); } e.preventDefault(); });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) { c.addEventListener(t, function () { dn = false; }); });
  var clr = el("button", { class: "link", text: "clear", onclick: function () { x.clearRect(0, 0, c.width, c.height); drawn = false; onchg && onchg(); } });
  return {
    name: name, node: el("div", { style: "margin:6px 0 10px" }, el("div", { class: "row small", style: "justify-content:space-between" }, el("span", { text: name }), clr), c),
    signed: function () { return drawn; },
    png: function () { var o = document.createElement("canvas"); o.width = 300; o.height = 90; var ox = o.getContext("2d"); ox.fillStyle = "#fff"; ox.fillRect(0, 0, 300, 90); ox.drawImage(c, 0, 0, 300, 90); return o.toDataURL("image/jpeg", 0.6); }
  };
}

/* Save a Blob as a file. Works on desktop, Android and iOS Safari 13+. */
export function saveBlob(blob, filename) {
  var url = URL.createObjectURL(blob), a = el("a", { href: url, download: filename, style: "display:none" });
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
}

export function loadJs(u) {
  return new Promise(function (ok, no) {
    if (document.querySelector('script[src="' + u + '"]')) return ok();
    var t = document.createElement("script"); t.src = u; t.onload = ok; t.onerror = function () { no(new Error("Couldn't load " + u.split("/").pop() + ". Check internet and try again.")); }; document.head.appendChild(t);
  });
}

/* Turns tables into cards on phones (data-label per cell). */
export function labelTables() {
  document.querySelectorAll(".tw table").forEach(function (t) {
    var h = t.querySelector("tr"); if (!h || !h.querySelector("th")) return; var L = [].map.call(h.children, function (c) { return c.textContent.trim(); });
    [].forEach.call(t.querySelectorAll("tr"), function (r) { if (r === h) return; var i = 0; [].forEach.call(r.children, function (c) { var sp = c.colSpan || 1; if (!c.hasAttribute("data-label")) c.setAttribute("data-label", L[i] || ""); i += sp; }); });
  });
}
