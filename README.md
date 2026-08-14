# Surf Ace

Turn any screen into an OpenClaw-managed surface. Push content, read annotations, orchestrate displays across devices.

## Packages

| Package | Description |
|---|---|
| `packages/protocol` | Shared TypeScript types and JSON Schema for the wire protocol |
| `packages/extension` | OpenClaw extension — provider-side WS client, OpenClaw tools, Bonjour discovery |
| `packages/ios` | iOS/iPadOS surface app (Swift) |
| `packages/electron` | Electron surface app (macOS/Windows/Linux) |

## Spec

Full wire protocol spec: [DESIGN.md](./DESIGN.md)

UI flows reference: [docs/design/surf-ace-ui-flows.html](./docs/design/surf-ace-ui-flows.html)

## Repo

`clickety-clacks/surf-ace`

## Development Workflow

Extension/provider startup requires an explicit host allowlist. Set `SURF_ACE_PROVIDER_ALLOWED_HOSTS` to the approved comma-separated host names. Startup fails when this value is absent, malformed, or does not include the current host.

Provider deployment also requires explicit configuration. Set `SURF_ACE_EXTENSION_DEPLOY_HOST` to a valid destination host name, then run `make -C packages/extension deploy-provider`. The deploy target fails before packaging when the value is absent or malformed.

Persistent launchd/auto-start installation requires `SURF_ACE_AUTOSTART_ALLOWED_HOSTS`. Set it to the approved comma-separated host names before `pnpm --filter @surf-ace/electron launchd:install`. The installer fails when this value is absent, malformed, or does not include the current host. Manual foreground startup does not use this install guard.

Provider runtime state must use the standard OpenClaw extension state root: `~/.openclaw/extensions/surf-ace/`. The legacy standalone state root `~/.surf-ace-openclaw-extension` is non-standard and must not be used for durable installs, gateway runtime, or soak harnesses.

### OpenClaw Tool Admission

Surf Ace is an OpenClaw plugin tool surface. In installs that use the normal coding tool profile, the plugin must be explicitly admitted in `~/.openclaw/openclaw.json`; plugin installation/enabling alone is not enough to make `surf_ace_*` tools visible to OpenClaw sessions.

Required OpenClaw config:

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
- [x] Extension package (WS runtime, OpenClaw tools, discovery, reconnect)
- [ ] iOS surface app
- [ ] Electron surface app
