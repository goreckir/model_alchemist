# Model Alchemist — Release Notes

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
