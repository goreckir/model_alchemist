# Analiza Comparison Engine — Kompletność wykrywania zmian

**Data analizy:** 2026-06-02  
**Wersja aplikacji:** 4.5.1  
**Zakres:** `comparison/extractor.js` — mechanizm identyfikacji zmian między modelami  
**Kontekst:** Po wykryciu luki w porównywaniu perspektyw (brak ekstrakcji miar/kolumn/hierarchii z `perspectiveTable`), przeprowadzono systematyczny audit wszystkich funkcji `extract*` w celu weryfikacji kompletności ekstrakcji właściwości dla każdego typu obiektu TMDL.

---

## Streszczenie

| Status | Liczba obiektów | Komentarz |
|--------|-----------------|-----------|
| ✅ **Poprawne** | 5 | `function`, `dataSource`, `modelProperties`, `calculationGroup`, `calculationItem` — pełna ekstrakcja lub świadome pominięcia |
| ⚠️ **Częściowe** | 6 | `table`, `column`, `measure`, `hierarchy`, `partition`, `relationship` — brakuje niektórych właściwości TMDL |
| ❌ **Problematyczne** | 3 | `perspective` (✅ naprawione w 4.5.1), `culture` (monolit), `expression` (brak parsowania M) |
| 🔍 **Do weryfikacji** | 1 | `role` + `tablePermission` — prawdopodobnie OK, ale wymaga testu z column-level security |

**Ogólny wniosek:** Extractor pokrywa **~70-80% właściwości** definiowanych w TMDL 1.2 / TOM 1605+. Największe luki to:
1. Właściwości semantyczne (np. `variations`, `alternateof`) — częściowo zserializowane przez `serializeChildren`
2. Właściwości zaawansowane (`kpi` w kolumnach, `alternateOf`, `linguisticMetadata`) — niewyciągane
3. Właściwości runtime/diagnostyczne (patrz sekcja 4.2)

---

## 1. Analiza per typ obiektu

### 1.1 `table` ✅ **Dobra kompletność**

**Wyciągane właściwości:**
- `isHidden`, `isPrivate`, `description` ✅
- `dataCategory`, `excludeFromModelRefresh`, `showAsVariationsOnly` ✅
- `annotations`, `extendedProperty` (przez `serializeChildren`) ✅
- `refreshPolicy` (przez `serializeChildren`) ✅

**Brakujące właściwości:**
- Brak — wszystkie kluczowe właściwości table pokryte. ✅

**Świadome pominięcia:**
- `lineageTag`, `sourceLineageTag` — prawidłowo pominięte (per-environment identifiers).

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 1.2.1 wymienia `lineageTag`, `excludeFromModelRefresh`, `refreshPolicy`, `annotation` — **wszystkie są już wyciągane** (po v4.3+).
- ✅ **Zgodność z audytem krytycznym.**

---

### 1.2 `column` ⚠️ **Częściowa kompletność**

**Wyciągane właściwości:**
- `dataType`, `sourceColumn`, `formatString`, `displayFolder` ✅
- `isHidden`, `isKey`, `isNullable`, `isUnique` ✅
- `description`, `dataCategory`, `summarizeBy`, `sortByColumn` ✅
- `summarizationSetBy`, `encodingHint` ✅
- `annotations`, `extendedProperty`, `formatStringDefinition`, `detailRowsDefinition`, `variations` (przez `serializeChildren`) ✅
- `expression` (dla calculated columns) ✅

**Brakujące właściwości:**
1. **`kpi`** — KPI może być zdefiniowane na kolumnie (nie tylko na measure). Extractor sprawdza `kpi` tylko w `extractMeasure`, **nie** w `extractColumn`.
2. **`alternateOf`** — kolumna może być alternate key dla innej kolumny (TMDL: `alternateOf column 'OtherColumn'`). Parser rozpoznaje `alternateOf` jako `objectTypes`, ale extractor nie wyciąga.
3. **`linguisticMetadata`** — dla kolumn typu text w Natural Language Query. Parser ma `linguisticMetadata` w `objectTypes`, ale extractor nie ekstrahuje.

**Świadome pominięcia:**
- `lineageTag`, `sourceLineageTag` — prawidłowo pominięte.

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 1.2.1 wymienia `lineageTag`, `summarizationSetBy`, `encodingHint`, `formatStringDefinition`, `detailRowsDefinition`, `variations`, `dataCategory` — **wszystkie już wyciągane** (po v4.3+).
- ⚠️ **Nowe luki:** `kpi` na kolumnie, `alternateOf`, `linguisticMetadata` — **nieopisane w audycie krytycznym.**

---

### 1.3 `measure` ⚠️ **Częściowa kompletność**

**Wyciągane właściwości:**
- `expression`, `formatString`, `displayFolder`, `isHidden`, `description` ✅
- `dataCategory` ✅
- `annotations`, `extendedProperty`, `formatStringDefinition`, `detailRowsDefinition` (przez `serializeChildren`) ✅
- `kpi` (statusExpression, targetExpression, trendExpression) ✅

**Brakujące właściwości:**
- Brak — wszystkie kluczowe właściwości measure pokryte. ✅

**Świadome pominięcia:**
- `lineageTag` — prawidłowo pominięty.

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 1.2.1 wymienia `lineageTag`, `formatStringDefinition`, `detailRowsExpression`, `displayFolder` z translacją, `dataCategory` — **wszystkie już wyciągane**.
- ✅ **Zgodność z audytem krytycznym.**

---

### 1.4 `hierarchy` ⚠️ **Niepełna ekstrakcja poziomów**

**Wyciągane właściwości:**
- `displayFolder`, `isHidden` ✅
- `level[i]`, `level[i].column` — nazwy poziomów i kolumn ✅

**Brakujące właściwości:**
1. **`level.ordinal`** — każdy level ma `ordinal` (pozycja w hierarchii). Obecnie extractor inkrementuje `levelIdx` sam, ale nie sprawdza czy TMDL ma jawny `ordinal` (może różnić się od kolejności w pliku).
2. **`level.lineageTag`** — pomijany (świadomie, jak w innych obiektach).

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Nie wymieniono hierarchii jako obszaru problemowego. Audit krytyczny koncentrował się na table/column/measure.
- ⚠️ **Nowe obserwacje:** `level.ordinal` może różnić się od kolejności w pliku — potencjalne false negatives.

---

### 1.5 `partition` ⚠️ **Częściowa kompletność**

**Wyciągane właściwości:**
- `mode`, `type` (expression), `expression` (source), `dataView`, `queryGroup` ✅
- `annotations`, `extendedProperty` (przez `serializeChildren`) ✅

**Brakujące właściwości:**
1. **`dataSource`** — partition może mieć referencję `dataSource: 'DataSourceName'` (dla DirectQuery/LiveConnect). Nie ekstrahowana.
2. **`refreshBookmarkDataOnly`** — boolean flag dla partycji w trybie DirectQuery z raportami zakładkowymi. Parser ma w `booleanShorthand`, ale extractor nie wyciąga.

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 1.2.1 wymienia `mode` enum, `dataView`, `queryGroup`, `annotation` — **wszystkie wyciągane**.
- ⚠️ **Nowe luki:** `dataSource`, `refreshBookmarkDataOnly` — **nieopisane.**

---

### 1.6 `relationship` ✅ **Dobra kompletność (po v4.5.1)**

**Wyciągane właściwości:**
- `fromColumn`, `toColumn`, `fromCardinality`, `toCardinality` ✅
- `crossFilteringBehavior`, `isActive`, `securityFilteringBehavior` ✅
- `joinOnDateBehavior`, `relyOnReferentialIntegrity` ✅
- `annotations`, `extendedProperty` (przez `serializeChildren`) ✅

**Identity key:** `relationship:${displayName}${keySuffix}${cfSuffix}` — teraz zawiera `isActive` + `crossFilteringBehavior`, co rozwiązuje problem kolizji opisany w ANALIZA_KRYTYCZNA.md sekcja 1.2.3.

**Brakujące właściwości:**
- Brak — wszystkie właściwości relationship pokryte. ✅

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 1.2.3 opisuje ryzyko kolizji klucza dla wielu relacji między tymi samymi kolumnami — **naprawione** przez kompozytowy klucz z `isActive` + `crossFilter`.
- ✅ **Zgodność z audytem krytycznym.**

---

### 1.7 `calculationGroup` + `calculationItem` ✅ **Pełna kompletność**

**Wyciągane właściwości (calculationGroup):**
- `precedence` ✅

**Wyciągane właściwości (calculationItem):**
- `expression`, `ordinal` ✅

**Brakujące właściwości:**
1. **`description` dla calculationGroup** — TMDL wspiera `description` dla CG (nie tylko dla items). Extractor nie wyciąga.
2. **`annotations` dla calculationGroup/item** — możliwe, ale nie ekstrahowane jawnie. Są w `rawBlock`, więc pojawią się w deploy, ale nie w diff properties.
3. **`calculationGroupExpression`** (override dla selected item) — zaawansowana funkcja TMDL, niewyciągana.

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 1.2.1 wymienia `description`, `annotation`, `calculationGroupExpression` — **potwierdzone jako pominięte**.
- ⚠️ **Zgodność z audytem krytycznym** — luki znane i udokumentowane.

---

### 1.8 `role` + `tablePermission` + `roleMember` 🔍 **Prawdopodobnie OK, wymaga testu**

**Wyciągane właściwości (role):**
- `modelPermission`, `description`, `tablePermissions` (summary) ✅

**Wyciągane właściwości (tablePermission):**
- `filterExpression`, `metadataPermission` ✅
- `columnPermissions`, `dataCoveragePermission` (przez `serializeChildren`) ✅

**Wyciągane właściwości (roleMember):**
- `memberName`, `memberType` (lub `identityProvider`) ✅

**Potencjalne luki:**
1. **`columnpermission` wewnątrz tablePermission** — serializowane przez `serializeChildren`, ale **nie ma osobnego obiektu** w `objects`. Jeśli jedna table permission ma dwie column permissions i jedna się zmienia — diff pokaże zmianę całego `serializeChildren`, nie konkretnej kolumny.
   - **Skutek:** Mniej granularny diff (OK dla podstawowego use case, ale suboptymalne dla szczegółowego audytu RLS).

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 1.2.1 wymienia `tablePermissions.metadataPermission`, `columnPermission`, `dataCoveragePermission` — **wszystkie są serializowane**, ale nie jako osobne obiekty identity.
- 🔍 **Wymaga testu:** Sprawdzić czy zmiana jednej column permission w table permission generuje prawidłowy diff.

---

### 1.9 `expression` (Named Expressions / M Parameters) ❌ **Problematyczna heurystyka**

**Wyciągane właściwości:**
- `expression` (pełna treść M), `kind` ✅

**Problemy:**
1. **Heurystyka `IsParameterQuery`** — detection parametru vs shared query opiera się na `String.includes('IsParameterQuery')`. To może dać:
   - False positive: komentarz `// IsParameterQuery is deprecated` w shared query sklasyfikuje go jako parameter.
   - False negative: parameter bez explicit `IsParameterQuery` (starsze TMDL) nie zostanie rozpoznany.
2. **Brak parsowania M** — zmiana kolejności `let` bindings (semantycznie ekwiwalentnych) wygeneruje diff mimo braku faktycznej zmiany funkcjonalnej.
3. **Brak wyciągania meta-properties** — `Expression.Kind`, `Expression.IsParameterQuery`, `Expression.IsParameterQueryRequired` są dostępne w M meta record, ale nie są ekstrahowane.

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 1.2.4 opisuje problem heurystyki `String.includes` dla dependency detection (analogiczny problem).
- Sekcja 1.2.7 opisuje brak normalizacji whitespace w M — **potwierdzony**.
- ❌ **Zgodność z audytem krytycznym** — problemy znane i nierozwiązane.

---

### 1.10 `perspective` ✅ **Naprawione w 4.5.1**

**Wyciągane właściwości (po poprawce 2026-06-02):**
- `description`, `includedTables` ✅
- `includedMeasures`, `includedColumns`, `includedHierarchies` ✅ (nowe)

**Historia:**
- **Przed 4.5.1:** Wyciągano tylko nazwy tabel (`perspectiveTable`), nie ich zawartość (measures/columns/hierarchies). Zmiana nazw miar w perspektywie **nie była wykrywana**.
- **Po 4.5.1:** Pełna ekstrakcja zawartości `perspectiveTable` → diff wykrywa zmiany w miarach/kolumnach/hierarchiach.

**Brakujące właściwości:**
- Brak — wszystkie kluczowe właściwości perspective pokryte. ✅

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Nie wymieniono perspektyw jako obszaru problemowego (audit był przed odkryciem luki).
- ✅ **Nowa obserwacja** — luka wykryta empirycznie 2026-06-02, naprawiona w 4.5.1.

---

### 1.11 `culture` (translations) ❌ **Monolit, nieprecyzyjny diff**

**Wyciągane właściwości:**
- `locale` ✅
- `translations` — **cały tekst jako monolit string** (lista `table.object (type): caption/description`).

**Problemy:**
1. **Brak per-object identity** — zmiana jednej translacji (`Sales.Amount.caption`) generuje diff całego stringa `translations`. Nie da się zlokalizować która konkretna translacja się zmieniła.
2. **Brak selektywnego deployu** — deployment cultures kopiuje cały plik. Nie da się przenieść tylko jednej zmiany translacji.
3. **Sortowanie** — jeśli kolejność tłumaczeń w pliku TMDL się zmieni (np. przez auto-format), diff pokaże zmianę mimo braku faktycznej zmiany treści.

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 1.2.6 opisuje dokładnie ten problem — **potwierdzony**.
- Sekcja 2.2.13 opisuje deployment jako monolit — **potwierdzony**.
- ❌ **Zgodność z audytem krytycznym** — problemy znane i nierozwiązane.

---

### 1.12 `dataSource` ✅ **Minimalna, ale wystarczająca**

**Wyciągane właściwości:**
- `type` ✅

**Brakujące właściwości:**
1. **`connectionString`** — dla structured data sources (SQL, Oracle) może zawierać różnice (server, database). Nie ekstrahowane (zawarte w `rawBlock`, więc deploy przeniesie, ale diff nie pokaże szczegółów).
2. **`credential`** — typ uwierzytelniania (Windows, OAuth, Key). Nie ekstrahowane.
3. **`options`** — DirectQuery options, privacy levels. Nie ekstrahowane.

**Uzasadnienie:**
- DataSources rzadko się zmieniają w typowym workflow (są ustawiane raz przy konfiguracji środowiska).
- `rawBlock` zawiera wszystko — deploy jest kompletny.
- Brak szczegółowych properties w diff **nie blokuje** podstawowego użycia.

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Nie wymieniono dataSources jako obszaru problemowego — **zgadza się**, to minor issue.
- ✅ **Akceptowalne** dla obecnego poziomu szczegółowości.

---

### 1.13 `modelProperties` ⚠️ **Częściowa kompletność**

**Wyciągane właściwości:**
- `culture`, `defaultPowerBIDataSourceVersion`, `discourageImplicitMeasures` ✅
- `defaultMeasure`, `sourceQueryCulture`, `collation` ✅
- `annotations`, `extendedProperty`, `dataAccessOptions` (przez `serializeChildren`) ✅

**Brakujące właściwości:**
1. **`compatibilityLevel`** — kluczowa właściwość dla wersji TOM (1200, 1400, 1500, 1605). **Nie ekstrahowana**, mimo że ANALIZA_KRYTYCZNA.md sekcja 1.2.1 wymienia to jako istotne.
2. **`structuredDataSource`** — ref do domyślnego źródła dla modelu (dla Direct Lake / DirectQuery). Nie ekstrahowane.
3. **`model.ref` entries** — referencje do tabel, ról, expressions w `model.tmdl`. Parser wyciąga jako `model.refs`, ale extractor nie weryfikuje ich kompletności.

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 1.2.1 wymienia `compatibilityLevel`, `dataAccessOptions`, `annotation`, `defaultPowerBIDataSourceVersion` — **większość wyciągana, brak `compatibilityLevel`**.
- ⚠️ **Nowa luka:** `compatibilityLevel` — **potwierdzona jako brakująca**.

---

### 1.14 `function` (UDF) ✅ **Pełna kompletność**

**Wyciągane właściwości:**
- `expression`, `description` ✅

**Brakujące właściwości:**
- Brak — wszystkie właściwości function pokryte. ✅

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Sekcja 2.2.1 opisuje brak **deploymentu** funkcji (case `function` w `planSingleDiff`), **nie** problem z ekstrakcją.
- ✅ **Extractor OK** — problem jest w deployer, nie w comparison engine.

---

## 2. Typy obiektów nieobsługiwane przez extractor

Parser (`tmdl-parser.js`) rozpoznaje następujące `objectTypes`, które **nie mają dedykowanych funkcji extract**:

| Typ parsera | Ekstrahowany? | Komentarz |
|-------------|---------------|-----------|
| `alternateof` | ❌ | Alternate keys dla kolumn — nie ekstrahowane |
| `linguisticmetadata` | ❌ | Natural Language Query metadata — nie ekstrahowane |
| `kpi` w `column` | ❌ | KPI definiowane na kolumnie (nie measure) — nie ekstrahowane |
| `queryGroup` | ❌ | Foldery M expressions — nie ekstrahowane jako osobny obiekt (jest property w partition, ale nie ma identity) |
| `dataAccessOptions` | ⚠️ | Serializowane w `model`, ale nie ma osobnego obiektu |
| `refreshPolicy` | ⚠️ | Serializowane w `table`, ale nie ma szczegółowej ekstrakcji (tryb, policyType, incrementalPeriodsOffset, rollingWindowPeriods) |

---

## 3. Analiza funkcji pomocniczych

### 3.1 `serializeChildren(obj, types)` ✅ **Dobre rozwiązanie kompromisowe**

**Cel:** Wyciągnięcie bloków `annotation`, `extendedProperty`, `formatStringDefinition`, `detailRowsDefinition`, `refreshPolicy`, `dataAccessOptions`, `variations`, `columnpermission`, `datacoveragepermission` bez konieczności definiowania pełnej struktury dla każdego.

**Działanie:**
- Sortuje `rawBlock` dzieci po typie, łączy w string, porównuje przy diff.
- **Skip PBI_* annotations** (runtime state Power BI) — prawidłowe.

**Zalety:**
- Wykrywa **dodanie/usunięcie/zmianę** tych bloków bez konieczności pełnego parsowania.
- Conservatywne — zachowuje pełną treść w `rawBlock` do deploymentu.

**Wady:**
- **Brak granularności** — jeśli obiekt ma 3 annotations i jedna się zmieni, diff pokaże cały serializowany string jako „zmieniony", nie konkretną annotation.
- **Sortowanie alfabetyczne** — jeśli kolejność annotations w pliku ma znaczenie semantyczne (rzadkie, ale możliwe), sortowanie może ukryć faktyczną zmianę.

**Weryfikacja z ANALIZA_KRYTYCZNA.md:**
- Nie opisano `serializeChildren` jako problemu — **zgadza się**, to rozwiązanie interim OK dla większości przypadków.
- ✅ **Akceptowalne** dla obecnego poziomu szczegółowości.

---

### 3.2 Identity keys — podsumowanie

| Typ | Identity key format | Ryzyko kolizji | Komentarz |
|-----|---------------------|----------------|-----------|
| `table` | `table:${name}` | Brak | OK |
| `column` | `column:${table}.${name}` | Brak | OK |
| `measure` | `measure:${table}.${name}` | Brak | OK |
| `hierarchy` | `hierarchy:${table}.${name}` | Brak | OK |
| `partition` | `partition:${table}.${name}` | Brak | OK |
| `relationship` | `relationship:${from}→${to}\|inactive\|cf=X` | **Niski** (po v4.5.1) | Kompozytowy klucz z `isActive` + `crossFilter` — poprawka problemu z ANALIZA_KRYTYCZNA 1.2.3 |
| `calculationGroup` | `calculationGroup:${table}` | Brak | OK |
| `calculationItem` | `calculationItem:${table}.${name}` | Brak | OK |
| `role` | `role:${name}` | Brak | OK |
| `tablePermission` | `tablePermission:${role}.${table}` | Brak | OK |
| `roleMember` | `roleMember:${role}.${memberName}` | **Średni** | Jeśli ten sam user jest w roli dwa razy (różne `identityProvider`) — kolizja. Rzadkie. |
| `expression` | `expression:${name}` | Brak | OK |
| `perspective` | `perspective:${name}` | Brak | OK |
| `culture` | `culture:${locale}` | Brak | OK |
| `dataSource` | `dataSource:${name}` | Brak | OK |
| `model` | `model:properties` | Brak | OK (singleton) |
| `function` | `function:${name}` | Brak | OK |

**Wnioski:**
- Większość identity keys jest **deterministyczna i bezkolizyjna**. ✅
- `relationship` — **naprawiony** w v4.5.1 (kompozytowy klucz).
- `roleMember` — **potencjalny** problem przy duplikatach (rzadkie w praktyce).

---

## 4. Specjalne przypadki i edge cases

### 4.1 Właściwości runtime / diagnostyczne (świadomie pomijane)

Następujące właściwości TMDL **nie powinny być porównywane** (są generowane przez Power BI engine w runtime):

| Właściwość | Obiekt | Powód pominięcia |
|-----------|--------|------------------|
| `lineageTag` | table, column, measure, hierarchy, relationship | Per-environment identifier — zachowywany przez deployer |
| `sourceLineageTag` | column | J.w. |
| `PBI_*` annotations | wszystkie | Runtime state (np. `PBI_ResultType`, `PBI_NavigationStepName`) — filtrowane w `serializeChildren` |
| `changedTime` | (jeśli występuje) | Timestamp ostatniej modyfikacji — nieistotny dla porównania semantycznego |

**Status:** ✅ **Prawidłowo pomijane** w extractorze (explicit comment w kodzie).

---

### 4.2 Właściwości rzadko używane (niewyciągane, ale prawdopodobnie OK)

| Właściwość | Obiekt | Ryzyko | Komentarz |
|-----------|--------|--------|-----------|
| `isAvailableInMDX` | column, measure | Niskie | Dla kompatybilności z Analysis Services — rzadko używane w Power BI |
| `isDefaultLabel` | column | Niskie | Dla perspektyw wielowymiarowych — nieużywane w Power BI semantic models |
| `isDefaultImage` | column | Niskie | J.w. |
| `isNameInferred` | column | Niskie | Metadata o origin nazwy — nieistotne dla porównania |
| `isDataTypeInferred` | column | Niskie | J.w. |
| `showAsVariationsOnly` | table | **Średnie** | Dla tabel kalkulacyjnych z variations — **jest wyciągane** ✅ |

**Status:** ⚠️ Większość nieistotna dla Power BI workflow. `showAsVariationsOnly` już obsługiwane.

---

## 5. Weryfikacja względem ANALIZA_KRYTYCZNA.md

### 5.1 Problemy opisane w ANALIZA_KRYTYCZNA.md — status w extractorze

| Sekcja | Problem opisany | Status ekstrakcji | Komentarz |
|--------|-----------------|-------------------|-----------|
| 1.2.1 | Zamknięta lista properties | ⚠️ **Częściowo naprawione** | Po v4.3: dodano `refreshPolicy`, `annotations`, `formatStringDefinition`, `detailRowsDefinition`, `encodingHint`, `summarizationSetBy`, `variations`, `dataAccessOptions`. **Nadal brak:** `compatibilityLevel`, `linguisticMetadata`, `alternateof`, `kpi` w kolumnach. |
| 1.2.2 | Fałszywe defaulty (`summarizeBy`, `cardinality`) | ⚠️ **Częściowo poprawione** | Extractor używa `||` fallback, ale może dawać false negatives jeśli DEV ma explicit default a PROD nie. Wymaga dogłębnego testu. |
| 1.2.3 | Kolizja identity key dla relationships | ✅ **Naprawione** | Kompozytowy klucz z `isActive` + `crossFilter` (wdrożony przed audytem krytycznym). |
| 1.2.4 | Heurystyka `String.includes` dla dependency | ❌ **Nienaprawione** | Problem w `computeGroups` (deployment/deployer.js), **nie** w extractorze. Extractor wykrywa zmianę expression prawidłowo. |
| 1.2.5 | Brak analizy `definition.pbism`, `functions.tmdl` | ⚠️ **Częściowo naprawione** | `functions.tmdl` **jest parsowany i ekstrahowany** (od v4.0+). `definition.pbism` nadal nie. |
| 1.2.6 | Translacje jako monolit | ❌ **Nienaprawione** | `extractCulture` serializuje translations jako jeden string — brak per-object identity. |
| 1.2.7 | Brak normalizacji whitespace w DAX/M | ❌ **Nienaprawione** | `comparison/engine.js` robi tylko `String.trim()` — różnice w wcięciach generują false positives. |

**Wnioski:**
- **3 problemy naprawione** (częściowo/w pełni).
- **4 problemy aktywne** (nienaprawione lub wymaga dalszej pracy).

---

### 5.2 Nowe luki wykryte w tym audycie (nieopisane w ANALIZA_KRYTYCZNA.md)

| # | Obiekt | Właściwość | Ryzyko | Priorytet |
|---|--------|------------|--------|-----------|
| N1 | `column` | `kpi` | Średnie | P2 — rzadko używane (KPI zwykle na measure) |
| N2 | `column` | `alternateOf` | Niskie | P3 — zaawansowana funkcja |
| N3 | `column` | `linguisticMetadata` | Niskie | P3 — NLQ rzadko używane |
| N4 | `hierarchy` | `level.ordinal` | Niskie | P2 — porządek poziomów zwykle zgodny z kolejnością w pliku |
| N5 | `partition` | `dataSource` | Średnie | P2 — dla DirectQuery/LiveConnect |
| N6 | `partition` | `refreshBookmarkDataOnly` | Niskie | P3 — niszowa funkcja |
| N7 | `calculationGroup` | `description` | Niskie | P2 — kosmetyczne |
| N8 | `calculationGroup` | `annotations` | Niskie | P2 — j.w. |
| N9 | `model` | `compatibilityLevel` | **Wysokie** | **P1** — zmiana compatibility level to znacząca operacja |
| N10 | `model` | `structuredDataSource` | Średnie | P2 — dla Direct Lake models |

**Nowe luki wysokiego priorytetu:**
- **N9: `model.compatibilityLevel`** — powinien być wyciągany jawnie jako property, nie tylko w rawBlock.

---

## 6. Rekomendacje

### P0 — Krytyczne (brakujące funkcjonalności)

1. ✅ **Perspective measures/columns/hierarchies** — **Naprawione w v4.5.1.**

### P1 — Wysokie (kompletność kluczowych właściwości)

2. **Dodać `model.compatibilityLevel` do `extractModelProperties`** — kluczowa właściwość dla zarządzania wersją TOM. Zmiana 1500 → 1605 to znacząca operacja wymagająca testu i świadomego deployu.
3. **Dodać `kpi` extraction w `extractColumn`** — analogicznie do `extractMeasure`. KPI może być zdefiniowane na kolumnie (rzadkie, ale legalne).
4. **Normalizacja whitespace w wyrażeniach DAX/M** — w `comparison/engine.js` dodać normalizację: collapse multiple newlines, strip trailing whitespace, unifikacja wcięć. Eliminuje false positives.

### P2 — Średnie (rozszerzenie pokrycia)

5. **Dodać `partition.dataSource` do `extractPartition`** — dla DirectQuery/LiveConnect partitions. Zmiana data source to istotna modyfikacja.
6. **Per-object identity dla translations** — w `extractCulture` utworzyć osobne obiekty `translation:${culture}:${table}.${object}:${property}` zamiast serializacji do stringa. Wymaga refactor flow deploymentu cultures.
7. **Dodać `hierarchy.level.ordinal` extraction** — sprawdzić czy TMDL ma jawny ordinal i wyciągnąć; porównać z pozycją w pliku. Wykrywa reordering poziomów.
8. **Dodać `calculationGroup.description` i `annotations`** — kosmetyczne, ale kompletne.

### P3 — Niskie (zaawansowane funkcje)

9. **Dodać `column.alternateOf` extraction** — dla alternate keys.
10. **Dodać `column.linguisticMetadata` extraction** — dla NLQ.
11. **Dodać `partition.refreshBookmarkDataOnly` extraction** — niszowa funkcja.
12. **Dodać `model.structuredDataSource` extraction** — dla Direct Lake models.

---

## 7. Podsumowanie

### Ogólna ocena extractora: **7/10**

**Mocne strony:**
- Pokrywa **~70-80% właściwości TMDL** używanych w typowych workflow Power BI.
- `serializeChildren` to pragmatyczne rozwiązanie dla bloków złożonych (annotations, formatStringDefinition, refreshPolicy).
- Identity keys są deterministyczne i bezkolizyjne (po naprawie relationships).
- Świadome pominięcia (`lineageTag`, PBI_* annotations) są prawidłowe.

**Słabe strony:**
- **Brak `model.compatibilityLevel`** — to jest P1 gap.
- **Translations jako monolit** — utrudnia granularny deployment.
- **Brak normalizacji whitespace** — generuje false positives w diff.
- **Zaawansowane funkcje TMDL nie obsługiwane** (`alternateOf`, `linguisticMetadata`, `kpi` na kolumnach).

**Czy extractor wykrywa zmiany we wszystkich artefaktach?**
- **TAK** — dla większości podstawowych właściwości (table, column, measure, hierarchy, partition, relationship, role, perspective, dataSource, function).
- **NIE** — dla zaawansowanych właściwości (compatibilityLevel, kpi na kolumnach, alternateOf, linguisticMetadata, szczegóły refreshPolicy, per-translation identity).

**Ryzyko w produkcji:**
- **Niskie** — dla typowego workflow (dodanie measure, zmiana M, deployment relationship, RLS).
- **Średnie** — dla zaawansowanych scenariuszy (incremental refresh policy changes, compatibility level upgrade, alternate keys, KPI na kolumnach).

---

## 8. Zgodność z BACKLOG.md

### Czy luki opisane w BACKLOG.md są pokryte przez ten audit?

**BACKLOG.md P0:**
- „Obsługa `refreshPolicy` block" — **extractor serializuje refreshPolicy** ✅, ale nie ma szczegółowej ekstrakcji (tryb, policyType, offset, rolling window). **Częściowo pokryte.**

**BACKLOG.md P1:**
- „Normalizacja wyrażeń SQL/M" — **potwierdzone jako brakujące** ✅.
- „Multi-stage comparison" — poza zakresem tego audytu (dotyczy UI/workflow, nie extractora).

**BACKLOG.md P2:**
- „Model documentation export" — poza zakresem (dotyczy eksportu, nie comparison).

**BACKLOG.md Tech Debt TD1:**
- „Brak automated tests" — **potwierdzone**. Audit ujawnił wiele edge cases, które nie są pokryte testami jednostkowymi. ✅

**Nowe wpisy do BACKLOG.md (z tego audytu):**
1. **P1:** `model.compatibilityLevel` extraction (nowe — N9).
2. **P2:** `kpi` na kolumnach (nowe — N1).
3. **P2:** `partition.dataSource` (nowe — N5).
4. **P2:** Per-object translation identity (istniejące — potwierdzone z ANALIZA_KRYTYCZNA 1.2.6).

---

**Koniec analizy.**
