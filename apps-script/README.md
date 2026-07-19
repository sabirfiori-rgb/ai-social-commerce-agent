# AI Social Commerce Agent — Apps Script bundle

Container-bound Apps Script for the control-surface Google Sheet. It gives an
operator a menu inside the Sheet to add products, mark rows for
reprocessing, ping the backend for an immediate poll, and keep the tab
layout/headers/validation correct. Uses only Apps Script built-in services
(`SpreadsheetApp`, `HtmlService`, `PropertiesService`, `UrlFetchApp`,
`Utilities`, `ScriptApp`) — no external libraries.

Files:

- `appsscript.json` — project manifest (timezone, V8 runtime, OAuth scopes).
- `Code.gs` — menu, sidebar, product/row operations, backend webhook call,
  sheet initialization, triggers, `onEdit`.
- `Sidebar.html` — the "Add Product" form shown in the sidebar.

## 1. Bind the script to the Sheet

Option A — paste directly in the Apps Script editor:

1. Open the Google Sheet.
2. **Extensions → Apps Script**. This opens a new, empty container-bound
   project already linked to the Sheet.
3. Delete the default `Code.gs` boilerplate and the default
   `appsscript.json` content.
4. Create matching files in the editor (**File → New → Script file** for
   `.gs`, **File → New → HTML file** for `.html`) and paste in the contents
   of this folder:
   - `Code.gs`
   - `Sidebar.html`
   - For `appsscript.json`, click the gear icon (**Project Settings**) and
     enable **"Show 'appsscript.json' manifest file in editor"**, then paste
     its contents in.
5. Save (**Ctrl/Cmd+S** or the save icon). Reload the Sheet tab in your
   browser — the **AI Agent** menu should appear within a few seconds.

Option B — [`clasp`](https://github.com/google/clasp) (recommended for
version control):

```bash
npm install -g @google/clasp
clasp login

# From this apps-script/ directory:
clasp create --type sheets --title "AI Social Commerce Agent" --rootDir .
# — or, if the script is already bound to an existing Sheet, grab its
#   Script ID from Extensions > Apps Script > Project Settings and put it
#   in a .clasp.json { "scriptId": "..." } file instead of running `create`.

clasp push
clasp open
```

`clasp push` uploads `appsscript.json`, `Code.gs`, and `Sidebar.html` as-is —
no build step is required.

## 2. Authorize scopes

The manifest requests three OAuth scopes:

- `https://www.googleapis.com/auth/spreadsheets` — read/write the Sheet
  (rows, headers, data validation).
- `https://www.googleapis.com/auth/script.external_request` — lets
  `UrlFetchApp` call the backend's webhook (`Trigger Processing Now`).
- `https://www.googleapis.com/auth/script.container.ui` — custom menu and
  sidebar.

The first time you run any menu item (e.g. **AI Agent → Initialize Sheet
Tabs**), Google shows a standard "This app isn't verified" / permission
screen because the project is unpublished and owned by you. Click **Advanced
→ Go to (project name) (unsafe)** — this is expected for personal/internal
scripts — then **Allow**. You only need to do this once per Google account.

## 3. Set up the Sheet tabs

Run **AI Agent → Initialize Sheet Tabs** once after binding the script. It:

- Creates any of the six tabs that don't already exist: `Products`,
  `Brand Settings`, `Publishing Schedule`, `Generated Content`, `Logs`,
  `Analytics`.
- Writes the header row on any tab whose header row is currently blank
  (it never overwrites headers that are already present).
- Freezes row 1 on every tab.
- Applies a dropdown data-validation rule to the `Products.Status` column
  with the seven canonical values: `NEW`, `PROCESSING`,
  `PRODUCT_IMPORTED`, `CONTENT_CREATED`, `VIDEO_CREATED`, `POSTED`,
  `FAILED`.

Safe to re-run at any time — it only fills in what's missing.

## 4. Point it at the backend

Run **AI Agent → Set Backend URL…** and enter:

1. The backend's base URL (e.g. `https://your-service.example.com`, no
   trailing slash needed — it's normalized automatically).
2. Optionally, a shared-secret bearer token, if the backend's
   `/api/actions/run` endpoint requires
   `Authorization: Bearer <token>`. Leave blank to call it unauthenticated.

Both values are stored in this script's **Script Properties**
(`BACKEND_URL`, `BACKEND_TOKEN`) — private to the script project, not
written anywhere in the Sheet itself.

Use **AI Agent → Trigger Processing Now** at any time to POST to
`{backendUrl}/api/actions/run` immediately and see a toast with the result.

## 5. Adding products

**AI Agent → Add Product…** opens a sidebar form. Pick a source, fill in the
relevant fields, choose one or more platforms, and submit. This appends a
new row to `Products` with `Status = NEW`, a generated ID, and
`Created Time` / `Updated Time` set to now (ISO-8601 UTC).

For **manual** entries with no product page to import from, expand **"For
manual entry"** and fill in Title (required), Description, Features (one
per line), Price, Currency, and Image URLs (one per line). These are packed
into a single JSON object and written into the `Product URL` cell — the
backend's manual product source reads that inline JSON directly, so no
separate storage step is needed.

**AI Agent → Mark Selected as NEW** resets the `Status` of every selected
Products row back to `NEW` (e.g. to reprocess a `FAILED` row after fixing
its data), skipping the header row.

## 6. The 5-minute trigger vs. the backend's own polling

The backend already polls the Sheet on its own schedule
(`POLL_INTERVAL_MINUTES`, default every 5 minutes per `.env.example`) via
the Google Sheets API, independent of anything in this Apps Script project.
**You do not need to install anything here for normal operation.**

This project additionally offers an *optional* time-based trigger,
installed by running the `installTrigger()` function once from the Apps
Script editor (**Run → installTrigger**, or bind it to a menu item if you
want a UI entry point). It calls `triggerProcessingNow()` every 5 minutes,
which just POSTs to the backend's webhook — the same action as clicking
**Trigger Processing Now** by hand.

Use it if you want the Sheet itself to nudge the backend on a schedule
(e.g. the backend's own poll interval is longer, or its scheduler is
paused and you want the Sheet to be the sole heartbeat). It is redundant
with the backend's built-in polling otherwise. Run `removeTriggers()` the
same way to uninstall it — it removes every trigger this script owns that
targets `triggerProcessingNow`, so it's safe to call even if none exist.

## Notes on `onEdit`

The bundled `onEdit(e)` is a **simple trigger** (not an installable one), so
it runs automatically with no extra setup and no external-request
permission — it only ever touches cells in the currently open Sheet. When a
user types a value into a core Products field (Product Source, Product URL,
Product ID, Brand, Platform, Language, Category, Schedule Date, Schedule
Time) on a data row whose `Status` cell is still blank, it defaults
`Status` to `NEW` and stamps `Created Time`/`Updated Time`. It intentionally
ignores edits to the `Status` column itself and ignores multi-cell/paste
edits, so it never fights a deliberate status change or a bulk paste — use
**Mark Selected as NEW** for bulk operations instead.

## Backend authentication

If the backend has `API_TOKENS` set, use the **AI Agent → Set Backend URL…** menu item to also store a **BACKEND_TOKEN** equal to one of those tokens. The 5-minute trigger and the *Trigger Processing Now* action send it as `Authorization: Bearer <BACKEND_TOKEN>`; without it, calls to a secured backend return 401.
