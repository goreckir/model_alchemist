const test = require('node:test');
const assert = require('node:assert');
const { createVsCodeAuth, explainAuthError, POWER_BI_SCOPE } = require('../src/auth-vscode');

/**
 * A stand-in for vscode.authentication: `account` is who is signed in to VS Code
 * (null: nobody), `onCreate` decides what an interactive sign-in does.
 */
function fakeVsCode({ account = null, onCreate } = {}) {
    const calls = [];
    let token = 1;
    const vscodeApi = {
        authentication: {
            getSession: async (provider, scopes, options) => {
                calls.push({ provider, scopes, options });
                if (options.createIfNone) {
                    const result = onCreate ? await onCreate() : { label: 'someone@contoso.example' };
                    account = result;
                }
                return account ? { accessToken: `token-${token++}`, account } : undefined;
            }
        }
    };
    return { vscodeApi, calls, signOut: () => { account = null; } };
}

test('scopes: the Power BI scope and the home tenant, VS Code\'s own client unless one is set', () => {
    const { vscodeApi } = fakeVsCode();
    assert.deepStrictEqual(createVsCodeAuth(vscodeApi, () => ({})).scopes(), [POWER_BI_SCOPE, 'VSCODE_TENANT:organizations']);
    assert.deepStrictEqual(
        createVsCodeAuth(vscodeApi, () => ({ clientId: ' 1111-2222 ', tenant: 'contoso.onmicrosoft.com' })).scopes(),
        [POWER_BI_SCOPE, 'VSCODE_TENANT:contoso.onmicrosoft.com', 'VSCODE_CLIENT_ID:1111-2222']
    );
});

test('a settings change applies to the next token request', async () => {
    const fake = fakeVsCode({ account: { label: 'a' } });
    let settings = {};
    const auth = createVsCodeAuth(fake.vscodeApi, () => settings);
    await auth.getAccessToken();
    settings = { clientId: 'abc' };
    await auth.getAccessToken();
    assert.ok(!fake.calls[0].scopes.some(s => s.startsWith('VSCODE_CLIENT_ID')));
    assert.ok(fake.calls[1].scopes.includes('VSCODE_CLIENT_ID:abc'));
});

test('an account already signed in to VS Code is used silently, without a prompt', async () => {
    const fake = fakeVsCode({ account: { label: 'someone@contoso.example' } });
    const auth = createVsCodeAuth(fake.vscodeApi, () => ({}));
    assert.strictEqual(await auth.getAccessToken(), 'token-1');
    assert.deepStrictEqual(fake.calls[0].options, { silent: true });
    assert.strictEqual(auth.isAuthenticated(), true);
    assert.deepStrictEqual(auth.getAccountInfo(), { username: 'someone@contoso.example', name: 'someone@contoso.example' });
});

test('nobody signed in: no token, no error, not authenticated', async () => {
    const auth = createVsCodeAuth(fakeVsCode().vscodeApi, () => ({}));
    assert.strictEqual(await auth.getAccessToken(), null);
    assert.strictEqual(auth.isAuthenticated(), false);
    assert.strictEqual(auth.getLastAuthError(), null);
    assert.strictEqual(auth.getAccountInfo(), null);
});

test('sign-in asks VS Code to create a session, and is pending meanwhile', async () => {
    let finish;
    const fake = fakeVsCode({ onCreate: () => new Promise(resolve => { finish = resolve; }) });
    const auth = createVsCodeAuth(fake.vscodeApi, () => ({}));
    const signingIn = auth.loginInteractive();
    assert.strictEqual(auth.isLoginPending(), true);
    finish({ label: 'someone@contoso.example' });
    assert.strictEqual(await signingIn, 'token-1');
    assert.strictEqual(auth.isLoginPending(), false);
    assert.strictEqual(auth.isAuthenticated(), true);
    assert.deepStrictEqual(fake.calls[0].options, { createIfNone: true, clearSessionPreference: false });
});

test('disconnect keeps Model Alchemist signed out even though VS Code still has the account', async () => {
    const fake = fakeVsCode({ account: { label: 'a' } });
    const auth = createVsCodeAuth(fake.vscodeApi, () => ({}));
    await auth.getAccessToken();
    auth.logout();
    assert.strictEqual(auth.isAuthenticated(), false);
    assert.strictEqual(await auth.getAccessToken(), null, 'no silent reconnect');
    assert.strictEqual(fake.calls.length, 1, 'VS Code was not even asked');

    // Signing in again lets the user pick an account.
    await auth.loginInteractive();
    assert.strictEqual(fake.calls.at(-1).options.clearSessionPreference, true);
    assert.strictEqual(auth.isAuthenticated(), true);
});

test('a cancelled wait ignores the sign-in that finishes later', async () => {
    let finish;
    const fake = fakeVsCode({ onCreate: () => new Promise(resolve => { finish = resolve; }) });
    const auth = createVsCodeAuth(fake.vscodeApi, () => ({}));
    const signingIn = auth.loginInteractive();
    auth.cancelLogin();
    assert.strictEqual(auth.isLoginPending(), false);
    finish({ label: 'late@contoso.example' });
    assert.strictEqual(await signingIn, null);
    assert.strictEqual(auth.isAuthenticated(), false);
});

test('signing out of VS Code drops the cached session', async () => {
    const fake = fakeVsCode({ account: { label: 'a' } });
    const auth = createVsCodeAuth(fake.vscodeApi, () => ({}));
    await auth.getAccessToken();
    fake.signOut();
    auth.onSessionsChanged({ provider: { id: 'microsoft' } });
    assert.strictEqual(auth.isAuthenticated(), false);
    assert.strictEqual(await auth.getAccessToken(), null);
    auth.onSessionsChanged({ provider: { id: 'github' } });   // other providers are ignored
});

test('a refused sign-in is explained and remembered for the status', async () => {
    const auth = createVsCodeAuth(fakeVsCode({ onCreate: async () => { throw new Error('AADSTS65002: Consent between first party application and first party resource must be configured via preauthorization'); } }).vscodeApi, () => ({}));
    await assert.rejects(auth.loginInteractive(), /modelAlchemist\.fabric\.clientId/);
    assert.match(auth.getLastAuthError(), /AADSTS65002/);
    assert.strictEqual(auth.isLoginPending(), false);
});

test('error messages: cancelling is not a policy problem', () => {
    assert.strictEqual(explainAuthError(new Error('User did not consent to login.')), 'Sign-in was cancelled.');
    assert.strictEqual(explainAuthError(new Error('Cancelled')), 'Sign-in was cancelled.');
    assert.match(explainAuthError(new Error('AADSTS65001: The user or administrator has not consented')), /clientId/);
    assert.match(explainAuthError(new Error('AADSTS90094: admin approval')), /clientId/);
    assert.strictEqual(explainAuthError(new Error('network down')), 'network down');
});
