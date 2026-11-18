# Walks through every screen (admin, monthly wizard, master, settings, dashboard, counter, supervisor, modals,
# public dashboard) in dark and light mode and reports text whose contrast with its background is too low.
# Fresh server: BOOTSTRAP_CODE=SETUP-123 SEED_BRANCHES="NDD Alpha,NDD Beta" node server.mjs  (needs /tmp/ndd-ui/mb52.xlsx)
import os, sys, json
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8787"); OUT = "/tmp/ndd-ui"; SCHEME = sys.argv[1] if len(sys.argv) > 1 else "dark"
AUDIT = r"""() => {
  function rgb(s){ const m = s.match(/rgba?\(([^)]+)\)/); if(!m) return null; const p = m[1].split(',').map(x=>parseFloat(x)); return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}; }
  function lum(c){ const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); }
  function bgOf(el){ let e=el; while(e){ const c=rgb(getComputedStyle(e).backgroundColor); if(c && c.a>0.5) return c; e=e.parentElement; } return rgb(getComputedStyle(document.body).backgroundColor)||{r:255,g:255,b:255}; }
  const bad=[]; const seen=new Set();
  document.querySelectorAll('body *').forEach(el=>{
    const st=getComputedStyle(el); if(st.visibility==='hidden'||st.display==='none'||el.offsetParent===null&&st.position!=='fixed') return;
    const r=el.getBoundingClientRect(); if(r.width<2||r.height<2) return;
    const isField=/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
    const own=[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());
    if(!isField&&!own) return;
    if(isField&&['checkbox','radio','range','color','hidden'].includes(el.type)) return;
    const fg=rgb(st.color), bg=bgOf(isField?el:el); if(!fg) return;
    const L1=lum(fg),L2=lum(bg), ratio=(Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
    const txt=(isField?(el.value||el.placeholder||el.type):el.textContent).trim().replace(/\s+/g,' ').slice(0,40);
    if(ratio<3){ const k=el.tagName+'|'+txt; if(!seen.has(k)){ seen.add(k); bad.push(`${el.tagName.toLowerCase()}${el.className?'.'+String(el.className).split(' ')[0]:''} "${txt}" ${ratio.toFixed(2)}`); } }
  });
  return bad;
}"""
results = {}
def audit(pg, label):
    pg.wait_for_timeout(350); b = pg.evaluate(AUDIT); results[label] = b
    print(f"  {'✓' if not b else '✗'} {label}" + ("" if not b else "  ->  " + "; ".join(b[:8])))
    pg.screenshot(path=f"{OUT}/c_{SCHEME}_{label.replace(' ', '_').replace('/', '-')}.png", full_page=True)
def B(t): return f'button:has-text("{t}")'
def SB(t): return f'#sheet button:has-text("{t}")'

with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    def page(w, h):
        ctx = br.new_context(viewport={"width": w, "height": h}, color_scheme=SCHEME, is_mobile=w < 600, has_touch=w < 600)
        return ctx.new_page()
    ow = page(1280, 900); ow.goto(BASE + "/?api=local"); audit(ow, "first run")
    ow.click(B("Start first-time setup")); audit(ow, "modal owner setup")
    ow.fill("input[placeholder='Setup code']", "SETUP-123"); ow.fill("input[placeholder^='New owner password']", "OwnerPass1"); ow.fill("input[placeholder='Repeat password']", "OwnerPass1"); ow.click(SB("Save")); ow.click(SB("OK"))
    audit(ow, "monthly wizard step 1")
    ow.fill("input[placeholder='Cycle count Nov week 4']", "Nov W4"); ow.click(".choice:has-text('Partial')"); ow.click(B("Save and continue")); ow.wait_for_timeout(500); audit(ow, "monthly wizard step 2 skus")
    ow.click("#tabs button:text-is('Daily')"); ow.wait_for_selector("text=Daily stock (MB52)"); audit(ow, "daily empty")
    ow.set_input_files(".card:has(h3:text-is('Daily stock (MB52)')) input[type=file]", f"{OUT}/mb52.xlsx"); ow.wait_for_selector("#sheet >> text=New branches in this MB52"); audit(ow, "modal new branches")
    ow.click(SB("Continue")); ow.wait_for_selector("#sheet >> text=Load MB52?"); ow.click(SB("Load")); ow.wait_for_selector("#sheet >> text=Daily stock loaded", timeout=20000); ow.click(SB("OK"))
    ow.wait_for_selector("text=Daily counts ·"); audit(ow, "daily with lists")
    ow.click("tr:has(td:text-is('NDD Alpha')) button:text-is('ABC')"); ow.wait_for_selector("#sheet >> text=ABC"); audit(ow, "modal ABC"); ow.click(SB("Close"))
    ow.click("#tabs button:text-is('Settings')"); ow.wait_for_selector("text=Daily cycle count"); audit(ow, "settings")
    ow.click("tr:has(td:text-is('NDD Alpha')) button:text-is('Create')"); ow.click(SB("Create")); ow.wait_for_selector("#sheet >> text=PIN:")
    pin = ow.inner_text("#sheet").split("PIN: ")[1][:6]; audit(ow, "modal PIN"); ow.click(SB("OK"))
    ow.click("#tabs button:text-is('Dashboard')"); ow.wait_for_selector("text=Compliance · warehouse × day"); audit(ow, "dashboard admin")
    ow.click("#tabs button:text-is('Master')"); ow.wait_for_timeout(800); audit(ow, "master")
    op = page(390, 844); op.goto(BASE + "/?api=local"); op.wait_for_selector("text=Enter your warehouse plant code"); audit(op, "counter plant code")
    for d in "1501": op.click(f".pad button:text-is('{d}')")
    op.click("button:text-is('Next')"); op.wait_for_selector(B("Yes, that's my warehouse")); audit(op, "counter confirm")
    op.click(B("Yes, that's my warehouse")); op.wait_for_selector("text=Who is counting?"); audit(op, "counter names")
    op.fill("input[placeholder*='name' i]", "Siti"); op.keyboard.press("Enter"); op.wait_for_timeout(300); op.click(B("Start count")); op.wait_for_timeout(800); audit(op, "counter count list")
    op.click(".skuh:has-text('A1')"); op.wait_for_timeout(200); audit(op, "counter sku open")
    op.locator(".sku:has-text('A1') .batch").first.locator(".val").last.click(); audit(op, "counter number pad"); [op.click(f"#sheet .pad button:text-is('{k}')") for k in "12"]; op.click(SB("OK"))
    sp = page(390, 844); sp.goto(BASE + "/?api=local"); sp.click(B("Warehouse supervisor? Log in here")); audit(sp, "modal supervisor login")
    sp.fill("#sheet input[placeholder='Plant code']", "1501"); sp.fill("#sheet input[placeholder='Supervisor PIN']", pin); sp.click(SB("Log in")); sp.wait_for_selector("#sheet >> text=Choose your own PIN"); audit(sp, "modal change PIN")
    sp.fill("#sheet input[placeholder^='New PIN']", "24681357"); sp.fill("#sheet input[placeholder='Repeat new PIN']", "24681357"); sp.click(SB("Save PIN")); sp.wait_for_selector("text=What to do today"); audit(sp, "supervisor today")
    sp.click(B("+ Add SKU to today")); audit(sp, "modal add SKU"); sp.click(SB("Close"))
    pd = page(1280, 900); pd.goto(BASE + "/dashboard/?api=local"); pd.wait_for_selector("text=Daily cycle count · this month"); audit(pd, "public dashboard")
    br.close()
n = sum(len(v) for v in results.values())
print(f"\n{SCHEME}: {len(results)} screens, {n} low-contrast item(s)")
