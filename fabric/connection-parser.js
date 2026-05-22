/**
 * Parse Power BI / Fabric XMLA connection string.
 * Format: "Data Source=powerbi://api.powerbi.com/v1.0/myorg/WorkspaceName;Initial Catalog=ModelName;"
 */

function parseConnectionString(connStr) {
    if (!connStr || typeof connStr !== 'string') {
        throw new Error('Connection string is required.');
    }

    const result = { workspaceName: null, modelName: null, server: null };

    // Parse key=value pairs separated by semicolons
    const parts = connStr.split(';').map(p => p.trim()).filter(Boolean);

    for (const part of parts) {
        const eqIndex = part.indexOf('=');
        if (eqIndex === -1) continue;

        const key = part.substring(0, eqIndex).trim().toLowerCase();
        const value = part.substring(eqIndex + 1).trim();

        if (key === 'data source') {
            result.server = value;
            // Extract workspace name from powerbi://api.powerbi.com/v1.0/myorg/{WorkspaceName}
            const match = value.match(/powerbi:\/\/[^/]+\/v[\d.]+\/myorg\/(.+)/i);
            if (match) {
                result.workspaceName = decodeURIComponent(match[1]);
            }
        } else if (key === 'initial catalog') {
            result.modelName = value;
        }
    }

    if (!result.workspaceName) {
        throw new Error('Cannot parse workspace name from connection string. Expected format: Data Source=powerbi://api.powerbi.com/v1.0/myorg/WorkspaceName;Initial Catalog=ModelName;');
    }

    if (!result.modelName) {
        throw new Error('Cannot parse model name (Initial Catalog) from connection string.');
    }

    return result;
}

module.exports = { parseConnectionString };
