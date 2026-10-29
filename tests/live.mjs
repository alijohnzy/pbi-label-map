// Live checks for Label Map: the built visual against the real Nominatim and tile servers (no mocks).
// Run `npm run preview` first, then `node tests/live.mjs`. Makes about 15 Nominatim requests at 1 per second,
// so run it by hand before a release, not in a loop. Screenshots go to .tmp/live/.
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require("playwright"));
} catch {
    ({ chromium } = await import("playwright"));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(path.join(here, "harness.html")).href + "?live";
const shots = path.join(here, "..", ".tmp", "live");
fs.mkdirSync(shots, { recursive: true });
let failures = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!ok) failures++;
};
// Real results move a little as OpenStreetMap is edited, so the tolerance is wider than in check.mjs
const near = (p, lat, lon, tol = 0.3) => p && Math.abs(p.lat - lat) < tol && Math.abs(p.lon - lon) < tol;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
await page.goto(url);

const started = Date.now();
await page.evaluate(() => window.doUpdate({ map: { basemap: "outline" } }));
await page.waitForFunction(() => !window.visual.geocoder.busy, null, { timeout: 240000, polling: 1000 });
const seconds = Math.round((Date.now() - started) / 1000);

const points = await page.evaluate(() => window.visual.points.map(p => ({
    name: p.name, lat: p.lat, lon: p.lon,
    how: (p.tooltip.find(t => t.displayName === "Placed by") || {}).value || ""
})));
const by = name => points.find(p => p.name === name);
const notice = await page.evaluate(() => document.querySelector(".plm-notice").textContent);
const geo = await page.evaluate(() => ({ stop: window.visual.geocoder.stop, error: window.visual.geocoder.lastError }));
const requests = await page.evaluate(() => window.__fetchLog.filter(r => r.url.startsWith("https://nominatim.openstreetmap.org/")));

// Row in tests/harness.html -> where it belongs, and how it should get there
const EXPECT = [
    ["US TX 79035", 34.64, -102.72, "ZIP code"],
    ["US, MN, 561751234", 44.23, -95.62, "ZIP code"],
    ["US, MN, 55918, 311 NW California Street", 43.72, -92.87, "ZIP code"],
    ["US, MN, 561756, 2088 80th Ave P. O. Box 251", 44.23, -95.62, "ZIP code"],
    ["US, MA, 2134", 42.35, -71.13, "ZIP code"],
    ["Austin, TX 54214", 30.27, -97.74, "OpenStreetMap"],
    ["US, IL, 6221, 10232 Hunter School Rd, Marine", 38.79, -89.78, "OpenStreetMap"],
    ["Friona, TX 79035", 34.64, -102.72, "OpenStreetMap"],
    ["100 Main St, Friona, TX 79035", 34.64, -102.72, "OpenStreetMap"],
    ["Paris, TX", 33.66, -95.56, "OpenStreetMap"],
    ["China, TX, USA", 30.05, -94.34, "OpenStreetMap"],
    ["Ontario, CA 91761", 34.06, -117.65, "OpenStreetMap"],
    ["123 Main St NE, Minneapolis, MN 55401", 44.98, -93.27, "OpenStreetMap"],
    ["CA, PQ, Saint-Hyacinthe", 45.63, -72.96, "OpenStreetMap"],
    ["CA, PQ, S0K 1A0, Saint-Hyacinthe", 45.63, -72.96, "OpenStreetMap"],
    ["Brooks, AB T1R 0A1", 50.56, -111.90, "OpenStreetMap"],
    ["Winnipeg, MB R3C 4T3", 49.90, -97.14, "OpenStreetMap"],
    ["CA AB T0J 3E0", 49.84, -110.78, "Postal area"],
    ["CA, AB, TOJ 3EO", 49.84, -110.78, "Postal area"],
    ["CA, AB, T0J 3E0, Box 123", 49.84, -110.78, "Postal area"],
    ["PQ, CA", 52.26, -73.72, "Québec"]
];
for (const [name, lat, lon, how] of EXPECT) {
    const p = by(name);
    check(name, near(p, lat, lon) && p.how.startsWith(how),
        p ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}  ${p.how}` : "not placed");
}
check("ZIP from another state is reported, not placed", !by("US, TX, 54214, PO BOX 249") && notice.includes("54214 is in WI"));
check("Postal code from another province is reported, not placed", !by("CA, PQ, S0K 1A0") && notice.includes("S0K is in SK"));
const statuses = [...new Set(requests.map(r => r.status))];
check("Nominatim answered every request", requests.length > 0 && statuses.length === 1 && statuses[0] === 200 && !geo.stop,
    `${requests.length} requests in ${seconds} s, status ${statuses.join(",")}${geo.stop ? `, stopped: ${geo.stop} ${geo.error}` : ""}`);

// Base maps that need no key
for (const basemap of ["esriStreets", "esriGray", "esriImagery", "osm"]) {
    await page.evaluate(b => window.doUpdate({ map: { basemap: b } }), basemap);
    await page.waitForTimeout(6000);
    const stats = await page.evaluate(() => window.visual.tileStats);
    check(`Tiles load: ${basemap}`, stats.loads > 0 && stats.errors === 0, `${stats.loads} loaded, ${stats.errors} failed`);
    await page.screenshot({ path: path.join(shots, `${basemap}.png`) });
}

check("No page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(`\nScreenshots: ${shots}`);
console.log(failures ? `${failures} check(s) failed` : "All live checks passed");
process.exit(failures ? 1 : 0);
