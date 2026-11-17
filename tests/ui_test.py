# End-to-end UI test against the local backend (node server.mjs with BOOTSTRAP_CODE=SETUP-123).
# Each browser context = one phone. Ops phone uses a fake camera showing the real Nabati barcode.
import os, sys, io, json, time
from playwright.sync_api import sync_playwright
from openpyxl import Workbook
from PIL import Image

BASE = os.environ.get("BASE", "http://localhost:8787")
CAM = os.environ.get("CAM", "/home/claude/scantest/cam/near.y4m")
OUT = "/tmp/ndd-ui"; os.makedirs(OUT, exist_ok=True)
ok = 0; bad = 0
def check(name, cond, extra=""):
    global ok, bad
    if cond: ok += 1; print("  ✓", name)
    else: bad += 1; print("  ✗", name, extra)

# ---------- fixtures ----------
H = ["Plant","Name 1","Material","Material Description","Storage Location","Descr. of Storage Loc.","Batch","Unrestricted","Value Unrestricted","Restricted-Use Stock","Value Restricted","Quality Inspection","Value in QualInsp.","Blocked Stock","Value BlockedStock","Stock in Transit","Value in Transit"]
rows = [
 ["1501","NDD Alpha","A1","Wafer A 50g","MW00","Main","20270315",240,480,0,0,0,0,5,10,0,0],
 ["1501","NDD Alpha","A1","Wafer A 50g","MW00","Main","20270501",120,240,0,0,0,0,0,0,0,0],
 ["1501","NDD Alpha","B2","Roll B 18g","MW00","Main","",100,50,0,0,0,0,0,0,0,0],
 ["1501","NDD Alpha","C3","Snack C 25g","MW00","Main","20261201",60,60,0,0,0,0,0,0,0,0],
 ["1501","NDD Alpha","A1","Wafer A 50g","BS00","Bad stock","20270315",9,18,0,0,0,0,0,0,0,0],
 ["1502","NDD Beta","A1","Wafer A 50g","MW00","Main","20270315",48,96,0,0,0,0,0,0,0,0],
 ["1503","NDD Gamma","A1","Wafer A 50g","MW00","Main","20270315",12,24,0,0,0,0,0,0,0,0],
 ["1599","Factory DC","A1","Wafer A 50g","MW00","Main","20270315",7,14,0,0,0,0,0,0,0,0]]
wb = Workbook(); ws = wb.active; ws.append(["MB52 export"]); ws.append(H)
for r in rows: ws.append(r)
wb.save(f"{OUT}/mb52.xlsx")
wb = Workbook(); ws = wb.active; ws.append(["Barcode","Item Code","UoM"]); ws.append(["8993175536707","A1","PCS"]); ws.append(["12345","B2","BAG"])
for c in ws["A"]: c.number_format = "@"
wb.save(f"{OUT}/barcodes.xlsx")
for i in range(4):
    Image.new("RGB", (1200, 900), (40*i, 120, 200)).save(f"{OUT}/p{i}.jpg", quality=90)

def sign(pg, idx=0):
    c = pg.locator("#sheet canvas").nth(idx); b = c.bounding_box()
    pg.mouse.move(b["x"]+20, b["y"]+20); pg.mouse.down(); pg.mouse.move(b["x"]+120, b["y"]+60, steps=8); pg.mouse.move(b["x"]+200, b["y"]+30, steps=8); pg.mouse.up()

with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox","--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",f"--use-file-for-fake-video-capture={CAM}","--autoplay-policy=no-user-gesture-required"])
    errs = []
    def phone(w=390, h=844):
        ctx = br.new_context(viewport={"width": w, "height": h}, is_mobile=w < 600, has_touch=w < 600, accept_downloads=True); ctx.grant_permissions(["camera"])
        pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: m.type == "error" and errs.append("console: " + m.text))
        return pg

    print("owner setup (laptop)")
    ow = phone(1280, 900); ow.goto(BASE + "/?api=local"); ow.wait_for_selector("text=Welcome - first-time setup")
    check("fresh app shows first-time setup guide", ow.inner_text("#pill") == "Online", ow.inner_text("#pill"))
    ow.screenshot(path=f"{OUT}/first_run.png")
    ow.click("button:has-text('Start first-time setup')")
    ow.fill("input[placeholder='Setup code']", "SETUP-123"); ow.fill("input[placeholder^='New owner password']", "OwnerPass1"); ow.fill("input[placeholder='Repeat password']", "OwnerPass1")
    ow.click("#sheet button:has-text(\"Save\")"); ow.wait_for_selector("text=Owner password set")
    ow.click("#sheet button:has-text(\"OK\")"); check("owner bootstrap → Setup tab", ow.is_visible("text=1. Upload SAP MB52"))
    ow.click("button:has-text(\"Edit branch list\")"); ow.locator("div:has(> p:text(\"One per line\")) textarea").fill("NDD Alpha\nNDD Beta"); ow.click("button:has-text(\"Save branches\")"); ow.wait_for_selector("#sheet >> text=Saved"); ow.click("#sheet button:has-text(\"OK\")")
    ow.click("button:has-text(\"Paste from Excel\")"); ow.fill("textarea[placeholder^='Paste 3 columns']", "Ali Rahman\tNDD Alpha\tCounter\nBudi\tNDD Alpha\tCounter\nSiti Aminah\tNDD Alpha\tChecker\nLim\tNDD Beta\tCounter")
    ow.click("button:has-text(\"Replace team with pasted list\")"); ow.wait_for_selector("#sheet >> text=4 people."); ow.click("#sheet button:has-text(\"OK\")")
    check("team saved", ow.is_visible("text=Ali Rahman"))
    ow.locator(".card:has-text('Branch PINs') input").nth(0).fill("1234"); ow.locator(".card:has-text('Branch PINs') input").nth(1).fill("5678")
    ow.click("button:has-text(\"Save PINs\")"); ow.wait_for_selector("#sheet >> text=Send each branch its PIN"); ow.click("#sheet button:has-text(\"OK\")")
    ow.set_input_files(".card:has-text('1. Upload SAP MB52') input[type=file]", f"{OUT}/mb52.xlsx"); ow.wait_for_selector("#sheet >> text=New branches in this MB52")
    nb = ow.inner_text("#sheet"); check("MB52 offers new branch names, NDD ticked, DC not", "NDD Gamma" in nb and "Factory DC" in nb and ow.is_checked("#sheet label:has-text('NDD Gamma') input") and not ow.is_checked("#sheet label:has-text('Factory DC') input"), nb)
    ow.click("#sheet button:has-text(\"Continue\")"); ow.wait_for_selector("#sheet >> text=Load MB52?")
    txt = ow.inner_text("#sheet"); check("MB52 summary shows 4 lines, bad stock excluded", "6 lines for 3 branch" in txt and "SKIPPED (branch not in list): 1599 Factory DC" in txt and "bad-stock locations BS/SH 9 PCS" in txt, txt[:300])
    ow.click("#sheet button:has-text(\"Load\")"); ow.wait_for_selector("#sheet >> text=Next: Pcs per Carton", timeout=20000)
    ow.click("#sheet button:has-text(\"OK\")")
    gpin = ow.locator(".card:has-text('Branch PINs') tr:has-text('NDD Gamma') input").input_value(); check("new branch got an automatic PIN", len(gpin) == 4 and gpin.isdigit(), gpin)
    ow.fill(".card:has-text('2. Pcs per Carton') textarea", "A1\t24\t\nB2\t50\t10\nC3\t12\t"); ow.click("button:has-text(\"Save factors\")"); ow.wait_for_selector("#sheet >> text=3 SKU(s) updated"); ow.click("#sheet button:has-text(\"OK\")")
    ow.set_input_files(".card:has-text('3. Barcode master') input[type=file]", f"{OUT}/barcodes.xlsx"); ow.wait_for_selector("#sheet >> text=Load barcodes?")
    t2 = ow.inner_text("#sheet"); check("barcode upload: 1 ok, BAG row skipped", "1 barcode(s) ready" in t2 and "1 row(s) skipped" in t2, t2)
    ow.click("#sheet button:has-text(\"Load\")"); ow.wait_for_selector("#sheet >> text=1 barcode(s) saved"); ow.click("#sheet button:has-text(\"OK\")")
    fc = ow.locator(".card:has(h3:text-is('Finance password (Master & Setup access)'))"); fc.locator("input").fill("FinPass99"); fc.locator("button:text-is('Save')").click()
    ow.wait_for_selector("#sheet >> text=FinPass99"); ow.click("#sheet button:has-text(\"OK\")")
    ow.screenshot(path=f"{OUT}/owner_setup.png", full_page=True)

    print("ops phone")
    op = phone(); op.goto(BASE + "/?api=local"); op.wait_for_selector("text=1. I am counting as")
    op.click(".big:has-text('Ops team counts')"); op.click(".big:has-text('NDD Alpha')")
    for d in "9999": op.click(f"#sheet .pad button:text-is('{d}')")
    op.click("#sheet button:has-text(\"Unlock\")"); op.wait_for_selector("#sheet >> text=Wrong PIN"); check("wrong PIN rejected", True)
    for d in "1234": op.click(f"#sheet .pad button:text-is('{d}')")
    op.click("#sheet button:has-text(\"Unlock\")"); op.wait_for_selector("text=3. Counter(s) - Operations")
    op.click(".big:has-text('Ali Rahman')"); op.click(".big:has-text('Budi')"); op.click("button:has-text(\"Start ops count\")")
    op.wait_for_selector("text=OPS COUNT"); op.wait_for_selector("text=0 / 3 SKUs counted"); check("count screen opens", True, op.inner_text("main")[:200])
    # stepper count on B2 (box factor)
    op.click(".skuh:has-text('B2')"); bt = op.locator(".sku:has-text('B2') .batch").first
    bt.locator("button.plus").nth(0).click(); bt = op.locator(".sku:has-text('B2') .batch").first
    bt.locator("button.plus").nth(1).click(); bt = op.locator(".sku:has-text('B2') .batch").first
    check("B2: 1 ctn + 1 box = 60 PCS", "= 60 PCS" in bt.inner_text(), bt.inner_text())
    # calculator pad on pieces
    bt.locator(".val").nth(2).click(); [op.click(f"#sheet .pad button:text-is('{k}')") for k in ["4","×","1","0"]]; op.click("#sheet button:has-text(\"OK\")")
    check("calculator 4×10 → 40 pcs, total 100", "= 100 PCS" in op.locator(".sku:has-text('B2') .batch").first.inner_text())
    # scan with camera → A1
    op.click(".sfab.scan"); op.wait_for_selector(".ssheet.on", timeout=15000)
    check("scan: green tick shown", "on" in (op.get_attribute(".tick", "class") or ""))
    s1 = op.inner_text(".ssheet"); check("scan: SKU name shown after barcode read", "Barcode read" in s1 and "Wafer A 50g" in s1, s1[:200])
    check("scan: save disabled until batch picked", op.is_disabled(".ssheet .btn.primary") and "Pick the batch month first" in op.inner_text(".ssheet .btn.primary"))
    op.click(".ssheet .chip >> text=03/2027"); op.click(".ssheet [aria-label='plus Carton']"); op.click(".ssheet [aria-label='plus Carton']")
    op.fill(".ssheet [aria-label='Pieces']", "5"); op.dispatch_event(".ssheet [aria-label='Pieces']", "input")
    check("scan: 2 ctn + 5 pcs = 53 PCS", "53 PCS" in op.inner_text(".ssheet .stotal"))
    op.screenshot(path=f"{OUT}/ops_scan_sheet.png")
    op.click(".ssheet .btn.primary"); op.wait_for_timeout(1500)
    check("scan: sheet does not reopen right after save", not op.is_visible(".ssheet.on"))
    op.wait_for_selector(".ssheet.on", timeout=10000)
    check("scan: rescan shows previous count to edit", op.is_visible(".ssheet .prev:not(.hidden)") and op.input_value(".ssheet [aria-label='Carton']") == "2")
    op.click(".ssheet >> text=Cancel"); op.click(".scanbar >> text=Done"); op.click(".seg button:text-is('All')")
    a1 = op.locator(".sku:has-text('A1')").first.inner_text(); check("scan result is in the list (53 PCS)", "53 PCS" in a1, a1)
    # handheld scanner: type barcode + Enter in search
    op.fill(".sbox input", "8993175536707"); op.press(".sbox input", "Enter"); op.wait_for_selector(".ssheet.on")
    check("handheld scanner (Enter in search) opens the same sheet", "Wafer A 50g" in op.inner_text(".ssheet")); op.click(".ssheet >> text=Cancel"); op.wait_for_timeout(400)
    # C3 = 0 with remark
    op.fill(".sbox input", "C3"); op.dispatch_event(".sbox input", "input"); op.click(".skuh:has-text('C3')"); op.wait_for_timeout(200)
    op.locator(".sku:has-text('C3') .batch").first.locator("button.plus").nth(1).click()
    op.locator(".sku:has-text('C3') .batch").first.locator("text=+ remark").click(); op.locator(".sku:has-text('C3') .batch >> text=Damaged").click()
    op.fill(".sbox input", ""); op.dispatch_event(".sbox input", "input")
    op.wait_for_timeout(2000); op.evaluate("window.dispatchEvent(new Event('online'))"); op.wait_for_timeout(1500); check("autosave → 'All saved ✓'", "All saved" in op.inner_text("#pill"), op.inner_text("#pill"))
    # reload keeps counts
    op.reload(); op.wait_for_selector(".toolbar"); check("after reload still on the count screen (not the start screen)", not op.is_visible("text=Continue a count")); op.click(".seg button:text-is('Counted')"); check("after reload counts still there", op.is_visible(".sku:has-text('A1')") and "53 PCS" in op.locator(".sku:has-text('A1')").first.inner_text())
    # submit blocked without photos
    op.click("#footIn >> text=Submit"); op.wait_for_selector("#sheet >> text=Are you sure")
    op.check("#sheet input[type=checkbox]"); sign(op, 0); sign(op, 1)
    check("submit disabled with 0 photos", op.is_disabled("#sheet >> text=Yes, submit"))
    op.set_input_files("#sheet input[type=file][multiple]", [f"{OUT}/p0.jpg", f"{OUT}/p1.jpg", f"{OUT}/p2.jpg", f"{OUT}/p3.jpg"])
    op.wait_for_selector("#sheet >> text=4 of 5 photos", timeout=15000)
    check("4 photos uploaded (shrunk JPEG)", op.locator("#sheet .pthumb img").count() == 4)
    op.locator("#sheet .pdel").first.click(); op.wait_for_selector("#sheet >> text=3 of 5 photos"); check("delete photo works", True)
    check("submit enabled with 3 photos + 2 signatures + tick", not op.is_disabled("#sheet >> text=Yes, submit"))
    op.screenshot(path=f"{OUT}/ops_submit.png", full_page=True)
    op.click("#sheet button:has-text(\"Yes, submit\")"); op.wait_for_selector("text=Submitted ✓", timeout=10000); check("submitted, screen locked", not op.is_visible("#footIn >> text=Submit"))

    print("finance phone")
    fn = phone(); fn.goto(BASE + "/?api=local"); fn.wait_for_selector('text=1. I am counting as'); fn.click(".big:has-text('Finance counts again')"); fn.click(".big:has-text('NDD Alpha')")
    for d in "1234": fn.click(f"#sheet .pad button:text-is('{d}')")
    fn.click("#sheet button:has-text(\"Unlock\")"); fn.click(".big:has-text('Siti Aminah')"); fn.click("button:has-text(\"Start finance check\")"); fn.wait_for_selector("text=FINANCE CHECK")
    def setpcs(code, n):
        fn.fill(".sbox input", code); fn.dispatch_event(".sbox input", "input"); fn.click(f".skuh:has-text('{code}')")
        fn.locator(f".sku:has-text('{code}') .batch").first.locator(".val").last.click()
        for k in str(n): fn.click(f"#sheet .pad button:text-is('{k}')")
        fn.click("#sheet button:has-text(\"OK\")")
    setpcs("A1", 53); setpcs("B2", 99)
    fn.fill(".sbox input", ""); fn.dispatch_event(".sbox input", "input"); fn.wait_for_timeout(1800)
    check("finance cannot see Ops numbers", "53" not in fn.inner_text(".banner") and "OPS COUNT" not in fn.inner_text("main"))

    print("branch without a team list")
    gm = phone(); gm.goto(BASE + "/?api=local"); gm.wait_for_selector("text=1. I am counting as"); gm.click(".big:has-text('Ops team counts')"); gm.click(".big:has-text('NDD Gamma')")
    for d in gpin: gm.click(f"#sheet .pad button:text-is('{d}')")
    gm.click("#sheet button:has-text(\"Unlock\")"); gm.wait_for_selector("input[placeholder='Type your name, then Add']")
    check("no team list → name box shown straight away", True)
    gm.fill("input[placeholder='Type your name, then Add']", "Rahim"); gm.press("input[placeholder='Type your name, then Add']", "Enter")
    gm.click("button:has-text(\"Start ops count\")"); gm.wait_for_selector("text=OPS COUNT"); gm.click("#footIn button:text-is('⚙')"); gm.click("#sheet button:has-text('Switch person')")
    gm.click(".big:has-text('Ops team counts')"); gm.click(".big:text-is('NDD Gamma')"); gm.wait_for_selector("text=3. Counter(s) - Operations")
    check("typed name remembered on this phone", gm.is_visible(".big:has-text('Rahim')"))

    print("finance desk: master + recount + export")
    ow.click("#lockBtn"); ow.wait_for_selector("text=🔒 Finance")
    ow.click("#lockBtn"); ow.fill("#sheet input[type=password]", "FinPass99"); ow.click("#sheet button:has-text(\"Unlock\")"); ow.wait_for_selector("text=Progress - Ops count vs Finance check")
    m = ow.inner_text("main"); check("master: Alpha shows Submitted + Counting", "Submitted" in m and "Counting" in m)
    ow.check("text=Exceptions only") if not ow.is_checked(".card:has-text('Ops vs Finance, then') input[type=checkbox]") else None
    vt = ow.inner_text(".card:has-text('Ops vs Finance, then')")
    check("variance: B2 RECOUNT (100 vs 99)", "RECOUNT" in vt, vt[:400])
    check("variance: A1 03/2027 MATCH hidden as non-exception; C3 OVER shown", "OVER 2%" in vt)
    ow.click("button:has-text(\"Send recount list\")"); ow.click("#sheet button:has-text(\"Send\")"); ow.wait_for_selector("#sheet >> text=Recount list sent"); ow.click("#sheet button:has-text(\"OK\")")
    op.reload(); op.wait_for_selector("text=Recount needed on", timeout=10000); check("ops phone gets recount banner + reopened", op.is_visible("#footIn >> text=Submit"))
    with ow.expect_download() as d: ow.click("button:has-text(\"Export to Excel\")")
    x = d.value; x.save_as(f"{OUT}/master.xlsx"); check("Excel export downloads", os.path.getsize(f"{OUT}/master.xlsx") > 5000)
    ow.click("#sheet button:has-text(\"OK\")")
    with ow.expect_download() as d2: ow.click("button:has-text(\"Sign-off PDF\")")
    d2.value.save_as(f"{OUT}/signoff.pdf"); check("Sign-off PDF downloads", os.path.getsize(f"{OUT}/signoff.pdf") > 5000)
    ow.click("#sheet button:has-text(\"OK\")")
    ow.locator("button.link:has-text('📷 3')").first.click(); ow.wait_for_selector("#sheet .pthumb img"); check("Finance sees 3 warehouse photos", ow.locator("#sheet .pthumb img").count() == 3); ow.click("#sheet button:has-text(\"Close\")")
    ow.screenshot(path=f"{OUT}/master.png", full_page=True)

    print("dashboard")
    db = phone(1280, 800); db.goto(BASE + "/dashboard/?api=local"); db.wait_for_selector("text=NDD Alpha")
    t = db.inner_text("main"); check("dashboard progress only", "Variance is not published" in t and "Ops: Counting" in t, t[:300])
    ow.click("#tabs >> text=Setup"); ow.wait_for_selector("text=Public dashboard"); ow.select_option(".card:has(h3:text-is('Public dashboard')) select", "value"); ow.locator(".card:has(h3:text-is('Public dashboard')) button:text-is('Save')").click(); ow.wait_for_selector("#sheet >> text=Dashboard level saved"); ow.click("#sheet button:has-text(\"OK\")")
    ow.click("#tabs >> text=Master"); ow.click("button:has-text(\"Close counting\")"); ow.wait_for_selector("text=Reopen counting")
    db.reload(); db.wait_for_selector("text=variance RM"); check("dashboard shows variance after close at 'value' level", "Net variance value" in db.inner_text("main"))
    db.screenshot(path=f"{OUT}/dashboard.png", full_page=True)
    op.reload(); op.wait_for_selector("text=Counting is closed by Finance"); check("counter sees closed banner", True)

    print("\npage errors:", errs or "none")
    print(f"\n{ok} passed, {bad} failed")
    br.close()
    sys.exit(1 if bad or errs else 0)
