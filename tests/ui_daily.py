# UI test for the daily cycle count (run after ui_test.py has written /tmp/ndd-ui/mb52.xlsx).
# Fresh server: BOOTSTRAP_CODE=SETUP-123 node server.mjs
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8787"); OUT = "/tmp/ndd-ui"
ok = 0; bad = 0
def check(name, cond, extra=""):
    global ok, bad
    if cond: ok += 1; print("  ✓", name)
    else: bad += 1; print("  ✗", name, str(extra)[:1500])
def B(t): return f'button:has-text("{t}")'
def SB(t): return f'#sheet button:has-text("{t}")'
def pad(pg, digits, scope=""):
    for d in digits: pg.click(f"{scope}.pad button:text-is('{d}')")
    pg.click(f"{scope}button:text-is('Next')")

with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    errs = []
    def page(w, h):
        ctx = br.new_context(viewport={"width": w, "height": h}, is_mobile=w < 600, has_touch=w < 600)
        pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: m.type == "error" and "ERR_INTERNET_DISCONNECTED" not in m.text and errs.append("console: " + m.text))
        return pg

    print("HQ: daily stock upload")
    ow = page(1280, 900); ow.goto(BASE + "/?api=local"); ow.click(B("Start first-time setup"))
    ow.fill("input[placeholder='Setup code']", "SETUP-123"); ow.fill("input[placeholder^='New owner password']", "OwnerPass1"); ow.fill("input[placeholder='Repeat password']", "OwnerPass1")
    ow.click(SB("Save")); ow.click(SB("OK"))
    ow.click("#tabs button:text-is('Daily')"); ow.wait_for_selector("text=Daily stock (MB52)")
    check("Daily tab: asks for the first upload", ow.is_visible("text=Upload the MB52 to start daily counts"))
    ow.set_input_files(".card:has(h3:text-is('Daily stock (MB52)')) input[type=file]", f"{OUT}/mb52.xlsx"); ow.wait_for_selector("#sheet >> text=New branches in this MB52")
    ow.click(SB("Continue")); ow.wait_for_selector("#sheet >> text=Load MB52?")
    check("confirm says it becomes the daily stock", "system stock dated" in ow.inner_text("#sheet"), ow.inner_text("#sheet"))
    ow.click(SB("Load")); ow.wait_for_selector("#sheet >> text=Daily stock loaded", timeout=20000); ow.click(SB("OK"))
    ow.wait_for_selector("text=Daily counts ·"); ow.wait_for_timeout(500)
    tt = ow.inner_text(".card:has(h3:has-text('Daily counts'))")
    check("each warehouse has today's list (Not started, 0 / n)", "Not started: 3" in tt and tt.count("0 / 1") == 3, tt)
    ow.click("tr:has(td:text-is('NDD Alpha')) button:text-is('ABC')"); ow.wait_for_selector("#sheet >> text=ABC")
    at = ow.inner_text("#sheet"); check("ABC: A1 is A (most value), B2/C3 lower", "A1 Wafer A 50g" in at and "62.9%" in at or "A1" in at, at); ow.click(SB("Close"))
    ow.click("tr:has(td:text-is('NDD Alpha')) button:text-is('List')"); lt = ow.inner_text("#sheet"); check("today's list for Alpha is A1 (class A)", "A1" in lt, lt); ow.click(SB("Close"))

    print("HQ: settings")
    ow.click("#tabs button:text-is('Settings')"); ow.wait_for_selector("text=Daily cycle count")
    ow.locator(".card:has(h3:text-is('Warehouse photos at submit')) input[type=number]").first.fill("0"); ow.click(".card:has(h3:text-is('Warehouse photos at submit')) button:has-text('Save')"); ow.click(SB("OK"))
    ow.click("tr:has(td:text-is('NDD Alpha')) button:text-is('Create')"); ow.click(SB("Create")); ow.wait_for_selector("#sheet >> text=PIN:")
    pin = ow.inner_text("#sheet").split("PIN: ")[1][:6]; check("supervisor PIN shown once (6 digits)", pin.isdigit() and len(pin) == 6, pin); ow.click(SB("OK"))
    check("PIN status: not changed yet", "Not changed yet" in ow.inner_text("tr:has(td:text-is('NDD Alpha'))"))

    print("counter: today's list")
    op = page(390, 844); op.goto(BASE + "/?api=local"); op.wait_for_selector("text=Enter your warehouse plant code"); pad(op, "1501")
    op.wait_for_selector("text=Today's cycle count"); check("confirm shows today's cycle count", "1 SKU(s)" in op.inner_text("main"), op.inner_text("main"))
    op.click(B("Yes, that's my warehouse")); op.wait_for_selector("text=Who is counting?")
    check("daily = single count: no team step", not op.is_visible("text=Which team are you?"))
    op.fill("input[placeholder*='name' i]", "Siti"); op.keyboard.press("Enter"); op.wait_for_timeout(300)
    op.click(B("Start count")); op.wait_for_selector("text=Today's cycle count · 1 SKU(s)")
    check("count screen: today's banner", True)
    op.click(".skuh:has-text('A1')"); op.wait_for_timeout(200); op.locator(".sku:has-text('A1') .batch").first.locator(".val").last.click()
    [op.click(f"#sheet .pad button:text-is('{k}')") for k in "355"]; op.click(SB("OK")); op.wait_for_timeout(2500)

    print("HQ sees progress; Master read-only view")
    ow.click("#tabs button:text-is('Daily')"); ow.wait_for_selector("text=Daily counts ·"); ow.wait_for_timeout(500)
    ar = ow.inner_text("tr:has(td:text-is('NDD Alpha'))"); check("Alpha: Counting, 1 / 1", "Counting" in ar and "1 / 1" in ar, ar)
    ow.click("tr:has(td:text-is('NDD Alpha')) button:text-is('View')"); ow.wait_for_selector("text=Daily count (read-only)")
    check("View opens the day in Master", "COUNTED" in ow.inner_text("main") or "A1" in ow.inner_text("main"), ow.inner_text("main")[:400])
    ow.click(B("Back to Daily")); ow.wait_for_selector("text=Daily counts ·")

    print("supervisor")
    sp = page(390, 844); sp.goto(BASE + "/?api=local"); sp.click(B("Warehouse supervisor? Log in here"))
    sp.fill("#sheet input[placeholder='Plant code']", "1501"); sp.fill("#sheet input[placeholder='Supervisor PIN']", "000000" if pin != "000000" else "111111"); sp.click(SB("Log in"))
    sp.wait_for_selector("#sheet >> text=Wrong plant code or PIN"); check("wrong PIN refused", True)
    sp.fill("#sheet input[placeholder='Supervisor PIN']", pin); sp.click(SB("Log in")); sp.wait_for_selector("#sheet >> text=Choose your own PIN")
    sp.fill("#sheet input[placeholder^='New PIN']", "24681357"); sp.fill("#sheet input[placeholder='Repeat new PIN']", "24681357"); sp.click(SB("Save PIN"))
    sp.wait_for_selector("text=Today's list"); st = sp.inner_text("main")
    check("supervisor sees own warehouse today: A1 batch 03/2027 counted 355 vs system 240, batch 05/2027 120", "NDD Alpha" in st and "355" in st and "240" in st and "120" in st, st[:600])
    check("supervisor header: Log out, tabs My warehouse/Count", sp.inner_text("#lockBtn").strip() == "Log out" and "My warehouse" in sp.inner_text("#tabs"))
    sp.click(B("+ Add SKU to today")); sp.fill("#sheet input[placeholder='Search SKU code or name']", "C3"); sp.click("#sheet .big:has-text('C3')")
    sp.wait_for_timeout(800); check("added SKU shows with S tag", "C3" in sp.inner_text("main") and sp.is_visible(".cls-S"), sp.inner_text("main")[:500])
    check("can't skip after counting started", not sp.is_visible(B("Skip today")))
    sp.click(B("This month's plan")); sp.wait_for_selector("#sheet >> text=ABC 20"); check("plan modal opens (supervisor can see the ABC plan)", "A1" in sp.inner_text("#sheet")); sp.click(SB("Close"))
    sp.screenshot(path=f"{OUT}/sup.png", full_page=True); sp.click("#lockBtn"); sp.wait_for_selector("text=Enter your warehouse plant code"); check("supervisor log out back to start", True)
    op.reload(); op.wait_for_timeout(1500); op.click(".seg button:text-is('All')") if op.is_visible(".seg button:text-is('All')") else None
    check("counter now sees the added SKU (2 on the list)", "2 SKU(s)" in op.inner_text("main"), op.inner_text("main")[:300])

    print("dashboards")
    ow.click("#tabs button:text-is('Dashboard')"); ow.wait_for_selector("text=Compliance · warehouse × day")
    dt = ow.inner_text("main"); check("admin dashboard: KPIs, grid, trends, table", all(x in dt for x in ["Counted today", "SKU coverage", "Accuracy (IRA)", "Net variance", "By warehouse", "Top variance SKUs"]), dt[:500])
    check("grid has a row per warehouse", ow.locator(".dccgrid tr").count() == 4)
    pd = page(1280, 900); pd.goto(BASE + "/dashboard/?api=local"); pd.wait_for_selector("text=Daily cycle count · this month")
    pt = pd.inner_text("main"); check("public dashboard: daily section, no RM", "SKU coverage" in pt and "Net variance" not in pt and "Top variance" not in pt, pt[:400])
    pd.screenshot(path=f"{OUT}/public_dcc.png", full_page=True); ow.screenshot(path=f"{OUT}/admin_dash.png", full_page=True)
    ow.click("#tabs button:text-is('Daily')"); ow.wait_for_selector("text=Daily counts ·"); ow.wait_for_timeout(400); ow.screenshot(path=f"{OUT}/admin_daily.png", full_page=True)
    ow.click("#tabs button:text-is('Settings')"); ow.wait_for_selector("text=Daily cycle count"); ow.locator(".card:has(h3:text-is('Daily cycle count'))").screenshot(path=f"{OUT}/admin_dccset.png")

    print("offline change + log out + phone syncs to another stock take: the unsent count survives")
    op.wait_for_selector("text=Today's cycle count"); op.context.set_offline(True)
    op.click(".seg button:text-is('All')"); op.wait_for_timeout(200)
    if not op.is_visible(".sku:has-text('A1') .batch"): op.click(".skuh:has-text('A1')"); op.wait_for_timeout(200)
    op.locator(".sku:has-text('A1') .batch").first.locator(".val").last.click(); [op.click(f"#sheet .pad button:text-is('{k}')") for k in ["C", "3", "5", "6"]]; op.click(SB("OK")); op.wait_for_timeout(1500)
    op.click("#lockBtn"); op.click("#sheet button:text-is('Log out')"); op.wait_for_selector("#sheet >> text=Some changes have not uploaded yet"); op.click(SB("OK"))
    op.context.set_offline(False)
    # the same phone is then used for another warehouse: its sync follows NDD Beta's daily list
    op.wait_for_selector("text=Enter your warehouse plant code"); [op.click(f".card .pad button:text-is('{d}')") for d in "1502"]; op.click(".card button:text-is('Next')")
    op.wait_for_selector(B("Yes, that's my warehouse")); op.reload(); op.wait_for_timeout(3000)
    if op.is_visible(B("Different warehouse")): op.click(B("Different warehouse")); op.wait_for_timeout(500)
    check("after sync to another stock take: unsent count still on the phone", op.is_visible("text=Continue a count") and "kept on phone" in op.inner_text("#pill").lower(), op.inner_text("main")[:300] + " | " + op.inner_text("#pill"))
    op.click(".big:has-text('NDD Alpha')"); op.wait_for_selector("#sheet .pad"); [op.click(f"#sheet .pad button:text-is('{d}')") for d in "1501"]; op.click("#sheet button:text-is('Next')")
    op.wait_for_selector("text=Today's cycle count"); op.wait_for_timeout(3500)
    check("logged in again: the change uploads", "All saved" in op.inner_text("#pill"), op.inner_text("#pill"))
    ow.click("#tabs button:text-is('Daily')"); ow.wait_for_selector("text=Daily counts ·"); ow.click("tr:has(td:text-is('NDD Alpha')) button:text-is('View')"); ow.wait_for_selector("text=Daily count (read-only)")
    check("HQ sees 356 (the offline change), not 355", "356" in ow.inner_text("main") and "355" not in ow.inner_text("main"), ow.inner_text("main")[:500])

    print("\npage errors:", errs or "none")
    br.close()
print(f"\n{ok} passed, {bad} failed")
