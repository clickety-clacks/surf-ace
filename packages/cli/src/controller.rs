use crate::command::Invocation;
use crate::state::{
    AcknowledgementIntent, CorrelationPhase, LockedStateRoot, ScopeProjection, StateError,
    UnresolvedCorrelation,
};
use crate::wire::{DirectWire, Envelope, WebSocketWire, WireFailure, WireResponse};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

const LOCKLESS_CAPABILITY: &str = "surf-ace.lockless-multi-controller.v1";
const RECEIPT_CAPABILITY: &str = "operation-receipt-replay-v1";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliOutput {
    pub ok: bool,
    pub command: String,
    pub controller_instance_id: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reconciliations: Vec<Value>,
    pub result: Value,
}

pub fn execute(invocation: Invocation) -> Result<CliOutput, CliError> {
    invocation
        .command
        .validate(&invocation.input)
        .map_err(CliError::Input)?;
    if invocation.command.is_local() {
        return execute_local(invocation);
    }
    let endpoint = invocation
        .endpoint
        .clone()
        .ok_or_else(|| CliError::Input("missing_endpoint".into()))?;
    let mut root =
        LockedStateRoot::open(&invocation.state_root, invocation.projection_capacity_bytes)?;
    let surface_id = operation_surface_id(&invocation)?;
    if let Some(surface_id) = surface_id.as_deref() {
        let mut lifecycle = WebSocketWire::connect_direct(&endpoint).map_err(CliError::Wire)?;
        discover_surface(&invocation, &mut root, &mut lifecycle, surface_id)?;
        lifecycle.close().map_err(CliError::Wire)?;
    }
    let mut operation_wire = WebSocketWire::connect_direct(&endpoint).map_err(CliError::Wire)?;
    execute_locked(
        invocation,
        &mut root,
        &mut operation_wire,
        surface_id.as_deref(),
    )
}

pub fn execute_with_wire(
    invocation: Invocation,
    wire: &mut dyn DirectWire,
) -> Result<CliOutput, CliError> {
    invocation
        .command
        .validate(&invocation.input)
        .map_err(CliError::Input)?;
    if invocation.command.is_local() {
        return Err(CliError::Input("read_must_use_local_path".into()));
    }
    let surface_id = operation_surface_id(&invocation)?;
    let mut root =
        LockedStateRoot::open(&invocation.state_root, invocation.projection_capacity_bytes)?;
    execute_locked(invocation, &mut root, wire, surface_id.as_deref())
}

fn execute_locked(
    invocation: Invocation,
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    surface_id: Option<&str>,
) -> Result<CliOutput, CliError> {
    let product_label = invocation
        .product_label
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Input("missing_product_label".into()))?;
    let controller_id = root.state().controller_instance_id.clone();
    let mut pair_payload = json!({
        "controllerInstanceId": controller_id,
        "controllerProductName": product_label,
        "projectionCapacityBytes": invocation.projection_capacity_bytes,
        "protocolFeatures": [LOCKLESS_CAPABILITY, RECEIPT_CAPABILITY],
        "protocolVersion": 1,
        "resume": resume_payload(root.state(), true),
    });
    if let Some(surface_id) = surface_id {
        pair_payload
            .as_object_mut()
            .expect("pair payload object")
            .insert("surfaceId".into(), Value::String(surface_id.into()));
    }
    let pair = request_without_correlation(wire, "pair.request", pair_payload)?;
    let pair_payload = successful_payload(&pair.response, "pair.request")?;
    if pair_payload.get("mode").and_then(Value::as_str) != Some("lockless") {
        return Err(CliError::Protocol(
            "lockless_capability_not_admitted".into(),
        ));
    }
    if pair_payload
        .get("controllerInstanceId")
        .and_then(Value::as_str)
        != Some(&controller_id)
    {
        return Err(CliError::Protocol("controller_identity_mismatch".into()));
    }
    if pair_payload.get("surfaceId").unwrap_or(&Value::Null)
        != surface_id.map(Value::from).as_ref().unwrap_or(&Value::Null)
    {
        return Err(CliError::Protocol("surface_pair_mismatch".into()));
    }
    verify_receipt_limits(pair_payload)?;
    apply_synchronization(root, pair_payload, &pair.events)?;
    finalize_acknowledged_receipts(root, wire)?;

    flush_acknowledgements(root, wire)?;
    let resolutions = pair_payload
        .get("receiptResolutions")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::Protocol("invalid_pair_receipt_resolutions".into()))?;
    let mut reconciliations = resolve_uncertain(root, wire, resolutions)?;

    let has_pending = root
        .state()
        .unresolved
        .values()
        .any(|correlation| correlation.phase != CorrelationPhase::ReceiptPersisted);
    if has_pending && invocation.command.is_mutation() {
        mark_all_unsynchronized(root)?;
        let _ = wire.close();
        return Err(CliError::StillPending);
    }

    let op = invocation
        .command
        .wire_operation(&invocation.input)
        .map_err(CliError::Input)?;
    let payload = invocation
        .command
        .wire_payload(invocation.input.clone())
        .map_err(CliError::Input)?;
    let result = if invocation.command.is_mutation() {
        perform_mutation(root, wire, op, payload)?
    } else {
        let response = request_without_correlation(wire, op, payload)?;
        apply_wire_events(root, &response)?;
        terminal_envelope(&response.response)
    };
    mark_all_synchronized(root, pair_payload.get("synchronizationCutoff"))?;
    wire.close().map_err(CliError::Wire)?;
    reconciliations.sort_by(|left, right| {
        left.get("requestId")
            .and_then(Value::as_str)
            .cmp(&right.get("requestId").and_then(Value::as_str))
    });
    Ok(CliOutput {
        ok: true,
        command: invocation.command.name().into(),
        controller_instance_id: controller_id,
        reconciliations,
        result,
    })
}

fn execute_local(invocation: Invocation) -> Result<CliOutput, CliError> {
    if invocation.endpoint.is_some() {
        return Err(CliError::Input("read_rejects_endpoint".into()));
    }
    let scope_id = invocation
        .input
        .get("scopeId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Input("invalid_input:scopeId".into()))?
        .to_owned();
    let mut root =
        LockedStateRoot::open(&invocation.state_root, invocation.projection_capacity_bytes)?;
    let controller_id = root.state().controller_instance_id.clone();
    let result = root.mutate(|state| {
        let Some(scope) = state.scopes.get_mut(&scope_id) else {
            return json!({
                "acknowledgement": null,
                "cacheStatus": "unsynchronized",
                "consumableLoss": null,
                "records": [],
                "scopeId": scope_id,
                "synchronizationCutoff": null,
            });
        };
        let records = scope
            .records
            .iter()
            .filter(|record| {
                record.get("sequence").and_then(Value::as_u64).unwrap_or(0)
                    >= scope.projected_cursor
            })
            .cloned()
            .collect::<Vec<_>>();
        let cursor = records
            .last()
            .and_then(|record| record.get("sequence"))
            .and_then(Value::as_u64)
            .map_or(scope.projected_cursor, |sequence| sequence + 1);
        let gap_generation = scope
            .gap
            .as_ref()
            .and_then(|gap| gap.get("generation"))
            .and_then(Value::as_u64);
        let acknowledgement = if cursor > scope.client_cursor || gap_generation.is_some() {
            let intent = AcknowledgementIntent {
                scope_id: scope_id.clone(),
                cursor,
                gap_generation,
                idempotency_key: format!("{}:{}:{}", scope_id, cursor, gap_generation.unwrap_or(0)),
            };
            state
                .acknowledgement_outbox
                .retain(|candidate| candidate.scope_id != scope_id);
            state.acknowledgement_outbox.push(intent.clone());
            Some(serde_json::to_value(intent).expect("serializable acknowledgement"))
        } else {
            None
        };
        scope.projected_cursor = cursor;
        json!({
            "acknowledgement": acknowledgement,
            "cacheStatus": if scope.synchronized { "current" } else { "unsynchronized" },
            "consumableLoss": scope.gap,
            "records": records,
            "scopeId": scope_id,
            "synchronizationCutoff": scope.synchronization_cutoff,
        })
    })?;
    Ok(CliOutput {
        ok: true,
        command: invocation.command.name().into(),
        controller_instance_id: controller_id,
        reconciliations: vec![],
        result,
    })
}

fn operation_surface_id(invocation: &Invocation) -> Result<Option<String>, CliError> {
    let lifecycle_operation = invocation.command == crate::command::Command::List
        || (invocation.command == crate::command::Command::SurfaceIntent
            && matches!(
                invocation.input.get("action").and_then(Value::as_str),
                Some("open" | "restore")
            ));
    if lifecycle_operation {
        return Ok(None);
    }
    invocation
        .input
        .get("surfaceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| CliError::Input("invalid_input:surfaceId".into()))
}

fn discover_surface(
    invocation: &Invocation,
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    surface_id: &str,
) -> Result<(), CliError> {
    let product_label = invocation
        .product_label
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Input("missing_product_label".into()))?;
    let controller_id = root.state().controller_instance_id.clone();
    let pair = request_without_correlation(
        wire,
        "pair.request",
        json!({
            "controllerInstanceId": controller_id,
            "controllerProductName": product_label,
            "projectionCapacityBytes": invocation.projection_capacity_bytes,
            "protocolFeatures": [LOCKLESS_CAPABILITY, RECEIPT_CAPABILITY],
            "protocolVersion": 1,
            "resume": resume_payload(root.state(), false),
        }),
    )?;
    let payload = successful_payload(&pair.response, "pair.request")?;
    if payload.get("mode").and_then(Value::as_str) != Some("lockless")
        || payload.get("controllerInstanceId").and_then(Value::as_str) != Some(&controller_id)
    {
        return Err(CliError::Protocol("lifecycle_pair_mismatch".into()));
    }
    verify_receipt_limits(payload)?;
    apply_synchronization(root, payload, &pair.events)?;
    let listed = request_without_correlation(wire, "surfaces.list", json!({}))?;
    successful_payload(&listed.response, "surfaces.list")?;
    apply_wire_events(root, &listed)?;
    let listed_payload = successful_payload(&listed.response, "surfaces.list")?;
    let exists = listed_payload
        .get("surfaces")
        .and_then(Value::as_array)
        .is_some_and(|surfaces| {
            surfaces
                .iter()
                .any(|surface| surface.get("surfaceId").and_then(Value::as_str) == Some(surface_id))
        });
    if !exists {
        return Err(CliError::Input(format!("unknown_surface:{surface_id}")));
    }
    Ok(())
}

fn perform_mutation(
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    op: &str,
    payload: Value,
) -> Result<Value, CliError> {
    let request_id = format!("rq_{}", Uuid::new_v4().simple());
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&payload)?));
    root.mutate(|state| {
        state.unresolved.insert(
            request_id.clone(),
            UnresolvedCorrelation {
                operation: op.into(),
                payload_digest: digest,
                phase: CorrelationPhase::Prepared,
                terminal_response: None,
            },
        );
    })?;
    let mut sent = || {
        root.mutate(|state| {
            state.unresolved.get_mut(&request_id).unwrap().phase = CorrelationPhase::Sent;
        })
        .map_err(|error| error.to_string())
    };
    let response = match wire.request(&request_id, op, payload, &mut sent) {
        Ok(response) => response,
        Err(WireFailure::BeforeSend { code }) => {
            root.mutate(|state| {
                state.unresolved.remove(&request_id);
            })?;
            return Err(CliError::Wire(WireFailure::BeforeSend { code }));
        }
        Err(WireFailure::AfterSend { code }) => {
            mark_all_unsynchronized(root)?;
            return Err(CliError::OutcomeUnknown {
                request_id,
                cause: code,
            });
        }
    };
    apply_wire_events(root, &response)?;
    let terminal = terminal_envelope(&response.response);
    let precommit_error = response
        .response
        .error
        .as_ref()
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str);
    if response.response.ok == Some(false)
        && (precommit_error == Some("receipt_capacity")
            || (op == "target.apply"
                && matches!(
                    precommit_error,
                    Some("surface_state_capacity" | "invalid_payload" | "unsupported_operation")
                )))
    {
        root.mutate(|state| {
            state.unresolved.remove(&request_id);
        })?;
        return Ok(terminal);
    }
    if response.response.ok == Some(false) {
        return resolve_committed_rejection(root, wire, &request_id, &terminal);
    }
    require_operation_receipt(&terminal, &request_id)?;
    if op == "target.apply" {
        validate_target_apply_accepted(&terminal, &request_id)?;
    }
    root.mutate(|state| {
        let correlation = state.unresolved.get_mut(&request_id).unwrap();
        correlation.phase = CorrelationPhase::ReceiptPersisted;
        correlation.terminal_response = Some(terminal.clone());
    })?;
    acknowledge_receipt(root, wire, &request_id)?;
    Ok(terminal)
}

fn resolve_uncertain(
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    resolutions: &[Value],
) -> Result<Vec<Value>, CliError> {
    let unresolved_ids = root.state().unresolved.keys().cloned().collect::<Vec<_>>();
    if unresolved_ids.is_empty() {
        return Ok(vec![]);
    }
    let mut output = vec![];
    for resolution in resolutions {
        let request_id = resolution
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError::Protocol("invalid_receipt_resolution:requestId".into()))?
            .to_owned();
        if !root.state().unresolved.contains_key(&request_id) {
            return Err(CliError::Protocol("unknown_receipt_resolution".into()));
        }
        let outcome = resolution
            .get("outcome")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError::Protocol("invalid_receipt_resolution:outcome".into()))?;
        match outcome {
            "resolved_success" | "resolved_failure" => {
                let terminal = resolution
                    .get("terminalResponse")
                    .cloned()
                    .ok_or_else(|| CliError::Protocol("missing_terminal_response".into()))?;
                require_replayed_receipt(resolution, &terminal, &request_id)?;
                root.mutate(|state| {
                    let correlation = state.unresolved.get_mut(&request_id).unwrap();
                    correlation.phase = CorrelationPhase::ReceiptPersisted;
                    correlation.terminal_response = Some(terminal);
                })?;
                acknowledge_receipt(root, wire, &request_id)?;
            }
            "not_committed" => {
                root.mutate(|state| {
                    state.unresolved.remove(&request_id);
                })?;
            }
            "still_pending" => {}
            "receipt_unavailable" => {
                if resolution.get("cause").and_then(Value::as_str) != Some("controller_reclaimed") {
                    return Err(CliError::Protocol(
                        "invalid_receipt_unavailable_cause".into(),
                    ));
                }
                root.mutate(|state| {
                    state.unresolved.remove(&request_id);
                })?;
            }
            _ => {
                return Err(CliError::Protocol(
                    "invalid_receipt_resolution:outcome".into(),
                ))
            }
        }
        output.push(resolution.clone());
    }
    if output.len() != unresolved_ids.len() {
        return Err(CliError::Protocol("incomplete_receipt_sync".into()));
    }
    Ok(output)
}

fn resolve_committed_rejection(
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    request_id: &str,
    terminal: &Value,
) -> Result<Value, CliError> {
    let response = request_without_correlation(
        wire,
        "operation.receipt.sync",
        json!({ "requestIds": [request_id] }),
    )?;
    let payload = successful_payload(&response.response, "operation.receipt.sync")?;
    apply_wire_events(root, &response)?;
    let resolutions = payload
        .get("resolutions")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::Protocol("invalid_receipt_sync".into()))?;
    if resolutions.len() != 1
        || resolutions[0].get("requestId").and_then(Value::as_str) != Some(request_id)
        || resolutions[0].get("outcome").and_then(Value::as_str) != Some("resolved_failure")
        || resolutions[0].get("terminalResponse") != Some(terminal)
    {
        return Err(CliError::Protocol(
            "committed_rejection_receipt_mismatch".into(),
        ));
    }
    let operation_receipt = resolutions[0]
        .get("operationReceipt")
        .cloned()
        .ok_or_else(|| CliError::Protocol("missing_operation_receipt".into()))?;
    resolve_uncertain(root, wire, resolutions)?;
    let mut returned = terminal.clone();
    returned
        .as_object_mut()
        .ok_or_else(|| CliError::Protocol("invalid_terminal_response".into()))?
        .insert("operationReceipt".into(), operation_receipt);
    Ok(returned)
}

fn finalize_acknowledged_receipts(
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
) -> Result<(), CliError> {
    let request_ids = root
        .state()
        .unresolved
        .iter()
        .filter(|(_, correlation)| correlation.phase == CorrelationPhase::ReceiptAcknowledged)
        .map(|(request_id, _)| request_id.clone())
        .collect::<Vec<_>>();
    for request_id in request_ids {
        release_receipt(root, wire, &request_id)?;
    }
    Ok(())
}

fn accepted_receipt_ack(response: &WireResponse) -> Result<(), CliError> {
    let payload = successful_payload(&response.response, "operation.receipt.ack")?;
    if payload.get("accepted").and_then(Value::as_bool) != Some(true) {
        return Err(CliError::Protocol("receipt_ack_not_accepted".into()));
    }
    Ok(())
}

fn release_receipt(
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    request_id: &str,
) -> Result<(), CliError> {
    let response = request_without_correlation(
        wire,
        "operation.receipt.ack",
        json!({ "release": true, "requestId": request_id }),
    )?;
    accepted_receipt_ack(&response)?;
    apply_wire_events(root, &response)?;
    root.mutate(|state| {
        state.unresolved.remove(request_id);
    })?;
    Ok(())
}

fn acknowledge_receipt(
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    request_id: &str,
) -> Result<(), CliError> {
    let response = request_without_correlation(
        wire,
        "operation.receipt.ack",
        json!({ "requestId": request_id }),
    )?;
    accepted_receipt_ack(&response)?;
    root.mutate(|state| {
        state.unresolved.get_mut(request_id).unwrap().phase = CorrelationPhase::ReceiptAcknowledged;
    })?;
    apply_wire_events(root, &response)?;
    release_receipt(root, wire, request_id)
}

fn flush_acknowledgements(
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
) -> Result<(), CliError> {
    for intent in root.state().acknowledgement_outbox.clone() {
        let response = request_without_correlation(
            wire,
            "consumable.ack",
            acknowledgement_wire_payload(&intent),
        )?;
        successful_payload(&response.response, "consumable.ack")?;
        apply_wire_events(root, &response)?;
        root.mutate(|state| {
            state
                .acknowledgement_outbox
                .retain(|candidate| candidate.idempotency_key != intent.idempotency_key);
            if let Some(scope) = state.scopes.get_mut(&intent.scope_id) {
                scope.client_cursor = scope.client_cursor.max(intent.cursor);
                if intent.gap_generation.is_some()
                    && scope.gap.as_ref().and_then(|gap| gap.get("generation"))
                        == intent.gap_generation.map(Value::from).as_ref()
                {
                    scope.gap = None;
                }
                scope.records.retain(|record| {
                    record.get("sequence").and_then(Value::as_u64).unwrap_or(0)
                        >= scope.client_cursor
                });
            }
        })?;
    }
    Ok(())
}

fn request_without_correlation(
    wire: &mut dyn DirectWire,
    op: &str,
    payload: Value,
) -> Result<WireResponse, CliError> {
    let request_id = format!("rq_{}", Uuid::new_v4().simple());
    let mut sent = || Ok(());
    wire.request(&request_id, op, payload, &mut sent)
        .map_err(CliError::Wire)
}

fn apply_synchronization(
    root: &mut LockedStateRoot,
    pair_payload: &Map<String, Value>,
    events: &[Envelope],
) -> Result<(), CliError> {
    let result = (|| {
        if let Some(scopes) = pair_payload.get("scopes").and_then(Value::as_array) {
            for scope in scopes {
                apply_snapshot(root, scope)?;
            }
        }
        apply_events(root, events)
    })();
    if let Err(error) = result {
        mark_all_unsynchronized(root)?;
        return Err(error);
    }
    Ok(())
}

fn apply_events(root: &mut LockedStateRoot, events: &[Envelope]) -> Result<(), CliError> {
    for event in events {
        let payload = event.payload.as_ref().unwrap_or(&Value::Null);
        match event.op.as_str() {
            "event.lockless_scope_snapshot" => {
                apply_snapshot(root, payload.get("snapshot").unwrap_or(payload))?;
            }
            "event.lockless_consumable_delta" => apply_delta(root, payload)?,
            "event.consumable_overflow" => apply_gap(root, payload)?,
            "event.target_apply_result" => apply_target_result_event(root, payload)?,
            _ => {}
        }
    }
    Ok(())
}

fn apply_target_result_event(root: &mut LockedStateRoot, payload: &Value) -> Result<(), CliError> {
    validate_target_apply_result_event(payload)?;
    let object = payload
        .as_object()
        .ok_or_else(|| CliError::Protocol("invalid_target_apply_result_event".into()))?;
    let sequence = object
        .get("consumableSequence")
        .and_then(Value::as_u64)
        .ok_or_else(|| CliError::Protocol("invalid_target_apply_result_event".into()))?;
    let record_id = object
        .get("recordId")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Protocol("invalid_target_apply_result_event".into()))?;
    let surface_id = object
        .get("surfaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Protocol("invalid_target_apply_result_event".into()))?;
    let mut result = object.clone();
    result.shift_remove("consumableSequence");
    result.shift_remove("recordId");
    let result = Value::Object(result);
    let mut durable = Map::new();
    durable.insert("version".into(), Value::from(1));
    durable.insert("payload".into(), result.clone());
    durable.insert("recordClass".into(), Value::from("target_result"));
    durable.insert("recordId".into(), Value::from(record_id));
    durable.insert("sequence".into(), Value::from(sequence));
    let bytes = serde_json::to_vec(&Value::Object(durable))?.len() as u64;
    apply_delta(
        root,
        &json!({
            "records": [{
                "bytes": bytes,
                "payload": result,
                "recordClass": "target_result",
                "recordId": record_id,
                "sequence": sequence,
            }],
            "scopeId": format!("surface:{surface_id}"),
        }),
    )
}

fn apply_wire_events(root: &mut LockedStateRoot, response: &WireResponse) -> Result<(), CliError> {
    if let Err(error) = apply_events(root, &response.events) {
        mark_all_unsynchronized(root)?;
        return Err(error);
    }
    Ok(())
}

fn apply_snapshot(root: &mut LockedStateRoot, snapshot: &Value) -> Result<(), CliError> {
    let scope_id = snapshot
        .get("scopeId")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Protocol("invalid_scope_snapshot".into()))?
        .to_owned();
    let cursor = snapshot
        .get("cursor")
        .and_then(|cursor| cursor.get("cursor"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let projected = root
        .state()
        .scopes
        .get(&scope_id)
        .map_or(cursor, |scope| scope.projected_cursor.max(cursor));
    let records = snapshot
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for record in &records {
        validate_target_result_record(record)?;
    }
    let scope = ScopeProjection {
        client_cursor: cursor,
        projected_cursor: projected,
        first_retained_sequence: snapshot
            .get("firstRetainedSequence")
            .and_then(Value::as_u64)
            .unwrap_or(cursor),
        last_retained_sequence: snapshot
            .get("lastRetainedSequence")
            .and_then(Value::as_u64)
            .unwrap_or(cursor),
        records,
        gap: snapshot
            .get("cursor")
            .and_then(|cursor| cursor.get("gap"))
            .cloned(),
        synchronized: true,
        synchronization_cutoff: snapshot.get("synchronizationCutoff").cloned(),
    };
    root.mutate(|state| {
        state.scopes.insert(scope_id, scope);
    })?;
    Ok(())
}

fn apply_delta(root: &mut LockedStateRoot, payload: &Value) -> Result<(), CliError> {
    let scope_id = payload
        .get("scopeId")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Protocol("invalid_consumable_delta".into()))?
        .to_owned();
    let records = payload
        .get("records")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::Protocol("invalid_consumable_delta".into()))?
        .clone();
    for record in &records {
        validate_target_result_record(record)?;
    }
    root.mutate(|state| {
        let scope = state.scopes.get_mut(&scope_id).ok_or(())?;
        for record in records {
            let sequence = record.get("sequence").and_then(Value::as_u64).ok_or(())?;
            if sequence <= scope.last_retained_sequence {
                if scope.records.iter().any(|existing| existing == &record) {
                    continue;
                }
                return Err(());
            }
            if sequence != scope.last_retained_sequence + 1 {
                return Err(());
            }
            scope
                .records
                .retain(|retained| !record_is_superseded(retained, &record));
            scope.records.push(record);
            scope.last_retained_sequence = sequence;
        }
        Ok::<(), ()>(())
    })??;
    Ok(())
}

fn record_is_superseded(retained: &Value, incoming: &Value) -> bool {
    let retained_class = retained.get("recordClass").and_then(Value::as_str);
    let incoming_class = incoming.get("recordClass").and_then(Value::as_str);
    if matches!(
        incoming_class,
        Some("scroll" | "selection" | "page" | "playback" | "navigation")
    ) && retained_class == incoming_class
    {
        return true;
    }
    if incoming_class != Some("annotation_frame") || retained_class != incoming_class {
        return false;
    }
    let incoming_id = incoming.get("recordId").and_then(Value::as_str);
    let flush_id = incoming
        .get("payload")
        .and_then(|payload| payload.get("flushId"))
        .and_then(Value::as_str);
    let retained_id = retained.get("recordId").and_then(Value::as_str);
    retained_id == incoming_id || retained_id == flush_id
}

fn apply_gap(root: &mut LockedStateRoot, payload: &Value) -> Result<(), CliError> {
    let scope_id = payload
        .get("scopeId")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Protocol("invalid_consumable_gap".into()))?
        .to_owned();
    let gap = payload
        .get("gap")
        .cloned()
        .ok_or_else(|| CliError::Protocol("invalid_consumable_gap".into()))?;
    let first = payload
        .get("firstRetainedSequence")
        .and_then(Value::as_u64)
        .ok_or_else(|| CliError::Protocol("invalid_consumable_gap".into()))?;
    let last = payload
        .get("lastRetainedSequence")
        .and_then(Value::as_u64)
        .ok_or_else(|| CliError::Protocol("invalid_consumable_gap".into()))?;
    root.mutate(|state| {
        let scope = state.scopes.get_mut(&scope_id).ok_or(())?;
        scope.gap = Some(gap);
        scope.first_retained_sequence = first;
        scope.last_retained_sequence = scope.last_retained_sequence.max(last);
        scope
            .records
            .retain(|record| record.get("sequence").and_then(Value::as_u64).unwrap_or(0) >= first);
        Ok::<(), ()>(())
    })??;
    Ok(())
}

fn resume_payload(state: &crate::state::DurableState, include_unresolved: bool) -> Value {
    json!({
        "pendingAcks": state.acknowledgement_outbox.iter()
            .map(acknowledgement_wire_payload)
            .collect::<Vec<_>>(),
        "unresolvedRequestIds": if include_unresolved {
            state.unresolved.iter()
                .filter(|(_, correlation)| correlation.phase != CorrelationPhase::ReceiptAcknowledged)
                .map(|(request_id, _)| request_id)
                .collect::<Vec<_>>()
        } else {
            vec![]
        },
        "scopes": state.scopes.iter().map(|(id, scope)| (
            id.clone(),
            json!({
                "cursor": scope.client_cursor,
                "gapGeneration": scope.gap.as_ref()
                    .and_then(|gap| gap.get("generation"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            })
        )).collect::<BTreeMap<_, _>>(),
    })
}

fn acknowledgement_wire_payload(intent: &crate::state::AcknowledgementIntent) -> Value {
    let mut payload = json!({
        "cursor": intent.cursor,
        "scopeId": intent.scope_id,
    });
    if let Some(gap_generation) = intent.gap_generation {
        payload
            .as_object_mut()
            .expect("acknowledgement payload object")
            .insert("gapGeneration".into(), Value::from(gap_generation));
    }
    payload
}

fn verify_receipt_limits(payload: &Map<String, Value>) -> Result<(), CliError> {
    let limits = payload
        .get("limits")
        .and_then(Value::as_object)
        .ok_or_else(|| CliError::Protocol("missing_limits".into()))?;
    for key in [
        "maxPendingOperationReceiptsPerController",
        "maxPendingOperationReceiptBytesPerController",
    ] {
        if limits.get(key).and_then(Value::as_u64).unwrap_or(0) == 0 {
            return Err(CliError::Protocol(format!("missing_positive_limit:{key}")));
        }
    }
    Ok(())
}

fn require_operation_receipt(terminal: &Value, request_id: &str) -> Result<(), CliError> {
    if terminal.get("id").and_then(Value::as_str) != Some(request_id) {
        return Err(CliError::Protocol("terminal_response_id_mismatch".into()));
    }
    let payload = terminal
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| CliError::Protocol("missing_operation_receipt".into()))?;
    let receipt = payload
        .get("operationReceipt")
        .or_else(|| payload.get("receipt"))
        .and_then(Value::as_object)
        .ok_or_else(|| CliError::Protocol("missing_operation_receipt".into()))?;
    if receipt.get("requestId").and_then(Value::as_str) != Some(request_id) {
        return Err(CliError::Protocol("operation_receipt_mismatch".into()));
    }
    Ok(())
}

fn validate_target_apply_accepted(terminal: &Value, request_id: &str) -> Result<(), CliError> {
    let payload = terminal
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| CliError::Protocol("invalid_target_apply_accepted".into()))?;
    if payload.get("status").and_then(Value::as_str) != Some("intent_committed")
        || payload.get("operationRequestId").and_then(Value::as_str) != Some(request_id)
        || payload
            .get("targetRequestId")
            .and_then(Value::as_str)
            .is_none()
        || payload.get("surfaceId").and_then(Value::as_str).is_none()
        || payload.get("targetId").and_then(Value::as_str).is_none()
        || payload
            .get("targetEpoch")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
    {
        return Err(CliError::Protocol("invalid_target_apply_accepted".into()));
    }
    Ok(())
}

fn validate_target_apply_result_payload(payload: &Value) -> Result<(), CliError> {
    let object = payload
        .as_object()
        .ok_or_else(|| CliError::Protocol("invalid_target_apply_result".into()))?;
    let status = object.get("status").and_then(Value::as_str);
    if !matches!(status, Some("applied" | "failed"))
        || object
            .get("operationRequestId")
            .and_then(Value::as_str)
            .is_none()
        || object
            .get("targetRequestId")
            .and_then(Value::as_str)
            .is_none()
        || object.get("surfaceId").and_then(Value::as_str).is_none()
        || object.get("targetId").and_then(Value::as_str).is_none()
        || object
            .get("intentCommitSequence")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
        || object
            .get("targetEpoch")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
        || (object.get("errorCode").is_some()
            && object.get("errorCode").and_then(Value::as_str).is_none())
    {
        return Err(CliError::Protocol("invalid_target_apply_result".into()));
    }
    Ok(())
}

fn validate_target_apply_result_event(payload: &Value) -> Result<(), CliError> {
    validate_target_apply_result_payload(payload)?;
    if payload.get("recordId").and_then(Value::as_str).is_none()
        || payload
            .get("consumableSequence")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
    {
        return Err(CliError::Protocol(
            "invalid_target_apply_result_event".into(),
        ));
    }
    Ok(())
}

fn validate_target_result_record(record: &Value) -> Result<(), CliError> {
    if record.get("recordClass").and_then(Value::as_str) == Some("target_result") {
        validate_target_apply_result_payload(record.get("payload").unwrap_or(&Value::Null))?;
    }
    Ok(())
}

fn require_replayed_receipt(
    resolution: &Value,
    terminal: &Value,
    request_id: &str,
) -> Result<(), CliError> {
    if terminal.get("id").and_then(Value::as_str) != Some(request_id) {
        return Err(CliError::Protocol("terminal_response_id_mismatch".into()));
    }
    let receipt = resolution
        .get("operationReceipt")
        .and_then(Value::as_object)
        .ok_or_else(|| CliError::Protocol("missing_operation_receipt".into()))?;
    if receipt.get("requestId").and_then(Value::as_str) != Some(request_id)
        || receipt
            .get("commitSequence")
            .and_then(Value::as_u64)
            .is_none()
    {
        return Err(CliError::Protocol("operation_receipt_mismatch".into()));
    }
    Ok(())
}

fn successful_payload<'a>(
    response: &'a Envelope,
    operation: &str,
) -> Result<&'a Map<String, Value>, CliError> {
    if response.ok == Some(false) {
        let code = response
            .error
            .as_ref()
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(CliError::Rejected {
            operation: operation.into(),
            code: code.into(),
        });
    }
    response
        .payload
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| CliError::Protocol(format!("invalid_response:{operation}")))
}

fn terminal_envelope(response: &Envelope) -> Value {
    serde_json::to_value(response).expect("wire envelope is serializable")
}

fn mark_all_unsynchronized(root: &mut LockedStateRoot) -> Result<(), CliError> {
    root.mutate(|state| {
        for scope in state.scopes.values_mut() {
            scope.synchronized = false;
        }
    })?;
    Ok(())
}

fn mark_all_synchronized(
    root: &mut LockedStateRoot,
    cutoff: Option<&Value>,
) -> Result<(), CliError> {
    root.mutate(|state| {
        for scope in state.scopes.values_mut() {
            scope.synchronized = true;
            if let Some(cutoff) = cutoff {
                scope.synchronization_cutoff = Some(cutoff.clone());
            }
        }
    })?;
    Ok(())
}

#[derive(Debug)]
pub enum CliError {
    Input(String),
    OutcomeUnknown { request_id: String, cause: String },
    Protocol(String),
    Rejected { operation: String, code: String },
    State(StateError),
    StillPending,
    Wire(WireFailure),
    Json(serde_json::Error),
}

impl CliError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Input(_) => "invalid_input",
            Self::OutcomeUnknown { .. } => "outcome_unknown",
            Self::Protocol(_) => "protocol_error",
            Self::Rejected { .. } => "operation_rejected",
            Self::State(_) => "state_error",
            Self::StillPending => "still_pending",
            Self::Wire(_) => "transport_error",
            Self::Json(_) => "json_error",
        }
    }

    pub fn details(&self) -> Value {
        match self {
            Self::OutcomeUnknown { request_id, cause } => {
                json!({ "cause": cause, "requestId": request_id })
            }
            Self::Rejected { operation, code } => {
                json!({ "operation": operation, "rejectionCode": code })
            }
            _ => json!({ "message": self.to_string() }),
        }
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Input(value) => write!(formatter, "invalid_input:{value}"),
            Self::OutcomeUnknown { request_id, cause } => {
                write!(formatter, "outcome_unknown:{request_id}:{cause}")
            }
            Self::Protocol(value) => write!(formatter, "protocol_error:{value}"),
            Self::Rejected { operation, code } => {
                write!(formatter, "operation_rejected:{operation}:{code}")
            }
            Self::State(error) => error.fmt(formatter),
            Self::StillPending => formatter.write_str("still_pending"),
            Self::Wire(error) => error.fmt(formatter),
            Self::Json(error) => write!(formatter, "json_error:{error}"),
        }
    }
}

impl std::error::Error for CliError {}

impl From<StateError> for CliError {
    fn from(value: StateError) -> Self {
        Self::State(value)
    }
}

impl From<serde_json::Error> for CliError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

impl From<()> for CliError {
    fn from(_: ()) -> Self {
        Self::Protocol("projection_order".into())
    }
}
