use serde::{Deserialize, Serialize};
use serde_json::Value;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Envelope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(rename = "type")]
    pub envelope_type: String,
    pub v: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

impl Envelope {
    pub fn request(id: String, op: &str, payload: Value) -> Self {
        Self {
            id: Some(id),
            op: op.into(),
            payload: Some(payload),
            envelope_type: "request".into(),
            v: 1,
            ok: None,
            error: None,
        }
    }
}

pub struct WireResponse {
    pub response: Envelope,
    pub events: Vec<Envelope>,
}

pub trait DirectWire {
    fn request(
        &mut self,
        id: &str,
        op: &str,
        payload: Value,
        sent: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<WireResponse, WireFailure>;

    fn close(&mut self) -> Result<(), WireFailure>;
}

pub struct WebSocketWire {
    socket: WebSocket<MaybeTlsStream<std::net::TcpStream>>,
}

impl WebSocketWire {
    pub fn connect_direct(endpoint: &str) -> Result<Self, WireFailure> {
        let (socket, _) = connect(endpoint).map_err(|error| WireFailure::BeforeSend {
            code: format!("reachability:{error}"),
        })?;
        Ok(Self { socket })
    }
}

impl DirectWire for WebSocketWire {
    fn request(
        &mut self,
        id: &str,
        op: &str,
        payload: Value,
        sent: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<WireResponse, WireFailure> {
        let request = Envelope::request(id.to_owned(), op, payload);
        let serialized =
            serde_json::to_string(&request).map_err(|error| WireFailure::BeforeSend {
                code: format!("request_encode:{error}"),
            })?;
        self.socket
            .send(Message::Text(serialized.into()))
            .map_err(|error| WireFailure::AfterSend {
                code: format!("request_send:{error}"),
            })?;
        sent().map_err(|code| WireFailure::AfterSend { code })?;
        let mut events = vec![];
        loop {
            let message = self.socket.read().map_err(|error| WireFailure::AfterSend {
                code: format!("response_read:{error}"),
            })?;
            let Message::Text(text) = message else {
                continue;
            };
            let envelope: Envelope =
                serde_json::from_str(&text).map_err(|error| WireFailure::AfterSend {
                    code: format!("response_decode:{error}"),
                })?;
            if envelope.envelope_type == "event" {
                events.push(envelope);
                continue;
            }
            if envelope.envelope_type == "response" && envelope.id.as_deref() == Some(id) {
                return Ok(WireResponse {
                    response: envelope,
                    events,
                });
            }
        }
    }

    fn close(&mut self) -> Result<(), WireFailure> {
        self.socket
            .close(None)
            .map_err(|error| WireFailure::AfterSend {
                code: format!("disconnect:{error}"),
            })
    }
}

#[derive(Debug, PartialEq)]
pub enum WireFailure {
    BeforeSend { code: String },
    AfterSend { code: String },
}

impl std::fmt::Display for WireFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BeforeSend { code } => write!(formatter, "before_send:{code}"),
            Self::AfterSend { code } => write!(formatter, "after_send:{code}"),
        }
    }
}

impl std::error::Error for WireFailure {}
