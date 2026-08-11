use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::thread;
use surf_ace_cli::{execute, CliError, Command, Invocation};

fn invocation(socket_path: std::path::PathBuf) -> Invocation {
    Invocation {
        command: Command::List,
        input: serde_json::Map::new(),
        socket_path,
    }
}

#[test]
fn cli_is_a_thin_local_controller_client() {
    let directory = tempfile::tempdir().unwrap();
    let socket_path = directory.path().join("controller.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut encoded = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut encoded)
            .unwrap();
        let request: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(request["v"], 1);
        assert_eq!(request["command"], "list");
        assert_eq!(request["input"], json!({}));
        let response = json!({
            "id": request["id"],
            "ok": true,
            "result": {
                "command": "list",
                "controllerInstanceId": "ci_resident",
                "ok": true,
                "reconciliations": [],
                "result": { "surfaces": [] }
            },
            "v": 1
        });
        writeln!(stream, "{response}").unwrap();
    });

    let output = execute(invocation(socket_path)).unwrap();
    assert_eq!(output["controllerInstanceId"], "ci_resident");
    assert_eq!(output["result"]["surfaces"], json!([]));
    server.join().unwrap();
}

#[test]
fn cli_refuses_controller_response_for_another_request() {
    let directory = tempfile::tempdir().unwrap();
    let socket_path = directory.path().join("controller.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut encoded = String::new();
        BufReader::new(stream.try_clone().unwrap())
            .read_line(&mut encoded)
            .unwrap();
        writeln!(
            stream,
            "{}",
            json!({
                "id": "wrong",
                "ok": true,
                "result": {},
                "v": 1
            })
        )
        .unwrap();
    });

    let error = execute(invocation(socket_path)).unwrap_err();
    assert!(matches!(error, CliError::Protocol(ref detail)
        if detail == "controller_response_mismatch"));
    server.join().unwrap();
}

#[test]
fn every_command_validates_before_local_transport() {
    let directory = tempfile::tempdir().unwrap();
    for command in Command::ALL {
        let input = match command {
            Command::List => serde_json::Map::new(),
            _ => serde_json::Map::new(),
        };
        let result = execute(Invocation {
            command,
            input,
            socket_path: directory.path().join("absent.sock"),
        });
        if command == Command::List {
            assert!(matches!(result, Err(CliError::Transport(_))));
        } else {
            assert!(matches!(result, Err(CliError::Input(_))), "{command:?}");
        }
    }
}
