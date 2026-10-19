/**
 * Demo Kit report — generates the one "Sales Overview" page of the Apothecary
 * report into an existing PBIR folder (scaffolded with `powerbi-report-author
 * scaffold`). Implements analysis/2026-10-15-demo-kit-report-spec.md.
 *
 *   node demo/build-report.js [path/to/Apothecary.Report]   (default: demo/dev)
 *
 * Re-running is safe: the page's visuals folder is rebuilt from scratch and
 * visual names are derived from stable ids, so the output is deterministic.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPORT = path.resolve(process.argv[2] || path.join(__dirname, 'dev', 'Apothecary.Report'));
const PAGES = path.join(REPORT, 'definition', 'pages');
const VISUAL_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.9.0/schema.json';

// Canvas: FHD, margin 32, gutter 24 (spec layout_contract)
const W = 1920, H = 1080, M = 32, G = 24;
const CONTENT_W = W - 2 * M;

// Measure → colour (spec color_map)
const COLOR = {
    'Sales.Sales Amount': '#5B2A86',
    'Budget.Budget': '#8A8A8A',
    'Sales.Margin %': '#0F7B6C',
    'Budget.Budget Attainment %': '#B5651D'
};

// ── Expression helpers ───────────────────────────────────────────────────────

const lit = value => ({ expr: { Literal: { Value: value } } });
const str = text => lit(`'${text.replace(/'/g, "''")}'`);
const num = n => lit(`${n}D`);
const color = hex => ({ solid: { color: str(hex) } });

const measure = (table, name) => ({
    field: { Measure: { Expression: { SourceRef: { Entity: table } }, Property: name } },
    queryRef: `${table}.${name}`,
    nativeQueryRef: name
});
const column = (table, name) => ({
    field: { Column: { Expression: { SourceRef: { Entity: table } }, Property: name } },
    queryRef: `${table}.${name}`,
    nativeQueryRef: name
});

const padding = p => [{ properties: { top: num(p), bottom: num(p), left: num(p), right: num(p) } }];
const title = text => [{ properties: { show: lit('true'), text: str(text) } }];
// Hide the auto-generated "<measure> by <field>" subtitle that repeats the title.
const noSubtitle = [{ properties: { show: lit('false') } }];

/** 20 hex chars derived from a stable id, so regeneration does not churn names. */
const visualName = id => crypto.createHash('sha1').update(`apothecary:${id}`).digest('hex').slice(0, 20);

let z = 0;
function visual(id, position, body) {
    z += 1000;
    return {
        $schema: VISUAL_SCHEMA,
        name: visualName(id),
        position: { ...position, z, tabOrder: z },
        visual: body
    };
}

// ── Layout ───────────────────────────────────────────────────────────────────

const HEADER_Y = M, HEADER_H = 80;                         // slicer height = 60 + 2×8 padding, snapped
const KPI_Y = HEADER_Y + HEADER_H + G, KPI_H = 97;         // card sizing formula at 1080 px: 28pt/14pt fonts
const MID_Y = KPI_Y + KPI_H + G, MID_H = 440;
const TABLE_Y = MID_Y + MID_H + G, TABLE_H = H - M - TABLE_Y;
const SLICER_W = 300;
const CARD_W = Math.floor((CONTENT_W - 2 * G) / 3);
const TREND_W = 1076;
const RANK_X = M + TREND_W + G, RANK_W = W - M - RANK_X;

// ── Visuals ──────────────────────────────────────────────────────────────────

function pageTitle() {
    return visual('page_title', { x: M, y: HEADER_Y, width: W - 2 * M - 2 * (SLICER_W + G), height: HEADER_H }, {
        visualType: 'textbox',
        objects: {
            general: [{
                properties: {
                    paragraphs: [{
                        textRuns: [{
                            value: 'Apothecary Sales: Revenue, Margin and Budget',
                            textStyle: { fontFamily: 'Segoe UI Semibold', fontSize: '28px', color: '#2B1A3D' }
                        }],
                        horizontalTextAlignment: 'left'
                    }]
                }
            }]
        },
        visualContainerObjects: {
            background: [{ properties: { show: lit('false') } }],
            border: [{ properties: { show: lit('false') } }],
            padding: padding(0)
        }
    });
}

function slicer(id, x, table, field, label) {
    return visual(id, { x, y: HEADER_Y, width: SLICER_W, height: HEADER_H }, {
        visualType: 'slicer',
        query: { queryState: { Values: { projections: [column(table, field)] } } },
        objects: {
            data: [{ properties: { mode: str('Dropdown') } }],
            header: [{ properties: { show: lit('true'), text: str(label) } }]
        },
        visualContainerObjects: { padding: padding(8) }
    });
}

function card(id, slot, table, name) {
    const accent = COLOR[`${table}.${name}`];
    return visual(id, { x: M + slot * (CARD_W + G), y: KPI_Y, width: CARD_W, height: KPI_H }, {
        visualType: 'cardVisual',
        query: { queryState: { Data: { projections: [measure(table, name)] } } },
        objects: {
            value: [{ properties: { fontSize: num(28), fontColor: color(accent) }, selector: { id: 'default' } }],
            label: [{ properties: { fontSize: num(14) }, selector: { id: 'default' } }],
            padding: [{ properties: { paddingUniform: num(8) }, selector: { id: 'default' } }],
            layout: [{ properties: { paddingUniform: num(0) }, selector: { id: 'default' } }]
        },
        visualContainerObjects: {
            padding: padding(8),
            spacing: [{ properties: { customizeSpacing: lit('true'), verticalSpacing: num(2) }, selector: { id: 'default' } }]
        }
    });
}

function salesTrend() {
    return visual('sales_trend', { x: M, y: MID_Y, width: TREND_W, height: MID_H }, {
        visualType: 'lineChart',
        query: {
            queryState: {
                Category: { projections: [column('Date', 'Year Month')] },
                Y: { projections: [measure('Sales', 'Sales Amount'), measure('Budget', 'Budget')] }
            },
            sortDefinition: {
                sort: [{ field: column('Date', 'Year Month').field, direction: 'Ascending' }],
                isDefaultSort: true
            }
        },
        objects: {
            dataPoint: [
                { properties: { fill: color(COLOR['Sales.Sales Amount']) }, selector: { metadata: 'Sales.Sales Amount' } },
                { properties: { fill: color(COLOR['Budget.Budget']) }, selector: { metadata: 'Budget.Budget' } }
            ]
        },
        visualContainerObjects: {
            title: title('Monthly sales against budget'),
            subTitle: noSubtitle,
            padding: padding(8)
        }
    });
}

function regionRanking() {
    return visual('region_ranking', { x: RANK_X, y: MID_Y, width: RANK_W, height: MID_H }, {
        visualType: 'clusteredBarChart',
        query: {
            queryState: {
                Category: { projections: [column('Store', 'Region')] },
                Y: { projections: [measure('Sales', 'Sales Amount')] }
            },
            sortDefinition: {
                sort: [{ field: measure('Sales', 'Sales Amount').field, direction: 'Descending' }],
                isDefaultSort: true
            }
        },
        objects: {
            dataPoint: [{ properties: { defaultColor: color(COLOR['Sales.Sales Amount']) } }]
        },
        visualContainerObjects: {
            title: title('Sales by region'),
            subTitle: noSubtitle,
            padding: padding(8)
        }
    });
}

function categoryTable() {
    return visual('category_table', { x: M, y: TABLE_Y, width: CONTENT_W, height: TABLE_H }, {
        visualType: 'tableEx',
        query: {
            queryState: {
                Values: {
                    projections: [
                        column('Product', 'Category'),
                        measure('Sales', 'Sales Amount'),
                        measure('Sales', 'Quantity Sold'),
                        measure('Sales', 'Margin'),
                        measure('Sales', 'Margin %')
                    ]
                }
            },
            sortDefinition: {
                sort: [{ field: measure('Sales', 'Sales Amount').field, direction: 'Descending' }],
                isDefaultSort: true
            }
        },
        objects: {
            columnHeaders: [{ properties: { columnAdjustment: str('growToFit'), autoSizeColumnWidth: lit('true') } }]
        },
        visualContainerObjects: {
            title: title('Revenue and margin by product category'),
            subTitle: noSubtitle,
            padding: padding(8)
        }
    });
}

// ── Write ────────────────────────────────────────────────────────────────────

function main() {
    const pagesJson = JSON.parse(fs.readFileSync(path.join(PAGES, 'pages.json'), 'utf8'));
    const pageId = pagesJson.pageOrder[0];
    const pageDir = path.join(PAGES, pageId);

    const page = JSON.parse(fs.readFileSync(path.join(pageDir, 'page.json'), 'utf8'));
    Object.assign(page, {
        displayName: 'Sales Overview',
        displayOption: 'FitToPage',
        height: H,
        width: W,
        objects: {
            background: [{ properties: { color: color('#F7F6FA'), transparency: num(0) } }]
        }
    });
    fs.writeFileSync(path.join(pageDir, 'page.json'), JSON.stringify(page, null, 2) + '\n');

    const visuals = [
        pageTitle(),
        slicer('year_slicer', W - M - 2 * SLICER_W - G, 'Date', 'Year', 'Year'),
        slicer('region_slicer', W - M - SLICER_W, 'Store', 'Region', 'Region'),
        card('sales_card', 0, 'Sales', 'Sales Amount'),
        card('margin_card', 1, 'Sales', 'Margin %'),
        card('attainment_card', 2, 'Budget', 'Budget Attainment %'),
        salesTrend(),
        regionRanking(),
        categoryTable()
    ];

    const visualsDir = path.join(pageDir, 'visuals');
    fs.rmSync(visualsDir, { recursive: true, force: true });
    for (const v of visuals) {
        const dir = path.join(visualsDir, v.name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'visual.json'), JSON.stringify(v, null, 2) + '\n');
    }
    console.log(`Wrote ${visuals.length} visuals to ${path.relative(process.cwd(), visualsDir)}`);
}

main();
