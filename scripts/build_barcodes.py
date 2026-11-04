"""
Build the barcode -> product name list the app uses to name products on
receipts (especially photos, where printed Hebrew is hard to read).

Source: the price files every Israeli supermarket chain must publish by law
(Price Transparency regulations). This script reads Shufersal's public
"PriceFull" files. Barcodes are national, so names apply to every chain.

Runs on GitHub's servers (.github/workflows/barcodes.yml). Standard library only.

Usage: python scripts/build_barcodes.py <output folder>
Writes:
  barcodes.json  {"729...": "name", ...}   national barcodes only (8+ digits)
  words.json     ["חלב", "גבינה", ...]       Hebrew words in product names, most common first
  meta.json      when, from where, how many, and any errors (always written)
"""
import gzip
import html
import io
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from datetime import datetime, timezone

LISTING = "https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=2&storeId=0&page={page}"
MAX_STORES = 6   # several branches: together they cover nearly the whole assortment
MAX_PAGES = 4
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; kniyot-barcodes/1.0; +https://github.com/mor-the-merrier/shopping-list)"}

errors = []


def get(url, tries=3, timeout=90):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # network hiccups: retry
            last = e
            time.sleep(3 * (attempt + 1))
    raise last


def price_file_links():
    """Links to PriceFull files, one per branch."""
    links = {}
    for page in range(1, MAX_PAGES + 1):
        try:
            page_html = get(LISTING.format(page=page)).decode("utf-8", "replace")
        except Exception as e:
            errors.append(f"listing page {page}: {e}")
            continue
        for href in re.findall(r'href="([^"]+)"', page_html):
            href = html.unescape(href)
            m = re.search(r"PriceFull\d+-(\d+)-\d+", href)
            if m and m.group(1) not in links:
                links[m.group(1)] = href
        if len(links) >= MAX_STORES:
            break
    return list(links.items())[:MAX_STORES]


def unpack(blob):
    """Price files are gzip, sometimes zip, sometimes plain XML."""
    if blob[:2] == b"\x1f\x8b":
        return gzip.decompress(blob)
    if blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            return z.read(z.namelist()[0])
    return blob


def items_of(xml_bytes):
    """(code, name, weighted) for every item, whatever the tag case."""
    root = ET.fromstring(xml_bytes)
    for el in root.iter():
        if el.tag.lower() not in ("item", "product"):
            continue
        fields = {c.tag.lower(): (c.text or "").strip() for c in el}
        code = fields.get("itemcode", "")
        name = fields.get("itemname", "") or fields.get("manufactureritemdescription", "")
        if code and name:
            yield code, name, fields.get("bisweighted", "0") == "1"


def clean_name(name):
    name = re.sub(r"\s+", " ", name.replace('""', '"')).strip(' "\'')
    return name


def main(out_dir):
    names = {}
    words = Counter()
    stores = []
    for store, url in price_file_links():
        try:
            xml_bytes = unpack(get(url))
            n = 0
            for code, name, weighted in items_of(xml_bytes):
                name = clean_name(name)
                for w in re.findall(r"[֐-׿][֐-׿\"'׳״]+", name):
                    words[w.strip("\"'")] += 1
                code = code.lstrip("0") if len(code) > 13 else code
                if len(code) >= 8 and code.isdigit() and not weighted:
                    names.setdefault(code, name)
                n += 1
            stores.append({"store": store, "items": n})
        except Exception as e:
            errors.append(f"store {store}: {e}")

    meta = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Shufersal public price files (Price Transparency regulations)",
        "stores": stores,
        "barcodes": len(names),
        "words": 0,
        "errors": errors,
    }
    import os

    os.makedirs(out_dir, exist_ok=True)
    if names:  # keep the previous list if this run got nothing
        with open(os.path.join(out_dir, "barcodes.json"), "w", encoding="utf-8") as f:
            json.dump(dict(sorted(names.items())), f, ensure_ascii=False, separators=(",", ":"))
        vocab = [w for w, c in words.most_common() if len(w) >= 2 and c >= 2][:25000]
        meta["words"] = len(vocab)
        with open(os.path.join(out_dir, "words.json"), "w", encoding="utf-8") as f:
            json.dump(vocab, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data")
