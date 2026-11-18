//! The shared Merkliste in Drive as the service's source.

use sondra_core::merkliste::{read_shared, Shared};
use sondra_daemon::ports::Library;

use crate::client::{DriveClient, TokenSource};
use crate::DriveError;

/// `Sondra/Merkliste/Sondra-Merkliste.sqlite`, or the older `….json` next to it.
const FOLDERS: [&str; 2] = ["Sondra", "Merkliste"];
const FILE: &str = "Sondra-Merkliste.sqlite";
const LEGACY_FILE: &str = "Sondra-Merkliste.json";

pub struct DriveLibrary<T: TokenSource> {
    client: DriveClient<T>,
}

impl<T: TokenSource> DriveLibrary<T> {
    pub fn new(client: DriveClient<T>) -> Self {
        Self { client }
    }

    fn fetch(&self) -> Result<Vec<u8>, DriveError> {
        let folder = self
            .client
            .folder_path(&FOLDERS)?
            .ok_or_else(|| DriveError::Missing("Sondra/Merkliste".into()))?;
        let file = match self.client.find_file(&folder, FILE)? {
            Some(file) => file,
            None => self
                .client
                .find_file(&folder, LEGACY_FILE)?
                .ok_or_else(|| DriveError::Missing(FILE.into()))?,
        };
        self.client.download(&file.id)
    }
}

impl<T: TokenSource> Library for DriveLibrary<T> {
    fn read(&self) -> Result<Shared, String> {
        let bytes = self.fetch().map_err(|error| match error {
            DriveError::Missing(what) => {
                format!("Auf Google Drive liegt noch keine Merkliste ({what} fehlt).")
            }
            DriveError::Unauthorized => "Bei Google Drive ist niemand angemeldet.".to_owned(),
            DriveError::Offline(why) => format!("Google Drive ist nicht erreichbar ({why})."),
            other => format!("Google Drive: {other}"),
        })?;
        read_shared(&bytes)
            .map_err(|e| format!("Die Datei auf Google Drive ist keine Merkliste ({e})."))
    }
}
