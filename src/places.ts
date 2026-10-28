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
    const californiaZip = [...text.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].some(m => zipState(m[1]) === "CA");
    const keepCalifornia = country === "US" || (!country && !caProvinceCode && californiaZip);
    candidates = candidates.filter(c => !(c.byCode && c.region.code === "CA") || keepCalifornia);
    if (!country && caProvinceCode) country = "CA";

    let region: Region | null = stateField ? regionFromField(stateField, country) : null;
    if (!region) {
        const fitting = candidates.filter(c => !country || c.region.iso.startsWith(country + "-"));
        region = fitting.length ? fitting[fitting.length - 1].region : null;
    }
    if (!country && region) country = region.iso.slice(0, 2) as "US" | "CA";

    // US ZIP: the last 5-digit number that is a real ZIP in the row's state (earlier numbers are often house numbers)
    let zip: PlaceInfo["zip"] = null;
    let zipSpan: [number, number] | null = null;
    if (country !== "CA") {
        const nums = [...text.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].reverse();
        for (const m of nums) {
            const at = zipCentre(m[1]);
            const st = zipState(m[1]);
            if (!at || !st) continue;
            if (region ? region.iso !== `US-${st}` : country !== "US") continue;
            zip = { code: m[1], at };
            zipSpan = [m.index, m.index + m[0].length];
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
