/* All server calls go through here. */
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

function fail(message, code, status) { var e = new Error(message); e.code = code; e.status = status; return e; }

/* code: OFFLINE | AUTH | LOCKED | PHOTOS | NOT_ALLOWED | GONE | ERROR */
function classify(m) {
  var c = /^([A-Z_ ]+):/.exec(m || "");
  if (!c) return "ERROR";
  return c[1].trim().replace(/ /g, "_");
}
function clean(m) { return String(m || "").replace(/^[A-Z_ ]+:\s*/, ""); }

export async function rpc(name, args) {
  var r;
  try {
    r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(args || {})
    });
  } catch (e) { throw fail("No connection to the server.", "OFFLINE", 0); }
  var txt = await r.text(), body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = txt; }
  if (!r.ok) {
    var m = (body && body.message) || ("Server error " + r.status);
    if (r.status >= 500 || r.status === 0 || r.status === 503 || r.status === 520) throw fail("Server busy. Try again.", "OFFLINE", r.status);
    throw fail(clean(m), classify(m), r.status);
  }
  return body;
}

export async function fn(name, body) {
  var r;
  try {
    r = await fetch(SUPABASE_URL + "/functions/v1/" + name, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  } catch (e) { throw fail("No connection to the server.", "OFFLINE", 0); }
  var j = null; try { j = await r.json(); } catch (e) { }
  if (!r.ok || (j && j.error)) {
    var m = (j && j.error) || ("Server error " + r.status);
    throw fail(clean(m), classify(m), r.status);
  }
  return j;
}
