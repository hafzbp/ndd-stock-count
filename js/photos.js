/* Warehouse condition photos: taken with the phone camera (no gallery), stamped with date, time, GPS and address
   (OpenStreetMap), shrunk to ~1600 px JPEG, stored privately in Supabase Storage through the "photos" edge function
   (which checks the plant-code/password token). */
import { S, tokenFor, backup } from "./state.js";
import { fn } from "./api.js";
import { el, toast, errText, openModal, closeModal } from "./ui.js";

var cache = {}; // session id -> [{id,url}]

/* ---- where and when: every photo is stamped with date, time, GPS and address ---- */
var MAX_AGE = 5 * 60 * 1000;          // a photo older than this was not just taken with the camera
var geo = { p: null, at: 0, st: "idle", run: null }, addrCache = {};
function locate() {
  if (geo.st === "ok" && Date.now() - geo.at < 120000) return Promise.resolve(geo.p);
  if (geo.run) return geo.run;
  if (!navigator.geolocation) { geo.st = "none"; return Promise.resolve(null); }
  geo.run = new Promise(function (ok) {
    navigator.geolocation.getCurrentPosition(function (pos) {
      geo.p = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy }; geo.at = Date.now(); geo.st = "ok"; geo.run = null;
      address(geo.p); ok(geo.p);
    }, function (e) { geo.st = e && e.code === 1 ? "denied" : "fail"; geo.run = null; ok(null); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
  return geo.run;
}
function address(p) {
  var k = p.lat.toFixed(4) + "," + p.lon.toFixed(4);
  if (addrCache[k]) return addrCache[k];
  var ctl = typeof AbortController !== "undefined" ? new AbortController() : null, tm = setTimeout(function () { ctl && ctl.abort(); }, 7000);
  addrCache[k] = fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=en&lat=" + p.lat + "&lon=" + p.lon, ctl ? { signal: ctl.signal } : {})
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { clearTimeout(tm); return j && j.display_name ? String(j.display_name).replace(/,\s*Malaysia$/, "") : null; })
    .catch(function () { clearTimeout(tm); delete addrCache[k]; return null; });
  return addrCache[k];
}
function within(pr, ms) { return Promise.race([pr, new Promise(function (ok) { setTimeout(function () { ok(null); }, ms); })]); }
export function stampWhen(t) {
  var d = new Date(t), f = function (o) { return new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: "Asia/Kuala_Lumpur" }, o)).format(d); };
  return f({ day: "numeric", month: "short", year: "numeric" }) + ", " + f({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " MYT";
}
/* Lines written on the photo, top to bottom. */
export function stampLines(info) {
  var out = [stampWhen(info.at)];
  if (info.pos) out.push("GPS " + info.pos.lat.toFixed(6) + ", " + info.pos.lon.toFixed(6) + (info.pos.acc ? " (±" + Math.round(info.pos.acc) + " m)" : ""));
  else out.push("Location not shared");
  if (info.pos) out.push(info.addr || "Address not available (no connection)");
  if (info.who) out.push(info.who);
  return out;
}
function wrap(ctx, text, maxW) {
  var words = text.split(" "), lines = [], cur = "";
  words.forEach(function (w) { var t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; });
  if (cur) lines.push(cur);
  return lines;
}
function stamp(c, lines) {
  var ctx = c.getContext("2d"), fs = Math.max(16, Math.round(c.width / 36)), pad = Math.round(fs * 0.7), lh = Math.round(fs * 1.3);
  ctx.font = "600 " + fs + "px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  var all = []; lines.forEach(function (l, i) { var w = wrap(ctx, l, c.width - 2 * pad); (i === 2 ? w.slice(0, 2) : w.slice(0, 1)).forEach(function (x) { all.push(x); }); });
  var h = all.length * lh + 2 * pad;
  ctx.fillStyle = "rgba(0,0,0,0.58)"; ctx.fillRect(0, c.height - h, c.width, h);
  ctx.fillStyle = "#fff"; ctx.textBaseline = "top";
  all.forEach(function (l, i) { ctx.fillText(l, pad, c.height - h + pad + i * lh + Math.round((lh - fs) / 2)); });
}
function shrink(file, lines) {
  return new Promise(function (ok, no) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var max = 1600, w = img.naturalWidth, h = img.naturalHeight, sc = Math.min(1, max / Math.max(w, h));
      var c = document.createElement("canvas"); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      if (lines) stamp(c, lines);
      URL.revokeObjectURL(url);
      ok(c.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = function () { URL.revokeObjectURL(url); no(new Error("Can't read this photo")); };
    img.src = url;
  });
}

/* The photo count lives on the session object, but a background sync can swap that object for a fresh copy from the
   server (which may not include an upload that just finished). Keep this phone's own count in S.photoN and write it
   to whichever object is live now. */
function setN(m, n) {
  S.photoN = S.photoN || {}; S.photoN[m.id] = n; m.photos = n;
  var live = S.mine.sessions[m.id]; if (live) live.photos = n;
  backup();
}

export async function listPhotos(sessionId, token) {
  var r = await fn("photos", { action: "list", token: token, device: S.device, session_id: sessionId });
  cache[sessionId] = r.photos || [];
  return cache[sessionId];
}

/* Grid of thumbnails + "Take photo" (camera only). Every photo gets a stamp: date, time, GPS, address.
   onChange() after every add/delete. */
export function photoBlock(m, locked, onChange) {
  var cfg = S.cfg || {}, max = Number(cfg.photoMax) || 5, min = Number(cfg.photoMin) || 0;
  var wrap = el("div", { class: "photos" }), grid = el("div", { class: "pgrid" }), info = el("div", { class: "small muted", style: "margin:6px 0" }), err = el("div", { class: "small", style: "color:var(--bad)" });
  var where = el("div", { class: "small muted", style: "margin:2px 0 4px" });
  var pending = 0;
  function count() { return (cache[m.id] || []).length; }
  function geoTxt() {
    where.textContent = geo.st === "ok" ? "📍 Location found - photos are stamped with date, time, GPS and address."
      : geo.st === "denied" ? "📍 Location is blocked on this phone - photos will say \u201cLocation not shared\u201d. Allow location for this site to stamp the address."
      : "📍 Photos are stamped with date, time and location. Allow location when the phone asks.";
  }
  function draw() {
    grid.innerHTML = "";
    (cache[m.id] || []).forEach(function (p) {
      grid.append(el("div", { class: "pthumb" },
        el("img", { src: p.url, alt: "warehouse photo", loading: "lazy", onclick: function () { window.open(p.url, "_blank"); } }),
        locked ? null : el("button", { class: "pdel", "aria-label": "Delete photo", text: "✕", onclick: function () { del(p); } })));
    });
    for (var i = 0; i < pending; i++) grid.append(el("div", { class: "pthumb busy" }, el("span", { text: "Uploading…" })));
    var n = count();
    info.textContent = n + " of " + max + " photos" + (min ? " · minimum " + min : "") + (n >= min ? " ✓" : "");
    info.style.color = n >= min ? "var(--ok)" : "var(--warn)";
    cam.disabled = locked || n + pending >= max;
    geoTxt();
  }
  var inCam = el("input", { type: "file", accept: "image/*", capture: "environment", class: "hidden" });
  var cam = el("button", { class: "btn primary", type: "button", text: "📷 Take photo", onclick: function () { locate(); inCam.click(); } });
  inCam.addEventListener("change", async function () {
    var file = (inCam.files || [])[0]; inCam.value = "";
    if (!file) return;
    if (count() + pending >= max) { err.textContent = "Maximum " + max + " photos."; return; }
    if (file.lastModified && Date.now() - file.lastModified > MAX_AGE) { err.textContent = "Take a new photo with the camera. Older photos from the gallery can't be used."; return; }
    err.textContent = ""; pending++; draw();
    try {
      var at = file.lastModified && Math.abs(Date.now() - file.lastModified) < MAX_AGE ? file.lastModified : Date.now();
      var pos = await within(locate(), 15000), addr = pos ? await within(address(pos), 7000) : null;
      var who = [m.branch, S.take && S.take.kind === "daily" ? "Daily count" : "Stock take", m.member].filter(Boolean).join(" · ");
      var data = await shrink(file, stampLines({ at: at, pos: pos, addr: addr, who: who }));
      var r = await fn("photos", { action: "upload", token: tokenFor(m.branch), device: S.device, session_id: m.id, image: data.split(",")[1] });
      (cache[m.id] = cache[m.id] || []).push(r.photo);
      setN(m, cache[m.id].length);
    } catch (e) { err.textContent = e.code === "OFFLINE" ? "No connection - photo not sent. Try again when online." : errText(e); }
    pending--; draw(); onChange && onChange();
  });
  async function del(p) {
    try {
      await fn("photos", { action: "delete", token: tokenFor(m.branch), device: S.device, photo_id: p.id });
      cache[m.id] = (cache[m.id] || []).filter(function (x) { return x.id !== p.id; });
      setN(m, cache[m.id].length); draw(); onChange && onChange();
    } catch (e) { err.textContent = errText(e); }
  }
  wrap.append(info, locked ? null : where, grid, locked ? null : el("div", { class: "row", style: "margin-top:8px" }, cam), inCam, err);
  if (!locked && count() < max) locate().then(draw);   /* ask for location once, before the first photo */
  draw();
  if (!cache[m.id] || cache[m.id].length !== (m.photos || 0)) {
    listPhotos(m.id, tokenFor(m.branch)).then(function () { setN(m, count()); draw(); onChange && onChange(); }, function (e) { if (m.photos) err.textContent = "Can't load photos: " + errText(e); });
  }
  return wrap;
}

/* Read-only gallery for Finance (Master tab). */
export function showGallery(sess, adminToken) {
  openModal(function (sh) {
    var grid = el("div", { class: "pgrid" }, el("p", { class: "muted", text: "Loading…" }));
    sh.append(el("h3", { text: "📷 " + sess.branch + " · " + (sess.role === "fin" ? "Finance" : "Ops") }), el("p", { class: "small muted", text: sess.member || "" }), grid,
      el("button", { class: "btn block", style: "margin-top:12px", text: "Close", onclick: closeModal }));
    listPhotos(sess.id, adminToken).then(function (ps) {
      grid.innerHTML = "";
      if (!ps.length) grid.append(el("p", { class: "muted", text: "No photos." }));
      ps.forEach(function (p) { grid.append(el("a", { class: "pthumb", href: p.url, target: "_blank", rel: "noopener" }, el("img", { src: p.url, alt: "warehouse photo" }))); });
    }, function (e) { grid.innerHTML = ""; grid.append(el("p", { class: "muted", text: errText(e) })); });
  });
}
