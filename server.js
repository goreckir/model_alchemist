const express = require('express');
const path = require('path');
const { execFile } = require('child_process');
const sessionStore = require('./lib/session-store');
const { createService, accountForClient, APP_VERSION } = require('./core/service');
const { deployToFabric, inspectTargetReadiness, detectTablesNeedingRefresh } = require('./core/fabric-deploy');

const BACKUP_DIR = path.join(__dirname, 'backups');

const app = express();
// process.env.PORT is a STRING. Without the parse, the EADDRINUSE fallback did
// '3001' + 1 = '30011' and bound a port nobody asked for.
const PORT = parseInt(process.env.PORT, 10) || 3001;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
    }
}));

// The operations live in core/service.js so the VS Code extension can run the
// same code without HTTP. This file only maps routes onto them.
const service = createService({ backupDir: BACKUP_DIR });

// Comparison state is per session (per browser tab), never module-global:
// concurrent tabs used to overwrite each other's comparison and deploy target.
const stateFor = req => sessionStore.stateFor(req);

/** Route a request to a service operation and send its { status, body }. */
function route(operation, input = req => req.body) {
    return async (req, res) => {
        const { status, body } = await operation(stateFor(req), input(req));
        res.status(status).json(body);
    };
}

app.get('/api/version', route(service.version));
app.get('/api/defaults', route(service.defaults));

app.post('/api/compare', route(service.compare));
app.post('/api/compare-fabric', route(service.compareFabric));
app.post('/api/deploy', route(service.deploy));
app.post('/api/deploy/preview', route(service.previewDeploy));
app.post('/api/resolve-model', route(service.resolveModel));

// ===== Fabric API Endpoints =====
// Login opens the system browser to the Microsoft sign-in page.
app.post('/api/fabric/login', route(service.fabricLogin));
app.get('/api/fabric/status', route(service.fabricStatus));
app.post('/api/fabric/cancel-login', route(service.fabricCancelLogin));
app.post('/api/fabric/disconnect', route(service.fabricDisconnect));
app.post('/api/fabric/resolve', route(service.fabricResolve));
app.post('/api/fabric/refresh', route(service.fabricRefresh));
app.get('/api/fabric/refresh/status/:requestId', route(service.fabricRefreshStatus, req => ({ requestId: req.params.requestId })));
app.get('/api/fabric/refresh/history', route(service.fabricRefreshHistory));
app.get('/api/fabric/refresh/active', route(service.fabricRefreshActive));
app.get('/api/fabric/readiness', route(service.fabricReadiness));

app.get('/api/activity-log', route(service.activityLog, req => ({ limit: req.query.limit })));

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

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function startServer(portArg, maxAttempts = 20) {
    const port = Number(portArg);
    const server = app.listen(port, () => {
        const url = `http://localhost:${port}`;
        console.log(`Model Alchemist v${APP_VERSION} running at ${url}`);
        if (accountForClient({})?.presentation) console.log('Presentation Mode: the signed-in account is hidden in the UI.');
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

// Guarded so tests can `require('../server')` for its exports without binding a real port.
if (require.main === module) {
    startServer(PORT);
}

// Re-exported for the tests that have always imported them from here.
module.exports = { app, deployToFabric, inspectTargetReadiness, detectTablesNeedingRefresh, accountForClient };
