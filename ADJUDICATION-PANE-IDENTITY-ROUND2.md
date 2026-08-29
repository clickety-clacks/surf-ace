# Pane Identity Round 2 Adjudication

Scope adjudicated:
- [REVIEW-PANE-IDENTITY-ROUND2.md](./REVIEW-PANE-IDENTITY-ROUND2.md)
- [DESIGN.md](./DESIGN.md)
- [scratch/pane-id-pane-label-migration-20260328.md](./scratch/pane-id-pane-label-migration-20260328.md)

## Decision Summary

All three round-2 blockers were accepted as valid spec blockers.

The fixes were applied in [DESIGN.md](./DESIGN.md). The migration note did not require amendment for this round because it was already aligned with the intended pane-label payload contract and split semantics.

## Blocker Adjudication

### 1. Pair handshake prose/schema mismatch

Status: `accepted and fixed`

Reason:
- Round 2 was correct that the prose required `initialPaneLabel` and `pair.response.state.panes[].paneLabel`, while the embedded schema omitted them.
- That was a real authoritative-spec contradiction, not a review false positive.

Fix applied:
- Added `PaneLabel` schema type.
- Added `initialPaneLabel` to `PairRequest.payload.required` and properties.
- Added `paneLabel` to `PairResponse.state.panes[]` required fields and properties.

### 2. Pane list/split/lifecycle prose/schema mismatch

Status: `accepted and fixed`

Reason:
- Round 2 was correct that the prose required pane-label-bearing payloads for `panes.list`, `pane.split`, and `event.pane_created`, while the embedded schema still described older payload shapes.
- The migration note already identified these payloads as required for the coupled pane-label protocol phase.

Fix applied:
- Added `paneLabel` to `PanesListResponse.panes[]`.
- Added `newPaneLabels` to `PaneSplitRequest.payload.required` and properties.
- Added `paneLabel` to `PaneSplitResponse.panes[]`.
- Added `paneLabel` to `PaneCreatedEvent.payload.required` and properties.

### 3. OpenClaw split-tool contract omitted provider-assigned pane labels

Status: `accepted and fixed`

Reason:
- Round 2 was correct that the tool prose still said only `paneId` values were assigned during split, while the normative pane-split operation said the provider assigns both internal ids and visible labels.
- That was a tool-contract contradiction inside the spec.

Fix applied:
- Updated the `surf_ace_split` behavior text to state that the provider assigns both internal `paneId` values and visible `paneLabel` values for newly created panes.

## Scratch Note Disposition

Status: `no patch required`

Reason:
- [scratch/pane-id-pane-label-migration-20260328.md](./scratch/pane-id-pane-label-migration-20260328.md) already matched the intended outcome for these three blockers:
  - coupled Phase 2 rollout
  - `initialPaneLabel` in pair bootstrap
  - `paneLabel` in pair/list/split/lifecycle payloads
  - provider-owned visible pane labels during split
- No additional migration-document change was necessary to resolve the round-2 findings.

## Result

Round 2 adjudication outcome: patch the authoritative spec, then rerun adversarial review.
