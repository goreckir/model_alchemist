/**
 * Fabric REST API Client — Communicates with Microsoft Fabric APIs.
 * Handles workspace listing, semantic model discovery, and definition retrieval.
 */

const https = require('https');
const { URL } = require('url');

const FABRIC_API_BASE = 'https://api.fabric.microsoft.com/v1';
const POWERBI_API_BASE = 'https://api.powerbi.com/v1.0/myorg';

/**
 * Make an authenticated HTTP request to Fabric/Power BI API.
 */
function apiRequest(url, accessToken, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 202) {
                    // Long-running operation — check for Location/Retry-After
                    resolve({
                        status: 202,
                        location: res.headers['location'],
                        retryAfter: parseInt(res.headers['retry-after'] || '2', 10)
                    });
                } else if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(data ? JSON.parse(data) : {});
                    } catch {
                        resolve(data);
                    }
                } else {
                    let errMsg = `API error ${res.statusCode}`;
                    try {
                        const errBody = JSON.parse(data);
                        errMsg = errBody.error?.message || errBody.message || errMsg;
                    } catch { /* ignore parse error */ }
                    reject(new Error(errMsg));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

/**
 * Poll a long-running operation until complete.
 * Fabric API pattern: poll status URL, then fetch /result when Succeeded.
 */
/** An operation the client stopped waiting for. It may still be running in Fabric. */
function operationTimeoutError(maxWaitMs) {
    const err = new Error(
        `Fabric did not finish the operation within ${Math.round(maxWaitMs / 1000)}s, so the client stopped waiting. ` +
        `THE OPERATION MAY STILL BE RUNNING and may complete successfully — do not assume nothing changed. ` +
        `Check the model in the Fabric portal before retrying.`
    );
    err.code = 'OPERATION_TIMEOUT';
    err.indeterminate = true;
    return err;
}

async function pollOperation(locationUrl, accessToken, maxWaitMs = 600000) {
    const start = Date.now();
    let url = locationUrl;

    while (Date.now() - start < maxWaitMs) {
        await sleep(2000);
        const result = await apiRequest(url, accessToken);

        // HTTP 202 — still processing at network level
        if (result.status === 202) {
            url = result.location || url;
            continue;
        }

        // Fabric operation status in response body
        if (result.status === 'Running' || result.status === 'NotStarted') {
            continue;
        }

        if (result.status === 'Failed') {
            const errMsg = result.error?.message || 'Operation failed';
            throw new Error(`Fabric operation failed: ${errMsg}`);
        }

        // Status is "Succeeded" or response already contains the definition
        if (result.definition && result.definition.parts) {
            return result;
        }

        // If Succeeded but no definition inline, fetch from /result endpoint
        if (result.status === 'Succeeded' || result.status === undefined) {
            const resultUrl = url.replace(/\/$/, '') + '/result';
            try {
                const finalResult = await apiRequest(resultUrl, accessToken);
                if (finalResult.definition && finalResult.definition.parts) {
                    return finalResult;
                }
                return finalResult;
            } catch {
                // If /result fails, return what we have
                return result;
            }
        }

        return result;
    }

    throw operationTimeoutError(maxWaitMs);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read every page of a paginated Fabric list endpoint.
 *
 * Reading only the first page made workspaces and models on later pages look
 * inaccessible: a user got "Workspace not found or access denied" for a workspace
 * they can open in the browser.
 *
 * @param {function} [request=apiRequest] - injected for testing
 */
async function listAllPages(url, accessToken, request = apiRequest) {
    const items = [];
    let nextUrl = url;
    let guard = 0;

    while (nextUrl && guard++ < 1000) {
        const result = await request(nextUrl, accessToken);
        items.push(...(result.value || []));

        if (result.continuationUri) {
            nextUrl = result.continuationUri;
        } else if (result.continuationToken) {
            const parsed = new URL(url);
            parsed.searchParams.set('continuationToken', result.continuationToken);
            nextUrl = parsed.toString();
        } else {
            nextUrl = null;
        }
    }

    return items;
}

/**
 * List all workspaces the user has access to.
 */
async function listWorkspaces(accessToken, request) {
    const url = `${FABRIC_API_BASE}/workspaces`;
    const values = await listAllPages(url, accessToken, request);
    return values.map(ws => ({
        id: ws.id,
        name: ws.displayName,
        type: ws.type,
        capacityId: ws.capacityId
    }));
}

/**
 * List semantic models in a workspace.
 */
async function listSemanticModels(accessToken, workspaceId, request) {
    const url = `${FABRIC_API_BASE}/workspaces/${workspaceId}/semanticModels`;
    const values = await listAllPages(url, accessToken, request);
    return values.map(sm => ({
        id: sm.id,
        name: sm.displayName,
        description: sm.description || '',
        workspaceId
    }));
}

/**
 * Get semantic model definition (TMDL format) from Fabric.
 * Returns an array of { path, content } objects representing the TMDL files.
 */
async function getSemanticModelDefinition(accessToken, workspaceId, semanticModelId) {
    const url = `${FABRIC_API_BASE}/workspaces/${workspaceId}/semanticModels/${semanticModelId}/getDefinition?format=TMDL`;
    const result = await apiRequest(url, accessToken, 'POST');

    // Handle long-running operation (202 response)
    let definition;
    if (result.status === 202 && result.location) {
        definition = await pollOperation(result.location, accessToken);
    } else {
        definition = result;
    }

    if (!definition || !definition.definition || !definition.definition.parts) {
        const preview = JSON.stringify(definition, null, 2)?.slice(0, 500);
        throw new Error(`Invalid response from Fabric API: no definition parts returned. Response: ${preview}`);
    }

    // Decode base64 parts into { path, content } array
    const files = [];
    for (const part of definition.definition.parts) {
        if (part.payloadType === 'InlineBase64' && part.payload) {
            const content = Buffer.from(part.payload, 'base64').toString('utf-8');
            files.push({ path: part.path, content });
        }
    }

    return files;
}

/**
 * Update semantic model definition in Fabric (deploy TMDL changes).
 * @param {string} accessToken - Valid access token
 * @param {string} workspaceId - Target workspace ID
 * @param {string} semanticModelId - Target semantic model ID
 * @param {object} rawFiles - Dictionary of { relativePath: content } (e.g. { "tables/Sales.tmdl": "..." })
 */
async function updateSemanticModelDefinition(accessToken, workspaceId, semanticModelId, rawFiles) {
    const url = `${FABRIC_API_BASE}/workspaces/${workspaceId}/semanticModels/${semanticModelId}/updateDefinition`;

    // Build parts array with base64-encoded content
    const parts = [];
    for (const [filePath, content] of Object.entries(rawFiles)) {
        // Only add 'definition/' prefix to TMDL structure files (in subfolders or .tmdl at root)
        // Root-level non-TMDL files (like definition.pbism, diagramLayout.json) stay as-is
        const shouldPrefix = filePath.includes('/') || filePath.endsWith('.tmdl');
        const apiPath = shouldPrefix ? `definition/${filePath}` : filePath;
        parts.push({
            path: apiPath,
            payload: Buffer.from(content, 'utf-8').toString('base64'),
            payloadType: 'InlineBase64'
        });
    }

    const body = { definition: { parts } };
    const result = await apiRequest(url, accessToken, 'POST', body);

    // Handle long-running operation. A large model can take well over two minutes;
    // giving up early reported a successful deploy as failed while PROD had in fact
    // been updated, so the wait is long and a timeout is explicitly indeterminate.
    if (result.status === 202 && result.location) {
        const finalResult = await pollOperation(result.location, accessToken, UPDATE_DEFINITION_MAX_WAIT_MS);
        if (finalResult.status === 'Failed') {
            const errMsg = finalResult.error?.message || 'Update definition failed';
            throw new Error(errMsg);
        }
        return finalResult;
    }

    return result;
}

/** Definition uploads are the slowest Fabric LRO — wait 10 minutes before giving up. */
const UPDATE_DEFINITION_MAX_WAIT_MS = 600000;

/**
 * Trigger a refresh of the semantic model via Power BI Enhanced Refresh API.
 * @param {string} accessToken - Valid access token
 * @param {string} workspaceId - Workspace (group) ID
 * @param {string} semanticModelId - Dataset ID
 * @param {string[]} tables - Array of table names to refresh (empty = full model)
 * @param {string} [refreshType='automatic'] - Refresh type: automatic|dataOnly|calculate|full
 * @returns {{ requestId: string }} - The refresh request ID for status polling
 */
async function refreshSemanticModel(accessToken, workspaceId, semanticModelId, tables = [], refreshType = 'automatic') {
    const url = `${POWERBI_API_BASE}/groups/${workspaceId}/datasets/${semanticModelId}/refreshes`;

    const body = {
        type: refreshType,
        commitMode: 'transactional',
        maxParallelism: 10,
        retryCount: 1
    };

    if (tables.length > 0) {
        body.objects = tables.map(t => ({ table: t }));
    }

    const result = await apiRequest(url, accessToken, 'POST', body);

    // 202 Accepted — extract requestId from Location header
    if (result.status === 202 && result.location) {
        const match = result.location.match(/refreshes\/(.+)$/);
        return { requestId: match ? match[1] : null, location: result.location };
    }

    return { requestId: null };
}

/**
 * Get refresh operation status.
 * @param {string} accessToken
 * @param {string} workspaceId
 * @param {string} semanticModelId
 * @param {string} requestId
 * @returns {{ status: string, startTime: string, endTime?: string }}
 */
async function getRefreshStatus(accessToken, workspaceId, semanticModelId, requestId) {
    const url = `${POWERBI_API_BASE}/groups/${workspaceId}/datasets/${semanticModelId}/refreshes/${requestId}`;
    return await apiRequest(url, accessToken);
}

module.exports = {
    listWorkspaces,
    listSemanticModels,
    listAllPages,
    getSemanticModelDefinition,
    updateSemanticModelDefinition,
    refreshSemanticModel,
    getRefreshStatus,
    pollOperation,
    operationTimeoutError
};
