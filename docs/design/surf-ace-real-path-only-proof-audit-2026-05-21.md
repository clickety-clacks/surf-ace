# Surf Ace Real-Path-Only Proof Audit

Date: 2026-05-21

## Decision

Surf Ace native GUI/app materialization is product-proven only through the official provider/materialization path. Direct compositor or `native_pane.host` success is lower-layer diagnostic evidence only.

## Required Product Gate

A production/spec proof for native GUI/app materialization must show all of the following for the same pane:

- `surf_ace_list` reports the target surface and pane as connected, provider-admitted, and actionable.
- The launch enters through the official Surf Ace provider/tool path, such as `surf_ace_launch_terminal` with `confirmed:true`.
- The provider-owned `target.apply` result reports the same target pane and materialization evidence.
- `nativeHost` is `applied`.
- `overlayRegions` is `applied`.
- Product-approved capture shows the GUI/app visibly rendered inside that Surf Ace pane.

## Reclassified Evidence

The following evidence may diagnose implementation failures but must not satisfy Surf Ace product proof or be offered as a user-facing escape hatch:

- direct compositor calls
- direct `native_pane.host` or `native_pane.update` success
- manually hosted native windows
- disabled native-pane demo fixtures
- fake WebSocket servers or unit/integration harnesses
- mocked compositor status
- provider logs, lower-layer logs, DNS-SD, direct HTTP/WS calls, stale pane IDs, or screenshots not tied to the official provider result

## Source Audit Result

- `DESIGN.md` now defines the native GUI/app product proof gate at `surf_ace_launch_terminal` and restates that native-host special cases are internal implementation seams.
- Root and extension READMEs now classify native materialization proof separately from installation/topology proof.
- The Surf Ace ops skill, generated agent instructions, and `surf_ace_launch_terminal` tool description now tell operators that direct compositor/native-pane hosting is diagnostic-only.
- `disabled-native-pane-demo.mjs` remains disabled and now rejects use of direct compositor/native-pane hosting as product proof in its own failure text.
- Existing compositor/native-pane implementation and tests remain valid only as internal machinery/regression coverage for the provider-owned path.

## Remaining Product Gap

This audit does not deploy or prove a runtime. Final product acceptance still requires Flynn-approved OpenClaw proof against the live tablet-a Surf Ace provider/runtime using the official launch path and capture requirements above.
