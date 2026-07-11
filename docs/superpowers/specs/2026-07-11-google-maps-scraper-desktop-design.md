# Google Maps Lead Scraper (Python) + Electron Viewer — Design

**Date:** 2026-07-11
**Status:** Approved, implementing

## Problem

n8n won't install locally due to dependency issues. Rather than fight that,
reimplement the existing `google-maps-lead-gen.n8n.json` flow as a standalone
Python scraper, and add an Electron desktop app to run it and watch scraping
progress live.

The Python scraper must **follow the n8n JSON flow** — same source (Apify actor
`compass/crawler-google-places`), same field mapping, same dedup rule, same
default of 100 results.

## Whiteboard requirements

- **Location-first:** "just add location and it will tell all brands in that area."
  Category is optional; location is required.
- **Click a brand → contact details:** clicking a result opens a detail view with
  the brand's full contact info.
- **Filter**, headlined by **"give brands which don't have a website"** — the core
  lead-gen filter.

## Architecture

Two decoupled halves in one repo. Electron spawns the Python scraper as a child
process and reads **newline-delimited JSON (NDJSON)** events from its stdout — no
server, no ports. The scraper is also fully runnable standalone from the CLI.

```
Scapping/
  scraper/
    scraper.py         # CLI entry: parse args, orchestrate, emit NDJSON, write CSV
    sources/
      __init__.py
      apify.py         # primary: calls compass/crawler-google-places (run-sync-get-dataset-items)
      browser.py       # fallback: Playwright drives real Google Maps
    mapping.py         # raw record -> the 15 canonical columns (shared by both sources)
    events.py          # NDJSON emit helpers + incremental CSV writer
    config.py          # resolve Apify token (env var or config.json)
    requirements.txt
  desktop/
    package.json
    main.js            # spawns python, relays stdout events to renderer over IPC
    preload.js         # contextBridge (safe IPC surface)
    renderer/{index.html, renderer.js, styles.css}
  output/              # timestamped CSVs (gitignored)
  config.json          # local, gitignored: { "apifyToken": "..." }
```

## The 15 canonical columns (must match n8n `Map Fields` exactly)

`name, category, full_address, city, state, postal_code, phone, website, email,
rating, reviews_count, opening_hours, latitude, longitude, google_maps_url`

Mapping from the Apify record (mirrors the n8n expressions, every field guarded so
a missing value never breaks a row):

| Column | Apify source |
|---|---|
| name | `title` |
| category | `categoryName` or `categories.join(', ')` |
| full_address | `address` |
| city | `city` |
| state | `state` |
| postal_code | `postalCode` |
| phone | `phone` or `phoneUnformatted` |
| website | `website` |
| email | `emails[0]` if present |
| rating | `totalScore` |
| reviews_count | `reviewsCount` (default 0) |
| opening_hours | `openingHours[].{day}: {hours}` joined by ` | ` |
| latitude | `location.lat` |
| longitude | `location.lng` |
| google_maps_url | `url` |

`mapping.py` is the single schema boundary; both Apify and browser records are
normalized through it.

## Scraper CLI contract

```
python scraper.py --location "Punjab, India" [--category "clothing"] \
                  [--max-results 100] [--json]
```

- `--location` required. `--category` optional: empty -> broad `businesses in {location}`
  search; filled -> `{category} in {location}`.
- `--max-results` defaults to **100** (matches n8n).
- `--json` switches stdout to NDJSON event mode (used by Electron). Without it, the
  script prints a human-readable progress log.

### NDJSON events (one JSON object per line, flushed)

- `{"type":"status","source":"apify|browser","state":"starting|scraping|fallback|done|error","message":"..."}`
- `{"type":"progress","found":N}`
- `{"type":"lead","data":{...15 columns...}}` — one per business, as found
- `{"type":"done","total":N,"csv_path":"output/leads_....csv"}`
- `{"type":"error","message":"..."}`

## Source selection & fallback

1. Resolve Apify token: `APIFY_TOKEN` env var, else `config.json` `apifyToken`.
2. If a token exists, try **Apify** (`run-sync-get-dataset-items`, body
   `{ searchStringsArray, maxCrawledPlacesPerSearch, language:'en', scrapeContacts:true }`,
   `Authorization: Bearer <token>`, 300s timeout — same as n8n).
3. If no token, Apify errors, or Apify returns zero results -> emit
   `status: fallback` and run the **Playwright** browser scraper against Google
   Maps. Website is always captured when present; email is best-effort (only if
   trivially found), since the browser path has no `scrapeContacts`.

## CSV writing & resilience

`scraper.py` writes each mapped, **de-duplicated** (by `name + full_address`,
matching n8n `Remove Duplicates`) row to a timestamped CSV incrementally as it is
found — so a cancelled (SIGTERM) or crashed run still leaves a valid partial CSV.
Filename: `output/leads_YYYY-MM-DD_{category-or-all}-{location}.csv`. On `done`,
emit the final path.

## Electron app behavior

- **Form + Start/Stop:** location (required), category (optional), max_results.
  Start spawns the scraper with `--json`. Stop sends SIGTERM; Python flushes CSV
  and exits cleanly.
- **Live progress + status:** found count, active source (Apify/browser), elapsed
  time, status line reflecting `starting -> scraping -> (fallback) -> done/error`.
- **Live results table:** each `lead` event appends a row (name, phone, website,
  email, rating shown).
- **Detail view:** clicking a row opens a panel with all 15 fields + a link to the
  Google Maps URL.
- **Filter bar (client-side, instant, no re-scrape):**
  - "No website only" toggle (`website` empty) — the headline filter.
  - "Has email only" toggle.
  - Text search (name / category / city).
  - "Export current view -> CSV" — writes only the filtered rows to a new CSV.
- **Past runs list:** lists CSVs in `output/`; open file / reveal folder.
- **Settings:** paste & save Apify token -> `config.json` (read by the scraper).

## Scope boundaries (v1)

- **Dev-run, not a packaged installer.** Run via `npm start` in `desktop/` with a
  local Python 3 that has `requirements.txt` installed
  (`pip install -r requirements.txt`, `playwright install chromium`). Building a
  distributable `.dmg`/`.exe` is out of scope for v1.
- **CSV only** — no Google Sheets output, no SQLite. "Past runs" = reading the
  `output/` folder.

## Security

- Apify token never hardcoded: env var or gitignored `config.json`.
- `.gitignore` covers `output/`, `config.json`, `node_modules/`, Python caches.
- Electron renderer runs with `contextIsolation: true`, `nodeIntegration: false`;
  all privileged actions go through a minimal `preload.js` `contextBridge` surface.
