//! `sondra-dienst`: the background service. Checks the shared Merkliste for new episodes and
//! fetches them as chosen. Nothing is chosen until the person chooses it.
//!
//! This is the first, command-line face of it; the settings window and the tray icon come with the
//! app (wave 4). The settings live in `einstellungen.json` next to the log.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use sondra_daemon::round::Ports;
use sondra_download::Cancel;
use sondra_drive::keystore::FileKeyStore;
use sondra_drive::{Account, ClientCredentials, DriveClient, DriveLibrary, Endpoints};
use sondra_extract::fetch::UreqFetch;
use sondra_service::runner::{
    self, data_dir, key_path, load_config, log_path, run_loop, run_once, state_path,
    RecordingLibrary,
};
use sondra_service::{
    autostart, ConfiguredFetcher, InstanceLock, SystemHost, SystemTrash, WebChecker,
};

/// Google's "Desktop app" client, baked in at build time (as in the Electron app).
const CLIENT_ID: Option<&str> = option_env!("SONDRA_GOOGLE_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("SONDRA_GOOGLE_CLIENT_SECRET");
const AUTOSTART_NAME: &str = "Sondra Dienst";

const HELP: &str = "\
Sondra-Dienst — lädt neue Folgen im Hintergrund, so wie Sie es gewählt haben.

  sondra-dienst anmelden        bei Google Drive anmelden (öffnet den Browser)
  sondra-dienst trennen         die Anmeldung wieder lösen
  sondra-dienst status          zeigt, was gewählt ist und was zuletzt geschah
  sondra-dienst einmal          eine Runde jetzt
  sondra-dienst laufen          Runden, bis das Programm beendet wird
  sondra-dienst autostart an    mit Windows starten (aus: wieder weg)

Gewählt wird in einstellungen.json im Ordner des Dienstes; solange dort nichts steht,
wird nichts geladen, gelöscht oder wachgehalten.";

fn account(dir: &std::path::Path) -> Arc<Account> {
    let client = match (CLIENT_ID, CLIENT_SECRET) {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => {
            Some(ClientCredentials {
                id: id.to_owned(),
                secret: secret.to_owned(),
            })
        }
        _ => None,
    };
    Arc::new(Account::new(
        client,
        Endpoints::default(),
        Box::new(FileKeyStore::new(key_path(dir))),
    ))
}

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let result = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(not(windows))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

fn shutdown_computer() {
    #[cfg(windows)]
    {
        // A minute to change one's mind: `shutdown /a` takes it back.
        let _ = std::process::Command::new("shutdown")
            .args([
                "/s",
                "/t",
                "60",
                "/c",
                "Sondra: alle gewählten Folgen sind geladen.",
            ])
            .status();
    }
    #[cfg(not(windows))]
    eprintln!("(Herunterfahren gibt es nur unter Windows.)");
}

fn ffmpeg_next_to_the_program() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let candidate = exe.parent()?.join(name);
    candidate.is_file().then_some(candidate)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = data_dir();
    let account = account(&dir);
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["anmelden"] => {
            if !account.configured() {
                eprintln!("Dieses Programm wurde ohne Google-Zugang gebaut (SONDRA_GOOGLE_CLIENT_ID / _SECRET).");
                return ExitCode::FAILURE;
            }
            println!("Der Browser öffnet sich. Melden Sie sich dort bei Google an und erlauben Sie Sondra den Zugriff auf seine eigenen Dateien.");
            match account.connect(open_in_browser) {
                Ok(()) => {
                    println!(
                        "Angemeldet.{}",
                        if account.lasting() {
                            ""
                        } else {
                            " (Gilt nur, bis das Programm endet: dieser Rechner kann es nicht verschlüsselt ablegen.)"
                        }
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("Anmeldung nicht möglich: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        ["trennen"] => {
            account.disconnect();
            println!("Die Anmeldung bei Google ist gelöst.");
            ExitCode::SUCCESS
        }
        ["status"] => status(&dir, &account),
        ["autostart", mode @ ("an" | "aus")] => {
            let result = if *mode == "an" {
                let exe = std::env::current_exe()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default();
                autostart::enable(AUTOSTART_NAME, &format!("\"{exe}\" laufen"))
            } else {
                autostart::disable(AUTOSTART_NAME)
            };
            match result {
                Ok(()) => {
                    println!(
                        "Autostart ist {}.",
                        if *mode == "an" { "an" } else { "aus" }
                    );
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("Autostart nicht möglich: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        [mode @ ("einmal" | "laufen")] => {
            let Some(_lock) = (match InstanceLock::acquire(&dir) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("Der Ordner des Dienstes ist nicht benutzbar: {e}");
                    return ExitCode::FAILURE;
                }
            }) else {
                eprintln!("Der Dienst läuft schon.");
                return ExitCode::FAILURE;
            };
            if !account.connected() {
                eprintln!(
                    "Bei Google Drive ist niemand angemeldet. Zuerst: sondra-dienst anmelden"
                );
                return ExitCode::FAILURE;
            }
            let library = RecordingLibrary::new(DriveLibrary::new(DriveClient::new(
                account.clone(),
                account.api(),
            )));
            let checker = WebChecker {
                fetch: UreqFetch::default(),
            };
            let stop = Cancel::new();
            let mut fetcher = ConfiguredFetcher::new(dir.clone(), UreqFetch::default);
            fetcher.ffmpeg = ffmpeg_next_to_the_program();
            fetcher.cancel = stop.clone();
            let ports = Ports {
                library: &library,
                checker: &checker,
                fetcher: &fetcher,
                trash: &SystemTrash,
                host: &SystemHost,
            };
            let titles = || library.titles();
            if *mode == "einmal" {
                match run_once(&dir, &ports, &titles) {
                    Ok(report) => {
                        for line in runner::describe(&report, &library.titles()) {
                            println!("{line}");
                        }
                        ExitCode::SUCCESS
                    }
                    Err(e) => {
                        eprintln!("Runde nicht möglich: {e}");
                        ExitCode::FAILURE
                    }
                }
            } else {
                println!(
                    "Der Dienst läuft. Beenden mit Strg+C; was geladen wird, steht in {}",
                    log_path(&dir).display()
                );
                run_loop(&dir, &ports, &titles, &stop, &shutdown_computer);
                ExitCode::SUCCESS
            }
        }
        [] | ["hilfe"] | ["--help"] | ["-h"] => {
            println!("{HELP}");
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("Unbekannt: {}\n\n{HELP}", other.join(" "));
            ExitCode::FAILURE
        }
    }
}

fn status(dir: &std::path::Path, account: &Account) -> ExitCode {
    println!("Ordner des Dienstes: {}", dir.display());
    println!(
        "Google Drive: {}",
        if !account.configured() {
            "dieses Programm hat keinen Google-Zugang eingebaut"
        } else if account.connected() {
            "angemeldet"
        } else {
            "nicht angemeldet"
        }
    );
    match load_config(dir) {
        Ok(c) => {
            println!(
                "Serien zum selbstständigen Laden: {}",
                if c.auto_series.is_empty() {
                    "keine gewählt".to_owned()
                } else {
                    c.auto_series.iter().cloned().collect::<Vec<_>>().join(", ")
                }
            );
            println!(
                "Ordner: {}",
                c.folder.as_deref().unwrap_or("keiner gewählt")
            );
            println!(
                "Auf Vorrat: {} Folgen · Speichergrenze: {}",
                c.ahead,
                c.storage_limit_gb
                    .map_or("keine".into(), |g| format!("{g} GB"))
            );
        }
        Err(e) => println!("Einstellungen: {e}"),
    }
    if let Ok(state) = sondra_core::state::State::load(&state_path(dir)) {
        println!(
            "Geladen und noch da: {} Folgen, {:.1} GB",
            state.fetched.len(),
            state.total_size() as f64 / 1_073_741_824.0
        );
    }
    if let Ok(text) = std::fs::read_to_string(log_path(dir)) {
        println!("\nZuletzt:");
        for line in text
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            println!("  {line}");
        }
    }
    println!(
        "Autostart: {}",
        if autostart::is_enabled(AUTOSTART_NAME) {
            "an"
        } else {
            "aus"
        }
    );
    ExitCode::SUCCESS
}
