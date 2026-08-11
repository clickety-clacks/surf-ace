use crate::command::Invocation;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn execute(invocation: Invocation) -> Result<Value, CliError> {
    invocation
        .command
        .validate(&invocation.input)
        .map_err(CliError::Input)?;
    let mut socket = UnixStream::connect(&invocation.socket_path)
        .map_err(|error| CliError::Transport(error.to_string()))?;
    let request_id = format!(
        "local_{}_{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| CliError::Transport(error.to_string()))?
            .as_nanos()
    );
    let request = json!({
        "command": invocation.command.name(),
        "id": request_id,
        "input": invocation.input,
        "v": 1,
    });
    socket
        .write_all(format!("{}\n", request).as_bytes())
        .map_err(|error| CliError::Transport(error.to_string()))?;
    socket
        .shutdown(std::net::Shutdown::Write)
        .map_err(|error| CliError::Transport(error.to_string()))?;
    let mut encoded = String::new();
    socket
        .read_to_string(&mut encoded)
        .map_err(|error| CliError::Transport(error.to_string()))?;
    let response: Value = serde_json::from_str(encoded.trim())
        .map_err(|_| CliError::Protocol("invalid_controller_response".into()))?;
    if response.get("v").and_then(Value::as_u64) != Some(1)
        || response.get("id").and_then(Value::as_str) != Some(&request_id)
    {
        return Err(CliError::Protocol("controller_response_mismatch".into()));
    }
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        let details = response
            .pointer("/error/details")
            .and_then(Value::as_str)
            .unwrap_or("controller_request_failed");
        return Err(CliError::Controller(details.into()));
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| CliError::Protocol("controller_response_missing_result".into()))
}

#[derive(Debug)]
pub enum CliError {
    Controller(String),
    Input(String),
    Protocol(String),
    Transport(String),
}

impl CliError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Controller(_) => "controller_error",
            Self::Input(_) => "invalid_input",
            Self::Protocol(_) => "protocol_error",
            Self::Transport(_) => "controller_unavailable",
        }
    }

    pub fn details(&self) -> &str {
        match self {
            Self::Controller(details)
            | Self::Input(details)
            | Self::Protocol(details)
            | Self::Transport(details) => details,
        }
    }
}
