/**
 * Turn public/index.html into a page a VS Code webview can load.
 *
 * A webview cannot fetch relative URLs from disk, so every local reference
 * (css/, js/, favicon.png) is rewritten to a webview URI, and a Content Security
 * Policy is added: scripts only from the extension with this page's nonce,
 * styles from the extension plus inline style attributes (the UI sets those
 * when it renders), no network access at all.
 */
const LOCAL_REF = /\b(src|href)="((?:css|js)\/[^"]+|favicon\.png)"/g;

/**
 * @param {string} indexHtml contents of public/index.html
 * @param {{ cspSource: string, nonce: string, asWebviewUri: (relPath: string) => string }} opts
 */
function buildWebviewHtml(indexHtml, { cspSource, nonce, asWebviewUri }) {
    const csp = [
        "default-src 'none'",
        `img-src ${cspSource} data:`,
        `style-src ${cspSource} 'unsafe-inline'`,
        `font-src ${cspSource}`,
        `script-src 'nonce-${nonce}'`
    ].join('; ');

    let html = indexHtml.replace(LOCAL_REF, (_, attr, rel) => `${attr}="${asWebviewUri(rel)}"`);
    html = html.replace(/<script src=/g, `<script nonce="${nonce}" src=`);
    html = html.replace(/<head>/i, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
    return html;
}

/** A random nonce for one page load. */
function makeNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

module.exports = { buildWebviewHtml, makeNonce };
