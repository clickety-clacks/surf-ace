mod common;

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::net::{SocketAddr, TcpListener};
use std::process::Command as ProcessCommand;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use surf_ace_cli::command::{Command, Invocation};
use surf_ace_cli::controller::{execute, execute_with_wire, CliError};
use surf_ace_cli::state::{CorrelationPhase, LockedStateRoot, UnresolvedCorrelation};
use surf_ace_cli::wire::{DirectWire, Envelope, WireFailure, WireResponse};
use tempfile::TempDir;
use tungstenite::{accept, Message};

const WEBSOCKET_FRAME_LIMIT_BYTES: usize = 16 * 1024 * 1024;

struct FakeWire {
    ack_accepted: bool,
    close_count: usize,
    operations: Vec<String>,
    payloads: Vec<(String, Value)>,
    fail_after_send_on: Option<String>,
    pair_rejection: Option<Envelope>,
    pair_response_fault: Option<ResponseEnvelopeFault>,
    pair_controller_instance_id_override: Option<Value>,
    pair_surface_id_override: Option<Value>,
    pair_projection: Option<String>,
    pair_protocol_features: Option<Vec<String>>,
    scope_summaries: Vec<Value>,
    sync_snapshots: Vec<Value>,
    sync_response_fault: Option<ResponseEnvelopeFault>,
    snapshot_payload: Option<Value>,
    panes_list_payload: Value,
    panes_list_rejection: Option<String>,
    panes_list_response_fault: Option<ResponseEnvelopeFault>,
    receipt_capacity_on: Option<String>,
    target_precommit_error: Option<(String, Option<String>)>,
    committed_rejection_on: Option<String>,
    resolutions: Vec<Value>,
    scopes: Vec<Value>,
    response_events: BTreeMap<String, Vec<Envelope>>,
}

#[derive(Clone, Copy)]
enum ResponseEnvelopeFault {
    MissingSuccess,
    WrongOperation,
    UnsupportedVersion,
}

impl ResponseEnvelopeFault {
    fn apply(self, response: &mut Envelope) {
        match self {
            Self::MissingSuccess => response.ok = None,
            Self::WrongOperation => response.op = "unrelated.operation".into(),
            Self::UnsupportedVersion => response.v = 2,
        }
    }
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
            pair_response_fault: None,
            pair_controller_instance_id_override: None,
            pair_surface_id_override: None,
            pair_projection: None,
            pair_protocol_features: None,
            scope_summaries: vec![],
            sync_snapshots: vec![],
            sync_response_fault: None,
            snapshot_payload: None,
            panes_list_payload: json!({
                "panes": [{
                    "paneId": 1,
                    "paneLineageId": "pl_1",
                    "currentTarget": {
                        "currentState": "current",
                        "paneLineageId": "pl_1",
                        "targetEpoch": 3,
                        "targetId": "tg_1",
                        "targetKind": "browser_url"
                    }
                }]
            }),
            panes_list_rejection: None,
            panes_list_response_fault: None,
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
        if op == "panes.list" {
            if let Some(code) = self.panes_list_rejection.clone() {
                return Ok(WireResponse {
                    response: Envelope {
                        id: Some(id.into()),
                        op: "panes.list".into(),
                        payload: Some(json!({})),
                        envelope_type: "response".into(),
                        v: 1,
                        ok: Some(false),
                        error: Some(json!({ "code": code })),
                        sent_at: None,
                    },
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
            "pair.request" => {
                let mut pair_payload = json!({
                "capabilities": {},
                "controllerInstanceId": self
                    .pair_controller_instance_id_override
                    .clone()
                    .unwrap_or_else(|| payload["controllerInstanceId"].clone()),
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
                "surfaceId": self
                    .pair_surface_id_override
                    .clone()
                    .unwrap_or_else(|| payload.get("surfaceId").cloned().unwrap_or(Value::Null)),
                "surfaceSetRevision": 1
                });
                if let Some(projection) = self.pair_projection.as_deref() {
                    pair_payload["projection"] = json!(projection);
                    if projection == "control" {
                        pair_payload["scopeSummaries"] = json!(self.scope_summaries);
                    }
                }
                if let Some(features) = &self.pair_protocol_features {
                    pair_payload["capabilities"]["protocolFeatures"] = json!(features);
                }
                let mut response = Self::response(id, "pair.request", pair_payload);
                if let Some(fault) = self.pair_response_fault {
                    fault.apply(&mut response.response);
                }
                response
            }
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
            "consumable.sync" => {
                let mut response = Self::response(
                    id,
                    "consumable.sync",
                    json!({ "snapshots": self.sync_snapshots }),
                );
                if let Some(fault) = self.sync_response_fault {
                    fault.apply(&mut response.response);
                }
                response
            }
            "surfaces.list" => Self::response(
                id,
                "surfaces.list.result",
                json!({ "surfaces": [{ "surfaceId": "sf_1" }] }),
            ),
            "panes.list" => {
                let mut response =
                    Self::response(id, "panes.list", self.panes_list_payload.clone());
                if let Some(fault) = self.panes_list_response_fault {
                    fault.apply(&mut response.response);
                }
                response
            }
            "snapshot.get" => Self::response(
                id,
                "snapshot.result",
                self.snapshot_payload
                    .clone()
                    .unwrap_or_else(|| json!({ "snapshotId": "sn_1" })),
            ),
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
        registry: None,
        input: input.as_object().cloned().unwrap_or_else(Map::new),
        product_label: Some("Clawline".into()),
        projection_capacity_bytes: 1024 * 1024,
        state_root: temp.path().into(),
    }
}

fn pane_describe_input(controller_id: &str, surface_id: &str, pane_id: u64) -> Value {
    json!({
        "expectedControllerInstanceId": controller_id,
        "surfaceId": surface_id,
        "paneId": pane_id
    })
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

fn pane_content_record(
    surface_id: &str,
    pane_id: u64,
    sequence: u64,
    content_id: Option<&str>,
    operation: Option<&str>,
) -> Value {
    let mut payload = json!({
        "contentId": content_id,
        "currentContentId": content_id,
        "currentRevision": sequence,
        "historyEntryId": format!("he_{}_{}", content_id.unwrap_or("cleared"), sequence),
        "paneId": pane_id,
        "revision": sequence,
        "surfaceId": surface_id
    });
    if let Some(operation) = operation {
        payload["operation"] = json!(operation);
    }
    json!({
        "bytes": 128,
        "payload": payload,
        "recordClass": "content",
        "recordId": format!("record:{surface_id}:{pane_id}:{sequence}"),
        "sequence": sequence
    })
}

fn pane_scroll_record(surface_id: &str, pane_id: u64, sequence: u64) -> Value {
    json!({
        "bytes": 96,
        "payload": {
            "contentId": "content-visible",
            "paneId": pane_id,
            "phase": "settled",
            "revision": 1,
            "surfaceId": surface_id,
            "visibleText": "content visible after resume"
        },
        "recordClass": "scroll",
        "recordId": format!("scroll:{surface_id}:{pane_id}:{sequence}"),
        "sequence": sequence
    })
}

fn pane_scope_snapshot(scope_id: &str, cursor: u64, records: Vec<Value>) -> Value {
    let first = records
        .first()
        .and_then(|record| record["sequence"].as_u64())
        .unwrap_or(cursor);
    let last = records
        .last()
        .and_then(|record| record["sequence"].as_u64())
        .unwrap_or(cursor.saturating_sub(1));
    json!({
        "cursor": { "cursor": cursor, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": first,
        "lastRetainedSequence": last,
        "records": records,
        "scopeId": scope_id,
        "version": 1
    })
}

fn native_cli_read(temp: &TempDir, scope_id: &str) -> Value {
    let output = ProcessCommand::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args([
            "--state-root",
            temp.path().to_str().unwrap(),
            "read",
            "--input-json",
            &serde_json::to_string(&json!({ "scopeId": scope_id })).unwrap(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}

fn spawn_registry_server(
    payload: Value,
    response_op: &'static str,
    response_ok: bool,
) -> (String, thread::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let task = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut socket = accept(stream).unwrap();
        let request = match socket.read().unwrap() {
            Message::Text(text) => serde_json::from_str::<Value>(&text).unwrap(),
            message => panic!("unexpected registry request frame: {message:?}"),
        };
        let mut response = json!({
            "id": request["id"],
            "op": response_op,
            "payload": payload,
            "sentAt": epoch_ms(),
            "type": "response",
            "v": 1,
            "ok": response_ok,
        });
        if !response_ok {
            response["error"] = json!({ "code": "registry_unavailable" });
        }
        socket
            .send(Message::Text(response.to_string().into()))
            .unwrap();
        let _ = socket.close(None);
        request
    });
    (format!("ws://{address}"), task)
}

fn spawn_registry_sequence(payloads: Vec<Value>) -> (String, thread::JoinHandle<Vec<Value>>) {
    spawn_registry_sequence_with_outcomes(
        payloads
            .into_iter()
            .map(|payload| (payload, true))
            .collect(),
    )
}

fn spawn_registry_sequence_with_outcomes(
    outcomes: Vec<(Value, bool)>,
) -> (String, thread::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let task = thread::spawn(move || {
        let mut requests = Vec::new();
        for (payload, response_ok) in outcomes {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut socket = accept(stream).unwrap();
            let request = match socket.read().unwrap() {
                Message::Text(text) => serde_json::from_str::<Value>(&text).unwrap(),
                message => panic!("unexpected registry request frame: {message:?}"),
            };
            assert_eq!(request["op"], "fleet.topology");
            assert_eq!(request["payload"], json!({}));
            let mut response = json!({
                "id": request["id"],
                "op": "fleet.topology",
                "payload": payload,
                "sentAt": epoch_ms(),
                "type": "response",
                "v": 1,
                "ok": response_ok,
            });
            if !response_ok {
                response["error"] = json!({ "code": "registry_unavailable" });
            }
            socket
                .send(Message::Text(response.to_string().into()))
                .unwrap();
            let _ = socket.close(None);
            requests.push(request);
        }
        requests
    });
    (format!("ws://{address}"), task)
}

fn spawn_rejected_surface_describe_server(
    code: &'static str,
) -> (String, thread::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let task = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut socket = accept(stream).unwrap();
        let request = match socket.read().unwrap() {
            Message::Text(text) => serde_json::from_str::<Value>(&text).unwrap(),
            message => panic!("unexpected direct request frame: {message:?}"),
        };
        assert_eq!(request["op"], "surface.describe");
        socket
            .send(Message::Text(
                json!({
                    "id": request["id"], "op": "surface.describe", "error": { "code": code },
                    "sentAt": epoch_ms(), "type": "response", "v": 1, "ok": false
                })
                .to_string()
                .into(),
            ))
            .unwrap();
        let _ = socket.close(None);
        request
    });
    (format!("ws://{address}"), task)
}

fn spawn_surface_describe_server(payload: Value) -> (String, thread::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let task = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut socket = accept(stream).unwrap();
        let request = match socket.read().unwrap() {
            Message::Text(text) => serde_json::from_str::<Value>(&text).unwrap(),
            message => panic!("unexpected direct request frame: {message:?}"),
        };
        assert_eq!(request["op"], "surface.describe");
        let mut response_payload = payload;
        response_payload["nonce"] = request["payload"]["nonce"].clone();
        socket
            .send(Message::Text(
                json!({
                    "id": request["id"],
                    "op": "surface.describe",
                    "payload": response_payload,
                    "sentAt": epoch_ms(),
                    "type": "response",
                    "v": 1,
                    "ok": true,
                })
                .to_string()
                .into(),
            ))
            .unwrap();
        let _ = socket.close(None);
        request
    });
    (format!("ws://{address}"), task)
}

fn spawn_unresponsive_surface_server() -> (String, thread::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let task = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut socket = accept(stream).unwrap();
        let request = match socket.read().unwrap() {
            Message::Text(text) => serde_json::from_str::<Value>(&text).unwrap(),
            message => panic!("unexpected direct request frame: {message:?}"),
        };
        assert_eq!(request["op"], "surface.describe");
        drop(socket);
        request
    });
    (format!("ws://{address}"), task)
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn discovery_client(
    client_id: &str,
    endpoint: Option<&str>,
    surface_rows: Vec<Value>,
    generation: u64,
    registered_at: u64,
    expires_at: u64,
    supports_describe: bool,
) -> Value {
    json!({
        "clientId": client_id,
        "directEndpoint": endpoint,
        "prePairDescribeV1": supports_describe,
        "registryIdentity": { "allocatorId": "alloc_fixture", "fleetId": "fleet_fixture" },
        "endpointLease": {
            "leaseGeneration": generation,
            "registrationObservedAtMs": registered_at,
            "leaseExpiresAtMs": expires_at
        },
        "surfaces": surface_rows,
    })
}

fn discovery_surface(surface_id: &str, label: &str) -> Value {
    json!({
        "surfaceId": surface_id,
        "windowLabel": label,
        "panes": [{ "paneId": "1", "paneLabel": 1, "paneAddress": format!("{label}1") }]
    })
}

fn discovery_topology(clients: Vec<Value>, server_time_ms: u64) -> Value {
    json!({
        "clients": clients,
        "registryIdentity": { "allocatorId": "alloc_fixture", "fleetId": "fleet_fixture" },
        "registryServerTimeMs": server_time_ms,
        "maxEndpointLeaseMs": 15_000,
        "registrationReady": true,
    })
}

fn describe_observation(client_id: &str, surface_id: &str, generation: u64) -> Value {
    let now = epoch_ms();
    json!({
        "nonce": "ignored-by-fixture",
        "clientId": client_id,
        "registryIdentity": { "allocatorId": "alloc_fixture", "fleetId": "fleet_fixture" },
        "surfaceId": surface_id,
        "endpointLeaseGeneration": generation,
        "observedAtMs": now,
        "applicationReadiness": { "status": "ready", "limitationCodes": [] },
        "surfaceSetRevision": 4,
        "topologyRevision": 8,
        "layout": { "type": "pane", "paneId": 1 },
        "panes": [{
            "paneId": 1,
            "paneLabel": null,
            "contentObservation": { "revision": null, "source": "client-authority", "observedAtMs": now }
        }]
    })
}

fn run_window_describe(registry: &str, label: &str) -> std::process::Output {
    let input = serde_json::to_string(&json!({ "windowLabel": label })).unwrap();
    run_native_cli(&[
        "--registry",
        registry,
        "--input-json",
        &input,
        "window-describe",
    ])
}

fn run_native_cli(arguments: &[&str]) -> std::process::Output {
    ProcessCommand::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(arguments)
        .output()
        .unwrap()
}

#[test]
fn help_and_schema_are_json_and_do_not_require_operational_arguments() {
    let help = run_native_cli(&["--help"]);
    assert!(
        help.status.success(),
        "{}",
        String::from_utf8_lossy(&help.stdout)
    );
    let help_json: Value = serde_json::from_slice(&help.stdout).unwrap();
    assert_eq!(help_json["command"], "help");
    assert_eq!(
        help_json["result"]["commands"].as_array().unwrap().len(),
        Command::ALL.len() + 4
    );
    assert_eq!(
        help_json["result"]["commands"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|command| command["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("annotations ")))
            .count(),
        4
    );
    let discovery_limits = help_json["result"]["discoveryLimits"].as_array().unwrap();
    assert!(discovery_limits.iter().any(|limit| limit
        .as_str()
        .is_some_and(|text| text.contains("fleet-list")
            && text.contains("does not prove endpoint reachability"))));
    assert!(discovery_limits
        .iter()
        .any(|limit| limit.as_str().is_some_and(|text| {
            text.contains("pair a controller") && text.contains("not no-pair discovery probes")
        })));
    assert!(discovery_limits
        .iter()
        .any(|limit| limit.as_str().is_some_and(
            |text| text.contains("window-describe") && text.contains("does not authenticate")
        )));

    let list_help = run_native_cli(&["help", "list"]);
    assert!(list_help.status.success());
    let list_help_json: Value = serde_json::from_slice(&list_help.stdout).unwrap();
    assert!(list_help_json["result"]["command"]["effect"]
        .as_str()
        .unwrap()
        .contains("paired_direct_read"));
    assert!(
        list_help_json["result"]["command"]["resultSchema"]["properties"]["result"]["description"]
            .as_str()
            .unwrap()
            .contains("pair.request")
    );

    let window_help = run_native_cli(&["help", "window-describe"]);
    assert!(window_help.status.success());
    let window_help_json: Value = serde_json::from_slice(&window_help.stdout).unwrap();
    let window_command = &window_help_json["result"]["command"];
    assert_eq!(window_command["route"], "registry-and-direct-client");
    assert_eq!(
        window_command["effect"],
        "registry_leased_read_only_pre_pair_probe"
    );
    assert_eq!(
        window_command["wireOperation"],
        json!(["fleet.topology", "surface.describe", "fleet.topology"])
    );
    let window_input_schema = &window_command["inputSchema"];
    common::schema::validate(
        window_input_schema,
        window_input_schema,
        &window_command["examples"][0]["input"],
    )
    .expect("window-describe example validates against its published input schema");
    let window_result_schema = &window_command["resultSchema"]["properties"]["result"];
    assert!(
        window_result_schema["properties"]["surfaceObservation"]["properties"]["panes"]["items"]
            ["properties"]["contentObservation"]["properties"]["revision"]["type"]
            .as_array()
            .is_some_and(|types| types.contains(&json!("null")))
    );

    let window_schema = run_native_cli(&["schema", "window-describe"]);
    assert!(window_schema.status.success());
    let window_schema_json: Value = serde_json::from_slice(&window_schema.stdout).unwrap();
    assert_eq!(
        window_schema_json["result"]["command"]["name"],
        "window-describe"
    );

    let pane_help = run_native_cli(&["help", "pane-describe"]);
    assert!(pane_help.status.success());
    let pane_help_json: Value = serde_json::from_slice(&pane_help.stdout).unwrap();
    let pane_command = &pane_help_json["result"]["command"];
    assert_eq!(pane_command["effect"], "paired_surface_read_with_admission");
    assert_eq!(
        pane_command["wireOperation"],
        json!(["pair.request", "panes.list"])
    );
    assert!(
        pane_command["resultSchema"]["properties"]["result"]["description"]
            .as_str()
            .unwrap()
            .contains("pending-receipt reconciliation")
    );
    let pane_input_schema = &pane_command["inputSchema"];
    let pane_input_example = pane_command["examples"][0]["input"].clone();
    common::schema::validate(pane_input_schema, pane_input_schema, &pane_input_example)
        .expect("the pane-describe example validates against its published input schema");
    let pane_result_schema = &pane_command["resultSchema"]["properties"]["result"];
    common::schema::validate(
        pane_result_schema,
        pane_result_schema,
        &json!({
            "surfaceId": "sf_fixture",
            "paneId": 1,
            "paneLineageId": "pl_fixture",
            "currentTarget": {
                "paneLineageId": "pl_fixture",
                "targetEpoch": 7,
                "currentState": "stale",
                "targetId": "tg_fixture",
                "targetKind": "browser_url"
            },
            "targetEpoch": 7
        }),
    )
    .expect("a stale target's actual epoch validates without being represented as current");
    common::schema::validate(
        pane_result_schema,
        pane_result_schema,
        &json!({
            "surfaceId": "sf_fixture",
            "paneId": 1,
            "paneLineageId": "pl_fixture",
            "currentTarget": null,
            "targetEpoch": null
        }),
    )
    .expect("an absent current target is represented by null without an invented epoch");
    assert!(common::schema::validate(
        pane_result_schema,
        pane_result_schema,
        &json!({
            "surfaceId": "sf_fixture",
            "paneId": 1,
            "paneLineageId": "pl_fixture",
            "currentTarget": {
                "paneLineageId": "pl_fixture",
                "currentState": "current",
                "targetId": "tg_fixture",
                "targetKind": "browser_url"
            },
            "targetEpoch": 1
        }),
    )
    .is_err());

    let pane_schema = run_native_cli(&["schema", "pane-describe"]);
    assert!(pane_schema.status.success());
    let pane_schema_json: Value = serde_json::from_slice(&pane_schema.stdout).unwrap();
    assert_eq!(
        pane_schema_json["result"]["command"]["name"],
        "pane-describe"
    );
    assert!(pane_schema_json["result"]["command"]["inputSchema"].is_object());
    assert!(pane_schema_json["result"]["command"]["resultSchema"].is_object());

    let schema = run_native_cli(&["schema", "topology-realize"]);
    assert!(
        schema.status.success(),
        "{}",
        String::from_utf8_lossy(&schema.stdout)
    );
    let schema_json: Value = serde_json::from_slice(&schema.stdout).unwrap();
    assert_eq!(schema_json["command"], "schema");
    assert_eq!(schema_json["result"]["command"]["name"], "topology-realize");
    assert_eq!(schema_json["result"]["command"]["route"], "direct-client");

    let annotation_help = run_native_cli(&["annotations", "watch", "--help"]);
    assert!(
        annotation_help.status.success(),
        "{}",
        String::from_utf8_lossy(&annotation_help.stdout)
    );
    let annotation_help_json: Value = serde_json::from_slice(&annotation_help.stdout).unwrap();
    assert_eq!(
        annotation_help_json["result"]["command"]["name"],
        "annotations watch"
    );
    assert_eq!(
        annotation_help_json["result"]["command"]["route"],
        "registry"
    );

    let annotation_schema = run_native_cli(&["schema", "annotations", "ack"]);
    assert!(
        annotation_schema.status.success(),
        "{}",
        String::from_utf8_lossy(&annotation_schema.stdout)
    );
    let annotation_schema_json: Value = serde_json::from_slice(&annotation_schema.stdout).unwrap();
    assert_eq!(
        annotation_schema_json["result"]["command"]["name"],
        "annotations ack"
    );

    let watch_schema = run_native_cli(&["schema", "annotations", "watch"]);
    assert!(watch_schema.status.success());
    let watch_spec: Value = serde_json::from_slice(&watch_schema.stdout).unwrap();
    let watch_command = &watch_spec["result"]["command"];
    let watch_help = run_native_cli(&["help", "annotations", "watch"]);
    assert!(watch_help.status.success());
    let watch_help_json: Value = serde_json::from_slice(&watch_help.stdout).unwrap();
    let watch_help_command = &watch_help_json["result"]["command"];
    assert_eq!(
        watch_command["effect"],
        "registry_consumer_create_and_lease_acquire_and_local_state_write"
    );
    assert_eq!(watch_help_command["effect"], watch_command["effect"]);
    assert!(watch_command["summary"]
        .as_str()
        .unwrap()
        .contains("consumer ID must be unused"));
    assert!(watch_help_command["summary"]
        .as_str()
        .unwrap()
        .contains("consumer ID must be unused"));
    assert_eq!(
        watch_command["consumerLifecycle"]["registryConsumer"],
        "create"
    );

    let resume_schema = run_native_cli(&["schema", "annotations", "resume"]);
    assert!(resume_schema.status.success());
    let resume_spec: Value = serde_json::from_slice(&resume_schema.stdout).unwrap();
    let resume_command = &resume_spec["result"]["command"];
    let resume_help = run_native_cli(&["help", "annotations", "resume"]);
    assert!(resume_help.status.success());
    let resume_help_json: Value = serde_json::from_slice(&resume_help.stdout).unwrap();
    let resume_help_command = &resume_help_json["result"]["command"];
    assert_eq!(
        resume_command["effect"],
        "registry_consumer_lease_replace_and_local_state_write_may_close_prior_listener"
    );
    assert_eq!(resume_help_command["effect"], resume_command["effect"]);
    assert!(resume_command["summary"]
        .as_str()
        .unwrap()
        .contains("may close another live listener"));
    assert!(resume_help_command["summary"]
        .as_str()
        .unwrap()
        .contains("may close another live listener"));
    assert_eq!(
        resume_command["consumerLifecycle"]["lease"],
        "replace_and_fence_prior"
    );
    assert_eq!(
        resume_command["consumerLifecycle"]["mayClosePriorSameIdListener"],
        true
    );
}

#[test]
fn private_dns_helper_uses_the_platform_resolver_without_starting_cli_state() {
    let output = ProcessCommand::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(["--_surf_ace_internal_resolve_dns", "localhost", "80"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let addresses = String::from_utf8(output.stdout).unwrap();
    assert!(addresses.lines().any(|line| line
        .parse::<SocketAddr>()
        .is_ok_and(|addr| addr.port() == 80)));
}

#[test]
fn topology_realize_published_schema_resolves_recursive_nodes_at_resource_root() {
    let schema_output = run_native_cli(&["schema", "topology-realize"]);
    assert!(
        schema_output.status.success(),
        "{}",
        String::from_utf8_lossy(&schema_output.stdout)
    );
    let schema_response: Value = serde_json::from_slice(&schema_output.stdout).unwrap();
    let input_schema = &schema_response["result"]["command"]["inputSchema"];
    assert!(input_schema["$defs"]["topology"].is_object());

    let help_output = run_native_cli(&["help", "topology-realize"]);
    assert!(help_output.status.success());
    let help_response: Value = serde_json::from_slice(&help_output.stdout).unwrap();
    let example = help_response["result"]["command"]["examples"][0]["input"].clone();
    common::schema::validate(input_schema, input_schema, &example)
        .expect("the documented three-pane example validates against the published schema");

    let mut nested = example.clone();
    nested["desired"]["children"][0] = json!({
        "type": "split", "direction": "horizontal", "children": [
            { "type": "pane" }, { "type": "pane", "paneId": 17 }
        ]
    });
    common::schema::validate(input_schema, input_schema, &nested)
        .expect("nested splits resolve the same resource-root definition");

    let mut unknown_descendant = nested.clone();
    unknown_descendant["desired"]["children"][0]["children"][1]["type"] = json!("unknown");
    assert!(common::schema::validate(input_schema, input_schema, &unknown_descendant).is_err());

    let mut incomplete_descendant = nested;
    incomplete_descendant["desired"]["children"][0]["children"][0] =
        json!({ "type": "split", "direction": "vertical" });
    assert!(common::schema::validate(input_schema, input_schema, &incomplete_descendant).is_err());
}

fn fleet_inventory_fixture() -> Value {
    json!({
        "clients": [
            {
                "clientId": "a".repeat(64),
                "registryIdentity": { "allocatorId": "alloc_fixture", "fleetId": "fleet_fixture" },
                "surfaces": [
                    {
                        "surfaceId": "sf_primary",
                        "windowLabel": "a",
                        "panes": [
                            { "paneId": "1", "paneLabel": 1, "paneAddress": "a1" },
                            { "paneId": "2", "paneLabel": 2, "paneAddress": "a2" }
                        ]
                    },
                    {
                        "surfaceId": "sf_secondary",
                        "windowLabel": "b",
                        "panes": [{ "paneId": "1", "paneLabel": 1, "paneAddress": "b1" }]
                    }
                ]
            },
            {
                "clientId": "b".repeat(64),
                "registryIdentity": { "allocatorId": "alloc_fixture", "fleetId": "fleet_fixture" },
                "surfaces": [{
                    "surfaceId": "sf_other_client",
                    "windowLabel": "c",
                    "panes": [{ "paneId": "7", "paneLabel": 3, "paneAddress": "c3" }]
                }]
            }
        ]
    })
}

#[test]
fn window_describe_reads_a_leased_endpoint_before_pairing_and_rechecks_the_registry() {
    let now = epoch_ms();
    let client_id = "a".repeat(64);
    let surface_id = "sf_window_fixture";
    let (endpoint, endpoint_server) =
        spawn_surface_describe_server(describe_observation(&client_id, surface_id, 9));
    let first = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(&endpoint),
            vec![discovery_surface(surface_id, "a")],
            9,
            now - 100,
            now + 10_000,
            true,
        )],
        now,
    );
    let second = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(&endpoint),
            vec![discovery_surface(surface_id, "a")],
            9,
            now - 100,
            now + 12_000,
            true,
        )],
        now + 5,
    );
    let (registry, registry_server) = spawn_registry_sequence(vec![first, second]);
    let temp = TempDir::new().unwrap();
    let state_root = temp.path().join("must-remain-absent");
    let state_root_text = state_root.to_str().unwrap();
    let input = serde_json::to_string(&json!({ "windowLabel": "a" })).unwrap();

    let output = run_native_cli(&[
        "--state-root",
        state_root_text,
        "--registry",
        &registry,
        "--input-json",
        &input,
        "window-describe",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["command"], "window-describe");
    assert_eq!(result["result"]["windowLabel"], "a");
    assert_eq!(
        result["result"]["identitySemantics"],
        "consistency_only_not_authentication"
    );
    assert_eq!(
        result["result"]["transportReachability"]["status"],
        "reachable"
    );
    assert_eq!(
        result["result"]["transportReachability"]["directEndpoint"],
        endpoint
    );
    assert_eq!(result["result"]["applicationReadiness"]["status"], "ready");
    assert_eq!(
        result["result"]["registryBefore"]["endpointLease"]["leaseGeneration"],
        9
    );
    assert_eq!(
        result["result"]["registryAfter"]["endpointLease"]["leaseExpiresAtMs"],
        now + 12_000
    );
    assert_eq!(
        result["result"]["surfaceObservation"]["surfaceSetRevision"],
        4
    );
    assert_eq!(
        result["result"]["surfaceObservation"]["topologyRevision"],
        8
    );
    assert_eq!(
        result["result"]["surfaceObservation"]["layout"]["paneId"],
        1
    );
    assert_eq!(
        result["result"]["surfaceObservation"]["panes"][0]["paneLabel"],
        Value::Null
    );
    assert_eq!(
        result["result"]["surfaceObservation"]["panes"][0]["contentObservation"]["revision"],
        Value::Null
    );

    let registry_requests = registry_server.join().unwrap();
    assert_eq!(registry_requests.len(), 2);
    assert!(registry_requests
        .iter()
        .all(|request| request["op"] == "fleet.topology"));
    let direct_request = endpoint_server.join().unwrap();
    assert_eq!(direct_request["op"], "surface.describe");
    assert_eq!(direct_request["type"], "request");
    assert_eq!(direct_request["v"], 1);
    let payload = direct_request["payload"].as_object().unwrap();
    let mut keys = payload.keys().map(String::as_str).collect::<Vec<_>>();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "clientId",
            "endpointLeaseGeneration",
            "nonce",
            "registryIdentity",
            "surfaceId"
        ]
    );
    assert_eq!(payload["nonce"].as_str().unwrap().len(), 64);
    assert!(!payload.contains_key("controllerInstanceId"));
    assert!(
        !state_root.exists(),
        "window-describe must not create controller state"
    );
}

#[test]
fn window_describe_rejects_missing_ambiguous_and_stale_registry_rows() {
    let now = epoch_ms();
    let id_a = "a".repeat(64);
    let id_b = "b".repeat(64);
    let endpoint = "ws://127.0.0.1:1";
    let cases = vec![
        ("window_not_found", discovery_topology(vec![], now)),
        (
            "endpoint_unconfigured",
            discovery_topology(
                vec![discovery_client(
                    &id_a,
                    None,
                    vec![discovery_surface("sf_window_unconfigured", "a")],
                    2,
                    now - 10,
                    now + 10_000,
                    false,
                )],
                now,
            ),
        ),
        (
            "window_ambiguous",
            discovery_topology(
                vec![
                    discovery_client(
                        &id_a,
                        Some(endpoint),
                        vec![discovery_surface("sf_window_one", "a")],
                        2,
                        now - 10,
                        now + 10_000,
                        true,
                    ),
                    discovery_client(
                        &id_b,
                        Some(endpoint),
                        vec![discovery_surface("sf_window_two", "a")],
                        3,
                        now - 10,
                        now + 10_000,
                        true,
                    ),
                ],
                now,
            ),
        ),
        (
            "stale_registration",
            discovery_topology(
                vec![discovery_client(
                    &id_a,
                    Some("ws://127.0.0.1:1"),
                    vec![discovery_surface("sf_window_stale", "a")],
                    2,
                    now - 20_000,
                    now - 1,
                    true,
                )],
                now,
            ),
        ),
    ];
    for (expected_code, topology) in cases {
        let (registry, server) = spawn_registry_sequence(vec![topology]);
        let output = run_window_describe(&registry, "a");
        assert!(!output.status.success());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["error"]["code"], expected_code);
        assert_eq!(server.join().unwrap().len(), 1);
    }
}

#[test]
fn window_describe_requires_selected_row_identity_to_match_registry_identity() {
    let now = epoch_ms();
    let client_id = "6".repeat(64);
    let endpoint = "ws://127.0.0.1:1";
    let mut missing = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(endpoint),
            vec![discovery_surface("sf_row_missing_identity", "a")],
            3,
            now - 10,
            now + 10_000,
            true,
        )],
        now,
    );
    missing["clients"][0]
        .as_object_mut()
        .unwrap()
        .remove("registryIdentity");

    let mut foreign_allocator = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(endpoint),
            vec![discovery_surface("sf_row_foreign_allocator", "a")],
            3,
            now - 10,
            now + 10_000,
            true,
        )],
        now,
    );
    foreign_allocator["clients"][0]["registryIdentity"]["allocatorId"] = json!("alloc_other");

    let mut foreign_fleet = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(endpoint),
            vec![discovery_surface("sf_row_foreign_fleet", "a")],
            3,
            now - 10,
            now + 10_000,
            true,
        )],
        now,
    );
    foreign_fleet["clients"][0]["registryIdentity"]["fleetId"] = json!("fleet_other");

    for topology in [missing, foreign_allocator, foreign_fleet] {
        let (registry, server) = spawn_registry_sequence(vec![topology]);
        let output = run_window_describe(&registry, "a");
        assert!(!output.status.success());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["error"]["code"], "registry_response_invalid");
        assert_eq!(
            server.join().unwrap().len(),
            1,
            "must refuse before direct connect"
        );
    }

    let now = epoch_ms();
    let surface_id = "sf_row_identity_recheck";
    let (direct_endpoint, direct_server) =
        spawn_surface_describe_server(describe_observation(&client_id, surface_id, 4));
    let before = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(&direct_endpoint),
            vec![discovery_surface(surface_id, "a")],
            4,
            now - 10,
            now + 10_000,
            true,
        )],
        now,
    );
    let mut after = before.clone();
    after["clients"][0]["registryIdentity"]["fleetId"] = json!("fleet_foreign_recheck");
    after["registryIdentity"]["fleetId"] = json!("fleet_foreign_recheck");
    let (registry, server) = spawn_registry_sequence(vec![before, after]);
    let output = run_window_describe(&registry, "a");
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result["error"]["code"], "stale_registration",
        "result={result}"
    );
    assert_eq!(
        result["error"]["details"]["transportReachability"]["status"],
        "reachable"
    );
    assert_eq!(server.join().unwrap().len(), 2);
    let request = direct_server.join().unwrap();
    assert_eq!(
        request["payload"]["registryIdentity"]["allocatorId"],
        "alloc_fixture"
    );
    assert_eq!(
        request["payload"]["registryIdentity"]["fleetId"],
        "fleet_fixture"
    );
}

#[test]
fn window_describe_rejects_unreachable_endpoints_and_stale_rechecks() {
    let now = epoch_ms();
    let client_id = "c".repeat(64);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let unavailable_endpoint = format!("ws://{}", listener.local_addr().unwrap());
    drop(listener);
    let topology = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(&unavailable_endpoint),
            vec![discovery_surface("sf_unreachable", "a")],
            5,
            now - 10,
            now + 10_000,
            true,
        )],
        now,
    );
    let (registry, server) = spawn_registry_sequence(vec![topology.clone(), topology]);
    let unreachable = run_window_describe(&registry, "a");
    assert!(!unreachable.status.success());
    let unreachable_json: Value = serde_json::from_slice(&unreachable.stdout).unwrap();
    assert_eq!(unreachable_json["error"]["code"], "endpoint_unreachable");
    assert_eq!(
        unreachable_json["error"]["details"]["transportReachability"]["status"],
        "unreachable"
    );
    assert_eq!(
        unreachable_json["error"]["details"]["applicationReadiness"]["status"],
        "unknown"
    );
    assert_eq!(server.join().unwrap().len(), 2);

    let surface_id = "sf_stale_after_probe";
    let (endpoint, endpoint_server) =
        spawn_surface_describe_server(describe_observation(&client_id, surface_id, 5));
    let first = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(&endpoint),
            vec![discovery_surface(surface_id, "a")],
            5,
            now - 10,
            now + 10_000,
            true,
        )],
        now,
    );
    let changed = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(&endpoint),
            vec![discovery_surface(surface_id, "a")],
            6,
            now - 10,
            now + 10_000,
            true,
        )],
        now + 1,
    );
    let (registry, server) = spawn_registry_sequence(vec![first, changed]);
    let stale = run_window_describe(&registry, "a");
    assert!(!stale.status.success());
    let stale_json: Value = serde_json::from_slice(&stale.stdout).unwrap();
    assert_eq!(stale_json["error"]["code"], "stale_registration");
    assert_eq!(
        stale_json["error"]["details"]["transportReachability"]["status"],
        "reachable"
    );
    assert_eq!(
        stale_json["error"]["details"]["applicationReadiness"]["status"],
        "ready"
    );
    assert_eq!(
        stale_json["error"]["details"]["surfaceObservation"]["topologyRevision"],
        8
    );
    assert!(stale_json["error"]["details"]
        .get("registryAfter")
        .is_none());
    assert_eq!(server.join().unwrap().len(), 2);
    let direct_request = endpoint_server.join().unwrap();
    assert_eq!(direct_request["op"], "surface.describe");
}

#[test]
fn window_describe_preserves_transport_and_unknown_readiness_when_recheck_fails() {
    let now = epoch_ms();
    let client_id = "7".repeat(64);
    let surface_id = "sf_invalid_then_stale";
    for recheck_kind in ["stale", "ambiguous", "unavailable"] {
        let mut invalid_observation = describe_observation(&client_id, surface_id, 5);
        invalid_observation
            .as_object_mut()
            .unwrap()
            .remove("topologyRevision");
        let (endpoint, endpoint_server) = spawn_surface_describe_server(invalid_observation);
        let first = discovery_topology(
            vec![discovery_client(
                &client_id,
                Some(&endpoint),
                vec![discovery_surface(surface_id, "a")],
                5,
                now - 10,
                now + 10_000,
                true,
            )],
            now,
        );
        let (second, response_ok, expected_code) = match recheck_kind {
            "stale" => {
                let mut changed = first.clone();
                changed["clients"][0]["endpointLease"]["leaseGeneration"] = json!(6);
                (changed, true, "stale_registration")
            }
            "ambiguous" => (
                discovery_topology(
                    vec![
                        discovery_client(
                            &client_id,
                            Some(&endpoint),
                            vec![discovery_surface(surface_id, "a")],
                            5,
                            now - 10,
                            now + 10_000,
                            true,
                        ),
                        discovery_client(
                            &"9".repeat(64),
                            Some("ws://127.0.0.1:2"),
                            vec![discovery_surface("sf_ambiguous_recheck", "a")],
                            7,
                            now - 10,
                            now + 10_000,
                            true,
                        ),
                    ],
                    now,
                ),
                true,
                "stale_registration",
            ),
            _ => (json!({}), false, "registry_unavailable"),
        };
        let outcomes = vec![(first, true), (second, response_ok)];
        let (registry, registry_server) = spawn_registry_sequence_with_outcomes(outcomes);
        let output = run_window_describe(&registry, "a");
        assert!(!output.status.success());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result["error"]["code"], expected_code,
            "recheck_kind={recheck_kind}, result={result}"
        );
        assert_eq!(
            result["error"]["details"]["transportReachability"]["status"],
            "reachable"
        );
        assert_eq!(
            result["error"]["details"]["applicationReadiness"]["status"],
            "unknown"
        );
        assert_eq!(
            result["error"]["details"]["transportReachability"]["observedAtMs"]
                .as_u64()
                .is_some(),
            true
        );
        assert!(result["error"]["details"]
            .get("surfaceObservation")
            .is_none());
        assert_eq!(registry_server.join().unwrap().len(), 2);
        assert_eq!(endpoint_server.join().unwrap()["op"], "surface.describe");
    }
}

#[test]
fn window_describe_serialized_discovery_errors_match_advertised_error_schema() {
    let schema_output = run_native_cli(&["schema", "window-describe"]);
    assert!(schema_output.status.success());
    let schema: Value = serde_json::from_slice(&schema_output.stdout).unwrap();
    let error_schema = schema["result"]["errorSchema"].clone();

    let (registry, server) = spawn_registry_server(json!({}), "fleet.topology", false);
    let unavailable = run_window_describe(&registry, "a");
    assert!(!unavailable.status.success());
    let unavailable_json: Value = serde_json::from_slice(&unavailable.stdout).unwrap();
    assert_eq!(unavailable_json["error"]["code"], "registry_unavailable");
    common::schema::validate(&error_schema, &error_schema, &unavailable_json).unwrap();
    server.join().unwrap();

    let now = epoch_ms();
    let client_id = "8".repeat(64);
    let surface_id = "sf_rejected_schema";
    let (endpoint, endpoint_server) =
        spawn_rejected_surface_describe_server("unexpected_client_failure");
    let topology = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(&endpoint),
            vec![discovery_surface(surface_id, "a")],
            5,
            now - 10,
            now + 10_000,
            true,
        )],
        now,
    );
    let (registry, registry_server) = spawn_registry_sequence(vec![topology.clone(), topology]);
    let rejected = run_window_describe(&registry, "a");
    assert!(!rejected.status.success());
    let rejected_json: Value = serde_json::from_slice(&rejected.stdout).unwrap();
    assert_eq!(
        rejected_json["error"]["code"], "describe_rejected",
        "result={rejected_json}"
    );
    common::schema::validate(&error_schema, &error_schema, &rejected_json).unwrap();
    assert_eq!(registry_server.join().unwrap().len(), 2);
    assert_eq!(endpoint_server.join().unwrap()["op"], "surface.describe");
}

#[test]
fn window_describe_rejects_direct_identity_mismatch() {
    let now = epoch_ms();
    let client_id = "d".repeat(64);
    let wrong_client_id = "e".repeat(64);
    let surface_id = "sf_identity_mismatch";
    let (endpoint, endpoint_server) =
        spawn_surface_describe_server(describe_observation(&wrong_client_id, surface_id, 7));
    let topology = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(&endpoint),
            vec![discovery_surface(surface_id, "a")],
            7,
            now - 10,
            now + 10_000,
            true,
        )],
        now,
    );
    let (registry, server) = spawn_registry_sequence(vec![topology.clone(), topology]);
    let output = run_window_describe(&registry, "a");
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["error"]["code"], "identity_mismatch");
    assert_eq!(
        result["error"]["details"]["transportReachability"]["status"],
        "reachable"
    );
    assert_eq!(
        result["error"]["details"]["applicationReadiness"]["status"],
        "unknown"
    );
    assert_eq!(server.join().unwrap().len(), 2);
    assert_eq!(endpoint_server.join().unwrap()["op"], "surface.describe");
}

#[test]
fn window_describe_keeps_reachable_transport_separate_from_unresponsive_application() {
    let now = epoch_ms();
    let client_id = "f".repeat(64);
    let surface_id = "sf_unresponsive";
    let (endpoint, endpoint_server) = spawn_unresponsive_surface_server();
    let topology = discovery_topology(
        vec![discovery_client(
            &client_id,
            Some(&endpoint),
            vec![discovery_surface(surface_id, "a")],
            7,
            now - 10,
            now + 10_000,
            true,
        )],
        now,
    );
    let (registry, registry_server) = spawn_registry_sequence(vec![topology.clone(), topology]);
    let output = run_window_describe(&registry, "a");
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["error"]["code"], "application_unresponsive");
    assert_eq!(
        result["error"]["details"]["transportReachability"]["status"],
        "reachable"
    );
    assert_eq!(
        result["error"]["details"]["applicationReadiness"]["status"],
        "unknown"
    );
    assert_eq!(registry_server.join().unwrap().len(), 2);
    assert_eq!(endpoint_server.join().unwrap()["op"], "surface.describe");
}

#[test]
fn fleet_list_queries_registered_inventory_without_pairing_or_local_state_mutation() {
    let expected = fleet_inventory_fixture();
    let (registry, server) = spawn_registry_server(expected.clone(), "fleet.topology", true);
    let temp = TempDir::new().unwrap();
    let state_root = temp.path().join("state-must-remain-absent");
    let state_root_text = state_root.to_str().unwrap();
    let output = run_native_cli(&[
        "--state-root",
        state_root_text,
        "--registry",
        &registry,
        "fleet-list",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let output_json: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output_json["ok"], true);
    assert_eq!(output_json["command"], "fleet-list");
    assert!(output_json.get("controllerInstanceId").is_none());
    assert_eq!(output_json["result"], expected);
    assert!(
        !state_root.exists(),
        "fleet-list must not create controller state"
    );

    let request = server.join().unwrap();
    assert_eq!(request["v"], 1);
    assert_eq!(request["type"], "request");
    assert_eq!(request["op"], "fleet.topology");
    assert_eq!(request["payload"], json!({}));
    assert!(request["id"]
        .as_str()
        .is_some_and(|id| id.starts_with("rq_")));
}

#[test]
fn fleet_list_selects_only_the_explicit_registry_without_environment_fallback() {
    let first_inventory = fleet_inventory_fixture();
    let second_inventory = json!({
        "clients": [{
            "clientId": "c".repeat(64),
            "surfaces": [{
                "surfaceId": "sf_registry_two",
                "windowLabel": "z",
                "panes": [{ "paneId": "pane-unique", "paneLabel": 4, "paneAddress": "z4" }]
            }]
        }]
    });
    let (first_registry, first_server) =
        spawn_registry_server(first_inventory.clone(), "fleet.topology", true);
    let (second_registry, second_server) =
        spawn_registry_server(second_inventory.clone(), "fleet.topology", true);
    let temp = TempDir::new().unwrap();
    let state_root = temp.path().join("must-remain-absent");
    let state_root_text = state_root.to_str().unwrap();

    for (registry, expected, foreign_client_id, server) in [
        (
            first_registry.as_str(),
            &first_inventory,
            "c".repeat(64),
            first_server,
        ),
        (
            second_registry.as_str(),
            &second_inventory,
            "a".repeat(64),
            second_server,
        ),
    ] {
        let output = run_native_cli(&[
            "--state-root",
            state_root_text,
            "--registry",
            registry,
            "fleet-list",
        ]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let output_json: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(output_json["result"], *expected);
        assert!(output_json.to_string().find(&foreign_client_id).is_none());

        let request = server.join().unwrap();
        assert_eq!(request["op"], "fleet.topology");
        assert_eq!(request["payload"], json!({}));
    }
    assert!(!state_root.exists(), "fleet-list must remain state-free");

    // A registry environment value must not silently become the selected route.
    let no_explicit_registry = ProcessCommand::new(env!("CARGO_BIN_EXE_surf-ace"))
        .env("SURF_ACE_SERVER", &first_registry)
        .args(["--state-root", state_root_text, "fleet-list"])
        .output()
        .unwrap();
    assert!(!no_explicit_registry.status.success());
    let no_explicit_json: Value = serde_json::from_slice(&no_explicit_registry.stdout).unwrap();
    assert_eq!(
        no_explicit_json["error"]["details"]["message"],
        "invalid_input:missing_registry"
    );
}

#[test]
fn fleet_list_distinguishes_an_empty_registry_from_an_unavailable_registry() {
    let (registry, server) =
        spawn_registry_server(json!({ "clients": [] }), "fleet.topology", true);
    let temp = TempDir::new().unwrap();
    let state_root = temp.path().join("empty-state");
    let state_root_text = state_root.to_str().unwrap();
    let empty = run_native_cli(&[
        "--state-root",
        state_root_text,
        "--registry",
        &registry,
        "fleet-list",
    ]);
    assert!(empty.status.success());
    let empty_json: Value = serde_json::from_slice(&empty.stdout).unwrap();
    assert_eq!(empty_json["result"]["clients"], json!([]));
    assert!(server.join().is_ok());

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let unavailable_url = format!("ws://{}", listener.local_addr().unwrap());
    drop(listener);
    let unavailable_state = temp.path().join("unavailable-state");
    let unavailable_state_text = unavailable_state.to_str().unwrap();
    let unavailable = run_native_cli(&[
        "--state-root",
        unavailable_state_text,
        "--registry",
        &unavailable_url,
        "fleet-list",
    ]);
    assert!(!unavailable.status.success());
    let unavailable_json: Value = serde_json::from_slice(&unavailable.stdout).unwrap();
    assert_eq!(unavailable_json["error"]["code"], "transport_error");
    assert!(unavailable_json["error"]["details"]["message"]
        .as_str()
        .unwrap()
        .contains("before_send:reachability:"));
    assert_ne!(empty_json["result"]["clients"], unavailable_json["error"]);
    assert!(!unavailable_state.exists());
}

#[test]
fn fleet_list_rejects_ambiguous_invalid_and_malformed_registry_routes() {
    let temp = TempDir::new().unwrap();
    let state_root = temp.path().join("unused-state");
    let state_root_text = state_root.to_str().unwrap();

    let ambiguous = run_native_cli(&[
        "--state-root",
        state_root_text,
        "--endpoint",
        "ws://client.invalid",
        "--registry",
        "ws://registry.invalid",
        "fleet-list",
    ]);
    assert!(!ambiguous.status.success());
    let ambiguous_json: Value = serde_json::from_slice(&ambiguous.stdout).unwrap();
    assert_eq!(
        ambiguous_json["error"]["details"]["message"],
        "invalid_input:ambiguous_endpoint_registry"
    );

    let invalid = run_native_cli(&[
        "--state-root",
        state_root_text,
        "--registry",
        "https://registry.example",
        "fleet-list",
    ]);
    assert!(!invalid.status.success());
    let invalid_json: Value = serde_json::from_slice(&invalid.stdout).unwrap();
    assert_eq!(
        invalid_json["error"]["details"]["message"],
        "invalid_input:invalid_registry"
    );

    let missing = run_native_cli(&["--state-root", state_root_text, "fleet-list"]);
    assert!(!missing.status.success());
    let missing_json: Value = serde_json::from_slice(&missing.stdout).unwrap();
    assert_eq!(
        missing_json["error"]["details"]["message"],
        "invalid_input:missing_registry"
    );

    let malformed_payload =
        json!({ "clients": [{ "clientId": "not-a-fingerprint", "surfaces": [] }] });
    let (registry, server) = spawn_registry_server(malformed_payload, "fleet.topology", true);
    let malformed = run_native_cli(&[
        "--state-root",
        state_root_text,
        "--registry",
        &registry,
        "fleet-list",
    ]);
    assert!(!malformed.status.success());
    let malformed_json: Value = serde_json::from_slice(&malformed.stdout).unwrap();
    assert_eq!(malformed_json["error"]["code"], "protocol_error");
    assert!(malformed_json["error"]["details"]["message"]
        .as_str()
        .unwrap()
        .contains("invalid_fleet_topology_client_id"));
    assert!(server.join().is_ok());
    assert!(!state_root.exists());

    let (registry, server) =
        spawn_registry_server(fleet_inventory_fixture(), "client.register", true);
    let malformed_envelope = run_native_cli(&[
        "--state-root",
        state_root_text,
        "--registry",
        &registry,
        "fleet-list",
    ]);
    assert!(!malformed_envelope.status.success());
    let malformed_envelope_json: Value =
        serde_json::from_slice(&malformed_envelope.stdout).unwrap();
    assert_eq!(malformed_envelope_json["error"]["code"], "protocol_error");
    assert_eq!(
        malformed_envelope_json["error"]["details"]["message"],
        "protocol_error:invalid_fleet_topology_envelope"
    );
    assert!(server.join().is_ok());

    let ordinary_command = run_native_cli(&[
        "--state-root",
        state_root_text,
        "--registry",
        "ws://registry.invalid",
        "list",
    ]);
    assert!(!ordinary_command.status.success());
    let ordinary_command_json: Value = serde_json::from_slice(&ordinary_command.stdout).unwrap();
    assert_eq!(
        ordinary_command_json["error"]["details"]["message"],
        "invalid_input:registry_only_for_fleet_list"
    );
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
    assert_eq!(expected.len(), 14);
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
fn canonical_client_commands_map_to_the_public_wire_and_return_json() {
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
fn packaged_linux_and_macos_cli_assets_use_the_same_command_surface() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let repository = manifest_dir.join("../..");
    let config =
        fs::read_to_string(repository.join("scripts/release/tightbeam-release-config.mjs"))
            .unwrap();
    for target in ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"] {
        assert!(
            config.contains(&format!(
                "cargo build --manifest-path source/packages/cli/Cargo.toml --target-dir source/packages/cli/target --release --locked --target {target}"
            )),
            "release config must build the CLI crate for {target}"
        );
    }

    let builder =
        fs::read_to_string(repository.join("scripts/release/build-tightbeam-release.mjs")).unwrap();
    let linux_stage = builder
        .split("export async function buildTightbeamLinuxStage")
        .nth(1)
        .unwrap()
        .split("const TIGHTBEAM_SKILL_SOURCE")
        .next()
        .unwrap();
    let linux_packages = builder
        .split("export async function buildTightbeamLinuxPackages")
        .nth(1)
        .unwrap()
        .split("export async function buildTightbeamMacosPackages")
        .next()
        .unwrap();
    let macos = builder
        .split("export async function buildTightbeamMacosPackages")
        .nth(1)
        .unwrap()
        .split("export async function buildTightbeamLinuxQualification")
        .next()
        .unwrap();
    for platform_builder in [linux_stage, macos] {
        assert!(platform_builder.contains("path.join(source, \"packages/cli/Cargo.toml\")"));
    }
    for package_builder in [linux_packages, macos] {
        assert!(package_builder.contains("packages/cli/target"));
        assert!(package_builder.contains("release/surf-ace"));
        assert!(package_builder.contains("assembleTightbeamCliStage"));
    }
    assert!(builder.contains("path.join(stageDir, \"bin/surf-ace\")"));
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
    assert_eq!(cases.len(), 65);
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
fn pane_describe_validates_local_guards_and_sends_only_surface_id_to_panes_list() {
    let input = pane_describe_input("ctl_fixture", "sf_1", 1);
    let fields = input.as_object().unwrap();
    assert_eq!(
        Command::PaneDescribe.wire_operation(fields).unwrap(),
        "panes.list"
    );
    assert_eq!(
        Command::PaneDescribe.wire_payload(fields.clone()).unwrap(),
        json!({ "surfaceId": "sf_1" })
    );

    for invalid in [
        json!({ "expectedControllerInstanceId": "", "surfaceId": "sf_1", "paneId": 1 }),
        json!({ "expectedControllerInstanceId": "ctl_fixture", "surfaceId": "sf_1", "paneId": 0 }),
        json!({ "expectedControllerInstanceId": "ctl_fixture", "surfaceId": "sf_1", "paneId": 1, "extra": true }),
    ] {
        assert!(Command::PaneDescribe
            .validate(invalid.as_object().unwrap())
            .is_err());
    }
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
    wire.pair_projection = Some("control".into());
    wire.pair_protocol_features = Some(vec!["control_projection_v1".into()]);
    wire.scope_summaries = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 0,
        "scopeId": "surface:sf_1"
    })];
    wire.sync_snapshots = vec![json!({
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
    let sync_request = wire
        .payloads
        .iter()
        .find(|(operation, _)| operation == "consumable.sync")
        .unwrap();
    assert_eq!(sync_request.1["scopeIds"], json!(["surface:sf_1"]));
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
    assert_eq!(pair_payload["resume"]["pendingAcks"], json!([]));
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
fn pane_describe_requires_the_existing_controller_root_and_expected_identity() {
    let expected_root = TempDir::new().unwrap();
    let mut initialize = FakeWire::ordinary();
    let expected_id = execute_with_wire(
        invocation(&expected_root, Command::List, json!({})),
        &mut initialize,
    )
    .unwrap()
    .controller_instance_id
    .unwrap();

    let uninitialized_root = TempDir::new().unwrap();
    let mut uninitialized_wire = FakeWire::ordinary();
    let error = execute_with_wire(
        invocation(
            &uninitialized_root,
            Command::PaneDescribe,
            pane_describe_input(&expected_id, "sf_1", 1),
        ),
        &mut uninitialized_wire,
    )
    .unwrap_err();
    assert!(matches!(error, CliError::State(_)));
    assert!(uninitialized_wire.operations.is_empty());
    assert!(
        !uninitialized_root.path().exists()
            || fs::read_dir(uninitialized_root.path())
                .unwrap()
                .next()
                .is_none()
    );

    let wrong_root = TempDir::new().unwrap();
    let mut initialize_wrong = FakeWire::ordinary();
    let wrong_id = execute_with_wire(
        invocation(&wrong_root, Command::List, json!({})),
        &mut initialize_wrong,
    )
    .unwrap()
    .controller_instance_id
    .unwrap();
    assert_ne!(expected_id, wrong_id);

    let mut wrong_root_wire = FakeWire::ordinary();
    let error = execute_with_wire(
        invocation(
            &wrong_root,
            Command::PaneDescribe,
            pane_describe_input(&expected_id, "sf_1", 1),
        ),
        &mut wrong_root_wire,
    )
    .unwrap_err();
    assert!(matches!(error, CliError::Input(message) if message == "controller_instance_mismatch"));
    assert!(wrong_root_wire.operations.is_empty());
}

#[test]
fn pane_describe_reuses_one_controller_and_uses_one_surface_scoped_panes_list_response() {
    let temp = TempDir::new().unwrap();
    let mut first = FakeWire::ordinary();
    let first_output =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut first).unwrap();
    let controller_id = first_output.controller_instance_id.unwrap();

    let mut second = FakeWire::ordinary();
    let output = execute_with_wire(
        invocation(
            &temp,
            Command::PaneDescribe,
            pane_describe_input(&controller_id, "sf_1", 1),
        ),
        &mut second,
    )
    .unwrap();
    assert_eq!(output.command, "pane-describe");
    assert_eq!(
        output.controller_instance_id.as_deref(),
        Some(controller_id.as_str())
    );
    assert_eq!(second.operations, vec!["pair.request", "panes.list"]);
    let pair = &second.payloads[0].1;
    assert_eq!(pair["controllerInstanceId"], controller_id);
    assert_eq!(pair["surfaceId"], "sf_1");
    let (op, request) = &second.payloads[1];
    assert_eq!(op, "panes.list");
    assert_eq!(request, &json!({ "surfaceId": "sf_1" }));
    assert_eq!(output.result["surfaceId"], "sf_1");
    assert_eq!(output.result["paneId"], 1);
    assert_eq!(output.result["paneLineageId"], "pl_1");
    assert_eq!(output.result["currentTarget"]["targetEpoch"], 3);
    assert_eq!(output.result["targetEpoch"], 3);
}

#[test]
fn pane_describe_rejects_malformed_success_envelopes_and_retires_connection() {
    let temp = TempDir::new().unwrap();
    let mut initialize = FakeWire::ordinary();
    let controller_id =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initialize)
            .unwrap()
            .controller_instance_id
            .unwrap();
    let input = pane_describe_input(&controller_id, "sf_1", 1);

    let faults = [
        (
            ResponseEnvelopeFault::MissingSuccess,
            "missing_response_success:{}",
        ),
        (
            ResponseEnvelopeFault::WrongOperation,
            "response_operation_mismatch:{}",
        ),
        (
            ResponseEnvelopeFault::UnsupportedVersion,
            "unsupported_response_version:{}",
        ),
    ];
    for (fault, error_template) in faults {
        let mut pair = FakeWire::ordinary();
        pair.pair_response_fault = Some(fault);
        let error = execute_with_wire(
            invocation(&temp, Command::PaneDescribe, input.clone()),
            &mut pair,
        )
        .unwrap_err();
        let expected = error_template.replace("{}", "pair.request");
        assert!(matches!(error, CliError::Protocol(message) if message == expected));
        assert_eq!(pair.operations, vec!["pair.request"]);
        assert_eq!(pair.close_count, 1);
    }

    for (fault, error_template) in faults {
        let mut panes = FakeWire::ordinary();
        panes.panes_list_response_fault = Some(fault);
        let error = execute_with_wire(
            invocation(&temp, Command::PaneDescribe, input.clone()),
            &mut panes,
        )
        .unwrap_err();
        let expected = error_template.replace("{}", "panes.list");
        assert!(matches!(error, CliError::Protocol(message) if message == expected));
        assert_eq!(panes.operations, vec!["pair.request", "panes.list"]);
        assert_eq!(panes.close_count, 1);
    }
}

#[test]
fn pane_describe_preserves_stale_target_and_never_invents_an_epoch() {
    let temp = TempDir::new().unwrap();
    let mut initialize = FakeWire::ordinary();
    let controller_id =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initialize)
            .unwrap()
            .controller_instance_id
            .unwrap();

    let mut stale = FakeWire::ordinary();
    stale.panes_list_payload = json!({
        "panes": [{
            "paneId": 1,
            "paneLineageId": "pl_1",
            "currentTarget": {
                "currentState": "stale",
                "paneLineageId": "pl_1",
                "targetEpoch": 9,
                "targetId": "tg_stale",
                "targetKind": "browser_url"
            }
        }]
    });
    let stale_output = execute_with_wire(
        invocation(
            &temp,
            Command::PaneDescribe,
            pane_describe_input(&controller_id, "sf_1", 1),
        ),
        &mut stale,
    )
    .unwrap();
    assert_eq!(
        stale_output.result["currentTarget"]["currentState"],
        "stale"
    );
    assert_eq!(stale_output.result["targetEpoch"], 9);
    assert_eq!(
        stale
            .operations
            .iter()
            .filter(|op| *op == "panes.list")
            .count(),
        1
    );

    for current_target_is_null in [false, true] {
        let mut absent = FakeWire::ordinary();
        let mut pane = json!({ "paneId": 1, "paneLineageId": "pl_1" });
        if current_target_is_null {
            pane["currentTarget"] = Value::Null;
        }
        absent.panes_list_payload = json!({ "panes": [pane] });
        let absent_output = execute_with_wire(
            invocation(
                &temp,
                Command::PaneDescribe,
                pane_describe_input(&controller_id, "sf_1", 1),
            ),
            &mut absent,
        )
        .unwrap();
        assert_eq!(absent_output.result["currentTarget"], Value::Null);
        assert_eq!(absent_output.result["targetEpoch"], Value::Null);
        assert_eq!(
            absent
                .operations
                .iter()
                .filter(|op| *op == "panes.list")
                .count(),
            1
        );
    }
}

#[test]
fn pane_describe_rejects_missing_lineage_and_missing_target_epoch() {
    let temp = TempDir::new().unwrap();
    let mut initialize = FakeWire::ordinary();
    let controller_id =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initialize)
            .unwrap()
            .controller_instance_id
            .unwrap();

    let mut missing_lineage = FakeWire::ordinary();
    missing_lineage.panes_list_payload = json!({ "panes": [{ "paneId": 1 }] });
    let error = execute_with_wire(
        invocation(
            &temp,
            Command::PaneDescribe,
            pane_describe_input(&controller_id, "sf_1", 1),
        ),
        &mut missing_lineage,
    )
    .unwrap_err();
    assert!(
        matches!(error, CliError::Protocol(message) if message == "invalid_panes_list_pane_lineage")
    );

    let mut missing_epoch = FakeWire::ordinary();
    missing_epoch.panes_list_payload = json!({ "panes": [{
        "paneId": 1,
        "paneLineageId": "pl_1",
        "currentTarget": {
            "currentState": "current",
            "paneLineageId": "pl_1",
            "targetId": "tg_1",
            "targetKind": "browser_url"
        }
    }] });
    let error = execute_with_wire(
        invocation(
            &temp,
            Command::PaneDescribe,
            pane_describe_input(&controller_id, "sf_1", 1),
        ),
        &mut missing_epoch,
    )
    .unwrap_err();
    assert!(
        matches!(error, CliError::Protocol(message) if message == "invalid_panes_list_target_epoch")
    );
}

#[test]
fn pane_describe_rejects_ambiguous_or_inconsistent_pane_identity() {
    let temp = TempDir::new().unwrap();
    let mut initialize = FakeWire::ordinary();
    let controller_id =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initialize)
            .unwrap()
            .controller_instance_id
            .unwrap();

    let malformed = [
        (
            json!({
                "panes": [
                    { "paneId": 1, "paneLineageId": "pl_1" },
                    { "paneId": 1, "paneLineageId": "pl_2" }
                ]
            }),
            "duplicate_panes_list_pane_id",
        ),
        (
            json!({
                "panes": [{
                    "paneId": 1,
                    "paneLineageId": "pl_1",
                    "currentTarget": {
                        "currentState": "current",
                        "paneLineageId": "pl_other",
                        "targetEpoch": 1,
                        "targetId": "tg_1",
                        "targetKind": "browser_url"
                    }
                }]
            }),
            "panes_list_target_lineage_mismatch",
        ),
        (json!({ "panes": [] }), "pane_not_found"),
    ];

    for (payload, expected_error) in malformed {
        let mut wire = FakeWire::ordinary();
        wire.panes_list_payload = payload;
        let error = execute_with_wire(
            invocation(
                &temp,
                Command::PaneDescribe,
                pane_describe_input(&controller_id, "sf_1", 1),
            ),
            &mut wire,
        )
        .unwrap_err();
        assert!(matches!(error, CliError::Protocol(message) if message == expected_error));
        assert_eq!(wire.operations, vec!["pair.request", "panes.list"]);
        assert_eq!(wire.close_count, 1);
    }
}

#[test]
fn pane_describe_refuses_duplicate_live_controller_wrong_surface_unpaired_and_disconnects() {
    let temp = TempDir::new().unwrap();
    let mut initialize = FakeWire::ordinary();
    let controller_id =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initialize)
            .unwrap()
            .controller_instance_id
            .unwrap();
    let pane_input = pane_describe_input(&controller_id, "sf_1", 1);

    let mut duplicate = FakeWire::ordinary();
    duplicate.pair_rejection = Some(Envelope {
        id: Some("rq_duplicate".into()),
        op: "pair.request".into(),
        payload: Some(json!({})),
        envelope_type: "response".into(),
        v: 1,
        ok: Some(false),
        error: Some(json!({ "code": "duplicate_controller_instance" })),
        sent_at: None,
    });
    let error = execute_with_wire(
        invocation(&temp, Command::PaneDescribe, pane_input.clone()),
        &mut duplicate,
    )
    .unwrap_err();
    assert!(
        matches!(error, CliError::Rejected { ref operation, ref code } if operation == "pair.request" && code == "duplicate_controller_instance")
    );
    assert_eq!(duplicate.operations, vec!["pair.request"]);

    let mut wrong_surface = FakeWire::ordinary();
    wrong_surface.pair_surface_id_override = Some(json!("sf_other"));
    let error = execute_with_wire(
        invocation(&temp, Command::PaneDescribe, pane_input.clone()),
        &mut wrong_surface,
    )
    .unwrap_err();
    assert!(matches!(error, CliError::Protocol(message) if message == "surface_pair_mismatch"));
    assert_eq!(wrong_surface.operations, vec!["pair.request"]);

    let mut wrong_controller = FakeWire::ordinary();
    wrong_controller.pair_controller_instance_id_override = Some(json!("ctl_other"));
    let error = execute_with_wire(
        invocation(&temp, Command::PaneDescribe, pane_input.clone()),
        &mut wrong_controller,
    )
    .unwrap_err();
    assert!(
        matches!(error, CliError::Protocol(message) if message == "controller_identity_mismatch")
    );
    assert_eq!(wrong_controller.operations, vec!["pair.request"]);

    let mut unpaired = FakeWire::ordinary();
    unpaired.panes_list_rejection = Some("not_paired".into());
    let error = execute_with_wire(
        invocation(&temp, Command::PaneDescribe, pane_input.clone()),
        &mut unpaired,
    )
    .unwrap_err();
    assert!(
        matches!(error, CliError::Rejected { ref operation, ref code } if operation == "panes.list" && code == "not_paired")
    );
    assert_eq!(unpaired.operations, vec!["pair.request", "panes.list"]);
    assert_eq!(unpaired.close_count, 1);

    let mut disconnected = FakeWire::ordinary();
    disconnected.fail_after_send_on = Some("panes.list".into());
    let error = execute_with_wire(
        invocation(&temp, Command::PaneDescribe, pane_input),
        &mut disconnected,
    )
    .unwrap_err();
    assert!(matches!(error, CliError::Wire(_)));
    assert_eq!(disconnected.operations, vec!["pair.request", "panes.list"]);
    assert_eq!(disconnected.close_count, 1);
}

#[test]
fn cli_targeted_mutation_discovers_before_pair_on_one_bounded_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut socket = accept(stream).unwrap();
        let (list, list_request_bytes) = read_request_with_bytes(&mut socket);
        assert_eq!(list["op"], "surfaces.list");
        assert!(list["payload"].as_object().unwrap().is_empty());
        let list_bytes = send_response_with_bytes(
            &mut socket,
            list["id"].as_str().unwrap(),
            "surfaces.list.result",
            json!({ "surfaces": [{ "surfaceId": "sf_aleph" }] }),
        );

        let (pair, pair_request_bytes) = read_request_with_bytes(&mut socket);
        assert_eq!(pair["op"], "pair.request");
        assert_eq!(pair["payload"]["surfaceId"], "sf_aleph");
        assert_eq!(pair["payload"]["controllerProductName"], "Clawline");
        assert!(pair["payload"]["protocolFeatures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|feature| feature == "control_projection_v1"));
        let mut surface_pair =
            control_pair_payload(pair["payload"]["controllerInstanceId"].clone());
        surface_pair["surfaceId"] = json!("sf_aleph");
        surface_pair["state"] = json!({ "panes": (64..=70).map(|pane_id| json!({
            "paneId": pane_id,
            "paneLabel": pane_id - 63,
            "currentContentId": format!("content-{pane_id}"),
            "currentRevision": 12,
            "contentType": "markdown"
        })).collect::<Vec<_>>() });
        surface_pair["scopeSummaries"] = json!((64..=70)
            .map(|pane_id| json!({
                "cursor": { "cursor": 0, "gap": null, "gapGeneration": 0 },
                "firstRetainedSequence": 1,
                "lastRetainedSequence": 0,
                "scopeId": format!("pane:sf_aleph:{pane_id}")
            }))
            .collect::<Vec<_>>());
        let pair_bytes = send_response_with_bytes(
            &mut socket,
            pair["id"].as_str().unwrap(),
            "pair.request",
            surface_pair,
        );
        let (sync, sync_request_bytes) = read_request_with_bytes(&mut socket);
        assert_eq!(sync["op"], "consumable.sync");
        assert_eq!(sync["payload"]["scopeIds"], json!(["pane:sf_aleph:70"]));
        let sync_response_bytes = send_response_with_bytes(
            &mut socket,
            sync["id"].as_str().unwrap(),
            "consumable.sync",
            json!({
                "snapshots": [{
                    "cursor": { "cursor": 0, "gap": null, "gapGeneration": 0 },
                    "firstRetainedSequence": 1,
                    "lastRetainedSequence": 0,
                    "records": [],
                    "scopeId": "pane:sf_aleph:70",
                    "version": 1
                }]
            }),
        );
        let (push, push_request_bytes) = read_request_with_bytes(&mut socket);
        assert_eq!(push["op"], "content.set");
        assert_eq!(push["payload"]["surfaceId"], "sf_aleph");
        assert_eq!(push["payload"]["paneId"], 70);
        assert_eq!(push["payload"]["friendlyChatName"], "OpenClaw");
        let push_id = push["id"].as_str().unwrap();
        let push_bytes = send_response_with_bytes(
            &mut socket,
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
        let (ack, ack_request_bytes) = read_request_with_bytes(&mut socket);
        assert_eq!(ack["op"], "operation.receipt.ack");
        assert_eq!(ack["payload"]["requestId"], push_id);
        let ack_bytes = send_response_with_bytes(
            &mut socket,
            ack["id"].as_str().unwrap(),
            "operation.receipt.ack.result",
            json!({ "accepted": true }),
        );
        let (release, release_request_bytes) = read_request_with_bytes(&mut socket);
        assert_eq!(release["op"], "operation.receipt.ack");
        assert_eq!(release["payload"]["requestId"], push_id);
        assert_eq!(release["payload"]["release"], true);
        let release_bytes = send_response_with_bytes(
            &mut socket,
            release["id"].as_str().unwrap(),
            "operation.receipt.ack.result",
            json!({ "accepted": true, "release": true }),
        );
        expect_orderly_close(&mut socket);

        let frame_sizes = [
            ("pre-pair surfaces.list request", list_request_bytes),
            ("pre-pair surfaces.list response", list_bytes),
            ("scoped pair.request", pair_request_bytes),
            ("scoped pair.response", pair_bytes),
            ("target consumable.sync request", sync_request_bytes),
            ("target consumable.sync response", sync_response_bytes),
            ("content.set request", push_request_bytes),
            ("content.set response", push_bytes),
            ("receipt ack request", ack_request_bytes),
            ("receipt ack response", ack_bytes),
            ("receipt release request", release_request_bytes),
            ("receipt release response", release_bytes),
        ];
        assert!(frame_sizes
            .iter()
            .all(|(_, bytes)| *bytes < WEBSOCKET_FRAME_LIMIT_BYTES));
        frame_sizes
    });

    let temp = TempDir::new().unwrap();
    let mut call = invocation(
        &temp,
        Command::Push,
        json!({
            "surfaceId": "sf_aleph",
            "paneId": 70,
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
    let frame_sizes = server.join().unwrap();
    eprintln!("loopback targeted mutation WebSocket payload sizes: {frame_sizes:?}");
    assert!(
        frame_sizes.iter().map(|(_, bytes)| *bytes).max().unwrap() < WEBSOCKET_FRAME_LIMIT_BYTES
    );
}

#[test]
fn control_pair_summaries_preserve_unread_records_and_pending_ack_intents() {
    let temp = TempDir::new().unwrap();
    let retained = json!({
        "bytes": 32,
        "payload": { "value": "retained-before-compact-pair" },
        "recordClass": "annotation_frame",
        "recordId": "unread-1",
        "sequence": 1
    });
    let mut initial = FakeWire::ordinary();
    initial.scopes = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 1,
        "records": [retained.clone()],
        "scopeId": "pane:sf_aleph:70",
        "version": 1
    })];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initial).unwrap();

    let mut read = invocation(
        &temp,
        Command::Read,
        json!({ "scopeId": "pane:sf_aleph:70" }),
    );
    read.endpoint = None;
    read.product_label = None;
    let read_result = execute(read).unwrap();
    assert_eq!(read_result.result["cacheStatus"], "current");
    assert_eq!(read_result.result["acknowledgement"]["cursor"], 2);

    let mut control = FakeWire::ordinary();
    control.pair_projection = Some("control".into());
    control.pair_protocol_features = Some(vec![
        "surf-ace.lockless-multi-controller.v1".into(),
        "control_projection_v1".into(),
    ]);
    control.scope_summaries = vec![
        json!({
            "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
            "firstRetainedSequence": 1,
            "lastRetainedSequence": 2,
            "scopeId": "pane:sf_aleph:70"
        }),
        json!({
            "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
            "firstRetainedSequence": 1,
            "lastRetainedSequence": 1,
            "scopeId": "pane:sf_aleph:69"
        }),
    ];
    let unread = json!({
        "bytes": 37,
        "payload": { "value": "still-unread-after-summary" },
        "recordClass": "content",
        "recordId": "unread-2",
        "sequence": 2
    });
    control.sync_snapshots = vec![json!({
        "cursor": { "cursor": 2, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 2,
        "records": [unread.clone()],
        "scopeId": "pane:sf_aleph:70",
        "version": 1
    })];
    let output = execute_with_wire(
        invocation(
            &temp,
            Command::Push,
            json!({
                "surfaceId": "sf_aleph",
                "paneId": 70,
                "contentId": "content-new",
                "contentType": "markdown",
                "content": { "markdown": "targeted" }
            }),
        ),
        &mut control,
    )
    .unwrap();
    assert_eq!(
        output.result["payload"]["operationReceipt"]["commitSequence"],
        7
    );
    let acknowledgement_requests = control
        .payloads
        .iter()
        .filter(|(operation, _)| operation == "consumable.ack")
        .map(|(_, payload)| payload)
        .collect::<Vec<_>>();
    assert_eq!(acknowledgement_requests.len(), 1);
    assert_eq!(acknowledgement_requests[0]["scopeId"], "pane:sf_aleph:70");
    assert_eq!(acknowledgement_requests[0]["cursor"], 2);
    let requested_sync_scopes = control
        .payloads
        .iter()
        .find(|(operation, _)| operation == "consumable.sync")
        .unwrap();
    assert_eq!(
        requested_sync_scopes.1["scopeIds"],
        json!(["pane:sf_aleph:70"])
    );

    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(
        persisted["acknowledgementOutbox"].as_array().unwrap().len(),
        0
    );
    assert_eq!(
        persisted["scopes"]["pane:sf_aleph:70"]["records"],
        json!([unread])
    );
    assert_eq!(
        persisted["scopes"]["pane:sf_aleph:70"]["lastRetainedSequence"],
        2
    );
    assert_eq!(persisted["scopes"]["pane:sf_aleph:70"]["clientCursor"], 2);
    assert_eq!(
        persisted["scopes"]["pane:sf_aleph:70"]["synchronized"],
        false
    );
    assert!(persisted["scopes"].get("pane:sf_aleph:69").is_none());
    assert!(!control
        .payloads
        .iter()
        .filter(|(operation, _)| operation == "consumable.ack")
        .any(|(_, payload)| payload["scopeId"] == "pane:sf_aleph:69"));

    let mut resumed = FakeWire::ordinary();
    resumed.pair_projection = Some("control".into());
    resumed.pair_protocol_features = Some(vec![
        "surf-ace.lockless-multi-controller.v1".into(),
        "control_projection_v1".into(),
    ]);
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut resumed).unwrap();
    let resume_scopes = &resumed
        .payloads
        .iter()
        .find(|(operation, _)| operation == "pair.request")
        .unwrap()
        .1["resume"]["scopes"];
    assert_eq!(resume_scopes["pane:sf_aleph:70"]["cursor"], 2);
    assert!(resume_scopes.get("pane:sf_aleph:69").is_none());
}

#[test]
fn control_scope_summaries_do_not_invent_or_drop_zero_resume_cursors() {
    let temp = TempDir::new().unwrap();
    let mut initial = FakeWire::ordinary();
    initial.scopes = vec![json!({
        "cursor": { "cursor": 0, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 0,
        "records": [],
        "scopeId": "pane:sf_aleph:70",
        "version": 1
    })];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initial).unwrap();

    let mut control = FakeWire::ordinary();
    control.pair_projection = Some("control".into());
    control.pair_protocol_features = Some(vec![
        "surf-ace.lockless-multi-controller.v1".into(),
        "control_projection_v1".into(),
    ]);
    control.scope_summaries = vec![
        json!({
            "cursor": { "cursor": 0, "gap": null, "gapGeneration": 0 },
            "firstRetainedSequence": 1,
            "lastRetainedSequence": 0,
            "scopeId": "pane:sf_aleph:70"
        }),
        json!({
            "cursor": { "cursor": 0, "gap": null, "gapGeneration": 0 },
            "firstRetainedSequence": 1,
            "lastRetainedSequence": 0,
            "scopeId": "pane:sf_aleph:69"
        }),
    ];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut control).unwrap();

    let pair_payload = &control
        .payloads
        .iter()
        .find(|(operation, _)| operation == "pair.request")
        .unwrap()
        .1;
    assert_eq!(
        pair_payload["resume"]["scopes"]["pane:sf_aleph:70"]["cursor"],
        0
    );
    assert!(pair_payload["resume"]["scopes"]
        .get("pane:sf_aleph:69")
        .is_none());

    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["scopes"]["pane:sf_aleph:70"]["clientCursor"], 0);
    assert!(persisted["scopes"].get("pane:sf_aleph:69").is_none());
}

#[test]
fn control_projection_requires_server_capability_and_well_formed_scope_metadata() {
    let temp = TempDir::new().unwrap();
    let mut unadvertised = FakeWire::ordinary();
    unadvertised.pair_projection = Some("control".into());
    let error = execute_with_wire(
        invocation(&temp, Command::List, json!({})),
        &mut unadvertised,
    )
    .unwrap_err();
    assert!(
        matches!(error, CliError::Protocol(code) if code == "control_projection_not_advertised")
    );
    assert_eq!(unadvertised.close_count, 1);
    assert_eq!(unadvertised.operations, vec!["pair.request"]);

    let mut malformed = FakeWire::ordinary();
    malformed.pair_projection = Some("control".into());
    malformed.pair_protocol_features = Some(vec!["control_projection_v1".into()]);
    malformed.scope_summaries = vec![json!({ "scopeId": "pane:sf_1:1" })];
    let error =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut malformed).unwrap_err();
    assert!(
        matches!(error, CliError::Protocol(code) if code == "invalid_control_projection_scope_summary")
    );
    assert_eq!(malformed.close_count, 1);
    assert_eq!(malformed.operations, vec!["pair.request"]);

    let mut material_in_control = FakeWire::ordinary();
    material_in_control.pair_projection = Some("control".into());
    material_in_control.pair_protocol_features = Some(vec!["control_projection_v1".into()]);
    material_in_control.scopes = vec![json!({
        "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 1,
        "records": [],
        "scopeId": "pane:sf_1:1",
        "version": 1
    })];
    let error = execute_with_wire(
        invocation(&temp, Command::List, json!({})),
        &mut material_in_control,
    )
    .unwrap_err();
    assert!(
        matches!(error, CliError::Protocol(code) if code == "control_projection_contains_material_scopes")
    );
    assert_eq!(material_in_control.close_count, 1);
}

#[test]
fn control_projection_rejects_invalid_target_sync_before_mutation() {
    let temp = TempDir::new().unwrap();
    let mut wire = FakeWire::ordinary();
    wire.pair_projection = Some("control".into());
    wire.pair_protocol_features = Some(vec!["control_projection_v1".into()]);
    wire.scope_summaries = vec![json!({
        "cursor": { "cursor": 0, "gap": null, "gapGeneration": 0 },
        "firstRetainedSequence": 1,
        "lastRetainedSequence": 0,
        "scopeId": "pane:sf_1:1"
    })];
    wire.sync_response_fault = Some(ResponseEnvelopeFault::WrongOperation);

    let error = execute_with_wire(
        invocation(
            &temp,
            Command::Push,
            json!({
                "surfaceId": "sf_1",
                "paneId": 1,
                "contentId": "c_1",
                "contentType": "markdown",
                "content": { "markdown": "must not be sent" }
            }),
        ),
        &mut wire,
    )
    .unwrap_err();
    assert!(
        matches!(error, CliError::Protocol(code) if code == "response_operation_mismatch:consumable.sync")
    );
    assert_eq!(wire.operations, vec!["pair.request", "consumable.sync"]);
    assert!(!wire
        .operations
        .iter()
        .any(|operation| operation == "content.set"));
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["unresolved"], json!({}));
    assert!(persisted["scopes"].get("pane:sf_1:1").is_none());
}

#[test]
fn control_projection_keeps_explicit_capture_read_available() {
    let temp = TempDir::new().unwrap();
    let mut wire = FakeWire::ordinary();
    wire.pair_projection = Some("control".into());
    wire.pair_protocol_features = Some(vec![
        "surf-ace.lockless-multi-controller.v1".into(),
        "control_projection_v1".into(),
    ]);
    wire.snapshot_payload = Some(json!({
        "image": "cG5n",
        "snapshotId": "sn_control"
    }));

    let output = execute_with_wire(
        invocation(
            &temp,
            Command::CapturePane,
            json!({ "includeDrawings": true, "paneId": 70, "surfaceId": "sf_aleph" }),
        ),
        &mut wire,
    )
    .unwrap();

    assert_eq!(output.result["payload"]["image"], "cG5n");
    assert_eq!(wire.operations, vec!["pair.request", "snapshot.get"]);
    assert_eq!(
        wire.payloads
            .iter()
            .find(|(operation, _)| operation == "snapshot.get")
            .unwrap()
            .1["includeDrawings"],
        true
    );
}

#[test]
fn control_pair_resume_still_reconciles_uncertain_mutation_receipts() {
    let temp = TempDir::new().unwrap();
    let mut first = FakeWire::ordinary();
    first.fail_after_send_on = Some("content.set".into());
    let error = execute_with_wire(
        invocation(
            &temp,
            Command::Push,
            json!({
                "surfaceId": "sf_aleph",
                "paneId": 70,
                "contentId": "content-unknown",
                "contentType": "markdown",
                "content": { "markdown": "outcome unknown" }
            }),
        ),
        &mut first,
    )
    .unwrap_err();
    assert!(matches!(error, CliError::OutcomeUnknown { .. }));

    let state: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    let request_id = state["unresolved"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap();
    let mut resumed = FakeWire::ordinary();
    resumed.pair_projection = Some("control".into());
    resumed.pair_protocol_features = Some(vec![
        "surf-ace.lockless-multi-controller.v1".into(),
        "control_projection_v1".into(),
    ]);
    resumed.resolutions = vec![json!({
        "outcome": "not_committed",
        "requestId": request_id
    })];

    let result =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut resumed).unwrap();
    assert_eq!(result.reconciliations[0]["outcome"], "not_committed");
    assert_eq!(
        resumed
            .payloads
            .iter()
            .find(|(operation, _)| operation == "pair.request")
            .unwrap()
            .1["resume"]["unresolvedRequestIds"],
        json!([request_id])
    );
    assert!(!resumed
        .operations
        .iter()
        .any(|operation| operation == "operation.receipt.sync"));
    let repaired: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(repaired["unresolved"], json!({}));
}

#[test]
fn cli_seven_pane_listing_uses_compact_control_projection_under_frame_cap() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut measured = Vec::new();
        let panes = (64..=70)
            .map(|pane_id| {
                json!({
                    "paneId": pane_id,
                    "paneLabel": pane_id - 63,
                    "currentContentId": format!("content-{pane_id}"),
                    "currentRevision": 12,
                    "contentType": "markdown"
                })
            })
            .collect::<Vec<_>>();

        let (stream, _) = listener.accept().unwrap();
        let mut list_socket = accept(stream).unwrap();
        let (pair, request_bytes) = read_request_with_bytes(&mut list_socket);
        measured.push(("list pair.request", request_bytes));
        assert_eq!(pair["op"], "pair.request");
        assert!(pair["payload"].get("surfaceId").is_none());
        assert!(pair["payload"]["protocolFeatures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|feature| feature == "control_projection_v1"));
        let mut paired = control_pair_payload(pair["payload"]["controllerInstanceId"].clone());
        paired["state"] = json!({ "panes": panes });
        measured.push((
            "list pair.response",
            send_response_with_bytes(
                &mut list_socket,
                pair["id"].as_str().unwrap(),
                "pair.request",
                paired,
            ),
        ));
        let (list, request_bytes) = read_request_with_bytes(&mut list_socket);
        measured.push(("surfaces.list request", request_bytes));
        assert_eq!(list["op"], "surfaces.list");
        measured.push((
            "surfaces.list response",
            send_response_with_bytes(
                &mut list_socket,
                list["id"].as_str().unwrap(),
                "surfaces.list.result",
                json!({
                    "surfaces": [{
                        "surfaceId": "sf_aleph",
                        "name": "Aleph",
                        "windowLabel": "g",
                        "viewport": { "width": 4096, "height": 4096, "scale": 1 }
                    }]
                }),
            ),
        ));
        expect_orderly_close(&mut list_socket);

        let (stream, _) = listener.accept().unwrap();
        let mut pane_socket = accept(stream).unwrap();
        let (pair, request_bytes) = read_request_with_bytes(&mut pane_socket);
        measured.push(("pane describe pair.request", request_bytes));
        assert_eq!(pair["op"], "pair.request");
        assert_eq!(pair["payload"]["surfaceId"], "sf_aleph");
        assert!(pair["payload"]["protocolFeatures"]
            .as_array()
            .unwrap()
            .iter()
            .any(|feature| feature == "control_projection_v1"));
        let mut paired = control_pair_payload(pair["payload"]["controllerInstanceId"].clone());
        paired["surfaceId"] = json!("sf_aleph");
        paired["state"] = json!({ "panes": (64..=70).map(|pane_id| json!({
            "paneId": pane_id,
            "paneLabel": pane_id - 63,
            "currentContentId": format!("content-{pane_id}"),
            "currentRevision": 12,
            "contentType": "markdown"
        })).collect::<Vec<_>>() });
        measured.push((
            "pane describe pair.response",
            send_response_with_bytes(
                &mut pane_socket,
                pair["id"].as_str().unwrap(),
                "pair.request",
                paired,
            ),
        ));
        let (panes_list, request_bytes) = read_request_with_bytes(&mut pane_socket);
        measured.push(("panes.list request", request_bytes));
        assert_eq!(panes_list["op"], "panes.list");
        measured.push((
            "panes.list response",
            send_response_with_bytes(
                &mut pane_socket,
                panes_list["id"].as_str().unwrap(),
                "panes.list",
                json!({
                    "panes": (64..=70).map(|pane_id| json!({
                        "paneId": pane_id,
                        "paneLineageId": format!("pl_{pane_id}"),
                        "currentTarget": null
                    })).collect::<Vec<_>>()
                }),
            ),
        ));
        expect_orderly_close(&mut pane_socket);

        assert!(measured
            .iter()
            .all(|(_, bytes)| *bytes < WEBSOCKET_FRAME_LIMIT_BYTES));
        measured
    });

    let temp = TempDir::new().unwrap();
    let mut list = invocation(&temp, Command::List, json!({}));
    list.endpoint = Some(endpoint.clone());
    let listed = execute(list).unwrap();
    let controller_id = listed.controller_instance_id.clone().unwrap();
    assert_eq!(
        listed.result["payload"]["surfaces"][0]["surfaceId"],
        "sf_aleph"
    );

    let mut describe = invocation(
        &temp,
        Command::PaneDescribe,
        pane_describe_input(&controller_id, "sf_aleph", 70),
    );
    describe.endpoint = Some(endpoint);
    let pane = execute(describe).unwrap();
    assert_eq!(pane.result["paneId"], 70);
    assert_eq!(pane.result["paneLineageId"], "pl_70");
    assert_eq!(pane.result["currentTarget"], Value::Null);
    assert_eq!(pane.result["targetEpoch"], Value::Null);

    let frame_sizes = server.join().unwrap();
    eprintln!("loopback seven-pane listing WebSocket payload sizes: {frame_sizes:?}");
    assert!(
        frame_sizes.iter().map(|(_, bytes)| *bytes).max().unwrap() < WEBSOCKET_FRAME_LIMIT_BYTES
    );
}

#[test]
fn pane_describe_production_path_uses_one_sequential_same_root_surface_pair() {
    let temp = TempDir::new().unwrap();
    let mut initialize = FakeWire::ordinary();
    let controller_id =
        execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initialize)
            .unwrap()
            .controller_instance_id
            .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let server_controller_id = controller_id.clone();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut socket = accept(stream).unwrap();
        let pair = read_request(&mut socket);
        assert_eq!(pair["op"], "pair.request");
        assert_eq!(
            pair["payload"]["controllerInstanceId"],
            server_controller_id
        );
        assert_eq!(pair["payload"]["surfaceId"], "sf_1");
        assert_eq!(pair["payload"]["controllerProductName"], "Clawline");
        let mut paired = pair_payload(pair["payload"]["controllerInstanceId"].clone());
        paired["surfaceId"] = json!("sf_1");
        send_response(
            &mut socket,
            pair["id"].as_str().unwrap(),
            "pair.request",
            paired,
        );

        let panes = read_request(&mut socket);
        assert_eq!(panes["op"], "panes.list");
        assert_eq!(panes["payload"], json!({ "surfaceId": "sf_1" }));
        send_response(
            &mut socket,
            panes["id"].as_str().unwrap(),
            "panes.list",
            json!({
                "panes": [{
                    "paneId": 1,
                    "paneLineageId": "pl_1",
                    "currentTarget": null
                }]
            }),
        );
        expect_orderly_close(&mut socket);
    });

    let mut call = invocation(
        &temp,
        Command::PaneDescribe,
        pane_describe_input(&controller_id, "sf_1", 1),
    );
    call.endpoint = Some(endpoint);
    let output = execute(call).unwrap();
    assert_eq!(
        output.controller_instance_id.as_deref(),
        Some(controller_id.as_str())
    );
    assert_eq!(output.result["surfaceId"], "sf_1");
    assert_eq!(output.result["paneId"], 1);
    assert_eq!(output.result["paneLineageId"], "pl_1");
    assert_eq!(output.result["currentTarget"], Value::Null);
    assert_eq!(output.result["targetEpoch"], Value::Null);
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
fn native_cli_read_returns_current_content_when_unread_delta_is_empty() {
    let temp = TempDir::new().unwrap();
    let scope_id = "pane:sf_ipad:1";
    let current_content = json!({
        "bytes": 510,
        "payload": {
            "annotations": { "drawingData": "", "strokesById": {} },
            "content": { "markdown": "# CURRENT IPAD PANE" },
            "contentId": "current-ipad-pane-1",
            "contentType": "markdown",
            "historyEntryId": "he_current",
            "paneId": 1,
            "provenance": {
                "controllerProductName": "Surf Ace regression",
                "friendlyChatName": "Current-state probe"
            },
            "revision": 19,
            "surfaceId": "sf_ipad"
        },
        "recordClass": "content",
        "recordId": "record:45",
        "sequence": 45
    });
    fs::write(
        temp.path().join("controller-state.json"),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "controllerInstanceId": "ctl_current_read_regression",
            "scopes": {
                scope_id: {
                    "clientCursor": 46,
                    "projectedCursor": 46,
                    "firstRetainedSequence": 1,
                    "lastRetainedSequence": 45,
                    "records": [current_content],
                    "gap": null,
                    "synchronized": true,
                    "synchronizationCutoff": "cutoff-current"
                }
            },
            "acknowledgementOutbox": [],
            "unresolved": {},
            "resumeMetadata": {}
        }))
        .unwrap(),
    )
    .unwrap();

    let output = ProcessCommand::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args([
            "--state-root",
            temp.path().to_str().unwrap(),
            "read",
            "--input-json",
            &serde_json::to_string(&json!({ "scopeId": scope_id })).unwrap(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["result"]["cacheStatus"], "current");
    assert_eq!(result["result"]["consumableLoss"], Value::Null);
    assert_eq!(result["result"]["records"], json!([]));
    assert_eq!(result["result"]["currentContentRecord"], current_content);

    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["scopes"][scope_id]["projectedCursor"], 46);
    assert_eq!(persisted["scopes"][scope_id]["clientCursor"], 46);
}

#[test]
fn current_content_survives_acknowledgement_scroll_only_resume_and_process_restart() {
    let temp = TempDir::new().unwrap();
    let scope_id = "pane:sf_1:1";
    let current_content = pane_content_record("sf_1", 1, 1, Some("content-visible"), None);
    let mut initial = FakeWire::ordinary();
    initial.scopes = vec![pane_scope_snapshot(
        scope_id,
        1,
        vec![current_content.clone(), pane_scroll_record("sf_1", 1, 2)],
    )];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initial).unwrap();

    let before_restart = native_cli_read(&temp, scope_id);
    assert_eq!(
        before_restart["result"]["currentContentRecord"],
        current_content
    );
    assert_eq!(
        before_restart["result"]["records"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(before_restart["result"]["acknowledgement"]["cursor"], 3);

    // Re-open the same durable state root as a fresh CLI process. The server has
    // accepted the cursor, so its resumed snapshot contains only a newer scroll.
    let mut resumed = FakeWire::ordinary();
    resumed.scopes = vec![pane_scope_snapshot(
        scope_id,
        3,
        vec![pane_scroll_record("sf_1", 1, 3)],
    )];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut resumed).unwrap();
    let ack = resumed
        .payloads
        .iter()
        .find(|(operation, _)| operation == "consumable.ack")
        .map(|(_, payload)| payload)
        .expect("the prior read cursor is acknowledged after resume");
    assert_eq!(ack["cursor"], 3);

    let after_restart = native_cli_read(&temp, scope_id);
    assert_eq!(after_restart["result"]["cacheStatus"], "current");
    assert_eq!(after_restart["result"]["consumableLoss"], Value::Null);
    assert_eq!(
        after_restart["result"]["records"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        after_restart["result"]["records"][0]["recordClass"],
        "scroll"
    );
    assert_eq!(
        after_restart["result"]["currentContentRecord"],
        current_content
    );
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["scopes"][scope_id]["clientCursor"], 3);
    assert_eq!(persisted["scopes"][scope_id]["projectedCursor"], 4);
}

#[test]
fn current_content_tracks_replacement_and_clear_without_promoting_scroll() {
    let temp = TempDir::new().unwrap();
    let scope_id = "pane:sf_1:1";
    let original = pane_content_record("sf_1", 1, 1, Some("original"), None);
    let mut initial = FakeWire::ordinary();
    initial.scopes = vec![pane_scope_snapshot(scope_id, 1, vec![original])];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initial).unwrap();

    let replacement = pane_content_record("sf_1", 1, 2, Some("replacement"), None);
    let mut replacement_wire = FakeWire::ordinary();
    replacement_wire.scopes = vec![pane_scope_snapshot(scope_id, 2, vec![replacement.clone()])];
    execute_with_wire(
        invocation(&temp, Command::List, json!({})),
        &mut replacement_wire,
    )
    .unwrap();
    let replaced = native_cli_read(&temp, scope_id);
    assert_eq!(replaced["result"]["currentContentRecord"], replacement);

    let scroll = pane_scroll_record("sf_1", 1, 3);
    let mut scroll_wire = FakeWire::ordinary();
    scroll_wire.scopes = vec![pane_scope_snapshot(scope_id, 3, vec![scroll])];
    execute_with_wire(
        invocation(&temp, Command::List, json!({})),
        &mut scroll_wire,
    )
    .unwrap();
    assert_eq!(
        native_cli_read(&temp, scope_id)["result"]["currentContentRecord"],
        replacement,
        "a later scroll record is not a content replacement"
    );

    let cleared = pane_content_record("sf_1", 1, 4, None, Some("content.clear"));
    let mut clear_wire = FakeWire::ordinary();
    clear_wire.scopes = vec![pane_scope_snapshot(scope_id, 4, vec![cleared])];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut clear_wire).unwrap();
    assert_eq!(
        native_cli_read(&temp, scope_id)["result"]["currentContentRecord"],
        Value::Null,
        "an explicit clear invalidates the remembered current content"
    );
}

#[test]
fn current_content_isolated_by_pane_and_client_state_root() {
    let first_client = TempDir::new().unwrap();
    let pane_one = "pane:sf_shared:1";
    let pane_two = "pane:sf_shared:2";
    let pane_one_content = pane_content_record("sf_shared", 1, 1, Some("client-a-pane-1"), None);
    let pane_two_content = pane_content_record("sf_shared", 2, 1, Some("client-a-pane-2"), None);
    let mut first_wire = FakeWire::ordinary();
    first_wire.scopes = vec![
        pane_scope_snapshot(pane_one, 1, vec![pane_one_content.clone()]),
        pane_scope_snapshot(pane_two, 1, vec![pane_two_content.clone()]),
    ];
    execute_with_wire(
        invocation(&first_client, Command::List, json!({})),
        &mut first_wire,
    )
    .unwrap();
    assert_eq!(
        native_cli_read(&first_client, pane_one)["result"]["currentContentRecord"],
        pane_one_content
    );
    assert_eq!(
        native_cli_read(&first_client, pane_two)["result"]["currentContentRecord"],
        pane_two_content
    );

    let second_client = TempDir::new().unwrap();
    let second_client_content =
        pane_content_record("sf_shared", 1, 1, Some("client-b-pane-1"), None);
    let mut second_wire = FakeWire::ordinary();
    second_wire.scopes = vec![pane_scope_snapshot(
        pane_one,
        1,
        vec![second_client_content.clone()],
    )];
    execute_with_wire(
        invocation(&second_client, Command::List, json!({})),
        &mut second_wire,
    )
    .unwrap();
    assert_eq!(
        native_cli_read(&second_client, pane_one)["result"]["currentContentRecord"],
        second_client_content
    );
    assert_ne!(
        first_wire.payloads[0].1["controllerInstanceId"],
        second_wire.payloads[0].1["controllerInstanceId"],
        "each state root keeps an independent controller identity"
    );
}

#[test]
fn current_content_is_withheld_after_loss_or_wrong_surface_record() {
    let temp = TempDir::new().unwrap();
    let scope_id = "pane:sf_1:1";
    let current_content = pane_content_record("sf_1", 1, 1, Some("known-current"), None);
    let mut initial = FakeWire::ordinary();
    initial.scopes = vec![pane_scope_snapshot(scope_id, 1, vec![current_content])];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initial).unwrap();
    assert_eq!(
        native_cli_read(&temp, scope_id)["result"]["currentContentRecord"]["payload"]["contentId"],
        "known-current"
    );

    let mut lost = FakeWire::ordinary();
    lost.scopes = vec![pane_scope_snapshot(scope_id, 2, vec![])];
    lost.response_events.insert(
        "surfaces.list".into(),
        vec![event(
            "event.consumable_overflow",
            json!({
                "firstRetainedSequence": 3,
                "gap": {
                    "cause": "source_overflow",
                    "generation": 1,
                    "lastLostSequence": 2,
                    "lossExtent": "exact",
                    "recordClasses": ["content"]
                },
                "lastRetainedSequence": 2,
                "scopeId": scope_id
            }),
        )],
    );
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut lost).unwrap();
    let after_loss = native_cli_read(&temp, scope_id);
    assert_eq!(after_loss["result"]["consumableLoss"]["generation"], 1);
    assert_eq!(after_loss["result"]["currentContentRecord"], Value::Null);

    let wrong_surface_root = TempDir::new().unwrap();
    let wrong_surface = pane_content_record("sf_other", 1, 1, Some("wrong-surface"), None);
    let mut wrong_wire = FakeWire::ordinary();
    wrong_wire.scopes = vec![pane_scope_snapshot(scope_id, 1, vec![wrong_surface])];
    execute_with_wire(
        invocation(&wrong_surface_root, Command::List, json!({})),
        &mut wrong_wire,
    )
    .unwrap();
    assert_eq!(
        native_cli_read(&wrong_surface_root, scope_id)["result"]["currentContentRecord"],
        Value::Null,
        "content from another surface cannot become current for this scope"
    );
}

#[test]
fn successful_pane_close_discards_that_scope_current_content() {
    let temp = TempDir::new().unwrap();
    let scope_id = "pane:sf_1:2";
    let current_content = pane_content_record("sf_1", 2, 1, Some("to-be-closed"), None);
    let mut initial = FakeWire::ordinary();
    initial.scopes = vec![pane_scope_snapshot(scope_id, 1, vec![current_content])];
    execute_with_wire(invocation(&temp, Command::List, json!({})), &mut initial).unwrap();
    assert_eq!(
        native_cli_read(&temp, scope_id)["result"]["currentContentRecord"]["payload"]["contentId"],
        "to-be-closed"
    );

    let mut close = FakeWire::ordinary();
    close.scopes = vec![pane_scope_snapshot(scope_id, 2, vec![])];
    execute_with_wire(
        invocation(
            &temp,
            Command::TopologyIntent,
            json!({
                "action": "close",
                "expectedTopologyRevision": 4,
                "paneId": 2,
                "surfaceId": "sf_1"
            }),
        ),
        &mut close,
    )
    .unwrap();
    assert!(close.operations.contains(&"pane.close".into()));
    assert_eq!(
        native_cli_read(&temp, scope_id)["result"]["cacheStatus"],
        "unsynchronized"
    );
    assert_eq!(
        native_cli_read(&temp, scope_id)["result"]["currentContentRecord"],
        Value::Null
    );
    let persisted: Value =
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap();
    assert!(persisted["scopes"].get(scope_id).is_none());
}

#[test]
fn native_cli_read_ignores_malformed_current_content_sequences() {
    let temp = TempDir::new().unwrap();
    let mixed_scope = "pane:sf_ipad:1";
    let invalid_scope = "pane:sf_ipad:2";
    let current_content = json!({
        "bytes": 128,
        "payload": {
            "contentId": "valid-current",
            "paneId": 1,
            "surfaceId": "sf_ipad"
        },
        "recordClass": "content",
        "recordId": "record:7",
        "sequence": 7
    });
    fs::write(
        temp.path().join("controller-state.json"),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "controllerInstanceId": "ctl_malformed_current_regression",
            "scopes": {
                mixed_scope: {
                    "clientCursor": 100,
                    "projectedCursor": 100,
                    "firstRetainedSequence": 1,
                    "lastRetainedSequence": 99,
                    "records": [
                        { "recordClass": "content", "recordId": "missing-sequence" },
                        { "recordClass": "content", "recordId": "zero-sequence", "sequence": 0 },
                        { "recordClass": "content", "recordId": "string-sequence", "sequence": "9" },
                        { "recordClass": "tap", "recordId": "later-non-content", "sequence": 99 },
                        current_content
                    ],
                    "gap": null,
                    "synchronized": true,
                    "synchronizationCutoff": "cutoff-current"
                },
                invalid_scope: {
                    "clientCursor": 1,
                    "projectedCursor": 1,
                    "firstRetainedSequence": 0,
                    "lastRetainedSequence": 0,
                    "records": [
                        { "recordClass": "content", "recordId": "missing-sequence" },
                        { "recordClass": "content", "recordId": "zero-sequence", "sequence": 0 }
                    ],
                    "gap": null,
                    "synchronized": true,
                    "synchronizationCutoff": "cutoff-current"
                }
            },
            "acknowledgementOutbox": [],
            "unresolved": {},
            "resumeMetadata": {}
        }))
        .unwrap(),
    )
    .unwrap();

    let run_read = |scope_id: &str| {
        let output = ProcessCommand::new(env!("CARGO_BIN_EXE_surf-ace"))
            .args([
                "--state-root",
                temp.path().to_str().unwrap(),
                "read",
                "--input-json",
                &serde_json::to_string(&json!({ "scopeId": scope_id })).unwrap(),
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };

    let mixed = run_read(mixed_scope);
    assert_eq!(mixed["result"]["records"], json!([]));
    assert_eq!(mixed["result"]["currentContentRecord"], current_content);

    let invalid = run_read(invalid_scope);
    assert_eq!(invalid["result"]["records"], json!([]));
    assert_eq!(invalid["result"]["currentContentRecord"], Value::Null);
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
        assert_eq!(pair["payload"]["resume"]["pendingAcks"], json!([]));
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
    read_request_with_bytes(socket).0
}

fn read_request_with_bytes(
    socket: &mut tungstenite::WebSocket<std::net::TcpStream>,
) -> (Value, usize) {
    loop {
        match socket.read().unwrap() {
            Message::Text(text) => {
                let bytes = text.as_bytes().len();
                let envelope: Value = serde_json::from_str(&text).unwrap();
                assert_canonical_request_envelope(&envelope);
                return (envelope, bytes);
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
    let _ = send_response_with_bytes(socket, id, op, payload);
}

fn send_response_with_bytes(
    socket: &mut tungstenite::WebSocket<std::net::TcpStream>,
    id: &str,
    op: &str,
    payload: Value,
) -> usize {
    let encoded = serde_json::to_string(&json!({
        "id": id,
        "ok": true,
        "op": op,
        "payload": payload,
        "type": "response",
        "v": 1
    }))
    .unwrap();
    let byte_count = encoded.len();
    socket.send(Message::Text(encoded.into())).unwrap();
    byte_count
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

fn control_pair_payload(controller_instance_id: Value) -> Value {
    let mut payload = pair_payload(controller_instance_id);
    payload["capabilities"]["protocolFeatures"] = json!([
        "surf-ace.lockless-multi-controller.v1",
        "control_projection_v1"
    ]);
    payload["projection"] = json!("control");
    payload["scopeSummaries"] = json!([]);
    payload
}

#[test]
fn cross_endpoint_read_acknowledgements_wait_for_owning_client() {
    let temp = TempDir::new().unwrap();
    let scopes = ["pane:sf_client_a:1", "pane:sf_client_a:2"];
    let snapshot = |scope_id: &str| {
        json!({
            "cursor": { "cursor": 1, "gap": null, "gapGeneration": 0 },
            "firstRetainedSequence": 1,
            "lastRetainedSequence": 1,
            "records": [{ "bytes": 32, "payload": { "contentId": scope_id },
                "recordClass": "content", "recordId": scope_id, "sequence": 1 }],
            "scopeId": scope_id, "version": 1
        })
    };
    let mut a = FakeWire::ordinary();
    a.scopes = scopes.iter().map(|scope| snapshot(scope)).collect();
    let mut list_a = invocation(&temp, Command::List, json!({}));
    list_a.endpoint = Some("ws://client-a:43801/ws".into());
    let initial = execute_with_wire(list_a.clone(), &mut a).unwrap();
    for scope in scopes {
        let mut read = invocation(&temp, Command::Read, json!({ "scopeId": scope }));
        read.endpoint = None;
        read.product_label = None;
        let output = execute(read).unwrap();
        assert_eq!(
            output.controller_instance_id,
            initial.controller_instance_id
        );
        assert_eq!(output.result["acknowledgement"]["cursor"], 2);
    }
    let state = || -> Value {
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap()
    };
    let queued = state()["acknowledgementOutbox"].clone();
    assert_eq!(queued.as_array().unwrap().len(), 2);
    let mut b = FakeWire::ordinary();
    b.scopes = vec![snapshot("pane:sf_client_b:1")];
    let mut list_b = invocation(&temp, Command::List, json!({}));
    list_b.endpoint = Some("ws://client-b:34329/ws".into());
    let switched = execute_with_wire(list_b, &mut b).unwrap();
    assert_eq!(
        switched.controller_instance_id,
        initial.controller_instance_id
    );
    assert!(
        !b.operations.iter().any(|op| op == "consumable.ack"),
        "B must not receive explicit acknowledgements for A: {:?}",
        b.payloads
    );
    assert_eq!(state()["acknowledgementOutbox"], queued);
    let mut resumed_a = FakeWire::ordinary();
    resumed_a.scopes = a.scopes;
    execute_with_wire(list_a, &mut resumed_a).unwrap();
    let sent: Vec<_> = resumed_a
        .payloads
        .iter()
        .filter(|(op, _)| op == "consumable.ack")
        .map(|(_, payload)| payload.clone())
        .collect();
    assert_eq!(
        sent,
        vec![
            json!({"scopeId": scopes[0], "cursor": 2}),
            json!({"scopeId": scopes[1], "cursor": 2})
        ]
    );
    assert_eq!(state()["acknowledgementOutbox"], json!([]));
}

#[test]
fn production_empty_scope_lifecycle_routes_pending_acks_after_listing() {
    let a_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let b_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let a_endpoint = format!("ws://{}", a_listener.local_addr().unwrap());
    let b_endpoint = format!("ws://{}", b_listener.local_addr().unwrap());
    let listed = |surface: &str| {
        json!({"surfaces":[{"surfaceId":surface,
        "topology":{"panes":[{"paneId":1},{"paneId":2}]}}]})
    };
    let a_server = thread::spawn(move || {
        // Discovery stays pre-pair on the same socket; the later lifecycle revisit
        // routes durable acknowledgements only after the listing identifies client A.
        for stage in 0..2 {
            let (stream, _) = a_listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut socket = accept(stream).unwrap();
            if stage == 1 {
                let pair = read_request(&mut socket);
                assert_eq!(pair["op"], "pair.request");
                assert!(pair["payload"].get("surfaceId").is_none());
                let response = pair_payload(pair["payload"]["controllerInstanceId"].clone());
                assert_eq!(response["scopes"], json!([]));
                send_response(
                    &mut socket,
                    pair["id"].as_str().unwrap(),
                    "pair.response",
                    response,
                );
                let list = read_request(&mut socket);
                assert_eq!(list["op"], "surfaces.list");
                send_response(
                    &mut socket,
                    list["id"].as_str().unwrap(),
                    "surfaces.list.result",
                    listed("sf_a"),
                );
                for pane in [1, 2] {
                    let ack = read_request(&mut socket);
                    assert_eq!(ack["op"], "consumable.ack");
                    assert_eq!(
                        ack["payload"],
                        json!({"scopeId":format!("pane:sf_a:{pane}"),"cursor":2})
                    );
                    send_response(
                        &mut socket,
                        ack["id"].as_str().unwrap(),
                        "consumable.ack.result",
                        json!({"accepted":true}),
                    );
                }
            } else {
                let list = read_request(&mut socket);
                assert_eq!(list["op"], "surfaces.list");
                send_response(
                    &mut socket,
                    list["id"].as_str().unwrap(),
                    "surfaces.list.result",
                    listed("sf_a"),
                );
                let pair = read_request(&mut socket);
                assert_eq!(pair["op"], "pair.request");
                assert_eq!(pair["payload"]["surfaceId"], "sf_a");
                let mut response = pair_payload(pair["payload"]["controllerInstanceId"].clone());
                response["surfaceId"] = json!("sf_a");
                response["scopes"] = json!([1, 2].map(|pane| json!({
                    "scopeId":format!("pane:sf_a:{pane}"),"version":1,
                    "cursor":{"cursor":1,"gap":null,"gapGeneration":0},
                    "firstRetainedSequence":1,"lastRetainedSequence":1,
                    "records":[{"bytes":32,"payload":{"contentId":format!("a-{pane}")},
                        "recordClass":"content","recordId":format!("a-{pane}"),"sequence":1}]
                })));
                send_response(
                    &mut socket,
                    pair["id"].as_str().unwrap(),
                    "pair.response",
                    response,
                );
                let operation = read_request(&mut socket);
                assert_eq!(operation["op"], "snapshot.get");
                assert_eq!(
                    operation["payload"].get("includeImage"),
                    None,
                    "capture-pane has no image suppression option"
                );
                send_response(
                    &mut socket,
                    operation["id"].as_str().unwrap(),
                    "snapshot.result",
                    json!({"snapshotId":"sn_a", "image":"cG5n"}),
                );
            }
            expect_orderly_close(&mut socket);
        }
    });
    let b_server = thread::spawn(move || {
        let (stream, _) = b_listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut socket = accept(stream).unwrap();
        let pair = read_request(&mut socket);
        assert_eq!(
            pair["payload"]["resume"]["pendingAcks"],
            json!([]),
            "Lifecycle B must not receive A acknowledgements in pair.resume"
        );
        let response = pair_payload(pair["payload"]["controllerInstanceId"].clone());
        assert_eq!(response["scopes"], json!([]));
        send_response(
            &mut socket,
            pair["id"].as_str().unwrap(),
            "pair.response",
            response,
        );
        let list = read_request(&mut socket);
        assert_eq!(list["op"], "surfaces.list");
        send_response(
            &mut socket,
            list["id"].as_str().unwrap(),
            "surfaces.list.result",
            listed("sf_b"),
        );
        // Any acknowledgement here belongs to A and is a test failure.
        assert!(matches!(socket.read().unwrap(), Message::Close(_)));
    });
    let temp = TempDir::new().unwrap();
    let mut capture = invocation(
        &temp,
        Command::CapturePane,
        json!({"surfaceId":"sf_a","paneId":1}),
    );
    capture.endpoint = Some(a_endpoint.clone());
    let initial = execute(capture).unwrap();
    assert_eq!(initial.result["payload"]["image"], "cG5n");
    for pane in [1, 2] {
        let mut read = invocation(
            &temp,
            Command::Read,
            json!({"scopeId":format!("pane:sf_a:{pane}")}),
        );
        read.endpoint = None;
        read.product_label = None;
        assert_eq!(
            execute(read).unwrap().result["acknowledgement"]["cursor"],
            2
        );
    }
    let state = || -> Value {
        serde_json::from_slice(&fs::read(temp.path().join("controller-state.json")).unwrap())
            .unwrap()
    };
    let queued = state()["acknowledgementOutbox"].clone();
    let mut b = invocation(&temp, Command::List, json!({}));
    b.endpoint = Some(b_endpoint);
    assert_eq!(
        execute(b).unwrap().controller_instance_id,
        initial.controller_instance_id
    );
    b_server.join().unwrap();
    assert_eq!(state()["acknowledgementOutbox"], queued);
    let mut a = invocation(&temp, Command::List, json!({}));
    a.endpoint = Some(a_endpoint);
    assert_eq!(
        execute(a).unwrap().controller_instance_id,
        initial.controller_instance_id
    );
    a_server.join().unwrap();
    assert_eq!(state()["acknowledgementOutbox"], json!([]));
}
