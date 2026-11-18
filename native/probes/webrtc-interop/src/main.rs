//! Probe for Welle 0b: does a Rust device understand the web app's devices?
//!
//! Plays the sender the way `devices.ts` does: a connection without any ICE
//! server, one ordered data channel called "sondra", 64 KiB pieces with the
//! sender holding back while the channel's buffer is full. The other side is
//! the real Chromium, driven by `run.mjs`. The offer and the answer travel as
//! files, where the app would send them through Drive.
//!
//! Usage: probe-webrtc-interop <dir>   (writes <dir>/offer.json, reads <dir>/answer.json)

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use tokio::sync::{mpsc, Notify};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

const CHUNK: usize = 64 * 1024;
const TOTAL: usize = 8 * 1024 * 1024;
const BUFFER_HIGH: usize = 4 * 1024 * 1024;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(std::env::args().nth(1).expect("a directory"));
    let api = APIBuilder::new().build();
    let pc = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);
    let channel = pc
        .create_data_channel("sondra", Some(RTCDataChannelInit { ordered: Some(true), ..Default::default() }))
        .await?;

    let open = Arc::new(Notify::new());
    let low = Arc::new(Notify::new());
    channel.set_buffered_amount_low_threshold(1024 * 1024).await;
    {
        let open = open.clone();
        channel.on_open(Box::new(move || {
            open.notify_one();
            Box::pin(async {})
        }));
        let low = low.clone();
        channel
            .on_buffered_amount_low(Box::new(move || {
                low.notify_one();
                Box::pin(async {})
            }))
            .await;
    }
    let (reply_tx, mut reply_rx) = mpsc::unbounded_channel::<String>();
    channel.on_message(Box::new(move |message| {
        let _ = reply_tx.send(String::from_utf8_lossy(&message.data).into_owned());
        Box::pin(async {})
    }));

    // The offer, with the candidates in it: the app waits for gathering to finish too.
    let offer = pc.create_offer(None).await?;
    let mut gathered = pc.gathering_complete_promise().await;
    pc.set_local_description(offer).await?;
    let _ = gathered.recv().await;
    let local = pc.local_description().await.expect("a local description");
    std::fs::write(dir.join("offer.json"), serde_json::to_string(&local)?)?;
    println!("offer written");

    let answer_path = dir.join("answer.json");
    let answer: RTCSessionDescription = loop {
        if let Ok(text) = std::fs::read_to_string(&answer_path) {
            if let Ok(answer) = serde_json::from_str(&text) {
                break answer;
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    pc.set_remote_description(answer).await?;

    tokio::time::timeout(Duration::from_secs(30), open.notified())
        .await
        .map_err(|_| "the data channel never opened")?;
    println!("channel open");

    // A header like the app's first message, then the data in pieces.
    channel.send_text(format!("{{\"type\":\"probe\",\"size\":{TOTAL}}}")).await?;
    let started = std::time::Instant::now();
    let mut sent = 0;
    while sent < TOTAL {
        while channel.buffered_amount().await > BUFFER_HIGH {
            low.notified().await;
        }
        let piece: Vec<u8> = (0..CHUNK).map(|i| ((sent + i) % 251) as u8).collect();
        channel.send(&Bytes::from(piece)).await?;
        sent += CHUNK;
    }
    println!("sent {sent} bytes in {:.2}s", started.elapsed().as_secs_f64());

    // The browser says what it got, and sends a piece back.
    let reply = tokio::time::timeout(Duration::from_secs(30), reply_rx.recv())
        .await
        .map_err(|_| "no reply from the browser")?
        .ok_or("channel closed")?;
    println!("browser said: {reply}");
    let back = tokio::time::timeout(Duration::from_secs(30), reply_rx.recv())
        .await
        .map_err(|_| "no piece back from the browser")?
        .ok_or("channel closed")?;
    println!("browser sent back {} characters", back.len());
    pc.close().await?;
    Ok(())
}
