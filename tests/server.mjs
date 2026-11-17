// Local test backend: runs the real sql/*.sql in PGlite (Postgres in WASM) and imitates
// Supabase's /rest/v1/rpc/<fn> (as role anon) and the "photos" edge function.
// Usage:  cd tests && npm i && node server.mjs   → open http://localhost:8787/?api=local
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8787);
export const db = new PGlite({ extensions: { pgcrypto } });

export async function setup() {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema extensions; create extension pgcrypto with schema extensions;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);`);
  for (const f of fs.readdirSync(path.join(ROOT, "sql")).filter((x) => /^\d+[a-z]?_.*\.sql$/.test(x)).sort()) await db.exec(fs.readFileSync(path.join(ROOT, "sql", f), "utf8"));
  const r = await db.query(`select p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
  for (const row of r.rows) {
    sig[row.proname] = {};
    for (const part of row.args.split(",").map((s) => s.trim()).filter(Boolean)) { const [n, ...t] = part.split(" "); sig[row.proname][n] = t.join(" "); }
  }
}
const sig = {};

export async function rpc(name, args, role = "anon") {
  if (!sig[name]) throw Object.assign(new Error("function not found"), { status: 404 });
  const names = Object.keys(args || {}), vals = [], parts = [];
  names.forEach((n, i) => {
    const t = sig[name][n]; if (!t) throw Object.assign(new Error("unknown arg " + n), { status: 400 });
    let v = args[n]; if (t === "jsonb") v = v == null ? null : JSON.stringify(v);
    vals.push(v); parts.push(`${n} => $${i + 1}::${t}`);
  });
  return await db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    const r = await tx.query(`select public.${name}(${parts.join(", ")}) as r`, vals);
    return r.rows[0].r;
  });
}

const files = new Map(); // storage path -> Buffer
async function photos(body) {
  const q = (s, p) => db.query(s, p).then((r) => r.rows);
  const [tok] = await q(`select kind, branch, expires_at from public.tokens where token = $1`, [String(body.token || "")]);
  if (!tok || new Date(tok.expires_at) < new Date()) return [403, { error: "AUTH: enter the branch PIN again" }];
  const admin = tok.kind === "owner" || tok.kind === "finance";
  async function session(id) {
    const [s] = await q(`select id, take_id, branch, role, device_id, status from public.count_sessions where id = $1`, [id]);
    if (!s) throw new Error("GONE: this count was cleared.");
    if (!admin && (tok.branch !== s.branch || s.device_id !== String(body.device || ""))) throw new Error("AUTH: not your count");
    return s;
  }
  const url = (p) => "data:image/jpeg;base64," + (files.get(p) || Buffer.alloc(0)).toString("base64");
  try {
    if (body.action === "list") { await session(body.session_id); const rows = await q(`select id, path from public.session_photos where session_id = $1 order by created_at`, [body.session_id]); return [200, { photos: rows.map((r) => ({ id: r.id, url: url(r.path) })) }]; }
    if (body.action === "upload") {
      const s = await session(body.session_id);
      if (s.status !== "counting") return [400, { error: "This count is submitted. Ask Finance to reopen it to add photos." }];
      const [mx] = await q(`select value from public.settings where key = 'photo_max'`);
      const [{ n }] = await q(`select count(*)::int as n from public.session_photos where session_id = $1`, [s.id]);
      if (n >= Number(mx.value)) return [400, { error: "Maximum " + mx.value + " photos." }];
      const buf = Buffer.from(String(body.image || ""), "base64");
      if (buf.length < 1000 || buf.length > 3 * 1024 * 1024) return [400, { error: "Photo too small or too large." }];
      if (!(buf[0] === 0xff && buf[1] === 0xd8)) return [400, { error: "Only JPEG photos." }];
      const p = `${s.take_id}/${s.branch.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/${s.id}/${crypto.randomUUID()}.jpg`;
      files.set(p, buf);
      const [row] = await q(`insert into public.session_photos (session_id, path) values ($1, $2) returning id, path`, [s.id, p]);
      return [200, { photo: { id: row.id, url: url(row.path) } }];
    }
    if (body.action === "delete") {
      const [p] = await q(`select id, path, session_id from public.session_photos where id = $1`, [body.photo_id]);
      if (!p) return [200, { ok: true }];
      const s = await session(p.session_id);
      if (s.status !== "counting" && !admin) return [400, { error: "This count is submitted." }];
      files.delete(p.path); await q(`delete from public.session_photos where id = $1`, [p.id]); return [200, { ok: true }];
    }
    if (body.action === "remove_paths") { if (tok.kind !== "owner") return [403, { error: "AUTH: owner login needed" }]; (body.paths || []).forEach((p) => files.delete(p)); return [200, { ok: true }]; }
    return [400, { error: "Unknown action" }];
  } catch (e) { return [/^AUTH/.test(e.message) ? 403 : 400, { error: e.message }]; }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml" };
export function serve() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "POST" && (u.pathname.startsWith("/rest/v1/rpc/") || u.pathname === "/functions/v1/photos")) {
      let raw = ""; for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader("Content-Type", "application/json");
      if (u.pathname === "/functions/v1/photos") { const [st, out] = await photos(body); res.writeHead(st); res.end(JSON.stringify(out)); return; }
      try { const r = await rpc(u.pathname.slice(13), body); res.writeHead(200); res.end(JSON.stringify(r)); }
      catch (e) { res.writeHead(e.status || (/AUTH|LOCKED/.test(e.message) ? 403 : 400)); res.end(JSON.stringify({ message: e.message, code: e.code })); }
      return;
    }
    let p = path.join(ROOT, decodeURIComponent(u.pathname)); if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
    if (!fs.existsSync(p)) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(p).pipe(res);
  }).listen(PORT);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await setup();
  if (process.env.BOOTSTRAP_CODE) await db.query(`insert into private.secrets (key, value, expires_at) values ('bootstrap_code', extensions.crypt($1, extensions.gen_salt('bf')), now() + interval '7 days')`, [process.env.BOOTSTRAP_CODE]);
  serve(); console.log("ready on http://localhost:" + PORT + "/?api=local");
}
