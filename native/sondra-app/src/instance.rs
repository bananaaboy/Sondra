//! One Sondra at a time. A second start does not open a second window: it hands what it was given on the
//! command line (files „Öffnen mit Sondra“, a folder, a shared list) to the first and ends. The first
//! listens on this computer's own address only, on a port it picked, and writes the port and a secret into
//! a small file in the data folder; whoever has no way to read that file (a web page, another user) cannot
//! make the app open anything.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

/// What the first instance gets from the others: the paths they were started with (maybe none: then the
/// window only comes forward).
pub struct Instance {
    pub paths: Receiver<Vec<PathBuf>>,
}

pub enum Claim {
    /// This is the first Sondra: it listens.
    First(Instance),
    /// Another one is running and has been told; this one ends.
    Handed,
}

/// A line longer than this is not a list of paths.
const LINE_MAX: u64 = 256 * 1024;

fn secret() -> String {
    let mut out = String::new();
    for _ in 0..4 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

fn read_file(file: &Path) -> Option<(u16, String)> {
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    Some((u16::try_from(value["port"].as_u64()?).ok()?, value["token"].as_str()?.to_owned()))
}

/// Tries to hand `paths` to a running Sondra; true when it took them.
fn hand_over(file: &Path, paths: &[PathBuf]) -> bool {
    let Some((port, token)) = read_file(file) else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)), Duration::from_millis(500)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let message = serde_json::json!({ "token": token, "paths": paths.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>() });
    if writeln!(stream, "{message}").and_then(|()| stream.flush()).is_err() {
        return false;
    }
    let mut answer = [0u8; 1];
    stream.read_exact(&mut answer).is_ok() && answer[0] == b'1'
}

/// Becomes the first instance, or hands over to the one that is.
pub fn claim(dir: &Path, paths: &[PathBuf]) -> Claim {
    let file = dir.join("Instanz.json");
    if hand_over(&file, paths) {
        return Claim::Handed;
    }
    let (tx, rx) = channel();
    if let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) {
        if let Ok(addr) = listener.local_addr() {
            let token = secret();
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(&file, serde_json::json!({ "port": addr.port(), "token": token }).to_string());
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    serve(stream, &token, &tx);
                }
            });
        }
    }
    Claim::First(Instance { paths: rx })
}

fn serve(mut stream: TcpStream, token: &str, tx: &std::sync::mpsc::Sender<Vec<PathBuf>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut line = String::new();
    let read = BufReader::new((&stream).take(LINE_MAX)).read_line(&mut line);
    if read.is_err() || !line.ends_with('\n') {
        return;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { return };
    // Compared whole, without stopping at the first difference.
    let given = value["token"].as_str().unwrap_or("");
    let same = given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0;
    if !same {
        return;
    }
    let paths = value["paths"].as_array().map(|a| a.iter().filter_map(|p| p.as_str().map(PathBuf::from)).collect()).unwrap_or_default();
    if tx.send(paths).is_ok() {
        let _ = stream.write_all(b"1");
    }
}
