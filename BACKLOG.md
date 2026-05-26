# Model Alchemist — Backlog

## 🚀 Planned Features

### High Priority
- [ ] **Selective refresh per group** — After deploy, allow user to pick which refresh groups to execute (instead of all-or-nothing).
- [ ] **Diff preview in deploy confirmation** — Show side-by-side code diff before confirming deployment.
- [ ] **Incremental deployment** — Deploy only changed TMDL files (not full model redefinition) for faster Fabric uploads.
- [ ] **Merge conflicts detection** — When deploying to Fabric, detect if the remote model changed since last comparison and warn user.

### Medium Priority
- [ ] **Multi-model batch comparison** — Compare multiple semantic models in one session (e.g. DEV vs UAT vs PROD pipeline).
- [ ] **History / audit log** — Track deployments with timestamps, user, and list of deployed changes.
- [ ] **CLI mode** — Run comparison/deployment headless from command line (CI/CD integration).
- [ ] **Git integration** — Show git diff status alongside model comparison; auto-commit after deploy.
- [ ] **Refresh scheduling** — Queue refresh for a specific time (e.g. after business hours).

### Low Priority / Nice-to-Have
- [ ] **Dark/light theme toggle** — Currently dark-only; add light theme option.
- [ ] **Drag & drop model files** — Drop `.pbip` files onto the UI instead of using file picker.
- [ ] **Syntax highlighting in diff** — DAX/M code highlighting in expanded property views.
- [ ] **Model documentation export** — Generate model documentation (tables, measures, relationships) as HTML/PDF.
- [ ] **Notifications** — Desktop notifications when long-running refresh completes.

---

## 🐛 Known Issues & Tech Debt

### Bugs
- [ ] **`Financial Data` false positive** — Commented-out SQL lines (`--from ...`) in partition expressions cause diff when semantically equivalent. Consider ignoring SQL comments in expression comparison.
- [ ] **TIME_WAIT port delay** — After crash, OS holds port in TIME_WAIT for ~30s. Auto port fallback mitigates but doesn't eliminate the wait message.

### Tech Debt
- [ ] **Version string duplication** — Version is hardcoded in 5 places (package.json, index.html title, index.html badge, app.js comment, server.js console). Should be single source of truth.
- [ ] **No automated tests** — No unit/integration tests for parser, extractor, or engine. High risk of regressions.
- [ ] **Large `server.js`** — 650+ lines mixing routes, deployment logic, PowerShell interop, and Fabric refresh. Should be split into modules.
- [ ] **`execFile` for file picker** — Windows-only dependency (PowerShell + .NET Forms). Consider Electron or platform-agnostic alternative.
- [ ] **No input validation on connection strings** — Malformed Fabric connection strings can cause unhandled errors.
- [ ] **Error handling in engine** — `computeGroups` assumes devObjects always has matching partitions; edge cases (orphaned partitions, circular deps) not handled.
- [ ] **Frontend `app.js` monolith** — Single 900+ line file. Consider splitting into modules (comparison UI, deploy UI, export, refresh).

---

## 💡 Ideas (Exploration)

- [ ] **Power BI REST API v2** — Replace XMLA with newer REST endpoints where available.
- [ ] **VS Code extension** — Package as VS Code extension with sidebar for model comparison.
- [ ] **Tabular Editor integration** — Import/export compatibility with Tabular Editor's BIM format.
- [ ] **AI-assisted review** — Use LLM to summarize DAX/M changes in natural language.
- [ ] **Webhook on deploy** — Fire webhook (Teams, Slack) when deployment completes.
