const express = require('express');
const path = require('path');
const { execFile } = require('child_process');
const sessionStore = require('./lib/session-store');
const { createService, accountForClient, APP_VERSION } = require('./core/service');
const { ROUTES } = require('./core/routes');
const { deployToFabric, inspectTargetReadiness, detectTablesNeedingRefresh } = require('./core/fabric-deploy');

const BACKUP_DIR = path.join(__dirname, 'backups');

const app = express();
// process.env.PORT is a STRING. Without the parse, the EADDRINUSE fallback did
// '3001' + 1 = '30011' and bound a port nobody asked for.
const PORT = parseInt(process.env.PORT, 10) || 3001;
// Loopback only: the API reads local files and acts with the signed-in user's
// Fabric token, and has no authentication of its own. Without a host, Express
// listens on every interface and anyone on the network can call it.
// Set HOST (e.g. 0.0.0.0) only if you accept that.
const HOST = process.env.HOST || '127.0.0.1';

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

// Every /api route comes from the shared table in core/routes.js, which the
// VS Code extension uses for its webview messages too.
for (const { method, path: routePath, operation, input } of ROUTES) {
    app[method.toLowerCase()](routePath, async (req, res) => {
        const { status, body } = await service[operation](stateFor(req), input(req));
        res.status(status).json(body);
    });
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

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Is the port free on every interface? Binding only HOST is not enough to tell:
 * Windows lets 127.0.0.1:port be bound while another program holds the same port
 * on all interfaces, and "localhost" in the browser may then reach that program.
 */
function portIsFree(port, callback) {
    const probe = require('net').createServer();
    probe.once('error', () => callback(false));
    probe.listen(port, () => probe.close(() => callback(true)));
}

function startServer(portArg, maxAttempts = 20) {
    const port = Number(portArg);
    const tryNext = () => {
        if (port - PORT < maxAttempts - 1) {
            console.log(`Port ${port} is busy, trying ${port + 1}...`);
            startServer(port + 1, maxAttempts);
        } else {
            console.error(`Could not find a free port after ${maxAttempts} attempts (tried ${PORT}-${port}).`);
            process.exit(1);
        }
    };
    portIsFree(port, free => (free ? listen(port, tryNext) : tryNext()));
}

function listen(port, tryNext) {
    const server = app.listen(port, HOST, () => {
        const url = `http://localhost:${port}`;
        console.log(`Model Alchemist v${APP_VERSION} running at ${url}`);
        if (accountForClient({})?.presentation) console.log('Presentation Mode: the signed-in account is hidden in the UI.');
        const { exec } = require('child_process');
        exec(`start "" "${url}"`);
    });
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') return tryNext();
        console.error(`Could not start the server on ${HOST}:${port}: ${err.message}`);
        process.exit(1);
    });
}

// Guarded so tests can `require('../server')` for its exports without binding a real port.
if (require.main === module) {
    startServer(PORT);
}

// Re-exported for the tests that have always imported them from here.
module.exports = { app, deployToFabric, inspectTargetReadiness, detectTablesNeedingRefresh, accountForClient };
