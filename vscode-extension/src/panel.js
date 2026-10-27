/**
 * The Model Alchemist panel: the web UI from public/ in a webview, with its
 * messages answered by the router and the host calls done with VS Code APIs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const sessionStore = require('../../lib/session-store');
const { buildWebviewHtml, makeNonce } = require('./html');
const { createRouter, isInside } = require('./router');

let panelCount = 0;

class ModelAlchemistPanel {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {ReturnType<import('../../core/service').createService>} service
     * @param {(msg: object, reply: object|null) => void} [observe] sees every message and its reply (tests)
     */
    constructor(context, service, observe = () => {}) {
        const publicRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'public');
        this.ready = false;
        this.queued = [];

        this.panel = vscode.window.createWebviewPanel('modelAlchemist', 'Model Alchemist', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [publicRoot]
        });
        this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'public', 'favicon.png');

        const webview = this.panel.webview;
        const indexHtml = fs.readFileSync(path.join(publicRoot.fsPath, 'index.html'), 'utf-8');
        webview.html = buildWebviewHtml(indexHtml, {
            cspSource: webview.cspSource,
            nonce: makeNonce(),
            asWebviewUri: rel => webview.asWebviewUri(vscode.Uri.joinPath(publicRoot, ...rel.split('/'))).toString()
        });

        // One comparison state per panel, like one per browser tab in the web app.
        const state = sessionStore.getState(`vscode-panel-${++panelCount}`);
        const router = createRouter({ service, state, host: this.host() });

        webview.onDidReceiveMessage(async msg => {
            const reply = await router.handle(msg);
            observe(msg, reply);
            if (reply) webview.postMessage(reply);
        });

        this.disposed = false;
        this.panel.onDidDispose(() => { this.disposed = true; });
    }

    /** Send a command to the page, once it is ready to take it. */
    sendCommand(command) {
        const msg = Object.assign({ type: 'command' }, command);
        if (this.ready) this.panel.webview.postMessage(msg);
        else this.queued.push(msg);
    }

    reveal() {
        this.panel.reveal();
    }

    host() {
        return {
            onReady: () => {
                this.ready = true;
                for (const msg of this.queued.splice(0)) this.panel.webview.postMessage(msg);
            },

            pickFolder: async ({ target, initialdir }) => {
                const start = initialdir && fs.existsSync(initialdir) ? vscode.Uri.file(initialdir) : defaultFolder();
                const picked = await vscode.window.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    defaultUri: start,
                    openLabel: 'Select',
                    title: `Select ${target === 'dev' ? 'SOURCE' : target === 'prod' ? 'TARGET' : 'model'} folder (.SemanticModel)`
                });
                return picked && picked[0]
                    ? { cancelled: false, filePath: picked[0].fsPath }
                    : { cancelled: true, filePath: null };
            },

            saveFile: async ({ filename, content, bom }) => {
                const ext = path.extname(filename).slice(1);
                const uri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.joinPath(defaultFolder(), filename),
                    filters: ext ? { [ext.toUpperCase()]: [ext] } : undefined,
                    title: 'Export comparison'
                });
                if (!uri) return { saved: false };
                await vscode.workspace.fs.writeFile(uri, Buffer.from((bom ? '﻿' : '') + content, 'utf-8'));
                vscode.window.showInformationMessage(`Exported ${path.basename(uri.fsPath)}`, 'Open').then(choice => {
                    if (choice === 'Open') vscode.commands.executeCommand('vscode.open', uri);
                });
                return { saved: true, path: uri.fsPath };
            },

            confirmDeploy: async targetFolder => {
                const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && d.uri.scheme === 'file' && isInside(d.uri.fsPath, targetFolder));
                if (dirty.length === 0) return true;
                const names = dirty.slice(0, 5).map(d => path.basename(d.uri.fsPath)).join(', ') + (dirty.length > 5 ? ', …' : '');
                const choice = await vscode.window.showWarningMessage(
                    `${dirty.length} file(s) of the target model have unsaved changes: ${names}. ` +
                    'The deploy writes these files, so the unsaved edits would be lost or would overwrite the deploy.',
                    { modal: true },
                    'Save All and Deploy'
                );
                if (choice !== 'Save All and Deploy') return false;
                const saved = await Promise.all(dirty.map(d => d.save()));
                return saved.every(Boolean);
            }
        };
    }
}

/** Where dialogs start: the first workspace folder, else the home folder. */
function defaultFolder() {
    const ws = vscode.workspace.workspaceFolders;
    return ws && ws.length ? ws[0].uri : vscode.Uri.file(os.homedir());
}

module.exports = { ModelAlchemistPanel };
