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

pub(crate) fn format_size(bytes: u64) -> String {
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
    /// A portal Sondra has no extractor for, loaded by yt-dlp.
    Portal { address: String, title: String },
}

pub struct Job {
    pub title: String,
    pub progress: Arc<Mutex<Progress>>,
    pub cancel: Cancel,
    pub started: Instant,
    /// A direct file or stream can be held; a yt-dlp load cannot (its own process runs on).
    pub can_pause: bool,
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
    /// More than one address was pasted: what was found behind each, waiting to be loaded in turn.
    pub queue: Vec<Found>,
    /// Loading the queue: the next one starts when this one is done.
    pub running_queue: bool,
    /// Addresses of a list that gave nothing, or loads that failed, with the reason.
    pub failed: Vec<String>,
    /// Whether a chime says that loading is done (on unless turned off).
    pub chime: bool,
    /// What the window's title and the system were last told, so they are told only when it changes.
    pub told: Option<(bool, String)>,
    /// Where Sondra's own copy of yt-dlp lives.
    pub ytdlp_dir: PathBuf,
    /// Where it is fetched from, when the person says so; a test points this at a server of its own.
    pub ytdlp_releases: String,
    /// Whether yt-dlp is also looked for outside Sondra's own folder (WinGet, the path); tests say no.
    pub ytdlp_system: bool,
    /// An address nothing could be found behind while yt-dlp is not there: the offer to fetch it.
    pub offer_tool: Option<String>,
    /// yt-dlp is being fetched.
    pub installing: bool,
    /// What is loaded and what happens with it (`download_options`).
    pub options: crate::download_options::DownloadOptions,
    /// Whether a change of the options is written to `Herunterladen.json` (not in tests).
    pub options_kept: bool,
    /// An address found in the clipboard when the page was opened, and the one turned down („Nicht jetzt“).
    pub clip_offer: Option<String>,
    pub clip_declined: Option<String>,
}

/// The address's host, for a title when nothing else names it.
fn host_of(address: &str) -> String {
    url::Url::parse(address).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string())).unwrap_or_else(|| "Portal".into())
}

/// What an address is when Sondra has no source of its own for it: a portal for yt-dlp if that is
/// there, otherwise the reason — and whether fetching yt-dlp could help.
fn find_or_portal(fetch: &dyn Fetch, address: &str, language: &str, ytdlp_dir: &std::path::Path, system: bool) -> Result<Vec<Found>, (String, bool)> {
    match find(fetch, address, language) {
        Ok(found) => Ok(vec![found]),
        Err(error) => {
            let is_address = url::Url::parse(address.trim()).ok().is_some_and(|u| matches!(u.scheme(), "http" | "https"));
            if !is_address {
                return Err((error, false));
            }
            use sondra_download::ytdlp;
            let address = address.trim();
            let Some(tool) = ytdlp::locate(ytdlp_dir, system) else { return Err((error, true)) };
            // A list is named, not loaded: each video of it is one source of the list.
            if ytdlp::is_playlist_address(address) {
                if let Ok((_, entries)) = ytdlp::playlist(&tool, address) {
                    if !entries.is_empty() {
                        return Ok(entries.into_iter().map(|e| Found::Portal { address: e.url, title: e.title }).collect());
                    }
                }
            }
            Ok(vec![Found::Portal { address: address.to_string(), title: format!("Video von {}", host_of(address)) }])
        }
    }
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

fn found_title(found: &Found) -> String {
    match found {
        Found::Episode(ep) if !ep.series_title.is_empty() => format!("{} · {}", ep.series_title, ep.title),
        Found::Episode(ep) => ep.title.clone(),
        Found::Direct(s) => s.title.clone(),
        Found::Portal { title, .. } => title.clone(),
    }
}

fn clean(name: &str) -> String {
    sondra_download::name::safe_stem(name)
}

/// Loads a portal's address with yt-dlp; a yt-dlp that is out of date is updated once and tried again.
fn load_with_ytdlp(address: &str, tool_dir: &std::path::Path, system: bool, dir: &std::path::Path, want: sondra_download::ytdlp::Want, cancel: &Cancel, progress: &Arc<Mutex<Progress>>) -> Result<(PathBuf, u64), String> {
    use sondra_download::ytdlp;
    let Some(mut tool) = ytdlp::locate(tool_dir, system) else { return Err(ytdlp::YtdlpError::Missing.to_string()) };
    if ytdlp::is_stale(tool_dir) {
        ytdlp::update(tool_dir);
    }
    let mut updated = false;
    loop {
        let heard = progress.clone();
        // FFmpeg beside the program puts picture and sound together and takes the sound out.
        let ffmpeg = sondra_media::ffmpeg::Ffmpeg::locate().map(|f| f.program().to_path_buf());
        match ytdlp::download_with(&tool, address, dir, ffmpeg.as_deref(), &ytdlp::want_args(want), cancel, &mut |p| *heard.lock().expect("lock") = p) {
            Ok(file) => return Ok((file.path, file.size)),
            Err(ytdlp::YtdlpError::Cancelled) => return Err("Abgebrochen.".into()),
            Err(error) if error.outdated() && !updated => {
                updated = true;
                if !ytdlp::update(tool_dir) {
                    return Err(error.to_string());
                }
                match ytdlp::locate(tool_dir, system) {
                    Some(newer) => tool = newer,
                    None => return Err(error.to_string()),
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

impl DownloadState {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> DownloadState {
        let input = cx.new(|cx| TextField::new(cx, colors, "Adresse").value_face().placeholder("Adresse einer Folge, eines Films oder einer Datei").max_chars(2000));
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
            queue: Vec::new(),
            running_queue: false,
            failed: Vec::new(),
            chime: crate::store::FileStore::at_default("Herunterladen.json").is_none_or(|store| sondra_merk::folder_memory::Store::get_item(&store, "gong").as_deref() != Some("aus")),
            told: None,
            ytdlp_dir: crate::store::data_dir().unwrap_or_default(),
            ytdlp_releases: sondra_download::ytdlp::RELEASES.to_string(),
            options: crate::download_options::DownloadOptions::load(),
            options_kept: true,
            clip_offer: None,
            clip_declined: None,
            ytdlp_system: true,
            offer_tool: None,
            installing: false,
        }
    }
}

impl Shell {
    /// For tests: the network the lookups use, and whether this computer's own addresses are let through.
    pub fn download_with(&mut self, fetch: FetchFactory, allow_private: bool, folder: PathBuf) {
        self.download.fetch = fetch;
        self.download.allow_private = allow_private;
        self.download.folder = folder;
        // A test never depends on what is installed on this machine.
        self.download.ytdlp_dir = self.download.folder.join(".ytdlp-test");
        self.download.ytdlp_system = false;
        // Nor on what was chosen here before; and what a test chooses is not kept.
        self.download.options = crate::download_options::DownloadOptions::default();
        self.download.options_kept = false;
    }

    /// For tests: where yt-dlp is looked for and fetched from — Sondra's own folder only, and a server of
    /// the test's own.
    pub fn download_ytdlp_with(&mut self, dir: PathBuf, releases: String) {
        self.download.ytdlp_dir = dir;
        self.download.ytdlp_releases = releases;
        self.download.ytdlp_system = false;
    }

    /// For tests: puts an address in the field.
    pub fn download_set_input(&mut self, text: &str, cx: &mut Context<Self>) {
        self.download.input.update(cx, |f, cx| f.set_text(text.to_string(), cx));
    }

    /// Looks up the address that is typed — or, when a list was pasted, each of its addresses.
    pub(crate) fn find_address(&mut self, cx: &mut Context<Self>) {
        let d = &mut self.download;
        if d.finding || d.job.is_some() {
            return;
        }
        let text = d.input.read(cx).text().to_string();
        let addresses = sondra_download::addresses::extract_addresses(&text);
        let (factory, language, ytdlp_dir, system) = (d.fetch.clone(), d.language.clone(), d.ytdlp_dir.clone(), d.ytdlp_system);
        d.finding = true;
        d.error = None;
        d.offer_tool = None;
        d.found = None;
        d.queue.clear();
        d.failed.clear();
        if addresses.len() > 1 {
            Self::in_background(
                cx,
                move || addresses.into_iter().map(|a| (a.clone(), find_or_portal(factory().as_ref(), &a, &language, &ytdlp_dir, system).map_err(|(e, _)| e))).collect::<Vec<_>>(),
                |shell, answers, cx| {
                    let d = &mut shell.download;
                    d.finding = false;
                    for (address, answer) in answers {
                        match answer {
                            Ok(found) => d.queue.extend(found),
                            Err(error) => d.failed.push(format!("{address}: {error}")),
                        }
                    }
                    if d.queue.is_empty() {
                        d.error = Some("Hinter keiner dieser Adressen hat Sondra eine Quelle gefunden, die sich laden lässt.".into());
                    }
                    cx.notify();
                },
            );
            cx.notify();
            return;
        }
        let address = if addresses.len() == 1 { addresses.into_iter().next().unwrap_or_default() } else { text };
        Self::in_background(
            cx,
            {
                let address = address.clone();
                move || find_or_portal(factory().as_ref(), &address, &language, &ytdlp_dir, system)
            },
            move |shell, answer, cx| {
                let d = &mut shell.download;
                d.finding = false;
                match answer {
                    // One source is shown for loading; several (a list of videos) wait as a list.
                    Ok(mut found) if found.len() == 1 => d.found = found.pop(),
                    Ok(found) => d.queue = found,
                    Err((error, can_fetch)) => {
                        d.error = Some(error);
                        // Fetching yt-dlp is offered, never done by itself.
                        d.offer_tool = can_fetch.then(|| address.trim().to_string());
                    }
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// The window's title says how far a download is, and the screen and system stay awake while it runs;
    /// both are put back when it ends. Called on every frame, it tells only what changed.
    pub(crate) fn sync_download_chrome(&mut self, window: &mut gpui::Window, cx: &mut Context<Self>) {
        let d = &self.download;
        let now = match &d.job {
            Some(job) => {
                let p = *job.progress.lock().expect("lock");
                let said = match p.total.filter(|t| *t > 0) {
                    Some(t) => format!("⬇ {} % · {} — Sondra", (p.loaded * 100 / t).min(100), job.title),
                    None => format!("⬇ {} — Sondra", job.title),
                };
                (true, said)
            }
            None => (false, "Sondra".to_string()),
        };
        if d.told.as_ref() == Some(&now) {
            return;
        }
        let was_awake = d.told.as_ref().is_some_and(|t| t.0);
        if now.0 != was_awake {
            crate::system::keep_awake(now.0);
        }
        sondra_a11y::set_window_title(window, cx, &now.1);
        self.download.told = Some(now);
    }

    /// Turns the chime on or off, and remembers it.
    pub(crate) fn set_download_chime(&mut self, on: bool, cx: &mut Context<Self>) {
        self.download.chime = on;
        if let Some(mut store) = crate::store::FileStore::at_default("Herunterladen.json") {
            sondra_merk::folder_memory::Store::set_item(&mut store, "gong", if on { "an" } else { "aus" }.to_string());
        }
        cx.notify();
    }

    /// Loads everything a pasted list gave, one after the other.
    pub(crate) fn start_queue(&mut self, cx: &mut Context<Self>) {
        let d = &mut self.download;
        if d.job.is_some() || d.queue.is_empty() {
            return;
        }
        d.running_queue = true;
        self.next_in_queue(cx);
    }

    fn next_in_queue(&mut self, cx: &mut Context<Self>) {
        let d = &mut self.download;
        if d.queue.is_empty() {
            d.running_queue = false;
            d.found = None;
            d.input.update(cx, |f, cx| f.set_text("", cx));
            cx.notify();
            return;
        }
        d.found = Some(d.queue.remove(0));
        self.start_download(cx);
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
            Found::Portal { .. } => (Vec::new(), found_title(&found), d.folder.clone()),
            Found::Episode(ep) => (
                ep.streams.iter().map(|s: &ResolvedStream| StreamInfo { title: ep.title.clone(), url: s.url.clone(), is_hls: s.is_hls, referer: s.referer.clone(), hoster: s.provider.clone() }).collect(),
                ep.title.clone(),
                d.folder.join(clean(&ep.series_title)).join(if ep.season == 0 { "Filme".to_string() } else { format!("Staffel {}", ep.season) }),
            ),
        };
        let progress = Arc::new(Mutex::new(Progress::default()));
        let cancel = Cancel::new();
        d.job = Some(Job { title: title.clone(), progress: progress.clone(), cancel: cancel.clone(), started: Instant::now(), can_pause: !matches!(found, Found::Portal { .. }) });
        d.error = None;
        let allow_private = d.allow_private;
        let stem = title.clone();
        let options = d.options.clone();
        let (finish_title, want) = (title.clone(), options.want());
        let portal = match &found {
            Found::Portal { address, .. } => Some((address.clone(), d.ytdlp_dir.clone(), d.ytdlp_system)),
            _ => None,
        };
        Self::in_background(
            cx,
            move || -> Result<(PathBuf, u64), String> {
                // After loading: the sound alone when only that was wanted, then the name (`download_options`).
                let finished = |(path, size): (PathBuf, u64), by_ytdlp: bool| -> Result<(PathBuf, u64), String> {
                    let path = crate::download_options::finish(&path, &finish_title, &options, by_ytdlp)?;
                    let size = std::fs::metadata(&path).map_or(size, |m| m.len());
                    Ok((path, size))
                };
                if let Some((address, tool_dir, system)) = portal {
                    return load_with_ytdlp(&address, &tool_dir, system, &dir, want, &cancel, &progress).and_then(|done| finished(done, true));
                }
                let mut last = String::from("Keine Quelle ließ sich laden.");
                for stream in &streams {
                    let mut downloader = Downloader::new(None, cancel.clone());
                    downloader.allow_private = allow_private;
                    let progress = progress.clone();
                    match downloader.download(stream, &dir, &stem, &mut |p| *progress.lock().expect("lock") = p) {
                        Ok(file) => return finished((file.path, file.size), false),
                        Err(sondra_download::DownloadError::Cancelled) => return Err("Abgebrochen.".into()),
                        Err(error) => last = format!("{}: {error}", stream.hoster),
                    }
                }
                Err(last)
            },
            move |shell, answer, cx| {
                let d = &mut shell.download;
                d.job = None;
                let in_queue = d.running_queue;
                match answer {
                    Ok((path, size)) => {
                        let line = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| title.clone());
                        let play_now = d.options.play_after && !in_queue;
                        d.done.insert(0, Loaded { title, path: path.clone(), size });
                        if play_now {
                            shell.go(crate::nav::Panel::Player, cx);
                            shell.play_files(vec![path], cx);
                        }
                        crate::protocol::note("herunterladen", format!("Geladen: {line}"));
                        shell.note("Geladen", line, Some(crate::nav::Panel::Downloader));
                        let d = &mut shell.download;
                        d.found = None;
                        if !in_queue {
                            d.input.update(cx, |f, cx| f.set_text("", cx));
                        }
                    }
                    Err(error) if in_queue && error != "Abgebrochen." => {
                        crate::protocol::warn("herunterladen", format!("{title}: {error}"));
                        d.failed.push(format!("{title}: {error}"));
                        d.found = None;
                    }
                    Err(error) => {
                        d.error = Some(error);
                        // A cancelled load stops the rest of the list too.
                        d.running_queue = false;
                        d.queue.clear();
                    }
                }
                if shell.download.running_queue {
                    shell.next_in_queue(cx);
                }
                let d = &shell.download;
                if d.job.is_none() && !d.running_queue && d.error.is_none() && d.chime && !d.done.is_empty() {
                    crate::system::play_chime();
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// Fetches yt-dlp — only on the person's click — and then goes on with the address it was wanted for.
    pub(crate) fn install_ytdlp(&mut self, cx: &mut Context<Self>) {
        let d = &mut self.download;
        let Some(address) = d.offer_tool.clone() else { return };
        if d.installing {
            return;
        }
        d.installing = true;
        d.error = None;
        let (dir, releases) = (d.ytdlp_dir.clone(), d.ytdlp_releases.clone());
        Self::in_background(
            cx,
            move || sondra_download::ytdlp::install(&dir, &releases, &Cancel::new()).map_err(|e| e.to_string()),
            move |shell, answer, cx| {
                let d = &mut shell.download;
                d.installing = false;
                match answer {
                    Ok(_) => {
                        d.offer_tool = None;
                        d.found = Some(Found::Portal { title: format!("Video von {}", host_of(&address)), address });
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

        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Herunterladen", "Geben Sie die Adresse einer Folge, eines Films oder einer Datei ein. Sondra sucht die Quelle dahinter und lädt sie in einen Ordner auf diesem Computer."));
        page = page.child(ui.notice(NoticeKind::Info, "Herunterladen läuft nicht lokal: Die Adresse und die Datei gehen durch das Netz zu dem Dienst, bei dem sie liegen. Laden Sie nur, was Sie laden dürfen."));
        if let Some(error) = &d.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }

        for line in &d.failed {
            page = page.child(ui.notice(NoticeKind::Warning, line.clone()));
        }

        let find_button = {
            let me = me.clone();
            ui.button("suchen", if d.finding { "Sucht …" } else { "Suchen" }).primary().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.find_address(cx)))
        };
        let mut work = div().flex().flex_col().gap(px(20.)).child(div().flex().flex_wrap().items_center().gap(px(10.)).child(div().flex_1().min_w(px(260.)).max_w(px(560.)).child(d.input.clone())).child(find_button));
        if let Some(address) = d.clip_offer.clone().filter(|_| !busy) {
            let (take, away) = (me.clone(), me.clone());
            let shown = address.trim_start_matches("https://").trim_start_matches("http://").to_string();
            work = work.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(10.))
                    .p(px(12.))
                    .rounded(px(sondra_ui::radius::CARD))
                    .bg(c.panel_soft)
                    .child(ui.hint("In der Zwischenablage"))
                    .child(div().max_w(px(420.)).truncate().child(ui.value(shown)))
                    .child(ui.button("zwischenablage-einfuegen", "Einfügen und nachsehen").small().primary().on_click(move |_, app| take.update(app, |shell, cx| {
                        if let Some(address) = shell.download.clip_offer.take() {
                            shell.download_set_input(&address, cx);
                            shell.find_address(cx);
                        }
                        cx.notify();
                    })))
                    .child(ui.button("zwischenablage-nicht", "Nicht jetzt").small().ghost().on_click(move |_, app| away.update(app, |shell, cx| {
                        shell.download.clip_declined = shell.download.clip_offer.take();
                        cx.notify();
                    }))),
            );
        }
        // Where the files go and whether a sound says they are there: the settings column.
        let me2 = me.clone();
        let (me_chime, chime_on) = (me.clone(), d.chime);
        let settings = vec![
            ui.setting(
                "Ordner",
                div().flex().flex_col().gap(px(8.)).child(ui.value(d.folder.display().to_string())).child(div().flex().child(ui.button("ordner-aendern", "Ändern").small().disabled(busy).on_click(move |_, app| me2.update(app, |shell, cx| shell.choose_download_folder(cx))))),
                None,
            ),
            self.download_what_setting(&ui, cx),
            self.download_quality_setting(&ui, cx),
            self.download_language_setting(&ui, cx),
            self.download_naming_setting(&ui, cx),
            ui.setting(
                "Wenn es fertig ist",
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(6.))
                    .child(ui.chip("gong", "Ton, wenn fertig", chime_on).on_click(move |_, app| me_chime.update(app, |shell, cx| shell.set_download_chime(!chime_on, cx))))
                    .child({
                        let me = me.clone();
                        let on = d.options.play_after;
                        ui.chip("sofort-abspielen", "Danach im Player abspielen", on).accessible_name("Nach Download sofort im Player abspielen").on_click(move |_, app| me.update(app, |shell, cx| {
                            shell.download.options.play_after = !on;
                            if shell.download.options_kept {
                                shell.download.options.keep();
                            }
                            cx.notify();
                        }))
                    }),
                None,
            ),
        ];

        // A pasted list: what was found behind each address.
        if !d.queue.is_empty() && d.job.is_none() {
            let mut rows = div().flex().flex_col().gap(px(4.));
            for found in &d.queue {
                rows = rows.child(ui.prose(found_title(found)));
            }
            let me4 = me.clone();
            let count = d.queue.len();
            work = work.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .p(px(16.))
                    .rounded(px(sondra_ui::radius::CARD))
                    .bg(c.panel_soft)
                    .child(ui.subheading(format!("{count} Quellen gefunden")))
                    .child(rows)
                    .child(div().flex().child(ui.button("alle-laden", "Alle laden").primary().on_click(move |_, app| me4.update(app, |shell, cx| shell.start_queue(cx))))),
            );
        }

        // Nothing found, yt-dlp not there: the offer to fetch it.
        if let Some(address) = d.offer_tool.as_ref().filter(|_| d.found.is_none()) {
            let me_install = me.clone();
            work = work.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .p(px(16.))
                    .rounded(px(sondra_ui::radius::CARD))
                    .bg(c.panel_cool)
                    .child(ui.subheading(format!("Mehr Seiten laden: {}", host_of(address))))
                    .child(ui.prose("Mit yt-dlp, einem freien Programm, lassen sich viele weitere Seiten laden. Sondra holt es nur auf Ihren Klick von yt-dlp selbst (rund 18 MB) und prüft es gegen die veröffentlichte Prüfsumme. Danach läuft es auf diesem Computer; die Adresse geht an die Seite, bei der das Video liegt."))
                    .child(div().flex().child(ui.button("ytdlp-laden", if d.installing { "Lädt yt-dlp …" } else { "yt-dlp laden" }).primary().disabled(d.installing).on_click(move |_, app| me_install.update(app, |shell, cx| shell.install_ytdlp(cx))))),
            );
        }

        // What was found.
        if let Some(found) = d.found.as_ref().filter(|_| !d.running_queue) {
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
                Found::Portal { address, .. } => (found_title(found), vec!["Über yt-dlp".to_string(), host_of(address)]),
            };
            let mut card = div().flex().flex_col().gap(px(10.)).p(px(16.)).rounded(px(sondra_ui::radius::CARD)).bg(c.panel_soft).child(ui.subheading(title.clone())).child(ui.prose(facts.join(" · ")));
            // „Merken“: onto the Merkliste with this address (an episode with its season and episode).
            {
                let me = me.clone();
                let address = d.input.read(cx).text().trim().to_string();
                let (name, season, episode) = match found {
                    Found::Episode(ep) => (if ep.series_title.is_empty() { ep.title.clone() } else { ep.series_title.clone() }, i64::from(ep.season), Some(i64::from(ep.episode))),
                    _ => (title.clone(), 1, None),
                };
                if !address.is_empty() {
                    card = card.child(div().flex().child(ui.button("adresse-merken", "Merken").small().ghost().accessible_name("Auf die Merkliste setzen, mit Staffel und Folge").on_click(move |_, app| {
                        let (address, name) = (address.clone(), name.clone());
                        me.update(app, |shell, cx| shell.remember_address(&address, &name, season, episode, cx))
                    })));
                }
            }
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
            work = work.child(card);
        }

        // The way there.
        if let Some(job) = &d.job {
            let progress = *job.progress.lock().expect("lock");
            let fraction = progress.total.filter(|t| *t > 0).map(|t| (progress.loaded as f32 / t as f32).clamp(0.0, 1.0));
            let seconds = job.started.elapsed().as_secs_f64().max(0.001);
            let rate = progress.loaded as f64 / seconds;
            let paused = job.cancel.is_paused();
            let said = match (paused, progress.total) {
                (true, Some(total)) => format!("Angehalten bei {} von {}", format_size(progress.loaded), format_size(total)),
                (true, None) => format!("Angehalten bei {}", format_size(progress.loaded)),
                (false, Some(total)) => format!("{} von {} · {}/s", format_size(progress.loaded), format_size(total), format_size(rate as u64)),
                (false, None) => format!("{} · {}/s", format_size(progress.loaded), format_size(rate as u64)),
            };
            let cancel = job.cancel.clone();
            let hold = job.cancel.clone();
            let hold_me = me.clone();
            let can_pause = job.can_pause;
            work = work.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(ui.title({
                        let verb = if paused { "Angehalten" } else { "Lädt" };
                        if d.running_queue && !d.queue.is_empty() { format!("{verb}: {} · noch {} danach", job.title, d.queue.len()) } else { format!("{verb}: {}", job.title) }
                    }))
                    .child(ui.bar("laden", fraction, format!("{}: geladen", job.title)))
                    .child(div().flex().flex_wrap().items_center().gap(px(12.)).child(div().font_family(family::VALUE).text_size(px(size::SMALL)).text_color(c.prose).child(said)).children(can_pause.then(|| {
                        ui.button("laden-pause", if paused { "Fortsetzen" } else { "Anhalten" }).small().on_click(move |_, app| {
                            if hold.is_paused() { hold.resume() } else { hold.pause() }
                            hold_me.update(app, |_, cx| cx.notify());
                        })
                    })).child(ui.button("laden-abbrechen", "Abbrechen").small().on_click(move |_, _| cancel.cancel()))),
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
                let drive_button = self.drive_button(&ui, format!("geladen-drive-{n}"), &path, &name, cx);
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
                        div().flex().gap(px(8.)).children(drive_button).child(ui.button(format!("geladen-abspielen-{n}"), "Abspielen").small().on_click(move |_, app| {
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
                    keys_pass: false,
                    on_open: std::rc::Rc::new(|_, _| {}),
                });
            }
            work = work.child(div().flex().flex_col().gap(px(10.)).child(div().pb(px(10.)).border_b_1().border_color(c.line).child(ui.subheading("Geladen"))).child(rows));
        }
        page.child(ui.tool_body(settings, work)).into_any_element()
    }
}
