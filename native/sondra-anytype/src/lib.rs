//! The Merkliste in Anytype (`desktop/anytype.mjs`, `src/lib/anytype.ts`): one page, „Sondra · Merkliste“,
//! in a space the person picks, read and written through Anytype's local API on this computer.
//!
//! Two dialects. `/v1` is what every Anytype since 0.46.7 speaks. Since 0.51.6 the pairing lets the person
//! hand out only some spaces, and `/v1` refuses such a key outright (403 `v1_not_available_for_scoped_keys`);
//! `/v2` takes it. The first such refusal switches this link to `/v2` for good — a key that may see
//! everything stays on `/v1`, where it always worked.
//!
//! The key Anytype hands out is kept like Drive's token (DPAPI on Windows); the rest of the link — space,
//! page, dialect — is a small file beside it.

pub mod client;
#[doc(hidden)]
pub mod fake;
pub mod page;
pub mod sync;

pub use client::{Anytype, Config, Note, Space, Status, ANYTYPE_API, ANYTYPE_VERSION, PAGE_NAME};
pub use page::{markdown_runs, merkliste_from_markdown, merkliste_to_markdown, Remote};
pub use sync::{load_from_anytype, sync_merkliste, Loaded, Sync};

/// What can go wrong, as the page can name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    /// Anytype is closed or does not answer.
    Unreachable,
    /// The key was withdrawn (or there is none): a new code is needed.
    Unauthorized,
    NoSpace,
    WrongCode,
    /// The page is gone (404, 410).
    Missing,
    Busy,
    Rejected,
    /// Reading rights only, or paired for reading; the key stays.
    Forbidden,
    /// A space the key was not given when it was paired (`/v2`).
    NotGranted,
    /// Internal: a key bound to chosen spaces on `/v1`.
    ScopedKey,
    /// The data block on the page cannot be read; never written over.
    Unreadable,
    Failed,
}

impl Kind {
    /// The code the web app's page uses.
    pub fn code(self) -> &'static str {
        match self {
            Kind::Unreachable => "unreachable",
            Kind::Unauthorized => "unauthorized",
            Kind::NoSpace => "no-space",
            Kind::WrongCode => "wrong-code",
            Kind::Missing => "missing",
            Kind::Busy => "busy",
            Kind::Rejected => "rejected",
            Kind::Forbidden => "forbidden",
            Kind::NotGranted => "not-granted",
            Kind::ScopedKey => "scoped-key",
            Kind::Unreadable => "unreadable",
            Kind::Failed => "failed",
        }
    }

    /// What each failure means, in a sentence (`ANYTYPE_PROBLEM`).
    pub fn problem(self) -> &'static str {
        match self {
            Kind::Unreachable => "Anytype antwortet auf diesem Rechner gerade nicht. Abgeglichen wird, sobald es wieder offen ist.",
            Kind::Unauthorized => "Anytype hat den Zugang zurückgezogen. Bitte neu verbinden.",
            Kind::NoSpace => "Es ist noch kein Space gewählt.",
            Kind::WrongCode => "Dieser Code passt nicht. Fordern Sie einen neuen an.",
            Kind::Missing => "Die Seite in Anytype ist nicht mehr da; beim nächsten Abgleich legt Sondra sie neu an.",
            Kind::Busy => "Anytype ist gerade beschäftigt. Gleich noch einmal.",
            Kind::Rejected | Kind::ScopedKey => "Anytype hat die Anfrage abgelehnt.",
            Kind::Forbidden => "In diesem Space darf Sondra nichts anlegen oder ändern — Sie haben dort nur Leserechte, oder Sondra wurde beim Verbinden nur Lesen erlaubt. Wählen Sie einen anderen Space oder verbinden Sie neu.",
            Kind::NotGranted => "Diesen Space hat Anytype für Sondra nicht freigegeben. Wählen Sie einen freigegebenen Space, oder verbinden Sie neu und geben Sie ihn beim Bestätigen in Anytype frei.",
            Kind::Unreadable => "Der Datenblock auf der Seite in Anytype lässt sich nicht lesen. Sondra schreibt nicht darüber, damit dort nichts verloren geht. Wählen Sie unter „Anytype“ eine andere Notiz oder legen Sie eine neue an.",
            Kind::Failed => "Der Abgleich mit Anytype ist gescheitert. Die Einzelheiten stehen in sondra.log.",
        }
    }
}

/// A failure with Anytype's own reason, for the log and the dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub kind: Kind,
    pub detail: String,
}

impl Error {
    pub fn new(kind: Kind, detail: impl Into<String>) -> Error {
        Error { kind, detail: detail.into() }
    }
}

impl From<Kind> for Error {
    fn from(kind: Kind) -> Error {
        Error { kind, detail: String::new() }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.detail.is_empty() {
            write!(f, "{}", self.kind.code())
        } else {
            write!(f, "{} ({})", self.kind.code(), self.detail)
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;
