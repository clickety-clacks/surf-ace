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

After making extension changes, run `pnpm deploy:extension` on TARS to deploy to the live gateway.

## Status

- [x] Wire protocol spec (DESIGN.md)
- [x] Protocol package (types + JSON Schema)
- [x] Extension package (WS runtime, CLU tools, discovery, reconnect)
- [ ] iOS surface app
- [ ] Electron surface app
