use crate::command::Invocation;
use crate::state::{
    AcknowledgementIntent, CorrelationPhase, LockedStateRoot, ScopeProjection, StateError,
    UnresolvedCorrelation,
};
use crate::wire::{DirectWire, Envelope, WebSocketWire, WireFailure, WireResponse};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tungstenite::client::{uri_mode, IntoClientRequest};
use uuid::Uuid;

const LOCKLESS_CAPABILITY: &str = "surf-ace.lockless-multi-controller.v1";
const RECEIPT_CAPABILITY: &str = "operation-receipt-replay-v1";
const CONTROL_PROJECTION_V1: &str = "control_projection_v1";
const DISCOVERY_TIMEOUT: Duration = Duration::from_millis(2_000);
const DISCOVERY_REGISTRY_MAX_BYTES: usize = 1_048_576;
const DISCOVERY_DESCRIBE_MAX_BYTES: usize = 65_536;
const MAX_READINESS_REASON_CHARS: usize = 512;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliOutput {
    pub ok: bool,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reconciliations: Vec<Value>,
    pub result: Value,
}

pub fn execute(invocation: Invocation) -> Result<CliOutput, CliError> {
    invocation
        .command
        .validate(&invocation.input)
        .map_err(CliError::Input)?;
    validate_invocation_route(&invocation)?;
    if invocation.command == crate::command::Command::FleetList {
        let registry = invocation
            .registry
            .as_deref()
            .expect("fleet-list route validation requires registry");
        let mut wire = WebSocketWire::connect_direct(registry).map_err(CliError::Wire)?;
        return execute_fleet_list_with_wire(&mut wire);
    }
    if invocation.command == crate::command::Command::WindowDescribe {
        return execute_window_describe(&invocation);
    }
    if invocation.command.is_local() {
        return execute_local(invocation);
    }
    let endpoint = invocation
        .endpoint
        .clone()
        .ok_or_else(|| CliError::Input("missing_endpoint".into()))?;
    let mut root = open_invocation_state(&invocation)?;
    validate_expected_controller(&invocation, &root)?;
    let surface_id = operation_surface_id(&invocation)?;
    let mut operation_wire = WebSocketWire::connect_direct(&endpoint).map_err(CliError::Wire)?;
    if invocation.command != crate::command::Command::PaneDescribe {
        if let Some(surface_id) = surface_id.as_deref() {
            discover_surface(&mut root, &mut operation_wire, surface_id)?;
        }
    }
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
    validate_invocation_route(&invocation)?;
    if invocation.command == crate::command::Command::FleetList {
        return execute_fleet_list_with_wire(wire);
    }
    if invocation.command == crate::command::Command::WindowDescribe {
        return Err(CliError::Input(
            "window_describe_requires_routed_transport".into(),
        ));
    }
    if invocation.command.is_local() {
        return Err(CliError::Input("read_must_use_local_path".into()));
    }
    let surface_id = operation_surface_id(&invocation)?;
    let mut root = open_invocation_state(&invocation)?;
    validate_expected_controller(&invocation, &root)?;
    execute_locked(invocation, &mut root, wire, surface_id.as_deref())
}

fn open_invocation_state(invocation: &Invocation) -> Result<LockedStateRoot, CliError> {
    if invocation.command == crate::command::Command::PaneDescribe {
        Ok(LockedStateRoot::open_existing(
            &invocation.state_root,
            invocation.projection_capacity_bytes,
        )?)
    } else {
        Ok(LockedStateRoot::open(
            &invocation.state_root,
            invocation.projection_capacity_bytes,
        )?)
    }
}

fn validate_expected_controller(
    invocation: &Invocation,
    root: &LockedStateRoot,
) -> Result<(), CliError> {
    if invocation.command != crate::command::Command::PaneDescribe {
        return Ok(());
    }
    let expected = invocation
        .input
        .get("expectedControllerInstanceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::Input("invalid_input:expectedControllerInstanceId".into()))?;
    if root.state().controller_instance_id != expected {
        return Err(CliError::Input("controller_instance_mismatch".into()));
    }
    Ok(())
}

fn validate_invocation_route(invocation: &Invocation) -> Result<(), CliError> {
    if invocation.endpoint.is_some() && invocation.registry.is_some() {
        return Err(CliError::Input("ambiguous_endpoint_registry".into()));
    }
    if matches!(
        invocation.command,
        crate::command::Command::FleetList | crate::command::Command::WindowDescribe
    ) {
        if invocation.endpoint.is_some() {
            let code = if invocation.command == crate::command::Command::FleetList {
                "fleet_list_rejects_endpoint"
            } else {
                "window_describe_rejects_endpoint"
            };
            return Err(CliError::Input(code.into()));
        }
        if invocation.product_label.is_some() {
            return Err(CliError::Input("fleet_list_rejects_product_label".into()));
        }
        let registry = invocation
            .registry
            .as_deref()
            .ok_or_else(|| CliError::Input("missing_registry".into()))?;
        let request = registry
            .into_client_request()
            .map_err(|_| CliError::Input("invalid_registry".into()))?;
        uri_mode(request.uri()).map_err(|_| CliError::Input("invalid_registry".into()))?;
        return Ok(());
    }
    if invocation.registry.is_some() {
        return Err(CliError::Input("registry_only_for_fleet_list".into()));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RegistryIdentity {
    allocator_id: String,
    fleet_id: String,
}

#[derive(Clone, Debug)]
struct RegistrySnapshot {
    payload: Value,
    identity: RegistryIdentity,
    server_time_ms: u64,
    max_endpoint_lease_ms: u64,
}

#[derive(Clone, Debug)]
struct EndpointCandidate {
    identity: RegistryIdentity,
    client_id: String,
    surface_id: String,
    window_label: String,
    direct_endpoint: String,
    lease_generation: u64,
    registration_observed_at_ms: u64,
    lease_expires_at_ms: u64,
}

impl EndpointCandidate {
    fn same_registration(&self, other: &Self) -> bool {
        self.identity == other.identity
            && self.client_id == other.client_id
            && self.surface_id == other.surface_id
            && self.window_label == other.window_label
            && self.direct_endpoint == other.direct_endpoint
            && self.lease_generation == other.lease_generation
            && self.registration_observed_at_ms == other.registration_observed_at_ms
    }

    fn evidence(&self, snapshot: &RegistrySnapshot) -> Value {
        json!({
            "clientId": self.client_id,
            "surfaceId": self.surface_id,
            "windowLabel": self.window_label,
            "directEndpoint": self.direct_endpoint,
            "registryIdentity": {
                "allocatorId": self.identity.allocator_id,
                "fleetId": self.identity.fleet_id,
            },
            "registryServerTimeMs": snapshot.server_time_ms,
            "maxEndpointLeaseMs": snapshot.max_endpoint_lease_ms,
            "registrationReady": snapshot.payload.get("registrationReady").cloned().unwrap_or(Value::Null),
            "endpointLease": {
                "leaseGeneration": self.lease_generation,
                "registrationObservedAtMs": self.registration_observed_at_ms,
                "leaseExpiresAtMs": self.lease_expires_at_ms,
            },
        })
    }
}

fn execute_window_describe(invocation: &Invocation) -> Result<CliOutput, CliError> {
    let registry = invocation
        .registry
        .as_deref()
        .expect("window-describe route validation requires registry");
    let window_label = invocation
        .input
        .get("windowLabel")
        .and_then(Value::as_str)
        .expect("window-describe input validation requires a label");
    let before = read_discovery_registry(registry)?;
    let selected = select_endpoint_candidate(&before, window_label)?;
    let direct_observed_at_ms = discovery_now_ms()?;
    let probe = probe_surface(&selected, direct_observed_at_ms);
    let after = read_discovery_registry(registry)
        .map_err(|error| with_probe_observation(error, &selected, direct_observed_at_ms, &probe))?;
    let rechecked = select_endpoint_candidate(&after, window_label).map_err(|error| {
        with_probe_observation(
            discovery_error(
                "stale_registration",
                format!(
                    "Registry row did not remain uniquely current after direct observation: {error}"
                ),
            ),
            &selected,
            direct_observed_at_ms,
            &probe,
        )
    })?;
    if !selected.same_registration(&rechecked) {
        return Err(with_probe_observation(
            discovery_error(
                "stale_registration",
                "Registry identity, client, surface, endpoint, window label, or lease generation changed during observation",
            ),
            &selected,
            direct_observed_at_ms,
            &probe,
        ));
    }
    let surface_observation = probe?;
    let identity_consistency = identity_consistency(&surface_observation, &rechecked);
    Ok(CliOutput {
        ok: true,
        command: crate::command::Command::WindowDescribe.name().into(),
        controller_instance_id: None,
        reconciliations: vec![],
        result: json!({
            "windowLabel": window_label,
            "identitySemantics": "consistency_only_not_authentication",
            "transportReachability": {
                "status": "reachable",
                "directEndpoint": selected.direct_endpoint,
                "observedAtMs": direct_observed_at_ms,
            },
            "registryBefore": selected.evidence(&before),
            "registryAfter": rechecked.evidence(&after),
            "applicationReadiness": surface_observation["applicationReadiness"].clone(),
            "identityConsistency": identity_consistency,
            "surfaceObservation": surface_observation,
        }),
    })
}

fn read_discovery_registry(registry: &str) -> Result<RegistrySnapshot, CliError> {
    let mut wire = WebSocketWire::connect_direct_bounded(
        registry,
        DISCOVERY_TIMEOUT,
        DISCOVERY_REGISTRY_MAX_BYTES,
    )
    .map_err(|error| registry_wire_error(error))?;
    let request_id = format!("rq_{}", Uuid::new_v4().simple());
    let mut sent = || Ok(());
    let response = wire
        .request(&request_id, "fleet.topology", json!({}), &mut sent)
        .map_err(registry_wire_error)?;
    let _ = wire.close();
    if response.response.id.as_deref() != Some(request_id.as_str())
        || response.response.op != "fleet.topology"
        || response.response.envelope_type != "response"
        || response.response.v != 1
        || response
            .response
            .sent_at
            .is_none_or(|time| time > MAX_SAFE_INTEGER)
    {
        return Err(discovery_error(
            "registry_response_invalid",
            "Registry returned an invalid fleet.topology envelope",
        ));
    }
    if response.response.ok != Some(true) {
        let code = response
            .response
            .error
            .as_ref()
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(discovery_error(
            "registry_unavailable",
            format!("fleet.topology was refused: {code}"),
        ));
    }
    let payload = response.response.payload.ok_or_else(|| {
        discovery_error(
            "registry_response_invalid",
            "Registry omitted fleet.topology payload",
        )
    })?;
    validate_fleet_topology_payload(&payload)
        .map_err(|error| discovery_error("registry_response_invalid", error.to_string()))?;
    let object = payload.as_object().ok_or_else(|| {
        discovery_error(
            "registry_response_invalid",
            "Registry topology payload is not an object",
        )
    })?;
    let identity = object
        .get("registryIdentity")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            discovery_error("registry_response_invalid", "Registry identity is missing")
        })?;
    if identity
        .keys()
        .any(|key| key != "allocatorId" && key != "fleetId")
    {
        return Err(discovery_error(
            "registry_response_invalid",
            "Registry identity has unknown fields",
        ));
    }
    let allocator_id = identity
        .get("allocatorId")
        .and_then(Value::as_str)
        .filter(|value| valid_allocator_id(value))
        .ok_or_else(|| {
            discovery_error(
                "registry_response_invalid",
                "Registry allocator identity is invalid",
            )
        })?;
    let fleet_id = identity
        .get("fleetId")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        })
        .ok_or_else(|| {
            discovery_error(
                "registry_response_invalid",
                "Registry fleet identity is invalid",
            )
        })?;
    let server_time_ms = object
        .get("registryServerTimeMs")
        .and_then(safe_nonnegative_u64)
        .ok_or_else(|| {
            discovery_error(
                "registry_response_invalid",
                "Registry server time is missing or invalid",
            )
        })?;
    let max_endpoint_lease_ms = object
        .get("maxEndpointLeaseMs")
        .and_then(safe_positive_u64)
        .ok_or_else(|| {
            discovery_error(
                "registry_response_invalid",
                "Registry endpoint lease bound is missing or invalid",
            )
        })?;
    if !object
        .get("registrationReady")
        .is_some_and(Value::is_boolean)
    {
        return Err(discovery_error(
            "registry_response_invalid",
            "Registry readiness is missing or invalid",
        ));
    }
    let parsed_identity = RegistryIdentity {
        allocator_id: allocator_id.to_owned(),
        fleet_id: fleet_id.to_owned(),
    };
    Ok(RegistrySnapshot {
        payload,
        identity: parsed_identity,
        server_time_ms,
        max_endpoint_lease_ms,
    })
}

fn select_endpoint_candidate(
    snapshot: &RegistrySnapshot,
    window_label: &str,
) -> Result<EndpointCandidate, CliError> {
    let clients = snapshot
        .payload
        .get("clients")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            discovery_error("registry_response_invalid", "Registry clients are missing")
        })?;
    let mut label_seen = false;
    let mut label_has_supported_endpoint = false;
    let mut candidates = Vec::new();
    for client in clients {
        let Some(client_object) = client.as_object() else {
            continue;
        };
        let Some(client_id) = client_object.get("clientId").and_then(Value::as_str) else {
            continue;
        };
        let Some(surfaces) = client_object.get("surfaces").and_then(Value::as_array) else {
            continue;
        };
        for surface in surfaces {
            let Some(surface_object) = surface.as_object() else {
                continue;
            };
            if surface_object.get("windowLabel").and_then(Value::as_str) != Some(window_label) {
                continue;
            }
            label_seen = true;
            let row_identity = parse_registry_identity(client_object.get("registryIdentity"))
                .map_err(|message| {
                    discovery_error(
                        "registry_response_invalid",
                        format!("Selected client row has invalid registry identity: {message}"),
                    )
                })?;
            if row_identity != snapshot.identity {
                return Err(discovery_error(
                    "registry_response_invalid",
                    "Selected client row identity differs from fleet.topology identity",
                ));
            }
            let Some(surface_id) = surface_object.get("surfaceId").and_then(Value::as_str) else {
                continue;
            };
            let Some(direct_endpoint) = client_object.get("directEndpoint").and_then(Value::as_str)
            else {
                continue;
            };
            if !is_supported_direct_endpoint(direct_endpoint)
                || client_object.get("prePairDescribeV1") != Some(&Value::Bool(true))
            {
                continue;
            }
            label_has_supported_endpoint = true;
            let Some(lease) = client_object
                .get("endpointLease")
                .and_then(Value::as_object)
            else {
                continue;
            };
            if lease.keys().any(|key| {
                ![
                    "leaseGeneration",
                    "registrationObservedAtMs",
                    "leaseExpiresAtMs",
                ]
                .contains(&key.as_str())
            }) {
                continue;
            }
            let Some(lease_generation) = lease.get("leaseGeneration").and_then(safe_positive_u64)
            else {
                continue;
            };
            let Some(registration_observed_at_ms) = lease
                .get("registrationObservedAtMs")
                .and_then(safe_nonnegative_u64)
            else {
                continue;
            };
            let Some(lease_expires_at_ms) =
                lease.get("leaseExpiresAtMs").and_then(safe_positive_u64)
            else {
                continue;
            };
            if registration_observed_at_ms > snapshot.server_time_ms
                || lease_expires_at_ms <= snapshot.server_time_ms
                || lease_expires_at_ms <= registration_observed_at_ms
                || lease_expires_at_ms - snapshot.server_time_ms > snapshot.max_endpoint_lease_ms
            {
                continue;
            }
            candidates.push(EndpointCandidate {
                identity: row_identity,
                client_id: client_id.to_owned(),
                surface_id: surface_id.to_owned(),
                window_label: window_label.to_owned(),
                direct_endpoint: direct_endpoint.to_owned(),
                lease_generation,
                registration_observed_at_ms,
                lease_expires_at_ms,
            });
        }
    }
    match candidates.len() {
        0 if label_seen && !label_has_supported_endpoint => Err(discovery_error(
            "endpoint_unconfigured",
            "Named window has no configured direct endpoint with pre-pair describe support",
        )),
        0 if label_seen => Err(discovery_error(
            "stale_registration",
            "Named window has no current supported endpoint lease",
        )),
        0 => Err(discovery_error(
            "window_not_found",
            "No registry surface has the requested window label",
        )),
        1 => Ok(candidates.remove(0)),
        _ => Err(discovery_error(
            "window_ambiguous",
            "More than one current registry surface has the requested window label",
        )),
    }
}

fn probe_surface(candidate: &EndpointCandidate, observed_at_ms: u64) -> Result<Value, CliError> {
    let mut wire = match WebSocketWire::connect_direct_bounded(
        &candidate.direct_endpoint,
        DISCOVERY_TIMEOUT,
        DISCOVERY_DESCRIBE_MAX_BYTES,
    ) {
        Ok(wire) => wire,
        Err(error) => {
            let failure = endpoint_wire_error(error);
            return Err(with_probe_evidence(
                failure,
                candidate,
                observed_at_ms,
                "unreachable",
                "unknown",
            ));
        }
    };
    let request_id = format!("rq_{}", Uuid::new_v4().simple());
    // Two independent v4 values provide 244 random bits after their fixed version/variant bits.
    let nonce = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let payload = json!({
        "clientId": candidate.client_id,
        "registryIdentity": {
            "allocatorId": candidate.identity.allocator_id,
            "fleetId": candidate.identity.fleet_id,
        },
        "surfaceId": candidate.surface_id,
        "endpointLeaseGeneration": candidate.lease_generation,
        "nonce": nonce,
    });
    let mut sent = || Ok(());
    let response = match wire.request(&request_id, "surface.describe", payload, &mut sent) {
        Ok(response) => response,
        Err(error) => {
            let _ = wire.close();
            let failure = endpoint_wire_error(error);
            return Err(with_probe_evidence(
                failure,
                candidate,
                observed_at_ms,
                "reachable",
                "unknown",
            ));
        }
    };
    let _ = wire.close();
    if !response.events.is_empty() {
        return Err(with_probe_evidence(
            discovery_error(
                "describe_response_invalid",
                "Pre-pair surface.describe produced unexpected events",
            ),
            candidate,
            observed_at_ms,
            "reachable",
            "unknown",
        ));
    }
    if response.response.id.as_deref() != Some(request_id.as_str())
        || response.response.op != "surface.describe"
        || response.response.envelope_type != "response"
        || response.response.v != 1
        || response
            .response
            .sent_at
            .is_none_or(|time| time > MAX_SAFE_INTEGER)
    {
        return Err(with_probe_evidence(
            discovery_error(
                "describe_response_invalid",
                "Client returned an invalid surface.describe envelope",
            ),
            candidate,
            observed_at_ms,
            "reachable",
            "unknown",
        ));
    }
    if response.response.ok != Some(true) {
        let code = response
            .response
            .error
            .as_ref()
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let (mapped, message) = match code {
            "prepair_describe_unsupported" => (
                "prepair_describe_unsupported",
                "Client does not support pre-pair surface.describe",
            ),
            "identity_mismatch" => (
                "identity_mismatch",
                "Client refused the registry identity or endpoint lease",
            ),
            "revision_churn" => (
                "revision_churn",
                "Client topology changed during observation",
            ),
            "not_ready" => (
                "client_not_ready",
                "Client application is not ready for an authoritative observation",
            ),
            "surface_not_found" => (
                "stale_registration",
                "Registry surface is no longer live at the endpoint",
            ),
            "unsupported_protocol_version" => (
                "unsupported_protocol_version",
                "Client does not support protocol v1",
            ),
            _ => ("describe_rejected", "Client refused surface.describe"),
        };
        let readiness = if mapped == "client_not_ready" {
            "not_ready"
        } else {
            "unknown"
        };
        let error = with_probe_evidence(
            discovery_error(mapped, format!("{message}: {code}")),
            candidate,
            observed_at_ms,
            "reachable",
            readiness,
        );
        let readiness_reason = (mapped == "client_not_ready")
            .then(|| {
                response
                    .response
                    .error
                    .as_ref()
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
            })
            .flatten()
            .and_then(bounded_readiness_reason);
        return Err(match readiness_reason {
            Some(reason) => with_probe_readiness_reason(error, reason),
            None => error,
        });
    }
    let payload = match response.response.payload {
        Some(payload) => payload,
        None => {
            return Err(with_probe_evidence(
                discovery_error(
                    "describe_response_invalid",
                    "Client omitted surface.describe payload",
                ),
                candidate,
                observed_at_ms,
                "reachable",
                "unknown",
            ));
        }
    };
    if let Err(error) = validate_surface_observation(&payload, candidate, &nonce) {
        return Err(with_probe_evidence(
            error,
            candidate,
            observed_at_ms,
            "reachable",
            "unknown",
        ));
    }
    Ok(payload)
}

fn bounded_readiness_reason(message: &str) -> Option<String> {
    if message.trim().is_empty() {
        return None;
    }
    let mut chars = message.chars();
    let mut reason: String = chars.by_ref().take(MAX_READINESS_REASON_CHARS).collect();
    if chars.next().is_some() {
        reason.pop();
        reason.push('…');
    }
    Some(reason)
}

fn with_probe_readiness_reason(error: CliError, reason: String) -> CliError {
    match error {
        CliError::Discovery {
            code,
            message,
            mut details,
        } => {
            if let Some(readiness) = details
                .get_mut("applicationReadiness")
                .and_then(Value::as_object_mut)
            {
                readiness.insert("readinessReason".into(), Value::String(reason));
            }
            CliError::Discovery {
                code,
                message,
                details,
            }
        }
        other => other,
    }
}

fn with_probe_evidence(
    error: CliError,
    candidate: &EndpointCandidate,
    observed_at_ms: u64,
    transport_status: &str,
    readiness_status: &str,
) -> CliError {
    match error {
        CliError::Discovery { code, message, .. } => {
            let details = json!({
                "message": message.clone(),
                "transportReachability": {
                    "status": transport_status,
                    "directEndpoint": candidate.direct_endpoint.clone(),
                    "observedAtMs": observed_at_ms,
                },
                "applicationReadiness": {
                    "status": readiness_status,
                    "limitationCodes": if readiness_status == "unknown" {
                        vec![code]
                    } else if readiness_status == "not_ready" {
                        vec!["not_ready"]
                    } else {
                        vec![]
                    },
                },
            });
            CliError::Discovery {
                code,
                message,
                details,
            }
        }
        other => other,
    }
}

fn with_probe_observation(
    error: CliError,
    candidate: &EndpointCandidate,
    observed_at_ms: u64,
    probe: &Result<Value, CliError>,
) -> CliError {
    let CliError::Discovery { code, message, .. } = error else {
        return error;
    };
    let (transport_reachability, application_readiness, surface_observation) = match probe {
        Ok(observation) => (
            json!({
                "status": "reachable",
                "directEndpoint": candidate.direct_endpoint,
                "observedAtMs": observed_at_ms,
            }),
            observation
                .get("applicationReadiness")
                .cloned()
                .unwrap_or(Value::Null),
            Some(observation.clone()),
        ),
        Err(probe_error) => {
            let details = probe_error.details();
            let transport = details
                .get("transportReachability")
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "status": "reachable",
                        "directEndpoint": candidate.direct_endpoint,
                        "observedAtMs": observed_at_ms,
                    })
                });
            let readiness = details
                .get("applicationReadiness")
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "status": "unknown",
                        "limitationCodes": [probe_error.code()],
                    })
                });
            (transport, readiness, None)
        }
    };
    let mut details = json!({
        "message": message,
        "transportReachability": transport_reachability,
        "applicationReadiness": application_readiness,
    });
    if let Some(observation) = surface_observation {
        details["surfaceObservation"] = observation;
    }
    CliError::Discovery {
        code,
        message,
        details,
    }
}

fn validate_surface_observation(
    payload: &Value,
    candidate: &EndpointCandidate,
    nonce: &str,
) -> Result<(), CliError> {
    let object = payload.as_object().ok_or_else(|| {
        discovery_error(
            "describe_response_invalid",
            "Client observation is not an object",
        )
    })?;
    require_exact_keys(
        object,
        &[
            "nonce",
            "clientId",
            "registryIdentity",
            "surfaceId",
            "endpointLeaseGeneration",
            "observedAtMs",
            "applicationReadiness",
            "surfaceSetRevision",
            "topologyRevision",
            "layout",
            "panes",
        ],
    )
    .map_err(|message| discovery_error("describe_response_invalid", message))?;
    if object.get("nonce").and_then(Value::as_str) != Some(nonce) {
        return Err(discovery_error(
            "stale_response",
            "Client observation did not match the request nonce",
        ));
    }
    match object.get("clientId") {
        Some(value) if value.as_str().is_some_and(valid_client_id) => {}
        _ => return Err(discovery_error(
            "describe_response_invalid",
            "Client observation has an invalid client id",
        )),
    }
    if object.get("clientId").and_then(Value::as_str) != Some(candidate.client_id.as_str())
        || object.get("surfaceId").and_then(Value::as_str) != Some(candidate.surface_id.as_str())
    {
        return Err(discovery_error(
            "identity_mismatch",
            "Client observation identifies a different client or surface",
        ));
    }
    match object.get("registryIdentity") {
        Some(value) if value.is_null() => {}
        Some(_) => {
            parse_registry_identity(object.get("registryIdentity"))
                .map_err(|message| discovery_error("describe_response_invalid", message))?;
        }
        None => return Err(discovery_error(
            "describe_response_invalid",
            "Client observation is missing its saved registry identity",
        )),
    }
    match object.get("endpointLeaseGeneration") {
        Some(value) if value.is_null() => {}
        Some(value) if safe_positive_u64(value).is_some() => {}
        None => return Err(discovery_error(
            "describe_response_invalid",
            "Client observation is missing its saved endpoint lease",
        )),
        _ => return Err(discovery_error(
            "describe_response_invalid",
            "Saved endpoint lease generation is invalid",
        )),
    }
    for key in ["observedAtMs", "surfaceSetRevision", "topologyRevision"] {
        if object.get(key).and_then(safe_nonnegative_u64).is_none() {
            return Err(discovery_error(
                "describe_response_invalid",
                format!("Client observation has invalid {key}"),
            ));
        }
    }
    validate_application_readiness(object.get("applicationReadiness"))
        .map_err(|message| discovery_error("describe_response_invalid", message))?;
    let panes = object
        .get("panes")
        .and_then(Value::as_array)
        .filter(|panes| !panes.is_empty())
        .ok_or_else(|| {
            discovery_error(
                "describe_response_invalid",
                "Client observation has no live panes",
            )
        })?;
    let mut pane_ids = BTreeSet::new();
    for pane in panes {
        let pane = pane.as_object().ok_or_else(|| {
            discovery_error("describe_response_invalid", "Pane record is not an object")
        })?;
        require_exact_keys(pane, &["paneId", "paneLabel", "contentObservation"])
            .map_err(|message| discovery_error("describe_response_invalid", message))?;
        let pane_id = pane
            .get("paneId")
            .and_then(safe_nonnegative_u64)
            .ok_or_else(|| discovery_error("describe_response_invalid", "Pane id is invalid"))?;
        if !pane_ids.insert(pane_id) {
            return Err(discovery_error(
                "describe_response_invalid",
                "Client observation contains duplicate pane ids",
            ));
        }
        let label = pane
            .get("paneLabel")
            .ok_or_else(|| discovery_error("describe_response_invalid", "Pane label is missing"))?;
        if !label.is_null() && safe_positive_u64(label).is_none() {
            return Err(discovery_error(
                "describe_response_invalid",
                "Pane label is invalid",
            ));
        }
        let observation = pane
            .get("contentObservation")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                discovery_error(
                    "describe_response_invalid",
                    "Pane content observation is invalid",
                )
            })?;
        require_exact_keys(observation, &["revision", "source", "observedAtMs"])
            .map_err(|message| discovery_error("describe_response_invalid", message))?;
        if observation.get("source").and_then(Value::as_str) != Some("client-authority")
            || observation
                .get("observedAtMs")
                .and_then(safe_nonnegative_u64)
                .is_none()
            || (!observation.get("revision").is_some_and(Value::is_null)
                && observation
                    .get("revision")
                    .and_then(safe_nonnegative_u64)
                    .is_none())
        {
            return Err(discovery_error(
                "describe_response_invalid",
                "Pane content observation is invalid",
            ));
        }
    }
    let mut layout_ids = Vec::new();
    validate_layout_node(
        object.get("layout").expect("required layout"),
        0,
        &mut layout_ids,
    )
    .map_err(|message| discovery_error("describe_response_invalid", message))?;
    let pane_id_set = pane_ids.into_iter().collect::<Vec<_>>();
    layout_ids.sort_unstable();
    if layout_ids != pane_id_set {
        return Err(discovery_error(
            "describe_response_invalid",
            "Layout leaves do not match the live pane list",
        ));
    }
    Ok(())
}

fn identity_consistency(
    payload: &Value,
    candidate: &EndpointCandidate,
) -> Value {
    let limitation_codes = payload
        .get("applicationReadiness")
        .and_then(|readiness| readiness.get("limitationCodes"))
        .and_then(Value::as_array)
        .expect("validated limitation codes");
    let has_code = |code: &str| {
        limitation_codes
            .iter()
            .any(|value| value.as_str() == Some(code))
    };
    let registry_identity = match payload.get("registryIdentity") {
        Some(value) if value.is_null() => "absent",
        Some(value) => {
            let matches = value
                .get("allocatorId")
                .and_then(Value::as_str)
                == Some(candidate.identity.allocator_id.as_str())
                && value.get("fleetId").and_then(Value::as_str)
                    == Some(candidate.identity.fleet_id.as_str());
            if !matches {
                "differs"
            } else if has_code("persistence_outcome_unknown")
                || has_code("registry_binding_unavailable")
                || has_code("registry_binding_stale")
            {
                "unverified"
            } else {
                "matched"
            }
        }
        None => "absent",
    };
    let endpoint_lease = match payload.get("endpointLeaseGeneration") {
        Some(value) if value.is_null() => "absent",
        Some(value) if safe_positive_u64(value) != Some(candidate.lease_generation) => "differs",
        Some(_) if has_code("persistence_outcome_unknown")
            || has_code("endpoint_lease_unavailable")
            || has_code("endpoint_lease_stale") =>
        {
            "unverified"
        }
        Some(_) => "matched",
        None => "absent",
    };

    json!({
        "clientId": "matched",
        "surfaceId": "matched",
        "registryIdentity": registry_identity,
        "endpointLease": endpoint_lease,
    })
}

fn valid_client_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_application_readiness(value: Option<&Value>) -> Result<(), String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| "applicationReadiness is missing".to_owned())?;
    require_exact_keys(object, &["status", "limitationCodes"])?;
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| "applicationReadiness.status is invalid".to_owned())?;
    let codes = object
        .get("limitationCodes")
        .and_then(Value::as_array)
        .ok_or_else(|| "applicationReadiness.limitationCodes is invalid".to_owned())?;
    if !codes
        .iter()
        .all(|code| code.as_str().is_some_and(valid_limitation_code))
    {
        return Err("applicationReadiness contains an invalid limitation code".into());
    }
    match status {
        "ready" if codes.is_empty() => Ok(()),
        "degraded" if !codes.is_empty() => Ok(()),
        _ => Err("applicationReadiness status and limitation codes disagree".into()),
    }
}

fn validate_layout_node(
    value: &Value,
    depth: usize,
    pane_ids: &mut Vec<u64>,
) -> Result<(), String> {
    if depth > 64 || pane_ids.len() > 4096 {
        return Err("layout exceeds topology bounds".into());
    }
    let object = value
        .as_object()
        .ok_or_else(|| "layout node is not an object".to_owned())?;
    match object.get("type").and_then(Value::as_str) {
        Some("pane") => {
            require_exact_keys_with_optional(object, &["type", "paneId"], &["weight"])?;
            let pane_id = object
                .get("paneId")
                .and_then(safe_nonnegative_u64)
                .ok_or_else(|| "layout pane id is invalid".to_owned())?;
            validate_layout_weight(object.get("weight"))?;
            pane_ids.push(pane_id);
            Ok(())
        }
        Some("split") => {
            require_exact_keys_with_optional(
                object,
                &["type", "direction", "children"],
                &["weight"],
            )?;
            if !matches!(
                object.get("direction").and_then(Value::as_str),
                Some("horizontal" | "vertical")
            ) {
                return Err("layout split direction is invalid".into());
            }
            validate_layout_weight(object.get("weight"))?;
            let children = object
                .get("children")
                .and_then(Value::as_array)
                .filter(|children| !children.is_empty())
                .ok_or_else(|| "layout split children are invalid".to_owned())?;
            for child in children {
                validate_layout_node(child, depth + 1, pane_ids)?;
            }
            Ok(())
        }
        _ => Err("layout node type is invalid".into()),
    }
}

fn validate_layout_weight(weight: Option<&Value>) -> Result<(), String> {
    if let Some(weight) = weight {
        let weight = weight
            .as_f64()
            .ok_or_else(|| "layout weight is invalid".to_owned())?;
        if !weight.is_finite() || weight <= 0.0 {
            return Err("layout weight is invalid".into());
        }
    }
    Ok(())
}

fn parse_registry_identity(value: Option<&Value>) -> Result<RegistryIdentity, String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| "Registry identity is missing".to_owned())?;
    require_exact_keys(object, &["allocatorId", "fleetId"])?;
    let allocator_id = object
        .get("allocatorId")
        .and_then(Value::as_str)
        .filter(|value| valid_allocator_id(value))
        .ok_or_else(|| "Registry allocator identity is invalid".to_owned())?;
    let fleet_id = object
        .get("fleetId")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        })
        .ok_or_else(|| "Registry fleet identity is invalid".to_owned())?;
    Ok(RegistryIdentity {
        allocator_id: allocator_id.into(),
        fleet_id: fleet_id.into(),
    })
}

fn require_exact_keys(object: &Map<String, Value>, required: &[&str]) -> Result<(), String> {
    require_exact_keys_with_optional(object, required, &[])
}

fn require_exact_keys_with_optional(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> Result<(), String> {
    if required.iter().any(|key| !object.contains_key(*key)) {
        return Err("Required response field is missing".into());
    }
    if object
        .keys()
        .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err("Response object contains an unsupported field".into());
    }
    Ok(())
}

fn safe_nonnegative_u64(value: &Value) -> Option<u64> {
    let value = value.as_u64()?;
    (value <= MAX_SAFE_INTEGER).then_some(value)
}

fn safe_positive_u64(value: &Value) -> Option<u64> {
    safe_nonnegative_u64(value).filter(|value| *value > 0)
}

fn valid_allocator_id(value: &str) -> bool {
    value.strip_prefix("alloc_").is_some_and(|suffix| {
        suffix.len() >= 3
            && suffix.len() <= 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    })
}

fn valid_limitation_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
}

fn is_supported_direct_endpoint(value: &str) -> bool {
    if value.is_empty() || value.len() > 2048 || value.contains('#') {
        return false;
    }
    let Ok(request) = value.into_client_request() else {
        return false;
    };
    let uri = request.uri();
    if uri_mode(uri).is_err() || uri.host().is_none() {
        return false;
    }
    !uri.authority()
        .is_some_and(|authority| authority.as_str().contains('@'))
}

fn registry_wire_error(error: WireFailure) -> CliError {
    let code = if wire_is_timed_out(&error) {
        "registry_timeout"
    } else {
        "registry_unreachable"
    };
    discovery_error(code, error.to_string())
}

fn endpoint_wire_error(error: WireFailure) -> CliError {
    let code = match &error {
        WireFailure::BeforeSend { .. } => "endpoint_unreachable",
        WireFailure::AfterSend { code } if code.contains("response_too_large") => {
            "describe_response_too_large"
        }
        WireFailure::AfterSend { .. } => "application_unresponsive",
    };
    discovery_error(code, error.to_string())
}

fn wire_is_timed_out(error: &WireFailure) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("timed out")
        || message.contains("deadline_exceeded")
        || message.contains("deadline:operation timed out")
        || message.contains("temporarily unavailable")
        || message.contains("would block")
        || message.contains("wouldblock")
}

#[cfg(test)]
mod discovery_timeout_tests {
    use super::wire_is_timed_out;
    use crate::wire::WireFailure;

    #[test]
    fn socket_timeout_classification_includes_platform_would_block_errors() {
        for message in [
            "deadline_exceeded",
            "operation timed out",
            "Resource temporarily unavailable (os error 11)",
            "WouldBlock",
        ] {
            assert!(
                wire_is_timed_out(&WireFailure::AfterSend {
                    code: format!("response_read:{message}"),
                }),
                "{message} should be reported as a bounded timeout",
            );
        }
        assert!(!wire_is_timed_out(&WireFailure::BeforeSend {
            code: "reachability:Connection refused".into(),
        }));
    }
}

fn discovery_now_ms() -> Result<u64, CliError> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| discovery_error("clock_unavailable", error.to_string()))?
        .as_millis();
    let value = u64::try_from(value)
        .map_err(|error| discovery_error("clock_unavailable", error.to_string()))?;
    if value > MAX_SAFE_INTEGER {
        return Err(discovery_error(
            "clock_unavailable",
            "Local clock exceeds safe epoch milliseconds",
        ));
    }
    Ok(value)
}

fn discovery_error(code: &'static str, message: impl Into<String>) -> CliError {
    let message = message.into();
    CliError::Discovery {
        code,
        details: json!({ "message": message.clone() }),
        message,
    }
}

fn execute_fleet_list_with_wire(wire: &mut dyn DirectWire) -> Result<CliOutput, CliError> {
    let request_id = format!("rq_{}", Uuid::new_v4().simple());
    let mut sent = || Ok(());
    let response = wire
        .request(&request_id, "fleet.topology", json!({}), &mut sent)
        .map_err(CliError::Wire)
        .and_then(|response| {
            if response.response.id.as_deref() != Some(request_id.as_str())
                || response.response.op != "fleet.topology"
                || response.response.envelope_type != "response"
                || response.response.v != 1
            {
                return Err(CliError::Protocol("invalid_fleet_topology_envelope".into()));
            }
            if response.response.ok != Some(true) {
                if response.response.ok == Some(false) {
                    let code = response
                        .response
                        .error
                        .as_ref()
                        .and_then(|error| error.get("code"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    return Err(CliError::Rejected {
                        operation: "fleet.topology".into(),
                        code: code.into(),
                    });
                }
                return Err(CliError::Protocol("invalid_fleet_topology_envelope".into()));
            }
            let payload = successful_payload(&response.response, "fleet.topology")?;
            let payload = Value::Object(payload.clone());
            validate_fleet_topology_payload(&payload)?;
            Ok(payload)
        });
    let close = wire.close();
    let result = match response {
        Ok(result) => {
            close.map_err(CliError::Wire)?;
            result
        }
        Err(error) => {
            let _ = close;
            return Err(error);
        }
    };
    Ok(CliOutput {
        ok: true,
        command: crate::command::Command::FleetList.name().into(),
        controller_instance_id: None,
        reconciliations: vec![],
        result,
    })
}

fn validate_fleet_topology_payload(payload: &Value) -> Result<(), CliError> {
    let clients = payload
        .get("clients")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::Protocol("invalid_fleet_topology_clients".into()))?;
    let mut client_ids = BTreeSet::new();
    for client in clients {
        let client_id = client
            .get("clientId")
            .and_then(Value::as_str)
            .filter(|value| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
            .ok_or_else(|| CliError::Protocol("invalid_fleet_topology_client_id".into()))?;
        if !client_ids.insert(client_id.to_owned()) {
            return Err(CliError::Protocol(
                "duplicate_fleet_topology_client_id".into(),
            ));
        }
        let surfaces = client
            .get("surfaces")
            .and_then(Value::as_array)
            .ok_or_else(|| CliError::Protocol("invalid_fleet_topology_surfaces".into()))?;
        let mut surface_ids = BTreeSet::new();
        for surface in surfaces {
            let surface_id = surface
                .get("surfaceId")
                .and_then(Value::as_str)
                .filter(|value| valid_registered_surface_id(value))
                .ok_or_else(|| CliError::Protocol("invalid_fleet_topology_surface_id".into()))?;
            if !surface_ids.insert(surface_id.to_owned()) {
                return Err(CliError::Protocol(
                    "duplicate_fleet_topology_surface_id".into(),
                ));
            }
            let window_label = surface
                .get("windowLabel")
                .and_then(Value::as_str)
                .filter(|value| {
                    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_lowercase())
                })
                .ok_or_else(|| CliError::Protocol("invalid_fleet_topology_window_label".into()))?;
            let panes = surface
                .get("panes")
                .and_then(Value::as_array)
                .ok_or_else(|| CliError::Protocol("invalid_fleet_topology_panes".into()))?;
            let mut pane_ids = BTreeSet::new();
            let mut pane_labels = BTreeSet::new();
            for pane in panes {
                let pane_id = pane
                    .get("paneId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| CliError::Protocol("invalid_fleet_topology_pane_id".into()))?;
                let pane_label = pane
                    .get("paneLabel")
                    .and_then(Value::as_u64)
                    .filter(|value| *value > 0)
                    .ok_or_else(|| {
                        CliError::Protocol("invalid_fleet_topology_pane_label".into())
                    })?;
                let pane_address =
                    pane.get("paneAddress")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            CliError::Protocol("invalid_fleet_topology_pane_address".into())
                        })?;
                if pane_address != format!("{window_label}{pane_label}") {
                    return Err(CliError::Protocol(
                        "inconsistent_fleet_topology_pane_address".into(),
                    ));
                }
                if !pane_ids.insert(pane_id.to_owned()) || !pane_labels.insert(pane_label) {
                    return Err(CliError::Protocol(
                        "duplicate_fleet_topology_pane_identity".into(),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn valid_registered_surface_id(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("sf_") else {
        return false;
    };
    (3..=64).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn execute_locked(
    invocation: Invocation,
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    surface_id: Option<&str>,
) -> Result<CliOutput, CliError> {
    let pane_target = if invocation.command == crate::command::Command::PaneDescribe {
        Some((
            surface_id
                .ok_or_else(|| CliError::Input("invalid_input:surfaceId".into()))?
                .to_owned(),
            invocation
                .input
                .get("paneId")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
                .ok_or_else(|| CliError::Input("invalid_input:paneId".into()))?,
        ))
    } else {
        None
    };
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
        "protocolFeatures": [LOCKLESS_CAPABILITY, RECEIPT_CAPABILITY, CONTROL_PROJECTION_V1],
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
    let pane_describe = invocation.command == crate::command::Command::PaneDescribe;
    let pair_payload = if pane_describe {
        match pane_describe_successful_payload(&pair.response, "pair.request") {
            Ok(payload) => payload,
            Err(error) => {
                let _ = wire.close();
                return Err(error);
            }
        }
    } else {
        successful_payload(&pair.response, "pair.request")?
    };
    if pair_payload.get("mode").and_then(Value::as_str) != Some("lockless") {
        return Err(CliError::Protocol(
            "lockless_capability_not_admitted".into(),
        ));
    }
    let control_projection = match validate_pair_projection(pair_payload) {
        Ok(control_projection) => control_projection,
        Err(error) => {
            let _ = wire.close();
            return Err(error);
        }
    };
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
    if let Err(error) = (|| {
        apply_synchronization(
            root,
            pair_payload,
            &pair.events,
            control_projection,
            surface_id,
        )?;
        finalize_acknowledged_receipts(root, wire)?;
        let acknowledgement_scopes = acknowledgement_scopes(pair_payload, control_projection);
        flush_acknowledgements(root, wire, &acknowledgement_scopes)
    })() {
        let _ = mark_all_unsynchronized(root);
        let _ = wire.close();
        return Err(error);
    }
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
    let projection_scopes = if control_projection {
        projection_scopes_for_command(invocation.command, &payload)
    } else {
        vec![]
    };
    if control_projection && invocation.command != crate::command::Command::Sync {
        synchronize_operation_scopes(root, wire, pair_payload, invocation.command, &payload)?;
    }
    let result = if invocation.command == crate::command::Command::Sync {
        let scopes = projection_scopes_for_command(invocation.command, &payload);
        for scope in &scopes { mark_scope_unsynchronized(root, scope)?; }
        if control_projection {
            synchronize_operation_scopes(root, wire, pair_payload, invocation.command, &payload)?;
        } else {
            synchronize_scope_payloads(root, wire, scopes.clone())?;
        }
        let current = scopes.iter().all(|id| root.state().scopes.get(id)
            .is_some_and(|scope| scope.synchronized));
        json!({"ok":true,"scopeIds":scopes,"cacheStatus":if current {"current"} else {"unsynchronized"}})
    } else if let Some((surface_id, pane_id)) = pane_target {
        let pane_result = (|| {
            let response = request_without_correlation(wire, op, payload)?;
            let response_payload =
                pane_describe_successful_payload(&response.response, "panes.list")?;
            apply_wire_events(root, &response)?;
            describe_pane(response_payload, &surface_id, pane_id)
        })();
        match pane_result {
            Ok(result) => result,
            Err(error) => {
                let _ = wire.close();
                return Err(error);
            }
        }
    } else if invocation.command.is_mutation() {
        perform_mutation(root, wire, op, payload)?
    } else {
        let response = request_without_correlation(wire, op, payload)?;
        apply_wire_events(root, &response)?;
        if invocation.command == crate::command::Command::List && response.response.ok == Some(true)
        {
            // Lifecycle pairs have no scopes. The successful listing identifies
            // this client’s active scopes without trusting another endpoint’s cache.
            let scopes = listed_acknowledgement_scopes(successful_payload(
                &response.response,
                "surfaces.list",
            )?);
            flush_acknowledgements(root, wire, &scopes)?;
        }
        terminal_envelope(&response.response)
    };
    if control_projection {
        if invocation.command.is_mutation()
            && result.get("ok").and_then(Value::as_bool) == Some(true)
        {
            for scope_id in &projection_scopes {
                mark_scope_unsynchronized(root, scope_id)?;
            }
            // A content/annotation commit does not push payload deltas in control
            // mode. Hydrate only its scope so subsequent explicit local reads can
            // see that committed result. target.apply only commits an async intent.
            if invocation.command != crate::command::Command::TargetApply {
                if let Err(error) = synchronize_scope_payloads(root, wire, projection_scopes) {
                    let _ = wire.close();
                    return Err(CliError::ProjectionAfterCommit {
                        committed: Box::new(result), cause: error.to_string(),
                    });
                }
            }
        }
    } else {
        mark_all_synchronized(root, pair_payload.get("synchronizationCutoff"))?;
    }
    wire.close().map_err(CliError::Wire)?;
    reconciliations.sort_by(|left, right| {
        left.get("requestId")
            .and_then(Value::as_str)
            .cmp(&right.get("requestId").and_then(Value::as_str))
    });
    Ok(CliOutput {
        ok: true,
        command: invocation.command.name().into(),
        controller_instance_id: Some(controller_id),
        reconciliations,
        result,
    })
}

fn describe_pane(
    payload: &Map<String, Value>,
    surface_id: &str,
    pane_id: u64,
) -> Result<Value, CliError> {
    let panes = payload
        .get("panes")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::Protocol("invalid_panes_list_panes".into()))?;
    let mut selected = None;
    for pane in panes {
        if pane.get("paneId").and_then(Value::as_u64) == Some(pane_id) {
            if selected.is_some() {
                return Err(CliError::Protocol("duplicate_panes_list_pane_id".into()));
            }
            selected = Some(pane);
        }
    }
    let pane = selected.ok_or_else(|| CliError::Protocol("pane_not_found".into()))?;
    let pane_lineage_id = pane
        .get("paneLineageId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CliError::Protocol("invalid_panes_list_pane_lineage".into()))?;
    let current_target = match pane.get("currentTarget") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Object(target)) => {
            let target_epoch = target
                .get("targetEpoch")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
                .ok_or_else(|| CliError::Protocol("invalid_panes_list_target_epoch".into()))?;
            let target_lineage_id = target
                .get("paneLineageId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| CliError::Protocol("invalid_panes_list_target_lineage".into()))?;
            if target_lineage_id != pane_lineage_id {
                return Err(CliError::Protocol(
                    "panes_list_target_lineage_mismatch".into(),
                ));
            }
            if !matches!(
                target.get("currentState").and_then(Value::as_str),
                Some("current" | "stale" | "superseded" | "tombstoned")
            ) {
                return Err(CliError::Protocol("invalid_panes_list_target_state".into()));
            }
            if target
                .get("targetId")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
                || target
                    .get("targetKind")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
            {
                return Err(CliError::Protocol("invalid_panes_list_target".into()));
            }
            let mut target = target.clone();
            target.insert("targetEpoch".into(), Value::from(target_epoch));
            Value::Object(target)
        }
        Some(_) => {
            return Err(CliError::Protocol(
                "invalid_panes_list_current_target".into(),
            ));
        }
    };
    let target_epoch = current_target
        .get("targetEpoch")
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({
        "currentTarget": current_target,
        "paneId": pane_id,
        "paneLineageId": pane_lineage_id,
        "surfaceId": surface_id,
        "targetEpoch": target_epoch
    }))
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
                "consumableLoss": state.unfetched_scope_gaps.get(&scope_id)
                    .and_then(|metadata| metadata.get("gap")),
                "currentContentRecord": null,
                "records": [],
                "scopeId": scope_id,
                "synchronizationCutoff": null,
            });
        };
        update_current_content_from_records(scope, &scope_id);
        let current_content_record = if scope.synchronized && scope.gap.is_none() {
            scope.current_content_record.clone()
        } else {
            None
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
            "currentContentRecord": current_content_record,
            "records": records,
            "scopeId": scope_id,
            "synchronizationCutoff": scope.synchronization_cutoff,
        })
    })?;
    Ok(CliOutput {
        ok: true,
        command: invocation.command.name().into(),
        controller_instance_id: Some(controller_id),
        reconciliations: vec![],
        result,
    })
}

fn update_current_content_from_records(scope: &mut ScopeProjection, scope_id: &str) {
    for record in &scope.records {
        update_current_content(
            scope_id,
            record,
            &mut scope.current_content_record,
            &mut scope.current_content_sequence,
        );
    }
}

fn update_current_content(
    scope_id: &str,
    record: &Value,
    current_content_record: &mut Option<Value>,
    current_content_sequence: &mut Option<u64>,
) {
    if record.get("recordClass").and_then(Value::as_str) != Some("content") {
        return;
    }
    let Some(sequence) = record
        .get("sequence")
        .and_then(Value::as_u64)
        .filter(|sequence| *sequence > 0)
    else {
        return;
    };
    if current_content_sequence.is_some_and(|previous| sequence <= previous) {
        return;
    }

    *current_content_sequence = Some(sequence);
    let payload = record.get("payload").unwrap_or(&Value::Null);
    let explicit_clear = payload.get("operation").and_then(Value::as_str) == Some("content.clear")
        || (payload.get("currentContentId").is_some_and(Value::is_null)
            && payload.get("contentId").is_some_and(Value::is_null)
            && payload.get("contentType").is_some_and(Value::is_null));
    if explicit_clear || !content_record_matches_scope(record, scope_id) {
        *current_content_record = None;
    } else {
        *current_content_record = Some(record.clone());
    }
}

fn content_record_matches_scope(record: &Value, scope_id: &str) -> bool {
    let payload = record.get("payload").unwrap_or(&Value::Null);
    let Some(surface_id) = payload.get("surfaceId").and_then(Value::as_str) else {
        return false;
    };
    let Some(pane_id) = payload.get("paneId").and_then(Value::as_u64) else {
        return false;
    };
    scope_id == format!("pane:{}:{pane_id}", encode_scope_component(surface_id))
}

fn encode_scope_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*()'".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn scopes_closed_by(operation: &str, payload: &Value) -> Vec<String> {
    let Some(surface_id) = payload.get("surfaceId").and_then(Value::as_str) else {
        return vec![];
    };
    let encoded_surface = encode_scope_component(surface_id);
    match operation {
        "pane.close" => payload
            .get("paneId")
            .and_then(Value::as_u64)
            .map(|pane_id| vec![format!("pane:{encoded_surface}:{pane_id}")])
            .unwrap_or_default(),
        "surface.window.close" => vec![
            format!("surface:{encoded_surface}"),
            format!("pane:{encoded_surface}:"),
        ],
        _ => vec![],
    }
}

fn forget_closed_scopes(
    root: &mut LockedStateRoot,
    closed_scope_selectors: &[String],
) -> Result<(), CliError> {
    let matches_closed_scope = |scope_id: &str| {
        closed_scope_selectors.iter().any(|selector| {
            if selector.ends_with(':') {
                scope_id.starts_with(selector)
            } else {
                scope_id == selector
            }
        })
    };
    root.mutate(|state| {
        state
            .scopes
            .retain(|scope_id, _| !matches_closed_scope(scope_id));
        state
            .acknowledgement_outbox
            .retain(|intent| !matches_closed_scope(&intent.scope_id));
        state.unfetched_scope_gaps.retain(|scope_id, _| !matches_closed_scope(scope_id));
    })?;
    Ok(())
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
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    surface_id: &str,
) -> Result<(), CliError> {
    let listed = request_without_correlation(wire, "surfaces.list", json!({}))?;
    let listed_payload = successful_payload(&listed.response, "surfaces.list")?;
    apply_wire_events(root, &listed)?;
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
    let closed_scopes = scopes_closed_by(op, &payload);
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
    let terminal = terminal_envelope(&response.response);
    let precommit_error = response
        .response
        .error
        .as_ref()
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str);
    if response.response.ok == Some(false) {
        apply_wire_events(root, &response)?;
    }
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
    // A projection failure cannot erase an already returned, durable terminal
    // receipt or turn its known commit back into a generic/uncertain result.
    if let Err(error) = apply_wire_events(root, &response) {
        return Err(CliError::ProjectionAfterCommit {
            committed: Box::new(terminal), cause: error.to_string(),
        });
    }
    acknowledge_receipt(root, wire, &request_id)?;
    if response.response.ok == Some(true) && !closed_scopes.is_empty() {
        forget_closed_scopes(root, &closed_scopes)?;
    }
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

fn listed_acknowledgement_scopes(payload: &Map<String, Value>) -> Vec<Value> {
    let mut scopes = Vec::new();
    for surface in payload
        .get("surfaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(surface_id) = surface.get("surfaceId").and_then(Value::as_str) else {
            continue;
        };
        let encoded = encoded_surface_id(surface_id);
        scopes.push(json!({"scopeId": format!("surface:{encoded}")}));
        for pane in surface
            .pointer("/topology/panes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(pane_id) = pane.get("paneId").and_then(Value::as_u64) {
                scopes.push(json!({"scopeId": format!("pane:{encoded}:{pane_id}")}));
            }
        }
    }
    scopes
}

fn encoded_surface_id(surface_id: &str) -> String {
    // Match the protocol’s encodeURIComponent scope component.
    surface_id
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn flush_acknowledgements(
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    eligible_scopes: &[Value],
) -> Result<(), CliError> {
    for intent in root.state().acknowledgement_outbox.clone() {
        // A pair summary may identify an owned scope, but only a pre-existing
        // durable intent plus an accepted explicit ACK advances its cursor.
        if !eligible_scopes.iter().any(|scope| {
            scope.get("scopeId").and_then(Value::as_str) == Some(intent.scope_id.as_str())
        }) {
            continue;
        }
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

fn projection_scopes_for_command(command: crate::command::Command, payload: &Value) -> Vec<String> {
    let Some(surface_id) = payload.get("surfaceId").and_then(Value::as_str) else {
        return vec![];
    };
    let encoded_surface_id = encoded_surface_id(surface_id);
    match command {
        crate::command::Command::Sync => payload.get("scopeIds").and_then(Value::as_array)
            .into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect(),
        crate::command::Command::Push
        | crate::command::Command::Clear
        | crate::command::Command::AnnotationsRemove => payload
            .get("paneId")
            .and_then(Value::as_u64)
            .map(|pane_id| vec![format!("pane:{encoded_surface_id}:{pane_id}")])
            .unwrap_or_default(),
        crate::command::Command::TargetApply => {
            vec![format!("surface:{encoded_surface_id}")]
        }
        _ => vec![],
    }
}

fn synchronize_operation_scopes(
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    pair_payload: &Map<String, Value>,
    command: crate::command::Command,
    operation_payload: &Value,
) -> Result<(), CliError> {
    let required_scope_ids = projection_scopes_for_command(command, operation_payload);
    if required_scope_ids.is_empty() {
        return Ok(());
    }
    let summaries = pair_payload
        .get("scopeSummaries")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::Protocol("invalid_control_projection_scope_summaries".into()))?;
    let available_scope_ids = summaries
        .iter()
        .filter_map(|summary| summary.get("scopeId").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    for scope_id in &required_scope_ids {
        if !available_scope_ids.contains(scope_id.as_str()) {
            return Err(CliError::Protocol(
                "control_projection_missing_operation_scope".into(),
            ));
        }
    }
    synchronize_scope_payloads(root, wire, required_scope_ids)
}

fn synchronize_scope_payloads(
    root: &mut LockedStateRoot,
    wire: &mut dyn DirectWire,
    required_scope_ids: Vec<String>,
) -> Result<(), CliError> {
    // Matching cursor, gap and retention metadata lets an existing local
    // snapshot remain current. The summaries themselves never supply records
    // or move a cursor; fetch only operation-relevant scopes that are stale.
    let scopes_to_sync = required_scope_ids
        .into_iter()
        .filter(|scope_id| {
            !root
                .state()
                .scopes
                .get(scope_id)
                .is_some_and(|scope| scope.synchronized)
        })
        .collect::<Vec<_>>();
    if scopes_to_sync.is_empty() {
        return Ok(());
    }
    let response = request_without_correlation(
        wire,
        "consumable.sync",
        json!({ "scopeIds": scopes_to_sync.clone() }),
    )?;
    let payload = match control_sync_successful_payload(&response.response) {
        Ok(payload) => payload,
        Err(error) => {
            apply_wire_events(root, &response)?;
            return Err(error);
        }
    };
    let snapshots = payload
        .get("snapshots")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::Protocol("invalid_consumable_sync_snapshots".into()))?;
    let expected = scopes_to_sync
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    for snapshot in snapshots {
        let scope_id = snapshot
            .get("scopeId")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError::Protocol("invalid_consumable_sync_snapshot".into()))?;
        if !expected.contains(scope_id) || !seen.insert(scope_id) {
            return Err(CliError::Protocol(
                "unexpected_consumable_sync_snapshot_scope".into(),
            ));
        }
        validate_consumable_sync_snapshot(snapshot)?;
    }
    if seen != expected {
        return Err(CliError::Protocol(
            "missing_consumable_sync_snapshot_scope".into(),
        ));
    }
    for snapshot in snapshots {
        apply_snapshot(root, snapshot)?;
    }
    apply_wire_events(root, &response)?;
    Ok(())
}

fn control_sync_successful_payload(response: &Envelope) -> Result<&Map<String, Value>, CliError> {
    if response.envelope_type != "response" {
        return Err(CliError::Protocol(
            "invalid_response_type:consumable.sync".into(),
        ));
    }
    if response.v != 1 {
        return Err(CliError::Protocol(
            "unsupported_response_version:consumable.sync".into(),
        ));
    }
    if response.op != "consumable.sync" {
        return Err(CliError::Protocol(
            "response_operation_mismatch:consumable.sync".into(),
        ));
    }
    if response.ok == Some(false) {
        let code = response
            .error
            .as_ref()
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(CliError::Rejected {
            operation: "consumable.sync".into(),
            code: code.into(),
        });
    }
    if response.ok != Some(true) {
        return Err(CliError::Protocol(
            "missing_response_success:consumable.sync".into(),
        ));
    }
    response
        .payload
        .as_ref()
        .and_then(Value::as_object)
        .ok_or_else(|| CliError::Protocol("invalid_response:consumable.sync".into()))
}

fn validate_consumable_sync_snapshot(snapshot: &Value) -> Result<(), CliError> {
    let valid = snapshot.get("version").and_then(Value::as_u64) == Some(1)
        && snapshot
            .pointer("/cursor/cursor")
            .and_then(Value::as_u64)
            .is_some()
        && snapshot
            .pointer("/cursor/gapGeneration")
            .and_then(Value::as_u64)
            .is_some()
        && snapshot
            .pointer("/cursor/gap")
            .is_none_or(|gap| gap.is_null() || gap.is_object())
        && snapshot
            .get("firstRetainedSequence")
            .and_then(Value::as_u64)
            .is_some()
        && snapshot
            .get("lastRetainedSequence")
            .and_then(Value::as_u64)
            .is_some()
        && snapshot.get("records").and_then(Value::as_array).is_some();
    if !valid {
        return Err(CliError::Protocol(
            "invalid_consumable_sync_snapshot".into(),
        ));
    }
    Ok(())
}

fn acknowledgement_scopes(
    pair_payload: &Map<String, Value>,
    control_projection: bool,
) -> Vec<Value> {
    if control_projection {
        return pair_payload
            .get("scopeSummaries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|summary| summary.get("scopeId").and_then(Value::as_str))
            .map(|scope_id| json!({ "scopeId": scope_id }))
            .collect();
    }
    pair_payload
        .get("scopes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|scope| scope.get("scopeId").and_then(Value::as_str))
        .map(|scope_id| json!({ "scopeId": scope_id }))
        .collect()
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
    control_projection: bool,
    surface_id: Option<&str>,
) -> Result<(), CliError> {
    let result = (|| {
        if let Some(scopes) = pair_payload.get("scopes").and_then(Value::as_array) {
            for scope in scopes {
                apply_snapshot(root, scope)?;
            }
        }
        if control_projection {
            apply_control_scope_summaries(root, pair_payload, surface_id)?;
        }
        apply_events(root, events)
    })();
    if let Err(error) = result {
        mark_all_unsynchronized(root)?;
        return Err(error);
    }
    Ok(())
}

fn validate_pair_projection(payload: &Map<String, Value>) -> Result<bool, CliError> {
    match payload.get("projection") {
        Some(Value::String(projection)) if projection == "control" => {
            let features = payload
                .get("capabilities")
                .and_then(Value::as_object)
                .and_then(|capabilities| capabilities.get("protocolFeatures"))
                .and_then(Value::as_array)
                .ok_or_else(|| CliError::Protocol("control_projection_not_advertised".into()))?;
            if !features
                .iter()
                .any(|feature| feature.as_str() == Some(CONTROL_PROJECTION_V1))
            {
                return Err(CliError::Protocol(
                    "control_projection_not_advertised".into(),
                ));
            }
            if !payload.get("scopeSummaries").is_some_and(Value::is_array) {
                return Err(CliError::Protocol(
                    "invalid_control_projection_scope_summaries".into(),
                ));
            }
            if !payload
                .get("scopes")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
            {
                return Err(CliError::Protocol(
                    "control_projection_contains_material_scopes".into(),
                ));
            }
            Ok(true)
        }
        Some(Value::String(projection)) if projection == "material" => Ok(false),
        None => Ok(false),
        Some(_) => Err(CliError::Protocol("invalid_pair_projection".into())),
    }
}

fn apply_control_scope_summaries(
    root: &mut LockedStateRoot,
    pair_payload: &Map<String, Value>,
    surface_id: Option<&str>,
) -> Result<(), CliError> {
    let summaries = pair_payload
        .get("scopeSummaries")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::Protocol("invalid_control_projection_scope_summaries".into()))?;
    let mut seen = BTreeSet::new();
    let mut parsed = Vec::with_capacity(summaries.len());
    for summary in summaries {
        let scope_id = summary
            .get("scopeId")
            .and_then(Value::as_str)
            .filter(|scope_id| !scope_id.is_empty())
            .ok_or_else(|| CliError::Protocol("invalid_control_projection_scope_summary".into()))?;
        let cursor = summary
            .pointer("/cursor/cursor")
            .and_then(Value::as_u64)
            .ok_or_else(|| CliError::Protocol("invalid_control_projection_scope_summary".into()))?;
        let gap_generation = summary
            .pointer("/cursor/gapGeneration")
            .and_then(Value::as_u64)
            .ok_or_else(|| CliError::Protocol("invalid_control_projection_scope_summary".into()))?;
        let gap = summary
            .pointer("/cursor/gap")
            .or(Some(&Value::Null))
            .filter(|gap| gap.is_null() || gap.is_object())
            .ok_or_else(|| CliError::Protocol("invalid_control_projection_scope_summary".into()))?;
        let first = summary
            .get("firstRetainedSequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| CliError::Protocol("invalid_control_projection_scope_summary".into()))?;
        let last = summary
            .get("lastRetainedSequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| CliError::Protocol("invalid_control_projection_scope_summary".into()))?;
        if !seen.insert(scope_id.to_owned()) {
            return Err(CliError::Protocol(
                "duplicate_control_projection_scope_summary".into(),
            ));
        }
        parsed.push((
            scope_id.to_owned(),
            cursor,
            gap_generation,
            gap.clone(),
            first,
            last,
        ));
    }

    let paired_scope_prefixes = surface_id.map(|surface_id| {
        let encoded = encoded_surface_id(surface_id);
        (format!("surface:{encoded}"), format!("pane:{encoded}:"))
    });
    if let Some((surface_scope, pane_prefix)) = paired_scope_prefixes.as_ref() {
        if parsed.iter().any(|entry| {
            let scope_id = &entry.0;
            scope_id != surface_scope && !scope_id.starts_with(pane_prefix)
        }) {
            return Err(CliError::Protocol(
                "control_projection_scope_summary_surface_mismatch".into(),
            ));
        }
    }
    root.mutate(|state| {
        if let Some((surface_scope, pane_prefix)) = paired_scope_prefixes.as_ref() {
            for (scope_id, scope) in &mut state.scopes {
                let belongs_to_surface =
                    scope_id == surface_scope || scope_id.starts_with(pane_prefix);
                if belongs_to_surface && !seen.contains(scope_id) {
                    scope.synchronized = false;
                }
            }
        } else {
            for (scope_id, scope) in &mut state.scopes {
                if !seen.contains(scope_id) {
                    scope.synchronized = false;
                }
            }
        }
        for (scope_id, cursor, gap_generation, gap, first, last) in parsed {
            if let Some(scope) = state.scopes.get_mut(&scope_id) {
                let gap_matches = scope.gap.as_ref().unwrap_or(&Value::Null) == &gap;
                // A historical accepted gap generation can remain after the gap itself
                // is cleared. It does not make otherwise matching retained state stale.
                let gap_generation_matches = gap.is_null()
                    || scope
                        .gap
                        .as_ref()
                        .and_then(|value| value.get("generation"))
                        .and_then(Value::as_u64)
                        == Some(gap_generation);
                let matches_snapshot = scope.synchronized
                    && scope.client_cursor == cursor
                    && scope.first_retained_sequence == first
                    && scope.last_retained_sequence == last
                    && gap_matches
                    && gap_generation_matches;
                if !matches_snapshot {
                    scope.synchronized = false;
                }
            }
        }
    })?;
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
            "event.consumable_available" => {
                if let Some(scope_id) = payload.get("scopeId").and_then(Value::as_str) {
                    mark_scope_unsynchronized(root, scope_id)?;
                }
            }
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
    let previous_scope = root.state().scopes.get(&scope_id);
    let mut current_content_record =
        previous_scope.and_then(|scope| scope.current_content_record.clone());
    let mut current_content_sequence =
        previous_scope.and_then(|scope| scope.current_content_sequence);
    let gap = snapshot
        .get("cursor")
        .and_then(|cursor| cursor.get("gap"))
        .cloned()
        .unwrap_or(Value::Null);
    if !gap.is_null() {
        current_content_record = None;
        let lost_through = gap
            .get("lastLostSequence")
            .or_else(|| gap.get("lastDiscardedSequence"))
            .and_then(Value::as_u64)
            .or_else(|| {
                snapshot
                    .get("firstRetainedSequence")
                    .and_then(Value::as_u64)
                    .map(|first| first.saturating_sub(1))
            });
        if let Some(lost_through) = lost_through {
            current_content_sequence =
                Some(current_content_sequence.unwrap_or(0).max(lost_through));
        }
    }
    for record in &records {
        update_current_content(
            &scope_id,
            record,
            &mut current_content_record,
            &mut current_content_sequence,
        );
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
        current_content_record,
        current_content_sequence,
        records,
        gap: if gap.is_null() { None } else { Some(gap) },
        synchronized: true,
        synchronization_cutoff: snapshot.get("synchronizationCutoff").cloned(),
    };
    root.mutate(|state| {
        state.unfetched_scope_gaps.remove(&scope_id);
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
            update_current_content(
                &scope_id,
                &record,
                &mut scope.current_content_record,
                &mut scope.current_content_sequence,
            );
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
        let Some(scope) = state.scopes.get_mut(&scope_id) else {
            state.unfetched_scope_gaps.insert(scope_id.clone(), json!({
                "gap": gap, "firstRetainedSequence": first, "lastRetainedSequence": last
            }));
            return Ok::<(), ()>(());
        };
        scope.gap = Some(gap);
        scope.synchronized = false;
        scope.first_retained_sequence = first;
        scope.last_retained_sequence = scope.last_retained_sequence.max(last);
        scope.current_content_record = None;
        let lost_through = scope
            .gap
            .as_ref()
            .and_then(|gap| {
                gap.get("lastLostSequence")
                    .or_else(|| gap.get("lastDiscardedSequence"))
            })
            .and_then(Value::as_u64)
            .unwrap_or_else(|| first.saturating_sub(1));
        scope.current_content_sequence = Some(
            scope
                .current_content_sequence
                .unwrap_or(0)
                .max(lost_through),
        );
        scope
            .records
            .retain(|record| record.get("sequence").and_then(Value::as_u64).unwrap_or(0) >= first);
        Ok::<(), ()>(())
    })??;
    Ok(())
}

fn resume_payload(state: &crate::state::DurableState, include_unresolved: bool) -> Value {
    json!({
        // Pairing has not established the current client’s owned scopes yet.
        // Flush durable intents explicitly after scoped synchronization or list.
        "pendingAcks": [],
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

fn pane_describe_successful_payload<'a>(
    response: &'a Envelope,
    operation: &str,
) -> Result<&'a Map<String, Value>, CliError> {
    if response.envelope_type != "response" {
        return Err(CliError::Protocol(format!(
            "invalid_response_type:{operation}"
        )));
    }
    if response.v != 1 {
        return Err(CliError::Protocol(format!(
            "unsupported_response_version:{operation}"
        )));
    }
    if response.op != operation {
        return Err(CliError::Protocol(format!(
            "response_operation_mismatch:{operation}"
        )));
    }
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
    if response.ok != Some(true) {
        return Err(CliError::Protocol(format!(
            "missing_response_success:{operation}"
        )));
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

fn mark_scope_unsynchronized(root: &mut LockedStateRoot, scope_id: &str) -> Result<(), CliError> {
    root.mutate(|state| {
        if let Some(scope) = state.scopes.get_mut(scope_id) {
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
    Discovery {
        code: &'static str,
        message: String,
        details: Value,
    },
    OutcomeUnknown {
        request_id: String,
        cause: String,
    },
    ProjectionAfterCommit { committed: Box<Value>, cause: String },
    Protocol(String),
    Rejected {
        operation: String,
        code: String,
    },
    State(StateError),
    StillPending,
    Wire(WireFailure),
    Json(serde_json::Error),
}

impl CliError {
    pub fn code(&self) -> &str {
        match self {
            Self::Input(_) => "invalid_input",
            Self::Discovery { code, .. } => code,
            Self::OutcomeUnknown { .. } => "outcome_unknown",
            Self::ProjectionAfterCommit { .. } => "projection_unavailable_after_commit",
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
            Self::Discovery { details, .. } => details.clone(),
            Self::OutcomeUnknown { request_id, cause } => {
                json!({ "cause": cause, "requestId": request_id })
            }
            Self::ProjectionAfterCommit { committed, cause } => {
                json!({ "committedResponse": committed, "cause": cause, "cacheStatus": "unsynchronized" })
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
            Self::Discovery { code, message, .. } => write!(formatter, "{code}:{message}"),
            Self::OutcomeUnknown { request_id, cause } => {
                write!(formatter, "outcome_unknown:{request_id}:{cause}")
            }
            Self::ProjectionAfterCommit { cause, .. } => write!(formatter, "projection_unavailable_after_commit:{cause}"),
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
