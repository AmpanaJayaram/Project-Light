# LightLibrary

Find North Carolina public libraries by ZIP code, current location, city or name, filter by service, and ask a chatbot about them.

## Run it

```bash
npm install
npm start            # http://127.0.0.1:3000
```

To turn on the AI chatbot, put your key in `.env` (`ANTHROPIC_API_KEY=sk-ant-...`) and restart `npm start`. Without a key the chatbot uses rule-based answers over the same data.

```bash
npm test             # data + search + chat tests
```

## Data

`data/library-data.json` is generated. Don't edit it by hand. Rebuild it after updating the workbook:

```bash
.venv/Scripts/python.exe -m pip install openpyxl   # once
.venv/Scripts/python.exe scripts/build_library_data.py
```

| Field | Source |
|---|---|
| Branch name, system, system URL, type, county, address, city, ZIP | `NC_Library System_Branches_Manual Check _9_20_2026(1).xlsx` |
| Latitude/longitude, phone, weekly hours | IMLS Public Libraries Survey records embedded in `nc-library-finder-standalone.html`, matched by ZIP + address, then ZIP + name |
| Services (computers, Wi-Fi, databases, kids/teen/adult programs) | IMLS system-level counts |

Branches with no IMLS match are placed at their ZIP centroid and marked `locationPrecision: "zip"` (shown as "approx. location"). Wi-Fi that a system did not report is listed in `unverifiedResources` and shown as "not reported". Bookmobiles without a fixed address are skipped.

`data/content.json` holds featured branches, digital resources, FAQs and workshops. **The workshops are sample listings** until a real events feed is connected.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Status, library count, whether AI is on |
| `GET /api/meta` | Counts and resource labels |
| `GET /api/libraries?zip=27601&resource=wifi&limit=10` | Nearby search. Also `lat`/`lng`, `q` (name/city/county/system text), `mobile=1` |
| `GET /api/libraries/:id` | One branch (`light-out-0053` or `LIGHT-OUT-0053`) |
| `GET /api/map-points` | `[id, lat, lng, name]` for every branch (search page background pins) |
| `GET /api/map-libraries` | Every branch with details, for the statewide map |
| `GET /api/content` | Featured branches, workshops, digital resources, FAQs |
| `POST /api/chat` | `{ message, history?, location? }` → `{ reply, mode: "ai" \| "rules", libraries }` (top 3 matches for cards) |

## Layout

- `server.js`: HTTP server (no framework) serving the pages and the API
- `server/libraries.js`: data loading and search
- `server/chat.js`: chatbot (Claude via `@anthropic-ai/sdk`, rule-based fallback)
- `index.html`, `search.html`, `map.html`, `faq.html`, `chatbot.html`, `app.js`, `styles.css`: front end (Leaflet + OpenStreetMap)
- `data/nc-counties.geojson`: county outlines for the statewide map (written by the build script)
- `scripts/build_library_data.py`: workbook → JSON

If the API isn't reachable, the front end falls back to reading `data/*.json` directly, so search still works on static hosting (the chatbot is limited to basic answers there).

## Deploy

Any Node 20+ host works (Render, Railway, Fly.io, Azure App Service). Set `HOST=0.0.0.0`, `PORT` (often set by the host), and optionally `ANTHROPIC_API_KEY`. The start command is `npm start`. See `.env.example`.
