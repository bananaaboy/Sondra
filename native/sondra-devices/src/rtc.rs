//! The line between two devices: one ordered WebRTC data channel called „sondra“, the way
//! `devices.ts` makes it (`createDataChannel('sondra', { ordered: true })`, offer and answer with the
//! candidates already in them, no server unless the person put one in). A browser, the Android app and
//! this one speak to each other over it; `probes/webrtc-interop` showed a Rust peer and Chromium do.
//!
//! The transfer (`transfer.rs`) is blocking code; the library underneath is async. Each connection owns
//! a small runtime, and [`RtcWire`] is the bridge: frames in go through a queue, frames out are sent on
//! the runtime, and the channel's own buffer is what `buffered()` reports.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use tokio::runtime::Runtime;
use tokio::sync::Notify;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::transfer::{Closed, Frame, Wire};

pub const CHANNEL: &str = "sondra";
/// The channel says „low“ when what it holds falls below this, as in the browser.
const LOW: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RtcError {
    #[error("Die Verbindung kam nicht zustande.")]
    NoConnection,
    #[error("{0}")]
    Failed(String),
}

fn failed(e: impl std::fmt::Display) -> RtcError {
    RtcError::Failed(e.to_string())
}

/// A server the person trusts: `stun:host:3478` or `turn:host:3478` with its login.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IceServer {
    pub urls: String,
    pub username: Option<String>,
    pub credential: Option<String>,
}

/// Asked for at every connection: the servers the person has put in by now.
pub type LiveServers = Arc<dyn Fn() -> Vec<IceServer> + Send + Sync>;

#[derive(Clone, Default)]
pub struct Config {
    pub servers: Vec<IceServer>,
    /// When set, this is asked at every connection instead of `servers`, so a server put in while the
    /// program runs is used by the next connection.
    pub live: Option<LiveServers>,
    /// Also offer the loopback address: for two programs on one computer, in tests.
    pub loopback: bool,
}

fn configuration(config: &Config) -> RTCConfiguration {
    RTCConfiguration {
        ice_servers: config
            .live
            .as_ref()
            .map_or_else(|| config.servers.clone(), |live| live())
            .iter()
            .map(|s| RTCIceServer {
                urls: vec![s.urls.clone()],
                username: s.username.clone().unwrap_or_default(),
                credential: s.credential.clone().unwrap_or_default(),
            })
            .collect(),
        ..Default::default()
    }
}

fn runtime() -> Result<Arc<Runtime>, RtcError> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .thread_name("sondra-rtc")
        .build()
        .map(Arc::new)
        .map_err(failed)
}

async fn peer(config: &Config) -> Result<Arc<RTCPeerConnection>, RtcError> {
    let mut settings = SettingEngine::default();
    // A browser hides its address behind a name ending in .local; ask for it, publish the real one.
    settings.set_ice_multicast_dns_mode(MulticastDnsMode::QueryOnly);
    if config.loopback {
        settings.set_include_loopback_candidate(true);
    }
    let api = APIBuilder::new().with_setting_engine(settings).build();
    let pc = Arc::new(api.new_peer_connection(configuration(config)).await.map_err(failed)?);
    if std::env::var_os("SONDRA_RTC_DEBUG").is_some() {
        pc.on_ice_connection_state_change(Box::new(|s| {
            eprintln!("ice: {s}");
            Box::pin(async {})
        }));
        pc.on_peer_connection_state_change(Box::new(|s| {
            eprintln!("peer: {s}");
            Box::pin(async {})
        }));
        pc.on_ice_gathering_state_change(Box::new(|s| {
            eprintln!("gathering: {s}");
            Box::pin(async {})
        }));
    }
    Ok(pc)
}

/// What the channel brings in, wired to a queue.
struct Inbox {
    tx: Arc<Mutex<Option<Sender<Frame>>>>,
}

fn hook(channel: &Arc<RTCDataChannel>, open: Arc<Notify>, opened: Arc<AtomicBool>) -> (Receiver<Frame>, Inbox) {
    let (tx, rx) = channel_pair();
    let inbox = Inbox { tx: Arc::new(Mutex::new(Some(tx))) };
    let sink = inbox.tx.clone();
    channel.on_message(Box::new(move |message| {
        if std::env::var_os("SONDRA_RTC_DEBUG").is_some() {
            eprintln!("message {} bytes, string {}", message.data.len(), message.is_string);
        }
        if let Some(tx) = sink.lock().unwrap().as_ref() {
            let frame = if message.is_string {
                Frame::Text(String::from_utf8_lossy(&message.data).into_owned())
            } else {
                Frame::Bytes(message.data.to_vec())
            };
            let _ = tx.send(frame);
        }
        Box::pin(async {})
    }));
    let sink = inbox.tx.clone();
    let label = format!("{}#{:?}", channel.label(), channel.id());
    channel.on_close(Box::new(move || {
        // Dropping the sender is how the receiving side learns the line is gone, after the last frame.
        if std::env::var_os("SONDRA_RTC_DEBUG").is_some() {
            eprintln!("channel closed {label}");
        }
        sink.lock().unwrap().take();
        Box::pin(async {})
    }));
    channel.on_open(Box::new(move || {
        opened.store(true, Ordering::SeqCst);
        open.notify_waiters();
        open.notify_one();
        Box::pin(async {})
    }));
    (rx, inbox)
}

fn channel_pair() -> (Sender<Frame>, Receiver<Frame>) {
    channel()
}

/// The sender's side before the answer: holds the connection and the offer's SDP.
pub struct Initiator {
    rt: Arc<Runtime>,
    pc: Arc<RTCPeerConnection>,
    channel: Arc<RTCDataChannel>,
    open: Arc<Notify>,
    opened: Arc<AtomicBool>,
    rx: Receiver<Frame>,
    inbox: Inbox,
}

impl Initiator {
    /// A connection and its offer, with the candidates in it.
    pub fn offer(config: &Config) -> Result<(Initiator, String), RtcError> {
        let rt = runtime()?;
        let (pc, channel, sdp) = rt.block_on(async {
            let pc = peer(config).await?;
            let channel = pc
                .create_data_channel(CHANNEL, Some(RTCDataChannelInit { ordered: Some(true), ..Default::default() }))
                .await
                .map_err(failed)?;
            channel.set_buffered_amount_low_threshold(LOW).await;
            let offer = pc.create_offer(None).await.map_err(failed)?;
            let mut gathered = pc.gathering_complete_promise().await;
            pc.set_local_description(offer).await.map_err(failed)?;
            let _ = gathered.recv().await;
            let local = pc.local_description().await.ok_or_else(|| RtcError::Failed("no local description".into()))?;
            Ok::<_, RtcError>((pc, channel, local.sdp))
        })?;
        let (open, opened) = (Arc::new(Notify::new()), Arc::new(AtomicBool::new(false)));
        let (rx, inbox) = hook(&channel, open.clone(), opened.clone());
        Ok((Initiator { rt, pc, channel, open, opened, rx, inbox }, sdp))
    }

    /// The answer came: connect. `wait` is how long the line may take to open.
    pub fn connect(self, answer_sdp: &str, wait: Duration) -> Result<RtcWire, RtcError> {
        let Initiator { rt, pc, channel, open, opened, rx, inbox } = self;
        rt.block_on(async {
            pc.set_remote_description(RTCSessionDescription::answer(answer_sdp.to_owned()).map_err(failed)?)
                .await
                .map_err(failed)?;
            await_open(&open, &opened, wait).await
        })?;
        Ok(RtcWire::new(rt, pc, channel, rx, inbox))
    }
}

async fn await_open(open: &Notify, opened: &AtomicBool, wait: Duration) -> Result<(), RtcError> {
    let waiting = async {
        while !opened.load(Ordering::SeqCst) {
            tokio::time::timeout(Duration::from_millis(100), open.notified()).await.ok();
        }
    };
    tokio::time::timeout(wait, waiting).await.map_err(|_| RtcError::NoConnection)
}

/// The receiver's side after the offer: the answer's SDP is ready, the channel not yet open.
pub struct Responder {
    rt: Arc<Runtime>,
    pc: Arc<RTCPeerConnection>,
    arrived: Arc<Mutex<Option<Arrived>>>,
    got: Arc<Notify>,
}

struct Arrived {
    channel: Arc<RTCDataChannel>,
    open: Arc<Notify>,
    opened: Arc<AtomicBool>,
    rx: Receiver<Frame>,
    inbox: Inbox,
}

impl Responder {
    /// Takes an offer and makes the answer, candidates in it.
    pub fn accept(offer_sdp: &str, config: &Config) -> Result<(Responder, String), RtcError> {
        let rt = runtime()?;
        let arrived: Arc<Mutex<Option<Arrived>>> = Arc::new(Mutex::new(None));
        let got = Arc::new(Notify::new());
        let (pc, sdp) = rt.block_on(async {
            let pc = peer(config).await?;
            let (slot, notify) = (arrived.clone(), got.clone());
            pc.on_data_channel(Box::new(move |channel| {
                let (open, opened) = (Arc::new(Notify::new()), Arc::new(AtomicBool::new(false)));
                let (rx, inbox) = hook(&channel, open.clone(), opened.clone());
                // A channel that arrives already open has missed its on_open: ask.
                if channel.ready_state() == webrtc::data_channel::data_channel_state::RTCDataChannelState::Open {
                    opened.store(true, Ordering::SeqCst);
                }
                let (slot, notify) = (slot.clone(), notify.clone());
                Box::pin(async move {
                    channel.set_buffered_amount_low_threshold(LOW).await;
                    *slot.lock().unwrap() = Some(Arrived { channel, open, opened, rx, inbox });
                    notify.notify_one();
                })
            }));
            let _ = notify;
            pc.set_remote_description(RTCSessionDescription::offer(offer_sdp.to_owned()).map_err(failed)?)
                .await
                .map_err(failed)?;
            let answer = pc.create_answer(None).await.map_err(failed)?;
            let mut gathered = pc.gathering_complete_promise().await;
            pc.set_local_description(answer).await.map_err(failed)?;
            let _ = gathered.recv().await;
            let local = pc.local_description().await.ok_or_else(|| RtcError::Failed("no local description".into()))?;
            Ok::<_, RtcError>((pc, local.sdp))
        })?;
        Ok((Responder { rt, pc, arrived, got }, sdp))
    }

    /// Waits for the sender's channel to arrive and open.
    pub fn connect(self, wait: Duration) -> Result<RtcWire, RtcError> {
        let Responder { rt, pc, arrived, got } = self;
        let found = rt.block_on(async {
            let waiting = async {
                loop {
                    if arrived.lock().unwrap().is_some() {
                        return;
                    }
                    tokio::time::timeout(Duration::from_millis(100), got.notified()).await.ok();
                }
            };
            tokio::time::timeout(wait, waiting).await.map_err(|_| RtcError::NoConnection)?;
            let a = arrived.lock().unwrap().take().expect("it arrived");
            await_open(&a.open, &a.opened, wait).await?;
            Ok::<_, RtcError>(a)
        })?;
        Ok(RtcWire::new(rt, pc, found.channel, found.rx, found.inbox))
    }
}

/// An open data channel as the transfer's line.
pub struct RtcWire {
    rt: Arc<Runtime>,
    pc: Arc<RTCPeerConnection>,
    channel: Arc<RTCDataChannel>,
    rx: Receiver<Frame>,
    inbox: Inbox,
    closed: Arc<AtomicBool>,
}

impl RtcWire {
    fn new(rt: Arc<Runtime>, pc: Arc<RTCPeerConnection>, channel: Arc<RTCDataChannel>, rx: Receiver<Frame>, inbox: Inbox) -> Self {
        let closed = Arc::new(AtomicBool::new(false));
        // The whole connection going away is the line going away, even when the channel says nothing.
        let (sink, flag) = (inbox.tx.clone(), closed.clone());
        pc.on_peer_connection_state_change(Box::new(move |state| {
            if std::env::var_os("SONDRA_RTC_DEBUG").is_some() {
                eprintln!("wire sees {state}");
            }
            if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed | RTCPeerConnectionState::Disconnected) {
                flag.store(true, Ordering::SeqCst);
                if state != RTCPeerConnectionState::Disconnected {
                    sink.lock().unwrap().take();
                }
            }
            Box::pin(async {})
        }));
        Self { rt, pc, channel, rx, inbox, closed }
    }
}

impl Wire for RtcWire {
    fn send(&mut self, frame: Frame) -> Result<(), Closed> {
        let channel = self.channel.clone();
        let sent = self.rt.block_on(async move {
            match frame {
                Frame::Text(text) => channel.send_text(text).await.map(|_| ()),
                Frame::Bytes(bytes) => channel.send(&Bytes::from(bytes)).await.map(|_| ()),
            }
        });
        sent.map_err(|_| Closed)
    }

    fn buffered(&self) -> usize {
        self.rt.block_on(self.channel.buffered_amount())
    }

    fn recv(&mut self, timeout: Duration) -> Result<Option<Frame>, Closed> {
        match self.rx.recv_timeout(timeout) {
            Ok(frame) => Ok(Some(frame)),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(Closed),
        }
    }

    fn close(&mut self) {
        self.shutdown();
    }
}

impl RtcWire {
    /// Ends the line the way a transfer needs: what was sent is delivered first (the last message,
    /// „fertig“, is the one the other side waits for), then the channel is closed, then the connection.
    /// Closing the connection at once would drop what is still on its way.
    fn shutdown(&mut self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let (channel, pc, inbox) = (self.channel.clone(), self.pc.clone(), self.inbox.tx.clone());
        self.rt.block_on(async move {
            let drained = async {
                while channel.buffered_amount().await > 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(5), drained).await;
            let _ = channel.close().await;
            // The other side's close comes back as ours; waiting for it means its reads are done.
            let gone = async {
                while inbox.lock().unwrap().is_some() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(2), gone).await;
            let _ = tokio::time::timeout(Duration::from_secs(3), pc.close()).await;
        });
        self.inbox.tx.lock().unwrap().take();
    }
}

impl Drop for RtcWire {
    fn drop(&mut self) {
        self.shutdown();
    }
}
