use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::net::TcpListener;
use std::process::Command as ProcessCommand;
use std::thread;
use std::time::Duration;
use surf_ace_cli::command::{Command, Invocation};
use surf_ace_cli::controller::{execute, execute_with_wire, CliError};
use surf_ace_cli::state::{CorrelationPhase, LockedStateRoot, UnresolvedCorrelation};
use surf_ace_cli::wire::{DirectWire, Envelope, WireFailure, WireResponse};
use tempfile::TempDir;
use tungstenite::{accept, Message};

struct FakeWire {
    ack_accepted: bool,
    close_count: usize,
    operations: Vec<String>,
    payloads: Vec<(String, Value)>,
    fail_after_send_on: Option<String>,
    pair_rejection: Option<Envelope>,
    receipt_capacity_on: Option<String>,
    target_precommit_error: Option<(String, Option<String>)>,
    committed_rejection_on: Option<String>,
    resolutions: Vec<Value>,
    scopes: Vec<Value>,
    response_events: BTreeMap<String, Vec<Envelope>>,
}

impl FakeWire {
    fn ordinary() -> Self {
        Self {
            ack_accepted: true,
            close_count: 0,
            operations: vec![],
            payloads: vec![],
            fail_after_send_on: None,
            pair_rejection: None,
            receipt_capacity_on: None,
            target_precommit_error: None,
            committed_rejection_on: None,
            resolutions: vec![],
            scopes: vec![],
            response_events: BTreeMap::new(),
        }
    }

    fn response(id: &str, op: &str, payload: Value) -> WireResponse {
        WireResponse {
            response: Envelope {
                id: Some(id.into()),
                op: op.into(),
                payload: Some(payload),
                envelope_type: "response".into(),
                v: 1,
                ok: Some(true),
                error: None,
                sent_at: None,
            },
            events: vec![],
        }
    }
}

impl DirectWire for FakeWire {
    fn request(
        &mut self,
        id: &str,
        op: &str,
        payload: Value,
        sent: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<WireResponse, WireFailure> {
        self.operations.push(op.into());
        self.payloads.push((op.into(), payload.clone()));
        sent().map_err(|code| WireFailure::AfterSend { code })?;
        if self.fail_after_send_on.as_deref() == Some(op) {
            return Err(WireFailure::AfterSend {
                code: "test_disconnect".into(),
            });
        }
        if op == "pair.request" {
            if let Some(response) = self.pair_rejection.clone() {
                return Ok(WireResponse {
                    response,
                    events: vec![],
                });
            }
        }
        if self.receipt_capacity_on.as_deref() == Some(op) {
            return Ok(WireResponse {
                response: Envelope {
                    id: Some(id.into()),
                    op: format!("{op}.result"),
                    payload: Some(json!({})),
                    envelope_type: "response".into(),
                    v: 1,
                    ok: Some(false),
                    error: Some(json!({ "code": "receipt_capacity" })),
                    sent_at: None,
                },
                events: vec![],
            });
        }
        if op == "target.apply" {
            if let Some((code, target_error_code)) = &self.target_precommit_error {
                return Ok(WireResponse {
                    response: Envelope {
                        id: Some(id.into()),
                        op: "target.apply.result".into(),
                        payload: Some(json!({})),
                        envelope_type: "response".into(),
                        v: 1,
                        ok: Some(false),
                        error: Some(json!({
                            "code": code,
                            "details": { "targetErrorCode": target_error_code }
                        })),
                        sent_at: None,
                    },
                    events: vec![],
                });
            }
        }
        if self.committed_rejection_on.as_deref() == Some(op) {
            let response = Envelope {
                id: Some(id.into()),
                op: op.into(),
                payload: None,
                envelope_type: "response".into(),
                v: 1,
                ok: Some(false),
                error: Some(json!({ "code": "stale_content" })),
                sent_at: None,
            };
            self.resolutions = vec![json!({
                "operationReceipt": { "commitSequence": 8, "requestId": id },
                "outcome": "resolved_failure",
                "requestId": id,
                "terminalResponse": serde_json::to_value(&response).unwrap()
            })];
            return Ok(WireResponse {
                response,
                events: self.response_events.remove(op).unwrap_or_default(),
            });
        }
        let mut response = match op {
            "pair.request" => Self::response(
                id,
                "pair.response",
                json!({
                    "capabilities": {},
                    "controllerInstanceId": payload["controllerInstanceId"],
                    "limits": {
                        "maxPendingOperationReceiptBytesPerController": 65536,
                        "maxPendingOperationReceiptsPerController": 16
                    },
                    "mode": "lockless",
                    "receiptResolutions": self.resolutions,
                    "resumed": false,
                    "scopes": self.scopes.clone(),
                    "sessionId": "session_test",
                    "state": null,
                    "surfaceId": payload.get("surfaceId").cloned().unwrap_or(Value::Null),
                    "surfaceSetRevision": 1
                }),
            ),
            "operation.receipt.sync" => Self::response(
                id,
                "operation.receipt.sync.result",
                json!({ "resolutions": self.resolutions }),
            ),
            "operation.receipt.ack" => Self::response(
                id,
                "operation.receipt.ack.result",
                json!({ "accepted": self.ack_accepted }),
            ),
            "consumable.ack" => {
                Self::response(id, "consumable.ack.result", json!({ "accepted": true }))
            }
            "surfaces.list" => Self::response(
                id,
                "surfaces.list.result",
                json!({ "surfaces": [{ "surfaceId": "sf_1" }] }),
            ),
            "snapshot.get" => {
                Self::response(id, "snapshot.result", json!({ "snapshotId": "sn_1" }))
            }
            "target.apply" => Self::response(
                id,
                "target.apply.result",
                json!({
                    "operationReceipt": {
                        "commitSequence": 7,
                        "operation": op,
                        "requestId": id
                    },
                    "operationRequestId": id,
                    "status": "intent_committed",
                    "surfaceId": payload["surfaceId"],
                    "targetEpoch": payload["targetEpoch"],
                    "targetId": payload["targetId"],
                    "targetRequestId": payload["requestId"]
                }),
            ),
            _ => Self::response(
                id,
                &format!("{op}.result"),
                json!({
                    "operationReceipt": {
                        "commitSequence": 7,
                        "operation": op,
                        "requestId": id
                    },
                    "revision": 7
                }),
            ),
        };
        response.events = self.response_events.remove(op).unwrap_or_default();
        Ok(response)
    }

    fn close(&mut self) -> Result<(), WireFailure> {
        self.close_count += 1;
        Ok(())
    }
}

fn invocation(temp: &TempDir, command: Command, input: Value) -> Invocation {
    Invocation {
        command,
        endpoint: Some("ws://unused.test".into()),
        input: input.as_object().cloned().unwrap_or_else(Map::new),
        product_label: Some("Clawline".into()),
        projection_capacity_bytes: 1024 * 1024,
        state_root: temp.path().into(),
    }
}

fn event(op: &str, payload: Value) -> Envelope {
    Envelope {
        id: None,
        op: op.into(),
        payload: Some(payload),
        envelope_type: "event".into(),
        v: 1,
        ok: None,
        error: None,
        sent_at: None,
    }
}

#[test]
fn command_surface_is_exact_and_matches_package_and_canonical_vectors() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let package: Value = serde_json::from_slice(
        &fs::read(manifest_dir.join("vectors/cli-conformance.json")).unwrap(),
    )
    .unwrap();
    let expected = Command::ALL
        .iter()
        .map(|command| command.name())
        .collect::<Vec<_>>();
    assert_eq!(expected.len(), 11);
    assert_eq!(package["commands"], json!(expected));
    assert_eq!(
        package["receiptResolutionOutcomes"],
        json!([
            "resolved_success",
            "resolved_failure",
            "not_committed",
            "still_pending",
            "receipt_unavailable"
        ])
    );
    let canonical: Value = serde_json::from_slice(
        &fs::read(manifest_dir.join("../protocol/vectors/authority-conformance.json")).unwrap(),
    )
    .unwrap();
    let vector_ids = canonical["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|vector| vector["id"].as_str())
        .collect::<Vec<_>>();
    for id in [
        "lockless-cross-language-wire-parity",
        "lockless-receipt-cross-connection-resolution",
        "lockless-receipt-capacity-precommit",
        "lockless-receipt-replay-not-request-replay",
        "lockless-target-precommit-rejection-classification",
    ] {
        assert!(vector_ids.contains(&id), "canonical vectors omit {id}");
    }
    let parity_tokens = canonical["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|vector| vector["id"] == "lockless-cross-language-wire-parity")
        .and_then(|vector| vector["tokens"].as_array())
        .expect("canonical parity vector must expose tokens");
    let expected_parity_tokens = json!([
        "surf-ace.lockless-multi-controller.v1",
        "maxPanesPerSurface",
        "maxSurfaceRecoverableBaseBytes",
        "maxPaneRecoverableStateBytes",
        "maxPaneAnnotationRestoreBytes",
        "maxRetainedTombstones",
        "maxRetainedTombstoneBytes",
        "maxRecoverableSurfaceBytes",
        "maxPaneConsumableRecords",
        "maxPaneConsumableBytes",
        "maxSurfaceConsumableRecords",
        "maxSurfaceConsumableBytes",
        "maxConsumableRecordBytes",
        "maxConsumableCursorStateBytesPerScope",
        "maxAdmittedControllerEntries",
        "maxDormantControllerEntries",
        "maxDormantControllerBytes",
        "maxPendingOperationReceiptsPerController",
        "maxPendingOperationReceiptBytesPerController",
        "resolved_success",
        "resolved_failure",
        "not_committed",
        "still_pending",
        "receipt_unavailable",
        "source_overflow",
        "scope_capacity",
        "record_oversize",
        "cursor",
        "gapGeneration",
        "intent_committed",
        "materializing",
        "terminal",
        "commitSequence",
        "receipt_capacity",
        "surface_state_capacity",
        "materialization_outcome_unknown",
    ]);
    assert_eq!(parity_tokens, expected_parity_tokens.as_array().unwrap());
    let encoded = serde_json::to_string(&canonical).unwrap();
    assert!(encoded.contains("operation.receipt.sync"));
    assert!(encoded.contains("operation.receipt.ack"));
    assert!(encoded.contains("maxPendingOperationReceiptsPerController"));
    assert!(encoded.contains("maxPendingOperationReceiptBytesPerController"));
    for outcome in package["receiptResolutionOutcomes"].as_array().unwrap() {
        assert!(encoded.contains(outcome.as_str().unwrap()));
    }
    let target_cases = canonical["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|vector| vector["id"] == "lockless-target-precommit-rejection-classification")
        .and_then(|vector| vector["cases"].as_array())
        .expect("canonical target precommit vector must expose executable cases");
    assert_eq!(target_cases.len(), 8);
}

#[test]
fn canonical_target_admission_cases_execute_rust_controller_semantics() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let canonical: Value = serde_json::from_slice(
        &fs::read(manifest_dir.join("../protocol/vectors/authority-conformance.json")).unwrap(),
    )
    .unwrap();
    let cases = canonical["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|vector| vector["id"] == "lockless-target-precommit-rejection-classification")
        .and_then(|vector| vector["cases"].as_array())
        .unwrap();
    for case in cases {
        if case["input"]["controllerScenario"] == "two_same_request_id" {
            continue;
        }
        let temp = TempDir::new().unwrap();
        let mut wire = FakeWire::ordinary();
        if let Some(code) = case["expected"]["topLevelCode"].as_str() {
            wire.target_precommit_error = Some((
                code.into(),
                case["expected"]["targetErrorCode"]
                    .as_str()
                    .map(str::to_owned),
            ));
        }
        let output = execute_with_wire(
            invocation(
                &temp,
                Command::TargetApply,
                json!({
                    "surfaceId": "sf_1",
                    "paneId": 1,
                    "requestId": format!("target-{}", case["id"].as_str().unwrap()),
                    "restoreReason": "initial",
                    "targetId": format!("target-{}", case["id"].as_str().unwrap()),
                    "targetEpoch": 1,
                    "targetKind": "browser_url",
                    "targetHeader": {
                        "replaySemantics": case["input"]["replaySemantics"],
                        "requiredCapabilities": [if case["input"]["requiredCapability"] == "supported" {
                            "target.browser_url.v1"
                        } else {
                            "target.missing.v1"
                        }]
                    },
                    "targetPayload": { "url": if case["input"]["targetPayload"] == "safe_https" {
                        "https://example.com"
                    } else {
                        "file:///etc/passwd"
                    }}
                }),
            ),
            &mut wire,
        )
        .unwrap();
        assert!(output.ok, "{}", case["id"]);
        assert_eq!(
            output
                .result
                .get("error")
                .and_then(|error| error.get("code")),
            case["expected"]["topLevelCode"]
                .as_str()
                .map(Value::from)
                .as_ref(),
            "{}",
            case["id"]
        );
        assert_eq!(
            output
                .result
                .get("error")
                .and_then(|error| error.get("details"))
                .and_then(|details| details.get("targetErrorCode")),
            case["expected"]["targetErrorCode"]
                .as_str()
                .map(Value::from)
                .as_ref(),
            "{}",
            case["id"]
        );
        if case["expected"]["topLevelCode"].is_null() {
            assert_eq!(output.result["payload"]["status"], "intent_committed");
            assert_eq!(
                wire.operations
                    .iter()
                    .filter(|op| *op == "operation.receipt.ack")
                    .count(),
                2,
            );
        } else {
            assert!(!wire.operations.contains(&"operation.receipt.ack".into()));
        }
        assert_eq!(
            wire.operations
                .iter()
                .filter(|op| *op == "target.apply")
                .count(),
            1
        );
        let persisted: Value =
            serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
                .unwrap();
        assert_eq!(persisted["unresolved"], json!({}), "{}", case["id"]);
    }

    let collision = cases
        .iter()
        .find(|case| case["input"]["controllerScenario"] == "two_same_request_id")
        .unwrap();
    let mut controller_ids = vec![];
    for _ in 0..2 {
        let temp = TempDir::new().unwrap();
        let mut root = LockedStateRoot::open(temp.path(), 1024 * 1024).unwrap();
        root.mutate(|state| {
            state.unresolved.insert(
                "rq-shared-controller-scoped".into(),
                UnresolvedCorrelation {
                    operation: "target.apply".into(),
                    payload_digest: "shared".into(),
                    phase: CorrelationPhase::Sent,
                    terminal_response: None,
                },
            );
        })
        .unwrap();
        let controller_id = root.state().controller_instance_id.clone();
        drop(root);
        let terminal = json!({
            "id": "rq-shared-controller-scoped",
            "ok": true,
            "op": "target.apply.result",
            "payload": {
                "operationReceipt": {
                    "commitSequence": 7,
                    "requestId": "rq-shared-controller-scoped"
                },
                "operationRequestId": "rq-shared-controller-scoped",
                "status": "intent_committed",
                "surfaceId": "sf_1",
                "targetEpoch": 1,
                "targetId": "target-shared",
                "targetRequestId": "target-shared"
            },
            "type": "response",
            "v": 1
        });
        let mut wire = FakeWire::ordinary();
        wire.resolutions = vec![json!({
            "operationReceipt": {
                "commitSequence": 7,
                "requestId": "rq-shared-controller-scoped"
            },
            "outcome": collision["expected"]["receiptSyncOutcome"],
            "requestId": "rq-shared-controller-scoped",
            "terminalResponse": terminal
        })];
        let output =
            execute_with_wire(invocation(&temp, Command::List, json!({})), &mut wire).unwrap();
        assert_eq!(output.reconciliations.len(), 1);
        assert_eq!(
            output.reconciliations[0]["requestId"],
            "rq-shared-controller-scoped"
        );
        let persisted: Value =
            serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
                .unwrap();
        assert_eq!(persisted["unresolved"], json!({}));
        controller_ids.push(controller_id);
    }
    assert_ne!(controller_ids[0], controller_ids[1]);
}

#[test]
fn all_eleven_commands_map_to_the_public_wire_and_return_json() {
    for (command, input, expected_operation) in canonical_network_cases() {
        let temp = TempDir::new().unwrap();
        let mut wire = FakeWire::ordinary();
        let output = execute_with_wire(invocation(&temp, command, input), &mut wire).unwrap();
        assert!(output.ok);
        assert!(wire.operations.contains(&expected_operation.into()));
    }

    let temp = TempDir::new().unwrap();
    let mut local = invocation(&temp, Command::Read, json!({ "scopeId": "pane:sf_1:1" }));
    local.endpoint = None;
    local.product_label = None;
    let output = execute(local).unwrap();
    assert_eq!(output.result["cacheStatus"], "unsynchronized");
}

#[test]
fn every_serialized_network_command_variant_matches_the_shared_production_vector() {
    let envelopes = canonical_network_cases()
        .into_iter()
        .enumerate()
        .map(|(index, (command, input, expected_operation))| {
            let operation = command.wire_operation(input.as_object().unwrap()).unwrap();
            assert_eq!(operation, expected_operation);
            let payload = command
                .wire_payload(input.as_object().unwrap().clone())
                .unwrap();
            serde_json::to_value(Envelope::request(
                format!("rq-{index}"),
                operation,
                payload,
                1_785_619_273_922,
            ))
            .unwrap()
        })
        .collect::<Vec<_>>();

    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let shared: Value = serde_json::from_slice(
        &fs::read(manifest_dir.join("vectors/network-request-conformance.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(json!(envelopes), shared["requests"]);
}

#[test]
fn rust_validation_matches_the_shared_production_boundary_vector() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let shared: Value = serde_json::from_slice(
        &fs::read(manifest_dir.join("vectors/network-validation-conformance.json")).unwrap(),
    )
    .unwrap();
    let cases = shared["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 64);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let command = Command::parse(case["command"].as_str().unwrap()).unwrap();
        let input = case["input"].as_object().unwrap();
        let result = command.wire_operation(input).and_then(|operation| {
            if operation != case["operation"].as_str().unwrap() {
                return Err("operation_mismatch".to_owned());
            }
            command.wire_payload(input.clone()).map(|_| ())
        });
        assert_eq!(result.is_ok(), case["accepted"] == true, "{id}");
    }
}

#[test]
fn command_validation_rejects_the_three_reviewed_noncanonical_payloads() {
    let invalid = [
        (
            Command::TopologyRealize,
            json!({ "surfaceId": "sf_1", "expectedTopologyRevision": 1, "target": { "root": true }, "desired": {}, "allowDestroyPaneIds": [] }),
        ),
        (
            Command::SurfaceIntent,
            json!({ "action": "open", "expectedSurfaceSetRevision": 1, "requestedLabel": "Window" }),
        ),
        (
            Command::TargetRegister,
            json!({ "surfaceId": "sf_1", "paneId": 1, "idempotencyKey": "idem_1", "targetKind": "native_app", "targetHeader": {}, "targetPayload": {} }),
        ),
    ];
    for (command, input) in invalid {
        assert!(command.validate(input.as_object().unwrap()).is_err());
    }
}

fn canonical_network_cases() -> Vec<(Command, Value, &'static str)> {
    vec![
        (Command::List, json!({}), "surfaces.list"),
        (
            Command::Push,
            json!({ "surfaceId": "sf_1", "paneId": 1, "contentId": "c_1", "contentType": "markdown", "content": { "markdown": "hi" }, "friendlyChatName": "OpenClaw" }),
            "content.set",
        ),
        (
            Command::TopologyIntent,
            json!({ "surfaceId": "sf_1", "action": "split", "paneId": 1, "count": 2, "direction": "horizontal", "expectedTopologyRevision": 1 }),
            "pane.split",
        ),
        (
            Command::TopologyIntent,
            json!({ "surfaceId": "sf_1", "action": "close", "paneId": 1, "expectedTopologyRevision": 1 }),
            "pane.close",
        ),
        (
            Command::TopologyIntent,
            json!({ "surfaceId": "sf_1", "action": "restore", "anchorPaneId": 1, "tombstoneId": "pt_1", "direction": "vertical", "expectedTopologyRevision": 1 }),
            "pane.restore",
        ),
        (
            Command::TopologyIntent,
            json!({ "surfaceId": "sf_1", "action": "rename", "paneId": 1, "name": "Notes", "expectedTopologyRevision": 1 }),
            "pane.rename",
        ),
        (
            Command::TopologyRealize,
            json!({ "surfaceId": "sf_1", "expectedTopologyRevision": 1, "target": { "root": true }, "desired": { "type": "pane" }, "allowDestroyPaneIds": [] }),
            "topology.apply",
        ),
        (
            Command::Clear,
            json!({ "surfaceId": "sf_1", "paneId": 1, "expectedRevision": 1 }),
            "content.clear",
        ),
        (
            Command::AnnotationsRemove,
            json!({ "surfaceId": "sf_1", "paneId": 1, "contentId": "c_1", "strokeIds": ["st_1"] }),
            "annotations.remove",
        ),
        (
            Command::CapturePane,
            json!({ "surfaceId": "sf_1", "paneId": 1, "includeDrawings": true }),
            "snapshot.get",
        ),
        (
            Command::SurfaceIntent,
            json!({ "action": "open", "expectedSurfaceSetRevision": 1, "placement": {} }),
            "surface.window.open",
        ),
        (
            Command::SurfaceIntent,
            json!({ "action": "close", "expectedSurfaceSetRevision": 1, "expectedTopologyRevision": 1, "surfaceId": "sf_1" }),
            "surface.window.close",
        ),
        (
            Command::SurfaceIntent,
            json!({ "action": "restore", "expectedSurfaceSetRevision": 1, "tombstoneId": "st_1", "placement": {} }),
            "surface.window.restore",
        ),
        (
            Command::TargetRegister,
            json!({ "surfaceId": "sf_1", "paneId": 1, "idempotencyKey": "idem_1", "expectedPreviousTargetEpoch": null, "launchedAt": "2026-07-30T00:00:00Z", "registrationState": "attached", "targetKind": "native_app", "targetHeader": {}, "targetPayload": {} }),
            "target.register",
        ),
        (
            Command::TargetApply,
            json!({ "surfaceId": "sf_1", "paneId": 1, "requestId": "target_request_1", "restoreReason": "initial", "targetId": "tg_1", "targetEpoch": 1, "targetKind": "native_app", "targetHeader": {}, "targetPayload": {} }),
            "target.apply",
        ),
    ]
}

#[test]
fn later_target_result_is_projected_from_client_authoritative_surface_state() {
    let temp = TempDir::new().unwrap();
    let result = json!({
        "errorCode": "materialization_outcome_unknown",
        "intentCommitSequence": 11,
        "operationRequestId": "operation-a",
        "status": "failed",
        "surfaceId": "sf_1",
        "targetEpoch": 3,
        "targetId": "target-a",
        "targetRequestId": "materialization-a"
    });
    let record = json!({
        "bytes": 321,
        "payload": result,
        "recordClass": "target_result",
        "recordId": "record-a",
        "sequence": 1
    });
    let mut wire = FakeWire::ordinary();
    wire.scopes = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 1,
        "records": [record.clone()],
        "scopeId": "surface:sf_1",
        "version": 1
    })];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut wire).unwrap();
    let state: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(state["scopes"]["surface:sf_1"]["records"][0], record);
}

#[test]
fn receipt_ack_projects_direct_target_result_before_clearing_correlation() {
    let temp = TempDir::new().unwrap();
    let result = json!({
        "intentCommitSequence": 7,
        "operationRequestId": "operation-target",
        "status": "applied",
        "surfaceId": "sf_1",
        "targetEpoch": 1,
        "targetId": "tg_1",
        "targetRequestId": "target_request_1"
    });
    let mut wire = FakeWire::ordinary();
    wire.scopes = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 0,
        "records": [],
        "scopeId": "surface:sf_1",
        "version": 1
    })];
    wire.response_events.insert(
        "operation.receipt.ack".into(),
        vec![event(
            "event.target_apply_result",
            json!({
                "consumableSequence": 1,
                "recordId": "target-result-1",
                "intentCommitSequence": 7,
                "operationRequestId": "operation-target",
                "status": "applied",
                "surfaceId": "sf_1",
                "targetEpoch": 1,
                "targetId": "tg_1",
                "targetRequestId": "target_request_1"
            }),
        )],
    );
    execute_with_wire(
        invocation(
            &temp,
            Command::TargetApply,
            json!({
                "paneId": 1,
                "requestId": "target_request_1",
                "restoreReason": "initial",
                "surfaceId": "sf_1",
                "targetEpoch": 1,
                "targetHeader": {},
                "targetId": "tg_1",
                "targetKind": "native_app",
                "targetPayload": {}
            }),
        ),
        &mut wire,
    )
    .unwrap();
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["unresolved"], json!({}));
    assert_eq!(
        persisted["scopes"]["surface:sf_1"]["records"][0]["recordId"],
        "target-result-1"
    );
    assert_eq!(
        persisted["scopes"]["surface:sf_1"]["records"][0]["payload"],
        result
    );
}

#[test]
fn receipt_ack_projection_failure_retains_correlation_and_marks_repair() {
    let temp = TempDir::new().unwrap();
    let mut wire = FakeWire::ordinary();
    wire.scopes = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 0,
        "records": [],
        "scopeId": "surface:sf_1",
        "version": 1
    })];
    wire.response_events.insert(
        "operation.receipt.ack".into(),
        vec![event(
            "event.lockless_consumable_delta",
            json!({
                "records": [{ "recordClass": "tap", "recordId": "bad-gap", "sequence": 2 }],
                "scopeId": "surface:sf_1"
            }),
        )],
    );
    let error = execute_with_wire(
        invocation(
            &temp,
            Command::Clear,
            json!({ "expectedRevision": 1, "paneId": 1, "surfaceId": "sf_1" }),
        ),
        &mut wire,
    )
    .unwrap_err();
    assert!(matches!(error, CliError::State(_) | CliError::Protocol(_)));
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["unresolved"].as_object().unwrap().len(), 1);
    assert_eq!(persisted["scopes"]["surface:sf_1"]["synchronized"], false);

    let mut restarted = FakeWire::ordinary();
    restarted.scopes = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 0,
        "records": [],
        "scopeId": "surface:sf_1",
        "version": 1
    })];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut restarted).unwrap();
    assert!(!restarted
        .operations
        .contains(&"operation.receipt.sync".into()));
    let repaired: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(repaired["unresolved"], json!({}));
    assert_eq!(repaired["scopes"]["surface:sf_1"]["synchronized"], true);
}

#[test]
fn discovery_and_consumable_ack_events_commit_before_sync_and_outbox_clear() {
    let temp = TempDir::new().unwrap();
    let initial = json!({
        "bytes": 32,
        "payload": { "value": "initial" },
        "recordClass": "tap",
        "recordId": "record-1",
        "sequence": 1
    });
    let mut first = FakeWire::ordinary();
    first.scopes = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 1,
        "records": [initial],
        "scopeId": "surface:sf_1",
        "version": 1
    })];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut first).unwrap();
    let mut local = invocation(&temp, Command::Read, json!({ "scopeId": "surface:sf_1" }));
    local.endpoint = None;
    local.product_label = None;
    execute(local).unwrap();

    let acknowledged = json!({
        "bytes": 32,
        "payload": { "value": "ack-response" },
        "recordClass": "tap",
        "recordId": "record-2",
        "sequence": 2
    });
    let discovered = json!({
        "bytes": 32,
        "payload": { "value": "discovery-response" },
        "recordClass": "tap",
        "recordId": "record-3",
        "sequence": 3
    });
    let mut second = FakeWire::ordinary();
    second.scopes = first.scopes;
    second.response_events.insert(
        "consumable.ack".into(),
        vec![event(
            "event.lockless_consumable_delta",
            json!({
                "records": [acknowledged],
                "scopeId": "surface:sf_1"
            }),
        )],
    );
    second.response_events.insert(
        "surfaces.list".into(),
        vec![event(
            "event.lockless_consumable_delta",
            json!({
                "records": [discovered],
                "scopeId": "surface:sf_1"
            }),
        )],
    );
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut second).unwrap();
    let pair_payload = second
        .payloads
        .iter()
        .find(|(operation, _)| operation == "pair.request")
        .map(|(_, payload)| payload)
        .unwrap();
    assert_eq!(
        pair_payload["resume"]["pendingAcks"],
        json!([{
            "cursor": 2,
            "scopeId": "surface:sf_1"
        }])
    );
    let acknowledgement_payload = second
        .payloads
        .iter()
        .find(|(operation, _)| operation == "consumable.ack")
        .map(|(_, payload)| payload)
        .unwrap();
    assert_eq!(
        acknowledgement_payload,
        &json!({
            "cursor": 2,
            "scopeId": "surface:sf_1"
        })
    );
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["acknowledgementOutbox"], json!([]));
    assert_eq!(
        persisted["scopes"]["surface:sf_1"]["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| record["sequence"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![2, 3]
    );
    assert_eq!(persisted["scopes"]["surface:sf_1"]["synchronized"], true);

    let restored = LockedStateRoot::open(temp.path(), 1024 * 1024).unwrap();
    assert_eq!(
        restored.state().scopes["surface:sf_1"].last_retained_sequence,
        3
    );
}

#[test]
fn oversize_gap_high_water_allows_the_next_ordered_delta() {
    let temp = TempDir::new().unwrap();
    let mut wire = FakeWire::ordinary();
    wire.scopes = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 0,
        "records": [],
        "scopeId": "surface:sf_1",
        "version": 1
    })];
    wire.response_events.insert(
        "surfaces.list".into(),
        vec![
            event(
                "event.consumable_overflow",
                json!({
                    "firstRetainedSequence": 2,
                    "gap": {
                        "bytesDiscarded": 2048,
                        "firstDiscardedSequence": 1,
                        "generation": 1,
                        "lastDiscardedSequence": 1,
                        "reason": "record_oversize",
                        "recordsDiscarded": 1,
                        "triggerOperation": "target.apply.materialization"
                    },
                    "lastRetainedSequence": 1,
                    "scopeId": "surface:sf_1"
                }),
            ),
            event(
                "event.lockless_consumable_delta",
                json!({
                    "records": [{
                        "bytes": 32,
                        "payload": { "value": "retained" },
                        "recordClass": "tap",
                        "recordId": "record-2",
                        "sequence": 2
                    }],
                    "scopeId": "surface:sf_1"
                }),
            ),
        ],
    );

    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut wire).unwrap();

    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(
        persisted["scopes"]["surface:sf_1"]["records"][0]["recordId"],
        "record-2"
    );
    assert_eq!(
        persisted["scopes"]["surface:sf_1"]["lastRetainedSequence"],
        2
    );
}

#[test]
fn committed_rejection_is_synced_persisted_and_acknowledged() {
    let temp = TempDir::new().unwrap();
    let mut wire = FakeWire::ordinary();
    wire.committed_rejection_on = Some("content.clear".into());

    let output = execute_with_wire(
        invocation(
            &temp,
            Command::Clear,
            json!({ "expectedRevision": 1, "paneId": 1, "surfaceId": "sf_1" }),
        ),
        &mut wire,
    )
    .unwrap();

    assert_eq!(output.result["ok"], false);
    assert_eq!(output.result["error"]["code"], "stale_content");
    assert_eq!(output.result["operationReceipt"]["commitSequence"], 8);
    assert!(wire.operations.contains(&"operation.receipt.sync".into()));
    assert!(wire.operations.contains(&"operation.receipt.ack".into()));
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["unresolved"], json!({}));
}

#[test]
fn consumable_ack_projection_failure_keeps_outbox_and_unsynchronized_state() {
    let temp = TempDir::new().unwrap();
    let mut first = FakeWire::ordinary();
    first.scopes = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 1,
        "records": [{
            "bytes": 32,
            "payload": { "value": "initial" },
            "recordClass": "tap",
            "recordId": "record-1",
            "sequence": 1
        }],
        "scopeId": "surface:sf_1",
        "version": 1
    })];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut first).unwrap();
    let mut local = invocation(&temp, Command::Read, json!({ "scopeId": "surface:sf_1" }));
    local.endpoint = None;
    local.product_label = None;
    execute(local).unwrap();

    let mut second = FakeWire::ordinary();
    second.scopes = first.scopes;
    second.response_events.insert(
        "consumable.ack".into(),
        vec![event(
            "event.lockless_consumable_delta",
            json!({
                "records": [{ "recordClass": "tap", "recordId": "gap", "sequence": 3 }],
                "scopeId": "surface:sf_1"
            }),
        )],
    );
    assert!(execute_with_wire(invocation(&temp, Command::List, json!({})), &mut second).is_err());
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(
        persisted["acknowledgementOutbox"].as_array().unwrap().len(),
        1
    );
    assert_eq!(persisted["scopes"]["surface:sf_1"]["synchronized"], false);
    assert_eq!(second.close_count, 1);
}

#[test]
fn consumable_ack_rejection_closes_and_keeps_outbox_unsynchronized() {
    let temp = TempDir::new().unwrap();
    let mut first = FakeWire::ordinary();
    first.scopes = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 1,
        "records": [{
            "bytes": 32,
            "payload": { "value": "initial" },
            "recordClass": "tap",
            "recordId": "record-1",
            "sequence": 1
        }],
        "scopeId": "surface:sf_1",
        "version": 1
    })];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut first).unwrap();
    let mut local = invocation(&temp, Command::Read, json!({ "scopeId": "surface:sf_1" }));
    local.endpoint = None;
    local.product_label = None;
    execute(local).unwrap();

    let mut rejected = FakeWire::ordinary();
    rejected.scopes = first.scopes;
    rejected.receipt_capacity_on = Some("consumable.ack".into());
    let error =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut rejected).unwrap_err();
    assert!(matches!(
        error,
        CliError::Rejected { ref operation, ref code }
            if operation == "consumable.ack" && code == "receipt_capacity"
    ));
    assert_eq!(rejected.close_count, 1);
    assert!(!rejected.operations.contains(&"surfaces.list".into()));
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(
        persisted["acknowledgementOutbox"].as_array().unwrap().len(),
        1
    );
    assert_eq!(persisted["scopes"]["surface:sf_1"]["synchronized"], false);
}

#[test]
fn post_send_interruption_is_durable_unknown_then_exact_receipt_is_replayed_and_acked() {
    let temp = TempDir::new().unwrap();
    let mut first = FakeWire::ordinary();
    first.fail_after_send_on = Some("content.set".into());
    let error = execute_with_wire(
        invocation(&temp, Command::Push, json!({ "surfaceId": "sf_1", "paneId": 1, "contentId": "c_1", "contentType": "markdown", "content": { "markdown": "hello" } })),
        &mut first,
    )
    .unwrap_err();
    let request_id = match error {
        CliError::OutcomeUnknown { request_id, .. } => request_id,
        other => panic!("unexpected error {other}"),
    };

    let terminal = json!({
        "id": request_id,
        "ok": true,
        "op": "content.set.result",
        "payload": { "operationReceipt": { "requestId": request_id, "operation": "content.set", "commitSequence": 9 } },
        "type": "response",
        "v": 1
    });
    let mut second = FakeWire::ordinary();
    second.resolutions = vec![json!({
        "outcome": "resolved_success",
        "operationReceipt": { "requestId": request_id, "commitSequence": 9 },
        "requestId": request_id,
        "terminalResponse": terminal
    })];
    let output =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut second).unwrap();
    assert_eq!(output.reconciliations[0]["outcome"], "resolved_success");
    assert!(!second.operations.contains(&"operation.receipt.sync".into()));
    assert!(second.operations.contains(&"operation.receipt.ack".into()));
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["unresolved"], json!({}));
}

#[test]
fn accepted_receipt_ack_interruption_replays_then_releases_without_losing_terminal() {
    let temp = TempDir::new().unwrap();
    let mut first = FakeWire::ordinary();
    first.fail_after_send_on = Some("operation.receipt.ack".into());
    let error = execute_with_wire(
        invocation(
            &temp,
            Command::Push,
            json!({
                "surfaceId": "sf_1",
                "paneId": 1,
                "contentId": "c_ack_crash",
                "contentType": "markdown",
                "content": { "markdown": "hello" }
            }),
        ),
        &mut first,
    )
    .unwrap_err();
    assert!(matches!(error, CliError::Wire(_)));
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    let (request_id, correlation) = persisted["unresolved"]
        .as_object()
        .unwrap()
        .iter()
        .next()
        .unwrap();
    assert_eq!(correlation["phase"], "receipt_persisted");
    let terminal = correlation["terminalResponse"].clone();

    let mut restarted = FakeWire::ordinary();
    restarted.resolutions = vec![json!({
        "outcome": "resolved_success",
        "operationReceipt": terminal["payload"]["operationReceipt"],
        "requestId": request_id,
        "terminalResponse": terminal
    })];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut restarted).unwrap();
    assert_eq!(
        restarted
            .operations
            .iter()
            .filter(|operation| operation.as_str() == "operation.receipt.ack")
            .count(),
        2
    );
    let repaired: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(repaired["unresolved"], json!({}));
}

#[test]
fn receipt_ack_requires_explicit_acceptance_before_local_cleanup() {
    let temp = TempDir::new().unwrap();
    let mut wire = FakeWire::ordinary();
    wire.ack_accepted = false;
    let error = execute_with_wire(
        invocation(
            &temp,
            Command::Clear,
            json!({ "expectedRevision": 1, "paneId": 1, "surfaceId": "sf_1" }),
        ),
        &mut wire,
    )
    .unwrap_err();
    assert!(matches!(error, CliError::Protocol(ref code) if code == "receipt_ack_not_accepted"));
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(
        persisted["unresolved"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()["phase"],
        "receipt_persisted"
    );
}

#[test]
fn all_five_receipt_resolution_outcomes_are_deterministic() {
    for outcome in [
        "resolved_success",
        "resolved_failure",
        "not_committed",
        "still_pending",
        "receipt_unavailable",
    ] {
        let temp = TempDir::new().unwrap();
        let request_id = "rq_uncertain";
        let mut state = LockedStateRoot::open(temp.path(), 1024 * 1024).unwrap();
        state
            .mutate(|state| {
                state.unresolved.insert(
                    request_id.into(),
                    UnresolvedCorrelation {
                        operation: "content.set".into(),
                        payload_digest: "digest".into(),
                        phase: CorrelationPhase::Sent,
                        terminal_response: None,
                    },
                );
            })
            .unwrap();
        drop(state);
        let mut resolution = json!({ "outcome": outcome, "requestId": request_id });
        if outcome.starts_with("resolved_") {
            resolution["operationReceipt"] =
                json!({ "requestId": request_id, "commitSequence": 2 });
            resolution["terminalResponse"] = json!({
                "id": request_id,
                "ok": outcome == "resolved_success",
                "op": "content.set.result",
                "payload": { "operationReceipt": { "requestId": request_id, "operation": "content.set", "commitSequence": 2 } },
                "type": "response",
                "v": 1
            });
        }
        if outcome == "receipt_unavailable" {
            resolution["cause"] = json!("controller_reclaimed");
        }
        let mut wire = FakeWire::ordinary();
        wire.resolutions = vec![resolution];
        let output =
            execute_with_wire(invocation(&temp, Command::List, json!({})), &mut wire).unwrap();
        assert_eq!(output.reconciliations[0]["outcome"], outcome);
        assert_eq!(
            wire.operations.contains(&"operation.receipt.ack".into()),
            outcome.starts_with("resolved_")
        );
    }
}

#[test]
fn still_pending_blocks_a_later_mutation() {
    let temp = TempDir::new().unwrap();
    let mut state = LockedStateRoot::open(temp.path(), 1024 * 1024).unwrap();
    state
        .mutate(|state| {
            state.unresolved.insert(
                "rq_pending".into(),
                UnresolvedCorrelation {
                    operation: "content.set".into(),
                    payload_digest: "digest".into(),
                    phase: CorrelationPhase::Sent,
                    terminal_response: None,
                },
            );
        })
        .unwrap();
    drop(state);
    let mut wire = FakeWire::ordinary();
    wire.resolutions = vec![json!({ "outcome": "still_pending", "requestId": "rq_pending" })];
    let error = execute_with_wire(
        invocation(
            &temp,
            Command::Clear,
            json!({ "surfaceId": "sf_1", "paneId": 1, "expectedRevision": 1 }),
        ),
        &mut wire,
    )
    .unwrap_err();
    assert!(matches!(error, CliError::StillPending));
    assert!(!wire.operations.contains(&"content.clear".into()));
}

#[test]
fn receipt_capacity_is_a_definitive_no_commit_without_correlation_or_ack() {
    let temp = TempDir::new().unwrap();
    let mut wire = FakeWire::ordinary();
    wire.receipt_capacity_on = Some("content.clear".into());
    let output = execute_with_wire(
        invocation(
            &temp,
            Command::Clear,
            json!({ "surfaceId": "sf_1", "paneId": 1, "expectedRevision": 1 }),
        ),
        &mut wire,
    )
    .unwrap();
    assert_eq!(output.result["error"]["code"], "receipt_capacity");
    assert!(!wire.operations.contains(&"operation.receipt.ack".into()));
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["unresolved"], json!({}));
}

#[test]
fn sequential_process_model_reuses_identity() {
    let temp = TempDir::new().unwrap();
    let mut first = FakeWire::ordinary();
    let first_id = execute_with_wire(invocation(&temp, Command::List, json!({})), &mut first)
        .unwrap()
        .controller_instance_id;
    let mut second = FakeWire::ordinary();
    let second_id = execute_with_wire(invocation(&temp, Command::List, json!({})), &mut second)
        .unwrap()
        .controller_instance_id;
    assert_eq!(first_id, second_id);
}

#[test]
fn production_path_uses_lifecycle_discovery_then_surface_scoped_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (lifecycle_stream, _) = listener.accept().unwrap();
        let mut lifecycle = accept(lifecycle_stream).unwrap();
        let pair = read_request(&mut lifecycle);
        assert_eq!(pair["op"], "pair.request");
        assert_eq!(
            pair["payload"]["protocolFeatures"][0],
            "surf-ace.lockless-multi-controller.v1"
        );
        assert_eq!(pair["payload"]["controllerProductName"], "Clawline");
        assert!(pair["payload"].get("surfaceId").is_none());
        send_response(
            &mut lifecycle,
            pair["id"].as_str().unwrap(),
            "pair.response",
            pair_payload(pair["payload"]["controllerInstanceId"].clone()),
        );
        let list = read_request(&mut lifecycle);
        assert_eq!(list["op"], "surfaces.list");
        send_response(
            &mut lifecycle,
            list["id"].as_str().unwrap(),
            "surfaces.list.result",
            json!({ "surfaces": [{ "surfaceId": "sf_1" }] }),
        );

        let (surface_stream, _) = listener.accept().unwrap();
        let mut surface = accept(surface_stream).unwrap();
        let pair = read_request(&mut surface);
        assert_eq!(pair["payload"]["surfaceId"], "sf_1");
        let mut surface_pair = pair_payload(pair["payload"]["controllerInstanceId"].clone());
        surface_pair["surfaceId"] = json!("sf_1");
        send_response(
            &mut surface,
            pair["id"].as_str().unwrap(),
            "pair.response",
            surface_pair,
        );
        let push = read_request(&mut surface);
        assert_eq!(push["op"], "content.set");
        assert_eq!(push["payload"]["friendlyChatName"], "OpenClaw");
        let push_id = push["id"].as_str().unwrap();
        send_response(
            &mut surface,
            push_id,
            "content.set.result",
            json!({
                "operationReceipt": {
                    "commitSequence": 11,
                    "operation": "content.set",
                    "requestId": push_id
                }
            }),
        );
        let ack = read_request(&mut surface);
        assert_eq!(ack["op"], "operation.receipt.ack");
        assert_eq!(ack["payload"]["requestId"], push_id);
        send_response(
            &mut surface,
            ack["id"].as_str().unwrap(),
            "operation.receipt.ack.result",
            json!({ "accepted": true }),
        );
        let release = read_request(&mut surface);
        assert_eq!(release["op"], "operation.receipt.ack");
        assert_eq!(release["payload"]["requestId"], push_id);
        assert_eq!(release["payload"]["release"], true);
        send_response(
            &mut surface,
            release["id"].as_str().unwrap(),
            "operation.receipt.ack.result",
            json!({ "accepted": true, "release": true }),
        );
    });

    let temp = TempDir::new().unwrap();
    let mut call = invocation(
        &temp,
        Command::Push,
        json!({
            "surfaceId": "sf_1",
            "paneId": 1,
            "contentId": "c_1",
            "contentType": "markdown",
            "content": { "markdown": "hello" },
            "friendlyChatName": "OpenClaw"
        }),
    );
    call.endpoint = Some(endpoint);
    let output = execute(call).unwrap();
    assert_eq!(
        output.result["payload"]["operationReceipt"]["commitSequence"],
        11
    );
    server.join().unwrap();
}

#[test]
fn captured_pair_rejection_preserves_controller_operation_and_code() {
    let temp = TempDir::new().unwrap();
    let mut wire = FakeWire::ordinary();
    wire.pair_rejection = Some(
        serde_json::from_str(include_str!("fixtures/pair-request-invalid-operation.json")).unwrap(),
    );
    let error = execute_with_wire(
        invocation(
            &temp,
            Command::Push,
            json!({
                "surfaceId": "sf_1",
                "paneId": 1,
                "contentId": "c_1",
                "contentType": "markdown",
                "content": { "markdown": "hello" }
            }),
        ),
        &mut wire,
    )
    .unwrap_err();
    assert!(matches!(
        error,
        CliError::Rejected { ref operation, ref code }
            if operation == "pair.request" && code == "invalid_operation"
    ));
    assert_eq!(wire.operations, vec!["pair.request"]);
}

#[test]
fn native_cli_rejects_unknown_input_fields_before_transport_or_state() {
    let temp = TempDir::new().unwrap();
    let input = json!({
        "unexpectedField": { "unexpected": true },
        "surfaceId": "sf_1",
        "paneId": 1,
        "contentId": "c_1",
        "contentType": "markdown",
        "content": { "markdown": "hello" }
    });
    let output = ProcessCommand::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args([
            "--state-root",
            temp.path().to_str().unwrap(),
            "--endpoint",
            "ws://127.0.0.1:9",
            "--product-label",
            "Clawline",
            "push",
            "--input-json",
            &serde_json::to_string(&input).unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["error"]["code"], "invalid_input");
    assert!(result["error"]["details"]["message"]
        .as_str()
        .unwrap()
        .contains("unexpectedField"));
    assert!(!temp.path().join("controller-state.json").exists());
    assert!(!temp.path().join("invocation.lock").exists());
}

#[test]
fn production_lifecycle_connection_flushes_multi_surface_read_acknowledgements() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let scopes = vec![
            json!({
                "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
                "firstRetainedSequence": 1,
                "lastRetainedSequence": 1,
                "records": [{
                    "bytes": 32,
                    "payload": { "surfaceId": "sf_1" },
                    "recordClass": "tap",
                    "recordId": "record-sf-1",
                    "sequence": 1
                }],
                "scopeId": "surface:sf_1",
                "version": 1
            }),
            json!({
                "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
                "firstRetainedSequence": 1,
                "lastRetainedSequence": 1,
                "records": [{
                    "bytes": 32,
                    "payload": { "surfaceId": "sf_2" },
                    "recordClass": "tap",
                    "recordId": "record-sf-2",
                    "sequence": 1
                }],
                "scopeId": "surface:sf_2",
                "version": 1
            }),
        ];

        let (sync_stream, _) = listener.accept().unwrap();
        let mut sync = accept(sync_stream).unwrap();
        let pair = read_request(&mut sync);
        assert_eq!(pair["op"], "pair.request");
        assert!(pair["payload"].get("surfaceId").is_none());
        let mut initial_pair = pair_payload(pair["payload"]["controllerInstanceId"].clone());
        initial_pair["scopes"] = json!(scopes);
        initial_pair["synchronizationCutoff"] = json!("cutoff-initial");
        send_response(
            &mut sync,
            pair["id"].as_str().unwrap(),
            "pair.response",
            initial_pair,
        );
        let list = read_request(&mut sync);
        assert_eq!(list["op"], "surfaces.list");
        send_response(
            &mut sync,
            list["id"].as_str().unwrap(),
            "surfaces.list.result",
            json!({
                "surfaces": [
                    { "surfaceId": "sf_1" },
                    { "surfaceId": "sf_2" }
                ]
            }),
        );
        expect_orderly_close(&mut sync);

        let (ack_stream, _) = listener.accept().unwrap();
        let mut ack = accept(ack_stream).unwrap();
        let pair = read_request(&mut ack);
        assert_eq!(pair["op"], "pair.request");
        assert!(pair["payload"].get("surfaceId").is_none());
        assert_eq!(
            pair["payload"]["resume"]["pendingAcks"],
            json!([
                { "cursor": 2, "scopeId": "surface:sf_1" },
                { "cursor": 2, "scopeId": "surface:sf_2" }
            ])
        );
        let mut resumed_pair = pair_payload(pair["payload"]["controllerInstanceId"].clone());
        resumed_pair["resumed"] = json!(true);
        resumed_pair["scopes"] = json!(scopes);
        resumed_pair["synchronizationCutoff"] = json!("cutoff-resumed");
        send_response(
            &mut ack,
            pair["id"].as_str().unwrap(),
            "pair.response",
            resumed_pair,
        );
        for scope_id in ["surface:sf_1", "surface:sf_2"] {
            let acknowledgement = read_request(&mut ack);
            assert_eq!(acknowledgement["op"], "consumable.ack");
            assert_eq!(acknowledgement["payload"]["scopeId"], scope_id);
            assert_eq!(acknowledgement["payload"]["cursor"], 2);
            send_response(
                &mut ack,
                acknowledgement["id"].as_str().unwrap(),
                "consumable.ack.result",
                json!({ "accepted": true }),
            );
        }
        let list = read_request(&mut ack);
        assert_eq!(list["op"], "surfaces.list");
        send_response(
            &mut ack,
            list["id"].as_str().unwrap(),
            "surfaces.list.result",
            json!({
                "surfaces": [
                    { "surfaceId": "sf_1" },
                    { "surfaceId": "sf_2" }
                ]
            }),
        );
        expect_orderly_close(&mut ack);
    });

    let temp = TempDir::new().unwrap();
    let mut synchronize = invocation(&temp, Command::List, json!({}));
    synchronize.endpoint = Some(endpoint.clone());
    execute(synchronize).unwrap();
    for scope_id in ["surface:sf_1", "surface:sf_2"] {
        let mut read = invocation(&temp, Command::Read, json!({ "scopeId": scope_id }));
        read.endpoint = None;
        read.product_label = None;
        let output = execute(read).unwrap();
        assert_eq!(output.result["cacheStatus"], "current");
        assert_eq!(output.result["acknowledgement"]["cursor"], 2);
    }
    let mut list = invocation(&temp, Command::List, json!({}));
    list.endpoint = Some(endpoint);
    execute(list).unwrap();
    server.join().unwrap();

    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["acknowledgementOutbox"], json!([]));
    for scope_id in ["surface:sf_1", "surface:sf_2"] {
        assert_eq!(persisted["scopes"][scope_id]["clientCursor"], 2);
        assert_eq!(persisted["scopes"][scope_id]["synchronized"], true);
        assert_eq!(
            persisted["scopes"][scope_id]["synchronizationCutoff"],
            "cutoff-resumed"
        );
    }
}

#[test]
fn state_root_os_lock_serializes_whole_cross_process_lifetime() {
    let temp = TempDir::new().unwrap();
    let first = LockedStateRoot::open(temp.path(), 1024 * 1024).unwrap();
    let path = temp.path().to_owned();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (acquired_tx, acquired_rx) = std::sync::mpsc::channel();
    let contender = thread::spawn(move || {
        started_tx.send(()).unwrap();
        let second = LockedStateRoot::open(&path, 1024 * 1024).unwrap();
        acquired_tx
            .send(second.state().controller_instance_id.clone())
            .unwrap();
    });
    started_rx.recv().unwrap();
    assert!(acquired_rx
        .recv_timeout(Duration::from_millis(100))
        .is_err());
    let identity = first.state().controller_instance_id.clone();
    drop(first);
    assert_eq!(
        acquired_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        identity
    );
    contender.join().unwrap();
}

#[test]
fn native_cli_stdout_is_one_deterministic_json_document() {
    let temp = TempDir::new().unwrap();
    let run = || {
        ProcessCommand::new(env!("CARGO_BIN_EXE_surf-ace"))
            .args([
                "--state-root",
                temp.path().to_str().unwrap(),
                "read",
                "--input-json",
                r#"{"scopeId":"pane:sf_1:1"}"#,
            ])
            .output()
            .unwrap()
    };
    let first = run();
    let second = run();
    assert!(first.status.success());
    assert_eq!(first.stdout, second.stdout);
    assert!(!first.stdout.is_empty());
    assert_eq!(
        first.stdout.iter().filter(|byte| **byte == b'\n').count(),
        1
    );
    let output: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(output["command"], "read");
    assert_eq!(output["result"]["cacheStatus"], "unsynchronized");
    assert!(output["result"].get("repairScheduled").is_none());
}

#[test]
fn general_cli_manifest_uses_only_the_public_surf_ace_identity() {
    let manifest =
        fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
            .unwrap();
    assert!(manifest.contains("name = \"surf-ace-cli\""));
    assert!(manifest.contains("name = \"surf-ace\""));
}

fn read_request(socket: &mut tungstenite::WebSocket<std::net::TcpStream>) -> Value {
    loop {
        match socket.read().unwrap() {
            Message::Text(text) => {
                let envelope: Value = serde_json::from_str(&text).unwrap();
                assert_canonical_request_envelope(&envelope);
                return envelope;
            }
            Message::Close(_) => panic!("connection closed before request"),
            _ => {}
        }
    }
}

fn expect_orderly_close(socket: &mut tungstenite::WebSocket<std::net::TcpStream>) {
    loop {
        match socket.read().unwrap() {
            Message::Close(_) => return,
            Message::Ping(payload) => socket.send(Message::Pong(payload)).unwrap(),
            _ => {}
        }
    }
}

fn assert_canonical_request_envelope(envelope: &Value) {
    let object = envelope.as_object().unwrap();
    let actual = object
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let expected = ["id", "op", "payload", "sentAt", "type", "v"]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(actual, expected);
    assert_eq!(envelope["v"], 1);
    assert_eq!(envelope["type"], "request");
    assert!(envelope["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(envelope["op"].as_str().is_some_and(|op| !op.is_empty()));
    assert!(envelope["payload"].is_object());
    assert!(envelope["sentAt"].as_u64().is_some());
}

fn send_response(
    socket: &mut tungstenite::WebSocket<std::net::TcpStream>,
    id: &str,
    op: &str,
    payload: Value,
) {
    socket
        .send(Message::Text(
            serde_json::to_string(&json!({
                "id": id,
                "ok": true,
                "op": op,
                "payload": payload,
                "type": "response",
                "v": 1
            }))
            .unwrap()
            .into(),
        ))
        .unwrap();
}

fn pair_payload(controller_instance_id: Value) -> Value {
    json!({
        "capabilities": {},
        "controllerInstanceId": controller_instance_id,
        "limits": {
            "maxPendingOperationReceiptBytesPerController": 65536,
            "maxPendingOperationReceiptsPerController": 16
        },
        "mode": "lockless",
        "receiptResolutions": [],
        "resumed": false,
        "scopes": [],
        "sessionId": "session_test",
        "state": null,
        "surfaceId": null,
        "surfaceSetRevision": 1
    })
}
