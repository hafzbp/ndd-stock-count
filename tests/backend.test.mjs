// Backend tests against the real SQL (PGlite). Run: node backend.test.mjs
import { setup, rpc, db } from "./server.mjs";
import { parseMB52, variance } from "../js/pure.js";
import assert from "node:assert/strict";

let pass = 0, fail = 0;
async function t(name, f) { try { await f(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e.stack || e).toString().split("\n").slice(0, 3).join("\n      ")); } }
async function rejects(p, re) { try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error("wrong error: " + e.message); return; } throw new Error("expected an error"); }

await setup();
await db.query(`insert into private.secrets (key, value, expires_at) values ('bootstrap_code', extensions.crypt('SETUP-123', extensions.gen_salt('bf')), now() + interval '1 day')`);
let OWNER, FIN, TA, TA2, TB;
const DEV1 = "dev-ops-1", DEV2 = "dev-fin-1", DEV3 = "dev-ops-2";

console.log("auth");
await t("bootstrap rejects wrong code", async () => { const r = await rpc("owner_bootstrap", { p_code: "nope", p_password: "OwnerPass1" }); assert.equal(r.ok, false); });
await t("bootstrap sets owner password once", async () => {
  const r = await rpc("owner_bootstrap", { p_code: "SETUP-123", p_password: "OwnerPass1" }); assert.equal(r.ok, true); assert.equal(r.kind, "owner"); OWNER = r.token;
  const again = await rpc("owner_bootstrap", { p_code: "SETUP-123", p_password: "Other1234" }); assert.equal(again.ok, false);
});
await t("owner login works, wrong password fails", async () => {
  assert.equal((await rpc("admin_login", { p_password: "bad" })).ok, false);
  const r = await rpc("admin_login", { p_password: "OwnerPass1" }); assert.equal(r.kind, "owner");
});
await t("owner sets finance password; finance logs in", async () => {
  await rpc("owner_set_password", { p_token: OWNER, p_which: "finance", p_password: "FinPass9" });
  const r = await rpc("admin_login", { p_password: "FinPass9" }); assert.equal(r.kind, "finance"); FIN = r.token;
});
await t("finance cannot use owner-only functions", async () => { await rejects(rpc("owner_set_password", { p_token: FIN, p_which: "finance", p_password: "xxxxxx" }), /owner/); await rejects(rpc("owner_backup", { p_token: FIN }), /owner/); });
await t("no token cannot load admin data", async () => { await rejects(rpc("admin_load", { p_token: "junk" }), /Finance login/); });
await t("anon cannot read tables or private helpers", async () => {
  for (const s of ["select * from public.tokens", "select * from public.branches", "select private.cur_take()", "select * from private.secrets"]) {
    await rejects(db.transaction(async (tx) => { await tx.exec("set local role anon"); await tx.query(s); }), /permission denied/);
  }
});

console.log("setup");
await t("save branches + team", async () => {
  await rpc("admin_save_team", { p_token: FIN, p_branches: ["NDD Alpha", "NDD Beta"], p_team: [{ name: "Ali", branch: "NDD Alpha", role: "Counter" }, { name: "Siti", branch: "NDD Alpha", role: "Checker" }, { name: "Ghost", branch: "NDD Nowhere", role: "Counter" }] });
  const a = await rpc("admin_load", { p_token: FIN });
  assert.deepEqual(a.branches.map((b) => b.name), ["NDD Alpha", "NDD Beta"]); assert.equal(a.team.length, 2);
  assert.deepEqual((await rpc("public_config", {})).branches, ["NDD Alpha", "NDD Beta"]);
});
await t("PINs: validation + save", async () => {
  await rejects(rpc("admin_save_pins", { p_token: FIN, p_pins: { "NDD Alpha": "12a" } }), /4-6 digits/);
  await rpc("admin_save_pins", { p_token: FIN, p_pins: { "NDD Alpha": "1111", "NDD Beta": "" } });
});
await t("PIN login: wrong / right / blank-PIN branch", async () => {
  assert.equal((await rpc("pin_login", { p_branch: "NDD Alpha", p_pin: "2222" })).ok, false);
  TA = (await rpc("pin_login", { p_branch: "NDD Alpha", p_pin: "1111" })).token; assert.ok(TA);
  TA2 = (await rpc("pin_login", { p_branch: "NDD Alpha", p_pin: "1111" })).token;
  TB = (await rpc("pin_login", { p_branch: "NDD Beta", p_pin: "" })).token; assert.ok(TB);
});
await t("branch token can't open another branch", async () => { await rejects(rpc("counter_branch", { p_token: TB, p_branch: "NDD Alpha" }), /PIN/); });

const H = ["Plant", "Name 1", "Material", "Material Description", "Storage Location", "Descr. of Storage Loc.", "Batch", "Unrestricted", "Value Unrestricted", "Restricted-Use Stock", "Value Restricted", "Quality Inspection", "Value in QualInsp.", "Blocked Stock", "Value BlockedStock", "Stock in Transit", "Value in Transit"];
const rows = [["junk"], H,
  ["1501", "NDD Alpha", "A1", "Wafer A", "MW00", "Main", "20270315", 240, 240, 0, 0, 0, 0, 5, 5, 0, 0],
  ["1501", "NDD Alpha", "A1", "Wafer A", "MW01", "Main2", "15/03/2027", 24, 24, 0, 0, 0, 0, 0, 0, 0, 0],
  ["1501", "NDD Alpha", "A1", "Wafer A", "MW00", "Main", "20270501", 120, 120, 0, 0, 0, 0, 0, 0, 0, 0],
  ["1501", "NDD Alpha", "B2", "Roll B", "MW00", "Main", "", 100, 50, 0, 0, 0, 0, 0, 0, 0, 0],
  ["1501", "NDD Alpha", "C3", "Snack C", "MW00", "Main", "20261201", 60, 60, 0, 0, 0, 0, 0, 0, 0, 0],
  ["1501", "NDD Alpha", "D4", "Choc D", "MW00", "Main", "20270101", 1000, 1000, 0, 0, 0, 0, 0, 0, 0, 0],
  ["1501", "NDD Alpha", "A1", "Wafer A", "BS00", "Bad", "20270315", 99, 99, 0, 0, 0, 0, 0, 0, 0, 0],
  ["1502", "NDD Beta", "A1", "Wafer A", "MW00", "Main", "20270315", 48, 48, 0, 0, 0, 0, 0, 0, 0, 0],
  ["1599", "NDD Gamma", "A1", "Wafer A", "MW00", "Main", "20270315", 10, 10, 0, 0, 0, 0, 0, 0, 0, 0]];
let parsed;
await t("MB52 parse + load", async () => {
  parsed = parseMB52(rows, ["NDD Alpha", "NDD Beta"]);
  assert.equal(parsed.lines, 6); assert.equal(parsed.exBadQ, 99); assert.ok(parsed.skipped["1599 NDD Gamma"]);
  await rpc("admin_load_mb52", { p_token: FIN, p_payload: { meta: { goodV: parsed.totV, goodQ: parsed.totQ }, byBr: parsed.byBr, descs: parsed.descs } });
  const a = await rpc("admin_load", { p_token: FIN });
  assert.equal(a.sys["NDD Alpha"].length, 5); assert.equal(a.skus.find((s) => s.code === "A1").desc, "Wafer A");
});
await t("factors: carton/box, new code added", async () => {
  const n = await rpc("admin_save_skus", { p_token: FIN, p_items: [{ code: "A1", per: 24 }, { code: "B2", per: 50, perBox: 10 }, { code: "C3", per: 12 }, { code: "Z9", per: 6 }] });
  assert.equal(n, 4);
  const a = await rpc("admin_load", { p_token: FIN }); const b2 = a.skus.find((s) => s.code === "B2");
  assert.equal(b2.per, 50); assert.equal(b2.perBox, 10); assert.equal(b2.desc, "Roll B");
  await rpc("admin_save_skus", { p_token: FIN, p_items: [{ code: "B2", perBox: 5 }] });
  const b3 = (await rpc("admin_load", { p_token: FIN })).skus.find((s) => s.code === "B2"); assert.equal(b3.per, 50); assert.equal(b3.perBox, 5);
  await rpc("admin_save_skus", { p_token: FIN, p_items: [{ code: "B2", perBox: 10 }] });
});
await t("barcodes: upload, uom check, replace", async () => {
  const n = await rpc("admin_save_barcodes", { p_token: FIN, p_rows: [{ barcode: "8993175536707", code: "A1", uom: "PCS" }, { barcode: "18993175536704", code: "A1", uom: "ctn" }, { barcode: "x", code: "A1", uom: "BAG" }], p_replace: false });
  assert.equal(n, 2);
  const m = await rpc("counter_master", { p_token: TA }); assert.equal(m.barcodes["18993175536704"].uom, "CTN"); assert.equal(m.barcodes["8993175536707"].code, "A1");
});
await t("counter_branch: codes + batch months, no quantities", async () => {
  const b = await rpc("counter_branch", { p_token: TA, p_branch: "NDD Alpha" });
  assert.deepEqual(b.codes.sort(), ["A1", "B2", "C3", "D4"]); assert.deepEqual(b.batches.A1.sort(), ["2027-03", "2027-05"]); assert.deepEqual(b.batches.B2, [""]);
  assert.ok(!JSON.stringify(b).includes("240"));
});

console.log("counting");
let SO, SF, SO2;
await t("ops starts on phone 1, fin on phone 2", async () => {
  SO = await rpc("counter_start", { p_token: TA, p_device: DEV1, p_branch: "NDD Alpha", p_role: "ops", p_data: { member: "Ali", names: ["Ali"], lines: {} } });
  SF = await rpc("counter_start", { p_token: TA2, p_device: DEV2, p_branch: "NDD Alpha", p_role: "fin", p_data: { member: "Siti", names: ["Siti"], lines: {} } });
  assert.ok(SO.id && SF.id && SO.id !== SF.id);
});
const L = (code, batch, ctn, box, pcs, remark) => ({ code, batch, ctn, box, pcs, remark: remark || "" });
const opsLines = {
  "A1|2027-03": L("A1", "2027-03", 11, null, 0),     // 264 = sys 264
  "A1|2027-05": L("A1", "2027-05", 5, null, 0),      // 120 = sys
  "B2|": L("B2", "", 1, 4, 10),                       // 50+40+10 = 100; fin 99 -> RECOUNT
  "C3|2026-12": L("C3", "2026-12", 0, null, 0),      // 0, fin blank -> MATCH 0 (sys 60, OVER)
  "Z9|": L("Z9", "", null, null, 6),                  // not in system; fin same -> NOT IN SYSTEM
  "Q1|": L("Q1", "", 2, null, null, "Damaged"),       // no factor -> NEEDS PCS FACTOR
};
const finLines = {
  "A1|2027-03": L("A1", "2027-03", null, null, 264),
  "A1|2027-05": L("A1", "2027-05", null, null, 120),
  "B2|": L("B2", "", null, null, 99),
  "Z9|": L("Z9", "", 1, null, null),
  "D4|2027-01": L("D4", "2027-01", null, null, 990),  // ops blank -> WAITING OPS
};
await t("save counts; same role on 2nd phone allowed", async () => {
  let r = await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { member: "Ali", names: ["Ali"], lines: opsLines } }); assert.equal(r.ok, true);
  r = await rpc("counter_save", { p_token: TA2, p_device: DEV2, p_id: SF.id, p_data: { member: "Siti", names: ["Siti"], lines: finLines } }); assert.equal(r.ok, true);
  SO2 = await rpc("counter_start", { p_token: TA, p_device: DEV3, p_branch: "NDD Alpha", p_role: "ops", p_data: { member: "Bob", names: ["Bob"], lines: {} } });
});
await t("other phone can't write my session", async () => { await rejects(rpc("counter_save", { p_token: TA, p_device: DEV3, p_id: SO.id, p_data: {} }), /Not your count/); });
await t("same phone can't do the other role once it has counts", async () => {
  await rejects(rpc("counter_start", { p_token: TA, p_device: DEV1, p_branch: "NDD Alpha", p_role: "fin", p_data: {} }), /NOT ALLOWED/);
});
await t("counter_sync returns only this phone's sessions", async () => {
  const s = await rpc("counter_sync", { p_tokens: [TA], p_device: DEV1 }); assert.equal(s.sessions.length, 1); assert.equal(s.sessions[0].id, SO.id);
  const sb = await rpc("counter_sync", { p_tokens: [TB], p_device: DEV1 }); assert.equal(sb.sessions.length, 0);
});

let jsV;
await t("SQL variance == JS variance (status, agreed, var, SKU result)", async () => {
  const a = await rpc("admin_load", { p_token: FIN });
  const sm = {}; a.skus.forEach((s) => (sm[s.code] = s));
  const docs = a.sessions.filter((s) => s.branch === "NDD Alpha").map((s) => ({ role: s.role, lines: s.data.lines, names: s.data.names, member: s.data.member, extraSkus: [] }));
  jsV = variance(a.sys["NDD Alpha"], docs, sm, 2);
  const sq = (await db.query(`select * from private.variance((select (value #>> '{}')::uuid from public.settings where key='current_take')) where branch = 'NDD Alpha' order by code, batch`)).rows;
  const norm = (f) => String(f || "").replace(/ 2%$/, "");
  assert.equal(sq.length, jsV.length, "row count");
  for (const o of jsV) {
    const r = sq.find((x) => x.code === o.code && x.batch === o.batch); assert.ok(r, "missing " + o.code + "|" + o.batch);
    assert.equal(r.status, o.status, o.code + " status");
    assert.equal(r.phys == null ? null : Number(r.phys), o.phys, o.code + " phys");
    assert.equal(r.v == null ? null : Number(r.v), o.v, o.code + " v");
    assert.equal(norm(r.sku_flag), norm(o.skuFlag), o.code + " sku flag");
  }
  const st = Object.fromEntries(jsV.map((o) => [o.code + "|" + o.batch, o.status]));
  assert.deepEqual(st, { "A1|2027-03": "MATCH", "A1|2027-05": "MATCH", "B2|": "RECOUNT", "C3|2026-12": "MATCH", "D4|2027-01": "WAITING OPS", "Q1|": "NEEDS PCS FACTOR", "Z9|": "MATCH" });
  assert.equal(jsV.skuGroups.C3.flag, "OVER 2%"); assert.equal(jsV.skuGroups.Z9.flag, "NOT IN SYSTEM"); assert.equal(jsV.skuGroups.A1.flag, "OK");
});

console.log("photos + submit + recount");
await t("submit blocked without 3 photos", async () => { await rejects(rpc("counter_submit", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { lines: opsLines } }), /at least 3/); });
await t("submit ok with 3 photos; then saves are refused", async () => {
  for (let i = 0; i < 3; i++) await db.query(`insert into public.session_photos (session_id, path) values ($1, 'x/' || $2)`, [SO.id, String(i)]);
  const r = await rpc("counter_submit", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { member: "Ali", names: ["Ali"], lines: opsLines, sign: { Ali: { img: "data:x", at: "t" } } } });
  assert.equal(r.session.status, "submitted"); assert.equal(r.session.photos, 3);
  const s = await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { lines: {} } }); assert.equal(s.ok, false); assert.equal(s.session.status, "submitted");
  assert.equal(Object.keys(s.session.data.lines).length, 6);
});
await t("photo rule: Finance-only exempt when roles = [ops]", async () => {
  await rpc("admin_settings", { p_token: FIN, p_patch: { photo_roles: ["ops"] } });
  const r = await rpc("counter_submit", { p_token: TA2, p_device: DEV2, p_id: SF.id, p_data: { member: "Siti", names: ["Siti"], lines: finLines } }); assert.equal(r.session.status, "submitted");
  await rpc("admin_settings", { p_token: FIN, p_patch: { photo_roles: ["ops", "fin"] } });
});
await t("recount reopens submitted sessions and shows items", async () => {
  const n = await rpc("admin_send_recount", { p_token: FIN, p_branch: "NDD Alpha", p_items: ["B2|", "D4|2027-01"] }); assert.equal(n, 2);
  const s = await rpc("counter_sync", { p_tokens: [TA], p_device: DEV1 }); assert.equal(s.sessions[0].status, "counting"); assert.deepEqual(s.recount["NDD Alpha"], ["B2|", "D4|2027-01"]);
});
await t("reopen single session", async () => {
  await db.query(`update public.count_sessions set status = 'submitted' where id = $1`, [SF.id]);
  await rpc("admin_reopen", { p_token: FIN, p_id: SF.id });
  assert.equal((await db.query(`select status from public.count_sessions where id = $1`, [SF.id])).rows[0].status, "counting");
});

console.log("closing + dashboard");
await t("close counting blocks counters, not Finance", async () => {
  await rpc("admin_settings", { p_token: FIN, p_patch: { closed: true } });
  const r = await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { member: "Ali", lines: opsLines } }); assert.equal(r.ok, false); assert.equal(r.closed, true);
  await rejects(rpc("counter_start", { p_token: TB, p_device: DEV1, p_branch: "NDD Beta", p_role: "ops", p_data: {} }), /closed/);
  const r2 = await rpc("counter_save", { p_token: FIN, p_device: "finance-pc", p_id: SO.id, p_data: { member: "Ali", names: ["Ali"], lines: opsLines } }); assert.equal(r2.ok, true);
});
await t("dashboard: progress level hides variance", async () => {
  const d = await rpc("public_dashboard", {}); const a = d.branches.find((b) => b.branch === "NDD Alpha");
  assert.equal(d.showVariance, false); assert.equal(a.variance, null); assert.equal(a.expected, 4);
  assert.equal(a.opsDone, 3); assert.equal(a.finDone, 3); assert.equal(a.ops, "counting");
  const b = d.branches.find((x) => x.branch === "NDD Beta"); assert.equal(b.ops, "not_started");
});
await t("dashboard: qty level shows PCS, no RM; value level shows RM", async () => {
  await rpc("admin_settings", { p_token: FIN, p_patch: { dash_level: "qty" } });
  let d = await rpc("public_dashboard", {}), a = d.branches.find((b) => b.branch === "NDD Alpha");
  assert.equal(d.showVariance, true); assert.equal(a.variance.recount, 1); assert.equal(a.variance.varRM, null);
  const jsVar = jsV.filter((o) => o.v != null).reduce((s, o) => s + o.v, 0); assert.equal(Number(a.variance.varQ), jsVar);
  await rpc("admin_settings", { p_token: FIN, p_patch: { dash_level: "value" } });
  d = await rpc("public_dashboard", {}); a = d.branches.find((b) => b.branch === "NDD Alpha"); assert.ok(a.variance.varRM != null);
  await rejects(rpc("admin_settings", { p_token: FIN, p_patch: { dash_level: "everything" } }), /level/);
  await rejects(rpc("admin_settings", { p_token: FIN, p_patch: { hack: 1 } }), /Unknown setting/);
});

console.log("owner tools");
await t("changing a PIN logs that branch out", async () => {
  await rpc("admin_save_pins", { p_token: FIN, p_pins: { "NDD Alpha": "4444" } });
  await rejects(rpc("counter_branch", { p_token: TA, p_branch: "NDD Alpha" }), /PIN/);
  await rpc("counter_branch", { p_token: TB, p_branch: "NDD Beta" });
});
await t("backup has everything", async () => { const b = await rpc("owner_backup", { p_token: OWNER }); assert.equal(b.count_sessions.length, 3); assert.ok(b.sys_stock.length >= 6); });
await t("clear counts wipes sessions + returns photo paths + new resetId", async () => {
  const before = (await rpc("public_config", {})).take.resetId;
  const r = await rpc("owner_clear_counts", { p_token: OWNER }); assert.equal(r.sessions, 3); assert.equal(r.paths.length, 3);
  const after = (await rpc("public_config", {})).take.resetId; assert.notEqual(before, after);
  await rejects(rpc("counter_save", { p_token: FIN, p_device: DEV1, p_id: SO.id, p_data: {} }), /GONE/);
});
await t("new stock take: old kept, new is current and open", async () => {
  const old = (await rpc("public_config", {})).take.id;
  const id = await rpc("owner_new_take", { p_token: OWNER, p_name: "Dec 2026" });
  const c = await rpc("public_config", {}); assert.equal(c.take.id, id); assert.equal(c.take.closed, false);
  const a = await rpc("admin_load", { p_token: FIN }); assert.equal(a.takes.length, 2); assert.deepEqual(a.sys, {});
  await rpc("owner_set_take", { p_token: OWNER, p_take: old }); assert.equal((await rpc("public_config", {})).take.id, old);
  await rpc("owner_set_take", { p_token: OWNER, p_take: id });
});
await t("finance password change logs finance out", async () => {
  await rpc("owner_set_password", { p_token: OWNER, p_which: "finance", p_password: "NewFin77" });
  await rejects(rpc("admin_load", { p_token: FIN }), /Finance login/);
});
await t("10 wrong PINs lock the branch for 15 minutes", async () => {
  await db.query("delete from public.login_attempts");
  for (let i = 0; i < 10; i++) assert.equal((await rpc("pin_login", { p_branch: "NDD Alpha", p_pin: "0000" })).ok, false);
  await rejects(rpc("pin_login", { p_branch: "NDD Alpha", p_pin: "4444" }), /LOCKED/);
  await db.query("update public.login_attempts set at = now() - interval '16 minutes'");
  assert.equal((await rpc("pin_login", { p_branch: "NDD Alpha", p_pin: "4444" })).ok, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
