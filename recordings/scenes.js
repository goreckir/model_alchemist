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
];
