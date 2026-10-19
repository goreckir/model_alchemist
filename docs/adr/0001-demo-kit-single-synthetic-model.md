---
status: accepted
---

# One synthetic Demo Kit serves as user demo, regression fixture and campaign source, with data generated in Power Query

Model Alchemist needed a demo model for new users, a realistic model to test against, and material for campaign recordings. The only realistic models available were Client Models, which may never be used. We build one synthetic model, the Apothecary Demo Kit in `demo/`, and use it for all three purposes. Its data is generated deterministically in Power Query M, so it refreshes in Power BI Desktop and in Fabric with no files, gateway or credentials. That is required by the scoped-refresh and readiness recordings. Each change between Source and Target is a named Scenario, which is both a recording and a regression test.

## Considered Options

- **Separate assets per purpose** (in-code Contoso fixtures for tests and screenshots, a hand-built model for demos). Rejected: the three would drift apart, and recordings would show behaviour the tests do not cover.
- **Microsoft sample models** (AdventureWorks, Sales & Returns). Rejected: we do not control their licence, look or change set, and they do not cover all eleven Change Groups.
- **CSV or Parquet data in the repo, or a Fabric Lakehouse source.** Rejected: CSV needs file paths that break across machines and needs credentials in Fabric. A Lakehouse ties the demo to one tenant.

## Consequences

- Changing the Demo Kit's shape changes the expected diff counts in the tests, and may make published recordings stale. Treat schema changes as deliberate.
- Data volume is limited by how fast M generates rows. Scale is a `RowCount` parameter, not a fixed dataset.
- The in-code Contoso models in `assets/src/screenshots.js` are replaced by Scenarios.
