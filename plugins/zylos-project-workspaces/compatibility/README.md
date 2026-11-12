# Zylos Console compatibility layer

This plugin owns all locally developed Zylos console behavior:

- project-scoped workspaces and Codex runner sessions;
- project and conversation isolation in the Web Console and C4 dispatcher;
- configured-model display, attachment preview fallback, persistent thinking state,
  and per-conversation unsent message drafts.

The Web Console and C4 bridge remain Zylos-managed runtime sources. This plugin
keeps a versioned baseline plus the local customization for each touched source.
After a Core upgrade, `apply-overrides.mjs` uses a three-way merge to replay the
customization onto the upgraded source. It never writes any source when a merge
conflicts.

## Upgrade workflow

```bash
node /home/zylos-cm/plugins/zylos-project-workspaces/scripts/apply-overrides.mjs --check
node /home/zylos-cm/plugins/zylos-project-workspaces/scripts/apply-overrides.mjs --apply
pm2 reload web-console c4-dispatcher
```

`--check` is read-only. `--apply` creates a timestamped backup of only the
touched runtime files before writing. Review and resolve any reported conflict,
then run the command again. Do not copy older snapshots over a new Core version.

Run the read-only verifier after applying the overlay or updating either component:

```bash
/home/zylos-cm/.nvm/versions/node/v22.22.3/bin/node \
  /home/zylos-cm/plugins/zylos-project-workspaces/scripts/verify-project-workspaces.mjs
```

It validates project ownership, conversation ownership, workspace bindings,
running project session directories, project-route selection, attachment
scoping, and the absolute Node reply path. It does not read C4 message
content. If it fails after an upgrade, do not restart or migrate project data;
repair the compatibility break first and rerun the verifier.
