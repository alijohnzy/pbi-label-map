// Builds the bundled lookup tables in src/data from public sources:
//   node tools/build-geo-data.mjs <zipcodes package dir> <ne_50m_admin_1_states_provinces.geojson>
// - usZip.json:   US ZIP code centres, from the BSD-licensed `zipcodes` npm package (v8)
// - regions.json: US state and Canadian province names, codes and label points, from Natural Earth (public domain)
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import path from "path";

const [zipDir, nePath] = process.argv.slice(2);
if (!zipDir || !nePath) {
    console.error("usage: node tools/build-geo-data.mjs <zipcodes dir> <admin1 geojson>");
    process.exit(1);
}
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "data");

// ---- US ZIP centres: sorted records of 8 base-36 chars: ZIP delta (2), lat (3), lon (3), 0.01 degree precision
const { codes } = createRequire(import.meta.url)(path.resolve(zipDir, "lib", "codes.js"));
const MILITARY = new Set(["AA", "AE", "AP"]);
const zips = Object.values(codes)
    .filter(c => c.country === "US" && /^\d{5}$/.test(c.zip) && !MILITARY.has(c.state)
        && Number.isFinite(c.latitude) && Number.isFinite(c.longitude) && (c.latitude || c.longitude))
    .sort((a, b) => a.zip.localeCompare(b.zip));
const b36 = (n, width) => {
    const s = Math.round(n).toString(36);
    if (s.length > width) throw new Error(`value ${n} too wide`);
    return s.padStart(width, "0");
};
let prev = 0;
let records = "";
for (const c of zips) {
    const z = Number(c.zip);
    records += b36(z - prev, 2) + b36((c.latitude + 90) * 100, 3) + b36((c.longitude + 180) * 100, 3);
    prev = z;
}
// State per ZIP: the most common state of its first three digits, plus the few exceptions
const byZip3 = {};
for (const c of zips) {
    const k = c.zip.slice(0, 3);
    byZip3[k] = byZip3[k] || {};
    byZip3[k][c.state] = (byZip3[k][c.state] || 0) + 1;
}
const zip3 = {};
for (const [k, counts] of Object.entries(byZip3)) zip3[k] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
const exceptions = {};
for (const c of zips) if (zip3[c.zip.slice(0, 3)] !== c.state) exceptions[c.zip] = c.state;
writeFileSync(path.join(out, "usZip.json"), JSON.stringify({ records, zip3, exceptions }));
console.log(`usZip.json: ${zips.length} ZIPs, ${records.length} chars, ${Object.keys(exceptions).length} exceptions`);

// ---- States and provinces
const ne = JSON.parse(readFileSync(nePath, "utf8"));
// Rough area in km² (equirectangular shoelace), used to label big regions first
const areaKm2 = geom => {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    let total = 0;
    for (const poly of polys) {
        const pts = poly[0].map(([lon, lat]) => [lon * Math.cos((lat * Math.PI) / 180) * 111.32, lat * 110.57]);
        let a = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        total += Math.abs(a / 2);
    }
    return total;
};
const regions = ne.features
    .filter(f => (f.properties.adm0_a3 === "USA" || f.properties.adm0_a3 === "CAN") && f.properties.iso_3166_2 && f.properties.postal)
    .map(f => ({ ...f.properties, area_sqkm: areaKm2(f.geometry) }))
    .map(p => ({
        iso: p.iso_3166_2,
        code: p.postal,
        name: p.name,
        lat: Math.round(p.latitude * 1000) / 1000,
        lon: Math.round(p.longitude * 1000) / 1000,
        area: Math.round(p.area_sqkm),
        minZoom: p.min_label || 3.5
    }))
    .sort((a, b) => a.iso.localeCompare(b.iso));
writeFileSync(path.join(out, "regions.json"), JSON.stringify(regions));
console.log(`regions.json: ${regions.length} regions`);
