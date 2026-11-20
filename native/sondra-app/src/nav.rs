//! The tools and how the row of tabs groups them — `src/components/panelMeta.tsx`, as data. The table is
//! checked against what the web app writes today (`npm run native:golden`), so a tool added or moved
//! there that is not carried over here fails a test instead of leaving a tab that goes nowhere.

/// Every tool, in the order of the web app's `PANELS` (arrow keys and the direction a tool slides in from
/// follow it).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Panel {
    Start,
    Merkliste,
    Folder,
    Player,
    Downloader,
    Devices,
    Converter,
    Video,
    Images,
    Subtitles,
    Audio,
    Mix,
    Stems,
    Normalize,
    Sampler,
    Harmony,
    Screen,
    Phone,
    Mic,
}

pub struct PanelMeta {
    pub panel: Panel,
    /// What the code switches on; the web app's `PanelId`.
    pub id: &'static str,
    /// The address after the `#`: German and stable, because it is a link someone may send.
    pub slug: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
}

const fn meta(
    panel: Panel,
    id: &'static str,
    slug: &'static str,
    label: &'static str,
    summary: &'static str,
) -> PanelMeta {
    PanelMeta {
        panel,
        id,
        slug,
        label,
        summary,
    }
}

pub const PANELS: [PanelMeta; 19] = [
    meta(
        Panel::Start,
        "start",
        "start",
        "Start",
        "Alle Werkzeuge als Kacheln, mit Suche",
    ),
    meta(
        Panel::Merkliste,
        "merkliste",
        "merkliste",
        "Merkliste",
        "Serien und Listen, die Sie schauen — Staffeln, Folgen, Fortschritt",
    ),
    meta(
        Panel::Folder,
        "folder",
        "ordner",
        "Ordner",
        "Die Dateien eines Ordners sehen, auswählen und weiterschauen",
    ),
    meta(
        Panel::Player,
        "player",
        "abspielen",
        "Abspielen",
        "Videos und Musik ansehen und anhören, auch grosse Filme",
    ),
    meta(
        Panel::Downloader,
        "downloader",
        "herunterladen",
        "Herunterladen",
        "Ein Video oder Lied von einer Adresse holen",
    ),
    meta(
        Panel::Devices,
        "devices",
        "geraete",
        "Geräte",
        "Dateien direkt an Ihr Handy oder Ihren Rechner senden",
    ),
    meta(
        Panel::Converter,
        "converter",
        "umwandeln",
        "Umwandeln",
        "In ein anderes Dateiformat bringen — etwa Video zu MP3",
    ),
    meta(
        Panel::Video,
        "video",
        "video",
        "Video",
        "Schneiden, drehen, Farbe, Blenden, Tempo, Ton",
    ),
    meta(
        Panel::Images,
        "images",
        "bilder",
        "Bilder",
        "Skalieren, zuschneiden, umwandeln, viele auf einmal",
    ),
    meta(
        Panel::Subtitles,
        "subtitles",
        "untertitel",
        "Untertitel",
        "Gesprochenes als Text, SRT-Datei oder direkt im Video",
    ),
    meta(
        Panel::Audio,
        "audio",
        "ton",
        "Ton",
        "Schneiden, einfügen, Filter, Rauschen, Hall, Tonhöhe, Tempo",
    ),
    meta(
        Panel::Mix,
        "mix",
        "mischen",
        "Mischen",
        "Stimme und Musik zusammen, die Musik weicht beim Sprechen",
    ),
    meta(
        Panel::Stems,
        "stems",
        "spuren-trennen",
        "Spuren trennen",
        "Gesang, Schlagzeug und Bass als einzelne Dateien",
    ),
    meta(
        Panel::Normalize,
        "normalize",
        "lautstaerke",
        "Lautstärke",
        "So laut machen wie im Radio, ohne zu übersteuern",
    ),
    meta(
        Panel::Sampler,
        "sampler",
        "zerschneiden",
        "Zerschneiden",
        "In Schläge zerlegen, auf Pads legen und einen Beat daraus bauen",
    ),
    meta(
        Panel::Harmony,
        "harmony",
        "tonart",
        "Tonart",
        "Tonart, Tempo, Akkorde und die Melodie als MIDI",
    ),
    meta(
        Panel::Screen,
        "screen",
        "bildschirm",
        "Bildschirm",
        "Bildschirm oder ein Fenster mit Ton als Video aufnehmen",
    ),
    meta(
        Panel::Phone,
        "phone",
        "spiegeln",
        "Handy spiegeln",
        "Den Bildschirm Ihres Android-Handys hier zeigen und mit der Maus bedienen",
    ),
    meta(
        Panel::Mic,
        "mic",
        "mikrofon",
        "Mikrofon",
        "Testen, Geräte wählen und für Podcast, Stream oder Musik einstellen",
    ),
];

impl Panel {
    pub fn meta(self) -> &'static PanelMeta {
        PANELS
            .iter()
            .find(|m| m.panel == self)
            .expect("every panel has a row in PANELS")
    }
    /// The tool a web `PanelId` names.
    pub fn from_id(id: &str) -> Option<Panel> {
        PANELS.iter().find(|m| m.id == id).map(|m| m.panel)
    }
    pub fn label(self) -> &'static str {
        self.meta().label
    }
    pub fn slug(self) -> &'static str {
        self.meta().slug
    }
    pub fn index(self) -> usize {
        PANELS
            .iter()
            .position(|m| m.panel == self)
            .expect("every panel has a row in PANELS")
    }
    /// The tool an address names; an unknown one is the start, as on the web.
    pub fn from_slug(slug: &str) -> Panel {
        let slug = slug.trim_start_matches('#');
        PANELS
            .iter()
            .find(|m| m.slug == slug)
            .map_or(Panel::Start, |m| m.panel)
    }
    /// The tool next to this one in the row (wrapping), for the arrow keys and swipes.
    pub fn step(self, by: i32) -> Panel {
        let n = PANELS.len() as i32;
        PANELS[(self.index() as i32 + by).rem_euclid(n) as usize].panel
    }
}

/// Which side a tool comes from: from the right when its tab lies after the one just left, else from the
/// left; `0` when nothing changes.
pub fn slide_from(from: Panel, to: Panel) -> i32 {
    (to.index() as i32 - from.index() as i32).signum()
}

/// How the rack groups the places: a task on its own, or a group of tools under one heading.
#[derive(Clone, Copy, Debug)]
pub enum Entry {
    Single(Panel),
    Group {
        id: &'static str,
        label: &'static str,
        panels: &'static [Panel],
    },
}

pub const ENTRIES: [Entry; 9] = [
    Entry::Single(Panel::Start),
    Entry::Single(Panel::Merkliste),
    Entry::Single(Panel::Folder),
    Entry::Single(Panel::Player),
    Entry::Single(Panel::Downloader),
    Entry::Single(Panel::Devices),
    Entry::Group {
        id: "bearbeiten",
        label: "Bearbeiten",
        panels: &[
            Panel::Converter,
            Panel::Video,
            Panel::Images,
            Panel::Subtitles,
        ],
    },
    Entry::Group {
        id: "ton",
        label: "Ton",
        panels: &[
            Panel::Audio,
            Panel::Mix,
            Panel::Stems,
            Panel::Normalize,
            Panel::Sampler,
            Panel::Harmony,
        ],
    },
    Entry::Group {
        id: "aufnehmen",
        label: "Aufnehmen",
        panels: &[Panel::Screen, Panel::Phone, Panel::Mic],
    },
];

impl Entry {
    pub fn label(&self) -> &'static str {
        match self {
            Entry::Single(p) => p.label(),
            Entry::Group { label, .. } => label,
        }
    }
    pub fn id(&self) -> &'static str {
        match self {
            Entry::Single(p) => p.meta().id,
            Entry::Group { id, .. } => id,
        }
    }
    pub fn panels(&self) -> &[Panel] {
        match self {
            Entry::Single(p) => std::slice::from_ref(p),
            Entry::Group { panels, .. } => panels,
        }
    }
    pub fn holds(&self, panel: Panel) -> bool {
        self.panels().contains(&panel)
    }
}

/// The entry a tool stands in.
pub fn entry_of(panel: Panel) -> usize {
    ENTRIES.iter().position(|e| e.holds(panel)).unwrap_or(0)
}

