# T368 Implementation Review - 2026-06-03

## Scope

Reviewed the T368 bounceback repair against `/Users/mike/shared-workspace/surf-ace/specs/native-pane-window-groups.html`.

Changed source:

- `packages/electron/src/native-pane-bridge.ts`
- `packages/electron/src/surface-core.ts`
- `packages/electron/test/surface-core.test.ts`
- `packages/electron/test/ws-server.test.ts`
- `docs/t368-bounceback-miss-analysis-2026-06-03.md`

## Spec Check

- R4: native app windows remain pane-owned and clipped to the pane rectangle.
- R6: window-group policy now carries explicit chrome reachability insets so native window title/control chrome is not clamped directly to a clipping edge.
- R8: the repair stays inside Electron's compositor projection seam and does not change provider-facing `target.apply`.
- R10/NG3: no direct compositor/native-pane path was used as product proof.
- R12: no launchd, service, persistence, restart, or deploy change was made.

## Review Result

Result: approved with product-proof gap.

No source blocker found in the Electron projection/bridge patch. The main residual risk is runtime compatibility: the real native-pane compositor/runtime must honor `windowGroup.policy.chromeInsets` for this to fix Flynn's observed native-app chrome clipping. That requires approved Surf Ace/Racter runtime deployment and official provider/materialization proof before the ticket can move past source readiness.

## Gates

- `pnpm --filter @surf-ace/electron build`: pass
- `pnpm --filter @surf-ace/protocol test`: pass, 20/20
- `node --test packages/electron/dist/test/native-pane-bridge.test.js packages/electron/dist/test/surface-core.test.js packages/electron/dist/test/ws-server.test.js packages/electron/dist/test/renderer-sizing.test.js`: pass, 187/187
- `git diff --check`: pass
