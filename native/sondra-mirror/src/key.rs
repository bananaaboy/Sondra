//! The key that tells a phone this computer is the one it allowed: an RSA key of 2048 bits, kept in a file
//! of the app's own, so that „Immer von diesem Computer zulassen“ sticks. What the phone checks is a
//! signature over a token of 20 bytes, made as if the token were the SHA-1 of something (the way ADB does
//! it), and the public key in Android's own layout.

use std::path::Path;

use base64::Engine;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, Pkcs1v15Sign, RsaPrivateKey};

use crate::MirrorError;

pub struct AdbKey {
    key: RsaPrivateKey,
}

impl AdbKey {
    /// A new key. Slow in a debug build (seconds), quick in a release one.
    pub fn generate() -> AdbKey {
        AdbKey { key: RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).expect("a key of 2048 bits") }
    }

    pub fn from_pkcs8(der: &[u8]) -> Result<AdbKey, MirrorError> {
        let key = RsaPrivateKey::from_pkcs8_der(der).map_err(|_| MirrorError::Key("Der Schlüssel für das Handy ist unlesbar.".into()))?;
        if key.size() != 256 {
            return Err(MirrorError::Key("Der Schlüssel für das Handy hat nicht 2048 Bit.".into()));
        }
        Ok(AdbKey { key })
    }

    pub fn to_pkcs8(&self) -> Vec<u8> {
        self.key.to_pkcs8_der().expect("a key encodes").as_bytes().to_vec()
    }

    /// The key kept in `file`, or a new one made and kept there.
    pub fn load_or_create(file: &Path) -> AdbKey {
        if let Some(key) = std::fs::read(file).ok().and_then(|b| AdbKey::from_pkcs8(&b).ok()) {
            return key;
        }
        let key = AdbKey::generate();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, key.to_pkcs8());
        key
    }

    /// The signature over a token of 20 bytes (it is treated as a SHA-1 and wrapped like one).
    pub fn sign(&self, token: &[u8]) -> Vec<u8> {
        self.key.sign(Pkcs1v15Sign::new::<sha1::Sha1>(), token).expect("a token of 20 bytes is signed")
    }

    /// The public key in Android's layout (little endian): the length in words, `n0inv`, the modulus, R² and
    /// the exponent — 524 bytes.
    pub fn public_key_raw(&self) -> Vec<u8> {
        let n = self.key.n();
        let mut out = Vec::with_capacity(524);
        out.extend(64u32.to_le_bytes());
        // n0inv: the inverse of the low 32 bits of n modulo 2^32, negated.
        let low = (n % BigUint::from(1u64 << 32)).to_bytes_le().iter().take(4).enumerate().fold(0u32, |sum, (i, b)| sum | (u32::from(*b) << (8 * i)));
        out.extend(neg_inverse_mod_2_32(low).to_le_bytes());
        out.extend(little_endian(n, 256));
        let rr = (BigUint::from(1u8) << 4096usize) % n;
        out.extend(little_endian(&rr, 256));
        out.extend(65537u32.to_le_bytes());
        out
    }

    /// The public key as the phone reads it: Android's layout, in base64, a space and a name, a zero.
    pub fn public_key(&self, name: &str) -> Vec<u8> {
        let mut text = base64::engine::general_purpose::STANDARD.encode(self.public_key_raw()).into_bytes();
        if !name.is_empty() {
            text.push(b' ');
            text.extend(name.as_bytes());
        }
        text.push(0);
        text
    }
}

fn little_endian(value: &BigUint, len: usize) -> Vec<u8> {
    let mut bytes = value.to_bytes_le();
    bytes.resize(len, 0);
    bytes
}

/// −(a⁻¹) mod 2³² for an odd `a` (Newton's iteration).
fn neg_inverse_mod_2_32(a: u32) -> u32 {
    let mut x: u32 = 1;
    for _ in 0..5 {
        x = x.wrapping_mul(2u32.wrapping_sub(a.wrapping_mul(x)));
    }
    x.wrapping_neg()
}

#[cfg(test)]
mod tests {
    use super::neg_inverse_mod_2_32;

    #[test]
    fn the_inverse_multiplies_back_to_minus_one() {
        for a in [1u32, 3, 0x1234_5679, 0xffff_ffff, 65537] {
            assert_eq!(a.wrapping_mul(neg_inverse_mod_2_32(a)), u32::MAX, "{a}");
        }
    }
}
