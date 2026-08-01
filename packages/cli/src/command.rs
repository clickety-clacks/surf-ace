use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const LEGACY_AUTHORITY_FIELDS: [&str; 12] = [
    "connectionId",
    "historyOwnerToken",
    "initialPaneId",
    "initialPaneLabel",
    "newPaneIds",
    "newPaneLabels",
    "ownershipEpoch",
    "ownershipSessionId",
    "providerId",
    "revision",
    "takeover",
    "windowLabel",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Command {
    List,
    Push,
    Read,
    TopologyIntent,
    TopologyRealize,
    Clear,
    AnnotationsRemove,
    CapturePane,
    SurfaceIntent,
    TargetRegister,
    TargetApply,
}

impl Command {
    pub const ALL: [Self; 11] = [
        Self::List,
        Self::Push,
        Self::Read,
        Self::TopologyIntent,
        Self::TopologyRealize,
        Self::Clear,
        Self::AnnotationsRemove,
        Self::CapturePane,
        Self::SurfaceIntent,
        Self::TargetRegister,
        Self::TargetApply,
    ];

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|command| command.name() == value)
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Push => "push",
            Self::Read => "read",
            Self::TopologyIntent => "topology-intent",
            Self::TopologyRealize => "topology-realize",
            Self::Clear => "clear",
            Self::AnnotationsRemove => "annotations-remove",
            Self::CapturePane => "capture-pane",
            Self::SurfaceIntent => "surface-intent",
            Self::TargetRegister => "target-register",
            Self::TargetApply => "target-apply",
        }
    }

    pub const fn is_local(self) -> bool {
        matches!(self, Self::Read)
    }

    pub const fn is_mutation(self) -> bool {
        !matches!(self, Self::List | Self::Read | Self::CapturePane)
    }

    pub fn wire_operation(self, input: &Map<String, Value>) -> Result<&'static str, String> {
        self.validate(input)?;
        match self {
            Self::List => Ok("surfaces.list"),
            Self::Push => Ok("content.set"),
            Self::Read => Err("read_is_local".into()),
            Self::TopologyIntent => match string(input, "action")? {
                "split" => Ok("pane.split"),
                "close" => Ok("pane.close"),
                "restore" => Ok("pane.restore"),
                "rename" => Ok("pane.rename"),
                _ => Err("invalid_input:action".into()),
            },
            Self::TopologyRealize => Ok("topology.apply"),
            Self::Clear => Ok("content.clear"),
            Self::AnnotationsRemove => Ok("annotations.remove"),
            Self::CapturePane => Ok("snapshot.get"),
            Self::SurfaceIntent => match string(input, "action")? {
                "open" => Ok("surface.window.open"),
                "close" => Ok("surface.window.close"),
                "restore" => Ok("surface.window.restore"),
                _ => Err("invalid_input:action".into()),
            },
            Self::TargetRegister => Ok("target.register"),
            Self::TargetApply => Ok("target.apply"),
        }
    }

    pub fn validate(self, input: &Map<String, Value>) -> Result<(), String> {
        match self {
            Self::List => {
                if !input.is_empty() {
                    return Err("invalid_input:list_properties".into());
                }
            }
            Self::Push => {
                exact_fields(
                    input,
                    &["content", "contentId", "contentType", "paneId", "surfaceId"],
                    &["display", "friendlyChatName"],
                )?;
                required_string(input, "surfaceId")?;
                positive_integer(input, "paneId")?;
                required_string(input, "contentId")?;
                required_string(input, "contentType")?;
                required(input, "content")?;
                optional_object(input, "display")?;
            }
            Self::Read => {
                exact_fields(input, &["scopeId"], &[])?;
                required_string(input, "scopeId")?;
            }
            Self::TopologyIntent => {
                required_string(input, "surfaceId")?;
                nonnegative_integer(input, "expectedTopologyRevision")?;
                match string(input, "action")? {
                    "split" => {
                        exact_fields(
                            input,
                            &[
                                "action",
                                "count",
                                "direction",
                                "expectedTopologyRevision",
                                "paneId",
                                "surfaceId",
                            ],
                            &[],
                        )?;
                        positive_integer(input, "paneId")?;
                        if integer(input, "count")? < 2 {
                            return Err("invalid_input:count".into());
                        }
                        direction(input)?;
                    }
                    "close" => {
                        exact_fields(
                            input,
                            &["action", "expectedTopologyRevision", "paneId", "surfaceId"],
                            &[],
                        )?;
                        positive_integer(input, "paneId")?;
                    }
                    "restore" => {
                        exact_fields(
                            input,
                            &[
                                "action",
                                "anchorPaneId",
                                "direction",
                                "expectedTopologyRevision",
                                "surfaceId",
                                "tombstoneId",
                            ],
                            &[],
                        )?;
                        positive_integer(input, "anchorPaneId")?;
                        required_string(input, "tombstoneId")?;
                        direction(input)?;
                    }
                    "rename" => {
                        exact_fields(
                            input,
                            &[
                                "action",
                                "expectedTopologyRevision",
                                "name",
                                "paneId",
                                "surfaceId",
                            ],
                            &[],
                        )?;
                        positive_integer(input, "paneId")?;
                        if !matches!(
                            input.get("name"),
                            Some(Value::String(_)) | Some(Value::Null)
                        ) {
                            return Err("invalid_input:name".into());
                        }
                    }
                    _ => return Err("invalid_input:action".into()),
                }
            }
            Self::TopologyRealize => {
                exact_fields(
                    input,
                    &[
                        "allowDestroyPaneIds",
                        "desired",
                        "expectedTopologyRevision",
                        "surfaceId",
                        "target",
                    ],
                    &[],
                )?;
                required_string(input, "surfaceId")?;
                nonnegative_integer(input, "expectedTopologyRevision")?;
                topology_target(input)?;
                desired_topology(required(input, "desired")?)?;
                positive_integer_array(input, "allowDestroyPaneIds")?;
            }
            Self::Clear => {
                exact_fields(input, &["expectedRevision", "paneId", "surfaceId"], &[])?;
                required_string(input, "surfaceId")?;
                positive_integer(input, "paneId")?;
                nonnegative_integer(input, "expectedRevision")?;
            }
            Self::AnnotationsRemove => {
                exact_fields(
                    input,
                    &["contentId", "paneId", "strokeIds", "surfaceId"],
                    &[],
                )?;
                required_string(input, "surfaceId")?;
                positive_integer(input, "paneId")?;
                required_string(input, "contentId")?;
                nonempty_string_array(input, "strokeIds")?;
            }
            Self::CapturePane => {
                exact_fields(
                    input,
                    &["paneId", "surfaceId"],
                    &["includeDrawings", "includeImage", "includeVisibleText"],
                )?;
                required_string(input, "surfaceId")?;
                positive_integer(input, "paneId")?;
                for key in ["includeDrawings", "includeImage", "includeVisibleText"] {
                    optional_boolean(input, key)?;
                }
            }
            Self::SurfaceIntent => {
                nonnegative_integer(input, "expectedSurfaceSetRevision")?;
                match string(input, "action")? {
                    "open" => {
                        exact_fields(
                            input,
                            &["action", "expectedSurfaceSetRevision"],
                            &["placement"],
                        )?;
                        optional_object(input, "placement")?;
                    }
                    "close" => {
                        exact_fields(
                            input,
                            &[
                                "action",
                                "expectedSurfaceSetRevision",
                                "expectedTopologyRevision",
                                "surfaceId",
                            ],
                            &[],
                        )?;
                        required_string(input, "surfaceId")?;
                        nonnegative_integer(input, "expectedTopologyRevision")?;
                    }
                    "restore" => {
                        exact_fields(
                            input,
                            &["action", "expectedSurfaceSetRevision", "tombstoneId"],
                            &["placement"],
                        )?;
                        required_string(input, "tombstoneId")?;
                        optional_object(input, "placement")?;
                    }
                    _ => return Err("invalid_input:action".into()),
                }
            }
            Self::TargetRegister => {
                exact_fields(
                    input,
                    &[
                        "expectedPreviousTargetEpoch",
                        "idempotencyKey",
                        "launchedAt",
                        "registrationState",
                        "surfaceId",
                        "targetHeader",
                        "targetKind",
                        "targetPayload",
                    ],
                    &["paneId", "paneLineageId", "restorePolicy"],
                )?;
                required_string(input, "surfaceId")?;
                required_string(input, "idempotencyKey")?;
                nullable_nonnegative_integer(input, "expectedPreviousTargetEpoch")?;
                launched_at(input)?;
                match string(input, "registrationState")? {
                    "before_attach" | "attached" => {}
                    _ => return Err("invalid_input:registrationState".into()),
                }
                required_string(input, "targetKind")?;
                object(input, "targetHeader")?;
                required(input, "targetPayload")?;
                optional_positive_integer(input, "paneId")?;
                optional_nonempty_string(input, "paneLineageId")?;
                optional_string(input, "restorePolicy")?;
            }
            Self::TargetApply => {
                exact_fields(
                    input,
                    &[
                        "requestId",
                        "restoreReason",
                        "surfaceId",
                        "targetEpoch",
                        "targetHeader",
                        "targetId",
                        "targetKind",
                        "targetPayload",
                    ],
                    &["display", "paneId", "paneLineageId"],
                )?;
                required_string(input, "surfaceId")?;
                required_string(input, "requestId")?;
                string_value(input, "restoreReason")?;
                required_string(input, "targetId")?;
                positive_integer(input, "targetEpoch")?;
                required_string(input, "targetKind")?;
                object(input, "targetHeader")?;
                required(input, "targetPayload")?;
                optional_positive_integer(input, "paneId")?;
                optional_nonempty_string(input, "paneLineageId")?;
                optional_object(input, "display")?;
            }
        }
        Ok(())
    }

    pub fn wire_payload(self, mut input: Map<String, Value>) -> Result<Value, String> {
        if let Some(path) = forbidden_legacy_path(&Value::Object(input.clone()), "payload", true) {
            return Err(format!("forbidden_legacy_field:{path}"));
        }
        match self {
            Self::TopologyIntent => {
                input.remove("action");
                if let Some(expected) = input.remove("expectedTopologyRevision") {
                    input.insert("expectedTopologyRevision".into(), expected);
                }
            }
            Self::SurfaceIntent => {
                input.remove("action");
            }
            _ => {}
        }
        Ok(Value::Object(input))
    }
}

fn string<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("invalid_input:{key}"))
}

fn required<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a Value, String> {
    input.get(key).ok_or_else(|| format!("invalid_input:{key}"))
}

fn required_string<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    string(input, key)
}

fn string_value<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("invalid_input:{key}"))
}

fn integer(input: &Map<String, Value>, key: &str) -> Result<i64, String> {
    let value = input
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("invalid_input:{key}"))?;
    if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(format!("invalid_input:{key}"));
    }
    Ok(value)
}

fn positive_integer(input: &Map<String, Value>, key: &str) -> Result<i64, String> {
    let value = integer(input, key)?;
    if !(1..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(format!("invalid_input:{key}"));
    }
    Ok(value)
}

fn nonnegative_integer(input: &Map<String, Value>, key: &str) -> Result<i64, String> {
    let value = integer(input, key)?;
    if !(0..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(format!("invalid_input:{key}"));
    }
    Ok(value)
}

fn object<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a Map<String, Value>, String> {
    input
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("invalid_input:{key}"))
}

fn array<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a Vec<Value>, String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("invalid_input:{key}"))
}

fn exact_fields(
    input: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> Result<(), String> {
    for key in required {
        if !input.contains_key(*key) {
            return Err(format!("invalid_input:{key}"));
        }
    }
    for key in input.keys() {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            if LEGACY_AUTHORITY_FIELDS.contains(&key.as_str()) {
                return Err(format!("forbidden_legacy_field:{key}"));
            }
            return Err(format!("invalid_input:unknown_property:{key}"));
        }
    }
    Ok(())
}

fn nullable_nonnegative_integer(input: &Map<String, Value>, key: &str) -> Result<(), String> {
    match required(input, key)? {
        Value::Null => Ok(()),
        Value::Number(_) => nonnegative_integer(input, key).map(|_| ()),
        _ => Err(format!("invalid_input:{key}")),
    }
}

fn optional_positive_integer(input: &Map<String, Value>, key: &str) -> Result<(), String> {
    if input.contains_key(key) {
        positive_integer(input, key)?;
    }
    Ok(())
}

fn optional_nonempty_string(input: &Map<String, Value>, key: &str) -> Result<(), String> {
    if input.contains_key(key) {
        required_string(input, key)?;
    }
    Ok(())
}

fn optional_string(input: &Map<String, Value>, key: &str) -> Result<(), String> {
    if input.contains_key(key) {
        string_value(input, key)?;
    }
    Ok(())
}

fn optional_boolean(input: &Map<String, Value>, key: &str) -> Result<(), String> {
    if input.contains_key(key) && !matches!(input.get(key), Some(Value::Bool(_))) {
        return Err(format!("invalid_input:{key}"));
    }
    Ok(())
}

fn optional_object(input: &Map<String, Value>, key: &str) -> Result<(), String> {
    if input.contains_key(key) {
        object(input, key)?;
    }
    Ok(())
}

fn positive_integer_array(input: &Map<String, Value>, key: &str) -> Result<(), String> {
    if !array(input, key)?.iter().all(|value| {
        value
            .as_i64()
            .is_some_and(|integer| (1..=MAX_SAFE_INTEGER).contains(&integer))
    }) {
        return Err(format!("invalid_input:{key}"));
    }
    Ok(())
}

fn nonempty_string_array(input: &Map<String, Value>, key: &str) -> Result<(), String> {
    if !array(input, key)?
        .iter()
        .all(|value| value.as_str().is_some_and(|string| !string.is_empty()))
    {
        return Err(format!("invalid_input:{key}"));
    }
    Ok(())
}

fn topology_target(input: &Map<String, Value>) -> Result<(), String> {
    let target = object(input, "target")?;
    if target.get("root") == Some(&Value::Bool(true))
        || target
            .get("paneId")
            .and_then(Value::as_i64)
            .is_some_and(|pane_id| (1..=MAX_SAFE_INTEGER).contains(&pane_id))
    {
        return Ok(());
    }
    Err("invalid_input:target".into())
}

fn launched_at(input: &Map<String, Value>) -> Result<(), String> {
    let value = required_string(input, "launchedAt")?;
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| "invalid_input:launchedAt".to_owned())
}

fn forbidden_legacy_path(value: &Value, path: &str, root: bool) -> Option<String> {
    match value {
        Value::Array(values) => values.iter().enumerate().find_map(|(index, child)| {
            forbidden_legacy_path(child, &format!("{path}[{index}]"), false)
        }),
        Value::Object(fields) => fields.iter().find_map(|(key, child)| {
            if (root || key != "revision") && LEGACY_AUTHORITY_FIELDS.contains(&key.as_str()) {
                return Some(format!("{path}.{key}"));
            }
            forbidden_legacy_path(child, &format!("{path}.{key}"), false)
        }),
        _ => None,
    }
}

fn desired_topology(value: &Value) -> Result<(), String> {
    let desired = value
        .as_object()
        .ok_or_else(|| "invalid_input:desired".to_owned())?;
    match desired.get("type").and_then(Value::as_str) {
        Some("pane") => {
            if desired.contains_key("paneId") {
                positive_integer(desired, "paneId")?;
            }
            Ok(())
        }
        Some("split") => {
            match desired.get("direction").and_then(Value::as_str) {
                Some("horizontal" | "vertical") => {}
                _ => return Err("invalid_input:desired".into()),
            }
            let children = desired
                .get("children")
                .and_then(Value::as_array)
                .filter(|children| children.len() >= 2)
                .ok_or_else(|| "invalid_input:desired".to_owned())?;
            for child in children {
                desired_topology(child)?;
            }
            Ok(())
        }
        _ => Err("invalid_input:desired".into()),
    }
}

fn direction(input: &Map<String, Value>) -> Result<(), String> {
    match string(input, "direction")? {
        "horizontal" | "vertical" => Ok(()),
        _ => Err("invalid_input:direction".into()),
    }
}

#[derive(Clone, Debug)]
pub struct Invocation {
    pub command: Command,
    pub endpoint: Option<String>,
    pub input: Map<String, Value>,
    pub product_label: Option<String>,
    pub projection_capacity_bytes: u64,
    pub state_root: PathBuf,
}
