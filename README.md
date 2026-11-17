# NDD Stock Count

Double-count stock take for Nabati Malaysia NDD warehouses: Ops counts, Finance counts again separately,
the app compares both and then compares the agreed count to SAP MB52.

- **App (counters + Finance):** `index.html` → https://hafzbp.github.io/ndd-stock-count/
- **Public live dashboard:** `dashboard/` → https://hafzbp.github.io/ndd-stock-count/dashboard/
- **Backend:** Supabase project `ndd-stock-count` (Singapore), free plan.

## Who logs in how
| Who | How | Can do |
|---|---|---|
| Counter (Ops / Finance check) | Warehouse **SAP plant code** (from the MB52) | Count, scan, photos, sign, submit — only their own phone's counts |
| Admin | Admin password (🔒 Admin) | Run stock takes: wizard, monitor, recount, close, export, settings |
| Owner | Owner password | Everything + passwords, clear counts, backup |
| Anyone | Dashboard link | What Settings → Public dashboard allows |

## A stock take, start to finish
1. **Stock take tab → wizard (Draft):** name + Total or Partial → pick SKUs (Partial) → upload MB52 → review → **Open counting**.
2. **Open:** send the one WhatsApp message; counters open the link, enter the plant code, pick team, type name, count.
   Admin watches progress (Stock take tab, Master) and sends recount lists.
3. **Close counting:** results per warehouse, Excel, sign-off PDF per warehouse, dashboard variance (by level).
4. **Start new stock take:** the old one moves to History (read-only).

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
js/app.js      start-up, header, tabs, logins
dashboard/     public dashboard
sql/NNN_*.sql  database, numbered migrations (apply in order)
supabase/functions/photos   edge function for photos (private storage)
tests/         backend + UI tests (run locally, no Supabase needed)
vendor/        zxing (barcodes), SheetJS (Excel), jsPDF (PDF)
```
Security model: every table is closed to the public API. The page can only call the functions in
`sql/`, and each one checks a token on the server. Counter login uses the warehouse plant code (a known
code, chosen for simplicity, so it identifies the warehouse rather than keeping outsiders out); admin
and owner passwords are stored as bcrypt hashes.

### Adding a feature
- **A new setting:** add the key to `admin_settings` (or prefix it `x_` — those are accepted without a migration), read it from `S.adm.settings` in the UI.
- **Database change:** add `sql/00N_name.sql`, apply it in Supabase (SQL editor or MCP), commit the file.
- **New screen logic:** put calculations in `js/pure.js` with a test, UI in its own module.

## Tests
```
cd tests && npm i
node backend.test.mjs                         # 30 checks on the real SQL (PGlite)
BOOTSTRAP_CODE=SETUP-123 node server.mjs &     # local backend on :8787
python3 ui_test.py                             # 49 end-to-end checks, needs Playwright + Chrome
```

## Free plan notes
- The project pauses after 7 days without use. Open the Supabase dashboard and press **Restore** a day before a stock take.
- No automatic backups: Setup → **Download backup** after every stock take.
- Upgrading to Pro keeps the same project and data.
