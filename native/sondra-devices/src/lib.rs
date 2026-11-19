//! Who a device is, in a way no other device can claim. A port of `src/lib/deviceIdentity.ts`, interoperable
//! with it byte for byte: a record this crate signs verifies on the website and the other way round.
//!
//! Every device makes one key pair (ECDSA P-256) the first time it joins. Its id is the hash of its public key
//! (SHA-256, the first 100 bits, in Crockford base32), so an id cannot be chosen, only earned. Every record a
//! device puts into Drive and every message it sends another is signed. All devices of one account can write
//! each other's files — Drive knows no finer rights than the account — so a record changed by anyone but its
//! owner fails its signature, is ignored, and its owner writes it again on its next round.

pub mod identity;
pub use identity::*;
