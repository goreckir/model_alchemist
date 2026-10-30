# Beta: Git branch compare and pull requests

Thank you for testing. This beta adds Git to Model Alchemist: compare two branches of a repository, then deploy the selected changes into a new branch and open a draft pull request. What changed is listed in [RELEASE_NOTES.md](../RELEASE_NOTES.md) under `v5.3.0-beta.1`.

## Before you start

- **Use a sandbox repository**, never your team's real one. A deploy pushes a new branch with your own Git credentials. A private repository on your own GitHub account or an Azure DevOps project you can delete is ideal.
- **Use the Demo Kit or a model of your own.** Never use a client's model, and do not paste model contents into a public issue.
- Leave **Open as a draft** switched on.

## Install next to your stable copy

The beta goes into its own folder, so your current installation keeps working.

```powershell
git clone --branch v5.3.0-beta.1 https://github.com/goreckir/model_alchemist.git model_alchemist-beta
cd model_alchemist-beta
npm install
npm start
```

The header shows **v5.3.0-beta.1 · Beta**. If you are asked to test a newer beta later:

```powershell
git fetch --tags
git checkout v5.3.0-beta.2
npm install
```

Requirements on top of the README's: Git 2.28 or newer. For pull requests: [GitHub CLI](https://cli.github.com/) signed in (`gh auth login`), or for Azure DevOps the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) with the DevOps extension (`az extension add --name azure-devops`) and `az login`.

## Create a sandbox repository from the Demo Kit

Run from the beta folder. It creates `main` with the "production" model and `dev` with the changed one.

```powershell
$beta = (Get-Location).Path
$repo = "$HOME\alchemist-sandbox"
New-Item -ItemType Directory $repo | Out-Null
Copy-Item -Recurse "$beta\demo\prod\*" $repo
cd $repo
"**/.pbi/" | Set-Content .gitignore -Encoding ascii
git init -b main
git add -A
git commit -m "Production model"
git switch -c dev
Remove-Item -Recurse Apothecary.SemanticModel, Apothecary.Report
Copy-Item -Recurse "$beta\demo\dev\*" .
git add -A
git commit -m "Development changes"
```

To test pull requests, create an **empty** repository on GitHub or Azure DevOps, then:

```powershell
git remote add origin <URL of the empty repository>
git push -u origin main dev
```

## What to test

Do what fits your setup; every scenario helps. Note the result of each one.

| # | Scenario | Expected |
|---|---|---|
| 1 | Source: **🌿 Git**, sandbox, branch `dev`. Target: **🌿 Git**, same repository, branch `main`. Compare. | Same differences as comparing `demo\dev` with `demo\prod` as folders |
| 2 | Source: a **Local** folder. Target: **🌿 Git** branch `main`. Compare. | Differences between the folder and the branch |
| 3 | After scenario 1, commit something to `main` outside the app (or push from another clone and click **Fetch**), then return to the app. | The target panel warns that the branch has moved since the comparison |
| 4 | Select a few objects, **Deploy**. Switch off **Push the branch and open a pull request**. Confirm. | A new local branch with one commit containing only the selected objects. `git status` in your checkout is unchanged |
| 5 | Same with push and pull request on a **GitHub** remote. | Branch pushed; a **draft** pull request into `main` opened; its link shown in the result |
| 6 | Same on an **Azure DevOps** remote. | As 5 |
| 7 | Error paths: reuse an existing branch name; deploy with `user.email` unset; uninstall or sign out of `gh`/`az`; push to a repository you cannot write to. | A clear message in the dialog or result, nothing half-done. Without the CLI: the branch is pushed and a link opens the pull request page |
| 8 | On Windows with `git config core.autocrlf true`: deploy and open the commit diff. | Only the selected objects change, no whole-file line-ending changes |

Also useful: GitHub Enterprise, SSH remotes (`git@...`), a large repository, macOS or Linux.

## How to report

Open an issue at [github.com/goreckir/model_alchemist/issues/new/choose](https://github.com/goreckir/model_alchemist/issues/new/choose) and choose **Beta feedback**. A scenario that worked is worth reporting too: "Scenario 5 passed on GitHub, gh 2.x" tells us as much as a bug.

Include:

- the version from the header and your operating system;
- the remote type (GitHub, GitHub Enterprise, Azure DevOps, other, none) and whether it uses HTTPS or SSH;
- `git --version`, and `gh --version` or `az version` if used;
- what you did, what you expected, what happened;
- a screenshot of the deploy result, with model or company names hidden if needed.

If you cannot share details publicly, say so in the issue and we will move the conversation elsewhere.
