# webrtc 0.14.0, patched

A copy of `webrtc` 0.14.0 (MIT OR Apache-2.0, see the licence files here) with one change, in
`src/data_channel/mod.rs`: the buffer a data channel reads a message into is 256 KiB, not 65 535 bytes.

Why: the web app (and the Android app) send files in pieces of exactly 64 KiB (65 536 bytes,
`CHUNK` in `deviceTransfer.ts`). The unpatched channel reads into a `u16::MAX` buffer, fails with
`ErrShortBuffer` on the first such piece and closes the channel — a Rust device could send to a
browser (`probes/webrtc-interop`) but could not receive from one. Browsers allow up to 256 KiB per
message, so the new buffer holds anything a browser may send.

`native/sondra-devices/tests/rtc.rs` runs a transfer of 64 KiB pieces over a real connection. Remove the
copy and the `[patch.crates-io]` entry in `native/Cargo.toml` once the fix is in a released `webrtc`.
