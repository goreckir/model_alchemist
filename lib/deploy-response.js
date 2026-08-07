'use strict';

/**
 * Merge a local deployChanges() result into the accumulated Fabric-deploy
 * response, WITHOUT losing actions already recorded (e.g. the pre-upload
 * `backup` entry) and WITHOUT dropping warnings (e.g. UNREVIEWED_BLOCK_CHANGES).
 *
 * Fixes finding 4.5: `result.actions = deployResult.actions` used to overwrite
 * (not append to) `result.actions`, silently discarding the backup action, and
 * `deployResult.warnings` was never copied onto the response at all.
 *
 * @param {{ actions: any[], warnings?: any[] }} result mutated in place
 * @param {{ actions?: any[], warnings?: any[] }} deployResult
 */
function mergeDeployResultIntoResponse(result, deployResult) {
    result.actions.push(...(deployResult.actions || []));
    if (deployResult.warnings && deployResult.warnings.length > 0) {
        result.warnings = [...(result.warnings || []), ...deployResult.warnings];
    }
}

module.exports = { mergeDeployResultIntoResponse };
