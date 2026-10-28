"use strict";

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import Card = formattingSettings.SimpleCard;
import Slice = formattingSettings.Slice;
import Model = formattingSettings.Model;
import ValidatorType = powerbi.visuals.ValidatorType;

export const BASEMAPS: powerbi.IEnumMember[] = [
    { value: "auto", displayName: "Auto (best for your keys)" },
    { value: "azureRoad", displayName: "Road (Azure Maps key)" },
    { value: "azureDark", displayName: "Dark grey (Azure Maps key)" },
    { value: "azureImagery", displayName: "Satellite (Azure Maps key)" },
    { value: "cartoLight", displayName: "Light (free CARTO key)" },
    { value: "cartoVoyager", displayName: "Streets (free CARTO key)" },
    { value: "cartoDark", displayName: "Dark (free CARTO key)" },
    { value: "esriStreets", displayName: "Streets (Esri, no key)" },
    { value: "esriGray", displayName: "Grey streets (Esri, no key)" },
    { value: "esriImagery", displayName: "Satellite (Esri, no key)" },
    { value: "osm", displayName: "OpenStreetMap (no key)" },
    { value: "outline", displayName: "Offline outline (no internet)" }
];

export const GEO_PROVIDERS: powerbi.IEnumMember[] = [
    { value: "osm", displayName: "OpenStreetMap (free)" },
    { value: "azure", displayName: "Azure Maps (needs key)" }
];

export const LABEL_CONTENT: powerbi.IEnumMember[] = [
    { value: "value", displayName: "Value" },
    { value: "name", displayName: "Location" },
    { value: "nameValue", displayName: "Location: Value" },
    { value: "twoLines", displayName: "Location and value (2 lines)" }
];

export const LABEL_POSITION: powerbi.IEnumMember[] = [
    { value: "top", displayName: "Above" },
    { value: "bottom", displayName: "Below" },
    { value: "right", displayName: "Right" },
    { value: "left", displayName: "Left" }
];

export const BUBBLE_TEXT_CONTENT: powerbi.IEnumMember[] = [
    { value: "field", displayName: "Bubble text field" },
    { value: "size", displayName: "Size value" },
    { value: "label", displayName: "Label value" },
    { value: "location", displayName: "Location" }
];

export const DECIMALS: powerbi.IEnumMember[] = [
    { value: "auto", displayName: "Auto" },
    { value: "0", displayName: "0" },
    { value: "1", displayName: "1" },
    { value: "2", displayName: "2" },
    { value: "3", displayName: "3" }
];

export const LEGEND_POSITION: powerbi.IEnumMember[] = [
    { value: "topright", displayName: "Top right" },
    { value: "topleft", displayName: "Top left" },
    { value: "bottomright", displayName: "Bottom right" },
    { value: "bottomleft", displayName: "Bottom left" }
];

function range(min: number, max: number): powerbi.visuals.NumUpDownFormat {
    return {
        minValue: { type: ValidatorType.Min as const, value: min },
        maxValue: { type: ValidatorType.Max as const, value: max }
    };
}

class MapCard extends Card {
    basemap = new formattingSettings.ItemDropdown({
        name: "basemap",
        displayName: "Base map",
        items: BASEMAPS,
        value: BASEMAPS[0]
    });
    autoFit = new formattingSettings.ToggleSwitch({
        name: "autoFit",
        displayName: "Zoom to data on filter",
        value: true
    });
    zoomControl = new formattingSettings.ToggleSwitch({
        name: "zoomControl",
        displayName: "Zoom buttons",
        value: true
    });
    wheelZoom = new formattingSettings.ToggleSwitch({
        name: "wheelZoom",
        displayName: "Zoom with mouse wheel",
        value: true
    });
    greyscale = new formattingSettings.ToggleSwitch({
        name: "greyscale",
        displayName: "Greyscale",
        description: "Shows any base map in shades of grey so the bubbles stand out",
        value: false
    });
    regionNames = new formattingSettings.ToggleSwitch({
        name: "regionNames",
        displayName: "State and province names",
        description: "Names US states and Canadian provinces when zoomed out. Grey streets and Offline outline don't show them on their own.",
        value: true
    });

    name = "map";
    displayName = "Map";
    slices: Slice[] = [this.basemap, this.greyscale, this.regionNames, this.autoFit, this.zoomControl, this.wheelZoom];

    syncVisibility() {
        const b = String(this.basemap.value.value);
        this.regionNames.visible = REGION_NAME_BASEMAPS.has(b);
    }
}

/** Base maps without their own state/province labels, which get ours */
export const REGION_NAME_BASEMAPS = new Set(["esriGray", "outline"]);

/** Legend values that get their own color picker; the rest use theme colors */
export const LEGEND_SLOTS = 60;

export interface LegendColorItem {
    /** Slot number: the color is saved as bubbles.c<slot> */
    slot: number;
    label: string;
    color: string;
}

class BubblesCard extends formattingSettings.CompositeCard {
    fill = new formattingSettings.ColorPicker({
        name: "fill",
        displayName: "Default color",
        description: "Used when nothing is in Legend",
        value: { value: "#1f6feb" }
    });
    radius = new formattingSettings.NumUpDown({
        name: "radius",
        displayName: "Size",
        description: "Used when nothing is in Size",
        value: 7,
        options: range(1, 60)
    });
    minRadius = new formattingSettings.NumUpDown({
        name: "minRadius",
        displayName: "Min size",
        value: 4,
        options: range(1, 60)
    });
    maxRadius = new formattingSettings.NumUpDown({
        name: "maxRadius",
        displayName: "Max size",
        value: 28,
        options: range(1, 120)
    });
    opacity = new formattingSettings.Slider({
        name: "opacity",
        displayName: "Opacity %",
        value: 80,
        options: range(5, 100)
    });
    strokeColor = new formattingSettings.ColorPicker({
        name: "strokeColor",
        displayName: "Border color",
        value: { value: "#ffffff" }
    });
    strokeWidth = new formattingSettings.NumUpDown({
        name: "strokeWidth",
        displayName: "Border width",
        value: 1,
        options: range(0, 10)
    });

    colors = new formattingSettings.Group({
        name: "bubbleColors",
        displayName: "Colors",
        slices: [this.fill]
    });
    size = new formattingSettings.Group({
        name: "bubbleSize",
        displayName: "Size",
        slices: [this.radius, this.minRadius, this.maxRadius]
    });
    style = new formattingSettings.Group({
        name: "bubbleStyle",
        displayName: "Style",
        slices: [this.opacity, this.strokeColor, this.strokeWidth]
    });

    name = "bubbles";
    displayName = "Bubbles";
    groups = [this.colors, this.size, this.style];

    /** One color picker per Legend value, like Azure Maps; Default color only matters without a Legend */
    setLegendColors(items: LegendColorItem[]) {
        const pickers = items.map(item => new formattingSettings.ColorPicker({
            name: `c${item.slot}`,
            displayName: item.label,
            value: { value: item.color }
        }));
        this.fill.visible = items.length === 0;
        this.colors.slices = [this.fill, ...pickers];
    }
}

class LabelsCard extends Card {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Labels",
        value: true
    });
    topLevelSlice = this.show;

    content = new formattingSettings.ItemDropdown({
        name: "content",
        displayName: "Content",
        items: LABEL_CONTENT,
        value: LABEL_CONTENT[0]
    });
    position = new formattingSettings.ItemDropdown({
        name: "position",
        displayName: "Position",
        items: LABEL_POSITION,
        value: LABEL_POSITION[0]
    });
    displayUnits = new formattingSettings.AutoDropdown({
        name: "displayUnits",
        displayName: "Display units",
        value: 0
    });
    decimals = new formattingSettings.ItemDropdown({
        name: "decimals",
        displayName: "Decimal places",
        items: DECIMALS,
        value: DECIMALS[0]
    });
    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "Text size",
        value: 11,
        options: range(6, 40)
    });
    fontColor = new formattingSettings.ColorPicker({
        name: "fontColor",
        displayName: "Text color",
        value: { value: "#1b1f24" }
    });
    bold = new formattingSettings.ToggleSwitch({
        name: "bold",
        displayName: "Bold",
        value: true
    });
    background = new formattingSettings.ToggleSwitch({
        name: "background",
        displayName: "Background",
        value: true
    });
    backgroundColor = new formattingSettings.ColorPicker({
        name: "backgroundColor",
        displayName: "Background color",
        value: { value: "#ffffff" }
    });
    avoidOverlap = new formattingSettings.ToggleSwitch({
        name: "avoidOverlap",
        displayName: "Hide overlapping labels",
        description: "Keeps the labels with the largest values when labels collide",
        value: true
    });

    name = "labels";
    displayName = "Labels";
    slices: Slice[] = [
        this.content, this.position, this.displayUnits, this.decimals,
        this.fontSize, this.fontColor, this.bold,
        this.background, this.backgroundColor, this.avoidOverlap
    ];
}

class BubbleTextCard extends Card {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Bubble text",
        value: true
    });
    topLevelSlice = this.show;

    content = new formattingSettings.ItemDropdown({
        name: "content",
        displayName: "Show",
        description: "Text drawn inside each bubble, separate from the label. Bubble text field uses the Bubble text well, or the Size value when that well is empty.",
        items: BUBBLE_TEXT_CONTENT,
        value: BUBBLE_TEXT_CONTENT[0]
    });
    displayUnits = new formattingSettings.AutoDropdown({
        name: "displayUnits",
        displayName: "Display units",
        value: 0
    });
    decimals = new formattingSettings.ItemDropdown({
        name: "decimals",
        displayName: "Decimal places",
        items: DECIMALS,
        value: DECIMALS[0]
    });
    fontSize = new formattingSettings.NumUpDown({
        name: "fontSize",
        displayName: "Text size",
        value: 11,
        options: range(6, 40)
    });
    autoColor = new formattingSettings.ToggleSwitch({
        name: "autoColor",
        displayName: "Auto text color",
        description: "White or dark text, whichever reads better on each bubble",
        value: true
    });
    fontColor = new formattingSettings.ColorPicker({
        name: "fontColor",
        displayName: "Text color",
        value: { value: "#ffffff" }
    });
    bold = new formattingSettings.ToggleSwitch({
        name: "bold",
        displayName: "Bold",
        value: true
    });
    fitBubble = new formattingSettings.ToggleSwitch({
        name: "fitBubble",
        displayName: "Grow bubbles to fit text",
        description: "Enlarges bubbles so the longest text fits, keeping their size order. Turn off to keep exact sizes.",
        value: true
    });

    name = "bubbleText";
    displayName = "Bubble text";
    slices: Slice[] = [
        this.content, this.displayUnits, this.decimals, this.fontSize,
        this.autoColor, this.fontColor, this.bold, this.fitBubble
    ];

    syncVisibility() {
        this.fontColor.visible = !this.autoColor.value;
    }
}

class GeocodingCard extends Card {
    provider = new formattingSettings.ItemDropdown({
        name: "provider",
        displayName: "Service",
        description: "Finds coordinates for the Location field. Rows with Latitude/Longitude skip this.",
        items: GEO_PROVIDERS,
        value: GEO_PROVIDERS[0]
    });
    countries = new formattingSettings.TextInput({
        name: "countries",
        displayName: "Only these countries",
        description: "Two-letter codes, e.g. CA, US. Stops 'Brandon' from landing in Florida.",
        placeholder: "e.g. CA, US",
        value: ""
    });

    name = "geocoding";
    displayName = "Geocoding";
    slices: Slice[] = [this.provider, this.countries];
}

class ServicesCard extends Card {
    azureKey = new formattingSettings.TextInput({
        name: "azureKey",
        displayName: "Azure Maps key",
        description: "From your company's Azure Maps account. Unlocks Azure base maps and fast geocoding. Saved in the report, so report editors can read it.",
        placeholder: "Subscription key",
        value: ""
    });
    cartoKey = new formattingSettings.TextInput({
        name: "cartoKey",
        displayName: "CARTO key",
        description: "Free from carto.com/basemaps/apikey (no account needed). Unlocks the CARTO base maps.",
        placeholder: "Basemaps key",
        value: ""
    });

    name = "services";
    displayName = "Map service keys";
    slices: Slice[] = [this.azureKey, this.cartoKey];
}

class LegendCard extends Card {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Legend",
        value: true
    });
    topLevelSlice = this.show;

    position = new formattingSettings.ItemDropdown({
        name: "position",
        displayName: "Position",
        items: LEGEND_POSITION,
        value: LEGEND_POSITION[0]
    });

    name = "legend";
    displayName = "Legend";
    slices: Slice[] = [this.position];
}

export class VisualFormattingSettingsModel extends Model {
    map = new MapCard();
    bubbles = new BubblesCard();
    labels = new LabelsCard();
    bubbleText = new BubbleTextCard();
    legend = new LegendCard();
    geocoding = new GeocodingCard();
    services = new ServicesCard();

    cards = [this.map, this.bubbles, this.bubbleText, this.labels, this.legend, this.geocoding, this.services];

    syncVisibility() {
        this.map.syncVisibility();
        this.bubbleText.syncVisibility();
    }
}
