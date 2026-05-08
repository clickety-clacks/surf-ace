# @surf-ace/extension

OpenClaw Surf Ace extension package.

This package owns:

- Bonjour/mDNS discovery for `_surf-ace._tcp`
- Persistent WebSocket connection jobs per paired surface
- Local pane content/readback buffers for `surf_ace_read`
- CLU tool registration for Surf Ace surface operations

## Provider Placement

Surf Ace OpenClaw extension/provider installs and provider identity/state belong on TARS only. Do not install or run this package under `~/.openclaw/extensions/surf-ace/` on eezo or other non-TARS hosts; eezo may run the Surf Ace Electron client for display/testing.

Deploy provider changes with `make -C packages/extension deploy-tars`. The deploy target fails closed for non-TARS deploy hosts unless `SURF_ACE_ALLOW_NON_TARS_PROVIDER=1` is set for an explicit approved override. The runtime entrypoint enforces the same guard before resolving OpenClaw state or starting the provider.
