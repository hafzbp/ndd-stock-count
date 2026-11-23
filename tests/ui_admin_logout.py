# Admin logs in on a counter phone, finishes the counter's count, logs out: the phone must not stay stuck in that count.
# Also: a phone already stuck (open count, no plant-code login) gets a Log out button. Fresh server: BOOTSTRAP_CODE=SETUP-123 node server.mjs
import sys
from playwright.sync_api import sync_playwright
BASE="http://localhost:8787"; OUT="/tmp/ndd-ui"
ok=0; bad=0
def check(n,c,e=""):
    global ok,bad
    if c: ok+=1; print("  ✓",n)
    else: bad+=1; print("  ✗",n,str(e)[:400])
def B(t): return f'button:has-text("{t}")'
def SB(t): return f'#sheet button:has-text("{t}")'
def hdr(pg): return pg.inner_text("#lockBtn").strip()
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    ow=b.new_page(viewport={"width":1280,"height":900}); ow.goto(BASE+"/?api=local"); ow.click(B("Start first-time setup"))
    ow.fill("input[placeholder='Setup code']","SETUP-123"); ow.fill("input[placeholder^='New owner password']","OwnerPass1"); ow.fill("input[placeholder='Repeat password']","OwnerPass1"); ow.click(SB("Save")); ow.click(SB("OK"))
    ow.fill("input[placeholder='Cycle count Nov week 4']","Test 3"); ow.click(".choice:has-text('Total')"); ow.click(".choice:has-text('Double count')"); ow.click(B("Save and continue"))
    ow.wait_for_selector("text=3. Upload the SAP MB52"); ow.set_input_files(".card:has(h3:text-is('MB52 file')) input[type=file]", f"{OUT}/mb52.xlsx"); ow.wait_for_selector("#sheet >> text=New branches in this MB52"); ow.click(SB("Continue"))
    ow.wait_for_selector("#sheet >> text=Load MB52?"); ow.click(SB("Load")); ow.wait_for_selector("#sheet >> text=plant codes ready", timeout=20000); ow.click(SB("OK")); ow.click("main button:text-is('Continue')")
    ow.click("main button:text-is('Open counting')"); ow.click("#sheet button:text-is('Open')"); ow.wait_for_selector(".state.open")
    ow.click("#tabs button:text-is('Settings')"); ow.wait_for_selector("text=Warehouse photos at submit")
    ow.locator(".card:has(h3:text-is('Warehouse photos at submit')) input[type=number]").first.fill("0"); ow.click(".card:has(h3:text-is('Warehouse photos at submit')) button:has-text('Save')"); ow.click(SB("OK"))
    ac = ow.locator(".card:has(h3:text-is('Admin password'))"); ac.locator("input").fill("AdmPass99"); ac.locator("button:text-is('Save')").click(); ow.wait_for_selector("#sheet >> text=AdmPass99"); ow.click(SB("OK"))
    ctx=b.new_context(viewport={"width":820,"height":1180}); op=ctx.new_page(); errs=[]; op.on("pageerror", lambda e: errs.append(str(e)))
    op.goto(BASE+"/?api=local"); op.wait_for_selector("text=Start counting")
    # the iPad: counter starts Keningau (1501 here), logs out, then the same iPad logs in as admin
    for d in "1501": op.click(f".pad button:text-is('{d}')")
    op.click("button:text-is('Next')"); op.click(".big:has-text('Ops team counts')")
    op.wait_for_selector("text=Who is counting?"); op.fill("input[placeholder*='name' i]","tedt"); op.keyboard.press("Enter"); op.wait_for_timeout(300); op.click(B("Start ops count")); op.wait_for_selector("text=OPS COUNT")
    op.click(".skuh:has-text('A1')"); op.wait_for_selector("#skuv"); op.locator("#skuv .batch").first.locator(".val").last.click()
    [op.click(f"#sheet .pad button:text-is('{k}')") for k in "10"]; op.click(SB("OK")); op.wait_for_timeout(2500)
    (op.click("#skuv [aria-label='Back to list']") if op.is_visible("#skuv") else None); op.click("#lockBtn"); op.click("#sheet button:text-is('Log out')"); op.wait_for_timeout(800)
    (op.click("#skuv [aria-label='Back to list']") if op.is_visible("#skuv") else None); op.click("#lockBtn"); op.fill("#sheet input[type=password]", "AdmPass99"); op.click(SB("Unlock")); op.wait_for_timeout(2500)
    op.click("#tabs button:text-is('Count')"); op.wait_for_timeout(800)
    op.click(".big:has-text('NDD Alpha')"); op.wait_for_selector("text=OPS COUNT")
    (op.click("#skuv [aria-label='Back to list']") if op.is_visible("#skuv") else None); op.click("#footIn >> text=Submit"); op.wait_for_selector("#sheet >> text=Review & submit"); op.check("#sheet input[type=checkbox]")
    c = op.locator("#sheet canvas").first; c.evaluate("e => e.scrollIntoView({block: 'center'})"); op.wait_for_timeout(150); bb = c.bounding_box(); op.mouse.move(bb["x"]+20, bb["y"]+20); op.mouse.down(); op.mouse.move(bb["x"]+150, bb["y"]+50, steps=8); op.mouse.up()
    op.click("#sheet >> text=Submit count"); op.wait_for_selector("text=Submitted ✓", timeout=10000); op.wait_for_timeout(1000)
    check("admin on the phone submitted the counter's count", "Submitted" in op.inner_text("main"))
    (op.click("#skuv [aria-label='Back to list']") if op.is_visible("#skuv") else None); op.click("#lockBtn"); op.wait_for_timeout(1500)   # admin logs out
    check("after admin logout: back to the plant code screen (not stuck in the count)", op.is_visible("text=Start counting"), (hdr(op), op.inner_text("main")[:200]))
    op.reload(); op.wait_for_timeout(3000)
    check("after refresh: still the start screen", op.is_visible("text=Start counting"), (hdr(op), op.inner_text("main")[:200]))
    # a phone already stuck from the old version (open count, no plant-code login): it must have a way out
    op.evaluate("() => { const m = JSON.parse(localStorage.getItem('ndd2-mine')); m.active = Object.keys(m.sessions)[0]; localStorage.setItem('ndd2-mine', JSON.stringify(m)); localStorage.setItem('ndd2-tokens', '{}'); }")
    op.reload(); op.wait_for_timeout(3000)
    check("a phone left in a count without a login shows Log out", hdr(op) == "Log out", (hdr(op), op.inner_text("#sub")))
    if hdr(op) == "Log out":
        (op.click("#skuv [aria-label='Back to list']") if op.is_visible("#skuv") else None); op.click("#lockBtn"); op.wait_for_timeout(500)
        if op.is_visible("#sheet button:text-is('Log out')"): op.click("#sheet button:text-is('Log out')")
        op.wait_for_timeout(1200)
        check("...and Log out takes it back to the start screen", op.is_visible("text=Start counting"), op.inner_text("main")[:200])
    print("errors:", errs or "none"); b.close()
print(f"\n{ok} passed, {bad} failed")
