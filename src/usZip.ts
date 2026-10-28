"use strict";

/**
 * US ZIP code centres (about 42,000), bundled so ZIP-based locations don't need a lookup and
 * can't land in the wrong state. Data: the BSD-licensed `zipcodes` npm package, packed by
 * tools/build-geo-data.mjs into 8 base-36 characters per ZIP (ZIP delta, lat, lon at 0.01°).
 */

import zipData from "./data/usZip.json";

interface ZipTable {
    records: string;
    zip3: Record<string, string>;
    exceptions: Record<string, string>;
}

const TABLE = zipData as unknown as ZipTable;
let zips: Int32Array | null = null;
let coords: Float32Array | null = null;

function decode() {
    const n = TABLE.records.length / 8;
    zips = new Int32Array(n);
    coords = new Float32Array(n * 2);
    let zip = 0;
    for (let i = 0; i < n; i++) {
        const r = TABLE.records.substr(i * 8, 8);
        zip += parseInt(r.slice(0, 2), 36);
        zips[i] = zip;
        coords[i * 2] = parseInt(r.slice(2, 5), 36) / 100 - 90;
        coords[i * 2 + 1] = parseInt(r.slice(5, 8), 36) / 100 - 180;
    }
}

/** Centre of a 5-digit ZIP, or null when it isn't in the table */
export function zipCentre(zip: string): [number, number] | null {
    if (!/^\d{5}$/.test(zip)) return null;
    if (!zips) decode();
    const z = Number(zip);
    let lo = 0;
    let hi = zips.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (zips[mid] === z) return [coords[mid * 2], coords[mid * 2 + 1]];
        if (zips[mid] < z) lo = mid + 1;
        else hi = mid - 1;
    }
    return null;
}

/** Two-letter state of a ZIP, e.g. "79035" -> "TX" */
export function zipState(zip: string): string | null {
    return TABLE.exceptions[zip] || TABLE.zip3[zip.slice(0, 3)] || null;
}
