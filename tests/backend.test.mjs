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
  return { meta: { goodV: res.totV }, byBr: res.byBr, descs: res.descs, plants };
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
});
await t("open counting; can't start another stock take while open", async () => {
  const o = await rpc("admin_set_status", { p_token: ADM, p_status: "open" }); assert.equal(o.status, "open");
  await rejects(rpc("admin_draft", { p_token: ADM, p_name: "Another", p_scope: "total", p_skus: [] }), /close the current/);
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
const day = async (d) => { await db.query(`insert into public.settings (key, value) values ('test_today', '"${d}"') on conflict (key) do update set value = excluded.value`); };
await t("setup: admin login, monthly closed, photos optional, today = Wed 18 Nov 2026", async () => {
  A2 = (await rpc("admin_login", { p_password: "NewAdm77" })).token; assert.ok(A2);
  await db.query("update public.stock_takes set status = 'closed', closed_at = now() - interval '2 days' where kind = 'monthly'"); await db.query("delete from public.count_log");
  await rpc("admin_settings", { p_token: A2, p_patch: { photo_min: 0 } }); await day("2026-11-18");
});
await t("no stock upload yet: nothing planned, counter told there's nothing to count", async () => {
  const r = await rpc("plant_login", { p_code: "1501" }); TD = r.token; assert.equal(r.take.kind, "monthly");
  await rejects(rpc("counter_start", { p_token: TD, p_device: "d-1", p_branch: "NDD Alpha", p_role: "ops", p_data: {} }), /Nothing to count at NDD Alpha today/);
  const o = await rpc("admin_dcc_day", { p_token: A2 }); assert.equal(o.rows.find((x) => x.branch === "NDD Alpha").why, "nostock");
});
await t("daily stock upload; ABC by value per warehouse (A 80%, B next 15%, C rest)", async () => {
  const r = await rpc("admin_load_daily", { p_token: A2, p_date: "2026-11-17", p_payload: mb52Payload(["NDD Alpha", "NDD Beta"]) }); assert.equal(r.branches, 2);
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
await t("counter gets today's daily list after the plant code", async () => {
  const r = await rpc("plant_login", { p_code: "1501" }); TD = r.token; assert.equal(r.take.kind, "daily"); assert.equal(r.take.countDate, "2026-11-18");
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
await t("next day: yesterday closes and is logged; out-of-tolerance SKU comes back as a recount", async () => {
  await day("2026-11-19");
  const r = await rpc("plant_login", { p_code: "1501" }); assert.equal(r.take.countDate, "2026-11-19");
  const lg = (await db.query("select code, flag from public.count_log where branch = 'NDD Alpha' and kind = 'daily' order by code")).rows;
  assert.deepEqual(lg.map((x) => x.code + ":" + x.flag), ["C3:OVER", "D4:WITHIN"]);
  const o = await rpc("admin_dcc_day", { p_token: A2 }); assert.deepEqual(o.rows.find((x) => x.branch === "NDD Alpha").take.plan, { A1: "A", C3: "R" });
  const st = await rpc("admin_dcc_stats", { p_token: A2, p_from: "2026-11-18", p_to: "2026-11-19" });
  assert.equal(st.branches.find((x) => x.branch === "NDD Beta").cells[0].st, "missed");
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
  const r = await rpc("plant_login", { p_code: "1501" }); assert.equal(r.take.kind, "monthly"); assert.equal(r.take.name, "Monthly Nov");
  assert.equal((await rpc("admin_dcc_day", { p_token: A2 })).rows.find((x) => x.branch === "NDD Alpha").why, "monthly");
  assert.equal((await rpc("admin_load", { p_token: A2 })).takes.every((x) => x.kind === "monthly"), true);
  await rpc("admin_set_status", { p_token: A2, p_status: "closed" });
  assert.equal((await rpc("plant_login", { p_code: "1501" })).take.kind, "daily");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
