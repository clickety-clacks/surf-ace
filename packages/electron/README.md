# @surf-ace/electron

Electron surface app for Surf Ace.

## Launch Modes

Manual foreground launches are available for display testing:

```bash
pnpm --filter @surf-ace/electron start
```

Persistent launchd/auto-start installation requires `SURF_ACE_AUTOSTART_ALLOWED_HOSTS`. Set it to the approved comma-separated host names. The installer fails when the value is absent, malformed, or excludes the current host. `launchd:uninstall` remains available without the install configuration so stale jobs can be removed.
