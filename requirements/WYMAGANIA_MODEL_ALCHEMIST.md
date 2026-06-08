# Model Alchemist — Pełna Specyfikacja Wymagań

## Spis treści

1. [Przegląd aplikacji](#1-przegląd-aplikacji)
2. [Wymagania biznesowe](#2-wymagania-biznesowe)
3. [Architektura systemu](#3-architektura-systemu)
4. [Wymagania funkcjonalne](#4-wymagania-funkcjonalne)
5. [Wymagania techniczne](#5-wymagania-techniczne)
6. [Struktura projektu](#6-struktura-projektu)
7. [Specyfikacja API](#7-specyfikacja-api)
8. [Moduły aplikacji](#8-moduły-aplikacji)
9. [Integracja z Microsoft Fabric](#9-integracja-z-microsoft-fabric)
10. [Frontend — Interfejs użytkownika](#10-frontend--interfejs-użytkownika)
11. [Proces wdrożenia (Deployment)](#11-proces-wdrożenia-deployment)
12. [System logowania i monitorowania](#12-system-logowania-i-monitorowania)
13. [Walidacja i kontrola jakości](#13-walidacja-i-kontrola-jakości)
14. [Refresh Management](#14-refresh-management)
15. [Bezpieczeństwo](#15-bezpieczeństwo)

---

## 1. Przegląd aplikacji

### 1.1 Nazwa i wersja
- **Nazwa**: Model Alchemist
- **Wersja**: 4.3.1
- **Typ**: Aplikacja webowa (Express.js + SPA)

### 1.2 Cel aplikacji
Model Alchemist to narzędzie do analizy, porównywania i wdrażania zmian w modelach semantycznych Power BI w formacie TMDL/PBIP. Umożliwia:
- Porównywanie dwóch modeli semantycznych na poziomie poszczególnych obiektów
- Selektywne wdrażanie zmian z modelu źródłowego do docelowego
- Pracę z modelami lokalnymi (pliki TMDL) oraz modelami w Microsoft Fabric (przez REST API)
- Wyzwalanie i monitorowanie Enhanced Refresh po wdrożeniu
- Tworzenie automatycznych kopii zapasowych przed wdrożeniem

### 1.3 Główne funkcjonalności
1. **Porównywanie modeli** — identyfikacja różnic między modelem DEV i PROD
2. **Wdrażanie selektywne** — wybór i aplikacja konkretnych zmian
3. **Integracja z Fabric** — odczyt i zapis modeli przez REST API
4. **Enhanced Refresh** — automatyczne odświeżanie danych z monitorowaniem statusu
5. **Backup automatyczny** — tworzenie kopii zapasowych przed wdrożeniem
6. **Export raportów** — eksport różnic do CSV, Markdown, HTML
7. **Activity log** — rejestracja wszystkich operacji w formacie JSONL

---

## 2. Wymagania biznesowe

### 2.1 Scenariusze użycia

#### Scenariusz 1: Porównanie lokalnych modeli (TMDL ↔ TMDL)
**Aktor**: Data Engineer / BI Developer  
**Cel**: Porównanie dwóch wersji modelu z repozytoriów Git lub folderów lokalnych  
**Kroki**:
1. Użytkownik wybiera folder DEV (`.SemanticModel/` lub `definition/`)
2. Użytkownik wybiera folder PROD
3. Kliknięcie "Compare Models"
4. System pokazuje listę różnic pogrupowaną według kategorii zmian
5. Użytkownik przegląda szczegóły zmian (dodane/usunięte/zmodyfikowane obiekty)

#### Scenariusz 2: Wdrożenie zmian (Deployment)
**Aktor**: Data Engineer  
**Cel**: Wdrożenie wybranych zmian z DEV do PROD  
**Kroki**:
1. Po wykonaniu porównania użytkownik zaznacza zmiany do wdrożenia
2. Kliknięcie "Deploy Selected"
3. System pokazuje preview operacji (dry-run)
4. Użytkownik potwierdza wdrożenie
5. System tworzy backup PROD (jeśli włączony)
6. System aplikuje zmiany do plików TMDL lub uploaduje do Fabric
7. System pokazuje podsumowanie wykonanych operacji
8. System sugeruje refresh dla tabel wymagających odświeżenia danych

#### Scenariusz 3: Praca z Fabric (TMDL ↔ Fabric)
**Aktor**: BI Developer z dostępem do Fabric  
**Cel**: Porównanie lokalnego modelu z modelem live w Fabric  
**Kroki**:
1. Użytkownik loguje się do Fabric (OAuth2 + PKCE)
2. Wybiera lokalny folder jako DEV
3. Wkleja connection string Fabric jako PROD
4. System weryfikuje dostęp do Fabric
5. Kliknięcie "Compare Models"
6. System pobiera definicję modelu z Fabric przez REST API
7. System pokazuje różnice
8. Użytkownik wdraża zmiany bezpośrednio do Fabric

#### Scenariusz 4: Enhanced Refresh
**Aktor**: Data Engineer  
**Cel**: Odświeżenie danych po wdrożeniu zmian strukturalnych  
**Kroki**:
1. Po wdrożeniu system identyfikuje tabele wymagające odświeżenia
2. System pokazuje panel Refresh z rekomendowanym typem refresh (full/dataOnly/calculate)
3. Użytkownik uruchamia refresh
4. System monitoruje status w czasie rzeczywistym
5. Po zakończeniu fazy dataOnly system automatycznie wyzwala calculate
6. System zapisuje historię refresh do plików JSONL

### 2.2 Wymagania niefunkcjonalne

#### Wydajność
- Porównanie modelu z 100+ tabelami: < 5 sekund
- Deployment 50 zmian: < 10 sekund (lokalny), < 30 sekund (Fabric)
- Refresh status polling: co 2 sekundy bez obciążania przeglądarki

#### Dostępność
- System działa lokalnie (localhost) — nie wymaga dostępu do sieci (poza Fabric integration)
- Pojedynczy użytkownik na instancję (desktop app model)
- Auto-restart w trybie dev: `npm run dev`

#### Bezpieczeństwo
- OAuth2 Authorization Code + PKCE dla Fabric (brak przechowywania haseł)
- Access token tylko w pamięci (nie zapisywany na dysku)
- Default client ID: Power BI Desktop public client
- Backup przed wdrożeniem (włączony domyślnie)

#### Użyteczność
- Single Page Application (SPA) — brak przeładowań strony
- Responsywny design (obsługa ekranów 1366px+)
- Grupowanie różnic według kategorii
- Możliwość expand/collapse wszystkich grup jednym kliknięciem
- Persist wyboru ścieżek w localStorage
- Auto-verify Fabric access przed porównaniem

---

## 3. Architektura systemu

### 3.1 Stos technologiczny

#### Backend
- **Runtime**: Node.js v18+ (testowane na v24)
- **Framework**: Express.js 4.21+
- **Authentication**: @azure/msal-node 2.16+
- **Protocol**: HTTP/1.1, JSON API
- **Port**: 3001 (configurable via `PORT` env var)

#### Frontend
- **Framework**: Vanilla JavaScript (ES6+)
- **UI**: HTML5 + CSS3 (custom design system)
- **State management**: In-memory + localStorage
- **Communication**: Fetch API (async/await)

#### Storage
- **Models**: Filesystem (TMDL files) + Microsoft Fabric REST API
- **Backups**: Local filesystem (`backups/` directory)
- **Logs**: JSONL files (`logs/activity.jsonl`, `logs/refresh/<model>/*.jsonl`)
- **Session state**: In-memory (server) + localStorage (browser)

### 3.2 Wzorce architektoniczne

#### 1. Model-View-Controller (MVC) — zmodyfikowany
- **Model**: `parser/`, `comparison/`, `deployment/` (business logic)
- **View**: `public/` (HTML/CSS/JS frontend)
- **Controller**: `server.js` (Express routes)

#### 2. Separation of Concerns
- **Parser** — odpowiedzialny za parsowanie TMDL
- **Comparison Engine** — algorytm porównywania modeli
- **Deployment Engine** — aplikacja zmian
- **Fabric Integration** — komunikacja z API
- **Validator** — walidacja zależności

#### 3. Single Source of Truth
- Wersja aplikacji: tylko w `package.json`
- Ścieżki modeli: localStorage (browser) + in-memory state (server)
- Wynik porównania: przechowywany w serwerze do czasu nowego porównania

#### 4. Progressive Enhancement
- Core functionality działa bez Fabric (local-only mode)
- Fabric integration jest opcjonalna (feature toggle)
- Refresh panel pojawia się tylko po wdrożeniu do Fabric

---

## 4. Wymagania funkcjonalne

### F1: Ładowanie modelu z folderu TMDL

**Input**: Ścieżka do folderu `.SemanticModel/` lub `definition/`  
**Output**: Obiekt modelu z pełną strukturą

**Kroki**:
1. Sprawdzenie istnienia `definition.pbism`
2. Walidacja wersji formatu (`version >= 4.0`)
3. Parsowanie `database.tmdl` (compatibilityLevel, ID)
4. Parsowanie `model.tmdl` (konfiguracja, ref ordering)
5. Parsowanie `relationships.tmdl` (wszystkie relacje)
6. Parsowanie `expressions.tmdl` (shared M queries, parametry)
7. Opcjonalnie: `dataSources.tmdl`, `functions.tmdl`
8. Parsowanie wszystkich plików w `tables/*.tmdl`
9. Parsowanie plików w `roles/`, `perspectives/`, `cultures/`
10. Budowanie słowników obiektów z kluczami identyfikacji

**Implementacja**: `parser/model-loader.js::loadModelFromFolder()`

### F2: Parsowanie plików TMDL

**Wymagania parsera**:
- Obsługa indentacji tabulatorami (semantyczna)
- Obsługa single-quote escaping dla nazw
- Obsługa multi-line expressions (DAX, M)
- Obsługa boolean shorthand (`isHidden` = `isHidden: true`)
- Obsługa `ref` keyword dla porządkowania kolekcji
- Obsługa backtick-verbatim blocks
- Zachowanie raw text bloków dla każdego obiektu (deployment)

**Implementacja**: `parser/tmdl-parser.js::parseTmdlFile()`

### F3: Porównywanie dwóch modeli

**Input**: Model A, Model B  
**Output**: Lista różnic (diffs) z kategoryzacją

**Algorytm**:
1. Ekstrakcja wszystkich obiektów z obu modeli do słowników `{ identityKey → object }`
2. Obliczenie trzech zbiorów:
   - **Added** (B \ A): obiekty w B nieobecne w A
   - **Removed** (A \ B): obiekty w A nieobecne w B
   - **Modified** (A ∩ B): obiekty obecne w obu z różnymi właściwościami
3. Dla każdego modified object: obliczenie property-level diffs
4. Filtrowanie PBI_* annotations (wewnętrzne Power BI)
5. Ignorowanie `lineageTag`, `sourceLineageTag` (auto-generated)
6. Grupowanie różnic według change groups (see F4)

**Implementacja**: `comparison/engine.js::compareModels()`

### F4: Grupowanie różnic (Change Groups)

**Kategorie zmian**:
- `SCHEMA` — strukturalne zmiany (tabele, kolumny, typy danych)
- `CALCULATION` — miary, calculated columns, calculation items
- `RELATIONSHIP` — relacje między tabelami
- `SECURITY` — role, RLS, OLS
- `HIERARCHY` — hierarchie i poziomy
- `TRANSLATION` — kultury i tłumaczenia
- `METADATA` — annotations, descriptions, display folders
- `DATASOURCE` — źródła danych, partycje, wyrażenia M
- `VISUAL` — perspectives, perspectiveTable/Measure/Column
- `ADVANCED` — calculation groups, KPIs, UDFs

**Grouping logic**:
- Atomic groups — operacje muszą być wykonane razem (np. usunięcie kolumny + jej relationships)
- Parameter groups — zmiana parametru Query + wszystkie zależne tabele
- Cascade groups — automatyczne dołączanie zależności (np. orphaned relationships)

**Implementacja**: `comparison/extractor.js::computeGroups()`

### F5: Wdrażanie zmian (Deployment)

**Input**: Lista selected diffs, model DEV, ścieżka PROD  
**Output**: Wynik wdrożenia (success, actions, errors, warnings)

**Pre-deployment validation**:
1. Sprawdzenie zależności (validator)
2. Sprawdzenie compatibility level (auto-bump jeśli potrzebny)
3. Wykrycie orphaned relationships (auto-cascade)
4. Sprawdzenie, czy parent tables istnieją dla dodawanych child objects

**Deployment strategies**:

| Object type | Add | Remove | Modify |
|-------------|-----|--------|--------|
| Table | Kopiuj `.tmdl` file | Usuń `.tmdl` file | Replace header w file |
| Column | Append block w table file | Remove block z table file | Replace block |
| Measure | Append block | Remove block | Replace block |
| Relationship | Append block w `relationships.tmdl` | Remove block | Replace block (by GUID) |
| Expression | Append block w `expressions.tmdl` | Remove block | Replace block |
| Role | Kopiuj `.tmdl` file | Usuń `.tmdl` file | Replace blocks w file |
| Perspective | Kopiuj `.tmdl` file | Usuń `.tmdl` file | Replace blocks w file |
| Culture | Kopiuj `.tmdl` file | Usuń `.tmdl` file | Replace blocks w file |

**Backup strategy**:
- Default path: `backups/` w root projektu
- Naming: `<ModelName>.SemanticModel_backup_<ISO-timestamp>/`
- Content: pełna kopia `definition/` + `definition.pbism` + `diagramLayout.json`
- Opcja user-defined backup path (persisted w localStorage)

**Implementacja**: `deployment/deployer.js::deployChanges()`

### F6: Wdrażanie do Fabric

**Flow**:
1. Walidacja (jak F5)
2. Backup (opcjonalny): zapis rawFiles do backups/
3. Zapis PROD rawFiles do temp directory
4. Uruchomienie deployer przeciwko temp dir (jak deployment lokalny)
5. Odczyt zmodyfikowanych plików z temp dir
6. Upload definicji do Fabric przez REST API
7. Cleanup temp directory

**Implementacja**: `server.js::deployToFabric()`

### F7: Ładowanie modelu z Fabric

**Input**: Connection string Power BI  
**Output**: Obiekt modelu z pełną strukturą

**Przykład connection string**:
```
Data Source=powerbi://api.powerbi.com/v1.0/myorg/WorkspaceName;Initial Catalog=ModelName;
```

**Flow**:
1. Parsowanie connection string (extract workspace, model name)
2. Wywołanie Fabric REST API: `POST /workspaces/{workspaceId}/semanticModels/{semanticModelId}/getDefinition`
3. Polling operacji długotrwałej (status endpoint)
4. Pobranie `definition.parts` (słownik plików TMDL)
5. Konwersja do wewnętrznej struktury (jak `loadModelFromFolder`)

**Implementacja**:
- `fabric/connection-parser.js::parseConnectionString()`
- `fabric/api-client.js::getSemanticModelDefinition()`
- `fabric/model-loader.js::loadModelFromFabric()`

### F8: Autentykacja Fabric (OAuth2)

**Metoda**: Authorization Code + PKCE (Proof Key for Code Exchange)  
**Provider**: Microsoft Entra ID  
**Client**: Power BI Desktop public client (`ea0616ba-638b-4df5-95b9-636659ae5121`)  
**Scopes**: `https://analysis.windows.net/powerbi/api/.default`

**Flow**:
1. Użytkownik klika "Connect to Fabric"
2. System otwiera system browser (Windows `start`)
3. Użytkownik loguje się w przeglądarce
4. Authorization code wraca do localhost callback
5. MSAL wymienia code na access token
6. Access token przechowywany w pamięci serwera
7. Token używany do wszystkich API calls (header: `Authorization: Bearer <token>`)

**Implementacja**: `fabric/auth.js`

### F9: Enhanced Refresh Management

**Typy refresh**:
- `full` — pełne odświeżenie tabeli (schema + data + relationships)
- `dataOnly` — tylko dane (bez schema changes)
- `calculate` — przeliczenie calculated tables i relacji (bez pobierania danych)
- `automatic` — Fabric decyduje (domyślnie full)

**Auto-detect refresh type** (per-table):
| Zmiana | Typ refresh |
|--------|-------------|
| Nowa tabela dodana | `full` |
| Nowa kolumna z sourceColumn | `dataOnly` |
| Calculated column expression | `calculate` |
| Calculated table (mode: calculated) | `calculate` |
| Partition expression | `dataOnly` |
| Calculation item add/remove | `calculate` (dla CG table) |
| Parametr Query zmieniony | `dataOnly` (dla dependent tables) |
| Named expression (shared M query) | `dataOnly` (all dependent) lub `full` model |

**Two-phase refresh**:
1. Faza 1: `dataOnly` refresh tabel wymagających danych
2. Faza 2: automatyczny `calculate` na poziomie modelu (rebuild relationships)

**Implementacja**:
- Detection: `server.js::detectTablesNeedingRefresh()`
- Trigger: `POST /api/fabric/refresh`
- Status: `GET /api/fabric/refresh/status/:requestId`
- Storage: `lib/refresh-store.js`

### F10: Export raportów

**Formaty**:
1. **CSV** — lista różnic z metadanymi
2. **Markdown** — raport z side-by-side code diffs
3. **HTML** — standalone report z embedded CSS

**Zawartość raportu**:
- Metadata: DEV model, PROD model, timestamp
- Summary: liczba Added/Removed/Modified per change group
- Szczegółowa lista różnic:
  - Identity key, display name, object type, change type
  - Property diffs: property name, old value, new value
  - Side-by-side code diff (dla expressions)

**Implementacja**: `public/js/app.js::exportDiffs()`

---

## 5. Wymagania techniczne

### 5.1 Platforma
- **System operacyjny**: Windows 10/11 (native file picker używa Windows Forms dialogs)
- **Node.js**: v18+ (tested on v24)
- **PowerShell**: 5.1+ (dla file picker)

### 5.2 Instalacja Node.js

**Metoda 1 — winget** (rekomendowana):
```powershell
winget install OpenJS.NodeJS.LTS
```

**Metoda 2 — instalator**:
1. Pobierz z https://nodejs.org/
2. Uruchom instalator MSI
3. Restart terminala

**Weryfikacja**:
```powershell
node --version   # powinno wyświetlić v18.x.x lub wyżej
npm --version    # powinno wyświetlić 9.x.x lub wyżej
```

### 5.3 Zależności (Dependencies)

**package.json**:
```json
{
  "name": "model-alchemist",
  "version": "4.3.1",
  "description": "Semantic Model Analysis, Comparison and Deployment Tool (TMDL + Fabric XMLA)",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "@azure/msal-node": "^2.16.0",
    "express": "^4.21.0"
  }
}
```

### 5.4 Zmienne środowiskowe

| Zmienna | Opis | Domyślna wartość |
|---------|------|-----------------|
| `PORT` | Port HTTP serwera | `3001` |

---

## 6. Struktura projektu

```
model_alchemist/
├── server.js                   # Express server (API + static files)
├── package.json                # Dependencies, scripts, version (SSOT)
├── README.md                   # User documentation
├── RELEASE_NOTES.md            # Version history, features
├── LICENSE                     # MIT license
├── .gitignore                  # Git ignored files (node_modules, backups, logs)
│
├── public/                     # Frontend (SPA)
│   ├── index.html              # Main HTML (connection panel + results panel)
│   ├── css/
│   │   └── style.css           # All styles (design system, components, modals)
│   └── js/
│       └── app.js              # Frontend logic (state, events, API calls, rendering)
│
├── parser/                     # TMDL parser
│   ├── tmdl-parser.js          # Parsuje pliki TMDL do obiektów
│   └── model-loader.js         # Ładuje cały model z folderu definition/
│
├── comparison/                 # Comparison engine
│   ├── engine.js               # Algorytm porównywania (F3)
│   └── extractor.js            # Ekstrakcja obiektów, identity keys, grouping
│
├── deployment/                 # Deployment engine
│   ├── deployer.js             # Główna logika wdrażania (F5)
│   ├── tmdl-writer.js          # Manipulacja bloków TMDL w plikach
│   └── validator.js            # Walidacja zależności, compatibility level
│
├── fabric/                     # Microsoft Fabric integration
│   ├── auth.js                 # MSAL OAuth (browser popup, PKCE)
│   ├── api-client.js           # Fabric REST API client
│   ├── model-loader.js         # Konwertuje Fabric TMDL do internal format
│   └── connection-parser.js    # Parsuje Power BI connection strings
│
├── lib/                        # Shared utilities
│   ├── activity-log.js         # Activity log writer (JSONL)
│   └── refresh-store.js        # Refresh session persistence
│
├── backups/                    # Backup directory (gitignored)
│   └── <ModelName>.SemanticModel_backup_<timestamp>/
│       └── definition/
│
└── logs/                       # Logs directory (gitignored)
    ├── activity.jsonl          # All operations (compare, deploy, refresh)
    └── refresh/                # Refresh session logs
        └── <ModelName>/
            └── <date>_<session>.jsonl
```

---

## 7. Specyfikacja API

### 7.1 Server endpoints

#### GET `/api/version`
**Opis**: Zwraca wersję aplikacji  
**Response**:
```json
{
  "version": "4.3.1"
}
```

#### GET `/api/defaults`
**Opis**: Zwraca defaultowe ustawienia (version, backupPath)  
**Response**:
```json
{
  "version": "4.3.1",
  "backupPath": "D:\\path\\to\\model_alchemist\\backups"
}
```

#### POST `/api/compare`
**Opis**: Porównuje dwa modele (local-local lub mixed mode)  
**Request body**:
```json
{
  "devPath": "D:\\Models\\DEV.SemanticModel\\definition",
  "prodPath": "D:\\Models\\PROD.SemanticModel\\definition"
}
```
**Response**:
```json
{
  "devModelName": "DEV Model",
  "prodModelName": "PROD Model",
  "devSource": "D:\\...",
  "prodSource": "D:\\...",
  "timestamp": "2026-05-28T10:30:00.000Z",
  "diffs": [
    {
      "type": 0,
      "objectType": "measure",
      "identityKey": "table:Sales|measure:Total Sales",
      "displayName": "Total Sales",
      "modelName": "DEV Model",
      "changeGroup": "CALCULATION",
      "parentTable": "Sales",
      "sourceFile": "tables/Sales.tmdl",
      "rawBlock": "measure 'Total Sales' = SUM(Sales[Amount])",
      "propertyDiffs": [
        { "propertyName": "expression", "devValue": "SUM(Sales[Amount])", "prodValue": null }
      ]
    }
  ],
  "groups": [...],
  "summary": {
    "SCHEMA": 5,
    "CALCULATION": 12,
    "RELATIONSHIP": 3
  }
}
```

#### POST `/api/compare/fabric`
**Opis**: Porównuje modele z co najmniej jednym źródłem Fabric  
**Request body**:
```json
{
  "devSource": {
    "type": "fabric",
    "workspaceId": "abc-123",
    "semanticModelId": "def-456"
  },
  "prodSource": {
    "type": "local",
    "path": "D:\\Models\\PROD.SemanticModel\\definition"
  }
}
```
**Response**: Jak `/api/compare`

#### POST `/api/deploy/preview`
**Opis**: Dry-run deployment (preview operacji bez wykonania)  
**Request body**:
```json
{
  "selectedKeys": [
    "table:Sales|measure:Total Sales",
    "relationship:Sales.CustomerId->Customer.Id"
  ]
}
```
**Response**:
```json
{
  "success": true,
  "actions": [
    { "type": "dryrun", "action": "add", "objectType": "measure", "name": "Total Sales", "file": "tables/Sales.tmdl" }
  ],
  "errors": [],
  "warnings": []
}
```

#### POST `/api/deploy`
**Opis**: Wykonuje deployment wybranych zmian  
**Request body**:
```json
{
  "selectedKeys": ["table:Sales|measure:Total Sales"],
  "dryRun": false,
  "backup": true,
  "backupPath": "D:\\Backups"
}
```
**Response**:
```json
{
  "success": true,
  "actions": [
    { "type": "backup", "message": "Backup created: D:\\Backups\\..." },
    { "type": "applied", "action": "add", "objectType": "measure", "name": "Total Sales" }
  ],
  "errors": [],
  "warnings": [],
  "backupPath": "D:\\Backups\\Model.SemanticModel_backup_2026-05-28T10-30-00",
  "tablesNeedingRefresh": {
    "refreshType": "dataOnly",
    "tables": [
      { "table": "Sales", "refreshType": "dataOnly", "reason": "new calculated column" }
    ],
    "isFullModel": false
  }
}
```

#### POST `/api/fabric/auth/login`
**Opis**: Inicjuje OAuth2 login (otwiera browser)  
**Request body**:
```json
{
  "clientId": "ea0616ba-638b-4df5-95b9-636659ae5121"
}
```
**Response**:
```json
{
  "success": true,
  "message": "Login initiated. Complete authentication in browser."
}
```

#### POST `/api/fabric/auth/cancel`
**Opis**: Anuluje login w trakcie  
**Response**:
```json
{
  "success": true
}
```

#### POST `/api/fabric/auth/disconnect`
**Opis**: Logout (usuwa access token z pamięci)  
**Response**:
```json
{
  "success": true
}
```

#### GET `/api/fabric/auth/status`
**Opis**: Sprawdza status połączenia z Fabric  
**Response**:
```json
{
  "connected": true,
  "account": {
    "username": "user@company.com",
    "name": "John Doe"
  }
}
```

#### POST `/api/fabric/resolve`
**Opis**: Weryfikuje dostęp do modelu w Fabric (resolve connection string)  
**Request body**:
```json
{
  "connectionString": "Data Source=powerbi://api.powerbi.com/v1.0/myorg/MyWorkspace;Initial Catalog=MyModel;"
}
```
**Response**:
```json
{
  "success": true,
  "workspaceId": "abc-123",
  "semanticModelId": "def-456",
  "modelName": "MyModel"
}
```

#### POST `/api/fabric/refresh`
**Opis**: Wyzwala Enhanced Refresh na Fabric semantic model  
**Request body**:
```json
{
  "workspaceId": "abc-123",
  "semanticModelId": "def-456",
  "modelName": "MyModel",
  "tables": [
    { "table": "Sales", "refreshType": "dataOnly" },
    { "table": "Customer", "refreshType": "full" }
  ],
  "refreshType": "dataOnly",
  "options": {
    "commitMode": "transactional",
    "maxParallelism": 2,
    "retryCount": 3,
    "needsPostCalculate": true
  }
}
```
**Response**:
```json
{
  "success": true,
  "requestId": "abc-def-ghi",
  "status": "inProgress"
}
```

#### GET `/api/fabric/refresh/status/:requestId`
**Opis**: Pobiera status refresh operation  
**Response**:
```json
{
  "id": "abc-def-ghi",
  "status": "inProgress",
  "objects": [
    {
      "table": "Sales",
      "partition": "Sales-Part1",
      "status": "inProgress",
      "startTime": "2026-05-28T10:30:00.000Z"
    }
  ],
  "postCalculate": {
    "triggered": true,
    "requestId": "xyz-789",
    "status": "inProgress"
  }
}
```

#### GET `/api/activity-log`
**Opis**: Pobiera ostatnie wpisy z activity log  
**Query params**: `?limit=200`  
**Response**:
```json
{
  "events": [
    {
      "timestamp": "2026-05-28T10:30:00.000Z",
      "event": "compare",
      "mode": "local-local",
      "devSource": "D:\\...",
      "prodSource": "D:\\...",
      "diffCount": 15,
      "success": true
    }
  ]
}
```

#### POST `/api/pick-file`
**Opis**: Otwiera natywny folder picker (PowerShell FolderBrowserDialog)  
**Response**:
```json
{
  "success": true,
  "path": "D:\\Models\\MyModel.SemanticModel"
}
```

---

## 8. Moduły aplikacji

### 8.1 Parser Module (`parser/`)

#### `tmdl-parser.js`

**Funkcja**: `parseTmdlFile(content, filePath)`  
**Opis**: Parsuje pojedynczy plik TMDL do listy obiektów  
**Input**:
- `content` (string) — zawartość pliku TMDL
- `filePath` (string) — ścieżka pliku (dla error reporting)

**Output**: Array obiektów, każdy z:
- `type` — typ obiektu (table, measure, column, etc.)
- `name` — nazwa obiektu (extracted i unquoted)
- `properties` — słownik właściwości
- `children` — array child objects (dla nested structures)
- `rawBlock` — oryginalny tekst bloku (dla deployment)
- `startLine`, `endLine` — pozycja w pliku

**Kluczowe zasady parsowania**:
1. Indentacja **tabulatorami** jest semantyczna
2. Nazwy w single quotes (`'Sales Amount'`) — unescape doubled quotes
3. Boolean shorthand: `isHidden` = `isHidden: true`
4. Property assignment: `name: value` lub `name = expression`
5. Multi-line expressions: indentowane o jeden poziom głębiej
6. Backtick blocks: ` ``` expression ``` ` — verbatim text
7. Komentarze: `//` (skip line), `///` (description — merge do next object)
8. Ref entries: `ref table Calendar` — tylko rejestracja (nie pełny obiekt)

#### `model-loader.js`

**Funkcja**: `loadModelFromFolder(folderPath)`  
**Opis**: Ładuje cały model z folderu `definition/`  
**Input**: Ścieżka do `.SemanticModel/` lub `definition/`  
**Output**: Obiekt modelu:
```javascript
{
  name: 'Model Name',
  compatibilityLevel: 1566,
  tables: Map { 'TableName' → tableObject },
  relationships: Array,
  expressions: Map { 'ExpressionName' → expressionObject },
  roles: Map,
  perspectives: Map,
  cultures: Map,
  functions: Map,
  dataSources: Map,
  rawFiles: Map { 'relativePath' → 'content' }  // dla deployment
}
```

**Logika**:
1. Resolve path (obsługa `.SemanticModel/`, `definition/`, parent folders)
2. Sprawdź `definition.pbism` → parse version
3. Parse `database.tmdl` → extract compatibilityLevel
4. Parse `model.tmdl` → extract model config + ref ordering
5. Parse `relationships.tmdl`
6. Parse `expressions.tmdl`
7. Dla każdego pliku w `tables/*.tmdl`: parse table + children
8. Dla każdego pliku w `roles/*.tmdl`, `perspectives/*.tmdl`, `cultures/*.tmdl`
9. Zachowaj wszystkie rawFiles (klucz: względna ścieżka, wartość: content)

### 8.2 Comparison Module (`comparison/`)

#### `extractor.js`

**Funkcja**: `extractAll(model)`  
**Opis**: Ekstrahuje wszystkie obiekty z modelu do flat dictionary  
**Output**: Map `{ identityKey → extractedObject }`

**Extracted object**:
```javascript
{
  objectType: 'measure',
  identityKey: 'table:Sales|measure:Total Sales',
  displayName: 'Total Sales',
  modelName: 'Model Name',
  changeGroup: 'CALCULATION',
  parentTable: 'Sales',
  sourceFile: 'tables/Sales.tmdl',
  rawBlock: 'measure \'Total Sales\' = ...',
  properties: {
    expression: 'SUM(Sales[Amount])',
    formatString: '$ #,##0',
    isHidden: false
  }
}
```

**Identity key format**:
| Object type | Key format |
|-------------|-----------|
| table | `table:<name>` |
| column | `table:<table>\|column:<name>` |
| measure | `table:<table>\|measure:<name>` |
| hierarchy | `table:<table>\|hierarchy:<name>` |
| relationship | `relationship:<from>.<col>-><to>.<col>` (semantic) lub `relationship:<GUID>` |
| expression | `expression:<name>` |
| role | `role:<name>` |
| perspective | `perspective:<name>` |

**Funkcja**: `computeGroups(diffs, devObjects)`  
**Opis**: Grupuje różnice w logiczne atomic groups i parameter groups  
**Output**: Array grup:
```javascript
{
  groupId: 'cascade_Sales_CustomerId',
  groupType: 'cascade',
  isAtomic: true,
  memberKeys: ['table:Sales|column:CustomerId', 'relationship:Sales.CustomerId->Customer.Id'],
  displayName: 'Remove column Sales.CustomerId + 1 dependent relationship',
  reason: 'Column removal cascades to relationships'
}
```

#### `engine.js`

**Funkcja**: `compareModels(devModel, prodModel, devPath, prodPath)`  
**Opis**: Główny algorytm porównywania (F3)  
**Output**: Comparison result (see API section)

**Logika**:
1. `extractAll(devModel)` → `devObjects`
2. `extractAll(prodModel)` → `prodObjects`
3. Compute **Added**: `devObjects \ prodObjects`
4. Compute **Removed**: `prodObjects \ devObjects`
5. Compute **Modified**: dla każdego key w `devObjects ∩ prodObjects`:
   - `computePropertyDiffs(dev.properties, prod.properties)`
   - Jeśli są różnice → dodaj do Modified
6. Filtruj: PBI_* annotations, lineageTag
7. `computeGroups(diffs, devObjects)` → atomic groups
8. Compute summary per change group
9. Return result

### 8.3 Deployment Module (`deployment/`)

#### `validator.js`

**Funkcja**: `validateDependencies(selectedDiffs, devModel, prodModel)`  
**Opis**: Waliduje zależności przed deployment  
**Output**:
```javascript
{
  warnings: [
    { code: 'COMPAT_LEVEL_AUTO_BUMP', identityKey: '...', message: '...' }
  ],
  errors: [
    { code: 'MISSING_PARENT_TABLE', identityKey: '...', message: '...' }
  ],
  cascadeRels: [
    { displayName: 'Sales->Customer', relName: 'rel-guid-123', reason: 'Column Sales.CustomerId removed' }
  ]
}
```

**Checks**:
1. **Compatibility level** — czy target model ma wystarczający compatibilityLevel dla nowych features (np. UDF requires >= 1702)
2. **Parent table existence** — czy dodawane child objects (column, measure) mają parent table w target po deployment
3. **Relationship endpoints** — czy dodawane relationships mają obie kolumny w target
4. **Orphaned relationships** — czy usuwane tabele/kolumny nie zostawiają orphaned relationships (auto-cascade)
5. **Calculation group dependencies** — czy calculation items nie referencują usuniętych miar

**Auto-cascade logic**:
- Usunięcie kolumny → automatyczne usunięcie relationships używających tej kolumny
- Usunięcie tabeli → automatyczne usunięcie wszystkich relationships z/do tej tabeli
- Dodane do `warnings` jako `CASCADE_AUTO_INCLUDED`

#### `deployer.js`

**Funkcja**: `deployChanges(selectedDiffs, devModel, prodPath, options)`  
**Opis**: Główna logika deployment (F5)  
**Options**:
```javascript
{
  dryRun: false,
  backup: true,
  backupPath: 'D:\\Backups',
  prodModel: <optional loaded PROD model>
}
```

**Flow**:
1. **Validation**: `validateDependencies()` → jeśli hard errors i nie dryRun → abort
2. **Backup**: jeśli `backup && !dryRun`:
   - Stwórz folder `backupPath/<ModelName>_backup_<timestamp>/`
   - Kopiuj wszystkie pliki z `definition/` + `definition.pbism` + `diagramLayout.json`
3. **Plan operations**: `planFileOperations(selectedDiffs)` → lista operacji per plik
4. **Execute operations** (jeśli nie dryRun):
   - Dla każdej operacji: call `executeOperation(op)`
   - Log do `result.actions`
5. **Detect refresh needs**: `detectTablesNeedingRefresh(selectedDiffs)`
6. **Return result**

**Operation types**:
- `addFile` — skopiuj plik z DEV do PROD (nowa table, role, etc.)
- `removeFile` — usuń plik z PROD
- `addTopLevel` — append block do pliku (np. nowy relationship w `relationships.tmdl`)
- `removeTopLevel` — remove block z pliku
- `replaceTopLevel` — replace block w pliku
- `addChild` — append child block w table file
- `removeChild` — remove child block z table file
- `replaceChild` — replace child block w table file
- `replaceTableHeader` — zmień właściwości na poziomie table declaration
- `ensureModelProperty` — dodaj lub zmień property w `model.tmdl`
- `bumpCompatLevel` — zwiększ compatibilityLevel w `database.tmdl`

#### `tmdl-writer.js`

**Funkcje do manipulacji bloków TMDL**:

- `findObjectBlock(content, objectType, objectName)` → `{ start, end, text }`
- `findTopLevelBlock(content, identityKey)` → `{ start, end, text }`
- `removeObjectBlock(content, start, end)` → `newContent`
- `replaceObjectBlock(content, start, end, newBlock)` → `newContent`
- `appendTopLevelBlock(content, newBlock)` → `newContent`
- `appendChildBlock(content, parentType, parentName, childBlock, indent)` → `newContent`
- `addRefEntry(content, refType, refName)` → `newContent`
- `removeRefEntry(content, refType, refName)` → `newContent`
- `ensureModelProperty(content, propertyName, value)` → `newContent`
- `ensureTopLevelProperty(content, propertyName, value)` → `newContent`

**Kluczowe zasady manipulacji**:
1. Zachowaj indentację (tabs)
2. Zachowaj quote escaping dla nazw
3. Dla relationships: znajdź blok po GUID (targetRelName z diff), replace z DEV block
4. Dla top-level append: dodaj przed ostatnią pustą linią (jeśli istnieje)
5. Dla child append: znajdź parent block → append przed końcem bloku (respectuj indent)

### 8.4 Fabric Module (`fabric/`)

#### `auth.js`

**MSAL Configuration**:
```javascript
{
  auth: {
    clientId: 'ea0616ba-638b-4df5-95b9-636659ae5121',  // Power BI Desktop public client
    authority: 'https://login.microsoftonline.com/organizations'
  }
}
```

**Funkcje**:
- `loginInteractive(clientId)` — inicjuje login przez browser (zwraca Promise<accessToken>)
- `cancelLogin()` — anuluje login w trakcie
- `getAccessToken()` — zwraca cached access token (lub null)
- `logout()` — czyści cached token i account info
- `getAccountInfo()` — zwraca { username, name } lub null

**Flow**:
1. `loginInteractive()` → tworzy MSAL PublicClientApplication
2. `acquireTokenInteractive()` → otwiera browser przez `openBrowser(url)`
3. User loguje się w przeglądarce
4. Authorization code wraca do localhost callback
5. MSAL wymienia code na token (PKCE)
6. Token cachowany w `cachedAccessToken` (memory only)
7. Account info w `currentAccount`

#### `api-client.js`

**Base URLs**:
- Fabric API: `https://api.fabric.microsoft.com/v1`
- Power BI API: `https://api.powerbi.com/v1.0/myorg`

**Funkcje**:

1. `listWorkspaces(accessToken)` → Array workspace objects
2. `getWorkspace(accessToken, workspaceName)` → workspace object with ID
3. `listSemanticModels(accessToken, workspaceId)` → Array semantic models
4. `getSemanticModel(accessToken, workspaceId, modelName)` → model object with ID
5. `getSemanticModelDefinition(accessToken, workspaceId, semanticModelId)` → definition.parts
6. `updateSemanticModelDefinition(accessToken, workspaceId, semanticModelId, definitionParts)` → void
7. `triggerEnhancedRefresh(accessToken, workspaceId, semanticModelId, refreshRequest)` → { requestId, status }
8. `getRefreshStatus(accessToken, workspaceId, semanticModelId, requestId)` → status object

**Long-running operation handling**:
- HTTP 202 → poll status URL (header `Location`, `Retry-After`)
- Body `{ status: 'Running' }` → continue polling
- Body `{ status: 'Succeeded', definition: {...} }` → return result
- Body `{ status: 'Failed', error: {...} }` → throw error

#### `model-loader.js`

**Funkcja**: `loadModelFromFabric(accessToken, workspaceId, semanticModelId, modelName)`  
**Opis**: Ładuje model z Fabric do internal format  
**Flow**:
1. Call `api-client.getSemanticModelDefinition()`
2. Otrzymaj `definition.parts` (Map `{ 'path' → 'base64' }`)
3. Decode base64 → content string per file
4. Build internal model structure (jak `loadModelFromFolder`):
   - Parse `database.tmdl`, `model.tmdl`, etc.
   - Dla każdego `tables/*.tmdl` → parse table
   - Build dictionaries
5. Zachowaj `rawFiles` (dla deployment)

#### `connection-parser.js`

**Funkcja**: `parseConnectionString(connString)`  
**Opis**: Parsuje Power BI connection string  
**Format**:
```
Data Source=powerbi://api.powerbi.com/v1.0/myorg/<WorkspaceName>;Initial Catalog=<ModelName>;
```

**Output**:
```javascript
{
  workspaceName: 'MyWorkspace',
  modelName: 'MyModel'
}
```

**Edge cases**:
- Workspace name ze spacjami: OK (URL decode)
- Model name ze spacjami: OK
- Missing semicolon at end: OK (optional)

### 8.5 Lib Module (`lib/`)

#### `activity-log.js`

**Format**: JSONL (JSON Lines) — jeden JSON object per linia  
**File**: `logs/activity.jsonl`

**Funkcje**:
- `logEvent(eventType, payload)` — append entry do log file
- `readEvents(limit)` — read last N entries

**Event types**:
- `compare` — porównanie modeli
- `deploy` — deployment
- `refresh` — refresh trigger
- `refresh-status` — refresh status update
- `fabric-auth` — login/logout

**Entry structure**:
```json
{
  "timestamp": "2026-05-28T10:30:00.000Z",
  "event": "deploy",
  "mode": "fabric",
  "target": "workspace:abc-123/model:def-456",
  "selectedCount": 5,
  "selectedDiffs": [...],
  "success": true,
  "actionsExecuted": 5,
  "errorCount": 0,
  "warnings": [],
  "backupPath": "D:\\Backups\\..."
}
```

#### `refresh-store.js`

**Format**: JSONL per model per session  
**Path**: `logs/refresh/<ModelName>/<YYYY-MM-DD>_<sessionStartISO>.jsonl`

**In-memory store**: Array `sessionRefreshes`

**Funkcje**:
- `createRefreshRecord(requestId, modelName, workspaceId, semanticModelId, tables, tableDetails, refreshType, options)` → record object
- `updateRefreshStatus(requestId, statusUpdate)` → void
- `getRefreshRecord(requestId)` → record object
- `getAllRefreshes()` → Array all session refreshes
- `persistRefreshRecord(record)` → append to JSONL file

**RefreshRecord structure**:
```javascript
{
  id: 'request-id-123',
  modelName: 'MyModel',
  workspaceId: 'abc',
  semanticModelId: 'def',
  status: 'inProgress',  // inProgress|completed|failed|cancelled|unknown
  startTime: '2026-05-28T10:30:00.000Z',
  endTime: null,
  requestedTables: ['Sales', 'Customer'],
  tableDetails: [
    { table: 'Sales', refreshType: 'dataOnly' }
  ],
  refreshType: 'dataOnly',
  options: {
    commitMode: 'transactional',
    maxParallelism: 2,
    needsPostCalculate: true
  },
  objects: [
    {
      table: 'Sales',
      partition: 'Sales-Part1',
      status: 'inProgress',
      startTime: '2026-05-28T10:30:00.000Z',
      endTime: null,
      message: null
    }
  ],
  postCalculate: {
    triggered: true,
    requestId: 'calc-xyz-789',
    status: 'inProgress'
  }
}
```

---

## 9. Integracja z Microsoft Fabric

### 9.1 Fabric REST API

**Base URL**: `https://api.fabric.microsoft.com/v1`

**Wykorzystywane endpointy**:

| Endpoint | Method | Opis |
|----------|--------|------|
| `/workspaces` | GET | Lista workspaces |
| `/workspaces/{id}` | GET | Szczegóły workspace |
| `/workspaces/{id}/items?type=SemanticModel` | GET | Lista semantic models w workspace |
| `/workspaces/{id}/semanticModels/{id}` | GET | Szczegóły semantic model |
| `/workspaces/{id}/semanticModels/{id}/getDefinition` | POST | Pobranie definicji TMDL (long-running) |
| `/workspaces/{id}/semanticModels/{id}/updateDefinition` | POST | Upload definicji TMDL (long-running) |

**Power BI REST API**:

| Endpoint | Method | Opis |
|----------|--------|------|
| `/datasets/{id}/refreshes` | POST | Trigger Enhanced Refresh |
| `/datasets/{id}/refreshes/{requestId}` | GET | Status Enhanced Refresh |

### 9.2 Enhanced Refresh API

**Endpoint**: `POST /datasets/{id}/refreshes`

**Request body**:
```json
{
  "type": "full",
  "commitMode": "transactional",
  "maxParallelism": 2,
  "retryCount": 3,
  "objects": [
    {
      "table": "Sales",
      "partition": "Sales-Part1"
    }
  ],
  "applyRefreshPolicy": false
}
```

**Refresh types**:
- `full` — schema + data + relationships
- `dataOnly` — tylko dane (bez schema changes)
- `calculate` — przeliczenie calculated tables/columns
- `automatic` — Fabric decyduje

**Commit modes**:
- `transactional` — all-or-nothing (rollback jeśli błąd)
- `partialBatch` — commit per partition (częściowy sukces możliwy)

**Response**:
```json
{
  "requestId": "abc-def-ghi"
}
```

**Status endpoint**: `GET /datasets/{id}/refreshes/{requestId}`

**Response**:
```json
{
  "requestId": "abc-def-ghi",
  "id": "123",
  "status": "Completed",
  "startTime": "2026-05-28T10:30:00Z",
  "endTime": "2026-05-28T10:35:00Z",
  "objects": [
    {
      "table": "Sales",
      "partition": "Sales-Part1",
      "status": "Completed"
    }
  ]
}
```

**Status values**:
- `Unknown` — nieznany status
- `NotStarted` — zakolejkowany
- `InProgress` — w trakcie
- `Completed` — sukces
- `Failed` — błąd
- `Cancelled` — anulowany przez użytkownika

### 9.3 Two-phase refresh workflow

**Problem**: Po zmianie struktury (nowe kolumny z sourceColumn) i wykonaniu `dataOnly` refresh, relationships mogą być "empty" (brak danych w indeksach).

**Rozwiązanie**: Auto-calculate po dataOnly

**Flow**:
1. User wdraża zmiany wymagające `dataOnly` refresh (np. nowa kolumna z sourceColumn)
2. System tworzy `refreshRequest` z `needsPostCalculate: true`
3. Trigger `dataOnly` refresh
4. Poll status (co 2 sekundy)
5. Gdy status = `Completed`:
   - Server auto-triggeruje `calculate` refresh (model-level)
   - Zwraca `postCalculate: { triggered: true, requestId: 'xyz' }` w response
6. Frontend kontynuuje polling na nowym `requestId`
7. Gdy `calculate` complete → refresh panel pokazuje sukces obu faz

**Implementacja**:
- Server: `POST /api/fabric/refresh` z `options.needsPostCalculate = true`
- Server: `GET /api/fabric/refresh/status/:requestId` → detect completion → auto-trigger calculate
- Frontend: `pollRefreshStatus()` → detect `postCalculate` → chain to new requestId

---

## 10. Frontend — Interfejs użytkownika

### 10.1 Struktura HTML

**Main sections**:
1. **Header** — logo, version, buttons (Fabric, New Compare, Export, Deploy, Refresh)
2. **Connection Panel** — wybór źródeł (DEV/PROD), local vs Fabric tabs, Compare button
3. **Results Panel** — lista różnic, filtry, actions, diff details

**Modals**:
1. **Fabric Modal** — login, account info, disconnect
2. **Deploy Modal** — preview operacji, confirm/cancel
3. **Result Modal** — podsumowanie po deployment
4. **Activity Log Modal** — historia operacji
5. **Refresh Modal** — Enhanced Refresh panel

### 10.2 Design System (CSS)

**Color palette**:
- Primary: `#4cc9f0` (cyan/blue) — actions, highlights
- Dark bg: `#1a1a2e` — main background
- Card bg: `#2d2d44` — panels, cards
- Success: `#06d6a0` — added, success states
- Danger: `#ef476f` — removed, errors
- Warning: `#ffd166` — modified, warnings
- Text: `#eee` — primary text
- Text muted: `#aaa` — secondary text

**Typography**:
- Font: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- Sizes: 14px base, 12px small, 16px headings

**Components**:
1. **Badges** — `.badge-dev` (cyan), `.badge-prod` (purple)
2. **Buttons** — `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-deploy`, `.btn-fabric`
3. **Cards** — `.connection-card`, `.diff-card`, `.group-card`
4. **Status dots** — `.status-dot.connected`, `.status-dot.disconnected`
5. **Pills** — `.pill.added`, `.pill.removed`, `.pill.modified`
6. **Code blocks** — `.code-block`, `.code-diff` (side-by-side)

### 10.3 State Management (Frontend)

**Global state** (JavaScript):
```javascript
let comparisonResult = null;           // Last comparison result
let activeGroup = null;                // Currently expanded group
let activeFilter = 'all';              // Filter: all|added|removed|modified
let searchTerm = '';                   // Search query
let selectedKeys = new Set();          // Selected diffs for deployment
let devPath = '';                      // DEV model path
let prodPath = '';                     // PROD model path
let fabricConnected = false;           // Fabric connection status
let workspacesCache = [];              // Cached workspaces list
let devSourceMode = 'local';           // 'local' | 'fabric'
let prodSourceMode = 'local';          // 'local' | 'fabric'
let devFabricSelection = { workspaceId, semanticModelId, modelName };
let prodFabricSelection = { workspaceId, semanticModelId, modelName };
let refreshHistory = [];               // Session refresh records
let activeRefreshId = null;            // Currently monitored refresh
let refreshPollTimer = null;           // Poll timer ID
```

**LocalStorage persistence**:
- `ma_devPath` — last selected DEV path
- `ma_prodPath` — last selected PROD path
- `ma_backupPath` — custom backup path
- `ma_devSourceMode` — 'local' | 'fabric'
- `ma_prodSourceMode` — 'local' | 'fabric'
- `ma_devFabricConn` — last DEV Fabric connection string
- `ma_prodFabricConn` — last PROD Fabric connection string

### 10.4 Event Handling

**Connection Panel**:
- `btn-browse-dev/prod.click` → `pickFile(side)` → open folder picker
- `btn-swap.click` → swap DEV ↔ PROD paths
- `source-tab.click` → switch local/Fabric tabs
- `btn-resolve-dev/prod.click` → verify Fabric access
- `btn-compare.click` → `handleCompare()`

**Results Panel**:
- `filter-btn.click` → set `activeFilter`, re-render diffs
- `diff-search.input` → set `searchTerm`, re-render (if length >= 2)
- `btn-select-all.click` → select all visible diffs
- `btn-deselect-all.click` → clear `selectedKeys`
- `btn-expand-all.click` → expand all groups
- `btn-collapse-all.click` → collapse all groups
- `diff-item.click` → toggle expand diff details
- `diff-checkbox.change` → toggle selection

**Deploy Flow**:
- `btn-deploy.click` → `handleDeployClick()` → show preview modal
- `btn-confirm-deploy.click` → `handleConfirmDeploy()` → POST /api/deploy → show result modal

**Refresh Flow**:
- `btn-model-refresh.click` → `openRefreshPanel()` → show refresh modal
- `btn-trigger-refresh.click` → `triggerRefresh()` → POST /api/fabric/refresh
- Auto-poll: `pollRefreshStatus()` co 2 sekundy
- `btn-refresh-cancel.click` → stop polling, close modal

### 10.5 Rendering Logic

#### Comparison Results
```javascript
function renderDiffs() {
  // 1. Filtruj diffs wg activeFilter (all|added|removed|modified)
  // 2. Filtruj wg searchTerm (match displayName, identityKey)
  // 3. Grupuj per change group (SCHEMA, CALCULATION, etc.)
  // 4. Render group cards:
  //    - Group header (expand/collapse)
  //    - Diff items (checkbox, icon, name, badge)
  //    - Diff details (property diffs, code diff)
  // 5. Update counters (total diffs, added/removed/modified)
  // 6. Update deploy button (enabled if selectedKeys.size > 0)
}
```

#### Diff Details (expand)
```javascript
function renderDiffDetails(diff) {
  // 1. Property diffs table:
  //    - Property name | Old value | New value
  // 2. Side-by-side code diff (dla expressions):
  //    - PROD code | DEV code
  //    - Highlight differences (word-level)
  // 3. Metadata: source file, identity key, change group
}
```

#### Refresh Panel
```javascript
function renderRefreshPanel() {
  // 1. Header: model name, workspace
  // 2. Refresh offer (jeśli jest tablesNeedingRefresh):
  //    - "Recommended: dataOnly + auto-calculate"
  //    - Lista tabel z reason per table
  // 3. Active refresh display (jeśli activeRefreshId):
  //    - Progress bar (% objects completed)
  //    - Per-table status (inProgress|completed|failed)
  //    - Real-time updates (poll co 2s)
  // 4. Session history:
  //    - Past refreshes (expandable)
  //    - Status, duration, tables refreshed
}
```

---

## 11. Proces wdrożenia (Deployment)

### 11.1 Pre-deployment Checklist

**User actions**:
1. Review differences w UI
2. Zaznacz zmiany do wdrożenia (checkboxes)
3. Ustaw backup path (jeśli custom)
4. Kliknij "Deploy Selected"

**System validation** (automatic):
1. Sprawdź zależności (`validator.validateDependencies()`)
2. Wykryj compatibility level requirements
3. Wykryj orphaned relationships (auto-cascade)
4. Pokaż preview (dry-run) w modal

**User confirmation**:
- Preview modal pokazuje:
  - Liczba operacji (add/remove/modify)
  - Lista plików do zmiany
  - Warnings (jeśli są)
  - Backup path (jeśli enabled)
  - Refresh recommendation (jeśli potrzebny)
- User klika "Confirm"

### 11.2 Deployment Execution

**Flow**:
1. **Backup** (jeśli `backup === true`):
   - Timestamp: `YYYY-MM-DDTHH-mm-ss`
   - Folder: `<backupPath>/<ModelName>.SemanticModel_backup_<timestamp>/`
   - Kopiuj: `definition/`, `definition.pbism`, `diagramLayout.json`
2. **Plan operations**:
   - Grupuj diffs per target file
   - Dla każdego file: lista operacji (add/remove/replace blocks)
3. **Execute operations** (sequentially per file):
   - Read file content
   - Apply operation (manipulacja stringów TMDL)
   - Write file content (jeśli changed)
   - Log do `result.actions`
4. **Auto-bump compatibility level** (jeśli validator wykrył potrzebę):
   - Edit `database.tmdl`
   - `compatibilityLevel: 1566` → `compatibilityLevel: 1702` (dla UDF)
5. **Detect refresh needs**:
   - Analiza deployed diffs
   - Zwróć `tablesNeedingRefresh` object
6. **Return result**:
   - Success/failure
   - Executed actions
   - Errors (jeśli były)
   - Warnings
   - Backup path
   - Tables needing refresh

### 11.3 Post-deployment Actions

**Jeśli local deployment**:
- Model może być otwarty w Power BI Desktop → user musi zamknąć i otworzyć ponownie

**Jeśli Fabric deployment**:
1. System sugeruje refresh (panel + badge)
2. User klika "Model Refresh"
3. System pokazuje refresh panel z rekomendowanym typem
4. User uruchamia refresh
5. System monitoruje status w czasie rzeczywistym
6. Po zakończeniu dataOnly → auto-trigger calculate
7. Po zakończeniu calculate → refresh complete

### 11.4 Rollback Strategy

**Backup restore** (manual):
1. User lokalizuje backup folder w `backups/`
2. Kopiuje zawartość `definition/` z backup do PROD
3. (Opcjonalnie) kopiuje `definition.pbism`, `diagramLayout.json`
4. Power BI Desktop/Fabric odczytuje nową definicję

**Brak automatycznego rollback** — użytkownik kontroluje proces.

---

## 12. System logowania i monitorowania

### 12.1 Activity Log (`logs/activity.jsonl`)

**Format**: JSONL — jeden JSON object per linia

**Event types**:

#### `compare`
```json
{
  "timestamp": "2026-05-28T10:30:00.000Z",
  "event": "compare",
  "mode": "local-local",
  "devSource": "D:\\Models\\DEV.SemanticModel\\definition",
  "prodSource": "D:\\Models\\PROD.SemanticModel\\definition",
  "diffCount": 15,
  "groupCount": 5,
  "success": true
}
```

#### `deploy`
```json
{
  "timestamp": "2026-05-28T10:35:00.000Z",
  "event": "deploy",
  "mode": "local",
  "dryRun": false,
  "target": "D:\\Models\\PROD.SemanticModel\\definition",
  "selectedCount": 5,
  "selectedDiffs": [
    { "type": 0, "objectType": "measure", "name": "Total Sales", "identityKey": "..." }
  ],
  "success": true,
  "actionsExecuted": 5,
  "errorCount": 0,
  "warnings": [],
  "errors": [],
  "backupPath": "D:\\Backups\\Model_backup_2026-05-28T10-35-00",
  "tablesNeedingRefresh": {
    "refreshType": "dataOnly",
    "tables": [{ "table": "Sales", "refreshType": "dataOnly", "reason": "new column" }],
    "isFullModel": false
  }
}
```

#### `refresh`
```json
{
  "timestamp": "2026-05-28T10:40:00.000Z",
  "event": "refresh",
  "modelName": "MyModel",
  "workspaceId": "abc-123",
  "semanticModelId": "def-456",
  "requestId": "refresh-id-789",
  "refreshType": "dataOnly",
  "tables": ["Sales", "Customer"],
  "success": true
}
```

#### `refresh-status`
```json
{
  "timestamp": "2026-05-28T10:41:00.000Z",
  "event": "refresh-status",
  "requestId": "refresh-id-789",
  "status": "Completed",
  "duration": 60
}
```

### 12.2 Refresh Log (`logs/refresh/<ModelName>/<date>_<session>.jsonl`)

**Format**: JSONL — jeden refresh record per linia

**Entry structure**: Zobacz `refresh-store.js::RefreshRecord`

**Użycie**:
- Persystencja refresh history między restartami aplikacji
- Analiza performance (czas refresh per table/partition)
- Troubleshooting (błędy, retries)

### 12.3 Activity Log Viewer (UI)

**Location**: Modal "Activity Log" (button w header)

**Features**:
- Wyświetlanie ostatnich N entries (limit: 50/100/200/500)
- Filtrowanie per event type
- Expand/collapse entry details
- Refresh button (re-load from file)

**Rendering**:
- Timeline view (newest on top)
- Color-coded per event type
- Success/failure icons
- Expandable JSON details

---

## 13. Walidacja i kontrola jakości

### 13.1 Pre-deployment Validation

**Checks** (see `validator.js`):
1. **Compatibility level** — auto-bump jeśli potrzebny (warning)
2. **Parent table existence** — error jeśli missing
3. **Relationship endpoints** — error jeśli kolumny missing
4. **Orphaned relationships** — auto-cascade (warning)
5. **Calculation dependencies** — warning jeśli potencjalny broken DAX

**Action on errors**:
- `dryRun === true` → show planned ops + errors (nie blokuje preview)
- `dryRun === false` → abort deployment, return errors

### 13.2 Runtime Validation

**During deployment**:
- Każda operacja wrapped w try-catch
- Błędy logowane do `result.errors`
- Continue z kolejnymi operacjami (best-effort)
- Jeśli critical error (np. file not found) → abort remaining ops dla tego pliku

**Success criteria**:
- `result.success === true` jeśli wszystkie operacje succeeded
- `result.success === false` jeśli co najmniej jeden error

### 13.3 Post-deployment Verification (Manual)

**Recommended checks**:
1. Otwórz model w Power BI Desktop (jeśli local)
2. Sprawdź Model View — czy relationships są widoczne
3. Sprawdź Data View — czy calculated columns mają wartości
4. Uruchom DAX query na zmodyfikowanych measures
5. (Fabric) uruchom Enhanced Refresh → sprawdź status

---

## 14. Refresh Management

### 14.1 Refresh Type Detection

**Algorytm** (server-side, `detectTablesNeedingRefresh()`):

```javascript
function detectRefreshType(diff) {
  if (diff.objectType === 'table' && diff.type === 0) return 'full';  // nowa tabela
  if (diff.objectType === 'column' && diff.type === 0) {
    const hasSourceCol = diff.propertyDiffs.some(p => p.propertyName === 'sourceColumn');
    const hasExpr = diff.propertyDiffs.some(p => p.propertyName === 'expression');
    if (hasExpr) return 'calculate';       // calculated column
    if (hasSourceCol) return 'dataOnly';   // imported column
  }
  if (diff.objectType === 'column' && diff.type === 2) {
    const exprChanged = diff.propertyDiffs.some(p => p.propertyName === 'expression');
    if (exprChanged) return 'calculate';   // calculated column changed
  }
  if (diff.objectType === 'partition') {
    const mode = getPartitionMode(diff);
    if (mode === 'calculated') return 'calculate';
    return 'dataOnly';                     // data partition
  }
  if (diff.objectType === 'calculationItem') return 'calculate';
  if (diff.objectType === 'expression') {
    if (isParameterExpression(diff)) return 'dataOnly';  // parametr Query
    return 'dataOnly';  // shared M query (all tables lub specific dependent tables)
  }
  return null;  // no refresh needed
}
```

**Output**: `tablesNeedingRefresh` object:
```javascript
{
  refreshType: 'dataOnly',  // dominant type (lub 'full' jeśli any table needs full)
  tables: [
    { table: 'Sales', refreshType: 'dataOnly', reason: 'new column with sourceColumn' },
    { table: 'Customer', refreshType: 'calculate', reason: 'calculated column expression changed' }
  ],
  isFullModel: false  // true jeśli shared M query changed (all tables affected)
}
```

### 14.2 Refresh Panel UI

**Sections**:
1. **Header** — model name, workspace, Fabric connection status
2. **Refresh Offer** (jeśli `tablesNeedingRefresh`):
   - "Changes require data refresh"
   - Recommended action: "Refresh {N} tables with type {refreshType}"
   - Note: "After dataOnly, automatic calculate will run"
   - Lista tabel z ikona refresh type + reason
   - Button: "Trigger Refresh"
3. **Active Refresh** (jeśli `activeRefreshId`):
   - Progress bar (% tables completed)
   - Real-time status per table (🔵 inProgress | ✅ completed | ❌ failed)
   - Elapsed time
   - Current phase (Phase 1: Data Refresh | Phase 2: Calculate)
   - Button: "Cancel" (hide panel — refresh continues in background)
4. **Session History**:
   - Past refreshes (collapsible cards)
   - Status, duration, tables count
   - Expand → per-table details

### 14.3 Two-Phase Refresh UI Flow

**Phase 1: dataOnly refresh**:
1. User klika "Trigger Refresh"
2. Frontend: POST `/api/fabric/refresh` z `options.needsPostCalculate = true`
3. Backend: Fabric API POST `/datasets/{id}/refreshes` (type: dataOnly)
4. Backend: Zwraca `{ requestId, status: 'inProgress' }`
5. Frontend: Start polling `GET /api/fabric/refresh/status/:requestId` co 2s
6. UI pokazuje: "Phase 1: Data Refresh" + progress bar + per-table status
7. Gdy status = 'Completed':
   - Backend auto-triggeruje calculate refresh
   - Backend zwraca `postCalculate: { triggered: true, requestId: 'xyz' }`
   - Frontend kontynuuje polling na `requestId = 'xyz'`

**Phase 2: calculate refresh**:
8. UI pokazuje: "Phase 2: Calculate (rebuild relationships)"
9. Polling kontynuowany na nowym `requestId`
10. Gdy calculate status = 'Completed':
    - UI pokazuje: "✅ Refresh complete (both phases)"
    - Stop polling
    - Update session history

**Cancel handling**:
- User klika "Cancel" → stop polling, hide panel
- Refresh kontynuowany w tle (nie anulowany w Fabric)
- User może wrócić do panelu ("Model Refresh" button) i kontynuować monitoring

---

## 15. Bezpieczeństwo

### 15.1 Autentykacja

**Metoda**: OAuth2 Authorization Code + PKCE  
**Provider**: Microsoft Entra ID  
**Client type**: Public client (no secret)  
**Client ID**: Power BI Desktop public client (`ea0616ba-638b-4df5-95b9-636659ae5121`)

**Security benefits**:
- Brak przechowywania haseł (user loguje się w przeglądarce Microsoft)
- PKCE zapobiega authorization code interception
- Access token only in memory (nie zapisywany na dysku)
- Token lifetime: ~60 minut (auto-refresh przez MSAL)

### 15.2 Przechowywanie Credentials

**What is stored**:
- LocalStorage: ścieżki modeli, connection strings (bez credentials), backup path
- Memory (server): access token, account info
- Disk: brak credentials

**What is NOT stored**:
- Hasła użytkownika
- Refresh tokens (MSAL managed)
- Access tokens na dysku

### 15.3 Network Security

**HTTPS enforcement**:
- Wszystkie calls do Fabric API przez HTTPS
- OAuth flow przez HTTPS

**Localhost security**:
- Server listens tylko na `localhost:3001` (nie exposed na network)
- Brak cross-origin requests (frontend served z tego samego origin)

### 15.4 Data Protection

**Backups**:
- Stored lokalnie (user kontroluje backup path)
- Zawierają pełną definicję modelu (TMDL files) — user musi zabezpieczyć backups

**Logs**:
- Activity log zawiera metadata (ścieżki, liczba zmian, errors) — nie zawiera credentials
- Refresh log zawiera workspace IDs, model IDs — nie zawiera access tokens

**Recommendation**:
- Dodaj `backups/` i `logs/` do `.gitignore` (jeśli używany Git)
- Nie commituj backups ani logs do public repositories
- Encrypt dysk (BitLocker) jeśli model zawiera sensitive data

### 15.5 Access Control

**Fabric access**:
- User musi mieć odpowiednie permissions w Fabric workspace:
  - **Read** — do porównywania modeli
  - **Write** — do wdrażania zmian
  - **Admin** — do triggerowania refresh
- Permissions kontrolowane przez Microsoft Entra ID (nie przez aplikację)

**Local file access**:
- Aplikacja działa z prawami użytkownika uruchamiającego Node.js
- User może modyfikować tylko pliki, do których ma write access (OS-level)

---

## 16. Instalacja i uruchomienie

### 16.1 Wymagania wstępne

1. **Windows 10/11** (native file picker)
2. **Node.js v18+** (rekomendowane: LTS)
3. **PowerShell 5.1+** (included w Windows)
4. **Power BI Desktop** (opcjonalnie — do testowania lokalnych modeli)

### 16.2 Instalacja

```powershell
# 1. Sklonuj repozytorium (lub pobierz ZIP)
cd D:\Projects
git clone <repo-url> model_alchemist
cd model_alchemist

# 2. Zainstaluj dependencies
npm install

# 3. Weryfikacja
node --version   # powinno wyświetlić v18.x.x+
```

### 16.3 Uruchomienie

**Tryb produkcyjny**:
```powershell
npm start
```
- Server startuje na `http://localhost:3001`
- Otwórz przeglądarkę: `http://localhost:3001`

**Tryb deweloperski** (auto-restart on file changes):
```powershell
npm run dev
```
- Używa `node --watch` (Node.js 18+)
- Auto-restart przy zmianie plików `.js`

### 16.4 Pierwsze użycie

1. Otwórz `http://localhost:3001` w przeglądarce
2. **Local mode**:
   - Kliknij "Browse..." przy DEV → wybierz folder `.SemanticModel`
   - Kliknij "Browse..." przy PROD → wybierz folder `.SemanticModel`
   - Kliknij "Compare Models"
3. **Fabric mode**:
   - Kliknij "☁️ Fabric" w header → Sign in
   - Zaloguj się w przeglądarce
   - Przełącz DEV lub PROD na tab "☁️ Fabric"
   - Wklej connection string lub wybierz z listy workspaces
   - Kliknij "Verify Access"
   - Kliknij "Compare Models"

---

## 17. Troubleshooting

### 17.1 Częste problemy

#### Problem: "Node.js is not recognized"
**Rozwiązanie**:
- Zrestartuj terminal po instalacji Node.js
- Sprawdź PATH: `echo $env:PATH` (PowerShell)
- Reinstall Node.js z opcją "Add to PATH"

#### Problem: "npm install failed"
**Rozwiązanie**:
- Usuń `node_modules/` i `package-lock.json`
- `npm cache clean --force`
- `npm install` ponownie

#### Problem: "Port 3001 already in use"
**Rozwiązanie**:
- Zmień port: `$env:PORT=3002; npm start` (PowerShell)
- Lub zabij proces: `Get-Process -Name node | Stop-Process`

#### Problem: "Folder picker not opening"
**Rozwiązanie**:
- Sprawdź, czy PowerShell jest dostępny: `powershell -Command "Get-Host"`
- Sprawdź uprawnienia: uruchom terminal as Administrator
- Check `pick-file.py` error output w console

#### Problem: "Fabric login failed"
**Rozwiązanie**:
- Sprawdź połączenie internetowe
- Sprawdź, czy przeglądarka nie blokuje popup (disable popup blocker)
- Sprawdź firewall — czy localhost może otworzyć browser
- Sprawdź tenant restrictions — czy organizacja blokuje external apps

#### Problem: "Deployment failed — file not found"
**Rozwiązanie**:
- Sprawdź, czy PROD path jest poprawny
- Sprawdź, czy masz write access do folderu
- Sprawdź, czy model nie jest otwarty w Power BI Desktop (file lock)

#### Problem: "Refresh failed — access denied"
**Rozwiązanie**:
- Sprawdź uprawnienia w Fabric workspace (wymaga Admin role)
- Sprawdź, czy model ma data gateway configured
- Sprawdź credentials data sources w Fabric

### 17.2 Debug mode

**Włączanie verbose logging**:
```powershell
$env:DEBUG='*'
npm start
```

**Inspect logs**:
- Activity log: `logs/activity.jsonl`
- Refresh log: `logs/refresh/<ModelName>/<session>.jsonl`
- Console output (server): stderr/stdout

---

## 18. Roadmap i przyszłe rozszerzenia

### 18.1 Planned features (nie zaimplementowane)

1. **Git integration** — automatyczne porównywanie branch commits
2. **Rollback automation** — one-click restore z backup
3. **Diff export to Git** — generowanie patch files
4. **Multi-model comparison** — porównywanie 3+ modeli jednocześnie
5. **Advanced DAX analysis** — dependency graph, performance hints
6. **Schema drift detection** — scheduled porównywanie (cron)
7. **CI/CD integration** — GitHub Actions / Azure DevOps pipelines
8. **Deployment approvals** — multi-user approval workflow
9. **Audit trail** — comprehensive change log z user attribution
10. **Model documentation** — auto-generated docs z descriptions

### 18.2 Możliwe ulepszenia

1. **Performance**:
   - Paralelizacja porównywania (Worker Threads)
   - Caching parsed models (pomiędzy porównaniami)
   - Incremental parsing (only changed files)

2. **UI/UX**:
   - Dark/light theme toggle
   - Keyboard shortcuts (Ctrl+F search, Ctrl+A select all)
   - Drag-and-drop folder selection
   - Persistent expand/collapse state per group

3. **Integracja**:
   - Direct integration z Power BI Desktop (extension)
   - Support dla Azure DevOps Repos
   - Support dla AWS CodeCommit

---

## 19. Licencja i autorstwo

**Licencja**: MIT  
**Autor**: Radosław Górecki  
**Repository**: https://github.com/goreckir  
**Wersja dokumentacji**: 1.0 (zgodna z Model Alchemist v4.3.1)

---

## 20. Glosariusz

**TMDL** — Tabular Model Definition Language — format tekstowy dla modeli semantycznych Power BI  
**PBIP** — Power BI Project — format projektów Power BI Desktop z Git integration  
**TOM** — Tabular Object Model — API do programmatic access modeli Analysis Services  
**XMLA** — XML for Analysis — protocol używany przez Power BI / Analysis Services  
**Enhanced Refresh** — zaawansowany API do refresh danych w Fabric z kontrolą per-table/partition  
**Semantic Model** — model danych Power BI (dawniej nazywany Dataset)  
**Fabric** — Microsoft Fabric — unified analytics platform (SaaS)  
**MSAL** — Microsoft Authentication Library — OAuth2 library  
**PKCE** — Proof Key for Code Exchange — OAuth2 extension dla public clients  
**RLS** — Row-Level Security — filtrowanie wierszy per user  
**OLS** — Object-Level Security — ukrywanie kolumn/miar per user  
**UDF** — User Defined Function — DAX function defined przez użytkownika  
**Calculation Group** — tabela specjalna z calculation items (dynamic calculations)  
**DAX** — Data Analysis Expressions — język formuł Power BI  
**M** — Power Query M — język transformacji danych  
**Partition** — część tabeli (podział na fragmenty dla performance)

---

**Koniec specyfikacji**
