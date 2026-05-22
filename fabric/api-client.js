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
async function pollOperation(locationUrl, accessToken, maxWaitMs = 120000) {
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

    throw new Error('Operation timed out waiting for Fabric API response.');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * List all workspaces the user has access to.
 */
async function listWorkspaces(accessToken) {
    const url = `${FABRIC_API_BASE}/workspaces`;
    const result = await apiRequest(url, accessToken);
    return (result.value || []).map(ws => ({
        id: ws.id,
        name: ws.displayName,
        type: ws.type,
        capacityId: ws.capacityId
    }));
}

/**
 * List semantic models in a workspace.
 */
async function listSemanticModels(accessToken, workspaceId) {
    const url = `${FABRIC_API_BASE}/workspaces/${workspaceId}/semanticModels`;
    const result = await apiRequest(url, accessToken);
    return (result.value || []).map(sm => ({
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

    // Handle long-running operation
    if (result.status === 202 && result.location) {
        const finalResult = await pollOperation(result.location, accessToken);
        if (finalResult.status === 'Failed') {
            const errMsg = finalResult.error?.message || 'Update definition failed';
            throw new Error(errMsg);
        }
        return finalResult;
    }

    return result;
}

module.exports = {
    listWorkspaces,
    listSemanticModels,
    getSemanticModelDefinition,
    updateSemanticModelDefinition
};
