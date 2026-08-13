/**
 * Manual verification script for the target model readiness feature
 * (requirements/TARGET_MODEL_READINESS_MVP_PLAN.md).
 *
 * Not part of the automated test suite — this exercises the REAL Fabric REST
 * `executeDaxQueries` endpoint against a real workspace/model, which the unit
 * tests only cover via injected fakes. Run this once against a real Fabric
 * environment to confirm the Arrow (and LZ4_FRAME-compressed batch) decoding
 * actually works end-to-end, before relying on it in production deploys.
 *
 * Usage:
 *   node verify-fabric-readiness.js <workspaceId> <semanticModelId>
 *
 * A browser window opens for interactive sign-in (same MSAL flow the app uses).
 * No token or credential is written to disk or logged.
 */
const auth = require('./fabric/auth');
const readinessClient = require('./fabric/readiness-client');
const modelReadiness = require('./lib/model-readiness');

async function main() {
    const [workspaceId, semanticModelId] = process.argv.slice(2);
    if (!workspaceId || !semanticModelId) {
        console.error('Usage: node verify-fabric-readiness.js <workspaceId> <semanticModelId>');
        process.exit(1);
    }

    console.log('Opening browser for sign-in...');
    const token = await auth.loginInteractive();
    console.log(`Signed in as ${auth.getAccountInfo()?.username || '(unknown account)'}`);

    console.log('Querying INFO.PARTITIONS() via executeDaxQueries...');
    const records = await readinessClient.getPartitionReadiness(token, workspaceId, semanticModelId);
    console.log(`Decoded ${records.length} partition record(s).`);
    console.table(records);

    const snapshot = modelReadiness.buildReadinessSnapshot(records);
    console.log('\nSummary:', snapshot.summary);
    if (snapshot.objectsRequiringAttention.length > 0) {
        console.log('\nObjects requiring attention:');
        console.table(snapshot.objectsRequiringAttention);
    } else {
        console.log('\nAll objects are Ready.');
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\nVERIFICATION FAILED');
        console.error(`reasonCode: ${err.reasonCode || '(none)'}`);
        console.error(err.stack || err.message);
        process.exit(1);
    });
