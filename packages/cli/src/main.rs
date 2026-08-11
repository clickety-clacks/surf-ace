use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::path::PathBuf;
use surf_ace_cli::{execute, Command, Invocation};

fn main() {
    match parse().and_then(execute) {
        Ok(output) => {
            println!(
                "{}",
                serde_json::to_string(&output).expect("CLI output is serializable")
            );
        }
        Err(error) => {
            println!(
                "{}",
                serde_json::to_string(&json!({
                    "error": { "code": error.code(), "details": error.details() },
                    "ok": false,
                }))
                .expect("CLI error is serializable")
            );
            std::process::exit(1);
        }
    }
}

fn parse() -> Result<Invocation, surf_ace_cli::CliError> {
    let mut args = env::args().skip(1).peekable();
    let mut socket_path: Option<PathBuf> = None;
    let mut input_json = None;
    let mut command = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--socket" => socket_path = Some(PathBuf::from(value(&mut args, "socket")?)),
            "--input-json" => input_json = Some(value(&mut args, "input-json")?),
            value if command.is_none() => {
                command = Command::parse(value);
                if command.is_none() {
                    return Err(input_error("command"));
                }
            }
            _ => return Err(input_error("argument")),
        }
    }
    let command = command.ok_or_else(|| input_error("command"))?;
    let socket_path = socket_path
        .or_else(|| env::var_os("SURF_ACE_CONTROLLER_SOCKET").map(PathBuf::from))
        .ok_or_else(|| input_error("socket"))?;
    let encoded = if let Some(input) = input_json {
        input
    } else {
        let mut input = String::new();
        io::stdin()
            .read_to_string(&mut input)
            .map_err(|_| input_error("stdin"))?;
        if input.trim().is_empty() {
            "{}".into()
        } else {
            input
        }
    };
    let input = serde_json::from_str::<Value>(&encoded)
        .map_err(|_| input_error("input-json"))?
        .as_object()
        .cloned()
        .ok_or_else(|| input_error("input-json-object"))?;
    Ok(Invocation {
        command,
        input,
        socket_path,
    })
}

fn value(
    args: &mut std::iter::Peekable<impl Iterator<Item = String>>,
    name: &str,
) -> Result<String, surf_ace_cli::CliError> {
    args.next().ok_or_else(|| input_error(name))
}

fn input_error(field: &str) -> surf_ace_cli::CliError {
    surf_ace_cli::CliError::Input(format!("missing_or_invalid:{field}"))
}
