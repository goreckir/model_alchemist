# Model Alchemist v2.2

A tool for comparing and deploying changes in Power BI semantic models (TMDL/PBIP format).

## What does it do?

- **Compares** two semantic models (DEV vs PROD) at object level (tables, measures, columns, relationships, roles, perspectives, expressions, cultures).
- **Displays differences** in a clean web UI with color-coded indicators (Added / Removed / Modified).
- **Deploys selected changes** from DEV to PROD — selectively, with preview and optional backup.

## Requirements

- **Windows 10/11** (native file picker uses Windows dialogs)
- **Node.js** v18+ (tested on v24)
- **Python 3.10+** with `tkinter` (for native file picker dialog)
  - On Windows, tkinter is bundled with the default Python installation
- **Power BI models in PBIP/TMDL format** (Developer Mode enabled in Power BI Desktop)

### Quick install (Windows — winget)

```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.12
```

> After installing, restart your terminal so `node` and `python` are available in PATH.

### Verify installation

```powershell
node --version   # should be v18+
python --version # should be 3.10+
python -c "import tkinter; print('tkinter OK')"
```

## Installation

```bash
cd model_alchemist
npm install
```

## Running

### Option 1: Standard (Python in PATH)

```bash
npm start
```

### Option 2: Python at a custom path

```powershell
$env:PYTHON_PATH = "C:\path\to\python.exe"
npm start
```

### Option 3: Development mode (auto-restart on changes)

```bash
npm run dev
```

The app will start at **http://localhost:3001**.

## Usage

1. **Select DEV model** — click "Browse" and pick the `.pbip` file of the source (development) model.
2. **Select PROD model** — click "Browse" and pick the `.pbip` file of the target (production) model.
3. **Click "Compare Models"** — the app compares both models and displays a list of differences.
4. **Review differences** — click an object to expand details. Use "Expand All" to open all at once.
5. **Select changes to deploy** — use checkboxes next to each diff. "Select All Visible" checks all.
6. **Click "Deploy"** — preview planned operations, confirm, and deploy to PROD.

## Project Structure

```
model_alchemist/
├── server.js              # Express server (API + static files)
├── pick-file.py           # Python script (native file picker dialog)
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
└── deployment/            # Deployment engine
    ├── deployer.js
    └── tmdl-writer.js
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3001` |
| `PYTHON_PATH` | Path to Python interpreter | `python` |

## Notes

- The app operates directly on TMDL files on disk — a backup before deployment is recommended (enabled by default).
- Selected model paths are persisted in the browser (localStorage).
- The ⇅ button swaps DEV and PROD.
