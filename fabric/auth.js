/**
 * Fabric Authentication Module — MSAL interactive browser login.
 * Uses OAuth2 Authorization Code flow with PKCE (system browser popup).
 * NO credentials are stored — only the access token is held in memory.
 */

const msal = require('@azure/msal-node');
const { exec } = require('child_process');

const FABRIC_SCOPES = ['https://analysis.windows.net/powerbi/api/.default'];

// Default public client ID (Power BI Desktop — allows localhost redirects)
const DEFAULT_CLIENT_ID = 'ea0616ba-638b-4df5-95b9-636659ae5121';

let msalInstance = null;
let currentAccount = null;
let loginInProgress = false;
let loginPromise = null;
let loginAbortController = null;

/**
 * In-memory token cache. `expiresOn` is tracked so an expired token is never
 * handed out: acquireTokenSilent used to swallow every failure and the caller
 * then fell back to the stale token forever, so every Fabric call failed with a
 * bare 401 while the UI kept reporting "connected" until the server restarted.
 */
const tokenCache = { accessToken: null, expiresOn: null };

/** Treat a token as expired one minute early to cover clock skew and in-flight calls. */
const EXPIRY_SKEW_MS = 60 * 1000;

function tokenIsValid(expiresOn, now = Date.now(), skewMs = EXPIRY_SKEW_MS) {
    if (!expiresOn) return false;
    const time = expiresOn instanceof Date ? expiresOn.getTime() : new Date(expiresOn).getTime();
    if (Number.isNaN(time)) return false;
    return time - skewMs > now;
}

function cacheToken(result) {
    tokenCache.accessToken = result.accessToken;
    tokenCache.expiresOn = result.expiresOn || null;
}

function clearToken() {
    tokenCache.accessToken = null;
    tokenCache.expiresOn = null;
}

/**
 * Open URL in system browser.
 */
function openBrowser(url) {
    // Windows
    exec(`start "" "${url}"`);
}

/**
 * Initialize MSAL instance.
 */
function initMsal(clientId) {
    const msalConfig = {
        auth: {
            clientId: clientId || DEFAULT_CLIENT_ID,
            authority: 'https://login.microsoftonline.com/organizations',
        }
    };
    msalInstance = new msal.PublicClientApplication(msalConfig);
}

/**
 * Start interactive login via system browser.
 * Opens Microsoft login page — user authenticates there.
 * Returns a promise that resolves with the access token.
 */
async function loginInteractive(clientId) {
    if (loginInProgress) {
        return loginPromise;
    }

    initMsal(clientId);
    loginInProgress = true;
    loginAbortController = new AbortController();

    loginPromise = (async () => {
        try {
            const result = await Promise.race([
                msalInstance.acquireTokenInteractive({
                    scopes: FABRIC_SCOPES,
                    openBrowser: async (url) => {
                        openBrowser(url);
                    },
                    successTemplate: `
                        <html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#1a1a2e;color:#eee;">
                        <div style="text-align:center">
                            <h1 style="color:#4cc9f0">🧙 The gates of knowledge are open</h1>
                            <p>You can close this window and return to Model Alchemist.</p>
                        </div></body></html>`,
                    errorTemplate: `
                        <html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#1a1a2e;color:#eee;">
                        <div style="text-align:center">
                            <h1 style="color:#ff6b6b">✗ Login failed</h1>
                            <p>{{error}}</p>
                        </div></body></html>`
                }),
                new Promise((_, reject) => {
                    loginAbortController.signal.addEventListener('abort', () => {
                        reject(new Error('Login cancelled by user.'));
                    });
                })
            ]);

            currentAccount = result.account;
            cacheToken(result);
            return result.accessToken;
        } finally {
            loginInProgress = false;
            loginPromise = null;
            loginAbortController = null;
        }
    })();

    return loginPromise;
}

/**
 * Cancel an in-progress login attempt.
 */
function cancelLogin() {
    if (loginInProgress && loginAbortController) {
        loginAbortController.abort();
    }
}

/**
 * Acquire token silently using cached account.
 */
async function acquireTokenSilent() {
    if (!msalInstance || !currentAccount) {
        return null;
    }

    try {
        const result = await msalInstance.acquireTokenSilent({
            scopes: FABRIC_SCOPES,
            account: currentAccount
        });
        cacheToken(result);
        return result.accessToken;
    } catch (err) {
        lastAuthError = err && err.message ? err.message : 'Silent token refresh failed.';
        return null;
    }
}

let lastAuthError = null;

/**
 * Get a valid access token.
 *
 * Silent refresh first; the cached token is only reused while it is still valid.
 * An expired token is dropped so callers get `null` (and the UI reports
 * disconnected) instead of hitting Fabric with a token that always 401s.
 */
async function getAccessToken() {
    const token = await acquireTokenSilent();
    if (token) {
        lastAuthError = null;
        return token;
    }
    if (tokenCache.accessToken && tokenIsValid(tokenCache.expiresOn)) {
        return tokenCache.accessToken;
    }
    clearToken();
    return null;
}

/**
 * Check if authenticated. An expired, unrefreshable token is not authentication.
 */
function isAuthenticated() {
    return currentAccount !== null
        && tokenCache.accessToken !== null
        && tokenIsValid(tokenCache.expiresOn);
}

/** Why the last silent refresh failed, for a diagnostic message in the UI. */
function getLastAuthError() {
    return lastAuthError;
}

/**
 * Check if login is in progress.
 */
function isLoginPending() {
    return loginInProgress;
}

/**
 * Get current account info.
 */
function getAccountInfo() {
    if (!currentAccount) return null;
    return {
        username: currentAccount.username,
        name: currentAccount.name,
        tenantId: currentAccount.tenantId
    };
}

/**
 * Clear session / logout. No credentials to clear — only in-memory token.
 */
function logout() {
    currentAccount = null;
    clearToken();
    lastAuthError = null;
    msalInstance = null;
}

module.exports = {
    loginInteractive,
    cancelLogin,
    acquireTokenSilent,
    getAccessToken,
    isAuthenticated,
    isLoginPending,
    getAccountInfo,
    getLastAuthError,
    logout,
    // Exposed so the token lifetime can be asserted and inspected.
    tokenIsValid,
    tokenCache
};
