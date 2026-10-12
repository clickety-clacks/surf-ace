use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tungstenite::client::{client_with_config, uri_mode, IntoClientRequest};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::stream::Mode;
use tungstenite::{client_tls_with_config, connect, Message, WebSocket};

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
    #[serde(rename = "sentAt", skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<u64>,
}

impl Envelope {
    pub fn request(id: String, op: &str, payload: Value, sent_at: u64) -> Self {
        Self {
            id: Some(id),
            op: op.into(),
            payload: Some(payload),
            envelope_type: "request".into(),
            v: 1,
            ok: None,
            error: None,
            sent_at: Some(sent_at),
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
    deadline: Option<Instant>,
    max_response_bytes: Option<usize>,
}

impl WebSocketWire {
    pub fn connect_direct(endpoint: &str) -> Result<Self, WireFailure> {
        let (socket, _) = connect(endpoint).map_err(|error| WireFailure::BeforeSend {
            code: format!("reachability:{error}"),
        })?;
        Ok(Self {
            socket,
            deadline: None,
            max_response_bytes: None,
        })
    }

    pub fn connect_direct_bounded(
        endpoint: &str,
        timeout: Duration,
        max_response_bytes: usize,
    ) -> Result<Self, WireFailure> {
        let deadline = Instant::now() + timeout;
        let request = endpoint
            .into_client_request()
            .map_err(|error| WireFailure::BeforeSend {
                code: format!("reachability:{error}"),
            })?;
        let uri = request.uri();
        let mode = uri_mode(uri).map_err(|error| WireFailure::BeforeSend {
            code: format!("reachability:{error}"),
        })?;
        let host = uri.host().ok_or_else(|| WireFailure::BeforeSend {
            code: "reachability:missing_host".into(),
        })?;
        let host = host
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(host);
        let port = uri.port_u16().unwrap_or(match mode {
            Mode::Plain => 80,
            Mode::Tls => 443,
        });
        let addresses = (host, port)
            .to_socket_addrs()
            .map_err(|error| WireFailure::BeforeSend {
                code: format!("reachability:{error}"),
            })?
            .collect::<Vec<_>>();
        let mut last_connect_error = None;
        let mut stream = None;
        for address in addresses {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match TcpStream::connect_timeout(&address, remaining) {
                Ok(connected) => {
                    stream = Some(connected);
                    break;
                }
                Err(error) => last_connect_error = Some(error),
            }
        }
        let stream = stream.ok_or_else(|| WireFailure::BeforeSend {
            code: format!(
                "reachability:{}",
                last_connect_error
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "deadline_exceeded".into())
            ),
        })?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(WireFailure::BeforeSend {
                code: "reachability:deadline_exceeded".into(),
            });
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| WireFailure::BeforeSend {
                code: format!("reachability:{error}"),
            })?;
        stream
            .set_write_timeout(Some(remaining))
            .map_err(|error| WireFailure::BeforeSend {
                code: format!("reachability:{error}"),
            })?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(max_response_bytes))
            .max_frame_size(Some(max_response_bytes));
        let socket = match mode {
            Mode::Plain => client_with_config(request, MaybeTlsStream::Plain(stream), Some(config))
                .map(|(socket, _)| socket)
                .map_err(|error| WireFailure::BeforeSend {
                    code: format!("reachability:{error}"),
                })?,
            Mode::Tls => client_tls_with_config(request, stream, Some(config), None)
                .map(|(socket, _)| socket)
                .map_err(|error| WireFailure::BeforeSend {
                    code: format!("reachability:{error}"),
                })?,
        };
        if Instant::now() >= deadline {
            return Err(WireFailure::BeforeSend {
                code: "reachability:deadline_exceeded".into(),
            });
        }
        let mut wire = Self {
            socket,
            deadline: Some(deadline),
            max_response_bytes: Some(max_response_bytes),
        };
        wire.refresh_timeouts()
            .map_err(|error| WireFailure::BeforeSend {
                code: format!("reachability:{error}"),
            })?;
        Ok(wire)
    }

    fn refresh_timeouts(&mut self) -> io::Result<()> {
        let Some(deadline) = self.deadline else {
            return Ok(());
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "deadline_exceeded"));
        }
        match self.socket.get_mut() {
            MaybeTlsStream::Plain(stream) => {
                stream.set_read_timeout(Some(remaining))?;
                stream.set_write_timeout(Some(remaining))?;
            }
            MaybeTlsStream::Rustls(stream) => {
                stream.sock.set_read_timeout(Some(remaining))?;
                stream.sock.set_write_timeout(Some(remaining))?;
            }
            _ => {}
        }
        Ok(())
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
        self.refresh_timeouts()
            .map_err(|error| WireFailure::BeforeSend {
                code: format!("deadline:{error}"),
            })?;
        let sent_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| WireFailure::BeforeSend {
                code: format!("request_clock:{error}"),
            })?
            .as_millis()
            .try_into()
            .map_err(|error| WireFailure::BeforeSend {
                code: format!("request_clock:{error}"),
            })?;
        let request = Envelope::request(id.to_owned(), op, payload, sent_at);
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
        let mut received_bytes = 0usize;
        loop {
            self.refresh_timeouts()
                .map_err(|error| WireFailure::AfterSend {
                    code: format!("deadline:{error}"),
                })?;
            let message = self.socket.read().map_err(|error| WireFailure::AfterSend {
                code: format!("response_read:{error}"),
            })?;
            if let Some(maximum) = self.max_response_bytes {
                let bytes = match &message {
                    Message::Text(text) => text.len(),
                    Message::Binary(bytes) => bytes.len(),
                    Message::Ping(bytes) | Message::Pong(bytes) => bytes.len(),
                    Message::Close(_) | Message::Frame(_) => 0,
                };
                received_bytes = received_bytes.saturating_add(bytes);
                if received_bytes > maximum {
                    return Err(WireFailure::AfterSend {
                        code: "response_too_large".into(),
                    });
                }
            }
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
                if self
                    .deadline
                    .is_some_and(|deadline| Instant::now() > deadline)
                {
                    return Err(WireFailure::AfterSend {
                        code: "deadline_exceeded".into(),
                    });
                }
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
