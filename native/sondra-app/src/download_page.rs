//! The Herunterladen page: an address in, what is behind it found, one click to load it into a folder —
//! with the way there in view (how far, how fast), a way to stop, and what has been loaded, ready to play.
//! What finds the stream is `sondra-extract`, what loads it is `sondra-download`; both are the ones the
//! background service uses. Nothing is looked up anywhere but at the address the person gave: no provider is
//! built in.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use gpui::{div, prelude::*, px, AnyElement, Context, Entity, PathPromptOptions};
use sondra_download::{Cancel, Downloader, Progress};
use sondra_extract::episode::{extract_episode, Episode, ResolvedStream};
use sondra_extract::fetch::{Fetch, UreqFetch};
use sondra_extract::stream::StreamInfo;
use sondra_ui::{family, size, FieldEvent, NoticeKind, TextField, Ui};

fn format_size(bytes: u64) -> String {
    sondra_merk::format::format_bytes(bytes as f64, 1)
}

use crate::lines::Line;
use crate::nav::Panel;
use crate::shell::Shell;

/// Makes the network a lookup uses; tests hand in stand-in pages.
pub type FetchFactory = Arc<dyn Fn() -> Box<dyn Fetch> + Send + Sync>;

/// What an address turned out to be.
#[derive(Debug, Clone)]
pub enum Found {
    /// A page of episodes with sources to choose among.
    Episode(Episode),
    /// An address of a file or a stream itself.
    Direct(StreamInfo),
}

pub struct Job {
    pub title: String,
    pub progress: Arc<Mutex<Progress>>,
    pub cancel: Cancel,
    pub started: Instant,
}

pub struct Loaded {
    pub title: String,
    pub path: PathBuf,
    pub size: u64,
}

pub struct DownloadState {
    pub input: Entity<TextField>,
    pub folder: PathBuf,
    /// An address is being looked up.
    pub finding: bool,
    pub found: Option<Found>,
    pub job: Option<Job>,
    pub done: Vec<Loaded>,
    pub error: Option<String>,
    pub fetch: FetchFactory,
    /// For tests against a server on this computer; a real download never sets it.
    pub allow_private: bool,
    /// The language chosen among those the page offers (its code), or none: the site's own order.
    pub language: String,
}

/// An address that is a file or a stream itself rather than a page.
fn direct_stream(address: &str) -> Option<StreamInfo> {
    let url = url::Url::parse(address).ok().filter(|u| matches!(u.scheme(), "http" | "https"))?;
    let path = url.path().to_lowercase();
    let is_hls = path.ends_with(".m3u8");
    let media = [".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav", ".aac"];
    if !is_hls && !media.iter().any(|e| path.ends_with(e)) {
        return None;
    }
    let title = url.path_segments().and_then(|mut s| s.next_back()).filter(|s| !s.is_empty()).map_or_else(|| "Download".to_string(), |s| s.rsplit_once('.').map_or(s, |(stem, _)| stem).to_string());
    Some(StreamInfo { title, url: address.to_string(), is_hls, referer: String::new(), hoster: url.host_str().unwrap_or("").to_string() })
}

/// What is behind an address: the sources of an episode page, or the file itself.
pub fn find(fetch: &dyn Fetch, address: &str, language: &str) -> Result<Found, String> {
    let address = address.trim();
    if address.is_empty() {
        return Err("Geben Sie eine Adresse ein.".into());
    }
    if url::Url::parse(address).ok().filter(|u| matches!(u.scheme(), "http" | "https")).is_none() {
        return Err("Das ist keine Adresse. Sie beginnt mit https://.".into());
    }
    // A file or a stream itself is taken as it is — not fetched once to see what it is.
    if let Some(stream) = direct_stream(address) {
        return Ok(Found::Direct(stream));
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    if let Some(episode) = extract_episode(fetch, address, language, now) {
        return Ok(Found::Episode(episode));
    }
    Err("Hinter dieser Adresse hat Sondra keine Quelle gefunden, die sich laden lässt.".into())
}

fn clean(name: &str) -> String {
    sondra_download::name::safe_stem(name)
}

impl DownloadState {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> DownloadState {
        let input = cx.new(|cx| TextField::new(cx, colors, "Adresse").placeholder("Adresse einer Folge, eines Films oder einer Datei").max_chars(2000));
        cx.subscribe(&input, |shell: &mut Shell, _, event: &FieldEvent, cx| {
            if *event == FieldEvent::Submitted {
                shell.find_address(cx);
            }
        })
        .detach();
        DownloadState {
            input,
            folder: crate::store::downloads_dir(),
            finding: false,
            found: None,
            job: None,
            done: Vec::new(),
            error: None,
            fetch: Arc::new(|| Box::new(UreqFetch::default())),
            allow_private: false,
            language: String::new(),
        }
    }
}

impl Shell {
    /// For tests: the network the lookups use, and whether this computer's own addresses are let through.
    pub fn download_with(&mut self, fetch: FetchFactory, allow_private: bool, folder: PathBuf) {
        self.download.fetch = fetch;
        self.download.allow_private = allow_private;
        self.download.folder = folder;
    }

    /// For tests: puts an address in the field.
    pub fn download_set_input(&mut self, text: &str, cx: &mut Context<Self>) {
        self.download.input.update(cx, |f, cx| f.set_text(text.to_string(), cx));
    }

    /// Looks up the address that is typed.
    pub(crate) fn find_address(&mut self, cx: &mut Context<Self>) {
        let d = &mut self.download;
        if d.finding || d.job.is_some() {
            return;
        }
        let address = d.input.read(cx).text().to_string();
        let (factory, language) = (d.fetch.clone(), d.language.clone());
        d.finding = true;
        d.error = None;
        d.found = None;
        Self::in_background(
            cx,
            move || find(factory().as_ref(), &address, &language),
            |shell, answer, cx| {
                let d = &mut shell.download;
                d.finding = false;
                match answer {
                    Ok(found) => d.found = Some(found),
                    Err(error) => d.error = Some(error),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// Loads what was found: the first source that works, the others are mirrors of it.
    pub(crate) fn start_download(&mut self, cx: &mut Context<Self>) {
        let d = &mut self.download;
        let Some(found) = d.found.clone() else { return };
        if d.job.is_some() {
            return;
        }
        let (streams, title, dir): (Vec<StreamInfo>, String, PathBuf) = match &found {
            Found::Direct(stream) => (vec![stream.clone()], stream.title.clone(), d.folder.clone()),
            Found::Episode(ep) => (
                ep.streams.iter().map(|s: &ResolvedStream| StreamInfo { title: ep.title.clone(), url: s.url.clone(), is_hls: s.is_hls, referer: s.referer.clone(), hoster: s.provider.clone() }).collect(),
                ep.title.clone(),
                d.folder.join(clean(&ep.series_title)).join(if ep.season == 0 { "Filme".to_string() } else { format!("Staffel {}", ep.season) }),
            ),
        };
        let progress = Arc::new(Mutex::new(Progress::default()));
        let cancel = Cancel::new();
        d.job = Some(Job { title: title.clone(), progress: progress.clone(), cancel: cancel.clone(), started: Instant::now() });
        d.error = None;
        let allow_private = d.allow_private;
        let stem = title.clone();
        Self::in_background(
            cx,
            move || -> Result<(PathBuf, u64), String> {
                let mut last = String::from("Keine Quelle ließ sich laden.");
                for stream in &streams {
                    let mut downloader = Downloader::new(None, cancel.clone());
                    downloader.allow_private = allow_private;
                    let progress = progress.clone();
                    match downloader.download(stream, &dir, &stem, &mut |p| *progress.lock().expect("lock") = p) {
                        Ok(file) => return Ok((file.path, file.size)),
                        Err(sondra_download::DownloadError::Cancelled) => return Err("Abgebrochen.".into()),
                        Err(error) => last = format!("{}: {error}", stream.hoster),
                    }
                }
                Err(last)
            },
            move |shell, answer, cx| {
                let d = &mut shell.download;
                d.job = None;
                match answer {
                    Ok((path, size)) => {
                        d.done.insert(0, Loaded { title, path, size });
                        d.found = None;
                        d.input.update(cx, |f, cx| f.set_text("", cx));
                    }
                    Err(error) => d.error = Some(error),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// Asks for another folder to load into.
    fn choose_download_folder(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| {
                        shell.download.folder = path;
                        cx.notify();
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    /// The page.
    pub(crate) fn download_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let d = &self.download;
        let busy = d.finding || d.job.is_some();

        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.heading("Herunterladen"));
        page = page.child(ui.prose("Geben Sie die Adresse einer Folge, eines Films oder einer Datei ein. Sondra sucht die Quelle dahinter und lädt sie in einen Ordner auf diesem Computer."));
        page = page.child(ui.notice(NoticeKind::Info, "Herunterladen läuft nicht lokal: Die Adresse und die Datei gehen durch das Netz zu dem Dienst, bei dem sie liegen. Laden Sie nur, was Sie laden dürfen."));
        if let Some(error) = &d.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }

        let find_button = {
            let me = me.clone();
            ui.button("suchen", if d.finding { "Sucht …" } else { "Suchen" }).primary().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.find_address(cx)))
        };
        page = page.child(div().flex().flex_wrap().items_center().gap(px(10.)).child(div().w(px(520.)).child(d.input.clone())).child(find_button));
        let me2 = me.clone();
        page = page.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(10.))
                .child(ui.hint("Ordner:"))
                .child(ui.value(d.folder.display().to_string()))
                .child(ui.button("ordner-aendern", "Ändern").small().disabled(busy).on_click(move |_, app| me2.update(app, |shell, cx| shell.choose_download_folder(cx)))),
        );

        // What was found.
        if let Some(found) = &d.found {
            let (title, facts): (String, Vec<String>) = match found {
                Found::Episode(ep) => {
                    let mut facts = vec![if ep.season == 0 { "Film".to_string() } else { format!("Staffel {}, Folge {}", ep.season, ep.episode) }];
                    facts.push(format!("{} {}", ep.streams.len(), if ep.streams.len() == 1 { "Quelle" } else { "Quellen" }));
                    if !ep.language.is_empty() {
                        facts.push(ep.language.clone());
                    }
                    (if ep.series_title.is_empty() { ep.title.clone() } else { format!("{} · {}", ep.series_title, ep.title) }, facts)
                }
                Found::Direct(s) => (s.title.clone(), vec![if s.is_hls { "Stream (HLS)".to_string() } else { "Datei".to_string() }, s.hoster.clone()]),
            };
            let mut card = div().flex().flex_col().gap(px(10.)).p(px(16.)).rounded(px(sondra_ui::radius::CARD)).bg(c.panel_soft).child(ui.subheading(title)).child(ui.prose(facts.join(" · ")));
            if let Found::Episode(ep) = found {
                if ep.available_languages.len() > 1 {
                    let mut languages = div().flex().flex_wrap().gap(px(6.));
                    for language in &ep.available_languages {
                        let (me, code) = (me.clone(), language.code.clone());
                        let on = ep.language == language.label || d.language == language.code;
                        languages = languages.child(ui.chip(format!("sprache-{}", language.code), language.label.clone(), on).on_click(move |_, app| {
                            let code = code.clone();
                            me.update(app, |shell, cx| {
                                shell.download.language = code;
                                shell.find_address(cx);
                            })
                        }));
                    }
                    card = card.child(languages);
                }
            }
            let me3 = me.clone();
            card = card.child(div().flex().child(ui.button("laden", "Laden").primary().disabled(d.job.is_some()).on_click(move |_, app| me3.update(app, |shell, cx| shell.start_download(cx)))));
            page = page.child(card);
        }

        // The way there.
        if let Some(job) = &d.job {
            let progress = *job.progress.lock().expect("lock");
            let fraction = progress.total.filter(|t| *t > 0).map(|t| (progress.loaded as f32 / t as f32).clamp(0.0, 1.0));
            let seconds = job.started.elapsed().as_secs_f64().max(0.001);
            let rate = progress.loaded as f64 / seconds;
            let said = match progress.total {
                Some(total) => format!("{} von {} · {}/s", format_size(progress.loaded), format_size(total), format_size(rate as u64)),
                None => format!("{} · {}/s", format_size(progress.loaded), format_size(rate as u64)),
            };
            let cancel = job.cancel.clone();
            page = page.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(ui.title(format!("Lädt: {}", job.title)))
                    .child(ui.bar("laden", fraction, format!("{}: geladen", job.title)))
                    .child(div().flex().flex_wrap().items_center().gap(px(12.)).child(div().font_family(family::VALUE).text_size(px(size::SMALL)).text_color(c.prose).child(said)).child(ui.button("laden-abbrechen", "Abbrechen").small().on_click(move |_, _| cancel.cancel()))),
            );
        }

        // What has been loaded: ready to play.
        if !d.done.is_empty() {
            let mut rows = div().flex().flex_col();
            for (n, file) in d.done.iter().enumerate() {
                let (play, show) = (me.clone(), me.clone());
                let (path, folder) = (file.path.clone(), file.path.parent().map(PathBuf::from));
                let says = format!("{} · {}", file.path.display(), format_size(file.size));
                let name = file.path.file_name().map_or_else(|| file.title.clone(), |n| n.to_string_lossy().into_owned());
                rows = rows.child(Line {
                    colors: c,
                    id: format!("geladen-{n}").into(),
                    name: name.clone().into(),
                    says: says.clone().into(),
                    first: n == 0,
                    tile: None,
                    selected: false,
                    body: vec![
                        div().flex_1().min_w(px(0.)).child(ui.value(name)).into_any_element(),
                        div().flex().gap(px(8.)).child(ui.button(format!("geladen-abspielen-{n}"), "Abspielen").small().on_click(move |_, app| {
                            let path = path.clone();
                            play.update(app, |shell, cx| {
                                shell.go(Panel::Player, cx);
                                shell.play_files(vec![path], cx);
                            })
                        })).child(ui.button(format!("geladen-zeigen-{n}"), "Im Ordner zeigen").small().on_click(move |_, app| {
                            if let Some(folder) = folder.clone() {
                                show.update(app, |shell, cx| {
                                    shell.go(Panel::Folder, cx);
                                    shell.open_folder(folder, cx);
                                })
                            }
                        })).into_any_element(),
                    ],
                    on_open: std::rc::Rc::new(|_, _| {}),
                });
            }
            page = page.child(div().flex().flex_col().gap(px(10.)).child(div().pb(px(10.)).border_b_1().border_color(c.line).child(ui.subheading("Geladen"))).child(rows));
        }
        page.into_any_element()
    }
}
