// Edge function "photos": warehouse photos for a count session.
// Checks the same PIN/password tokens as the database functions, then reads/writes the private "photos" bucket.
// Deployed with verify_jwt = false (the app has no Supabase user login; the token check below is the gate).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const BUCKET = "photos";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const body = await req.json();
    const action = String(body.action || "");

    const { data: tok } = await db.from("tokens").select("kind, branch, expires_at").eq("token", String(body.token || "")).maybeSingle();
    if (!tok || new Date(tok.expires_at) < new Date()) return json({ error: "AUTH: enter the branch PIN again" }, 403);
    const admin = tok.kind === "owner" || tok.kind === "finance";

    async function session(id: string) {
      const { data: s } = await db.from("count_sessions").select("id, take_id, branch, role, device_id, status").eq("id", id).maybeSingle();
      if (!s) throw new Error("GONE: this count was cleared.");
      if (!admin && (tok!.branch !== s.branch || s.device_id !== String(body.device || ""))) throw new Error("AUTH: not your count");
      return s;
    }
    async function signed(rows: { id: string; path: string }[]) {
      if (!rows.length) return [];
      const { data, error } = await db.storage.from(BUCKET).createSignedUrls(rows.map((r) => r.path), 3600);
      if (error) throw error;
      return rows.map((r, i) => ({ id: r.id, url: data![i].signedUrl }));
    }

    if (action === "list") {
      await session(String(body.session_id));
      const { data } = await db.from("session_photos").select("id, path").eq("session_id", body.session_id).order("created_at");
      return json({ photos: await signed(data || []) });
    }

    if (action === "upload") {
      const s = await session(String(body.session_id));
      if (s.status !== "counting") return json({ error: "This count is submitted. Ask Finance to reopen it to add photos." }, 400);
      const { data: mx } = await db.from("settings").select("value").eq("key", "photo_max").maybeSingle();
      const max = Number(mx?.value ?? 5);
      const { count } = await db.from("session_photos").select("id", { count: "exact", head: true }).eq("session_id", s.id);
      if ((count || 0) >= max) return json({ error: "Maximum " + max + " photos." }, 400);
      const b64 = String(body.image || "");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      if (bytes.length < 1000 || bytes.length > 3 * 1024 * 1024) return json({ error: "Photo too small or too large." }, 400);
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return json({ error: "Only JPEG photos." }, 400);
      const safe = s.branch.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const path = `${s.take_id}/${safe}/${s.id}/${crypto.randomUUID()}.jpg`;
      const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      const { data: row, error } = await db.from("session_photos").insert({ session_id: s.id, path }).select("id, path").single();
      if (error) throw error;
      await db.from("count_sessions").update({ updated_at: new Date().toISOString() }).eq("id", s.id);
      return json({ photo: (await signed([row]))[0] });
    }

    if (action === "delete") {
      const { data: p } = await db.from("session_photos").select("id, path, session_id").eq("id", String(body.photo_id)).maybeSingle();
      if (!p) return json({ ok: true });
      const s = await session(p.session_id);
      if (s.status !== "counting" && !admin) return json({ error: "This count is submitted." }, 400);
      await db.storage.from(BUCKET).remove([p.path]);
      await db.from("session_photos").delete().eq("id", p.id);
      return json({ ok: true });
    }

    if (action === "remove_paths") {
      if (tok.kind !== "owner") return json({ error: "AUTH: owner login needed" }, 403);
      const paths = (body.paths || []).map(String).filter((x: string) => /^[0-9a-f-]{36}\//.test(x));
      for (let i = 0; i < paths.length; i += 100) await db.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      return json({ ok: true, removed: paths.length });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return json({ error: m }, /^AUTH/.test(m) ? 403 : 400);
  }
});
