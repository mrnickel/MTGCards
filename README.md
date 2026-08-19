# MTG Card Scanner

A tiny, server-less web app that scans physical Magic: The Gathering cards with your camera and stores them in a collection kept entirely in your browser (IndexedDB).

## Run it

Camera access requires a secure context (HTTPS or `localhost`), so serve the folder rather than opening the file directly:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

On a phone, deploy the three files to any static host (GitHub Pages, Netlify, Cloudflare Pages…) and open over HTTPS.

## How it works

1. **Start Camera** → fit the card in the dashed outline so its **name** (top strip) and **bottom-left footer** (set code + collector number, bottom strip) are in the highlighted boxes.
2. Both strips are continuously captured and OCR'd in-browser with [Tesseract.js](https://github.com/naptha/tesseract.js). The footer's set code + collector number pin the **exact printing** via the [Scryfall API](https://scryfall.com/docs/api) (`/cards/{set}/{number}`), cross-checked against the OCR'd name. If the footer can't be read, it falls back to a name-only match and flags the set as unconfirmed (no auto-add).
3. When the same card is read twice in a row it is recognized and (with **Auto-add** on) added automatically (stored in IndexedDB; quantities tracked per printing).
4. **Collection** tab: filter, adjust quantities, remove, export/import JSON.
5. **Transfer between devices**: Collection → **Share QR** encodes the whole collection (set/collector-number/qty, deflate-compressed) into one or more QR codes. On the other device tap **Scan QR** and point its camera at each code — cards are rehydrated from Scryfall and merged into that device's collection.

If OCR misses, you can type the name instead.

## Notes

- Nothing is uploaded anywhere except the OCR'd *name text* sent to Scryfall for lookup. The camera image never leaves the device.
- Tesseract.js and its English language data are loaded from a CDN the first time you scan (~few MB, then cached).
- Data lives in this browser only. Use **Export JSON** to back up.
