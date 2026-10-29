// Browser checks for Label Map: run `npm run preview` first, then `node tests/check.mjs`.
// Needs Playwright's Chromium: `npx playwright install chromium` once.
// tests/harness.html loads preview/visual.js with a fake Power BI host and a mocked Nominatim.
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";

const require = createRequire(import.meta.url);
let chromium;
try {
    ({ chromium } = require("playwright"));
} catch {
    ({ chromium } = await import("playwright"));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(path.join(here, "harness.html")).href;
let failures = 0;
const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!ok) failures++;
};
const near = (p, lat, lon, tol = 0.05) => p && Math.abs(p.lat - lat) < tol && Math.abs(p.lon - lon) < tol;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
await page.goto(url);

// A location saved by an old version in the wrong state must be re-checked and looked up again
await page.evaluate(() => {
    window.__savedObjects.geocoding = { cache: "osm2||paris, tx\t44.259800\t-70.500900" };
});
await page.evaluate(o => window.doUpdate(o), { map: { basemap: "outline" } });
await page.waitForTimeout(30000); // the mock answers like Nominatim: one request per 1.1 s

const points = await page.evaluate(() => window.visual.points.map(p => ({
    name: p.name, lat: p.lat, lon: p.lon,
    how: (p.tooltip.find(t => t.displayName === "Placed by") || {}).value || ""
})));
const by = name => points.find(p => p.name === name);
const notice = await page.evaluate(() => document.querySelector(".plm-notice").textContent);

check("US ZIP only -> ZIP centre", near(by("US TX 79035"), 34.64, -102.72));
check("ZIP+4 without dash", near(by("US, MN, 561751234"), 44.23, -95.62));
check("6-digit ZIP + PO box -> ZIP 56175", near(by("US, MN, 561756, 2088 80th Ave P. O. Box 251"), 44.23, -95.62), by("US, MN, 561756, 2088 80th Ave P. O. Box 251")?.how);
check("'California Street' is not California", near(by("US, MN, 55918, 311 NW California Street"), 43.72, -92.87));
check("Garbled ZIP ignored, street name + town found", near(by("US, IL, 6221, 10232 Hunter School Rd, Marine"), 38.80, -89.76));
check("Paris, TX not in Maine (stale save re-checked)", near(by("Paris, TX"), 33.66, -95.56), by("Paris, TX")?.how);
check("Lost leading zero ZIP", near(by("US, MA, 2134"), 42.35, -71.13));
check("Canadian postal only -> postal area", near(by("CA AB T0J 3E0"), 49.84, -110.78));
check("Letter O typos in postal code", near(by("CA, AB, TOJ 3EO"), 49.84, -110.78));
check("PQ row looked up in Québec, not SK", near(by("CA, PQ, Saint-Hyacinthe"), 45.63, -72.96));
check("Province only -> province centre", near(by("PQ, CA"), 52.26, -73.72), by("PQ, CA")?.how);
check("ZIP from another state is reported, not placed", !by("US, TX, 54214, PO BOX 249") && notice.includes("54214 is in WI"));
check("Version shown in the note", /\(Label Map \d+\.\d+\.\d+\)/.test(notice));

// Notes on the map: approximate placements and rows not on the map can be switched off
const noticeText = () => page.evaluate(() => {
    const el = document.querySelector(".plm-notice");
    return el.style.display === "none" ? "" : el.textContent;
});
check("Notes card in the format pane", await page.evaluate(() => {
    const card = window.visual.getFormattingModel().cards.find(c => c.displayName === "Notes on the map");
    const props = card ? card.groups.flatMap(g => g.slices).map(s => s.control.properties.descriptor.propertyName) : [];
    return props.join(",") === "approximate,notPlaced";
}));
await page.evaluate(o => window.doUpdate(o), { map: { basemap: "outline" }, notes: { approximate: false } });
let text = await noticeText();
check("Approximate placements can be hidden",
    !text.includes("only name a state/province") && !text.includes("postal area") && text.includes("54214 is in WI"), text);
await page.evaluate(o => window.doUpdate(o), { map: { basemap: "outline" }, notes: { notPlaced: false } });
text = await noticeText();
check("Rows not on the map can be hidden",
    !text.includes("54214 is in WI") && text.includes("only name a state/province"), text);
await page.evaluate(o => window.doUpdate(o), { map: { basemap: "outline" }, notes: { approximate: false, notPlaced: false } });
check("Note gone when both are off", (await noticeText()) === "", await noticeText());
await page.evaluate(o => window.doUpdate(o), { map: { basemap: "outline" } });
text = await noticeText();
check("Notes back when switched on", text.includes("only name a state/province") && text.includes("54214 is in WI"));

// Legend filter: click toggles, several at once, last click clears
const legendState = () => page.evaluate(() => [...document.querySelectorAll(".plm-legend-row")]
    .map(r => r.dataset.value + (r.classList.contains("plm-legend-off") ? ":off" : ":on")).join(" "));
await page.click(".plm-legend-row[data-value='US']");
check("Legend click shows only that entry", (await legendState()) === "Canada:off US:on", await legendState());
await page.click(".plm-legend-row[data-value='Canada']");
check("Second legend click adds it", (await legendState()) === "Canada:on US:on");
await page.click(".plm-legend-row[data-value='US']");
await page.click(".plm-legend-row[data-value='Canada']");
check("Clicking the last active entry clears", (await page.evaluate(() => window.__log.slice(-1)[0])) === "clear");

// Re-lookup button: edit mode only, two clicks
check("Re-lookup button shown while editing", await page.evaluate(() => !!document.querySelector(".plm-refresh")));
const before = await page.evaluate(() => window.__fetchLog.length);
await page.click(".plm-refresh a");
await page.click(".plm-refresh a");
await page.waitForTimeout(2500);
check("Re-lookup empties the saved cache and looks up again",
    (await page.evaluate(() => window.__persisted.some(c => c.merge[0].properties.cache === "")))
    && (await page.evaluate(() => window.__fetchLog.length)) > before);

// State/province names on the offline outline
await page.evaluate(() => { window.visual.map.setView([47, -100], 4, { animate: false }); });
await page.waitForTimeout(400);
const names = await page.evaluate(() => [...document.querySelectorAll(".plm-region-name")].filter(e => e.style.visibility !== "hidden").length);
check("State/province names at zoom 4", names > 20, `${names} shown`);

check("No page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
