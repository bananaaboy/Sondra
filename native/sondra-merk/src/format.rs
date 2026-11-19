//! Sizes and dates as the web app prints them (`src/lib/format.ts`, and the folder page's short date).

use chrono::{DateTime, TimeZone};

/// `Number.prototype.toFixed`: the decimal text of the exact value, rounded half up at `digits`.
pub fn to_fixed(value: f64, digits: usize) -> String {
    // A positive float below 2^53 times 1/2^52 has at most 52 fractional decimal digits: sixty is exact.
    let exact = format!("{:.60}", value);
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut digits_all: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).map(|b| b - b'0').collect();
    let round_up = fraction.as_bytes().get(digits).is_some_and(|b| *b >= b'5');
    if round_up {
        let mut i = digits_all.len();
        loop {
            if i == 0 {
                digits_all.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_all[i] == 9 {
                digits_all[i] = 0;
            } else {
                digits_all[i] += 1;
                break;
            }
        }
    }
    let int_len = digits_all.len() - digits;
    let int_part: String = digits_all[..int_len].iter().map(|d| (b'0' + d) as char).collect();
    if digits == 0 {
        return int_part;
    }
    let frac_part: String = digits_all[int_len..].iter().map(|d| (b'0' + d) as char).collect();
    format!("{int_part}.{frac_part}")
}

/// „1.5 GB“: the size of a file in plain words. Not a number (or negative) is „—“.
pub fn format_bytes(bytes: f64, digits: usize) -> String {
    if !bytes.is_finite() || bytes < 0.0 {
        return "—".into();
    }
    if bytes < 1024.0 {
        return format!("{} B", (bytes + 0.5).floor());
    }
    let units = ["KB", "MB", "GB", "TB"];
    let (mut value, mut unit) = (bytes / 1024.0, 0);
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{} {}", to_fixed(value, if value >= 100.0 { 0 } else { digits }), units[unit])
}

/// „14.11.23“: day, month and year of a time, as the folder page shows a file's date.
pub fn short_date<Tz: TimeZone>(tz: &Tz, ms: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    match DateTime::from_timestamp_millis(ms) {
        Some(at) => at.with_timezone(tz).format("%d.%m.%y").to_string(),
        None => "—".into(),
    }
}
