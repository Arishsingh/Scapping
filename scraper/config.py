"""Resolve the Apify API token without ever hardcoding it.

Order of precedence:
1. APIFY_TOKEN environment variable.
2. `apifyToken` in config.json at the repo root (written by the app's Settings).
"""

import json
import os

# repo root = parent of the scraper/ directory
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CONFIG_PATH = os.path.join(_ROOT, "config.json")


def get_apify_token():
    token = os.environ.get("APIFY_TOKEN", "").strip()
    if token:
        return token
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return (data.get("apifyToken") or "").strip()
    except (FileNotFoundError, ValueError, OSError):
        return ""
