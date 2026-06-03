# Relationship Cardinality Change Warnings

## Implementation (2026-06-03)

Model Alchemist now detects relationship cardinality changes and displays warnings to prevent deployment failures caused by duplicate keys.

## Problem

Fabric blocks deployment of relationship changes from `many-to-many` to `many-to-one` (or `one-to-many`) when the key column on the "one" side contains duplicate values. This is a data integrity requirement - the "one" side must have unique values.

**Example:**
- Changing relationship `Report_Volume.Version → Dim_Snapshot.Volume_Version` from `many-to-many` to `many-to-one`
- If column `Dim_Snapshot.Volume_Version` has duplicates → Fabric returns error: `"The operation cannot be completed due to missing options"`

## Solution

### 1. Warnings Before Deployment

When user selects a relationship with cardinality change for deployment, the system displays a warning:

```
⚠️ WARNING: Changing relationship cardinality "Report_Volume.Version → Dim_Snapshot.Volume_Version" 
from many-to-many to many-to-one.

Ensure that key columns in tables do not contain duplicates:
- For many-to-one: the "one" side column (toColumn) must not have duplicates
- For one-to-many: the "one" side column (fromColumn) must not have duplicates
- For one-to-one: both columns must be unique

Fabric will block deployment if data does not meet cardinality requirements.
If deployment fails - refresh table data and try again.
```

### 2. Enhanced Error Messages After Failed Deployment

When relationship deployment fails, the system adds detailed information:

```
Fabric operation failed: The operation cannot be completed due to missing options

⚠️ RELATIONSHIP DEPLOYMENT FAILED

Cardinality change detected. Common causes:
1. Key column contains duplicates (on the "one" side of the relationship)
2. Table data does not meet cardinality requirements
3. Table needs refresh before relationship change

📋 SOLUTION:
1. Refresh data in tables participating in the relationship
2. Check that key columns do not have duplicates:
   - Relationship: Report_Volume.Version → Dim_Snapshot.Volume_Version
   - Change: many-to-many → many-to-one
   - Check: toColumn must be unique (no duplicates)
3. After refreshing data - retry deployment
```

## Relationship Types and Requirements

| Relationship Type | fromCardinality | toCardinality | Requirements |
|------------------|----------------|---------------|--------------|
| Many-to-One | many | one | `toColumn` must be unique |
| One-to-Many | one | many | `fromColumn` must be unique |
| One-to-One | one | one | Both columns must be unique |
| Many-to-Many | many | many | No uniqueness requirements |

## Modified Files

1. **comparison/engine.js** - cardinality change detection
   - Added `cardinalityChange` to relationship diff objects
   - `requiresDataValidation` flag for changes requiring data validation

2. **deployment/deployer.js** - pre-deployment warnings
   - Checking `cardinalityChange.requiresDataValidation`
   - Generating detailed warnings with instructions

3. **server.js** - enhanced error messages
   - Detection of relationship-related errors
   - Contextual messages for failed deployments
   - Problem resolution instructions

## Usage Examples

### Scenario 1: Successful Deployment

1. User has a many-to-many relationship
2. Wants to change it to many-to-one
3. **Model Alchemist displays warning**
4. User refreshes data in `Dim_Snapshot`
5. Checks uniqueness of `Volume_Version` column in Power BI
6. Executes deployment ✅

### Scenario 2: Failed Deployment with Guidance

1. User tries to change relationship to many-to-one
2. Has not refreshed data / column has duplicates
3. Deployment fails ❌
4. **Model Alchemist displays detailed message**
5. User refreshes data
6. Checks for duplicates
7. Retries deployment ✅

## Recommendations

1. **Before changing cardinality:**
   - Always refresh data in tables
   - Check in Power BI whether key columns are unique
   - Use DAX to check for duplicates: `EVALUATE FILTER(ADDCOLUMNS(VALUES(Table[Key]), "Count", CALCULATE(COUNTROWS(Table))), [Count] > 1)`

2. **After failed deployment:**
   - Read the error message carefully
   - Follow instructions step by step
   - Refresh data before trying again

3. **Diagnostics:**
   - Check logs in `logs/activity.jsonl`
   - Backup is always created before deployment
   - You can restore previous version from `backups/` folder
