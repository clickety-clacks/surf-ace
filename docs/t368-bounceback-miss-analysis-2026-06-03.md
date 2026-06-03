# T368 Bounceback Miss Analysis - 2026-06-03

## Observed Miss

Flynn verification bounced T368 back because native app pane window id/chrome was still clipped in a constrained native app pane. The referenced screenshot path was not present locally at `/Users/mike/.openclaw/clawline-media/assets/a_5e9e801a-6d1a-416e-b22c-11d35794abaf`, so this analysis is based on the live T368 ticket bounceback text, the source spec at `/Users/mike/shared-workspace/surf-ace/specs/native-pane-window-groups.html`, and current source.

## Miss Cause

The previous T368 slice modeled pane window groups and sent `clipToPane` / `constrainToPane` policy, but the policy did not encode any explicit chrome reachability budget. That left native app windows constrained to the pane rectangle in the abstract while still allowing toolkit/window chrome or Surf Ace-visible identity affordances to sit on a clipping edge in real native apps.

The product requirement is stricter than "pixels do not escape the pane": R6 requires dragging/clamping to preserve a visible reachable title/control area inside the pane, and R8 requires Surf Ace chrome/hit regions to remain visually coherent and usable when native app windows are present.

## Architecture Fit

The repair belongs in Electron's internal native-pane host projection and bridge types. Providers still submit pane-targeted `target.apply` payloads and never provide compositor geometry, pane instance ids, or chrome constants. Direct compositor/native-pane hosting remains diagnostic only.

The source repair should therefore project an internal window-group policy field that tells the compositor/native-pane host how much pane-edge space must remain reachable for native window chrome while preserving the same official provider/materialization path.

## Engram

Queried:

- `engram explain packages/electron/src/surface-core.ts:710-820`
- `engram explain packages/electron/src/renderer/renderer.ts:330-430`

Result: Engram returned earlier geometry/overlay projection sessions but no specific rationale that justified omitting a chrome reachability policy from T368. It did not change the repair direction.
