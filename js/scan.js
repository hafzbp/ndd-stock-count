/* Barcode scanning: camera overlay, green tick on detection, then a count sheet for that SKU.
   Uses zxing-wasm (vendor/zxing.js + zxing_reader.wasm). A handheld scanner works too: it types
   the barcode into the search box and presses Enter (see count.js). */
import { S, cur, touch, hooks } from "./state.js";
import { el, fmt, bLabel, toast } from "./ui.js";
import { lk, toPcs } from "./pure.js";
import { setLine, skuBatches, pickBatch, refreshProgress } from "./count.js";

var stream = null, running = false, paused = true, busy = false, frameNo = 0, SCALES = [1, 0.7, 0.5];
var ready = null, audio = null, lastCode = "", quietUntil = 0, ov = null, canvas = null, ctx = null, video = null;
var BASE = new URL("../vendor/", import.meta.url).href;

function loadEngine() {
  if (ready) return ready;
  ready = new Promise(function (ok, no) {
    if (window.ZXingWASM) return ok();
    var s = document.createElement("script"); s.src = BASE + "zxing.js"; s.onload = ok; s.onerror = function () { no(new Error("Couldn't load the barcode reader. Check internet.")); }; document.head.appendChild(s);
  }).then(function () {
    return window.ZXingWASM.prepareZXingModule({ overrides: { locateFile: function (p) { return p.endsWith(".wasm") ? BASE + "zxing_reader.wasm" : p; } }, fireImmediately: true });
  });
  ready.catch(function () { ready = null; });
  return ready;
}

function beep() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    var o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 1760; g.gain.value = 0.12; o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.09);
  } catch (e) { }
  if (navigator.vibrate) navigator.vibrate(60);
}

function inApp() { return /WhatsApp|Instagram|FBAN|FBAV|FB_IAB|Line\/|TikTok|; wv\)/i.test(navigator.userAgent); }

export function openScanner() {
  if (ov) return;
  var idle, err, aim, hint, tick;
  ov = el("div", { class: "scanov", role: "dialog", "aria-label": "Scan barcode" },
    el("div", { class: "scanbar" },
      el("b", { text: "Scan barcode" }), el("span", { class: "sp" }),
      el("button", { class: "btn", style: "padding:8px 12px", text: "🔦", "aria-label": "Torch", onclick: torch }),
      el("button", { class: "btn", style: "padding:8px 14px", text: "Done", onclick: closeScanner })),
    el("div", { class: "scanview" },
      video = el("video", { playsinline: true, muted: true, autoplay: true }),
      aim = el("div", { class: "aim hidden" }),
      hint = el("div", { class: "hint hidden", text: "Point the barcode at the box, 10–20 cm away" }),
      tick = el("div", { class: "tick", "aria-hidden": "true" }),
      idle = el("div", { class: "idle" }, el("div", { text: "Starting camera…" }), err = el("div", { class: "small", style: "color:#fff;max-width:320px" }))),
    el("div", { class: "scanfoot" },
      el("button", { class: "btn block", text: "Search SKU without scanning", onclick: function () { paused = true; openPicker(null); } })));
  tick.innerHTML = '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  video.muted = true;
  ov._aim = aim; ov._tick = tick; ov._idle = idle; ov._hint = hint;
  document.body.append(ov); document.body.classList.add("noscroll");
  canvas = document.createElement("canvas"); ctx = canvas.getContext("2d", { willReadFrequently: true });
  start().catch(function (e) {
    idle.firstChild.textContent = "Camera can't start";
    err.textContent = (e && e.name === "NotAllowedError") ? "Camera permission was refused. Allow the camera for this site, or use “Search SKU without scanning”."
      : inApp() ? "This page was opened inside WhatsApp/another app. Open it in Chrome or Safari to use the camera."
      : (e && e.message) || "Camera can't be opened. Use “Search SKU without scanning”.";
  });
}

async function start() {
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.resume) audio.resume(); } catch (e) { }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error(inApp() ? "" : "This browser has no camera access. Use Chrome or Safari.");
  await loadEngine();
  stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  if (!ov) { stopStream(); return; }
  var t = stream.getVideoTracks()[0];
  try { await t.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) { }
  video.srcObject = stream; try { await video.play(); } catch (e) { }
  ov._idle.classList.add("hidden"); ov._aim.classList.remove("hidden"); ov._hint.classList.remove("hidden");
  running = true; paused = false; loop();
}
var torchOn = false;
async function torch() { try { var t = stream && stream.getVideoTracks()[0]; if (!t) return; torchOn = !torchOn; await t.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { toast("Torch not available on this phone"); } }

async function loop() {
  if (!running) return;
  if (!busy && !paused && video.readyState >= 2 && video.videoWidth) {
    busy = true;
    try {
      var vw = video.videoWidth, vh = video.videoHeight, sx = Math.round(vw * .05), sw = vw - 2 * sx, sy = Math.round(vh * .2), sh = vh - 2 * sy;
      frameNo = (frameNo + 1) % SCALES.length;
      var sc = Math.min(1, 1600 / sw) * SCALES[frameNo];
      canvas.width = Math.round(sw * sc); canvas.height = Math.round(sh * sc);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      var res = await window.ZXingWASM.readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), { formats: ["EAN-13", "EAN-8", "UPC-A", "UPC-E", "ITF", "Code128"], tryHarder: true, tryRotate: true, maxNumberOfSymbols: 1 });
      var hit = res.find(function (r) { return r.isValid && r.text; });
      if (hit && !paused) detected(hit.text);
    } catch (e) { }
    busy = false;
  }
  requestAnimationFrame(loop);
}
function stopStream() { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
export function closeScanner() {
  running = false; paused = true; stopStream(); torchOn = false;
  if (ov) { ov.remove(); ov = null; } closeSheet(false);
  document.body.classList.remove("noscroll");
  hooks.render();
}
document.addEventListener("visibilitychange", function () { if (document.hidden && ov) closeScanner(); });

function resume() { paused = false; if (ov) { ov._aim.classList.remove("hit"); ov._tick.classList.remove("on"); } }

function detected(code) {
  if (code === lastCode && performance.now() < quietUntil) return;
  lastCode = code; paused = true;
  ov._aim.classList.add("hit");
  var tk = ov._tick; tk.classList.remove("on"); void tk.offsetWidth; tk.classList.add("on");
  beep();
  setTimeout(function () { openScanSheet(code); }, 450);
}

/* ---------- sheet ---------- */
var shade = null, sheet = null;
function openSheet(build) {
  closeSheet(false);
  shade = el("div", { class: "sshade", onclick: function () { closeSheet(true); } });
  sheet = el("div", { class: "ssheet", role: "dialog", "aria-modal": "true" });
  build(sheet);
  document.body.append(shade, sheet);
  requestAnimationFrame(function () { shade.classList.add("on"); sheet.classList.add("on"); });
}
var wedge = false;
function closeSheet(andResume) {
  var had = !!sheet;
  if (sheet) { var a = sheet, b = shade; a.classList.remove("on"); b.classList.remove("on"); setTimeout(function () { a.remove(); b.remove(); }, 260); sheet = shade = null; }
  quietUntil = performance.now() + 3000;
  if (andResume && running) setTimeout(resume, 250);
  if (!ov && had) {
    hooks.render();
    if (wedge) setTimeout(function () { if (S.searchEl) S.searchEl.focus(); }, 60);
  }
}

function skuFor(code) { return (S.skuIndex && S.skuIndex[code]) || (S.skus || []).find(function (s) { return s.code === code; }); }

/* Called by the camera and by a handheld scanner typing into the search box. */
export function openScanSheet(barcode, fromWedge) {
  wedge = !!fromWedge;
  var map = S.barcodes[barcode], m = cur();
  var learned = m && m.unknownBarcodes && m.unknownBarcodes[barcode];
  var s = map ? skuFor(map.code) : learned ? skuFor(learned) : null;
  if (s) openCount(s, barcode, map ? map.uom : null);
  else openPicker(barcode);
}

function openCount(s, barcode, uom) {
  var m = cur(); if (!m) return;
  var batches = skuBatches(s), batch = batches.length === 1 ? batches[0] : null;
  var L = m.lines || {}, counted = Object.keys(L).filter(function (k) { return L[k].code === s.code; });
  if (batch == null && counted.length === 1) batch = L[counted[0]].batch || "";
  openSheet(function (sh) {
    var vals = { ctn: null, box: null, pcs: null }, inputs = {};
    var prevBox = el("div", { class: "prev hidden" }), totalEl = el("span", { text: "0 PCS" });
    var saveBtn = el("button", { class: "btn primary grow", type: "button", text: "Save & scan next" });
    function loadPrev() {
      var l = batch != null ? (m.lines || {})[lk(s.code, batch)] : null;
      if (l && (l.ctn != null || l.box != null || l.pcs != null)) {
        vals = { ctn: l.ctn, box: l.box, pcs: l.pcs };
        var cv = toPcs(l, s);
        prevBox.textContent = "Already counted for batch " + bLabel(batch) + ": " + (cv.ok ? fmt(cv.qty) + " PCS" : "check") + ". Change the numbers if needed - they replace the old ones.";
        prevBox.classList.remove("hidden");
      } else { vals = { ctn: null, box: null, pcs: null }; prevBox.classList.add("hidden"); }
      Object.keys(inputs).forEach(function (f) { inputs[f].value = vals[f] == null ? "" : vals[f]; });
      upd();
    }
    function upd() {
      var cv = toPcs(vals, s);
      totalEl.textContent = cv.ok ? fmt(cv.qty || 0) + " PCS" : "No conversion - tell Finance";
      var any = vals.ctn != null || vals.box != null || vals.pcs != null;
      saveBtn.disabled = batch == null || !any;
      saveBtn.textContent = batch == null ? "Pick the batch month first" : !any ? "Enter the quantity" : (ov ? "Save & scan next" : "Save");
    }
    function stepper(f, label, sub) {
      var inp = el("input", { type: "number", inputmode: "numeric", min: "0", step: "1", placeholder: "0", "aria-label": label });
      inp.addEventListener("input", function () { var n = inp.value === "" ? null : Math.max(0, Math.floor(Number(inp.value))); vals[f] = isNaN(n) ? null : n; upd(); });
      inputs[f] = inp;
      return el("div", { class: "sstep" },
        el("div", { class: "lab" }, label, sub ? el("small", { text: sub }) : null),
        el("button", { type: "button", "aria-label": "minus " + label, text: "−", onclick: function () { vals[f] = Math.max(0, (vals[f] || 0) - 1); inp.value = vals[f]; upd(); } }),
        inp,
        el("button", { type: "button", class: "plus", "aria-label": "plus " + label, text: "+", onclick: function () { vals[f] = (vals[f] || 0) + 1; inp.value = vals[f]; upd(); } }));
    }
    var chips = el("div", { class: "chips", role: "group", "aria-label": "Batch month" });
    function drawChips() {
      chips.innerHTML = "";
      var list = skuBatches(s); if (batch != null && list.indexOf(batch) < 0) list.push(batch);
      list.filter(function (b) { return b; }).forEach(function (b) {
        chips.append(el("button", { type: "button", class: "chip" + (batch === b ? " on" : ""), "aria-pressed": String(batch === b), text: bLabel(b), onclick: function () { batch = b; drawChips(); loadPrev(); } }));
      });
      chips.append(el("button", { type: "button", class: "chip" + (batch === "" ? " on" : ""), "aria-pressed": String(batch === ""), text: "No date", onclick: function () { batch = ""; drawChips(); loadPrev(); } }));
      chips.append(el("button", { type: "button", class: "chip", text: "+ Other batch", onclick: function () {
        pickBatchInline(s, function (b) { batch = b; drawChips(); loadPrev(); });
      } }));
    }
    var steps = [stepper("ctn", "Carton", s.per ? "1 ctn = " + fmt(s.per) + " pcs" : "no pcs/ctn yet")];
    if (s.perBox || uom === "BOX") steps.push(stepper("box", "Box", s.perBox ? "1 box = " + fmt(s.perBox) + " pcs" : "no pcs/box yet"));
    steps.push(stepper("pcs", "Pieces", null));
    saveBtn.addEventListener("click", function () {
      if (saveBtn.disabled) return;
      var cv = toPcs(vals, s);
      setLine(s, batch, { ctn: vals.ctn, box: vals.box, pcs: vals.pcs });
      S.open[s.code] = true;
      closeSheet(true);
      toast("Saved: " + s.code + " · " + bLabel(batch) + " · " + (cv.ok ? fmt(cv.qty) + " PCS" : "check conversion"));
    });
    sh.append(
      el("div", { class: barcode ? "found" : "found" }, barcode ? "✓ Barcode read" : "Selected", el("span", { class: "muted", text: barcode ? " · " + barcode + (uom === "CTN" ? " (carton)" : uom === "BOX" ? " (box)" : "") : "" })),
      el("div", { class: "skuname", text: s.desc || s.code }),
      el("div", { class: "muted", text: s.code }),
      prevBox,
      el("div", { style: "font-weight:600;margin-top:12px", text: "Batch month" }), chips, steps,
      el("div", { class: "stotal" }, "Total", totalEl),
      el("div", { class: "row" }, el("button", { class: "btn", type: "button", text: "Cancel", onclick: function () { closeSheet(true); } }), saveBtn));
    drawChips(); loadPrev();
    var focusF = uom === "CTN" ? "ctn" : uom === "BOX" ? "box" : null;
    if (focusF && inputs[focusF]) { inputs[focusF].closest(".sstep").classList.add("focus"); setTimeout(function () { inputs[focusF].focus(); }, 300); }
  });
}

function pickBatchInline(s, done) {
  var hold = sheet; if (hold) hold.style.visibility = "hidden";
  pickBatch(s, "", function (b) { if (hold) hold.style.visibility = ""; done(b); });
  /* if the picker is cancelled, show the sheet again */
  var mo = document.getElementById("modal");
  var t = setInterval(function () { if (!mo.classList.contains("on")) { clearInterval(t); if (hold) hold.style.visibility = ""; } }, 200);
}

function openPicker(barcode) {
  openSheet(function (sh) {
    var q = el("input", { type: "search", placeholder: "Search SKU code or name", "aria-label": "Search SKU" }), list = el("div");
    var all = Object.keys(S.skuIndex || {}).map(function (k) { return S.skuIndex[k]; });
    if (!all.length) all = S.skus || [];
    function draw() {
      list.innerHTML = ""; var w = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      all.filter(function (s) { var t = (s.code + " " + (s.desc || "")).toLowerCase(); return w.every(function (x) { return t.indexOf(x) >= 0; }); }).slice(0, 60)
        .forEach(function (s) {
          list.append(el("button", { type: "button", class: "pick", onclick: function () {
            var m = cur();
            if (barcode && m) { m.unknownBarcodes = m.unknownBarcodes || {}; m.unknownBarcodes[barcode] = s.code; touch(); }
            closeSheet(false); setTimeout(function () { openCount(s, barcode, null); }, 280);
          } }, s.desc || s.code, el("small", { text: s.code })));
        });
    }
    q.addEventListener("input", draw);
    sh.append(
      el("div", { class: barcode ? "unk" : "found" }, barcode ? "Barcode not registered" : "Search SKU", barcode ? el("span", { class: "muted", text: " · " + barcode }) : null),
      el("div", { class: "skuname", text: barcode ? "Which SKU is this?" : "Pick the SKU you are counting" }),
      barcode ? el("div", { class: "muted small", text: "Your choice is sent to Finance so they can add this barcode to the master. Next scan of this barcode on this phone goes straight to the SKU." }) : null,
      el("div", { style: "height:10px" }), q, list,
      el("div", { class: "row", style: "margin-top:12px" }, el("button", { class: "btn grow", type: "button", text: ov ? "Cancel, scan again" : "Cancel", onclick: function () { closeSheet(true); } })));
    draw(); setTimeout(function () { q.focus(); }, 300);
  });
}
