# Model Alchemist — Backlog (v4.5.1)

> Ostatnia aktualizacja: 2026-06-02
> Kontekst: aplikacja porównuje i wdraża zmiany w modelach semantycznych Power BI (TMDL/PBIP) — lokalnie i przez Fabric REST API (`updateDefinition`/`getDefinition`). Posiada panel Enhanced Refresh z monitorowaniem per-obiekt.

---

## P0 — Krytyczne (blokujące produkcyjne użycie)

### Deployment & Refresh

- [ ] **Selektywny refresh per grupa** — Po deploy użytkownik wybiera, które grupy refresh ma wykonać zamiast odpalania pełnego refresha. Enhanced Refresh API obsługuje `objects[]` z listą tabel/partycji — wystarczy przekazać wybrane.
- [ ] **Detekcja zmian zdalnych (merge conflict)** — Przed deploy do Fabric wykonać `getDefinition` ponownie i porównać z wersją użytą przy Compare. Jeśli remote się zmienił → ostrzeżenie z diff'em. Zapobiega nadpisaniu cudzych zmian.
- [ ] **Obsługa Incremental Refresh partycji** — Tabele z polityką Incremental Refresh posiadają wiele partycji (historyczne + bieżące). Deploy nie powinien kasować/regenerować partycji zarządzanych przez silnik IR. Weryfikacja: sprawdzenie `refreshPolicy` w TMDL i pominięcie tabel z aktywnymi politykami IR przy operacjach strukturalnych.

### Parser & Engine

- [ ] **Obsługa `refreshPolicy` block** — Parser (`tmdl-parser.js`) nie wyciąga `refreshPolicy` jako osobnego bloku — dane IR policy nie są porównywane ani wdrażane. Dodać ekstrakcję i porównanie.
- [ ] **Circular dependency detection** — `computeGroups` zakłada acykliczność zależności między Named Expressions. BFS w `findDependentExprNames()` może zapętlić się na cyklicznych `ref`. Dodać visited-set i warning.

---

## P1 — Wysoki priorytet (znacząco poprawia użyteczność)

### Deployment

- [ ] **Side-by-side diff w potwierdzeniu deploy** — Przed `Confirm Deploy` wyświetlić porównanie kodu (TMDL blok: stary vs nowy) w modal — analogicznie do "Change Review" w Fabric Deployment Pipelines.
- [ ] **Incremental upload (partial updateDefinition)** — Zamiast uploadować pełen zestaw rawFiles do Fabric, wysłać tylko zmienione pliki. API `updateDefinition` wymaga pełnej definicji, ale można cache'ować ostatni `getDefinition` response i podmienić tylko zmodyfikowane `parts[]`.
- [ ] **Anulowanie refresh** — Enhanced Refresh API obsługuje `DELETE /refreshes/{requestId}`. Dodać przycisk "Cancel" w panelu Refresh gdy status = `inProgress`.
- [ ] **Batched commits** — Enhanced Refresh API wspiera `commitMode: "transactional"` vs `"partialBatch"`. Pozwolić użytkownikowi wybrać tryb (atomic vs partial) przed uruchomieniem refresh.

### Comparison

- [ ] **Multi-stage comparison (DEV → UAT → PROD)** — Porównanie 3+ modeli w pipeline (a'la Fabric Deployment Pipelines). Widok: tabela z ikonami ✓/✗/~ dla każdego obiektu per stage.
- [ ] **Ignore-list konfigurowalny** — Oprócz PBI_* annotations i lineageTag, pozwolić użytkownikowi zdefiniować własne wzorce property do ignorowania (np. konkretne annotations, `changedTime`).
- [ ] **Normalizacja wyrażeń SQL/M** — Ignorowanie nieistotnych różnic: trailing whitespace, komentarze SQL (`--`), kolejność `let` bindings (semantycznie ekwiwalentne). Eliminuje false positives jak bug `Financial Data`.

### UI / UX

- [ ] **Syntax highlighting w diff** — DAX highlighting dla measures/calculated columns, Power Query (M) dla partycji/expressions. Użyć lekkiej biblioteki (Prism.js / highlight.js).
- [ ] **Auto-refresh panelu Refresh** — Polling statusu (obecny wymaga manualnego kliknięcia "Check Status"). Dodać auto-poll co 3s gdy refresh jest aktywny, zatrzymanie po zakończeniu.
- [ ] **Powiadomienia systemowe** — `Notification API` w przeglądarce gdy refresh/deploy zakończy się w tle (użytkownik przełączył tab).

---

## P2 — Średni priorytet (rozszerzenie możliwości)

### CI/CD & Automatyzacja

- [ ] **CLI mode (headless)** — Uruchomienie porównania/deploya z linii poleceń bez GUI. Format: `node cli.js compare --source ./DEV --target "powerbi://..." --output report.md`. Umożliwi integrację z Azure Pipelines / GitHub Actions.
- [ ] **Git-aware deployment** — Po deploy lokalnym automatycznie git-commit zmienionych plików TMDL z opisowym commit message (lista wdrożonych obiektów). Opcjonalnie: auto-push.
- [ ] **Integracja z Fabric Deployment Pipelines** — Trigger pipeline stage promotion po successful deploy via Fabric REST API (`/deploymentPipelines/{id}/deploy`). Łączy Model Alchemist z natywnym ALM Fabric.
- [ ] **Webhook/notification na deploy** — Po zakończeniu deploy/refresh: fire webhook (Teams Incoming Webhook, Slack, generic HTTP POST). Payload: status, lista zmian, czas.

### Model Features

- [ ] **Direct Lake model awareness** — Direct Lake to nowy storage mode w Fabric. Parser powinien rozpoznawać `mode: directLake` w partycjach i prawidłowo klasyfikować refresh type (DL nie wymaga data refresh — dane z Delta Lake).
- [ ] **Calculation Group `createOrReplace` deploy** — Zamiast blokowej edycji TMDL, dla Calculation Groups użyć TMDL Scripts `createOrReplace` command (MS docs) — bezpieczniejsze wdrożenie złożonych CG.
- [ ] **Model documentation export** — Generowanie dokumentacji modelu (tabele, measures z DAX, relacje, RLS roles) jako HTML/Markdown/PDF. Opcjonalnie diagramy ERD (mermaid).
- [ ] **Perspective/Translation batch edit** — Perspektywy i tłumaczenia to powtarzalne operacje. Dodać hurtową edycję: "dodaj tabelę X do perspektywy Y" bez ręcznego deploy.

### Refresh & Monitoring

- [ ] **Refresh scheduling** — Zakolejkowanie refresh na konkretny czas (np. po godzinach pracy). Wystarczy `setTimeout` + zapis do `refresh-store.js`.
- [ ] **Refresh history per model** — Dashboard z historią refreshów per model: czas, status, duration, obiekty. Dane już persystowane w `logs/refresh/` — potrzeba jedynie UI.
- [ ] **Smart refresh type recommendation** — Na podstawie analizy zmian automatycznie sugerować `dataOnly` vs `full` vs `calculate`. Obecna logika w `detectTablesNeedingRefresh` robi to częściowo — rozszerzyć o display w UI z objaśnieniem.

---

## P3 — Niski priorytet / Nice-to-Have

- [ ] **Dark/Light theme toggle** — Dodać jasny motyw (toggle w headerze).
- [ ] **Drag & drop `.pbip` files** — Przeciągnięcie pliku na panel zamiast Browse.
- [ ] **Tabular Editor BIM import** — Opcjonalny import z formatu `model.bim` (TMSL JSON) — konwersja do wewnętrznej struktury.
- [ ] **AI review zmian** — Integracja z LLM (np. Azure OpenAI) do streszczenia zmian DAX/M w języku naturalnym. Prompt: "Co zmienia ta modyfikacja?"
- [ ] **VS Code extension** — Pakowanie jako rozszerzenie VS Code z sidebar panelem (tree view modeli, inline diff).
- [ ] **Multi-platform support** — Zastąpienie PowerShell file picker natywnym dialogiem Electron lub `<input type="file">` z `webkitdirectory` — usunięcie zależności od Windows.
- [ ] **Connection string validation** — Walidacja formatu connection string przed wywołaniem API (regex + feedback w UI). Obecne: malformed string → unhandled error.

---

## 🐛 Znane bugi

| # | Opis | Priorytet | Workaround |
|---|------|-----------|------------|
| B1 | **SQL comment false positive** — Zakomentowane linie SQL (`-- from ...`) w partition expressions powodują diff mimo braku zmian semantycznych. | P1 | Brak — ręczne odznaczenie diffa. |
| B2 | **TIME_WAIT port** — Po crashu OS blokuje port na ~30s (TCP TIME_WAIT). Auto fallback (+20 portów) łagodzi, ale nie eliminuje. | P3 | Poczekać 30s lub zmienić PORT env. |
| B3 | **`computeGroups` edge case** — Orphaned partitions (partition referująca nieistniejący expression) lub circular dependencies → potencjalne pętle/crash. | P1 | Brak. |
| B4 | **Expression compare: `let` ordering** — Power Query `let ... in` z inną kolejnością bindings jest traktowany jako zmiana mimo semantycznej equivalencji. | P2 | Brak — review manualny. |

---

## 🔧 Tech Debt

| # | Opis | Priorytet | Wpływ |
|---|------|-----------|-------|
| TD1 | **Brak automated tests** — Zero unit/integration testów dla parser, extractor, engine, deployer. Wysoka regresyjność przy zmianach. | P0 | Każda zmiana riskuje złamanie dotychczasowej logiki. |
| TD2 | **`server.js` monolith (700+ linii)** — Miesza routing Express, logikę deploy Fabric, PowerShell interop, refresh polling. Rozbić na: `routes/`, `services/fabric-deploy.js`, `services/refresh.js`. | P1 | Utrudniona nawigacja, testowanie niemożliwe. |
| TD3 | **`app.js` frontend monolith (900+ linii)** — Jeden plik z całą logiką UI. Rozbić na moduły ES (comparison, deploy, export, refresh). | P2 | Trudne utrzymanie, brak separacji odpowiedzialności. |
| TD4 | ~~**Version string × 5**~~ — ✅ Rozwiązane w v4.3.0. Jedno źródło prawdy: `package.json` → `/api/defaults` → frontend. | ~~P2~~ | — |
| TD5 | **Brak input sanitization** — Connection strings, ścieżki plików, klucze obiektów przekazywane bez walidacji. Potencjalne path traversal (choć localhost-only). | P1 | Ryzyko bezpieczeństwa przy ewentualnym wystawieniu na sieć. |
| TD6 | **Windows-only file picker** — `execFile('powershell', ...)` z .NET Forms. Brak działania na macOS/Linux. | P3 | Użytkownicy muszą być na Windows. |
| TD7 | **In-memory state (`lastComparison`, `lastProdModel`)** — Brak persystencji sesji. Restart serwera = utrata kontekstu porównania. | P2 | Użytkownik musi porównać ponownie po restartach. |
| TD8 | **Brak rate-limiting / timeout na API calls** — Fabric API polling (`pollOperation`) ma 120s hard limit, ale retry na refresh status nie ma backoff. | P3 | Przy dużych modelach Fabric może zwrócić 429. |

---

## 💡 Eksploracja (Research spikes)

| Temat | Pytanie badawcze | Referencje |
|-------|-------------------|------------|
| **Fabric Git Integration sync** | Czy można użyć Fabric Git REST API do sync'owania modeli zamiast `updateDefinition`? Git integration wspiera semantic models. | [Fabric Git Integration](https://learn.microsoft.com/fabric/cicd/git-integration/intro-to-git-integration) |
| **TMDL Scripts `createOrReplace`** | Czy Fabric/XMLA wspiera `createOrReplace` command na obiekcie bez pełnego redeploy? Byłoby szybsze niż `updateDefinition`. | [TMDL Scripts](https://learn.microsoft.com/analysis-services/tmdl/tmdl-scripts) |
| **Semantic Link (Python)** | `semantic-link-labs` pozwala programatycznie modyfikować model z notebooka Fabric. Czy można wyciągnąć API do integracji? | [Semantic Link Labs](https://github.com/microsoft/semantic-link-labs) |
| **Power BI MCP Server** | Microsoft udostępnił MCP Server dla Power BI. Zbadać czy operacje na modelu (measure CRUD, table ops) mogłyby zastąpić/uzupełnić nasz deployer. | [Power BI MCP](https://learn.microsoft.com/power-bi/developer/mcp/) |
| **TOM (Tabular Object Model) via REST** | Fabric REST API coraz bardziej pokrywa TOM. Czy `execute queries` + `refresh` API mogą zastąpić XMLA? | [Semantic Models REST](https://learn.microsoft.com/rest/api/fabric/semanticmodel/items) |
| **Diff na poziomie TOM JSON** | Alternatywa: porównywać model jako TOM JSON (model.bim) zamiast parsingu TMDL. Simpler ale mniej czytelne diff'y. | [TMSL Database Object](https://learn.microsoft.com/analysis-services/tmsl/database-object-tmsl) |

---

## 📋 Legenda priorytetów

| Priorytet | Znaczenie |
|-----------|-----------|
| **P0** | Blokuje produkcyjne użycie lub powoduje utratę danych. Naprawić przed następnym release. |
| **P1** | Znacząca poprawa jakości lub usability. Planować na najbliższy sprint. |
| **P2** | Pożądana funkcjonalność, ale nie blokuje. Backlog na kolejne sprinty. |
| **P3** | Nice-to-have. Realizować gdy jest czas lub potrzeba. |
