use serde_json::{json, Value};
use std::net::TcpListener;
use std::process::Command;
use std::thread;
use std::time::Duration;
use tempfile::TempDir;
use tungstenite::{accept, Message, WebSocket};

const EPOCH: &str = "0123456789abcdef0123456789abcdef";

fn request(socket: &mut WebSocket<std::net::TcpStream>, expected: &str) -> Value {
    let message = socket.read().unwrap();
    let Message::Text(text) = message else {
        panic!("expected text request")
    };
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["type"], "request");
    assert_eq!(value["op"], expected);
    value
}

fn respond(socket: &mut WebSocket<std::net::TcpStream>, request: &Value, payload: Value) {
    socket
        .send(Message::Text(
            json!({"v":1,"type":"response","op":request["op"],
        "id":request["id"],"ok":true,"sentAt":1,"payload":payload})
            .to_string()
            .into(),
        ))
        .unwrap();
}

fn hello(socket: &mut WebSocket<std::net::TcpStream>) {
    let request = request(socket, "annotation.hello");
    assert_eq!(
        request["payload"],
        json!({"protocolVersion":1,"role":"consumer"})
    );
    respond(
        socket,
        &request,
        json!({"registryId":"test","journalEpoch":EPOCH,
        "availableFromCursor":null,"headCursor":null,"limits":{},"usage":{}}),
    );
}

#[test]
fn watch_persists_delivery_without_ack_then_explicit_ack_uses_same_lease() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let root = TempDir::new().unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut socket = accept(stream).unwrap();
        hello(&mut socket);
        let watch = request(&mut socket, "annotation.watch");
        assert_eq!(watch["payload"], json!({"consumerId":"reviewer"}));
        respond(
            &mut socket,
            &watch,
            json!({"consumerId":"reviewer",
            "leaseId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ackCursor":null,
            "initialFromCursor":{"epoch":EPOCH,"sequence":"1"},
            "availableFromCursor":null,"headCursor":null,
            "historyCompleteSinceStart":true,
            "limits":{"replayPolicy":{"targetAcknowledgedHistoryDays":30,
                "pressureCompaction":true,"requireActualConsumerAcknowledgement":true}}}),
        );
        socket
            .send(Message::Text(
                json!({"v":1,"type":"event","op":"annotation.record",
            "eventId":"e1","sentAt":2,"payload":{"serverCursor":{"epoch":EPOCH,"sequence":"1"},
            "record":{"kind":"live_delta"},"committedAt":2}})
                .to_string()
                .into(),
            ))
            .unwrap();
        socket.close(None).unwrap();

        let (stream, _) = listener.accept().unwrap();
        let mut socket = accept(stream).unwrap();
        hello(&mut socket);
        let ack = request(&mut socket, "annotation.ack");
        assert_eq!(
            ack["payload"],
            json!({"consumerId":"reviewer",
            "leaseId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "throughCursor":{"epoch":EPOCH,"sequence":"1"}})
        );
        respond(
            &mut socket,
            &ack,
            json!({"ackCursor":{"epoch":EPOCH,"sequence":"1"}}),
        );
    });
    let registry = format!("ws://{address}");
    let cursor = format!("ann1:{EPOCH}:1");
    let common = [
        "--registry",
        registry.as_str(),
        "--state-root",
        root.path().to_str().unwrap(),
        "annotations",
    ];
    let watch = Command::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(common)
        .args(["watch", "--consumer-id", "reviewer"])
        .output()
        .unwrap();
    assert!(!watch.status.success());
    let lines: Vec<Value> = String::from_utf8(watch.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["type"], "annotation.subscription");
    assert_eq!(lines[0]["historyCompleteSinceStart"], true);
    assert_eq!(
        lines[0]["replayPolicy"]["targetAcknowledgedHistoryDays"],
        30
    );
    assert_eq!(lines[1]["op"], "annotation.record");
    assert!(lines[2]["error"]["code"]
        .as_str()
        .unwrap()
        .starts_with("annotation_"));
    let state_file = std::fs::read_dir(root.path().join("annotations"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "json"))
        .unwrap();
    let state: Value = serde_json::from_slice(&std::fs::read(state_file).unwrap()).unwrap();
    assert_eq!(state["lastDeliveredCursor"], format!("ann1:{EPOCH}:1"));
    assert_eq!(state["ackCursor"], Value::Null);
    let ack = Command::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(common)
        .args([
            "ack",
            "--consumer-id",
            "reviewer",
            "--cursor",
            cursor.as_str(),
        ])
        .output()
        .unwrap();
    assert!(
        ack.status.success(),
        "{}",
        String::from_utf8_lossy(&ack.stdout)
    );
    let output: Value = serde_json::from_slice(&ack.stdout).unwrap();
    assert_eq!(output["ackCursor"], format!("ann1:{EPOCH}:1"));
    server.join().unwrap();
}

#[test]
fn foreground_watcher_preserves_ack_written_by_separate_process() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let root = TempDir::new().unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut watch_socket = accept(stream).unwrap();
        hello(&mut watch_socket);
        let watch = request(&mut watch_socket, "annotation.watch");
        respond(
            &mut watch_socket,
            &watch,
            json!({"consumerId":"reviewer",
            "leaseId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ackCursor":null,
            "initialFromCursor":{"epoch":EPOCH,"sequence":"1"},
            "availableFromCursor":null,"headCursor":null,"historyCompleteSinceStart":true,
            "limits":{"replayPolicy":{"targetAcknowledgedHistoryDays":30}}}),
        );
        watch_socket
            .send(Message::Text(
                json!({"v":1,"type":"event","op":"annotation.record",
            "eventId":"e1","sentAt":2,"payload":{"serverCursor":{"epoch":EPOCH,"sequence":"1"},
            "record":{"kind":"live_delta"},"committedAt":2}})
                .to_string()
                .into(),
            ))
            .unwrap();
        let (stream, _) = listener.accept().unwrap();
        let mut ack_socket = accept(stream).unwrap();
        hello(&mut ack_socket);
        let ack = request(&mut ack_socket, "annotation.ack");
        respond(
            &mut ack_socket,
            &ack,
            json!({"ackCursor":{"epoch":EPOCH,"sequence":"1"}}),
        );
        watch_socket
            .send(Message::Text(
                json!({"v":1,"type":"event","op":"annotation.record",
            "eventId":"e2","sentAt":3,"payload":{"serverCursor":{"epoch":EPOCH,"sequence":"2"},
            "record":{"kind":"live_delta"},"committedAt":3}})
                .to_string()
                .into(),
            ))
            .unwrap();
        watch_socket
            .send(Message::Text(
                json!({"v":1,"type":"event","op":"annotation.lease_replaced",
            "eventId":"e3","sentAt":4,"payload":{"consumerId":"reviewer",
            "leaseId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}})
                .to_string()
                .into(),
            ))
            .unwrap();
    });
    let registry = format!("ws://{address}");
    let state_root = root.path().to_str().unwrap();
    let common = [
        "--registry",
        registry.as_str(),
        "--state-root",
        state_root,
        "annotations",
    ];
    let child = Command::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(common)
        .args(["watch", "--consumer-id", "reviewer"])
        .spawn()
        .unwrap();
    let mut state_file = None;
    for _ in 0..100 {
        if let Ok(entries) = std::fs::read_dir(root.path().join("annotations")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "json") {
                    if let Ok(bytes) = std::fs::read(&path) {
                        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                            if value["lastDeliveredCursor"] == format!("ann1:{EPOCH}:1") {
                                state_file = Some(path);
                                break;
                            }
                        }
                    }
                }
            }
        }
        if state_file.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let state_file = state_file.expect("first record persisted");
    let ack = Command::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(common)
        .args([
            "ack",
            "--consumer-id",
            "reviewer",
            "--cursor",
            &format!("ann1:{EPOCH}:1"),
        ])
        .output()
        .unwrap();
    assert!(
        ack.status.success(),
        "{}",
        String::from_utf8_lossy(&ack.stdout)
    );
    let status = child.wait_with_output().unwrap();
    assert!(status.status.success());
    server.join().unwrap();
    let state: Value = serde_json::from_slice(&std::fs::read(state_file).unwrap()).unwrap();
    assert_eq!(state["ackCursor"], format!("ann1:{EPOCH}:1"));
    assert_eq!(state["lastDeliveredCursor"], format!("ann1:{EPOCH}:2"));
}

#[test]
fn history_gap_requires_explicit_gap_ack_before_confirmed_retirement() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let root = TempDir::new().unwrap();
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut watch_socket = accept(stream).unwrap();
        hello(&mut watch_socket);
        let watch = request(&mut watch_socket, "annotation.watch");
        assert_eq!(
            watch["payload"]["fromCursor"],
            json!({"epoch":EPOCH,"sequence":"1"})
        );
        respond(
            &mut watch_socket,
            &watch,
            json!({"consumerId":"gap-reader",
            "leaseId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","ackCursor":null,
            "initialFromCursor":{"epoch":EPOCH,"sequence":"1"},
            "availableFromCursor":{"epoch":EPOCH,"sequence":"2"},
            "headCursor":{"epoch":EPOCH,"sequence":"2"},"historyCompleteSinceStart":false,
            "limits":{"replayPolicy":{"targetAcknowledgedHistoryDays":30}}}),
        );
        watch_socket
            .send(Message::Text(
                json!({"v":1,"type":"event","op":"annotation.history_gap",
            "eventId":"gap-event","sentAt":2,"payload":{"gapId":"gap-1",
            "requestedCursor":{"epoch":EPOCH,"sequence":"1"},
            "availableFromCursor":{"epoch":EPOCH,"sequence":"2"},
            "throughCursor":{"epoch":EPOCH,"sequence":"1"},
            "headCursor":{"epoch":EPOCH,"sequence":"2"},"reason":"cursor_expired"}})
                .to_string()
                .into(),
            ))
            .unwrap();
        watch_socket.close(None).unwrap();

        let (stream, _) = listener.accept().unwrap();
        let mut ack_socket = accept(stream).unwrap();
        hello(&mut ack_socket);
        let ack = request(&mut ack_socket, "annotation.gap.ack");
        assert_eq!(
            ack["payload"],
            json!({"consumerId":"gap-reader",
            "leaseId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","gapId":"gap-1"})
        );
        respond(
            &mut ack_socket,
            &ack,
            json!({"ackCursor":{"epoch":EPOCH,"sequence":"1"},"gapId":"gap-1"}),
        );

        let (stream, _) = listener.accept().unwrap();
        let mut retire_socket = accept(stream).unwrap();
        hello(&mut retire_socket);
        let retire = request(&mut retire_socket, "annotation.consumer.retire");
        assert_eq!(
            retire["payload"],
            json!({"consumerId":"gap-reader",
            "expectedAckCursor":{"epoch":EPOCH,"sequence":"1"},
            "discardUnacknowledged":true})
        );
        respond(
            &mut retire_socket,
            &retire,
            json!({"consumerId":"gap-reader","retired":true,
            "expectedAckCursor":{"epoch":EPOCH,"sequence":"1"},
            "discardedFromCursor":{"epoch":EPOCH,"sequence":"2"},
            "discardedThroughCursor":{"epoch":EPOCH,"sequence":"2"}}),
        );
    });
    let registry = format!("ws://{address}");
    let state_root = root.path().to_str().unwrap();
    let common = [
        "--registry",
        registry.as_str(),
        "--state-root",
        state_root,
        "annotations",
    ];
    let cursor = format!("ann1:{EPOCH}:1");
    let watch = Command::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(common)
        .args([
            "watch",
            "--consumer-id",
            "gap-reader",
            "--from",
            cursor.as_str(),
        ])
        .output()
        .unwrap();
    assert!(!watch.status.success());
    let lines: Vec<Value> = String::from_utf8(watch.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines[0]["historyCompleteSinceStart"], false);
    assert_eq!(lines[1]["op"], "annotation.history_gap");
    let ack = Command::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(common)
        .args(["ack", "--consumer-id", "gap-reader", "--gap-id", "gap-1"])
        .output()
        .unwrap();
    assert!(
        ack.status.success(),
        "{}",
        String::from_utf8_lossy(&ack.stdout)
    );
    let ack_json: Value = serde_json::from_slice(&ack.stdout).unwrap();
    assert_eq!(ack_json["ackCursor"], cursor);
    let retire = Command::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(common)
        .args([
            "retire",
            "--consumer-id",
            "gap-reader",
            "--expect-ack",
            cursor.as_str(),
            "--discard-unacknowledged",
        ])
        .output()
        .unwrap();
    assert!(
        retire.status.success(),
        "{}",
        String::from_utf8_lossy(&retire.stdout)
    );
    let retired: Value = serde_json::from_slice(&retire.stdout).unwrap();
    assert_eq!(retired["payload"]["retired"], true);
    server.join().unwrap();
}
