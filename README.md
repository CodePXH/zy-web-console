# Zylos Console Customizations

An upgrade-safe local plugin for Zylos Web Console customizations and isolated
project workspaces.

It provides project-scoped workspaces and Codex runner sessions, scoped
conversations and attachments, model information in the console header,
attachment rendering fallback, persistent thinking indicators, and unsent
per-conversation drafts.

## Install on another machine

Prerequisites: Git, Node.js, Codex CLI, Zylos, and the `web-console` and
`comm-bridge` services installed by Zylos.

```bash
git clone git@github.com:CodePXH/zy-web-console.git
cd zy-web-console
codex plugin marketplace add "$PWD"
codex plugin add zylos-project-workspaces@zy-web-console
node plugins/zylos-project-workspaces/scripts/apply-overrides.mjs --check
node plugins/zylos-project-workspaces/scripts/apply-overrides.mjs --apply
pm2 reload web-console c4-dispatcher
```

The overlay targets `~/zylos` by default. For another installation, set
`ZYLOS_DIR` before running the scripts.

```bash
ZYLOS_DIR=/path/to/zylos \
  node plugins/zylos-project-workspaces/scripts/apply-overrides.mjs --apply
```

## After a Zylos Core upgrade

Run the same `--check` command. If there are pending files, use `--apply` and
reload the two services. The script combines the upgraded file, its saved Core
baseline, and the local customization with a three-way merge. It stages every
result first; a merge conflict writes no live file and requires an intentional
compatibility update.

## Repository layout

- `marketplace.json` — local Codex marketplace entry
- `plugins/zylos-project-workspaces/` — installable plugin source
- `baseline/` — Zylos Core source used to derive the customization
- `overrides/` — current local customization

No runtime database, upload, session, environment, SSH, or API credential is
included in this repository.
