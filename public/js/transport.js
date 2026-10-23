/**
 * How the UI talks to its host. No DOM rendering here.
 *
 * The same UI runs in two hosts:
 *   - the browser, served by server.js: API calls are HTTP, a file is saved
 *     through a download link;
 *   - a VS Code webview: there is no HTTP server, so every API call and every
 *     file save is a message to the extension, which answers with a message.
 *
 * app.js only calls request(), which resolves to an object with the part of the
 * fetch Response it uses ({ ok, status, json() }), and saveFile(). It never
 * needs to know which host it is in.
 *
 * Webview protocol (the extension side implements the other half):
 *   UI → host   { type: 'request', id, method, path, query, body }
 *   host → UI   { type: 'response', id, status, body }
 *   UI → host   { type: 'saveFile', id, filename, content, mimeType, bom }
 *   host → UI   { type: 'saveFileResult', id, saved, path?, error? }
 * `path` is the URL path the browser would call (e.g. '/api/compare'), `query`
 * its query string as an object. /api/pick-file is answered by the host's own
 * folder dialog with the same body the web server returns.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MATransport = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /** The subset of a fetch Response that app.js reads. */
    function responseLike(status, body) {
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body
        };
    }

    /** Split '/api/x?a=1&b=2' into a path and a plain query object. */
    function splitUrl(url) {
        const [path, search = ''] = String(url).split('?');
        const query = {};
        for (const pair of search.split('&')) {
            if (!pair) continue;
            const [k, v = ''] = pair.split('=');
            query[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
        }
        return { path, query };
    }

    /** A request body as the host should receive it: parsed JSON, or nothing. */
    function parseBody(body) {
        if (body == null || body === '') return undefined;
        if (typeof body !== 'string') return body;
        try { return JSON.parse(body); } catch { return body; }
    }

    /**
     * Browser host: HTTP to server.js. Every call carries the per-tab session id,
     * so two tabs keep two independent comparisons.
     */
    function createFetchTransport({ sessionId, fetchImpl, documentRef }) {
        return {
            kind: 'http',
            request(url, options = {}) {
                const headers = Object.assign({}, options.headers, { 'x-ma-session': sessionId });
                return fetchImpl(url, Object.assign({}, options, { headers }));
            },
            // Trigger a download (CSV gets a UTF-8 BOM so Excel reads accents correctly).
            async saveFile({ filename, content, mimeType, bom = false }) {
                const parts = bom ? ['﻿', content] : [content];
                const blob = new Blob(parts, { type: mimeType });
                const url = URL.createObjectURL(blob);
                const a = documentRef.createElement('a');
                a.href = url;
                a.download = filename;
                documentRef.body.appendChild(a);
                a.click();
                documentRef.body.removeChild(a);
                URL.revokeObjectURL(url);
                return { saved: true };
            }
        };
    }

    /**
     * VS Code webview host: messages to the extension. `vscodeApi` is the object
     * acquireVsCodeApi() returns; `windowRef` receives the answers.
     */
    function createWebviewTransport({ vscodeApi, windowRef }) {
        let nextId = 1;
        const pending = new Map();

        windowRef.addEventListener('message', event => {
            const msg = event.data;
            if (!msg || !pending.has(msg.id)) return;
            const resolve = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.type === 'response') resolve(responseLike(msg.status, msg.body));
            else if (msg.type === 'saveFileResult') resolve({ saved: !!msg.saved, path: msg.path, error: msg.error });
        });

        function send(message) {
            const id = nextId++;
            return new Promise(resolve => {
                pending.set(id, resolve);
                vscodeApi.postMessage(Object.assign({ id }, message));
            });
        }

        return {
            kind: 'webview',
            request(url, options = {}) {
                const { path, query } = splitUrl(url);
                return send({
                    type: 'request',
                    method: (options.method || 'GET').toUpperCase(),
                    path,
                    query,
                    body: parseBody(options.body)
                });
            },
            saveFile({ filename, content, mimeType, bom = false }) {
                return send({ type: 'saveFile', filename, content, mimeType, bom });
            },
            pendingCount: () => pending.size
        };
    }

    /** Pick the transport for the host this page is running in. */
    function createTransport({ sessionId, globalRef }) {
        if (typeof globalRef.acquireVsCodeApi === 'function') {
            return createWebviewTransport({ vscodeApi: globalRef.acquireVsCodeApi(), windowRef: globalRef });
        }
        return createFetchTransport({ sessionId, fetchImpl: globalRef.fetch.bind(globalRef), documentRef: globalRef.document });
    }

    return { createTransport, createFetchTransport, createWebviewTransport, splitUrl, parseBody, responseLike };
});
