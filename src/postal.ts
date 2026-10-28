"use strict";

/**
 * Canadian postal codes. OpenStreetMap has almost none of them (Canada Post owns the data), so
 * lookups like "CA AB T0J 3E0" fail there. We use the postal area instead: the first three
 * characters (the FSA), whose centre comes from a bundled table of about 1,600 FSAs.
 */

import caFsa from "./data/caFsa.json";

const FSA = caFsa as unknown as Record<string, [number, number]>;

// Letters D, F, I, O, Q, U never appear; W and Z never start a code.
// A letter O where a digit belongs is a typed zero ("TOJ 3EO" is T0J 3E0).
const CA_POSTAL = /\b([ABCEGHJ-NPRSTVXY][\dO][ABCEGHJ-NPRSTV-Z])[ -]?([\dO][ABCEGHJ-NPRSTV-Z][\dO])?\b/gi;

const PROVINCE_WORDS = new Set([
    "ab", "alberta", "bc", "british", "columbia", "mb", "manitoba", "nb", "new", "brunswick",
    "nl", "newfoundland", "and", "labrador", "ns", "nova", "scotia", "nt", "northwest", "territories",
    "nu", "nunavut", "on", "ontario", "pe", "pei", "prince", "edward", "island", "qc", "quebec", "québec",
    "sk", "saskatchewan", "yt", "yukon", "ca", "can", "canada"
]);

export interface CanadianPostal {
    /** Postal area (first three characters), upper case */
    fsa: string;
    /** The location text without the postal code */
    rest: string;
    /** True when the rest is only province and country words, so there's nothing better to look up */
    postalOnly: boolean;
}

export function findCanadianPostal(text: string): CanadianPostal | null {
    // A bare three-character token like "ON1" is too ambiguous unless a full code is present,
    // and a letter O read as zero needs the full code too (so "Row" isn't R0W)
    const saysCanada = /\bcanada\b|\bca\b|\bcan\b/i.test(text);
    const m = [...text.matchAll(CA_POSTAL)].find(x => x[2] || (saysCanada && !/o/i.test(x[0])));
    if (!m) return null;
    const fsa = m[1].toUpperCase().replace(/^(.)O/, (_, first: string) => first + "0");
    const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length))
        .replace(/\s+,/g, ",")
        .replace(/,(\s*,)+/g, ",")
        .replace(/,(?=\S)/g, ", ")
        .replace(/^[\s,]+|[\s,]+$/g, "")
        .replace(/\s{2,}/g, " ");
    const words = rest.toLowerCase().split(/[^a-zà-ÿ]+/).filter(Boolean);
    return { fsa, rest, postalOnly: words.every(w => PROVINCE_WORDS.has(w)) };
}

/** Centre of a postal area, or null when the table doesn't have it */
export function fsaCentre(fsa: string): [number, number] | null {
    return FSA[fsa] || null;
}
