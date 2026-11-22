//! The statistics of the Merkliste to take along (`MerklistePanel.tsx`, „Statistik als Bild“ and „Zusammenfassung
//! als Text kopieren“): a picture of 900 × 500 in the palette's greens — four numbers, the stands as a bar with
//! their share — and the same in a few lines of text. Both say „Erstellt mit Sondra“.

use sondra_merk::model::Status;
use sondra_merk::stats::{calculate_stats, Stats};
use sondra_merk::Item;

/// The stands with their colour on the picture, as the website draws them.
const SHARES: [(Status, &str, &str); 5] = [
    (Status::Watching, "Am Schauen", "#0b4a22"),
    (Status::Later, "Später", "#799081"),
    (Status::Paused, "Pausiert", "#4e6355"),
    (Status::Done, "Fertig", "#a7bca9"),
    (Status::Dropped, "Abgebrochen", "#c8e1cf"),
];

fn shares(items: &[Item], s: &Stats) -> Vec<(&'static str, &'static str, usize, i64)> {
    SHARES
        .iter()
        .map(|(status, label, hex)| {
            let n = items.iter().filter(|i| i.status == *status).count();
            let p = if s.total_series == 0 { 0 } else { ((n as f64 / s.total_series as f64) * 100.0).round() as i64 };
            (*label, *hex, n, p)
        })
        .collect()
}

/// „Zusammenfassung als Text kopieren“.
pub fn summary_text(items: &[Item]) -> String {
    let s = calculate_stats(items);
    let stands: Vec<String> = shares(items, &s).into_iter().filter(|(_, _, n, _)| *n > 0).map(|(label, _, n, _)| format!("{n} {}", label.to_lowercase())).collect();
    let mut lines = vec!["**Meine Sondra Merkliste**:".to_string(), format!("• {} ({} Serien)", stands.join(" · "), s.total_series), format!("• {} Folgen gesehen (ca. {} / {} Sehzeit)", s.seen_total, s.watch_time.short, s.watch_time.long)];
    if let Some(avg) = &s.avg_rating {
        lines.push(format!("• ⭐️ Durchschnittsbewertung: ★ {avg}"));
    }
    if s.completed_seasons > 0 {
        lines.push(format!("• {} Staffeln komplett gesehen", s.completed_seasons));
    }
    lines.push(String::new());
    lines.push("Erstellt mit Sondra (https://sondra.lizge.ch)".into());
    lines.join("\n")
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The picture as SVG (also what is tested).
pub fn summary_svg(items: &[Item], today: &str) -> String {
    let s = calculate_stats(items);
    let mut svg = String::from(r##"<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500" viewBox="0 0 900 500" font-family="Barlow">"##);
    svg.push_str(r##"<rect width="900" height="500" fill="#f8faf8"/><rect x="20" y="20" width="860" height="460" fill="none" stroke="#a7bca9" stroke-width="2"/><line x1="40" y1="110" x2="860" y2="110" stroke="#cbd7cf"/>"##);
    svg.push_str(r##"<text x="40" y="70" font-size="30" font-weight="700" fill="#0b4a22">Sondra · Merkliste Statistik</text>"##);
    svg.push_str(&format!(r##"<text x="40" y="96" font-size="15" fill="#4e6355">Stand vom {}</text>"##, escape(today)));
    let cards = [
        ("Gesehene Folgen", s.seen_total.to_string(), if s.seen_total == 1 { "Folge".to_string() } else { "Folgen".to_string() }),
        ("Geschätzte Sehzeit", s.watch_time.short.clone(), s.watch_time.long.clone()),
        ("Katalog", s.total_series.to_string(), format!("{} am Schauen", s.watching_count)),
        ("Bewertungsschnitt", s.avg_rating.clone().unwrap_or_else(|| "—".to_string()), format!("{} bewertet", s.rated_count)),
    ];
    for (n, (label, value, sub)) in cards.iter().enumerate() {
        let x = 40 + n * 205;
        let sub: String = sub.chars().take(24).collect();
        // The rating with a star drawn as a shape (the faces have no ★), the number after it.
        let (value_x, star) = if n == 3 && s.avg_rating.is_some() {
            let (cx, cy, r) = (x as f64 + 26.0, 194.0, 11.0);
            let points: Vec<String> = (0..10)
                .map(|k| {
                    let radius = if k % 2 == 0 { r } else { r * 0.45 };
                    let angle = std::f64::consts::PI / 5.0 * k as f64 - std::f64::consts::FRAC_PI_2;
                    format!("{:.1},{:.1}", cx + radius * angle.cos(), cy + radius * angle.sin())
                })
                .collect();
            (x + 44, format!(r##"<polygon points="{}" fill="#0b4a22"/>"##, points.join(" ")))
        } else {
            (x + 14, String::new())
        };
        svg.push_str(&format!(
            r##"<rect x="{x}" y="135" width="195" height="110" fill="#e0f0e5" stroke="#a7bca9"/><text x="{}" y="163" font-size="13" fill="#4e6355">{}</text><text x="{}" y="203" font-size="26" font-weight="700" fill="#0b4a22">{}</text><text x="{}" y="229" font-size="12" fill="#111a14">{}</text>"##,
            x + 14,
            escape(label),
            value_x,
            escape(&if n == 3 { value.replace('.', ",") } else { value.clone() }),
            x + 14,
            escape(&sub)
        ));
        svg.push_str(&star);
    }
    svg.push_str(r##"<text x="40" y="285" font-size="15" font-weight="700" fill="#111a14">Status-Aufteilung</text><rect x="40" y="300" width="820" height="14" fill="#cbd7cf"/>"##);
    let list = shares(items, &s);
    if s.total_series > 0 {
        let mut x = 40.0;
        for (_, hex, n, _) in &list {
            let w = *n as f64 / s.total_series as f64 * 820.0;
            svg.push_str(&format!(r##"<rect x="{x:.2}" y="300" width="{w:.2}" height="14" fill="{hex}"/>"##));
            x += w;
        }
    }
    // The legend: the colour in the dot, the words dark.
    let mut x = 40.0;
    for (label, hex, n, p) in list.iter().filter(|(_, _, n, _)| *n > 0) {
        let text = format!("{label}: {n} ({p}%)");
        svg.push_str(&format!(r##"<circle cx="{}" cy="340" r="5" fill="{hex}"/><text x="{}" y="345" font-size="14" fill="#111a14">{}</text>"##, x + 5.0, x + 18.0, escape(&text)));
        x += 18.0 + text.chars().count() as f64 * 7.4 + 28.0;
    }
    svg.push_str(r##"<text x="40" y="430" font-size="13" font-family="Courier Prime" fill="#799081">Erstellt mit Sondra · https://sondra.lizge.ch</text></svg>"##);
    svg
}

/// The picture as PNG, drawn with Sondra's own faces.
pub fn summary_png(items: &[Item], today: &str) -> Result<Vec<u8>, String> {
    let mut options = resvg::usvg::Options::default();
    {
        let db = options.fontdb_mut();
        for bytes in sondra_ui::fonts::files() {
            db.load_font_data(bytes.to_vec());
        }
    }
    let tree = resvg::usvg::Tree::from_str(&summary_svg(items, today), &options).map_err(|e| e.to_string())?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(900, 500).ok_or("Kein Platz für das Bild.")?;
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());
    pixmap.encode_png().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sondra_merk::normalize::{normalize, Context};

    fn items() -> Vec<Item> {
        let mut ids = Context::system();
        vec![
            normalize(&json!({ "id": "a", "title": "Frieren", "status": "watching", "season": 1, "episode": 3, "rating": 5, "seasons": [{ "number": 1, "episodes": 12, "watched": [1, 2] }] }), &mut ids),
            normalize(&json!({ "id": "b", "title": "Dune", "status": "done", "season": 0, "seasons": [] }), &mut ids),
        ]
    }

    #[test]
    fn the_summary_says_the_stands_the_episodes_and_who_made_it() {
        let text = summary_text(&items());
        assert!(text.starts_with("**Meine Sondra Merkliste**:"), "{text}");
        assert!(text.contains("1 am schauen · 1 fertig (2 Serien)"), "{text}");
        assert!(text.contains("2 Folgen gesehen"), "{text}");
        assert!(text.ends_with("Erstellt mit Sondra (https://sondra.lizge.ch)"));
    }

    #[test]
    fn the_picture_is_a_png_of_900_by_500() {
        let png = summary_png(&items(), "22. November 2026").unwrap();
        assert_eq!(&png[1..4], b"PNG");
        let picture = image::load_from_memory(&png).unwrap();
        assert_eq!((picture.width(), picture.height()), (900, 500));
        assert!(summary_svg(&items(), "x").contains("Am Schauen: 1 (50%)"));
    }
}

#[cfg(test)]
#[test]
#[ignore]
fn write_the_picture_for_a_look() {
    let mut ids = sondra_merk::normalize::Context::system();
    let items = vec![
        sondra_merk::normalize::normalize(&serde_json::json!({ "id": "a", "title": "Frieren", "status": "watching", "season": 1, "episode": 3, "rating": 5, "seasons": [{ "number": 1, "episodes": 12, "watched": [1, 2] }] }), &mut ids),
        sondra_merk::normalize::normalize(&serde_json::json!({ "id": "b", "title": "Dune", "status": "done", "season": 0, "seasons": [] }), &mut ids),
        sondra_merk::normalize::normalize(&serde_json::json!({ "id": "c", "title": "One Piece", "status": "later", "season": 1, "seasons": [] }), &mut ids),
    ];
    std::fs::write(std::env::var("SONDRA_STATS_PNG").unwrap(), summary_png(&items, "22. November 2026").unwrap()).unwrap();
}
