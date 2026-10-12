use crate::command::Command;
use serde_json::{json, Value};

const SAFE_INTEGER_MAX: i64 = 9_007_199_254_740_991;

pub fn handle_arguments(arguments: &[String]) -> Option<Result<Value, String>> {
    if arguments.first().is_some_and(|value| value == "help") {
        let target = match arguments {
            [_] => None,
            [_, name] => Some(name.as_str()),
            [_, group, name] if group == "annotations" => {
                return Some(document(Some(&format!("annotations {name}"))))
            }
            _ => return Some(Err("invalid_input:help_arguments".into())),
        };
        return Some(document(target));
    }
    if arguments.first().is_some_and(|value| value == "schema") {
        return Some(match arguments {
            [_, name] => schema_document(name),
            [_, group, name] if group == "annotations" => {
                schema_document(&format!("annotations {name}"))
            }
            _ => Err("invalid_input:schema_requires_command".into()),
        });
    }

    if let Some(flag_index) = arguments.iter().position(|value| value == "--schema") {
        let target = help_target(&arguments[..flag_index])
            .or_else(|| help_target(&arguments[flag_index + 1..]));
        return Some(
            target
                .as_deref()
                .ok_or_else(|| "invalid_input:schema_requires_command".to_owned())
                .and_then(schema_document),
        );
    }

    let flag_index = arguments
        .iter()
        .position(|value| matches!(value.as_str(), "--help" | "-h" | "--schema"))?;
    let target =
        help_target(&arguments[..flag_index]).or_else(|| help_target(&arguments[flag_index + 1..]));
    Some(document(target.as_deref()))
}

fn help_target(arguments: &[String]) -> Option<String> {
    if let Some(index) = arguments
        .windows(2)
        .position(|pair| pair[0] == "annotations" && annotation_action(&pair[1]))
    {
        return Some(format!("annotations {}", arguments[index + 1]));
    }
    arguments
        .iter()
        .rev()
        .find_map(|value| Command::parse(value))
        .map(|command| command.name().to_owned())
}

fn annotation_action(name: &str) -> bool {
    matches!(name, "watch" | "resume" | "ack" | "retire")
}

fn schema_document(name: &str) -> Result<Value, String> {
    document(Some(name)).map(|value| {
        let mut result = value["result"].clone();
        if let Some(spec) = result.get_mut("command") {
            let mut command = json!({
                "name": spec["name"],
                "route": spec["route"],
                "effect": spec["effect"],
                "summary": spec["summary"],
                "inputSchema": spec["inputSchema"],
                "resultSchema": spec["resultSchema"],
                "errorSchema": spec["errorSchema"],
                "errors": spec["errors"],
            });
            for field in ["consumerLifecycle", "errorContract"] {
                if let Some(value) = spec.get(field) {
                    command[field] = value.clone();
                }
            }
            *spec = command;
        }
        json!({ "ok": true, "command": "schema", "result": result })
    })
}

pub fn document(target: Option<&str>) -> Result<Value, String> {
    if let Some(name) = target {
        if name == "annotations" {
            return Ok(annotation_group_document());
        }
        if let Some(action) = name.strip_prefix("annotations ") {
            return annotation_command_document(action);
        }
        let command = Command::parse(name)
            .ok_or_else(|| format!("invalid_input:unknown_help_command:{name}"))?;
        return Ok(json!({
            "ok": true,
            "command": "help",
            "result": {
                "globalOptions": global_options(),
                "command": command_spec(command),
                "errorSchema": error_schema(),
                "errorBehavior": "Success and error records are one JSON object on stdout; nonzero exit indicates failure.",
                "mutationRules": [
                    "Mutations require the current expected revision and a correlated operationReceipt.",
                    "Never retry outcome_unknown; a later invocation resolves its durable correlation.",
                    "still_pending forbids another mutation until the outstanding request is resolved."
                ]
            }
        }));
    }

    let mut commands = Command::ALL
        .iter()
        .map(|command| {
            let spec = command_spec(*command);
            json!({
                "name": spec["name"],
                "route": spec["route"],
                "effect": spec["effect"],
                "summary": spec["summary"],
            })
        })
        .collect::<Vec<_>>();
    commands.extend(annotation_actions().iter().map(|action| {
        let spec = annotation_command_spec(action);
        json!({
            "name": spec["name"],
            "route": spec["route"],
            "effect": spec["effect"],
            "summary": spec["summary"],
        })
    }));
    Ok(json!({
        "ok": true,
        "command": "help",
        "result": {
            "usage": [
                "surf-ace help [COMMAND]",
                "surf-ace schema COMMAND",
                "surf-ace --help [COMMAND]",
                "surf-ace --schema COMMAND",
                "surf-ace COMMAND --help"
            ],
            "format": "Help and schema output are JSON and require no endpoint, registry, or state root.",
            "globalOptions": global_options(),
            "commands": commands,
            "errorSchema": error_schema(),
            "errorBehavior": "Success and error records are one JSON object on stdout; nonzero exit indicates failure.",
            "discoveryLimits": [
                "fleet-list reads registry inventory only; it has no direct endpoint, freshness, or reachability evidence.",
                "window-describe reads fleet.topology, sends one nonce-correlated surface.describe to the leased direct endpoint before pairing, then rechecks fleet.topology; identity matching is consistency only and does not authenticate either peer.",
                "list and capture-pane pair a controller before their direct request; they are not no-pair discovery probes.",
                "window-describe does not pair, create controller state, or authorize later mutations; writes still need their own explicit endpoint and revision guards."
            ],
            "mutationRules": [
                "Mutations require the current expected revision and a correlated operationReceipt.",
                "topology-realize requires an explicit allowDestroyPaneIds list for pane removal.",
                "Never retry outcome_unknown; a later invocation resolves its durable correlation.",
                "still_pending forbids another mutation until the outstanding request is resolved."
            ]
        }
    }))
}

fn annotation_actions() -> &'static [&'static str] {
    &["watch", "resume", "ack", "retire"]
}

fn annotation_group_document() -> Value {
    let commands = annotation_actions()
        .iter()
        .map(|action| {
            let spec = annotation_command_spec(action);
            json!({
                "name": spec["name"],
                "route": spec["route"],
                "effect": spec["effect"],
                "summary": spec["summary"],
            })
        })
        .collect::<Vec<_>>();
    json!({
        "ok": true,
        "command": "help",
        "result": {
            "group": "annotations",
            "format": "watch and resume emit newline-delimited JSON records; ack and retire emit one JSON record.",
            "commands": commands,
            "helpUsage": "surf-ace help annotations ACTION",
            "schemaUsage": "surf-ace schema annotations ACTION",
        }
    })
}

fn annotation_command_document(action: &str) -> Result<Value, String> {
    if !annotation_actions().contains(&action) {
        return Err(format!(
            "invalid_input:unknown_help_command:annotations {action}"
        ));
    }
    Ok(json!({
        "ok": true,
        "command": "help",
        "result": {
            "globalOptions": [
                { "name": "--registry", "type": "websocket-url", "required": true, "description": "Annotation registry URL; this command does not connect to a client." },
                { "name": "--state-root", "type": "path", "required": true, "description": "Local durable listener state." },
                { "name": "--consumer-id", "type": "string", "required": true }
            ],
            "command": annotation_command_spec(action),
            "errorSchema": annotation_error_schema(),
            "errorBehavior": "Local validation, response, and transport errors use the listed local codes. Registry refusal codes are forwarded unchanged as error.code, with the full registry error object preserved in error.details. Errors are one JSON object on stdout; nonzero exit indicates failure.",
            "deliveryRules": [
                "watch and resume remain in the foreground and emit NDJSON; receiving a record does not acknowledge it.",
                "watch requires a new consumer ID and creates a durable registry consumer and lease; an existing ID is refused.",
                "resume requires an existing registry consumer ID, replaces and fences its prior lease, and may close another live listener using that same ID; a locally stored lease is not required to request resume.",
                "Ack only after the record has been durably processed; history gaps require the exact gapId.",
                "retire requires an explicit expected acknowledgement cursor and --discard-unacknowledged."
            ]
        }
    }))
}

fn annotation_command_spec(action: &str) -> Value {
    let (effect, summary, wire_operation, result_description) = match action {
        "watch" => (
            "registry_consumer_create_and_lease_acquire_and_local_state_write",
            "Create a new durable registry consumer and open its foreground subscription, optionally from an explicit cursor; the consumer ID must be unused.",
            json!("annotation.watch"),
            "NDJSON: one subscription record followed by annotation event records until a terminal event.",
        ),
        "resume" => (
            "registry_consumer_lease_replace_and_local_state_write_may_close_prior_listener",
            "Resume an existing registry consumer with a replacement lease; this fences its prior lease and may close another live listener using the same ID.",
            json!("annotation.resume"),
            "NDJSON: one subscription record followed by annotation event records until a terminal event.",
        ),
        "ack" => (
            "registry_acknowledgement_and_local_state_write",
            "Acknowledge a processed cursor or explicitly resolve one history gap.",
            json!(["annotation.ack", "annotation.gap.ack"]),
            "One JSON annotation.ack record after the registry confirms the acknowledgement.",
        ),
        "retire" => (
            "registry_consumer_retirement_and_local_state_write",
            "Retire the annotation consumer with an exact expected acknowledgement cursor.",
            json!("annotation.consumer.retire"),
            "One JSON annotation.consumer_retired record after the registry confirms retirement.",
        ),
        _ => unreachable!("action checked by caller"),
    };
    let mut spec = json!({
        "name": format!("annotations {action}"),
        "route": "registry",
        "effect": effect,
        "summary": summary,
        "wireOperation": wire_operation,
        "inputSchema": annotation_input_schema(action),
        "resultSchema": annotation_result_schema(action, result_description),
        "errorSchema": annotation_error_schema(),
        "errors": annotation_error_codes(),
        "errorContract": {
            "localCodes": annotation_local_error_codes(),
            "registryCodes": annotation_registry_error_codes(),
            "registryCodesForwardedUnchanged": true,
            "registryErrorObjectPreservedAt": "error.details"
        },
        "examples": annotation_examples(action),
    });
    match action {
        "watch" => {
            spec["consumerLifecycle"] = json!({
                "consumerIdRequirement": "new_unused_registry_id",
                "registryConsumer": "create",
                "lease": "acquire",
                "localState": "write_after_registry_success",
                "replacesPriorSameIdLease": false,
                "mayClosePriorSameIdListener": false
            });
        }
        "resume" => {
            spec["consumerLifecycle"] = json!({
                "consumerIdRequirement": "existing_registry_id",
                "registryConsumer": "reuse",
                "lease": "replace_and_fence_prior",
                "localState": "write_after_registry_success",
                "replacesPriorSameIdLease": true,
                "mayClosePriorSameIdListener": true
            });
        }
        _ => {}
    }
    spec
}

fn annotation_local_error_codes() -> &'static [&'static str] {
    &[
        "annotation_invalid_request",
        "annotation_invalid_response",
        "annotation_transport_failure",
    ]
}

fn annotation_registry_error_codes() -> &'static [&'static str] {
    &[
        "annotation_invalid_request",
        "annotation_protocol_unsupported",
        "annotation_role_operation_invalid",
        "annotation_cursor_invalid",
        "annotation_context_image_invalid",
        "annotation_record_too_large",
        "annotation_source_event_conflict",
        "annotation_source_sequence_conflict",
        "annotation_source_gap_required",
        "annotation_source_gap_invalid",
        "annotation_source_sequence_exhausted",
        "annotation_ingest_capacity",
        "annotation_journal_sequence_exhausted",
        "annotation_consumer_capacity",
        "annotation_consumer_exists",
        "annotation_consumer_not_found",
        "annotation_consumer_lease_stale",
        "annotation_ack_regression",
        "annotation_ack_not_delivered",
        "annotation_ack_cursor_mismatch",
        "annotation_gap_ack_required",
        "annotation_gap_id_mismatch",
        "annotation_consumer_retire_confirmation_required",
        "annotation_journal_unverified",
        "writer_fence_unavailable",
        "persistence_failed",
        "internal_error",
    ]
}

fn annotation_error_codes() -> Vec<&'static str> {
    let mut codes = annotation_local_error_codes().to_vec();
    codes.extend(annotation_registry_error_codes().iter().copied());
    codes.sort_unstable();
    codes.dedup();
    codes
}

fn annotation_input_schema(action: &str) -> Value {
    let base_properties = json!({
        "registry": { "type": "string", "pattern": "^ws://", "description": "CLI flag --registry" },
        "stateRoot": { "type": "string", "minLength": 1, "description": "CLI flag --state-root" },
        "consumerId": { "type": "string", "minLength": 1, "maxLength": 128, "description": "CLI flag --consumer-id" }
    });
    let base_required = ["registry", "stateRoot", "consumerId"];
    match action {
        "watch" => object_with_flags(
            &["registry", "stateRoot", "consumerId"],
            json!({
                "registry": base_properties["registry"], "stateRoot": base_properties["stateRoot"],
                "consumerId": base_properties["consumerId"], "from": cursor_schema(false)
            }),
        ),
        "resume" => object_with_flags(&base_required, base_properties),
        "ack" => {
            let base_and_cursor = json!({
                "type": "object", "required": ["registry", "stateRoot", "consumerId", "cursor"],
                "properties": {
                    "registry": base_properties["registry"], "stateRoot": base_properties["stateRoot"],
                    "consumerId": base_properties["consumerId"], "cursor": cursor_schema(false)
                }, "additionalProperties": false
            });
            let base_and_gap = json!({
                "type": "object", "required": ["registry", "stateRoot", "consumerId", "gapId"],
                "properties": {
                    "registry": base_properties["registry"], "stateRoot": base_properties["stateRoot"],
                    "consumerId": base_properties["consumerId"],
                    "gapId": { "type": "string", "minLength": 1, "maxLength": 128 }
                }, "additionalProperties": false
            });
            json!({ "$schema": "https://json-schema.org/draft/2020-12/schema", "oneOf": [base_and_cursor, base_and_gap], "description": "Pass exactly one of --cursor or --gap-id." })
        }
        "retire" => object_with_flags(
            &[
                "registry",
                "stateRoot",
                "consumerId",
                "expectedAck",
                "discardUnacknowledged",
            ],
            json!({
                "registry": base_properties["registry"], "stateRoot": base_properties["stateRoot"],
                "consumerId": base_properties["consumerId"],
                "expectedAck": { "anyOf": [{ "const": "none" }, cursor_schema(true)], "description": "CLI flag --expect-ack" },
                "discardUnacknowledged": { "const": true, "description": "CLI flag --discard-unacknowledged" }
            }),
        ),
        _ => unreachable!("action checked by caller"),
    }
}

fn object_with_flags(required: &[&str], properties: Value) -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "description": "Normalized CLI flag values; these commands do not accept --input-json.",
        "required": required,
        "properties": properties,
        "additionalProperties": false
    })
}

fn cursor_schema(allow_zero: bool) -> Value {
    let sequence = if allow_zero {
        "(?:0|[1-9][0-9]*)"
    } else {
        "[1-9][0-9]*"
    };
    json!({
        "type": "string",
        "pattern": format!("^ann1:[0-9a-f]{{32}}:{sequence}$"),
        "description": "Canonical ann1 cursor. The numeric sequence must not exceed 9223372036854775807."
    })
}

fn annotation_result_schema(action: &str, description: &str) -> Value {
    match action {
        "watch" | "resume" => json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "oneOf": [
                { "type": "object", "required": ["type", "consumerId", "leaseId", "historyCompleteSinceStart", "replayPolicy"], "properties": { "type": { "const": "annotation.subscription" }, "consumerId": { "type": "string" }, "leaseId": { "type": "string" }, "ackCursor": { "type": ["string", "null"] }, "historyCompleteSinceStart": { "type": "boolean" }, "replayPolicy": { "type": "object" } }, "additionalProperties": true },
                { "type": "object", "required": ["type", "op", "eventId", "payload"], "properties": { "type": { "const": "event" }, "op": { "type": "string", "pattern": "^annotation\\." }, "eventId": { "type": "string" }, "payload": { "type": "object" } }, "additionalProperties": true }
            ], "description": description, "x-cli-output-format": "ndjson"
        }),
        "ack" => json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object", "required": ["type", "consumerId", "ackCursor"],
            "properties": { "type": { "const": "annotation.ack" }, "consumerId": { "type": "string" }, "ackCursor": { "type": ["string", "null"] }, "gapId": { "type": ["string", "null"] } },
            "additionalProperties": false, "description": description
        }),
        "retire" => json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object", "required": ["type", "payload"],
            "properties": { "type": { "const": "annotation.consumer_retired" }, "payload": { "type": "object" } },
            "additionalProperties": false, "description": description
        }),
        _ => unreachable!("action checked by caller"),
    }
}

fn annotation_error_schema() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object", "required": ["ok", "error"],
        "properties": {
            "ok": { "const": false },
            "error": { "type": "object", "required": ["code", "details"], "properties": { "code": { "enum": annotation_error_codes() }, "details": { "type": "object" } }, "additionalProperties": false }
        }, "additionalProperties": false
    })
}

fn annotation_examples(action: &str) -> Value {
    match action {
        "watch" => json!(["surf-ace --registry ws://127.0.0.1:7331 --state-root \"$STATE_ROOT\" annotations watch --consumer-id reviewer"]),
        "resume" => json!(["surf-ace --registry ws://127.0.0.1:7331 --state-root \"$STATE_ROOT\" annotations resume --consumer-id reviewer"]),
        "ack" => json!([
            "surf-ace --registry ws://127.0.0.1:7331 --state-root \"$STATE_ROOT\" annotations ack --consumer-id reviewer --cursor ann1:0123456789abcdef0123456789abcdef:3",
            "surf-ace --registry ws://127.0.0.1:7331 --state-root \"$STATE_ROOT\" annotations ack --consumer-id reviewer --gap-id gap_1"
        ]),
        "retire" => json!(["surf-ace --registry ws://127.0.0.1:7331 --state-root \"$STATE_ROOT\" annotations retire --consumer-id reviewer --expect-ack none --discard-unacknowledged"]),
        _ => json!([]),
    }
}

fn global_options() -> Value {
    json!([
        { "name": "--state-root", "type": "path", "required": true, "appliesTo": "stateful operational commands; window-describe is stateless" },
        { "name": "--registry", "type": "websocket-url", "requiredFor": ["fleet-list", "window-describe"], "exclusiveWith": ["--endpoint"] },
        { "name": "--endpoint", "type": "websocket-url", "requiredFor": "direct-client commands", "exclusiveWith": ["--registry"] },
        { "name": "--product-label", "type": "string", "requiredFor": "direct-client commands", "description": "Descriptive provenance; not identity or authority." },
        { "name": "--input-json", "type": "object", "description": "One command input object; standard input is used when omitted." },
        { "name": "--projection-capacity-bytes", "type": "integer", "default": 16777216 }
    ])
}

fn command_spec(command: Command) -> Value {
    let name = command.name();
    let (route, effect, summary, result_description, extra_errors) = match command {
        Command::FleetList => (
            "registry",
            "registry_inventory_read",
            "Read registered client, window, and pane labels from the explicitly selected registry.",
            "Registry fleet.topology payload with clients, registryIdentity, and registrationReady; it does not contain direct endpoints or prove client reachability.",
            vec!["missing_registry", "invalid_registry", "invalid_fleet_topology_clients"],
        ),
        Command::WindowDescribe => (
            "registry-and-direct-client",
            "registry_leased_read_only_pre_pair_probe",
            "Resolve exactly one current registry lease for a named window, read it directly before pairing, and recheck the registry row.",
            "Separate registry identity, registration and lease freshness, direct transport reachability, client application readiness, topology/layout, and per-pane content revision evidence. This is consistency only, does not authenticate either peer, and does not authorize a later mutation.",
            vec![
                "missing_registry", "invalid_registry", "registry_timeout", "registry_unreachable",
                "registry_response_invalid", "window_not_found", "window_ambiguous", "endpoint_unconfigured", "stale_registration",
                "endpoint_unreachable", "application_unresponsive", "describe_timeout", "describe_response_too_large",
                "describe_response_invalid", "prepair_describe_unsupported", "identity_mismatch",
                "revision_churn", "client_not_ready", "unsupported_protocol_version", "clock_unavailable",
            ],
        ),
        Command::List => (
            "direct-client",
            "paired_direct_read",
            "List the selected endpoint's live surfaces.",
            "surfaces.list payload. This command sends pair.request first, which admits the controller and may persist client state.",
            vec!["missing_endpoint", "missing_product_label", "lifecycle_pair_mismatch"],
        ),
        Command::PaneDescribe => (
            "direct-client",
            "paired_surface_read_with_admission",
            "Describe one pane using the controller identity in an existing state root and a single paired panes.list response.",
            "Use the same --state-root as the controller whose expectedControllerInstanceId you supply. The selected pane's lineage and currentTarget are taken from one panes.list response; targetEpoch is copied from currentTarget or null when no target is present. The command sends pair.request for the selected surface and may persist admission, synchronization, cursor, acknowledgement, or pending-receipt reconciliation state. It can be refused if that controller identity already has a live session. It does not change pane layout or content, and the observation is not an atomic guarantee of future validity.",
            vec![
                "missing_endpoint",
                "missing_product_label",
                "state_root_not_initialized",
                "controller_instance_mismatch",
                "duplicate_controller_instance",
                "surface_pair_mismatch",
                "pane_not_found",
                "not_paired",
            ],
        ),
        Command::Push => (
            "direct-client",
            "client_mutation",
            "Set typed content in one explicit pane.",
            "Correlated content.set result and operationReceipt.",
            vec!["missing_endpoint", "missing_product_label", "outcome_unknown", "still_pending"],
        ),
        Command::Read => (
            "local-projection",
            "local_projection_read",
            "Read the local event projection for one pane scope.",
            "Current local content record and unread records for scopeId. This advances the local projected cursor and may persist an acknowledgement intent; it does not contact a client.",
            vec!["state_error", "invalid_input:scopeId"],
        ),
        Command::TopologyIntent => (
            "direct-client",
            "client_mutation",
            "Split, close, restore, or rename a pane using the current topology revision.",
            "Correlated pane operation result and operationReceipt.",
            vec!["missing_endpoint", "missing_product_label", "stale_revision", "outcome_unknown", "still_pending"],
        ),
        Command::TopologyRealize => (
            "direct-client",
            "client_mutation_destructive",
            "Replace a root or pane subtree with a validated desired topology.",
            "Correlated topology.apply result with the new topologyRevision and pane assignments.",
            vec!["missing_endpoint", "missing_product_label", "stale_revision", "outcome_unknown", "still_pending"],
        ),
        Command::Clear => (
            "direct-client",
            "client_mutation_destructive",
            "Clear content from one explicit pane using its current content revision.",
            "Correlated content.clear result with the new revision and operationReceipt.",
            vec!["missing_endpoint", "missing_product_label", "stale_revision", "outcome_unknown", "still_pending"],
        ),
        Command::AnnotationsRemove => (
            "direct-client",
            "client_mutation",
            "Remove selected annotation strokes from one pane and content.",
            "Correlated annotations.remove result and operationReceipt.",
            vec!["missing_endpoint", "missing_product_label", "stale_content", "outcome_unknown", "still_pending"],
        ),
        Command::CapturePane => (
            "direct-client",
            "paired_snapshot_read",
            "Capture one pane as a PNG snapshot.",
            "snapshot.get payload including the PNG image and pane revision. This command sends pair.request first and has no image-suppression option.",
            vec!["missing_endpoint", "missing_product_label", "render_failed"],
        ),
        Command::SurfaceIntent => (
            "direct-client",
            "client_mutation_lifecycle",
            "Open, close, or restore a window using the current surface-set and topology revisions.",
            "Correlated surface lifecycle result and operationReceipt.",
            vec!["missing_endpoint", "missing_product_label", "stale_revision", "outcome_unknown", "still_pending"],
        ),
        Command::TargetRegister => (
            "direct-client",
            "client_mutation",
            "Register a target intent with an explicit epoch and idempotency key.",
            "Correlated target.register result and operationReceipt.",
            vec!["missing_endpoint", "missing_product_label", "outcome_unknown", "still_pending"],
        ),
        Command::TargetApply => (
            "direct-client",
            "client_mutation",
            "Apply one registered target intent using its exact request, target, and epoch identities.",
            "Correlated target.apply intent receipt; later materialization outcome is reported separately by the client.",
            vec!["missing_endpoint", "missing_product_label", "outcome_unknown", "still_pending"],
        ),
    };

    let mut errors = vec![
        "invalid_input",
        "protocol_error",
        "operation_rejected",
        "transport_error",
        "state_error",
    ]
    .into_iter()
    .map(Value::from)
    .collect::<Vec<_>>();
    errors.extend(extra_errors.into_iter().map(Value::from));
    json!({
        "name": name,
        "route": route,
        "effect": effect,
        "summary": summary,
        "wireOperation": wire_operation(command),
        "inputSchema": published_input_schema(command),
        "resultSchema": result_schema(command, result_description),
        "errorSchema": error_schema(),
        "errors": errors,
        "examples": examples(command),
    })
}

fn published_input_schema(command: Command) -> Value {
    let mut schema = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": format!("surf-ace {} input", command.name()),
        "allOf": [input_schema(command)]
    });
    if command == Command::TopologyRealize {
        schema["$defs"] = json!({ "topology": topology_node_schema() });
    }
    schema
}

fn wire_operation(command: Command) -> Value {
    match command {
        Command::FleetList => json!("fleet.topology"),
        Command::WindowDescribe => json!(["fleet.topology", "surface.describe", "fleet.topology"]),
        Command::List => json!("surfaces.list"),
        Command::PaneDescribe => json!(["pair.request", "panes.list"]),
        Command::Push => json!("content.set"),
        Command::Read => json!("local projection; no network operation"),
        Command::TopologyIntent => {
            json!({ "split": "pane.split", "close": "pane.close", "restore": "pane.restore", "rename": "pane.rename" })
        }
        Command::TopologyRealize => json!("topology.apply"),
        Command::Clear => json!("content.clear"),
        Command::AnnotationsRemove => json!("annotations.remove"),
        Command::CapturePane => json!("snapshot.get"),
        Command::SurfaceIntent => {
            json!({ "open": "surface.window.open", "close": "surface.window.close", "restore": "surface.window.restore" })
        }
        Command::TargetRegister => json!("target.register"),
        Command::TargetApply => json!("target.apply"),
    }
}

fn input_schema(command: Command) -> Value {
    match command {
        Command::FleetList | Command::List => object(&[], json!({}), false),
        Command::WindowDescribe => object(
            &["windowLabel"],
            json!({ "windowLabel": { "type": "string", "minLength": 1, "maxLength": 64, "pattern": "^[a-z]+$" } }),
            false,
        ),
        Command::PaneDescribe => object(
            &["expectedControllerInstanceId", "surfaceId", "paneId"],
            json!({
                "expectedControllerInstanceId": string_schema(),
                "surfaceId": string_schema(),
                "paneId": positive_integer_schema()
            }),
            false,
        ),
        Command::Push => {
            let common = json!({
                "surfaceId": string_schema(),
                "paneId": positive_integer_schema(),
                "contentId": string_schema(),
                "contentType": { "enum": ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"] },
                "content": {},
                "display": object_schema_any(),
                "friendlyChatName": string_schema()
            });
            let content_variants = json!([
                { "properties": { "contentType": { "const": "html" }, "content": { "type": "object", "required": ["html"], "properties": { "html": { "type": "string" }, "baseUrl": { "type": "string" } }, "additionalProperties": false } } },
                { "properties": { "contentType": { "const": "image" }, "content": { "type": "object", "required": ["data", "mediaType"], "properties": { "data": { "type": "string" }, "mediaType": { "type": "string" }, "alt": { "type": "string" } }, "additionalProperties": false } } },
                { "properties": { "contentType": { "const": "pdf" }, "content": { "type": "object", "required": ["data"], "properties": { "data": { "type": "string" } }, "additionalProperties": false } } },
                { "properties": { "contentType": { "const": "terminal" }, "content": { "type": "object", "required": ["lines", "scrollback"], "properties": { "lines": { "type": "array", "items": { "type": "string" } }, "scrollback": nonnegative_integer_schema() }, "additionalProperties": false } } },
                { "properties": { "contentType": { "const": "markdown" }, "content": { "type": "object", "required": ["markdown"], "properties": { "markdown": { "type": "string" } }, "additionalProperties": false } } },
                { "properties": { "contentType": { "const": "video" }, "content": { "type": "string" } } },
                { "properties": { "contentType": { "const": "canvas" }, "content": { "anyOf": [{ "const": "" }, { "type": "object", "properties": { "color": { "type": "string" }, "grid": { "type": "boolean" } }, "additionalProperties": false }] } } }
            ]);
            object_with_all_of(
                &["surfaceId", "paneId", "contentId", "contentType", "content"],
                common,
                json!([{ "oneOf": content_variants }]),
            )
        }
        Command::Read => object(&["scopeId"], json!({ "scopeId": string_schema() }), false),
        Command::TopologyIntent => json!({
            "oneOf": [
                object(&["surfaceId", "action", "paneId", "count", "direction", "expectedTopologyRevision"], json!({ "surfaceId": string_schema(), "action": { "const": "split" }, "paneId": positive_integer_schema(), "count": { "type": "integer", "minimum": 2, "maximum": SAFE_INTEGER_MAX }, "direction": direction_schema(), "expectedTopologyRevision": nonnegative_integer_schema() }), false),
                object(&["surfaceId", "action", "paneId", "expectedTopologyRevision"], json!({ "surfaceId": string_schema(), "action": { "const": "close" }, "paneId": positive_integer_schema(), "expectedTopologyRevision": nonnegative_integer_schema() }), false),
                object(&["surfaceId", "action", "anchorPaneId", "tombstoneId", "direction", "expectedTopologyRevision"], json!({ "surfaceId": string_schema(), "action": { "const": "restore" }, "anchorPaneId": positive_integer_schema(), "tombstoneId": string_schema(), "direction": direction_schema(), "expectedTopologyRevision": nonnegative_integer_schema() }), false),
                object(&["surfaceId", "action", "paneId", "name", "expectedTopologyRevision"], json!({ "surfaceId": string_schema(), "action": { "const": "rename" }, "paneId": positive_integer_schema(), "name": { "type": ["string", "null"] }, "expectedTopologyRevision": nonnegative_integer_schema() }), false)
            ]
        }),
        Command::TopologyRealize => object(
            &[
                "surfaceId",
                "expectedTopologyRevision",
                "target",
                "desired",
                "allowDestroyPaneIds",
            ],
            json!({
                "surfaceId": string_schema(),
                "expectedTopologyRevision": nonnegative_integer_schema(),
                "target": { "anyOf": [{ "type": "object", "required": ["root"], "properties": { "root": { "const": true } }, "additionalProperties": true }, { "type": "object", "required": ["paneId"], "properties": { "paneId": positive_integer_schema() }, "additionalProperties": true }] },
                "desired": desired_topology_schema(),
                "allowDestroyPaneIds": { "type": "array", "items": positive_integer_schema() }
            }),
            false,
        ),
        Command::Clear => object(
            &["surfaceId", "paneId", "expectedRevision"],
            json!({ "surfaceId": string_schema(), "paneId": positive_integer_schema(), "expectedRevision": nonnegative_integer_schema() }),
            false,
        ),
        Command::AnnotationsRemove => object(
            &["surfaceId", "paneId", "contentId", "strokeIds"],
            json!({ "surfaceId": string_schema(), "paneId": positive_integer_schema(), "contentId": string_schema(), "strokeIds": { "type": "array", "items": string_schema() } }),
            false,
        ),
        Command::CapturePane => object(
            &["surfaceId", "paneId"],
            json!({ "surfaceId": string_schema(), "paneId": positive_integer_schema(), "includeDrawings": { "type": "boolean" } }),
            false,
        ),
        Command::SurfaceIntent => json!({
            "oneOf": [
                object(&["action", "expectedSurfaceSetRevision"], json!({ "action": { "const": "open" }, "expectedSurfaceSetRevision": nonnegative_integer_schema(), "placement": object_schema_any() }), false),
                object(&["action", "expectedSurfaceSetRevision", "surfaceId", "expectedTopologyRevision"], json!({ "action": { "const": "close" }, "expectedSurfaceSetRevision": nonnegative_integer_schema(), "surfaceId": string_schema(), "expectedTopologyRevision": nonnegative_integer_schema() }), false),
                object(&["action", "expectedSurfaceSetRevision", "tombstoneId"], json!({ "action": { "const": "restore" }, "expectedSurfaceSetRevision": nonnegative_integer_schema(), "tombstoneId": string_schema(), "placement": object_schema_any() }), false)
            ]
        }),
        Command::TargetRegister => object(
            &[
                "surfaceId",
                "idempotencyKey",
                "expectedPreviousTargetEpoch",
                "launchedAt",
                "registrationState",
                "targetKind",
                "targetHeader",
                "targetPayload",
            ],
            json!({
                "surfaceId": string_schema(), "idempotencyKey": string_schema(),
                "expectedPreviousTargetEpoch": { "type": ["integer", "null"], "minimum": 0, "maximum": SAFE_INTEGER_MAX },
                "launchedAt": { "type": "string", "format": "date-time" },
                "registrationState": { "enum": ["before_attach", "attached"] },
                "targetKind": string_schema(), "targetHeader": object_schema_any(), "targetPayload": {},
                "paneId": positive_integer_schema(), "paneLineageId": string_schema(), "restorePolicy": { "type": "string" }
            }),
            false,
        ),
        Command::TargetApply => object(
            &[
                "surfaceId",
                "requestId",
                "restoreReason",
                "targetId",
                "targetEpoch",
                "targetKind",
                "targetHeader",
                "targetPayload",
            ],
            json!({
                "surfaceId": string_schema(), "requestId": string_schema(), "restoreReason": { "type": "string" },
                "targetId": string_schema(), "targetEpoch": positive_integer_schema(), "targetKind": string_schema(),
                "targetHeader": object_schema_any(), "targetPayload": {}, "paneId": positive_integer_schema(),
                "paneLineageId": string_schema(), "display": object_schema_any()
            }),
            false,
        ),
    }
}

fn object(required: &[&str], properties: Value, additional: bool) -> Value {
    json!({ "type": "object", "required": required, "properties": properties, "additionalProperties": additional })
}

fn object_with_all_of(required: &[&str], properties: Value, all_of: Value) -> Value {
    json!({ "type": "object", "required": required, "properties": properties, "additionalProperties": false, "allOf": all_of })
}

fn string_schema() -> Value {
    json!({ "type": "string", "minLength": 1 })
}

fn positive_integer_schema() -> Value {
    json!({ "type": "integer", "minimum": 1, "maximum": SAFE_INTEGER_MAX })
}

fn nonnegative_integer_schema() -> Value {
    json!({ "type": "integer", "minimum": 0, "maximum": SAFE_INTEGER_MAX })
}

fn direction_schema() -> Value {
    json!({ "enum": ["horizontal", "vertical"] })
}

fn object_schema_any() -> Value {
    json!({ "type": "object" })
}

fn desired_topology_schema() -> Value {
    json!({ "$ref": "#/$defs/topology" })
}

fn topology_node_schema() -> Value {
    json!({
        "oneOf": [
            { "type": "object", "required": ["type"], "properties": { "type": { "const": "pane" }, "paneId": positive_integer_schema() }, "additionalProperties": true },
            { "type": "object", "required": ["type", "direction", "children"], "properties": { "type": { "const": "split" }, "direction": direction_schema(), "children": { "type": "array", "minItems": 2, "items": { "$ref": "#/$defs/topology" } } }, "additionalProperties": true }
        ]
    })
}

fn result_schema(command: Command, description: &str) -> Value {
    let result = if command == Command::WindowDescribe {
        json!({
            "description": description,
            "type": "object",
            "required": ["windowLabel", "identitySemantics", "transportReachability", "registryBefore", "registryAfter", "applicationReadiness", "surfaceObservation"],
            "properties": {
                "windowLabel": { "type": "string", "pattern": "^[a-z]+$" },
                "identitySemantics": { "const": "consistency_only_not_authentication" },
                "transportReachability": {
                    "type": "object", "required": ["status", "directEndpoint", "observedAtMs"],
                    "properties": { "status": { "const": "reachable" }, "directEndpoint": { "type": "string", "format": "uri" }, "observedAtMs": nonnegative_integer_schema() },
                    "additionalProperties": false
                },
                "registryBefore": registry_candidate_schema(),
                "registryAfter": registry_candidate_schema(),
                "applicationReadiness": {
                    "type": "object", "required": ["status", "limitationCodes"],
                    "properties": { "status": { "enum": ["ready", "degraded"] }, "limitationCodes": { "type": "array", "items": { "type": "string", "pattern": "^[a-z_]{1,64}$" } } },
                    "additionalProperties": false
                },
                "surfaceObservation": {
                    "type": "object", "required": ["nonce", "clientId", "registryIdentity", "surfaceId", "endpointLeaseGeneration", "observedAtMs", "applicationReadiness", "surfaceSetRevision", "topologyRevision", "layout", "panes"],
                    "properties": {
                        "nonce": { "type": "string", "pattern": "^[a-f0-9]{32,128}$" },
                        "clientId": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
                        "registryIdentity": { "type": "object", "required": ["allocatorId", "fleetId"], "properties": { "allocatorId": string_schema(), "fleetId": string_schema() }, "additionalProperties": false },
                        "surfaceId": string_schema(), "endpointLeaseGeneration": positive_integer_schema(),
                        "observedAtMs": nonnegative_integer_schema(), "applicationReadiness": { "type": "object" },
                        "surfaceSetRevision": nonnegative_integer_schema(), "topologyRevision": nonnegative_integer_schema(),
                        "layout": { "type": "object" },
                        "panes": { "type": "array", "minItems": 1, "items": { "type": "object", "required": ["paneId", "paneLabel", "contentObservation"], "properties": { "paneId": positive_integer_schema(), "paneLabel": { "type": ["integer", "null"], "minimum": 1, "maximum": SAFE_INTEGER_MAX }, "contentObservation": { "type": "object", "required": ["revision", "source", "observedAtMs"], "properties": { "revision": { "type": ["integer", "null"], "minimum": 0, "maximum": SAFE_INTEGER_MAX }, "source": { "const": "client-authority" }, "observedAtMs": nonnegative_integer_schema() }, "additionalProperties": false } }, "additionalProperties": false } }
                    },
                    "additionalProperties": false
                }
            },
            "additionalProperties": false
        })
    } else if command == Command::PaneDescribe {
        json!({
            "description": description,
            "type": "object",
            "required": ["surfaceId", "paneId", "paneLineageId", "currentTarget", "targetEpoch"],
            "properties": {
                "surfaceId": string_schema(),
                "paneId": positive_integer_schema(),
                "paneLineageId": { "type": "string", "minLength": 1 },
                "currentTarget": {
                    "anyOf": [
                        { "type": "null" },
                        {
                            "type": "object",
                            "required": ["paneLineageId", "targetEpoch", "currentState", "targetId", "targetKind"],
                            "properties": {
                                "paneLineageId": { "type": "string", "minLength": 1 },
                                "targetEpoch": positive_integer_schema(),
                                "currentState": { "enum": ["current", "stale", "superseded", "tombstoned"] },
                                "targetId": string_schema(),
                                "targetKind": string_schema()
                            },
                            "additionalProperties": true
                        }
                    ]
                },
                "targetEpoch": { "anyOf": [positive_integer_schema(), { "type": "null" }] }
            },
            "additionalProperties": false
        })
    } else {
        json!({ "type": "object", "description": description })
    };
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["ok", "command", "result"],
        "properties": {
            "ok": { "const": true },
            "command": { "const": command.name() },
            "controllerInstanceId": { "type": "string" },
            "reconciliations": { "type": "array", "items": { "type": "object" } },
            "result": result
        },
        "additionalProperties": false
    })
}

fn registry_candidate_schema() -> Value {
    json!({
        "type": "object",
        "required": ["clientId", "surfaceId", "windowLabel", "directEndpoint", "registryIdentity", "registryServerTimeMs", "maxEndpointLeaseMs", "registrationReady", "endpointLease"],
        "properties": {
            "clientId": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
            "surfaceId": string_schema(),
            "windowLabel": { "type": "string", "pattern": "^[a-z]+$" },
            "directEndpoint": { "type": "string", "format": "uri" },
            "registryIdentity": { "type": "object", "required": ["allocatorId", "fleetId"], "properties": { "allocatorId": string_schema(), "fleetId": string_schema() }, "additionalProperties": false },
            "registryServerTimeMs": nonnegative_integer_schema(),
            "maxEndpointLeaseMs": positive_integer_schema(),
            "registrationReady": { "type": "boolean" },
            "endpointLease": { "type": "object", "required": ["leaseGeneration", "registrationObservedAtMs", "leaseExpiresAtMs"], "properties": { "leaseGeneration": positive_integer_schema(), "registrationObservedAtMs": nonnegative_integer_schema(), "leaseExpiresAtMs": positive_integer_schema() }, "additionalProperties": false }
        },
        "additionalProperties": false
    })
}

fn error_schema() -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["ok", "error"],
        "properties": {
            "ok": { "const": false },
            "error": { "type": "object", "required": ["code", "details"], "properties": { "code": { "enum": ["invalid_input", "outcome_unknown", "protocol_error", "operation_rejected", "state_error", "still_pending", "transport_error", "json_error", "registry_timeout", "registry_unreachable", "registry_response_invalid", "window_not_found", "window_ambiguous", "endpoint_unconfigured", "stale_registration", "endpoint_unreachable", "application_unresponsive", "describe_timeout", "describe_response_too_large", "describe_response_invalid", "prepair_describe_unsupported", "identity_mismatch", "revision_churn", "client_not_ready", "unsupported_protocol_version", "clock_unavailable"] }, "details": { "type": "object" } }, "additionalProperties": false }
        },
        "additionalProperties": false
    })
}

fn examples(command: Command) -> Value {
    match command {
        Command::WindowDescribe => json!([{
            "purpose": "Read-only consistency probe. No pairing or local controller state is created; registry identity matching is not authentication.",
            "input": { "windowLabel": "a" },
            "command": "surf-ace --registry ws://registry.example:7331 --input-json '{\"windowLabel\":\"a\"}' window-describe"
        }]),
        Command::PaneDescribe => json!([{
            "purpose": "Fixture-only. Reuse the controller identity in this state root; targetEpoch is null when this response has no currentTarget.",
            "input": {
                "expectedControllerInstanceId": "ctl_fixture",
                "surfaceId": "sf_fixture",
                "paneId": 1
            }
        }]),
        Command::TopologyRealize => json!([{
            "purpose": "Fixture-only replacement with three vertical panes; the integer values are examples, not live revisions.",
            "input": three_vertical_pane_example()
        }]),
        Command::Clear => json!([
            { "purpose": "Replace expectedRevision with this pane's current local read revision.", "input": { "surfaceId": "sf_fixture", "paneId": 1, "expectedRevision": 5 } },
            { "purpose": "Read pane 2 separately; revisions are pane-local.", "input": { "surfaceId": "sf_fixture", "paneId": 2, "expectedRevision": 2 } },
            { "purpose": "Read pane 3 separately; revisions are pane-local.", "input": { "surfaceId": "sf_fixture", "paneId": 3, "expectedRevision": 8 } }
        ]),
        _ => json!([]),
    }
}

fn three_vertical_pane_example() -> Value {
    json!({
        "surfaceId": "sf_fixture",
        "expectedTopologyRevision": 7,
        "target": { "root": true },
        "desired": { "type": "split", "direction": "vertical", "children": [
            { "type": "pane" }, { "type": "pane" }, { "type": "pane" }
        ] },
        "allowDestroyPaneIds": [1, 2, 3]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    #[test]
    fn help_and_schema_are_available_without_operational_arguments() {
        let help = handle_arguments(&["--help".into()]).unwrap().unwrap();
        assert_eq!(
            help["result"]["commands"].as_array().unwrap().len(),
            Command::ALL.len() + annotation_actions().len()
        );
        let schema = handle_arguments(&["schema".into(), "topology-realize".into()])
            .unwrap()
            .unwrap();
        assert_eq!(schema["command"], "schema");
        assert_eq!(schema["result"]["command"]["name"], "topology-realize");
        let flag_schema = handle_arguments(&["--schema".into(), "clear".into()])
            .unwrap()
            .unwrap();
        assert_eq!(flag_schema["command"], "schema");
        assert_eq!(flag_schema["result"]["command"]["name"], "clear");

        let annotation_help =
            handle_arguments(&["annotations".into(), "watch".into(), "--help".into()])
                .unwrap()
                .unwrap();
        assert_eq!(
            annotation_help["result"]["command"]["name"],
            "annotations watch"
        );
        let annotation_schema =
            handle_arguments(&["schema".into(), "annotations".into(), "ack".into()])
                .unwrap()
                .unwrap();
        assert_eq!(
            annotation_schema["result"]["command"]["name"],
            "annotations ack"
        );
        assert_eq!(
            annotation_schema["result"]["command"]["inputSchema"]["oneOf"]
                .as_array()
                .unwrap()
                .len(),
            2,
            "ack requires exactly one of cursor or gapId"
        );
    }

    #[test]
    fn documented_layout_and_per_pane_clear_examples_pass_authoritative_validators() {
        let layout = three_vertical_pane_example();
        assert!(Command::TopologyRealize
            .validate(layout.as_object().unwrap())
            .is_ok());

        let clears = examples(Command::Clear);
        assert_eq!(clears.as_array().unwrap().len(), 3);
        for example in clears.as_array().unwrap() {
            let input = example["input"].as_object().unwrap();
            assert!(Command::Clear.validate(input).is_ok());
        }

        let mut unsafe_layout: Map<String, Value> = layout.as_object().unwrap().clone();
        unsafe_layout.remove("allowDestroyPaneIds");
        assert!(Command::TopologyRealize.validate(&unsafe_layout).is_err());
    }

    #[test]
    fn annotation_examples_and_schema_are_explicit_about_stream_and_retirement_effects() {
        for action in annotation_actions() {
            assert_eq!(
                annotation_examples(action).as_array().unwrap().len(),
                1 + usize::from(*action == "ack")
            );
            let spec = annotation_command_spec(action);
            assert_eq!(spec["route"], "registry");
            assert!(
                spec["inputSchema"]["properties"]["registry"].is_object()
                    || spec["inputSchema"]["oneOf"].is_array()
            );
        }
        assert_eq!(
            annotation_command_spec("watch")["resultSchema"]["x-cli-output-format"],
            "ndjson"
        );
        assert_eq!(
            annotation_command_spec("retire")["effect"],
            "registry_consumer_retirement_and_local_state_write"
        );
    }
}
