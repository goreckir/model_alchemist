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
const row = (p, name) => p.locator('.diff-object', { has: p.locator(`.diff-object-name[title="${name}"]`) }).first();

async function deploySelected(d) {
    const p = d.page;
    await d.click(p.locator('#btn-deploy'), { pauseAfter: 0 });
    await p.waitForSelector('#deploy-modal:not(.hidden)');
    await d.wait(1600);
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
    }
];
