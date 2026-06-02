# Model Alchemist — Release Notes

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
