/* Warehouse condition photos: taken on the phone, shrunk to ~1600 px JPEG, stored privately in Supabase Storage
   through the "photos" edge function (which checks the PIN/password token). */
import { S, tokenFor, backup } from "./state.js";
import { fn } from "./api.js";
import { el, toast, errText, openModal, closeModal } from "./ui.js";

var cache = {}; // session id -> [{id,url}]

function shrink(file) {
  return new Promise(function (ok, no) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var max = 1600, w = img.naturalWidth, h = img.naturalHeight, sc = Math.min(1, max / Math.max(w, h));
      var c = document.createElement("canvas"); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = function () { URL.revokeObjectURL(url); no(new Error("Can't read this photo")); };
    img.src = url;
  });
}

export async function listPhotos(sessionId, token) {
  var r = await fn("photos", { action: "list", token: token, device: S.device, session_id: sessionId });
  cache[sessionId] = r.photos || [];
  return cache[sessionId];
}

/* Grid of thumbnails + "Take photo" / "From gallery". onChange() after every add/delete. */
export function photoBlock(m, locked, onChange) {
  var cfg = S.cfg || {}, max = Number(cfg.photoMax) || 5, min = Number(cfg.photoMin) || 0;
  var wrap = el("div", { class: "photos" }), grid = el("div", { class: "pgrid" }), info = el("div", { class: "small muted", style: "margin:6px 0" }), err = el("div", { class: "small", style: "color:var(--bad)" });
  var pending = 0;
  function count() { return (cache[m.id] || []).length; }
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
    cam.disabled = gal.disabled = locked || n + pending >= max;
  }
  var inCam = el("input", { type: "file", accept: "image/*", capture: "environment", class: "hidden" });
  var inGal = el("input", { type: "file", accept: "image/*", multiple: true, class: "hidden" });
  var cam = el("button", { class: "btn", type: "button", text: "📷 Take photo", onclick: function () { inCam.click(); } });
  var gal = el("button", { class: "btn", type: "button", text: "🖼 From gallery", onclick: function () { inGal.click(); } });
  [inCam, inGal].forEach(function (inp) {
    inp.addEventListener("change", async function () {
      var files = Array.from(inp.files || []); inp.value = "";
      var room = max - count() - pending; files = files.slice(0, Math.max(0, room));
      if (!files.length) { err.textContent = "Maximum " + max + " photos."; return; }
      err.textContent = "";
      pending += files.length; draw();
      for (var i = 0; i < files.length; i++) {
        try {
          var data = await shrink(files[i]);
          var r = await fn("photos", { action: "upload", token: tokenFor(m.branch), device: S.device, session_id: m.id, image: data.split(",")[1] });
          (cache[m.id] = cache[m.id] || []).push(r.photo);
          m.photos = (cache[m.id] || []).length; backup();
        } catch (e) { err.textContent = e.code === "OFFLINE" ? "No connection - photo not sent. Try again when online." : errText(e); }
        pending--; draw(); onChange && onChange();
      }
    });
  });
  async function del(p) {
    try {
      await fn("photos", { action: "delete", token: tokenFor(m.branch), device: S.device, photo_id: p.id });
      cache[m.id] = (cache[m.id] || []).filter(function (x) { return x.id !== p.id; });
      m.photos = cache[m.id].length; backup(); draw(); onChange && onChange();
    } catch (e) { err.textContent = errText(e); }
  }
  wrap.append(info, grid, locked ? null : el("div", { class: "row", style: "margin-top:8px" }, cam, gal), inCam, inGal, err);
  draw();
  if (!cache[m.id] || cache[m.id].length !== (m.photos || 0)) {
    listPhotos(m.id, tokenFor(m.branch)).then(function () { m.photos = count(); draw(); onChange && onChange(); }, function (e) { if (m.photos) err.textContent = "Can't load photos: " + errText(e); });
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
