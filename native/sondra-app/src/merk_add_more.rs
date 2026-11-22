//! „Mehr Angaben: Staffeln, Cover, Tags …“ when adding a series (the long form of the website's `AddDialog`):
//! the address (its title, season and episode are taken from it), tags, a cover by address or from this computer,
//! poster or manga, the stand to start in, how many seasons and how many episodes each — or „noch unbekannt“ —,
//! films, and where one is now („Gerade bei“: what lies before counts as seen).

use gpui::{div, prelude::*, px, AnyElement, Context, Entity};
use serde_json::json;
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::urlinfo::{derive_link_title, parse_link_episode_info};
use sondra_merk::{Item, Status};
use sondra_ui::{NoticeKind, TextField, Ui};

use crate::merk_edit::{episode_address, read_number, CoverFor};
use crate::shell::Shell;

/// What the long form says, read and checked.
#[derive(Debug, Clone, PartialEq)]
pub struct MoreInput {
    pub title: String,
    pub url: String,
    pub tags: Vec<String>,
    pub cover: Option<String>,
    pub manga: bool,
    pub status: Status,
    pub seasons: i64,
    /// Episodes per season; `None` is „noch unbekannt“.
    pub counts: Option<Vec<i64>>,
    pub films: i64,
    pub at_season: i64,
    pub at_episode: i64,
}

/// The fields of the long form while it is open.
pub struct AddMore {
    pub url: Entity<TextField>,
    pub tags: Entity<TextField>,
    pub cover: Entity<TextField>,
    pub seasons: Entity<TextField>,
    pub counts: Entity<TextField>,
    pub films: Entity<TextField>,
    pub at_season: Entity<TextField>,
    pub at_episode: Entity<TextField>,
    pub picked: Option<String>,
    pub manga: bool,
    pub status: Status,
    pub problem: Option<String>,
}

pub const STANDS: [(Status, &str); 5] = [(Status::Watching, "Am Schauen"), (Status::Later, "Später"), (Status::Paused, "Pausiert"), (Status::Done, "Fertig"), (Status::Dropped, "Abgebrochen")];

fn status_word(status: Status) -> &'static str {
    match status {
        Status::Watching => "watching",
        Status::Later => "later",
        Status::Paused => "paused",
        Status::Done => "done",
        Status::Dropped => "dropped",
    }
}

/// „12, 24, 13“ → the episodes of each season; empty is unknown. One number given for several seasons counts for each.
pub fn read_counts(text: &str, seasons: i64) -> Result<Option<Vec<i64>>, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let numbers: Vec<i64> = t
        .split([',', ';', ' '])
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.trim().parse::<i64>().ok().filter(|n| (1..=2000).contains(n)).ok_or_else(|| format!("Folgen je Staffel: „{}“ ist keine Zahl von 1 bis 2000.", p.trim())))
        .collect::<Result<_, _>>()?;
    let wanted = seasons.max(1) as usize;
    Ok(Some(match numbers.len() {
        1 => vec![numbers[0]; wanted],
        n if n == wanted => numbers,
        n => return Err(format!("Folgen je Staffel: {n} Zahlen für {wanted} Staffeln — eine je Staffel, mit Komma getrennt.")),
    }))
}

/// The entry the long form makes, as `save` in the website's `AddDialog`: seasons before „Gerade bei“ count as seen
/// (when their length is known), the one there up to the episode before; films come as season 0.
pub fn entry_from(input: &MoreInput, ids: &mut Ids) -> Item {
    let seasons = input.seasons.clamp(1, 60);
    let position = input.at_season.clamp(1, seasons);
    let count_of = |n: i64| input.counts.as_ref().and_then(|c| c.get((n - 1) as usize).copied());
    let episode = match count_of(position) {
        Some(c) => input.at_episode.clamp(1, c),
        None => input.at_episode.max(1),
    };
    let mut list: Vec<serde_json::Value> = (1..=seasons)
        .map(|number| {
            let episodes = count_of(number);
            let before = if number < position { episodes.unwrap_or(0) } else if number == position { episode - 1 } else { 0 };
            json!({ "number": number, "episodes": episodes, "watched": (1..=before.max(0)).collect::<Vec<i64>>() })
        })
        .collect();
    if input.films > 0 {
        list.push(json!({ "number": 0, "episodes": input.films, "watched": [] }));
    }
    let address = match input.url.trim() {
        "" => String::new(),
        u if u.starts_with("http://") || u.starts_with("https://") => u.to_string(),
        u => format!("https://{u}"),
    };
    let url = if address.is_empty() { address } else { episode_address(&address, position, episode) };
    let title = if input.title.trim().is_empty() && !url.is_empty() { derive_link_title(&url) } else { input.title.trim().to_string() };
    let mut raw = json!({
        "title": title,
        "url": url,
        "season": position,
        "episode": episode,
        "seasons": list,
        "status": status_word(input.status),
        "updatedAt": ids.now,
    });
    if let Some(cover) = &input.cover {
        raw["cover"] = cover.clone().into();
    }
    if input.manga {
        raw["tileFormat"] = "manga".into();
    }
    if !input.tags.is_empty() {
        raw["tags"] = input.tags.clone().into();
    }
    normalize(&raw, ids)
}

impl Shell {
    fn more_field(&self, cx: &mut Context<Self>, label: &str, value: &str, hint: &str) -> Entity<TextField> {
        let colors = self.mode.colors();
        let (label, value, hint) = (label.to_string(), value.to_string(), hint.to_string());
        cx.new(move |cx| {
            let mut f = TextField::new(cx, colors, label).placeholder(hint);
            f.set_text(value, cx);
            f
        })
    }

    /// Opens the long form; a typed address goes into its field, with what it names.
    pub fn add_more_open(&mut self, cx: &mut Context<Self>) {
        let typed = self.merk.add.read(cx).text().trim().to_string();
        let is_address = typed.starts_with("http://") || typed.starts_with("https://") || typed.starts_with("www.");
        let info = if is_address { Some(parse_link_episode_info(&typed)) } else { None };
        let (season, episode) = info.as_ref().filter(|i| i.is_episodic_url).map_or((1, 1), |i| (i.season.max(1), i.episode.unwrap_or(1).max(1)));
        let found = self.merk.add_found.clone();
        let more = AddMore {
            url: self.more_field(cx, "Web- / Stream-Adresse", if is_address { &typed } else { "" }, "https://…"),
            tags: self.more_field(cx, "Tags, durch Komma getrennt", "", "Anime, Favorit, Manga …"),
            cover: self.more_field(cx, "Adresse des Covers", found.as_ref().and_then(|m| m.cover_url.as_deref()).unwrap_or(""), "https://… oder ein Bild vom Gerät"),
            seasons: self.more_field(cx, "Anzahl Staffeln", &season.to_string(), "1"),
            counts: self.more_field(cx, "Folgen je Staffel", &found.as_ref().and_then(|m| m.episodes).map(|n| n.to_string()).unwrap_or_default(), "Noch unbekannt — sonst z. B. 12, 24"),
            films: self.more_field(cx, "Anzahl Filme", "", "0"),
            at_season: self.more_field(cx, "Gerade bei Staffel", &season.to_string(), "1"),
            at_episode: self.more_field(cx, "Gerade bei Folge", &episode.max(self.merk.add_next).to_string(), "1"),
            picked: None,
            manga: false,
            status: Status::Watching,
            problem: None,
        };
        if is_address {
            let title = derive_link_title(&typed);
            self.merk.add.update(cx, |f, cx| f.set_text(title, cx));
        }
        self.merk.add_more = Some(more);
        cx.notify();
    }

    /// Reads the long form; a mistake stays in it and says what is wrong.
    fn add_more_read(&self, cx: &Context<Self>) -> Result<MoreInput, String> {
        let m = self.merk.add_more.as_ref().ok_or("")?;
        let text = |e: &Entity<TextField>| e.read(cx).text().to_string();
        let title = self.merk.add.read(cx).text().trim().to_string();
        let url = text(&m.url).trim().to_string();
        if title.is_empty() && url.is_empty() {
            return Err("Bitte einen Namen oder eine Adresse eintragen.".into());
        }
        let seasons = read_number(&text(&m.seasons), 1, 60, "Anzahl Staffeln")?.unwrap_or(1);
        let counts = read_counts(&text(&m.counts), seasons)?;
        let films = read_number(&text(&m.films), 0, 200, "Anzahl Filme")?.unwrap_or(0);
        let at_season = read_number(&text(&m.at_season), 1, 60, "Gerade bei Staffel")?.unwrap_or(1);
        let at_episode = read_number(&text(&m.at_episode), 1, 2000, "Gerade bei Folge")?.unwrap_or(1);
        let cover_text = text(&m.cover).trim().to_string();
        let tags = text(&m.tags).split(',').map(|t| t.trim().trim_start_matches('#').to_string()).filter(|t| !t.is_empty()).collect();
        Ok(MoreInput {
            title,
            url,
            tags,
            cover: if cover_text.is_empty() { m.picked.clone() } else { Some(cover_text) },
            manga: m.manga,
            status: m.status,
            seasons,
            counts,
            films,
            at_season,
            at_episode,
        })
    }

    /// „Auf die Merkliste“ from the long form.
    pub fn add_more_save(&mut self, cx: &mut Context<Self>) {
        match self.add_more_read(cx) {
            Ok(input) => {
                let item = entry_from(&input, &mut Ids::system());
                self.merk.items.insert(0, item);
                self.merk.save();
                self.merk.add_more = None;
                self.merk.add_found = None;
                self.merk.add_next = 1;
                self.merk.adding = false;
                self.merk.add.update(cx, |f, cx| f.set_text("", cx));
            }
            Err(problem) => {
                if let Some(m) = self.merk.add_more.as_mut() {
                    m.problem = Some(problem);
                }
            }
        }
        cx.notify();
    }

    /// For tests: a field of the long form by its name.
    pub fn add_more_field(&self, name: &str) -> Option<Entity<TextField>> {
        let m = self.merk.add_more.as_ref()?;
        Some(match name {
            "url" => m.url.clone(),
            "tags" => m.tags.clone(),
            "cover" => m.cover.clone(),
            "seasons" => m.seasons.clone(),
            "counts" => m.counts.clone(),
            "films" => m.films.clone(),
            "at_season" => m.at_season.clone(),
            "at_episode" => m.at_episode.clone(),
            _ => return None,
        })
    }

    /// The long form under the field of the name.
    pub(crate) fn add_more_section(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let Some(m) = &self.merk.add_more else {
            return ui
                .button("mehr-angaben", "Mehr Angaben: Staffeln, Cover, Tags …")
                .small()
                .ghost()
                .on_click(move |_, app| me.update(app, |shell, cx| shell.add_more_open(cx)))
                .into_any_element();
        };
        let group = |label: &str, body: AnyElement| div().flex().flex_col().gap(px(8.)).child(ui.subheading(label.to_string())).child(body);
        let mut stands = div().flex().flex_wrap().gap(px(6.));
        for (status, label) in STANDS {
            let me = me.clone();
            stands = stands.child(ui.chip(format!("neu-stand-{label}"), label, m.status == status).accessible_name(format!("Start-Status {label}")).on_click(move |_, app| me.update(app, |shell, cx| {
                if let Some(m) = shell.merk.add_more.as_mut() {
                    m.status = status;
                }
                cx.notify();
            })));
        }
        let mut shapes = div().flex().gap(px(6.));
        for (manga, label) in [(false, "Poster (2:3)"), (true, "Manga (5:7)")] {
            let me = me.clone();
            shapes = shapes.child(ui.chip(format!("neu-format-{manga}"), label, m.manga == manga).on_click(move |_, app| me.update(app, |shell, cx| {
                if let Some(m) = shell.merk.add_more.as_mut() {
                    m.manga = manga;
                }
                cx.notify();
            })));
        }
        let mut cover_row = div().flex().flex_wrap().items_center().gap(px(8.)).child(div().w(px(300.)).child(m.cover.clone()));
        {
            let me = me.clone();
            cover_row = cover_row.child(ui.button("neu-cover-geraet", "Bild vom Gerät").small().accessible_name("Cover: Bild vom Gerät").on_click(move |_, app| me.update(app, |shell, cx| shell.pick_cover(CoverFor::Add, cx))));
        }
        if m.picked.is_some() {
            cover_row = cover_row.child(ui.hint("Bild gewählt"));
        }
        let field = |w: f32, f: &Entity<TextField>| div().w(px(w)).child(f.clone());
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(group("Adresse und Tags", div().flex().flex_wrap().gap(px(12.)).child(field(360., &m.url)).child(field(280., &m.tags)).into_any_element()))
            .child(group("Cover und Format", div().flex().flex_col().gap(px(8.)).child(cover_row).child(shapes).into_any_element()))
            .child(group("Start-Status", stands.into_any_element()))
            .child(group(
                "Staffeln und Folgen",
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(div().flex().flex_wrap().gap(px(12.)).child(field(160., &m.seasons)).child(field(280., &m.counts)).child(field(140., &m.films)))
                    .child(ui.hint("Folgen je Staffel mit Komma getrennt; eine Zahl gilt für alle, leer heisst noch unbekannt."))
                    .into_any_element(),
            ))
            .child(group(
                "Gerade bei",
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(div().flex().flex_wrap().gap(px(12.)).child(field(160., &m.at_season)).child(field(160., &m.at_episode)))
                    .child(ui.hint("Was davor liegt, gilt als gesehen."))
                    .into_any_element(),
            ));
        if let Some(p) = &m.problem {
            body = body.child(ui.notice(NoticeKind::Warning, p.clone()));
        }
        let (save, cancel) = (me.clone(), me.clone());
        body.child(
            div()
                .flex()
                .gap(px(8.))
                .child(ui.button("neu-auf-die-merkliste", "Auf die Merkliste").primary().on_click(move |_, app| save.update(app, |shell, cx| shell.add_more_save(cx))))
                .child(ui.button("neu-weniger", "Weniger Angaben").ghost().on_click(move |_, app| cancel.update(app, |shell, cx| {
                    shell.merk.add_more = None;
                    cx.notify();
                }))),
        )
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> MoreInput {
        MoreInput { title: "Frieren".into(), url: String::new(), tags: vec![], cover: None, manga: false, status: Status::Watching, seasons: 2, counts: Some(vec![28, 12]), films: 1, at_season: 2, at_episode: 4, }
    }

    #[test]
    fn what_lies_before_where_one_is_counts_as_seen() {
        let item = entry_from(&input(), &mut Ids::system());
        let seasons = item.seasons.unwrap();
        assert_eq!(seasons[0].watched.len(), 28);
        assert_eq!(seasons[1].watched, vec![1, 2, 3]);
        assert_eq!(seasons.iter().find(|s| s.number == 0).and_then(|s| s.episodes), Some(1));
        assert_eq!((item.season, item.episode), (2, Some(4)));
    }

    #[test]
    fn unknown_lengths_see_nothing_before_and_an_address_names_the_episode() {
        let mut i = input();
        i.counts = None;
        i.url = "aniworld.to/anime/stream/frieren".into();
        i.title = String::new();
        let item = entry_from(&i, &mut Ids::system());
        let seasons = item.seasons.unwrap();
        assert!(seasons[0].watched.is_empty() && seasons[0].episodes.is_none());
        assert_eq!(seasons[1].watched, vec![1, 2, 3]);
        assert_eq!(item.url, "https://aniworld.to/anime/stream/frieren/staffel-2/episode-4");
        assert!(!item.title.is_empty());
    }

    #[test]
    fn counts_are_one_per_season_or_one_for_all() {
        assert_eq!(read_counts("12", 3), Ok(Some(vec![12, 12, 12])));
        assert_eq!(read_counts("12, 24", 2), Ok(Some(vec![12, 24])));
        assert_eq!(read_counts("", 2), Ok(None));
        assert!(read_counts("12, 24", 3).is_err());
        assert!(read_counts("viel", 1).is_err());
    }
}
