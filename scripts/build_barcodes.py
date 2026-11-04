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
from collections import Counter, defaultdict
from datetime import datetime, timezone

LISTING = "https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=2&storeId=0&page={page}"
MAX_STORES = 10  # several branches: together they cover nearly the whole assortment
MAX_PAGES = 25
# Chains publishing through url.publishedprices.co.il (public username, no password)
CERBERUS = [("yohananof", "יוחננוף"), ("RamiLevi", "רמי לוי")]
CERBERUS_BASE = "https://url.publishedprices.co.il"
CERBERUS_FILES = 5  # PriceFull files (branches) per chain
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


def cerberus_files(user):
    """Log in with the chain's public user and download a few PriceFull files."""
    import http.cookiejar
    import urllib.parse

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def open_(url, data=None):
        req = urllib.request.Request(url, data=data, headers=HEADERS)
        with opener.open(req, timeout=90) as r:
            return r.read()

    def token_of(page):
        m = re.search(r'name="csrftoken"\s+content="([^"]+)"', page) or re.search(r'csrftoken[^>]*value="([^"]+)"', page)
        return m.group(1) if m else ""

    token = token_of(open_(CERBERUS_BASE + "/login").decode("utf-8", "replace"))
    form = urllib.parse.urlencode({"r": "", "username": user, "password": "", "Submit": "Sign in", "csrftoken": token}).encode()
    token = token_of(open_(CERBERUS_BASE + "/login/user", form).decode("utf-8", "replace")) or token
    listing = open_(
        CERBERUS_BASE + "/file/json/dir",
        urllib.parse.urlencode({"sSearch": "PriceFull", "iDisplayLength": 100000, "cd": "/", "csrftoken": token}).encode(),
    )
    # Names: PriceFull<chain>-<store>-<yyyymmddhhmm> or PriceFull<chain>-<sub>-<store>-<yyyymmdd>-<hhmmss>
    dated = []
    for row in json.loads(listing).get("aaData", []):
        f = row.get("fname", "")
        m = re.match(r"PriceFull\d+-(?:\d{3}-)?(\d{3,4})-(\d{8})", f)
        if m:
            dated.append((m.group(2), m.group(1), f))
    dated.sort(reverse=True)  # newest first
    newest = dated[0][0] if dated else ""
    seen, picked = set(), []
    for date, branch, f in dated:
        if newest and date < str(int(newest) - 100):  # skip files over ~a month older than the newest
            continue
        if branch not in seen:
            seen.add(branch)
            picked.append(f)
        if len(picked) >= CERBERUS_FILES:
            break
    for f in picked:
        yield f, open_(CERBERUS_BASE + "/file/d/" + urllib.parse.quote(f))


def unpack(blob):
    """Price files are gzip, sometimes zip, sometimes plain XML."""
    if blob[:2] == b"\x1f\x8b":
        return gzip.decompress(blob)
    if blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            return z.read(z.namelist()[0])
    return blob


def items_of(xml_bytes):
    """(code, name, weighted, price) for every item, whatever the tag case."""
    root = ET.fromstring(xml_bytes)
    for el in root.iter():
        if el.tag.lower() not in ("item", "product"):
            continue
        fields = {c.tag.lower(): (c.text or "").strip() for c in el}
        code = fields.get("itemcode", "")
        name = fields.get("itemname", "") or fields.get("manufactureritemdescription", "")
        try:
            price = round(float(fields.get("itemprice", "") or 0), 2)
        except ValueError:
            price = 0
        if code and name:
            yield code, name, fields.get("bisweighted", "0") == "1", price


def clean_name(name):
    name = re.sub(r"\s+", " ", name.replace('""', '"')).strip(' "\'')
    return name


def add_file(xml_bytes, names, words, prices):
    n = 0
    for code, name, weighted, price in items_of(xml_bytes):
        name = clean_name(name)
        for w in re.findall(r"[֐-׿][֐-׿\"'׳״]+", name):
            words[w.strip("\"'")] += 1
        code = code.lstrip("0") if len(code) > 13 else code
        # National barcodes only. Codes starting with 2 are in-store scale labels.
        if len(code) >= 8 and code.isdigit() and not (weighted and code.startswith("2")):
            names.setdefault(code, name)
            # shelf prices, to check prices read from a photo of a receipt
            if not weighted and 0 < price < 5000:
                prices[code][price] += 1
        n += 1
    return n


def main(out_dir):
    names = {}
    words = Counter()
    prices = defaultdict(Counter)
    stores = []
    for store, url in price_file_links():
        try:
            stores.append({"chain": "שופרסל", "store": store, "items": add_file(unpack(get(url)), names, words, prices)})
        except Exception as e:
            errors.append(f"shufersal store {store}: {e}")
    for user, chain in CERBERUS:
        try:
            for fname, blob in cerberus_files(user):
                stores.append({"chain": chain, "file": fname, "items": add_file(unpack(blob), names, words, prices)})
        except Exception as e:
            errors.append(f"{chain}: {type(e).__name__}: {e}")

    meta = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Supermarket chains' public price files (Price Transparency regulations)",
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
        # up to 4 prices per barcode, most common first (they differ by chain and branch)
        price_list = {c: [p for p, _ in cnt.most_common(4)] for c, cnt in sorted(prices.items()) if c in names}
        meta["prices"] = len(price_list)
        with open(os.path.join(out_dir, "prices.json"), "w", encoding="utf-8") as f:
            json.dump(price_list, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data")
