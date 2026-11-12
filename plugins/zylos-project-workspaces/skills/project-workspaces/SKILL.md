---
name: project-workspaces
description: Maintain the locally developed Zylos Web Console customizations, including user-scoped projects, project-scoped conversations, dedicated project working directories, attachment safety, model information, thinking state, and per-conversation drafts.
---

# Zylos Console Customizations

This plugin owns the local Zylos Console customizations. The source snapshots
under `baseline/` and `overrides/` are the authoritative compatibility layer.

Before changing the integration, verify that every project record is owned by a
single user, every conversation belongs to one project, and every runner session
uses only that project's working directory. Never expose project data, drafts,
attachments, or runner output across users or projects.

After a Zylos Core upgrade, run `scripts/apply-overrides.mjs --check`. If it
reports pending files, run it with `--apply`, reload `web-console` and
`c4-dispatcher`, then run `scripts/verify-project-workspaces.mjs`. If a merge
conflicts, do not overwrite the upgraded file: resolve the compatibility change,
update this plugin's baseline and override snapshots, and verify again.
