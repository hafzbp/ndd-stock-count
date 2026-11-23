import sys, subprocess, time
ok=0; bad=0
def check(n,c,e=""):
    global ok,bad
    if c: ok+=1; print("  ✓",n)
    else: bad+=1; print("  ✗",n,str(e)[:600])
from playwright.sync_api import sync_playwright
BASE="http://localhost:8787"; OUT="/tmp/ndd-ui"
def B(t): return f'button:has-text("{t}")'
def SB(t): return f'#sheet button:has-text("{t}")'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"])
    ow=b.new_page(viewport={"width":1280,"height":900}); ow.goto(BASE+"/?api=local"); ow.click(B("Start first-time setup"))
    ow.fill("input[placeholder='Setup code']","SETUP-123"); ow.fill("input[placeholder^='New owner password']","OwnerPass1"); ow.fill("input[placeholder='Repeat password']","OwnerPass1"); ow.click(SB("Save")); ow.click(SB("OK"))
    ow.fill("input[placeholder='Cycle count Nov week 4']","Trial 3"); ow.click(".choice:has-text('Total')"); ow.click(".choice:has-text('Single count')"); ow.click(B("Save and continue"))
    ow.wait_for_selector("text=3. Upload the SAP MB52"); ow.set_input_files(".card:has(h3:text-is('MB52 file')) input[type=file]", f"{OUT}/mb52.xlsx"); ow.wait_for_selector("#sheet >> text=New branches in this MB52"); ow.click(SB("Continue"))
    ow.wait_for_selector("#sheet >> text=Load MB52?"); ow.click(SB("Load")); ow.wait_for_selector("#sheet >> text=plant codes ready", timeout=20000); ow.click(SB("OK")); ow.click("main button:text-is('Continue')")
    ow.click("main button:text-is('Open counting')"); ow.click("#sheet button:text-is('Open')"); ow.wait_for_selector(".state.open")
    ctx=b.new_context(viewport={"width":390,"height":844}); op=ctx.new_page(); errs=[]; op.on("pageerror", lambda e: errs.append(str(e)))
    op.goto(BASE+"/?api=local"); op.wait_for_selector("text=Start counting")
    for d in "1501": op.click(f".pad button:text-is('{d}')")
    op.click("button:text-is('Next')"); op.wait_for_selector("text=Who is counting?")
    op.fill("input[placeholder*='name' i]","Ali"); op.keyboard.press("Enter"); op.wait_for_timeout(300); op.click(B("Start count")); op.wait_for_selector("text=COUNT - count every SKU")
    op.click(".skuh:has-text('A1')"); op.wait_for_selector("#skuv"); op.locator("#skuv .batch").first.locator(".val").last.click()
    [op.click(f"#sheet .pad button:text-is('{k}')") for k in "10"]; op.click(SB("OK")); op.wait_for_timeout(2500)
    ow.click(B("Close counting")); ow.click("#sheet button:text-is('Close')"); ow.wait_for_selector(".state.closed")
    op.reload(); op.wait_for_timeout(3000)
    check("closed: clear 'Counting is closed' card with a Done button", op.is_visible("text=Counting is closed") and op.is_visible(B("Done - back to start")), op.inner_text("main")[:300])
    op.click(B("Done - back to start")); op.wait_for_timeout(1200)
    check("Done: back to the plant code screen, no 'Continue a count' for the closed stock take", op.is_visible("text=Start counting") and not op.is_visible("text=Continue a count"), op.inner_text("main")[:300])
    op.reload(); op.wait_for_timeout(2500)
    check("after refresh: still the start screen (not stuck on the closed count)", op.is_visible("text=Start counting") and not op.is_visible("text=Continue a count") and not op.is_visible("text=Counting is closed"), op.inner_text("main")[:300])
    print("owner deletes the closed stock take")
    ow.click(B("Delete")); ow.wait_for_selector("#sheet >> text=Delete “Trial 3”?")
    ow.fill("#sheet input", "Trial"); ow.click(SB("Delete for good")); check("wrong name refused", "Type the name exactly" in ow.inner_text("#sheet"))
    ow.fill("#sheet input", "Trial 3"); ow.click(SB("Delete for good")); ow.wait_for_timeout(1500)
    check("deleted: Monthly tab goes to setting up a new stock take, Trial 3 gone", "Trial 3" not in ow.inner_text("main") and "Set up the stock take" in ow.inner_text("main"), ow.inner_text("main")[:400])
    print("errors:", errs or "none")
    b.close()
print(f"\n{ok} passed, {bad} failed")
