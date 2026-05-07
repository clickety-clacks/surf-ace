# Surf Ace

Turn any screen into a CLU-managed surface. Push content, read annotations, orchestrate displays across devices.

## Packages

| Package | Description |
|---|---|
| `packages/protocol` | Shared TypeScript types and JSON Schema for the wire protocol |
| `packages/extension` | OpenClaw extension — provider-side WS client, CLU tools, Bonjour discovery |
| `packages/ios` | iOS/iPadOS surface app (Swift) |
| `packages/electron` | Electron surface app (macOS/Windows/Linux) |

## Spec

Full wire protocol spec: [DESIGN.md](./DESIGN.md)

UI flows reference: [docs/design/surf-ace-ui-flows.html](./docs/design/surf-ace-ui-flows.html)

## Repo

`clickety-clacks/surf-ace`

## Development Workflow

Extension/provider installs are TARS-only. Do not copy, rsync, package-install, or run the Surf Ace OpenClaw extension/provider under `~/.openclaw/extensions/surf-ace/` on eezo or any other non-TARS host; that creates phantom ownership/discovery state. Eezo may run the Surf Ace Electron client for display/testing.

Use `make -C packages/extension deploy-tars` for provider deploys. The deploy target defaults to TARS and refuses non-TARS deploy hosts unless `SURF_ACE_ALLOW_NON_TARS_PROVIDER=1` is set for an explicit approved override. Manual provider syncs must also target TARS only.

Surf Ace launchd/auto-start installs are also TARS-only. Do not run `pnpm --filter @surf-ace/electron launchd:install` on eezo/non-TARS hosts. Use `pnpm --filter @surf-ace/electron start` for temporary foreground Electron display testing on eezo. The launchd installer refuses non-TARS hosts unless `SURF_ACE_ALLOW_NON_TARS_AUTOSTART=1` is set for an explicit approved override.

Provider runtime state must use the same standard OpenClaw extension state root on TARS: `/Users/mike/.openclaw/extensions/surf-ace/`. The legacy standalone state root `~/.surf-ace-openclaw-extension` is non-standard and must not be used for durable installs, gateway runtime, or soak harnesses.

## Status

- [x] Wire protocol spec (DESIGN.md)
- [x] Protocol package (types + JSON Schema)
- [x] Extension package (WS runtime, CLU tools, discovery, reconnect)
- [ ] iOS surface app
- [ ] Electron surface app
