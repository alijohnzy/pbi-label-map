# Label Map (Power BI custom visual)

Leaflet point map with the Azure Maps field wells (Location, Latitude, Longitude, Legend, Size, Tooltips) plus **Label value** and **Bubble text**, which print any measure or column on each point. Location text is geocoded; Latitude/Longitude override it per row. Cross-filters like a normal visual.

**Download:** grab the `.pbiviz` from the [latest release](https://github.com/alijohnzy/pbi-label-map/releases/latest). No Node or build tools needed to use it.

## Use it in Power BI

1. Visualizations pane → `…` → **Import a visual from a file** → pick the `.pbiviz`.
2. Fill the fields:

| Field | What to put there |
|---|---|
| Location | Address, city, postal code, state or country. Up to 5 fields (e.g. City, Province, Country) are combined into one lookup. Also used as the point's name in labels and tooltips. |
| Latitude / Longitude | Optional. Rows that have them skip geocoding, so you can mix both. |
| Legend | Optional category. Each value gets its own color picker in *Format → Bubbles → Colors* (theme colors until you pick one). |
| Size | Optional measure; bubble area scales between Min and Max size. Printed inside the bubble when Bubble text is empty. |
| Label value | The number or text printed next to each point (the label). Measures respond to slicers. For a text column pick First/Last. |
| Bubble text | Optional. The number or text printed inside each bubble, e.g. a dealer code or a count, separate from Label value. |
| Tooltips | Extra fields for the hover tooltip. Report page tooltips work too. |

3. Format pane: **Map** (base map, greyscale, state and province names, auto-zoom on filter, zoom buttons, wheel zoom), **Bubbles** (Colors per legend value, Size, Style), **Bubble text**, **Labels** (content, position, display units, decimals, text style, background/halo, hide overlapping), **Legend**, **Geocoding**, **Map service keys**.

   Each point can carry two texts at once:
   - **Bubble text** is drawn inside the node: the Bubble text field (or the Size value while that well is empty), or pick Size value, Label value or Location. It has its own display units, decimals, text size, bold and color (*Auto text color* picks white or dark per bubble). *Grow bubbles to fit text* enlarges bubbles until the longest text fits, keeping their size order; turn it off to keep exact sizes.
   - **Labels** sit outside the node (above, below, left or right): the Label value, Location, or both.

   When texts collide, *Hide overlapping labels* keeps bubble texts first, then the labels with the largest values.

Legend colors: up to 60 legend values get their own picker and keep their color through filters and new data; any beyond that use theme colors.

Click a point to filter other visuals, Ctrl/⌘-click to multi-select, click empty map to clear, right-click for the context menu.

## Geocoding (Location field)

Power BI doesn't let custom visuals use its built-in geocoder, so the visual calls a geocoding service itself. *Format → Geocoding*:

- **Service: OpenStreetMap (free).** Nominatim, at most one lookup per second by its usage policy, so 200 new locations take a few minutes the first time. Points appear as they're found.
- **Service: Azure Maps (needs key).** The same service the built-in Azure Maps visual uses; looks up 100 locations per request. Paste a subscription key from your company's Azure Maps account into *Format → Map service keys*. The key is saved in the report, so anyone who can edit the report can read it.
- **Only these countries:** two-letter codes like `CA, US` so an ambiguous name like "Brandon" doesn't land in another country.

Found coordinates are saved into the report while you're editing (Desktop, or Edit mode in the service). After you save, viewers get the points instantly and the service isn't called again unless new locations show up. Locations that can't be found are listed in the yellow note; add more detail (city, province, country) or give those rows Latitude/Longitude.

Fields with a data category (City, State or Province, Postal Code, Country, Address) are sent as a structured lookup to OpenStreetMap, which is more accurate than free text.

**State and ZIP checks.** The visual reads the country, state/province (`TX`, `Texas`, `AB`), US ZIP and Canadian postal code out of each Location first:
- A result from OpenStreetMap that lands in a different state or province than the row says is rejected, so "Paris, TX" can't end up in Paris, Maine. The country the row names is also passed to the lookup.
- **US ZIP codes** are placed at the ZIP's centre from a bundled table of about 42,000 ZIPs, with no lookup, when the Location has nothing more specific than the town (e.g. `US TX 79035`, `Friona, TX 79035`). With a street address the address is looked up, and kept only if it's within 80 km of the ZIP's centre. Tooltips say "Placed at: ZIP code ... area".
- The number right after the state is read generously: ZIP+4 without the dash (`561751234`), a lost leading zero (`2134` for `02134`, common in Excel exports) and an extra digit (`561756` as `56175`). Tooltips show what it was read from.
- Each comma-separated part is read as country, state, ZIP, street, town or PO box. PO boxes, rural routes and unit numbers (`PO Box 249`, `P. O. Box 251`, `RR 2 Site 5 Comp 10`, `Suite 100`) are left out of lookups. Without a town, a street alone isn't looked up: the row goes to its ZIP or postal-area centre, which is closer than a guess at "80th Ave" somewhere in the state.
- State names inside street names (`311 NW California Street`) and the direction `NE` (`123 Main St NE`) aren't read as states.
- **ZIP in another state** (`US, TX, 54214` — 54214 is in Wisconsin): with a town, the town is looked up and the ZIP ignored; without one the row isn't placed, and the yellow note lists it so the data can be fixed.
- A bare `CA` means Canada next to a province or postal code, and California next to `US` or a California ZIP.

**Canadian postal codes.** Codes typed with a letter O for zero (`TOJ 3EO`) are read as `T0J 3E0`. OpenStreetMap has almost no Canadian postal codes (Canada Post owns that data), so with OpenStreetMap:
- A location that's only a postal code plus province/country (e.g. `CA AB T0J 3E0`) is placed at the centre of its postal area, the first three characters (FSA), from a bundled table of 1,620 areas. No lookup is needed, so it's instant. Rural areas (a 0 in the second character, like T0J) are large, so several dealers can land on the same spot.
- A location with a town or street too (e.g. `Brooks, AB T1R 0A1`) is looked up without the postal code, so it lands on the town.
- Anything that still isn't found falls back to its postal area.

These points say "approximate" in the tooltip and the yellow note counts them. A looked-up town that lands more than 250 km (rural areas) or 80 km from its postal area's centre is replaced by that centre. Azure Maps knows full Canadian postal codes, so an Azure Maps key places them exactly.

## If it doesn't render at work

- **Visual shows an error / won't import:** tenant setting *Add and use certified visuals only* is on. This visual can't be certified (it loads map tiles from outside), so ask the Power BI admin to add the `.pbiviz` to **Organizational visuals**, which works regardless of that setting.
- **Points show but the background is blank and a yellow note says tiles can't load:** web access for custom visuals is blocked. Switch *Format → Map → Base map* to **Offline outline**, which is bundled and needs no network.
- **Yellow note says the geocoding service can't be reached:** same cause; Location lookups need web access. Rows with Latitude/Longitude still plot.

## Base maps

*Format → Map → Base map*, with keys in *Format → Map service keys*:

| Base map | Key |
|---|---|
| Auto (default) | Uses Azure Maps if you've entered that key, else CARTO if you've entered that key, else Esri |
| Road / Dark grey / Satellite (Azure Maps) | Azure Maps subscription key; the same key also speeds up geocoding |
| Light / Streets / Dark (CARTO) | Free CARTO key from carto.com/basemaps/apikey (commercial use free up to 1M tiles a month). Since late August 2026 CARTO stamps "API key required" on tiles requested without one. |
| Streets / Grey streets / Satellite (Esri) | None (Esri's older public tile service). Grey streets is Esri's light grey canvas with its own label layer. |
| OpenStreetMap | None, but OSM blocks requests that arrive without a Referer, which can happen in Power BI Desktop |
| Offline outline | None; bundled, works with no internet |

Choosing a base map whose key is missing shows Esri streets and a note saying which key to add. *Greyscale* turns any base map grey. Grey streets and Offline outline don't name states and provinces when zoomed out, so the visual adds the names itself (*State and province names*, zoom 3 to 7.5); they hide wherever a bubble or label is.

Power BI's built-in Azure Maps visual runs on Microsoft's own Azure Maps account, and the custom visual API doesn't expose it or Power BI's geocoder. Microsoft's Azure Maps Web SDK also needs your own key, so this visual uses Azure Maps' tile and geocoding REST services directly with that key instead.

To add a provider: add its URL to `TILES` in `src/visual.ts`, an entry to `BASEMAPS` in `src/settings.ts`, and its domain to the `WebAccess` privilege in `capabilities.json`, then repackage. A tile domain that isn't listed in `capabilities.json` is blocked by Power BI.

## Develop

```bash
npm install
npm run package        # writes dist/*.pbiviz
npm run preview        # rebuilds and refreshes preview/ for the browser check
```

After `npm run preview`, `preview/index.html` opens in any browser (double-click) with sample data and a fake Power BI host, so you can check tiles, labels and styling without Power BI.

Releases: bump `version` in `pbiviz.json` and `package.json`, run `npm run package`, then attach `dist/*.pbiviz` to a new GitHub release.

Note: packaging uses `--all-locales` because powerbi-visuals-utils-formattingutils 7 ships ESM locale data that the default locale-trimming loader in powerbi-visuals-tools 7.2 can't parse.

## Files

- `capabilities.json` — data roles, format pane objects, tile and geocoder domains (WebAccess)
- `src/visual.ts` — rendering, labels, overlap hiding, selection, tooltips
- `src/geocoder.ts` — Location lookups (Nominatim, Azure Maps batch), rate limiting, cache
- `src/places.ts` — reads country, state, ZIP/postal code and street from Location text
- `src/postal.ts`, `src/data/caFsa.json` — Canadian postal-area centres (from the BSD-licensed `zipcodes` npm package, Canada data originally from AggData)
- `src/usZip.ts`, `src/data/usZip.json` — US ZIP centres (same `zipcodes` package, US data from federalgovernmentzipcodes.us)
- `src/regions.ts`, `src/data/regions.json` — US state and Canadian province names, codes and label points (Natural Earth, public domain)
- `tools/build-geo-data.mjs` — rebuilds `usZip.json` and `regions.json` from those sources
- `src/settings.ts` — format pane model
- `style/visual.less` — label, legend and notice styles
