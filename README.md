# Shopping List

A family shopping list (Hebrew interface) that learns from your digital supermarket receipts:

- **Usual price next to every item.** Upload a receipt and the app remembers what you paid. Add "milk" to the list and the price you usually pay shows up next to it, styled like a shelf tag.
- **Grouped by store section** (produce, dairy, bakery, cleaning…), in the order you walk through the store. Sections are guessed from product names with a keyword list (`js/categories.js`) and can be changed per product.
- **Estimated total** for the list, and a place to record what you actually paid when you finish shopping.
- **Shelf price check.** Tap an item, type the price on the shelf, and see whether it's cheaper, normal or more expensive than usual.
- **"Probably running out" suggestions,** based on how often you buy each product.
- **More lists when you need them** (pharmacy, hardware store…): simple lists with a done section, alongside the main shopping list. No prices or sections on those.
- **One list for the whole family,** synced in real time, including offline use inside the store.

No AI and no running costs. All the calculations happen in the browser, and sharing runs on Firebase's free plan.

## How it works

1. Open the receipt link from the SMS and save the PDF.
2. On the **קבלות** (Receipts) screen, upload the file, or paste the receipt's text.
3. The first time a product appears, give it a name (for example "חלב"). Products are recognized by barcode, so after that it's automatic.
4. On the **רשימה** (List) screen, add items and see prices, the estimated total and suggestions.
5. On the **משפחה** (Family) screen, create a shared list and send the invite link.

Two kinds of receipts are supported:

- **Yohananof (Weezmo format):** the PDF contains text, which is read directly. Other chains using the same format should work too.
- **Shufersal:** the PDF is a picture of the receipt, so it's read with OCR ([Tesseract.js](https://github.com/naptha/tesseract.js), free and open source) inside the browser. Nothing is sent to any server. The first time, the browser downloads the OCR engine and the Hebrew language file (a few MB). Screenshots of a receipt work the same way.

- **Photos of paper receipts:** tap the camera button, or pick several photos of one long receipt. Each photo is cleaned in the browser (`js/paper.js`): cropped to the paper, colored print showing through from the back removed, shadows evened out. Then it's read with OCR. Photos are put in shooting order, and lines that appear in two overlapping photos are counted once. Another photo can be added to the same receipt from the review screen.

For picture receipts the code, description and amount columns are read separately, with digits-only settings for the number columns, which makes barcodes and prices much more reliable. On photos, the columns are found from where the prices sit, the barcode is the rightmost number on each line, and an Israeli barcode that lost its leading 7 is repaired using its check digit.

Before saving, every receipt can be reviewed: fix a name or price, remove a line, add a missing one, and compare the lines' sum with the receipt's total. On photos of dot-matrix receipts the Hebrew names often come out garbled. That's expected: the barcode and price are what matter, and each product is named once.

### Product names

Names come from three places, in this order:

1. **Products you already named:** a barcode you've seen before always gets your name.
2. **The barcode list** (`data/barcodes.json`, about 33,000 products): built weekly by a GitHub Action (`.github/workflows/barcodes.yml`, `scripts/build_barcodes.py`) from the price files Israeli chains must publish by law. It currently reads Shufersal, Yohananof and Rami Levy. Barcodes are national, so the names work for receipts from any chain. `data/meta.json` shows when it last ran and from which branches. The Action can also be run by hand from the repository's **Actions** tab.
3. **OCR fixes** (photos only, `js/names.js`): products without a national barcode (produce, in-store codes) are matched word by word against a Hebrew product vocabulary, with low cost for letters OCR confuses on receipts (ה/ח, ם/ס, נ/ג, ר/ד…), unreadable characters treated as unknown letters, and split words rejoined.

### How prices and suggestions are calculated

- **Usual price:** the median shelf price over the last year, so a one-off sale doesn't skew it.
- **Estimated total:** for each item, the median amount spent on it per shopping trip (three cottage cheeses count as three).
- **Suggestions:** the median number of days between purchases of a product. An item is suggested when it's due within two days, and dropped if it's more than three intervals overdue.
- **Matching list items to products:** what you type is kept exactly. An item shows a price when its name matches a product from your receipts; the suggestions under the box while typing help pick the exact name.

## Firebase setup (one time)

The Firebase project `more-the-merrier` is already configured in `js/cloud.js`. Two settings are needed in the Firebase console:

1. **Anonymous sign-in:** Build → Authentication → Sign-in method → Add new provider → **Anonymous** → Enable → Save.
   Nobody in the family needs an account or a password. People join with the invite link.
2. **Security rules:** Build → Firestore Database → **Rules** tab. Replace the contents with the file `firestore.rules` and click **Publish**.
   The rules make sure only members of a household can read or change its data.

Collections appear in Firestore only after the first shared list is created.

## Sharing with family

1. On the **משפחה** screen, tap "יצירת רשימה משותפת" (create shared list). Everything already saved on the phone is uploaded.
2. Send the invite link to your family (on WhatsApp, for example).
3. Whoever opens the link taps "הצטרפות" (join), and from then on everyone is in sync. Anything they already had on their phone is added to the shared list. Products with the same name become one.

**Keep the invite link.** It's also how you get back to the list from a new phone, or after browser data is cleared.

### Data model

```
households/{householdId}            { members: [uid], createdAt }
households/{householdId}/list       shopping-list items
households/{householdId}/receipts   receipt details and their purchase lines
households/{householdId}/trips      finished shopping trips (estimate vs. actual)
households/{householdId}/lists      extra simple lists (their items are in list/, tagged with listId)
households/{householdId}/meta/catalog   { products, codeMap, dismissed }
```

The household ID is a random 20-character code. Knowing it (from the invite link) is what allows someone to join, and joining can only add yourself to the members list.

## Deploying to GitHub Pages

The site is served from the `main` branch: **Settings → Pages → Deploy from a branch → `main` / `(root)`**.

It's available at **https://mor-the-merrier.github.io/shopping-list/**.

On a phone, open the address and add it to the home screen:

- **iPhone (Safari):** Share button → "Add to Home Screen".
- **Android (Chrome):** ⋮ menu → "Add to Home screen" or "Install app".

This matters on iPhone in particular: Safari clears data for sites that haven't been opened in 7 days, but not for sites added to the home screen.

## Running locally

Service workers don't run from a local file, so use a small server:

```bash
npx serve .
# or
python3 -m http.server 8000
```

## Tests

```bash
node test/parser.test.js   # receipt parsing
node test/store.test.js    # prices, frequency, suggestions, totals
node test/cloud.test.js    # sync between two "phones" on a simulated Firebase
node test/shufersal.test.js  # Shufersal layout from made-up OCR words
node test/paper.test.js      # photo cleaning, columns, barcodes, several photos
node test/names.test.js      # names: barcode list, your products, OCR fixes
```

`test/sample-yohananof.txt` is a made-up receipt in the Weezmo format. Its products, barcodes and prices are fictional.

## Files

| File | Contents |
|---|---|
| `index.html` | Page skeleton |
| `css/style.css` | Styles, including dark mode |
| `js/parser.js` | Turns receipt text into product, price and quantity lines |
| `js/pdf.js` | Extracts text from a PDF receipt with pdf.js |
| `js/ocr.js` | Reads picture receipts (Shufersal, screenshots) with Tesseract.js |
| `js/shufersal.js` | Turns OCR results (Shufersal, photos) into receipt lines |
| `js/names.js` | Product names: your products, the barcode list, OCR-aware word fixes |
| `scripts/build_barcodes.py` | Builds `data/barcodes.json` from the chains' public price files (run by the weekly Action) |
| `js/paper.js` | Photos of paper receipts: cleaning, finding the columns, merging several photos |
| `js/categories.js` | Store sections and the keyword list used to guess them |
| `js/store.js` | Local data, usual price (median), purchase frequency, estimated total |
| `js/cloud.js` | Family sharing: Firebase sync, invites and joining |
| `js/app.js` | Screens and interaction |
| `firestore.rules` | Database security rules |
| `sw.js` | Lets the app open without an internet connection |
| `test/` | Tests and a sample receipt |

## Good to know

- The Firebase settings in `js/cloud.js` identify the project and aren't a secret. The security rules are what protect the data.
- Firebase's free plan doesn't require a credit card. If a quota is reached, requests are refused rather than billed.
- After changing the code, bump `VERSION` in `sw.js` and the matching `?v=` numbers in `index.html`, so phones load the new files.
