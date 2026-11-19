//! The devices' rounds and their transfers, as one background worker a window can watch and command.
//! A port of the state machine in `src/lib/devices.ts` (`round`, `handle`, `offerOut`, `acceptTransfer`,
//! `receiveOn`, `declineTransfer`, `sendText`): the same messages through Drive (`offer`, `answer`,
//! `decline`, `cancel`, `text`), the same data channel for the files, so a native device and a browser
//! are two devices of one account.
//!
//! Not here yet: the way through Drive when no direct line opens, resuming a broken transfer, playing on
//! another device, STUN/TURN settings (a `Config` carries servers, nothing sets them).

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sondra_drive::{DriveClient, TokenSource};

use crate::identity::{clean_name, random_id, DeviceKeys};
use crate::registry::{Hardware, Incoming, Registry, BEAT_EVERY, LIST_EVERY};
use crate::rtc::{Config, Initiator, Responder};
use crate::transfer::{
    receive_over, safe_file_name, send_over, split_path, ErrorCode, FileInfo, OutgoingFile, Options, Piece, Progress, Sink,
};

/// More than this in one transfer is sent in parts.
pub const FOLDER_FILES_MAX: usize = 300;
pub const TEXT_MAX: usize = 4000;
/// An offer nobody answers expires after this long, as a message does.
const OFFER_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// After the answer, how long the line may take to open.
const CONNECT_WAIT: Duration = Duration::from_secs(3 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Offered, waiting for the other device's yes.
    Offering,
    /// Offered to this device: it is asked.
    Asking,
    Connecting,
    Sending,
    Receiving,
    Done,
    Declined,
    Failed,
    Cancelled,
    Expired,
}

impl State {
    pub fn waiting(self) -> bool {
        matches!(self, State::Offering | State::Connecting)
    }
    pub fn over(self) -> bool {
        matches!(self, State::Done | State::Declined | State::Failed | State::Cancelled | State::Expired)
    }
}

#[derive(Debug, Clone)]
pub struct Transfer {
    pub id: String,
    pub outgoing: bool,
    pub peer: String,
    pub peer_name: String,
    pub files: Vec<FileInfo>,
    pub total: u64,
    pub done: u64,
    pub state: State,
    pub error: Option<String>,
    /// Where each file went, in words (the receiver's, for what arrived; the answer's, for what was sent).
    pub places: Vec<String>,
    pub at: f64,
    /// Said no, or finished, and closed by the person: no longer shown.
    pub dismissed: bool,
}

#[derive(Debug, Clone)]
pub struct Note {
    pub id: String,
    pub from: String,
    pub peer_name: String,
    pub text: String,
    /// A single http(s) link in it, which the person may open; nothing opens by itself.
    pub link: Option<String>,
    pub at: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Joining,
    Ready,
    Error(String),
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub status: Status,
    pub me: Option<Value>,
    pub name: String,
    pub decided: bool,
    pub devices: Vec<Value>,
    pub former: Vec<Value>,
    pub transfers: Vec<Transfer>,
    pub notes: Vec<Note>,
}

/// Where the files of an accepted transfer go.
pub type SinkMaker = Arc<dyn Fn(&FileInfo, usize, Option<&Piece>) -> io::Result<Box<dyn Sink>> + Send + Sync>;

enum Command {
    Send { to: String, files: Vec<OutgoingFile> },
    Accept { id: String, sinks: SinkMaker },
    Decline(String),
    Cancel(String),
    Dismiss(String),
    Text { to: String, text: String },
    DismissNote(String),
    Rename(String),
    Remove(String),
    Adopt(String),
    DismissFormer,
    Refresh,
}

/// What a transfer's thread asks the rounds to do for it.
enum Event {
    Post { to: String, kind: &'static str, transfer: String, body: Value },
}

/// How often things happen; tests make it short.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub poll: Duration,
    /// While a transfer waits for an answer: the other side should not wait on this one's rhythm.
    pub busy: Duration,
    /// How often the list of devices is read again.
    pub list: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { poll: Duration::from_secs(4), busy: Duration::from_millis(1200), list: Duration::from_millis(LIST_EVERY as u64) }
    }
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// An id that may be looked up and used in a name: what `random_id` makes, nothing else.
pub fn is_transfer_id(id: &str) -> bool {
    id.len() == 20 && id.bytes().all(|c| matches!(c, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z'))
}

/// The one link in a note, if the text is a single http or https address.
pub fn link_of(text: &str) -> Option<String> {
    let text = text.trim();
    if text.chars().any(char::is_whitespace) {
        return None;
    }
    let url = url::Url::parse(text).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string()).filter(|_| url.host_str().is_some())
}

type Shared = Arc<Mutex<Snapshot>>;

struct Control {
    cancel: Arc<AtomicBool>,
    /// The other side's answer (or no), for an outgoing transfer that waits for it.
    answer: Option<Sender<Result<String, State>>>,
}

/// Told when the name this device carries or the answer to „Das war dieses Gerät?“ changed: the app keeps it.
pub type OnOwnChange = Arc<dyn Fn(&str, bool) + Send + Sync>;

pub struct Engine {
    shared: Shared,
    commands: Sender<Command>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Engine {
    pub fn start<T: TokenSource + Send + Sync + 'static>(
        client: DriveClient<T>,
        keys: DeviceKeys,
        name: &str,
        created: f64,
        hardware: Hardware,
        config: Config,
        timing: Timing,
        decided: bool,
        on_own_change: Option<OnOwnChange>,
    ) -> Engine {
        let mut registry = Registry::new(client, keys, name, created, hardware);
        registry.decided = decided;
        let shared: Shared = Arc::new(Mutex::new(Snapshot {
            status: Status::Joining,
            me: None,
            name: name.to_owned(),
            decided,
            devices: vec![],
            former: vec![],
            transfers: vec![],
            notes: vec![],
        }));
        let (commands, inbox) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        let worker = Worker { registry, shared: shared.clone(), config, timing, controls: HashMap::new(), offers: HashMap::new(), stop: stop.clone(), on_own_change, told: (name.to_owned(), decided) };
        let thread = thread::Builder::new().name("sondra-devices".into()).spawn(move || worker.run(inbox)).ok();
        Engine { shared, commands, stop, thread }
    }

    pub fn snapshot(&self) -> Snapshot {
        self.shared.lock().unwrap().clone()
    }

    fn command(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    /// Offers files to another device; it says yes or no there.
    pub fn send(&self, to: &str, files: Vec<OutgoingFile>) {
        self.command(Command::Send { to: to.to_owned(), files });
    }
    pub fn accept(&self, id: &str, sinks: SinkMaker) {
        self.command(Command::Accept { id: id.to_owned(), sinks });
    }
    pub fn decline(&self, id: &str) {
        self.command(Command::Decline(id.to_owned()));
    }
    pub fn cancel(&self, id: &str) {
        self.command(Command::Cancel(id.to_owned()));
    }
    pub fn dismiss(&self, id: &str) {
        self.command(Command::Dismiss(id.to_owned()));
    }
    pub fn send_text(&self, to: &str, text: &str) {
        self.command(Command::Text { to: to.to_owned(), text: text.to_owned() });
    }
    pub fn dismiss_note(&self, id: &str) {
        self.command(Command::DismissNote(id.to_owned()));
    }
    pub fn rename(&self, wanted: &str) {
        self.command(Command::Rename(wanted.to_owned()));
    }
    pub fn remove_device(&self, id: &str) {
        self.command(Command::Remove(id.to_owned()));
    }
    pub fn adopt_former(&self, id: &str) {
        self.command(Command::Adopt(id.to_owned()));
    }
    pub fn dismiss_former(&self) {
        self.command(Command::DismissFormer);
    }
    pub fn refresh(&self) {
        self.command(Command::Refresh);
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn patch(shared: &Shared, id: &str, f: impl FnOnce(&mut Transfer)) {
    if let Some(t) = shared.lock().unwrap().transfers.iter_mut().find(|t| t.id == id) {
        f(t);
    }
}

struct Worker<T: TokenSource> {
    registry: Registry<T>,
    shared: Shared,
    config: Config,
    timing: Timing,
    controls: HashMap<String, Control>,
    /// The offers this device was made and has not answered: the other side's description.
    offers: HashMap<String, String>,
    stop: Arc<AtomicBool>,
    on_own_change: Option<OnOwnChange>,
    told: (String, bool),
}

impl<T: TokenSource + Send + Sync + 'static> Worker<T> {
    fn run(mut self, inbox: Receiver<Command>) {
        let (events_tx, events) = channel::<Event>();
        let mut last_poll = 0.0;
        while !self.stop.load(Ordering::SeqCst) {
            // Commands and events first, each as they come, then the rounds.
            match inbox.recv_timeout(Duration::from_millis(25)) {
                Ok(command) => {
                    self.command(command, &events_tx);
                    while let Ok(next) = inbox.try_recv() {
                        self.command(next, &events_tx);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            while let Ok(Event::Post { to, kind, transfer, body }) = events.try_recv() {
                if let Err(e) = self.registry.post(&to, kind, &transfer, body, now_ms()) {
                    patch(&self.shared, &transfer, |t| {
                        t.state = State::Failed;
                        t.error = Some(e.to_string());
                    });
                }
            }
            let now = now_ms();
            let waiting = self.shared.lock().unwrap().transfers.iter().any(|t| t.state.waiting());
            let every = if waiting { self.timing.busy } else { self.timing.poll }.as_millis() as f64;
            if now - last_poll >= every {
                last_poll = now;
                self.round(now, &events_tx);
            }
        }
        // Closing the program closes every transfer still going.
        for control in self.controls.values() {
            control.cancel.store(true, Ordering::SeqCst);
        }
    }

    fn publish(&mut self) {
        let mut s = self.shared.lock().unwrap();
        s.me = self.registry.me.clone();
        s.name = self.registry.name.clone();
        s.devices = self.registry.devices.clone();
        s.former = self.registry.former.clone();
        s.decided = self.registry.decided;
        drop(s);
        let now = (self.registry.name.clone(), self.registry.decided);
        if now != self.told {
            if let Some(tell) = &self.on_own_change {
                tell(&now.0, now.1);
            }
            self.told = now;
        }
    }

    fn round(&mut self, now: f64, events: &Sender<Event>) {
        let ready = self.shared.lock().unwrap().status == Status::Ready;
        let result = (|| {
            if !ready || now - self.registry.last_list > self.timing.list.as_millis() as f64 {
                self.registry.refresh_list(now, now - self.registry.last_beat > BEAT_EVERY)?;
            } else if now - self.registry.last_beat > BEAT_EVERY {
                self.registry.refresh_list(now, true)?;
            }
            let incoming = self.registry.read_post(now)?;
            self.publish();
            for message in incoming {
                self.handle(message, events);
            }
            Ok::<(), sondra_drive::DriveError>(())
        })();
        match result {
            Ok(()) => self.shared.lock().unwrap().status = Status::Ready,
            Err(e) => self.shared.lock().unwrap().status = Status::Error(e.to_string()),
        }
    }

    fn name_of(&self, id: &str) -> String {
        self.registry
            .devices
            .iter()
            .find(|d| d["id"].as_str() == Some(id))
            .and_then(|d| d["name"].as_str().map(str::to_owned))
            .unwrap_or_else(|| crate::identity::short_id(id).to_owned())
    }

    /// One message that came through every check.
    fn handle(&mut self, m: Incoming, events: &Sender<Event>) {
        if !is_transfer_id(&m.transfer) {
            return;
        }
        let peer_name = self.name_of(&m.from);
        match m.kind.as_str() {
            "text" => {
                let raw = m.body["text"].as_str().unwrap_or_default();
                let text: String = raw.chars().take(TEXT_MAX).collect::<String>().trim().to_owned();
                let mut s = self.shared.lock().unwrap();
                if text.is_empty() || s.notes.iter().any(|n| n.id == m.transfer) {
                    return;
                }
                let link = link_of(&text);
                s.notes.insert(0, Note { id: m.transfer, from: m.from, peer_name, text, link, at: now_ms() });
                s.notes.truncate(50);
            }
            "offer" => {
                let (Some(sdp), Some(list)) = (m.body["sdp"].as_str(), m.body["files"].as_array()) else { return };
                let exists = self.shared.lock().unwrap().transfers.iter().any(|t| t.id == m.transfer);
                if exists {
                    return;
                }
                let files: Vec<FileInfo> = list
                    .iter()
                    .take(FOLDER_FILES_MAX)
                    .map(|f| {
                        let name = f["name"].as_str().unwrap_or("Datei");
                        let (dir, file) = split_path(f["path"].as_str(), name);
                        FileInfo {
                            name: safe_file_name(name),
                            size: f["size"].as_u64().unwrap_or(0),
                            mime: f["mime"].as_str().unwrap_or_default().to_owned(),
                            path: (!dir.is_empty()).then(|| format!("{dir}/{file}")),
                        }
                    })
                    .collect();
                self.offers.insert(m.transfer.clone(), sdp.to_owned());
                let total = files.iter().map(|f| f.size).sum();
                self.shared.lock().unwrap().transfers.insert(
                    0,
                    Transfer { id: m.transfer, outgoing: false, peer: m.from, peer_name, files, total, done: 0, state: State::Asking, error: None, places: vec![], at: now_ms(), dismissed: false },
                );
            }
            kind @ ("answer" | "decline" | "cancel") => {
                let known = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == m.transfer).map(|t| (t.peer.clone(), t.outgoing));
                let Some((peer, outgoing)) = known else { return };
                if peer != m.from {
                    return;
                }
                match (kind, outgoing) {
                    ("answer", true) => {
                        if let (Some(sdp), Some(control)) = (m.body["sdp"].as_str(), self.controls.get(&m.transfer)) {
                            if let Some(tx) = &control.answer {
                                let _ = tx.send(Ok(sdp.to_owned()));
                            }
                        }
                    }
                    ("decline", true) => {
                        if let Some(tx) = self.controls.get(&m.transfer).and_then(|c| c.answer.as_ref()) {
                            let _ = tx.send(Err(State::Declined));
                        }
                        patch(&self.shared, &m.transfer, |t| t.state = State::Declined);
                    }
                    ("cancel", _) => {
                        if let Some(control) = self.controls.get(&m.transfer) {
                            control.cancel.store(true, Ordering::SeqCst);
                            if let Some(tx) = &control.answer {
                                let _ = tx.send(Err(State::Cancelled));
                            }
                        }
                        self.offers.remove(&m.transfer);
                        patch(&self.shared, &m.transfer, |t| {
                            t.state = State::Cancelled;
                            if outgoing {
                                t.error = Some("Auf dem anderen Gerät abgebrochen.".into());
                            }
                        });
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        let _ = events;
    }

    fn command(&mut self, command: Command, events: &Sender<Event>) {
        match command {
            Command::Refresh => self.registry.last_list = 0.0,
            Command::Rename(wanted) => {
                let wanted = clean_name(&wanted);
                if !wanted.is_empty() {
                    let _ = self.registry.rename(&wanted, now_ms());
                    self.publish();
                }
            }
            Command::Remove(id) => {
                let _ = self.registry.remove_device(&id, now_ms());
                self.publish();
            }
            Command::Adopt(id) => {
                let _ = self.registry.adopt_former(&id, now_ms());
                self.publish();
            }
            Command::DismissFormer => {
                self.registry.dismiss_former();
                self.publish();
            }
            Command::DismissNote(id) => self.shared.lock().unwrap().notes.retain(|n| n.id != id),
            Command::Dismiss(id) => patch(&self.shared, &id, |t| {
                if t.state.over() {
                    t.dismissed = true;
                }
            }),
            Command::Text { to, text } => {
                let text: String = text.chars().take(TEXT_MAX).collect::<String>().trim().to_owned();
                if !text.is_empty() {
                    let _ = events_post(events, &to, "text", &random_id(), json!({ "text": text }));
                }
            }
            Command::Decline(id) => {
                let peer = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == id && t.state == State::Asking).map(|t| t.peer.clone());
                if let Some(peer) = peer {
                    self.offers.remove(&id);
                    patch(&self.shared, &id, |t| {
                        t.state = State::Declined;
                        t.dismissed = true;
                    });
                    let _ = events_post(events, &peer, "decline", &id, json!({}));
                }
            }
            Command::Cancel(id) => {
                let found = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == id && !t.state.over()).map(|t| (t.peer.clone(), t.state));
                if let Some((peer, state)) = found {
                    if let Some(control) = self.controls.get(&id) {
                        control.cancel.store(true, Ordering::SeqCst);
                        if let Some(tx) = &control.answer {
                            let _ = tx.send(Err(State::Cancelled));
                        }
                    }
                    if state == State::Asking {
                        self.offers.remove(&id);
                    }
                    patch(&self.shared, &id, |t| t.state = State::Cancelled);
                    let _ = events_post(events, &peer, "cancel", &id, json!({}));
                }
            }
            Command::Send { to, files } => self.send(to, files, events),
            Command::Accept { id, sinks } => self.accept(id, sinks, events),
        }
    }

    fn send(&mut self, to: String, mut files: Vec<OutgoingFile>, events: &Sender<Event>) {
        if files.is_empty() || files.len() > FOLDER_FILES_MAX || !self.registry.devices.iter().any(|d| d["id"].as_str() == Some(to.as_str())) {
            return;
        }
        let id = random_id();
        let infos: Vec<FileInfo> = files.iter().map(|f| f.info.clone()).collect();
        let total = infos.iter().map(|f| f.size).sum();
        let peer_name = self.name_of(&to);
        self.shared.lock().unwrap().transfers.insert(
            0,
            Transfer { id: id.clone(), outgoing: true, peer: to.clone(), peer_name, files: infos.clone(), total, done: 0, state: State::Offering, error: None, places: vec![], at: now_ms(), dismissed: false },
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let (answer_tx, answer_rx) = channel::<Result<String, State>>();
        self.controls.insert(id.clone(), Control { cancel: cancel.clone(), answer: Some(answer_tx) });
        let (shared, config, events) = (self.shared.clone(), self.config.clone(), events.clone());
        thread::spawn(move || {
            let fail = |state: State, error: Option<String>| {
                patch(&shared, &id, |t| {
                    if !t.state.over() {
                        t.state = state;
                        t.error = error;
                    }
                })
            };
            let (initiator, offer) = match Initiator::offer(&config) {
                Ok(pair) => pair,
                Err(e) => return fail(State::Failed, Some(e.to_string())),
            };
            let _ = events.send(Event::Post { to: to.clone(), kind: "offer", transfer: id.clone(), body: json!({ "sdp": offer, "files": infos }) });
            let answer = match answer_rx.recv_timeout(OFFER_TIMEOUT) {
                Ok(Ok(sdp)) => sdp,
                Ok(Err(state)) => return fail(state, None),
                Err(_) => return fail(State::Expired, None),
            };
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            patch(&shared, &id, |t| t.state = State::Connecting);
            let mut wire = match initiator.connect(&answer, CONNECT_WAIT) {
                Ok(w) => w,
                Err(e) => return fail(State::Failed, Some(e.to_string())),
            };
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            patch(&shared, &id, |t| t.state = State::Sending);
            let mut progress = |p: Progress| patch(&shared, &id, |t| t.done = p.done);
            let result = send_over(&mut wire, &mut files, Options { on_progress: Some(&mut progress), cancel: Some(cancel.clone()) });
            match result {
                Ok(places) => patch(&shared, &id, |t| {
                    t.state = State::Done;
                    t.done = t.total;
                    t.places = places;
                }),
                Err(e) => {
                    let state = if matches!(e.code, ErrorCode::Cancelled | ErrorCode::Refused) { State::Cancelled } else { State::Failed };
                    fail(state, Some(e.message));
                }
            }
        });
    }

    fn accept(&mut self, id: String, sinks: SinkMaker, events: &Sender<Event>) {
        let Some(sdp) = self.offers.remove(&id) else { return };
        let found = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == id && t.state == State::Asking).map(|t| (t.peer.clone(), t.total));
        let Some((peer, _total)) = found else { return };
        patch(&self.shared, &id, |t| t.state = State::Connecting);
        let cancel = Arc::new(AtomicBool::new(false));
        self.controls.insert(id.clone(), Control { cancel: cancel.clone(), answer: None });
        let (shared, config, events) = (self.shared.clone(), self.config.clone(), events.clone());
        thread::spawn(move || {
            let fail = |state: State, error: Option<String>| {
                patch(&shared, &id, |t| {
                    if !t.state.over() {
                        t.state = state;
                        t.error = error;
                    }
                })
            };
            let (responder, answer) = match Responder::accept(&sdp, &config) {
                Ok(pair) => pair,
                Err(e) => return fail(State::Failed, Some(e.to_string())),
            };
            let _ = events.send(Event::Post { to: peer, kind: "answer", transfer: id.clone(), body: json!({ "sdp": answer }) });
            let mut wire = match responder.connect(CONNECT_WAIT) {
                Ok(w) => w,
                Err(e) => return fail(State::Failed, Some(e.to_string())),
            };
            patch(&shared, &id, |t| t.state = State::Receiving);
            let mut progress = |p: Progress| patch(&shared, &id, |t| t.done = p.done);
            let mut make = |file: &FileInfo, i: usize, piece: Option<&Piece>| sinks(file, i, piece);
            let result = receive_over(&mut wire, &mut make, &mut |_| {}, None, None, Options { on_progress: Some(&mut progress), cancel: Some(cancel.clone()) });
            match result {
                Ok(places) => patch(&shared, &id, |t| {
                    t.state = State::Done;
                    t.done = t.total;
                    t.places = places;
                }),
                Err(e) => {
                    let state = if matches!(e.code, ErrorCode::Cancelled | ErrorCode::Refused) { State::Cancelled } else { State::Failed };
                    fail(state, Some(e.message));
                }
            }
        });
    }
}

fn events_post(events: &Sender<Event>, to: &str, kind: &'static str, transfer: &str, body: Value) -> Result<(), ()> {
    events.send(Event::Post { to: to.to_owned(), kind, transfer: transfer.to_owned(), body }).map_err(|_| ())
}
