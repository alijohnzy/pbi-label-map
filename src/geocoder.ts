"use strict";

/**
 * Turns Location text into coordinates.
 *
 * Results are cached in memory and serialized into the report (see Visual.persistGeocodes),
 * so a saved report doesn't geocode again for every viewer. Lookups that fail are remembered
 * for the session only, so they are retried the next time the report opens.
 */

export type GeoProvider = "osm" | "azure";
export type GeoPart = "street" | "city" | "county" | "state" | "postalcode" | "country";

export interface GeoQuery {
    /** Cache key: provider, country filter and the location text */
    key: string;
    /** Free-form text, parts joined most specific first */
    text: string;
    /** Set when every Location field had a known data category */
    parts: Partial<Record<GeoPart, string>> | null;
}

export interface GeoConfig {
    provider: GeoProvider;
    azureKey: string;
    /** Upper-case ISO 3166-1 alpha-2 codes, empty for no filter */
    countries: string[];
}

export type GeoStop = "" | "blocked" | "refused" | "badKey" | "noKey" | "failing";

const OSM_URL = "https://nominatim.openstreetmap.org/search";
const AZURE_URL = "https://atlas.microsoft.com/geocode:batch?api-version=2025-01-01";
const OSM_SPACING_MS = 1100; // Nominatim policy: at most 1 request per second
const AZURE_BATCH = 100;
const MAX_CACHE = 5000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_FAILURES = 3; // consecutive timeouts or server errors before giving up for this session

export function cacheKey(cfg: GeoConfig, text: string): string {
    return `${cfg.provider}|${cfg.countries.join(",")}|${text.toLowerCase()}`;
}

export class Geocoder {
    private hits = new Map<string, [number, number]>();
    private misses = new Set<string>();
    private pending = new Map<string, GeoQuery>();
    private cfg: GeoConfig | null = null;
    private running = false;
    private newHits = 0;
    public stop: GeoStop = "";
    public done = 0;
    public total = 0;
    /** Last problem seen, e.g. "HTTP 503" or "timed out", shown in the map's note */
    public lastError = "";
    private failures = 0;

    constructor(private onProgress: () => void, private onDrained: () => void) { }

    public get busy(): boolean {
        return this.running || this.pending.size > 0;
    }

    public get unsaved(): number {
        return this.newHits;
    }

    /** Coordinates for a key: a pair, null when not found, undefined when unknown yet */
    public lookup(key: string): [number, number] | null | undefined {
        const hit = this.hits.get(key);
        if (hit) return hit;
        return this.misses.has(key) ? null : undefined;
    }

    /** Loads cache lines written by serialize(): key \t lat \t lon */
    public load(text: string) {
        if (!text) return;
        for (const line of text.split("\n")) {
            const [key, lat, lon] = line.split("\t");
            const la = Number(lat);
            const lo = Number(lon);
            if (key && Number.isFinite(la) && Number.isFinite(lo) && !this.hits.has(key)) {
                this.hits.set(key, [la, lo]);
            }
        }
    }

    public serialize(): string {
        const entries = [...this.hits.entries()].slice(-MAX_CACHE);
        this.newHits = 0;
        return entries.map(([k, [la, lo]]) => `${k}\t${la.toFixed(6)}\t${lo.toFixed(6)}`).join("\n");
    }

    /** Applies the current settings. A change (e.g. switching service) clears the queue and any stop. */
    public configure(cfg: GeoConfig) {
        if (this.cfg && JSON.stringify(this.cfg) === JSON.stringify(cfg)) return;
        this.pending.clear();
        this.stop = "";
        this.failures = 0;
        this.lastError = "";
        this.done = 0;
        this.total = 0;
        this.cfg = cfg;
    }

    /** Queues lookups that aren't cached, pending or known misses, and starts the worker */
    public request(queries: GeoQuery[], cfg: GeoConfig) {
        this.configure(cfg);
        if (this.stop) return;
        if (cfg.provider === "azure" && !cfg.azureKey) {
            if (queries.some(q => this.lookup(q.key) === undefined)) this.stop = "noKey";
            return;
        }

        let added = 0;
        for (const q of queries) {
            if (this.lookup(q.key) !== undefined || this.pending.has(q.key)) continue;
            this.pending.set(q.key, q);
            added++;
        }
        if (added) {
            if (!this.running) {
                this.done = 0;
                this.total = 0;
            }
            this.total += added;
            this.run();
        }
    }

    private async run() {
        if (this.running) return;
        this.running = true;
        try {
            while (this.pending.size && !this.stop) {
                const cfg = this.cfg;
                if (cfg.provider === "azure") {
                    const batch = [...this.pending.values()].slice(0, AZURE_BATCH);
                    await this.azureBatch(batch, cfg);
                    batch.forEach(q => this.pending.delete(q.key));
                    this.done += batch.length;
                } else {
                    const q = this.pending.values().next().value as GeoQuery;
                    await this.osm(q, cfg);
                    this.pending.delete(q.key);
                    this.done++;
                    this.onProgress();
                    if (this.pending.size && !this.stop) await sleep(OSM_SPACING_MS);
                }
                if (cfg !== this.cfg) continue; // settings changed mid-run; request() already reset the queue
                this.onProgress();
            }
        } finally {
            this.running = false;
            if (this.stop) this.pending.clear();
            this.onDrained();
        }
    }

    /** Seconds left at the current pace */
    public secondsLeft(): number {
        const left = Math.max(0, this.total - this.done);
        if (!this.cfg) return 0;
        return this.cfg.provider === "azure" ? Math.ceil(left / AZURE_BATCH) * 2 : Math.ceil(left * OSM_SPACING_MS / 1000);
    }

    /** fetch with a timeout; returns null (and records why) when the request didn't complete */
    private async send(url: string, init: RequestInit): Promise<Response | null> {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, { ...init, signal: ctrl.signal });
            if (res.status >= 500) this.fail(`HTTP ${res.status}`);
            else this.failures = 0;
            return res;
        } catch (e) {
            if (ctrl.signal.aborted) {
                this.fail("timed out");
            } else {
                // CSP/web-access block, offline, or a response without CORS headers
                this.lastError = "network error";
                this.stop = "blocked";
            }
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    private fail(reason: string) {
        this.lastError = reason;
        if (++this.failures >= MAX_FAILURES) this.stop = "failing";
    }

    private record(key: string, lat: number, lon: number) {
        if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
            this.hits.set(key, [lat, lon]);
            this.newHits++;
        } else {
            this.misses.add(key);
        }
    }

    private async osm(q: GeoQuery, cfg: GeoConfig) {
        const params = new URLSearchParams({ format: "jsonv2", limit: "1", addressdetails: "0" });
        if (q.parts) {
            for (const [part, value] of Object.entries(q.parts)) params.set(part, value);
        } else {
            params.set("q", q.text);
        }
        if (cfg.countries.length) params.set("countrycodes", cfg.countries.join(",").toLowerCase());

        const res = await this.send(`${OSM_URL}?${params.toString()}`, { headers: { Accept: "application/json" } });
        if (!res) return;
        if (res.status === 429 || res.status === 403) {
            this.lastError = `HTTP ${res.status}`;
            this.stop = "refused";
            return;
        }
        if (!res.ok) {
            this.misses.add(q.key);
            return;
        }
        try {
            const json = await res.json() as Array<{ lat: string; lon: string }>;
            if (json.length) this.record(q.key, Number(json[0].lat), Number(json[0].lon));
            else this.misses.add(q.key);
        } catch {
            this.misses.add(q.key);
        }
    }

    private async azureBatch(batch: GeoQuery[], cfg: GeoConfig) {
        const filter = cfg.countries.length > 0;
        const body = {
            batchItems: batch.map((q, i) => ({ query: q.text, top: filter ? 5 : 1, optionalId: String(i) }))
        };
        const res = await this.send(AZURE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "subscription-key": cfg.azureKey },
            body: JSON.stringify(body)
        });
        if (!res) return;
        if (res.status === 401 || res.status === 403) {
            this.stop = "badKey";
            return;
        }
        if (res.status === 429) {
            this.stop = "refused";
            return;
        }
        if (!res.ok) {
            batch.forEach(q => this.misses.add(q.key));
            return;
        }
        try {
            const json = await res.json() as AzureBatchResponse;
            json.batchItems.forEach((item, i) => {
                const q = batch[i];
                const features = (item && item.features) || [];
                const match = filter
                    ? features.find(f => cfg.countries.includes(countryOf(f)))
                    : features[0];
                if (match) this.record(q.key, match.geometry.coordinates[1], match.geometry.coordinates[0]);
                else this.misses.add(q.key);
            });
        } catch {
            batch.forEach(q => this.misses.add(q.key));
        }
    }
}

interface AzureFeature {
    geometry: { coordinates: [number, number] };
    properties?: { address?: { countryRegion?: { ISO?: string } } };
}

interface AzureBatchResponse {
    batchItems: Array<{ features?: AzureFeature[]; error?: unknown }>;
}

function countryOf(f: AzureFeature): string {
    const iso = f.properties && f.properties.address && f.properties.address.countryRegion
        && f.properties.address.countryRegion.ISO;
    return (iso || "").toUpperCase();
}

function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

/** "ca, US;mx" -> ["CA", "US", "MX"] (two-letter codes only) */
export function parseCountries(text: string): string[] {
    return (text || "")
        .split(/[\s,;]+/)
        .map(s => s.trim().toUpperCase())
        .filter(s => /^[A-Z]{2}$/.test(s));
}
