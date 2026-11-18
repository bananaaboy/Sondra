# xattr 0.2.3, patched

A copy of `xattr` 0.2.3 (MIT OR Apache-2.0, see the licence files here) with one
change, in `src/sys/mod.rs`: on Linux and Android the "no such attribute" error is
`ENODATA`, not `ENOATTR`. `libc` 0.2.191 no longer defines `ENOATTR` for Linux, so
the unpatched crate does not build there, and GPUI depends on it.

Only Linux needs this; Windows never compiles `xattr`. Remove the copy and the
`[patch.crates-io]` entry in `native/Cargo.toml` once a fixed `xattr` is released.
