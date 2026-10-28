"use strict";

/**
 * Reads what a Location already tells us before any lookup: country, state/province,
 * a US ZIP or Canadian postal code, a street, a town, and PO boxes to leave out.
 * The visual uses this to place rows from the bundled ZIP/postal tables when a lookup can't
 * do better, and to reject geocoder results in the wrong state or far from the ZIP/postal area.
 */

import { CanadianPostal, findCanadianPostal, fsaCentre } from "./postal";
import { zipCentre, zipState } from "./usZip";
import { Region, RegionCandidate, countryInText, regionByIso, regionCandidates, regionFromField } from "./regions";

export interface PlaceInfo {
    country: "US" | "CA" | "";
    region: Region | null;
    /** US ZIP that agrees with the state, with its centre; `read` is the original when it was mangled ("561756") */
    zip: { code: string; at: [number, number]; read?: string } | null;
    /** The number right after the state is a real ZIP, but in another state ("US, TX, 54214" is in WI) */
    zipConflict: { code: string; state: string } | null;
    /** Canadian postal code and its postal-area centre */
    ca: CanadianPostal | null;
    caCentre: [number, number] | null;
    /** Has a street address: a house number or a street word ("123 Main St", "Hwy 9", "NW California Street") */
    street: boolean;
    /** Has a place name that isn't the state, country, code or PO box ("Friona", "Brooks") */
    town: boolean;
    /** The street address and town as written, PO boxes left out: "10232 Hunter School Rd", "Marine" */
    streetText: string;
    townText: string;
    /** Text to look up: PO boxes and unit numbers removed, a mangled ZIP written properly */
    query: string;
    /** The same without the ZIP/postal code (OpenStreetMap doesn't know Canadian ones; a conflicting ZIP misleads) */
    queryNoCode: string;
}

const STREET_WORDS = new Set([
    "st", "street", "ave", "av", "avenue", "rd", "road", "dr", "drive", "blvd", "boulevard", "ln", "lane",
    "way", "ct", "court", "pl", "place", "pkwy", "parkway", "hwy", "highway", "trl", "trail", "cir", "circle",
    "ter", "terrace", "sq", "square", "cres", "crescent", "cv", "loop", "pike", "rte", "route", "fwy",
    "expy", "freeway", "xing", "crossing", "grove", "gr", "close", "gate", "line", "concession", "sideroad"
]);
/** French street words come first: "Rue Principale", "Chemin du Lac", "Rang 3" */
const FRENCH_STREET_START = new Set(["rue", "chemin", "ch", "boul", "boulevard", "rang", "montee", "montée", "cote", "côte", "avenue", "av", "route", "rte", "place", "allee", "allée", "impasse"]);
const DIRECTIONS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"]);

/** PO boxes, rural routes, units: things a geocoder can't place */
const NOT_A_PLACE = new RegExp([
    "\\b(?:p\\.?\\s*o\\.?\\s*box|post\\s+office\\s+box|box|r\\.?\\s*r\\.?|rural\\s+route|h\\.?\\s*c\\.?|site|comp|s\\.?\\s*s\\.?|suite|ste|unit|apt|lot)\\s*#?\\s*\\d+[a-z]?\\b",
    "#\\s*\\d+[a-z]?\\b",
    "\\bgeneral\\s+delivery\\b"
].join("|"), "gi");

const COUNTRY_WORDS = /\b(usa|u\.s\.a?\.?|united states(?: of america)?|us|canada|can|ca)\b/gi;

function countryFromField(value: string | null | undefined): "US" | "CA" | "" {
    const v = (value || "").trim().toLowerCase().replace(/\./g, "");
    if (["us", "usa", "united states", "united states of america", "america"].includes(v)) return "US";
    if (["ca", "can", "canada"].includes(v)) return "CA";
    return "";
}

/** Removes PO boxes and tidies the separators left behind */
export function withoutPoBoxes(text: string): string {
    return tidy(text.replace(NOT_A_PLACE, " "));
}

function tidy(text: string): string {
    return text
        .replace(/\s+,/g, ",")
        .replace(/,(\s*,)+/g, ",")
        .replace(/,(?=\S)/g, ", ")
        .replace(/^[\s,]+|[\s,]+$/g, "")
        .replace(/\s{2,}/g, " ");
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9à-ÿ]+/).filter(Boolean);

/** "California" in "California Street", or "NE" in "311 NE Main St" / "Main St NE", is part of a street */
function partOfStreet(text: string, c: RegionCandidate): boolean {
    const after = words(text.slice(c.end)).slice(0, 2);
    const before = words(text.slice(0, c.pos)).slice(-1)[0] || "";
    if (STREET_WORDS.has(after[0] || "")) return true;
    if (c.byCode && c.region.code === "NE") {
        if (/^\d/.test(before) || STREET_WORDS.has(before)) return true;
        if (after[0] && STREET_WORDS.has(after[1] || "")) return true;
    }
    return !c.byCode && /^\d/.test(before);
}

interface Digits {
    text: string;
    start: number;
    end: number;
}

/**
 * ZIPs a run of digits could be: 12345, 12345-6789, and when it stands alone as the ZIP field,
 * 123456789 (no dash), 2134 (lost leading zero), 561756 (extra digit)
 */
function zipReadings(d: Digits, standalone: boolean): string[] {
    const m = /^(\d+)(?:-(\d{4}))?$/.exec(d.text);
    if (!m) return [];
    const n = m[1];
    if (n.length === 5) return [n];
    if (!standalone) return [];
    if (n.length === 4) return ["0" + n];
    if (m[2]) return [];
    if (n.length === 8) return ["0" + n.slice(0, 4)];
    if (n.length >= 6 && n.length <= 9) return [n.slice(0, 5)];
    return [];
}

export function analyzeLocation(text: string, stateField?: string | null, countryField?: string | null): PlaceInfo {
    let country = countryFromField(countryField) || countryInText(text);
    const ca = country === "US" ? null : findCanadianPostal(text);
    if (ca && !country) country = "CA";

    const digitRuns: Digits[] = [...text.matchAll(/\b\d+(?:-\d{4})?\b/g)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
    const standardZipStates = new Set(digitRuns.filter(d => /^\d{5}(-\d{4})?$/.test(d.text))
        .map(d => zipState(d.text.slice(0, 5))).filter(Boolean));

    // "CA" is California or Canada: Canada next to a province code or postal code, California next to "US"
    // or a California ZIP, ignored when there's no telling
    let candidates = regionCandidates(text).filter(c => !partOfStreet(text, c));
    const caProvinceCode = candidates.some(c => c.byCode && c.region.iso.startsWith("CA-"));
    const keepCalifornia = country === "US" || (!country && !caProvinceCode && standardZipStates.has("CA"));
    candidates = candidates.filter(c => !(c.byCode && c.region.code === "CA") || keepCalifornia);
    if (!country && caProvinceCode) country = "CA";

    let region: Region | null = stateField ? regionFromField(stateField, country) : null;
    let regionAt: RegionCandidate | null = null;
    if (!region) {
        const fitting = candidates.filter(c => !country || c.region.iso.startsWith(country + "-"));
        // A state that agrees with a ZIP in the text wins; then codes ("MN") over names; then the last one
        regionAt = [...fitting].reverse().find(c => standardZipStates.has(c.region.code))
            || [...fitting].reverse().find(c => c.byCode)
            || fitting[fitting.length - 1] || null;
        region = regionAt ? regionAt.region : null;
    }
    if (!country && region) country = region.iso.slice(0, 2) as "US" | "CA";

    // US ZIP. The number right after the state is read generously (561756, 123456789, 2134);
    // elsewhere only a standard ZIP in the row's state counts, since other numbers are often house numbers.
    let zip: PlaceInfo["zip"] = null;
    let zipConflict: PlaceInfo["zipConflict"] = null;
    let zipRun: Digits | null = null;
    if (country !== "CA") {
        const next = regionAt ? digitRuns.find(d => d.start >= regionAt.end && /^[\s,]*$/.test(text.slice(regionAt.end, d.start))) : null;
        // The ZIP field: a number on its own between commas ("US, IL, 6221, ..."), not a house number ("IL, 10232 Hunter ...")
        const standalone = !!next && /^\s*([,;]|$)/.test(text.slice(next.end));
        const standard = !!next && /^\d{5}(-\d{4})?$/.test(next.text);
        if (next && region) {
            for (const code of zipReadings(next, standalone)) {
                const st = zipState(code);
                if (!zipCentre(code) || !st) continue;
                if (`US-${st}` === region.iso) {
                    const plain = standard || /^\d{9}$/.test(next.text);
                    zip = { code, at: zipCentre(code), read: plain ? undefined : next.text };
                    zipRun = next;
                    break;
                }
                // A proper ZIP from another state is worth reporting; a garbled one ("6221") is just ignored
                if (!zipConflict && standard) zipConflict = { code, state: st };
            }
        }
        if (!zip) {
            for (const d of [...digitRuns].reverse()) {
                if (!/^\d{5}(-\d{4})?$/.test(d.text)) continue;
                const code = d.text.slice(0, 5);
                const st = zipState(code);
                if (!zipCentre(code) || !st) continue;
                if (region ? `US-${st}` !== region.iso : country !== "US") continue;
                zip = { code, at: zipCentre(code) };
                zipRun = d;
                break;
            }
        }
        if (zip) {
            zipConflict = null;
            if (!region) region = regionByIso(`US-${zipState(zip.code)}`);
            country = "US";
        } else if (zipConflict || standalone) {
            zipRun = next; // a wrong or garbled ZIP field: keep it out of the street and town
        }
    }

    // Text with the ZIP/postal code taken out, and the canonical ZIP put back for lookups
    let noCode = text;
    let query = text;
    if (zipRun) {
        noCode = text.slice(0, zipRun.start) + " " + text.slice(zipRun.end);
        query = zip ? text.slice(0, zipRun.start) + zip.code + text.slice(zipRun.end) : noCode;
    } else if (ca) {
        noCode = ca.rest;
    }

    // What's left in each comma-separated part: a street, a town, or nothing (state, country, PO box)
    const streets: string[] = [];
    const towns: string[] = [];
    for (const part of noCode.split(/[,;]/)) {
        let cleaned = part.replace(NOT_A_PLACE, " ").replace(COUNTRY_WORDS, " ");
        // The state as its own part ("Texas", "Que.", "P.Q."), or its code anywhere ("TX 79035", "PQ");
        // not "Oklahoma" in "Oklahoma City"
        if (region) cleaned = cleaned.replace(/\b[A-Z]{2}\b/g, code => (regionFromField(code, country) === region ? " " : code));
        if (region && regionFromField(cleaned.trim(), country) === region) cleaned = "";
        const toks = cleaned.split(/\s+/).map(t => t.replace(/^[.\-#:]+|[.\-#:]+$/g, "")).filter(Boolean);
        if (!toks.length) continue;
        const lower = toks.map(t => t.toLowerCase().replace(/\.$/, ""));
        // A street word after a name ("Main St"), not first in the part: "St. John's" is a town
        const lastStreetWord = lower.reduce((at, x, i) => (i > 0 && STREET_WORDS.has(x) ? i : at), -1);
        if (toks.some(t => /\d/.test(t)) || lastStreetWord >= 0 || (toks.length > 1 && FRENCH_STREET_START.has(lower[0]))) {
            // "123 Main St Brooks": words after the street name (other than N/E/S/W) are a town
            let end = lastStreetWord >= 0 ? lastStreetWord + 1 : toks.length;
            while (end < toks.length && DIRECTIONS.has(lower[end])) end++;
            const tail = toks.slice(end).filter(t => !/\d/.test(t));
            streets.push(toks.slice(0, lastStreetWord >= 0 ? end : toks.length).join(" "));
            if (lastStreetWord >= 0 && tail.length) towns.push(tail.join(" "));
        } else {
            towns.push(toks.join(" "));
        }
    }
    const street = streets.length > 0;
    const town = towns.length > 0;

    return {
        country,
        region,
        zip,
        zipConflict,
        ca,
        caCentre: ca ? fsaCentre(ca.fsa) : null,
        street,
        town,
        streetText: streets[0] || "",
        townText: towns[0] || "",
        query: withoutPoBoxes(query),
        queryNoCode: withoutPoBoxes(noCode)
    };
}


/** "10232 Hunter School Rd" -> "Hunter School Rd", for when the house number isn't on the map */
export function withoutHouseNumber(street: string): string {
    return street.replace(/^\s*\d+[a-z]?(?:-\d+)?\s+/i, "");
}

/** Great-circle distance in km */
export function distanceKm(a: [number, number], b: [number, number]): number {
    const rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad;
    const dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
