# My Warehouse

The warehouse app for Nabati Malaysia NDDs (formerly NDD Stock Count): monthly stock take (Ops and Finance
count separately), daily cycle count (DCC), and LSH, the daily stock ledger each warehouse keeps and closes
at the cut-off, checked every evening against SAP MB52.

- **App (counters + Finance):** `index.html` → https://hafzbp.github.io/ndd-stock-count/
- **Public live dashboard:** `dashboard/` → https://hafzbp.github.io/ndd-stock-count/dashboard/
- **Backend:** Supabase project `ndd-stock-count` (Singapore), free plan.

## Who logs in how
| Who | How | Can do |
|---|---|---|
| Warehouse people (NDD on **Username and PIN**) | First page, any phone: username (e.g. `ravi.1503`) + 6-digit PIN. The phone remembers the last username, so next time only the PIN. **Done** or 5 minutes without use logs out | Logistic Officer: record stock movements (LSH). Warehouse Admin / Supervisor: daily count. Ops Manager: everything, close the day, approve corrections, explain differences, add people |
| Counter (NDD still on **plant code**) | "Count with the plant code" link on the first page (a phone that used it opens there directly) | Count, scan, photos, sign, submit |
| Monthly stock take helpers | Admin, Supervisor or OM logs in and taps "Join stock take" on Today; the phone is then open for counting | Ops or Finance count, names, signatures (as before) |
| HQ | First page or the HQ button: email + password (superadmin, HQ admin, HQ Finance). Old shared passwords work until the superadmin switches them off | Run everything; superadmin manages HQ accounts |
| Anyone | Dashboard link | What Settings → Public dashboard allows |

HQ menu: **Overview · Stock · Count (Daily, Monthly, live counts, count here) · KPI · Setup (Settings, People, HQ accounts)**.

## LSH, the daily stock ledger (NDDs with Stock switched on)
- Areas: **good stock**, **staging** (invoiced in SAP, still in the warehouse: SAP posts GI at invoice) and **bad stock**.
- Movements, each with its document: goods received, invoice to staging, loaded on truck, failed delivery back, SAP reversal posted, redeliver, customer return, move to bad stock, transfer out. Typed as cartons, boxes and packs (with product photos where we have them), stored in pcs.
- Undo your own entry for 10 minutes; after that a correction, approved by the Ops Manager (an OM's own by HQ).
- The Ops Manager closes the day at the cut-off (16:00) with their PIN; a day nobody closed is closed by the app at midnight, marked late.
- HQ uploads one MB52 at 17:00 (Count → Daily). For each closed day the app compares good stock with MW00/MW01 and bad stock with BS00/BS01/SH00 (staging is left out). Each difference gets one of four reasons and is due in 24 hours; the same difference the next day keeps its reason.
- Opening stock and resets: Stock → Opening and reset, from an MB52 or a closed stock take.

## A stock take, start to finish
1. **Stock take tab → wizard (Draft):** name + Total or Partial + Double or Single count → pick SKUs (Partial) → upload MB52 → review → **Open counting**.
   - **Double count:** Ops and Finance count separately; a line is agreed only when both match.
   - **Single count:** one team counts (no team step for counters); its count is the agreed count. If both teams happen to count a line, they must still match.
2. **Open:** send the one WhatsApp message; counters open the link, enter the plant code, pick team, type name, count.
   Admin watches progress (Stock take tab, Master) and sends recount lists.
3. **Close counting:** results per warehouse, Excel, sign-off PDF per warehouse, dashboard variance (by level).
4. **Start new stock take:** the old one moves to History (read-only).

## Daily cycle count (DCC)
- **HQ (Daily tab):** upload the MB52 every day (one file, all plants, with RM values). Each NDD then gets a short list per working day.
- **The list:** ABC per NDD per month by stock value (A = first 80%, B = next 15%, C = rest; worked out on the 1st). Monthly targets A 4×, B 2×, C 1× are spread over the remaining working days; SKUs outside tolerance yesterday come back as recounts (R). Supervisors can add SKUs (S). Single count.
- **Supervisor:** "Warehouse supervisor? Log in here" → plant code + PIN (HQ creates it in Settings; supervisor must change it at first login). Sees own warehouse, adds SKUs, skips a day with a reason, 30-day history, ABC plan.
- **Settings:** rules, working days and count window per NDD (late = submitted after the window), supervisor PINs.
- **Dashboard tab / public page:** counted today, coverage, accuracy (IRA), compliance grid, trends, per-warehouse table, top variance (RM only after login).
- An open monthly stock take at a warehouse pauses its daily count. Yesterday's count closes automatically the next day.

## How it is built (so it is easy to extend)
```
index.html, css/app.css
js/config.js   backend URL + public key
js/api.js      every server call (rpc / edge function)
js/pure.js     logic with no screen: MB52 parsing, PCS conversion, variance, tolerance (unit-tested)
js/state.js    this phone's counts, local backup, autosave, sync
js/count.js    counter screens          js/scan.js     camera + handheld barcode scanning
js/photos.js   warehouse photos         js/master.js   admin master view
js/setup.js    Settings tab + MB52 card js/export.js   Excel + sign-off PDF
js/app.js      start-up, header, HQ menu, logins
js/wh.js       first-page login, first PIN, Today, sign-out   js/lsh.js  LSH screens
js/whadmin.js  HQ: Stock (LSH vs SAP, staging, opening), People, HQ accounts
js/i18n.js     English / Bahasa Melayu words for warehouse people
assets/sku/    product photos (carton, box, pack) by SKU code
dashboard/     public dashboard
sql/NNN_*.sql  database, numbered migrations (apply in order)
supabase/functions/photos   edge function for photos (private storage)
tests/         backend + UI tests (run locally, no Supabase needed)
vendor/        zxing (barcodes), SheetJS (Excel), jsPDF (PDF)
```
Security model: every table is closed to the public API. The page can only call the functions in
`sql/`, and each one checks a token on the server. Warehouse people log in with a
username and a bcrypt-hashed 6-digit PIN (5 wrong tries lock the person for 15 minutes; tries are also
rate-limited per username) and get a 12-hour token tied to the person. The device set-up of 2.18.0 is retired. Plant-code login remains for NDDs not yet moved; it identifies the warehouse
rather than keeping outsiders out. HQ passwords are bcrypt hashes.

### Adding a feature
- **A new setting:** add the key to `admin_settings` (or prefix it `x_` — those are accepted without a migration), read it from `S.adm.settings` in the UI.
- **Database change:** add `sql/00N_name.sql`, apply it in Supabase (SQL editor or MCP), commit the file.
- **New screen logic:** put calculations in `js/pure.js` with a test, UI in its own module.

## Tests
```
cd tests && npm i
node backend.test.mjs                          # 66 checks on the real SQL (PGlite)
node mw.test.mjs                               # 24 checks: username login, HQ accounts, LSH
BOOTSTRAP_CODE=SETUP-123 node server.mjs &     # local backend on :8787
python3 ui_test.py                             # 84 end-to-end checks, needs Playwright + Chrome
```

## Free plan notes
- The project pauses after 7 days without use. Open the Supabase dashboard and press **Restore** a day before a stock take.
- No automatic backups: Setup → **Download backup** after every stock take.
- Upgrading to Pro keeps the same project and data.
