# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Google Maps lead scraping, in **two independent implementations** of the same
logic (same Apify actor `compass/crawler-google-places`, same 15-column output):

1. **`scraper/` (Python) + `desktop/` (Electron)** — the primary path. A
   standalone scraper plus a desktop UI to run it and watch progress live. Built
   because n8n wouldn't install locally.
2. **`google-maps-lead-gen.n8n.json`** — the original n8n workflow (see the
   dedicated section below). Kept as reference; the Python scraper deliberately
   mirrors its field mapping, dedup rule, and 100-result default.

Design spec: `docs/superpowers/specs/2026-07-11-google-maps-scraper-desktop-design.md`.

## Commands

```bash
# Python scraper (from scraper/)
pip install -r requirements.txt && playwright install chromium
python3 scraper.py --location "Punjab, India" [--category clothing] [--max-results 100] [--json]

# Electron app (from desktop/)
npm install
npm start
```

There is **no test suite or lint config**. Verify the scraper by running it with
`--json` and checking the NDJSON stream + the generated `output/leads_*.csv`.
Mocked/pure-logic checks (mapping, dedup, CSV, event plumbing) are the fastest way
to validate changes without hitting Apify or launching a browser.

## Python scraper + Electron architecture

**They connect over stdout, not a server.** `desktop/main.js` spawns
`scraper/scraper.py --json` as a child process and reads **newline-delimited JSON
(NDJSON)** events from its stdout. Keep this contract stable when editing either
side — the event shapes are the interface:
`status`, `progress`, `lead`, `done`, `error` (main.js also synthesizes `exit`).

Key facts that span multiple files:

- **`scraper/mapping.py` is the single schema boundary.** Both the Apify source
  and the Playwright fallback yield raw dicts using **Apify's key names**
  (`title`, `address`, `phone`, `website`, `emails`, `totalScore`, `location`,
  `url`, …); `map_record` normalizes them to the 15 canonical columns. To add a
  browser field, emit it under the Apify key name — don't special-case it.
- **The 15 columns and their order are load-bearing** and identical across
  `mapping.py::COLUMNS`, `events.py::CsvWriter`, and `main.js::COLUMNS` (the
  filtered-export writer). Change one, change all three, or the export CSV drifts
  from the run CSV.
- **Fallback logic lives in `scraper.py::run`:** try Apify only if a token
  resolves (`config.py`: `APIFY_TOKEN` env → `config.json`); fall back to
  `sources/browser.py` when there's no token, Apify raises `ApifyError`, or Apify
  returns zero leads. `sources/browser.py` imports Playwright lazily so the
  Apify-only path never needs it installed.
- **Dedup + incremental CSV are in the `handle_raw` closure:** each record is
  mapped, checked against `dedupe_key` (name+full_address, matching n8n), written
  to CSV immediately (flushed), and emitted. A SIGTERM (the app's Stop button)
  sets `_STOP` so the loop exits and the partial CSV survives.
- **Electron security:** renderer runs with `contextIsolation:true`,
  `nodeIntegration:false`; all privileged actions cross via `preload.js`'s
  `contextBridge`. The raw Apify token is never sent to the renderer — only a
  `hasToken` boolean.

## n8n workflow (original / reference)

The sections below document `google-maps-lead-gen.n8n.json`. The Python scraper
mirrors this flow, so it's the canonical reference for the field mapping and
dedup behavior.

### Working with the workflow

The workflow is edited two ways, and they must stay in sync:
- **In n8n's visual editor**, then re-exported to `google-maps-lead-gen.n8n.json`
  (Export → Download).
- **Directly in the JSON** here. When editing JSON by hand, keep it valid n8n
  import format: every node needs a unique `id`, `name`, `type`, `typeVersion`,
  and `position`; wiring lives in the top-level `connections` map keyed by node
  **name** (not id). A node referenced in `connections` but missing from `nodes`
  (or a name mismatch) makes the import fail silently or drop edges.

## Architecture (data flow)

```
Form Trigger → Normalize Inputs → Apify Google Places Scraper
   → Map Fields → Remove Duplicates
        ├→ Append to Google Sheet
        ├→ CSV (disabled alt)
        └→ Aggregate All Leads → Build Summary
```

Key facts that require reading multiple nodes to understand:

- **Fan-out is at `Remove Duplicates`**, not the end. Its single output feeds
  three branches in parallel (Sheet, CSV, Aggregate). Adding a new output
  destination means adding a branch here, not chaining after Build Summary.
- **`Map Fields` is the schema boundary.** It flattens Apify's raw response into
  the 15 canonical columns (`name, category, full_address, city, state,
  postal_code, phone, website, email, rating, reviews_count, opening_hours,
  latitude, longitude, google_maps_url`). Every mapping is guarded with
  `|| default` so a missing field never errors a row. The Google Sheet header
  row and the CSV columns both depend on these exact names — rename a field here
  and you must update the sheet header too (append uses `autoMapInputData`).
- **`Build Summary` counts via `$json.data`** because `Aggregate All Leads` rolls
  all items into one item under `data`. `total_found` is `data.length`. It also
  reaches back to `$('Normalize Inputs')` for the category/location echo.
- **Error resilience is deliberate:** the Apify node uses `neverError: true` +
  `onError: continueRegularOutput`; Map Fields and the Sheet node also use
  `continueRegularOutput`. One bad record or failed write won't abort the run.
  Preserve these when editing those nodes.

## Two disabled alternatives (don't delete without reason)

- **`ALT: Google Places API (searchText)`** — first-party Google Places API
  instead of Apify. No emails, 20 results/page (needs `nextPageToken`
  pagination), billed per request. Response is under `places[]` (not flat).
- **`CSV (alternative to Sheets)`** / **`Split Out (safety)`** — enable CSV
  output instead of Sheets; enable Split Out only if an n8n version wraps the
  dataset array under a `data` field.

## Credentials & secrets

Never hardcode tokens. All auth goes through n8n credentials referenced by id:
- Apify: Header Auth credential `Apify API (Header Auth)` (`Authorization: Bearer <token>`).
- Google Sheets: `googleSheetsOAuth2Api` credential.

Placeholders like `REPLACE_WITH_YOUR_CREDENTIAL_ID`,
`REPLACE_WITH_YOUR_GOOGLE_SHEET_ID`, and
`REPLACE_WITH_YOUR_GSHEETS_CREDENTIAL_ID` are intentional — the user fills them
in after import. Keep them as placeholders in this repo; do not commit real ids.
