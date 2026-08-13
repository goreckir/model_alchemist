'use strict';

/**
 * Pure mapping/aggregation for Fabric target model readiness (MVP).
 * No network access here — this module only classifies and aggregates
 * already-normalized partition records produced by fabric/readiness-client.js.
 *
 * State codes are Microsoft.AnalysisServices.Tabular ObjectState values.
 * See requirements/TARGET_MODEL_READINESS_MVP_PLAN.md, "Scope > Included" table.
 */

const OBJECT_STATE_INFO = {
    1: { state: 'Ready', category: 'ready', action: 'none' },
    3: { state: 'NoData', category: 'requiresRefresh', action: 'refresh' },
    4: { state: 'CalculationNeeded', category: 'requiresRecalculation', action: 'recalculate' },
    5: { state: 'SemanticError', category: 'error', action: 'inspect' },
    6: { state: 'EvaluationError', category: 'error', action: 'inspect' },
    7: { state: 'DependencyError', category: 'error', action: 'repair' },
    8: { state: 'Incomplete', category: 'requiresRefresh', action: 'refresh' },
    10: { state: 'ForceCalculationNeeded', category: 'requiresRecalculation', action: 'recalculate' }
};

const UNKNOWN_STATE_INFO = { state: 'Unknown', category: 'unknown', action: 'inspect' };

/** Map a category to its key in the summary object returned by buildReadinessSnapshot(). */
const SUMMARY_KEY_OF_CATEGORY = {
    ready: 'ready',
    requiresRefresh: 'requiresRefresh',
    requiresRecalculation: 'requiresRecalculation',
    error: 'errors',
    unknown: 'unknown'
};

/**
 * Classify a raw engine state code into { state, category, action }.
 * Any value outside the documented enum — including missing/non-numeric values —
 * is treated as 'unknown', never silently as 'ready'.
 */
function classifyState(stateCode) {
    const code = Number(stateCode);
    if (!Number.isFinite(code)) return { ...UNKNOWN_STATE_INFO };
    const info = OBJECT_STATE_INFO[code];
    return info ? { ...info } : { ...UNKNOWN_STATE_INFO };
}

/**
 * Build the normalized MVP readiness snapshot from raw partition records.
 * @param {{ table: string, objectType?: string, name: string, stateCode: number|string, refreshedTime?: string|null, errorMessage?: string|null }[]} records
 * @param {{ checkedAt?: string }} [options]
 */
function buildReadinessSnapshot(records, options = {}) {
    const checkedAt = options.checkedAt || new Date().toISOString();
    const summary = { ready: 0, requiresRefresh: 0, requiresRecalculation: 0, errors: 0, unknown: 0 };
    const objectsRequiringAttention = [];

    for (const record of (records || [])) {
        const classification = classifyState(record.stateCode);
        summary[SUMMARY_KEY_OF_CATEGORY[classification.category]] += 1;

        if (classification.category !== 'ready') {
            objectsRequiringAttention.push({
                table: record.table,
                objectType: record.objectType || 'partition',
                name: record.name,
                stateCode: record.stateCode,
                state: classification.state,
                action: classification.action,
                refreshedTime: record.refreshedTime ?? null,
                errorMessage: record.errorMessage ?? null
            });
        }
    }

    return { availability: 'available', checkedAt, summary, objectsRequiringAttention };
}

/** Build an "inspection unavailable" result. Deployment succeeded but state could not be read. */
function buildUnavailableSnapshot(reasonCode, message) {
    return { availability: 'unavailable', reasonCode, message };
}

/** Weakest-to-strongest is the reverse of this list; index 0 is the strongest action. */
const ACTION_PRECEDENCE = ['refresh', 'recalculate', 'repair', 'inspect'];

/** Pick the stronger of two required actions: refresh > recalculate > repair > inspect. */
function strongerAction(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const ia = ACTION_PRECEDENCE.indexOf(a);
    const ib = ACTION_PRECEDENCE.indexOf(b);
    if (ia === -1) return b;
    if (ib === -1) return a;
    return ia <= ib ? a : b;
}

module.exports = {
    OBJECT_STATE_INFO,
    classifyState,
    buildReadinessSnapshot,
    buildUnavailableSnapshot,
    strongerAction
};
