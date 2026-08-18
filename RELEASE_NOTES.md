# Model Alchemist — Release Notes

## v5.1.0

### New Features

- **On-demand target readiness checks** — Inspect the current processing state of a Fabric target from the refresh modal without running a deployment first.
- **Actionable readiness results** — Refresh or recalculate individual objects, select several objects for a bulk action, or process every object that needs attention.

### Improvements

- **Post-deployment readiness** — Successful Fabric deployments now report the target model's processing state independently from refresh recommendations derived from the deployed diff.
- **Unified refresh planning** — Deployment refresh hints and live readiness results are merged per table, with the strongest required processing action retained.
- **Readiness diagnostics** — Optional `MA_READINESS_DEBUG` logging identifies unsupported Arrow compression types without affecting normal operation.

### Architecture

- `server.js` — Adds `GET /api/fabric/readiness`, exports readiness helpers for isolated tests, and starts the listener only when executed directly.
- `public/js/pure.js` — Centralizes readiness rendering, selection, and refresh-plan merging as testable pure functions.
- `test/frontend.test.js` and `test/server.test.js` — Cover readiness rendering, bulk actions, API wiring, error handling, and state isolation.

---

## v5.0.0

Correctness release. It closes 59 verified defects (11 critical, 23 high, 25 medium)
found in a full review of v4.9.0 plus live testing against real DEV/UAT and Fabric
models, and adds the first automated test suite.

### Read this before upgrading

Four changes alter what the tool does, on purpose:

1. **A Fabric deploy now refuses to upload a stale snapshot.** If the model changed
   in Fabric after your comparison was taken, the deploy stops with
   `PROD_CHANGED_SINCE_COMPARE` and lists the files. Re-compare and deploy again.
   Previously those changes were silently reverted.
2. **A local deploy is transactional.** It stops at the first failing operation and
   restores every file it touched. Previously it continued past failures and left a
   half-written model.
3. **More diffs appear, and some Add+Remove pairs collapse into one modify.**
   Properties that were never compared are now compared (see below), and identity is
   case-insensitive with per-environment GUIDs normalized, matching Analysis Services.

Each browser tab now keeps its own comparison state (`x-ma-session` header), so two
tabs no longer overwrite each other's deploy target. Fabric authentication itself
remains process-wide (one signed-in account per running server), not per-tab.

4. **`PBI_*` annotations and `sourceLineageTag` are undeployable by design.** They
   are always preserved from the target during deploy, even when the comparison
   shows them as a diff, so Fabric's own IDs and Power BI's internal bookkeeping are
   never overwritten by a cross-environment deploy. To change either value, edit it
   directly in the target model (e.g. via Fabric/Desktop) rather than through this
   tool.

### Changes that were invisible before

The comparison now detects: incremental `refreshPolicy`, column `variation` blocks,
`formatStringDefinition` and `detailRowsDefinition`, `alternateOf` aggregation
mappings, every non-whitelisted column property (e.g. `isAvailableInMdx`), KPI
`statusGraphic` / `trendGraphic`, culture `linguisticMetadata` (Q&A synonyms),
`dataSource` connection details, `dataAccessOptions`, and translations below three
levels (hierarchy-level captions, translated display folders).

### Deployments that silently did nothing

Adding a relationship to a model with no `relationships.tmdl`; RLS membership
changes; any object whose file name differs from its object name; calculation-group
removes and modifies; and modifies of children of a table whose name contains a dot.
All of them reported success while writing nothing. They now work, and a missing
source is an error rather than a silent skip.

### Deployments that wrote the wrong thing

A `tablePermission` change replaced the whole role file, swapping PROD RLS members
for DEV accounts. A calculation-group add wrote every item twice, making the model
unloadable. A model-properties change deleted refs indented under `model Model`.
A table header change copied DEV's `lineageTag`. `sourceLineageTag` was never
preserved. PBI_* runtime annotations were deployed despite being excluded from
comparison. All fixed; block replacement now merges instead of overwriting, and the
preview names any block content that ships beyond the reviewed properties.

### Bug Fixes

**Parser** — a `///` comment above a top-level `ref` crashed the whole model load;
object names containing ` = ` were mis-split; DAX continuation lines were swallowed
as properties and truncated expressions; `quoteName` under-quoted names, writing
invalid refs and leaving dangling refs on remove.

**Comparison** — child identity keys used an ambiguous dot separator, so a dotted
table name could mask a real change; keys were case-sensitive while AS names are
case-insensitive-unique; relationship identity included `isActive` and
`crossFilteringBehavior`, turning a modify into an Add+Remove whose Add created a
duplicate; partitions were keyed by their per-environment GUID, reporting every
table as Added+Removed; quoted relationship endpoints never matched their column
diffs; refresh groups absorbed unrelated metadata changes; a diff could belong to
two groups and render twice with desynced checkboxes. A rename detector now pairs
Add/Remove into one atomic group that states the Fabric data-loss consequence.
Partition and relationship ordinal keys (`#2`, `#3`, ...) were assigned by raw file
order, so two candidates sharing a base identity could silently overwrite each
other, and DEV/PROD listing relationships in different order could pair the wrong
pair together; both are now assigned by grouping candidates by their natural
identity and sorting each group by a deterministic content signature first, so the
same DEV/PROD structure always pairs the same way regardless of file order. The
rename detector's internal delimiters were raw NUL/control bytes, making the whole
file look binary to git; they are now literal escape-sequence text with identical
runtime behavior.

**Validation** — a `calculationItem` could be selected without its calculation
group; removing a table left dangling perspective, culture and role references; the
cascade used `startsWith`, so removing `Sales` also removed the relationship of
`Sales.EU`; escaped quotes in perspective names caused false hard blocks; a missing
`prodModel` caused an unconditional `compatibilityLevel` overwrite, including
downgrades.

**Fabric** — an expired token was handed out forever while the UI reported
connected; workspace and model lists read only the first page; a slow but successful
deploy was reported as failed after 120s (now 10 minutes, and a timeout is reported
as indeterminate); per-file parse errors silently dropped whole tables; `TimedOut`
and `Cancelling` refresh statuses never reached a terminal state. A forced deploy
over Fabric drift (`force: true`) now re-extracts the target model from the live
definition and re-plans against it, instead of planning against the stale
compare-time snapshot and risking a mismatched deploy. A case-only rename (e.g.
`sales` → `Sales`) is now deployable: block lookup during deploy is case-insensitive,
matching Analysis Services identity semantics.

**Deployment safety** — a rollback that failed to restore one or more files used to
be silently swallowed and still reported "the target is unchanged"; it now reports
a `ROLLBACK_INCOMPLETE` error naming the affected files and never claims the target
is unchanged unless every file was actually restored. A Fabric deploy's warnings
(e.g. `UNREVIEWED_BLOCK_CHANGES`) used to be dropped from the response, and the
backup action recorded before upload could be silently overwritten; both are now
preserved. When the target model can't be indexed, target file paths are now
guessed with an explicit `TARGET_PATHS_GUESSED` warning instead of silently.
Removing a whole role while one of its `tablePermission`/`roleMember` diffs was
also selected planned a redundant child operation against a file the role removal
had already deleted, failing with `TARGET_FILE_MISSING` and forcing a rollback
(mirrors the existing table/child-object guard, now extended to roles). That
rollback then failed to restore any file deleted earlier in the same batch, because
it tried to read-compare the file before rewriting it instead of just recreating
it — both are now fixed, and this exact sequence (found live, not in the original
review) is locked down by a dedicated regression test.

**Server** — `/api/compare` left the previous Fabric model and dataset armed;
`detectTablesNeedingRefresh` re-read mutable global state after a long await;
overlapping status polls could fire the post-refresh calculate twice; an `await`
precedence bug sent `Bearer [object Promise]`; `PORT` from the environment is a
string, so the EADDRINUSE fallback bound port 30011 instead of 3002.

**UI** — errors rendered inside a hidden panel, so a failed refresh left stale diffs
looking current; "Select All Visible" selected the previous view's items when the
current view was empty; member and group checkboxes disagreed under an active
filter; `data-key` was not quote-escaped, so a name containing `"` expanded to an
empty panel; Markdown export corrupted on multiline values and unescaped pipes; the
deploy preview ignored `response.ok` and rendered server errors as "No file
operations planned"; a second refresh abandoned polling of the first; search at
exactly one character kept the previous result set; group membership was an
O(diffs × members) scan re-run on every keystroke.

### Tests

`npm test` runs 138 tests on Node's built-in runner — no new dependencies. Each test
is named after the issue it locks down.

### Architecture

New modules: `comparison/keys.js` (identity keys), `comparison/refs.js` (TMDL
reference parsing), `comparison/rename-detector.js`, `lib/session-store.js`,
`lib/raw-files.js`, `public/js/pure.js` (DOM-free UI logic), `test/`.

---

## v4.9.0

### New Features
- **Inline refresh error guidance** — Added inline guidance for a known refresh failure (unbound data source / missing cloud connection), shown directly in the refresh error UI.

### Improvements
- **Cleaner deploy preview** — Deploy preview/result now skip idempotent "ensure" operations that are already no-ops, so the UI no longer shows misleading "will change" entries for properties already correct on TARGET.
- **Reduced false-positive diffs** — Removed `discourageImplicitMeasures` from the generic Model Properties diff (it's auto-managed by calculation-group deploy logic), eliminating a recurring false-positive diff.

### Bug Fixes
- **Duplicate `discourageImplicitMeasures` on deploy** — Fixed a bug where deploying a second/subsequent calculation group could corrupt `model.tmdl` with a duplicate `discourageImplicitMeasures` property (parser didn't recognize TMDL boolean-shorthand form), breaking the model in Fabric/Power BI.

---

## v4.8.0

### New Features
- **Group diffs by Table / Display Folder** — Added a grouping toggle in the sidebar (next to Expand All/Collapse All) that organizes the diff list into a flat set of collapsible groups (e.g. "table_a", "table_a / Folder A", "table_a / Folder A / Subfolder"), each with its own checkbox for bulk-selecting the diffs in that group. Icons: ▦ for the table level, 📁 for folders.

### Bug Fixes
- **Grouping toggle cleared the diff view** — Fixed a bug where clicking the grouping toggle cleared the entire diff view (conflict with the global `.filter-btn` listener, which reset `activeFilter` to `undefined`). Resolved by giving the toggle its own dedicated `.group-toggle-btn` CSS class.
- **"Select All Visible" missed collapsed groups** — Fixed `selectAllVisible()` so selecting "all visible" diffs also works for collapsed/not-yet-rendered groups (now based on the full `lastVisibleDiffs` list instead of only elements currently in the DOM).

### Architecture
- `public/js/app.js` — New functions `getDisplayFolder`, `buildLocationGroups`, `comparePathParts`, `createLocationGroupElement`; new state `groupByLocation` (persisted via localStorage `ma_groupByLocation`) and `lastVisibleDiffs`.
- `public/index.html` — New `#btn-group-location` button.
- `public/css/style.css` — New `.group-toggle-btn` and `.location-group` styles.
- Frontend-only change, no backend/API changes.

---

## v4.7.0

### New Features
- **Inline diff highlighting in UI** — Modified properties now show exact changed fragments directly in Source/Target values, making it clear where a change happened without manual scanning.
- **Multiline line-diff view** — Long properties (for example expressions/translations) are rendered with line-based diff, change counters, context windows, and quick focus on the first change.

### Improvements
- **HTML export now highlights exact changes** — Exported HTML report uses the same diff approach as UI (inline highlights + multiline line-diff), improving readability outside the app.
- **CSV export for automation** — CSV now contains a `Section` column (`SUMMARY`/`DETAILS`) and preserves raw multiline values for reliable parsing/copy-paste workflows.
- **CSV encoding compatibility** — Added UTF-8 BOM to improve Excel compatibility for Polish and other non-ASCII characters.

### Bug Fixes
- **Large text diff false positives** — Fixed edge case where very large multiline values could over-report changed lines after LCS guard fallback.

### Architecture
- `public/js/diff.js` — New lightweight diff module (token and line-level diff with safeguards for large inputs).
- `public/js/app.js` — Property renderer upgraded to use inline and multiline diff strategies; export generators updated for HTML and CSV behavior.
- `public/css/style.css` — Added styles for inline change marks and multiline line-diff rows.
- `public/index.html` — Loads the new `diff.js` module before application code.

---

## v4.6.3

### Improvements
- **Terminology update** — Replaced "DEV" with "Source" and "PROD" with "Target" in all user-facing messages for clarity and consistency. This includes error messages, deployment modals, activity logs, and export formats (CSV, Markdown, HTML).

### Architecture
- `public/js/app.js` — Updated all user-visible strings: validation errors, deployment confirmations, export headers, and activity log labels.
- `public/index.html` — Updated deployment modal title from "Deploy Changes to PROD" to "Deploy Changes to TARGET".

---

## v4.6.2

### Improvements
- **Fabric source swap support** — The ⇅ swap button now fully supports exchanging Fabric sources (connection strings, verification status, and active tabs) in addition to local paths. Users can now swap Source↔Target for any combination: Local↔Local, Fabric↔Fabric, and Local↔Fabric.

### Architecture
- `public/js/app.js` — Extended `swapModels()` function to exchange Fabric connection strings, Fabric status messages (including CSS classes), trigger tab switching via `switchSourceTab()`, and persist Fabric connection strings to localStorage.

---

## v4.6.1

### New Features
- **Power BI External Tool onboarding** — Added user documentation for launching Model Alchemist directly from Power BI Desktop via External Tools integration.

### Improvements
- **Setup instructions for `.pbitool.json`** — Documented how to adjust the `arguments` path to local `start.bat` location before use.
- **External Tools deployment step** — Added clear copy step for placing `model-alchemist.pbitool.json` in Power BI Desktop External Tools directory.

### Architecture
- `README.md` — Added new "Power BI External Tool Setup" section with step-by-step configuration guidance.
- `pbitool/model-alchemist.pbitool.json` — Added External Tool manifest file to repository.

---

## v4.6.0

### New Features
- **Relationship cardinality change warnings** — Model Alchemist now detects changes in relationship cardinality (e.g. many-to-many → many-to-one) and displays comprehensive warnings before deployment. When changing to a more restrictive cardinality (any relationship ending with "to-one"), the system warns users to verify that key columns don't contain duplicates, as Fabric will block deployment if data integrity requirements aren't met. If deployment fails, an enhanced error message provides step-by-step troubleshooting instructions, including which specific columns need to be unique and a reminder to refresh table data before retrying.

### Improvements
- **Contextual relationship deployment errors** — When a relationship deployment fails in Fabric, the error message now includes intelligent context detection. For cardinality changes, the system explains common causes (duplicate keys, stale data) and provides actionable resolution steps specific to the relationship type (many-to-one, one-to-many, or one-to-one). This eliminates the need for users to manually diagnose cryptic Fabric API errors like "missing options".

### Architecture
- `comparison/engine.js` — Modified diff detection now includes `cardinalityChange` metadata for relationships, capturing the transition (e.g. "many-to-many → many-to-one") and flagging whether data validation is required.
- `deployment/deployer.js` — Added pre-deployment check for cardinality changes requiring data validation; emits detailed warnings with integrity requirements for each relationship type.
- `server.js` — Enhanced Fabric deployment error handler detects relationship-related failures and appends troubleshooting guidance referencing the specific relationship and required unique columns.

---

## v4.5.2

### Bug Fixes
- **Perspective comparison false positives due to item ordering** — Fixed a bug where perspective comparisons reported false differences when measures, columns, or hierarchies were listed in a different order between DEV and Fabric, even though the actual content was identical. The extractor now sorts `includedMeasures`, `includedColumns`, `includedHierarchies`, and `includedTables` lists alphabetically before comparison, eliminating false positives caused by differing item order. This resolves the issue where deployments succeeded but the comparison view continued to show perspective changes.

### Architecture
- `comparison/extractor.js` — `extractPerspective()` now applies `.sort()` to tables, measures, columns, and hierarchies arrays before joining them into comma-separated strings for comparison.

---

## v4.5.1

### Bug Fixes
- **Perspective comparison not detecting measure/column/hierarchy changes** — Fixed a bug where modifying the list of measures, columns, or hierarchies within a perspective was not detected as a change during model comparison. The comparison engine now correctly extracts and compares `includedMeasures`, `includedColumns`, and `includedHierarchies` for each perspective, ensuring that renaming or removing measures referenced by a perspective triggers a "Modified" diff. This resolves deployment errors like "Property Measure of object 'perspective measure' refers to an object which cannot be found" when measures are renamed or removed without updating the perspective.

### Architecture
- `comparison/extractor.js` — `extractPerspective()` now recursively extracts `perspectiveMeasure`, `perspectiveColumn`, and `perspectiveHierarchy` children from each `perspectiveTable`, storing them as comma-separated lists in the object's properties for comparison.

---

## v4.5.0

### New Features
- **start.bat launcher** — Added `start.bat` file for one-click server start from Windows Explorer. Double-click the file to launch the server in a persistent console window with UTF-8 support and emoji in the title bar (⚗️ Model Alchemist). Close the window to stop the server.
- **VS Code F5 launch configuration** — Added `.vscode/launch.json` with two debug configurations: "Start Model Alchemist" (normal mode) and "Start Model Alchemist (watch)" (auto-restart on file changes). Press F5 in VS Code to start the server with integrated debugging support.

### Improvements
- **Enhanced README "Running" section** — Updated documentation now describes three launch methods: F5 in VS Code, double-click `start.bat`, or `npm start` in terminal. Added clarification that port 3001 is the default, with automatic fallback to 3002, 3003, etc. if the port is busy. The actual URL is always printed in the terminal on startup.
- **Removed redundant Environment Variables section** — Eliminated the `PORT` variable documentation table (now covered inline in the Running section).

---

## v4.4.0

### New Features
- **Manual Recalculate button** — New "🔄 Recalculate" button in the Model Refresh panel footer. Triggers a `calculate`-type refresh (recalculates DAX calculated columns, calculated tables and measures) without re-importing data from sources. Useful after deploying relationships or measures to force the engine to rebuild relationship indexes. The button is automatically disabled while any other refresh is in progress.
- **Pre-deploy validation warnings in modal** — Warnings returned by the deployment validator (e.g. relationship ordering conflicts) are now displayed prominently in the Deploy Confirmation modal, above the action list, before the user clicks "Confirm Deploy". Previously these warnings were silently dropped after being logged to the activity log only.

### Improvements
- **Refresh failure diagnostics** — When a Fabric refresh fails, the error details (`serviceExceptionJson`) returned by the Fabric API are now:
  - Shown **expanded by default** in the Refresh panel (no longer hidden behind a collapsed `<details>` toggle), so the user immediately sees the cause (e.g. "Column 'Version' does not exist in table 'Dim_Snapshot'").
  - Falls back to a clear message directing the user to the Fabric portal when no error detail is available.
- **Activity log captures refresh errors** — `refresh-status` log entries now include `serviceExceptionJson` (top-level) and `objectErrors[]` (per-table) when a refresh fails, making `activity.jsonl` directly useful for post-mortem diagnosis without opening the Fabric portal.
- **Pre-deploy relationship ordering check** — The validator detects when a selected relationship (add or modify) has unselected structural changes pending on its endpoint tables (partition expression changes, column adds/removes). Emits a `RELATIONSHIP_PENDING_TABLE_CHANGES` warning with the specific table and change names, explaining that Fabric may reject the deployment with "missing options" until those table changes are deployed and refreshed first.

### Bug Fixes
- **Relationship changes incorrectly triggering data refresh** — Added (`type=0`) and modified (`type=2`) relationships are pure metadata changes and do not require a data refresh. Only relationship removals (`type=1`) need cascade-aware refresh. Engine now correctly skips `requiresRefresh` for add/modify relationship diffs.

### Architecture
- `deployment/validator.js` — New check `RELATIONSHIP_PENDING_TABLE_CHANGES` (section 5); signature extended with `allDiffs` parameter.
- `deployment/deployer.js` — Passes `allDiffs` from comparison result to `validateDependencies`.
- `server.js` — `logEvent('refresh-status')` now includes error details on failure; `/api/fabric/refresh/status/:requestId` response includes `topLevelError` field.
- `lib/refresh-store.js` — `updateRefreshRecord()` captures top-level `serviceExceptionJson` from Fabric API response.
- `public/js/app.js` — Deploy preview renders warnings/errors inline; Refresh panel error block opened by default; `handleManualCalculate()` added; `updateRefreshButton()` disables calculate button during active refresh.
- `public/index.html` — "🔄 Recalculate" button added to Refresh modal footer.

---

## v4.3.1

### New Features
- **Auto-calculate after dataOnly refresh** — After a `dataOnly` refresh completes, the server automatically triggers a model-level `calculate` to rebuild relationship indexes. This prevents "relationship does not hold any data" errors that occurred when deploying table changes without a full refresh.

### Improvements
- **Two-phase refresh UI** — The front-end now displays both phases (data refresh → calculate) with continuous progress tracking. When the data phase completes and calculate is auto-triggered, polling seamlessly continues on the new request.
- **Refresh offer info** — When a deployment requires `dataOnly` refresh, the UI now shows a note explaining that a post-refresh calculate will run automatically.

### Architecture
- `server.js` — POST `/api/fabric/refresh` sets `needsPostCalculate` flag; GET `/api/fabric/refresh/status/:requestId` auto-triggers `calculate` when dataOnly completes and returns `postCalculate` info in response.
- `lib/refresh-store.js` — `createRefreshRecord()` accepts `options` parameter with `needsPostCalculate`, `postCalculateTriggered`, `postCalculateRequestId` fields.
- `public/js/app.js` — `pollRefreshStatus()` detects `postCalculate` response and chains polling to the calculate requestId; refresh offer panel shows two-phase info.

---

## v4.3.0

### New Features
- **Folder picker** — File browser now opens a folder dialog (`FolderBrowserDialog`) instead of a file picker. Users select the `.SemanticModel` directory directly — this supports working with repository-based models that may not have `.pbip` starter files. The resolver intelligently handles: `.SemanticModel` folders, parent folders containing `.SemanticModel`, and `definition/` subfolders.
- **Default backup directory** — Backups are stored in an application-local `backups/` folder by default (added to `.gitignore`). Users can override the path in the UI; the choice is persisted to `localStorage`.

### Improvements
- **Version single source of truth (TD4)** — Version is now defined only in `package.json`. The server exposes `/api/defaults` (includes version); the frontend fetches it on load and updates the page title and version badge dynamically. No more hardcoded version strings in HTML, JS, or console output.
- **Backup path always visible** — The backup path input is always displayed in the deploy panel (previously hidden until deploy click), making it discoverable and editable at any time.

### Architecture
- `server.js` — New endpoints: `GET /api/version`, `GET /api/defaults`; `APP_VERSION` constant read from `package.json`; `BACKUP_DIR` defaults to `./backups`; PowerShell dialog switched to `FolderBrowserDialog`; `resolveModelFromFile()` rewritten for directory-based resolution.
- `deployment/deployer.js` — `createBackup()` accepts optional `customBackupPath` parameter.
- `public/js/app.js` — New `loadDefaults()` on startup; backup path logic decoupled from Fabric-only mode.
- `.gitignore` — Added `backups/` entry.

---

## v4.2.0

### New Features
- **Model Refresh panel** — New dedicated panel for triggering and monitoring Enhanced Refreshes on Fabric semantic models. Tracks refresh status in real-time with session history persisted to local JSONL files.
- **Per-table refresh type classification** — Engine determines optimal refresh type (`full` vs `dataOnly`) per table based on structural vs data-only changes, with detailed reasoning displayed in the UI.
- **Activity log** — All compare, deploy, and refresh operations are logged to `logs/activity.jsonl` with timestamps. New UI viewer accessible from the header.
- **Auto-verify Fabric on Compare** — Clicking "Compare" with a Fabric source automatically resolves the connection (verifies access) without requiring a manual "Verify Access" click first.
- **Cascade groups** — Column/table deletions and their dependent relationship deletions are automatically grouped into a single atomic UI group, preventing partial deployments that would break the model.

### Improvements
- **Filter PBI_* annotations** — Internal Power BI annotations (`PBI_*`) are excluded from comparison results to reduce noise.
- **Ignore lineageTag** — `lineageTag` and `sourceLineageTag` properties are filtered out during property comparison (auto-generated, not meaningful for diffs).
- **Select All includes collapsed groups** — "Select All" now correctly selects members of collapsed atomic groups.
- **Auto-cascade relationship removal** — When a column is removed, dependent relationships are automatically included in the deployment plan (previously caused Fabric rejection).
- **Word-boundary dependency matching** — Expression dependency detection uses word-boundary regex to avoid false positives on partial name matches.
- **Full .SemanticModel backup** — Backup now copies the entire `.SemanticModel` folder, not just modified files.
- **Auto discourageImplicitMeasures** — Deploying a calculation group automatically sets `discourageImplicitMeasures = true` on the model if not already set.
- **Skip removed tables from refresh** — Tables being deleted are no longer flagged for data refresh (which would fail immediately).

### Bug Fixes
- **Refresh status crash** — `mapStatus` crashed when API returned numeric HTTP status (e.g. 202) instead of string. Fixed with `String()` coercion.
- **calculationItem parentIndent** — Fixed deploy using wrong indentation depth (1→2) for calculation items inside calculation groups.
- **Silent no-op detection** — Deploy now detects when a write operation silently did nothing (block not found in target file) and reports it as a warning/error.
- **Perspective ref validation** — Validates perspective references before deploy to prevent orphaned entries.
- **Empty action result line** — Removed spurious empty `[]` from Fabric deploy success summary.
- **Skip child diffs on table add/remove** — When a whole table is added or removed, individual child diffs (columns, measures) are no longer processed separately.
- **Select All Visible scope** — "Select All Visible" now respects the current search filter.
- **Block UDF deploy on old compat** — UDF deployment is blocked when target `compatibilityLevel` < 1702.
- **Ref entries indentation** — Fixed `ref` entries in `model.tmdl` being written with incorrect indentation + `culture` → `cultureInfo` key fix.
- **Backup path required** — Backup path field is now properly validated before deploy.

### Core / Architecture (P0–P2 critical fixes)
- **P0.1** — UDF (function) deploy support in `planSingleDiff`.
- **P0.2** — Model-level changes (`model.tmdl`) now handled in `planSingleDiff`.
- **P0.3** — TMDL indent validation at load time (rejects spaces, requires tabs).
- **P0.4** — `lineageTag` from Target is preserved during object modification (prevents Fabric regeneration).
- **P1.5** — Extractor expanded with critical TMDL properties (formatString, summarizeBy, etc.).
- **P1.6** — Composite identity key for relationships (fromTable+fromColumn+toTable+toColumn) replaces unreliable GUID matching.
- **P1.7** — Dependency validation at deployment time (blocks deploy if referenced objects are missing).
- **P1.8** — Atomic table-modify: modifying a table preserves all child objects in the target that are not explicitly changed.

---

## v4.1.0

### New Features
- **Parameter refresh groups** — Parameters (named expressions with `IsParameterQuery`) are now displayed as separate refresh groups with ⚡↻ icon and label "Parameter 'X' affecting N tables". Transitive dependencies are resolved via BFS (e.g. `PBI_Environment` → `silver_Release_Notes` → `_Release_Notes`).
- **Calculation Group refresh detection** — Adding/removing calculation items or changing their ordinal now correctly triggers a refresh group for the parent CG table.
- **Auto port fallback** — If port 3001 is busy, the server tries up to 20 consecutive ports before giving up.
- **Auto-open browser** — Browser opens automatically when the server starts listening.

### Improvements
- **`///` description parsing** — TMDL `///` annotation lines are now collected as `description` property and included in `rawBlock` for correct comparison and deployment.
- **Refresh group icons** — Regular table groups show ↻, parameter groups show ⚡↻ for visual distinction.
- **Parameter groups at top** — Parameter-driven refresh groups appear before table groups in the UI.
- **Alphabetical sort within groups** — Both parameter and table refresh groups are sorted alphabetically.

### Bug Fixes
- **Parameters not triggering refresh** — Fixed filter that prevented parameter changes from being linked to dependent tables.
- **Transitive dependency resolution** — Parameters depending on other expressions (chains) now correctly resolve all downstream tables.
- **`///` vs `//` confusion** — Parser now correctly distinguishes description annotations (`///`) from regular comments (`//`).

### Architecture
- `parser/tmdl-parser.js` — `pendingDescription` collection for `///` lines; skip `//` comments separately.
- `deployment/tmdl-writer.js` — `findObjectBlock` looks backwards to include preceding `///` lines.
- `comparison/extractor.js` — `extractPartition` accepts `isCalcGroupTable` flag for CG classification.
- `comparison/engine.js` — `computeGroups` separates parameter diffs (by `changeGroup`) from table diffs; BFS `findDependentExprNames()`; `parameterGroups` with `isParameterGroup: true`.
- `server.js` — `startServer()` with port retry loop + auto-open browser; `detectTablesNeedingRefresh` updated for calculation items.

---

## v4.0.0

### New Features
- **Refresh Groups** — Changes are automatically grouped by data refresh dependency. Tables sharing named expressions (Power Query sources) are merged into a single deployment group. Groups clearly indicate which tables require a data refresh after deployment.
- **Search in diff list** — New search box in the comparison header filters visible differences by name (activates from 2nd character typed).
- **UDF (User Defined Functions) support** — Functions defined in the model are now extracted, compared, and deployed as a separate "Functions" change group.
- **Translation details** — Culture/translation objects now show per-object translation details (caption/description) instead of just the culture name.
- **Calculation Groups classification** — Calculation group tables and their columns are now correctly classified into the "Calculation Groups" change group (previously mixed with Tables).

### Improvements
- **UI layout overhaul** — Diff items now show: `<name> [type] +/~/− ▼` with type badge pushed to the right via flexbox.
- **Alphabetical sort** — Diff list is sorted alphabetically by display name (no longer grouped by type).
- **Ellipsis for long names** — Object names that exceed available width are truncated with "..." and show the full name in a tooltip on hover.
- **Group badges right-aligned** — "N changes" count and "REQUIRES REFRESH" badge are pushed to the right side of group headers.
- **Relationships merged into Tables** — Relationships are now part of "Tables & Relationships" group instead of a separate group.
- **Named expressions → table refresh linking** — Engine checks ALL partition expressions (not just changed ones) to correctly link named expression changes to dependent tables.
- **Multi-table group merging** — Groups sharing the same named expression keys are automatically merged.

### Bug Fixes
- **Parser: bare keywords** — Fixed `parseDeclaration()` failing on bare keywords without names (e.g., `calculationGroup`, `translations`). Added bare keyword detection before the main name+type regex.
- **Columns in CG tables** — Columns belonging to calculation group tables are now correctly assigned to "Calculation Groups" change group instead of "Tables & Relationships".

### Architecture
- `comparison/extractor.js` — Added `extractFunction()`, enhanced `extractCulture()` with translation tree parsing, `extractColumn()` accepts `isCalcGroupTable` flag.
- `comparison/engine.js` — `computeGroups(diffs, devObjects)` rewritten: takes full devObjects for partition expression matching, merges multi-table groups.
- `parser/tmdl-parser.js` — `parseDeclaration()` handles bare keywords via `bareMatch` check.

---

## v3.5.0

### New Features
- **Export comparison report** — New "Export" dropdown in the header allows exporting all detected differences to CSV, Markdown, or HTML format.
  - **CSV** — flat table with all diffs and property values for further analysis in Excel.
  - **Markdown** — structured report with summary table, side-by-side property tables for simple values, and fenced code blocks for expressions/Power Query.
  - **HTML** — dark-themed standalone page with side-by-side code comparison (syntax-highlighted) and collapsible sections.
- **Cancel Fabric login** — A cancel button appears during Fabric authentication, allowing users to abort the browser login flow without restarting the app.

### Improvements
- **Fabric login message** — Success page now shows "🧙 The gates of knowledge are open" with UTF-8 encoding.
- **Deploy result display** — Backup actions are no longer shown in the deploy success summary (previously displayed as "✓ []").
- **Markdown export quality** — Expression/source properties render as labeled code blocks; simple properties (dataType, isHidden, etc.) render in compact side-by-side tables. Redundant TMDL code fences are automatically stripped.

### Bug Fixes
- **UTF-8 in auth pages** — Added `<meta charset="utf-8">` to MSAL success/error HTML templates to fix garbled characters.
- **Double code fence** — Fixed Markdown export producing ```` ``` ```` on consecutive lines when TMDL values already contained fence markers.

---

## v3.1.0

### Improvements
- **Reliable file picker in Chrome** — Rewrote PowerShell file dialog to use Win32 `SetForegroundWindow` API for forced focus activation. The dialog now always appears on top regardless of which browser/window is active.
- **Model info display** — Comparison header now shows the original `.pbip` filename and its directory path (instead of the resolved `definition/` folder).
- **Source/Target labels** — Renamed "DEV"/"PROD" badges to "Source"/"Target" with neutral white styling for clearer terminology.
- **Consistent icons** — 📁 for local models, ☁️ for Fabric models in the comparison header.

---

## v3.0.0

### New Features
- **Microsoft Fabric connectivity** — Compare and deploy semantic models directly from Microsoft Fabric workspaces via REST API. No local files required.
- **OAuth browser-based authentication** — Secure sign-in via Microsoft login page (MSAL + PKCE). No credentials are stored — only a session token in memory.
- **Independent DEV/PROD sources** — Each side (DEV and PROD) can independently use a local `.pbip` file or a Fabric connection string. Mix-and-match freely.
- **Connection string inputs** — Paste a Power BI connection string (`Data Source=powerbi://...;Initial Catalog=...;`) and click "Verify Access" to resolve workspace/model.
- **Deploy to Fabric** — Selected changes are applied and uploaded back to the target Fabric semantic model via `updateDefinition` API.
- **Refresh for Fabric models** — The Refresh button now re-fetches and re-compares Fabric models (not just local files).

### Improvements
- **No Python dependency** — File picker now uses PowerShell `System.Windows.Forms.OpenFileDialog` instead of Python/tkinter. Zero external runtime dependencies on Windows.
- **Fabric long-running operations** — Proper polling of Fabric API async operations with status checks (`Running`/`Succeeded`/`Failed`) and `/result` endpoint fallback.
- **Cache-busting headers** — Static files served with `no-store` to prevent stale UI after updates.
- **Connection string parser** — New module to parse Power BI connection strings into workspace/model identifiers.

### Architecture
- `fabric/auth.js` — MSAL interactive login with system browser, token caching in memory.
- `fabric/api-client.js` — Fabric REST API client (list workspaces, list models, get/update definition).
- `fabric/model-loader.js` — Converts Fabric TMDL definition into the same format as local models.
- `fabric/connection-parser.js` — Parses `Data Source` + `Initial Catalog` from connection strings.

---

## v2.2.0

### New Features
- **Native file picker (OS dialog)** — Model selection now opens a native Windows file dialog (via Python/tkinter) instead of a custom web-based file browser. The dialog title indicates whether picking DEV or PROD.
- **Path persistence (localStorage)** — Selected DEV and PROD paths are remembered across browser sessions.
- **Swap DEV ↔ PROD** — New swap button (⇅) between model fields to quickly reverse source and target.
- **Editable path inputs** — Path fields are no longer read-only; users can paste/edit paths manually and the app resolves them on blur.
- **Initial directory** — File dialog opens in the folder of the currently selected file (or last used location if empty).
- **Expand/Collapse All** — New buttons in the comparison view to expand or collapse all diff details at once.
- **Labels with filenames** — "Source" and "Target" labels now display the selected `.pbip` filename.

### Improvements
- Server version string updated to v2.2.
- Removed unused web-based file browser modal and related CSS/JS.

---

## v2.1.0

### New Features
- **File browser for model selection** — Models are now selected via a file explorer dialog instead of typing paths manually. User picks the `.pbip` project file (or `definition.pbism`) and the application automatically resolves the path to the TMDL `definition/` folder.
- **Refresh button** — After deployment, users can refresh the comparison to verify results without re-entering paths.

### Bug Fixes
- **Fixed deployment path resolution** — When user entered a `SemanticModel` folder path (without `/definition`), the deployer would fail to locate target files. The server now always resolves to the actual `definition/` subfolder.
- **Deploy endpoint uses server-stored path** — Deploy and preview endpoints no longer require `prodPath` from the client; they use the resolved path stored during comparison.

---

## v2.0.0

### Initial Release
- TMDL parser with rawBlock preservation for deployment operations.
- Model loader supporting `definition/` folder auto-detection.
- Comparison engine (Added / Removed / Modified) with 13 change groups.
- Deployment engine with selective changes (add/remove/modify objects).
- TMDL writer for block-level file manipulation.
- Backup creation before deployment.
- Dark-themed SPA with VS Code-inspired UI.
- REST API: `/api/compare`, `/api/deploy`, `/api/deploy/preview`.
