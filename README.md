# Google Maps Lead Generator (n8n + Apify)

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
# Scapping
