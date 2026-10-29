# Label Map: Power BI custom map visual

Leaflet point map for Power BI with Azure Maps style field wells, value labels on each point, a second text inside each bubble, Location geocoding, and US/Canada address handling. Built with `pbiviz` because Power BI's own maps can't print a value on each point.

- Repo: https://github.com/alijohnzy/pbi-label-map (public). Releases carry the `.pbiviz`; the user downloads it at work from Releases → Latest.
- Current version: **1.7.4** (released). Visual GUID `pbiLabelMap7379A3103AC7452ABE93F1A12B992918`; keep it so imports replace the old visual and reports keep their settings.
- The user (John) builds at home on this Mac. Work IT blocks LLMs and Node, so the work PC only imports the finished `.pbiviz`.

## Build, preview, release

```bash
npm install         # brings pbiviz (powerbi-visuals-tools 7.2.1) and Playwright as devDependencies
npm run package     # dist/<GUID>.<version>.pbiviz  (needs --all-locales, already in the script)
npm run preview     # package + copy visual.js/css into preview/ for the browser preview and tests
npm run lint
```

- `--all-locales` is required: powerbi-visuals-utils-formattingutils 7 ships ESM locale data that the default locale-trimming loader in powerbi-visuals-tools 7.2.1 can't parse.
- Test before every push or release (John's rule): `npm run preview`, `node tests/check.mjs`, `node tests/live.mjs`, all passing.
- Release: bump `version` in **pbiviz.json (two places)** and **package.json** (`x.y.z.0`), `npm run package`, commit, push, then
  `gh release create vX.Y.Z dist/pbiLabelMap…X.Y.Z.0.pbiviz --title "Label Map X.Y.Z" --notes "…" --latest`
  (upload it as `LabelMap-X.Y.Z.pbiviz`, e.g. copy/rename first).
- `~/Documents/frw/plm-release/` holds the old bundle-based publish flow (`publish.sh`) used when only a cloud session could build, plus every `LabelMap-X.Y.Z.pbiviz` and `notes-X.Y.Z.md`. With Claude Code here, use plain git + gh, but keep copying each release's `.pbiviz` and notes there. Don't run `publish.sh` now: it pushes local `main` and creates the release for the newest `.pbiviz` in that folder.
- In Power BI: Visualizations → … → Import a visual from a file. Tenant has "certified visuals only" risk; the fix is the admin adding it to Organizational visuals.

## Stack

powerbi-visuals-tools 7.2.1, API 5.11.1, powerbi-visuals-utils-formattingmodel 6.0.4, formattingutils 7, Leaflet 1.9.4 (canvas renderer, permanent tooltips for labels), topojson world-atlas 110m for the offline outline. TypeScript, Less.

## Files

- `capabilities.json`: data roles (Location ×5, Latitude, Longitude, Legend, Size, Label value, Bubble text, Tooltips), table mapping (top 30000), format objects, WebAccess privileges (CARTO, OSM, arcgisonline, atlas.microsoft.com). A tile/geocoder domain not listed here is blocked by Power BI.
- `src/visual.ts`: everything at runtime. `update` → `renderData` → `parse` (rows → points, uses `locate`) → `renderPoints` → legend, fit, notices, declutter. Also legend colors, legend filter, region names, re-lookup button.
- `src/places.ts`: `analyzeLocation(text)` reads country, state/province, US ZIP, Canadian postal code, street, town, PO boxes from the Location text. Pure; unit-testable with esbuild.
- `src/geocoder.ts`: Nominatim (1 req/s, structured "attempts" in order) and Azure Maps batch geocoding, checks (OpenStreetMap: state ISO code + distance; Azure: country filter + distance only, no state check), session misses, saved cache.
- `src/postal.ts` + `src/data/caFsa.json`: Canadian postal-area (first 3 chars) centres, 1,610 entries.
- `src/usZip.ts` + `src/data/usZip.json`: ~42,000 US ZIP centres, packed 8 base-36 chars per ZIP.
- `src/regions.ts` + `src/data/regions.json`: US states and Canadian provinces: codes, names, aliases (PQ, Que., B.C., Nfld. …), label points, bounding boxes, postal-letter → province.
- `src/settings.ts`: format pane model. Cards: Map, Bubbles (composite: Colors/Size/Style), Bubble text, Labels, Legend, Geocoding, Notes on the map, Map service keys.
- `tools/build-geo-data.mjs`: rebuilds usZip.json and regions.json from the `zipcodes` npm package (BSD) and Natural Earth admin-1 50m GeoJSON (public domain).
- `preview/index.html`: hand-run browser preview with a fake host. `tests/`: automated browser checks (see Testing).

## How a Location gets placed (locate() in visual.ts)

Latitude/Longitude win when present. Otherwise:
1. Only a state/province ("PQ, CA", "TX, US") → that region's centre, flagged approximate.
2. US ZIP valid for the row's state → ZIP centre, unless there's more to look up (OpenStreetMap: a town; Azure: a street or town). Lookups must land within 80 km of the ZIP centre.
3. ZIP/postal code that belongs to another state/province ("US, TX, 54214" is WI; a PQ row with an S… code) → look up the town if any, else not placed and listed in the yellow note as a conflict.
4. Canadian postal code: OpenStreetMap has no Canadian postal codes, so without a town → postal-area centre (approximate); with a town → lookup within 250 km (rural FSA, 2nd char 0) or 80 km.
5. Lookups (OpenStreetMap) try in order: street + town, street without house number + town, town, then plain text "street, town, ST ZIP, country". Every result must be in the row's state (Nominatim `ISO3166-2-lvl4`) and near its ZIP/postal area. Azure gets one free-text query in the usual order.
6. PO boxes, rural routes, C.P., Suite/Unit are never looked up. The number right after the state is read generously as the ZIP: ZIP+4 without dash, lost leading zero (2134 → 02134), extra digit (561756 → 56175). Garbled ZIPs are ignored.

Tooltips show a "Placed by" line. The yellow note lists not-found rows, conflicts, approximate counts, and ends with "(Label Map <version>)". Format → Notes on the map (1.7.4, object `notes`) hides the approximate ones (`approximate`: region-only and postal-area centres) and the not-placed ones (`notPlaced`: not found, conflicts, skipped rows). Lookup progress and service/key/tile problems always show; John sees the informational ones as not errors.

## Caching

- Found coordinates are saved in the report (`geocoding.cache`, lines `key\tlat\tlon`, max 5000) only in Edit/InFocusEdit view mode, so viewers don't geocode.
- Keys: `osm2|<countries>|<query lowercased>`; old `osm|` keys are dropped on load. Misses are session-only.
- Saved hits outside the row's region bounding box are dropped and looked up again (`forgetSaved`). Hits found this session are trusted.
- Re-lookup everything: the ↻ map button under the zoom buttons (edit mode only, click twice to confirm) or Format → Geocoding → "Look up all locations again".

## Other behaviour worth knowing

- Two texts per point: Bubble text inside (Bubble text field, else Size; own units/decimals/auto contrast color; "grow bubbles to fit") and Labels outside. Declutter hides overlaps, bubble texts first, then labels by value.
- Legend colors: per-value ColorPickers named `bubbles.c0…c59`; value→slot map persisted as `bubbles.legendSlots` (JSON) so colors survive filters. Pickers are built dynamically each update.
- Legend filter (1.7.0): clicking legend entries toggles a set; all rows of those values are selected with `selectionManager.select(ids)`, which dims others and cross-filters other visuals. Map click, point click or an external selection clears it.
- Base maps: Esri (no key, default for Auto without keys), CARTO (needs free key since Aug 2026), Azure Maps raster (key), OSM, offline outline. Greyscale CSS filter toggle. Grey streets and outline get our own state/province names (zoom 3–7.5, hidden under data).

## User's data (examples)

Location is several fields joined with ", " in field order, typically Country, State/Province, ZIP/Postal, Address, Town:
`US, IL, 6221, 10232 Hunter School Rd, Marine` · `US, MN, 561756, 2088 80th Ave P. O. Box 251` · `US, MN, 55918, 311 NW California Street` · `CA AB T0J 3E0` · `CA, AB, TOJ 3EO` (letter O typos) · `PQ, CA` (old Québec code). Mostly rural ag dealers in the US Midwest and the Canadian Prairies; many rural postal areas, so FSA-centre placements stack.

## Testing

Nothing has been tested inside real Power BI by Claude (Desktop is Windows-only; this Mac can't run it). All checks run in headless Chromium with a fake Power BI host (`tests/harness.html`):
- `tests/check.mjs`: mocked Nominatim, exact expected positions, legend filter, re-lookup button, region names. Fast and repeatable.
- `tests/live.mjs`: the same rows against the real Nominatim (`harness.html?live`) and the keyless tile servers (Esri ×3, OSM), ±0.3° and the expected "Placed by". About 15 Nominatim requests; run by hand before a release, not in a loop. Screenshots in `.tmp/live/`.

```bash
npm run preview                      # builds preview/visual.js used by the harness
npx playwright install chromium      # once
node tests/check.mjs                 # prints PASS/FAIL per check
node tests/live.mjs                  # real services; needs internet
```

For parser-only checks, bundle a small script importing `src/places.ts` with esbuild (`--loader:.json=json`) and run it with node.

## Open items

- The user saw an Azure Maps visual on the same page break ("locations associated with multiple legends") after updating. Likely the Azure map's own fields/filters (filled map + Legend at state level), but Label Map's legend filter does cross-filter other visuals. If clearing Label Map's selection or setting Edit interactions → None fixes it, add a "Legend click filters other visuals" toggle.
- Commit b3bc7eb (1.5.0) is authored as the user's noreply address and shows Unverified; history rewrite was not done.
- The Claude GitHub app has no access to this repo, so cloud sessions can't push; local Claude Code can.
- `.pbiviz` is ~400 KB, mostly the ZIP table.

## Working with John

Direct, low-noise answers; GUI steps over CLI when there's a choice; search for known issues before guessing; correct course quickly when he points out a mistake. He's a full-stack engineer (TypeScript/React/Angular/Svelte, Go, Node, Python) and a Sales Operations Analyst, so explain Power BI specifics, not programming basics.
