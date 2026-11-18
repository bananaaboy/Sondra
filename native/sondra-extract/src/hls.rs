//! HLS playlists: the qualities a master offers, the segments of a media playlist, byte ranges,
//! separate sound tracks. A port of `parseM3u8` and `audioFor` (`src/lib/download.ts`).
//!
//! Nothing here touches the network, and a segment address that points into this computer or its
//! network (loopback, private ranges, `localhost`) is dropped: a playlist is text from a stranger,
//! and it must not make Sondra knock on the router.

use std::collections::HashMap;
use std::net::IpAddr;

use regex::Regex;
use url::{Host, Url};

fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    pub url: String,
    pub bandwidth: u64,
    pub resolution: Option<String>,
    pub codecs: Option<String>,
    /// The `AUDIO` group whose rendition carries this variant's sound, if apart.
    pub audio_group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendition {
    pub url: String,
    pub group_id: String,
    pub is_default: bool,
    pub language: Option<String>,
    pub name: Option<String>,
}

/// Bytes `start` through `end` (inclusive) of a segment's address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Playlist {
    pub is_master: bool,
    /// Best quality first.
    pub variants: Vec<Variant>,
    pub segments: Vec<String>,
    /// Per segment, the part of its address it is, or `None` for the whole.
    pub ranges: Vec<Option<ByteRange>>,
    pub audio: Vec<Rendition>,
    /// Segments are encrypted; Sondra does not fetch keys.
    pub encrypted: bool,
}

/// A host that is this computer or its own network.
pub fn is_private_host(url: &Url) -> bool {
    match url.host() {
        None => true,
        Some(Host::Domain(name)) => {
            let name = name.to_ascii_lowercase();
            name == "localhost"
                || name.ends_with(".localhost")
                || name.ends_with(".local")
                || name.ends_with(".internal")
        }
        Some(Host::Ipv4(ip)) => private_ip(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => private_ip(IpAddr::V6(ip)),
    }
}

fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1])) // carrier-grade NAT
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return private_ip(IpAddr::V4(mapped));
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

/// Parses an M3U8 playlist into its variants or its segment list.
pub fn parse(text: &str, base_url: &str) -> Playlist {
    parse_with(text, base_url, false)
}

/// As [`parse`]; `allow_private` keeps addresses inside this network. For tests against a server on
/// this very computer — a real download never sets it.
pub fn parse_with(text: &str, base_url: &str, allow_private: bool) -> Playlist {
    let base = Url::parse(base_url).ok();
    // A line that is not an address (or not one we may fetch) is skipped, never fatal.
    let resolve = |reference: &str| -> Option<String> {
        let url = base.as_ref()?.join(reference).ok()?;
        if !matches!(url.scheme(), "http" | "https") || (!allow_private && is_private_host(&url)) {
            return None;
        }
        Some(url.to_string())
    };

    let mut variants = Vec::new();
    let mut segments = Vec::new();
    let mut audio = Vec::new();
    let mut ranges = Vec::new();
    let mut encrypted = false;
    let mut pending_variant: Option<Variant> = None;
    let mut pending_range: Option<String> = None;
    // A range without an offset continues where the last one of the same address ended.
    let mut end_of: HashMap<String, u64> = HashMap::new();
    let mut range_for = |spec: &str, address: &str| -> Option<ByteRange> {
        let (length_text, offset_text) = match spec.split_once('@') {
            Some((l, o)) => (l, Some(o)),
            None => (spec, None),
        };
        let length: u64 = length_text.trim().parse().ok().filter(|l| *l > 0)?;
        let start = offset_text
            .and_then(|o| o.trim().parse::<u64>().ok())
            .unwrap_or_else(|| end_of.get(address).copied().unwrap_or(0));
        end_of.insert(address.to_owned(), start + length);
        Some(ByteRange {
            start,
            end: start + length - 1,
        })
    };

    let attr = |line: &str, pattern: &str| rx(pattern).captures(line).map(|c| c[1].to_owned());

    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_variant = Some(Variant {
                url: String::new(),
                // `AVERAGE-BANDWIDTH` would match a looser pattern first.
                bandwidth: attr(attributes, r"(?:^|,)BANDWIDTH=(\d+)")
                    .and_then(|b| b.parse().ok())
                    .unwrap_or(0),
                resolution: attr(attributes, r"RESOLUTION=([\dx]+)"),
                codecs: attr(attributes, r#"CODECS="([^"]+)""#),
                audio_group: attr(attributes, r#"AUDIO="([^"]+)""#),
            });
            continue;
        }
        if line.starts_with("#EXT-X-MEDIA:") && line.contains("TYPE=AUDIO") {
            if let Some(url) = attr(line, r#"URI="([^"]+)""#).and_then(|u| resolve(&u)) {
                audio.push(Rendition {
                    url,
                    group_id: attr(line, r#"GROUP-ID="([^"]+)""#).unwrap_or_default(),
                    is_default: line.contains("DEFAULT=YES"),
                    language: attr(line, r#"LANGUAGE="([^"]+)""#),
                    name: attr(line, r#"NAME="([^"]+)""#),
                });
            }
            continue;
        }
        if line.starts_with("#EXT-X-KEY:") && !line.contains("METHOD=NONE") {
            encrypted = true;
            continue;
        }
        if line.starts_with("#EXT-X-MAP:") {
            // The initialisation segment of fragmented MP4 leads the stream.
            if let Some(url) = attr(line, r#"URI="([^"]+)""#).and_then(|u| resolve(&u)) {
                let spec = attr(line, r#"BYTERANGE="([^"]+)""#);
                let range = spec.and_then(|s| range_for(&s, &url));
                segments.push(url);
                ranges.push(range);
            }
            continue;
        }
        if let Some(spec) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            pending_range = Some(spec.trim().to_owned());
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let Some(url) = resolve(line) else { continue };
        if let Some(mut variant) = pending_variant.take() {
            variant.url = url;
            variants.push(variant);
        } else {
            let range = pending_range.take().and_then(|s| range_for(&s, &url));
            segments.push(url);
            ranges.push(range);
        }
    }
    variants.sort_by(|a, b| b.bandwidth.cmp(&a.bandwidth));
    Playlist {
        is_master: !variants.is_empty(),
        variants,
        segments,
        ranges,
        audio,
        encrypted,
    }
}

/// The sound that belongs to a variant when it is not in the variant itself: the default rendition
/// of its `AUDIO` group, else the group's first.
pub fn audio_for<'a>(playlist: &'a Playlist, variant: &Variant) -> Option<&'a Rendition> {
    let group = variant.audio_group.as_deref()?;
    let mut in_group = playlist.audio.iter().filter(|r| r.group_id == group);
    let first = in_group.clone().next();
    let chosen = in_group.find(|r| r.is_default).or(first)?;
    // Some masters name the variant's own address as the rendition; fetching it twice would put
    // the same picture in as "sound".
    (chosen.url != variant.url).then_some(chosen)
}

/// True when the bytes start like an M3U8 playlist (BOM and blank lines aside).
pub fn looks_like_playlist(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(64)]);
    head.trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("#EXTM3U")
}
