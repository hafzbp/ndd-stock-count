// Backend tests against the real SQL (PGlite). Run: node backend.test.mjs
import { setup, rpc, db } from "./server.mjs";
import { parseMB52, variance, mb52Names } from "../js/pure.js";
import assert from "node:assert/strict";

let pass = 0, fail = 0;
async function t(name, f) { try { await f(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + "\n      " + (e.stack || e).toString().split("\n").slice(0, 3).join("\n      ")); } }
async function rejects(p, re) { try { await p; } catch (e) { if (re && !re.test(e.message)) throw new Error("wrong error: " + e.message); return; } throw new Error("expected an error"); }

await setup();
await db.query(`insert into private.secrets (key, value, expires_at) values ('bootstrap_code', extensions.crypt('SETUP-123', extensions.gen_salt('bf')), now() + interval '1 day')`);
let OWNER, ADM, TA, TA2, TB;
const DEV1 = "dev-ops-1", DEV2 = "dev-fin-1", DEV3 = "dev-ops-2";

console.log("auth");
await t("bootstrap: wrong code rejected, right code once", async () => {
  assert.equal((await rpc("owner_bootstrap", { p_code: "nope", p_password: "OwnerPass1" })).ok, false);
  const r = await rpc("owner_bootstrap", { p_code: "SETUP-123", p_password: "OwnerPass1" }); assert.equal(r.kind, "owner"); OWNER = r.token;
  assert.equal((await rpc("owner_bootstrap", { p_code: "SETUP-123", p_password: "Other1234" })).ok, false);
});
await t("owner sets admin password; admin logs in; wrong password fails", async () => {
  assert.equal((await rpc("admin_login", { p_password: "bad" })).ok, false);
  await rpc("owner_set_password", { p_token: OWNER, p_which: "finance", p_password: "AdmPass9" });
  ADM = (await rpc("admin_login", { p_password: "AdmPass9" })).token; assert.ok(ADM);
});
await t("admin can't use owner-only functions", async () => { await rejects(rpc("owner_set_password", { p_token: ADM, p_which: "finance", p_password: "xxxxxx" }), /owner/); await rejects(rpc("owner_backup", { p_token: ADM }), /owner/); });
await t("no token can't load admin data; old PIN login is gone", async () => {
  await rejects(rpc("admin_load", { p_token: "junk" }), /login/);
  await rejects(rpc("pin_login", { p_branch: "x", p_pin: "1" }), /permission denied/);
});
await t("anon can't read tables or private helpers", async () => {
  for (const s of ["select * from public.tokens", "select * from public.branches", "select private.cur_take()", "select * from private.secrets", "select * from private.scoped_sys(gen_random_uuid())"]) {
    await rejects(db.transaction(async (tx) => { await tx.exec("set local role anon"); await tx.query(s); }), /permission denied/);
  }
});

console.log("draft setup");
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
  ["1509", "NDD Beta", "C3", "Snack C", "MW00", "Main", "20261201", 12, 12, 0, 0, 0, 0, 0, 0, 0, 0],
  ["1599", "NDD Gamma", "A1", "Wafer A", "MW00", "Main", "20270315", 10, 10, 0, 0, 0, 0, 0, 0, 0, 0]];
function mb52Payload(branches) {
  const res = parseMB52(rows, branches), plants = {};
  rows.slice(2).forEach((r) => { if (res.byBr[r[1]]) { (plants[r[1]] = plants[r[1]] || []); if (!plants[r[1]].includes(r[0])) plants[r[1]].push(r[0]); } });
  return { meta: { goodV: res.totV }, byBr: res.byBr, byBrBad: res.byBrBad, descs: res.descs, plants };
}
await t("first take is a draft; admin names it (Total)", async () => {
  const c = await rpc("public_config", {}); assert.equal(c.take.status, "draft");
  const d = await rpc("admin_draft", { p_token: ADM, p_name: "Test count", p_scope: "total", p_skus: [] }); assert.equal(d.name, "Test count"); assert.equal(d.status, "draft");
});
await t("can't open before MB52", async () => { await rejects(rpc("admin_set_status", { p_token: ADM, p_status: "open" }), /MB52/); });
await t("MB52 load: branches added, plant codes stored (1 branch can have 2 plants)", async () => {
  await rpc("admin_add_branches", { p_token: ADM, p_branches: ["NDD Alpha", "NDD Beta"] });
  await rpc("admin_load_mb52", { p_token: ADM, p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) });
  const a = await rpc("admin_load", { p_token: ADM });
  assert.deepEqual(a.branches.find((b) => b.name === "NDD Alpha").plants, ["1501"]);
  assert.deepEqual(a.branches.find((b) => b.name === "NDD Beta").plants.sort(), ["1502", "1509"]);
  assert.equal(a.sys["NDD Alpha"].length, 5);
});
await t("good or bad stock: parser keeps bad-stock locations apart; changing the kind in a draft clears the loaded MB52", async () => {
  const res = parseMB52(rows, ["NDD Alpha", "NDD Beta"]);
  assert.deepEqual(res.byBrBad, { "NDD Alpha": [["A1", "2027-03", 99, 1, "BS00"]] });
  assert.ok(!res.byBr["NDD Alpha"].some((r) => r[4] === "BS00")); assert.equal(res.badLines, 1); assert.equal(res.badQ, 99);
  let tk = (await rpc("admin_load", { p_token: ADM })).takeInfo; assert.equal(tk.stockType, "good");
  await rejects(rpc("admin_set_stock_type", { p_token: ADM, p_type: "ugly" }), /good or bad/);
  tk = await rpc("admin_set_stock_type", { p_token: ADM, p_type: "good" }); assert.equal(tk.stockType, "good");
  assert.ok(Number((await db.query("select count(*) from public.sys_stock where take_id = $1", [tk.id])).rows[0].count) > 0, "same kind keeps the MB52");
  tk = await rpc("admin_set_stock_type", { p_token: ADM, p_type: "bad" }); assert.equal(tk.stockType, "bad");
  assert.equal(Number((await db.query("select count(*) from public.sys_stock where take_id = $1", [tk.id])).rows[0].count), 0);
  assert.equal(Number((await db.query("select count(*) from public.mb52_meta where take_id = $1", [tk.id])).rows[0].count), 0);
  await rpc("admin_load_mb52", { p_token: ADM, p_payload: { meta: { stockType: "bad" }, byBr: res.byBrBad, descs: res.descs, plants: {} } });
  assert.deepEqual((await db.query("select code, qty::int as qty, sloc from public.sys_stock where take_id = $1", [tk.id])).rows, [{ code: "A1", qty: 99, sloc: "BS00" }]);
  await rpc("admin_set_stock_type", { p_token: ADM, p_type: "good" });
  await rpc("admin_load_mb52", { p_token: ADM, p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) });
  assert.equal((await rpc("admin_load", { p_token: ADM })).takeInfo.stockType, "good");
});
await t("plant login: wrong code rejected; right code gives that branch", async () => {
  assert.equal((await rpc("plant_login", { p_code: "9999" })).ok, false);
  const r = await rpc("plant_login", { p_code: "1501" }); assert.equal(r.branch, "NDD Alpha"); assert.equal(r.take.status, "draft"); TA = r.token;
  TA2 = (await rpc("plant_login", { p_code: "1501" })).token;
  const rb = await rpc("plant_login", { p_code: "1509" }); assert.equal(rb.branch, "NDD Beta"); TB = rb.token;
});
await t("draft: counters can't start yet", async () => {
  await rejects(rpc("counter_start", { p_token: TA, p_device: DEV1, p_branch: "NDD Alpha", p_role: "ops", p_data: {} }), /NOT OPEN/);
});
await t("factors + barcodes", async () => {
  await rpc("admin_save_skus", { p_token: ADM, p_items: [{ code: "A1", per: 24 }, { code: "B2", per: 50, perBox: 10 }, { code: "C3", per: 12 }, { code: "Z9", per: 6 }] });
  assert.equal(await rpc("admin_save_barcodes", { p_token: ADM, p_rows: [{ barcode: "8993175536707", code: "A1", uom: "PCS" }, { barcode: "x", code: "A1", uom: "BAG" }], p_replace: false }), 1);
  // one barcode printed on two SKUs: kept with both, so the phone asks instead of guessing
  assert.equal(await rpc("admin_save_barcodes", { p_token: ADM, p_rows: [{ barcode: "999", code: "C3", uom: "PCS" }, { barcode: "999", code: "B2", uom: "PCS" }, { barcode: "998", code: "B2", uom: "CTN" }, { barcode: "998", code: "B2", uom: "CTN" }], p_replace: false }), 2);
  const own = (await db.query("select token from public.tokens where kind = 'owner' limit 1")).rows[0].token;
  const m = await rpc("counter_master", { p_token: own });
  assert.deepEqual(m.barcodes["999"].alts, ["B2", "C3"]); assert.equal(m.barcodes["998"].alts, undefined); assert.equal(m.barcodes["8993175536707"].code, "A1");
});
await t("open counting; can't start another stock take while open", async () => {
  const o = await rpc("admin_set_status", { p_token: ADM, p_status: "open" }); assert.equal(o.status, "open");
  await rejects(rpc("admin_draft", { p_token: ADM, p_name: "Another", p_scope: "total", p_skus: [] }), /close the current/);
});
await t("good or bad stock can't change once counting is open", async () => {
  await rejects(rpc("admin_set_stock_type", { p_token: ADM, p_type: "bad" }), /before counting opens/);
});
await t("branch token can't open another branch; codes/batches without quantities", async () => {
  await rejects(rpc("counter_branch", { p_token: TB, p_branch: "NDD Alpha" }), /PIN/);
  const b = await rpc("counter_branch", { p_token: TA, p_branch: "NDD Alpha" });
  assert.deepEqual(b.codes.sort(), ["A1", "B2", "C3", "D4"]); assert.deepEqual(b.batches.B2, [""]); assert.ok(!JSON.stringify(b).includes("240"));
});

console.log("counting");
let SO, SF;
const L = (code, batch, ctn, box, pcs, remark) => ({ code, batch, ctn, box, pcs, remark: remark || "" });
const opsLines = { "A1|2027-03": L("A1", "2027-03", 11, null, 0), "A1|2027-05": L("A1", "2027-05", 5, null, 0), "B2|": L("B2", "", 1, 4, 10), "C3|2026-12": L("C3", "2026-12", 0, null, 0), "Z9|": L("Z9", "", null, null, 6), "Q1|": L("Q1", "", 2, null, null, "Damaged") };
const finLines = { "A1|2027-03": L("A1", "2027-03", null, null, 264), "A1|2027-05": L("A1", "2027-05", null, null, 120), "B2|": L("B2", "", null, null, 99), "Z9|": L("Z9", "", 1, null, null), "D4|2027-01": L("D4", "2027-01", null, null, 990) };
await t("ops + fin start on different phones and save", async () => {
  SO = await rpc("counter_start", { p_token: TA, p_device: DEV1, p_branch: "NDD Alpha", p_role: "ops", p_data: { member: "Ali", names: ["Ali"], lines: {} } });
  SF = await rpc("counter_start", { p_token: TA2, p_device: DEV2, p_branch: "NDD Alpha", p_role: "fin", p_data: { member: "Siti", names: ["Siti"], lines: {} } });
  assert.equal((await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { member: "Ali", names: ["Ali"], lines: opsLines } })).ok, true);
  assert.equal((await rpc("counter_save", { p_token: TA2, p_device: DEV2, p_id: SF.id, p_data: { member: "Siti", names: ["Siti"], lines: finLines } })).ok, true);
});
await t("other phone can't write my session; same phone can't take the other role", async () => {
  await rejects(rpc("counter_save", { p_token: TA, p_device: DEV3, p_id: SO.id, p_data: {} }), /Not your count/);
  await rejects(rpc("counter_start", { p_token: TA, p_device: DEV1, p_branch: "NDD Alpha", p_role: "fin", p_data: {} }), /NOT ALLOWED/);
});

let jsV;
await t("SQL variance == JS variance (status, agreed, var, SKU result)", async () => {
  const a = await rpc("admin_load", { p_token: ADM }); const sm = {}; a.skus.forEach((s) => (sm[s.code] = s));
  const docs = a.sessions.filter((s) => s.branch === "NDD Alpha").map((s) => ({ role: s.role, lines: s.data.lines, names: s.data.names, member: s.data.member, extraSkus: [] }));
  jsV = variance(a.sys["NDD Alpha"], docs, sm, 2);
  const sq = (await db.query(`select * from private.variance((select (value #>> '{}')::uuid from public.settings where key='current_take')) where branch = 'NDD Alpha' order by code, batch`)).rows;
  const norm = (f) => String(f || "").replace(/ 2%$/, "");
  assert.equal(sq.length, jsV.length);
  for (const o of jsV) {
    const r = sq.find((x) => x.code === o.code && x.batch === o.batch); assert.ok(r, "missing " + o.code + "|" + o.batch);
    assert.equal(r.status, o.status, o.code + " status"); assert.equal(r.phys == null ? null : Number(r.phys), o.phys, o.code + " phys");
    assert.equal(r.v == null ? null : Number(r.v), o.v, o.code + " v"); assert.equal(norm(r.sku_flag), norm(o.skuFlag), o.code + " flag");
  }
  assert.equal(jsV.skuGroups.C3.flag, "OVER 2%"); assert.equal(jsV.skuGroups.Z9.flag, "NOT IN SYSTEM"); assert.equal(jsV.skuGroups.A1.flag, "OK");
});

console.log("admin logs out in the middle");
await t("admin logout doesn't touch counting; counters keep saving; re-login shows the same", async () => {
  await rpc("logout", { p_token: ADM });
  await rejects(rpc("admin_load", { p_token: ADM }), /login/);
  const more = Object.assign({}, opsLines, { "D4|2027-01": L("D4", "2027-01", null, null, 990) });
  assert.equal((await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { member: "Ali", names: ["Ali"], lines: more } })).ok, true);
  assert.equal((await rpc("public_config", {})).take.status, "open");
  ADM = (await rpc("admin_login", { p_password: "AdmPass9" })).token;
  const a = await rpc("admin_load", { p_token: ADM });
  assert.equal(a.takeInfo.status, "open"); assert.equal(Object.keys(a.sessions.find((s) => s.id === SO.id).data.lines).length, 7);
});

console.log("photos, submit, recount");
await t("submit blocked without 3 photos, ok with 3, then locked", async () => {
  await rejects(rpc("counter_submit", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { lines: opsLines } }), /at least 3/);
  for (let i = 0; i < 3; i++) await db.query(`insert into public.session_photos (session_id, path) values ($1, 'x/' || $2)`, [SO.id, String(i)]);
  const r = await rpc("counter_submit", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { member: "Ali", names: ["Ali"], lines: opsLines, sign: { Ali: { img: "x", at: "t" } } } });
  assert.equal(r.session.status, "submitted"); assert.equal(r.session.photos, 3);
  assert.equal((await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { lines: {} } })).ok, false);
});
await t("photo rule can exempt Finance", async () => {
  await rpc("admin_settings", { p_token: ADM, p_patch: { photo_roles: ["ops"] } });
  assert.equal((await rpc("counter_submit", { p_token: TA2, p_device: DEV2, p_id: SF.id, p_data: { member: "Siti", names: ["Siti"], lines: finLines } })).session.status, "submitted");
  await rpc("admin_settings", { p_token: ADM, p_patch: { photo_roles: ["ops", "fin"] } });
});
await t("recount reopens submitted sessions", async () => {
  assert.equal(await rpc("admin_send_recount", { p_token: ADM, p_branch: "NDD Alpha", p_items: ["B2|"] }), 2);
  const s = await rpc("counter_sync", { p_tokens: [TA], p_device: DEV1 }); assert.equal(s.sessions[0].status, "counting"); assert.deepEqual(s.recount["NDD Alpha"], ["B2|"]);
});

console.log("close + dashboard");
await t("dashboard while open: progress only", async () => {
  const d = await rpc("public_dashboard", {}); const a = d.branches.find((b) => b.branch === "NDD Alpha");
  assert.equal(d.status, "open"); assert.equal(d.showVariance, false); assert.equal(a.expected, 4); assert.equal(a.opsDone, 3); assert.equal(a.finDone, 3);
});
await t("close: counters blocked, admin not; dashboard shows variance by level", async () => {
  await rejects(rpc("admin_settings", { p_token: ADM, p_patch: { closed: true } }), /Unknown setting/);
  assert.equal((await rpc("admin_set_status", { p_token: ADM, p_status: "closed" })).status, "closed");
  const r = await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { lines: opsLines } }); assert.equal(r.ok, false); assert.equal(r.closed, true);
  await rejects(rpc("counter_start", { p_token: TB, p_device: DEV1, p_branch: "NDD Beta", p_role: "ops", p_data: {} }), /CLOSED/);
  await rpc("admin_settings", { p_token: ADM, p_patch: { dash_level: "qty" } });
  let d = await rpc("public_dashboard", {}), a = d.branches.find((b) => b.branch === "NDD Alpha");
  assert.equal(d.showVariance, true); assert.equal(a.variance.varRM, null);
  await rpc("admin_settings", { p_token: ADM, p_patch: { dash_level: "value" } });
  d = await rpc("public_dashboard", {}); a = d.branches.find((b) => b.branch === "NDD Alpha"); assert.ok(a.variance.varRM != null);
});
await t("counts reaching the server after close are parked for HQ, not lost", async () => {
  const extra = Object.assign({}, opsLines, { "C3|2026-12": L("C3", "2026-12", 3, null, 0) });
  const r = await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { member: "Ali", lines: extra } });
  assert.equal(r.ok, false); assert.equal(r.closed, true); assert.equal(r.late, true);
  let late = await rpc("admin_late", { p_token: ADM }); assert.equal(late.length, 1); assert.equal(late[0].branch, "NDD Alpha"); assert.ok(late[0].lines >= 1);
  await rejects(rpc("admin_late", { p_token: TA }), /./);
  await rpc("admin_late_resolve", { p_token: ADM, p_session: SO.id, p_take: true });
  const a = await rpc("admin_load", { p_token: ADM }); assert.equal(a.sessions.find((x) => x.id === SO.id).data.lines["C3|2026-12"].ctn, 3);
  assert.equal((await rpc("admin_late", { p_token: ADM })).length, 0);
  // the same save again is no longer different: nothing parked
  assert.equal((await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { member: "Ali", lines: extra } })).late, false);
  await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: SO.id, p_data: { member: "Ali", lines: opsLines } });
  await rpc("admin_late_resolve", { p_token: ADM, p_session: SO.id, p_take: false });
  assert.equal((await rpc("admin_load", { p_token: ADM })).sessions.find((x) => x.id === SO.id).data.lines["C3|2026-12"].ctn, 3);
});
await t("reopen and close again", async () => {
  assert.equal((await rpc("admin_set_status", { p_token: ADM, p_status: "open" })).status, "open");
  assert.equal((await rpc("admin_set_status", { p_token: ADM, p_status: "closed" })).status, "closed");
  await rejects(rpc("admin_set_status", { p_token: ADM, p_status: "closed" }), /Only an open/);
});

console.log("partial stock take");
let OLD;
await t("new draft after closing; old one kept in history", async () => {
  OLD = (await rpc("public_config", {})).take.id;
  const d = await rpc("admin_draft", { p_token: ADM, p_name: "Cycle W4", p_scope: "partial", p_skus: ["A1", "C3"] });
  assert.equal(d.status, "draft"); assert.equal(d.scope, "partial"); assert.equal(d.skuCount, 2); assert.notEqual(d.id, OLD);
  const a = await rpc("admin_load", { p_token: ADM }); assert.equal(a.takes.length, 2); assert.deepEqual(a.sys, {});
  const old = await rpc("admin_load", { p_token: ADM, p_take: OLD }); assert.equal(old.takeInfo.status, "closed"); assert.ok(old.sessions.length >= 2);
});
await t("partial: only picked SKUs reach counters, admin and dashboard", async () => {
  await rpc("admin_load_mb52", { p_token: ADM, p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) });
  await rpc("admin_set_status", { p_token: ADM, p_status: "open" });
  const b = await rpc("counter_branch", { p_token: TA, p_branch: "NDD Alpha" }); assert.deepEqual(b.codes.sort(), ["A1", "C3"]);
  const a = await rpc("admin_load", { p_token: ADM }); assert.deepEqual([...new Set(a.sys["NDD Alpha"].map((r) => r[0]))].sort(), ["A1", "C3"]); assert.equal(a.sysAllCodes.length, 4);
  const d = await rpc("public_dashboard", {}); assert.equal(d.branches.find((x) => x.branch === "NDD Alpha").expected, 2); assert.equal(d.scope, "partial");
  const s = await rpc("counter_start", { p_token: TA, p_device: DEV1, p_branch: "NDD Alpha", p_role: "ops", p_data: { member: "Ali", names: ["Ali"], lines: {} } });
  await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: s.id, p_data: { lines: { "A1|2027-03": L("A1", "2027-03", null, null, 264), "D4|2027-01": L("D4", "2027-01", null, null, 5) } } });
  const v = (await db.query(`select code, status from private.variance((select (value #>> '{}')::uuid from public.settings where key='current_take')) where branch = 'NDD Alpha' order by code, batch`)).rows;
  assert.ok(!v.some((x) => x.code === "B2"), "B2 not picked must not appear as NOT COUNTED");
  assert.ok(v.some((x) => x.code === "D4" && x.status === "WAITING FINANCE"), "extra stock found is still recorded");
});
await t("can't open a partial with no SKUs", async () => {
  await rpc("admin_set_status", { p_token: ADM, p_status: "closed" });
  await rpc("admin_draft", { p_token: ADM, p_name: "Empty", p_scope: "partial", p_skus: [] });
  await rpc("admin_load_mb52", { p_token: ADM, p_payload: mb52Payload(["NDD Alpha"]) });
  await rejects(rpc("admin_set_status", { p_token: ADM, p_status: "open" }), /MB52|Pick at least/);
});

console.log("single count (database)");
await t("single count: mode saved on draft, locked once open, one team's count agreed in SQL", async () => {
  await rpc("admin_draft", { p_token: ADM, p_name: "Single W5", p_scope: "total", p_skus: [] });
  await rejects(rpc("admin_set_mode", { p_token: ADM, p_mode: "triple" }), /Bad count mode/);
  const m = await rpc("admin_set_mode", { p_token: ADM, p_mode: "single" }); assert.equal(m.mode, "single");
  await rpc("admin_set_status", { p_token: ADM, p_status: "open" });
  await rejects(rpc("admin_set_mode", { p_token: ADM, p_mode: "double" }), /before counting opens/);
  assert.equal((await rpc("public_config", {})).take.mode, "single"); assert.equal((await rpc("public_dashboard", {})).mode, "single");
  const s = await rpc("counter_start", { p_token: TA, p_device: DEV1, p_branch: "NDD Alpha", p_role: "ops", p_data: { member: "Ali", names: ["Ali"], lines: {} } });
  await rpc("counter_save", { p_token: TA, p_device: DEV1, p_id: s.id, p_data: { lines: { "A1|2027-03": L("A1", "2027-03", null, null, 264), "C3|2026-12": L("C3", "2026-12", null, null, 50) } } });
  const v = (await db.query(`select code, batch, status, phys, v, sku_flag from private.variance((select (value #>> '{}')::uuid from public.settings where key='current_take')) where branch = 'NDD Alpha' and code in ('A1','C3') order by code, batch`)).rows;
  const a = v.find((x) => x.code === "A1" && x.batch === "2027-03"), c = v.find((x) => x.code === "C3");
  assert.equal(a.status, "MATCH"); assert.equal(Number(a.phys), 264); assert.equal(Number(a.v), 0);
  assert.equal(c.status, "MATCH"); assert.equal(Number(c.v), -10); assert.equal(c.sku_flag, "OVER");
  await rpc("admin_set_status", { p_token: ADM, p_status: "closed" });
});

console.log("stock report layout (SKU / Total in PCS)");
await t("report layout parses: names matched ignoring case, plants, total row ignored, dd.mm.yyyy batches", async () => {
  const R = [["Plant", "PLANT DISCRIPTION", "Storage Loc.", "Batch", "Exp. date", "Manu. date", "SKU", "Description", "High(CTN)", "Total in PCS"],
    ["1501", "NDD ALPHA", "MW00", "20270903", "", "", "A1", "Wafer A", 24, 738],
    ["1501", "NDD ALPHA", "MW00", "20270915", "", "", "A1", "Wafer A", 1, 30],
    ["1511", "ndd beta ", "NDD Beta", "01.02.2027", "", "", "B2", "Roll B", 3, 119],
    ["1599", "Factory DC", "MW00", "20270101", "", "", "A1", "Wafer A", 1, 10],
    ["", "", "", "", "", "", "", "", 29, 897]];
  const r = parseMB52(R, ["NDD Alpha", "NDD Beta"]);
  assert.equal(r.format, "report"); assert.equal(r.hasValue, false);
  assert.deepEqual(r.byBr["NDD Alpha"], [["A1", "2027-09", 768, 0, "MW00"]]);
  assert.deepEqual(r.byBr["NDD Beta"], [["B2", "2027-02", 119, 0, "NDD Beta"]]);
  assert.deepEqual(r.plants, { "NDD Alpha": ["1501"], "NDD Beta": ["1511"] });
  assert.ok(r.skipped["1599 Factory DC"] !== undefined); assert.equal(r.totQ, 887);
});
await t("MB52 layout still the same (Unrestricted + Restricted + QI, values)", async () => {
  const r = parseMB52(rows, ["NDD Alpha", "NDD Beta"]); assert.equal(r.format, "mb52"); assert.equal(r.hasValue, true); assert.equal(r.exBadQ, 99); assert.equal(r.lines, 7);
});

await t("plant code wins over the name in the file", async () => {
  const R = [["Plant", "Name 1", "Material", "Batch", "Unrestricted", "Value Unrestricted"],
    ["1501", "NDD Alpha Sdn Bhd", "A1", "20270903", 10, 50], ["1777", "NDD Unknown", "A1", "20270903", 5, 25]];
  const r = parseMB52(R, ["NDD Alpha"], { "1501": "NDD Alpha" });
  assert.deepEqual(Object.keys(r.byBr), ["NDD Alpha"]); assert.equal(r.byBr["NDD Alpha"][0][2], 10); assert.equal(r.byBr["NDD Alpha"][0][3], 5);
  assert.ok(r.skipped["1777 NDD Unknown"] !== undefined);
  assert.deepEqual(mb52Names(R, ["NDD Alpha"], { "1501": "NDD Alpha" }).map(x => x.name + ":" + x.known), ["NDD Alpha:true", "NDD Unknown:false"]);
});

console.log("count mode");
await t("single count: one team's count is agreed; both teams must still match", async () => {
  const sys = [["A1", "2027-09", 100, 2], ["B2", "2027-02", 50, 1], ["C3", "2027-01", 10, 1]];
  const docs = [{ role: "ops", lines: { a: { code: "A1", batch: "2027-09", pcs: 98 }, c: { code: "C3", batch: "2027-01", pcs: 10 } } },
                { role: "fin", lines: { b: { code: "B2", batch: "2027-02", pcs: 50 }, c: { code: "C3", batch: "2027-01", pcs: 9 } } }];
  const sm = { A1: {}, B2: {}, C3: {} };
  const one = variance(sys, docs, sm, 2, true), by = Object.fromEntries(one.map(o => [o.code, o]));
  assert.equal(by.A1.status, "MATCH"); assert.equal(by.A1.phys, 98); assert.equal(by.A1.v, -2); assert.equal(by.A1.vv, -4); assert.equal(by.A1.skuFlag, "WITHIN 2%");
  assert.equal(by.B2.status, "MATCH"); assert.equal(by.B2.phys, 50); assert.equal(by.B2.skuFlag, "OK");
  assert.equal(by.C3.status, "RECOUNT"); assert.equal(by.C3.skuFlag, "PENDING");
  const two = Object.fromEntries(variance(sys, docs, sm, 2, false).map(o => [o.code, o]));
  assert.equal(two.A1.status, "WAITING FINANCE"); assert.equal(two.B2.status, "WAITING OPS"); assert.equal(two.A1.skuFlag, "PENDING");
});

console.log("SQL safety");
await t("no DELETE/UPDATE without WHERE (Supabase rejects them from the API - pg-safeupdate)", async () => {
  const fs = await import("node:fs"), dir = new URL("../sql/", import.meta.url), bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
    /* only function bodies: those run through the API; one-off migration statements don't */
    const sql = [...fs.readFileSync(new URL(f, dir), "utf8").replace(/--[^\n]*/g, "").matchAll(/create or replace function[\s\S]*?\$\$([\s\S]*?)\$\$;/gi)].map((x) => x[1]).join("\n");
    for (const m of sql.matchAll(/\b(delete\s+from|update\s+[\w.]+\s+set)\b[\s\S]*?;/gi)) if (!/\bwhere\b/i.test(m[0])) bad.push(f + ": " + m[0].replace(/\s+/g, " ").slice(0, 90));
  }
  assert.deepEqual(bad, []);
});

await t("index.html and dashboard re-download every JS module on a new version", async () => {
  const fs = await import("node:fs"), js = fs.readdirSync(new URL("../js/", import.meta.url)).filter((x) => x.endsWith(".js"));
  const idx = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8"), dsh = fs.readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8");
  assert.deepEqual(js.filter((f) => !idx.includes('"js/' + f + '"')), []);
  assert.deepEqual(js.filter((f) => !dsh.includes('"../js/' + f + '"')), []);
  const v = /APP_VERSION = "([^"]+)"/.exec(fs.readFileSync(new URL("../js/config.js", import.meta.url), "utf8"))[1];
  assert.ok(idx.includes("app.css?v=" + v), "css ?v= matches APP_VERSION");
});

console.log("owner tools");
await t("adding a known branch adds nothing", async () => {
  assert.equal(await rpc("admin_add_branches", { p_token: OWNER, p_branches: ["NDD Delta", "NDD Alpha"] }), 1);
});
await t("backup has everything; clear counts gives photo paths and new resetId", async () => {
  const b = await rpc("owner_backup", { p_token: OWNER }); assert.ok(b.count_sessions.length >= 3); assert.equal(b.stock_takes.length, 3);
  await rpc("owner_set_take", { p_token: OWNER, p_take: OLD });
  const before = (await rpc("public_config", {})).take.resetId;
  const r = await rpc("owner_clear_counts", { p_token: OWNER }); assert.ok(r.sessions >= 2); assert.equal(r.paths.length, 3);
  assert.notEqual((await rpc("public_config", {})).take.resetId, before);
});
await t("admin password change logs admins out", async () => {
  await rpc("owner_set_password", { p_token: OWNER, p_which: "finance", p_password: "NewAdm77" });
  await rejects(rpc("admin_load", { p_token: ADM }), /login/);
});
await t("10 wrong plant codes lock plant login for 15 minutes", async () => {
  await db.query("delete from public.login_attempts");
  for (let i = 0; i < 10; i++) assert.equal((await rpc("plant_login", { p_code: "0000" })).ok, false);
  await rejects(rpc("plant_login", { p_code: "1501" }), /LOCKED/);
  await db.query("update public.login_attempts set at = now() - interval '16 minutes'");
  assert.equal((await rpc("plant_login", { p_code: "1501" })).ok, true);
});

console.log("daily cycle count");
let A2, SUP, PIN, TD;
const day = async (d, release = true) => {
  await db.query(`insert into public.settings (key, value) values ('test_today', '"${d}"') on conflict (key) do update set value = excluded.value`);
  /* HQ uploads that day's MB52 in the morning: it releases the day's daily counts */
  if (release) await rpc("admin_load_daily", { p_token: A2, p_date: d, p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) });
};
await t("setup: admin login, monthly closed, photos optional, today = Wed 18 Nov 2026", async () => {
  A2 = (await rpc("admin_login", { p_password: "NewAdm77" })).token; assert.ok(A2);
  await db.query("update public.stock_takes set status = 'closed', closed_at = now() - interval '2 days' where kind = 'monthly'"); await db.query("delete from public.count_log");
  await rpc("admin_settings", { p_token: A2, p_patch: { photo_min: 0 } }); await day("2026-11-18", false);
});
await t("no stock upload yet: nothing planned, counter told there's nothing to count", async () => {
  const r = await rpc("plant_login", { p_code: "1501" }); TD = r.token; assert.equal(r.take.kind, "monthly");
  await rejects(rpc("counter_start", { p_token: TD, p_device: "d-1", p_branch: "NDD Alpha", p_role: "ops", p_data: {} }), /Nothing to count at NDD Alpha today/);
  const o = await rpc("admin_dcc_day", { p_token: A2 }); assert.equal(o.rows.find((x) => x.branch === "NDD Alpha").why, "waiting"); assert.equal(r.wait, "release");
});
await t("daily stock upload; ABC by value per warehouse (A 80%, B next 15%, C rest)", async () => {
  await rpc("admin_settings", { p_token: A2, p_patch: { dcc_min_skus: 1 } });   // the list tests below check the ABC planning itself
  const r = await rpc("admin_load_daily", { p_token: A2, p_date: "2026-11-18", p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) }); assert.equal(r.branches, 2);
  const kinds = (await db.query("select k.stype, k.code, k.qty::int as qty from public.snap_stock k join public.snapshots x on x.id = k.snap_id where x.snap_date = '2026-11-18' and k.branch = 'NDD Alpha' and k.stype = 'bad'")).rows;
  assert.deepEqual(kinds, [{ stype: "bad", code: "A1", qty: 99 }], "daily upload keeps bad stock apart");
  await rejects(rpc("admin_load_daily", { p_token: A2, p_date: "2026-12-01", p_payload: mb52Payload(["NDD Alpha"]) }), /stock date/);
  await rpc("admin_dcc_day", { p_token: A2 });
  const a = await rpc("admin_abc", { p_token: A2, p_branch: "NDD Alpha" });
  assert.deepEqual(a.rows.map((x) => x.code + ":" + x.cls), ["D4:A", "A1:A", "C3:B", "B2:C"]);
  const b = await rpc("admin_abc", { p_token: A2, p_branch: "NDD Beta" }); assert.deepEqual(b.rows.map((x) => x.code + ":" + x.cls), ["A1:A", "C3:B"]);
});
await t("today's list: monthly need spread over the remaining working days, A first, by value", async () => {
  const o = await rpc("admin_dcc_day", { p_token: A2 }), al = o.rows.find((x) => x.branch === "NDD Alpha"), be = o.rows.find((x) => x.branch === "NDD Beta");
  assert.equal(al.take.kind, "daily"); assert.equal(al.take.mode, "single"); assert.deepEqual(al.take.plan, { D4: "A" });
  assert.deepEqual(be.take.plan, { A1: "A" });
  const again = await rpc("admin_dcc_day", { p_token: A2 }); assert.equal(again.rows.find((x) => x.branch === "NDD Alpha").take.id, al.take.id);
});
await t("uploading the MB52 again after today's list exists keeps the ABC (rebuilt during the upload)", async () => {
  await rpc("admin_load_daily", { p_token: A2, p_date: "2026-11-18", p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) });
  const a = await rpc("admin_abc", { p_token: A2, p_branch: "NDD Alpha" });
  assert.deepEqual(a.rows.map((x) => x.code + ":" + x.cls), ["D4:A", "A1:A", "C3:B", "B2:C"]);
});
await t("counter gets today's daily list after the plant code", async () => {
  const r = await rpc("plant_login", { p_code: "1501" }); TD = r.token; assert.equal(r.take.kind, "daily"); assert.equal(r.take.countDate, "2026-11-18"); assert.equal(r.take.countTo, "10:00");
  const b = await rpc("counter_branch", { p_token: TD, p_branch: "NDD Alpha" }); assert.deepEqual(b.codes, ["D4"]); assert.deepEqual(b.batches, { D4: ["2027-01"] });
});
await t("supervisor: HQ creates PIN (shown once), wrong PIN fails, must change at first login", async () => {
  await rejects(rpc("admin_sup_pin", { p_token: TD, p_branch: "NDD Alpha" }), /login/);
  PIN = (await rpc("admin_sup_pin", { p_token: A2, p_branch: "NDD Alpha" })).pin; assert.match(PIN, /^\d{6}$/);
  assert.equal((await rpc("sup_login", { p_code: "1501", p_pin: "000000" === PIN ? "111111" : "000000" })).ok, false);
  const r = await rpc("sup_login", { p_code: "1501", p_pin: PIN }); assert.equal(r.mustChange, true); SUP = r.token;
  await rejects(rpc("sup_change_pin", { p_token: SUP, p_branch: "NDD Alpha", p_pin: "12" }), /6 to 8 digits/);
  await rejects(rpc("sup_change_pin", { p_token: SUP, p_branch: "NDD Beta", p_pin: "24681012" }), /supervisor login/);
  await rpc("sup_change_pin", { p_token: SUP, p_branch: "NDD Alpha", p_pin: "24681012" });
  assert.equal((await rpc("sup_login", { p_code: "1501", p_pin: "24681012" })).mustChange, false);
  await rejects(rpc("sup_day", { p_token: TD, p_branch: "NDD Alpha" }), /supervisor login/);
});
await t("supervisor adds a SKU to today; counter counts and submits", async () => {
  await rejects(rpc("sup_add_sku", { p_token: SUP, p_branch: "NDD Alpha", p_code: "ZZ9" }), /Unknown SKU/);
  const tk = await rpc("sup_add_sku", { p_token: SUP, p_branch: "NDD Alpha", p_code: "C3" }); assert.equal(tk.skuCount, 2);
  assert.deepEqual((await rpc("counter_branch", { p_token: TD, p_branch: "NDD Alpha" })).codes.sort(), ["C3", "D4"]);
  const s = await rpc("counter_start", { p_token: TD, p_device: "d-1", p_branch: "NDD Alpha", p_role: "ops", p_data: { member: "Ali", names: ["Ali"] } });
  const lines = { "D4|2027-01": L("D4", "2027-01", null, null, 990), "C3|2026-12": L("C3", "2026-12", null, null, 50) };
  await rpc("counter_save", { p_token: TD, p_device: "d-1", p_id: s.id, p_data: { member: "Ali", names: ["Ali"], lines } });
  await rpc("counter_submit", { p_token: TD, p_device: "d-1", p_id: s.id, p_data: { member: "Ali", names: ["Ali"], lines } });
  await db.query("update public.count_sessions set submitted_at = '2026-11-18 08:30:00+08' where id = $1", [s.id]);
  const d = await rpc("sup_day", { p_token: SUP, p_branch: "NDD Alpha" });
  assert.deepEqual(d.takeInfo.plan, { D4: "A", C3: "S" }); assert.equal(d.sessions.length, 1); assert.equal(d.sys["NDD Alpha"].length, 2);
});
await t("dashboard: on time, accuracy, coverage; public version has no RM", async () => {
  const st = await rpc("admin_dcc_stats", { p_token: A2, p_from: "2026-11-16", p_to: "2026-11-18" }), al = st.branches.find((x) => x.branch === "NDD Alpha");
  assert.deepEqual(al.cells.map((c) => c.st), ["none", "none", "ontime"]);
  assert.equal(al.ok, 1); assert.equal(al.counted, 2); assert.equal(al.covered, 2); assert.equal(al.universe, 4);
  assert.equal(st.top[0].code, "C3"); assert.equal(st.top[0].varQ, -10);
  const be = st.branches.find((x) => x.branch === "NDD Beta"); assert.equal(be.cells[2].st, "todo");
  const pub = await rpc("public_dcc", {}); assert.equal(pub.top, null); assert.equal(pub.branches[0].net, null); assert.equal(pub.withRm, false);
});
await t("dashboard 2: region + NOM per warehouse; today per warehouse (status, time taken, who, result)", async () => {
  await rejects(rpc("admin_branch_meta", { p_token: TD, p_branch: "NDD Alpha", p_region: "Central", p_nom: "Ahmad" }), /login|admin/i);
  await rejects(rpc("admin_branch_meta", { p_token: A2, p_branch: "NDD Nowhere", p_region: "X" }), /Unknown warehouse/);
  const meta = await rpc("admin_branch_meta", { p_token: A2, p_branch: "NDD Alpha", p_region: " Central ", p_nom: "Ahmad" });
  assert.deepEqual(meta.find((x) => x.branch === "NDD Alpha"), { branch: "NDD Alpha", region: "Central", nom: "Ahmad" });
  await db.query("update public.count_sessions set started_at = '2026-11-18 08:00:00+08' where device_id = 'd-1'");
  const o = await rpc("admin_dcc_today", { p_token: A2 }), al = o.rows.find((x) => x.branch === "NDD Alpha");
  assert.equal(o.date, "2026-11-18"); assert.equal(al.status, "ontime"); assert.equal(al.region, "Central"); assert.equal(al.nom, "Ahmad");
  assert.equal(al.listed, 2); assert.equal(al.counted, 2); assert.equal(al.minutes, 30); assert.equal(al.who, "Ali"); assert.equal(al.snapDate, "2026-11-18");
  assert.deepEqual(al.result, { ok: 0, within: 1, over: 1, nis: 0, notCounted: 0 });
  assert.equal(o.rows.find((x) => x.branch === "NDD Beta").status, "todo");
  const ins = await rpc("admin_dcc_insights", { p_token: A2, p_from: "2026-11-01", p_to: "2026-11-18" });
  assert.deepEqual(ins.counters, [{ name: "Ali", branches: "NDD Alpha", days: 1, skus: 2, minutes: 30, ok: 1, n: 2 }]);
  assert.deepEqual(ins.mix, [{ branch: "NDD Alpha", ok: 0, within: 1, over: 1, nis: 0 }]);
  const a = ins.abc.filter((x) => x.branch === "NDD Alpha").map((x) => x.cls + ":" + x.skus + ":" + x.target + ":" + x.times + ":" + x.once);
  assert.deepEqual(a, ["A:2:4:1:1", "B:1:2:1:1", "C:1:1:0:0"]);
  assert.deepEqual(ins.repeat, []);
  await rejects(rpc("admin_dcc_insights", { p_token: TD, p_from: "2026-11-01", p_to: "2026-11-18" }), /login|admin/i);
});
await t("daily report: every daily count in a period with SKU/batch results (export + daily sign-off PDF)", async () => {
  await rejects(rpc("admin_dcc_report", { p_token: TD, p_from: "2026-11-18", p_to: "2026-11-18" }), /login|admin/i);
  await rejects(rpc("admin_dcc_report", { p_token: A2, p_from: "2026-09-01", p_to: "2026-11-18" }), /at most 2 months/);
  const r = await rpc("admin_dcc_report", { p_token: A2, p_from: "2026-11-01", p_to: "2026-11-18" });
  const al = r.takes.find((x) => x.branch === "NDD Alpha");
  assert.equal(al.date, "2026-11-18"); assert.equal(al.listed, 2); assert.equal(al.who, "Ali"); assert.equal(al.late, false);
  assert.equal(al.from, "07:00"); assert.equal(al.to, "10:00"); assert.equal(al.snapDate, "2026-11-18"); assert.equal(al.region, "Central");
  assert.deepEqual(Object.keys(al.plan).sort(), ["C3", "D4"]);
  const fl = {}; al.lines.forEach((l) => { fl[l.code] = l.flag; });
  assert.deepEqual(fl, { C3: "OVER", D4: "WITHIN" });
  assert.ok(al.lines.every((l) => "sys" in l && "phys" in l && "vv" in l && "desc" in l));
  const one = await rpc("admin_dcc_report", { p_token: A2, p_from: "2026-11-18", p_to: "2026-11-18", p_branch: "NDD Beta" });
  assert.deepEqual(one.takes.map((x) => x.branch), ["NDD Beta"]); assert.equal(one.takes[0].submittedAt, null);
});
await t("SKU variance = total counted minus total system (a batch not found counts as 0)", async () => {
  const id = (await db.query("insert into public.stock_takes (name, kind, branch, count_date, status, mode, scope, skus) values ('Daily x', 'daily', 'NDD Alpha', '2026-11-16', 'open', 'single', 'partial', '{A1}') returning id")).rows[0].id;
  await db.query("insert into public.sys_stock (take_id, branch, code, batch, qty, unit_cost) values ($1, 'NDD Alpha', 'A1', '2027-03', 264, 2), ($1, 'NDD Alpha', 'A1', '2027-05', 120, 2)", [id]);
  const lines = { "A1|2027-03": L("A1", "2027-03", null, null, 380) };
  await db.query("insert into public.count_sessions (take_id, device_id, branch, role, data, status, submitted_at) values ($1, 'd-x', 'NDD Alpha', 'ops', $2, 'submitted', now())", [id, JSON.stringify({ member: "Ali", names: ["Ali"], lines })]);
  await db.query("select private.log_take($1)", [id]);
  const lg = (await db.query("select sys_q, phys_q, var_q, var_rm, flag from public.count_log where take_id = $1", [id])).rows[0];
  assert.equal(Number(lg.sys_q), 384); assert.equal(Number(lg.phys_q), 380); assert.equal(Number(lg.var_q), -4); assert.equal(Number(lg.var_rm), -8); assert.equal(lg.flag, "WITHIN");
  const rep = await rpc("admin_dcc_report", { p_token: A2, p_from: "2026-11-16", p_to: "2026-11-16", p_branch: "NDD Alpha" });
  assert.deepEqual(rep.takes[0].lines.map((l) => l.batch + ":" + l.status).sort(), ["2027-03:MATCH", "2027-05:NOT COUNTED"]);
  await db.query("delete from public.stock_takes where id = $1", [id]);
});
await t("next day: yesterday closes and is logged; out-of-tolerance SKU comes back as a recount", async () => {
  await day("2026-11-19");
  const r = await rpc("plant_login", { p_code: "1501" }); assert.equal(r.take.countDate, "2026-11-19");
  const lg = (await db.query("select code, flag from public.count_log where branch = 'NDD Alpha' and kind = 'daily' order by code")).rows;
  assert.deepEqual(lg.map((x) => x.code + ":" + x.flag), ["C3:OVER", "D4:WITHIN"]);
  const o = await rpc("admin_dcc_day", { p_token: A2 }); assert.deepEqual(o.rows.find((x) => x.branch === "NDD Alpha").take.plan, { A1: "A", C3: "R" });
  const st = await rpc("admin_dcc_stats", { p_token: A2, p_from: "2026-11-18", p_to: "2026-11-19" });
  assert.equal(st.branches.find((x) => x.branch === "NDD Beta").cells[0].st, "missed");
  const ins = await rpc("admin_dcc_insights", { p_token: A2, p_from: "2026-11-01", p_to: "2026-11-19" });
  assert.equal(ins.counters[0].n, 2); assert.equal(ins.abc.find((x) => x.branch === "NDD Alpha" && x.cls === "A").times, 1);
  assert.equal((await rpc("admin_dcc_today", { p_token: A2, p_date: "2026-11-18" })).rows.find((x) => x.branch === "NDD Beta").status, "missed");
});
await t("yesterday's count can't be changed any more", async () => {
  const old = (await db.query("select id from public.count_sessions where device_id = 'd-1'")).rows[0].id;
  const r = await rpc("counter_save", { p_token: TD, p_device: "d-1", p_id: old, p_data: { lines: {} } }); assert.equal(r.ok, false);
});
await t("supervisor skips today with a reason; counters are told why", async () => {
  await rejects(rpc("sup_skip", { p_token: SUP, p_branch: "NDD Alpha", p_reason: "" }), /reason/);
  const k = await rpc("sup_skip", { p_token: SUP, p_branch: "NDD Alpha", p_reason: "Stock transfer audit" }); assert.equal(k.skipReason, "Stock transfer audit");
  await rejects(rpc("counter_start", { p_token: TD, p_device: "d-1", p_branch: "NDD Alpha", p_role: "ops", p_data: {} }), /skipped: Stock transfer audit/);
  const st = await rpc("admin_dcc_stats", { p_token: A2, p_from: "2026-11-19", p_to: "2026-11-19" }); assert.equal(st.branches.find((x) => x.branch === "NDD Alpha").cells[0].st, "skip");
});
await t("Sunday is off; working days are set per warehouse", async () => {
  await day("2026-11-22");
  const o = await rpc("admin_dcc_day", { p_token: A2 }); assert.equal(o.rows.find((x) => x.branch === "NDD Alpha").why, "off");
  await rejects(rpc("admin_dcc_branch", { p_token: A2, p_branch: "NDD Alpha", p_days: [7, 1, 2, 3, 4], p_from: "10:00", p_to: "09:00" }), /start must be before end/);
  await rpc("admin_dcc_branch", { p_token: A2, p_branch: "NDD Alpha", p_days: [7, 1, 2, 3, 4], p_from: "06:30", p_to: "09:30" });
  const o2 = await rpc("admin_dcc_day", { p_token: A2 }), al = o2.rows.find((x) => x.branch === "NDD Alpha"); assert.equal(al.take.kind, "daily"); assert.equal(al.to, "09:30");
});
await t("monthly stock take open at a warehouse takes over from the daily count", async () => {
  await day("2026-11-23");
  await rpc("admin_draft", { p_token: A2, p_name: "Monthly Nov", p_scope: "total", p_skus: [] });
  await rpc("admin_load_mb52", { p_token: A2, p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) });
  await rpc("admin_set_status", { p_token: A2, p_status: "open" });
  const r = await rpc("plant_login", { p_code: "1501" }); assert.equal(r.take.kind, "monthly"); assert.equal(r.take.name, "Monthly Nov"); assert.equal(r.take.countTo, null);
  assert.equal((await rpc("admin_dcc_day", { p_token: A2 })).rows.find((x) => x.branch === "NDD Alpha").why, "monthly");
  assert.equal((await rpc("admin_load", { p_token: A2 })).takes.every((x) => x.kind === "monthly"), true);
  await rpc("admin_set_status", { p_token: A2, p_status: "closed" });
  assert.equal((await rpc("plant_login", { p_code: "1501" })).take.kind, "daily");
});
await t("KPI001: a day passes when submitted the same day with the minimum SKUs; skip fails; holidays leave HKE", async () => {
  await rejects(rpc("admin_kpi", { p_token: TD }), /login|admin/i);
  let k = await rpc("admin_kpi", { p_token: A2, p_month: "2026-11-01" }), cell = (br, d) => k.branches.find((x) => x.branch === br).cells.find((c) => c.d === d);
  assert.equal(k.month, "2026-11-01"); assert.equal(k.minSkus, 1);
  assert.equal(cell("NDD Alpha", "2026-11-18").st, "pass"); assert.equal(cell("NDD Alpha", "2026-11-18").skus, 2);
  assert.equal(cell("NDD Alpha", "2026-11-19").st, "skip"); assert.equal(cell("NDD Beta", "2026-11-18").st, "missed");
  assert.equal(cell("NDD Alpha", "2026-11-23").st, "pending"); assert.equal(cell("NDD Alpha", "2026-11-30").st, "future");
  await rpc("admin_settings", { p_token: A2, p_patch: { dcc_min_skus: 3 } });
  k = await rpc("admin_kpi", { p_token: A2, p_month: "2026-11-01" }); assert.equal(cell("NDD Alpha", "2026-11-18").st, "under");
  await rejects(rpc("admin_settings", { p_token: A2, p_patch: { dcc_min_skus: 0 } }), /1-50/);
  const hs = await rpc("admin_holidays", { p_token: A2, p_add: { day: "2026-11-30", name: "Test holiday", branches: ["NDD Beta"] } });
  k = await rpc("admin_kpi", { p_token: A2, p_month: "2026-11-01" });
  assert.equal(cell("NDD Beta", "2026-11-30").st, "holiday"); assert.equal(cell("NDD Alpha", "2026-11-30").st, "future");
  await rpc("admin_holidays", { p_token: A2, p_delete: hs[0].id });
  assert.equal(k.trend.length, 6); assert.equal(k.trend[5].month, "2026-11-01");
});
await t("daily list is topped up to the minimum SKUs a day (all SKUs when a warehouse has fewer)", async () => {
  await rpc("admin_settings", { p_token: A2, p_patch: { dcc_min_skus: 4 } });
  await day("2026-11-24");
  const o = await rpc("admin_dcc_day", { p_token: A2 });
  assert.equal(Object.keys(o.rows.find((x) => x.branch === "NDD Alpha").take.plan).length, 4);
  assert.equal(Object.keys(o.rows.find((x) => x.branch === "NDD Beta").take.plan).length, 2);
  await rpc("admin_settings", { p_token: A2, p_patch: { dcc_min_skus: 1 } });
});
await t("HQ deletes one count and stops / resumes a warehouse's daily count", async () => {
  const TB = (await rpc("plant_login", { p_code: "1502" })).token, me = { member: "Budi", names: ["Budi"] };
  const s = await rpc("counter_start", { p_token: TB, p_device: "d-b", p_branch: "NDD Beta", p_role: "ops", p_data: me });
  await rejects(rpc("admin_delete_session", { p_token: TB, p_session: s.id }), /login|admin/i);
  assert.equal((await rpc("admin_delete_session", { p_token: A2, p_session: s.id })).ok, true);
  await rejects(rpc("counter_save", { p_token: TB, p_device: "d-b", p_id: s.id, p_data: me }), /cleared/);
  const s2 = await rpc("counter_start", { p_token: TB, p_device: "d-b", p_branch: "NDD Beta", p_role: "ops", p_data: me });
  assert.notEqual(s2.id, s.id, "counting starts again from zero");
  await rpc("admin_stop_daily", { p_token: A2, p_branch: "NDD Beta", p_stop: true });
  assert.equal((await rpc("admin_dcc_day", { p_token: A2 })).rows.find((x) => x.branch === "NDD Beta").why, "stopped");
  const lb = await rpc("plant_login", { p_code: "1502" }); assert.equal(lb.wait, "stopped"); assert.notEqual(lb.take.kind, "daily");
  await rejects(rpc("counter_save", { p_token: TB, p_device: "d-b", p_id: s2.id, p_data: me }), /cleared/);
  await rejects(rpc("counter_start", { p_token: TB, p_device: "d-b", p_branch: "NDD Beta", p_role: "ops", p_data: me }), /Nothing to count|closed/);
  await rpc("admin_stop_daily", { p_token: A2, p_branch: "NDD Beta", p_stop: false });
  const be = (await rpc("admin_dcc_day", { p_token: A2 })).rows.find((x) => x.branch === "NDD Beta"); assert.equal(be.take.kind, "daily"); assert.equal(be.counted, 0);
  /* a stopped day doesn't count in KPI001 */
  await day("2026-11-25"); await rpc("admin_stop_daily", { p_token: A2, p_branch: "NDD Beta", p_stop: true });
  await day("2026-11-26", false);
  const k = await rpc("admin_kpi", { p_token: A2, p_month: "2026-11-01" }); assert.equal(k.branches.find((x) => x.branch === "NDD Beta").cells.find((c) => c.d === "2026-11-25").st, "nolist");
});
await t("daily is released only by that day's MB52; a late release moves the deadline", async () => {
  const w = await rpc("plant_login", { p_code: "1501" }); assert.equal(w.wait, "release"); assert.notEqual(w.take.kind, "daily");
  await rejects(rpc("admin_load_daily", { p_token: A2, p_date: "2026-11-25", p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) }), /today's MB52/);
  await rpc("admin_load_daily", { p_token: A2, p_date: "2026-11-26", p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) });
  await db.query("update public.snapshots set loaded_at = '2026-11-26 09:00:00+08' where snap_date = '2026-11-26'");
  const r = await rpc("plant_login", { p_code: "1501" }); assert.equal(r.wait, null); assert.equal(r.take.kind, "daily");
  assert.equal(r.take.countTo, "12:00", "window 06:30-09:30, released 09:00: 3 hours from the release");
  assert.equal((await rpc("admin_dcc_today", { p_token: A2 })).rows.find((x) => x.branch === "NDD Alpha").to, "12:00");
});
await t("opening a monthly: a warehouse mid daily count blocks it, untouched daily lists go; stop & reset", async () => {
  const TA = (await rpc("plant_login", { p_code: "1501" })).token;
  await rpc("admin_dcc_day", { p_token: A2 });   // both lists exist
  const s = await rpc("counter_start", { p_token: TA, p_device: "d-a", p_branch: "NDD Alpha", p_role: "ops", p_data: { member: "Ali", names: ["Ali"] } });
  await rpc("admin_draft", { p_token: A2, p_name: "Reset me", p_scope: "total", p_skus: [] });
  await rpc("admin_load_mb52", { p_token: A2, p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) });
  await rejects(rpc("admin_set_status", { p_token: A2, p_status: "open" }), /NDD Alpha started today's daily count/);
  await rpc("admin_stop_daily", { p_token: A2, p_branch: "NDD Alpha", p_stop: true });
  await rpc("admin_set_status", { p_token: A2, p_status: "open" });
  assert.equal((await db.query("select count(*)::int n from public.stock_takes where kind = 'daily' and count_date = '2026-11-26'")).rows[0].n, 0, "Beta's untouched list is gone");
  assert.equal((await rpc("admin_dcc_day", { p_token: A2 })).rows.find((x) => x.branch === "NDD Beta").why, "monthly");
  const m = await rpc("counter_start", { p_token: TA, p_device: "d-a", p_branch: "NDD Alpha", p_role: "ops", p_data: { member: "Ali", names: ["Ali"] } });
  assert.notEqual(m.id, s.id);
  await rejects(rpc("admin_reset_take", { p_token: TA, p_confirm: "Reset me" }), /login|admin/i);
  await rejects(rpc("admin_reset_take", { p_token: A2, p_confirm: "reset" }), /Type the stock take name/);
  const rr = await rpc("admin_reset_take", { p_token: A2, p_confirm: "Reset me" }); assert.equal(rr.take.status, "draft"); assert.equal(rr.sessions, 1);
  assert.equal((await db.query("select count(*)::int n from public.count_sessions where id = $1", [m.id])).rows[0].n, 0);
  assert.equal((await rpc("admin_load", { p_token: A2 })).takeInfo.skuCount >= 0, true, "MB52 and setup stay");
});
await t("KPI002: IRA by value from the month-end stock take; a SKU nobody counted counts as not found", async () => {
  const id = (await db.query("insert into public.stock_takes (name, kind, status, mode, scope, skus, opened_at, closed_at) values ('Month-end Nov', 'monthly', 'closed', 'single', 'total', '{}', '2026-11-29 08:00+08', '2026-11-29 18:00+08') returning id")).rows[0].id;
  await db.query("insert into public.sys_stock (take_id, branch, code, batch, qty, unit_cost) values ($1, 'NDD Alpha', 'A1', '2027-03', 264, 2), ($1, 'NDD Alpha', 'C3', '2027-01', 100, 5)", [id]);
  await db.query("insert into public.count_sessions (take_id, device_id, branch, role, data, status, submitted_at) values ($1, 'd-k', 'NDD Alpha', 'ops', $2, 'submitted', now())", [id, JSON.stringify({ member: "Ali", lines: { "A1|2027-03": L("A1", "2027-03", null, null, 260) } })]);
  await rejects(rpc("admin_set_kpi_month", { p_token: TD, p_take: id, p_month: "2026-11-01" }), /login|admin/i);
  assert.equal((await rpc("admin_set_kpi_month", { p_token: A2, p_take: id, p_month: "2026-11-15" })).kpiMonth, "2026-11-01");
  const k = await rpc("admin_kpi", { p_token: A2, p_month: "2026-11-01" }), al = k.branches.find((x) => x.branch === "NDD Alpha");
  assert.equal(k.kpi2Take.name, "Month-end Nov");
  assert.equal(al.kpi2.sysRm, 1028); assert.equal(al.kpi2.absRm, 508); assert.equal(al.kpi2.ira, Number((1 - 508 / 1028).toFixed(6)));
  assert.equal(al.top[0].code, "A1"); assert.equal(al.top[0].varRm, -8);
  assert.equal(k.trend[5].ira, al.kpi2.ira);
  /* public dashboard: no RM and no SKUs ever; the IRA % only at dashboard level "value" */
  await rpc("admin_settings", { p_token: A2, p_patch: { dash_level: "progress" } });
  let pk = await rpc("public_kpi", { p_month: "2026-11-01" }), pa = pk.branches.find((x) => x.branch === "NDD Alpha");
  assert.equal(pk.kpi2Hidden, true); assert.equal(pa.kpi2, null); assert.equal(pk.kpi2Take, null); assert.equal(pk.trend[5].ira, null);
  assert.deepEqual(pa.cells.map((c) => c.st), k.branches.find((x) => x.branch === "NDD Alpha").cells.map((c) => c.st), "KPI001 is the same as the admin view");
  await rpc("admin_settings", { p_token: A2, p_patch: { dash_level: "value" } });
  pk = await rpc("public_kpi", { p_month: "2026-11-01" }); pa = pk.branches.find((x) => x.branch === "NDD Alpha");
  assert.equal(pk.kpi2Hidden, false); assert.equal(pa.kpi2.ira, al.kpi2.ira); assert.equal(pk.kpi2Ira, k.kpi2Ira); assert.equal(k.kpi2Ira, al.kpi2.ira, "only Alpha in this take"); assert.equal(pa.kpi2.sysRm, null); assert.equal(pa.kpi2.absRm, null);
  assert.deepEqual(pa.top, []); assert.equal(pk.kpi2Take.id, null); assert.equal(JSON.stringify(pk).includes("508"), false, "no RM figure anywhere");
  await rpc("admin_settings", { p_token: A2, p_patch: { dash_level: "progress" } });
  await rejects(rpc("public_kpi", { p_month: "2026-04-01" }), /last 6 months/); await rejects(rpc("public_kpi", { p_month: "2026-12-01" }), /last 6 months/);
  await db.query("update public.stock_takes set stock_type = 'bad' where id = $1", [id]);
  await rejects(rpc("admin_set_kpi_month", { p_token: A2, p_take: id, p_month: "2026-11-01" }), /good-stock/);
  await db.query("delete from public.stock_takes where id = $1", [id]);
});
await t("owner deletes a closed stock take (counts, results, photos); admin can't; open one can't be deleted", async () => {
  const OW = (await rpc("admin_login", { p_password: "OwnerPass1" })).token;
  const cur = (await rpc("admin_load", { p_token: A2 })).current, takes = (await rpc("admin_load", { p_token: A2 })).takes;
  const old = takes.find((x) => x.id !== cur && x.status !== "open");
  await rejects(rpc("owner_delete_take", { p_token: A2, p_take: old.id }), /owner/i);
  const r = await rpc("owner_delete_take", { p_token: OW, p_take: old.id }); assert.equal(r.name, old.name);
  assert.equal((await db.query("select count(*)::int n from public.count_sessions where take_id = $1", [old.id])).rows[0].n, 0);
  assert.equal((await rpc("admin_load", { p_token: A2 })).takes.some((x) => x.id === old.id), false);
  /* the current one (closed) can go too: current moves to the newest remaining monthly stock take */
  const r2 = await rpc("owner_delete_take", { p_token: OW, p_take: cur }); assert.ok(r2.name);
  const after = await rpc("admin_load", { p_token: A2 }); assert.notEqual(after.current, cur); assert.ok(after.takeInfo && after.takeInfo.id === after.current);
  await rpc("admin_draft", { p_token: A2, p_name: "Open one", p_scope: "total", p_skus: [] });
  await rpc("admin_load_mb52", { p_token: A2, p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) }); await rpc("admin_set_status", { p_token: A2, p_status: "open" });
  await rejects(rpc("owner_delete_take", { p_token: OW, p_take: (await rpc("admin_load", { p_token: A2 })).current }), /Close counting first/);
  await rpc("admin_set_status", { p_token: A2, p_status: "closed" });
});
await t("bad settings rejected", async () => {
  await rejects(rpc("admin_settings", { p_token: A2, p_patch: { dcc_abc: { a: 96, b: 95 } } }), /A must be below B/);
  await rejects(rpc("admin_settings", { p_token: A2, p_patch: { dcc_target: { A: 0, B: 2, C: 1 } } }), /1-31/);
  await db.query("delete from public.settings where key = 'test_today'");
});

await t("import a result Excel from the previous app as a closed stock take", async () => {
  const P = { name: "Imported test", opened: "2026-11-25T08:06:00+08:00", closed: "2026-11-25T15:00:00+08:00", loaded: "2026-11-25T08:06:00+08:00", source: "x.xlsx",
    meta: { imported: true, goodV: 10 }, skus: [{ code: "ZZ9", desc: "New SKU", per: 10, box: null }],
    sys: [{ b: "NDD Alpha", c: "A1", bt: "2027-01", q: 100, u: 0.5 }, { b: "NDD Gone", c: "A1", bt: "2027-01", q: 5, u: 0.5 }],
    sessions: [{ branch: "NDD Alpha", member: "Ana", device: "import-1", start: "2026-11-25T09:00:00+08:00", end: "2026-11-25T10:00:00+08:00",
      lines: { "A1|2027-01": { code: "A1", batch: "2027-01", ctn: 9, box: null, pcs: 4, per: 999, perBox: null, total: 98, remark: "", t: null },
               "ZZ9|": { code: "ZZ9", batch: "", ctn: 1, box: null, pcs: 0, per: 10, perBox: null, total: 10, remark: "", t: null } } },
      { branch: "NDD Gone", member: "X", device: "import-2", start: "2026-11-25T09:00:00+08:00", end: "2026-11-25T09:00:00+08:00", lines: {} }] };
  const ADM2 = (await db.query("select token from public.tokens where kind in ('owner', 'finance') and expires_at > now() order by expires_at desc limit 1")).rows[0].token;
  await rejects(rpc("admin_import_take", { p_token: TA, p_payload: P }), /./);
  const r = await rpc("admin_import_take", { p_token: ADM2, p_payload: P });
  assert.equal(r.ok, true); assert.deepEqual(r.skipped, ["NDD Gone"]);
  const a = await rpc("admin_load", { p_token: ADM2, p_take: r.take });
  assert.equal(a.takeInfo.status, "closed"); assert.equal(a.takeInfo.mode, "single");
  const s = a.sessions.find((x) => x.branch === "NDD Alpha"); assert.equal(s.status, "submitted");
  assert.equal(s.data.lines["A1|2027-01"].pcs, 98); assert.equal(s.data.lines["A1|2027-01"].ctn, null);   // pack size differs from the app's: total pieces kept
  assert.equal(s.data.lines["ZZ9|"].ctn, 1);                                                                // same pack size: cartons kept
  await rejects(rpc("admin_import_take", { p_token: ADM2, p_payload: P }), /Already imported/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
