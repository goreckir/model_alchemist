# Fabric Semantic Model — Refresh Types & Rules

## Typy odświeżenia (TMSL / Enhanced Refresh API)

| Typ | Opis |
|-----|------|
| **`full`** | Odświeża dane + przelicza wszystkie zależności (calculated columns, hierarchie). Najcięższy. |
| **`dataOnly`** | Tylko odświeżenie danych z source — czyści zależne obiekty (calc columns tracą wartości). |
| **`calculate`** | Tylko przeliczenie (calculated columns, relationships) — bez pobierania danych. |
| **`automatic`** | Silnik sam decyduje co potrzeba: jeśli partycja nie jest w stanie "Ready" → full, jeśli OK → calculate. |
| **`clearValues`** | Czyści dane obiektu i jego zależności. |
| **`defragment`** | Porządkuje słowniki kolumn (czyszczenie po usunięciach). |
| **`add`** | Dołącza dane do partycji i przelicza zależności. Tylko dla zwykłych partycji. |

---

## Które zmiany wymagają odświeżenia po deploy?

> **Źródło:** Microsoft Learn — TMDL view docs:
> *"TMDL view modifies only the semantic model metadata, without refreshing data. If your changes require a data refresh, such as altering a PowerQuery expression or calculated column expression, you must manually refresh the table or model."*

| Typ zmiany | Wymaga odświeżenia? | Jaki typ? |
|------------|---------------------|-----------|
| **Measures** (wyrażenia DAX) | ❌ NIE | Obliczane at query time |
| **Column properties** (isHidden, formatString, displayFolder, sortByColumn, dataCategory) | ❌ NIE | Tylko metadane |
| **Relationships** (dodanie/usunięcie) | ❌ NIE | Metadane (chyba że wymaga przeliczenia) |
| **Partition expressions** (Power Query/M) | ✅ TAK | `dataOnly` lub `full` na danej tabeli |
| **Named Expressions** (shared M expressions) | ✅ TAK | `dataOnly` tabel używających tych wyrażeń |
| **Calculated columns** (zmiana DAX) | ✅ TAK | `calculate` lub `full` |
| **Nowa tabela** (Added) | ✅ TAK | `full` na nowej tabeli |
| **Usunięta tabela** (Removed) | ❌ NIE | Metadane |
| **Nowa kolumna** (sourceColumn) | ✅ TAK | `dataOnly` tabeli |
| **Security roles** | ❌ NIE | Metadane |
| **Perspectives, cultures** | ❌ NIE | Metadane |

---

## REST API — Enhanced Refresh

### Endpoint

```http
POST https://api.powerbi.com/v1.0/myorg/groups/{groupId}/datasets/{datasetId}/refreshes
```

### Wymagania
- Semantic model na Power BI Premium, Premium per user, Fabric capacity lub Embedded
- Scope: `Dataset.ReadWrite.All`
- Jeden refresh naraz na model (409 Conflict jeśli już trwa)

### Przykład — odświeżenie wybranych tabel

```json
{
    "type": "automatic",
    "commitMode": "transactional",
    "maxParallelism": 10,
    "retryCount": 0,
    "objects": [
        { "table": "Dim_KPI" },
        { "table": "Dim_Scenario" },
        { "table": "Financial Data" }
    ]
}
```

### Przykład — odświeżenie konkretnej partycji

```json
{
    "type": "dataOnly",
    "commitMode": "transactional",
    "objects": [
        {
            "table": "DimCustomer",
            "partition": "DimCustomer"
        }
    ]
}
```

### Parametry

| Parametr | Typ | Default | Opis |
|----------|-----|---------|------|
| `type` | Enum | `automatic` | Typ przetwarzania (full, clearValues, calculate, dataOnly, automatic, defragment) |
| `commitMode` | Enum | `transactional` | `transactional` (atomowo) lub `partialBatch` (po kawałku) |
| `maxParallelism` | Int | `10` | Max wątków równoległych |
| `retryCount` | Int | `0` | Ile razy ponawiać przy błędzie |
| `objects` | Array | cały model | Lista tabel/partycji do odświeżenia |
| `applyRefreshPolicy` | Boolean | `true` | Czy stosować incremental refresh policy |
| `effectiveDate` | Date | dzisiaj | Override daty dla incremental refresh |
| `timeout` | String | `05:00:00` | Timeout per attempt (max 24h z retries) |

### Odpowiedź

```
202 Accepted
Location: https://api.powerbi.com/v1.0/myorg/groups/{groupId}/datasets/{datasetId}/refreshes/{requestId}
```

### Sprawdzenie statusu

```http
GET https://api.powerbi.com/v1.0/myorg/groups/{groupId}/datasets/{datasetId}/refreshes/{requestId}
```

Statusy: `Unknown`, `Completed`, `Failed`, `Cancelled`, `Disabled`

---

## Strategia dla Model Alchemist

Po deploy via `updateDefinition` API:

1. **Wykryj affected tables** — tabele, których partycje lub named expressions zostały zmienione
2. **Zaproponuj refresh** — pokaż listę tabel wymagających odświeżenia
3. **Użyj `type: "automatic"`** — silnik sam dobierze minimalny zakres
4. **Monitoruj** — polluj GET /refreshes/{requestId} co kilka sekund

### Logika klasyfikacji zmian

```javascript
function needsRefresh(diff) {
    // Partycje (Power Query / M expressions) → zawsze refresh
    if (diff.objectType === 'partition') return true;
    
    // Named expressions → refresh tabel które ich używają
    if (diff.objectType === 'expression') return true;
    
    // Nowe tabele → refresh
    if (diff.type === 'added' && diff.objectType === 'table') return true;
    
    // Nowe kolumny z sourceColumn → refresh tabeli
    if (diff.type === 'added' && diff.objectType === 'column') return true;
    
    // Calculated columns (zmiana expression) → calculate
    if (diff.objectType === 'column' && hasExpressionChange(diff)) return true;
    
    // Measures, relationships, properties → NIE
    return false;
}
```
