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
const { logEvent, readEvents } = require('./lib/activity-log');
const refreshStore = require('./lib/refresh-store');

const pkg = require('./package.json');
const APP_VERSION = pkg.version;
const BACKUP_DIR = path.join(__dirname, 'backups');

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

// API: App version and defaults (single source of truth from package.json)
app.get('/api/version', (req, res) => {
    res.json({ version: APP_VERSION });
});
app.get('/api/defaults', (req, res) => {
    res.json({ version: APP_VERSION, backupPath: BACKUP_DIR });
});

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
        
        logEvent('compare', {
            mode: 'local-local',
            devSource: devPath,
            prodSource: prodPath,
            diffCount: result.diffs ? result.diffs.length : 0,
            groupCount: result.groups ? result.groups.length : 0,
            success: true
        });
        res.json(result);
    } catch (err) {
        console.error('Comparison error:', err);
        logEvent('compare', { mode: 'local-local', devSource: devPath, prodSource: prodPath, success: false, error: err.message });
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
            const result = deployChanges(selectedDiffs, lastDevModel, lastProdPath, { dryRun, backup, backupPath, prodModel: lastProdModel, allDiffs: lastComparison.diffs });
            logEvent('deploy', {
                mode: 'local',
                dryRun,
                target: lastProdPath,
                selectedCount: selectedDiffs.length,
                selectedDiffs: selectedDiffs.map(d => ({ type: d.type, objectType: d.objectType, name: d.displayName, identityKey: d.identityKey })),
                success: result.success,
                actionsExecuted: (result.actions || []).filter(a => a.type === 'applied').length,
                errorCount: (result.errors || []).length,
                warnings: result.warnings || [],
                errors: result.errors || [],
                backupPath: result.backupPath || null,
                tablesNeedingRefresh: result.tablesNeedingRefresh || null
            });
            res.json(result);
        } else {
            // Fabric deployment — apply changes via temp dir, then upload
            const result = await deployToFabric(selectedDiffs, lastDevModel, lastProdModel, lastProdFabricInfo, { dryRun, backup, backupPath, allDiffs: lastComparison.diffs });
            logEvent('deploy', {
                mode: 'fabric',
                dryRun,
                target: lastProdFabricInfo ? `workspace:${lastProdFabricInfo.workspaceId}/model:${lastProdFabricInfo.semanticModelId}` : null,
                selectedCount: selectedDiffs.length,
                selectedDiffs: selectedDiffs.map(d => ({ type: d.type, objectType: d.objectType, name: d.displayName, identityKey: d.identityKey })),
                success: result.success,
                actionsExecuted: (result.actions || []).filter(a => a.type === 'applied').length,
                errorCount: (result.errors || []).length,
                warnings: result.warnings || [],
                errors: result.errors || [],
                backupPath: result.backupPath || null,
                tablesNeedingRefresh: result.tablesNeedingRefresh || null
            });
            res.json(result);
        }
    } catch (err) {
        console.error('Deployment error:', err);
        logEvent('deploy', { success: false, error: err.message });
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
            const result = deployChanges(selectedDiffs, lastDevModel, lastProdPath, { dryRun: true, backup: false, prodModel: lastProdModel, allDiffs: lastComparison.diffs });
            res.json(result);
        } else {
            const result = await deployToFabric(selectedDiffs, lastDevModel, lastProdModel, lastProdFabricInfo, { dryRun: true, allDiffs: lastComparison.diffs });
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
        const deployResult = deployChanges(selectedDiffs, devModel, tmpDir, { dryRun, backup: false, prodModel, allDiffs: options.allDiffs || [] });

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

        // Determine which tables need refresh after metadata deploy
        const tablesNeedingRefresh = detectTablesNeedingRefresh(selectedDiffs, lastComparison);
        if (tablesNeedingRefresh !== null) {
            result.tablesNeedingRefresh = tablesNeedingRefresh;
        }
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
 * Detect which tables need refresh after deploying metadata changes.
 * Returns an object with per-table refresh classification:
 * {
 *   refreshType: 'automatic'|'dataOnly'|'calculate',
 *   tables: [{ table, refreshType, reason }],
 *   isFullModel: boolean
 * }
 * Returns null if no refresh is needed.
 *
 * Rules:
 * - Parameters (IsParameterQuery) → no refresh needed
 * - Named expression (shared M query) → dataOnly for dependent tables (or all)
 * - Partition expression changed → dataOnly for that table
 * - New table added → full for that table
 * - New column with sourceColumn → dataOnly for that table
 * - Calculated column expression changed → calculate for that table
 * - Calculated table (mode: calculated) → calculate for that table
 * - Calculation item add/remove/ordinal → calculate for the CG table
 * - Parameter change → dataOnly for all dependent tables (resolved from comparison groups)
 */
function detectTablesNeedingRefresh(selectedDiffs, comparison) {
    const tableMap = new Map(); // tableName → { refreshType, reasons[] }

    // Collect tables being removed — they can't be refreshed
    const tablesBeingRemoved = new Set();
    for (const d of selectedDiffs) {
        if (d.objectType === 'table' && d.type === 1) {
            tablesBeingRemoved.add(d.displayName);
        }
    }

    function addTable(table, type, reason) {
        if (!table) return;
        if (tablesBeingRemoved.has(table)) return; // can't refresh a deleted table
        const existing = tableMap.get(table);
        if (!existing) {
            tableMap.set(table, { refreshType: type, reasons: [reason] });
        } else {
            existing.reasons.push(reason);
            // Escalate: dataOnly > calculate > full
            if (type === 'full' || existing.refreshType === 'full') {
                existing.refreshType = 'full';
            } else if (type === 'dataOnly' || existing.refreshType === 'dataOnly') {
                existing.refreshType = 'dataOnly';
            }
            // else both calculate — stays calculate
        }
    }

    let needsFullModel = false;

    // Build lookup of parameter groups from comparison (pre-computed dependency resolution)
    const paramGroupsByKey = new Map();
    if (comparison && comparison.groups) {
        for (const g of comparison.groups) {
            if (g.isParameterGroup && g.affectedTables) {
                for (const key of (g.memberKeys || [])) {
                    paramGroupsByKey.set(key, g.affectedTables);
                }
            }
        }
    }

    for (const diff of selectedDiffs) {
        const objType = diff.objectType;
        const diffType = diff.type; // 0=added, 1=removed, 2=modified

        // Named expression / parameter
        if (objType === 'expression') {
            // Check if this is a parameter or a shared query
            const exprValue = getExpressionValue(diff);
            if (isParameterExpression(exprValue)) {
                // Parameter changed → refresh dependent tables.
                // dataOnly is sufficient when gateway/credentials are properly
                // configured for the new parameter value.
                const affectedTables = paramGroupsByKey.get(diff.identityKey);
                if (affectedTables && affectedTables.length > 0) {
                    for (const tbl of affectedTables) {
                        addTable(tbl, 'dataOnly', `parameter '${diff.displayName}' changed`);
                    }
                }
                continue;
            }
            // Shared M query changed → all tables using it need data refresh
            // We can't easily resolve dependencies, so mark as full-model dataOnly
            needsFullModel = true;
            continue;
        }

        // Partition expression changed → check if calculated table or data table
        if (objType === 'partition') {
            if (diffType === 1) continue; // partition removed → no refresh needed
            const mode = getPartitionMode(diff);
            if (mode === 'calculated') {
                addTable(diff.parentTable, 'calculate', 'calculated table expression changed');
            } else {
                addTable(diff.parentTable, 'dataOnly', 'partition expression changed');
            }
        }

        // New table added → needs full refresh
        else if (objType === 'table' && diffType === 0) {
            addTable(diff.displayName, 'full', 'new table added');
        }

        // New column added (has sourceColumn) → table needs data refresh
        else if (objType === 'column' && diffType === 0) {
            const hasSourceCol = (diff.propertyDiffs || []).some(p => p.propertyName === 'sourceColumn' && p.devValue);
            const hasExpression = (diff.propertyDiffs || []).some(p => p.propertyName === 'expression' && p.devValue);
            if (hasExpression) {
                addTable(diff.parentTable, 'calculate', 'new calculated column');
            } else if (hasSourceCol) {
                addTable(diff.parentTable, 'dataOnly', 'new column with sourceColumn');
            }
        }

        // Column expression change (calculated column)
        else if (objType === 'column' && diffType === 2) {
            const hasExpr = (diff.propertyDiffs || []).some(p => p.propertyName === 'expression');
            if (hasExpr) {
                addTable(diff.parentTable, 'calculate', 'calculated column expression changed');
            }
        }

        // Calculation item added/removed → recalculate the CG table
        else if (objType === 'calculationItem' && (diffType === 0 || diffType === 1)) {
            addTable(diff.parentTable, 'calculate', `calculationItem ${diffType === 0 ? 'added' : 'removed'}`);
        }

        // Calculation item modified → only if ordinal changed
        else if (objType === 'calculationItem' && diffType === 2) {
            const hasOrdinalChange = (diff.propertyDiffs || []).some(p => p.propertyName === 'ordinal');
            if (hasOrdinalChange) {
                addTable(diff.parentTable, 'calculate', 'calculationItem ordinal changed');
            }
        }

        // Calculation group precedence changed
        else if (objType === 'calculationGroup' && diffType === 2) {
            const hasPrecedenceChange = (diff.propertyDiffs || []).some(p => p.propertyName === 'precedence');
            if (hasPrecedenceChange) {
                addTable(diff.parentTable, 'calculate', 'calculationGroup precedence changed');
            }
        }
    }

    if (tableMap.size === 0 && !needsFullModel) {
        return null; // no refresh needed
    }

    // Build tables array
    const tables = [];
    for (const [name, info] of tableMap) {
        tables.push({ table: name, refreshType: info.refreshType, reasons: info.reasons });
    }

    // Determine overall API refresh type
    let overallType = 'calculate';
    if (needsFullModel) {
        overallType = 'automatic';
    } else {
        const types = new Set(tables.map(t => t.refreshType));
        if (types.has('full')) overallType = 'automatic';
        else if (types.has('dataOnly') && types.has('calculate')) overallType = 'automatic';
        else if (types.has('dataOnly')) overallType = 'dataOnly';
        // else all calculate → 'calculate'
    }

    return {
        refreshType: overallType,
        tables,
        isFullModel: needsFullModel
    };
}

/** Extract expression value from a diff object */
function getExpressionValue(diff) {
    const exprProp = (diff.propertyDiffs || []).find(p => p.propertyName === 'expression');
    if (exprProp) return exprProp.devValue || exprProp.prodValue || '';
    // Fallback: check rawBlock
    return diff.rawBlock || '';
}

/** Check if an expression value is a Power Query parameter */
function isParameterExpression(exprValue) {
    return /IsParameterQuery\s*=\s*true/i.test(exprValue);
}

/** Get partition mode from diff's propertyDiffs */
function getPartitionMode(diff) {
    const modeProp = (diff.propertyDiffs || []).find(p => p.propertyName === 'mode');
    if (modeProp) return (modeProp.devValue || modeProp.prodValue || 'import').toLowerCase();
    return 'import';
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

// API: Open native folder dialog (via PowerShell WinForms)
app.get('/api/pick-file', (req, res) => {
    const target = req.query.target || 'model';
    const initialdir = req.query.initialdir || '';
    const title = `Select ${target.toUpperCase()} model folder (.SemanticModel)`;

    // Use PowerShell with WinForms folder browser dialog + forced foreground activation
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
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '${title.replace(/'/g, "''")}'
$dlg.ShowNewFolderButton = $false
${initialdir ? `$dlg.SelectedPath = '${initialdir.replace(/'/g, "''")}'` : ''}
$result = $dlg.ShowDialog($form)
$form.Close()
if ($result -eq 'OK') { $dlg.SelectedPath } else { '' }
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

// API: Trigger refresh of affected tables after Fabric deployment
app.post('/api/fabric/refresh', async (req, res) => {
    const { tables, refreshType, tableDetails } = req.body;
    // tables: string[] of table names (empty = full model)
    // refreshType: 'automatic'|'dataOnly'|'calculate' (recommended type)
    // tableDetails: [{ table, refreshType, reasons }] (for display/logging)

    if (!lastProdFabricInfo) {
        return res.status(400).json({ error: 'No Fabric target available. Deploy to Fabric first.' });
    }

    try {
        const token = await fabricAuth.getAccessToken();
        if (!token) {
            return res.status(401).json({ error: 'Not authenticated. Login to Fabric first.' });
        }

        const { workspaceId, semanticModelId, modelName } = lastProdFabricInfo;
        const apiRefreshType = refreshType || 'automatic';
        const result = await fabricApi.refreshSemanticModel(token, workspaceId, semanticModelId, tables || [], apiRefreshType);

        // Determine if a post-refresh calculate is needed:
        // dataOnly does NOT recalculate relationships — a follow-up calculate is required
        const needsPostCalculate = apiRefreshType === 'dataOnly' || 
            (apiRefreshType === 'automatic' && (tables || []).length > 0);

        // Store in refresh session with detailed table info
        if (result.requestId) {
            refreshStore.createRefreshRecord(result.requestId, modelName, workspaceId, semanticModelId, tables || [], tableDetails || [], apiRefreshType, { needsPostCalculate });
        }

        logEvent('refresh', {
            target: `workspace:${workspaceId}/model:${semanticModelId}`,
            tables: tables || [],
            refreshType: apiRefreshType,
            tableDetails: tableDetails || [],
            tableCount: (tables || []).length,
            requestId: result.requestId,
            success: true
        });
        res.json({ success: true, requestId: result.requestId });
    } catch (err) {
        console.error('Refresh error:', err);
        logEvent('refresh', { tables: tables || [], refreshType: refreshType || 'automatic', success: false, error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// API: Check refresh status (with per-object detail)
app.get('/api/fabric/refresh/status/:requestId', async (req, res) => {
    const { requestId } = req.params;

    if (!lastProdFabricInfo) {
        return res.status(400).json({ error: 'No Fabric target available.' });
    }

    try {
        const token = await fabricAuth.getAccessToken();
        if (!token) {
            return res.status(401).json({ error: 'Not authenticated.' });
        }

        const { workspaceId, semanticModelId } = lastProdFabricInfo;
        const apiStatus = await fabricApi.getRefreshStatus(token, workspaceId, semanticModelId, requestId);

        // Update the session record with full status (including objects array)
        const record = refreshStore.updateRefreshRecord(requestId, apiStatus);

        const refreshLogPayload = {
            requestId,
            target: `workspace:${workspaceId}/model:${semanticModelId}`,
            status: apiStatus.status || null,
            startTime: apiStatus.startTime || null,
            endTime: apiStatus.endTime || null
        };
        // On failure, include error details so the activity log is diagnostic
        if (apiStatus.status === 'Failed') {
            if (apiStatus.serviceExceptionJson) {
                refreshLogPayload.serviceExceptionJson = apiStatus.serviceExceptionJson;
            }
            const objErrors = (apiStatus.objects || [])
                .filter(o => o.serviceExceptionJson)
                .map(o => ({ table: o.table, partition: o.partition || o.table, error: o.serviceExceptionJson }));
            if (objErrors.length > 0) {
                refreshLogPayload.objectErrors = objErrors;
            }
        }
        logEvent('refresh-status', refreshLogPayload);

        // Auto-trigger post-calculate when dataOnly refresh completes successfully
        let postCalculateInfo = null;
        if (record && record.needsPostCalculate && !record.postCalculateTriggered && record.status === 'completed') {
            try {
                const calcResult = await fabricApi.refreshSemanticModel(token, workspaceId, semanticModelId, [], 'calculate');
                record.postCalculateTriggered = true;
                record.postCalculateRequestId = calcResult.requestId || null;

                if (calcResult.requestId) {
                    refreshStore.createRefreshRecord(
                        calcResult.requestId,
                        record.modelName,
                        workspaceId,
                        semanticModelId,
                        [],
                        [{ table: '_model_', refreshType: 'calculate', reasons: ['post-refresh relationship recalculation'] }],
                        'calculate',
                        { needsPostCalculate: false }
                    );
                }

                logEvent('refresh', {
                    target: `workspace:${workspaceId}/model:${semanticModelId}`,
                    tables: [],
                    refreshType: 'calculate',
                    tableDetails: [{ table: '_model_', refreshType: 'calculate', reasons: ['post-refresh relationship recalculation'] }],
                    tableCount: 0,
                    requestId: calcResult.requestId,
                    success: true,
                    trigger: 'auto-post-calculate'
                });

                postCalculateInfo = { requestId: calcResult.requestId, status: 'inProgress' };
            } catch (calcErr) {
                console.error('Auto post-calculate failed:', calcErr.message);
                logEvent('refresh', {
                    target: `workspace:${workspaceId}/model:${semanticModelId}`,
                    refreshType: 'calculate',
                    success: false,
                    error: calcErr.message,
                    trigger: 'auto-post-calculate'
                });
            }
        }

        // Return merged response: API data + our tracked objects + post-calculate info
        res.json({
            ...apiStatus,
            trackedObjects: record ? record.objects : [],
            topLevelError: record ? (record.serviceExceptionJson || null) : (apiStatus.serviceExceptionJson || null),
            requestedTables: record ? record.requestedTables : [],
            postCalculate: postCalculateInfo
        });
    } catch (err) {
        console.error('Refresh status error:', err);
        logEvent('refresh-status', { requestId, success: false, error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// API: Get refresh session history
app.get('/api/fabric/refresh/history', (req, res) => {
    res.json(refreshStore.getSessionHistory());
});

// API: Get active refresh (if any)
app.get('/api/fabric/refresh/active', (req, res) => {
    const active = refreshStore.getActiveRefresh();
    res.json({ active: active || null });
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
                semanticModelId: prodSource.semanticModelId,
                modelName: prodModel.name || 'SemanticModel'
            };
        }

        logEvent('compare', {
            mode: `${devSource.type}-${prodSource.type}`,
            devSource: devLabel,
            prodSource: prodLabel,
            diffCount: result.diffs ? result.diffs.length : 0,
            groupCount: result.groups ? result.groups.length : 0,
            success: true
        });
        res.json(result);
    } catch (err) {
        console.error('Comparison error:', err);
        logEvent('compare', { mode: `${devSource && devSource.type}-${prodSource && prodSource.type}`, success: false, error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// API: Read recent activity log entries.
app.get('/api/activity-log', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 2000);
    try {
        const entries = readEvents(limit);
        res.json({ entries });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Resolve a .pbip, .pbism file OR a folder path to the definition/ folder path.
 * Supports:
 *  - .pbip file → finds .SemanticModel/definition/ next to it
 *  - .pbism file → finds definition/ in same directory
 *  - .SemanticModel folder → finds definition/ inside
 *  - Any folder containing a .SemanticModel subfolder → resolves it
 *  - Any folder containing definition/model.tmdl → uses it directly
 */
function resolveModelFromFile(filePath) {
    const resolved = path.resolve(filePath);

    // Check if it's a directory
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        // Case 1: The folder itself IS a .SemanticModel folder
        if (/\.SemanticModel$/i.test(resolved)) {
            const defFolder = path.join(resolved, 'definition');
            if (fs.existsSync(defFolder) && fs.existsSync(path.join(defFolder, 'model.tmdl'))) {
                return defFolder;
            }
            // Maybe it's a flat structure without definition/ subfolder
            if (fs.existsSync(path.join(resolved, 'model.tmdl'))) {
                return resolved;
            }
            throw new Error(`Folder "${path.basename(resolved)}" does not contain a valid TMDL definition.`);
        }

        // Case 2: The folder is a definition/ folder itself (contains model.tmdl)
        if (fs.existsSync(path.join(resolved, 'model.tmdl'))) {
            return resolved;
        }

        // Case 3: The folder contains a .SemanticModel subfolder
        const entries = fs.readdirSync(resolved);
        const smDir = entries.find(e => e.endsWith('.SemanticModel') && fs.statSync(path.join(resolved, e)).isDirectory());
        if (smDir) {
            const defFolder = path.join(resolved, smDir, 'definition');
            if (fs.existsSync(defFolder)) return defFolder;
            return path.join(resolved, smDir);
        }

        throw new Error(`No .SemanticModel folder or TMDL definition found in "${path.basename(resolved)}". Select a .SemanticModel folder or a folder containing one.`);
    }

    // File path handling
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
        const smDirEntry = entries.find(e => e.endsWith('.SemanticModel') && fs.statSync(path.join(dir, e)).isDirectory());
        if (smDirEntry) {
            const defFolder = path.join(dir, smDirEntry, 'definition');
            if (fs.existsSync(defFolder)) return defFolder;
            return path.join(dir, smDirEntry);
        }
        throw new Error(`No .SemanticModel folder found next to ${path.basename(resolved)}`);
    }

    if (ext === '.pbism') {
        // definition.pbism: the definition/ folder is in the same directory
        const defFolder = path.join(dir, 'definition');
        if (fs.existsSync(defFolder)) return defFolder;
        return dir;
    }

    throw new Error(`Unsupported path: "${path.basename(resolved)}". Select a .SemanticModel folder, .pbip file, or .pbism file.`);
}

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function startServer(port, maxAttempts = 20) {
    const server = app.listen(port, () => {
        const url = `http://localhost:${port}`;
        console.log(`Model Alchemist v${APP_VERSION} running at ${url}`);
        const { exec } = require('child_process');
        exec(`start "" "${url}"`);
    });
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && port - PORT < maxAttempts - 1) {
            console.log(`Port ${port} is busy, trying ${port + 1}...`);
            startServer(port + 1, maxAttempts);
        } else {
            console.error(`Could not find a free port after ${maxAttempts} attempts (tried ${PORT}-${port}).`);
            process.exit(1);
        }
    });
}

startServer(PORT);
