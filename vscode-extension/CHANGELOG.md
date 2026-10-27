# Changelog

## 5.2.0 (Preview)

First release of Model Alchemist as a VS Code extension, on the same engine as the web app 5.2.0.

- The web UI in a VS Code panel: compare two Power BI semantic models across eleven change groups, review the changed fragments, and deploy only the objects you tick, with dependency validation, backup, preview and a transactional local write.
- Model Alchemist icon in the Activity Bar with a start view: open the panel, compare two models, open the logs folder.
- **Model Alchemist: Compare with…** on a `.SemanticModel` folder or `.pbip` file in the Explorer.
- Folder picker and export through VS Code's dialogs; a local deploy asks first when target files have unsaved edits.
- Microsoft Fabric sources and targets, signed in with the Microsoft account in VS Code. Settings `modelAlchemist.fabric.clientId` and `modelAlchemist.fabric.tenant` for directories that need another sign-in app.
- Role members are not compared or deployed (Power BI assigns them in the service), and a model's culture is never changed (`MODEL_CULTURE_IMMUTABLE`, `MODEL_CULTURE_KEPT`).
- Backups and logs in the extension's storage, or in `modelAlchemist.backupPath` / `modelAlchemist.logPath`.
