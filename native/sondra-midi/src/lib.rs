//! MIDI controllers (keyboards, drum pads) for the pads of the Zerschneiden page. The reading of the bytes and the
//! mapping of a note to a pad are `parseMidi`/`midiNoteToPadIndex` of the website (`src/lib/midi.ts`), rule for rule.

use std::sync::mpsc::Receiver;

/// What a controller says that a pad cares about.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Message {
    /// A pad (0..15) struck, with the velocity in 0.01 … 1.
    NoteOn { pad: usize, velocity: f64, note: u8 },
    NoteOff { pad: usize, note: u8 },
}

/// Which pad a note number plays: the notes 36–51 (General MIDI drums, MPC) one to one, 48–63 and 60–75 from the
/// first pad, any other note wrapped into the sixteen.
pub fn pad_of(note: u8) -> usize {
    let note = usize::from(note);
    if (36..=51).contains(&note) {
        note - 36
    } else if (48..=63).contains(&note) {
        note - 48
    } else if (60..=75).contains(&note) {
        note - 60
    } else {
        note % 16
    }
}

/// One MIDI message as bytes. Note on with velocity 0 is a note off, as every controller means it; anything else
/// (controllers, clock, pitch bend) is of no interest here.
pub fn parse(data: &[u8]) -> Option<Message> {
    if data.len() < 3 {
        return None;
    }
    let (status, note, raw) = (data[0] & 0xF0, data[1], data[2]);
    match status {
        0x90 if raw > 0 => Some(Message::NoteOn { pad: pad_of(note), velocity: (f64::from(raw) / 127.0).clamp(0.01, 1.0), note }),
        0x80 | 0x90 => Some(Message::NoteOff { pad: pad_of(note), note }),
        _ => None,
    }
}

/// Every controller that is connected, listened to at once.
pub struct Input {
    #[cfg(windows)]
    _open: Vec<imp::Open>,
    pub devices: Vec<String>,
    #[allow(dead_code)]
    messages: Receiver<Message>,
}

impl Input {
    /// Opens every input there is. `None` where the system has no MIDI to ask (not Windows); no controller is an
    /// `Input` with no devices (one plugged in later is found by connecting again).
    pub fn connect() -> Option<Input> {
        #[cfg(windows)]
        {
            Some(imp::connect())
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    /// For tests: an input that hears what is sent through the returned sender, and says it has a device.
    pub fn for_test(device: &str) -> (Input, std::sync::mpsc::Sender<Message>) {
        let (tx, messages) = std::sync::mpsc::channel();
        (
            Input {
                #[cfg(windows)]
                _open: Vec::new(),
                devices: vec![device.to_owned()],
                messages,
            },
            tx,
        )
    }

    /// What came in since the last time.
    pub fn poll(&self) -> Vec<Message> {
        self.messages.try_iter().collect()
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::mpsc::{channel, Sender};

    use windows::Win32::Media::Audio::{
        midiInClose, midiInGetDevCapsW, midiInGetNumDevs, midiInOpen, midiInReset, midiInStart, midiInStop, CALLBACK_FUNCTION, HMIDIIN, MIDIINCAPSW,
    };

    use super::{parse, Input, Message};

    /// `MIM_DATA`: a short message, packed in the first parameter (status, then the two data bytes).
    const MIM_DATA: u32 = 0x3C3;

    pub struct Open {
        handle: HMIDIIN,
        /// The sender the callback writes to; freed after the input is closed.
        sender: *mut Sender<Message>,
    }

    // SAFETY: the handle is only used to close the input and the sender is only written to from the system's
    // callback; both live as long as the `Open`.
    unsafe impl Send for Open {}

    impl Drop for Open {
        fn drop(&mut self) {
            // SAFETY: the handle was opened by `midiInOpen`; once it is closed no callback runs, and then the
            // sender it carried can go.
            unsafe {
                let _ = midiInStop(self.handle);
                let _ = midiInReset(self.handle);
                let _ = midiInClose(self.handle);
                drop(Box::from_raw(self.sender));
            }
        }
    }

    unsafe extern "system" fn callback(_: HMIDIIN, message: u32, instance: usize, first: usize, _: usize) {
        if message != MIM_DATA || instance == 0 {
            return;
        }
        let packed = first as u32;
        let bytes = [(packed & 0xFF) as u8, ((packed >> 8) & 0xFF) as u8, ((packed >> 16) & 0xFF) as u8];
        if let Some(m) = parse(&bytes) {
            // SAFETY: `instance` is the sender `connect` gave to this input, alive until the input is closed.
            let _ = unsafe { &*(instance as *const Sender<Message>) }.send(m);
        }
    }

    fn name_of(index: u32) -> String {
        let mut caps = MIDIINCAPSW::default();
        // SAFETY: `caps` is a live structure of the size that is passed.
        let ok = unsafe { midiInGetDevCapsW(index as usize, &mut caps, std::mem::size_of::<MIDIINCAPSW>() as u32) } == 0;
        if !ok {
            return "MIDI-Eingang".into();
        }
        let name = caps.szPname;
        let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        String::from_utf16_lossy(&name[..end])
    }

    pub fn connect() -> Input {
        let (tx, messages) = channel();
        let mut open = Vec::new();
        let mut devices = Vec::new();
        // SAFETY: plain system calls; every handle that is opened is closed in `Open::drop`.
        unsafe {
            for index in 0..midiInGetNumDevs() {
                let sender = Box::into_raw(Box::new(tx.clone()));
                let mut handle = HMIDIIN::default();
                let opened = midiInOpen(&mut handle, index, Some(callback as *const () as usize), Some(sender as usize), CALLBACK_FUNCTION);
                if opened != 0 {
                    drop(Box::from_raw(sender));
                    continue;
                }
                let _ = midiInStart(handle);
                open.push(Open { handle, sender });
                devices.push(name_of(index));
            }
        }
        Input { _open: open, devices, messages }
    }
}
