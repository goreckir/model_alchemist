# Deployment Troubleshooting

Model Alchemist reports every deploy outcome as a warning or an error carrying a
short `code`. This is a reference for what each one means and what to do about it.
For the relationship cardinality warning specifically, see
[RELATIONSHIP_CARDINALITY_WARNINGS.md](RELATIONSHIP_CARDINALITY_WARNINGS.md).

## Errors that stop the deploy

| Code | Where it comes from | What it means | What to do |
|---|---|---|---|
| `TARGET_FILE_MISSING` | Any file-writing operation | The TMDL file the plan wants to change does not exist on the target. Usually the object was renamed/moved, or the target model is out of sync with what was compared. | Re-run the comparison against the current target, or check whether the file was deleted/relocated outside the tool. |
| `BLOCK_NOT_FOUND` | `removeChild`, `replaceChild`, `removeTopLevel`, `replaceTopLevel`, `replaceModelBlock` | The target file exists, but the specific object block inside it wasn't found — the target doesn't have this object, or it's indented differently than expected. | Confirm the object actually exists in the target under that exact name; if it does, its TMDL formatting may be non-standard. |
| `PARENT_BLOCK_MISSING` | `appendChild` (e.g. calculation group items) | The parent block (e.g. the calculation group itself) isn't in the target yet, so a child item can't be appended to it. | Select the parent object (e.g. the calculation group) for deployment together with its children, in the same batch. |
| `DEV_SOURCE_MISSING` | Planning stage, any add/modify | The source (DEV) block backing this diff was not found when the plan was built — usually because the source model changed between comparison and deploy. | Re-run the comparison and deploy again. |
| `PLAN_FAILED` | Planning stage | Generic planning failure; the specific reason is in the accompanying message. | Read the `reason` text in the error — it names the actual cause (often one of the above). |
| `UNKNOWN_OPERATION` | Internal | A planned operation used an action the executor doesn't recognize. This indicates a bug, not a data problem. | Report it — this should never happen in normal use. |
| `PROD_CHANGED_SINCE_COMPARE` | Fabric deploy only | The live Fabric model changed after the comparison was taken. Deploying the old snapshot would silently revert those changes. | Re-run the comparison against Fabric, review the new differences, and deploy again. To deploy anyway, use the force option (see `PROD_CHANGED_SINCE_COMPARE_FORCED` below). |
| `ROLLBACK_INCOMPLETE` | Local deploy, after a failed operation | The deploy failed partway through and the automatic rollback could **not** restore every file it had changed. The target is left in a partially-deployed, non-guaranteed state. | Treat this as the most serious failure. Compare the target folder against your backup (created before the deploy) and restore manually if needed before deploying again. |

## Warnings (deploy still proceeds, or already has)

| Code | Where it comes from | What it means | What to do |
|---|---|---|---|
| `VALIDATION_SKIPPED` | Planning stage | Dependency validation threw an exception and was skipped rather than blocking the deploy. | Review the plan preview manually before applying, since the usual cascade/cardinality checks did not run. |
| `TARGET_PATHS_GUESSED` | Planning stage | The target model couldn't be indexed, so file paths are guessed from object names (e.g. `tables/<name>.tmdl`) instead of the real file layout. | Review the plan preview carefully — a guessed path can miss a renamed or relocated file. |
| `RELATIONSHIP_CARDINALITY_CHANGE` | Planning stage | A relationship's cardinality is changing (e.g. many-to-many → many-to-one), which Fabric will reject if the "one" side key column has duplicates. | See [RELATIONSHIP_CARDINALITY_WARNINGS.md](RELATIONSHIP_CARDINALITY_WARNINGS.md) for the full explanation and how to check for duplicates before deploying. |
| `UNREVIEWED_BLOCK_CHANGES` | Planning stage | A modify replaces the object's whole TMDL block, which also carries properties beyond the ones shown in the diff. The warning lists exactly which lines are added/removed beyond what was reviewed. | Read the listed lines before applying — nothing is hidden, but a whole-block write ships more than the diff view shows. |
| `PROD_CHANGED_SINCE_COMPARE_FORCED` | Fabric deploy, force option | The Fabric model had drifted since the comparison, and the deploy was forced anyway. The plan was recomputed against the live definition, not the stale snapshot. | Confirm this was intentional — the deploy did not just overwrite the drifted changes with old data, but they were not part of what you originally reviewed either. |
| `OPERATION_NOOP` | Any file-writing operation | An operation completed without changing its target file (the target was already in the desired state). | Informational only — no action needed. |

## Fabric upload failures (relationship-specific)

When a Fabric deploy throws an error containing `missing options`, `cardinality`,
`duplicate`, or `uniqueness` **and** the selected diffs include relationship
changes, the error message is extended with concrete remediation steps: which
relationship is implicated, the cardinality change involved, and which column
(`fromColumn`/`toColumn`) must be checked for duplicates. See
[RELATIONSHIP_CARDINALITY_WARNINGS.md](RELATIONSHIP_CARDINALITY_WARNINGS.md).

If a Fabric deploy is interrupted (e.g. a network timeout) after the upload
request was sent, the result is reported as **indeterminate**, not failed — check
the model in the Fabric portal before retrying, since the upload may already have
succeeded.

## General diagnostics

- Every deploy is logged to `logs/activity.jsonl`.
- A local deploy backs up the whole `.SemanticModel` folder before writing, when
  the backup option is enabled — restore from there if something needs undoing
  by hand.
- Dry-run (preview) mode plans every operation without writing anything, so the
  full list of warnings and errors above can be reviewed before a real deploy.
