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

const pkg = require('../package.json');
const APP_VERSION = pkg.version;

const reply = (status, body) => ({ status, body });

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

    // Compare with Fabric model (local vs Fabric, Fabric vs local, Fabric vs Fabric)
    // Each source independently specifies its type and connection string.
    async function compareFabric(state, { devSource, prodSource } = {}) {
        // devSource/prodSource: { type: 'local', path } or { type: 'fabric', connectionString }

        if (!devSource || !prodSource) {
            return reply(400, { error: 'Both devSource and prodSource are required.' });
        }

        try {
            const token = await auth.getAccessToken();
            if (!token) {
                return reply(401, { error: 'Not authenticated to Fabric.' });
            }
            let devModel, prodModel;
            let devLabel, prodLabel;

            // Load DEV model
            if (devSource.type === 'local') {
                devModel = loadModelFromFolder(devSource.path);
                devLabel = devSource.path;
            } else if (devSource.type === 'fabric') {
                const parsed = parseConnectionString(devSource.connectionString);
                const wsId = devSource.workspaceId;
                const modelId = devSource.semanticModelId;
                devModel = await loadModelFromFabric(token, wsId, modelId, parsed.modelName);
                devLabel = `Fabric: ${parsed.workspaceName}/${parsed.modelName}`;
            } else {
                return reply(400, { error: 'Invalid devSource type.' });
            }

            // Load PROD model
            if (prodSource.type === 'local') {
                prodModel = loadModelFromFolder(prodSource.path);
                prodLabel = prodSource.path;
            } else if (prodSource.type === 'fabric') {
                const parsed = parseConnectionString(prodSource.connectionString);
                const wsId = prodSource.workspaceId;
                const modelId = prodSource.semanticModelId;
                prodModel = await loadModelFromFabric(token, wsId, modelId, parsed.modelName);
                prodLabel = `Fabric: ${parsed.workspaceName}/${parsed.modelName}`;
            } else {
                return reply(400, { error: 'Invalid prodSource type.' });
            }

            // Run comparison
            const result = compareModels(devModel, prodModel, devLabel, prodLabel);

            // Store for potential deployment
            state = sessionStore.resetComparison(state);
            state.lastComparison = result;
            state.lastDevModel = devModel;
            state.lastProdModel = prodModel;
            if (prodSource.type === 'local') {
                state.lastProdPath = resolveDefinitionPath(prodSource.path);
            } else {
                state.lastProdFabricInfo = {
                    workspaceId: prodSource.workspaceId,
                    semanticModelId: prodSource.semanticModelId,
                    modelName: prodModel.name || 'SemanticModel'
                };
            }

            logEvent('compare', {
                mode: `${devSource.type}-${prodSource.type}`,
                devSource: devLabel,
                prodSource: prodLabel,
                diffCount: result.diffs ? result.diffs.length : 0,
                groupCount: result.groups ? result.groups.length : 0,
                success: true
            });
            return reply(200, result);
        } catch (err) {
            console.error('Comparison error:', err);
            logEvent('compare', { mode: `${devSource && devSource.type}-${prodSource && prodSource.type}`, success: false, error: err.message });
            return reply(500, { error: err.message });
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
        activityLog
    };
}

module.exports = { createService, accountForClient, APP_VERSION };
