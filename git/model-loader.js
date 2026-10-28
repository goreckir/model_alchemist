/**
 * Semantic models stored in a Git commit.
 *
 * Models are read from the committed tree, never from the working tree, and
 * never written to disk: the definition files go from `git cat-file` straight
 * into parser/build-model.js, the same builder the folder loader uses. A model
 * read from a branch therefore parses exactly like the same files on disk.
 */
const git = require('./git-client');
const { buildModelFromFiles, isDefinitionFile } = require('../parser/build-model');

const { GitError } = git;

/** `<anything>.SemanticModel/definition/model.tmdl` (or database.tmdl) marks a model. */
const MODEL_MARKER = /^((?:[^/]+\/)*[^/]+\.SemanticModel)\/definition\/(?:model|database)\.tmdl$/i;

/**
 * The semantic models in a commit, as repository-relative POSIX paths.
 * Returns [{ modelPath, name }], sorted by path.
 */
async function discoverModels(root, sha) {
    const found = new Set();
    for (const p of await git.listTreePaths(root, sha)) {
        const m = MODEL_MARKER.exec(p);
        if (m) found.add(m[1]);
    }
    return [...found].sort().map(modelPath => ({ modelPath, name: modelName(modelPath) }));
}

function modelName(modelPath) {
    return modelPath.split('/').pop().replace(/\.SemanticModel$/i, '');
}

/**
 * Check a model path from the client: repository-relative, no traversal, and
 * one of the models discovered in the commit. Returns the normalised path.
 */
function validateModelPath(modelPath, discovered) {
    if (typeof modelPath !== 'string' || !modelPath.trim() || modelPath.includes('\0')) {
        throw new GitError('INVALID_INPUT', 'Model path is missing or invalid.');
    }
    const normalised = modelPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = normalised.split('/');
    if (normalised.startsWith('/') || /^[a-z]:/i.test(normalised) || segments.some(s => s === '..' || s === '.' || s === '')) {
        throw new GitError('INVALID_INPUT', `Model path "${modelPath}" must be relative to the repository root.`);
    }
    if (!/\.SemanticModel$/i.test(normalised)) {
        throw new GitError('INVALID_INPUT', `Model path "${modelPath}" must point at a .SemanticModel folder.`);
    }
    const match = discovered.find(m => m.modelPath === normalised);
    if (!match) {
        throw new GitError('MODEL_NOT_FOUND', `No semantic model at "${normalised}" in this revision.`);
    }
    return match.modelPath;
}

/**
 * Load one model from one commit.
 * @param {object} p
 * @param {string} p.root       repository root from inspectRepository()
 * @param {string} p.sha        full commit SHA from resolveCommit()
 * @param {string} p.modelPath  validated repository-relative .SemanticModel path
 * @param {string} [p.ref]      the branch the user picked, for labels
 */
async function loadModelFromGitRef({ root, sha, modelPath, ref }) {
    const prefix = `${modelPath}/definition/`;
    const relPaths = (await git.listTreePaths(root, sha, `${modelPath}/definition`))
        .filter(p => p.startsWith(prefix))
        .map(p => p.slice(prefix.length))
        .filter(isDefinitionFile);

    const blobs = await git.readBlobs(root, sha, relPaths.map(p => prefix + p));
    const files = {};
    for (const rel of relPaths) {
        if (Object.prototype.hasOwnProperty.call(blobs, prefix + rel)) files[rel] = blobs[prefix + rel];
    }

    return buildModelFromFiles(files, {
        name: modelName(modelPath),
        sourcePath: `git:${ref || sha.slice(0, 7)}@${sha.slice(0, 7)}/${modelPath}`,
        sourceType: 'git',
        git: { root, ref: ref || null, sha, modelPath }
    });
}

module.exports = { discoverModels, validateModelPath, loadModelFromGitRef, modelName, MODEL_MARKER };
