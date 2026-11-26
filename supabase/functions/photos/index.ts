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
      if (!admin) return json({ error: "AUTH: admin login needed" }, 403);
      let paths = (body.paths || []).map(String).filter((x: string) => /^[0-9a-f-]{36}\//.test(x));
      // only files of counts that are already deleted (HQ deleted a count or reset the stock take).
      // path = take id / branch / session id / photo.jpg
      const sid = (x: string) => x.split("/")[2] || "";
      const ids = [...new Set(paths.map(sid))].filter((x) => /^[0-9a-f-]{36}$/.test(x));
      const live = new Set<string>();
      for (let i = 0; i < ids.length; i += 100) {
        const { data } = await db.from("count_sessions").select("id").in("id", ids.slice(i, i + 100));
        (data || []).forEach((r: { id: string }) => live.add(r.id));
      }
      paths = paths.filter((x: string) => /^[0-9a-f-]{36}$/.test(sid(x)) && !live.has(sid(x)));
      for (let i = 0; i < paths.length; i += 100) await db.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      return json({ ok: true, removed: paths.length });
    }

    // ---- signed sign-off copies (admin only): private "signoffs" bucket, path = take id / branch slug / random.pdf
    if (action.startsWith("signed_")) {
      if (!admin) return json({ error: "AUTH: admin login needed" }, 403);
      const SB = "signoffs", takeId = String(body.take_id || "");
      if (!/^[0-9a-f-]{36}$/.test(takeId)) return json({ error: "Bad stock take" }, 400);
      const { data: tk } = await db.from("stock_takes").select("id, status").eq("id", takeId).maybeSingle();
      if (action === "signed_purge") {           // the stock take was deleted: remove its files
        if (tk) return json({ error: "Stock take still exists" }, 400);
        const { data: dirs } = await db.storage.from(SB).list(takeId, { limit: 1000 });
        const paths: string[] = [];
        for (const d of dirs || []) { const { data: fs } = await db.storage.from(SB).list(takeId + "/" + d.name, { limit: 1000 }); (fs || []).forEach((f) => paths.push(takeId + "/" + d.name + "/" + f.name)); }
        if (paths.length) await db.storage.from(SB).remove(paths);
        return json({ ok: true, removed: paths.length });
      }
      if (!tk) return json({ error: "GONE: this stock take was deleted." }, 400);
      if (action === "signed_list") {
        const { data: rows } = await db.from("signed_copies").select("branch, path, file_name, size, uploaded_at, uploaded_by").eq("take_id", takeId).order("branch");
        if (!rows || !rows.length) return json({ copies: [] });
        const { data: urls, error } = await db.storage.from(SB).createSignedUrls(rows.map((r) => r.path), 3600, body.download ? { download: true } : undefined);
        if (error) throw error;
        return json({ copies: rows.map((r, i) => ({ branch: r.branch, name: r.file_name, size: r.size, at: r.uploaded_at, by: r.uploaded_by, url: urls![i].signedUrl })) });
      }
      const branch = String(body.branch || "");
      const { data: br } = await db.from("branches").select("name").eq("name", branch).maybeSingle();
      if (!br) return json({ error: "Unknown warehouse: " + branch }, 400);
      if (action === "signed_upload") {         // step 1: a one-time upload URL; the browser PUTs the PDF straight to storage
        const size = Number(body.size || 0);
        if (!(size > 100) || size > 50 * 1024 * 1024) return json({ error: "PDF is empty or bigger than 50 MB." }, 400);
        const path = `${takeId}/${branch.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/${crypto.randomUUID()}.pdf`;
        const { data, error } = await db.storage.from(SB).createSignedUploadUrl(path);
        if (error) throw error;
        return json({ path, url: data.signedUrl });
      }
      if (action === "signed_commit") {         // step 2: record it (replaces the warehouse's earlier copy)
        const path = String(body.path || "");
        if (!path.startsWith(takeId + "/") || !/\.pdf$/.test(path)) return json({ error: "Bad path" }, 400);
        const dir = path.slice(0, path.lastIndexOf("/")), fname = path.slice(path.lastIndexOf("/") + 1);
        const { data: fs } = await db.storage.from(SB).list(dir, { search: fname });
        const f = (fs || []).find((x) => x.name === fname);
        if (!f) return json({ error: "The upload didn't arrive. Try again." }, 400);
        const { data: old } = await db.from("signed_copies").select("path").eq("take_id", takeId).eq("branch", branch).maybeSingle();
        const name = String(body.name || "signed.pdf").slice(0, 200);
        const { error } = await db.from("signed_copies").upsert({ take_id: takeId, branch, path, file_name: name, size: Number(f.metadata?.size || body.size || 0), uploaded_at: new Date().toISOString(), uploaded_by: tok.kind });
        if (error) throw error;
        if (old && old.path !== path) await db.storage.from(SB).remove([old.path]);
        return json({ ok: true });
      }
      if (action === "signed_delete") {
        const { data: old } = await db.from("signed_copies").select("path").eq("take_id", takeId).eq("branch", branch).maybeSingle();
        if (old) { await db.storage.from(SB).remove([old.path]); await db.from("signed_copies").delete().eq("take_id", takeId).eq("branch", branch); }
        return json({ ok: true });
      }
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return json({ error: m }, /^AUTH/.test(m) ? 403 : 400);
  }
});
