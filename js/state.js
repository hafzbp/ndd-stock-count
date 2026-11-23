/* Shared state, local backup, saving and syncing of this phone's counts. */
import { rpc } from "./api.js";
import { pill, nowIso, msg, toast } from "./ui.js";
import { hasQty } from "./pure.js";

export var S = {
  cfg: null,                 // public_config()
  device: "",
  tokens: {},                // branch -> PIN token
  admin: null,               // {token, kind: 'owner'|'finance'}
  skus: null, barcodes: {}, team: [],
  br: {},                    // branch -> {codes, batches, recount}
  mine: { takeId: null, resetId: null, sessions: {}, active: null },
  recount: {},               // branch -> ["code|batch"]
  take: null,                // {id,name,status,scope,skuCount,resetId}
  tab: "count", step: "", q: "", filter: "todo", open: {},
  saving: false, timer: null, saveErr: null,
  adm: null, mBranch: "", mOnly: true
};

export var hooks = { render: function () { }, renderCountOnly: function () { }, needPin: null, openLogin: null };

function ls(k, v) {
  try { if (v === undefined) { var x = localStorage.getItem(k); return x ? JSON.parse(x) : null; } if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; }
}
export var store = ls;

export function loadLocal() {
  var d = ls("ndd2-device");
  if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)); ls("ndd2-device", d); }
  S.device = d;
  S.tokens = ls("ndd2-tokens") || {};
  S.admin = ls("ndd2-admin");
  var m = ls("ndd2-mine"); if (m && m.sessions) S.mine = m;
  var mc = ls("ndd2-master"); if (mc) { S.skus = mc.skus; S.barcodes = mc.barcodes || {}; S.team = mc.team || []; }
  var bc = ls("ndd2-br"); if (bc) S.br = bc;
}
export function backup() { ls("ndd2-mine", S.mine); }
export function saveTokens() { ls("ndd2-tokens", S.tokens); ls("ndd2-admin", S.admin); }

export function isAdmin() { return !!(S.admin && S.admin.token); }
export function isOwner() { return !!(S.admin && S.admin.kind === "owner"); }
export function tokenFor(br) { return isAdmin() ? S.admin.token : S.tokens[br]; }
export function allTokens() { var t = Object.keys(S.tokens).map(function (b) { return S.tokens[b]; }); if (isAdmin()) t.push(S.admin.token); return t; }

export function cur() { var m = S.mine; return (m && m.active && m.sessions[m.active]) || null; }

export function dataOf(m) {
  return { member: m.member || "", names: m.names || [], countedBy: m.countedBy || "", lines: m.lines || {}, extraSkus: m.extraSkus || [],
    sign: m.sign || null, startedAt: m.startedAt || "", unknownBarcodes: m.unknownBarcodes || {} };
}
export function fromServer(s) {
  var d = s.data || {};
  return { id: s.id, branch: s.branch, role: s.role, member: d.member || "", names: d.names || [], countedBy: d.countedBy || "",
    lines: d.lines || {}, extraSkus: d.extraSkus || [], sign: d.sign || null, startedAt: d.startedAt || s.startedAt, unknownBarcodes: d.unknownBarcodes || {},
    status: s.status, submittedAt: s.submittedAt, reopenedAt: s.reopenedAt, updatedAt: s.updatedAt, photos: s.photos || 0, dirty: false };
}

/* Merge what the server says about this phone's sessions. Returns true if something visible changed. */
export function applySync(res) {
  var changed = false, t = res.take;
  if (t) {
    if (!S.take || S.take.status !== t.status || S.take.scope !== t.scope) changed = true;
    S.take = t;
    if (!S.mine.takeId) { S.mine.takeId = t.id; S.mine.resetId = t.resetId; }
    else if (S.mine.takeId !== t.id || S.mine.resetId !== t.resetId) {
      /* another stock take (next day, after logout, new monthly): forget counts that are already on the server,
         but keep changes not uploaded yet - they go up when this warehouse logs in again */
      var keep = {}, onSrv = {}; (res.sessions || []).forEach(function (x) { onSrv[x.id] = 1; });
      Object.keys(S.mine.sessions).forEach(function (k) { if (S.mine.sessions[k].dirty || onSrv[k]) keep[k] = S.mine.sessions[k]; });
      if (Object.keys(S.mine.sessions).length !== Object.keys(keep).length) changed = true;
      /* the count in progress belongs to the new stock take (started just now on this phone): keep it active */
      S.mine = { takeId: t.id, resetId: t.resetId, sessions: keep, active: keep[S.mine.active] ? S.mine.active : null };
    }
  }
  var seen = {};
  (res.sessions || []).forEach(function (s) {
    seen[s.id] = 1;
    var loc = S.mine.sessions[s.id];
    if (loc && loc.dirty && s.status === "counting") {
      if (loc.status !== s.status) changed = true;
      loc.status = s.status; loc.photos = s.photos; loc.submittedAt = s.submittedAt;
      return;
    }
    var n = fromServer(s);
    if (!loc || loc.status !== n.status || loc.updatedAt !== n.updatedAt || loc.photos !== n.photos) changed = true;
    S.mine.sessions[s.id] = n;
  });
  /* sessions the server no longer has, for branches this phone can still see */
  var open = {}; Object.keys(S.tokens).forEach(function (b) { open[b] = 1; });
  Object.keys(S.mine.sessions).forEach(function (id) {
    var x = S.mine.sessions[id];
    if (!seen[id] && !x.dirty && (isAdmin() || open[x.branch])) { delete S.mine.sessions[id]; changed = true; if (S.mine.active === id) { S.mine.active = null; if (!isAdmin()) S.goneNote = true; } }
  });
  var rc = res.recount || {};
  if (JSON.stringify(rc) !== JSON.stringify(S.recount)) changed = true;
  S.recount = rc;
  backup();
  return changed;
}

export async function sync() {
  var toks = allTokens(); if (!toks.length) return false;
  var res = await rpc("counter_sync", { p_tokens: toks, p_device: S.device });
  return applySync(res);
}

/* ---------- saving ---------- */
export function touch() {
  var c = cur(); if (!c) return;
  c.updatedAt = nowIso(); c.dirty = true; backup(); schedule(); syncPill();
}
export function schedule(ms) { clearTimeout(S.timer); S.timer = setTimeout(flush, ms == null ? 900 : ms); }

export async function flush() {
  if (S.saving) { schedule(500); return; }
  var dirty = Object.keys(S.mine.sessions).map(function (k) { return S.mine.sessions[k]; }).filter(function (x) { return x.dirty; });
  if (!dirty.length) { syncPill(); return; }
  S.saving = true; syncPill();
  for (var i = 0; i < dirty.length; i++) {
    var m = dirty[i], tok = tokenFor(m.branch), stamp = m.updatedAt;
    if (!tok && S.mine.active !== m.id) continue;
    if (!tok) { S.saving = false; S.saveErr = "PIN"; syncPill(); if (hooks.needPin) hooks.needPin(m.branch); return; }
    try {
      var r = await rpc("counter_save", { p_token: tok, p_device: S.device, p_id: m.id, p_data: dataOf(m) });
      if (m.updatedAt === stamp) m.dirty = false;
      m.photos = r.session.photos;
      if (!r.ok) {
        var srv = fromServer(r.session); m.dirty = false;
        if (srv.status === "submitted") { S.mine.sessions[m.id] = srv; toast("This count is submitted, it can't be changed now."); }
        else if (r.closed) { S.mine.sessions[m.id] = srv; toast("Counting is closed."); }
        hooks.render();
      }
      S.saveErr = null;
    } catch (e) {
      S.saving = false;
      if (e.code === "AUTH") { delete S.tokens[m.branch]; saveTokens(); S.saveErr = "PIN"; syncPill(); if (hooks.needPin) hooks.needPin(m.branch); return; }
      if (e.code === "GONE") { delete S.mine.sessions[m.id]; if (S.mine.active === m.id) S.mine.active = null; backup(); msg("Count removed", "HQ deleted this count. Start again from the plant code."); hooks.render(); return; }
      S.saveErr = e.code || "ERR"; syncPill(); schedule(3000 + Math.random() * 3000); return;
    }
  }
  S.saving = false; backup(); syncPill();
  if (Object.keys(S.mine.sessions).some(function (k) { var x = S.mine.sessions[k]; return x.dirty && tokenFor(x.branch); })) schedule(400);
}

export function anyDirty() { return Object.keys(S.mine.sessions).some(function (k) { return S.mine.sessions[k].dirty; }); }
export function syncPill() {
  if (S.saveErr === "PIN") return pill("Plant code needed to save", "bad");
  if (S.saveErr) return pill("Offline - kept on phone", "warn");
  var dz = Object.keys(S.mine.sessions).map(function (k) { return S.mine.sessions[k]; }).filter(function (x) { return x.dirty; });
  if (S.saving || dz.some(function (x) { return tokenFor(x.branch); })) return pill("Saving…");
  if (dz.length) return pill("Kept on phone", "warn");
  if (!Object.keys(S.mine.sessions).length) return pill("Online", "ok");
  pill("All saved ✓", "ok");
}

export function sessHasQty(x) { return Object.keys(x.lines || {}).some(function (j) { return hasQty(x.lines[j]); }); }
