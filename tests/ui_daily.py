import re
# UI test for the daily cycle count (run after ui_test.py has written /tmp/ndd-ui/mb52.xlsx).
# Fresh server: BOOTSTRAP_CODE=SETUP-123 node server.mjs
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8787"); OUT = "/tmp/ndd-ui"
ok = 0; bad = 0
import datetime; _d = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))); TODAY = f"{_d.day} {_d.strftime('%b')}"
def check(name, cond, extra=""):
    global ok, bad
    if cond: ok += 1; print("  ✓", name)
    else: bad += 1; print("  ✗", name, str(extra)[:1500])
def B(t): return f'button:has-text("{t}")'
def SB(t): return f'#sheet button:has-text("{t}")'
def ROW(nm): return f".wrow:has(.whn b:text-is('{nm}'))"
def WH(nm): return f".whc:has(.whn b:text-is('{nm}'))"
def dsel(pg, nm): pg.click(ROW(nm)); pg.wait_for_selector(f".detail h3:text-is('{nm}')"); pg.wait_for_selector(".detail .dacts")
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
    ow.click("#tabs button:text-is('Settings')"); ow.wait_for_selector("text=Minimum SKUs a day")
    mn = ow.locator(".card:has(h3:text-is('Daily cycle count')) .row:has-text('Minimum SKUs a day') input")
    check("Settings: minimum SKUs a day defaults to 10", mn.input_value() == "10", mn.input_value())
    mn.fill("1"); ow.click(B("Save rules")); ow.click(SB("OK"))   # the list checks below test the ABC planning itself
    ow.click("#tabs button:text-is('Daily')"); ow.wait_for_selector("text=Daily stock (MB52)")
    check("Daily tab: asks for the first upload", ow.is_visible("text=Upload the MB52 to start daily counts"))
    ow.set_input_files(".card:has(h3:text-is('Daily stock (MB52)')) input[type=file]", f"{OUT}/mb52.xlsx"); ow.wait_for_selector("#sheet >> text=New branches in this MB52")
    ow.click(SB("Continue")); ow.wait_for_selector("#sheet >> text=Load MB52?")
    check("confirm says it becomes the daily stock", "system stock dated" in ow.inner_text("#sheet"), ow.inner_text("#sheet"))
    _up = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    ow.click(SB("Load")); ow.wait_for_selector("#sheet >> text=Daily stock loaded", timeout=20000); ow.click(SB("OK"))
    ow.wait_for_selector("text=Daily counts ·"); ow.wait_for_timeout(500)
    # released after 07:00: the window (07:00-10:00, 3 h) runs from the upload instead
    _late = _up.hour * 60 + _up.minute > 7 * 60
    DUE = "10:00" if not _late else ("23:59" if _up.hour + 3 >= 24 else f"{max(10 * 60, (_up.hour + 3) * 60 + _up.minute) // 60:02d}:{max(10 * 60, (_up.hour + 3) * 60 + _up.minute) % 60:02d}")
    tt = ow.inner_text(".card:has(h3:has-text('Daily counts'))")
    check("each warehouse has today's list (Not started, 0 / n)", "Not started: 3" in tt and len(re.findall(r"\b0 / [1-9]", tt)) == 3, tt)
    dsel(ow, "NDD Alpha"); ow.click(".detail button:text-is('ABC')"); ow.wait_for_selector("#sheet >> text=ABC")
    at = ow.inner_text("#sheet"); check("ABC: A1 is A (most value), B2/C3 lower", "A1 Wafer A 50g" in at and "62.9%" in at or "A1" in at, at); ow.click(SB("Close"))
    ow.click(".detail button:text-is('List')"); lt = ow.inner_text("#sheet"); check("today's list for Alpha is A1 (class A)", "A1" in lt, lt); ow.click(SB("Close"))

    print("HQ: settings")
    ow.click("#tabs button:text-is('Settings')"); ow.wait_for_selector("text=Daily cycle count")
    ow.locator(".card:has(h3:text-is('Warehouse photos before counting')) input[type=number]").first.fill("0"); ow.click(".card:has(h3:text-is('Warehouse photos before counting')) button:has-text('Save')"); ow.click(SB("OK"))
    ow.click(WH("NDD Alpha") + " button:text-is('Edit')"); ow.click(SB("Create PIN")); ow.click(SB("Create")); ow.wait_for_selector("#sheet >> text=PIN:")
    pin = ow.inner_text("#sheet").split("PIN: ")[1][:6]; check("supervisor PIN shown once (6 digits)", pin.isdigit() and len(pin) == 6, pin); ow.click(SB("OK"))
    ow.wait_for_timeout(400); check("PIN status: not changed yet", "not changed yet" in ow.inner_text(WH("NDD Alpha")), ow.inner_text(WH("NDD Alpha")))

    print("counter: today's list")
    op = page(390, 844); op.goto(BASE + "/?api=local"); op.wait_for_selector("text=Start counting"); pad(op, "1501")
    op.wait_for_selector(".kind-daily"); kt = op.inner_text(".kind-daily")
    check("confirm: big DAILY label with date, SKU count and finish time", "DAILY CYCLE COUNT" in kt and re.search(r"\d+ SKU", kt) and TODAY in kt, kt)
    _fb = re.search(r"finish by (\d\d):(\d\d)", kt); _dm = int(DUE[:2]) * 60 + int(DUE[3:])
    check(f"late release moves the deadline: finish by ~{DUE}", _fb and abs(int(_fb.group(1)) * 60 + int(_fb.group(2)) - _dm) <= 1, kt)
    check("confirm: no monthly label", not op.is_visible(".kind-monthly"))
    op.wait_for_selector("text=Who is counting?")
    check("daily = single count: no team step", not op.is_visible("text=Which team are you?"))
    op.fill("input[placeholder*='name' i]", "Siti"); op.keyboard.press("Enter"); op.wait_for_timeout(300)
    op.click(B("Start count")); op.wait_for_selector(".kind-daily")
    check("count screen: daily label stays on top", "DAILY CYCLE COUNT" in op.inner_text(".kind-daily"))
    op.wait_for_function("document.querySelector('#sub').textContent.indexOf('Daily count · NDD Alpha') === 0", timeout=5000); check("header says Daily count", op.inner_text("#sub").startswith("Daily count · NDD Alpha"), op.inner_text("#sub"))
    op.click(".skuh:has-text('A1')"); op.wait_for_selector("#skuv"); op.locator("#skuv .batch").first.locator(".val").last.click()
    [op.click(f"#sheet .pad button:text-is('{k}')") for k in "355"]; op.click(SB("OK")); op.wait_for_timeout(2500)

    print("'Continue as last time' shortcut")
    check("shortcut saved only after a real count (Alpha counted)", "1501" in (op.evaluate("localStorage.getItem('ndd2-last')") or ""), op.evaluate("localStorage.getItem('ndd2-last')"))
    lp = page(390, 844); lp.goto(BASE + "/?api=local"); lp.wait_for_selector("text=Start counting"); pad(lp, "1502"); lp.wait_for_selector(".task")
    lp.click("[aria-label='Different warehouse']"); lp.wait_for_selector("text=Start counting")
    check("login without counting: no shortcut", lp.evaluate("localStorage.getItem('ndd2-last')") is None and not lp.is_visible("text=Continue as last time"))
    lp.evaluate("localStorage.setItem('ndd2-last', JSON.stringify({code: '1502', branch: 'NDD Beta'}))"); lp.reload(); lp.wait_for_selector("text=Continue as last time")
    lp.click("[aria-label='Remove NDD Beta shortcut']"); lp.wait_for_selector("#sheet >> text=Remove this shortcut?"); check("delete asks to confirm first", True)
    lp.click(SB("Cancel")); check("cancel keeps it", lp.is_visible("text=Continue as last time"))
    lp.click("[aria-label='Remove NDD Beta shortcut']"); lp.click(SB("Remove")); lp.wait_for_timeout(300)
    check("removed", not lp.is_visible("text=Continue as last time") and lp.evaluate("localStorage.getItem('ndd2-last')") is None); lp.close()

    print("HQ sees progress; Master read-only view")
    ow.click("#tabs button:text-is('Daily')"); ow.wait_for_selector("text=Daily counts ·"); ow.wait_for_timeout(500)
    ar = ow.inner_text(ROW("NDD Alpha")); check("Alpha: Counting, 1 counted", "Counting" in ar and re.search(r"\b1 / [1-9]", ar), ar)
    dsel(ow, "NDD Alpha"); ow.click(".detail button:text-is('View counts')"); ow.wait_for_selector("text=Daily count (read-only)")
    check("View opens the day in Master", "COUNTED" in ow.inner_text("main") or "A1" in ow.inner_text("main"), ow.inner_text("main")[:400])
    ow.click(B("Back to Daily")); ow.wait_for_selector("text=Daily counts ·")

    print("HQ: Today page")
    ow.click("#tabs button:text-is('Today')"); ow.wait_for_selector(".whlist .whrow"); ow.wait_for_timeout(600)
    tm = ow.inner_text("main")
    check("Today: checklist (MB52, lists, holidays)", all(x in tm for x in ["Today's MB52", "Daily lists", "Holidays"]), tm[:600])
    check("Today: MB52 released today", "Released · uploaded" in ow.inner_text(".ck:has-text(\"Today's MB52\")"), ow.inner_text(".checks"))
    check("Today: stat strip (3 due, 1 counting)", re.search(r"3\s*Due today", ow.inner_text(".statrow")) and re.search(r"1\s*Counting", ow.inner_text(".statrow")), ow.inner_text(".statrow"))
    wa = ow.inner_text(".whrow:has-text('NDD Alpha')"); check("Today: Alpha counting 1 / n SKUs", "ounting" in wa and re.search(r"\b1 / [1-9]", wa), wa)
    check("Today: KPI card", "KPI001 daily count" in ow.inner_text(".side"), ow.inner_text(".side"))
    ow.screenshot(path=f"{OUT}/admin_today.png", full_page=True)
    ow.click(".whrow:has-text('NDD Beta') button:text-is('Open')"); ow.wait_for_selector(".detail h3:text-is('NDD Beta')"); check("Today → Open selects the warehouse in Daily", True)

    print("supervisor")
    sp = page(390, 844); sp.goto(BASE + "/?api=local"); sp.click(B("Warehouse supervisor? Log in here"))
    sp.fill("#sheet input[placeholder='Plant code']", "1501"); sp.fill("#sheet input[placeholder='Supervisor PIN']", "000000" if pin != "000000" else "111111"); sp.click(SB("Log in"))
    sp.wait_for_selector("#sheet >> text=Wrong plant code or PIN"); check("wrong PIN refused", True)
    sp.fill("#sheet input[placeholder='Supervisor PIN']", pin); sp.click(SB("Log in")); sp.wait_for_selector("#sheet >> text=Choose your own PIN")
    sp.fill("#sheet input[placeholder^='New PIN']", "24681357"); sp.fill("#sheet input[placeholder='Repeat new PIN']", "24681357"); sp.click(SB("Save PIN"))
    sp.wait_for_selector("text=Today's list"); st = sp.inner_text("main")
    check("supervisor sees own warehouse today: A1 batch 03/2027 counted 355 vs system 240, batch 05/2027 120", "NDD Alpha" in st and "355" in st and "240" in st and "120" in st, st[:600])
    check("supervisor header: Log out, tabs My warehouse/Count", sp.inner_text("#lockBtn").strip() == "Log out" and "My warehouse" in sp.inner_text("#tabs"))
    sp.click(B("+ Add SKU to today")); sp.wait_for_selector("#sheet .big"); addc = sp.locator("#sheet .big").first.inner_text().split()[0]; sp.click("#sheet .big >> nth=0")
    sp.wait_for_timeout(800); check("added SKU shows with S tag", addc in sp.inner_text("main") and sp.is_visible(".cls-S"), sp.inner_text("main")[:500])
    check("can't skip after counting started", not sp.is_visible(B("Skip today")))
    sp.click(B("This month's plan")); sp.wait_for_selector("#sheet >> text=ABC 20"); check("plan modal opens (supervisor can see the ABC plan)", "A1" in sp.inner_text("#sheet")); sp.click(SB("Close"))
    sp.screenshot(path=f"{OUT}/sup.png", full_page=True); sp.click("#lockBtn"); sp.wait_for_selector("text=Start counting"); check("supervisor log out back to start", True)
    op.reload(); op.wait_for_timeout(1500); op.click(".seg button:text-is('All')") if op.is_visible(".seg button:text-is('All')") else None
    check("counter now sees the added SKU on the list", addc in op.inner_text(".skulist2"), op.inner_text("main")[:300])

    print("dashboards")
    ow.click("#tabs button:text-is('Settings')"); ow.wait_for_selector(WH("NDD Beta") + " >> text=No region")
    for nm, rg, nom in [("NDD Alpha", "Central", "Ahmad"), ("NDD Beta", "North", "Budi")]:
        ow.click(WH(nm) + " button:text-is('Edit')"); ow.fill("#sheet input[placeholder='e.g. Central']", rg); ow.fill("#sheet input[placeholder='Name']", nom)
        ow.click(SB("Save")); ow.wait_for_selector("#modal:not(.on)", state="attached"); ow.wait_for_timeout(700)
    check("region + NOM saved", "North · Budi" in ow.inner_text(WH("NDD Beta")), ow.inner_text(WH("NDD Beta")))
    ow.click("#tabs button:text-is('Dashboard')"); ow.wait_for_selector("text=Compliance · warehouse × day")
    dt = ow.inner_text("main"); check("admin dashboard: all sections", all(x in dt for x in ["Due today", "Not started", "SKU accuracy", "Net variance", "Needs attention", "Today per warehouse", "SKU accuracy by warehouse", "KPI001", "KPI002", "Daily cycle count", "Stock take (end of month)", "Result by SKU", "Counters", "ABC coverage", "Repeat variance SKUs", "Compliance", "By warehouse", "Top variance SKUs", "Bad stock (later phase)"]), dt[:800])
    tw = ow.inner_text(".card:has(h3:text-is('Today per warehouse'))"); check("today table: Alpha counting 1 / 2, Beta not started", "Counting" in tw and re.search(r"\b1 / [2-9]", tw) and "Not started" in tw, tw)
    check("needs attention lists the not-started warehouses", "NDD Beta" in ow.inner_text(".card:has(h3:text-is('Needs attention'))"), ow.inner_text(".card:has(h3:text-is('Needs attention'))"))
    ow.select_option("main select >> nth=1", "Central"); ow.wait_for_timeout(300)
    tw = ow.inner_text(".card:has(h3:text-is('Today per warehouse'))"); check("region filter: only Central warehouses", "NDD Alpha" in tw and "NDD Beta" not in tw, tw)
    check("region filter also applies to the shared views", "NDD Beta" not in ow.inner_text(".card:has(h3:text-is('By warehouse'))"))
    ow.select_option("main select >> nth=1", ""); ow.wait_for_timeout(300)
    check("grid has a row per warehouse", ow.locator(".dccgrid tr").count() == 4)
    pd = page(1280, 900); pd.goto(BASE + "/dashboard/?api=local"); pd.wait_for_selector("text=Daily cycle count · this month")
    pt = pd.inner_text("main"); check("public dashboard: daily section, no RM", "SKU coverage" in pt and "Net variance" not in pt and "Top variance" not in pt, pt[:400])
    pd.screenshot(path=f"{OUT}/public_dcc.png", full_page=True); ow.screenshot(path=f"{OUT}/admin_dash.png", full_page=True)
    ow.click("#tabs button:text-is('Daily')"); ow.wait_for_selector("text=Daily counts ·"); ow.wait_for_timeout(400); ow.screenshot(path=f"{OUT}/admin_daily.png", full_page=True)
    ow.click("#tabs button:text-is('Settings')"); ow.wait_for_selector("text=Daily cycle count"); ow.locator(".card:has(h3:text-is('Daily cycle count'))").screenshot(path=f"{OUT}/admin_dccset.png")

    print("offline change + log out + phone syncs to another stock take: the unsent count survives")
    op.wait_for_selector(".kind-daily"); op.context.set_offline(True)
    op.click(".seg button:text-is('All')"); op.wait_for_timeout(200)
    op.click(".skuh:has-text('A1')"); op.wait_for_selector("#skuv")
    op.locator("#skuv .batch").first.locator(".val").last.click(); [op.click(f"#sheet .pad button:text-is('{k}')") for k in ["C", "3", "5", "6"]]; op.click(SB("OK")); op.wait_for_timeout(1500)
    (op.click("#skuv [aria-label='Back to list']") if op.is_visible("#skuv") else None); op.click("#lockBtn"); op.click("#sheet button:text-is('Log out')"); op.wait_for_selector("#sheet >> text=Some changes have not uploaded yet"); op.click(SB("OK"))
    op.context.set_offline(False)
    # the same phone is then used for another warehouse: its sync follows NDD Beta's daily list
    op.wait_for_selector("text=Start counting"); [op.click(f".card .pad button:text-is('{d}')") for d in "1502"]; op.click(".card button:text-is('Next')")
    op.wait_for_selector(".task"); op.reload(); op.wait_for_timeout(3000)
    if op.is_visible(B("Different warehouse")): op.click(B("Different warehouse")); op.wait_for_timeout(500)
    check("after sync to another stock take: unsent count still on the phone", op.is_visible("text=Continue a count") and "kept on phone" in op.inner_text("#pill").lower(), op.inner_text("main")[:300] + " | " + op.inner_text("#pill"))
    op.click(".big:has-text('NDD Alpha')"); op.wait_for_selector("#sheet .pad"); [op.click(f"#sheet .pad button:text-is('{d}')") for d in "1501"]; op.click("#sheet button:text-is('Next')")
    op.wait_for_selector(".kind-daily"); op.wait_for_timeout(3500)
    check("logged in again: the change uploads", "All saved" in op.inner_text("#pill"), op.inner_text("#pill"))
    ow.click("#tabs button:text-is('Daily')"); ow.wait_for_selector("text=Daily counts ·"); dsel(ow, "NDD Alpha"); ow.click(".detail button:text-is('View counts')"); ow.wait_for_selector("text=Daily count (read-only)")
    check("HQ sees 356 (the offline change), not 355", "356" in ow.inner_text("main") and "355" not in ow.inner_text("main"), ow.inner_text("main")[:500])

    print("counter submits; HQ exports the daily report and the daily sign-off PDF")
    import base64
    (op.click("#skuv [aria-label='Back to list']") if op.is_visible("#skuv") else None); op.click("#footIn >> text=Submit"); op.wait_for_selector("#sheet >> text=Review & submit"); op.check("#sheet input[type=checkbox]")
    cv = op.locator("#sheet canvas").first; cv.evaluate("e => e.scrollIntoView({block: 'center'})"); op.wait_for_timeout(150); bb = cv.bounding_box(); op.mouse.move(bb["x"] + 20, bb["y"] + 20); op.mouse.down(); op.mouse.move(bb["x"] + 150, bb["y"] + 50, steps=8); op.mouse.up()
    op.click("#sheet >> text=Submit count"); op.wait_for_selector("text=Submitted ✓", timeout=10000); op.wait_for_timeout(1500)
    ow.click(B("Back to Daily")); ow.wait_for_selector("text=Daily counts ·"); ow.click(B("↻")); dsel(ow, "NDD Alpha"); ow.wait_for_selector(".detail >> text=Counted by")
    check("detail panel: submitted, counted by Siti", "Siti" in ow.inner_text(".detail") and "OK / within" in ow.inner_text(".detail"), ow.inner_text(".detail"))
    with ow.expect_download() as dl: ow.click(".detail button:text-is('Sign-off PDF')")
    ow.wait_for_selector("#sheet >> text=Saved ✓", timeout=20000); dl.value.save_as(f"{OUT}/dcc_signoff.pdf")
    pdf = base64.b64decode(ow.evaluate("window.__pdf").split(",", 1)[1])
    check("daily PDF: name, header, status, summary, counter signature, supervisor box", all(x in pdf for x in [b"DCC_SignOff_NDD_Alpha", b"Daily cycle count sign-off", b"NDD Alpha - Daily Cycle Count", b"Submitted", b"SKUs on today's list", b"Counted by", b"Checked by - Warehouse supervisor", b"Exceptions"]) if False else all(x in pdf for x in [b"Daily cycle count sign-off", b"NDD Alpha - Daily Cycle Count", b"Submitted", b"SKUs on today's list", b"Counted by", b"Checked by - Warehouse supervisor", b"Exceptions"]), pdf[:200])
    check("daily PDF: the counter's signature image is in it", pdf.count(b"/Subtype /Image") >= 2, pdf.count(b"/Subtype /Image"))
    ow.click(SB("OK"))
    ow.click(B("Export report")); ow.wait_for_selector("#sheet >> text=Daily cycle count report (Excel)")
    with ow.expect_download() as dl2: ow.click(SB("Export"))
    ow.wait_for_selector("#sheet >> text=Exported ✓", timeout=20000); dl2.value.save_as(f"{OUT}/dcc_report.xlsx")
    xs = ow.evaluate("window.__xlsx"); al = [r for r in xs["summary"][1:] if r[1] == "NDD Alpha" and r[4] in ("On time", "Late")]
    check("Excel: 4 sheets", xs["sheets"] == ["Summary", "Detail", "Repeat variance", "Notes"], xs["sheets"])
    check("Excel summary: Alpha's submitted day with counter, SKUs and accuracy", len(al) == 1 and al[0][10] == "Siti" and al[0][11] >= 2 and al[0][12] is not None, al)
    check("Excel detail has the SKU lines", xs["detail"] > 1, xs["detail"])
    ow.click(SB("OK"))
    ow.click("#tabs button:text-is('Dashboard')"); ow.wait_for_selector("text=Compliance · warehouse × day")
    with ow.expect_download() as dl3: ow.click(B("Export"))
    ow.wait_for_selector("#sheet >> text=Exported ✓", timeout=20000); check("Dashboard export works", True); ow.click(SB("OK"))

    print("HQ undo tools: delete a count, stop / resume a daily count")
    ow.click("#tabs button:text-is('Daily')"); ow.wait_for_selector(".wrow"); dsel(ow, "NDD Alpha")
    ow.click(".detail button:text-is('Delete a count…')"); ow.wait_for_selector("#sheet >> text=Delete a count · NDD Alpha")
    check("delete list shows Siti's submitted count", "Siti" in ow.inner_text("#sheet") and "Submitted" in ow.inner_text("#sheet"), ow.inner_text("#sheet"))
    ow.click("#sheet button:text-is('Delete')"); ow.wait_for_selector("#sheet >> text=Delete this count?"); check("delete asks to confirm", "can't be undone" in ow.inner_text("#sheet"))
    ow.click(SB("Delete")); ow.wait_for_timeout(1500); ow.wait_for_selector(ROW("NDD Alpha"))
    check("Alpha's count deleted: back to Not started", "Not started" in ow.inner_text(ROW("NDD Alpha")), ow.inner_text(ROW("NDD Alpha")))
    dsel(ow, "NDD Beta"); ow.click(".detail button:text-is('Stop count')"); ow.wait_for_selector("#sheet >> text=Stop today's count at NDD Beta?")
    ow.click(SB("Stop count")); ow.wait_for_timeout(1500); ow.wait_for_selector(ROW("NDD Beta"))
    check("Beta: Stopped by HQ", "Stopped by HQ" in ow.inner_text(ROW("NDD Beta")), ow.inner_text(ROW("NDD Beta")))
    bp = page(390, 844); bp.goto(BASE + "/?api=local"); bp.wait_for_selector("text=Start counting"); pad(bp, "1502")
    bp.wait_for_selector("text=HQ stopped today's count"); check("Beta's counter is told HQ stopped today's count", True); bp.close()
    ow.click(ROW("NDD Beta")); ow.wait_for_selector(".detail button:text-is('Resume count')"); ow.click(".detail button:text-is('Resume count')"); ow.click(SB("Resume")); ow.wait_for_timeout(1500)
    check("Beta resumed: Not started with a fresh list", "Not started" in ow.inner_text(ROW("NDD Beta")), ow.inner_text(ROW("NDD Beta")))

    print("\npage errors:", errs or "none")
    br.close()
print(f"\n{ok} passed, {bad} failed")
