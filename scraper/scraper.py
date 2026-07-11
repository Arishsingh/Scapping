#!/usr/bin/env python3
"""Google Maps lead scraper — standalone reimplementation of the n8n flow.

Primary source is the Apify actor compass/crawler-google-places (same as n8n);
the Playwright browser scraper is an automatic fallback when Apify is
unavailable. Leads are mapped to the 15 canonical columns, de-duplicated by
name+full_address, and written to a timestamped CSV incrementally.

Usage:
    python scraper.py --location "Punjab, India" [--category clothing] \
                      [--max-results 100] [--json] [--output-dir output]

With --json, stdout is newline-delimited JSON events consumed by the Electron
app. Without it, stdout is a human-readable log.
"""

import argparse
import os
import signal
import sys

from config import get_apify_token
from events import CsvWriter, Emitter
from mapping import dedupe_key, map_record
from sources import apify

# Upper bound on requested results — Apify plans bill per usage, so cap it.
MAX_RESULTS = 100000

# Set when SIGTERM/SIGINT arrives so the scrape loop can stop and flush cleanly.
_STOP = {"flag": False}


def _handle_stop(signum, frame):
    _STOP["flag"] = True


def _slug(text, fallback):
    text = (text or "").strip().lower()
    if not text:
        return fallback
    out = "".join(c if c.isalnum() else "-" for c in text)
    return "-".join(part for part in out.split("-") if part) or fallback


def _build_search_string(category, location):
    """Empty category -> broad 'businesses in {location}'; else '{category} in {location}'."""
    category = (category or "").strip()
    if category:
        return f"{category} in {location}"
    return f"businesses in {location}"


def _csv_path(output_dir, category, location, stamp):
    cat = _slug(category, "all")
    loc = _slug(location, "location")
    base = os.path.join(output_dir, f"leads_{stamp}_{cat}-{loc}")
    # Guard against overwriting if two runs land in the same second.
    path = base + ".csv"
    n = 2
    while os.path.exists(path):
        path = f"{base}_{n}.csv"
        n += 1
    return path


def _now_stamp():
    # Date + time so repeated runs for the same location/category each get their
    # own file instead of overwriting. datetime kept local for easy testing.
    from datetime import datetime

    return datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def run(args, emitter):
    search_string = _build_search_string(args.category, args.location)
    os.makedirs(args.output_dir, exist_ok=True)
    csv_path = _csv_path(args.output_dir, args.category, args.location, _now_stamp())

    writer = CsvWriter(csv_path)
    seen = set()
    total = 0
    counts = {"examined": 0, "filtered": 0, "dupes": 0}

    def handle_raw(raw):
        """Map, filter, dedupe, emit, and persist one raw record. Returns True if kept."""
        nonlocal total
        counts["examined"] += 1
        lead = map_record(raw)
        # Scrape-level filters: drop non-matching records before they are counted,
        # saved, or streamed, so the run CSV itself is pre-filtered.
        if args.only_no_website and (lead.get("website") or "").strip():
            counts["filtered"] += 1
            return False
        if args.only_with_email and not (lead.get("email") or "").strip():
            counts["filtered"] += 1
            return False
        key = dedupe_key(lead)
        if key in seen:
            counts["dupes"] += 1
            return False
        seen.add(key)
        writer.write(lead)
        emitter.lead(lead)
        total += 1
        emitter.progress(total)
        return True

    try:
        active_filters = []
        if args.only_no_website:
            active_filters.append("no-website only")
        if args.only_with_email:
            active_filters.append("has-email only")
        if active_filters:
            emitter.status("-", "starting", "scrape filter: " + ", ".join(active_filters))

        token = get_apify_token()
        used_apify = False
        mode = args.source  # auto | apify | browser

        # --- Apify attempt (auto or apify modes) ------------------------------
        if mode in ("auto", "apify") and not _STOP["flag"]:
            if token:
                emitter.status("apify", "starting", f'querying Apify actor for "{search_string}" — this can take 30–90s…')
                try:
                    records = apify.fetch(search_string, args.max_results, token)
                    used_apify = True
                    emitter.status("apify", "scraping", f"received {len(records)} raw records")
                    for raw in records:
                        if _STOP["flag"]:
                            break
                        handle_raw(raw)
                except apify.ApifyError as e:
                    if mode == "apify":
                        emitter.error(f"Apify failed: {e}")
                    else:
                        emitter.status("apify", "fallback", f"Apify failed ({e}); switching to browser")
            elif mode == "apify":
                emitter.error("Apify mode selected but no token is set — add one in Settings, or switch to Browser mode.")
            else:
                emitter.status("apify", "fallback", "no Apify token; using browser scraper")

        # --- Browser attempt --------------------------------------------------
        # Run the browser when explicitly chosen, or as an auto-fallback (no
        # Apify used, or Apify returned nothing). Never in 'apify' mode.
        want_browser = mode == "browser" or (mode == "auto" and (not used_apify or total == 0))
        if not _STOP["flag"] and want_browser:
            emitter.status("browser", "starting", f'browser scrape "{search_string}"')
            try:
                from sources import browser

                def on_status(state, message):
                    emitter.status("browser", state, message)

                for raw in browser.scrape(
                    search_string, args.max_results, on_status, should_stop=lambda: _STOP["flag"]
                ):
                    if _STOP["flag"] or total >= args.max_results:
                        break
                    handle_raw(raw)
            except ImportError:
                emitter.error("Playwright not installed — run: pip install -r requirements.txt && playwright install chromium")
            except Exception as e:  # noqa: BLE001 - surface any browser failure as an event
                emitter.error(f"browser scrape failed: {e}")

        # Explain any gap between places examined and leads kept.
        if counts["examined"] > total:
            parts = []
            if counts["filtered"]:
                parts.append(f"{counts['filtered']} filtered out")
            if counts["dupes"]:
                parts.append(f"{counts['dupes']} duplicate{'s' if counts['dupes'] != 1 else ''}")
            if parts:
                emitter.status("-", "scraping",
                               f"examined {counts['examined']} places → kept {total} ({', '.join(parts)})")

        emitter.done(total, csv_path)
    finally:
        writer.close()

    return total


def main(argv=None):
    parser = argparse.ArgumentParser(description="Google Maps lead scraper")
    parser.add_argument("--location", required=True, help="Area to search, e.g. 'Punjab, India'")
    parser.add_argument("--category", default="", help="Optional category, e.g. 'clothing'. Empty = all brands.")
    parser.add_argument("--max-results", type=int, default=100, help="Max leads (default 100, matches n8n; capped at 100000)")
    parser.add_argument("--source", choices=["auto", "apify", "browser"], default="auto",
                        help="Where to scrape from: auto (Apify then browser fallback), apify only, or browser only")
    parser.add_argument("--only-no-website", action="store_true",
                        help="Keep only businesses that have no website (targeted lead list)")
    parser.add_argument("--only-with-email", action="store_true",
                        help="Keep only businesses that have an email (best with Apify; browser rarely finds emails)")
    parser.add_argument("--output-dir", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "output"))
    parser.add_argument("--json", action="store_true", help="Emit NDJSON events on stdout (for the Electron app)")
    args = parser.parse_args(argv)

    # Hard cap: Apify plans bill per usage, so bound requested results to 100000.
    args.max_results = max(1, min(args.max_results, MAX_RESULTS))

    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)

    emitter = Emitter(args.json)
    try:
        run(args, emitter)
        return 0
    except Exception as e:  # noqa: BLE001 - report any unexpected failure as an event
        emitter.error(str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
