use serde_json::{json, Value};
use std::net::TcpListener;
use std::process::Command;
use std::thread;
use tempfile::TempDir;
use tungstenite::{accept, Message, WebSocket};

const EPOCH: &str = "0123456789abcdef0123456789abcdef";

fn request(socket: &mut WebSocket<std::net::TcpStream>, expected: &str) -> Value {
    let message = socket.read().unwrap();
    let Message::Text(text) = message else { panic!("expected text request") };
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["type"], "request");
    assert_eq!(value["op"], expected);
    value
}

fn respond(socket: &mut WebSocket<std::net::TcpStream>, request: &Value, payload: Value) {
    socket.send(Message::Text(json!({"v":1,"type":"response","op":request["op"],
        "id":request["id"],"ok":true,"sentAt":1,"payload":payload}).to_string().into())).unwrap();
}

fn hello(socket: &mut WebSocket<std::net::TcpStream>) {
    let request = request(socket, "annotation.hello");
    assert_eq!(request["payload"], json!({"protocolVersion":1,"role":"consumer"}));
    respond(socket, &request, json!({"registryId":"test","journalEpoch":EPOCH,
        "availableFromCursor":null,"headCursor":null,"limits":{},"usage":{}}));
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
        respond(&mut socket, &watch, json!({"consumerId":"reviewer",
            "leaseId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ackCursor":null,
            "initialFromCursor":{"epoch":EPOCH,"sequence":"1"},
            "availableFromCursor":null,"headCursor":null,
            "historyCompleteSinceStart":true,
            "limits":{"replayPolicy":{"targetAcknowledgedHistoryDays":30,
                "pressureCompaction":true,"requireActualConsumerAcknowledgement":true}}}));
        socket.send(Message::Text(json!({"v":1,"type":"event","op":"annotation.record",
            "eventId":"e1","sentAt":2,"payload":{"serverCursor":{"epoch":EPOCH,"sequence":"1"},
            "record":{"kind":"live_delta"},"committedAt":2}}).to_string().into())).unwrap();
        socket.close(None).unwrap();

        let (stream, _) = listener.accept().unwrap();
        let mut socket = accept(stream).unwrap();
        hello(&mut socket);
        let ack = request(&mut socket, "annotation.ack");
        assert_eq!(ack["payload"], json!({"consumerId":"reviewer",
            "leaseId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "throughCursor":{"epoch":EPOCH,"sequence":"1"}}));
        respond(&mut socket, &ack, json!({"ackCursor":{"epoch":EPOCH,"sequence":"1"}}));
    });
    let registry = format!("ws://{address}");
    let cursor = format!("ann1:{EPOCH}:1");
    let common = ["--registry", registry.as_str(), "--state-root", root.path().to_str().unwrap(),
        "annotations"];
    let watch = Command::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(common).args(["watch", "--consumer-id", "reviewer"]).output().unwrap();
    assert!(!watch.status.success());
    let lines: Vec<Value> = String::from_utf8(watch.stdout).unwrap().lines()
        .map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["type"], "annotation.subscription");
    assert_eq!(lines[0]["historyCompleteSinceStart"], true);
    assert_eq!(lines[0]["replayPolicy"]["targetAcknowledgedHistoryDays"], 30);
    assert_eq!(lines[1]["op"], "annotation.record");
    assert!(lines[2]["error"]["code"].as_str().unwrap().starts_with("annotation_"));
    let state_file = std::fs::read_dir(root.path().join("annotations")).unwrap()
        .map(|entry| entry.unwrap().path()).find(|path| path.extension().is_some_and(|ext| ext == "json")).unwrap();
    let state: Value = serde_json::from_slice(&std::fs::read(state_file).unwrap()).unwrap();
    assert_eq!(state["lastDeliveredCursor"], format!("ann1:{EPOCH}:1"));
    assert_eq!(state["ackCursor"], Value::Null);
    let ack = Command::new(env!("CARGO_BIN_EXE_surf-ace"))
        .args(common).args(["ack", "--consumer-id", "reviewer", "--cursor", cursor.as_str()]).output().unwrap();
    assert!(ack.status.success(), "{}", String::from_utf8_lossy(&ack.stdout));
    let output: Value = serde_json::from_slice(&ack.stdout).unwrap();
    assert_eq!(output["ackCursor"], format!("ann1:{EPOCH}:1"));
    server.join().unwrap();
}
