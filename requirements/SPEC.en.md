# Specification: Semantic Model Analysis and Comparison Application (TMDL)

## Purpose and Scope

The application provides programmatic traversal of an entire semantic model and accurate identification of every model object — enabling **code comparison between two independent models** at the individual object level.

Three comparison paths are supported:

| # | Path | Source A | Source B |
|---|------|----------|----------|
| 1 | **TMDL ↔ TMDL** | `definition/` folder on disk / Git | `definition/` folder on disk / Git |
| 2 | **TMDL ↔ Fabric** | `definition/` folder on disk / Git | Live semantic model in Fabric (via XMLA) |
| 3 | **Fabric ↔ Fabric** | Live semantic model in Fabric (via XMLA) | Live semantic model in Fabric (via XMLA) |

In all three paths the internal model representation is a **TOM** (`Microsoft.AnalysisServices.Tabular.Database`) object. TMDL and XMLA are simply two loading mechanisms for the same object graph.

### Reference documentation
- [Tabular Model Definition Language (TMDL) – Microsoft Learn](https://learn.microsoft.com/analysis-services/tmdl/tmdl-overview)
- [TMDL Reference – Objects overview](https://learn.microsoft.com/analysis-services/tmdl/tmdl-reference-tabular-object)
- [Power BI Desktop project – Semantic model folder (PBIP)](https://learn.microsoft.com/power-bi/developer/projects/projects-dataset)
- [Fabric REST API – SemanticModel definition](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/semantic-model-definition)

---

## 1. TMDL Folder Structure in a PBIP Project

The semantic model folder (`<Name>.SemanticModel/`) in a Power BI Project (PBIP) contains:

```
<Name>.SemanticModel/
├── definition.pbism          # required; format version (≥4.0 = TMDL)
├── diagramLayout.json        # optional; model diagram metadata
├── .platform                 # Fabric Git system file
├── definition/               # required when format = TMDL
│   ├── database.tmdl         # CompatibilityLevel, database ID, read/write mode
│   ├── model.tmdl            # model configuration + ref table/role/culture ordering
│   ├── relationships.tmdl    # ALL relationships in the model (single file)
│   ├── expressions.tmdl      # shared M expressions and query parameters
│   ├── dataSources.tmdl      # (optional) data source definitions
│   ├── functions.tmdl        # (optional) DAX user-defined functions
│   ├── tables/
│   │   └── <TableName>.tmdl  # one file per table
│   ├── roles/
│   │   └── <RoleName>.tmdl   # one file per security role
│   ├── perspectives/
│   │   └── <PerspName>.tmdl  # one file per perspective
│   └── cultures/
│       └── <locale>.tmdl     # one file per culture / linguistic schema
└── .pbi/
    ├── localSettings.json
    └── editorSettings.json
```

### Format version (`definition.pbism`)

| `version` property | Supported format |
|--------------------|-----------------|
| `1.0` | TMSL only (`model.bim`) |
| `4.0` or higher | TMDL (`definition/`) or TMSL (`model.bim`) |

The application must read `definition.pbism` and verify the version before attempting to load TMDL files.

---

## 2. TOM Object Hierarchy → TMDL Mapping

TMDL has a 1:1 correspondence with the Tabular Object Model (TOM). Every TMDL object maps to a class in the `Microsoft.AnalysisServices.Tabular` namespace.

### Root objects (indentation level 0, files under `definition/`)

| TMDL type     | File                  | Description                                          |
|---------------|-----------------------|------------------------------------------------------|
| `database`    | `database.tmdl`       | Compatibility level, database ID, read/write mode    |
| `model`       | `model.tmdl`          | Model configuration; `ref` ordering for tables/roles/cultures |
| `relationship`| `relationships.tmdl`  | All relationships (collected in a single file)       |
| `expression`  | `expressions.tmdl`    | Shared M expressions and Power Query parameters      |
| `dataSource`  | `dataSources.tmdl`    | External data source connections                     |
| `function`    | `functions.tmdl`      | DAX user-defined functions (UDFs)                    |

### Objects serialized as individual files (one file per object)

| TMDL type     | Folder               | Description                                              |
|---------------|----------------------|----------------------------------------------------------|
| `table`       | `tables/`            | Table with all child objects (columns, measures, etc.)   |
| `role`        | `roles/`             | Security role (RLS / OLS)                                |
| `perspective` | `perspectives/`      | Model perspective                                        |
| `cultureInfo` | `cultures/`          | Linguistic schema and translations                       |

### Child objects inside a table file (`tables/<Name>.tmdl`)

| TMDL type          | Parent             | Description                                        |
|--------------------|--------------------|----------------------------------------------------|
| `column`           | `table`            | Imported or calculated column                      |
| `measure`          | `table`            | DAX measure                                        |
| `hierarchy`        | `table`            | Hierarchy                                          |
| `partition`        | `table`            | Data partition (M or DAX)                          |
| `calculationGroup` | `table`            | Calculation group                                  |
| `kpi`              | `measure`          | KPI attached to a measure                          |
| `level`            | `hierarchy`        | Hierarchy level                                    |
| `calculationItem`  | `calculationGroup` | Calculation item                                   |
| `alternateOf`      | `column`           | Aggregation alternative definition                 |
| `annotation`       | any object         | Key-value metadata annotation                      |
| `extendedProperty` | any object         | Extended property                                  |

### Child objects inside a role file (`roles/<Name>.tmdl`)

| TMDL type          | Parent             | Description                                        |
|--------------------|--------------------|----------------------------------------------------|
| `tablePermission`  | `role`             | Row-level security (RLS) filter on a table         |
| `columnPermission` | `tablePermission`  | Object-level security (OLS) on a column            |
| `member`           | `role`             | Role member (Microsoft Entra ID or Windows)        |

### Child objects inside a perspective file (`perspectives/<Name>.tmdl`)

| TMDL type               | Parent              | Description                       |
|-------------------------|---------------------|-----------------------------------|
| `perspectiveTable`      | `perspective`       | Table included in the perspective |
| `perspectiveMeasure`    | `perspectiveTable`  | Measure included in the perspective |
| `perspectiveColumn`     | `perspectiveTable`  | Column included in the perspective |
| `perspectiveHierarchy`  | `perspectiveTable`  | Hierarchy included in the perspective |

### Child objects inside a culture file (`cultures/<locale>.tmdl`)

| TMDL type             | Parent        | Description                                    |
|-----------------------|---------------|------------------------------------------------|
| `translations`        | `cultureInfo` | Translation block replicating the model hierarchy |
| `linguisticMetadata`  | `cultureInfo` | Linguistic metadata (JSON expression)           |

---

## 3. Object Identity Keys

To compare objects across two models, the application must derive a **unique composite key** for each object.

### Key schema per object type

| Object type          | Unique key (TOM path)                                          |
|----------------------|----------------------------------------------------------------|
| `database`           | *(singleton — one per model)*                                  |
| `model`              | *(singleton — one per model)*                                  |
| `table`              | `table.name`                                                   |
| `column`             | `table.name` + `column.name`                                   |
| `measure`            | `table.name` + `measure.name`                                  |
| `hierarchy`          | `table.name` + `hierarchy.name`                                |
| `level`              | `table.name` + `hierarchy.name` + `level.name`                 |
| `partition`          | `table.name` + `partition.name`                                |
| `calculationGroup`   | `table.name` (calculationGroup is a child of the table)        |
| `calculationItem`    | `table.name` + `calculationItem.name`                          |
| `kpi`                | `table.name` + `measure.name` (KPI belongs to its measure)     |
| `relationship`       | `relationship.name` (GUID) OR semantic key — see note below    |
| `expression`         | `expression.name`                                              |
| `function`           | `function.name`                                                |
| `dataSource`         | `dataSource.name`                                              |
| `role`               | `role.name`                                                    |
| `tablePermission`    | `role.name` + `tablePermission.name`                           |
| `columnPermission`   | `role.name` + `tablePermission.name` + `columnPermission.name` |
| `member`             | `role.name` + `member.name`                                    |
| `perspective`        | `perspective.name`                                             |
| `perspectiveTable`   | `perspective.name` + `perspectiveTable.name`                   |
| `perspectiveMeasure` | `perspective.name` + `perspectiveTable.name` + `perspectiveMeasure.name` |
| `perspectiveColumn`  | `perspective.name` + `perspectiveTable.name` + `perspectiveColumn.name` |
| `perspectiveHierarchy`| `perspective.name` + `perspectiveTable.name` + `perspectiveHierarchy.name` |
| `cultureInfo`        | `cultureInfo.name` (locale code, e.g. `en-US`)                 |
| `annotation`         | parent key + `annotation.name`                                 |
| `extendedProperty`   | parent key + `extendedProperty.name`                           |

### Relationship identity note

Relationship names in TMDL are GUIDs (`relationship cdb6e6a9-...`) and will always differ between independent models. For semantic comparison use the composite key:
```
fromTable + "." + fromColumn + " → " + toTable + "." + toColumn
```
The application should support both the GUID-based and the semantic key.

---

## 4. TMDL Parsing Rules

### 4.1 Object declaration syntax

```
<objectType> <objectName>
    <property>: <value>
    <property> = <singleLineExpression>
    <property> =
        <multiLineExpression>
            ...
```

- **Indentation**: single **tab** per nesting level. Indentation is semantic — incorrect indentation causes a parse error.
- **Name quoting**: names containing whitespace, `.`, `=`, `:`, or `'` must be enclosed in single quotes (`'Sales Amount'`). A literal single quote in a name is escaped by doubling it.
- **Boolean shorthand**: `isHidden` alone (no value) implies `true`; alternatively use `isHidden: true/false`.
- **Casing**: serialization uses **camelCase** for object types, keywords, and enum values. Deserialization is **case-insensitive**.

### 4.2 Multi-line expressions (DAX, M)

```tmdl
measure 'Sales Amount' =
        var result = SUMX(...)
        return result
    formatString: $ #,##0
```

- The expression body must be indented **one level deeper** than the parent object's properties.
- Three backticks (`` ``` ``) delimit a verbatim block, preserving trailing whitespace and blank lines exactly as written.

### 4.3 `ref` keyword and collection ordering

In `model.tmdl` the `ref` keyword declares the canonical order of collections serialized to individual files (tables, roles, cultures, perspectives):

```tmdl
model Model
ref table Calendar
ref table Sales
ref role 'Store Admins'
ref culture en-US
```

Deserialization rules:
- Objects referenced by `ref` but whose file is missing are silently ignored.
- Objects with an existing file but no `ref` entry are appended to the end of the collection.

The application must respect `ref` ordering when reconstructing TOM from files.

### 4.4 Partial declaration

The same TOM object may be declared across multiple TMDL files (similar to C# partial classes). Declaring the same property more than once for the same object is a parse error. The application must merge partial declarations before building the object graph.

---

## 5. Functional Requirements

### F1 – Load model from a TMDL folder

```
Input:  path to the definition/ folder (e.g. "MyModel.SemanticModel/definition/")
Output: TOM Database object with full metadata
```

Steps:
1. Read `definition.pbism` → verify `version ≥ 4.0` (TMDL format).
2. Deserialize `database.tmdl` and `model.tmdl`.
3. Deserialize `relationships.tmdl`, `expressions.tmdl`, `dataSources.tmdl`, `functions.tmdl`.
4. For each file in `tables/*.tmdl` — deserialize the table and all its child objects.
5. For each file in `roles/*.tmdl`, `perspectives/*.tmdl`, `cultures/*.tmdl` — deserialize objects.
6. Build internal dictionaries keyed by the composite identity key from section 3.

### F2 – Model navigation API

| Method                                 | Returns                                                  |
|----------------------------------------|----------------------------------------------------------|
| `getTable(name)`                       | Table with all child objects                             |
| `getMeasure(tableName, measureName)`   | Measure definition (DAX expression + properties)         |
| `getColumn(tableName, columnName)`     | Column definition                                        |
| `getHierarchy(tableName, hierName)`    | Hierarchy with all levels                                |
| `getRelationships()`                   | All relationships in the model                           |
| `getRole(roleName)`                    | Security role with table/column permissions and members  |
| `getPerspective(name)`                 | Perspective with all included objects                    |
| `getCulture(locale)`                   | Culture with translations                                |
| `getExpression(name)`                  | Shared expression or Power Query parameter               |
| `getFunction(name)`                    | DAX user-defined function                                |
| `getAllObjects()`                       | Flat list of all objects with their identity keys        |

### F3 – Compare two models (core algorithm)

```
Input:  Model A (IModelSource) + Model B (IModelSource)
Output: diff report grouped by change type
```

Algorithm:
1. Load both models (F1 or F5).
2. For each object type build dictionaries `{ identityKey → object }` for A and B.
3. Compute three sets:
   - **Added** (`B \ A`): objects present in B but absent in A.
   - **Removed** (`A \ B`): objects present in A but absent in B.
   - **Modified** (`A ∩ B`): objects present in both models with at least one differing property.
4. For each modified object emit the list of changed properties with old and new values.

### F5 – Load model from Fabric via XMLA

```
Input:  XMLA connection string + workspace name + semantic model name
Output: TOM Database object with full metadata
```

Implementation (TOM API, .NET):

```csharp
using Microsoft.AnalysisServices.Tabular;

var server = new Server();
// Example Fabric XMLA connection string:
// "Data Source=powerbi://api.powerbi.com/v1.0/myorg/<WorkspaceName>;"
server.Connect(xmlaConnectionString);
Database db = server.Databases[semanticModelName];
// db.Model exposes the full TOM tree — identical API as DeserializeDatabaseFromFolder
```

Notes:
- XMLA always returns the model as **TOM** regardless of whether it was deployed from TMDL or TMSL.
- Required permission: at minimum **Build** on the semantic model in Fabric.
- Authentication: service principal (client ID + client secret) or interactive (MSAL `DefaultAzureCredential`).
- `diagramLayout.json` is not accessible via XMLA — retrieve it from PBIP files or the Fabric REST API if needed.

### F6 – Cross-source comparison (TMDL ↔ Fabric, Fabric ↔ Fabric)

Both new paths reuse the F3 algorithm unchanged. The difference is exclusively in how each model is loaded:

```
Path 2 (TMDL ↔ Fabric):
  Model A = TmdlSerializer.DeserializeDatabaseFromFolder(localPath)   ← F1
  Model B = server.Databases[fabricModelName]                          ← F5
  → run F3

Path 3 (Fabric ↔ Fabric):
  Model A = server.Databases[fabricModelNameA]                         ← F5
  Model B = server.Databases[fabricModelNameB]                         ← F5
  → run F3
```

Additional constraints that apply to XMLA-sourced models:

| Constraint | Description |
|---|---|
| `lineageTag` | Even more critical than in TMDL↔TMDL — always exclude from comparison |
| Database `id` | Each database has a unique GUID — ignore |
| System annotations | XMLA may surface internal AS annotations not present in TMDL files — filter prefixes `_TM_` and `PBI_` |
| No `ref` ordering | Collection order from XMLA reflects TOM internal order, not `ref` declarations — always compare as sets |
| Non-PBIP models | Path 3 works for semantic models that were never authored as a PBIP project |

### F4 – Diff report

Minimum report format:

```
=== MODEL COMPARISON ===
Model A: MyModel_v1.SemanticModel/definition/
Model B: powerbi://api.powerbi.com/v1.0/myorg/Production :: SalesModel

--- ADDED (12) ---
[table]       'DimDate'
[measure]     'Sales'.'YTD Sales'
[role]        'Regional Manager'
...

--- REMOVED (3) ---
[measure]     'Sales'.'Old KPI'
...

--- MODIFIED (47) ---
[measure]     'Sales'.'Sales Amount'
  expression: "SUMX(...)" → "CALCULATE(SUMX(...),...)"
[column]      'Product'.'Category'
  displayFolder: "" → "Products"
  isHidden: false → true
...
```

---

## 6. Key Properties per Object Type (Comparison Scope)

### `measure`
- `expression` (DAX) — **primary comparison target**
- `formatString`
- `displayFolder`
- `isHidden`
- `description`
- `kpi` — `statusExpression`, `targetExpression`, `trendExpression`
- `detailRowsDefinition`
- `formatStringDefinition`
- `annotation[]`

### `column`
- `dataType`
- `sourceColumn`
- `expression` (calculated columns only)
- `formatString`
- `displayFolder`
- `isHidden`, `isKey`, `isNullable`, `isUnique`
- `summarizeBy`
- `sortByColumn`
- `dataCategory`
- `description`
- `alternateOf`
- `annotation[]`

### `table`
- `isHidden`
- `isPrivate`
- `description`
- `lineageTag` *(exclude from diff — see section 9)*
- `showAsVariationsOnly`
- `calculationGroup` (present/absent + `precedence`)
- child object counts: columns, measures, hierarchies, partitions

### `partition`
- `mode` (`import` / `directQuery` / `dual`)
- `source` (M expression or DAX)
- `type`

### `relationship`
- `fromColumn`, `toColumn` (fully qualified: `Table.Column`)
- `cardinality`
- `crossFilteringBehavior`
- `isActive`
- `securityFilteringBehavior`

### `role`
- `modelPermission`
- `tablePermission[]` — table name + DAX filter expression
- `columnPermission[]` — `metadataPermission`
- `member[]` — compared as a set (order is not significant)

### `hierarchy`
- `level[]` — ordinal and column mapping
- `displayFolder`
- `isHidden`

### `expression` (shared M expression)
- `expression` (M / Power Query code)
- `kind` (`m` / `calculated`)
- `queryGroup`

### `cultureInfo` (translations)
- Per-object `caption`, `description`, `displayFolder` translations for all model objects.

---

## 7. Non-Functional Requirements

| Requirement | Description |
|---|---|
| **Parsing** | Correct handling of tab indentation, single-quote escaping, backtick-verbatim blocks, and partial declaration merging |
| **Encoding** | UTF-8 without BOM (PBIP standard) |
| **Line endings** | Must handle both LF and CRLF (Power BI Desktop writes CRLF) |
| **Collection ordering** | Respect `ref` declarations when reconstructing TOM collection order |
| **Case-insensitivity** | Property names and keywords must be parsed case-insensitively |
| **Idempotency** | A full deserialize → serialize roundtrip must not alter file content |
| **Performance** | Models with hundreds of tables and thousands of measures must load in < 5 s |
| **Error reporting** | Parse errors must include file path and line number |

---

## 8. Selected Implementation: TOM API (.NET)

The application uses the official `TmdlSerializer` and `Microsoft.AnalysisServices.Tabular.Server` from the NuGet package `Microsoft.AnalysisServices.NetCore.retail.amd64`.

A shared `IModelSource` interface abstracts the loading path:

```csharp
interface IModelSource
{
    Database Load(); // always returns a TOM Database
}

// Path 1: TMDL from disk
class TmdlFolderSource(string path) : IModelSource
{
    public Database Load() =>
        TmdlSerializer.DeserializeDatabaseFromFolder(path);
}

// Path 2/3: XMLA from Fabric
class XmlaSource(string connectionString, string databaseName) : IModelSource
{
    public Database Load()
    {
        var server = new Server();
        server.Connect(connectionString);
        return server.Databases[databaseName];
    }
}
```

Model navigation is identical regardless of source:

```csharp
Database db = source.Load();

foreach (Table table in db.Model.Tables)
{
    foreach (Measure m in table.Measures) { /* ... */ }
    foreach (Column c in table.Columns)   { /* ... */ }
    foreach (Hierarchy h in table.Hierarchies) { /* ... */ }
}

foreach (Relationship r in db.Model.Relationships) { /* ... */ }
foreach (Role role in db.Model.Roles)               { /* ... */ }
foreach (Expression expr in db.Model.Expressions)   { /* ... */ }
```

**Rationale for TOM API over a custom parser:**
- `TmdlSerializer` is the official Microsoft parser — it handles all edge cases (partial declaration, backtick-verbatim, CRLF, indentation) without any custom code.
- The same `Database` object is produced from both TMDL and XMLA — the F3 comparison algorithm runs unchanged for all three paths.
- Deserialize → serialize roundtrip is guaranteed to be idempotent.

**Fabric XMLA connection string (service principal):**
```
Data Source=powerbi://api.powerbi.com/v1.0/myorg/<WorkspaceName>;
Initial Catalog=<SemanticModelName>;
User ID=app:<ClientId>@<TenantId>;
Password=<ClientSecret>;
```

---

## 8a. Rejected Implementation Options

> The following options were evaluated and rejected. Retained for architectural decision record.

### ~~Option B — Custom text parser (Python / TypeScript)~~

**Rejected.** A hand-written TMDL parser based on indentation grammar requires weeks of work and carries significant risk of edge-case failures (partial declaration merging, backtick-verbatim, CRLF normalization). It provides no XMLA support without an additional layer. Its only advantage — no .NET dependency — is not a constraint in this project.

Implementation steps (for reference only):
1. Tokenize the file into indentation-delimited blocks.
2. Match object declarations with: `^(\w+|'\w[^']*')\s+(\w+|'\w[^']*')`.
3. Distinguish property assignments (`:`) from expression assignments (`=`).
4. Handle multi-line expressions (deeper indentation until block end).
5. Handle backtick-verbatim blocks (` ``` `).

### ~~Option C — Tabular Editor CLI (TE2 / TE3)~~

**Rejected.** The Tabular Editor CLI is an interactive tool, unsuitable as a library engine. Using it to convert TMDL → BIM (TMSL JSON) before diffing introduces an external process dependency, complicates error handling, and does not natively support XMLA connectivity for cross-source comparison.

```bash
# (for reference only — do not use in implementation)
TabularEditor.exe "ModelA.SemanticModel/definition" -script "..."
```

---

## 9. Known Limitations and Pitfalls

| Pitfall | Description |
|---------|-------------|
| **`diagramLayout.json`** | Not part of the TOM object graph — exclude from semantic comparison |
| **`lineageTag`** | Globally unique GUIDs; independent models will always have different `lineageTag` values for semantically identical objects — exclude from comparison or handle separately |
| **System annotations** | Annotations such as `SummarizationSetBy` and `PBI_ResultType` are generated automatically by Power BI Desktop — filter before comparison |
| **Relationship GUIDs** | Relationship names are GUIDs and will always differ between models — use the semantic key (`fromColumn → toColumn`) |
| **Partial declaration** | An object may be spread across multiple files — the application must merge all partial declarations before comparison |
| **`cultureInfo` translations** | Translations replicate the entire model hierarchy in a virtual TMDL structure that differs from standard TMDL — requires dedicated parsing logic |
| **Role members** | Member order within a role is not semantically significant — compare as an unordered set |
| **`unappliedChanges.json`** | Temporary file for in-progress Power Query changes — not part of the model definition; ignore |
| **CRLF vs. LF** | Power BI Desktop writes CRLF; Git may normalize to LF — normalize line endings before parsing |

---

## 10. Out-of-Scope Extensions (Post-MVP)

- **DAX AST diff**: parse DAX expressions into an abstract syntax tree and compare structurally rather than as text (formatting-resistant).
- **M / Power Query diff**: parse M expressions for structural comparison.
- **HTML diff report**: interactive diff output with syntax highlighting.
- **Git integration**: compare model versions across branches or commits using `git diff` output as input instead of two folder paths.
- **Referential integrity validation**: verify that all cross-object references (`sortByColumn`, `column` in a hierarchy level, etc.) resolve to existing objects within the model.
- **Best Practice Analyzer (BPA)**: evaluate model objects against quality and governance rules after loading.
