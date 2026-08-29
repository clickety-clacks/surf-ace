# @surf-ace/electron

Electron surface app for Surf Ace.

## Launch Modes

Manual foreground launches are available for display testing:

```bash
pnpm --filter @surf-ace/electron start
```

Persistent launchd/auto-start installation requires `SURF_ACE_AUTOSTART_ALLOWED_HOSTS`. Set it to the approved comma-separated host names. The installer fails when the value is absent, malformed, or excludes the current host. `launchd:uninstall` remains available without the install configuration so stale jobs can be removed.

## Offline lockless rollback

Stop the Electron client before using this one-shot operator tool. The approved
legacy snapshot identity is supplied at rollout time; it is recorded in the
preview and is not selected by the package.

```bash
pnpm --filter @surf-ace/electron legacy-rollback preview --state-dir "$STATE_DIR" --state-file surface-core-state.json --legacy-snapshot "$LEGACY_SNAPSHOT" --output rollback-preview.json
pnpm --filter @surf-ace/electron legacy-rollback apply --state-dir "$STATE_DIR" --state-file surface-core-state.json --preview rollback-preview.json
```

The preview is machine-readable JSON containing the projected owner-free legacy
state and every lockless-only item that cannot be represented. To reinstall the
exact pre-migration generation captured by the rollout:

```bash
pnpm --filter @surf-ace/electron legacy-rollback restore --state-dir "$STATE_DIR" --state-file surface-core-state.json --generation rollout-pre-migration-state.json
```
