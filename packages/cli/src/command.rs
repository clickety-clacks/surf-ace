use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;

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
                required_string(input, "surfaceId")?;
                positive_integer(input, "paneId")?;
                required_string(input, "contentId")?;
                required_string(input, "contentType")?;
                required(input, "content")?;
            }
            Self::Read => {
                required_string(input, "scopeId")?;
            }
            Self::TopologyIntent => {
                required_string(input, "surfaceId")?;
                nonnegative_integer(input, "expectedTopologyRevision")?;
                match string(input, "action")? {
                    "split" => {
                        positive_integer(input, "paneId")?;
                        if integer(input, "count")? < 2 {
                            return Err("invalid_input:count".into());
                        }
                        direction(input)?;
                    }
                    "close" => {
                        positive_integer(input, "paneId")?;
                    }
                    "restore" => {
                        positive_integer(input, "anchorPaneId")?;
                        required_string(input, "tombstoneId")?;
                        direction(input)?;
                    }
                    "rename" => {
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
                required_string(input, "surfaceId")?;
                nonnegative_integer(input, "expectedTopologyRevision")?;
                object(input, "target")?;
                object(input, "desired")?;
                array(input, "allowDestroyPaneIds")?;
            }
            Self::Clear => {
                required_string(input, "surfaceId")?;
                positive_integer(input, "paneId")?;
                nonnegative_integer(input, "expectedRevision")?;
            }
            Self::AnnotationsRemove => {
                required_string(input, "surfaceId")?;
                positive_integer(input, "paneId")?;
                required_string(input, "contentId")?;
                array(input, "strokeIds")?;
            }
            Self::CapturePane => {
                required_string(input, "surfaceId")?;
                positive_integer(input, "paneId")?;
            }
            Self::SurfaceIntent => {
                nonnegative_integer(input, "expectedSurfaceSetRevision")?;
                match string(input, "action")? {
                    "open" => {}
                    "close" => {
                        required_string(input, "surfaceId")?;
                        nonnegative_integer(input, "expectedTopologyRevision")?;
                    }
                    "restore" => {
                        required_string(input, "tombstoneId")?;
                    }
                    _ => return Err("invalid_input:action".into()),
                }
            }
            Self::TargetRegister => {
                required_string(input, "surfaceId")?;
                positive_integer(input, "paneId")?;
                required_string(input, "idempotencyKey")?;
            }
            Self::TargetApply => {
                required_string(input, "surfaceId")?;
                positive_integer(input, "paneId")?;
                required_string(input, "requestId")?;
                required_string(input, "restoreReason")?;
                required_string(input, "targetId")?;
                positive_integer(input, "targetEpoch")?;
                required_string(input, "targetKind")?;
                object(input, "targetHeader")?;
                required(input, "targetPayload")?;
            }
        }
        Ok(())
    }

    pub fn wire_payload(self, mut input: Map<String, Value>) -> Result<Value, String> {
        for forbidden in [
            "connectionId",
            "ownershipEpoch",
            "ownershipSessionId",
            "providerId",
        ] {
            if input.contains_key(forbidden) {
                return Err(format!("forbidden_legacy_field:{forbidden}"));
            }
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

fn integer(input: &Map<String, Value>, key: &str) -> Result<i64, String> {
    input
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("invalid_input:{key}"))
}

fn positive_integer(input: &Map<String, Value>, key: &str) -> Result<i64, String> {
    let value = integer(input, key)?;
    if value < 1 {
        return Err(format!("invalid_input:{key}"));
    }
    Ok(value)
}

fn nonnegative_integer(input: &Map<String, Value>, key: &str) -> Result<i64, String> {
    let value = integer(input, key)?;
    if value < 0 {
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
