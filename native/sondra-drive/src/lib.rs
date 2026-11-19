//! Google Drive for the background service.
//!
//! * [`auth`]: the sign-in the way Google asks of installed programs — the system
//!   browser, one request on a port of this computer, PKCE (RFC 8252) — and the
//!   refresh token that keeps it, never written down in the clear on Windows.
//! * [`client`]: a read-only Drive client. Only the scope `drive.file`: the service
//!   sees the files Sondra put there, nothing else.
//! * [`write`]: what the devices add — search by notes, folders, small files, replace, delete.
//! * [`library`]: the shared Merkliste in Drive as the service's source.
//!
//! The behaviour follows `desktop/googleDrive.mjs` and `src/lib/driveClient.ts`
//! line by line, so that the apps and the service are one account's two devices.

pub mod auth;
pub mod client;
#[doc(hidden)]
pub mod fake;
pub mod keystore;
pub mod library;
pub mod stream;
pub mod write;

pub use auth::{Account, ClientCredentials, Endpoints, DRIVE_SCOPE};
pub use client::{DriveClient, DriveFile, TokenSource};
pub use library::DriveLibrary;
pub use stream::DriveStream;
pub use write::{notes_query, Found};

/// What can go wrong, in the words the apps use.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DriveError {
    /// No client (id and secret) has been set up.
    #[error("not-configured")]
    NotConfigured,
    /// Not signed in, or Google withdrew the grant: sign in again.
    #[error("unauthorized")]
    Unauthorized,
    #[error("offline: {0}")]
    Offline(String),
    #[error("denied")]
    Denied,
    #[error("timeout")]
    Timeout,
    #[error("cancelled")]
    Cancelled,
    /// Signed in without the Drive scope.
    #[error("scope")]
    Scope,
    /// Drive said no such file or folder.
    #[error("missing: {0}")]
    Missing(String),
    #[error("failed: {0}")]
    Failed(String),
}
