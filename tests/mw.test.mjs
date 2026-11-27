// My Warehouse tests: username + PIN login, HQ accounts, LSH. Run: node mw.test.mjs
import { setup, rpc, db } from "./server.mjs";
import assert from "node:assert/strict";

let pass = 0, fail = 0;
async function t(name, f) { try { await f(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n      ")); } }
async function rejects(p, re) { try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error("wrong error: " + e.message); return; } throw new Error("expected an error"); }
const q = (s, p) => db.query(s, p).then((r) => r.rows);
export async function setToday(d) { await q(`insert into public.settings (key, value) values ('test_today', $1::jsonb) on conflict (key) do update set value = excluded.value`, [JSON.stringify(d)]); }
export async function setNow(ts) { await q(`insert into public.settings (key, value) values ('test_now', $1::jsonb) on conflict (key) do update set value = excluded.value`, [JSON.stringify(ts)]); }

await setup();
await q(`insert into private.secrets (key, value, expires_at) values ('bootstrap_code', extensions.crypt('SETUP-123', extensions.gen_salt('bf')), now() + interval '1 day')`);
let OWNER = (await rpc("owner_bootstrap", { p_code: "SETUP-123", p_password: "OwnerPass1" })).token;
await q(`insert into public.branches (name, plants, active) values ('NDD Shah Alam', '{1503}', true), ('NDD Melaka', '{1502}', true), ('NDD Johor', '{1501}', true) on conflict (name) do update set plants = excluded.plants`);
await q(`update public.branches set login_mode = 'people' where name in ('NDD Shah Alam', 'NDD Melaka')`);

let OM, OMPIN, LO, LOPIN, KEY, OMTOK, LOTOK, SUPER;
const login = (u, pin) => rpc("user_login", { p_user: u, p_pin: pin });
console.log("people and username login");
await t("HQ adds an Ops Manager and an LO: 6-digit temp PINs, usernames from name + plant; names unique per NDD", async () => {
  const om = await rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Shah Alam", p_id: null, p_name: "Aisyah", p_username: "", p_roles: ["om", "admin"] });
  assert.equal(om.tempPin.length, 6); assert.equal(om.username, "aisyah.1503"); OM = om.id; OMPIN = om.tempPin;
  const lo = await rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Shah Alam", p_id: null, p_name: "Ravi K", p_username: "Ravi.SA", p_roles: ["lo"] });
  assert.equal(lo.tempPin.length, 6); assert.equal(lo.username, "ravi.sa"); LO = lo.id; LOPIN = lo.tempPin;
  await rejects(rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Shah Alam", p_id: null, p_name: "ravi k", p_username: "", p_roles: ["lo"] }), /already has that name/);
  await rejects(rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Melaka", p_id: null, p_name: "Ravi M", p_username: "ravi.sa", p_roles: ["lo"] }), /taken/);
  await rejects(rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Shah Alam", p_id: null, p_name: "Bad", p_username: "has space", p_roles: ["lo"] }), /no spaces/);
  await rejects(rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Shah Alam", p_id: null, p_name: "X", p_username: "", p_roles: ["boss"] }), /at least one role/);
});
await t("plant code and supervisor PIN no longer open a people-login NDD; the old device sign-in is closed", async () => {
  const r = await rpc("plant_login", { p_code: "1503" }); assert.equal(r.ok, false); assert.equal(r.people, true);
  assert.equal((await rpc("plant_login", { p_code: "1501" })).ok, true);
  const [g] = await q(`select has_function_privilege('anon', 'public.device_setup_start(text)', 'execute') a, has_function_privilege('anon', 'public.user_login(text, text)', 'execute') b`);
  assert.equal(g.a, false); assert.equal(g.b, true);
});
await t("username login (any case): first time must change PIN; weak or the temporary PIN refused", async () => {
  assert.equal((await login("nobody", "123456")).ok, false);
  const r = await login("RAVI.sa", LOPIN); assert.equal(r.ok, true); assert.equal(r.mustChange, true); assert.equal(r.person.username, "ravi.sa"); LOTOK = r.token;
  await rejects(rpc("person_set_pin", { p_token: LOTOK, p_pin: "111111" }), /6 digits/);
  await rejects(rpc("person_set_pin", { p_token: LOTOK, p_pin: "123456" }), /6 digits/);
  await rejects(rpc("person_set_pin", { p_token: LOTOK, p_pin: "4820" }), /6 digits/);
  await rejects(rpc("person_set_pin", { p_token: LOTOK, p_pin: LOPIN }), /not the temporary/);
  await rpc("person_set_pin", { p_token: LOTOK, p_pin: "482061" }); LOPIN = "482061";
  const o = await login("aisyah.1503", OMPIN); OMTOK = o.token;
  await rpc("person_set_pin", { p_token: OMTOK, p_pin: "739214" }); OMPIN = "739214";
  const [tk] = await q(`select sup, person_id, device_id from public.tokens where token = $1`, [OMTOK]); assert.equal(tk.sup, true, "OM token has supervisor rights"); assert.equal(tk.device_id, null);
  const [tl] = await q(`select sup from public.tokens where token = $1`, [LOTOK]); assert.equal(tl.sup, false);
  const me = await rpc("wh_me", { p_token: LOTOK }); assert.equal(me.person.name, "Ravi K"); assert.equal(me.stockTake, null);
});
await t("5 wrong PINs lock for 15 minutes; OM unlocks", async () => {
  for (let i = 0; i < 4; i++) assert.equal((await login("ravi.sa", "999999")).left, 4 - i);
  const r = await login("ravi.sa", "999999"); assert.ok(r.lockedUntil);
  assert.ok((await login("ravi.sa", LOPIN)).lockedUntil, "right PIN still locked");
  await rejects(rpc("wh_person_unlock", { p_token: LOTOK, p_id: LO }), /Ops Manager/);
  await rpc("wh_person_unlock", { p_token: OMTOK, p_id: LO });
  LOTOK = (await login("ravi.sa", LOPIN)).token; assert.ok(LOTOK);
  await q(`delete from public.login_attempts`);
});
await t("OM manages own NDD's people but not Ops Managers or other NDDs", async () => {
  const a = await rpc("wh_person_save", { p_token: OMTOK, p_branch: "NDD Shah Alam", p_id: null, p_name: "Siti", p_username: "", p_roles: ["admin", "sup"] }); assert.equal(a.tempPin.length, 6);
  await rejects(rpc("wh_person_save", { p_token: OMTOK, p_branch: "NDD Shah Alam", p_id: null, p_name: "Boss", p_username: "", p_roles: ["om"] }), /only HQ/);
  await rejects(rpc("wh_people", { p_token: OMTOK, p_branch: "NDD Melaka" }), /Ops Manager or HQ/);
  const r = await rpc("wh_person_reset", { p_token: OMTOK, p_id: a.id }); assert.equal(r.tempPin.length, 6); assert.equal(r.username, "siti.1503");
  await rejects(rpc("wh_person_reset", { p_token: OMTOK, p_id: OM }), /HQ resets/);
  await rejects(rpc("wh_people", { p_token: LOTOK, p_branch: "NDD Shah Alam" }), /Ops Manager or HQ/);
});
await t("acting OM set by HQ gives the om role until the date", async () => {
  const s = (await rpc("wh_people", { p_token: OWNER, p_branch: "NDD Shah Alam" })).find((p) => p.name === "Siti");
  await setToday("2026-12-05");
  await rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Shah Alam", p_id: s.id, p_name: "Siti", p_username: s.username, p_roles: ["admin", "sup"], p_active: true, p_acting_om_until: "2026-12-10" });
  let x = (await rpc("wh_people", { p_token: OWNER, p_branch: "NDD Shah Alam" })).find((p) => p.name === "Siti"); assert.ok(x.roles.includes("om"));
  await setToday("2026-12-11");
  x = (await rpc("wh_people", { p_token: OWNER, p_branch: "NDD Shah Alam" })).find((p) => p.name === "Siti"); assert.ok(!x.roles.includes("om"));
  await q(`delete from public.settings where key = 'test_today'`);
});
await t("switched-off person loses access; an NDD moved back to the plant code refuses usernames", async () => {
  const z = await rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Shah Alam", p_id: null, p_name: "Temp", p_username: "", p_roles: ["lo"] });
  const zt = (await login(z.username, z.tempPin)).token; assert.ok(zt);
  await rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Shah Alam", p_id: z.id, p_name: "Temp", p_username: z.username, p_roles: ["lo"], p_active: false });
  await rejects(rpc("person_set_lang", { p_token: zt, p_lang: "ms" }), /sign in again/);
  assert.equal((await login(z.username, z.tempPin)).ok, false);
  const m = await rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Johor", p_id: null, p_name: "Jo", p_username: "", p_roles: ["lo"] });
  const r = await login(m.username, m.tempPin); assert.equal(r.ok, false); assert.equal(r.plant, true);
});
await t("monthly stock take: Admin/Sup/OM open counting for helpers; an LO can't", async () => {
  await rejects(rpc("person_join_take", { p_token: OMTOK }), /no stock take open/);
  await rejects(rpc("person_join_take", { p_token: LOTOK }), /role/);
});

console.log("HQ accounts");
await t("shared owner password can only make the first superadmin", async () => {
  await rejects(rpc("hq_user_save", { p_token: OWNER, p_id: null, p_email: "fin@nabati.my", p_name: "Fin", p_role: "finance" }), /first superadmin/);
  const s = await rpc("hq_user_save", { p_token: OWNER, p_id: null, p_email: "Hafiz@Nabati.my", p_name: "Hafiz", p_role: "superadmin" });
  assert.ok(s.tempPassword); assert.equal(s.email, "hafiz@nabati.my");
  await rejects(rpc("hq_user_save", { p_token: OWNER, p_id: null, p_email: "x@nabati.my", p_name: "X", p_role: "superadmin" }), /superadmin login/);
  const l = await rpc("hq_login", { p_email: "hafiz@nabati.my", p_password: s.tempPassword }); assert.equal(l.kind, "owner"); assert.equal(l.mustChange, true); SUPER = l.token;
  await rpc("hq_set_password", { p_token: SUPER, p_old: s.tempPassword, p_new: "Hafiz-pass-1" });
  assert.equal((await rpc("hq_login", { p_email: "hafiz@nabati.my", p_password: "wrong" })).ok, false);
});
await t("superadmin adds a finance account; finance gets a finance token; shared login can be switched off", async () => {
  const f = await rpc("hq_user_save", { p_token: SUPER, p_id: null, p_email: "fin@nabati.my", p_name: "Fin", p_role: "finance" });
  const l = await rpc("hq_login", { p_email: "fin@nabati.my", p_password: f.tempPassword }); assert.equal(l.kind, "finance");
  await rejects(rpc("hq_users_list", { p_token: l.token }), /superadmin/);
  assert.equal((await rpc("hq_users_list", { p_token: SUPER })).length, 2);
  await rpc("hq_shared_login", { p_token: SUPER, p_on: false });
  assert.equal((await rpc("admin_login", { p_password: "OwnerPass1" })).disabled, true);
  await rejects(rpc("admin_lsh_branch", { p_token: OWNER, p_branch: "NDD Johor", p_login_mode: "plant", p_lsh: false, p_cutoff: "" }), /owner|admin|AUTH|log in/i);
  await rpc("hq_shared_login", { p_token: SUPER, p_on: true });
  OWNER = (await rpc("admin_login", { p_password: "OwnerPass1" })).token;
  const me = await rpc("hq_me", { p_token: SUPER }); assert.equal(me.user.role, "superadmin");
});


const ids = () => ({ OM, LO, OMTOK, LOTOK, OMPIN, LOPIN, SUPER });
console.log("LSH");
const sum = (bal, area) => bal[area] || 0;
let SNAP1;
async function snap(date, rows, loadedAt) {
  await setNow(loadedAt);
  const byBr = {}, byBrBad = {};
  rows.forEach(([code, q, bad]) => { const g = bad ? byBrBad : byBr; (g["NDD Shah Alam"] = g["NDD Shah Alam"] || []).push([code, "", q, "", bad ? "BS00" : "MW00"]); });
  await rpc("admin_load_daily", { p_token: OWNER, p_date: date, p_payload: { meta: {}, byBr, byBrBad } });
  const [r] = await q(`select id from public.snapshots where snap_date = $1`, [date]); return r.id;
}
await q(`insert into public.skus (code, descr, per, per_box) values ('A1', 'Wafer A', 200, 20), ('B2', 'Roll B', 60, 6), ('C3', 'Snack C', 24, null) on conflict (code) do update set per = excluded.per, per_box = excluded.per_box`);
const I = () => ids();
await t("LSH needs people login; HQ switches it on with a 16:00 cut-off", async () => {
  await rejects(rpc("admin_lsh_branch", { p_token: OWNER, p_branch: "NDD Johor", p_login_mode: "plant", p_lsh: true, p_cutoff: "16:00" }), /name and PIN/);
  await rpc("admin_lsh_branch", { p_token: OWNER, p_branch: "NDD Shah Alam", p_login_mode: "people", p_lsh: true, p_cutoff: "16:00" });
  assert.equal((await rpc("lsh_today", { p_token: I().LOTOK })).started, false);
});
await t("opening stock from the 30 Nov MB52 (good and bad)", async () => {
  await setToday("2026-11-30");
  SNAP1 = await snap("2026-11-30", [["A1", 2000], ["A1", 100, true], ["B2", 600]], "2026-11-30T17:05:00+08:00");
  await setToday("2026-12-01"); await setNow("2026-12-01T00:00:00+08:00");
  const r = await rpc("admin_lsh_reset", { p_token: OWNER, p_branch: "NDD Shah Alam", p_source: "snapshot", p_ref: SNAP1, p_at: "2026-12-01T00:00:00+08:00" });
  assert.equal(r.lines, 3);
  const d = await rpc("lsh_today", { p_token: I().LOTOK }); assert.equal(d.byCode.A1.gs, 2000); assert.equal(d.byCode.A1.bs, 100); assert.equal(d.day, "2026-12-01");
});
await t("goods received (damaged line to bad stock), invoices to staging, a truck loaded", async () => {
  await setNow("2026-12-01T09:00:00+08:00");
  await rejects(rpc("lsh_add", { p_token: I().LOTOK, p: { type: "receive", doc: "", lines: [{ code: "A1", qty: 400 }] } }), /document number/);
  await rejects(rpc("lsh_add", { p_token: I().LOTOK, p: { type: "receive", doc: "DO800", lines: [{ code: "ZZ", qty: 1 }] } }), /Unknown SKU/);
  await rpc("lsh_add", { p_token: I().LOTOK, p: { type: "receive", doc: "DO800", lines: [{ code: "A1", qty: 400 }, { code: "B2", qty: 60, area: "bs" }] } });
  await rpc("lsh_add", { p_token: I().LOTOK, p: { type: "invoice", doc: "INV1", lines: [{ code: "A1", qty: 200 }, { code: "B2", qty: 120 }] } });
  await rpc("lsh_add", { p_token: I().LOTOK, p: { type: "invoice", doc: "INV2", lines: [{ code: "A1", qty: 100 }] } });
  await rejects(rpc("lsh_load", { p_token: I().LOTOK, p_docs: ["NOPE"] }), /Nothing waits/);
  await rpc("lsh_load", { p_token: I().LOTOK, p_docs: ["INV1"] });
  const d = await rpc("lsh_today", { p_token: I().LOTOK });
  assert.equal(d.byCode.A1.gs, 2100); assert.equal(d.byCode.A1.stg, 100); assert.equal(d.byCode.B2.gs, 480); assert.equal(d.byCode.B2.bs, 60);
  assert.deepEqual(d.staging.map((x) => [x.doc, x.waiting]), [["INV2", 100]]);
});
await t("failed delivery: at most what went out; reversal back to good stock, redeliver out again", async () => {
  await rejects(rpc("lsh_add", { p_token: I().LOTOK, p: { type: "fail_back", doc: "INV1", reason: "outlet_closed", lines: [{ code: "A1", qty: 250 }] } }), /Only 200/);
  await rejects(rpc("lsh_add", { p_token: I().LOTOK, p: { type: "fail_back", doc: "INV1", lines: [{ code: "A1", qty: 50 }] } }), /why it came back/);
  const inv = await rpc("lsh_invoice", { p_token: I().LOTOK, p_doc: "INV1" }); assert.equal(inv.find((x) => x.code === "A1").canFail, 200);
  await rpc("lsh_add", { p_token: I().LOTOK, p: { type: "fail_back", doc: "INV1", reason: "outlet_closed", lines: [{ code: "A1", qty: 50 }] } });
  let d = await rpc("lsh_today", { p_token: I().LOTOK }); const inv1 = d.staging.find((x) => x.doc === "INV1"); assert.equal(inv1.failed, 50); assert.equal(inv1.reason, "outlet_closed");
  await rejects(rpc("lsh_add", { p_token: I().LOTOK, p: { type: "reversal", doc: "INV1", lines: [{ code: "A1", qty: 30 }] } }), /reversal number/);
  await rpc("lsh_add", { p_token: I().LOTOK, p: { type: "reversal", doc: "INV1", ref: "REV9", lines: [{ code: "A1", qty: 30 }] } });
  await rejects(rpc("lsh_add", { p_token: I().LOTOK, p: { type: "redeliver", doc: "INV1", lines: [{ code: "A1", qty: 25 }] } }), /Only 20/);
  await rpc("lsh_add", { p_token: I().LOTOK, p: { type: "redeliver", doc: "INV1", lines: [{ code: "A1", qty: 20 }] } });
  d = await rpc("lsh_today", { p_token: I().LOTOK }); assert.equal(d.byCode.A1.gs, 2130); assert.equal(d.byCode.A1.stg, 100); assert.ok(!d.staging.find((x) => x.doc === "INV1"));
});
await t("undo: own entry within 10 minutes only; negative stock is recorded and flagged", async () => {
  const r = await rpc("lsh_add", { p_token: I().LOTOK, p: { type: "to_bs", note: "crushed", lines: [{ code: "B2", qty: 600 }] } });
  assert.equal(r.negative[0].code, "B2"); assert.equal(r.negative[0].qty, -120);
  await rejects(rpc("lsh_undo", { p_token: I().OMTOK, p_entry: r.entry }), /only who saved it/);
  await rpc("lsh_undo", { p_token: I().LOTOK, p_entry: r.entry });
  const d = await rpc("lsh_today", { p_token: I().LOTOK }); assert.equal(d.byCode.B2.gs, 480);
  assert.equal(d.entries.find((e) => e.entry === r.entry).status, "undone");
});
await t("correction: the asker can't approve it; the OM approves; OM's own goes to HQ", async () => {
  const c = await rpc("lsh_correct", { p_token: I().LOTOK, p: { reason: "Typed 10 too many on DO800", lines: [{ code: "A1", qty: -10, area: "gs" }] } });
  let d = await rpc("lsh_today", { p_token: I().OMTOK }); assert.equal(d.pending.length, 1); assert.equal(d.byCode.A1.gs, 2130, "pending doesn't count yet");
  await rejects(rpc("lsh_decide", { p_token: I().LOTOK, p_entry: c.entry, p_ok: true }), /Ops Manager or HQ/);
  await rpc("lsh_decide", { p_token: I().OMTOK, p_entry: c.entry, p_ok: true });
  d = await rpc("lsh_today", { p_token: I().OMTOK }); assert.equal(d.byCode.A1.gs, 2120);
  const c2 = await rpc("lsh_correct", { p_token: I().OMTOK, p: { reason: "x", lines: [{ code: "B2", qty: 1, area: "gs" }] } });
  await rejects(rpc("lsh_decide", { p_token: I().OMTOK, p_entry: c2.entry, p_ok: true }), /someone else/);
  await rpc("lsh_decide", { p_token: OWNER, p_entry: c2.entry, p_ok: false });
});
await t("close the day: OM only, PIN again; an entry after close counts for the next working day", async () => {
  await setNow("2026-12-01T15:50:00+08:00");
  await rejects(rpc("lsh_close_day", { p_token: I().LOTOK, p_pin: I().LOPIN }), /role/);
  await rejects(rpc("lsh_close_day", { p_token: I().OMTOK, p_pin: "000000" }), /Wrong PIN/);
  const r = await rpc("lsh_close_day", { p_token: I().OMTOK, p_pin: I().OMPIN }); assert.equal(r.late, false); assert.equal(r.day, "2026-12-01");
  await setNow("2026-12-01T16:30:00+08:00");
  const a = await rpc("lsh_add", { p_token: I().LOTOK, p: { type: "receive", doc: "DO801", lines: [{ code: "A1", qty: 200 }] } }); assert.equal(a.day, "2026-12-02");
  await rejects(rpc("lsh_undo", { p_token: I().LOTOK, p_entry: (await q(`select entry_id from public.lsh_moves where doc_no = 'INV2' limit 1`))[0].entry_id }), /10 minutes|closed/);
});
await t("evening MB52: compared area by area, staging left out; due in 24 h", async () => {
  await snap("2026-12-01", [["A1", 2120], ["A1", 100, true], ["B2", 500], ["B2", 60, true], ["C3", 30]], "2026-12-01T17:00:00+08:00");
  const r = await rpc("admin_lsh_recon", { p_token: OWNER, p_branch: "NDD Shah Alam", p_day: null });
  const row = (c, a) => r.rows.find((x) => x.code === c && x.area === a);
  assert.equal(r.day, "2026-12-01");
  assert.equal(row("A1", "gs").status, "match"); assert.equal(row("A1", "bs").status, "match"); assert.equal(row("B2", "bs").status, "match");
  assert.equal(row("B2", "gs").diff, -20); assert.equal(row("B2", "gs").status, "open");
  assert.equal(row("C3", "gs").diff, -30);
  assert.ok(!r.rows.find((x) => x.area === "stg"));
  const today = await rpc("lsh_today", { p_token: I().OMTOK }); assert.equal(today.diffs.length, 2);
});
await t("a morning MB52 (before the cut-off) doesn't build a comparison", async () => {
  await setToday("2026-12-02");
  await snap("2026-12-02", [["A1", 1]], "2026-12-02T08:00:00+08:00");
  assert.equal((await q(`select count(*)::int n from public.lsh_recon where day = '2026-12-02'`))[0].n, 0);
});
await t("OM gives a reason; the same difference next day keeps it and its first day", async () => {
  await rpc("lsh_reason", { p_token: I().OMTOK, p_branch: "NDD Shah Alam", p_day: "2026-12-01", p_code: "B2", p_area: "gs", p_reason: "sap", p_note: "GR not posted" });
  await rejects(rpc("lsh_reason", { p_token: I().LOTOK, p_branch: "NDD Shah Alam", p_day: "2026-12-01", p_code: "C3", p_area: "gs", p_reason: "sap", p_note: "" }), /Ops Manager or HQ/);
  await setNow("2026-12-02T15:59:00+08:00");
  await rpc("lsh_close_day", { p_token: I().OMTOK, p_pin: I().OMPIN });
  await snap("2026-12-02", [["A1", 2320], ["A1", 100, true], ["B2", 500], ["B2", 60, true], ["C3", 30]], "2026-12-02T17:00:00+08:00");
  const r = await rpc("admin_lsh_recon", { p_token: OWNER, p_branch: "NDD Shah Alam", p_day: "2026-12-02" });
  const b2 = r.rows.find((x) => x.code === "B2" && x.area === "gs"); assert.equal(b2.status, "explained"); assert.equal(b2.reason, "sap"); assert.equal(b2.since, "2026-12-01");
  const c3 = r.rows.find((x) => x.code === "C3"); assert.equal(c3.status, "open"); assert.equal(c3.since, "2026-12-01");
  assert.equal(r.rows.find((x) => x.code === "A1" && x.area === "gs").status, "match");
});
await t("a day nobody closed is closed by the app next day, marked late", async () => {
  await setToday("2026-12-04"); await setNow("2026-12-04T08:00:00+08:00");
  const d = await rpc("lsh_today", { p_token: I().LOTOK }); assert.equal(d.day, "2026-12-04");
  const [x] = await q(`select late, auto, closed_by_name from public.lsh_days where branch = 'NDD Shah Alam' and day = '2026-12-03'`);
  assert.equal(x.late, true); assert.equal(x.auto, true);
  const o = await rpc("admin_lsh", { p_token: OWNER }); const sa = o.branches.find((b) => b.branch === "NDD Shah Alam");
  assert.equal(sa.onTime.days, 3); assert.equal(sa.onTime.late, 1);
});
await t("reset to a closed stock take sets only the SKUs it counted", async () => {
  const [tk] = await q(`insert into public.stock_takes (name, status, kind, stock_type, scope, closed_at) values ('Dec count', 'closed', 'monthly', 'good', 'total', now()) returning id`);
  await q(`insert into public.count_log (take_id, branch, code, count_date, kind, sys_q, phys_q) values ($1, 'NDD Shah Alam', 'A1', '2026-12-04', 'monthly', 2320, 2300)`, [tk.id]);
  await rpc("admin_lsh_reset", { p_token: OWNER, p_branch: "NDD Shah Alam", p_source: "take", p_ref: tk.id, p_at: null });
  const d = await rpc("lsh_today", { p_token: I().LOTOK }); assert.equal(d.byCode.A1.gs, 2300); assert.equal(d.byCode.B2.gs, 480);
});
await t("roles: an LO can't read people or reasons; an Admin (counter) can't record movements", async () => {
  const s = await rpc("wh_person_save", { p_token: OWNER, p_branch: "NDD Shah Alam", p_id: null, p_name: "Nur", p_username: "", p_roles: ["admin"] });
  const tok = (await rpc("user_login", { p_user: s.username, p_pin: s.tempPin })).token;
  await rejects(rpc("lsh_add", { p_token: tok, p: { type: "receive", doc: "X", lines: [{ code: "A1", qty: 1 }] } }), /role/);
  await q(`delete from public.settings where key in ('test_today', 'test_now')`);
});

await t("an evening MB52 doesn't replace the stock a morning daily count compares with", async () => {
  await setToday("2026-12-05"); await setNow("2026-12-05T08:00:00+08:00");
  const sid = await snap("2026-12-05", [["A1", 500]], "2026-12-05T08:00:00+08:00");
  const [tk] = await q(`insert into public.stock_takes (name, status, kind, branch, count_date, snap_id, skus, stock_type, scope) values ('Daily', 'open', 'daily', 'NDD Shah Alam', '2026-12-05', $1, '{A1}', 'good', 'partial') returning id`, [sid]);
  await q(`insert into public.sys_stock (take_id, branch, code, batch, qty) values ($1, 'NDD Shah Alam', 'A1', '', 500)`, [tk.id]);
  await snap("2026-12-05", [["A1", 9999]], "2026-12-05T17:00:00+08:00");
  const [x] = await q(`select qty from public.sys_stock where take_id = $1`, [tk.id]); assert.equal(Number(x.qty), 500);
  await snap("2026-12-05", [["A1", 777]], "2026-12-05T09:00:00+08:00");
  const [y] = await q(`select qty from public.sys_stock where take_id = $1`, [tk.id]); assert.equal(Number(y.qty), 777, "a re-upload during the window still refreshes it");
  await q(`delete from public.stock_takes where id = $1`, [tk.id]);
  await q(`delete from public.settings where key in ('test_today', 'test_now')`);
});

export { OWNER };
if (process.argv[1].endsWith("mw.test.mjs")) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
