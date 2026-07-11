# Google Maps Lead Generator

Turn a **location** (and optional category) into a clean, de-duplicated list of
business leads scraped from Google Maps.

There are **two ways to run it**:

1. **Desktop app (Python + Electron)** — recommended. A standalone scraper with a
   desktop UI to pick a data source (Apify or live browser), watch progress in a
   live log, filter for "businesses with no website," inspect a brand's contact
   details, and export CSV. **No n8n required.**
2. **n8n workflow** — the original `google-maps-lead-gen.n8n.json`, documented
   further down.

Both use the same Apify actor (`compass/crawler-google-places`) and produce the
**same 15-column CSV** schema.

---

## Desktop app (Python scraper + Electron viewer)

```
scraper/   Python scraper — Apify primary + Playwright browser scraper
desktop/   Electron app — runs the scraper and shows progress live
output/    generated timestamped CSVs (gitignored)
config.json  local, gitignored — { apifyToken, pythonPath }
```

**How they connect:** the Electron app spawns `scraper/scraper.py` as a child
process and reads newline-delimited JSON (NDJSON) events from its stdout — no
server, no ports. The scraper is also fully usable on its own from the CLI.

### Setup

```bash
# 1. Python scraper deps (a venv at the repo root is auto-detected by the app)
python3 -m venv venv
source venv/bin/activate
pip install -r scraper/requirements.txt
playwright install chromium          # required for the Browser source

# 2. Electron app deps
cd desktop
npm install
```

The app auto-detects a virtualenv at `venv/`, `.venv/`, or `scraper/.venv/` and
runs its Python (where Playwright lives), so you don't have to activate the venv
before launching. Set an explicit interpreter in **Settings** only if you want to
override that.

### Run

```bash
cd desktop
npm start
```

### Using the app

- **Location** (required). **Category** is optional — leave it blank to list
  **all brands** in the area (`businesses in {location}`).
- **Max results** — 1–100,000 (hard-capped). Note the browser source opens one
  page per place (~2s each), so large numbers take a long time — and Google's feed
  only yields ~120 per search anyway (see Notes). High values mostly matter for
  Apify, where they also drive up usage/cost.
- **Source**:
  - **Auto** — try Apify first (if a token is set), fall back to the browser.
  - **Apify only** — first-party actor data; fast and rich, but tends to return
    established/branded stores (which usually *have* websites). Never falls back.
  - **Browser only** — scrapes live Google Maps, reaching smaller local shops.
    **Best for finding businesses with no website.** No Apify token/credits needed.
- **Start / Stop** — leads stream into the table live. Stop cancels within ~1
  scroll cycle; the partial CSV is still saved.
- **Filters** — "No website only" / "Has email only" toggles plus a text search
  (name / category / city / address). They filter the table live **and**, when set
  **before you press Start**, pre-filter the scrape itself so the saved run CSV
  contains only matching businesses. "Has email only" works best with Apify; the
  browser source rarely finds emails.
- **Click a row** → detail panel with the brand's full contact info + Maps link.
- **Export current view → CSV** — writes just the currently filtered rows.
- **Live logs** — a timestamped, color-coded stream of everything the scraper
  does (source, fallback, each lead, a summary like *"examined 29 places → kept 17
  (12 filtered out)"*, errors). Collapsible, with auto-scroll and clear.
- **Past runs** — every run is saved to its own timestamped file
  (`leads_YYYY-MM-DD_HH-MM-SS_{category}-{location}.csv`), so re-running the same
  search never overwrites a previous result. Open a file or the output folder.
- **Settings ⚙** — paste your Apify token (stored in gitignored `config.json`),
  or set an explicit Python interpreter (blank = auto-detect).

### Run the scraper without the app (CLI)

```bash
# from the repo root, with the venv active
python scraper/scraper.py --location "Punjab, India" --category clothing --max-results 50
python scraper/scraper.py --location "Ahmedabad" --source browser --only-no-website
python scraper/scraper.py --location "Punjab, India" --json     # NDJSON (what Electron reads)
```

Flags: `--location` (required), `--category`, `--max-results` (default 100, cap
100000), `--source auto|apify|browser`, `--only-no-website`, `--only-with-email`,
`--output-dir`, `--json`.

### Apify token

Set it either way:
- `export APIFY_TOKEN=...` in your shell, **or**
- via the app's **Settings** (writes `config.json` at the repo root).

In **Auto** mode, if no token is found — or Apify errors / returns nothing — the
scraper falls back to the Playwright browser scraper.

### Notes & limitations

- **Browser runtime:** it opens one page per place, so a large `max-results` run
  takes minutes. Watch the live logs; Stop anytime.
- **Google's ceiling:** the Maps results feed caps around ~120 results per search
  regardless of `max-results`. For deeper coverage of a big city, search by
  neighborhood (e.g. `clothing in Satellite, Ahmedabad`) and merge.
- **Emails:** only Apify (`scrapeContacts`) reliably returns emails; the browser
  source usually leaves the email column blank.

---

## n8n workflow (original)

An n8n workflow that turns a category + location into a clean list of business
leads scraped from Google Maps, de-duplicates them, writes them to a Google
Sheet (or CSV), and gives you a total-found summary.

**File:** `google-maps-lead-gen.n8n.json` — import this into n8n.

---

## What it does (flow)

```
Form Trigger → Normalize Inputs → Apify Google Places Scraper
   → Map Fields → Remove Duplicates
        → Append to Google Sheet
        → (alt) CSV file
        → Aggregate → Build Summary
```

- **Form Trigger** — asks for `category`, `location`, `max_results` (default 100).
- **Normalize Inputs** — applies the 100 default and carries fields forward.
- **Apify Google Places Scraper** — HTTP POST to the Apify actor
  `compass/crawler-google-places` via
  `run-sync-get-dataset-items`, authenticated by an n8n credential (token never
  hardcoded). Returns one item per business.
- **Map Fields** — flattens the raw response into clean columns:
  `name, category, full_address, city, state, postal_code, phone, website,
  email, rating, reviews_count, opening_hours, latitude, longitude,
  google_maps_url`. Every field is guarded so a missing value never breaks a row.
- **Remove Duplicates** — collapses duplicates by `name + full_address`.
- **Append to Google Sheet** — appends rows (auto-mapped by header name).
- **Aggregate → Build Summary** — counts total leads and builds a summary message.

**Error handling:** the Apify, Map Fields, and Sheet nodes use
*Continue On Error*, and the Apify node uses *Never Error*, so one bad record or a
single failed write won't abort the whole run.

---

## Setup

### 1. Import the workflow
n8n → **Workflows → Import from File** → pick `google-maps-lead-gen.n8n.json`.

### 2. Get an Apify API token
1. Create a free account at <https://apify.com>.
2. Go to **Settings → Integrations → API tokens** (or
   <https://console.apify.com/account/integrations>).
3. Copy your **Personal API token**.

### 3. Store the token as an n8n credential (do NOT hardcode)
1. In n8n: **Credentials → New → "Header Auth"**.
2. Name it `Apify API (Header Auth)`.
3. Set:
   - **Name:** `Authorization`
   - **Value:** `Bearer YOUR_APIFY_TOKEN`
4. Save, then open the **Apify - Google Places Scraper** node and select this
   credential under *Header Auth*.

> The actor is billed per usage on Apify (it has a free monthly tier). Big
> `max_results` = more compute = more cost. Start small (e.g. 20) to test.

### 4. Connect Google Sheets
1. Create a Google Sheet with a tab named **`Leads`**.
2. Add a header row (row 1) with exactly these column names:
   ```
   name  category  full_address  city  state  postal_code  phone  website  email  rating  reviews_count  opening_hours  latitude  longitude  google_maps_url
   ```
3. In n8n: **Credentials → New → "Google Sheets OAuth2 API"**, follow the OAuth
   consent flow (or use a Service Account and share the sheet with its email).
   Google's guide: <https://docs.n8n.io/integrations/builtin/credentials/google/>.
4. Open the **Append to Google Sheet** node:
   - Pick your Google Sheets credential.
   - Set **Document** to your sheet (paste the sheet ID from its URL:
     `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`).
   - Set **Sheet** to `Leads`.

### 5. (Optional) Get the summary delivered to you
The **Build Summary** node outputs `total_found` and a `summary` string. Add a
**Gmail**, **Send Email**, or **Slack** node after it and reference
`{{ $json.summary }}` to receive the total.

### 6. Run it
Activate the workflow, open the Form Trigger's production/test URL, submit
category + location, and watch rows land in your sheet.

---

## Prefer CSV instead of Sheets?
Enable the **CSV (alternative to Sheets)** node (right-click → *Enable*) and
disable the Sheets node. It produces a downloadable `google-maps-leads.csv`;
wire it to an email node to have it sent.

---

## Alternative: Google's official Places API (no Apify)

The disabled node **ALT: Google Places API (searchText)** hits
`https://places.googleapis.com/v1/places:searchText`. Use it if you want
first-party Google data instead of a third-party scraper.

**Trade-offs vs. Apify:**

| | Apify actor | Places API (searchText) |
|---|---|---|
| Emails | Yes (`scrapeContacts`) | No |
| Results per call | Up to your `max_results` | 20 max (needs `nextPageToken` pagination) |
| Cost | Apify usage credits | Billed per request by Google |
| Data source | Scraped | Official Google |

**To use it:**
1. Enable the Google Maps **Places API (New)** in Google Cloud Console and create
   an API key: <https://console.cloud.google.com/google/maps-apis>.
2. Store the key in an n8n Header Auth credential
   (`X-Goog-Api-Key: YOUR_KEY`) and attach it to that node (replace the inline
   `X-Goog-Api-Key` header).
3. Add a **Split Out** on `places`, then a Map Fields node using
   `displayName.text`, `formattedAddress`, `location.latitude/longitude`,
   `googleMapsUri`, `rating`, `userRatingCount`, `regularOpeningHours`, etc.
4. Rewire it into the same **Map Fields → Remove Duplicates → output** chain.
