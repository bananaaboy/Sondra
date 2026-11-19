//! The cable: a phone on USB with its ADB interface (class 0xFF, subclass 0x42, protocol 1), read and written in
//! whole packets. The web app does this through WebUSB; here it is the system's own USB, which on Windows needs
//! the phone's ADB driver (WinUSB) — the same driver WebUSB needs.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_lite::future::{block_on, poll_once};
use nusb::transfer::{Direction, EndpointType, RequestBuffer};

use crate::adb::{Link, Packet};
use crate::MirrorError;

/// A phone found on USB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneInfo {
    pub id: String,
    /// What it calls itself (the product name), or its ids when it says nothing.
    pub name: String,
    pub serial: Option<String>,
}

/// Whether an interface is ADB's.
pub fn is_adb_interface(class: u8, subclass: u8, protocol: u8) -> bool {
    class == 0xff && subclass == 0x42 && protocol == 0x01
}

/// A transfer on an IN endpoint is asked for in multiples of the packet size.
pub fn read_size(wanted: usize, packet_size: usize) -> usize {
    let packet = packet_size.max(64);
    wanted.max(1).div_ceil(packet) * packet
}

/// The phones that are plugged in and offer ADB.
pub fn list_phones() -> Vec<PhoneInfo> {
    let Ok(devices) = nusb::list_devices() else { return Vec::new() };
    devices
        .filter(|d| d.interfaces().any(|i| is_adb_interface(i.class(), i.subclass(), i.protocol())))
        .map(|d| PhoneInfo {
            id: format!("{:?}", d.id()),
            name: d.product_string().map(str::to_owned).unwrap_or_else(|| format!("USB {:04x}:{:04x}", d.vendor_id(), d.product_id())),
            serial: d.serial_number().map(str::to_owned),
        })
        .collect()
}

pub struct UsbLink {
    interface: nusb::Interface,
    out_endpoint: u8,
    incoming: Mutex<Receiver<io::Result<Packet>>>,
    closed: Arc<AtomicBool>,
}

impl UsbLink {
    /// Opens the phone `id` (from [`list_phones`]) and starts reading.
    pub fn open(id: &str) -> Result<UsbLink, MirrorError> {
        let info = nusb::list_devices()
            .map_err(|e| MirrorError::Usb(format!("Der USB-Anschluss lässt sich nicht lesen ({e}).")))?
            .find(|d| format!("{:?}", d.id()) == id)
            .ok_or_else(|| MirrorError::Usb("Das Handy ist nicht mehr angeschlossen.".into()))?;
        let device = info.open().map_err(|e| MirrorError::Usb(format!("Das Handy lässt sich nicht öffnen ({e}). Unter Windows braucht es den ADB-Treiber des Herstellers (WinUSB); ein laufendes „adb“ hält es ebenfalls besetzt.")))?;
        let configuration = device.active_configuration().map_err(|e| MirrorError::Usb(e.to_string()))?;
        let found = configuration
            .interface_alt_settings()
            .find(|i| is_adb_interface(i.class(), i.subclass(), i.protocol()))
            .ok_or_else(|| MirrorError::Usb("Das Gerät hat keine ADB-Schnittstelle: USB-Debugging ist aus, oder das Kabel lädt nur.".into()))?;
        let number = found.interface_number();
        let (mut in_endpoint, mut out_endpoint, mut packet) = (None, None, 512);
        for endpoint in found.endpoints() {
            if endpoint.transfer_type() != EndpointType::Bulk {
                continue;
            }
            match endpoint.direction() {
                Direction::In => {
                    in_endpoint = Some(endpoint.address());
                    packet = endpoint.max_packet_size();
                }
                Direction::Out => out_endpoint = Some(endpoint.address()),
            }
        }
        let (Some(in_endpoint), Some(out_endpoint)) = (in_endpoint, out_endpoint) else {
            return Err(MirrorError::Usb("Die ADB-Schnittstelle des Handys hat keine Bulk-Kanäle.".into()));
        };
        let interface = device.claim_interface(number).map_err(|e| MirrorError::Usb(format!("Die ADB-Schnittstelle ist besetzt ({e}). Beenden Sie „adb“ (adb kill-server) und andere Programme, die das Handy halten.")))?;

        let (tx, rx) = channel();
        let closed = Arc::new(AtomicBool::new(false));
        let (reader, stop) = (interface.clone(), closed.clone());
        std::thread::spawn(move || {
            let mut queue = reader.bulk_in_queue(in_endpoint);
            // One transfer after the other: a header, then the payload it announces.
            let read = |queue: &mut nusb::transfer::Queue<RequestBuffer>, wanted: usize, stop: &AtomicBool| -> io::Result<Vec<u8>> {
                let size = read_size(wanted, packet);
                queue.submit(RequestBuffer::new(size));
                // Polled with a short rest rather than waited for, so that closing can cancel it.
                let mut future = Box::pin(queue.next_complete());
                loop {
                    if let Some(done) = block_on(poll_once(&mut future)) {
                        return match done.status {
                            Ok(()) => Ok(done.data),
                            Err(e) => Err(io::Error::new(io::ErrorKind::BrokenPipe, e.to_string())),
                        };
                    }
                    if stop.load(Ordering::SeqCst) {
                        drop(future);
                        queue.cancel_all();
                        return Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"));
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
            };
            loop {
                let outcome = (|| -> io::Result<Packet> {
                    let header_bytes = read(&mut queue, 24, &stop)?;
                    let header: [u8; 24] = header_bytes.get(..24).and_then(|h| h.try_into().ok()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "a short header"))?;
                    let (mut packet_, len) = Packet::from_header(&header).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
                    // What came with the header (some phones send both in one transfer) and the rest.
                    let mut payload = header_bytes[24..].to_vec();
                    while payload.len() < len {
                        let more = read(&mut queue, len - payload.len(), &stop)?;
                        payload.extend(more);
                    }
                    payload.truncate(len);
                    packet_.payload = payload;
                    Ok(packet_)
                })();
                let failed = outcome.is_err();
                if tx.send(outcome).is_err() || failed {
                    break;
                }
            }
        });
        Ok(UsbLink { interface, out_endpoint, incoming: Mutex::new(rx), closed })
    }
}

impl Link for UsbLink {
    fn send(&self, packet: &Packet) -> io::Result<()> {
        // The header and the payload are separate transfers, as the phone's USB driver expects.
        let write = |data: Vec<u8>| -> io::Result<()> {
            let done = block_on(self.interface.bulk_out(self.out_endpoint, data));
            done.status.map_err(|e| io::Error::new(io::ErrorKind::BrokenPipe, e.to_string()))
        };
        write(packet.header().to_vec())?;
        if !packet.payload.is_empty() {
            write(packet.payload.clone())?;
        }
        Ok(())
    }

    fn recv(&self) -> io::Result<Packet> {
        self.incoming.lock().expect("lock").recv().map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "closed"))?
    }

    fn recv_timeout(&self, wait: Duration) -> io::Result<Option<Packet>> {
        match self.incoming.lock().expect("lock").recv_timeout(wait) {
            Ok(packet) => packet.map(Some),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed")),
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}
