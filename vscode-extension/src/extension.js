/**
 * Model Alchemist for VS Code: the same comparison and deployment as the web
 * app, in a panel. The operations are core/service.js, unchanged; this file
 * wires paths, settings and commands.
 */
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { createService } = require('../../core/service');
const activityLog = require('../../lib/activity-log');
const refreshStore = require('../../lib/refresh-store');
const unavailableAuth = require('./auth-unavailable');
const { ModelAlchemistPanel } = require('./panel');

/** Backup and log folders: the settings when set, else the extension's storage. */
function resolveFolders(context) {
    const config = vscode.workspace.getConfiguration('modelAlchemist');
    const storage = context.globalStorageUri.fsPath;
    return {
        backupDir: config.get('backupPath') || path.join(storage, 'backups'),
        logDir: config.get('logPath') || path.join(storage, 'logs')
    };
}

function activate(context) {
    // The bundle lives in the installed extension folder, which is replaced on
    // every update: logs must go elsewhere before the first event is written.
    let folders = resolveFolders(context);
    activityLog.setLogDir(folders.logDir);
    refreshStore.setLogDir(folders.logDir);
    let service = createService({ auth: unavailableAuth, backupDir: folders.backupDir });

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('modelAlchemist')) return;
        folders = resolveFolders(context);
        activityLog.setLogDir(folders.logDir);
        refreshStore.setLogDir(folders.logDir);
        service = createService({ auth: unavailableAuth, backupDir: folders.backupDir });
    }));

    const observers = [];
    let current = null;

    function openPanel() {
        if (current && !current.disposed) {
            current.reveal();
            return current;
        }
        // The service is looked up per message, so a settings change applies to an open panel too.
        const live = new Proxy({}, { get: (_, name) => service[name] });
        current = new ModelAlchemistPanel(context, live, (msg, reply) => observers.forEach(fn => fn(msg, reply)));
        return current;
    }

    context.subscriptions.push(
        // The Activity Bar view has no items of its own: its welcome content
        // (package.json, viewsWelcome) is the start page, shown while the tree is empty.
        vscode.window.registerTreeDataProvider('modelAlchemist.start', { getChildren: () => [], getTreeItem: item => item }),

        vscode.commands.registerCommand('modelAlchemist.open', () => { openPanel(); }),

        // From the Explorer: the clicked model is the Source; the Target is picked next.
        // `targetUri` lets other code (and the tests) skip the dialog.
        vscode.commands.registerCommand('modelAlchemist.compareWith', async (sourceUri, targetUri) => {
            let source = sourceUri instanceof vscode.Uri ? sourceUri : null;
            if (!source) {
                const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: 'Select the SOURCE model folder (.SemanticModel)', openLabel: 'Select' });
                if (!picked || !picked[0]) return;
                source = picked[0];
            }
            let target = targetUri instanceof vscode.Uri ? targetUri : null;
            if (!target) {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    defaultUri: vscode.Uri.file(path.dirname(source.fsPath)),
                    title: `Compare ${path.basename(source.fsPath)} with… (select the TARGET model folder)`,
                    openLabel: 'Compare'
                });
                target = picked && picked[0];
            }
            const panel = openPanel();
            panel.sendCommand({ command: 'setPaths', source: source.fsPath, target: target ? target.fsPath : null, compare: !!target });
        }),

        vscode.commands.registerCommand('modelAlchemist.openLogs', async () => {
            fs.mkdirSync(folders.logDir, { recursive: true });
            await vscode.env.openExternal(vscode.Uri.file(folders.logDir));
        })
    );

    // For the end-to-end test: watch the panel's messages.
    return {
        onMessage(fn) { observers.push(fn); return () => observers.splice(observers.indexOf(fn), 1); },
        folders: () => folders
    };
}

function deactivate() {}

module.exports = { activate, deactivate };
