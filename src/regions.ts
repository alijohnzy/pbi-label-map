"use strict";

/**
 * US states and Canadian provinces/territories: codes, names and label points (Natural Earth, public domain).
 * Used to read the state/province out of Location text, to check geocoder results against it,
 * and to label the map when the base map doesn't name them.
 */

import regionData from "./data/regions.json";

export interface Region {
    /** ISO 3166-2 code, e.g. "US-TX", "CA-AB" */
    iso: string;
    /** Postal abbreviation, e.g. "TX" */
    code: string;
    name: string;
    lat: number;
    lon: number;
    /** km², for labeling big regions first */
    area: number;
    /** Zoom level where the label starts to fit */
    minZoom: number;
}

export const REGIONS = regionData as Region[];

const US_CODES = new Map<string, Region>();
const CA_CODES = new Map<string, Region>();
const NAMES = new Map<string, Region>();

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

for (const r of REGIONS) {
    (r.iso.startsWith("US-") ? US_CODES : CA_CODES).set(r.code, r);
    NAMES.set(fold(r.name), r);
}
// Old two-letter codes still common in Canadian data: PQ (Québec), NF/LB (Newfoundland/Labrador), YK (Yukon)
const CODE_ALIASES: Record<string, string> = { PQ: "CA-QC", NF: "CA-NL", LB: "CA-NL", YK: "CA-YT" };
for (const [code, iso] of Object.entries(CODE_ALIASES)) {
    const r = REGIONS.find(x => x.iso === iso);
    if (r) CA_CODES.set(code, r);
}
// Other spellings, matched case-insensitively as whole words. Short ones that are also ordinary
// words or towns ("Man", "Alta") only count with their dot.
const ALIASES: Record<string, string> = {
    "washington dc": "US-DC", "washington d.c.": "US-DC", "d.c.": "US-DC",
    "pei": "CA-PE", "p.e.i.": "CA-PE", "newfoundland": "CA-NL", "labrador": "CA-NL", "nfld": "CA-NL", "nfld.": "CA-NL",
    "nwt": "CA-NT", "n.w.t.": "CA-NT", "yukon territory": "CA-YT", "northwest territory": "CA-NT", "y.t.": "CA-YT",
    "quebec": "CA-QC", "que": "CA-QC", "que.": "CA-QC", "p.q.": "CA-QC", "province of quebec": "CA-QC",
    "b.c.": "CA-BC", "n.s.": "CA-NS", "n.b.": "CA-NB", "n.l.": "CA-NL",
    "sask": "CA-SK", "sask.": "CA-SK", "alta.": "CA-AB", "man.": "CA-MB", "ont": "CA-ON", "ont.": "CA-ON"
};
for (const [alias, iso] of Object.entries(ALIASES)) {
    const r = REGIONS.find(x => x.iso === iso);
    if (r) NAMES.set(alias, r);
}
// Longest names first so "West Virginia" wins over "Virginia"
const NAME_LIST = [...NAMES.keys()].sort((a, b) => b.length - a.length);

export function regionByIso(iso: string): Region | null {
    return REGIONS.find(r => r.iso === iso) || null;
}

/** A state/province field value: "TX", "Texas", "AB", "Alberta" */
export function regionFromField(value: string, country: "US" | "CA" | ""): Region | null {
    const v = value.trim();
    if (!v) return null;
    const up = v.toUpperCase();
    if (country !== "CA" && US_CODES.has(up)) return US_CODES.get(up);
    if (country !== "US" && CA_CODES.has(up)) return CA_CODES.get(up);
    return NAMES.get(fold(v)) || null;
}

export interface RegionCandidate {
    region: Region;
    /** Position in the text, so the last one (usually the state after the city) wins */
    pos: number;
    end: number;
    /** Found as an upper-case code ("TX") rather than a name */
    byCode: boolean;
}

/** Every state/province code or name in the text. Codes must be upper case: "in", "or", "me" are words. */
export function regionCandidates(text: string): RegionCandidate[] {
    const found: RegionCandidate[] = [];
    for (const m of text.matchAll(/\b[A-Z]{2}\b/g)) {
        const r = US_CODES.get(m[0]) || CA_CODES.get(m[0]);
        if (r) found.push({ region: r, pos: m.index, end: m.index + 2, byCode: true });
    }
    const folded = fold(text);
    const taken: Array<[number, number]> = [];
    for (const name of NAME_LIST) {
        let from = 0;
        for (;;) {
            const i = folded.indexOf(name, from);
            if (i < 0) break;
            from = i + name.length;
            const before = i === 0 ? " " : folded[i - 1];
            const after = from >= folded.length ? " " : folded[from];
            if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
            if (taken.some(([a, b]) => i < b && from > a)) continue;
            taken.push([i, from]);
            found.push({ region: NAMES.get(name), pos: i, end: from, byCode: false });
        }
    }
    return found.sort((a, b) => a.pos - b.pos);
}

/** Country named in the text: "US"/"USA"/"United States" or "Canada"/"CAN". A bare "CA" is left to the caller. */
export function countryInText(text: string): "US" | "CA" | "" {
    const us = /\b(usa|u\.s\.a?\.?|united states(?: of america)?)\b/i.test(text) || /\bUS\b/.test(text);
    const ca = /\b(canada|can)\b/i.test(text);
    if (us && !ca) return "US";
    if (ca && !us) return "CA";
    return "";
}
