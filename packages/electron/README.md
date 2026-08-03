# @surf-ace/electron

Electron surface app for Surf Ace.

## Launch Modes

Manual foreground launches are allowed on eezo/non-TARS hosts for display testing:

```bash
pnpm --filter @surf-ace/electron start
```

Persistent launchd/auto-start installation is TARS-only. Do not run `pnpm --filter @surf-ace/electron launchd:install` on eezo or other non-TARS hosts. The installer fails closed outside TARS unless `SURF_ACE_ALLOW_NON_TARS_AUTOSTART=1` is set for an explicit approved override. `launchd:uninstall` remains available on non-TARS hosts so stale jobs can be removed.

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
