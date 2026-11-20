# KPI001 / KPI002: wizard month-end flag, holiday calendar, KPI dashboard (live empty state + Demo data with charts).
# Fresh server: BOOTSTRAP_CODE=SETUP-123 node server.mjs
import json
from playwright.sync_api import sync_playwright
BASE = "http://localhost:8787"; OUT = "/tmp/ndd-ui"
ok = 0; bad = 0
def check(n, c, e=""):
    global ok, bad
    if c: ok += 1; print("  ✓", n)
    else: bad += 1; print("  ✗", n, str(e)[:600])
def B(t): return f'button:has-text("{t}")'
def SB(t): return f'#sheet button:has-text("{t}")'
def rpc(pg, name, args):
    return pg.evaluate("""async ([n, a]) => { const t = JSON.parse(localStorage.getItem('ndd2-admin')).token;
      const r = await fetch('/rest/v1/rpc/' + n, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ p_token: t }, a)) }); return r.json(); }""", [name, args])

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ow = b.new_page(viewport={"width": 1280, "height": 900}); errs = []
    ow.on("pageerror", lambda e: errs.append(str(e))); ow.on("console", lambda m: m.type == "error" and errs.append("console: " + m.text))
    ow.goto(BASE + "/?api=local"); ow.click(B("Start first-time setup"))
    ow.fill("input[placeholder='Setup code']", "SETUP-123"); ow.fill("input[placeholder^='New owner password']", "OwnerPass1"); ow.fill("input[placeholder='Repeat password']", "OwnerPass1"); ow.click(SB("Save")); ow.click(SB("OK"))

    print("wizard: month-end stock take (KPI002)")
    kb = ".kpibox input[type=checkbox]"
    check("KPI box shown, not ticked by default", ow.is_visible("text=Month-end stock take (KPI002)") and not ow.is_checked(kb))
    ow.click(".choice:has-text('Bad stock')")
    check("bad stock: KPI box disabled (good stock only)", ow.is_disabled(kb) and "good stock only" in ow.inner_text(".kpibox"), ow.inner_text(".kpibox"))
    ow.click(".choice:has-text('Good stock')"); ow.check(kb)
    opts = ow.locator(".kpibox select option").all_inner_texts(); check("month choice: last month and this month", len(opts) == 2 and "November 2026" in opts, opts)
    ow.select_option(".kpibox select", label="November 2026")
    ow.fill("input[placeholder='Cycle count Nov week 4']", "Month-end Nov"); ow.click(".choice:has-text('Total')"); ow.click(B("Save and continue"))
    ow.wait_for_selector("text=3. Upload the SAP MB52")
    check("step 1 summary says KPI", "KPI" in ow.inner_text(".wiz"), ow.inner_text(".wiz")[:200])
    ti = rpc(ow, "admin_load", {})["takeInfo"]; check("server: take marked for Nov 2026", ti.get("kpiMonth") == "2026-11-01", ti.get("kpiMonth"))
    ow.click(".wiz button:has-text('1. Name and type')"); ow.uncheck(kb); ow.click(B("Save and continue")); ow.wait_for_timeout(600)
    check("untick: mark removed", rpc(ow, "admin_load", {})["takeInfo"].get("kpiMonth") is None)

    print("settings: minimum SKUs + holidays")
    ow.click("#tabs button:text-is('Settings')"); ow.wait_for_selector("text=Holidays (KPI001)"); ow.wait_for_selector("text=No holidays yet.")
    hc = ".card:has(h3:text-is('Holidays (KPI001)'))"
    ow.click(f"{hc} {B('Add holiday')}"); check("date required", ow.is_visible("#sheet >> text=Pick the date")); ow.click(SB("OK"))
    ow.fill(f"{hc} input[type=date]", "2026-12-25"); ow.fill(f"{hc} input[type=text]", "Christmas"); ow.click(f"{hc} {B('Add holiday')}"); ow.wait_for_timeout(500)
    ht = ow.inner_text(hc); check("holiday listed as national", "Christmas" in ht and "All (national)" in ht and "25 Dec 2026" in ht, ht)
    ow.click(f"{hc} button:text-is('Remove')"); ow.wait_for_selector("text=No holidays yet."); check("holiday removed", True)
    mn = ow.locator(".card:has(h3:text-is('Daily cycle count')) .row:has-text('Minimum SKUs a day') input")
    mn.fill("0"); ow.click(B("Save rules")); ow.wait_for_selector("#sheet >> text=Save failed", timeout=5000); check("min SKUs 0 rejected", "1-50" in ow.inner_text("#sheet"), ow.inner_text("#sheet")); ow.click(SB("OK"))
    errs.clear()   # the rejected save above logs a 400 on purpose
    mn.fill("12"); ow.click(B("Save rules")); ow.click(SB("OK")); ow.wait_for_timeout(300)

    print("dashboard: live (nothing yet)")
    ow.click("#tabs button:text-is('Dashboard')"); ow.wait_for_selector("text=KPI · Nov 2026"); ow.wait_for_selector("text=Daily cycle count", timeout=15000); ow.wait_for_selector("text=Needs attention")
    dt = ow.inner_text("main")
    check("KPI section on top with both KPIs", dt.index("KPI · Nov 2026") < dt.index("Daily operations") and "KPI001" in dt and "KPI002" in dt, dt[:500])
    check("min SKUs from Settings shown in KPI001 rule", "at least 12 SKUs" in dt)
    check("KPI002 empty: explains how to mark the month-end stock take", "No month-end stock take is marked for Nov 2026" in dt)
    check("ops tile renamed to SKU accuracy", "SKU accuracy" in dt and "Accuracy (IRA)" not in dt)

    print("dashboard: Demo data")
    ow.click("button.chip:has-text('Demo data')"); ow.wait_for_selector("text=Made-up numbers for 12 NDDs")
    check("demo banner + chip on", ow.is_visible(".banner.warn:has-text('Demo data')") and "on" in ow.get_attribute("button.chip:has-text('Demo data')", "class"))
    k1 = ".card:has(h3:has-text('Daily cycle count'))"; k2 = ".card:has(h3:has-text('Stock take (end of month)'))"
    check("KPI001: 12 warehouse bars", ow.locator(f"{k1} .kb .trk").count() == 12, ow.locator(f"{k1} .kb .trk").count())
    check("KPI001: day-by-day calendar 12 rows × 30 days", ow.locator(f"{k1} .kcal tr").count() == 13 and ow.locator(f"{k1} .kcal tr").nth(1).locator("td").count() == 30)
    check("KPI001: two line charts with legends", ow.locator(f"{k1} svg.kc").count() == 2 and ow.locator(f"{k1} .kl").count() >= 3)
    check("KPI001: fail reasons listed", ow.is_visible(f"{k1} .kfr"), "")
    check("KPI001: Kelantan has off days on Fri/Sat", ow.locator(f"{k1} .kcal tr:has(th:text-is('Kelantan')) i.k-off").count() >= 8)
    check("KPI002: 12 IRA bars with target line", ow.locator(f"{k2} .kb2 .trk").count() == 12 and ow.locator(f"{k2} .kb2 .trk b").count() == 12)
    check("KPI002: zoomed axis is stated", "Axis starts at" in ow.inner_text(k2))
    check("KPI002: by-warehouse table + total + top SKUs + trend", ow.locator(f"{k2} tr.tot").count() == 1 and "Biggest SKU variances" in ow.inner_text(k2) and ow.locator(f"{k2} svg.kc").count() == 1)
    tiles = ow.inner_text(".stats.dccst >> nth=0"); check("tiles: KPI001 / KPI002 with target status", tiles.count("KPI001") == 2 and tiles.count("KPI002") == 2 and ("On target" in tiles or "Below target" in tiles), tiles)
    check("ops sections filled by demo (12 warehouses today)", ow.locator(".card:has(h3:text-is('Today per warehouse')) tr").count() == 13)
    check("daily report export disabled in demo", ow.is_disabled("button:text-is('⬇ Export')"))
    ow.hover(f"{k1} .kb .trk i >> nth=0"); ow.wait_for_timeout(150)
    check("hover a bar segment: tooltip with days", ow.is_visible("#kpi-tip") and "days" in ow.inner_text("#kpi-tip"), ow.inner_text("#kpi-tip") if ow.is_visible("#kpi-tip") else "")
    ow.hover(f"{k1} .kcal tr >> nth=1 >> td >> nth=2"); ow.wait_for_timeout(150)
    check("hover a calendar day: tooltip with warehouse and date", ow.is_visible("#kpi-tip") and "Nov" in ow.inner_text("#kpi-tip"), ow.inner_text("#kpi-tip") if ow.is_visible("#kpi-tip") else "")
    box = ow.locator(f"{k1} svg.kc >> nth=1").bounding_box(); ow.mouse.move(box["x"] + box["width"] - 20, box["y"] + box["height"] / 2); ow.wait_for_timeout(150)
    check("hover the trend: month tooltip with achievement", ow.is_visible("#kpi-tip") and "Achievement" in ow.inner_text("#kpi-tip"), ow.inner_text("#kpi-tip") if ow.is_visible("#kpi-tip") else "")
    ow.mouse.move(5, 5)
    ow.screenshot(path=f"{OUT}/kpi_demo.png", full_page=True)
    # region filter narrows the KPI too
    ow.select_option("main select >> nth=1", "Sarawak"); ow.wait_for_timeout(300)
    check("region filter: KPI bars for Sarawak only (3)", ow.locator(f"{k1} .kb .trk").count() == 3 and ow.locator(f"{k2} .kb2 .trk").count() == 3)
    check("filtered trend says all warehouses", "(all warehouses)" in ow.inner_text(k1))
    ow.select_option("main select >> nth=1", ""); ow.wait_for_timeout(300)
    # month switch
    ow.select_option(".kh select", label="Oct 2026"); ow.wait_for_selector("text=KPI · Oct 2026")
    check("October: whole month done (no coming days)", ow.locator(f"{k1} .kcal i.k-future").count() == 0 and ow.locator(f"{k1} .kcal tr").nth(1).locator("td").count() == 31)
    # KPI Excel
    with ow.expect_download() as dl: ow.click(B("⬇ KPI Excel"))
    x = ow.evaluate("window.__kpiXlsx"); ow.click(SB("OK"))
    check("KPI Excel: 5 sheets, 12 warehouses, DEMO in file name", x["sheets"] == ["KPI001", "KPI001 by day", "KPI002", "KPI002 top SKUs", "Notes"] and len(x["kpi1"]) == 13 and len(x["kpi2"]) == 13 and "_DEMO" in dl.value.suggested_filename, [x["sheets"], dl.value.suggested_filename])
    r1 = x["kpi1"][1]; check("KPI Excel: achievement = passed / HKE", abs(r1[9] - round(r1[4] / r1[3] * 100, 2)) < 0.01 if r1[3] else True, r1)
    # iPad + dark
    ip = b.new_page(viewport={"width": 820, "height": 1180}, color_scheme="dark")
    ip.goto(BASE + "/?api=local"); ip.evaluate("t => localStorage.setItem('ndd2-admin', t)", ow.evaluate("localStorage.getItem('ndd2-admin')")); ip.goto(BASE + "/?api=local")
    ip.click("#tabs button:text-is('Dashboard')"); ip.click("button.chip:has-text('Demo data')"); ip.wait_for_selector("text=Made-up numbers"); ip.wait_for_timeout(400)
    sw = ip.evaluate("document.documentElement.scrollWidth"); check("iPad: no sideways scroll on the page", sw <= 820, sw)
    ip.screenshot(path=f"{OUT}/kpi_demo_ipad_dark.png", full_page=True)
    # public dashboard (no login)
    pb = b.new_page(viewport={"width": 1280, "height": 900}); pb.on("pageerror", lambda e: errs.append("public: " + str(e)))
    pb.goto(BASE + "/dashboard/?api=local"); pb.wait_for_selector("#kpi >> text=KPI · Nov 2026"); pb.wait_for_selector("#kpi .card")
    kt = pb.inner_text("#kpi")
    check("public: KPI section on top, both KPIs", "KPI001" in kt and "KPI002" in kt and pb.evaluate("document.querySelector('#kpi').compareDocumentPosition(document.querySelector('#dcc')) & 4") > 0, kt[:300])
    check("public: KPI002 not published at level 'progress'", "Not published" in kt and "published here when HQ sets" in kt, kt)
    check("public: no Excel button, no RM", not pb.is_visible("#kpi button:has-text('KPI Excel')") and "RM" not in kt)
    pb.goto(BASE + "/dashboard/?api=local&demo=1"); pb.wait_for_selector("#kpi >> text=Made-up numbers"); pb.wait_for_selector("#kpi .kb2")
    kt = pb.inner_text("#kpi")
    tl = pb.inner_text("#kpi .stats"); check("public demo: national IRA tile filled (no RM)", "99." in tl.split("Stock take IRA")[0].split("KPI002")[-1] and "RM" not in tl, tl)
    check("public demo: 12 KPI001 bars + 12 IRA bars", pb.locator("#kpi .kb:not(.kb2) .trk").count() == 12 and pb.locator("#kpi .kb2 .trk").count() == 12)
    check("public demo: no RM, no SKU list anywhere in KPI", "RM" not in kt and "Biggest SKU" not in kt and pb.locator("#kpi th:text-is('SAP value')").count() == 0, kt[-600:])
    pb.hover("#kpi .kb2 .trk >> nth=0"); pb.wait_for_timeout(150); tp = pb.inner_text("#kpi-tip")
    check("public demo: IRA tooltip has no RM", "IRA" in tp and "RM" not in tp, tp)
    pb.select_option("#kpi .kh select", label="Oct 2026"); pb.wait_for_selector("#kpi >> text=KPI · Oct 2026"); check("public: month switch", True)
    check("public demo: daily section also demo, no RM", pb.locator("#dcc .dccgrid tr").count() == 13 and "Net variance" not in pb.inner_text("#dcc"))
    pb.screenshot(path=f"{OUT}/kpi_public_demo.png", full_page=True)
    # off again
    ow.select_option(".kh select", label="Nov 2026"); ow.click("button.chip:has-text('Demo data')"); ow.wait_for_timeout(500)
    check("demo off: live data again", not ow.is_visible("text=Made-up numbers") and "No month-end stock take is marked" in ow.inner_text("main"))
    check("no page errors", not errs, errs)
print(f"\n{ok} passed, {bad} failed")
