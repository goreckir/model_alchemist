/**
 * Scenes: one per Recording. Each names its Scenario (Source/Target model
 * folders) and scripts the UI with the director from lib/capture.js.
 * Captions are burned into the take; keep each to one short sentence.
 */
const path = require('path');

const DEMO = path.join(__dirname, '..', 'demo');
const OUT_SCENARIOS = path.join(__dirname, '..', 'out', 'scenarios');
const MODEL = 'Apothecary.SemanticModel';

const defaultScenario = () => ({
    source: path.join(DEMO, 'dev', MODEL),
    target: path.join(DEMO, 'prod', MODEL)
});
// Built by `node demo/scenarios.js` into out/scenarios/<name>/{source,target}.
const scenario = name => () => ({
    source: path.join(OUT_SCENARIOS, name, 'source', MODEL),
    target: path.join(OUT_SCENARIOS, name, 'target', MODEL)
});

/** Shared opening: type both paths and compare. */
async function openComparison(d, staged, caption) {
    const p = d.page;
    await d.caption(caption);
    await d.wait(500);
    await d.type(p.locator('#dev-path'), staged.source);
    await p.keyboard.press('Tab');
    await d.type(p.locator('#prod-path'), staged.target);
    await p.keyboard.press('Tab');
    await d.wait(300);
    await d.click(p.locator('#btn-compare'), { pauseAfter: 0 });
    await p.waitForSelector('#results-panel:not(.hidden)', { timeout: 20000 });
    await d.wait(600);
}

const group = (p, name) => p.locator('#group-list .group-item', { has: p.locator('.group-name', { hasText: new RegExp(`^${name}$`) }) });
/** Expand a grouped set of changes (e.g. a table that requires refresh). */
const groupHeader = (p, label) => p.locator('.diff-group-header', { has: p.locator('.diff-group-label', { hasText: label }) }).first();
const row = (p, name) => p.locator('.diff-object', { has: p.locator(`.diff-object-name[title="${name}"]`) }).first();

async function openDeployPreview(d, holdMs = 1600) {
    const p = d.page;
    await d.click(p.locator('#btn-deploy'), { pauseAfter: 0 });
    await p.waitForSelector('#deploy-modal:not(.hidden)');
    await p.waitForFunction(() => !/loading|planning/i.test(document.getElementById('deploy-preview').textContent || ''));
    await d.wait(holdMs);
}

async function deploySelected(d) {
    const p = d.page;
    await openDeployPreview(d);
    await d.click(p.locator('#btn-confirm-deploy'), { pauseAfter: 0 });
    await p.waitForSelector('#result-modal:not(.hidden)', { timeout: 20000 });
    await d.wait(1600);
    await d.click(p.locator('#btn-result-ok'));
}


/** Local Source, Fabric Target: type the path, switch Target to Fabric, verify access, compare. */
async function openFabricComparison(d, staged, ctx, caption) {
    const p = d.page;
    await d.caption(caption);
    await d.wait(500);
    await d.type(p.locator('#dev-path'), staged.source);
    await p.keyboard.press('Tab');
    await d.click(p.locator('.source-tabs[data-target="prod"] .source-tab[data-source="fabric"]'), { pauseAfter: 300 });
    await p.waitForSelector('#fabric-selects-prod:not(.hidden)', { timeout: 10000 });
    await d.type(p.locator('#prod-conn-string'), ctx.fabric.connectionString(ctx.fabric.PROD_WS), { delay: 10 });
    await d.click(p.locator('#btn-resolve-prod'), { pauseAfter: 500 });
    await d.cut(() => p.waitForFunction(() => /✓/.test(document.getElementById('fabric-status-prod').textContent || ''), null, { timeout: 30000 }));
    await d.wait(700);
    await d.click(p.locator('#btn-compare'), { pauseAfter: 900 });
    // Loading the model from Fabric takes seconds: show the spinner briefly, then cut.
    await d.cut(() => p.waitForSelector('#results-panel:not(.hidden)', { timeout: 120000 }));
    await d.wait(600);
}

/** Tick the checkbox of a grouped set of changes (e.g. the Price Index parameter group). */
const groupCheckbox = (p, label) => groupHeader(p, label).locator('.diff-group-checkbox');

/**
 * Follow a running refresh in the Model Refresh panel and cut the wait until
 * every tracked refresh (including the automatic post-refresh recalculate) is done.
 */
async function waitInRefreshPanel(d) {
    const p = d.page;
    if (await p.locator('#refresh-modal.hidden').count()) {
        await d.click(p.locator('#btn-model-refresh'), { pauseAfter: 0 });
        await p.waitForSelector('#refresh-modal:not(.hidden)');
    }
    await d.wait(2200);
    await d.cut(async () => {
        await p.waitForTimeout(8000); // let the post-refresh recalculate get queued
        await p.waitForFunction(() => {
            const text = document.getElementById('refresh-panel-content').innerText || '';
            return /Completed/.test(text) && !/In Progress|Starting/i.test(text);
        }, null, { timeout: 15 * 60 * 1000, polling: 2000 });
    });
    await d.wait(2000);
}

/** Deploy and leave the result dialog open (Fabric scenes continue in it). */
async function deploySelectedKeepResult(d) {
    const p = d.page;
    await openDeployPreview(d);
    await d.click(p.locator('#btn-confirm-deploy'), { pauseAfter: 1100 });
    await d.cut(() => p.waitForSelector('#result-modal:not(.hidden)', { timeout: 120000 }));
    await d.wait(1200);
}

module.exports = [
    {
        name: 'launch',
        headline: 'Ship one measure,<br>not the whole model.',
        models: defaultScenario,
        async run(d, staged) {
            const p = d.page;
            await openComparison(d, staged, 'Two versions of the same Power BI model');

            await d.caption('Every difference, sorted into eleven change groups');
            await d.hover(group(p, 'Tables & Relationships'), 500);
            await d.hover(group(p, 'Translations'), 700);
            await d.hover(group(p, 'Functions'), 700);
            await d.wait(500);

            await d.caption('See exactly what changed, down to the format string');
            await d.click(group(p, 'Measures'));
            await d.click(row(p, 'Sales.Sales Amount').locator('.diff-object-header-left'), { pauseAfter: 1800 });

            await d.caption('Pick only what you want to ship');
            await d.click(row(p, 'Sales.Margin %').locator('.diff-checkbox'), { pauseAfter: 600 });
            await d.click(group(p, 'Functions'));
            await d.click(row(p, 'MarginRatio').locator('.diff-checkbox'), { pauseAfter: 800 });

            await d.caption('Preview the plan, then deploy just that');
            await deploySelected(d);

            await d.caption('Everything else in the target stays exactly as it was');
            await d.click(group(p, 'All'), { pauseAfter: 1800 });

            await d.caption('Model Alchemist · free and open source');
            await d.wait(2200);
            await d.caption('');
            await d.wait(400);
        }
    },
    {
        name: 'object-diff',
        headline: 'See the exact line<br>that changed.',
        models: scenario('object-diff'),
        async run(d, staged) {
            const p = d.page;
            await openComparison(d, staged, 'Same model, two branches');

            await d.caption('Power Query: only the changed line is highlighted');
            await d.click(groupHeader(p, 'Sales'), { pauseAfter: 500 });
            await d.click(row(p, 'Sales.Sales').locator('.diff-object-header-left'), { pauseAfter: 2600 });

            await d.caption('DAX: down to the token that changed');
            await d.click(row(p, 'Sales.Average Selling Price').locator('.diff-object-header-left'), { pauseAfter: 2600 });

            await d.caption('Everything identical is left out: no noise, no false alarms');
            await d.wait(2200);

            await d.caption('Model Alchemist · free and open source');
            await d.wait(2200);
            await d.caption('');
            await d.wait(400);
        }
    },
    {
        name: 'selective-deploy',
        headline: 'Deploy one measure.<br>Safely.',
        models: defaultScenario,
        async run(d, staged) {
            const p = d.page;
            await openComparison(d, staged, 'Dev has a new measure. Ship only that.');

            await d.click(group(p, 'Measures'));
            await d.caption('Tick the one measure you want');
            await d.click(row(p, 'Sales.Margin %').locator('.diff-checkbox'), { pauseAfter: 700 });

            await d.caption('It calls a function production does not have yet');
            await openDeployPreview(d, 2800);
            await d.click(p.locator('#btn-cancel-deploy'), { pauseAfter: 500 });

            await d.caption('Add the function, and the plan is clean');
            await d.click(group(p, 'Functions'));
            await d.click(row(p, 'MarginRatio').locator('.diff-checkbox'), { pauseAfter: 700 });
            await deploySelected(d);

            await d.caption('Two objects deployed. Nothing else in production moved.');
            await d.click(group(p, 'All'), { pauseAfter: 2000 });

            await d.caption('Model Alchemist · free and open source');
            await d.wait(2200);
            await d.caption('');
            await d.wait(400);
        }
    },
    {
        name: 'rls-preserved',
        headline: 'Change the rule.<br>Keep the people.',
        models: scenario('rls-preserved'),
        async run(d, staged) {
            const p = d.page;
            await openComparison(d, staged, 'Production roles have real members');

            await d.click(group(p, 'Roles & Row-Level Security'));
            await d.caption('Dev widened the Regional Manager filter');
            await d.click(row(p, 'Regional Manager → Store').locator('.diff-object-header-left'), { pauseAfter: 2200 });

            await d.caption('The members exist only in production');
            await d.hover(row(p, 'Regional Manager → manager.north@apothecary.example'), 700);
            await d.wait(1400);

            await d.caption('Deploy only the filter');
            await d.click(row(p, 'Regional Manager → Store').locator('.diff-checkbox'), { pauseAfter: 600 });
            await deploySelected(d);

            await d.caption('Filter updated. Every member is still there.');
            await d.wait(2400);

            await d.caption('Model Alchemist · free and open source');
            await d.wait(2200);
            await d.caption('');
            await d.wait(400);
        }
    }
    ,
    {
        name: 'scoped-refresh',
        fabric: true,
        headline: 'Refresh only<br>what changed.',
        models: defaultScenario,
        async run(d, staged, ctx) {
            const p = d.page;
            await openFabricComparison(d, staged, ctx, 'Dev on disk, production in Fabric');

            await d.caption('Dev raised every price by 5%');
            await d.click(groupHeader(p, 'Price Index'), { pauseAfter: 400 });
            await d.click(row(p, 'Price Index').locator('.diff-object-header-left'), { pauseAfter: 1800 });
            await d.click(groupCheckbox(p, 'Price Index'), { pauseAfter: 600 });

            await d.caption('Deploy just the parameter');
            await deploySelectedKeepResult(d);

            await d.caption('Only the two tables that read the price need a refresh');
            await d.hover(p.locator('#refresh-offer table'), 600);
            await d.wait(2200);

            await d.caption('One click: a scoped refresh, status live from Fabric');
            await d.click(p.locator('#btn-trigger-refresh'), { pauseAfter: 1400 });
            await d.click(p.locator('#btn-result-ok'), { pauseAfter: 300 });
            await waitInRefreshPanel(d);

            await d.caption('Data reloaded for two tables only. The rest was just recalculated.');
            await d.wait(2400);
            await d.caption('Model Alchemist · free and open source');
            await d.wait(2200);
            await d.caption('');
            await d.wait(400);
        }
    },
    {
        name: 'readiness',
        fabric: true,
        headline: 'Know what still<br>needs a refresh.',
        models: defaultScenario,
        async run(d, staged, ctx) {
            const p = d.page;
            await openFabricComparison(d, staged, ctx, 'Dev adds a holiday flag to the calendar');

            await d.caption('The calendar and the query it reads ship as one unit');
            await d.click(groupHeader(p, 'Date'), { pauseAfter: 400 });
            await d.click(groupCheckbox(p, 'Date'), { pauseAfter: 1800 });
            await d.caption('Deploy now, refresh later');
            await deploySelectedKeepResult(d);
            await d.click(p.locator('#btn-skip-refresh'), { pauseAfter: 400 });
            await d.click(p.locator('#btn-result-ok'), { pauseAfter: 500 });

            await d.caption('Later: is production actually ready?');
            await d.click(p.locator('#btn-model-refresh'), { pauseAfter: 0 });
            await p.waitForSelector('#refresh-modal:not(.hidden)');
            await p.waitForFunction(() => /Date/.test(document.getElementById('target-readiness-panel').innerText || ''), null, { timeout: 60000 });
            await d.wait(800);

            await d.caption('Alchemist reads the processing state of every object');
            await d.hover(p.locator('#target-readiness-panel'), 700);
            await d.wait(2200);

            await d.caption('Fix it from here');
            await d.click(p.locator('.btn-readiness-refresh').first(), { pauseAfter: 600 });
            await waitInRefreshPanel(d);

            await d.caption('Check again: production is ready');
            await d.click(p.locator('#btn-check-readiness'), { pauseAfter: 0 });
            await p.waitForFunction(() => /no objects require/i.test(document.getElementById('target-readiness-panel').innerText || ''), null, { timeout: 60000 });
            await d.wait(2400);
            await d.caption('Model Alchemist · free and open source');
            await d.wait(2200);
            await d.caption('');
            await d.wait(400);
        }
    },
    {
        name: 'fabric-drift',
        fabric: true,
        headline: 'No silent overwrites<br>in production.',
        card: 'fabric-drift-card.png',
        linkedinBand: false,
        // Trim only the end caption; the re-compare result (24 differences) lands late,
        // so hold its frame a little longer before the card returns.
        outro: { trim: 2.9, freeze: 1.5, hold: 3 },
        models: defaultScenario,
        async run(d, staged, ctx) {
            const p = d.page;
            await openFabricComparison(d, staged, ctx, 'You compare Dev with production');

            await d.click(group(p, 'Measures'));
            await d.click(row(p, 'Sales.Margin %').locator('.diff-checkbox'), { pauseAfter: 400 });
            await d.click(group(p, 'Functions'));
            await d.click(row(p, 'MarginRatio').locator('.diff-checkbox'), { pauseAfter: 600 });

            await d.caption('Meanwhile, a colleague publishes to production');
            await d.wait(2000);
            await d.cut(() => ctx.fabric.publishBehindYourBack(ctx.port, staged.source, ['Product.Product Hierarchy']));

            await d.caption('You deploy…');
            await d.click(p.locator('#btn-deploy'), { pauseAfter: 0 });
            await p.waitForSelector('#deploy-modal:not(.hidden)');
            await d.wait(1200);
            await d.click(p.locator('#btn-confirm-deploy'), { pauseAfter: 1100 });
            await d.cut(() => p.waitForSelector('#result-modal:not(.hidden)', { timeout: 120000 }));

            await d.caption('Production changed since you compared. Alchemist refuses.');
            await d.wait(3200);
            await d.click(p.locator('#btn-result-ok'), { pauseAfter: 400 });

            await d.caption('Re-compare: their change is already in, yours is still waiting');
            await d.click(p.locator('#btn-refresh'), { pauseAfter: 900 });
            await d.cut(() => p.waitForSelector('#results-panel:not(.hidden)', { timeout: 120000 }));
            await d.wait(2400);

            await d.caption('Model Alchemist · free and open source');
            await d.wait(2200);
            await d.caption('');
            await d.wait(400);
        }
    }
    ,
    {
        name: 'cherry-pick',
        headline: 'Cherry-pick for<br>semantic models.',
        // LinkedIn: no title band; the cherry-pick opening card is the headline.
        linkedinBand: false,
        // Trim the static tail (end captions) and close on the opening card again.
        outro: { trim: 3.6, hold: 3 },
        models: defaultScenario,
        async run(d, staged) {
            const p = d.page;
            await openComparison(d, staged, 'Compare Dev with production, object by object');
            await d.hover(group(p, 'Tables & Relationships'), 500);
            await d.hover(group(p, 'Functions'), 700);
            await d.wait(600);

            await d.caption('Pick the margin measure and the function it calls');
            await d.click(group(p, 'Measures'));
            await d.click(row(p, 'Sales.Margin %').locator('.diff-checkbox'), { pauseAfter: 500 });
            await d.click(group(p, 'Functions'));
            await d.click(row(p, 'MarginRatio').locator('.diff-checkbox'), { pauseAfter: 700 });

            await d.caption('Pick the holiday flag: column, query and partition ship as one unit');
            await d.click(group(p, 'All'), { pauseAfter: 400 });
            await d.click(groupHeader(p, 'Date'), { pauseAfter: 400 });
            await d.click(groupCheckbox(p, 'Date'), { pauseAfter: 1600 });

            await d.caption('Budget, price change and regional security stay in Dev');
            await d.hover(groupHeader(p, 'Budget'), 600);
            await d.wait(1600);

            await d.caption('Deploy exactly what you picked');
            await deploySelected(d);

            await d.caption('5 objects deployed. 22 differences stay in Dev until they are ready.');
            await d.click(group(p, 'All'), { pauseAfter: 2200 });

            await d.caption('Model Alchemist · free and open source');
            await d.wait(2200);
            await d.caption('');
            await d.wait(400);
        }
    }
];
