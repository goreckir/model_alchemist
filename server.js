const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { loadModelFromFolder } = require('./parser/model-loader');
const { compareModels } = require('./comparison/engine');
const { deployChanges } = require('./deployment/deployer');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// State: store last comparison result for deployment reference
let lastComparison = null;
let lastDevModel = null;
let lastProdPath = null;

/**
 * Resolve the actual definition/ folder path.
 * Users may enter the SemanticModel folder — we need the definition subfolder.
 */
function resolveDefinitionPath(folderPath) {
    const resolved = path.resolve(folderPath);
    const defSub = path.join(resolved, 'definition');
    if (fs.existsSync(defSub) && fs.existsSync(path.join(defSub, 'model.tmdl'))) {
        return defSub;
    }
    return resolved;
}

// API: Compare two TMDL models
app.post('/api/compare', (req, res) => {
    const { devPath, prodPath } = req.body;

    if (!devPath || !prodPath) {
        return res.status(400).json({ error: 'Both devPath and prodPath are required.' });
    }

    try {
        const devModel = loadModelFromFolder(devPath);
        const prodModel = loadModelFromFolder(prodPath);
        const result = compareModels(devModel, prodModel, devPath, prodPath);
        
        // Store for deployment — use resolved definition path
        lastComparison = result;
        lastDevModel = devModel;
        lastProdPath = resolveDefinitionPath(prodPath);
        
        res.json(result);
    } catch (err) {
        console.error('Comparison error:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Deploy selected changes to PROD
app.post('/api/deploy', (req, res) => {
    const { selectedKeys, dryRun = false, backup = true } = req.body;

    if (!selectedKeys || !selectedKeys.length) {
        return res.status(400).json({ error: 'No changes selected for deployment.' });
    }
    if (!lastComparison || !lastDevModel || !lastProdPath) {
        return res.status(400).json({ error: 'No comparison result available. Run a comparison first.' });
    }

    try {
        // Find the diffs matching the selected keys
        const selectedDiffs = lastComparison.diffs.filter(d => selectedKeys.includes(d.identityKey));
        
        if (selectedDiffs.length === 0) {
            return res.status(400).json({ error: 'None of the selected keys match current comparison results.' });
        }

        const result = deployChanges(selectedDiffs, lastDevModel, lastProdPath, { dryRun, backup });
        res.json(result);
    } catch (err) {
        console.error('Deployment error:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Dry-run deployment (preview)
app.post('/api/deploy/preview', (req, res) => {
    const { selectedKeys } = req.body;

    if (!selectedKeys || !selectedKeys.length) {
        return res.status(400).json({ error: 'No changes selected.' });
    }
    if (!lastComparison || !lastDevModel || !lastProdPath) {
        return res.status(400).json({ error: 'No comparison result available.' });
    }

    try {
        const selectedDiffs = lastComparison.diffs.filter(d => selectedKeys.includes(d.identityKey));
        const result = deployChanges(selectedDiffs, lastDevModel, lastProdPath, { dryRun: true, backup: false });
        res.json(result);
    } catch (err) {
        console.error('Preview error:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Open native file dialog (via Python/tkinter)
app.get('/api/pick-file', (req, res) => {
    const target = req.query.target || 'model';
    const initialdir = req.query.initialdir || '';
    const scriptPath = path.join(__dirname, 'pick-file.py');
    const pythonCmd = process.env.PYTHON_PATH || 'python';
    const args = [scriptPath, target];
    if (initialdir) args.push(initialdir);
    execFile(pythonCmd, args, { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) {
            if (err.code === 1 || err.killed) {
                return res.json({ cancelled: true, filePath: null });
            }
            return res.status(500).json({ error: stderr || err.message });
        }
        const filePath = stdout.trim().replace(/\//g, '\\');
        if (!filePath) {
            return res.json({ cancelled: true, filePath: null });
        }
        res.json({ cancelled: false, filePath });
    });
});

// API: Resolve a selected file to definition path
app.post('/api/resolve-model', (req, res) => {
    const { filePath } = req.body;

    if (!filePath) {
        return res.status(400).json({ error: 'filePath is required.' });
    }

    try {
        const resolved = resolveModelFromFile(filePath);
        res.json({ definitionPath: resolved, displayName: path.basename(path.dirname(resolved)) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * Resolve a .pbip or .pbism file to the definition/ folder path.
 */
function resolveModelFromFile(filePath) {
    const resolved = path.resolve(filePath);
    const ext = path.extname(resolved).toLowerCase();
    const dir = path.dirname(resolved);

    if (ext === '.pbip') {
        // .pbip file: look for <Name>.SemanticModel/definition/ in the same directory
        const baseName = path.basename(resolved, '.pbip');
        const smFolder = path.join(dir, `${baseName}.SemanticModel`);
        if (fs.existsSync(smFolder)) {
            const defFolder = path.join(smFolder, 'definition');
            if (fs.existsSync(defFolder)) return defFolder;
            return smFolder;
        }
        // Try any .SemanticModel folder in the same directory
        const entries = fs.readdirSync(dir);
        const smDir = entries.find(e => e.endsWith('.SemanticModel') && fs.statSync(path.join(dir, e)).isDirectory());
        if (smDir) {
            const defFolder = path.join(dir, smDir, 'definition');
            if (fs.existsSync(defFolder)) return defFolder;
            return path.join(dir, smDir);
        }
        throw new Error(`No .SemanticModel folder found next to ${path.basename(resolved)}`);
    }

    if (ext === '.pbism') {
        // definition.pbism: the definition/ folder is in the same directory
        const defFolder = path.join(dir, 'definition');
        if (fs.existsSync(defFolder)) return defFolder;
        return dir;
    }

    throw new Error(`Unsupported file type: ${ext}. Select a .pbip or .pbism file.`);
}

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Model Alchemist v2.2 running at http://localhost:${PORT}`);
});
