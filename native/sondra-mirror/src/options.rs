//! How the scrcpy server is started: its version, and the arguments after it (`startMirror` of the web app).

/// The server's version: it aborts at once if the client names another.
pub const SERVER_VERSION: &str = "3.3.3";

/// Where the server file is put on the phone while a connection lasts.
pub const SERVER_PATH: &str = "/data/local/tmp/scrcpy-server.jar";

/// „Flüssig“ caps the longer edge so the phone's encoder and this computer's decoder have an easy time;
/// „Scharf“ is the phone's own size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
    Smooth,
    Sharp,
}

/// The arguments after the version, as the library writes them: defaults left out (video, control and the
/// codecs — h264 and Opus — are the server's own).
pub fn server_args(quality: Quality, sound: bool) -> Vec<String> {
    let smooth = quality == Quality::Smooth;
    let mut args = Vec::new();
    if smooth {
        args.push("max_size=1280".to_string());
    }
    args.push("max_fps=60".into());
    args.push("tunnel_forward=true".into());
    args.push("clipboard_autosync=false".into());
    args.push(format!("video_bit_rate={}", if smooth { 6_000_000 } else { 12_000_000 }));
    if !sound {
        args.push("audio=false".into());
    }
    args
}

/// The whole command the phone's shell runs: the class path, `app_process` and the server's class.
pub fn server_command(quality: Quality, sound: bool) -> String {
    let mut parts = vec![format!("CLASSPATH={SERVER_PATH}"), "app_process".into(), "/".into(), "com.genymobile.scrcpy.Server".into(), SERVER_VERSION.into()];
    parts.extend(server_args(quality, sound));
    parts.join(" ")
}

/// The abstract socket the server listens on (no `scid` is given, so no suffix).
pub const SOCKET: &str = "localabstract:scrcpy";
