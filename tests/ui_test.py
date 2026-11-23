# End-to-end UI test against the local backend (node server.mjs with BOOTSTRAP_CODE=SETUP-123).
# Each browser context = one phone. Ops phone uses a fake camera showing the real Nabati barcode.
import os, time, sys
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
    else: bad += 1; print("  ✗", name, str(extra)[:400])
def B(t): return f'button:has-text("{t}")'
def SB(t): return f'#sheet button:has-text("{t}")'

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
for i in range(4): Image.new("RGB", (1200, 900), (40*i, 120, 200)).save(f"{OUT}/p{i}.jpg", quality=90)

def sign(pg, idx=0):
    c = pg.locator("#sheet canvas").nth(idx); c.evaluate("e => e.scrollIntoView({block: 'center'})"); pg.wait_for_timeout(150); b = c.bounding_box()
    pg.mouse.move(b["x"]+20, b["y"]+20); pg.mouse.down(); pg.mouse.move(b["x"]+120, b["y"]+60, steps=8); pg.mouse.move(b["x"]+200, b["y"]+30, steps=8); pg.mouse.up()
def code(pg, digits):
    for d in digits: pg.click(f".pad button:text-is('{d}')")
    pg.click("button:text-is('Next')")

def gate(pg, n=3):
    """warehouse photos come first: fill the blocking photo step if it shows"""
    try: pg.wait_for_selector("#modal.lock.on", timeout=4000)
    except Exception: return
    for i in range(n):
        os.utime(f"{OUT}/p{i}.jpg", None); pg.set_input_files("#sheet input[type=file]", f"{OUT}/p{i}.jpg"); pg.wait_for_selector(f"#sheet >> text={i + 1} of 5 photos", timeout=15000)
    pg.click("#sheet button.big1"); pg.wait_for_timeout(300)

with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox","--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",f"--use-file-for-fake-video-capture={CAM}","--autoplay-policy=no-user-gesture-required"])
    errs = []
    def phone(w=390, h=844, ua=None):
        kw = dict(viewport={"width": w, "height": h}, is_mobile=w < 600, has_touch=w < 600, accept_downloads=True)
        if ua: kw["user_agent"] = ua
        kw["geolocation"] = {"latitude": 3.0732, "longitude": 101.5183, "accuracy": 12}
        ctx = br.new_context(**kw); ctx.grant_permissions(["camera", "geolocation"])
        ctx.route("https://nominatim.openstreetmap.org/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body='{"display_name":"Jalan Test 23, Seksyen 23, Shah Alam, Selangor, 40300, Malaysia"}'))
        pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: m.type == "error" and "ERR_INTERNET_DISCONNECTED" not in m.text and errs.append("console: " + m.text))
        return pg

    print("owner: first-time setup + wizard")
    ow = phone(1280, 900); ow.goto(BASE + "/?api=local"); ow.wait_for_selector("text=Welcome - first-time setup")
    check("fresh app shows first-time setup", True)
    ow.click(B("Start first-time setup"))
    ow.fill("input[placeholder='Setup code']", "SETUP-123"); ow.fill("input[placeholder^='New owner password']", "OwnerPass1"); ow.fill("input[placeholder='Repeat password']", "OwnerPass1")
    ow.click(SB("Save")); ow.wait_for_selector("text=Owner password set"); ow.click(SB("OK"))
    check("owner lands on the stock take wizard (Draft)", ow.is_visible("text=1. Name and type") and ow.is_visible(".state.draft"))
    check("header says Admin, tabs Today/Daily/Monthly/Master/Dashboard/Settings/Count", " ".join(ow.inner_text("#tabs").split()) == "Today Daily Monthly Master Dashboard Settings Count" and "Log out" in ow.inner_text("#lockBtn"), ow.inner_text("#tabs"))
    ow.fill("input[placeholder='Cycle count Nov week 4']", "Test count"); ow.click(".choice:has-text('Total')"); ow.click(B("Save and continue"))
    ow.wait_for_selector("text=3. Upload the SAP MB52"); check("Total skips the SKU step", True)
    ow.set_input_files(".card:has(h3:text-is('MB52 file')) input[type=file]", f"{OUT}/mb52.xlsx"); ow.wait_for_selector("#sheet >> text=New branches in this MB52")
    nb = ow.inner_text("#sheet"); check("MB52 offers new warehouses, NDD ticked, DC not", "NDD Gamma" in nb and ow.is_checked("#sheet label:has-text('NDD Gamma') input") and not ow.is_checked("#sheet label:has-text('Factory DC') input"), nb)
    ow.click(SB("Continue")); ow.wait_for_selector("#sheet >> text=Load MB52?")
    txt = ow.inner_text("#sheet"); check("MB52 summary: 6 lines, 3 warehouses, DC skipped", "6 lines for 3 branch" in txt and "1599 Factory DC" in txt, txt)
    ow.click(SB("Load")); ow.wait_for_selector("#sheet >> text=plant codes ready", timeout=20000)
    check("warns about SKUs without pcs/ctn", "no pcs per carton yet" in ow.inner_text("#sheet")); ow.click(SB("OK"))
    rt = ow.inner_text(".card:has(h3:text-is('Warehouses ready'))"); check("plant codes shown per warehouse", "1501" in rt and "1503" in rt, rt)

    print("owner: settings")
    ow.click("#tabs button:text-is('Settings')"); ow.wait_for_selector("text=Pcs per Carton / Box")
    ow.fill(".card:has(h3:text-is('Pcs per Carton / Box')) textarea", "A1\t24\t\nB2\t50\t10\nC3\t12\t"); ow.click(B("Save factors")); ow.wait_for_selector("#sheet >> text=3 SKU(s) updated"); ow.click(SB("OK"))
    ow.set_input_files(".card:has(h3:text-is('Barcode master')) input[type=file]", f"{OUT}/barcodes.xlsx"); ow.wait_for_selector("#sheet >> text=Load barcodes?"); ow.click(SB("Load")); ow.wait_for_selector("#sheet >> text=1 barcode(s) saved"); ow.click(SB("OK"))
    ow.click(B("Paste from Excel")); ow.fill("textarea[placeholder^='Paste 3 columns']", "Ali Rahman\tNDD Alpha\tCounter\nBudi\tNDD Alpha\tCounter\nSiti Aminah\tNDD Alpha\tChecker")
    ow.click(B("Replace team with pasted list")); ow.wait_for_selector("#sheet >> text=3 people."); ow.click(SB("OK"))
    ac = ow.locator(".card:has(h3:text-is('Admin password'))"); ac.locator("input").fill("AdmPass99"); ac.locator("button:text-is('Save')").click(); ow.wait_for_selector("#sheet >> text=AdmPass99"); ow.click(SB("OK"))
    pc = ow.inner_text(".card:has(h3:text-is('Warehouses and plant codes'))"); check("Settings shows plant codes, no PIN editing", "1502" in pc and not ow.is_visible("text=Branch PINs"), pc)

    print("counter before opening (draft)")
    op = phone(); op.goto(BASE + "/?api=local"); op.wait_for_selector("text=Start counting")
    code(op, "9999"); op.wait_for_selector("text=No warehouse with that plant code"); check("unknown plant code rejected", True)
    code(op, "1501"); op.wait_for_selector("text=Counting hasn't started yet"); check("draft: counter told counting hasn't started", "NDD Alpha" in op.inner_text("main"))

    print("owner: open counting")
    ow.click("#tabs button:text-is('Monthly')"); ow.wait_for_selector("text=3. Upload the SAP MB52"); ow.click("main button:text-is('Continue')")
    ow.wait_for_selector("text=4. Review and open counting"); msgtxt = ow.input_value(".card textarea")
    check("one WhatsApp message for all warehouses", "plant code" in msgtxt and "/?" not in msgtxt.split("link")[-1][:5], msgtxt)
    ow.click("main button:text-is('Open counting')"); ow.click("#sheet button:text-is('Open')"); ow.wait_for_selector(".state.open")
    check("home shows Open with progress table", ow.is_visible("text=Progress") and "NDD Alpha" in ow.inner_text("main"))

    print("ops phone")
    op.click(B("Try again")); op.wait_for_selector("text=Your warehouse"); check("after opening: confirm screen shows warehouse", "NDD Alpha" in op.inner_text("main"))
    km = op.inner_text(".kind-monthly"); check("confirm: big MONTHLY label with the stock take name", "MONTHLY STOCK TAKE" in km and "Ops + Finance" in km, km)
    op.wait_for_selector("text=Which team are you?"); op.click(".big:has-text('Ops team counts')")
    op.wait_for_selector("text=Who is counting?"); op.click(".big:has-text('Ali Rahman')"); op.click(".big:has-text('Budi')"); op.click(B("Start ops count"))
    op.wait_for_selector("text=OPS COUNT"); op.wait_for_selector("text=0 / 3 SKUs counted"); check("count screen opens with 3 SKUs", True)
    op.wait_for_selector("#modal.lock.on >> text=First: warehouse photos", timeout=10000); check("photos come first: blocking step before counting", True)
    op.mouse.click(5, 5); op.wait_for_timeout(300); check("photo step can't be closed by tapping outside", op.is_visible("#modal.lock.on"))
    check("Start counting disabled with 0 photos", op.is_disabled("#sheet button.big1"), op.inner_text("#sheet button.big1"))
    check("camera only: no gallery button", not op.is_visible("#sheet >> text=From gallery") and op.locator("#sheet input[type=file]").count() == 1)
    old_t = time.time() - 3600; os.utime(f"{OUT}/p3.jpg", (old_t, old_t))
    op.set_input_files("#sheet input[type=file]", f"{OUT}/p3.jpg"); op.wait_for_selector("#sheet >> text=Take a new photo with the camera")
    check("an old photo (from the gallery) is refused", "0 of 5 photos" in op.inner_text("#sheet"))
    for i in range(3):
        os.utime(f"{OUT}/p{i}.jpg", None)
        op.set_input_files("#sheet input[type=file]", f"{OUT}/p{i}.jpg"); op.wait_for_selector(f"#sheet >> text={i + 1} of 5 photos", timeout=15000)
    check("location note shown", "Location found" in op.inner_text("#sheet"), op.inner_text("#sheet")[:400])
    dark = op.evaluate("""async () => { const im = document.querySelector('#sheet .pthumb img'); await im.decode(); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
      const lum = (a) => { let t = 0; for (let i = 0; i < a.length; i += 4) t += (a[i] + a[i+1] + a[i+2]) / 3; return t / (a.length / 4); };
      return { band: lum(x.getImageData(c.width - 40, c.height - 6, 30, 4).data), top: lum(x.getImageData(10, 10, 30, 4).data), mid: lum(x.getImageData(0, c.height - 120, c.width, 100).data) }; }""")
    check("photo has a dark stamp band at the bottom", dark["band"] < dark["top"] * 0.6, dark)
    sl = op.evaluate("""async () => { const m = await import('./js/photos.js'); return [m.stampLines({at: Date.UTC(2026, 10, 18, 2, 52, 13), pos: {lat: 3.0732, lon: 101.5183, acc: 12}, addr: 'Jalan Test 23, Shah Alam', who: 'NDD Alpha · Stock take · Ali'}), m.stampLines({at: Date.UTC(2026, 10, 18, 2, 52, 13), pos: null})]; }""")
    check("stamp text: date+time MYT, GPS, address, who", sl[0] == ["18 Nov 2026, 10:52:13 MYT", "GPS 3.073200, 101.518300 (±12 m)", "Jalan Test 23, Shah Alam", "NDD Alpha · Stock take · Ali"], sl[0])
    check("stamp text without location: 'Location not shared'", sl[1] == ["18 Nov 2026, 10:52:13 MYT", "Location not shared"], sl[1])
    op.evaluate("import('./js/state.js').then(m => { m.S.mine.takeId = '00000000-0000-0000-0000-000000000001'; m.S.mine.resetId = 'old'; })")   # phone used for an earlier stock take
    op.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); op.wait_for_timeout(2500)   # back from the camera: the app syncs
    check("back from the camera: the count stays active (not back to the plant code)", op.evaluate("JSON.parse(localStorage.getItem('ndd2-mine')).active") is not None and op.is_visible("#modal.lock.on"))
    check("3 photos → Start counting", op.inner_text("#sheet button.big1") == "Start counting" and not op.is_disabled("#sheet button.big1")); op.click("#sheet button.big1"); op.wait_for_timeout(300)
    op.click(".skuh:has-text('B2')"); op.wait_for_selector("#skuv"); bt = op.locator("#skuv .batch").first
    check("one SKU at a time: no next-SKU button or arrows", not op.is_visible("#skuv >> text=Save & next SKU") and op.locator("#skuv [aria-label='Next SKU']").count() == 0 and op.is_visible("#skuv >> text=Save & back to list"))
    bt.locator("button.plus").nth(0).click(); op.locator("#skuv .batch").first.locator("button.plus").nth(1).click()
    check("B2: 1 ctn + 1 box = 60 PCS", "= 60 PCS" in op.locator("#skuv .batch").first.inner_text())
    op.locator("#skuv .batch").first.locator(".val").nth(2).click(); [op.click(f"#sheet .pad button:text-is('{k}')") for k in ["4","×","1","0"]]; op.click(SB("OK"))
    check("calculator 4×10 → total 100", "= 100 PCS" in op.locator("#skuv .batch").first.inner_text())
    op.click("#skuv [aria-label='Back to list']"); op.click("#footIn .scanbtn"); op.wait_for_selector(".ssheet.on", timeout=15000)
    check("scan: green tick + SKU name", "on" in (op.get_attribute(".tick", "class") or "") and "Wafer A 50g" in op.inner_text(".ssheet"))
    check("scan: save waits for batch", "Pick the batch month first" in op.inner_text(".ssheet .btn.primary"))
    op.click(".ssheet .chip >> text=03/2027"); op.click(".ssheet [aria-label='plus Carton']"); op.click(".ssheet [aria-label='plus Carton']")
    op.fill(".ssheet [aria-label='Pieces']", "5"); op.dispatch_event(".ssheet [aria-label='Pieces']", "input")
    check("scan: 2 ctn + 5 pcs = 53 PCS", "53 PCS" in op.inner_text(".ssheet .stotal"))
    op.click(".ssheet .btn.primary"); op.wait_for_timeout(1200); check("scan: save closes the camera and goes back to the list", not op.is_visible(".scanov") and not op.is_visible(".ssheet.on") and op.is_visible(".skulist2"))
    op.click("#footIn .scanbtn"); op.wait_for_selector(".ssheet.on", timeout=15000); check("scan: rescan shows previous count", op.input_value(".ssheet [aria-label='Carton']") == "2")
    op.click(".ssheet >> text=Cancel"); op.click(".scanbar >> text=Done"); op.click(".seg button:text-is('All')")
    check("scan result in list (53 PCS)", "53 PCS" in op.locator(".sku:has-text('A1')").first.inner_text())
    op.fill(".sbox input", "8993175536707"); op.press(".sbox input", "Enter"); op.wait_for_selector(".ssheet.on")
    check("handheld scanner opens the same sheet", "Wafer A 50g" in op.inner_text(".ssheet")); op.click(".ssheet >> text=Cancel"); op.wait_for_timeout(400)
    op.fill(".sbox input", "C3"); op.dispatch_event(".sbox input", "input"); op.click(".skuh:has-text('C3')"); op.wait_for_selector("#skuv")
    op.locator("#skuv .batch").first.locator("button.plus").nth(1).click(); op.click("#skuv [aria-label='Back to list']"); 
    op.fill(".sbox input", ""); op.dispatch_event(".sbox input", "input"); op.wait_for_timeout(2000)
    op.evaluate("window.dispatchEvent(new Event('online'))"); op.wait_for_timeout(1500); check("autosave → All saved", "All saved" in op.inner_text("#pill"), op.inner_text("#pill"))

    print("admin logs out in the middle of counting")
    ow.click("#lockBtn"); ow.wait_for_selector("text=Start counting"); check("owner logged out → plain counter screen", "Admin" in ow.inner_text("#lockBtn"))
    op.fill(".sbox input", "A1"); op.dispatch_event(".sbox input", "input"); op.click(".seg button:text-is('All')"); op.wait_for_timeout(200)
    op.reload(); op.wait_for_selector(".chead"); check("counter unaffected: still counting after reload", not op.is_visible("text=Start counting"))
    op.click(".seg button:text-is('Counted')"); check("counts still there", "53 PCS" in op.locator(".sku:has-text('A1')").first.inner_text())
    ow.click("#lockBtn"); ow.fill("#sheet input[type=password]", "AdmPass99"); ow.click(SB("Unlock")); ow.wait_for_selector(".state.open")
    pt = ow.inner_text(".card:has(h3:text-is('Progress'))"); check("admin back in: still Open, progress shows ops 3/3", "3 / 3" in pt and "Counting" in pt, pt)

    print("submit with photos")
    (op.click("#skuv [aria-label='Back to list']") if op.is_visible("#skuv") else None); op.click("#footIn >> text=Submit"); op.wait_for_selector("#sheet >> text=Review & submit"); op.check("#sheet input[type=checkbox]"); sign(op, 0); sign(op, 1)
    check("submit enabled with 3 photos", not op.is_disabled("#sheet >> text=Submit count"))
    op.click("#sheet >> text=Submit count"); op.wait_for_selector("text=Submitted ✓", timeout=10000); check("submitted, locked", not op.is_visible("#footIn >> text=Submit"))

    print("finance phone + warehouse without team list")
    fn = phone(); fn.goto(BASE + "/?api=local"); fn.wait_for_selector("text=Start counting"); code(fn, "1501")
    fn.click(".big:has-text('Finance counts again')"); fn.click(".big:has-text('Siti Aminah')"); fn.click(B("Start finance check")); fn.wait_for_selector("text=FINANCE CHECK"); gate(fn)
    def setpcs(c, n):
        fn.fill(".sbox input", c); fn.dispatch_event(".sbox input", "input"); fn.click(f".skuh:has-text('{c}')"); fn.wait_for_selector("#skuv")
        fn.locator("#skuv .batch").first.locator(".val").last.click()
        for k in str(n): fn.click(f"#sheet .pad button:text-is('{k}')")
        fn.click(SB("OK")); fn.click("#skuv [aria-label='Back to list']")
    setpcs("A1", 53); setpcs("B2", 99); fn.fill(".sbox input", ""); fn.dispatch_event(".sbox input", "input"); fn.wait_for_timeout(1800)
    check("finance can't see Ops numbers", "53" not in fn.inner_text(".chead"))
    gm = phone(); gm.goto(BASE + "/?api=local"); gm.wait_for_selector("text=Start counting"); code(gm, "1503")
    gm.click(".big:has-text('Ops team counts')"); gm.wait_for_selector("input[placeholder='Type your name, then Add']")
    check("no team list → name box straight away", True)
    gm.fill("input[placeholder='Type your name, then Add']", "Rahim"); gm.press("input[placeholder='Type your name, then Add']", "Enter"); gm.click(B("Start ops count")); gm.wait_for_selector("text=OPS COUNT"); gate(gm)

    print("in-app browser (WhatsApp)")
    wa = phone(ua="Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 WhatsApp/2.24.1"); wa.goto(BASE + "/?api=local")
    wa.wait_for_selector("text=Open in Chrome first"); check("WhatsApp: open-in-Chrome screen first", wa.get_attribute("a:has-text('Open in Chrome')", "href").startswith("intent://"))
    wa.click(B("Continue here anyway")); wa.wait_for_selector("text=Start counting"); check("can continue anyway", True)

    print("admin: master, recount, close, results")
    ow.click("#tabs button:text-is('Master')"); ow.wait_for_selector("text=Progress - Ops count vs Finance check")
    vt = ow.inner_text(".card:has-text('Ops vs Finance, then')"); check("variance: B2 RECOUNT, C3 OVER", "RECOUNT" in vt and "OVER 2%" in vt, vt[:300])
    ow.locator("button.link:has-text('📷 3')").first.click(); ow.wait_for_selector("#sheet .pthumb img"); check("admin sees 3 warehouse photos", ow.locator("#sheet .pthumb img").count() == 3); ow.click(SB("Close"))
    ow.click(B("Send recount list")); ow.click("#sheet button:text-is('Send')"); ow.wait_for_selector("#sheet >> text=Recount list sent"); ow.click(SB("OK"))
    op.reload(); op.wait_for_selector("text=Recount needed on", timeout=10000); check("ops phone gets recount + reopened", op.is_visible("#footIn >> text=Submit"))
    with ow.expect_download() as d2: ow.click(B("Sign-off PDF"))
    d2.value.save_as(f"{OUT}/signoff.pdf"); check("sign-off PDF downloads", os.path.getsize(f"{OUT}/signoff.pdf") > 5000); ow.click(SB("OK"))
    pdfb = open(f"{OUT}/signoff.pdf", "rb").read()
    check("sign-off PDF has the warehouse photo page (3 ops + 3 finance)", b"Warehouse photos \\(6\\)" in pdfb and pdfb.count(b"/Subtype /Image") >= 4, (pdfb.count(b"/Subtype /Image"), os.path.getsize(f"{OUT}/signoff.pdf")))
    db = phone(1280, 800); db.goto(BASE + "/dashboard/?api=local"); db.wait_for_selector("text=NDD Alpha")
    t = db.inner_text("main"); check("dashboard: progress while open", "Variance is not published" in t and "Ops: Counting" in t, t[:300])
    ow.click("#tabs button:text-is('Monthly')"); ow.wait_for_selector(".state.open"); ow.click(B("Close counting")); ow.click("#sheet button:text-is('Close')"); ow.wait_for_selector(".state.closed")
    rs = ow.inner_text(".card:has(h3:text-is('Results'))"); check("closed: results per warehouse", "NDD Alpha" in rs and "TOTAL" in rs, rs)
    with ow.expect_download() as d: ow.click(B("Export to Excel"))
    d.value.save_as(f"{OUT}/master.xlsx"); check("Excel export downloads", os.path.getsize(f"{OUT}/master.xlsx") > 5000); ow.click(SB("OK"))
    op.reload(); op.wait_for_selector("text=Counting is closed"); check("counter sees closed", True)

    print("new partial stock take + history")
    ow.click(B("Start new stock take")); ow.wait_for_selector("text=New stock take")
    ow.fill("input[placeholder='Cycle count Nov week 4']", "Cycle W4"); ow.click(".choice:has-text('Partial')"); ow.click(B("Save and continue"))
    ow.wait_for_selector("text=2. Pick SKUs"); ow.fill(".card input[type=search]", "wafer"); ow.click(".skulist label:has-text('Wafer A 50g') input")
    check("SKU picker counts selection", "1 of" in ow.inner_text(".card:has(h3:text-is('2. Pick SKUs'))")); ow.click(B("Save and continue"))
    ow.wait_for_selector("text=3. Upload the SAP MB52"); ow.set_input_files(".card:has(h3:text-is('MB52 file')) input[type=file]", f"{OUT}/mb52.xlsx"); ow.wait_for_selector("#sheet >> text=Load MB52?"); ow.click(SB("Load"))
    ow.wait_for_selector("#sheet >> text=plant codes ready", timeout=20000); ow.click(SB("OK")); ow.click("main button:text-is('Continue')"); ow.wait_for_selector("text=4. Review and open counting")
    check("review says Partial · 1 SKU", "Partial" in ow.inner_text("main") and "1 SKUs picked" in ow.inner_text("main"))
    ow.click("main button:text-is('Open counting')"); ow.click("#sheet button:text-is('Open')"); ow.wait_for_selector(".state.open")
    op.reload(); op.wait_for_selector("text=Start counting"); check("old counts gone on phone after new stock take", True)
    code(op, "1501"); op.click(".big:has-text('Ops team counts')"); op.click(".big:has-text('Ali Rahman')"); op.click(B("Start ops count"))
    op.wait_for_selector(".kind-monthly >> text=only 1 SKU on your list"); gate(op); check("partial: counter sees 1 SKU", "MONTHLY STOCK TAKE" in op.inner_text(".kind-monthly") and "0 / 1 SKUs counted" in op.inner_text("main"), op.inner_text("main")[:300])
    ow.wait_for_selector("text=History"); ow.click("button.link:has-text('View (read-only)')"); ow.wait_for_selector("text=History (read-only): Test count")
    check("history opens read-only in Master", not ow.is_visible(B("Close counting")) and not ow.is_visible(B("Send recount list")))
    ow.click(B("Back to current")); ow.wait_for_timeout(800)
    ow.screenshot(path=f"{OUT}/admin_home.png", full_page=True); op.screenshot(path=f"{OUT}/ops_partial.png")

    print("single count + no clear-all")
    check("header credit line", "Built by TaskForce Team" in ow.inner_text("header"))
    ow.click("#tabs button:text-is('Monthly')"); ow.wait_for_selector(".state.open")
    ow.click(B("Close counting")); ow.click("#sheet button:text-is('Close')"); ow.wait_for_selector(".state.closed")
    ow.click("#tabs button:text-is('Master')"); ow.wait_for_selector("text=Reopen counting")
    check("Master: no Clear all counts; Start new stock take instead", not ow.is_visible(B("Clear all counts")) and ow.is_visible(B("Start new stock take")))
    ow.click(B("Start new stock take")); ow.wait_for_selector("text=New stock take"); check("Master → new stock take wizard", True)
    ow.fill("input[placeholder='Cycle count Nov week 4']", "Single W5"); ow.click(".choice:has-text('Total')"); ow.click(".choice:has-text('Single count')"); ow.click(B("Save and continue"))
    ow.wait_for_selector("text=3. Upload the SAP MB52"); ow.set_input_files(".card:has(h3:text-is('MB52 file')) input[type=file]", f"{OUT}/mb52.xlsx"); ow.wait_for_selector("#sheet >> text=Load MB52?"); ow.click(SB("Load"))
    ow.wait_for_selector("#sheet >> text=plant codes ready", timeout=20000); ow.click(SB("OK")); ow.click("main button:text-is('Continue')"); ow.wait_for_selector("text=4. Review and open counting")
    check("review shows Single", "One team counts" in ow.inner_text("main"))
    ow.click("main button:text-is('Open counting')"); ow.click("#sheet button:text-is('Open')"); ow.wait_for_selector(".state.open")
    check("open card: Single count + one-team progress table", "Single count" in ow.inner_text("main") and "Count" in ow.inner_text(".mcard") and "Finance check" not in ow.inner_text(".mcards"))
    op.reload(); op.wait_for_selector("text=Start counting"); code(op, "1501"); op.wait_for_selector(".task")
    op.wait_for_selector("text=Who is counting?"); check("single: team step skipped", not op.is_visible("text=Which team are you?"))
    op.click(".big:has-text('Ali Rahman')"); op.click(B("Start count")); op.wait_for_selector("text=COUNT - count every SKU"); gate(op)
    op.fill(".sbox input", "C3"); op.dispatch_event(".sbox input", "input"); op.wait_for_timeout(300)
    op.click(".skuh:has-text('C3')"); op.wait_for_selector("#skuv")
    op.locator("#skuv .batch").first.locator(".val").last.click(); [op.click(f"#sheet .pad button:text-is('{k}')") for k in ["6","0"]]; op.click(SB("OK")); op.click("#skuv [aria-label='Back to list']"); 
    op.wait_for_timeout(2500); op.evaluate("window.dispatchEvent(new Event('online'))"); op.wait_for_timeout(1500)
    ow.click("#tabs button:text-is('Master')"); ow.click(B("↻")); ow.wait_for_timeout(1200)
    mt = ow.inner_text("main")
    check("Master single: Counted column, COUNTED status, no Finance column", "Counted (PCS)" in mt and "COUNTED" in mt and "Finance (PCS)" not in mt and "Single count" in mt, mt[:600])
    ex = ow.locator("label:has-text('Exceptions only') input")
    if ex.is_checked(): ex.uncheck(); ow.wait_for_timeout(500)
    c3 = ow.locator("tr:has(td:text-is('C3'))").last.inner_text()
    check("Master single: C3 60 vs 60 → OK", "COUNTED" in c3 and "OK" in c3, c3)
    dp = op.context.new_page(); dp.goto("http://localhost:8787/dashboard/?api=local"); dp.wait_for_selector("text=single count")
    check("dashboard single: one bar, no Finance", "Finance" not in dp.inner_text("main") and "Counted" in dp.inner_text("main"), dp.inner_text("main")[:300]); dp.close()
    ow.screenshot(path=f"{OUT}/master_single.png", full_page=True); op.screenshot(path=f"{OUT}/ops_single.png")

    print("counter log out / log in again")
    check("counter header: only Log out (no Admin, no Dashboard)", op.inner_text("#lockBtn").strip() == "Log out" and not op.is_visible("#dashBtn"), op.inner_text("header"))
    check("credit line right under the title", op.inner_text("header .ttl").split("\n")[:2] == ["NDD Stock Count", "Built by TaskForce Team 🐯"], op.inner_text("header .ttl"))
    op.context.set_offline(True); op.click(".seg button:text-is('All')"); op.wait_for_timeout(200)
    op.click(".skuh:has-text('C3')"); op.wait_for_selector("#skuv")
    op.locator("#skuv .batch").first.locator(".val").last.click(); [op.click(f"#sheet .pad button:text-is('{k}')") for k in ["C", "5", "8"]]; op.click(SB("OK")); op.click("#skuv [aria-label='Back to list']"); 
    op.wait_for_timeout(2500)
    (op.click("#skuv [aria-label='Back to list']") if op.is_visible("#skuv") else None); op.click("#lockBtn"); op.wait_for_selector("#sheet >> text=Your counts stay saved"); op.click("#sheet button:text-is('Log out')")
    op.wait_for_selector("#sheet >> text=Some changes have not uploaded yet"); check("offline log out: warns changes kept on phone", True); op.click(SB("OK"))
    op.wait_for_selector("text=Continue a count"); op.wait_for_timeout(2500)
    check("after log out: plant code screen, Admin + Dashboard back, no popup", op.get_attribute("#lockBtn", "title") == "Admin login" and op.is_visible("#dashBtn") and not op.is_visible("#sheet .pad") and "kept on phone" in op.inner_text("#pill").lower(), op.inner_text("#pill"))
    op.context.set_offline(False)
    op.click(".big:has-text('NDD Alpha')"); op.wait_for_selector("#sheet .pad"); [op.click(f"#sheet .pad button:text-is('{d}')") for d in "1501"]; op.click("#sheet button:text-is('Next')")
    op.wait_for_selector("text=COUNT - count every SKU"); op.wait_for_timeout(3000)
    op.click(".seg button:text-is('All')"); c3p = op.locator(".sku:has-text('C3')").first.inner_text()
    check("log in again: same count continues (C3 = 58)", "58" in c3p and op.inner_text("#lockBtn").strip() == "Log out", c3p)
    check("pending change uploaded after login", "All saved" in op.inner_text("#pill"), op.inner_text("#pill"))
    ow.click(B("↻")); ow.wait_for_timeout(1200); check("admin sees 58 for C3", "58" in ow.locator("tr:has(td:text-is('C3'))").last.inner_text(), ow.locator("tr:has(td:text-is('C3'))").last.inner_text())
    with ow.expect_download() as d3: ow.click(B("Export to Excel"))
    d3.value.save_as(f"{OUT}/single.xlsx"); ow.click(SB("OK"))
    with ow.expect_download() as d4: ow.click(B("Sign-off PDF"))
    d4.value.save_as(f"{OUT}/single.pdf"); ow.click(SB("OK")); check("single: Excel + PDF download", os.path.getsize(f"{OUT}/single.pdf") > 5000)

    print("\npage errors:", errs or "none")
    print(f"\n{ok} passed, {bad} failed")
    br.close()
    sys.exit(1 if bad or errs else 0)
