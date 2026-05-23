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

### OpenClaw Tool Admission

Surf Ace is an OpenClaw plugin tool surface. In installs that use the normal coding tool profile, the plugin must be explicitly admitted in `~/.openclaw/openclaw.json`; plugin installation/enabling alone is not enough to make `surf_ace_*` tools visible to CLU sessions.

Required TARS OpenClaw config:

    {
      "tools": {
        "profile": "coding",
        "alsoAllow": ["surf-ace"]
      },
      "plugins": {
        "allow": ["surf-ace"],
        "entries": {
          "surf-ace": { "enabled": true }
        }
      }
    }

Use `tools.alsoAllow`, not `tools.allow`, when the install should keep the normal coding tools and add Surf Ace. `tools.allow: ["surf-ace"]` is plugin-only admission and can hide the normal coding profile tools.

After changing tool admission, reload OpenClaw/gateway sessions before verification. The product-level proof is that a normal session declares the `surf_ace_*` tools and a harmless `surf_ace_list` succeeds through that tool surface. Direct Surf Ace HTTP/WS calls, provider logs, DNS-SD, screenshots, and stale pane IDs are diagnostic only; they are not proof that the operator surface is installed correctly.

Native GUI/app materialization has the same real-path rule. Product proof must launch through the official Surf Ace provider/tool path, `surf_ace_launch_native_app` with `confirmed:true`, against an actionable provider-admitted pane. The proof must show the provider-owned target state and materialization evidence for that pane, including `nativeHost: "applied"` and `overlayRegions: "applied"`, plus visible rendering in the pane. Direct compositor calls such as `native_pane.host`, native-pane demo fixtures, mocked compositor status, or manually hosted windows are lower-layer diagnostics only; they must not be reported as Surf Ace production/spec proof.

## Status

- [x] Wire protocol spec (DESIGN.md)
- [x] Protocol package (types + JSON Schema)
- [x] Extension package (WS runtime, CLU tools, discovery, reconnect)
- [ ] iOS surface app
- [ ] Electron surface app
