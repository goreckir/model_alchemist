/**
 * Fabric sign-in through the Microsoft account in VS Code (Accounts menu).
 *
 * Same interface as fabric/auth.js, which the web app uses with MSAL. Here the
 * token comes from vscode.authentication: VS Code stores and refreshes it, and
 * the user signs in once for every extension that asks.
 *
 * The Power BI scope is the one the web app uses; its token works for both
 * api.powerbi.com and api.fabric.microsoft.com. The provider reads two special
 * entries in the scope list: VSCODE_TENANT (which directory) and, when the
 * modelAlchemist.fabric.clientId setting is set, VSCODE_CLIENT_ID (which app
 * registration signs in). Without a client id, VS Code's own client is used.
 * See analysis/2026-10-27-vscode-extension-fabric-auth.md.
 */
const PROVIDER = 'microsoft';
const POWER_BI_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';

/** A sign-in error as the user should read it. */
function explainAuthError(err) {
    const text = (err && err.message) || String(err || 'Sign-in failed.');
    // Closing VS Code's sign-in prompt reads "User did not consent to login." —
    // the user's choice, not a directory policy. Check it first.
    if (/did not consent to login|cancel/i.test(text)) return 'Sign-in was cancelled.';
    // The directory refuses this app for the Power BI API (not pre-authorised,
    // missing permission, or admin consent required).
    if (/AADSTS(65002|650057|65001|90094|90008)|preauthori[sz]ation/i.test(text)) {
        return 'Your organisation does not let this sign-in app call the Power BI API. ' +
            'Set "modelAlchemist.fabric.clientId" to an app registration that has the Power BI Service permission, then sign in again. ' +
            `(${text})`;
    }
    return text;
}

/**
 * @param {{ authentication: typeof import('vscode').authentication }} vscodeApi
 * @param {() => { clientId?: string, tenant?: string }} getSettings read on every call, so a settings change applies at once
 */
function createVsCodeAuth(vscodeApi, getSettings) {
    let session = null;
    let pending = false;
    let attempt = 0;
    let lastError = null;
    // After "Disconnect" in Model Alchemist the VS Code account stays signed in,
    // so a silent lookup would reconnect at once. Stay out until the user signs in again.
    let signedOut = false;

    function scopes() {
        const { clientId = '', tenant = '' } = getSettings() || {};
        const list = [POWER_BI_SCOPE, `VSCODE_TENANT:${tenant.trim() || 'organizations'}`];
        if (clientId.trim()) list.push(`VSCODE_CLIENT_ID:${clientId.trim()}`);
        return list;
    }

    function onSessionsChanged(e) {
        if (e && e.provider && e.provider.id === PROVIDER) session = null;
    }

    async function getAccessToken() {
        if (signedOut) return null;
        try {
            const found = await vscodeApi.authentication.getSession(PROVIDER, scopes(), { silent: true });
            session = found || null;
            if (session) lastError = null;
            return session ? session.accessToken : null;
        } catch (err) {
            session = null;
            lastError = explainAuthError(err);
            return null;
        }
    }

    async function loginInteractive() {
        const mine = ++attempt;
        pending = true;
        try {
            const created = await vscodeApi.authentication.getSession(PROVIDER, scopes(), {
                createIfNone: true,
                // After a Model Alchemist disconnect, let the user pick another account.
                clearSessionPreference: signedOut
            });
            if (mine !== attempt) return null;   // cancelled in the meantime
            session = created;
            signedOut = false;
            lastError = null;
            return session.accessToken;
        } catch (err) {
            if (mine !== attempt) return null;
            lastError = explainAuthError(err);
            throw new Error(lastError);
        } finally {
            if (mine === attempt) pending = false;
        }
    }

    /** VS Code's sign-in flow cannot be cancelled by an extension: stop waiting and ignore its result. */
    function cancelLogin() {
        attempt++;
        pending = false;
    }

    function logout() {
        attempt++;
        pending = false;
        session = null;
        signedOut = true;
        lastError = null;
    }

    return {
        getAccessToken,
        loginInteractive,
        cancelLogin,
        logout,
        isAuthenticated: () => !signedOut && session !== null,
        isLoginPending: () => pending,
        getAccountInfo: () => session ? { username: session.account.label, name: session.account.label } : null,
        getLastAuthError: () => lastError,
        onSessionsChanged,
        scopes
    };
}

module.exports = { createVsCodeAuth, explainAuthError, POWER_BI_SCOPE };
