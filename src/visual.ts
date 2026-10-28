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

import pbivizJson from "../pbiviz.json";
import { VisualFormattingSettingsModel, LEGEND_SLOTS, LegendColorItem, REGION_NAME_BASEMAPS } from "./settings";
import { REGIONS, Region, inRegionBox } from "./regions";
import { Geocoder, GeoAttempt, GeoConfig, GeoPart, GeoQuery, GeoProvider, cacheKey, parseCountries } from "./geocoder";
import { PlaceInfo, analyzeLocation, distanceKm, withoutHouseNumber, withoutPoBoxes } from "./places";

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

interface Approx {
    /** Canadian postal area (first 3 characters), US ZIP code, or a whole state/province */
    kind: "fsa" | "zip" | "region";
    code: string;
    /** The ZIP as written, when it had to be read generously ("561756") */
    read?: string;
}

interface Located {
    at: [number, number];
    approx: Approx | null;
    /** For the tooltip's "Placed by" line */
    how: string;
}

interface MapPoint {
    lat: number;
    lon: number;
    name: string | null;
    legend: string | null;
    labelText: string;
    /** Text drawn inside the bubble */
    bubbleText: string;
    /** Set when placed at a postal area or ZIP centre instead of an exact location */
    approx: Approx | null;
    priority: number;
    radius: number;
    color: string;
    identity: ISelectionId;
    tooltip: VisualTooltipDataItem[];
    marker?: L.CircleMarker;
    textTip?: L.Tooltip;
}

/** Shown in the yellow note, so it's clear which version a report is running */
const VERSION = String(pbivizJson.visual.version).replace(/\.0$/, "");
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
    /** Rows that only name a state/province, placed at its centre */
    private geoRegionOnly: string[] = [];
    /** Rows whose ZIP is in a different state than the row says, e.g. "US, TX, 54214" -> "54214 is in WI" */
    private geoConflicts: string[] = [];
    private textOrder: MapPoint[] = [];
    private lastAzureKeyLegacy = "";
    /** Legend value per color slot (bubbles.c0, c1, ...), saved in the report as bubbles.legendSlots */
    private legendSlots: string[] = [];
    private legendSlotsSaved = "";
    private regionLayer: L.LayerGroup;
    /** Legend values switched on by clicking the legend; empty = no legend filter */
    private legendActive = new Set<string>();
    /** Every row's selection id per Legend value, placed or not, so a legend click selects them all */
    private legendIds = new Map<string, ISelectionId[]>();
    /** "Look up all locations again" button on the map, shown while editing */
    private refreshControl: L.Control | null = null;
    private refreshConfirmTimer = 0;
    /** Set after a re-lookup until the emptied cache comes back, so the old one isn't loaded again */
    private ignoreSavedCache = false;
    /** Biggest first, so they win label collisions */
    private regionMarks: Array<{ region: Region; marker: L.Marker }> = [];

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
        const regionPane = this.map.createPane("plm-regions");
        regionPane.style.zIndex = "380"; // above tiles, below bubbles (400) and labels (650)
        regionPane.style.pointerEvents = "none";
        this.regionLayer = L.layerGroup();
        this.markerLayer = L.layerGroup().addTo(this.map);
        this.map.setView([30, -40], 2);

        this.map.on("click", () => {
            if (!this.allowInteractions) return;
            this.legendActive.clear();
            this.styleLegend();
            this.selectionManager.clear().then(() => this.applySelection([]));
        });
        this.map.on("contextmenu", (e: L.LeafletMouseEvent) => {
            L.DomEvent.preventDefault(e.originalEvent);
            this.selectionManager.showContextMenu({}, { x: e.originalEvent.clientX, y: e.originalEvent.clientY });
        });
        this.map.on("zoomend moveend resize", () => this.queueDeclutter());

        this.selectionManager.registerOnSelectCallback((ids: ISelectionId[]) => {
            // Selection changed from outside (bookmark, another visual): the legend filter no longer applies
            this.legendActive.clear();
            this.styleLegend();
            this.applySelection(ids);
        });
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
            const hasLocation = !!(dataView && dataView.table && dataView.table.columns.some(c => c.roles && c.roles.location));
            this.showRefreshButton(this.canPersist && hasLocation && this.allowInteractions);
            if (this.settings.geocoding.refresh.value && this.canPersist) {
                this.lookUpAllAgain(true); // Format pane switch; it turns itself off
            } else {
                this.loadSavedGeocodes(dataView);
            }
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
        const btI = roleIndex("bubbleText");
        const tooltipIs = cols.map((c, i) => (c.roles && c.roles.tooltips ? i : -1)).filter(i => i >= 0);
        this.hasSizeField = sizeI >= 0;

        const s = this.settings;
        const labelCol = labelI >= 0 ? cols[labelI] : null;
        const labelNumeric = !!(labelCol && labelCol.type && (labelCol.type.numeric || labelCol.type.integer));

        const btCol = btI >= 0 ? cols[btI] : null;
        const btNumeric = !!(btCol && btCol.type && (btCol.type.numeric || btCol.type.integer));

        let maxAbsLabel = 0;
        let maxAbsSize = 0;
        let maxAbsBt = 0;
        for (const row of table.rows) {
            if (labelNumeric) maxAbsLabel = Math.max(maxAbsLabel, Math.abs(Number(row[labelI]) || 0));
            if (sizeI >= 0) maxAbsSize = Math.max(maxAbsSize, Math.abs(Number(row[sizeI]) || 0));
            if (btNumeric) maxAbsBt = Math.max(maxAbsBt, Math.abs(Number(row[btI]) || 0));
        }

        const l = s.labels;
        const bt = s.bubbleText;
        const labelFormatter = labelNumeric
            ? this.makeFormatter(labelCol, maxAbsLabel, l.displayUnits.value, l.decimals.value.value) : null;
        const sizeCol = sizeI >= 0 ? cols[sizeI] : null;
        const sizeNumeric = !!(sizeCol && sizeCol.type && (sizeCol.type.numeric || sizeCol.type.integer));
        // "Bubble text field" falls back to the Size value while the Bubble text well is empty
        let btContent = bt.show.value ? String(bt.content.value.value) : "";
        if (btContent === "field" && btI < 0) btContent = "size";
        const btUnits = bt.displayUnits.value;
        const btDecimals = bt.decimals.value.value;
        const btFormatter = btContent === "field" && btNumeric
            ? this.makeFormatter(btCol, maxAbsBt, btUnits, btDecimals)
            : btContent === "size" && sizeNumeric
                ? this.makeFormatter(sizeCol, maxAbsSize, btUnits, btDecimals)
                : btContent === "label" && labelNumeric
                    ? this.makeFormatter(labelCol, maxAbsLabel, btUnits, btDecimals)
                    : null;
        const btSourceCol = btContent === "field" ? btCol : btContent === "size" ? sizeCol : labelCol;
        const palette = this.host.colorPalette;
        const highContrast = palette.isHighContrast;
        const baseColor = highContrast ? palette.foreground.value : s.bubbles.fill.value.value;
        const minR = Math.min(s.bubbles.minRadius.value, s.bubbles.maxRadius.value);
        const maxR = Math.max(s.bubbles.minRadius.value, s.bubbles.maxRadius.value);
        const content = String(s.labels.content.value.value);

        const points: MapPoint[] = [];
        this.skippedRows = 0;
        const geoCfg = this.geoConfig();
        this.geocoder.configure(geoCfg); // before locate(), so a changed service clears an old stop
        const legendColors = this.legendColors(dataView, legendI, highContrast);
        const toGeocode = new Map<string, GeoQuery>();
        const notFound = new Set<string>();
        const conflicts = new Map<string, string>();
        let waiting = 0;
        let approxCount = 0;
        const regionOnly = new Set<string>();

        this.legendIds = new Map();
        const identities = table.rows.map((row, i) => {
            const id = this.host.createSelectionIdBuilder().withTable(table, i).createSelectionId();
            if (legendI >= 0 && row[legendI] != null) {
                const key = String(row[legendI]);
                const list = this.legendIds.get(key);
                if (list) list.push(id);
                else this.legendIds.set(key, [id]);
            }
            return id;
        });

        table.rows.forEach((row, i) => {
            const loc = locationOf(row, cols, locIs);
            let lat = latI >= 0 ? toNumber(row[latI]) : null;
            let lon = lonI >= 0 ? toNumber(row[lonI]) : null;
            const hasLatLon = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

            // Latitude/Longitude win when the row has them; otherwise geocode the Location text
            let approx: Approx | null = null;
            let placedBy = "";
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
                if (coords === "conflict") {
                    const c = this.placeInfo(loc).zipConflict;
                    conflicts.set(loc.text, `${c.code} is in ${c.state}`);
                    return;
                }
                [lat, lon] = coords.at;
                approx = coords.approx;
                placedBy = coords.how;
                if (approx && approx.kind === "fsa") approxCount++;
                if (approx && approx.kind === "region") regionOnly.add(loc.text);
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
            const rawBt = btContent === "field" ? row[btI]
                : btContent === "size" ? (sizeI >= 0 ? row[sizeI] : null)
                    : btContent === "label" ? rawLabel
                        : btContent === "location" ? name : null;
            if (rawBt != null && rawBt !== "") {
                bubbleText = btFormatter ? btFormatter.format(rawBt)
                    : btContent === "location" ? String(rawBt)
                        : formatValue(rawBt, btSourceCol, this.host.locale);
            }

            let radius = s.bubbles.radius.value;
            if (sizeI >= 0) {
                const v = Math.abs(Number(row[sizeI]) || 0);
                radius = maxAbsSize > 0 ? minR + (maxR - minR) * Math.sqrt(v / maxAbsSize) : minR;
            }

            const color = legend !== null && !highContrast ? legendColors.get(legend) || baseColor : baseColor;

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
                identity: identities[i],
                tooltip: placedBy
                    ? [...this.buildTooltip(row, cols, [...locIs, legendI, labelI, sizeI, btI, ...tooltipIs]),
                        { displayName: "Placed by", value: placedBy }]
                    : this.buildTooltip(row, cols, [...locIs, legendI, labelI, sizeI, btI, ...tooltipIs])
            });
        });

        this.geoWaiting = waiting;
        this.geoNotFound = [...notFound];
        this.geoConflicts = [...conflicts].map(([text, why]) => `${text} (${why})`);
        this.geoApprox = approxCount;
        this.geoRegionOnly = [...regionOnly];
        this.geocoder.request([...toGeocode.values()], geoCfg);
        return points;
    }

    // ---------- legend colors ----------

    /**
     * Color per Legend value: the one picked in Format → Bubbles → Colors, else the theme color.
     * Each value keeps a numbered slot (saved as bubbles.legendSlots) so its color survives
     * filtering and new values; colors are stored as bubbles.c0, c1, ...
     */
    private legendColors(dataView: DataView, legendI: number, highContrast: boolean): Map<string, string> {
        const colors = new Map<string, string>();
        const bubbles = this.settings.bubbles;
        if (legendI < 0) {
            bubbles.setLegendColors([]);
            return colors;
        }
        const values = new Set<string>();
        for (const row of dataView.table.rows) {
            if (row[legendI] != null) values.add(String(row[legendI]));
        }
        const sorted = [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

        const objects = dataView.metadata && dataView.metadata.objects;
        const saved = (objects && objects.bubbles) || {};
        const savedText = typeof saved.legendSlots === "string" ? saved.legendSlots : "";
        // Keep slots added while viewing (they can't be saved then) until the report's list changes
        let slots = savedText === this.legendSlotsSaved && this.legendSlots.length ? [...this.legendSlots] : parseSlots(savedText);
        const picked = (slot: number): string | null => {
            const fill = saved[`c${slot}`] as powerbi.Fill | undefined;
            return fill && fill.solid && fill.solid.color ? fill.solid.color : null;
        };

        let changed = false;
        for (const v of sorted) {
            if (slots.includes(v)) continue;
            if (slots.length < LEGEND_SLOTS) {
                slots.push(v);
                changed = true;
                continue;
            }
            // All slots used: take one whose value isn't on the map now and has no picked color
            const free = slots.findIndex((old, k) => !values.has(old) && !picked(k));
            if (free >= 0) {
                slots[free] = v;
                changed = true;
            }
        }
        this.legendSlots = slots;
        this.legendSlotsSaved = savedText;
        if (changed && this.canPersist) {
            const text = JSON.stringify(slots);
            this.legendSlotsSaved = text;
            this.host.persistProperties({
                merge: [{ objectName: "bubbles", selector: null, properties: { legendSlots: text } }]
            });
        }

        const palette = this.host.colorPalette;
        const items: LegendColorItem[] = [];
        for (const v of sorted) {
            const theme = palette.getColor(v).value; // asked in sorted order so theme colors stay put
            const slot = slots.indexOf(v);
            const color = (slot >= 0 && picked(slot)) || theme;
            colors.set(v, color);
            if (slot >= 0) items.push({ slot, label: v, color });
        }
        bubbles.setLegendColors(highContrast ? [] : items);
        return colors;
    }

    // ---------- geocoding ----------

    /**
     * Coordinates for a row's Location. The street address and town come first, then the rest:
     * - OpenStreetMap is asked for street + town, then the street name without the house number + town,
     *   then the town, each checked against the row's state/province and its ZIP or postal area
     * - with nothing to look up (no town), or when every way fails: the ZIP or postal-area centre
     * - a ZIP from another state than the row says: the town if there is one, else reported as a conflict
     * PO boxes and unit numbers are never looked up. Queues the lookup and returns "waiting" when the
     * answer isn't known yet.
     */
    private locate(loc: RowLocation, cfg: GeoConfig, queue: Map<string, GeoQuery>): Located | "waiting" | "conflict" | null {
        const info = this.placeInfo(loc);
        const osm = cfg.provider === "osm";
        // Only a state/province ("PQ, CA", "TX, US"): its centre, like Azure Maps does; a lookup can only do worse
        if (info.region && !info.zip && !info.zipConflict && !info.ca && !info.street && !info.town) {
            return {
                at: [info.region.lat, info.region.lon],
                approx: { kind: "region", code: info.region.code },
                how: `${info.region.name} (centre, approximate: the row has nothing more specific)`
            };
        }
        let key = info.query;
        let onMiss: Located | "conflict" | null = null;
        let near: [number, number] | undefined;
        let maxKm: number | undefined;

        if (info.zip) {
            const centre: Located = {
                at: info.zip.at,
                approx: { kind: "zip", code: info.zip.code, read: info.zip.read },
                how: `ZIP code ${info.zip.code} area` + (info.zip.read ? ` (read from ${info.zip.read})` : "")
            };
            if (!(osm ? info.town : info.street || info.town)) return centre;
            onMiss = centre;
            near = info.zip.at;
            maxKm = 80; // rural ZIP areas can be ~100 km across
        } else if (info.zipConflict) {
            if (!info.town) return "conflict";
            key = info.queryNoCode; // the town decides; the ZIP is wrong or belongs to another state
            onMiss = "conflict";
        } else if (info.ca && info.caCentre) {
            const centre: Located = {
                at: info.caCentre,
                approx: { kind: "fsa", code: info.ca.fsa },
                how: `Postal area ${info.ca.fsa} (approximate)`
            };
            if (osm && !info.town) return centre; // OpenStreetMap doesn't know Canadian postal codes
            if (osm) key = info.queryNoCode;
            onMiss = centre;
            near = info.caCentre;
            maxKm = info.ca.fsa[1] === "0" ? 250 : 80; // a 0 in the 2nd character is a rural area, often huge
        }

        const k = cacheKey(cfg, key);
        let found = this.geocoder.lookup(k);
        // A result saved by an older version can sit in the wrong state/province: look it up again
        if (found && info.region && !inRegionBox(found, info.region) && this.geocoder.forgetSaved(k)) found = undefined;
        if (found === undefined) {
            const stopped = this.geocoder.stop || (cfg.provider === "azure" && !cfg.azureKey);
            // Still hand unplaceable rows to the geocoder when stopped, so it can say why (e.g. no Azure key)
            if (!stopped || !onMiss) {
                queue.set(k, {
                    key: k,
                    text: osm ? key : this.azureText(info, key),
                    parts: null,
                    attempts: osm ? this.osmAttempts(info, loc) : undefined,
                    expect: info.region ? info.region.iso : undefined,
                    expectName: info.region ? info.region.name : undefined,
                    country: info.country || undefined,
                    near,
                    maxKm
                });
            }
            return stopped && onMiss ? onMiss : "waiting";
        }
        if (found === null) return onMiss;
        if (near && distanceKm(found, near) > maxKm) return onMiss;
        const service = osm ? "OpenStreetMap" : "Azure Maps";
        return { at: found, approx: null, how: this.geocoder.isSaved(k) ? `${service} (saved in the report)` : service };
    }

    /** Street + town, street name + town, then town, as structured OpenStreetMap searches */
    private osmAttempts(info: PlaceInfo, loc: RowLocation): GeoAttempt[] {
        const state = info.region ? info.region.name : undefined;
        const ask = (p: Partial<Record<GeoPart, string>>): GeoAttempt => ({ parts: state ? { ...p, state } : p });
        const attempts: GeoAttempt[] = [];
        const street = info.streetText;
        const town = info.townText;
        if (street && town) {
            attempts.push(ask({ street, city: town }));
            const bare = withoutHouseNumber(street);
            if (bare && bare !== street) attempts.push(ask({ street: bare, city: town }));
        }
        if (town) attempts.push(ask({ city: town }));
        if (!attempts.length && street && !info.zip && !info.ca) attempts.push(ask({ street }));
        if (!attempts.length) {
            // Nothing recognisable: the Location fields as given, or the cleaned-up text
            const parts = loc.parts ? { ...loc.parts } : null;
            if (parts && parts.street) parts.street = withoutPoBoxes(parts.street);
            attempts.push(parts && Object.values(parts).some(Boolean) ? { parts } : { text: info.query });
        } else {
            // Last try: plain text in the usual order, in case the street/town split was off
            attempts.push({ text: this.plainText(info, false) || info.query });
        }
        return attempts;
    }

    /** Azure Maps reads free text best in the usual order: street, town, state ZIP, country */
    private azureText(info: PlaceInfo, fallback: string): string {
        return this.plainText(info, true) || fallback;
    }

    /** "street, town, ST ZIP, country"; empty when there's no street or town. Canadian postal codes only for Azure. */
    private plainText(info: PlaceInfo, withPostal: boolean): string {
        if (!info.streetText && !info.townText) return "";
        const postal = info.zip ? info.zip.code
            : info.ca && withPostal ? (info.query.match(/\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/i) || [""])[0] : "";
        const state = `${info.region ? info.region.code : ""} ${postal}`.trim();
        const country = info.country === "US" ? "USA" : info.country === "CA" ? "Canada" : "";
        return [info.streetText, info.townText, state, country].filter(Boolean).join(", ");
    }

    private placeCache = new Map<string, PlaceInfo>();

    private placeInfo(loc: RowLocation): PlaceInfo {
        let info = this.placeCache.get(loc.text);
        if (!info) {
            if (this.placeCache.size > 20000) this.placeCache.clear();
            info = analyzeLocation(loc.text, loc.parts && loc.parts.state, loc.parts && loc.parts.country);
            this.placeCache.set(loc.text, info);
        }
        return info;
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

    /**
     * Forgets every found location, saved or not, and looks them all up again. While editing, the emptied
     * cache is saved too, so the report doesn't bring the old spots back.
     */
    private lookUpAllAgain(resetSwitch: boolean) {
        this.geocoder.clearAll();
        this.placeCache.clear();
        this.loadedCache = "";
        this.ignoreSavedCache = true;
        if (this.canPersist) {
            const properties: Record<string, powerbi.DataViewPropertyValue> = { cache: "" };
            if (resetSwitch) properties.refresh = false;
            this.host.persistProperties({ merge: [{ objectName: "geocoding", selector: null, properties }] });
        }
        if (!resetSwitch) this.renderData(true);
    }

    /** Map button under the zoom buttons: first click asks, second click within 4 s runs it */
    private showRefreshButton(on: boolean) {
        if (on && !this.refreshControl) {
            const control = new L.Control({ position: "topleft" });
            control.onAdd = () => {
                const box = L.DomUtil.create("div", "leaflet-bar plm-refresh");
                L.DomEvent.disableClickPropagation(box);
                const btn = L.DomUtil.create("a", "", box) as HTMLAnchorElement;
                btn.href = "#";
                btn.setAttribute("role", "button");
                btn.title = "Look up all locations again";
                btn.setAttribute("aria-label", btn.title);
                const icon = "http://www.w3.org/2000/svg";
                const svg = document.createElementNS(icon, "svg");
                svg.setAttribute("viewBox", "0 0 24 24");
                svg.setAttribute("width", "16");
                svg.setAttribute("height", "16");
                const path = document.createElementNS(icon, "path");
                path.setAttribute("d", "M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z");
                path.setAttribute("fill", "currentColor");
                svg.appendChild(path);
                btn.appendChild(svg);
                const text = L.DomUtil.create("span", "plm-refresh-text", btn);
                text.textContent = "Look up all again? Click to confirm";
                L.DomEvent.on(btn, "click", (e: Event) => {
                    L.DomEvent.preventDefault(e);
                    if (box.classList.contains("plm-confirm")) {
                        window.clearTimeout(this.refreshConfirmTimer);
                        box.classList.remove("plm-confirm");
                        this.lookUpAllAgain(false);
                    } else {
                        box.classList.add("plm-confirm");
                        this.refreshConfirmTimer = window.setTimeout(() => box.classList.remove("plm-confirm"), 4000);
                    }
                });
                return box;
            };
            control.addTo(this.map);
            this.refreshControl = control;
        } else if (!on && this.refreshControl) {
            this.refreshControl.remove();
            this.refreshControl = null;
        }
    }

    private loadSavedGeocodes(dataView: DataView | undefined) {
        const objects = dataView && dataView.metadata && dataView.metadata.objects;
        const saved = objects && objects.geocoding && objects.geocoding.cache;
        const text = typeof saved === "string" ? saved : "";
        if (this.ignoreSavedCache) {
            // After "look up all again": skip the old cache until the emptied one (or ours) comes back
            if (!text || text === this.loadedCache) this.ignoreSavedCache = false;
            return;
        }
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

        // Only add when missing: re-adding would move the zoom buttons below the re-lookup button
        const zoomShown = !!(this.zoomControl.getContainer() && this.zoomControl.getContainer().parentNode);
        if (m.zoomControl.value && !zoomShown) this.zoomControl.addTo(this.map);
        else if (!m.zoomControl.value && zoomShown) this.zoomControl.remove();

        this.root.classList.toggle("plm-grey", m.greyscale.value);
        this.showRegionNames(m.regionNames.value && REGION_NAME_BASEMAPS.has(this.basemapKey));

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

    private showRegionNames(on: boolean) {
        if (on && !this.regionMarks.length) {
            for (const region of [...REGIONS].sort((a, b) => b.area - a.area)) {
                const el = document.createElement("div");
                el.className = "plm-region-name";
                el.textContent = region.name;
                const marker = L.marker([region.lat, region.lon], {
                    icon: L.divIcon({ className: "plm-region", html: el, iconSize: [0, 0] }),
                    interactive: false,
                    keyboard: false,
                    pane: "plm-regions"
                });
                this.regionLayer.addLayer(marker);
                this.regionMarks.push({ region, marker });
            }
        }
        const isOn = this.map.hasLayer(this.regionLayer);
        if (on && !isOn) this.regionLayer.addTo(this.map);
        if (!on && isOn) this.regionLayer.remove();
        if (on !== isOn) this.queueDeclutter();
    }

    private renderLegend() {
        if (this.legendControl) {
            this.legendControl.remove();
            this.legendControl = null;
        }
        const s = this.settings;
        if (!s || !s.legend.show.value) return;

        const found = new Map<string, string>();
        for (const p of this.points) {
            if (p.legend !== null && !found.has(p.legend)) found.set(p.legend, p.color);
        }
        if (!found.size) return;
        const entries = new Map([...found].sort((a, b) =>
            a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" })));

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
                row.dataset.value = label;
                if (this.allowInteractions) {
                    row.classList.add("plm-legend-click");
                    row.setAttribute("role", "button");
                    row.tabIndex = 0;
                    row.title = "Click to show this one; click others to add them, or again to remove";
                    row.addEventListener("click", () => this.toggleLegend(label));
                    row.addEventListener("keydown", (e: KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            this.toggleLegend(label);
                        }
                    });
                }
                const sw = L.DomUtil.create("span", "plm-swatch", row);
                sw.style.background = color;
                const text = L.DomUtil.create("span", "", row);
                text.textContent = label;
            }
            return box;
        };
        control.addTo(this.map);
        this.legendControl = control;
        this.styleLegend();
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
        if (!this.settings) return;
        const avoid = this.settings.labels.avoidOverlap.value;

        // Bubble texts first (they belong to the node), then labels, which also avoid bubble texts
        const view = this.mapEl.getBoundingClientRect();
        const placed: Box[] = [];
        const place = (el: HTMLElement) => {
            const r = el.getBoundingClientRect();
            if (!overlaps(r, view, 0)) return;
            if (avoid && placed.some(q => overlaps(r, q, 2))) el.style.visibility = "hidden";
            else placed.push(r);
        };
        texts.forEach(place);
        labels.forEach(place);
        this.declutterRegions(placed, view);
    }

    /** State/province names sit under the data: hidden where they'd touch a bubble, a label or each other */
    private declutterRegions(placed: Box[], view: DOMRect) {
        if (!this.map.hasLayer(this.regionLayer)) return;
        const zoom = this.map.getZoom();
        const obstacles: Box[] = [...placed];
        for (const p of this.points) {
            const c = this.map.latLngToContainerPoint([p.lat, p.lon]);
            const x = view.left + c.x;
            const y = view.top + c.y;
            const r = p.radius;
            const box = { left: x - r, right: x + r, top: y - r, bottom: y + r };
            if (overlaps(box, view, 0)) obstacles.push(box);
        }
        const names: Box[] = [];
        for (const { region, marker } of this.regionMarks) {
            const el = marker.getElement();
            const label = el && el.firstElementChild as HTMLElement;
            if (!label) continue;
            label.style.visibility = "";
            const fits = zoom >= Math.max(3, region.minZoom - 0.5) && zoom <= 7.5;
            const r = label.getBoundingClientRect();
            const hidden = !fits || !overlaps(r, view, 0)
                || obstacles.some(q => overlaps(r, q, 1)) || names.some(q => overlaps(r, q, 6));
            if (hidden) label.style.visibility = "hidden";
            else names.push(r);
        }
    }

    // ---------- interaction ----------

    private onPointClick(p: MapPoint, ev: MouseEvent) {
        if (!this.allowInteractions) return;
        const multi = ev.ctrlKey || ev.metaKey || ev.shiftKey;
        this.legendActive.clear();
        this.styleLegend();
        this.selectionManager.select(p.identity, multi).then((ids: ISelectionId[]) => this.applySelection(ids));
    }

    /**
     * Legend click: switches that value on or off, so several can be picked without Ctrl. The picked values'
     * rows are selected, which dims the rest here and cross-filters the other visuals, like Azure Maps.
     */
    private toggleLegend(value: string) {
        if (!this.allowInteractions) return;
        if (this.legendActive.has(value)) this.legendActive.delete(value);
        else this.legendActive.add(value);
        this.styleLegend();
        if (!this.legendActive.size) {
            this.selectionManager.clear().then(() => this.applySelection([]));
            return;
        }
        const ids: ISelectionId[] = [];
        for (const v of this.legendActive) ids.push(...(this.legendIds.get(v) || []));
        this.selectionManager.select(ids, false).then((sel: ISelectionId[]) => this.applySelection(sel));
    }

    private styleLegend() {
        if (!this.legendControl) return;
        const box = this.legendControl.getContainer();
        if (!box) return;
        const any = this.legendActive.size > 0;
        box.querySelectorAll<HTMLElement>(".plm-legend-row").forEach(row => {
            const on = this.legendActive.has(row.dataset.value);
            row.classList.toggle("plm-legend-off", any && !on);
            row.setAttribute("aria-pressed", String(on));
        });
    }

    private applySelection(ids: ISelectionId[]) {
        const any = ids && ids.length > 0;
        const keys = new Set(any ? ids.map(id => id.getKey()) : []);
        const base = this.settings ? this.settings.bubbles.opacity.value / 100 : 0.8;
        for (const p of this.points) {
            if (!p.marker) continue;
            const selected = !any || keys.has(p.identity.getKey());
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
        if (this.geoConflicts.length) {
            const list = this.geoConflicts.slice(0, 3).join("; ");
            const more = this.geoConflicts.length > 3 ? ` and ${this.geoConflicts.length - 3} more` : "";
            msgs.push(`${this.geoConflicts.length} location(s) not placed because the ZIP or postal code is in a different state/province than the row says: ${list}${more}. Fix the code or the state/province, or add Latitude/Longitude.`);
        }
        if (this.geoRegionOnly.length) {
            const list = this.geoRegionOnly.slice(0, 3).join("; ");
            const more = this.geoRegionOnly.length > 3 ? ` and ${this.geoRegionOnly.length - 3} more` : "";
            msgs.push(`${this.geoRegionOnly.length} location(s) only name a state/province, so they're placed at its centre: ${list}${more}.`);
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
        this.noticeEl.textContent = msgs.length ? `${msgs.join("  ")}  (Label Map ${VERSION})` : "";
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

interface Box {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

function overlaps(a: Box, b: Box, pad: number): boolean {
    return a.left - pad < b.right && a.right + pad > b.left && a.top - pad < b.bottom && a.bottom + pad > b.top;
}

function parseSlots(text: string): string[] {
    if (!text) return [];
    try {
        const list = JSON.parse(text);
        return Array.isArray(list) ? list.map(v => String(v)).slice(0, LEGEND_SLOTS) : [];
    } catch {
        return [];
    }
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
