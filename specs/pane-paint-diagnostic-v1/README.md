# Pane paint diagnostic v1 contract

Mike approved this separate specification PR in ruling
`dr_7ef1e022-1324-4b06-a8b0-85dda410a481`. The normative behavior is in
[`DESIGN.md` §12.1](../../DESIGN.md); `schema.json` defines the optional
request and handled-response shapes, and `REFUSAL-MATRIX.md` plus
`semantic_model.py` define the ordered receipt and replay rules that JSON
Schema alone cannot express.

This is a **specification only**. `packages/protocol/schema.json`, its message
unions, runtime dispatch, feature advertisement, and capture adapters are not
changed here. Clients must not send `diagnostics.pane_paint.get` unless a later
reviewed implementation advertises `surf-ace.pane-paint-diagnostic.v1`. Ordinary
`snapshot.get` behavior is unchanged.

Run the contract-model suite with:

```sh
python3 specs/pane-paint-diagnostic-v1/test_contract.py
```

The suite uses `jsonschema` and synthetic bytes. It checks contract consistency
and refusal/replay semantics; it does not prove captured pixels, physical display,
guest ownership, adapter cancellation, or pane recovery. Before implementation,
integrate the operation into the production protocol unions, error-operation
enum and capability advertisement, then test real adapters and compatibility.
