# DESIGN.md Consistency Review

Reviewed file: `/Users/mike/src/surf-ace-openclaw-extension/DESIGN.md`

1. Lines 238-245 and 268-277 define `### 4.6 iOS / iPadOS Background Behavior` twice, and the two sections disagree. Lines 242-245 say the WebSocket drops immediately on background and state is kept in memory only; lines 272-275 instead specify a 30-second background-task grace period that keeps the socket alive and accepts pushes. That directly conflicts with the settled “WS drops in background” behavior and leaves duplicate section numbering.

2. Lines 243-245 and 274-277 require `event.surface_resumed`, but that event is not part of the event model or schema. It does not appear in the event lists at lines 480-486, 530-543, the `oneOf` event refs at lines 654-679, or `EventType` at lines 757-772.

3. Lines 56, 69, 161, 387-394, 1615, 2017-2055, and 2870 still define pane focus as part of Phase 1 topology (`focus/select` lifecycle, `pane.focus`, and keyboard shortcuts that focus panes) even though the spec’s current invariant at lines 124-125 says there is no focused-pane concept.

4. Lines 367, 376, 1438-1448, 1925-1942, 2267, and 2589-2590 still expose `focused` / `focusedPaneId` in pair responses, panes lists, hardening text, and the CLU tool return shape. That contradicts lines 124-125 (“there is no concept of a focused pane”). Line 2589 is also self-contradictory because it lists `focusedPaneId` while saying it should be omitted.

5. Lines 678-689 keep removed focus/history-entry schema refs (`PaneFocusedEvent`, `HistoryList*`, `HistoryClose*`, `HistoryEntry*`), line 716 keeps `HistoryEntryId`, and line 1403 still mentions history-entry lifecycle events. None of those `$defs` exist later in Section 10, so these are dead cross-references/orphaned schema artifacts.

6. Lines 1092-1097, 1176-1181, 1205-1210, 1249-1254, 1273-1278, 1300-1307, and 1964-1969 describe `paneId` as required, but the JSON Schema `required` arrays for `content.set`, `content.append`, `content.patch`, `content.clear`, `annotations.remove`, `snapshot.get`, and `pane.split` do not include `paneId`. That contradicts lines 71-72, 124-125, and 2572.

7. Line 2355 still describes the tool as `surf_ace_read(fingerprint, paneId?)`, and lines 3275-3277 still call pane targeting an “optional selector,” even though the rest of the spec says `paneId` is required on all pane-scoped calls.

8. Lines 164-169 say window labels and initial pane IDs are assigned by the provider/extension during pairing, but lines 334-340 and schema lines 1006-1034 make pre-pair `surfaces.list` return `autoLabel` and optionally pane summaries with `paneId`. That makes the surface authoritative for identifiers the prose says are provider-assigned during pairing.

9. Lines 381-383 say the extension specifies new `paneId` values in `pane.split`, but the prose request field list and the schema at lines 1961-1979 provide no field for new pane IDs. That prevents the extension-controlled ID assignment described at lines 165 and 168.

10. Lines 733-743 still allow legacy string pane IDs (`root`, `pane_<n>`), which conflicts with the normative model at lines 98, 124-125, 157, and 165 that says pane IDs are globally unique numeric identifiers assigned by the provider/extension.

11. Lines 376, 1928-1934, and 2834 describe pane names as user-assigned or say a user may assign a custom pane name. That contradicts lines 166 and 397-405, which say pane naming is extension-to-surface only and there is no user-facing rename UI.

12. Lines 405 and 2834 conflict directly on UI ownership. Line 405 says topology is fully extension-controlled with no user-initiated rename or split UI; line 2834 says users can assign custom pane names.

13. Lines 429-430 say CLU does not list, target, or reason about individual history entries, but lines 681-689, 2326-2331, and 3330 still refer to history-entry requests/events/skills and “pane/history entry lifecycle events.” Those references are residual inconsistencies after history entries became internal-only.

14. Lines 442-445 and 2901 still place Back/Forward and restore-failure UI in a “pane header,” but lines 2876-2883 say there is no fixed pane header bar and controls live in a bottom-center floating cluster. The UI chrome model is internally inconsistent.

15. Lines 261-265 and 2950-2958 define incompatible connection-state UI. The keepalive section says healthy state may show “no indicator or neutral” and reconnect may appear as a subtle chip in window chrome; §15.7 says a persistent 2px line is always rendered and the connected state is a solid green line.

16. Line 2912 says the drawing-flush indicator stops when “the provider acknowledges receipt,” but the protocol defines no event ack from provider to surface. Lines 563-567 instead say the indicator hides when transmission finishes (success or terminal failure).

17. Lines 2976-2979 and 2990 in the UI/UX Invariants Index cite §4.4 for connectivity UI, but the actual indicator rules are at lines 260-266 under §4.5, not §4.4. The index also introduces text (“one ping missed or latency high”) that does not exist in the source section.

18. Lines 2982, 2999, 3001, 3002, and 3025 in the UI/UX Invariants Index are stale against the normative UI section. They still claim pane focus visibility exists, Done is a top-right pill, annotation mode adds a small “Annotating” badge, controls remain visible while annotating, and UI details are still a TODO, all of which disagree with lines 2844-2849 and 2876-2884.

19. Lines 3200-3202 and 3221 in Appendix A.7 are also stale against the current normative UI. They describe an “Annotate” button on Electron, pane-header controls, a top-right Done pill, and UI/presentation as a separate TODO, which conflicts with lines 2842-2849, 2876-2884, and 2815.

20. Line 3217 references “Section 6.2,” but Section 6 has no `6.2` subsection. This is a dead cross-reference.

21. Lines 3253 and 3255 reference “Section 6.9,” but Section 6 has no `6.9` subsection. These are dead cross-references.

22. Line 2751 says strokes disappear from the surface display when annotation mode exits, but lines 106 and 494 say annotations persist until the provider explicitly removes them. That is a separate behavioral inconsistency unrelated to content changes.
