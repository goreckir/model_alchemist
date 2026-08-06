# Contributing

## Running locally

```bash
npm install
npm start        # http://localhost:3001
npm run dev      # same, restarting on file changes
```

In VS Code, `F5` and pick **Start Model Alchemist** (or **Start Model Alchemist (watch)**).
On Windows, double-clicking `start.bat` also works.

## Tests

```bash
npm test         # unit + integration suite
npm run smoke    # boots the server and checks it serves the app
```

The suite runs on Node's built-in test runner. There are no test dependencies to install.

Two conventions worth knowing before adding a test:

- **Name the test after the issue it locks down** (`#42 modifying a table header preserves the target lineageTag`). When it fails, the name alone says which defect came back.
- **Use the real pipeline.** `test/helpers/tmdl.js` writes throwaway TMDL folders to a temp directory and runs them through the actual loader, comparison engine and deployer, so a test exercises the same code path the app does. `test/roundtrip.test.js` is the broadest of these: it deploys every difference between two models and asserts nothing is left to deploy.

Frontend logic that can be tested lives in `public/js/pure.js`. These are DOM-free functions (filtering, group indexing, escaping, export formatting) exported to both the browser (`window.MAPure`) and the test runner. Put logic there rather than inside `app.js` wherever it does not need the DOM.

## Language

All written artifacts are in English: code comments, commit messages, user-facing strings, docs, and release notes.

## Project structure

```
model_alchemist/
├── server.js                # Express server (API + static files)
├── parser/
│   ├── tmdl-parser.js       # TMDL text → object tree
│   └── model-loader.js      # definition/ folder → model
├── comparison/
│   ├── engine.js            # diff + atomic grouping
│   ├── extractor.js         # model → identity-keyed objects
│   ├── keys.js              # identity key construction
│   ├── refs.js              # TMDL reference parsing
│   └── rename-detector.js   # pairs Add/Remove that are one rename
├── deployment/
│   ├── deployer.js          # plans and applies file operations
│   ├── tmdl-writer.js       # block-level TMDL edits
│   └── validator.js         # pre-deploy dependency validation
├── fabric/
│   ├── auth.js              # MSAL OAuth2 + PKCE
│   ├── api-client.js        # Fabric / Power BI REST client
│   ├── model-loader.js      # Fabric TMDL → model
│   └── connection-parser.js # connection string → workspace + model
├── lib/
│   ├── activity-log.js      # JSONL activity log
│   ├── refresh-store.js     # refresh session tracking
│   ├── session-store.js     # per-tab comparison state
│   └── raw-files.js         # snapshot drift comparison
├── public/                  # frontend (single page)
│   ├── index.html
│   ├── css/style.css
│   └── js/{app,pure,diff}.js
├── test/                    # node:test suite
└── assets/                  # README images + their sources
```

### Where a change usually goes

| Symptom | Start here |
|---|---|
| A TMDL construct is misparsed or ignored | `parser/tmdl-parser.js` (check `OBJECT_TYPES` first) |
| A real difference is not reported | `comparison/extractor.js` (the property is probably not extracted) |
| Two objects are wrongly paired, or wrongly split | `comparison/keys.js` |
| Changes are grouped together that should not be | `comparison/engine.js` (`isStructuralDiff`) |
| A deploy writes nothing but reports success | `deployment/deployer.js` (the plan step returned no operations) |
| A deploy writes the wrong bytes | `deployment/tmdl-writer.js` |
| A deploy should have been blocked | `deployment/validator.js` |

## Regenerating the README images

The banner, logo and four diagrams are rendered from source in `assets/src/`. The two screenshots are captured from the running app against a throwaway pair of models. Nothing in the README is mocked up by hand.

This needs Playwright's Chromium, which is a development-only tool and deliberately not a dependency of the app:

```bash
npm install --no-save playwright
npx playwright install chromium

node assets/src/render.js        # logo, banner, 4 diagrams
node assets/src/screenshots.js   # 2 product screenshots
```

Both scripts accept `PLAYWRIGHT_PATH` if Playwright is installed somewhere else.

`assets/src/logo.svg` is the single source for the product mark. `render.js` emits it twice: `assets/logo.png` at 512px for docs, slides and anywhere the mark is needed on its own, and `public/favicon.png` at 128px, which the app serves as its browser-tab icon.

Editing an image means editing its source (`assets/src/*.html`, `assets/src/logo.svg`, `assets/src/theme.css`) and re-running the script. Do not touch the PNGs directly. `screenshots.js` neutralises the backup-path field before capturing, so no local filesystem path from the machine that ran it ends up in a published image.
