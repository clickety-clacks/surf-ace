# @surf-ace/electron

Electron surface app for Surf Ace.

## Launch Modes

Manual foreground launches are allowed on eezo/non-TARS hosts for display testing:

```bash
pnpm --filter @surf-ace/electron start
```

Persistent launchd/auto-start installation is TARS-only. Do not run `pnpm --filter @surf-ace/electron launchd:install` on eezo or other non-TARS hosts. The installer fails closed outside TARS unless `SURF_ACE_ALLOW_NON_TARS_AUTOSTART=1` is set for an explicit approved override. `launchd:uninstall` remains available on non-TARS hosts so stale jobs can be removed.
