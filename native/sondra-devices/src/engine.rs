//! The devices' rounds and their transfers, as one background worker a window can watch and command.
//! A port of the state machine in `src/lib/devices.ts` (`round`, `handle`, `offerOut`, `acceptTransfer`,
//! `receiveOn`, `declineTransfer`, `sendText`): the same messages through Drive (`offer`, `answer`,
//! `decline`, `cancel`, `text`), the same data channel for the files, so a native device and a browser
//! are two devices of one account.
//!
//! The way through Drive, for when no direct line opens: after the line has not come for a while
//! (`Transfer::no_direct`) the sender may put the files into `Sondra/Geräte/Übergabe` (each with the note
//! `sondraUebergabe` = this transfer and `sondraVon` = this device) and post `drive`; the receiver fetches exactly
//! those files — never another by its id —, deletes them, and posts `received`.
//!
//! Not here yet: resuming a broken transfer in the rounds (the pieces are in `transfer.rs`), playing on another
//! device, STUN/TURN settings (a `Config` carries servers, nothing sets them).

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sondra_drive::{notes_query, DriveClient, DriveError, TokenSource};

use crate::identity::{clean_name, random_id, DeviceKeys};
use crate::registry::{Hardware, Incoming, Registry, BEAT_EVERY, LIST_EVERY};
use crate::rtc::{Config, Initiator, Responder};
use crate::transfer::{
    receive_over, safe_file_name, send_over, split_path, ErrorCode, FileInfo, Kept, OutgoingFile, Options, Piece, Progress, Sink, Wire,
};

/// More than this in one transfer is sent in parts.
pub const FOLDER_FILES_MAX: usize = 300;
pub const TEXT_MAX: usize = 4000;
/// The largest film one device plays from another's file by transfer; beyond it the file is sent and opened there.
pub const PLAY_TRANSFER_MAX: u64 = 2 * 1024 * 1024 * 1024;
/// How many films one request to play may name.
pub const PLAY_ITEMS_MAX: usize = 100;
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
    /// No direct line: the files go through Drive (the sender puts them there, the receiver fetches them).
    ViaDrive,
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

/// How the files travel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Direct,
    Drive,
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
    pub route: Route,
    /// The line has not opened for a while (the sender may go through Drive; the receiver is told, no more).
    pub no_direct: bool,
    /// Offered to be played there, not kept: the receiver's button says „Abspielen“.
    pub play: bool,
    /// The line broke and the other device keeps what came: „Fortsetzen“ offers the same files again (sender only).
    pub resumable: bool,
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
    /// Films in Drive another device asks to be played here (asked first, started by a click).
    pub play: Vec<PlayItem>,
}

/// A film in Drive, named by its Drive id.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayItem {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
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
    Accept { id: String, sinks: SinkMaker },
    Decline(String),
    Cancel(String),
    Dismiss(String),
    Text { to: String, text: String },
    Send { to: String, files: Vec<OutgoingFile>, play: bool },
    PlayInDrive { to: String, items: Vec<PlayItem> },
    ViaDrive(String),
    Resume(String),
    Sever(String),
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
    /// How long a line may take to open before it is called „no direct way“: for the sender, for the receiver (who
    /// only learns of the offer later).
    pub no_direct_sender: Duration,
    pub no_direct_receiver: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { poll: Duration::from_secs(4), busy: Duration::from_millis(1200), list: Duration::from_millis(LIST_EVERY as u64), no_direct_sender: Duration::from_secs(25), no_direct_receiver: Duration::from_secs(45) }
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
    /// The way through Drive took over: the direct attempt ends without saying anything.
    switched: Arc<AtomicBool>,
    /// For tests: the line is cut here, as when a network goes away mid-transfer.
    cut: Arc<AtomicBool>,
}

/// A line that can be cut from outside: from then on it is closed, both ways, as a dead network is.
struct Severable<W: Wire> {
    inner: W,
    cut: Arc<AtomicBool>,
}

impl<W: Wire> Severable<W> {
    fn gone(&mut self) -> bool {
        if self.cut.load(Ordering::SeqCst) {
            self.inner.close();
            return true;
        }
        false
    }
}

impl<W: Wire> Wire for Severable<W> {
    fn send(&mut self, frame: crate::transfer::Frame) -> Result<(), crate::transfer::Closed> {
        if self.gone() {
            return Err(crate::transfer::Closed);
        }
        self.inner.send(frame)
    }
    fn buffered(&self) -> usize {
        self.inner.buffered()
    }
    fn recv(&mut self, timeout: Duration) -> Result<Option<crate::transfer::Frame>, crate::transfer::Closed> {
        if self.gone() {
            return Err(crate::transfer::Closed);
        }
        self.inner.recv(timeout)
    }
    fn close(&mut self) {
        self.inner.close();
    }
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
        let worker = Worker { registry, shared: shared.clone(), config, timing, controls: HashMap::new(), offers: HashMap::new(), pending: HashMap::new(), sinks: HashMap::new(), handed: HashMap::new(), kept: Arc::new(Mutex::new(HashMap::new())), held: HashMap::new(), stop: stop.clone(), on_own_change, told: (name.to_owned(), decided) };
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
        self.command(Command::Send { to: to.to_owned(), files, play: false });
    }
    /// Offers one film to be played there, not kept (up to 2 GB; the other device says yes first).
    pub fn send_to_play(&self, to: &str, file: OutgoingFile) {
        self.command(Command::Send { to: to.to_owned(), files: vec![file], play: true });
    }
    /// Asks a device to play films that lie in Drive: only their names and Drive ids go, that device streams
    /// them itself with its own sign-in.
    pub fn play_on(&self, to: &str, items: Vec<PlayItem>) {
        self.command(Command::PlayInDrive { to: to.to_owned(), items });
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
    /// When the line has not opened: the files go through Drive instead.
    /// „Fortsetzen“: the same files to the same device after the line broke; it goes on from what it kept.
    pub fn resume(&self, id: &str) {
        self.command(Command::Resume(id.to_owned()));
    }

    /// For tests: cuts the line of a transfer on this side, as a network that goes away does.
    pub fn sever_for_test(&self, id: &str) {
        self.command(Command::Sever(id.to_owned()));
    }

    pub fn send_via_drive(&self, id: &str) {
        self.command(Command::ViaDrive(id.to_owned()));
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
    /// The files of the transfers going out, kept so that the way through Drive can take them over.
    pending: HashMap<String, Arc<Mutex<Vec<OutgoingFile>>>>,
    /// Where the files of accepted transfers go.
    sinks: HashMap<String, SinkMaker>,
    /// A hand-over that came before the person said yes.
    handed: HashMap<String, Value>,
    /// What a broken incoming transfer kept on this side, for when the sender goes on.
    kept: Arc<Mutex<HashMap<String, Kept>>>,
    /// A resumed offer that came before this side saw its line break: taken up once the break is registered.
    held: HashMap<String, (String, Value)>,
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
            self.release_held(events);
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
                s.notes.insert(0, Note { id: m.transfer, from: m.from, peer_name, text, link, at: now_ms(), play: vec![] });
                s.notes.truncate(50);
            }
            "play" => {
                let Some(raw) = m.body["items"].as_array() else { return };
                if self.shared.lock().unwrap().notes.iter().any(|n| n.id == m.transfer) {
                    return;
                }
                let items: Vec<PlayItem> = raw
                    .iter()
                    .take(PLAY_ITEMS_MAX)
                    .filter_map(|item| {
                        let id = item["id"].as_str().filter(|id| is_drive_id(id))?;
                        let name = safe_file_name(item["name"].as_str().unwrap_or("Datei"));
                        Some(PlayItem { id: id.to_owned(), name, size: item["size"].as_u64().unwrap_or(0), mime: item["type"].as_str().unwrap_or_default().to_owned() })
                    })
                    .filter(|item| is_playable(&item.mime, &item.name))
                    .collect();
                let Some(first) = items.first() else { return };
                let text = if items.len() > 1 { format!("„{}“ und {} weitere", first.name, items.len() - 1) } else { format!("„{}“", first.name) };
                let mut s = self.shared.lock().unwrap();
                s.notes.insert(0, Note { id: m.transfer, from: m.from, peer_name, text, link: None, at: now_ms(), play: items });
                s.notes.truncate(50);
            }
            "offer" => {
                let (Some(sdp), Some(list)) = (m.body["sdp"].as_str(), m.body["files"].as_array()) else { return };
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
                let existing = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == m.transfer).map(|t| (t.outgoing, t.peer.clone(), t.files.clone(), t.state));
                if let Some((outgoing, peer, known, state)) = existing {
                    // The same transfer again after a break: a receiver that kept the first part goes on by itself,
                    // since it said yes to exactly these files; one that kept nothing treats it as a new offer.
                    let same = !outgoing && peer == m.from && known.len() == files.len() && known.iter().zip(&files).all(|(a, b)| a.name == b.name && a.size == b.size && a.path == b.path);
                    let resume = m.body["resume"].as_bool() == Some(true);
                    if same && resume && matches!(state, State::Connecting | State::Receiving) {
                        // The sender gave up on the line before this side saw it break: held until it does.
                        self.held.insert(m.transfer, (m.from, m.body));
                        return;
                    }
                    if !same || !resume || state != State::Failed {
                        return;
                    }
                    let kept = self.kept.lock().unwrap().remove(&m.transfer);
                    if let (Some(kept), Some(sinks)) = (kept, self.sinks.get(&m.transfer).cloned()) {
                        patch(&self.shared, &m.transfer, |t| {
                            t.state = State::Connecting;
                            t.error = None;
                        });
                        self.receive(m.transfer, m.from, sdp.to_owned(), sinks, Some(kept), events);
                        return;
                    }
                    self.shared.lock().unwrap().transfers.retain(|t| t.id != m.transfer);
                }
                self.offers.insert(m.transfer.clone(), sdp.to_owned());
                let total = files.iter().map(|f| f.size).sum();
                // One film, not too large: offered to be played, not kept.
                let play = m.body["play"].as_bool() == Some(true) && files.len() == 1 && total <= PLAY_TRANSFER_MAX;
                self.shared.lock().unwrap().transfers.insert(
                    0,
                    Transfer { id: m.transfer, outgoing: false, peer: m.from, peer_name, files, total, done: 0, state: State::Asking, error: None, places: vec![], at: now_ms(), dismissed: false, route: Route::Direct, no_direct: false, play, resumable: false },
                );
            }
            "drive" => {
                let known = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == m.transfer).map(|t| (t.peer.clone(), t.outgoing, t.state));
                let Some((peer, false, state)) = known else { return };
                if peer != m.from || !m.body["files"].is_array() {
                    return;
                }
                match state {
                    // Not yet said yes: kept for when it is.
                    State::Asking => {
                        self.handed.insert(m.transfer, m.body);
                    }
                    State::Connecting | State::Receiving => self.receive_via_drive(m.transfer, m.body, events),
                    _ => {}
                }
            }
            "received" => {
                let known = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == m.transfer).map(|t| (t.peer.clone(), t.outgoing, t.state));
                let Some((peer, true, State::ViaDrive)) = known else { return };
                if peer != m.from {
                    return;
                }
                let places: Vec<String> = m.body["places"].as_array().map(|l| l.iter().filter_map(|p| p.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                self.pending.remove(&m.transfer);
                patch(&self.shared, &m.transfer, |t| {
                    t.state = State::Done;
                    t.done = t.total;
                    t.places = places;
                });
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
            Command::ViaDrive(id) => self.send_via_drive(id, events),
            Command::Resume(id) => self.resume(id, events),
            Command::Sever(id) => {
                if let Some(control) = self.controls.get(&id) {
                    control.cut.store(true, Ordering::SeqCst);
                }
            }
            Command::Send { to, files, play } => self.send(to, files, play, events),
            Command::PlayInDrive { to, items } => self.play_in_drive(&to, items, events),
            Command::Accept { id, sinks } => self.accept(id, sinks, events),
        }
    }

    fn play_in_drive(&mut self, to: &str, items: Vec<PlayItem>, events: &Sender<Event>) {
        let known = self.registry.devices.iter().any(|d| d["id"].as_str() == Some(to));
        let items: Vec<&PlayItem> = items.iter().filter(|i| is_playable(&i.mime, &i.name)).take(PLAY_ITEMS_MAX).collect();
        if !known || items.is_empty() {
            return;
        }
        let body = json!({ "items": items.iter().map(|i| json!({ "id": i.id, "name": i.name, "size": i.size, "type": i.mime })).collect::<Vec<_>>() });
        let _ = events_post(events, to, "play", &random_id(), body);
    }

    fn send(&mut self, to: String, files: Vec<OutgoingFile>, play: bool, events: &Sender<Event>) {
        if files.is_empty() || files.len() > FOLDER_FILES_MAX || !self.registry.devices.iter().any(|d| d["id"].as_str() == Some(to.as_str())) {
            return;
        }
        let id = random_id();
        let infos: Vec<FileInfo> = files.iter().map(|f| f.info.clone()).collect();
        let total = infos.iter().map(|f| f.size).sum();
        let peer_name = self.name_of(&to);
        self.shared.lock().unwrap().transfers.insert(
            0,
            Transfer { id: id.clone(), outgoing: true, peer: to.clone(), peer_name, files: infos.clone(), total, done: 0, state: State::Offering, error: None, places: vec![], at: now_ms(), dismissed: false, route: Route::Direct, no_direct: false, play, resumable: false },
        );
        let files = Arc::new(Mutex::new(files));
        self.pending.insert(id.clone(), files.clone());
        self.spawn_outgoing(id, to, files, infos, play, false, events);
    }

    /// „Fortsetzen“: an outgoing transfer whose line broke, offered again with the same id and files.
    fn resume(&mut self, id: String, events: &Sender<Event>) {
        let found = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == id && t.outgoing && t.resumable).map(|t| (t.peer.clone(), t.files.clone(), t.play));
        let (Some((to, infos, play)), Some(files)) = (found, self.pending.get(&id).cloned()) else { return };
        patch(&self.shared, &id, |t| {
            t.state = State::Offering;
            t.error = None;
            t.resumable = false;
            t.no_direct = false;
        });
        self.spawn_outgoing(id, to, files, infos, play, true, events);
    }

    /// Offers the files and, on the answer, sends them over the line; a broken line to a device that can go on leaves
    /// the transfer resumable.
    #[allow(clippy::too_many_arguments)]
    fn spawn_outgoing(&mut self, id: String, to: String, files: Arc<Mutex<Vec<OutgoingFile>>>, infos: Vec<FileInfo>, play: bool, resume: bool, events: &Sender<Event>) {
        let cancel = Arc::new(AtomicBool::new(false));
        let switched = Arc::new(AtomicBool::new(false));
        let (answer_tx, answer_rx) = channel::<Result<String, State>>();
        let cut = Arc::new(AtomicBool::new(false));
        self.controls.insert(id.clone(), Control { cancel: cancel.clone(), answer: Some(answer_tx), switched: switched.clone(), cut: cut.clone() });
        let can_resume = crate::identity::can(self.registry.devices.iter().find(|d| d["id"].as_str() == Some(to.as_str())), "resume");
        let (shared, config, events, no_direct_after) = (self.shared.clone(), self.config.clone(), events.clone(), self.timing.no_direct_sender);
        thread::spawn(move || {
            let fail = |state: State, error: Option<String>| {
                // The way through Drive took over: this attempt ends without a word.
                if switched.load(Ordering::SeqCst) {
                    return;
                }
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
            let mut body = json!({ "sdp": offer, "files": infos });
            if play {
                body["play"] = json!(true);
            }
            if resume {
                body["resume"] = json!(true);
            }
            let _ = events.send(Event::Post { to: to.clone(), kind: "offer", transfer: id.clone(), body });
            let answer = match answer_rx.recv_timeout(OFFER_TIMEOUT) {
                Ok(Ok(sdp)) => sdp,
                Ok(Err(state)) => return fail(state, None),
                Err(_) => return fail(State::Expired, None),
            };
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            patch(&shared, &id, |t| t.state = State::Connecting);
            watch_no_direct(&shared, &id, &cancel, &switched, no_direct_after);
            if config.deaf {
                deaf_wait(&cancel, &switched);
                return fail(State::Failed, Some("Keine Verbindung zustande gekommen.".into()));
            }
            let mut wire = match initiator.connect(&answer, CONNECT_WAIT) {
                Ok(w) => Severable { inner: w, cut: cut.clone() },
                Err(e) => return fail(State::Failed, Some(e.to_string())),
            };
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            if switched.load(Ordering::SeqCst) {
                return;
            }
            patch(&shared, &id, |t| {
                t.state = State::Sending;
                t.no_direct = false;
            });
            let mut progress = |p: Progress| patch(&shared, &id, |t| t.done = p.done);
            let result = {
                let mut guard = files.lock().unwrap();
                send_over(&mut wire, &mut guard[..], Options { on_progress: Some(&mut progress), cancel: Some(cancel.clone()) })
            };
            match result {
                Ok(places) => patch(&shared, &id, |t| {
                    t.state = State::Done;
                    t.done = t.total;
                    t.places = places;
                }),
                Err(e) => {
                    let state = if matches!(e.code, ErrorCode::Cancelled | ErrorCode::Refused) { State::Cancelled } else { State::Failed };
                    let broke = e.code == ErrorCode::Closed && can_resume;
                    fail(state, Some(e.message));
                    if broke && !switched.load(Ordering::SeqCst) {
                        patch(&shared, &id, |t| t.resumable = true);
                    }
                }
            }
        });
    }


    /// Stops the direct attempt of a transfer without a word and gives it a fresh control for the way through Drive.
    fn switch_to_drive(&mut self, id: &str) -> (Arc<AtomicBool>, String) {
        if let Some(control) = self.controls.get(id) {
            control.switched.store(true, Ordering::SeqCst);
            control.cancel.store(true, Ordering::SeqCst);
            if let Some(tx) = &control.answer {
                let _ = tx.send(Err(State::Cancelled));
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        self.controls.insert(id.to_owned(), Control { cancel: cancel.clone(), answer: None, switched: Arc::new(AtomicBool::new(false)), cut: Arc::new(AtomicBool::new(false)) });
        patch(&self.shared, id, |t| {
            t.state = State::ViaDrive;
            t.route = Route::Drive;
            t.done = 0;
            t.error = None;
            t.no_direct = false;
        });
        (cancel, self.registry.id().to_owned())
    }

    /// „Über Drive senden“: the files into the hand-over folder, each noted for this transfer, then the message.
    fn send_via_drive(&mut self, id: String, events: &Sender<Event>) {
        let found = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == id && t.outgoing && t.state == State::Connecting).map(|t| (t.peer.clone(), t.files.clone()));
        let (Some((peer, infos)), Some(files)) = (found, self.pending.get(&id).cloned()) else { return };
        let (cancel, me) = self.switch_to_drive(&id);
        let (client, shared, events) = (self.registry.shared_client(), self.shared.clone(), events.clone());
        thread::spawn(move || {
            let outcome = (|| -> Result<Vec<Value>, DriveError> {
                let folder = client.ensure_path(&HANDOVER)?;
                let notes = std::collections::BTreeMap::from([("sondraUebergabe".to_owned(), id.clone()), ("sondraVon".to_owned(), me.clone())]);
                let (mut placed, mut before) = (Vec::new(), 0u64);
                for (index, info) in infos.iter().enumerate() {
                    // A name of its own in Drive: two files of one name may lie in different folders of the transfer.
                    let drive_name = format!("{index:03}-{}", info.name);
                    let mut guard = files.lock().unwrap();
                    let file = &mut guard[index];
                    let made = client.put_streamed(&folder, &drive_name, info.size, &info.mime, &notes, |from, to| (file.read)(from, to), &cancel, |sent, _| patch(&shared, &id, |t| t.done = before + sent))?;
                    drop(guard);
                    before += info.size;
                    let mut entry = serde_json::to_value(info).unwrap_or_else(|_| json!({}));
                    entry["id"] = Value::String(made.id);
                    placed.push(entry);
                }
                Ok(placed)
            })();
            match outcome {
                // „received“ from the other side finishes it.
                Ok(placed) => {
                    let _ = events.send(Event::Post { to: peer, kind: "drive", transfer: id, body: json!({ "files": placed }) });
                }
                Err(DriveError::Cancelled) => patch(&shared, &id, |t| t.state = State::Cancelled),
                Err(e) => patch(&shared, &id, |t| {
                    t.state = State::Failed;
                    t.error = Some(crate::engine::drive_words(&e));
                }),
            }
        });
    }

    /// The other device put the files into Drive: fetched, one after the other, into the sinks the person's yes
    /// made — only the files noted for this transfer by that device, never another by its id.
    fn receive_via_drive(&mut self, id: String, body: Value, events: &Sender<Event>) {
        let found = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == id && !t.outgoing && !t.state.over()).map(|t| (t.peer.clone(), t.total));
        let (Some((peer, total)), Some(sinks)) = (found, self.sinks.get(&id).cloned()) else { return };
        let (cancel, _) = self.switch_to_drive(&id);
        let (client, shared, events) = (self.registry.shared_client(), self.shared.clone(), events.clone());
        let list: Vec<Value> = body["files"].as_array().cloned().unwrap_or_default().into_iter().take(FOLDER_FILES_MAX).collect();
        thread::spawn(move || {
            let fail = |error: String| patch(&shared, &id, |t| {
                if !t.state.over() {
                    t.state = State::Failed;
                    t.error = Some(error);
                }
            });
            let handed: std::collections::HashSet<String> = match client.search(&notes_query("sondraUebergabe", &id)) {
                Ok(found) => found.into_iter().filter(|f| f.notes.get("sondraVon") == Some(&peer)).map(|f| f.file.id).collect(),
                Err(e) => return fail(drive_words(&e)),
            };
            let (mut places, mut before) = (Vec::new(), 0u64);
            for (index, entry) in list.iter().enumerate() {
                let file_id = entry["id"].as_str().unwrap_or_default().to_owned();
                if !handed.contains(&file_id) {
                    return fail("Eine Datei in Drive gehört nicht zu dieser Übertragung.".into());
                }
                let name = entry["name"].as_str().unwrap_or("Datei");
                let (dir, file) = split_path(entry["path"].as_str(), name);
                let info = FileInfo { name: safe_file_name(name), size: entry["size"].as_u64().unwrap_or(0), mime: entry["mime"].as_str().unwrap_or_default().to_owned(), path: (!dir.is_empty()).then(|| format!("{dir}/{file}")) };
                let mut sink = match sinks(&info, index, None) {
                    Ok(sink) => sink,
                    Err(e) => return fail(e.to_string()),
                };
                let result = client.read_to(&file_id, &cancel, |chunk| sink.write(chunk), |loaded, _| patch(&shared, &id, |t| t.done = before + loaded));
                match result {
                    Ok(()) => match sink.close() {
                        Ok(place) => places.push(place),
                        Err(e) => return fail(e.to_string()),
                    },
                    Err(DriveError::Cancelled) => {
                        sink.abort();
                        return patch(&shared, &id, |t| t.state = State::Cancelled);
                    }
                    Err(e) => {
                        sink.abort();
                        return fail(drive_words(&e));
                    }
                }
                before += info.size;
                let _ = client.remove(&file_id);
            }
            patch(&shared, &id, |t| {
                t.state = State::Done;
                t.done = total.max(t.done);
                t.places = places.clone();
            });
            let _ = events.send(Event::Post { to: peer, kind: "received", transfer: id, body: json!({ "places": places }) });
        });
    }

    /// Resumed offers held while the old line still seemed open: taken up once it is registered as broken, dropped
    /// when the transfer ended otherwise.
    fn release_held(&mut self, events: &Sender<Event>) {
        let ids: Vec<String> = self.held.keys().cloned().collect();
        for id in ids {
            let state = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == id).map(|t| t.state);
            match state {
                Some(State::Connecting | State::Receiving) => {}
                Some(State::Failed) => {
                    if let Some((from, body)) = self.held.remove(&id) {
                        self.handle(Incoming { id: String::new(), from, kind: "offer".into(), transfer: id, body }, events);
                    }
                }
                _ => {
                    self.held.remove(&id);
                }
            }
        }
    }

    fn accept(&mut self, id: String, sinks: SinkMaker, events: &Sender<Event>) {
        let Some(sdp) = self.offers.remove(&id) else { return };
        let found = self.shared.lock().unwrap().transfers.iter().find(|t| t.id == id && t.state == State::Asking).map(|t| (t.peer.clone(), t.total));
        let Some((peer, _total)) = found else { return };
        patch(&self.shared, &id, |t| t.state = State::Connecting);
        self.sinks.insert(id.clone(), sinks.clone());
        // The sender went through Drive before this was answered: the files are there already.
        if let Some(body) = self.handed.remove(&id) {
            self.offers.remove(&id);
            return self.receive_via_drive(id, body, events);
        }
        self.receive(id, peer, sdp, sinks, None, events);
    }

    /// The answer, the line and the files over it — for the first attempt and, with what was `kept`, after a break.
    /// A line that breaks keeps what came (`Kept`), for the sender's „Fortsetzen“.
    fn receive(&mut self, id: String, peer: String, sdp: String, sinks: SinkMaker, kept: Option<Kept>, events: &Sender<Event>) {
        let cancel = Arc::new(AtomicBool::new(false));
        let switched = Arc::new(AtomicBool::new(false));
        let cut = Arc::new(AtomicBool::new(false));
        self.controls.insert(id.clone(), Control { cancel: cancel.clone(), answer: None, switched: switched.clone(), cut: cut.clone() });
        let (shared, config, events, no_direct_after) = (self.shared.clone(), self.config.clone(), events.clone(), self.timing.no_direct_receiver);
        let keeper = self.kept.clone();
        thread::spawn(move || {
            let fail = |state: State, error: Option<String>| {
                if switched.load(Ordering::SeqCst) {
                    return;
                }
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
            watch_no_direct(&shared, &id, &cancel, &switched, no_direct_after);
            if config.deaf {
                deaf_wait(&cancel, &switched);
                return fail(State::Failed, Some("Keine Verbindung zustande gekommen.".into()));
            }
            let mut wire = match responder.connect(CONNECT_WAIT) {
                Ok(w) => Severable { inner: w, cut: cut.clone() },
                Err(e) => return fail(State::Failed, Some(e.to_string())),
            };
            if switched.load(Ordering::SeqCst) {
                return;
            }
            patch(&shared, &id, |t| {
                t.state = State::Receiving;
                t.no_direct = false;
            });
            let mut progress = |p: Progress| patch(&shared, &id, |t| t.done = p.done);
            let mut make = |file: &FileInfo, i: usize, piece: Option<&Piece>| sinks(file, i, piece);
            let keep_id = id.clone();
            let mut on_kept = |what: Kept| {
                keeper.lock().unwrap().insert(keep_id.clone(), what);
            };
            let result = receive_over(&mut wire, &mut make, &mut |_| {}, kept, Some(&mut on_kept), Options { on_progress: Some(&mut progress), cancel: Some(cancel.clone()) });
            match result {
                Ok(places) => {
                    keeper.lock().unwrap().remove(&id);
                    patch(&shared, &id, |t| {
                        t.state = State::Done;
                        t.done = t.total;
                        t.places = places;
                    })
                }
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

/// Where hand-overs wait for the other device.
const HANDOVER: [&str; 3] = ["Sondra", "Geräte", "Übergabe"];

/// A Drive failure in a sentence for the transfer's line.
pub(crate) fn drive_words(error: &DriveError) -> String {
    match error {
        DriveError::Unauthorized => "Bei Google Drive ist die Anmeldung abgelaufen.".into(),
        DriveError::Offline(why) => format!("Google Drive ist nicht erreichbar ({why})."),
        other => format!("Über Google Drive ging es nicht: {other}"),
    }
}

/// After `after` of still waiting for the line, the transfer is marked as having no direct way — which only offers
/// the way through Drive, never takes it by itself. The line goes on waiting; if it opens, the mark goes.
fn watch_no_direct(shared: &Shared, id: &str, cancel: &Arc<AtomicBool>, switched: &Arc<AtomicBool>, after: Duration) {
    let (shared, id, cancel, switched) = (shared.clone(), id.to_owned(), cancel.clone(), switched.clone());
    thread::spawn(move || {
        let until = std::time::Instant::now() + after;
        while std::time::Instant::now() < until {
            thread::sleep(Duration::from_millis(50).min(after));
            let waiting = shared.lock().unwrap().transfers.iter().any(|t| t.id == id && t.state == State::Connecting);
            if !waiting || cancel.load(Ordering::SeqCst) || switched.load(Ordering::SeqCst) {
                return;
            }
        }
        patch(&shared, &id, |t| {
            if t.state == State::Connecting {
                t.no_direct = true;
            }
        });
    });
}

/// For tests: a line that never opens waits as long as one that might, unless it is given up on.
fn deaf_wait(cancel: &Arc<AtomicBool>, switched: &Arc<AtomicBool>) {
    let until = std::time::Instant::now() + CONNECT_WAIT;
    while std::time::Instant::now() < until && !cancel.load(Ordering::SeqCst) && !switched.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(50));
    }
}

/// A Drive file id, as the website takes it: word characters and dashes, 4 to 100 of them.
pub fn is_drive_id(id: &str) -> bool {
    (4..=100).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Whether a film or a song can be played: by its type, or by its name's ending (the website's rule).
pub fn is_playable(mime: &str, name: &str) -> bool {
    if mime.starts_with("video/") || mime.starts_with("audio/") {
        return true;
    }
    let lower = name.to_lowercase();
    ["mp4", "m4v", "mkv", "webm", "mov", "avi", "mp3", "m4a", "aac", "flac", "ogg", "opus", "wav"].iter().any(|e| lower.ends_with(&format!(".{e}")))
}
