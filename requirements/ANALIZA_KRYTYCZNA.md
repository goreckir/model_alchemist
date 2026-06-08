# Krytyczna analiza aplikacji Model Alchemist v4.1

**Data analizy:** 2026-05-26
**Zakres:** moduły `parser/`, `comparison/`, `deployment/`, `fabric/`
**Źródła referencyjne:** dokumentacja Microsoft Learn — *Tabular Model Definition Language (TMDL)*, *Power BI Project files (PBIP)*, *Enhanced Refresh API*, *Fabric REST API — semanticModels/updateDefinition*.

---

## Streszczenie ocen

| Obszar | Ocena | Komentarz |
|--------|-------|-----------|
| Identyfikacja zmian (Source → diff) | **Częściowo poprawna** | Pokrywa większość obiektów strukturalnych, ale pomija krytyczne właściwości TMDL (annotations, lineageTag, extendedProperty, refreshPolicy, dynamic format strings, variations, summarizationSetBy, encoding) oraz ma istotne luki w wykrywaniu zmian model-level i functions. |
| Migracja do Target | **Niekompletna i ryzykowna** | Operuje na `rawBlock` (co konserwatywnie zachowuje pełną treść obiektu), ale: brak deployu funkcji (UDF), brak deployu zmian `model` (model properties), nadpisywanie całego pliku tabeli przy modyfikacji table-level, brak walidacji integralności (kolejność zależności), brak aktualizacji wpisów `ref` dla namedExpression/queryGroup, ryzyko nadpisania `lineageTag` w Target. |

---

## 1. Czy aplikacja poprawnie identyfikuje zmiany po stronie Source?

### 1.1 Co działa dobrze

- **Parser TMDL** (parser/tmdl-parser.js) prawidłowo zachowuje:
  - blok `rawBlock` per obiekt (pełna treść użyta później do deploymentu),
  - opisy `///` jako `properties.description`,
  - wielolinijkowe wyrażenia (`measure x = ...`),
  - referencje `ref` w `model.tmdl`.
- **Engine porównujący** (comparison/engine.js) generuje listę diffów Added / Removed / Modified z wykorzystaniem klucza tożsamości (`type:Table.Name`).
- **Grupowanie zależności** (computeGroups) prawidłowo rozpoznaje, że zmiana wyrażenia partition lub Named Expression / parametru wymaga atomowego deploymentu wraz z kolumnami zależnymi i tabelami konsumującymi to wyrażenie — łącznie z propagacją tranzytywną (`findDependentExprNames`).
- **Rozróżnienie M-parameters vs shared queries** poprzez heurystykę `IsParameterQuery` w treści wyrażenia.
- **Calculation groups** — wykrywanie `precedence` na poziomie CG i `ordinal` na poziomie items.

### 1.2 Krytyczne luki w identyfikacji zmian

#### 1.2.1 „Zamknięta lista" właściwości w `extractor.js`

Funkcje `extractColumn`, `extractMeasure`, `extractTable`, `extractHierarchy`, `extractPartition`, `extractRelationship`, `extractRole`, `extractCalculationGroup`, `extractModelProperties` ekstrahują **z góry ustaloną, wąską listę properties**. Zmiana właściwości spoza tej listy w pliku DEV **nie wygeneruje diffu „Modified"**, mimo że obiekt rzeczywiście się różni.

Przykłady pominiętych właściwości, które TMDL faktycznie wspiera (i które Power BI Desktop generuje):

| Obiekt | Pominięte właściwości (przykłady) | Skutek |
|--------|-----------------------------------|--------|
| `column` | `lineageTag`, `sourceLineageTag`, `summarizationSetBy`, `encodingHint`, `annotation`, `extendedProperty`, `formatStringDefinition` (dynamic format), `detailRowsDefinition`, `variations`, `dataCategory` jako enum vs string, `kpi` | Zmiana dynamicznego format stringa, lineageTag, encodingHint nie wykryta. Tracone powiązania z raportami po refaktorze. |
| `measure` | `lineageTag`, `formatStringDefinition` (calculated format), `annotation`, `detailRowsExpression`, `displayFolder` z translacją, `dataCategory` | Zmiana dynamic format string measure NIE wywoła diffu. |
| `table` | `lineageTag`, `excludeFromModelRefresh`, `dataCategory`, `showAsVariationsOnly`, `refreshPolicy` (incremental refresh!), `annotation`, `extendedProperty` | **Zmiana incremental refresh policy nie zostanie wykryta** — krytyczne dla produkcji. |
| `partition` | `mode` enum, `dataView`, `queryGroup`, `annotation` | Zmiana queryGroup (folder M) jest niewidoczna. |
| `relationship` | `joinOnDateBehavior`, `relyOnReferentialIntegrity`, `name` (GUID!) | Patrz 1.2.3 — kolizja klucza. |
| `role` | `modelPermission` (jest), ale brak `tablePermissions.metadataPermission`, `columnPermission`, `dataCoveragePermission` | Zmiana column-level security nie wykryta. |
| `calculationGroup` | `description`, `annotation`, `calculationGroupExpression` (selected item override) | Pominięte zmiany strukturalne. |
| `model` | `discourageImplicitMeasures`, `defaultMeasure`, `sourceQueryCulture`, `dataAccessOptions`, `compatibilityLevel`, `annotation`, `defaultPowerBIDataSourceVersion` (jest) | Zmiana poziomu kompatybilności lub `dataAccessOptions` (Direct Lake!) — niewykryta. |

**Konsekwencja:** dwa modele różniące się np. tylko `lineageTag` lub `refreshPolicy` zostaną zaraportowane jako **identyczne**, mimo że są semantycznie różne. Co ważne — `rawBlock` w diff zawiera całość, więc jeśli inny atrybut tego obiektu *też* się zmienił, deploy przyniesie również pominięte zmiany — ale wówczas użytkownik widzi w UI tylko podzbiór, co utrudnia świadomą decyzję.

#### 1.2.2 Domyślne wartości generujące fałszywe „brak zmiany"

W `extractColumn`:
```js
isNullable: col.properties.isNullable || 'true'
summarizeBy: col.properties.summarizeBy || 'default'
```

Jeżeli jeden plik zawiera jawnie `summarizeBy: none`, a drugi nie ma tego pola w ogóle (a TMDL domyślnie traktuje to inaczej zależnie od typu), porównanie znormalizowanych wartości może dać:
- *fałszywie pozytywny diff* (DEV: `none` vs PROD: `default`),
- albo *fałszywie negatywny brak diffu* (DEV pomija jawne `default`, PROD ma `default`).

Brak walidacji jest jeszcze gorszy dla `cardinality` w relacji (default `''`), gdzie pominięcie pola w jednym pliku, a obecność w drugim nie odzwierciedla realnej różnicy.

#### 1.2.3 Identyfikator relacji oparty o `fromColumn → toColumn`

```js
const semanticKey = `${fromCol} → ${toCol}`;
const key = `relationship:${semanticKey}`;
```

W TMDL jedna para kolumn może uczestniczyć w **wielu relacjach** (np. jedna aktywna + jedna nieaktywna, lub dwie aktywne z różną kierunkowością cross-filteringu — bardzo rzadko, ale legalnie). **Kolizja klucza** spowoduje, że tylko jedna relacja będzie reprezentowana w słowniku, a druga zostanie nadpisana — i nie zostanie wykryta jako Added/Removed/Modified.

Power BI używa stabilnego GUID (`relationship 'abc123...'`) jako tożsamości — ten GUID jest dostępny w `rel.name`, ale celowo pominięty na rzecz „semantycznego" klucza. Lepszą strategią byłby kompozytowy klucz (`fromColumn + toColumn + isActive + crossFilter`) albo wprost `rel.name`.

#### 1.2.4 Heurystyka wykrywania zależności M

```js
const body = expr.properties.expression || '';
if (body.includes(name)) { ... }
```

`String.includes` daje **false positives**:
- parametr `Server` znajdzie się w wyrażeniu `ServerOptions` lub w komentarzu `// Server-side ...`,
- parametr `Year` matchnie w `LastYearTotal`.

To może błędnie rozszerzyć grupę odświeżania na tabele, które wcale nie zależą od zmienionego parametru. Powinno być parsowanie M lub przynajmniej regex z granicami słów oraz wykluczeniem stringów.

#### 1.2.5 Brak analizy `definition.pbism`, `diagramLayout.json`, `expressions` rozproszonych

- `definition.pbism` (model `compatibilityLevel`, settings) **nie jest parsowany ani porównywany**.
- `diagramLayout.json` (układ relationship view) — pomijany. Akceptowalne, ale nie udokumentowane.
- Funkcje UDF (`functions.tmdl`) są parsowane, ale nigdy nie są poddane szczegółowej analizie zależności (np. UDF używana w measure → zmiana UDF nie propaguje się do diffów measures).

#### 1.2.6 Translacje (cultures) jako tekst

`extractCulture` serializuje translacje jako pojedynczy string `translations` w `properties`. Skutek:
- Diff pokazuje tylko *zbiorczą* zmianę całego tekstu — trudno zlokalizować, która konkretna translacja się zmieniła.
- Brak per-object identity (np. `culture:pl-PL:column:Sales.Amount.caption`) — nie da się selektywnie deployować pojedynczych tłumaczeń.

#### 1.2.7 Brak normalizacji whitespace w wyrażeniach M / DAX

Comparison `normalizeValue` robi tylko `String.trim()`. Różnice w wcięciach, łamaniach linii, końcowych pustych liniach generują **false-positive diffs** w długich wyrażeniach DAX/M. Power BI Desktop bywa wrażliwy na formatowanie i regeneruje białe znaki przy zapisie — co prowadzi do „szumu" w wynikach porównania.

### 1.3 Werdykt dla pytania 1

Aplikacja **identyfikuje zmiany strukturalne na średnim poziomie szczegółowości**, ale **nie spełnia kryterium kompletności**:
- Pomija krytyczne właściwości produkcyjne (`refreshPolicy`, `lineageTag`, `dynamic format strings`, `annotations`, `dataAccessOptions`).
- Ma ryzyko kolizji klucza dla relacji wieloznacznych.
- Ma heurystyki dające fałszywe wyniki przy analizie zależności.

Dla typowego użycia (modyfikacja measure, dodanie kolumny, zmiana M w partition) → działa **poprawnie**.
Dla produkcyjnego DevOps semantic models → **niewystarczająca**.

---

## 2. Czy aplikacja poprawnie migruje zmiany do Target?

### 2.1 Co działa dobrze

- **Operacje na `rawBlock`** — kopiowanie pełnego bloku obiektu z DEV zachowuje wszystkie szczegóły TMDL (włącznie z właściwościami, których extractor nie rozumie).
- **Aktualizacja wpisów `ref`** w `model.tmdl` przy add/remove tabel, ról, perspectives, cultures.
- **Backup przed zapisem** (lokalnie — folder `definition_backup_<timestamp>`; Fabric — kopia `rawFiles` PROD do lokalnego folderu).
- **Atomowy strumień Fabric** — `deployToFabric` montuje całość modelu w `tmpDir`, aplikuje zmiany, a następnie wysyła **cały** `definition/` przez `updateSemanticModelDefinition` (zgodnie z wymaganiem Microsoft, że endpoint przyjmuje kompletne `parts[]`).
- **Detekcja tabel do odświeżenia po deploy** + integracja z Enhanced Refresh API (`/refreshes`, typ `automatic`, transactional).

### 2.2 Krytyczne defekty migracji

#### 2.2.1 BRAK obsługi `function` w `planSingleDiff`

`planSingleDiff` w deployment/deployer.js obsługuje: `table`, `column`, `measure`, `hierarchy`, `partition`, `calculationGroup`, `calculationItem`, `relationship`, `expression`, `role`, `tablePermission`, `perspective`, `culture`, `dataSource`. **Brak `function`** (UDF z TMDL 1.2 / TOM compatibility level ≥ 1605).

Skutek: każda zmiana, dodanie lub usunięcie funkcji UDF w DEV — **nigdy nie zostanie zdeployowana**. Diff się pokaże, użytkownik kliknie „Deploy", system zwróci sukces, ale plik `functions.tmdl` w Target pozostanie bez zmian. **Cichy bug.**

#### 2.2.2 BRAK obsługi `model` (model properties) w `planSingleDiff`

Diff typu `model:properties` (kultura modelu, `defaultPowerBIDataSourceVersion`) jest generowany przez extractor, ale `planSingleDiff` nie ma case'u `model` — wpada w `default` i nie generuje operacji. **Zmiany model-level są ignorowane przy migracji.**

#### 2.2.3 Nadpisywanie całego pliku tabeli przy modyfikacji table-level

`planTableOp` dla `diff.type === 2` (Modified) kopiuje **cały plik tabeli z DEV do Target**:

```js
return [{
    action: 'writeFile',
    targetPath: targetFile,
    content,  // pełna treść tables/<Name>.tmdl z DEV
    ...
}];
```

Skutek: jeżeli użytkownik zaznaczył tylko zmianę `isHidden` tabeli, ale **nie zaznaczył** np. zmiany measure X w tej samej tabeli, to **i tak measure X zostanie wgrane** (jako efekt uboczny nadpisania pliku). Łamie to obietnicę selektywnego deploymentu wyświetlaną w UI. Powinno być modyfikowane tylko nagłówek deklaracji tabeli (`table 'Name'` + jej własności bezpośrednie), nie całe drzewo dzieci.

#### 2.2.4 Brak aktualizacji `ref` dla `expression` i `dataSource` przy `createIfMissing`

`planExpressionOp` i `planDataSourceOp` zawierają `createIfMissing: true` na wypadek, gdy `expressions.tmdl` / `dataSources.tmdl` jeszcze nie istnieją. **Ale**: w TMDL po stronie modelu w `model.tmdl` mogą istnieć wpisy typu `ref namedExpression '<name>'` / `ref queryGroup '...'`. Operator dodający nowy expression do pustego pliku **nie aktualizuje** `model.tmdl`, więc Power BI może go nie załadować (zależy od wersji TMDL i obecności explicit ref).

W praktyce dla podstawowego TMDL (≤ 1500) `expressions.tmdl` jest auto-detected. Dla TMDL 1.2 z `namedExpression` jako element model-owned — brak ref skutkuje pominięciem przy ładowaniu. **Niedeterministyczne zachowanie.**

#### 2.2.5 Brak walidacji integralności / kolejności zależności

Deployer nie waliduje, czy zaznaczony zbiór zmian jest **spójny**:
- Dodanie relacji do tabeli, której nie ma w Target i której deployment nie został zaznaczony → zepsuty model.
- Dodanie measure odwołującej się do nowej kolumny, której deployment pominięto → zepsuty DAX po stronie Target.
- Usunięcie tabeli, której kolumny są używane w relacji nie zaznaczonej do usunięcia → orphan relationship.
- Usunięcie roli, która jest referencjowana w `perspective`/`culture` → broken refs.

`computeGroups` rozwiązuje to częściowo dla M dependency (parameter → expression → partition), ale **nie dla DAX dependency** (measure → measure, measure → column, calculated column → column).

#### 2.2.6 Nadpisywanie `lineageTag` Target przy modify

Skoro `replaceObjectBlock` zastępuje cały blok w Target rawBlockiem z DEV, to **`lineageTag` z Target zostaje utracony** i zastąpiony lineageTagiem z DEV. Konsekwencje:
- **Łamanie referencji z raportów PBIR** — wizualizacje w `.Report/definition` wiążą się z obiektami modelu po `lineageTag`, nie po nazwie. Po zmianie tagu kolumny w Target wszystkie powiązane wizualizacje stracą binding (objawia się jako pusty wizual z błędem „field not found").
- W Fabric workspace, gdzie jeden semantic model zasila wiele raportów — propagacja lineageTag z DEV do PROD może uszkodzić raporty bez zmian w kodzie raportów.

**Poprawne podejście:** zachować `lineageTag` istniejący w Target, podstawiając tylko właściwości semantyczne. To wymaga merge na poziomie property, a nie zastępowania całego raw bloku.

#### 2.2.7 `findObjectBlock` zakłada wcięcie tabami — brak fallbacku na spacje

Parser i writer operują na `getIndentLevel` liczącym **wyłącznie znaki `\t`**. TMDL formalnie wymaga tabów (Microsoft docs: *„TMDL is whitespace-sensitive and uses tab characters for indentation"*), ale niektóre narzędzia (edytory tekstowe z auto-konwersją) mogą produkować spacje. Wówczas:
- `getIndentLevel` zwraca 0 → cały plik traktowany jako jeden poziom → `findObjectBlock` zwraca `null` → operacja `replaceChild`/`removeChild` **cicho nic nie robi** (writer ma `if (!location) return content;`).

**Cichy failure** — deploy zwróci `success: true`, ale plik nie zmieniony.

#### 2.2.8 `appendChildBlock` nie wymusza poziomu wcięcia

```js
function appendChildBlock(content, childBlock) {
    ...
    const newLines = ['', ...childBlock.split('\n')];
    lines.splice(insertPos, 0, ...newLines);
}
```

Wkleja `rawBlock` *jak jest*. Działa, **dopóki DEV używa tej samej liczby tabów wcięcia** co Target. Jeśli rawBlock pochodzi z tabeli, gdzie wcięcie jest 1 tab (standard), a wklejany jest do tabeli w innym miejscu drzewa (np. zagnieżdżonej w calculationGroup) — wcięcia będą niepoprawne i parser TMDL po stronie Power BI rzuci błąd ładowania.

W obecnej praktyce nie ma zagnieżdżonych tabel w TMDL, więc problem teoretyczny — ale architektonicznie kruchy.

#### 2.2.9 Brak normalizacji końca pliku i pustych linii

`appendTopLevelBlock` dodaje `'\n' + newBlock + '\n'`. Wielokrotne deploye mogą skutkować akumulacją pustych linii. TMDL toleruje, ale prowadzi do nieczytelnych diffów w git.

#### 2.2.10 Backup obejmuje tylko folder `definition/`

Dla lokalnego deploymentu backup tworzy `definition_backup_<timestamp>` obok `definition/`, ale **nie kopiuje** `.pbip`, `.Report`, `definition.pbism`, `diagramLayout.json`. Jeżeli deploy zepsuje binding raportu (patrz 2.2.6), backup `definition/` pomoże tylko częściowo. Zalecane: snapshot całego `.SemanticModel/`.

#### 2.2.11 Fabric deployment — brak walidacji odpowiedzi API per-część

`updateSemanticModelDefinition` wysyła `parts[]` w jednym wywołaniu. Fabric API może zwrócić błąd typu „Inconsistent metadata" jeśli `model.tmdl` ma `ref` do tabeli, której plik nie znalazł się w `parts[]`. Aplikacja wysyła **wszystkie** `rawFiles`, więc to się nie zdarza w typowym scenariuszu — ale jeśli plik zostanie usunięty z Target (np. delete table), implementacja w `deployToFabric` nadal wysyła zawartość z `prodModel.rawFiles` (snapshot sprzed deploymentu) z lokalnymi zmianami w temp — **co dokładnie zostanie wysłane** zależy od tego, czy plik został usunięty z tempDir przed `readDirRecursive`. Plik usunięty z tempDir nie znajdzie się w `updatedFiles`, więc nie wyśle się — ale czy Fabric to interpretuje jako delete? Wg dokumentacji `updateDefinition` **zastępuje** definition całością `parts`, więc pominięcie pliku to faktycznie jego usunięcie. **W teorii OK**, w praktyce wymaga weryfikacji integracyjnej.

#### 2.2.12 Brak transakcyjności wielofajlowej

Jeśli `executeOperation` zawiedzie w środku pętli (np. zapis zakończy się błędem dysku po N operacjach), Target zostanie w stanie częściowo zaktualizowanym. Backup istnieje, ale rollback automatyczny — nie. `result.success = false` jest ustawiane, ale po stronie UI nie ma mechanizmu „restore from backup". Dla deploymentu lokalnego = ręczne przywracanie. Dla Fabric = lepiej, bo `updateDefinition` jest atomic, ale lokalny temp może być w niespójnym stanie (nieistotne — tempDir jest usuwany).

#### 2.2.13 Brak deploymentu translation files selektywnie

`planFileBasedOp` dla `culture` kopiuje cały plik. Skoro extractor traktuje translacje jako monolit, deploy też jest monolitem. Brak możliwości przeniesienia *jednej* zmiany translacji.

### 2.3 Werdykt dla pytania 2

Aplikacja **nie gwarantuje, że Target po migracji otrzyma wszystkie niezbędne informacje, aby działać poprawnie**. Konkretne ryzyka:

| Ryzyko | Klasa | Prawdopodobieństwo |
|--------|-------|---------------------|
| Brak deployu UDF (functions) | **High** | Pewne, jeśli model używa UDF |
| Brak deployu zmian model-level | **High** | Pewne dla zmian w `model.tmdl` |
| Utrata `lineageTag` w Target → broken raporty | **High** | Wysokie przy modify istniejących obiektów |
| Pominięcie zmian incremental refresh policy | **Critical** | Niewykrywalne — extractor pomija refreshPolicy |
| Brak dependency-aware ordering | **Medium** | Występuje przy selektywnym deploymencie |
| Cichy fail przy plikach ze spacjami zamiast tabów | **Medium** | Rzadkie, ale niewidoczne |
| Nadpisywanie całego pliku tabeli przy table-modify | **Medium** | Każda zmiana table-level |

Dla podstawowych przypadków (dodanie/zmiana measure, dodanie kolumny, prosta zmiana M w partition, dodanie/usunięcie tabeli z atomowym refresh) — **deployment działa i jest użyteczny**.

Dla produkcyjnego CI/CD semantic models z lineage do raportów, incremental refresh, UDF, calculation groups z annotations — **wymaga znaczącego utwardzenia** przed bezpiecznym użyciem.

---

## 3. Rekomendacje priorytetowe

### P0 (krytyczne — niefunkcjonalność lub silent failure)

1. **Dodać case `function` do `planSingleDiff`** — analogiczny do `expression` (osobny plik `functions.tmdl`, top-level append/replace/remove).
2. **Dodać case `model` do `planSingleDiff`** — modify model properties w `model.tmdl` jako replaceTopLevel z type=`model`.
3. **Wykrywać i ostrzegać przed plikami TMDL ze spacjami** zamiast tabów (twardy fail w parserze).
4. **Zachować `lineageTag` Target przy modify** — merge property-level zamiast podmiany całego rawBlocka, albo opcjonalny tryb „preserve target lineage".

### P1 (wysokie — kompletność)

5. **Rozszerzyć extractor** o właściwości: `lineageTag`, `sourceLineageTag`, `annotation`, `extendedProperty`, `refreshPolicy`, `formatStringDefinition`, `detailRowsExpression`, `summarizationSetBy`, `encoding`, `dataAccessOptions`, `tablePermissions.metadataPermission`, `columnPermission`.
6. **Zmienić identity key relacji** na GUID (`rel.name`) lub kompozyt `from + to + isActive + crossFilter`.
7. **Walidacja zależności** — przy „Deploy" sprawdzić, że wszystkie obiekty referowane przez zaznaczone diffy są obecne w Target (po zaaplikowaniu changes) lub są również zaznaczone.
8. **Atomowy table-modify** — przy zmianie tylko table-level zmieniać tylko nagłówek deklaracji, nie nadpisywać dzieci.

### P2 (średnie — jakość)

9. **Normalizacja whitespace** w porównaniu DAX/M (collapse multiple newlines, strip trailing whitespace).
10. **Per-object translation identity** w `extractCulture` — jeden diff per (culture × table × object × property).
11. **Regex z granicami słów** w `findDependentExprNames` zamiast `String.includes`.
12. **Backup całego `.SemanticModel/`** zamiast tylko `definition/`.
13. **Rollback z backupu** dostępny z UI przy `success: false`.

### P3 (niski — porządkowe)

14. Walidacja syntaktyczna TMDL po deploymencie (re-parse, sprawdzenie czy nadal się parsuje).
15. Test integracyjny z Fabric API: deploy → re-read → diff = 0.
16. Lint/format raw bloków przed zapisem.

---

## 4. Odpowiedzi w skrócie

**Pytanie 1 — Czy aplikacja poprawnie identyfikuje zmiany w modelu semantycznym po stronie Source?**

**Częściowo TAK.** Wykrywa zmiany strukturalne (Added/Removed/Modified) na poziomie obiektu, dla większości typowych właściwości. **NIE** wykrywa zmian w: `lineageTag`, `refreshPolicy`, `annotations`, `extendedProperty`, dynamic format strings, `dataAccessOptions`, column-level security, model compatibility level. Ma ryzyko kolizji klucza dla wielu relacji między tymi samymi kolumnami i daje fałszywe wyniki przy analizie zależności M.

**Pytanie 2 — Czy aplikacja poprawnie migruje zmiany do Target, tak by Target dostał wszystkie niezbędne informacje?**

**NIE w pełni.** Nie deployuje funkcji UDF, nie deployuje zmian model properties, może nadpisać `lineageTag` Target (psując raporty), nadpisuje cały plik tabeli przy zmianie table-level (przenosząc niezaznaczone zmiany dzieci), nie waliduje integralności (kolejność zależności DAX/M), cichy fail przy plikach z białymi znakami innymi niż taby. Dla podstawowych operacji (measure, column, partition, table add/remove, relationship) — działa. Dla produkcji z incremental refresh, lineage do raportów i UDF — wymaga utwardzenia (lista P0/P1 powyżej).
