# NDD Stock Count

Double-count stock take for Nabati Malaysia NDD warehouses: Ops counts, Finance counts again separately,
the app compares both and then compares the agreed count to SAP MB52.

- **App (counters + Finance):** `index.html` → https://hafzbp.github.io/ndd-stock-count/
- **Public live dashboard:** `dashboard/` → https://hafzbp.github.io/ndd-stock-count/dashboard/
- **Backend:** Supabase project `ndd-stock-count` (Singapore), free plan.

## Who logs in how
| Who | How | Can do |
|---|---|---|
| Counter (Ops / Finance check) | Branch PIN (4-6 digits) | Count, scan, photos, sign, submit — only their own phone's counts |
| Finance | Finance password | Master + Setup (MB52, factors, barcodes, PINs, team, rules, recount, reopen, close, export) |
| Owner | Owner password | Everything + Finance password, clear counts, new stock take, backup |
| Anyone | Dashboard link | What Setup → Public dashboard allows |

## How it is built (so it is easy to extend)
```
index.html, css/app.css
js/config.js   backend URL + public key
js/api.js      every server call (rpc / edge function)
js/pure.js     logic with no screen: MB52 parsing, PCS conversion, variance, tolerance (unit-tested)
js/state.js    this phone's counts, local backup, autosave, sync
js/count.js    counter screens          js/scan.js     camera + handheld barcode scanning
js/photos.js   warehouse photos         js/master.js   Finance master view
js/setup.js    Setup tab                js/export.js   Excel + sign-off PDF
js/app.js      start-up, header, tabs, logins
dashboard/     public dashboard
sql/NNN_*.sql  database, numbered migrations (apply in order)
supabase/functions/photos   edge function for photos (private storage)
tests/         backend + UI tests (run locally, no Supabase needed)
vendor/        zxing (barcodes), SheetJS (Excel), jsPDF (PDF)
```
Security model: every table is closed to the public API. The page can only call the functions in
`sql/002_functions.sql`, and each one checks a PIN/password token on the server. PINs never leave the
database except to Finance; passwords are stored as bcrypt hashes.

### Adding a feature
- **A new setting:** add the key to `admin_settings` (or prefix it `x_` — those are accepted without a migration), read it from `S.adm.settings` in the UI.
- **Database change:** add `sql/00N_name.sql`, apply it in Supabase (SQL editor or MCP), commit the file.
- **New screen logic:** put calculations in `js/pure.js` with a test, UI in its own module.

## Tests
```
cd tests && npm i
node backend.test.mjs                         # 35 checks on the real SQL (PGlite)
BOOTSTRAP_CODE=SETUP-123 node server.mjs &     # local backend on :8787
python3 ui_test.py                             # 36 end-to-end checks, needs Playwright + Chrome
```

## Free plan notes
- The project pauses after 7 days without use. Open the Supabase dashboard and press **Restore** a day before a stock take.
- No automatic backups: Setup → **Download backup** after every stock take.
- Upgrading to Pro keeps the same project and data.
