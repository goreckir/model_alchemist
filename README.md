# Model Alchemist v4.6

A tool for comparing and deploying changes in Power BI semantic models (TMDL/PBIP format) — locally or via Microsoft Fabric REST API.

## What does it do?

- **Compares** two semantic models (Source vs Target) at object level (tables, measures, columns, relationships, roles, perspectives, expressions, cultures).
- **Supports local and Fabric models** — each side can independently use a local `.pbip` file or a Fabric connection string. Mix-and-match freely.
- **Displays differences** in a clean web UI with color-coded indicators (Added / Removed / Modified).
- **Exports comparison report** — export differences to CSV, Markdown, or HTML with side-by-side code diffs.
- **Deploys selected changes** from Source to Target — selectively, with preview and optional backup.
- **Deploys to Fabric** — uploads modified TMDL definitions back to Fabric semantic models via REST API.
- **Triggers Enhanced Refresh** — after deployment, triggers data refresh on affected tables with real-time status tracking.

## Requirements

- **Windows 10/11** (native file picker uses Windows Forms dialogs)
- **Node.js** v18+ (tested on v24)
- **Power BI models in PBIP/TMDL format** (Developer Mode enabled in Power BI Desktop)

### Quick install (Windows — winget)

```powershell
winget install OpenJS.NodeJS.LTS
```

> After installing, restart your terminal so `node` is available in PATH.

### Verify installation

```powershell
node --version   # should be v18+
```

## Installation

```bash
cd model_alchemist
npm install
```

## Running

**Option 1 — VS Code (F5)**

Open this workspace in VS Code, then press `F5` (or go to **Run → Start Debugging**) and pick **"Start Model Alchemist"**. The server starts in the integrated terminal. Use **"Start Model Alchemist (watch)"** for auto-restart on file changes.

**Option 2 — Windows Explorer**

Double-click `start.bat` in the `model_alchemist/` folder. A console window opens and keeps the server running.

**Option 3 — terminal**

```bash
npm start
```

Or with auto-restart on changes:

```bash
npm run dev
```

The app will start at **http://localhost:3001** (default). If port 3001 is already in use, the server automatically tries the next available port (3002, 3003, …). The actual URL is printed in the terminal output on startup.

## Usage

1. **Select Source model** — click "Browse" and pick the `.SemanticModel` folder (or any parent containing it), or switch to Fabric tab and paste a connection string.
2. **Select Target model** — same options: local folder or Fabric connection string.
3. **Click "Compare Models"** — the app compares both models and displays a list of differences.
4. **Review differences** — click an object to expand details. Use "Expand All" to open all at once.
5. **Select changes to deploy** — use checkboxes next to each diff. "Select All Visible" checks all.
6. **Click "Deploy"** — preview planned operations, confirm, and deploy to Target.

### Fabric Connection

1. Click the **Fabric** button in the header to sign in with your Microsoft account (browser popup).
2. Switch a model panel to the **Fabric** tab.
3. Paste the connection string: `Data Source=powerbi://api.powerbi.com/v1.0/myorg/WorkspaceName;Initial Catalog=ModelName;`
4. Click **Verify Access** to confirm connectivity.

## Project Structure

```
model_alchemist/
├── server.js              # Express server (API + static files)
├── package.json
├── public/                # Frontend (SPA)
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── parser/                # TMDL parser
│   ├── tmdl-parser.js
│   └── model-loader.js
├── comparison/            # Comparison engine
│   ├── engine.js
│   └── extractor.js
├── deployment/            # Deployment engine
│   ├── deployer.js
│   ├── tmdl-writer.js
│   └── validator.js       # Pre-deploy validation (deps, compat, refs)
├── lib/                   # Shared utilities
│   ├── activity-log.js    # Activity log writer (JSONL)
│   └── refresh-store.js   # Refresh session persistence
└── fabric/                # Microsoft Fabric integration
    ├── auth.js            # MSAL OAuth (browser popup, PKCE)
    ├── api-client.js      # Fabric REST API client
    ├── model-loader.js    # Converts Fabric TMDL to internal format
    └── connection-parser.js  # Parses Power BI connection strings
```

## License

MIT © [Radosław Górecki](https://github.com/goreckir)

## Notes

- The app operates directly on TMDL files on disk — a backup before deployment is recommended (enabled by default).
- Selected model paths are persisted in the browser (localStorage).
- The ⇅ button swaps Source and Target.
- Fabric authentication uses OAuth2 Authorization Code + PKCE (no credentials stored on disk).
- Default OAuth client ID: Power BI Desktop public client (`ea0616ba-638b-4df5-95b9-636659ae5121`).
