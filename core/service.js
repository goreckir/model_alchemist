/**
 * Model Alchemist operations, independent of the host that exposes them.
 *
 * Every operation takes the caller's comparison state (one per browser tab or
 * VS Code panel) and the request input, and resolves to `{ status, body }`:
 * exactly the HTTP status and JSON body the web app has always returned. The
 * Express server sends that as is; the VS Code extension posts it back to its
 * webview. Operations never throw for an expected failure.
 *
 * Host-specific pieces are injected through createService():
 *   - auth:      Fabric sign-in, the interface of fabric/auth.js;
 *   - backupDir: default folder for backups, shown in the UI.
 */
const path = require('path');
const { loadModelFromFolder } = require('../parser/model-loader');
const { compareModels } = require('../comparison/engine');
const { deployChanges } = require('../deployment/deployer');
const fabricAuth = require('../fabric/auth');
const fabricApi = require('../fabric/api-client');
const { loadModelFromFabric } = require('../fabric/model-loader');
const { parseConnectionString } = require('../fabric/connection-parser');
const { logEvent, readEvents } = require('../lib/activity-log');
const refreshStore = require('../lib/refresh-store');
const sessionStore = require('../lib/session-store');
const { resolveDefinitionPath, resolveModelFromFile } = require('./model-paths');
const { deployToFabric, inspectTargetReadiness } = require('./fabric-deploy');
const gitClient = require('../git/git-client');
const gitModelLoader = require('../git/model-loader');

const pkg = require('../package.json');
const APP_VERSION = pkg.version;

const reply = (status, body) => ({ status, body });

/** An expected failure with its HTTP status; Git errors carry a stable code too. */
const failure = err => reply(err.status || 500, err.code ? { error: err.message, code: err.code } : { error: err.message });
const statusError = (status, message) => Object.assign(new Error(message), { status });

/** A Git target cannot be deployed to yet: that is the next phase of the feature. */
const GIT_DEPLOY_NOT_AVAILABLE = {
    error: 'Deploying to a Git branch is not available yet. Compare against a Local or Fabric target to deploy.',
    code: 'GIT_DEPLOY_NOT_AVAILABLE'
};

/**
 * The account as the browser may see it. With MA_PRESENTATION=1 (or true) the
 * signed-in identity is replaced by a neutral label, so the app can be shown on
 * a shared screen or recorded without exposing the user, their organisation or
 * tenant. Read per call, not at startup, so tests can toggle it.
 */
function accountForClient(account, env = process.env) {
    if (!account) return null;
    if (/^(1|true)$/i.test(env.MA_PRESENTATION || '')) return { name: 'Fabric account', presentation: true };
    return account;
}

function createService({ auth = fabricAuth, backupDir } = {}) {

    function version() {
        return reply(200, { version: APP_VERSION });
    }

    function defaults() {
        return reply(200, { version: APP_VERSION, backupPath: backupDir });
    }

    function compare(state, { devPath, prodPath } = {}) {
        if (!devPath || !prodPath) {
            return reply(400, { error: 'Both devPath and prodPath are required.' });
        }

        try {
            const devModel = loadModelFromFolder(devPath);
            const prodModel = loadModelFromFolder(prodPath);
            const result = compareModels(devModel, prodModel, devPath, prodPath);

            // Store for deployment — reset EVERY field first. Setting only three of
            // them left a previous Fabric compare's model and dataset armed, so a
            // deploy validated against the wrong model and refresh targeted a dataset
            // that was no longer in play.
            state = sessionStore.resetComparison(state);
            state.lastComparison = result;
            state.lastDevModel = devModel;
            state.lastProdModel = prodModel;
            state.lastProdPath = resolveDefinitionPath(prodPath);

            logEvent('compare', {
                mode: 'local-local',
                devSource: devPath,
                prodSource: prodPath,
                diffCount: result.diffs ? result.diffs.length : 0,
                groupCount: result.groups ? result.groups.length : 0,
                success: true
            });
            return reply(200, result);
        } catch (err) {
            console.error('Comparison error:', err);
            logEvent('compare', { mode: 'local-local', devSource: devPath, prodSource: prodPath, success: false, error: err.message });
            return reply(500, { error: err.message });
        }
    }

    async function deploy(state, body = {}) {
        const { selectedKeys, dryRun = false, backup = true, backupPath } = body;
        const { lastComparison, lastDevModel, lastProdPath, lastProdModel, lastProdFabricInfo } = state;

        if (!selectedKeys || !selectedKeys.length) {
            return reply(400, { error: 'No changes selected for deployment.' });
        }
        if (!lastComparison || !lastDevModel) {
            return reply(400, { error: 'No comparison result available. Run a comparison first.' });
        }
        if (state.lastProdGitInfo) {
            return reply(400, GIT_DEPLOY_NOT_AVAILABLE);
        }
        if (!lastProdPath && !lastProdFabricInfo) {
            return reply(400, { error: 'No valid PROD target. Run a comparison first.' });
        }

        try {
            // Find the diffs matching the selected keys
            const selectedDiffs = lastComparison.diffs.filter(d => selectedKeys.includes(d.identityKey));

            if (selectedDiffs.length === 0) {
                return reply(400, { error: 'None of the selected keys match current comparison results.' });
            }

            if (lastProdPath) {
                // Local deployment — use filesystem deployer
                const result = deployChanges(selectedDiffs, lastDevModel, lastProdPath, { dryRun, backup, backupPath, prodModel: lastProdModel, allDiffs: lastComparison.diffs });
                logEvent('deploy', {
                    mode: 'local',
                    dryRun,
                    target: lastProdPath,
                    selectedCount: selectedDiffs.length,
                    selectedDiffs: selectedDiffs.map(d => ({ type: d.type, objectType: d.objectType, name: d.displayName, identityKey: d.identityKey })),
                    success: result.success,
                    actionsExecuted: (result.actions || []).filter(a => a.type === 'applied').length,
                    errorCount: (result.errors || []).length,
                    warnings: result.warnings || [],
                    errors: result.errors || [],
                    backupPath: result.backupPath || null,
                    tablesNeedingRefresh: result.tablesNeedingRefresh || null
                });
                return reply(200, result);
            }

            // Fabric deployment — apply changes via temp dir, then upload
            const result = await deployToFabric(selectedDiffs, lastDevModel, lastProdModel, lastProdFabricInfo, { dryRun, backup, backupPath, allDiffs: lastComparison.diffs, comparison: lastComparison, force: body.force === true, auth });
            logEvent('deploy', {
                mode: 'fabric',
                dryRun,
                target: lastProdFabricInfo ? `workspace:${lastProdFabricInfo.workspaceId}/model:${lastProdFabricInfo.semanticModelId}` : null,
                selectedCount: selectedDiffs.length,
                selectedDiffs: selectedDiffs.map(d => ({ type: d.type, objectType: d.objectType, name: d.displayName, identityKey: d.identityKey })),
                success: result.success,
                actionsExecuted: (result.actions || []).filter(a => a.type === 'applied').length,
                errorCount: (result.errors || []).length,
                warnings: result.warnings || [],
                errors: result.errors || [],
                backupPath: result.backupPath || null,
                tablesNeedingRefresh: result.tablesNeedingRefresh || null,
                targetReadiness: result.targetReadiness || null
            });
            return reply(200, result);
        } catch (err) {
            console.error('Deployment error:', err);
            logEvent('deploy', { success: false, error: err.message });
            return reply(500, { error: err.message });
        }
    }

    async function previewDeploy(state, { selectedKeys } = {}) {
        const { lastComparison, lastDevModel, lastProdPath, lastProdModel, lastProdFabricInfo } = state;

        if (!selectedKeys || !selectedKeys.length) {
            return reply(400, { error: 'No changes selected.' });
        }
        if (!lastComparison || !lastDevModel) {
            return reply(400, { error: 'No comparison result available.' });
        }
        if (state.lastProdGitInfo) {
            return reply(400, GIT_DEPLOY_NOT_AVAILABLE);
        }
        if (!lastProdPath && !lastProdFabricInfo) {
            return reply(400, { error: 'No valid PROD target. Run a comparison first.' });
        }

        try {
            const selectedDiffs = lastComparison.diffs.filter(d => selectedKeys.includes(d.identityKey));
            if (lastProdPath) {
                const result = deployChanges(selectedDiffs, lastDevModel, lastProdPath, { dryRun: true, backup: false, prodModel: lastProdModel, allDiffs: lastComparison.diffs });
                return reply(200, result);
            }
            const result = await deployToFabric(selectedDiffs, lastDevModel, lastProdModel, lastProdFabricInfo, { dryRun: true, allDiffs: lastComparison.diffs, comparison: lastComparison, auth });
            return reply(200, result);
        } catch (err) {
            console.error('Preview error:', err);
            return reply(500, { error: err.message });
        }
    }

    function resolveModel(state, { filePath } = {}) {
        if (!filePath) {
            return reply(400, { error: 'filePath is required.' });
        }

        try {
            const resolved = resolveModelFromFile(filePath);
            return reply(200, { definitionPath: resolved, displayName: path.basename(path.dirname(resolved)) });
        } catch (err) {
            return reply(400, { error: err.message });
        }
    }

    // ===== Fabric =====

    // Starts interactive login; the host decides how the sign-in page is shown.
    // No credentials pass through this application.
    async function fabricLogin() {
        if (auth.isAuthenticated()) {
            const account = accountForClient(auth.getAccountInfo());
            return reply(200, { status: 'connected', account });
        }

        if (auth.isLoginPending()) {
            return reply(200, { status: 'pending', message: 'Login already in progress. Complete it in the browser window.' });
        }

        try {
            await auth.loginInteractive();
            const account = accountForClient(auth.getAccountInfo());
            return reply(200, { status: 'connected', account });
        } catch (err) {
            console.error('Fabric login error:', err);
            const msg = err.message || 'Login failed';
            return reply(401, { error: msg });
        }
    }

    async function fabricStatus() {
        if (auth.isLoginPending()) {
            return reply(200, { status: 'pending' });
        }
        // getAccessToken drops an expired token it cannot refresh, so a failed silent
        // refresh now reports disconnected instead of "connected" forever.
        const token = await auth.getAccessToken();
        if (token) {
            const account = accountForClient(auth.getAccountInfo());
            return reply(200, { status: 'connected', account });
        }
        const reason = auth.getLastAuthError();
        return reply(200, { status: 'disconnected', ...(reason ? { reason } : {}) });
    }

    function fabricCancelLogin() {
        auth.cancelLogin();
        return reply(200, { status: 'cancelled' });
    }

    function fabricDisconnect() {
        auth.logout();
        return reply(200, { status: 'disconnected' });
    }

    // Trigger refresh of affected tables after Fabric deployment
    async function fabricRefresh(state, { tables, refreshType, tableDetails } = {}) {
        // tables: string[] of table names (empty = full model)
        // refreshType: 'automatic'|'dataOnly'|'calculate' (recommended type)
        // tableDetails: [{ table, refreshType, reasons }] (for display/logging)
        const { lastProdFabricInfo } = state;

        if (!lastProdFabricInfo) {
            return reply(400, { error: 'No Fabric target available. Deploy to Fabric first.' });
        }

        try {
            const token = await auth.getAccessToken();
            if (!token) {
                return reply(401, { error: 'Not authenticated. Login to Fabric first.' });
            }

            const { workspaceId, semanticModelId, modelName } = lastProdFabricInfo;
            const apiRefreshType = refreshType || 'automatic';
            const result = await fabricApi.refreshSemanticModel(token, workspaceId, semanticModelId, tables || [], apiRefreshType);

            // Determine if a post-refresh calculate is needed:
            // dataOnly does NOT recalculate relationships — a follow-up calculate is required
            const needsPostCalculate = apiRefreshType === 'dataOnly' ||
                (apiRefreshType === 'automatic' && (tables || []).length > 0);

            // Store in refresh session with detailed table info
            if (result.requestId) {
                refreshStore.createRefreshRecord(result.requestId, modelName, workspaceId, semanticModelId, tables || [], tableDetails || [], apiRefreshType, { needsPostCalculate });
            }

            logEvent('refresh', {
                target: `workspace:${workspaceId}/model:${semanticModelId}`,
                tables: tables || [],
                refreshType: apiRefreshType,
                tableDetails: tableDetails || [],
                tableCount: (tables || []).length,
                requestId: result.requestId,
                success: true
            });
            return reply(200, { success: true, requestId: result.requestId });
        } catch (err) {
            console.error('Refresh error:', err);
            logEvent('refresh', { tables: tables || [], refreshType: refreshType || 'automatic', success: false, error: err.message });
            return reply(500, { error: err.message });
        }
    }

    // Check refresh status (with per-object detail)
    async function fabricRefreshStatus(state, { requestId } = {}) {
        const { lastProdFabricInfo } = state;

        if (!lastProdFabricInfo) {
            return reply(400, { error: 'No Fabric target available.' });
        }

        try {
            const token = await auth.getAccessToken();
            if (!token) {
                return reply(401, { error: 'Not authenticated.' });
            }

            const { workspaceId, semanticModelId } = lastProdFabricInfo;
            const apiStatus = await fabricApi.getRefreshStatus(token, workspaceId, semanticModelId, requestId);

            // Update the session record with full status (including objects array)
            const record = refreshStore.updateRefreshRecord(requestId, apiStatus);

            const refreshLogPayload = {
                requestId,
                target: `workspace:${workspaceId}/model:${semanticModelId}`,
                status: apiStatus.status || null,
                startTime: apiStatus.startTime || null,
                endTime: apiStatus.endTime || null
            };
            // On failure, include error details so the activity log is diagnostic
            if (apiStatus.status === 'Failed') {
                if (apiStatus.serviceExceptionJson) {
                    refreshLogPayload.serviceExceptionJson = apiStatus.serviceExceptionJson;
                }
                const objErrors = (apiStatus.objects || [])
                    .filter(o => o.serviceExceptionJson)
                    .map(o => ({ table: o.table, partition: o.partition || o.table, error: o.serviceExceptionJson }));
                if (objErrors.length > 0) {
                    refreshLogPayload.objectErrors = objErrors;
                }
            }
            logEvent('refresh-status', refreshLogPayload);

            // Auto-trigger post-calculate when dataOnly refresh completes successfully
            let postCalculateInfo = null;
            if (record && record.needsPostCalculate && !record.postCalculateTriggered && record.status === 'completed') {
                // Claim the trigger BEFORE awaiting. The frontend polls this endpoint
                // from a one-shot timer and a 5s interval, so two polls could both pass
                // the check during the POST round-trip and fire the calculate twice.
                record.postCalculateTriggered = true;
                try {
                    const calcResult = await fabricApi.refreshSemanticModel(token, workspaceId, semanticModelId, [], 'calculate');
                    record.postCalculateRequestId = calcResult.requestId || null;

                    if (calcResult.requestId) {
                        refreshStore.createRefreshRecord(
                            calcResult.requestId,
                            record.modelName,
                            workspaceId,
                            semanticModelId,
                            [],
                            [{ table: '_model_', refreshType: 'calculate', reasons: ['post-refresh relationship recalculation'] }],
                            'calculate',
                            { needsPostCalculate: false }
                        );
                    }

                    logEvent('refresh', {
                        target: `workspace:${workspaceId}/model:${semanticModelId}`,
                        tables: [],
                        refreshType: 'calculate',
                        tableDetails: [{ table: '_model_', refreshType: 'calculate', reasons: ['post-refresh relationship recalculation'] }],
                        tableCount: 0,
                        requestId: calcResult.requestId,
                        success: true,
                        trigger: 'auto-post-calculate'
                    });

                    postCalculateInfo = { requestId: calcResult.requestId, status: 'inProgress' };
                } catch (calcErr) {
                    // Release the claim so a later poll can retry.
                    record.postCalculateTriggered = false;
                    console.error('Auto post-calculate failed:', calcErr.message);
                    logEvent('refresh', {
                        target: `workspace:${workspaceId}/model:${semanticModelId}`,
                        refreshType: 'calculate',
                        success: false,
                        error: calcErr.message,
                        trigger: 'auto-post-calculate'
                    });
                }
            }

            // Return merged response: API data + our tracked objects + post-calculate info
            return reply(200, {
                ...apiStatus,
                trackedObjects: record ? record.objects : [],
                topLevelError: record ? (record.serviceExceptionJson || null) : (apiStatus.serviceExceptionJson || null),
                requestedTables: record ? record.requestedTables : [],
                postCalculate: postCalculateInfo
            });
        } catch (err) {
            console.error('Refresh status error:', err);
            logEvent('refresh-status', { requestId, success: false, error: err.message });
            return reply(500, { error: err.message });
        }
    }

    function fabricRefreshHistory() {
        return reply(200, refreshStore.getSessionHistory());
    }

    function fabricRefreshActive() {
        const active = refreshStore.getActiveRefresh();
        return reply(200, { active: active || null });
    }

    // On-demand target model readiness check (independent of a deployment)
    async function fabricReadiness(state) {
        const { lastProdFabricInfo } = state;

        if (!lastProdFabricInfo) {
            return reply(400, { error: 'No Fabric target available. Compare against a Fabric target first.' });
        }

        try {
            const token = await auth.getAccessToken();
            if (!token) {
                return reply(401, { error: 'Not authenticated. Login to Fabric first.' });
            }

            const readiness = await inspectTargetReadiness(token, lastProdFabricInfo);
            return reply(200, readiness);
        } catch (err) {
            console.error('Readiness check error:', err);
            return reply(500, { error: err.message });
        }
    }

    // Resolve connection string — parse workspace/model names and verify access
    async function fabricResolve(state, { connectionString } = {}) {
        if (!connectionString) {
            return reply(400, { error: 'Connection string is required.' });
        }

        try {
            const parsed = parseConnectionString(connectionString);

            // Always resolve a fresh, valid token (never fall back to a stale one).
            const token = await auth.getAccessToken();
            if (!token) {
                return reply(401, { error: 'Not authenticated. Login to Fabric first.' });
            }
            state.fabricAccessToken = token;

            // Find workspace by name
            const workspaces = await fabricApi.listWorkspaces(token);
            const workspace = workspaces.find(ws =>
                ws.name.toLowerCase() === parsed.workspaceName.toLowerCase()
            );

            if (!workspace) {
                return reply(403, {
                    error: `Workspace "${parsed.workspaceName}" not found or access denied.`
                });
            }

            // Find model by name
            const models = await fabricApi.listSemanticModels(token, workspace.id);
            const model = models.find(m =>
                m.name.toLowerCase() === parsed.modelName.toLowerCase()
            );

            if (!model) {
                return reply(403, {
                    error: `Model "${parsed.modelName}" not found in workspace "${workspace.name}" or access denied.`
                });
            }

            return reply(200, {
                workspaceId: workspace.id,
                workspaceName: workspace.name,
                semanticModelId: model.id,
                modelName: model.name
            });
        } catch (err) {
            return reply(500, { error: err.message });
        }
    }

    /**
     * Load one side of a comparison from its descriptor:
     *   { type: 'local', path }
     *   { type: 'fabric', connectionString, workspaceId, semanticModelId }
     *   { type: 'git', repoPath, ref, modelPath }
     * Resolves to { model, label, meta }; `meta` is what the client gets back in
     * `sources` and holds nothing the client could not see already.
     */
    async function loadSide(desc, side, getToken) {
        if (!desc || typeof desc !== 'object') throw statusError(400, `Invalid ${side} type.`);

        if (desc.type === 'local') {
            return { model: loadModelFromFolder(desc.path), label: desc.path, meta: { type: 'local', path: desc.path } };
        }

        if (desc.type === 'fabric') {
            const token = await getToken();
            const parsed = parseConnectionString(desc.connectionString);
            const model = await loadModelFromFabric(token, desc.workspaceId, desc.semanticModelId, parsed.modelName);
            return {
                model,
                label: `Fabric: ${parsed.workspaceName}/${parsed.modelName}`,
                meta: { type: 'fabric', workspaceName: parsed.workspaceName, modelName: parsed.modelName }
            };
        }

        if (desc.type === 'git') {
            // Everything is re-derived on the server: the repository from the path,
            // the commit from the branch name, the model from that commit's tree.
            const repo = await gitClient.inspectRepository(desc.repoPath);
            const ref = gitClient.validateRef(desc.ref);
            const sha = await gitClient.resolveCommit(repo.root, ref);
            const modelPath = gitModelLoader.validateModelPath(desc.modelPath, await gitModelLoader.discoverModels(repo.root, sha));
            const model = await gitModelLoader.loadModelFromGitRef({ root: repo.root, sha, modelPath, ref });
            const shortSha = sha.slice(0, 7);
            return {
                model,
                label: `Git: ${repo.name}@${ref} (${shortSha})/${modelPath}`,
                meta: { type: 'git', repoRoot: repo.root, repoName: repo.name, ref, resolvedSha: sha, shortSha, modelPath }
            };
        }

        throw statusError(400, `Invalid ${side} type.`);
    }

    // Compare any two sources: local, Fabric or a Git branch on either side.
    // The route keeps its historical name, /api/compare-fabric.
    async function compareFabric(state, { devSource, prodSource } = {}) {
        if (!devSource || !prodSource) {
            return reply(400, { error: 'Both devSource and prodSource are required.' });
        }

        // A Fabric token only when a side is in Fabric: Git and local need no sign-in.
        let token = null;
        const getToken = async () => {
            if (!token) token = await auth.getAccessToken();
            if (!token) throw statusError(401, 'Not authenticated to Fabric.');
            return token;
        };

        try {
            const dev = await loadSide(devSource, 'devSource', getToken);
            const prod = await loadSide(prodSource, 'prodSource', getToken);

            const result = compareModels(dev.model, prod.model, dev.label, prod.label);
            result.sources = { source: dev.meta, target: prod.meta };

            // Store for potential deployment
            state = sessionStore.resetComparison(state);
            state.lastComparison = result;
            state.lastDevModel = dev.model;
            state.lastProdModel = prod.model;
            if (prodSource.type === 'local') {
                state.lastProdPath = resolveDefinitionPath(prodSource.path);
            } else if (prodSource.type === 'fabric') {
                state.lastProdFabricInfo = {
                    workspaceId: prodSource.workspaceId,
                    semanticModelId: prodSource.semanticModelId,
                    modelName: prod.model.name || 'SemanticModel'
                };
            } else {
                const { repoRoot, ref, resolvedSha, modelPath } = prod.meta;
                state.lastProdGitInfo = { repoRoot, ref, sha: resolvedSha, modelPath };
            }

            logEvent('compare', {
                mode: `${devSource.type}-${prodSource.type}`,
                devSource: dev.label,
                prodSource: prod.label,
                diffCount: result.diffs ? result.diffs.length : 0,
                groupCount: result.groups ? result.groups.length : 0,
                success: true
            });
            return reply(200, result);
        } catch (err) {
            if (!err.status) console.error('Comparison error:', err);
            logEvent('compare', { mode: `${devSource && devSource.type}-${prodSource && prodSource.type}`, success: false, error: gitClient.redact(err.message) });
            return err.status ? failure(err) : reply(500, { error: err.message });
        }
    }

    // ===== Git =====
    // Every operation takes the user's path again and re-checks it: the server
    // keeps no repository handle the client could forge.

    async function gitOpen(state, { path: repoPath } = {}) {
        try {
            const repo = await gitClient.inspectRepository(repoPath);
            const remotes = await gitClient.listRemotes(repo.root);
            return reply(200, Object.assign({}, repo, { remotes }));
        } catch (err) {
            return failure(err);
        }
    }

    async function gitBranches(state, { repoPath } = {}) {
        try {
            const repo = await gitClient.inspectRepository(repoPath);
            const { branches, lastFetchAt } = await gitClient.listBranches(repo.root);
            return reply(200, { repoRoot: repo.root, currentBranch: repo.currentBranch, branches, lastFetchAt });
        } catch (err) {
            return failure(err);
        }
    }

    // The models in one branch. On the checked-out branch each model also says
    // how many uncommitted files it has, which the Git tab does not include.
    async function gitModels(state, { repoPath, ref } = {}) {
        try {
            const repo = await gitClient.inspectRepository(repoPath);
            const name = gitClient.validateRef(ref);
            const sha = await gitClient.resolveCommit(repo.root, name);
            const models = await gitModelLoader.discoverModels(repo.root, sha);
            const checkedOut = !!repo.currentBranch && (name === repo.currentBranch || name === `refs/heads/${repo.currentBranch}`);
            if (checkedOut) {
                for (const m of models) m.uncommitted = await gitClient.countUncommitted(repo.root, m.modelPath);
            }
            return reply(200, { repoRoot: repo.root, ref: name, sha, shortSha: sha.slice(0, 7), checkedOut, models, modelPathHint: repo.modelPathHint });
        } catch (err) {
            return failure(err);
        }
    }

    // Fetch runs only when the user asks; nothing else here touches the network.
    async function gitFetch(state, { repoPath } = {}) {
        try {
            const repo = await gitClient.inspectRepository(repoPath);
            const fetched = await gitClient.fetchAll(repo.root);
            const { branches, lastFetchAt } = await gitClient.listBranches(repo.root);
            logEvent('git-fetch', { repository: repo.root, remotes: fetched.remotes, success: true });
            return reply(200, { repoRoot: repo.root, fetched: fetched.fetched, remotes: fetched.remotes, branches, lastFetchAt });
        } catch (err) {
            logEvent('git-fetch', { repository: typeof repoPath === 'string' ? repoPath : null, success: false, error: gitClient.redact(err.message) });
            return failure(err);
        }
    }

    // Read recent activity log entries.
    function activityLog(state, { limit } = {}) {
        const max = Math.min(parseInt(limit, 10) || 200, 2000);
        try {
            const entries = readEvents(max);
            return reply(200, { entries });
        } catch (err) {
            return reply(500, { error: err.message });
        }
    }

    return {
        version,
        defaults,
        compare,
        compareFabric,
        deploy,
        previewDeploy,
        resolveModel,
        fabricLogin,
        fabricStatus,
        fabricCancelLogin,
        fabricDisconnect,
        fabricResolve,
        fabricRefresh,
        fabricRefreshStatus,
        fabricRefreshHistory,
        fabricRefreshActive,
        fabricReadiness,
        gitOpen,
        gitBranches,
        gitModels,
        gitFetch,
        activityLog
    };
}

module.exports = { createService, accountForClient, APP_VERSION };
