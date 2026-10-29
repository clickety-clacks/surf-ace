use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
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

pub struct WebSocketWire<S: Read + Write = TcpStream> {
    socket: WebSocket<MaybeTlsStream<S>>,
    deadline: Option<Instant>,
    max_response_bytes: Option<usize>,
}

impl WebSocketWire<TcpStream> {
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
}

impl WebSocketWire<DeadlineTcpStream> {
    pub fn connect_direct_bounded(
        endpoint: &str,
        timeout: Duration,
        max_response_bytes: usize,
    ) -> Result<Self, WireFailure> {
        let deadline =
            Instant::now()
                .checked_add(timeout)
                .ok_or_else(|| WireFailure::BeforeSend {
                    code: "reachability:deadline_exhausted".into(),
                })?;
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
        let addresses = resolve_addresses_bounded(host, port, deadline).map_err(|error| {
            WireFailure::BeforeSend {
                code: format!("reachability:{error}"),
            }
        })?;
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
        if Instant::now() >= deadline {
            return Err(WireFailure::BeforeSend {
                code: "reachability:deadline_exceeded".into(),
            });
        }
        let stream = DeadlineTcpStream::new(stream, deadline);
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
        let wire = Self {
            socket,
            deadline: Some(deadline),
            max_response_bytes: Some(max_response_bytes),
        };
        Ok(wire)
    }
}

pub struct DeadlineTcpStream {
    stream: TcpStream,
    deadline: Instant,
}

impl DeadlineTcpStream {
    fn new(stream: TcpStream, deadline: Instant) -> Self {
        Self { stream, deadline }
    }

    fn normalize_timeout(error: io::Error) -> io::Error {
        if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) {
            io::Error::new(io::ErrorKind::TimedOut, "deadline_exceeded")
        } else {
            error
        }
    }

    fn refresh_read_timeout(&self) -> io::Result<()> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "deadline_exceeded"));
        }
        self.stream.set_read_timeout(Some(remaining))
    }

    fn refresh_write_timeout(&self) -> io::Result<()> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "deadline_exceeded"));
        }
        self.stream.set_write_timeout(Some(remaining))
    }
}

impl Read for DeadlineTcpStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.refresh_read_timeout()?;
        self.stream.read(buffer).map_err(Self::normalize_timeout)
    }
}

impl Write for DeadlineTcpStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.refresh_write_timeout()?;
        self.stream.write(buffer).map_err(Self::normalize_timeout)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.refresh_write_timeout()?;
        self.stream.flush().map_err(Self::normalize_timeout)
    }
}

impl<S: Read + Write> WebSocketWire<S> {
    fn check_deadline(&self) -> io::Result<()> {
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "deadline_exceeded"));
        }
        Ok(())
    }
}

impl<S: Read + Write> DirectWire for WebSocketWire<S> {
    fn request(
        &mut self,
        id: &str,
        op: &str,
        payload: Value,
        sent: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<WireResponse, WireFailure> {
        self.check_deadline()
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
            self.check_deadline()
                .map_err(|error| WireFailure::AfterSend {
                    code: format!("deadline:{error}"),
                })?;
            let message = self.socket.read().map_err(|error| WireFailure::AfterSend {
                code: format!("response_read:{error}"),
            })?;
            self.check_deadline()
                .map_err(|error| WireFailure::AfterSend {
                    code: format!("deadline:{error}"),
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

fn resolve_addresses_bounded(
    host: &str,
    port: u16,
    deadline: Instant,
) -> io::Result<Vec<SocketAddr>> {
    if let Ok(address) = host.parse::<std::net::IpAddr>() {
        return Ok(vec![SocketAddr::new(address, port)]);
    }
    let reaper = resolver_reaper_sender()?;
    let executable = std::env::current_exe()?;
    let child = ProcessCommand::new(executable)
        .arg("--_surf_ace_internal_resolve_dns")
        .arg(host)
        .arg(port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    wait_for_resolver_process(
        &mut ChildResolverProcess {
            child: Some(child),
            reaper,
        },
        deadline,
    )
}

trait ResolverProcess {
    fn try_wait_success(&mut self) -> io::Result<Option<bool>>;
    fn read_addresses(&mut self) -> io::Result<Vec<SocketAddr>>;
    fn kill(&mut self) -> io::Result<()>;
    fn retain_for_background_reaping(&mut self) -> io::Result<()>;
}

struct ChildResolverProcess {
    child: Option<Child>,
    reaper: &'static mpsc::Sender<Child>,
}

impl ResolverProcess for ChildResolverProcess {
    fn try_wait_success(&mut self) -> io::Result<Option<bool>> {
        self.child
            .as_mut()
            .ok_or_else(|| io::Error::other("dns_helper_ownership_transferred"))?
            .try_wait()
            .map(|status| status.map(|status| status.success()))
    }

    fn read_addresses(&mut self) -> io::Result<Vec<SocketAddr>> {
        let mut output = String::new();
        self.child
            .as_mut()
            .ok_or_else(|| io::Error::other("dns_helper_ownership_transferred"))?
            .stdout
            .as_mut()
            .ok_or_else(|| io::Error::other("dns_helper_stdout_missing"))?
            .read_to_string(&mut output)?;
        output
            .lines()
            .map(|line| {
                line.parse()
                    .map_err(|error| io::Error::other(format!("dns_helper_output:{error}")))
            })
            .collect()
    }

    fn kill(&mut self) -> io::Result<()> {
        self.child
            .as_mut()
            .ok_or_else(|| io::Error::other("dns_helper_ownership_transferred"))?
            .kill()
    }

    fn retain_for_background_reaping(&mut self) -> io::Result<()> {
        let child = self
            .child
            .take()
            .ok_or_else(|| io::Error::other("dns_helper_ownership_already_transferred"))?;
        match self.reaper.send(child) {
            Ok(()) => Ok(()),
            Err(error) => {
                // The worker is intended to live for the process lifetime. If it
                // nevertheless exits, keep the Child handle owned and report the
                // failure instead of silently dropping an unreaped helper.
                resolver_reaper_stalled_children()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(error.0);
                Err(io::Error::other("dns_reaper_unavailable_child_retained"))
            }
        }
    }
}

// Keep resolver work inside the common request deadline while reserving time to
// terminate and reap its owned helper.
const RESOLVER_CLEANUP_RESERVE_MAX: Duration = Duration::from_millis(100);

fn wait_for_resolver_process(
    process: &mut impl ResolverProcess,
    deadline: Instant,
) -> io::Result<Vec<SocketAddr>> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    let cleanup_reserve = if remaining.is_zero() {
        Duration::ZERO
    } else {
        Duration::from_millis(1)
            .max(remaining / 10)
            .min(RESOLVER_CLEANUP_RESERVE_MAX)
    };
    let work_deadline = deadline
        .checked_sub(cleanup_reserve)
        .unwrap_or_else(Instant::now);
    loop {
        if Instant::now() >= work_deadline {
            let timeout = io::Error::new(io::ErrorKind::TimedOut, "dns_deadline_exceeded");
            return Err(cleanup_after_failure(process, timeout, deadline));
        }
        let status = match process.try_wait_success() {
            Ok(status) => status,
            Err(primary) => return Err(cleanup_after_failure(process, primary, deadline)),
        };
        if Instant::now() >= work_deadline {
            let timeout = io::Error::new(io::ErrorKind::TimedOut, "dns_deadline_exceeded");
            return Err(cleanup_after_failure(process, timeout, deadline));
        }
        if let Some(success) = status {
            if !success {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "dns_resolution_failed",
                ));
            }
            let addresses = process.read_addresses()?;
            if addresses.is_empty() {
                return Err(io::Error::new(io::ErrorKind::NotFound, "dns_no_addresses"));
            }
            return Ok(addresses);
        }
        thread::sleep(
            Duration::from_millis(5).min(work_deadline.saturating_duration_since(Instant::now())),
        );
    }
}

fn cleanup_after_failure(
    process: &mut impl ResolverProcess,
    primary: io::Error,
    cleanup_deadline: Instant,
) -> io::Error {
    match kill_and_reap_bounded(process, cleanup_deadline) {
        Ok(()) => primary,
        Err(cleanup) => io::Error::new(
            primary.kind(),
            format!("{primary}; dns_helper_cleanup_failed: {cleanup}"),
        ),
    }
}

fn kill_and_reap_bounded(
    process: &mut impl ResolverProcess,
    cleanup_deadline: Instant,
) -> io::Result<()> {
    let mut cleanup_errors = Vec::new();
    match process.try_wait_success() {
        Ok(Some(_)) => return Ok(()),
        Ok(None) => {}
        Err(error) => cleanup_errors.push(format!("poll:{error}")),
    }
    if let Err(error) = process.kill() {
        cleanup_errors.push(format!("kill:{error}"));
    }

    loop {
        match process.try_wait_success() {
            Ok(Some(_)) => {
                return if cleanup_errors.is_empty() {
                    Ok(())
                } else {
                    Err(io::Error::other(cleanup_errors.join("; ")))
                };
            }
            Ok(None) => {}
            Err(error) => cleanup_errors.push(format!("poll:{error}")),
        }
        let remaining = cleanup_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            match process.retain_for_background_reaping() {
                Ok(()) => cleanup_errors.push("ownership transferred to background reaper".into()),
                Err(error) => cleanup_errors.push(format!("ownership retention:{error}")),
            }
            cleanup_errors.push("dns_reap_deadline_exceeded".into());
            return Err(io::Error::other(cleanup_errors.join("; ")));
        }
        thread::sleep(Duration::from_millis(5).min(remaining));
    }
}

static RESOLVER_REAPER: OnceLock<Result<mpsc::Sender<Child>, String>> = OnceLock::new();
static RESOLVER_REAPER_STALLED_CHILDREN: Mutex<Vec<Child>> = Mutex::new(Vec::new());

fn resolver_reaper_sender() -> io::Result<&'static mpsc::Sender<Child>> {
    // Initialize ownership transfer before spawning a helper, so deadline
    // cleanup never has to drop an unresolved Child handle.
    RESOLVER_REAPER
        .get_or_init(|| {
            let (sender, receiver) = mpsc::channel::<Child>();
            thread::Builder::new()
                .name("surf-ace-dns-reaper".into())
                .spawn(move || {
                    while let Ok(mut child) = receiver.recv() {
                        loop {
                            match child.try_wait() {
                                Ok(Some(_)) => break,
                                Ok(None) | Err(_) => {}
                            }
                            let _ = child.kill();
                            thread::sleep(Duration::from_millis(50));
                        }
                    }
                })
                .map_err(|error| error.to_string())?;
            Ok(sender)
        })
        .as_ref()
        .map_err(|error| io::Error::other(error.clone()))
}

fn resolver_reaper_stalled_children() -> &'static Mutex<Vec<Child>> {
    &RESOLVER_REAPER_STALLED_CHILDREN
}

/// Entry point used only by the CLI's isolated DNS helper process.
pub fn run_internal_dns_resolver(arguments: &[String]) -> Option<i32> {
    if arguments.first().map(String::as_str) != Some("--_surf_ace_internal_resolve_dns") {
        return None;
    }
    if arguments.len() != 3 {
        return Some(2);
    }
    let Ok(port) = arguments[2].parse::<u16>() else {
        return Some(2);
    };
    let Ok(addresses) = (arguments[1].as_str(), port).to_socket_addrs() else {
        return Some(1);
    };
    let mut count = 0;
    for address in addresses {
        println!("{address}");
        count += 1;
    }
    Some(if count == 0 { 1 } else { 0 })
}

#[cfg(test)]
mod deadline_tests {
    use super::{
        wait_for_resolver_process, DirectWire, ResolverProcess, WebSocketWire, WireFailure,
    };
    use serde_json::json;
    use std::io::{self, Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn resolver_deadline_kills_and_reaps_the_blocked_helper() {
        struct PendingResolver {
            killed: bool,
            reaped: bool,
        }
        impl ResolverProcess for PendingResolver {
            fn try_wait_success(&mut self) -> io::Result<Option<bool>> {
                if self.killed {
                    self.reaped = true;
                    Ok(Some(false))
                } else {
                    Ok(None)
                }
            }
            fn read_addresses(&mut self) -> io::Result<Vec<SocketAddr>> {
                unreachable!()
            }
            fn kill(&mut self) -> io::Result<()> {
                self.killed = true;
                Ok(())
            }
            fn retain_for_background_reaping(&mut self) -> io::Result<()> {
                unreachable!("the local kill should reap before the cleanup deadline")
            }
        }
        let mut resolver = PendingResolver {
            killed: false,
            reaped: false,
        };
        let start = Instant::now();
        let result = wait_for_resolver_process(&mut resolver, start + Duration::from_millis(40));
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(resolver.killed);
        assert!(resolver.reaped);
        assert!(start.elapsed() < Duration::from_millis(250));
    }

    #[test]
    fn resolver_poll_failure_attempts_cleanup_and_preserves_the_primary_error() {
        struct PollFailureResolver {
            polls: usize,
            killed: bool,
            reaped: bool,
            cleanup_poll_failed: bool,
        }
        impl ResolverProcess for PollFailureResolver {
            fn try_wait_success(&mut self) -> io::Result<Option<bool>> {
                self.polls += 1;
                if self.killed {
                    if !self.cleanup_poll_failed {
                        self.cleanup_poll_failed = true;
                        return Err(io::Error::other("reap_poll_failure"));
                    }
                    self.reaped = true;
                    Ok(Some(false))
                } else {
                    Err(io::Error::new(io::ErrorKind::BrokenPipe, "poll_failure"))
                }
            }
            fn read_addresses(&mut self) -> io::Result<Vec<SocketAddr>> {
                unreachable!()
            }
            fn kill(&mut self) -> io::Result<()> {
                self.killed = true;
                Ok(())
            }
            fn retain_for_background_reaping(&mut self) -> io::Result<()> {
                unreachable!("cleanup should reap after the poll error")
            }
        }

        let mut resolver = PollFailureResolver {
            polls: 0,
            killed: false,
            reaped: false,
            cleanup_poll_failed: false,
        };
        let result =
            wait_for_resolver_process(&mut resolver, Instant::now() + Duration::from_millis(100))
                .unwrap_err();
        assert_eq!(result.kind(), io::ErrorKind::BrokenPipe);
        assert!(result.to_string().contains("poll_failure"));
        assert!(result.to_string().contains("reap_poll_failure"));
        assert!(resolver.killed);
        assert!(resolver.reaped);
        assert!(resolver.polls >= 2);
    }

    #[test]
    fn resolver_cleanup_bounds_delayed_reap_and_retains_the_child_after_kill_error() {
        struct DelayedReapResolver {
            killed_at: Option<Instant>,
            retained: bool,
        }
        impl ResolverProcess for DelayedReapResolver {
            fn try_wait_success(&mut self) -> io::Result<Option<bool>> {
                Ok(self.killed_at.and_then(|killed_at| {
                    (killed_at.elapsed() >= Duration::from_millis(150)).then_some(false)
                }))
            }
            fn read_addresses(&mut self) -> io::Result<Vec<SocketAddr>> {
                unreachable!()
            }
            fn kill(&mut self) -> io::Result<()> {
                self.killed_at = Some(Instant::now());
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "kill_failure",
                ))
            }
            fn retain_for_background_reaping(&mut self) -> io::Result<()> {
                self.retained = true;
                Ok(())
            }
        }

        let mut resolver = DelayedReapResolver {
            killed_at: None,
            retained: false,
        };
        let start = Instant::now();
        let result = wait_for_resolver_process(&mut resolver, start + Duration::from_millis(40))
            .unwrap_err();
        assert_eq!(result.kind(), io::ErrorKind::TimedOut);
        assert!(result.to_string().contains("dns_deadline_exceeded"));
        assert!(result.to_string().contains("kill_failure"));
        assert!(
            resolver.retained,
            "bounded cleanup must transfer unresolved ownership"
        );
        assert!(start.elapsed() < Duration::from_millis(120));
    }

    #[test]
    fn fragmented_response_reads_share_one_absolute_deadline_and_drop_the_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            assert!(matches!(
                socket.read().unwrap(),
                tungstenite::Message::Text(_)
            ));
            let response = json!({
                "id": "rq_deadline_test", "op": "surface.describe", "type": "response",
                "v": 1, "ok": true, "payload": {}
            })
            .to_string()
            .into_bytes();
            let chunks = 8;
            for index in 0..chunks {
                let start = response.len() * index / chunks;
                let end = response.len() * (index + 1) / chunks;
                let fin = index + 1 == chunks;
                let opcode = if index == 0 { 0x01 } else { 0x00 };
                let first = opcode | if fin { 0x80 } else { 0x00 };
                let payload = &response[start..end];
                let stream = socket.get_mut();
                if stream.write_all(&[first, payload.len() as u8]).is_err()
                    || stream.write_all(payload).is_err()
                    || stream.flush().is_err()
                {
                    return true;
                }
                if !fin {
                    thread::sleep(Duration::from_millis(70));
                }
            }
            let stream = socket.get_mut();
            let mut bytes = [0; 64];
            loop {
                match stream.read(&mut bytes) {
                    Ok(0) => return true,
                    Ok(_) => continue,
                    Err(_) => return false,
                }
            }
        });

        let started = Instant::now();
        let timeout = Duration::from_millis(220);
        let mut wire =
            WebSocketWire::connect_direct_bounded(&format!("ws://{address}"), timeout, 65_536)
                .unwrap();
        let mut sent = || Ok(());
        let result = wire.request("rq_deadline_test", "surface.describe", json!({}), &mut sent);
        assert!(matches!(result, Err(WireFailure::AfterSend { .. })));
        assert!(
            started.elapsed() < timeout + Duration::from_millis(180),
            "operation exceeded its absolute deadline: {:?}",
            started.elapsed()
        );
        drop(wire);
        assert!(server.join().unwrap(), "timed-out socket must be closed");
    }

    #[test]
    fn websocket_handshake_uses_the_same_absolute_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(500));
            stream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut bytes = [0; 64];
            loop {
                match stream.read(&mut bytes) {
                    Ok(0) => return true,
                    Ok(_) => continue,
                    Err(_) => return false,
                }
            }
        });
        let timeout = Duration::from_millis(180);
        let started = Instant::now();
        let result =
            WebSocketWire::connect_direct_bounded(&format!("ws://{address}"), timeout, 65_536);
        assert!(result.is_err());
        assert!(
            started.elapsed() < timeout + Duration::from_millis(140),
            "handshake exceeded its absolute deadline: {:?}",
            started.elapsed()
        );
        assert!(
            server.join().unwrap(),
            "timed-out handshake socket must be closed"
        );
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
