//! Changing a series and its seasons, as the web app does it (`MerklistePanel.tsx`): the form behind
//! „Bearbeiten“ (title, address, rating, tags, note, lengths, opening, cover and its shape), the window of a
//! season (tick episodes, all seen, reset, „Hier weiterschauen“, how many, name, cover, parts, remove,
//! episodes of another length) and „Staffel hinzufügen“ / „Filme hinzufügen“. The changes go through
//! `MerkState::change`, so they count as made now and travel with the list.

use std::path::Path;

use gpui::{div, prelude::*, px, AnyElement, Context, Entity};
use serde_json::Value;
use sondra_merk::normalize::Context as Ids;
use sondra_merk::progress::{mark_range, season_name, season_progress, seasons_of, settle, split_season};
use sondra_merk::{Item, Season, Status};
use sondra_ui::{radius, size, NoticeKind, TextField, Ui};

use crate::merkliste::MerkState;
use crate::shell::Shell;

/// What the form of a series holds while it is open.
pub struct EditFields {
    pub series: String,
    pub title: Entity<TextField>,
    pub url: Entity<TextField>,
    pub tags: Entity<TextField>,
    pub notes: Entity<TextField>,
    pub minutes: Entity<TextField>,
    pub film_minutes: Entity<TextField>,
    pub opening: Entity<TextField>,
    pub cover: Entity<TextField>,
    pub rating: i64,
    pub manga: bool,
    /// A picture chosen on this computer, already made small (a data address).
    pub picked: Option<String>,
    pub problem: Option<String>,
}

/// What the window of one season holds while it is open.
pub struct SeasonFields {
    pub series: String,
    pub number: i64,
    pub name: Entity<TextField>,
    pub count: Entity<TextField>,
    pub cover: Entity<TextField>,
    pub exc_episode: Entity<TextField>,
    pub exc_minutes: Entity<TextField>,
    pub picked: Option<String>,
    pub problem: Option<String>,
}

/// A change to a series from the form, already read and checked.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Edit {
    pub title: String,
    pub url: String,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub episode_duration: Option<i64>,
    pub film_duration: Option<i64>,
    pub opening: Option<i64>,
    pub cover: Option<String>,
    pub rating: i64,
    pub manga: bool,
}

/// A whole number from a field: empty is `None`, anything else must be a number in the range.
pub fn read_number(text: &str, min: i64, max: i64, what: &str) -> Result<Option<i64>, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(None);
    }
    match t.parse::<i64>() {
        Ok(n) if (min..=max).contains(&n) => Ok(Some(n)),
        _ => Err(format!("{what}: bitte eine Zahl von {min} bis {max}.")),
    }
}

/// „1:30“ or „90“ → seconds.
pub fn read_opening(text: &str) -> Result<Option<i64>, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let seconds = match t.split_once(':') {
        Some((m, s)) => m.trim().parse::<i64>().ok().zip(s.trim().parse::<i64>().ok()).filter(|(_, s)| (0..60).contains(s)).map(|(m, s)| m * 60 + s),
        None => t.parse::<i64>().ok(),
    };
    match seconds {
        Some(s) if (sondra_merk::model::OPENING_MIN..=sondra_merk::model::OPENING_MAX).contains(&s) => Ok(Some(s)),
        _ => Err("Vorspann: als Minuten und Sekunden („1:30“), zwischen 0:10 und 10:00.".into()),
    }
}

/// „1:30“
pub fn opening_text(seconds: i64) -> String {
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

/// Tags as typed: separated by commas, trimmed, each once.
pub fn read_tags(text: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for t in text.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        if !tags.iter().any(|x| x.eq_ignore_ascii_case(t)) {
            tags.push(t.chars().take(40).collect());
        }
    }
    tags
}

/// The address of one episode on AniWorld or SerienStream: the series address with the season and episode
/// (films under `/filme/film-n`). Other addresses stay as they are.
pub fn episode_address(url: &str, season: i64, episode: i64) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let lower = trimmed.to_ascii_lowercase();
    let Some(at) = lower.find("/stream/") else { return trimmed.to_string() };
    let rest = &trimmed[at + "/stream/".len()..];
    let slug = rest.split('/').next().unwrap_or(rest);
    let base = &trimmed[..at + "/stream/".len() + slug.len()];
    if season == 0 {
        format!("{base}/filme/film-{episode}")
    } else {
        format!("{base}/staffel-{season}/episode-{episode}")
    }
}

/// A picture from this computer as a small cover: the longer side at most 720 px, as JPEG in a data address
/// (as the web app keeps covers from files; they stay on the device and do not travel with the list).
pub fn cover_from_file(path: &Path) -> Result<String, String> {
    use base64::Engine;
    let picture = image::open(path).map_err(|_| "Diese Datei liess sich nicht als Bild lesen.".to_string())?;
    let picture = if picture.width().max(picture.height()) > 720 { picture.resize(720, 720, image::imageops::FilterType::Lanczos3) } else { picture };
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 92);
    encoder.encode_image(&picture.to_rgb8()).map_err(|e| format!("Das Bild liess sich nicht verkleinern: {e}"))?;
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Where the address of a series points, in a word („AniWorld“), for the line under its title.
pub fn source_label(url: &str) -> Option<String> {
    let host = url::Url::parse(url.trim()).ok()?.host_str()?.trim_start_matches("www.").to_ascii_lowercase();
    Some(match host.as_str() {
        h if h.contains("aniworld") => "AniWorld".into(),
        h if h.contains("s.to") || h.contains("serienstream") => "SerienStream".into(),
        h if h.contains("youtube") || h == "youtu.be" => "YouTube".into(),
        h if h.contains("crunchyroll") => "Crunchyroll".into(),
        h if h.contains("netflix") => "Netflix".into(),
        _ => host,
    })
}

impl MerkState {
    /// Takes what the form says (`updateMerkItem` with the form's fields).
    pub fn apply_edit(&mut self, id: &str, edit: Edit) -> Result<(), String> {
        let title = edit.title.trim().to_string();
        if title.is_empty() {
            return Err("Der Name der Serie darf nicht leer sein.".into());
        }
        self.change(id, move |item| {
            item.title = title;
            item.url = edit.url.trim().to_string();
            item.tags = (!edit.tags.is_empty()).then_some(edit.tags);
            item.notes = edit.notes.filter(|n| !n.trim().is_empty());
            item.episode_duration = edit.episode_duration;
            item.film_duration = edit.film_duration;
            item.opening = edit.opening;
            if item.cover != edit.cover {
                item.cover_frame = None;
            }
            item.cover = edit.cover.filter(|c| !c.trim().is_empty());
            item.rating = (edit.rating > 0).then_some(edit.rating.clamp(1, 5));
            item.tile_format = edit.manga.then(|| "manga".to_string());
        });
        Ok(())
    }

    /// „Staffel hinzufügen“: the next number, length open. Returns its number.
    pub fn add_season(&mut self, id: &str) -> Option<i64> {
        let item = self.items.iter().find(|i| i.id == id)?;
        let mut seasons = seasons_of(item);
        let next = seasons.iter().map(|s| s.number).max().unwrap_or(0).max(0) + 1;
        seasons.push(Season::new(next, None, vec![]));
        seasons.sort_by_key(|s| if s.number == 0 { i64::MAX } else { s.number });
        self.change(id, move |item| item.seasons = Some(seasons));
        Some(next)
    }

    /// „Filme hinzufügen“: the films as season 0, when they are not there yet.
    pub fn add_films(&mut self, id: &str) -> bool {
        let Some(item) = self.items.iter().find(|i| i.id == id) else { return false };
        let mut seasons = seasons_of(item);
        if seasons.iter().any(|s| s.number == 0) {
            return false;
        }
        seasons.push(Season::new(0, None, vec![]));
        self.change(id, move |item| item.seasons = Some(seasons));
        true
    }

    /// „Alle gesehen“ (`seen`) or „Zurücksetzen“ for one season; the place moves as with a tick.
    pub fn season_all(&mut self, id: &str, number: i64, seen: bool) {
        let Some(item) = self.items.iter().find(|i| i.id == id) else { return };
        let Some(season) = seasons_of(item).into_iter().find(|s| s.number == number) else { return };
        let last = season.episodes.unwrap_or_else(|| season.watched.iter().copied().max().unwrap_or(0));
        if last < 1 {
            return;
        }
        let seasons = mark_range(item, number, 1, last, seen);
        let settled = settle(item, &seasons, number);
        self.change(id, move |item| {
            item.seasons = Some(settled.seasons);
            item.season = settled.season;
            item.episode = settled.episode;
            item.status = settled.status;
        });
    }

    /// „Hier weiterschauen“: the place goes to the first episode of this season not seen yet.
    pub fn continue_in(&mut self, id: &str, number: i64) {
        let Some(item) = self.items.iter().find(|i| i.id == id) else { return };
        let Some(season) = seasons_of(item).into_iter().find(|s| s.number == number) else { return };
        let next = season_progress(&season).next.max(1);
        self.change(id, move |item| {
            item.season = number;
            item.episode = Some(next);
            if matches!(item.status, Status::Done | Status::Later | Status::Paused | Status::Dropped) {
                item.status = Status::Watching;
            }
        });
    }

    /// Name and cover of a season (an empty name is the usual „Staffel n“; no cover is the series').
    pub fn set_season_details(&mut self, id: &str, number: i64, title: Option<String>, cover: Option<String>) {
        let Some(item) = self.items.iter().find(|i| i.id == id) else { return };
        let mut seasons = seasons_of(item);
        let Some(season) = seasons.iter_mut().find(|s| s.number == number) else { return };
        season.title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        if season.cover != cover {
            season.cover_frame = None;
        }
        season.cover = cover.filter(|c| !c.trim().is_empty());
        self.change(id, move |item| item.seasons = Some(seasons));
    }

    /// „In Teile teilen“ (`splitSeason`).
    pub fn split(&mut self, id: &str, number: i64) {
        let Some(item) = self.items.iter().find(|i| i.id == id) else { return };
        let mut seasons = seasons_of(item);
        let Some(season) = seasons.iter_mut().find(|s| s.number == number) else { return };
        *season = split_season(season);
        self.change(id, move |item| item.seasons = Some(seasons));
    }

    /// Takes a season away with what was seen in it; the place moves to what is left.
    pub fn remove_season(&mut self, id: &str, number: i64) {
        let Some(item) = self.items.iter().find(|i| i.id == id) else { return };
        let seasons: Vec<Season> = seasons_of(item).into_iter().filter(|s| s.number != number).collect();
        let from = if item.season == number { seasons.iter().map(|s| s.number).find(|n| *n > 0).unwrap_or(0) } else { item.season };
        let settled = settle(item, &seasons, from);
        let prefix = format!("{number}:");
        self.change(id, move |item| {
            item.seasons = Some(settled.seasons);
            item.season = settled.season;
            item.episode = settled.episode;
            item.status = settled.status;
            if let Some(map) = item.durations.as_mut() {
                map.retain(|k, _| !k.starts_with(&prefix));
                if map.is_empty() {
                    item.durations = None;
                }
            }
        });
    }

    /// One episode of another length („Folge 1: 47 Min.“); `None` takes the exception away.
    pub fn set_exception(&mut self, id: &str, season: i64, episode: i64, minutes: Option<i64>) {
        let key = format!("{season}:{episode}");
        self.change(id, move |item| {
            let map = item.durations.get_or_insert_with(Default::default);
            match minutes {
                Some(m) => {
                    map.insert(key, Value::from(m));
                }
                None => {
                    map.remove(&key);
                }
            }
            if map.is_empty() {
                item.durations = None;
            }
        });
    }

    /// The exceptions of one season, by episode.
    pub fn exceptions(item: &Item, season: i64) -> Vec<(i64, i64)> {
        let prefix = format!("{season}:");
        let mut list: Vec<(i64, i64)> = item
            .durations
            .iter()
            .flatten()
            .filter_map(|(k, v)| Some((k.strip_prefix(&prefix)?.parse::<i64>().ok()?, v.as_i64().or_else(|| v.as_f64().map(|f| f.round() as i64))?)))
            .collect();
        list.sort();
        list
    }

    /// „Als Ziel merken“: the point to get to, with how many episodes there were to it when it was set.
    pub fn set_goal(&mut self, id: &str, target: Option<sondra_merk::plan::PlanPoint>, by: Option<String>) {
        let Some(item) = self.items.iter().find(|i| i.id == id) else { return };
        let goal = target.map(|t| {
            let plan = sondra_merk::plan::watch_plan(item, t, sondra_merk::plan::PlanOptions { from_stand: true, speed: 1.0, skip_opening: 0.0 });
            sondra_merk::model::Goal { season: t.season, episode: t.episode, by: by.clone(), set_at: Ids::system().now, count: Some(plan.episodes) }
        });
        self.change(id, move |item| item.goal = goal);
    }
}

impl Shell {
    fn field(&self, cx: &mut Context<Self>, label: &str, value: String, hint: &str) -> Entity<TextField> {
        let colors = self.mode.colors();
        let label = label.to_string();
        let hint = hint.to_string();
        cx.new(move |cx| {
            let mut f = TextField::new(cx, colors, label).placeholder(hint);
            f.set_text(value, cx);
            f
        })
    }

    /// Opens the form of a series with what it holds now.
    pub fn edit_open(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(item) = self.merk.items.iter().find(|i| i.id == id).cloned() else { return };
        let fields = EditFields {
            series: item.id.clone(),
            title: self.field(cx, "Name der Serie", item.title.clone(), "Wie die Serie heisst"),
            url: self.field(cx, "Adresse", item.url.clone(), "Web- oder Stream-Adresse (zum Laden)"),
            tags: self.field(cx, "Tags, durch Komma getrennt", item.tags.clone().unwrap_or_default().join(", "), "Anime, Favorit, Manga …"),
            notes: self.field(cx, "Notiz", item.notes.clone().unwrap_or_default(), "Wo es spannend wurde, mit wem Sie schauen …"),
            minutes: self.field(cx, "Minuten pro Folge", item.episode_duration.map(|m| m.to_string()).unwrap_or_default(), "24"),
            film_minutes: self.field(cx, "Minuten pro Film", item.film_duration.map(|m| m.to_string()).unwrap_or_default(), "100"),
            opening: self.field(cx, "Länge des Vorspanns", item.opening.map(opening_text).unwrap_or_default(), "1:30"),
            cover: self.field(cx, "Adresse des Covers", item.cover.clone().filter(|c| !c.starts_with("data:")).unwrap_or_default(), "https://…"),
            rating: item.rating.unwrap_or(0),
            manga: item.tile_format.as_deref() == Some("manga"),
            picked: item.cover.clone().filter(|c| c.starts_with("data:")),
            problem: None,
        };
        self.merk.edit = Some(fields);
        cx.notify();
    }

    /// Reads the form; a mistake stays in the form and says what is wrong.
    pub fn edit_save(&mut self, cx: &mut Context<Self>) {
        let Some(f) = &self.merk.edit else { return };
        let text = |e: &Entity<TextField>| e.read(cx).text().to_string();
        let result = (|| -> Result<Edit, String> {
            let cover_text = text(&f.cover);
            Ok(Edit {
                title: text(&f.title),
                url: text(&f.url),
                tags: read_tags(&text(&f.tags)),
                notes: Some(text(&f.notes)),
                episode_duration: read_number(&text(&f.minutes), 1, 600, "Minuten pro Folge")?,
                film_duration: read_number(&text(&f.film_minutes), 1, 600, "Minuten pro Film")?,
                opening: read_opening(&text(&f.opening))?,
                cover: if cover_text.trim().is_empty() { f.picked.clone() } else { Some(cover_text.trim().to_string()) },
                rating: f.rating,
                manga: f.manga,
            })
        })();
        let id = f.series.clone();
        match result.and_then(|edit| self.merk.apply_edit(&id, edit)) {
            Ok(()) => self.merk.edit = None,
            Err(problem) => {
                if let Some(f) = &mut self.merk.edit {
                    f.problem = Some(problem);
                }
            }
        }
        cx.notify();
    }

    fn pick_cover(&mut self, for_season: bool, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    let made = cover_from_file(&path);
                    this.update(cx, |shell, cx| {
                        let (picked, problem) = match made {
                            Ok(data) => (Some(data), None),
                            Err(e) => (None, Some(e)),
                        };
                        if for_season {
                            if let Some(s) = &mut shell.merk.season_window {
                                if picked.is_some() {
                                    s.picked = picked;
                                    s.cover.update(cx, |f, cx| f.set_text(String::new(), cx));
                                }
                                s.problem = problem;
                            }
                        } else if let Some(f) = &mut shell.merk.edit {
                            if picked.is_some() {
                                f.picked = picked;
                                f.cover.update(cx, |f, cx| f.set_text(String::new(), cx));
                            }
                            f.problem = problem;
                        }
                        cx.notify();
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    /// Opens the window of one season.
    pub fn season_open(&mut self, id: &str, number: i64, cx: &mut Context<Self>) {
        let Some(item) = self.merk.items.iter().find(|i| i.id == id).cloned() else { return };
        let Some(season) = seasons_of(&item).into_iter().find(|s| s.number == number) else { return };
        let fields = SeasonFields {
            series: item.id.clone(),
            number,
            name: self.field(cx, "Name der Staffel", season.title.clone().unwrap_or_default(), &season_name(&Season { title: None, ..season.clone() })),
            count: self.field(cx, if number == 0 { "Wie viele Filme" } else { "Wie viele Folgen" }, season.episodes.map(|n| n.to_string()).unwrap_or_default(), "Noch unbekannt"),
            cover: self.field(cx, "Adresse des Covers der Staffel", season.cover.clone().filter(|c| !c.starts_with("data:")).unwrap_or_default(), "Sonst das der Serie"),
            exc_episode: self.field(cx, "Folge mit anderer Länge", String::new(), "Nr."),
            exc_minutes: self.field(cx, "Ihre Länge in Minuten", String::new(), "Min."),
            picked: season.cover.clone().filter(|c| c.starts_with("data:")),
            problem: None,
        };
        self.merk.season_window = Some(fields);
        cx.notify();
    }

    /// Takes the season's count, name and cover from its window.
    pub fn season_save(&mut self, cx: &mut Context<Self>) {
        let Some(s) = &self.merk.season_window else { return };
        let text = |e: &Entity<TextField>| e.read(cx).text().to_string();
        let (id, number) = (s.series.clone(), s.number);
        let count = match read_number(&text(&s.count), 1, 5000, if number == 0 { "Wie viele Filme" } else { "Wie viele Folgen" }) {
            Ok(c) => c,
            Err(problem) => {
                if let Some(s) = &mut self.merk.season_window {
                    s.problem = Some(problem);
                }
                cx.notify();
                return;
            }
        };
        let cover_text = text(&s.cover);
        let cover = if cover_text.trim().is_empty() { s.picked.clone() } else { Some(cover_text.trim().to_string()) };
        let name = text(&s.name);
        let before = self.merk.items.iter().find(|i| i.id == id).and_then(|i| seasons_of(i).into_iter().find(|x| x.number == number)).and_then(|x| x.episodes);
        if count != before {
            self.merk.set_episodes(&id, number, count);
        }
        self.merk.set_season_details(&id, number, Some(name), cover);
        if let Some(s) = &mut self.merk.season_window {
            s.problem = None;
        }
        cx.notify();
    }

    fn season_add_exception(&mut self, cx: &mut Context<Self>) {
        let Some(s) = &self.merk.season_window else { return };
        let text = |e: &Entity<TextField>| e.read(cx).text().to_string();
        let episode = read_number(&text(&s.exc_episode), 1, 5000, "Folge");
        let minutes = read_number(&text(&s.exc_minutes), 1, 600, "Dauer");
        match (episode, minutes) {
            (Ok(Some(e)), Ok(Some(m))) => {
                let (id, number) = (s.series.clone(), s.number);
                let (a, b) = (s.exc_episode.clone(), s.exc_minutes.clone());
                self.merk.set_exception(&id, number, e, Some(m));
                a.update(cx, |f, cx| f.set_text(String::new(), cx));
                b.update(cx, |f, cx| f.set_text(String::new(), cx));
                if let Some(s) = &mut self.merk.season_window {
                    s.problem = None;
                }
            }
            (Err(p), _) | (_, Err(p)) => {
                if let Some(s) = &mut self.merk.season_window {
                    s.problem = Some(p);
                }
            }
            _ => {
                if let Some(s) = &mut self.merk.season_window {
                    s.problem = Some("Bitte Folge und Dauer eintragen.".into());
                }
            }
        }
        cx.notify();
    }

    /// The stars of a rating, each a button (a second click on the chosen one takes the rating away).
    fn stars(&self, ui: &Ui, rating: i64, cx: &mut Context<Self>) -> AnyElement {
        let mut row = div().flex().items_center().gap(px(4.));
        for n in 1..=5i64 {
            let me = cx.entity();
            row = row.child(
                ui.chip(format!("stern-{n}"), if n <= rating { "★" } else { "☆" }, n <= rating)
                    .accessible_name(format!("{n} von 5 Sternen"))
                    .on_click(move |_, app| me.update(app, |shell, cx| {
                        if let Some(f) = &mut shell.merk.edit {
                            f.rating = if f.rating == n { 0 } else { n };
                        }
                        cx.notify();
                    })),
            );
        }
        row.into_any_element()
    }

    pub(crate) fn edit_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let f = self.merk.edit.as_ref()?;
        let me = cx.entity();
        let pair = |a: AnyElement, b: AnyElement| div().flex().flex_wrap().gap(px(12.)).child(div().flex_1().min_w(px(200.)).child(a)).child(div().flex_1().min_w(px(200.)).child(b)).into_any_element();
        let group = |title: &str, body: AnyElement| div().flex().flex_col().gap(px(8.)).child(ui.title(title.to_string())).child(body).into_any_element();

        let mut cover_row = div().flex().flex_wrap().items_center().gap(px(8.)).child(div().w(px(280.)).child(f.cover.clone()));
        {
            let me = me.clone();
            cover_row = cover_row.child(ui.button("cover-vom-geraet", "Bild vom Gerät").small().on_click(move |_, app| me.update(app, |shell, cx| shell.pick_cover(false, cx))));
        }
        if f.picked.is_some() {
            let me = me.clone();
            cover_row = cover_row.child(ui.hint("Ein Bild von diesem Gerät ist gewählt.")).child(ui.button("cover-entfernen", "Entfernen").small().ghost().on_click(move |_, app| me.update(app, |shell, cx| {
                if let Some(f) = &mut shell.merk.edit {
                    f.picked = None;
                }
                cx.notify();
            })));
        }
        let shapes = {
            let (a, b) = (me.clone(), me.clone());
            div()
                .flex()
                .gap(px(6.))
                .child(ui.chip("format-poster", "Filmposter (2:3)", !f.manga).on_click(move |_, app| a.update(app, |shell, cx| {
                    if let Some(f) = &mut shell.merk.edit {
                        f.manga = false;
                    }
                    cx.notify();
                })))
                .child(ui.chip("format-manga", "Manga (5:7)", f.manga).on_click(move |_, app| b.update(app, |shell, cx| {
                    if let Some(f) = &mut shell.merk.edit {
                        f.manga = true;
                    }
                    cx.notify();
                })))
        };

        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(18.))
            .child(group("Serie", div().flex().flex_col().gap(px(10.)).child(f.title.clone()).child(f.url.clone()).into_any_element()))
            .child(group("Bewertung", self.stars(&ui, f.rating, cx)))
            .child(group("Tags und Notiz", div().flex().flex_col().gap(px(10.)).child(f.tags.clone()).child(f.notes.clone()).into_any_element()))
            .child(group(
                "Längen",
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .child(pair(f.minutes.clone().into_any_element(), f.film_minutes.clone().into_any_element()))
                    .child(div().w(px(200.)).child(f.opening.clone()))
                    .child(ui.hint("Leer heisst: die übliche Länge (24 Min. je Folge, 1:30 Vorspann). Folgen anderer Länge stehen im Fenster ihrer Staffel."))
                    .into_any_element(),
            ))
            .child(group("Cover und Format", div().flex().flex_col().gap(px(10.)).child(cover_row).child(shapes).into_any_element()));
        if let Some(p) = &f.problem {
            body = body.child(ui.notice(NoticeKind::Warning, p.clone()));
        }
        let (save, cancel, away) = (me.clone(), me.clone(), me.clone());
        Some(
            ui.dialog("serie-bearbeiten", "Serie bearbeiten")
                .width(620.)
                .child(body)
                .action(ui.button("bearbeiten-abbrechen", "Abbrechen").ghost().on_click(move |_, app| cancel.update(app, |shell, cx| {
                    shell.merk.edit = None;
                    cx.notify();
                })))
                .action(ui.button("bearbeiten-speichern", "Speichern").primary().on_click(move |_, app| save.update(app, |shell, cx| shell.edit_save(cx))))
                .on_close(move |_, app| away.update(app, |shell, cx| {
                    shell.merk.edit = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    pub(crate) fn season_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let s = self.merk.season_window.as_ref()?;
        let item = self.merk.items.iter().find(|i| i.id == s.series)?;
        let season = seasons_of(item).into_iter().find(|x| x.number == s.number)?;
        let c = ui.c;
        let me = cx.entity();
        let (id, number) = (item.id.clone(), s.number);
        let unit = if number == 0 { "Film" } else { "Folge" };
        let progress = season_progress(&season);
        let name = season_name(&season);

        // The head: cover, what is seen, where it goes on.
        let cover = self.cover_element(cx, &season.cover.clone().or(item.cover.clone()), season.cover_frame.or(item.cover_frame), 84.0, 126.0).unwrap_or_else(|| div().w(px(84.)).h(px(126.)).rounded(px(radius::NAV)).bg(c.panel_mid).into_any_element());
        let seen_line = if progress.complete {
            "Alles gesehen.".to_string()
        } else {
            format!("Weiter mit {unit} {}.", progress.next.max(1))
        };
        let mut head_actions = div().flex().flex_wrap().gap(px(8.));
        if !progress.complete && !(item.season == number && item.episode == Some(progress.next)) {
            let (me, id) = (me.clone(), id.clone());
            head_actions = head_actions.child(ui.button("hier-weiterschauen", "Hier weiterschauen").small().on_click(move |_, app| {
                let id = id.clone();
                Shell::merk_do(&me, app, move |m| m.continue_in(&id, number))
            }));
        }
        let head = div()
            .flex()
            .gap(px(16.))
            .child(div().w(px(84.)).h(px(126.)).flex_none().rounded(px(radius::NAV)).overflow_hidden().child(cover))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(ui.hint(item.title.clone()))
                    .child(ui.value(format!("{} {} gesehen", progress.watched, if number == 0 { if progress.watched == 1 { "Film" } else { "Filme" } } else if progress.watched == 1 { "Folge" } else { "Folgen" })))
                    .child(ui.prose(seen_line))
                    .child(head_actions),
            );

        // The episodes to tick.
        let mut grid = div().flex().flex_wrap().gap(px(6.));
        let here = (item.season == number).then_some(item.episode).flatten();
        for episode in 1..=season.episodes.unwrap_or_else(|| season.watched.iter().copied().max().unwrap_or(0) + 1) {
            let seen = season.watched.contains(&episode);
            let (me, id) = (me.clone(), id.clone());
            grid = grid.child(
                ui.chip(format!("fenster-folge-{episode}"), episode.to_string(), seen)
                    .accessible_name(format!("{unit} {episode}{}", if here == Some(episode) { ", hier sind Sie" } else { "" }))
                    .on_click(move |window, app| {
                        let id = id.clone();
                        let up_to = window.modifiers().shift;
                        Shell::merk_do(&me, app, move |m| m.tick(&id, number, episode, up_to))
                    }),
            );
        }
        let all_row = {
            let (a, b) = (me.clone(), me.clone());
            let (ida, idb) = (id.clone(), id.clone());
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .child(ui.hint("Antippen zum Abhaken, mit Umschalt alles bis dort"))
                .child(ui.button("staffel-alle-gesehen", "Alle gesehen").small().disabled(season.episodes.is_none()).on_click(move |_, app| {
                    let id = ida.clone();
                    Shell::merk_do(&a, app, move |m| m.season_all(&id, number, true))
                }))
                .child(ui.button("staffel-zuruecksetzen", "Zurücksetzen").small().ghost().disabled(season.watched.is_empty()).on_click(move |_, app| {
                    let id = idb.clone();
                    Shell::merk_do(&b, app, move |m| m.season_all(&id, number, false))
                }))
        };

        // Count, name, cover.
        let mut cover_row = div().flex().flex_wrap().items_center().gap(px(8.)).child(div().w(px(280.)).child(s.cover.clone()));
        {
            let me = me.clone();
            cover_row = cover_row.child(ui.button("staffel-cover-geraet", "Bild vom Gerät").small().on_click(move |_, app| me.update(app, |shell, cx| shell.pick_cover(true, cx))));
        }
        if s.picked.is_some() {
            let me = me.clone();
            cover_row = cover_row.child(ui.button("staffel-cover-entfernen", "Entfernen").small().ghost().on_click(move |_, app| me.update(app, |shell, cx| {
                if let Some(s) = &mut shell.merk.season_window {
                    s.picked = None;
                }
                cx.notify();
            })));
        }
        let details = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(ui.title("Staffel bearbeiten: Anzahl, Name, Cover, Teile"))
            .child(div().flex().flex_wrap().gap(px(12.)).child(div().w(px(180.)).child(s.count.clone())).child(div().flex_1().min_w(px(200.)).child(s.name.clone())))
            .child(cover_row)
            .child({
                let (save, split, remove) = (me.clone(), me.clone(), me.clone());
                let (ids, idr) = (id.clone(), id.clone());
                let can_split = season.parts.as_ref().is_none_or(|p| p.len() < 2) && number != 0;
                let mut row = div().flex().flex_wrap().gap(px(8.)).child(ui.button("staffel-uebernehmen", "Übernehmen").small().on_click(move |_, app| save.update(app, |shell, cx| shell.season_save(cx))));
                if can_split {
                    row = row.child(ui.button("staffel-teilen", "In Teile teilen").small().on_click(move |_, app| {
                        let id = ids.clone();
                        Shell::merk_do(&split, app, move |m| m.split(&id, number))
                    }));
                }
                row.child(ui.button("staffel-entfernen", format!("{name} entfernen")).small().ghost().on_click(move |_, app| {
                    let id = idr.clone();
                    remove.update(app, |shell, cx| {
                        shell.merk.remove_season(&id, number);
                        shell.merk.season_window = None;
                        cx.notify();
                    })
                }))
            });

        // Episodes of another length.
        let standard = if number == 0 { item.film_duration.unwrap_or(100) } else { item.episode_duration.unwrap_or(24) };
        let mut lengths = div().flex().flex_col().gap(px(8.)).child(ui.title(format!("Episodendauer ({name})"))).child(ui.hint(format!("Standard: {standard} Min.")));
        for (episode, minutes) in MerkState::exceptions(item, number) {
            let (me, id) = (me.clone(), id.clone());
            lengths = lengths.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .child(ui.value(format!("{unit} {episode}: {minutes} Min.")))
                    .child(ui.button(format!("ausnahme-weg-{episode}"), "×").small().ghost().accessible_name(format!("Ausnahme für {unit} {episode} entfernen")).on_click(move |_, app| {
                        let id = id.clone();
                        Shell::merk_do(&me, app, move |m| m.set_exception(&id, number, episode, None))
                    })),
            );
        }
        {
            let me = me.clone();
            lengths = lengths.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_end()
                    .gap(px(8.))
                    .child(div().w(px(120.)).child(s.exc_episode.clone()))
                    .child(div().w(px(120.)).child(s.exc_minutes.clone()))
                    .child(ui.button("ausnahme-dazu", "+ Ausnahme").small().on_click(move |_, app| me.update(app, |shell, cx| shell.season_add_exception(cx)))),
            );
        }

        let mut body = div().flex().flex_col().gap(px(18.)).child(head).child(grid).child(all_row).child(ui.rule()).child(details).child(ui.rule()).child(lengths);
        if let Some(p) = &s.problem {
            body = body.child(ui.notice(NoticeKind::Warning, p.clone()));
        }
        let (close, away) = (me.clone(), me.clone());
        let _ = size::SMALL;
        Some(
            ui.dialog("staffel-fenster", format!("{} · {name}", item.title))
                .width(640.)
                .child(body)
                .action(ui.button("staffel-schliessen", "Schliessen").primary().on_click(move |_, app| close.update(app, |shell, cx| {
                    shell.merk.season_window = None;
                    cx.notify();
                })))
                .on_close(move |_, app| away.update(app, |shell, cx| {
                    shell.merk.season_window = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}

impl Shell {
    /// The head of a series page: the cover, the name, where it stands, where it comes from, the rating,
    /// tags and the note.
    pub(crate) fn merk_series_head(&self, ui: Ui, item: &Item, facts: String, cx: &mut Context<Self>) -> AnyElement {
        let c = ui.c;
        let (w, h) = if item.tile_format.as_deref() == Some("manga") { (120.0, 168.0) } else { (120.0, 180.0) };
        let cover = self.cover_element(cx, &item.cover, item.cover_frame, w, h).unwrap_or_else(|| {
            div()
                .w(px(w))
                .h(px(h))
                .bg(c.panel_mid)
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(size::SUBHEADING))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(c.muted)
                .child(crate::merkliste::initials(&item.title))
                .into_any_element()
        });
        let mut origin: Vec<String> = Vec::new();
        if let Some(source) = source_label(&item.url) {
            origin.push(source);
        }
        if let Some(at) = item.last_opened_at.and_then(chrono::DateTime::from_timestamp_millis) {
            let day = at.with_timezone(&chrono::Local).date_naive();
            let today = chrono::Local::now().date_naive();
            origin.push(if day == today { "zuletzt heute".into() } else { format!("zuletzt {}", day.format("%d.%m.%y")) });
        }
        origin.push(sondra_merk::view::status_label(item.status).to_string());
        let mut words = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .flex_1()
            .min_w(px(240.))
            .child(ui.heading(item.title.clone()))
            .child(ui.prose(facts))
            .child(ui.hint(origin.join(" · ")));
        if let Some(r) = item.rating.filter(|r| *r > 0) {
            words = words.child(div().text_color(c.ink).child(format!("{}{}", "★".repeat(r as usize), "☆".repeat(5 - r.clamp(0, 5) as usize))));
        }
        if let Some(tags) = item.tags.as_ref().filter(|t| !t.is_empty()) {
            let mut row = div().flex().flex_wrap().gap(px(6.));
            for t in tags {
                row = row.child(div().px(px(10.)).py(px(3.)).rounded(px(radius::PILL)).bg(c.panel_soft).text_size(px(size::SMALL)).text_color(c.prose).child(t.clone()));
            }
            words = words.child(row);
        }
        if let Some(note) = item.notes.as_ref().filter(|n| !n.trim().is_empty()) {
            words = words.child(div().max_w(px(560.)).child(ui.hint(note.clone())));
        }
        div()
            .flex()
            .flex_wrap()
            .gap(px(20.))
            .child(div().w(px(w)).h(px(h)).flex_none().rounded(px(radius::CARD)).overflow_hidden().child(cover))
            .child(words)
            .into_any_element()
    }

    /// „Mehr“ on a series: load the next episode, look online for what is new, recommend, remove.
    pub(crate) fn series_more(&self, ui: Ui, item: &Item, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let button = {
            let me = me.clone();
            ui.button("serie-mehr", "Mehr").on_click(move |_, app| Shell::merk_do(&me, app, |m| m.series_more = !m.series_more))
        };
        let mut holder = div().relative().child(button);
        if !self.merk.series_more {
            return holder.into_any_element();
        }
        let mut items: Vec<AnyElement> = Vec::new();
        let at = item.episode.unwrap_or(1).max(1);
        let unit = if item.season == 0 { "Film" } else { "Folge" };
        if !item.url.trim().is_empty() && !sondra_merk::progress::caught_up(&seasons_of(item)) {
            let (me, url, season) = (me.clone(), item.url.clone(), item.season);
            items.push(ui.menu_item("folge-laden", format!("{unit} {at} laden"), false).on_click(move |_, app| {
                let address = episode_address(&url, season, at);
                me.update(app, |shell, cx| {
                    shell.merk.series_more = false;
                    shell.go(crate::nav::Panel::Downloader, cx);
                    shell.download_set_input(&address, cx);
                    shell.find_address(cx);
                })
            }).into_any_element());
        }
        if sondra_extract::aniworld::is_aniworld_url(&item.url) {
            let (me, id) = (me.clone(), item.id.clone());
            let busy = self.merk.checking.is_some();
            items.push(ui.menu_item("online-suchen", if busy { "Sucht online …" } else { "Online nach Neuem suchen" }, false).on_click(move |_, app| {
                let id = id.clone();
                me.update(app, |shell, cx| {
                    shell.merk.series_more = false;
                    shell.check_one_online(&id, cx);
                })
            }).into_any_element());
        }
        {
            let (me, id) = (me.clone(), item.id.clone());
            items.push(ui.menu_item("serie-empfehlen-mehr", "Empfehlen", false).on_click(move |_, app| {
                let id = id.clone();
                Shell::merk_do(&me, app, move |m| {
                    m.series_more = false;
                    m.share.open = true;
                    m.share.said = None;
                    m.share.only = Some(id);
                    m.share.part = 0;
                })
            }).into_any_element());
        }
        {
            let (me, id) = (me.clone(), item.id.clone());
            items.push(ui.menu_item("serie-entfernen", "Von der Merkliste entfernen", false).on_click(move |_, app| {
                let id = id.clone();
                Shell::merk_do(&me, app, move |m| {
                    m.series_more = false;
                    m.remove(&id);
                })
            }).into_any_element());
        }
        let pop = ui.popover("menue-serie-mehr", "Mehr", items);
        let away = me.clone();
        holder = holder.child(
            gpui::deferred(div().absolute().top(px(44.)).left_0().on_mouse_down_out(move |_, _, app| Shell::merk_do(&away, app, |m| m.series_more = false)).child(pop)).with_priority(10),
        );
        holder.into_any_element()
    }

    /// „Staffeln n“ with „Staffel hinzufügen“ and „Filme hinzufügen“, and what the last look online said.
    pub(crate) fn seasons_heading(&self, ui: Ui, item: &Item, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let seasons = seasons_of(item);
        let count = seasons.iter().filter(|s| s.number > 0).count();
        let mut row = div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.subheading("Staffeln")).child(ui.value(count.to_string())).child(div().flex_1());
        {
            let (me, id) = (me.clone(), item.id.clone());
            row = row.child(ui.button("staffel-hinzufuegen", "Staffel hinzufügen").small().on_click(move |_, app| {
                let id = id.clone();
                Shell::merk_do(&me, app, move |m| {
                    m.add_season(&id);
                })
            }));
        }
        if !seasons.iter().any(|s| s.number == 0) {
            let (me, id) = (me.clone(), item.id.clone());
            row = row.child(ui.button("filme-hinzufuegen", "Filme hinzufügen").small().on_click(move |_, app| {
                let id = id.clone();
                Shell::merk_do(&me, app, move |m| {
                    m.add_films(&id);
                })
            }));
        }
        let mut block = div().flex().flex_col().gap(px(8.)).child(row);
        if let Some((id, said)) = &self.merk.checked_said {
            if id == &item.id {
                block = block.child(ui.hint(said.clone()));
            }
        }
        block.into_any_element()
    }

    /// „Online nach Neuem suchen“ for one series, whether or not the rounds are on; the page then offers what is
    /// new, or says that nothing is.
    pub fn check_one_online(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.merk.checking.is_some() {
            return;
        }
        let Some(item) = self.merk.items.iter().find(|i| i.id == id) else { return };
        let (id, url) = (item.id.clone(), item.url.clone());
        self.merk.checking = Some(id.clone());
        self.merk.checked_said = None;
        let factory = self.download.fetch.clone();
        Self::in_background(
            cx,
            move || {
                let now = Ids::system().now;
                let online = sondra_extract::aniworld::check_online_updates(factory().as_ref(), &url, false, now)
                    .map(|info| sondra_merk::model::Online { max_season: i64::from(info.max_season), max_episode: i64::from(info.max_episode), checked_at: now, has_new: None });
                (id, online)
            },
            |shell, (id, online), cx| {
                shell.merk.checking = None;
                let said = match &online {
                    None => "AniWorld war nicht zu erreichen. Später noch einmal.".to_string(),
                    Some(o) => {
                        let news = shell.merk.items.iter().find(|i| i.id == id).and_then(|i| sondra_merk::progress::online_news(i, Some(o)));
                        match news {
                            Some(n) => format!("Neu auf AniWorld: {}", crate::merkliste::news_label(&n)),
                            None => format!("Nichts Neues: online bis Staffel {}, Folge {}.", o.max_season, o.max_episode),
                        }
                    }
                };
                shell.apply_looks(vec![(id.clone(), online)]);
                shell.merk.checked_said = Some((id, said));
                cx.notify();
            },
        );
    }
}

impl Shell {
    /// For tests: a field of the open form („title“, „url“, „tags“, „notes“, „minutes“, „film_minutes“,
    /// „opening“, „cover“).
    pub fn edit_field(&self, name: &str) -> Option<Entity<TextField>> {
        let f = self.merk.edit.as_ref()?;
        Some(match name {
            "title" => f.title.clone(),
            "url" => f.url.clone(),
            "tags" => f.tags.clone(),
            "notes" => f.notes.clone(),
            "minutes" => f.minutes.clone(),
            "film_minutes" => f.film_minutes.clone(),
            "opening" => f.opening.clone(),
            "cover" => f.cover.clone(),
            _ => return None,
        })
    }

    /// For tests: a field of the open season window („name“, „count“, „cover“, „exc_episode“, „exc_minutes“).
    pub fn season_field(&self, name: &str) -> Option<Entity<TextField>> {
        let s = self.merk.season_window.as_ref()?;
        Some(match name {
            "name" => s.name.clone(),
            "count" => s.count.clone(),
            "cover" => s.cover.clone(),
            "exc_episode" => s.exc_episode.clone(),
            "exc_minutes" => s.exc_minutes.clone(),
            _ => return None,
        })
    }
}

impl Shell {
    /// Under the stands: the folder the list plays from, „Nur offene Folgen“, the tags, and where the list lies.
    pub(crate) fn merk_filters(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let state = &self.merk;
        let mut row = div().flex().flex_wrap().items_center().gap(px(6.));
        // The folder the episodes lie in, as on the website: a pill that names it, or one that asks for it.
        let in_folder = self.folder.scan.as_ref().map(|scan| {
            let series = sondra_merk::folder::folder_series(&scan.files, &state.items).len();
            (if scan.drive { "Google Drive".to_string() } else { format!("„{}“", scan.name) }, series)
        });
        {
            let me = me.clone();
            let label = match &in_folder {
                Some((name, n)) if *n > 0 => format!("{name} · {n} {} darin", if *n == 1 { "Serie" } else { "Serien" }),
                Some((name, _)) => format!("{name} · keine Serie darin"),
                None => "Ordner mit Folgen wählen".to_string(),
            };
            row = row.child(ui.chip("merk-ordner", label, in_folder.as_ref().is_some_and(|(_, n)| *n > 0)).on_click(move |_, app| me.update(app, |shell, cx| shell.go(crate::nav::Panel::Folder, cx))));
        }
        if self.drive.as_ref().is_some_and(|d| d.configured) && !in_folder.as_ref().is_some_and(|(n, _)| n == "Google Drive") {
            let me = me.clone();
            row = row.child(ui.chip("merk-drive-einbeziehen", "Google Drive einbeziehen", false).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.open_drive_folder(cx);
            })));
        }
        {
            let me = me.clone();
            row = row.child(ui.chip("nur-offene", "Nur offene Folgen", state.filter.only_open).accessible_name("Nur Serien mit noch ungesehenen Folgen anzeigen").on_click(move |_, app| Shell::merk_do(&me, app, |m| m.filter.only_open = !m.filter.only_open)));
        }
        let tags = sondra_merk::view::all_tags(&state.items);
        if !tags.is_empty() {
            let me2 = me.clone();
            row = row.child(ui.chip("alle-tags", "Alle Tags", state.filter.tag.is_none()).on_click(move |_, app| Shell::merk_do(&me2, app, |m| m.filter.tag = None)));
            for tag in tags {
                let me = me.clone();
                let on = state.filter.tag.as_deref() == Some(tag.as_str());
                let t = tag.clone();
                row = row.child(ui.chip(format!("tag-{tag}"), format!("# {tag}"), on).accessible_name(format!("Tag {tag}")).on_click(move |_, app| {
                    let t = t.clone();
                    Shell::merk_do(&me, app, move |m| m.filter.tag = if m.filter.tag.as_deref() == Some(t.as_str()) { None } else { Some(t) })
                }));
            }
        }
        let lies = if self.merk_drive.on {
            "Über Google Drive abgeglichen — alle Ihre Geräte mit demselben Konto haben dieselbe Liste."
        } else if self.anytype.link.as_ref().is_some_and(|l| l.connected()) {
            "Mit Anytype abgeglichen."
        } else if self.drive.as_ref().is_some_and(|d| d.configured) {
            "Nur auf diesem Gerät gespeichert. Über Google Drive teilen es alle Ihre Geräte (Mehr → Über Google Drive abgleichen)."
        } else {
            "Nur auf diesem Gerät gespeichert."
        };
        div().flex().flex_col().gap(px(8.)).child(row).child(ui.hint(lies)).into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_episode_address_is_built_from_the_series_address() {
        assert_eq!(episode_address("https://aniworld.to/anime/stream/jojo", 4, 11), "https://aniworld.to/anime/stream/jojo/staffel-4/episode-11");
        assert_eq!(episode_address("https://aniworld.to/anime/stream/jojo/staffel-2/episode-3/", 4, 11), "https://aniworld.to/anime/stream/jojo/staffel-4/episode-11");
        assert_eq!(episode_address("https://s.to/serie/stream/dark", 0, 2), "https://s.to/serie/stream/dark/filme/film-2");
        assert_eq!(episode_address("https://example.org/film.mp4", 1, 1), "https://example.org/film.mp4");
    }

    #[test]
    fn fields_are_read_or_refused_with_a_reason() {
        assert_eq!(read_number("", 1, 600, "X"), Ok(None));
        assert_eq!(read_number(" 47 ", 1, 600, "X"), Ok(Some(47)));
        assert!(read_number("0", 1, 600, "X").is_err());
        assert_eq!(read_opening("1:30"), Ok(Some(90)));
        assert_eq!(read_opening("95"), Ok(Some(95)));
        assert!(read_opening("1:75").is_err());
        assert_eq!(read_tags("Anime, Favorit, anime ,, Manga"), vec!["Anime", "Favorit", "Manga"]);
        assert_eq!(opening_text(90), "1:30");
        assert_eq!(source_label("https://aniworld.to/anime/stream/x").as_deref(), Some("AniWorld"));
    }
}
