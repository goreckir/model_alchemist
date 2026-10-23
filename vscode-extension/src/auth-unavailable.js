/**
 * Fabric sign-in for the extension, until it is decided which client id the
 * extension signs in with (#94, WP4). It has the interface of fabric/auth.js
 * and is never signed in, so Fabric sources and targets report a clear reason
 * and local models work as usual.
 */
const REASON = 'Fabric sign-in is not available in the VS Code extension yet. Compare local models here, or use the web app for Fabric.';

module.exports = {
    isAuthenticated: () => false,
    isLoginPending: () => false,
    getAccessToken: async () => null,
    getAccountInfo: () => null,
    getLastAuthError: () => REASON,
    loginInteractive: async () => { throw new Error(REASON); },
    cancelLogin: () => {},
    logout: () => {},
    REASON
};
