const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { loadModelFromFolder } = require('./parser/model-loader');
const { compareModels } = require('./comparison/engine');
const { deployChanges } = require('./deployment/deployer');
const fabricAuth = require('./fabric/auth');
const fabricApi = require('./fabric/api-client');
const { loadModelFromFabric } = require('./fabric/model-loader');
const { parseConnectionString } = require('./fabric/connection-parser');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
    }
}));

// State: store last comparison result for deployment reference
let lastComparison = null;
let lastDevModel = null;
let lastProdPath = null;
let lastProdModel = null;
let lastProdFabricInfo = null; // { workspaceId, semanticModelId }

// Fabric auth state
let fabricAccessToken = null;

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
app.post('/api/deploy', async (req, res) => {
    const { selectedKeys, dryRun = false, backup = true, backupPath } = req.body;

    if (!selectedKeys || !selectedKeys.length) {
        return res.status(400).json({ error: 'No changes selected for deployment.' });
    }
    if (!lastComparison || !lastDevModel) {
        return res.status(400).json({ error: 'No comparison result available. Run a comparison first.' });
    }
    if (!lastProdPath && !lastProdFabricInfo) {
        return res.status(400).json({ error: 'No valid PROD target. Run a comparison first.' });
    }

    try {
        // Find the diffs matching the selected keys
        const selectedDiffs = lastComparison.diffs.filter(d => selectedKeys.includes(d.identityKey));
        
        if (selectedDiffs.length === 0) {
            return res.status(400).json({ error: 'None of the selected keys match current comparison results.' });
        }

        if (lastProdPath) {
            // Local deployment — use filesystem deployer
            const result = deployChanges(selectedDiffs, lastDevModel, lastProdPath, { dryRun, backup });
            res.json(result);
        } else {
            // Fabric deployment — apply changes via temp dir, then upload
            const result = await deployToFabric(selectedDiffs, lastDevModel, lastProdModel, lastProdFabricInfo, { dryRun, backup, backupPath });
            res.json(result);
        }
    } catch (err) {
        console.error('Deployment error:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Dry-run deployment (preview)
app.post('/api/deploy/preview', async (req, res) => {
    const { selectedKeys } = req.body;

    if (!selectedKeys || !selectedKeys.length) {
        return res.status(400).json({ error: 'No changes selected.' });
    }
    if (!lastComparison || !lastDevModel) {
        return res.status(400).json({ error: 'No comparison result available.' });
    }

    try {
        const selectedDiffs = lastComparison.diffs.filter(d => selectedKeys.includes(d.identityKey));
        if (lastProdPath) {
            const result = deployChanges(selectedDiffs, lastDevModel, lastProdPath, { dryRun: true, backup: false });
            res.json(result);
        } else {
            const result = await deployToFabric(selectedDiffs, lastDevModel, lastProdModel, lastProdFabricInfo, { dryRun: true });
            res.json(result);
        }
    } catch (err) {
        console.error('Preview error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Deploy changes to a Fabric semantic model.
 * Strategy: write PROD rawFiles to temp dir, run deployer, read back, upload to Fabric.
 */
async function deployToFabric(selectedDiffs, devModel, prodModel, fabricInfo, options = {}) {
    const { dryRun = false, backup = false, backupPath } = options;
    const os = require('os');
    const tmpDir = path.join(os.tmpdir(), `model-alchemist-deploy-${Date.now()}`);
    const result = { success: true, actions: [], errors: [], backupPath: null };

    try {
        // Create backup if requested and backupPath is provided
        if (backup && backupPath && !dryRun) {
            const modelName = prodModel.name || 'SemanticModel';
            const semanticModelFolder = `${modelName}.SemanticModel`;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const backupDestination = path.join(backupPath, `${semanticModelFolder}_backup_${timestamp}`);

            // Write PROD rawFiles as backup
            fs.mkdirSync(backupDestination, { recursive: true });
            const defDir = path.join(backupDestination, 'definition');
            fs.mkdirSync(defDir, { recursive: true });
            for (const [filePath, content] of Object.entries(prodModel.rawFiles)) {
                const fullPath = path.join(defDir, filePath);
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, content, 'utf-8');
            }
            result.backupPath = backupDestination;
            result.actions.push({ type: 'backup', message: `Backup created: ${backupDestination}` });
        }

        // Write PROD rawFiles to temp directory
        fs.mkdirSync(tmpDir, { recursive: true });
        for (const [filePath, content] of Object.entries(prodModel.rawFiles)) {
            const fullPath = path.join(tmpDir, filePath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content, 'utf-8');
        }

        // Run deployer against temp dir (no backup for Fabric)
        const deployResult = deployChanges(selectedDiffs, devModel, tmpDir, { dryRun, backup: false });

        if (!deployResult.success) {
            return deployResult;
        }

        if (dryRun) {
            // For dry-run, just return the planned actions
            return deployResult;
        }

        // Read back modified files from temp dir
        const updatedFiles = {};
        readDirRecursive(tmpDir, tmpDir, updatedFiles);

        // Upload to Fabric
        const token = await fabricAuth.getAccessToken() || require('./fabric/auth').getAccessToken();
        await fabricApi.updateSemanticModelDefinition(
            token,
            fabricInfo.workspaceId,
            fabricInfo.semanticModelId,
            updatedFiles
        );

        result.actions = deployResult.actions;
        result.actions.push({ type: 'fabric-upload', message: 'Definition uploaded to Fabric successfully.' });
    } catch (err) {
        result.success = false;
        result.errors.push({ operation: { action: 'fabric-upload' }, error: err.message });
    } finally {
        // Cleanup temp dir
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    return result;
}

/**
 * Recursively read all files in a directory into a { relativePath: content } dict.
 */
function readDirRecursive(baseDir, currentDir, result) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            readDirRecursive(baseDir, fullPath, result);
        } else {
            const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
            result[relPath] = fs.readFileSync(fullPath, 'utf-8');
        }
    }
}

// API: Open native file dialog (via Python/tkinter)
app.get('/api/pick-file', (req, res) => {
    const target = req.query.target || 'model';
    const initialdir = req.query.initialdir || '';
    const title = `Select ${target.toUpperCase()} model file (.pbip)`;

    // Use PowerShell with WinForms file dialog + forced foreground activation
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.WindowState = 'Minimized'
$form.ShowInTaskbar = $false
$form.Show()
[Win32]::SetForegroundWindow($form.Handle) | Out-Null
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = '${title.replace(/'/g, "''")}'
$dlg.Filter = 'Power BI Project (*.pbip)|*.pbip|All files (*.*)|*.*'
${initialdir ? `$dlg.InitialDirectory = '${initialdir.replace(/'/g, "''")}'` : ''}
$dlg.RestoreDirectory = $true
$result = $dlg.ShowDialog($form)
$form.Close()
if ($result -eq 'OK') { $dlg.FileName } else { '' }
`.trim();

    execFile('powershell', ['-NoProfile', '-STA', '-Command', psScript], { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) {
            if (err.killed) {
                return res.json({ cancelled: true, filePath: null });
            }
            return res.status(500).json({ error: stderr || err.message });
        }
        const filePath = stdout.trim();
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

// ===== Fabric API Endpoints =====

// API: Start interactive login (opens system browser to Microsoft login page)
// No credentials pass through this application — authentication happens in the browser.
app.post('/api/fabric/login', async (req, res) => {
    if (fabricAuth.isAuthenticated()) {
        const account = fabricAuth.getAccountInfo();
        return res.json({ status: 'connected', account });
    }

    if (fabricAuth.isLoginPending()) {
        return res.json({ status: 'pending', message: 'Login already in progress. Complete it in the browser window.' });
    }

    try {
        // This opens a system browser window for Microsoft login
        // and waits for the user to complete authentication
        const token = await fabricAuth.loginInteractive();
        fabricAccessToken = token;
        const account = fabricAuth.getAccountInfo();
        res.json({ status: 'connected', account });
    } catch (err) {
        console.error('Fabric login error:', err);
        const msg = err.message || 'Login failed';
        res.status(401).json({ error: msg });
    }
});

// API: Check Fabric connection status
app.get('/api/fabric/status', async (req, res) => {
    if (fabricAuth.isLoginPending()) {
        return res.json({ status: 'pending' });
    }
    if (fabricAuth.isAuthenticated()) {
        // Try to refresh token
        const token = await fabricAuth.getAccessToken();
        if (token) {
            fabricAccessToken = token;
            const account = fabricAuth.getAccountInfo();
            return res.json({ status: 'connected', account });
        }
    }
    res.json({ status: 'disconnected' });
});

// API: Cancel in-progress login
app.post('/api/fabric/cancel-login', (req, res) => {
    fabricAuth.cancelLogin();
    res.json({ status: 'cancelled' });
});

// API: Disconnect from Fabric
app.post('/api/fabric/disconnect', (req, res) => {
    fabricAccessToken = null;
    fabricAuth.logout();
    res.json({ status: 'disconnected' });
});

// API: Resolve connection string — parse workspace/model names and verify access
app.post('/api/fabric/resolve', async (req, res) => {
    const { connectionString } = req.body;

    if (!fabricAccessToken) {
        return res.status(401).json({ error: 'Not authenticated. Login to Fabric first.' });
    }
    if (!connectionString) {
        return res.status(400).json({ error: 'Connection string is required.' });
    }

    try {
        const parsed = parseConnectionString(connectionString);

        // Refresh token if needed
        const token = await fabricAuth.getAccessToken() || fabricAccessToken;

        // Find workspace by name
        const workspaces = await fabricApi.listWorkspaces(token);
        const workspace = workspaces.find(ws =>
            ws.name.toLowerCase() === parsed.workspaceName.toLowerCase()
        );

        if (!workspace) {
            return res.status(403).json({
                error: `Workspace "${parsed.workspaceName}" not found or access denied.`
            });
        }

        // Find model by name
        const models = await fabricApi.listSemanticModels(token, workspace.id);
        const model = models.find(m =>
            m.name.toLowerCase() === parsed.modelName.toLowerCase()
        );

        if (!model) {
            return res.status(403).json({
                error: `Model "${parsed.modelName}" not found in workspace "${workspace.name}" or access denied.`
            });
        }

        res.json({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            semanticModelId: model.id,
            modelName: model.name
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Compare with Fabric model (local vs Fabric, Fabric vs local, Fabric vs Fabric)
// Each source independently specifies its type and connection string.
app.post('/api/compare-fabric', async (req, res) => {
    const { devSource, prodSource } = req.body;
    // devSource/prodSource: { type: 'local', path } or { type: 'fabric', connectionString }

    if (!devSource || !prodSource) {
        return res.status(400).json({ error: 'Both devSource and prodSource are required.' });
    }

    if (!fabricAccessToken) {
        return res.status(401).json({ error: 'Not authenticated to Fabric.' });
    }

    try {
        const token = await fabricAuth.getAccessToken() || fabricAccessToken;
        let devModel, prodModel;
        let devLabel, prodLabel;

        // Load DEV model
        if (devSource.type === 'local') {
            devModel = loadModelFromFolder(devSource.path);
            devLabel = devSource.path;
        } else if (devSource.type === 'fabric') {
            const parsed = parseConnectionString(devSource.connectionString);
            const wsId = devSource.workspaceId;
            const modelId = devSource.semanticModelId;
            devModel = await loadModelFromFabric(token, wsId, modelId, parsed.modelName);
            devLabel = `Fabric: ${parsed.workspaceName}/${parsed.modelName}`;
        } else {
            return res.status(400).json({ error: 'Invalid devSource type.' });
        }

        // Load PROD model
        if (prodSource.type === 'local') {
            prodModel = loadModelFromFolder(prodSource.path);
            prodLabel = prodSource.path;
        } else if (prodSource.type === 'fabric') {
            const parsed = parseConnectionString(prodSource.connectionString);
            const wsId = prodSource.workspaceId;
            const modelId = prodSource.semanticModelId;
            prodModel = await loadModelFromFabric(token, wsId, modelId, parsed.modelName);
            prodLabel = `Fabric: ${parsed.workspaceName}/${parsed.modelName}`;
        } else {
            return res.status(400).json({ error: 'Invalid prodSource type.' });
        }

        // Run comparison
        const result = compareModels(devModel, prodModel, devLabel, prodLabel);

        // Store for potential deployment
        lastComparison = result;
        lastDevModel = devModel;
        lastProdModel = prodModel;
        if (prodSource.type === 'local') {
            lastProdPath = resolveDefinitionPath(prodSource.path);
            lastProdFabricInfo = null;
        } else {
            lastProdPath = null;
            lastProdFabricInfo = {
                workspaceId: prodSource.workspaceId,
                semanticModelId: prodSource.semanticModelId
            };
        }

        res.json(result);
    } catch (err) {
        console.error('Comparison error:', err);
        res.status(500).json({ error: err.message });
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
    console.log(`Model Alchemist v3.0 running at http://localhost:${PORT}`);
});
