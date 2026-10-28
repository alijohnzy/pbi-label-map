"use strict";

/**
 * Reads what a Location already tells us before any lookup: country, state/province,
 * a US ZIP or Canadian postal code, and whether there's a street address.
 * The visual uses this to place ZIP/postal-only rows from bundled tables, and to reject
 * geocoder results that land in the wrong state or far from the row's ZIP/postal area.
 */

import { CanadianPostal, findCanadianPostal, fsaCentre } from "./postal";
import { zipCentre, zipState } from "./usZip";
import { Region, countryInText, regionByIso, regionCandidates, regionFromField } from "./regions";

export interface PlaceInfo {
    country: "US" | "CA" | "";
    region: Region | null;
    /** US ZIP in the text that agrees with the state, with its centre */
    zip: { code: string; at: [number, number] } | null;
    /** Canadian postal code and its postal-area centre */
    ca: CanadianPostal | null;
    caCentre: [number, number] | null;
    /** A number other than the ZIP/postal code, e.g. "123 Main St" or "Hwy 9" */
    street: boolean;
    /** Nothing but the ZIP, state and country, e.g. "US TX 79035" */
    zipOnly: boolean;
}

interface ZipToken {
    zip: string;
    start: number;
    end: number;
    /** Written the standard way: 12345 or 12345-6789 */
    standard: boolean;
}

/**
 * ZIP-like numbers: 12345, 12345-6789, and how exports mangle them: ZIP+4 without the dash
 * (123456789), and New England/New Jersey ZIPs that lost their leading zero (2134, 2134-5678, 21345678).
 */
function zipTokens(text: string): ZipToken[] {
    const found: ZipToken[] = [];
    for (const m of text.matchAll(/\b(\d{4,9})(?:-(\d{4}))?\b/g)) {
        const d = m[1];
        let zip = "";
        if (d.length === 5) zip = d;
        else if (d.length === 4) zip = "0" + d;
        else if (d.length === 9 && !m[2]) zip = d.slice(0, 5);
        else if (d.length === 8 && !m[2]) zip = "0" + d.slice(0, 4);
        if (zip) found.push({ zip, start: m.index, end: m.index + m[0].length, standard: d.length === 5 });
    }
    return found;
}

const COUNTRY_WORDS = /\b(usa|u\.s\.a?\.?|united states(?: of america)?|us|canada|can|ca)\b/gi;

function countryFromField(value: string | null | undefined): "US" | "CA" | "" {
    const v = (value || "").trim().toLowerCase().replace(/\./g, "");
    if (["us", "usa", "united states", "united states of america", "america"].includes(v)) return "US";
    if (["ca", "can", "canada"].includes(v)) return "CA";
    return "";
}

export function analyzeLocation(text: string, stateField?: string | null, countryField?: string | null): PlaceInfo {
    let country = countryFromField(countryField) || countryInText(text);
    const ca = country === "US" ? null : findCanadianPostal(text);
    if (ca && !country) country = "CA";

    // "CA" is California or Canada. It's Canada next to a province code or a postal code,
    // California next to "US" or a California ZIP, and ignored when there's no telling.
    let candidates = regionCandidates(text);
    const caProvinceCode = candidates.some(c => c.byCode && c.region.iso.startsWith("CA-"));
    const tokens = zipTokens(text);
    const californiaZip = tokens.some(t => t.standard && zipState(t.zip) === "CA");
    const keepCalifornia = country === "US" || (!country && !caProvinceCode && californiaZip);
    candidates = candidates.filter(c => !(c.byCode && c.region.code === "CA") || keepCalifornia);
    if (!country && caProvinceCode) country = "CA";

    let region: Region | null = stateField ? regionFromField(stateField, country) : null;
    /** Where the state ends in the text; -1 when it came from its own field */
    let regionEnd = -1;
    if (!region) {
        const fitting = candidates.filter(c => !country || c.region.iso.startsWith(country + "-"));
        const last = fitting.length ? fitting[fitting.length - 1] : null;
        region = last ? last.region : null;
        regionEnd = last ? last.end : -1;
    }
    if (!country && region) country = region.iso.slice(0, 2) as "US" | "CA";

    // US ZIP: the last number that is a real ZIP in the row's state (earlier numbers are often house numbers).
    // Mangled forms only count as the last number, after the state: "US, MA, 2134" but not "1234 Main St, Boston, MA".
    let zip: PlaceInfo["zip"] = null;
    let zipSpan: [number, number] | null = null;
    if (country !== "CA") {
        const lastNumber = [...text.matchAll(/\d+/g)].pop();
        for (const t of [...tokens].reverse()) {
            if (!t.standard && (!region || t.start < regionEnd || !lastNumber || lastNumber.index >= t.end)) continue;
            const at = zipCentre(t.zip);
            const st = zipState(t.zip);
            if (!at || !st) continue;
            if (region ? region.iso !== `US-${st}` : country !== "US") continue;
            zip = { code: t.zip, at };
            zipSpan = [t.start, t.end];
            if (!region) region = regionByIso(`US-${st}`);
            country = "US";
            break;
        }
    }

    const withoutCode = zipSpan ? text.slice(0, zipSpan[0]) + " " + text.slice(zipSpan[1]) : ca ? ca.rest : text;
    const street = /\d/.test(withoutCode);
    let leftover = withoutCode;
    if (zip) {
        for (const c of regionCandidates(withoutCode).reverse()) {
            if (c.region === region) leftover = leftover.slice(0, c.pos) + " " + leftover.slice(c.end);
        }
    }
    leftover = leftover.replace(COUNTRY_WORDS, " ").replace(/[\s,.;:/\-#]+/g, "");
    return {
        country,
        region,
        zip,
        ca,
        caCentre: ca ? fsaCentre(ca.fsa) : null,
        street,
        zipOnly: !!zip && leftover === ""
    };
}

/** Great-circle distance in km */
export function distanceKm(a: [number, number], b: [number, number]): number {
    const rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad;
    const dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
