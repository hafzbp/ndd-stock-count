# Bad-stock stock take end to end: wizard choice, MB52 loads only BS00/BS01/SH00 rows, counter sees BAD STOCK,
# changing the kind after the upload asks first and clears the MB52. Fresh server: BOOTSTRAP_CODE=SETUP-123 node server.mjs
# (run after ui_test.py has written /tmp/ndd-ui/mb52.xlsx).
from playwright.sync_api import sync_playwright
BASE = "http://localhost:8787"; OUT = "/tmp/ndd-ui"
ok = 0; bad = 0
def check(n, c, e=""):
    global ok, bad
    if c: ok += 1; print("  ✓", n)
    else: bad += 1; print("  ✗", n, str(e)[:500])
def B(t): return f'button:has-text("{t}")'
def SB(t): return f'#sheet button:has-text("{t}")'
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ow = b.new_page(viewport={"width": 1280, "height": 900}); errs = []; ow.on("pageerror", lambda e: errs.append(str(e)))
    ow.goto(BASE + "/?api=local"); ow.click(B("Start first-time setup"))
    ow.fill("input[placeholder='Setup code']", "SETUP-123"); ow.fill("input[placeholder^='New owner password']", "OwnerPass1"); ow.fill("input[placeholder='Repeat password']", "OwnerPass1"); ow.click(SB("Save")); ow.click(SB("OK"))
    check("wizard offers Good / Bad stock, Good picked by default", ow.is_visible(".choice.on:has-text('Good stock')") and ow.is_visible(".choice:has-text('Bad stock')"))
    ow.fill("input[placeholder='Cycle count Nov week 4']", "Bad Nov"); ow.click(".choice:has-text('Bad stock')"); ow.click(".choice:has-text('Total')"); ow.click(".choice:has-text('Single count')"); ow.click(B("Save and continue"))
    ow.wait_for_selector("text=3. Upload the SAP MB52")
    check("step 1 summary says Bad stock", "Bad stock" in ow.inner_text(".wiz"), ow.inner_text(".wiz")[:200])
    ow.set_input_files(".card:has(h3:text-is('MB52 file')) input[type=file]", f"{OUT}/mb52.xlsx"); ow.wait_for_selector("#sheet >> text=New branches in this MB52"); ow.click(SB("Continue"))
    ow.wait_for_selector("#sheet >> text=Load MB52?"); cf = ow.inner_text("#sheet")
    check("confirm: BAD STOCK, 1 line, only BS/SH locations", "BAD STOCK - 1 lines" in cf and "Bad stock only" in cf, cf[:400])
    ow.click(SB("Load")); ow.wait_for_selector("#sheet >> text=plant codes ready", timeout=20000); ow.click(SB("OK"))
    # changing the kind after the upload asks first
    ow.click(".wiz button:has-text('1. Name and type')"); ow.click(".choice:has-text('Good stock')"); ow.click(B("Save and continue"))
    check("switching to good asks before removing the MB52", ow.is_visible("#sheet >> text=Change to good stock?"))
    ow.click(SB("Cancel")); ow.click(".choice:has-text('Bad stock')"); ow.click(B("Save and continue")); ow.wait_for_selector("text=3. Upload the SAP MB52")
    check("cancelled: the bad-stock MB52 is still loaded", "1 warehouses" in ow.inner_text(".wiz") or "1 branch" in ow.inner_text("main"), ow.inner_text(".wiz")[:300])
    ow.click("main button:text-is('Continue')"); ow.wait_for_selector("text=4. Review and open counting")
    rv = ow.inner_text("main"); check("review shows Bad stock and BS00, BS01, SH00", "Bad stock" in rv and "BS00, BS01, SH00 only" in rv, rv[:400])
    ow.click("main button:text-is('Open counting')"); ow.click("#sheet button:text-is('Open')"); ow.wait_for_selector(".state.open")
    check("Monthly tab title says Bad stock", "Bad Nov · Bad stock" in ow.inner_text("main h2"), ow.inner_text("main h2"))
    op = b.new_context(viewport={"width": 390, "height": 844}).new_page(); op.on("pageerror", lambda e: errs.append(str(e)))
    op.goto(BASE + "/?api=local"); op.wait_for_selector("text=Start counting")
    for d in "1501": op.click(f".pad button:text-is('{d}')")
    op.click("button:text-is('Next')"); op.wait_for_selector(".kind-bad")
    kt = op.inner_text(".kind-bad"); check("counter: red MONTHLY STOCK TAKE · BAD STOCK label", "MONTHLY STOCK TAKE · BAD STOCK" in kt and "BS00, BS01, SH00" in kt, kt)
    op.wait_for_selector("text=Who is counting?"); op.fill("input[placeholder*='name' i]", "Ali"); op.keyboard.press("Enter"); op.wait_for_timeout(300); op.click(B("Start count")); op.wait_for_selector(".chead"); op.wait_for_timeout(300)
    lst = op.inner_text("main"); check("counter 'To count' list: only the bad-stock SKU (A1)", "A1" in lst and "B2" not in lst and "D4" not in lst and "0 / 1 SKUs counted" in lst, lst[:400])
    check("header says Bad stock take", op.inner_text("#sub").startswith("Bad stock take"), op.inner_text("#sub"))
    op.click(".skuh:has-text('A1')"); op.wait_for_selector("#skuv"); op.locator("#skuv .batch").first.locator(".val").last.click()
    [op.click(f"#sheet .pad button:text-is('{k}')") for k in "8"]; op.click(SB("OK")); op.wait_for_timeout(2500)
    ow.click("#tabs button:text-is('Master')"); ow.wait_for_timeout(1500)
    mt = ow.inner_text("main"); check("Master header says BAD STOCK and A1 shows system 9", "BAD STOCK" in mt and "A1" in mt, mt[:500])
    print("errors:", errs or "none"); b.close()
print(f"\n{ok} passed, {bad} failed")
