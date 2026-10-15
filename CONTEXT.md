# Model Alchemist

Diff and selective-deployment tool for Power BI semantic models (TMDL), plus the demo material used to test and promote it.

## Language

### Comparison and deployment

**Source**:
The semantic model changes are taken from (typically dev). Local PBIP folder or Fabric model.
_Avoid_: DEV model, left side

**Target**:
The semantic model changes are deployed into (typically prod). Local PBIP folder or Fabric model.
_Avoid_: PROD model, right side

**Change Group**:
One of the eleven categories of model objects Model Alchemist compares (tables and relationships, measures, calculation groups, hierarchies, roles and RLS, perspectives, translations, data sources and parameters, named expressions, functions, model properties).

### Demo material

**Demo Kit**:
The synthetic Power BI model shipped with Model Alchemist, used at once as the download-and-try demo, the regression fixture, and the source of every campaign recording.
_Avoid_: sample model, Contoso model, test model

**Apothecary**:
The fictional business the Demo Kit models: a retailer of potions and ingredients with stores, regions, sales and budget.

**Scenario**:
A named pair of Demo Kit variants (one Source, one Target) differing in a deliberate, known set of changes; it drives one recording and one regression test.
_Avoid_: test case, demo pair

**Default Scenario**:
The one Scenario committed ready-made in the repo, covering every Change Group, so a new user can compare without running anything.

**Presentation Mode**:
A Model Alchemist setting that hides the signed-in identity on screen, so the app can be recorded or shown on a shared screen.
_Avoid_: demo mode, mask mode

**Recording**:
A scripted capture of one Scenario in the Model Alchemist UI, published as a GIF (README, Reddit) and an MP4 (LinkedIn) from the same take.
_Avoid_: video, screencast

**Client Model**:
Any semantic model belonging to a customer, including local backups of one. Never read, used, recorded or shipped in demo or campaign material.
_Avoid_: real model, production backup

## Relationships

- A **Scenario** consists of exactly one **Source** and one **Target**, both derived from the **Demo Kit**
- The **Default Scenario** exercises all eleven **Change Groups**
- Campaign recordings use only **Scenarios**; a **Client Model** never appears

## Flagged ambiguities

- "przykładowy model" was used for both the demo shipped to users and the test fixture — resolved: they are the same thing, the **Demo Kit**.
