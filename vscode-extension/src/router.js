/**
 * Answers the webview's messages (see public/js/transport.js for the protocol).
 *
 * API requests are matched against core/routes.js, the same table server.js
 * serves, and run by core/service.js. Everything the web server does through
 * the operating system is a host call instead:
 *   host.pickFolder({ target, initialdir })     → { cancelled, filePath }
 *   host.saveFile({ filename, content, mimeType, bom }) → { saved, path?, error? }
 *   host.confirmDeploy(targetPath)              → true to go ahead
 *   host.onReady()                              the page has wired itself
 *
 * No `vscode` import here, so the router is tested in plain Node.
 */
const path = require('path');
const { matchRoute } = require('../../core/routes');

function createRouter({ service, state, host }) {

    async function request({ method, path: urlPath, query = {}, body }) {
        if (method === 'GET' && urlPath === '/api/pick-file') {
            const picked = await host.pickFolder({ target: query.target || 'model', initialdir: query.initialdir || '' });
            return { status: 200, body: picked };
        }

        const match = matchRoute(method, urlPath);
        if (!match) {
            return { status: 404, body: { error: `Unknown API route: ${method} ${urlPath}` } };
        }

        const { route, params } = match;

        // A local deploy rewrites TMDL files that may be open in an editor with
        // unsaved edits. The host asks before anything is written.
        if (route.operation === 'deploy' && !(body && body.dryRun) && state.lastProdPath) {
            const go = await host.confirmDeploy(modelFolderOf(state.lastProdPath));
            if (!go) {
                return { status: 409, body: { error: 'Deploy cancelled: the target model has unsaved changes in the editor.' } };
            }
        }

        try {
            return await service[route.operation](state, route.input({ body: body || {}, params, query }));
        } catch (err) {
            // Operations answer expected failures themselves; this is a bug guard.
            return { status: 500, body: { error: err.message } };
        }
    }

    /** Handle one message; resolves to the reply to post back, or null. */
    async function handle(msg) {
        if (!msg || typeof msg !== 'object') return null;
        switch (msg.type) {
            case 'request': {
                const { status, body } = await request(msg);
                return { type: 'response', id: msg.id, status, body };
            }
            case 'saveFile': {
                let result;
                try {
                    result = await host.saveFile({ filename: msg.filename, content: msg.content, mimeType: msg.mimeType, bom: !!msg.bom });
                } catch (err) {
                    result = { saved: false, error: err.message };
                }
                return Object.assign({ type: 'saveFileResult', id: msg.id }, result);
            }
            case 'ready':
                host.onReady();
                return null;
            default:
                return null;
        }
    }

    return { handle };
}

/** The .SemanticModel folder for a definition/ folder; anything else as is. */
function modelFolderOf(definitionPath) {
    return path.basename(definitionPath).toLowerCase() === 'definition' ? path.dirname(definitionPath) : definitionPath;
}

/** True when `file` is `folder` itself or somewhere inside it (case-insensitive on Windows). */
function isInside(file, folder) {
    const norm = p => {
        const resolved = path.resolve(p);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const rel = path.relative(norm(folder), norm(file));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = { createRouter, modelFolderOf, isInside };
