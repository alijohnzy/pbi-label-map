"use strict";

import powerbi from "powerbi-visuals-api";
import * as L from "leaflet";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import * as valueFormatter from "powerbi-visuals-utils-formattingutils/lib/valueFormatter";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import worldTopo from "world-atlas/countries-110m.json";

import "leaflet/dist/leaflet.css";
import "./../style/visual.less";

import { VisualFormattingSettingsModel } from "./settings";
import { Geocoder, GeoConfig, GeoPart, GeoQuery, GeoProvider, cacheKey, parseCountries } from "./geocoder";
import { findCanadianPostal, fsaCentre } from "./postal";

import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import VisualUpdateType = powerbi.VisualUpdateType;
import IVisualEventService = powerbi.extensibility.IVisualEventService;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import ITooltipService = powerbi.extensibility.ITooltipService;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;
import DataView = powerbi.DataView;
import DataViewMetadataColumn = powerbi.DataViewMetadataColumn;
import PrimitiveValue = powerbi.PrimitiveValue;
import ViewMode = powerbi.ViewMode;

interface TileDef {
    url: string;
    attribution: string;
    maxZoom: number;
    subdomains?: string;
    /** Which key the provider needs; it's appended to the URL */
    needs?: "azure" | "carto";
    /** Optional label layer drawn on top of the base tiles */
    overlay?: string;
}

const AZURE_TILE = "https://atlas.microsoft.com/map/tile?api-version=2024-04-01&tileSize=256&zoom={z}&x={x}&y={y}&tilesetId=";
const AZURE_ATTRIBUTION = `© ${new Date().getFullYear()} TomTom, Microsoft`;
const CARTO_ATTRIBUTION = "© OpenStreetMap contributors © CARTO";

const TILES: Record<string, TileDef> = {
    azureRoad: { url: AZURE_TILE + "microsoft.base.road", attribution: AZURE_ATTRIBUTION, maxZoom: 22, needs: "azure" },
    azureDark: { url: AZURE_TILE + "microsoft.base.darkgrey", attribution: AZURE_ATTRIBUTION, maxZoom: 22, needs: "azure" },
    azureImagery: { url: AZURE_TILE + "microsoft.imagery", attribution: AZURE_ATTRIBUTION, maxZoom: 19, needs: "azure" },
    cartoLight: {
        url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        attribution: CARTO_ATTRIBUTION, maxZoom: 20, subdomains: "abcd", needs: "carto"
    },
    cartoVoyager: {
        url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        attribution: CARTO_ATTRIBUTION, maxZoom: 20, subdomains: "abcd", needs: "carto"
    },
    cartoDark: {
        url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        attribution: CARTO_ATTRIBUTION, maxZoom: 20, subdomains: "abcd", needs: "carto"
    },
    esriStreets: {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
        attribution: "Tiles © Esri",
        maxZoom: 19
    },
    esriGray: {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        overlay: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
        attribution: "Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors",
        maxZoom: 16
    },
    esriImagery: {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attribution: "Tiles © Esri, Maxar, Earthstar Geographics",
        maxZoom: 19
    },
    osm: {
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: "© OpenStreetMap contributors",
        maxZoom: 19
    }
};

const BASEMAP_NAMES: Record<string, string> = {
    azureRoad: "Road (Azure Maps)", azureDark: "Dark grey (Azure Maps)", azureImagery: "Satellite (Azure Maps)",
    cartoLight: "Light (CARTO)", cartoVoyager: "Streets (CARTO)", cartoDark: "Dark (CARTO)"
};

interface MapKeys {
    azure: string;
    carto: string;
}

/** Picks the base map to draw: resolves Auto, and falls back to Esri when the chosen one lacks its key */
function resolveBasemap(choice: string, keys: MapKeys): { id: string; missingFor: string } {
    if (choice === "auto") {
        return { id: keys.azure ? "azureRoad" : keys.carto ? "cartoLight" : "esriStreets", missingFor: "" };
    }
    const def = TILES[choice];
    if (def && def.needs && !keys[def.needs]) {
        return { id: "esriStreets", missingFor: choice };
    }
    return { id: choice, missingFor: "" };
}

function tileUrl(def: TileDef, keys: MapKeys): string {
    if (def.needs === "azure") return `${def.url}&subscription-key=${encodeURIComponent(keys.azure)}`;
    if (def.needs === "carto") return `${def.url}?key=${encodeURIComponent(keys.carto)}`;
    return def.url;
}

interface MapPoint {
    lat: number;
    lon: number;
    name: string | null;
    legend: string | null;
    labelText: string;
    /** Text drawn inside the bubble */
    bubbleText: string;
    /** Postal area used when the exact location couldn't be found, e.g. "T0J" */
    approx: string | null;
    priority: number;
    radius: number;
    color: string;
    identity: ISelectionId;
    tooltip: VisualTooltipDataItem[];
    marker?: L.CircleMarker;
    textTip?: L.Tooltip;
}

const TILE_ERROR_THRESHOLD = 3;
const GEO_RENDER_MS = 800; // redraw at most this often while locations stream in
const GEO_FIT_MS = 4000; // and re-zoom at most this often
const GEO_PERSIST_MS = 8000;

/** Most specific first, for joining multi-field locations into one query */
const GEO_RANK: Array<[keyof powerbi.GeographyTypeDescriptor, GeoPart | null, number]> = [
    ["address", "street", 0],
    ["place", null, 0],
    ["city", "city", 1],
    ["county", "county", 2],
    ["stateOrProvince", "state", 3],
    ["region", null, 3],
    ["postalCode", "postalcode", 4],
    ["country", "country", 5],
    ["continent", null, 6]
];
const LABEL_FONT = '"Segoe UI", wf_segoe-ui_normal, helvetica, arial, sans-serif';
const DARK_BASEMAPS = new Set(["cartoDark", "esriImagery", "azureDark", "azureImagery"]);

export class Visual implements IVisual {
    private host: IVisualHost;
    private events: IVisualEventService;
    private selectionManager: ISelectionManager;
    private tooltipService: ITooltipService;
    private formattingSettingsService: FormattingSettingsService;
    private settings: VisualFormattingSettingsModel;

    private root: HTMLElement;
    private mapEl: HTMLElement;
    private noticeEl: HTMLElement;
    private emptyEl: HTMLElement;

    private map: L.Map;
    private zoomControl: L.Control.Zoom;
    private legendControl: L.Control | null = null;
    private markerLayer: L.LayerGroup;
    private baseLayer: L.Layer | null = null;
    private basemapKey = "";
    private basemapState = "";
    private basemapMissingFor = "";
    private outlineData: GeoJSON.FeatureCollection | null = null;

    private points: MapPoint[] = [];
    private labelOrder: MapPoint[] = [];
    private dataSignature = "";
    private hasFitted = false;
    private declutterQueued = false;
    private tileStats = { loads: 0, errors: 0 };
    private skippedRows = 0;
    private allowInteractions = true;
    private measureCtx: CanvasRenderingContext2D;
    private hasSizeField = false;

    private geocoder: Geocoder;
    private attribution: L.Control.Attribution;
    private geoAttribution = "";
    private lastDataView: DataView | null = null;
    private canPersist = false;
    private loadedCache = "";
    private lastPersist = 0;
    private lastFit = 0;
    private geoRenderTimer = 0;
    private geoWaiting = 0;
    private geoNotFound: string[] = [];
    private geoApprox = 0;
    private textOrder: MapPoint[] = [];
    private lastAzureKeyLegacy = "";

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.events = options.host.eventService;
        this.selectionManager = options.host.createSelectionManager();
        this.tooltipService = options.host.tooltipService;
        this.formattingSettingsService = new FormattingSettingsService();
        const caps = options.host.hostCapabilities;
        this.allowInteractions = !caps || caps.allowInteractions !== false;
        this.measureCtx = document.createElement("canvas").getContext("2d");
        this.geocoder = new Geocoder(() => this.onGeoProgress(), () => this.onGeoDrained());

        this.root = document.createElement("div");
        this.root.className = "plm-root";
        this.mapEl = document.createElement("div");
        this.mapEl.className = "plm-map";
        this.noticeEl = document.createElement("div");
        this.noticeEl.className = "plm-notice";
        this.emptyEl = document.createElement("div");
        this.emptyEl.className = "plm-empty";
        this.root.append(this.mapEl, this.noticeEl, this.emptyEl);
        options.element.appendChild(this.root);

        this.map = L.map(this.mapEl, {
            zoomControl: false,
            attributionControl: false,
            preferCanvas: true,
            worldCopyJump: true,
            minZoom: 1,
            zoomSnap: 0.5
        });
        this.attribution = L.control.attribution({ prefix: false, position: "bottomright" }).addTo(this.map);
        this.zoomControl = L.control.zoom({ position: "topleft" });
        this.map.createPane("plm-base").style.zIndex = "150";
        this.markerLayer = L.layerGroup().addTo(this.map);
        this.map.setView([30, -40], 2);

        this.map.on("click", () => {
            if (!this.allowInteractions) return;
            this.selectionManager.clear().then(() => this.applySelection([]));
        });
        this.map.on("contextmenu", (e: L.LeafletMouseEvent) => {
            L.DomEvent.preventDefault(e.originalEvent);
            this.selectionManager.showContextMenu({}, { x: e.originalEvent.clientX, y: e.originalEvent.clientY });
        });
        this.map.on("zoomend moveend resize", () => this.queueDeclutter());

        this.selectionManager.registerOnSelectCallback((ids: ISelectionId[]) => this.applySelection(ids));
    }

    public update(options: VisualUpdateOptions) {
        this.events.renderingStarted(options);
        try {
            const dataView: DataView | undefined = options.dataViews && options.dataViews[0];
            this.settings = this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView);
            this.settings.syncVisibility();

            this.root.style.width = `${options.viewport.width}px`;
            this.root.style.height = `${options.viewport.height}px`;
            this.map.invalidateSize({ pan: false });

            const onlyResize = (options.type & (VisualUpdateType.Data | VisualUpdateType.Style)) === 0
                && this.points.length > 0;
            if (onlyResize) {
                this.queueDeclutter();
                this.events.renderingFinished(options);
                return;
            }

            // v1.2 kept the Azure key under Geocoding; still honor it
            const geoObj = dataView && dataView.metadata && dataView.metadata.objects && dataView.metadata.objects.geocoding;
            this.lastAzureKeyLegacy = geoObj && typeof geoObj.azureKey === "string" ? geoObj.azureKey : "";

            this.applyMapSettings();
            this.applyLabelStyle();

            // Geocodes are saved into the report only while editing (Desktop, or Edit in the service)
            this.canPersist = options.viewMode === ViewMode.Edit || options.viewMode === ViewMode.InFocusEdit;
            this.loadSavedGeocodes(dataView);
            this.lastDataView = dataView || null;
            this.renderData(true);

            this.events.renderingFinished(options);
        } catch (error) {
            this.events.renderingFailed(options, String(error));
        }
    }

    /** Parses the current data view and redraws points, legend, zoom and notices */
    private renderData(allowFit: boolean) {
        const dataView = this.lastDataView;
        const table = dataView && dataView.table;
        const cols = table ? table.columns : [];
        const has = (role: string) => cols.some(c => c.roles && c.roles[role]);
        const hasCoords = has("latitude") && has("longitude");
        if (!table || (!hasCoords && !has("location"))) {
            this.clearPoints();
            this.showEmpty("Add Location (or Latitude and Longitude) to plot points.\nPut the value you want printed on each point in Label value.");
            this.updateNotice();
            return;
        }

        this.points = this.parse(dataView);
        const provider = String(this.settings.geocoding.provider.value.value);
        this.setGeoAttribution(!has("location") ? ""
            : provider === "osm" ? "Geocoding © OpenStreetMap contributors (Nominatim)"
                : "Geocoding © Microsoft Azure Maps");
        const waiting = this.geocoder.busy && this.geoWaiting > 0;
        this.showEmpty(this.points.length || waiting ? "" : "No rows could be placed on the map.");
        this.renderPoints();
        this.renderLegend();
        if (allowFit) this.fitIfNeeded();
        this.applySelection(this.selectionManager.getSelectionIds() as ISelectionId[]);
        this.updateNotice();
        this.queueDeclutter();
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.settings);
    }

    public destroy(): void {
        this.map.remove();
    }

    // ---------- data ----------

    private parse(dataView: DataView): MapPoint[] {
        const table = dataView.table;
        const cols = table.columns;
        const roleIndex = (role: string) => cols.findIndex(c => c.roles && c.roles[role]);
        const latI = roleIndex("latitude");
        const lonI = roleIndex("longitude");
        const locIs = orderLocationColumns(cols);
        const legendI = roleIndex("legend");
        const labelI = roleIndex("labelValue");
        const sizeI = roleIndex("size");
        const tooltipIs = cols.map((c, i) => (c.roles && c.roles.tooltips ? i : -1)).filter(i => i >= 0);
        this.hasSizeField = sizeI >= 0;

        const s = this.settings;
        const labelCol = labelI >= 0 ? cols[labelI] : null;
        const labelNumeric = !!(labelCol && labelCol.type && (labelCol.type.numeric || labelCol.type.integer));

        let maxAbsLabel = 0;
        let maxAbsSize = 0;
        for (const row of table.rows) {
            if (labelNumeric) maxAbsLabel = Math.max(maxAbsLabel, Math.abs(Number(row[labelI]) || 0));
            if (sizeI >= 0) maxAbsSize = Math.max(maxAbsSize, Math.abs(Number(row[sizeI]) || 0));
        }

        const l = s.labels;
        const bt = s.bubbleText;
        const labelFormatter = labelNumeric
            ? this.makeFormatter(labelCol, maxAbsLabel, l.displayUnits.value, l.decimals.value.value) : null;
        const sizeCol = sizeI >= 0 ? cols[sizeI] : null;
        const sizeNumeric = !!(sizeCol && sizeCol.type && (sizeCol.type.numeric || sizeCol.type.integer));
        const btContent = bt.show.value ? String(bt.content.value.value) : "";
        const btFormatter = btContent === "size" && sizeNumeric
            ? this.makeFormatter(sizeCol, maxAbsSize, bt.displayUnits.value, bt.decimals.value.value)
            : btContent === "label" && labelNumeric
                ? this.makeFormatter(labelCol, maxAbsLabel, bt.displayUnits.value, bt.decimals.value.value)
                : null;
        const palette = this.host.colorPalette;
        const highContrast = palette.isHighContrast;
        const baseColor = highContrast ? palette.foreground.value : s.bubbles.fill.value.value;
        const minR = Math.min(s.bubbles.minRadius.value, s.bubbles.maxRadius.value);
        const maxR = Math.max(s.bubbles.minRadius.value, s.bubbles.maxRadius.value);
        const content = String(s.labels.content.value.value);

        const points: MapPoint[] = [];
        this.skippedRows = 0;
        const geoCfg = this.geoConfig();
        const toGeocode = new Map<string, GeoQuery>();
        const notFound = new Set<string>();
        let waiting = 0;
        let approxCount = 0;

        table.rows.forEach((row, i) => {
            const loc = locationOf(row, cols, locIs);
            let lat = latI >= 0 ? toNumber(row[latI]) : null;
            let lon = lonI >= 0 ? toNumber(row[lonI]) : null;
            const hasLatLon = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

            // Latitude/Longitude win when the row has them; otherwise geocode the Location text
            let approx: string | null = null;
            if (!hasLatLon) {
                if (!loc) {
                    this.skippedRows++;
                    return;
                }
                const coords = this.locate(loc, geoCfg, toGeocode);
                if (coords === "waiting") {
                    waiting++;
                    return;
                }
                if (coords === null) {
                    notFound.add(loc.text);
                    return;
                }
                [lat, lon] = coords.at;
                approx = coords.approx;
                if (approx) approxCount++;
            }

            const name = loc ? loc.text : null;
            const legend = legendI >= 0 && row[legendI] != null ? String(row[legendI]) : null;
            const rawLabel = labelI >= 0 ? row[labelI] : null;

            let valueText = "";
            if (rawLabel != null && rawLabel !== "") {
                valueText = labelFormatter
                    ? labelFormatter.format(rawLabel)
                    : formatValue(rawLabel, labelCol, this.host.locale);
            }
            const labelText = composeLabel(content, name, valueText);

            let bubbleText = "";
            const rawBt = btContent === "size" ? (sizeI >= 0 ? row[sizeI] : null)
                : btContent === "label" ? rawLabel
                    : btContent === "location" ? name : null;
            if (rawBt != null && rawBt !== "") {
                bubbleText = btFormatter ? btFormatter.format(rawBt)
                    : btContent === "location" ? String(rawBt)
                        : formatValue(rawBt, btContent === "size" ? sizeCol : labelCol, this.host.locale);
            }

            let radius = s.bubbles.radius.value;
            if (sizeI >= 0) {
                const v = Math.abs(Number(row[sizeI]) || 0);
                radius = maxAbsSize > 0 ? minR + (maxR - minR) * Math.sqrt(v / maxAbsSize) : minR;
            }

            const color = legend !== null && !highContrast ? palette.getColor(legend).value : baseColor;

            const priorityRaw = labelNumeric ? Number(rawLabel) : sizeI >= 0 ? Number(row[sizeI]) : 0;

            points.push({
                lat,
                lon,
                name,
                legend,
                labelText,
                bubbleText,
                approx,
                priority: Number.isFinite(priorityRaw) ? Math.abs(priorityRaw) : 0,
                radius,
                color,
                identity: this.host.createSelectionIdBuilder().withTable(table, i).createSelectionId(),
                tooltip: approx
                    ? [...this.buildTooltip(row, cols, [...locIs, legendI, labelI, sizeI, ...tooltipIs]),
                        { displayName: "Placed at", value: `Postal area ${approx} (approximate)` }]
                    : this.buildTooltip(row, cols, [...locIs, legendI, labelI, sizeI, ...tooltipIs])
            });
        });

        this.geoWaiting = waiting;
        this.geoNotFound = [...notFound];
        this.geoApprox = approxCount;
        if (toGeocode.size) this.geocoder.request([...toGeocode.values()], geoCfg);
        return points;
    }

    // ---------- geocoding ----------

    /**
     * Coordinates for a row's Location: from the geocoding cache, or the Canadian postal-area table.
     * Queues a lookup and returns "waiting" when the answer isn't known yet.
     */
    private locate(loc: RowLocation, cfg: GeoConfig, queue: Map<string, GeoQuery>):
        { at: [number, number]; approx: string | null } | "waiting" | null {
        const ca = findCanadianPostal(loc.text);
        const centre = ca ? fsaCentre(ca.fsa) : null;
        let text = loc.text;
        let parts = loc.parts;

        // OpenStreetMap doesn't know Canadian postal codes: use the rest of the location,
        // or go straight to the postal area when there's nothing else to look up
        if (ca && cfg.provider === "osm") {
            if (ca.postalOnly && centre) return { at: centre, approx: ca.fsa };
            text = ca.rest;
            if (parts) {
                parts = { ...parts };
                delete parts.postalcode;
            }
        }

        const key = cacheKey(cfg, text);
        const found = this.geocoder.lookup(key);
        if (found === undefined) {
            if (this.geocoder.stop && centre) return { at: centre, approx: ca.fsa };
            queue.set(key, { key, text, parts });
            return "waiting";
        }
        if (found === null) return centre ? { at: centre, approx: ca.fsa } : null;
        return { at: found, approx: null };
    }

    private geoConfig(): GeoConfig {
        const g = this.settings.geocoding;
        return {
            provider: String(g.provider.value.value) as GeoProvider,
            azureKey: this.mapKeys().azure,
            countries: parseCountries(g.countries.value)
        };
    }

    private setGeoAttribution(text: string) {
        if (text === this.geoAttribution) return;
        if (this.geoAttribution) this.attribution.removeAttribution(this.geoAttribution);
        if (text) this.attribution.addAttribution(text);
        this.geoAttribution = text;
    }

    private loadSavedGeocodes(dataView: DataView | undefined) {
        const objects = dataView && dataView.metadata && dataView.metadata.objects;
        const saved = objects && objects.geocoding && objects.geocoding.cache;
        const text = typeof saved === "string" ? saved : "";
        if (text && text !== this.loadedCache) {
            this.geocoder.load(text);
            this.loadedCache = text;
        }
    }

    private onGeoProgress() {
        if (this.geoRenderTimer) return;
        this.geoRenderTimer = window.setTimeout(() => {
            this.geoRenderTimer = 0;
            const fitDue = Date.now() - this.lastFit > GEO_FIT_MS;
            this.renderData(fitDue);
            if (Date.now() - this.lastPersist > GEO_PERSIST_MS) this.persistGeocodes();
        }, GEO_RENDER_MS);
    }

    private onGeoDrained() {
        if (this.geoRenderTimer) {
            window.clearTimeout(this.geoRenderTimer);
            this.geoRenderTimer = 0;
        }
        this.renderData(true);
        this.persistGeocodes();
    }

    /** Saves found coordinates into the report so viewers don't geocode again */
    private persistGeocodes() {
        if (!this.canPersist || this.geocoder.unsaved === 0) return;
        const text = this.geocoder.serialize();
        this.loadedCache = text;
        this.lastPersist = Date.now();
        this.host.persistProperties({
            merge: [{ objectName: "geocoding", selector: null, properties: { cache: text } }]
        });
    }

    private makeFormatter(col: DataViewMetadataColumn, maxAbs: number, unitsSetting: powerbi.EnumMemberValue,
        decimalsSetting: powerbi.EnumMemberValue) {
        const units = Number(unitsSetting) || 0;
        const decimals = String(decimalsSetting);
        return valueFormatter.create({
            format: col.format,
            value: units === 0 ? (maxAbs || 1) : units,
            precision: decimals === "auto" ? undefined : Number(decimals),
            cultureSelector: this.host.locale
        });
    }

    private buildTooltip(row: PrimitiveValue[], cols: DataViewMetadataColumn[], indexes: number[]): VisualTooltipDataItem[] {
        const seen = new Set<number>();
        const items: VisualTooltipDataItem[] = [];
        for (const i of indexes) {
            if (i < 0 || seen.has(i)) continue;
            seen.add(i);
            const v = row[i];
            items.push({
                displayName: cols[i].displayName,
                value: v == null ? "(Blank)" : formatValue(v, cols[i], this.host.locale)
            });
        }
        return items;
    }

    // ---------- rendering ----------

    private clearPoints() {
        this.markerLayer.clearLayers();
        this.points = [];
        this.labelOrder = [];
        this.dataSignature = "";
        this.renderLegend();
    }

    private renderPoints() {
        this.markerLayer.clearLayers();
        const s = this.settings;
        const showLabels = s.labels.show.value;
        const rawPos = String(s.labels.position.value.value);
        const pos = (rawPos === "center" ? "top" : rawPos) as L.Direction; // v1.1-1.3 had "Inside bubble" here
        const bt = s.bubbleText;
        const showText = bt.show.value;
        const fillOpacity = s.bubbles.opacity.value / 100;
        const highContrast = this.host.colorPalette.isHighContrast;
        const stroke = highContrast ? this.host.colorPalette.background.value : s.bubbles.strokeColor.value.value;

        // Bubble text: grow bubbles until the longest text fits. Growth is uniform (or a remap of the
        // Size range), so text length never reads as magnitude.
        if (showText && bt.fitBubble.value) {
            const fontSize = bt.fontSize.value;
            this.measureCtx.font = `${bt.bold.value ? 600 : 400} ${fontSize}px ${LABEL_FONT}`;
            let needed = 0;
            for (const p of this.points) {
                if (!p.bubbleText) continue;
                const w = this.measureCtx.measureText(p.bubbleText).width;
                needed = Math.max(needed, Math.hypot(w / 2, fontSize * 0.6) + 2);
            }
            if (needed > 0 && this.hasSizeField) {
                const minR = Math.min(s.bubbles.minRadius.value, s.bubbles.maxRadius.value);
                const maxR = Math.max(s.bubbles.minRadius.value, s.bubbles.maxRadius.value);
                if (needed > minR) {
                    const hi = Math.max(maxR, needed * 1.6);
                    const span = maxR - minR || 1;
                    for (const p of this.points) p.radius = needed + ((p.radius - minR) / span) * (hi - needed);
                }
            } else if (needed > 0) {
                for (const p of this.points) p.radius = Math.max(p.radius, needed);
            }
        }

        // Big bubbles first so small ones stay clickable on top
        const drawOrder = [...this.points].sort((a, b) => b.radius - a.radius);
        for (const p of drawOrder) {
            const marker = L.circleMarker([p.lat, p.lon], {
                radius: p.radius,
                fillColor: p.color,
                fillOpacity,
                color: stroke,
                weight: s.bubbles.strokeWidth.value,
                opacity: 1,
                bubblingMouseEvents: false
            });

            marker.on("click", (e: L.LeafletMouseEvent) => this.onPointClick(p, e.originalEvent));
            marker.on("contextmenu", (e: L.LeafletMouseEvent) => {
                L.DomEvent.preventDefault(e.originalEvent);
                this.selectionManager.showContextMenu(p.identity, { x: e.originalEvent.clientX, y: e.originalEvent.clientY });
            });
            marker.on("mouseover mousemove", (e: L.LeafletMouseEvent) => this.showTooltip(p, e.originalEvent));
            marker.on("mouseout", () => this.tooltipService.hide({ isTouchEvent: false, immediately: false }));

            if (showLabels && p.labelText) {
                marker.bindTooltip(this.labelElement(p.labelText, null), {
                    permanent: true,
                    interactive: false,
                    direction: pos,
                    offset: labelOffset(pos, p.radius),
                    className: "plm-label",
                    opacity: 1
                });
            }

            p.marker = marker;
            p.textTip = undefined;
            this.markerLayer.addLayer(marker);

            if (showText && p.bubbleText) {
                const color = highContrast ? this.host.colorPalette.foreground.value
                    : bt.autoColor.value ? contrastText(p.color, fillOpacity, this.darkBase()) : bt.fontColor.value.value;
                const tip = L.tooltip({
                    permanent: true,
                    interactive: false,
                    direction: "center",
                    className: "plm-bt",
                    opacity: 1
                }).setLatLng([p.lat, p.lon]).setContent(this.labelElement(p.bubbleText, color));
                p.textTip = tip;
                this.markerLayer.addLayer(tip);
            }
        }

        // Declutter keeps the biggest values when texts collide
        const byPriority = (a: MapPoint, b: MapPoint) => b.priority - a.priority;
        this.textOrder = this.points.filter(p => p.textTip).sort(byPriority);
        this.labelOrder = this.points.filter(p => p.marker && p.marker.getTooltip()).sort(byPriority);
    }

    private darkBase(): boolean {
        return DARK_BASEMAPS.has(this.basemapKey);
    }

    private labelElement(text: string, color: string | null): HTMLElement {
        const el = document.createElement("div");
        if (color) el.style.color = color;
        for (const line of text.split("\n")) {
            const lineEl = document.createElement("div");
            lineEl.textContent = line;
            el.appendChild(lineEl);
        }
        return el;
    }

    private applyLabelStyle() {
        const l = this.settings.labels;
        const st = this.root.style;
        st.setProperty("--plm-font-size", `${l.fontSize.value}px`);
        st.setProperty("--plm-font-color", l.fontColor.value.value);
        st.setProperty("--plm-font-weight", l.bold.value ? "600" : "400");
        st.setProperty("--plm-label-bg", l.backgroundColor.value.value);
        this.root.classList.toggle("plm-nobg", !l.background.value);
        const bt = this.settings.bubbleText;
        st.setProperty("--plm-bt-size", `${bt.fontSize.value}px`);
        st.setProperty("--plm-bt-weight", bt.bold.value ? "600" : "400");
    }

    private mapKeys(): MapKeys {
        const sv = this.settings.services;
        const legacy = this.lastAzureKeyLegacy;
        return { azure: (sv.azureKey.value || legacy || "").trim(), carto: (sv.cartoKey.value || "").trim() };
    }

    private applyMapSettings() {
        const m = this.settings.map;
        const keys = this.mapKeys();
        const { id, missingFor } = resolveBasemap(String(m.basemap.value.value), keys);
        const def = TILES[id];
        const state = `${id}|${def && def.needs ? keys[def.needs] : ""}`;
        this.basemapMissingFor = missingFor;
        if (state !== this.basemapState) {
            this.basemapState = state;
            this.setBasemap(id, keys);
        }

        if (m.zoomControl.value) this.zoomControl.addTo(this.map);
        else this.zoomControl.remove();

        this.root.classList.toggle("plm-grey", m.greyscale.value);

        if (m.wheelZoom.value) this.map.scrollWheelZoom.enable();
        else this.map.scrollWheelZoom.disable();
    }

    private setBasemap(key: string, keys: MapKeys) {
        if (this.baseLayer) this.map.removeLayer(this.baseLayer);
        this.basemapKey = key;
        this.tileStats = { loads: 0, errors: 0 };

        const tile = TILES[key];
        if (tile) {
            const layer = L.tileLayer(tileUrl(tile, keys), {
                attribution: tile.attribution,
                maxZoom: tile.maxZoom,
                subdomains: tile.subdomains || "abc"
            });
            layer.on("tileload", () => { this.tileStats.loads++; this.updateNotice(); });
            layer.on("tileerror", () => { this.tileStats.errors++; this.updateNotice(); });
            this.baseLayer = tile.overlay
                ? L.layerGroup([layer, L.tileLayer(tile.overlay, { maxZoom: tile.maxZoom, zIndex: 2 })])
                : layer;
            this.map.setMaxZoom(tile.maxZoom);
            this.root.classList.remove("plm-ocean");
        } else {
            if (!this.outlineData) {
                const topo = worldTopo as unknown as Topology<{ countries: GeometryCollection }>;
                this.outlineData = feature(topo, topo.objects.countries) as GeoJSON.FeatureCollection;
            }
            this.baseLayer = L.geoJSON(this.outlineData, {
                pane: "plm-base",
                interactive: false,
                style: { color: "#9aa5b1", weight: 0.7, fillColor: "#f4f6f8", fillOpacity: 1 }
            });
            this.map.setMaxZoom(10);
            this.root.classList.add("plm-ocean");
        }
        this.baseLayer.addTo(this.map);
        this.updateNotice();
    }

    private renderLegend() {
        if (this.legendControl) {
            this.legendControl.remove();
            this.legendControl = null;
        }
        const s = this.settings;
        if (!s || !s.legend.show.value) return;

        const entries = new Map<string, string>();
        for (const p of this.points) {
            if (p.legend !== null && !entries.has(p.legend)) entries.set(p.legend, p.color);
        }
        if (!entries.size) return;

        const control = new L.Control({ position: String(s.legend.position.value.value) as L.ControlPosition });
        control.onAdd = () => {
            const box = L.DomUtil.create("div", "plm-legend");
            L.DomEvent.disableClickPropagation(box);
            L.DomEvent.disableScrollPropagation(box);
            let count = 0;
            for (const [label, color] of entries) {
                if (++count > 25) {
                    const more = L.DomUtil.create("div", "plm-legend-more", box);
                    more.textContent = `+${entries.size - 25} more`;
                    break;
                }
                const row = L.DomUtil.create("div", "plm-legend-row", box);
                const sw = L.DomUtil.create("span", "plm-swatch", row);
                sw.style.background = color;
                const text = L.DomUtil.create("span", "", row);
                text.textContent = label;
            }
            return box;
        };
        control.addTo(this.map);
        this.legendControl = control;
    }

    private fitIfNeeded() {
        if (!this.points.length) return;
        const sig = signature(this.points);
        const changed = sig !== this.dataSignature;
        this.dataSignature = sig;
        if (!changed) return;
        if (this.hasFitted && !this.settings.map.autoFit.value) return;

        this.lastFit = Date.now();
        if (this.points.length === 1) {
            this.map.setView([this.points[0].lat, this.points[0].lon], 9, { animate: false });
        } else {
            const bounds = L.latLngBounds(this.points.map(p => [p.lat, p.lon] as L.LatLngTuple));
            this.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 12, animate: false });
        }
        this.hasFitted = true;
    }

    // ---------- labels overlap ----------

    private queueDeclutter() {
        if (this.declutterQueued) return;
        this.declutterQueued = true;
        requestAnimationFrame(() => {
            this.declutterQueued = false;
            this.declutter();
        });
    }

    private declutter() {
        const tipEl = (t: L.Tooltip | undefined) => (t ? t.getElement() : undefined);
        const texts = this.textOrder.map(p => tipEl(p.textTip)).filter(Boolean) as HTMLElement[];
        const labels = this.labelOrder.map(p => tipEl(p.marker.getTooltip())).filter(Boolean) as HTMLElement[];
        for (const el of [...texts, ...labels]) el.style.visibility = "";
        if (!this.settings || !this.settings.labels.avoidOverlap.value) return;

        // Bubble texts first (they belong to the node), then labels, which also avoid bubble texts
        const view = this.mapEl.getBoundingClientRect();
        const placed: DOMRect[] = [];
        const pad = 2;
        const place = (el: HTMLElement) => {
            const r = el.getBoundingClientRect();
            if (r.right < view.left || r.left > view.right || r.bottom < view.top || r.top > view.bottom) return;
            const hit = placed.some(q =>
                r.left - pad < q.right && r.right + pad > q.left && r.top - pad < q.bottom && r.bottom + pad > q.top);
            if (hit) el.style.visibility = "hidden";
            else placed.push(r);
        };
        texts.forEach(place);
        labels.forEach(place);
    }

    // ---------- interaction ----------

    private onPointClick(p: MapPoint, ev: MouseEvent) {
        if (!this.allowInteractions) return;
        const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
        this.selectionManager.select(p.identity, multi).then((ids: ISelectionId[]) => this.applySelection(ids));
    }

    private applySelection(ids: ISelectionId[]) {
        const any = ids && ids.length > 0;
        const base = this.settings ? this.settings.bubbles.opacity.value / 100 : 0.8;
        for (const p of this.points) {
            if (!p.marker) continue;
            const selected = !any || ids.some(id => id.equals(p.identity));
            p.marker.setStyle({ fillOpacity: selected ? base : base * 0.2, opacity: selected ? 1 : 0.3 });
            const el = p.marker.getTooltip() && p.marker.getTooltip().getElement();
            if (el) el.style.opacity = selected ? "1" : "0.35";
            const tEl = p.textTip && p.textTip.getElement();
            if (tEl) tEl.style.opacity = selected ? "1" : "0.35";
        }
    }

    private showTooltip(p: MapPoint, ev: MouseEvent) {
        if (!this.tooltipService.enabled()) return;
        const rect = this.root.getBoundingClientRect();
        this.tooltipService.show({
            coordinates: [ev.clientX - rect.left, ev.clientY - rect.top],
            isTouchEvent: false,
            dataItems: p.tooltip,
            identities: [p.identity]
        });
    }

    // ---------- status ----------

    private showEmpty(message: string) {
        this.emptyEl.textContent = message;
        this.emptyEl.style.display = message ? "flex" : "none";
    }

    private updateNotice() {
        const msgs: string[] = [];
        const geo = this.geocoder;
        if (geo.stop) {
            msgs.push(GEO_STOP_TEXT[geo.stop] + (geo.lastError ? ` (${geo.lastError}).` : "."));
        } else if (geo.busy && this.geoWaiting > 0) {
            const azure = this.settings && String(this.settings.geocoding.provider.value.value) === "azure";
            const secs = geo.secondsLeft();
            const eta = secs >= 90 ? `about ${Math.round(secs / 60)} min left` : `about ${Math.max(secs, 1)} s left`;
            const pace = azure ? "Azure Maps" : "OpenStreetMap allows 1 per second";
            const saved = this.canPersist
                ? " Found locations are saved with the report."
                : " To spare viewers this wait, run it once in Desktop or Edit mode and save.";
            const retry = geo.lastError ? ` Last problem: ${geo.lastError}.` : "";
            msgs.push(`Finding locations: ${geo.done} of ${geo.total} (${pace}, ${eta}).${saved}${retry}`);
        }
        if (this.geoNotFound.length) {
            const names = this.geoNotFound.slice(0, 3).join("; ");
            const more = this.geoNotFound.length > 3 ? ` and ${this.geoNotFound.length - 3} more` : "";
            msgs.push(`Couldn't find ${this.geoNotFound.length} location(s): ${names}${more}. Add more detail (city, state, country) or Latitude/Longitude.`);
        }
        if (this.geoApprox > 0) {
            const osm = this.settings && String(this.settings.geocoding.provider.value.value) === "osm";
            msgs.push(osm
                ? `${this.geoApprox} location(s) placed at the centre of their postal area (first 3 characters), because OpenStreetMap doesn't have full Canadian postal codes. An Azure Maps key places them exactly.`
                : `${this.geoApprox} location(s) that couldn't be found exactly are placed at the centre of their postal area (first 3 characters).`);
        }
        if (this.basemapMissingFor) {
            const which = TILES[this.basemapMissingFor].needs === "azure" ? "an Azure Maps key" : "a free CARTO key";
            msgs.push(`${BASEMAP_NAMES[this.basemapMissingFor]} needs ${which} in Format → Map service keys. Showing Esri streets for now.`);
        }
        if (TILES[this.basemapKey] && this.tileStats.loads === 0 && this.tileStats.errors >= TILE_ERROR_THRESHOLD) {
            msgs.push("Map tiles can't load here (web access for custom visuals is likely blocked). Format → Map → Base map → Offline outline still works.");
        }
        if (this.skippedRows > 0) {
            msgs.push(`${this.skippedRows} row(s) skipped: no Location and no valid Latitude/Longitude.`);
        }
        this.noticeEl.textContent = msgs.join("  ");
        this.noticeEl.style.display = msgs.length ? "block" : "none";
    }
}

// ---------- helpers ----------

const GEO_STOP_TEXT: Record<string, string> = {
    blocked: "Can't reach the geocoding service from here (web access for custom visuals may be blocked). Use Latitude/Longitude, or ask your admin",
    refused: "The geocoding service is refusing requests right now. Points found so far are shown; reopen the report later to continue",
    failing: "The geocoding service stopped responding, so lookups are paused. Points found so far are shown; reopen the report to continue",
    badKey: "Azure Maps rejected the key in Format → Map service keys. Check the key",
    noKey: "Geocoding is set to Azure Maps but there's no key in Format → Map service keys. Add one, or switch Geocoding to OpenStreetMap"
};

interface RowLocation {
    text: string;
    parts: Partial<Record<GeoPart, string>> | null;
}

/** Location column indexes, most specific first when every column has a data category */
function orderLocationColumns(cols: DataViewMetadataColumn[]): number[] {
    const idx = cols.map((c, i) => (c.roles && c.roles.location ? i : -1)).filter(i => i >= 0);
    const ranks = idx.map(i => geoRank(cols[i]));
    if (ranks.every(r => r !== null)) {
        return idx.map((i, k) => ({ i, r: ranks[k].rank })).sort((a, b) => a.r - b.r).map(x => x.i);
    }
    return idx;
}

function geoRank(col: DataViewMetadataColumn): { rank: number; part: GeoPart | null } | null {
    const geo = col.type && col.type.geography;
    if (!geo) return null;
    for (const [flag, part, rank] of GEO_RANK) {
        if (geo[flag]) return { rank, part };
    }
    return null;
}

function locationOf(row: PrimitiveValue[], cols: DataViewMetadataColumn[], locIs: number[]): RowLocation | null {
    const values: string[] = [];
    const parts: Partial<Record<GeoPart, string>> = {};
    let structured = locIs.length > 0;
    for (const i of locIs) {
        const v = row[i];
        if (v == null || String(v).trim() === "") continue;
        const text = String(v).trim();
        values.push(text);
        const r = geoRank(cols[i]);
        if (r && r.part && !parts[r.part]) parts[r.part] = text;
        else structured = false;
    }
    if (!values.length) return null;
    return { text: values.join(", "), parts: structured ? parts : null };
}

function toNumber(v: PrimitiveValue): number | null {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

function formatValue(v: PrimitiveValue, col: DataViewMetadataColumn | null, locale: string): string {
    if (v == null) return "";
    if (col && col.format) return valueFormatter.format(v, col.format, false, locale);
    if (typeof v === "number") return v.toLocaleString(locale || undefined);
    if (v instanceof Date) return v.toLocaleDateString(locale || undefined);
    return String(v);
}

function composeLabel(content: string, name: string | null, value: string): string {
    switch (content) {
        case "name": return name || value;
        case "nameValue": return name && value ? `${name}: ${value}` : (name || value);
        case "twoLines": return name && value ? `${name}\n${value}` : (name || value);
        default: return value || name || "";
    }
}

/**
 * Picks dark or white text for a label drawn on a bubble, by WCAG contrast against
 * the bubble color blended over a light or dark basemap at the bubble's opacity.
 */
function contrastText(color: string, opacity: number, darkBase: boolean): string | null {
    const rgb = parseHex(color);
    if (!rgb) return null;
    const base = darkBase ? 34 : 242;
    const lin = (c: number) => {
        const v = (c * opacity + base * (1 - opacity)) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    const onWhite = 1.05 / (L + 0.05);
    const onDark = (L + 0.05) / 0.0625; // #1b1f24
    return onWhite >= onDark ? "#ffffff" : "#1b1f24";
}

function parseHex(color: string): [number, number, number] | null {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color || "").trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function labelOffset(pos: string, radius: number): L.PointExpression {
    const gap = radius + 3;
    switch (pos) {
        case "bottom": return [0, gap];
        case "right": return [gap, 0];
        case "left": return [-gap, 0];
        case "center": return [0, 0];
        default: return [0, -gap];
    }
}

function signature(points: MapPoint[]): string {
    // FNV-1a over rounded coordinates: cheap change detection for auto-fit
    let h = 0x811c9dc5;
    for (const p of points) {
        const s = `${p.lat.toFixed(5)},${p.lon.toFixed(5)};`;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
    }
    return `${points.length}:${(h >>> 0).toString(16)}`;
}
