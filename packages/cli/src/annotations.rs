use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};
use uuid::Uuid;

#[derive(Debug)]
pub struct AnnotationError {
    pub code: String,
    pub details: Value,
}

impl AnnotationError {
    fn input(field: &str) -> Self {
        Self {
            code: "annotation_invalid_request".into(),
            details: json!({ "field": field }),
        }
    }

    fn transport(error: impl ToString) -> Self {
        Self {
            code: "annotation_transport_failure".into(),
            details: json!({ "cause": error.to_string() }),
        }
    }

    fn protocol(field: &str) -> Self {
        Self {
            code: "annotation_invalid_response".into(),
            details: json!({ "field": field }),
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Action {
    Watch,
    Resume,
    Ack,
    Retire,
}

struct Invocation {
    action: Action,
    registry: String,
    state_root: PathBuf,
    consumer_id: String,
    from: Option<Value>,
    cursor: Option<Value>,
    gap_id: Option<String>,
    expected_ack: Option<Value>,
    discard: bool,
}

fn parse_cursor(text: &str, allow_zero: bool) -> Result<Value, AnnotationError> {
    let mut parts = text.split(':');
    let (Some("ann1"), Some(epoch), Some(sequence), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(AnnotationError::input("cursor"));
    };
    if epoch.len() != 32
        || !epoch
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || sequence.is_empty()
        || (sequence.len() > 1 && sequence.starts_with('0'))
        || !sequence.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(AnnotationError::input("cursor"));
    }
    let number = sequence
        .parse::<u64>()
        .map_err(|_| AnnotationError::input("cursor"))?;
    if number > i64::MAX as u64 || (number == 0 && !allow_zero) {
        return Err(AnnotationError::input("cursor"));
    }
    Ok(json!({ "epoch": epoch, "sequence": sequence }))
}

fn cursor_text(value: &Value, allow_zero: bool) -> Result<String, AnnotationError> {
    let epoch = value
        .get("epoch")
        .and_then(Value::as_str)
        .ok_or_else(|| AnnotationError::protocol("cursor.epoch"))?;
    let sequence = value
        .get("sequence")
        .and_then(Value::as_str)
        .ok_or_else(|| AnnotationError::protocol("cursor.sequence"))?;
    let text = format!("ann1:{epoch}:{sequence}");
    parse_cursor(&text, allow_zero).map_err(|_| AnnotationError::protocol("cursor"))?;
    Ok(text)
}

fn optional_cursor(
    payload: &Value,
    key: &str,
    allow_zero: bool,
) -> Result<Option<String>, AnnotationError> {
    match payload.get(key) {
        Some(Value::Null) => Ok(None),
        Some(value) => cursor_text(value, allow_zero).map(Some),
        None => Err(AnnotationError::protocol(key)),
    }
}

fn parse(arguments: &[String]) -> Result<Invocation, AnnotationError> {
    let mut registry = None;
    let mut state_root = None;
    let mut consumer_id = None;
    let mut action = None;
    let mut from = None;
    let mut cursor = None;
    let mut gap_id = None;
    let mut expected_ack = None;
    let mut discard = false;
    let mut saw_annotations = false;
    let mut index = 0;
    while index < arguments.len() {
        let argument = arguments[index].as_str();
        if argument == "annotations" && !saw_annotations {
            saw_annotations = true;
            index += 1;
            let value = arguments
                .get(index)
                .ok_or_else(|| AnnotationError::input("action"))?;
            action = Some(match value.as_str() {
                "watch" => Action::Watch,
                "resume" => Action::Resume,
                "ack" => Action::Ack,
                "retire" => Action::Retire,
                _ => return Err(AnnotationError::input("action")),
            });
        } else if argument == "--discard-unacknowledged" {
            if discard {
                return Err(AnnotationError::input("discard-unacknowledged"));
            }
            discard = true;
        } else {
            index += 1;
            let value = arguments
                .get(index)
                .ok_or_else(|| AnnotationError::input(argument))?;
            match argument {
                "--registry" if registry.is_none() => registry = Some(value.clone()),
                "--state-root" if state_root.is_none() => state_root = Some(PathBuf::from(value)),
                "--consumer-id" if consumer_id.is_none() => consumer_id = Some(value.clone()),
                "--from" if from.is_none() => from = Some(parse_cursor(value, false)?),
                "--cursor" if cursor.is_none() => cursor = Some(parse_cursor(value, false)?),
                "--gap-id" if gap_id.is_none() => gap_id = Some(value.clone()),
                "--expect-ack" if expected_ack.is_none() => {
                    expected_ack = Some(if value == "none" {
                        Value::Null
                    } else {
                        parse_cursor(value, true)?
                    });
                }
                _ => return Err(AnnotationError::input("argument")),
            }
        }
        index += 1;
    }
    let action = action.ok_or_else(|| AnnotationError::input("action"))?;
    let registry = registry.ok_or_else(|| AnnotationError::input("registry"))?;
    if !registry.starts_with("ws://")
        || tungstenite::client::IntoClientRequest::into_client_request(registry.as_str()).is_err()
    {
        return Err(AnnotationError::input("registry"));
    }
    let state_root = state_root.ok_or_else(|| AnnotationError::input("state-root"))?;
    let consumer_id: String = consumer_id.ok_or_else(|| AnnotationError::input("consumer-id"))?;
    if consumer_id.is_empty() || consumer_id.len() > 128 {
        return Err(AnnotationError::input("consumer-id"));
    }
    match action {
        Action::Watch
            if cursor.is_some() || gap_id.is_some() || expected_ack.is_some() || discard =>
        {
            return Err(AnnotationError::input("watch-options"))
        }
        Action::Resume
            if from.is_some()
                || cursor.is_some()
                || gap_id.is_some()
                || expected_ack.is_some()
                || discard =>
        {
            return Err(AnnotationError::input("resume-options"))
        }
        Action::Ack
            if from.is_some()
                || expected_ack.is_some()
                || discard
                || cursor.is_some() == gap_id.is_some() =>
        {
            return Err(AnnotationError::input("ack-options"))
        }
        Action::Retire
            if from.is_some()
                || cursor.is_some()
                || gap_id.is_some()
                || expected_ack.is_none()
                || !discard =>
        {
            return Err(AnnotationError::input("retire-options"))
        }
        _ => {}
    }
    if gap_id
        .as_deref()
        .is_some_and(|id| id.is_empty() || id.len() > 128)
    {
        return Err(AnnotationError::input("gap-id"));
    }
    Ok(Invocation {
        action,
        registry,
        state_root,
        consumer_id,
        from,
        cursor,
        gap_id,
        expected_ack,
        discard,
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListenerState {
    version: u8,
    consumer_id: String,
    lease_id: Option<String>,
    ack_cursor: Option<String>,
    initial_from_cursor: Option<String>,
    available_from_cursor: Option<String>,
    head_cursor: Option<String>,
    history_complete_since_start: bool,
    last_delivered_cursor: Option<String>,
    pending_gap_id: Option<String>,
    retired: bool,
}

struct StateStore {
    root: PathBuf,
    path: PathBuf,
    lock: File,
    consumer_id: String,
}

impl StateStore {
    fn open(root: &Path, consumer_id: &str) -> Result<Self, AnnotationError> {
        let root = root.join("annotations");
        fs::create_dir_all(&root).map_err(AnnotationError::transport)?;
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(root.join("listener.lock"))
            .map_err(AnnotationError::transport)?;
        lock.lock_exclusive().map_err(AnnotationError::transport)?;
        let digest = format!("{:x}", Sha256::digest(consumer_id.as_bytes()));
        let path = root.join(format!("{digest}.json"));
        Ok(Self {
            root,
            path,
            lock,
            consumer_id: consumer_id.into(),
        })
    }

    fn load(&self) -> Result<Option<ListenerState>, AnnotationError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(AnnotationError::transport(error)),
        };
        if bytes.len() > 8192 {
            return Err(AnnotationError::protocol("listener-state-capacity"));
        }
        let state: ListenerState = serde_json::from_slice(&bytes)
            .map_err(|_| AnnotationError::protocol("listener-state"))?;
        if state.version != 1 || state.consumer_id != self.consumer_id {
            return Err(AnnotationError::protocol("listener-state-identity"));
        }
        Ok(Some(state))
    }

    fn save(&self, state: &ListenerState) -> Result<(), AnnotationError> {
        let bytes = serde_json::to_vec(state).map_err(AnnotationError::transport)?;
        if bytes.len() > 8192 {
            return Err(AnnotationError::protocol("listener-state-capacity"));
        }
        let temporary = self.root.join(format!(".{}.tmp", Uuid::new_v4().simple()));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(AnnotationError::transport)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(AnnotationError::transport)?;
        fs::rename(&temporary, &self.path).map_err(AnnotationError::transport)?;
        File::open(&self.root)
            .and_then(|dir| dir.sync_all())
            .map_err(AnnotationError::transport)?;
        Ok(())
    }
}

impl Drop for StateStore {
    fn drop(&mut self) {
        let _ = self.lock.unlock();
    }
}

struct RegistryWire {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    events: Vec<Value>,
}

impl RegistryWire {
    fn connect(url: &str) -> Result<Self, AnnotationError> {
        let (socket, _) = connect(url).map_err(AnnotationError::transport)?;
        Ok(Self {
            socket,
            events: Vec::new(),
        })
    }

    fn read(&mut self) -> Result<Value, AnnotationError> {
        loop {
            match self.socket.read().map_err(AnnotationError::transport)? {
                Message::Text(value) => {
                    let value: Value = serde_json::from_str(&value)
                        .map_err(|_| AnnotationError::protocol("json"))?;
                    if value.get("v") != Some(&json!(1))
                        || !value.get("type").is_some_and(Value::is_string)
                    {
                        return Err(AnnotationError::protocol("envelope"));
                    }
                    return Ok(value);
                }
                Message::Ping(value) => self
                    .socket
                    .send(Message::Pong(value))
                    .map_err(AnnotationError::transport)?,
                Message::Pong(_) => {}
                _ => return Err(AnnotationError::protocol("frame")),
            }
        }
    }

    fn request(&mut self, op: &str, payload: Value) -> Result<Value, AnnotationError> {
        let id = Uuid::new_v4().simple().to_string();
        let sent_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(AnnotationError::transport)?
            .as_millis() as u64;
        let request =
            json!({"v":1,"type":"request","op":op,"id":id,"sentAt":sent_at,"payload":payload});
        self.socket
            .send(Message::Text(request.to_string().into()))
            .map_err(AnnotationError::transport)?;
        loop {
            let value = self.read()?;
            if value.get("type") == Some(&json!("event")) {
                self.events.push(value);
                continue;
            }
            if value.get("type") != Some(&json!("response"))
                || value.get("id") != Some(&json!(id))
                || value.get("op") != Some(&json!(op))
            {
                return Err(AnnotationError::protocol("response-correlation"));
            }
            if value.get("ok") == Some(&Value::Bool(false)) {
                let error = value
                    .get("error")
                    .ok_or_else(|| AnnotationError::protocol("error"))?;
                let code = error
                    .get("code")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AnnotationError::protocol("error.code"))?;
                return Err(AnnotationError {
                    code: code.into(),
                    details: error.clone(),
                });
            }
            if value.get("ok") != Some(&Value::Bool(true)) {
                return Err(AnnotationError::protocol("ok"));
            }
            return value
                .get("payload")
                .cloned()
                .ok_or_else(|| AnnotationError::protocol("payload"));
        }
    }

    fn event(&mut self) -> Result<Value, AnnotationError> {
        if !self.events.is_empty() {
            return Ok(self.events.remove(0));
        }
        let event = self.read()?;
        if event.get("type") != Some(&json!("event"))
            || event.get("eventId").and_then(Value::as_str).is_none()
        {
            return Err(AnnotationError::protocol("event"));
        }
        Ok(event)
    }
}

fn emit(value: Value) -> Result<(), AnnotationError> {
    println!(
        "{}",
        serde_json::to_string(&value).map_err(AnnotationError::transport)?
    );
    io::stdout().flush().map_err(AnnotationError::transport)
}

fn render_cursor_fields(payload: &mut Value, fields: &[&str]) -> Result<(), AnnotationError> {
    for field in fields {
        let value = payload
            .get(*field)
            .ok_or_else(|| AnnotationError::protocol(field))?;
        if !value.is_null() {
            let cursor = cursor_text(
                value,
                *field == "throughCursor" || *field == "expectedAckCursor",
            )?;
            payload[*field] = Value::String(cursor);
        }
    }
    Ok(())
}

fn render_event(event: &Value) -> Result<Value, AnnotationError> {
    let mut output = event.clone();
    let op = event
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| AnnotationError::protocol("event.op"))?;
    let payload = output
        .get_mut("payload")
        .ok_or_else(|| AnnotationError::protocol("event.payload"))?;
    match op {
        "annotation.record" => render_cursor_fields(payload, &["serverCursor"])?,
        "annotation.history_gap" => render_cursor_fields(
            payload,
            &[
                "requestedCursor",
                "availableFromCursor",
                "throughCursor",
                "headCursor",
            ],
        )?,
        "annotation.consumer_retired" => render_cursor_fields(
            payload,
            &[
                "expectedAckCursor",
                "discardedFromCursor",
                "discardedThroughCursor",
            ],
        )?,
        _ => {}
    }
    Ok(output)
}

fn open_state(invocation: &Invocation, response: &Value) -> Result<ListenerState, AnnotationError> {
    let lease_id = response
        .get("leaseId")
        .and_then(Value::as_str)
        .ok_or_else(|| AnnotationError::protocol("leaseId"))?;
    if lease_id.len() != 32
        || !lease_id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(AnnotationError::protocol("leaseId"));
    }
    let consumer_id = response
        .get("consumerId")
        .and_then(Value::as_str)
        .ok_or_else(|| AnnotationError::protocol("consumerId"))?;
    if consumer_id != invocation.consumer_id {
        return Err(AnnotationError::protocol("consumerId"));
    }
    Ok(ListenerState {
        version: 1,
        consumer_id: consumer_id.into(),
        lease_id: Some(lease_id.into()),
        ack_cursor: optional_cursor(response, "ackCursor", true)?,
        initial_from_cursor: optional_cursor(response, "initialFromCursor", true)?,
        available_from_cursor: optional_cursor(response, "availableFromCursor", true)?,
        head_cursor: optional_cursor(response, "headCursor", true)?,
        history_complete_since_start: response
            .get("historyCompleteSinceStart")
            .and_then(Value::as_bool)
            .ok_or_else(|| AnnotationError::protocol("historyCompleteSinceStart"))?,
        last_delivered_cursor: None,
        pending_gap_id: None,
        retired: false,
    })
}

pub fn run(arguments: &[String]) -> Result<(), AnnotationError> {
    let invocation = parse(arguments)?;
    let mut wire = RegistryWire::connect(&invocation.registry)?;
    wire.request(
        "annotation.hello",
        json!({"protocolVersion":1,"role":"consumer"}),
    )?;
    match invocation.action {
        Action::Watch | Action::Resume => {
            let mut payload = json!({"consumerId":invocation.consumer_id});
            if let Some(from) = &invocation.from {
                payload["fromCursor"] = from.clone();
            }
            let response = wire.request(
                if invocation.action == Action::Watch {
                    "annotation.watch"
                } else {
                    "annotation.resume"
                },
                payload,
            )?;
            let state = open_state(&invocation, &response)?;
            let active_lease = state.lease_id.clone();
            StateStore::open(&invocation.state_root, &invocation.consumer_id)?.save(&state)?;
            let limits = response
                .get("limits")
                .ok_or_else(|| AnnotationError::protocol("limits"))?;
            emit(
                json!({"type":"annotation.subscription","consumerId":state.consumer_id,
                "leaseId":state.lease_id,"ackCursor":state.ack_cursor,
                "initialFromCursor":state.initial_from_cursor,"availableFromCursor":state.available_from_cursor,
                "headCursor":state.head_cursor,"historyCompleteSinceStart":state.history_complete_since_start,
                "replayPolicy":limits.get("replayPolicy").ok_or_else(|| AnnotationError::protocol("replayPolicy"))?}),
            )?;
            loop {
                let event = wire.event()?;
                let output = render_event(&event)?;
                let op = event
                    .get("op")
                    .and_then(Value::as_str)
                    .ok_or_else(|| AnnotationError::protocol("event.op"))?
                    .to_owned();
                let data = event
                    .get("payload")
                    .ok_or_else(|| AnnotationError::protocol("event.payload"))?;
                let store = StateStore::open(&invocation.state_root, &invocation.consumer_id)?;
                let mut stored = store
                    .load()?
                    .ok_or_else(|| AnnotationError::protocol("listener-state"))?;
                if stored.lease_id != active_lease {
                    return Err(AnnotationError {
                        code: "annotation_consumer_lease_stale".into(),
                        details: json!({}),
                    });
                }
                match op.as_str() {
                    "annotation.record" => {
                        stored.last_delivered_cursor = Some(cursor_text(
                            data.get("serverCursor")
                                .ok_or_else(|| AnnotationError::protocol("serverCursor"))?,
                            false,
                        )?);
                    }
                    "annotation.history_gap" => {
                        stored.pending_gap_id = Some(
                            data.get("gapId")
                                .and_then(Value::as_str)
                                .ok_or_else(|| AnnotationError::protocol("gapId"))?
                                .into(),
                        );
                    }
                    "annotation.lease_replaced" | "annotation.consumer_retired" => {
                        stored.lease_id = None;
                        if op == "annotation.consumer_retired" {
                            stored.retired = true;
                        }
                    }
                    _ => return Err(AnnotationError::protocol("event.op")),
                }
                store.save(&stored)?;
                drop(store);
                emit(output)?;
                if op == "annotation.lease_replaced" || op == "annotation.consumer_retired" {
                    return Ok(());
                }
            }
        }
        Action::Ack => {
            let store = StateStore::open(&invocation.state_root, &invocation.consumer_id)?;
            let mut state = store
                .load()?
                .ok_or_else(|| AnnotationError::input("listener-state"))?;
            let lease_id = state
                .lease_id
                .clone()
                .ok_or_else(|| AnnotationError::input("leaseId"))?;
            let (op, payload) = if let Some(cursor) = invocation.cursor {
                (
                    "annotation.ack",
                    json!({"consumerId":invocation.consumer_id,"leaseId":lease_id,"throughCursor":cursor}),
                )
            } else {
                (
                    "annotation.gap.ack",
                    json!({"consumerId":invocation.consumer_id,"leaseId":lease_id,"gapId":invocation.gap_id}),
                )
            };
            let response = wire.request(op, payload)?;
            state.ack_cursor = optional_cursor(&response, "ackCursor", true)?;
            if op == "annotation.gap.ack" {
                state.pending_gap_id = None;
            }
            store.save(&state)?;
            emit(
                json!({"type":"annotation.ack","consumerId":state.consumer_id,"ackCursor":state.ack_cursor,"gapId":response.get("gapId")}),
            )
        }
        Action::Retire => {
            let payload = json!({"consumerId":invocation.consumer_id,
                "expectedAckCursor":invocation.expected_ack,"discardUnacknowledged":invocation.discard});
            let response = wire.request("annotation.consumer.retire", payload)?;
            let store = StateStore::open(&invocation.state_root, &invocation.consumer_id)?;
            if let Some(mut state) = store.load()? {
                state.lease_id = None;
                state.retired = true;
                store.save(&state)?;
            }
            let output =
                render_event(&json!({"op":"annotation.consumer_retired","payload":response}))?;
            emit(json!({"type":"annotation.consumer_retired","payload":output["payload"]}))
        }
    }
}
