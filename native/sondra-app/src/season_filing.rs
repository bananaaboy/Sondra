//! „In Staffel einordnen“ (the website's `SeasonFiling.tsx`): chosen files in Drive are given a series — one of the
//! Merkliste, or a new name, which then goes onto the list —, a season (0 = films) and, each, the episode it is. The
//! window shows what comes out — `Sondra / Serien / <Titel> / Staffel n` with „+ 5 Folgen“ —, and per file where its
//! number comes from („schon eingeordnet“, „Nummer aus dem Namen“, „weitergezählt — bitte prüfen“). A number twice
//! and one past the end of the season are said at the line; „Der Reihe nach nummerieren“ and „Wie erkannt“ set them
//! anew; a tick leaves a file out. Nothing is renamed; each file moves with a note of what it is.

use gpui::{div, prelude::*, px, AnyElement, Context, Entity};
use sondra_drive::client::DriveClient;
use sondra_merk::folder::{hint_properties, match_file, season_path, FolderFile};
use sondra_merk::matching::{guess_episode, EpisodeHint};
use sondra_merk::progress::seasons_of;
use sondra_merk::Item;
use sondra_ui::{NoticeKind, TextField, Ui};

use crate::shell::Shell;

/// Where a file's number comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum From {
    /// It is filed already as this series and season.
    Filed,
    Name,
    /// Neither said it: one more than the file before — to be checked.
    Counted,
}

impl From {
    pub fn said(self) -> &'static str {
        match self {
            From::Filed => "schon eingeordnet",
            From::Name => "Nummer aus dem Namen",
            From::Counted => "weitergezählt — bitte prüfen",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub file: FolderFile,
    pub number: i64,
    pub from: From,
    /// Left out with its tick taken away.
    pub keep: bool,
}

/// The numbers as recognised: as filed for this series and season, else from the name, else counted on.
pub fn recognised(files: &[FolderFile], items: &[Item], series: Option<&str>, season: i64) -> Vec<Row> {
    let mut last = 0;
    files
        .iter()
        .map(|file| {
            // Filed is what carries the note or lies in „Serien/<Titel>/Staffel n“ — not what only its name tells of.
            let placed = file.drive.as_ref().is_some_and(|d| d.hint.is_some()) || file.dir.split('/').any(|d| d == "Serien");
            let filed = series.filter(|_| placed).and_then(|id| match_file(file, items).filter(|m| m.item == id && m.season == season)).map(|m| m.episode);
            let (number, from) = match (filed, guess_episode(&file.name).map(|g| g.episode).filter(|e| *e > 0)) {
                (Some(e), _) => (e, From::Filed),
                (None, Some(e)) => (e, From::Name),
                (None, None) => (last + 1, From::Counted),
            };
            last = number;
            Row { file: file.clone(), number, from, keep: true }
        })
        .collect()
}

/// „Der Reihe nach nummerieren“: the kept files one after another from the first one's number.
pub fn in_order(rows: &mut [Row]) {
    let mut next = rows.iter().find(|r| r.keep).map_or(1, |r| r.number.max(1));
    for row in rows.iter_mut().filter(|r| r.keep) {
        row.number = next;
        next += 1;
    }
}

/// What is wrong at a line: a number twice, or one past the end of the season.
pub fn problem(rows: &[Row], index: usize, season_len: Option<i64>) -> Option<String> {
    let row = rows.get(index).filter(|r| r.keep)?;
    if rows.iter().enumerate().any(|(i, r)| i != index && r.keep && r.number == row.number) {
        return Some(format!("Nummer {} kommt zweimal vor", row.number));
    }
    if let Some(len) = season_len.filter(|l| row.number > *l) {
        return Some(format!("über das Ende der Staffel ({len})"));
    }
    None
}

/// The series the files suggest: the one most of them already are.
pub fn suggested(files: &[FolderFile], items: &[Item]) -> Option<String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for m in files.iter().filter_map(|f| match_file(f, items)) {
        match counts.iter_mut().find(|(id, _)| *id == m.item) {
            Some((_, n)) => *n += 1,
            None => counts.push((m.item, 1)),
        }
    }
    counts.into_iter().max_by_key(|(_, n)| *n).map(|(id, _)| id)
}

/// The window while it is open.
pub struct Filing {
    pub files: Vec<FolderFile>,
    /// A series of the list, or `None` for the new name typed.
    pub series: Option<String>,
    pub new_name: Entity<TextField>,
    pub season: i64,
    pub rows: Vec<Row>,
    pub problem: Option<String>,
}

impl Shell {
    /// Opens „In Staffel einordnen“ for the chosen files of a Drive folder.
    pub fn filing_open(&mut self, cx: &mut Context<Self>) {
        let Some(scan) = self.folder.scan.as_ref().filter(|s| s.drive) else { return };
        let files: Vec<FolderFile> = scan.files.iter().filter(|f| self.folder.selected.contains(&f.path) && f.drive.is_some()).cloned().collect();
        if files.is_empty() {
            return;
        }
        let series = suggested(&files, &self.merk.items);
        let season = series.as_ref().and_then(|id| files.iter().filter_map(|f| match_file(f, &self.merk.items)).find(|m| &m.item == id).map(|m| m.season)).unwrap_or(1);
        let colors = self.mode.colors();
        let new_name = cx.new(|cx| TextField::new(cx, colors, "Name der neuen Serie").placeholder("Kommt auf die Merkliste"));
        let rows = recognised(&files, &self.merk.items, series.as_deref(), season);
        self.folder.filing = Some(Filing { files, series, new_name, season, rows, problem: None });
        cx.notify();
    }

    /// The series or the season changed: the numbers are recognised anew for it.
    fn filing_recognise(&mut self) {
        let items = self.merk.items.clone();
        if let Some(f) = self.folder.filing.as_mut() {
            let kept: Vec<bool> = f.rows.iter().map(|r| r.keep).collect();
            f.rows = recognised(&f.files, &items, f.series.as_deref(), f.season);
            for (row, keep) in f.rows.iter_mut().zip(kept) {
                row.keep = keep;
            }
        }
    }

    pub(crate) fn filing_change(&mut self, change: impl FnOnce(&mut Filing), again: bool, cx: &mut Context<Self>) {
        if let Some(f) = self.folder.filing.as_mut() {
            change(f);
            f.problem = None;
        }
        if again {
            self.filing_recognise();
        }
        cx.notify();
    }

    /// For tests: the numbers and where they come from, the kept ones.
    pub fn filing_rows(&self) -> Vec<(String, i64, &'static str, bool)> {
        self.folder.filing.as_ref().map_or_else(Vec::new, |f| f.rows.iter().map(|r| (r.file.name.clone(), r.number, r.from.said(), r.keep)).collect())
    }

    /// For tests: the field of a new series' name.
    pub fn filing_name_field(&self) -> Option<Entity<TextField>> {
        self.folder.filing.as_ref().map(|f| f.new_name.clone())
    }

    /// „Einordnen“: every kept file into `Sondra/Serien/<Titel>/Staffel n`, with the note of what it is; a new name
    /// goes onto the Merkliste first. Then the folder is read again.
    pub fn filing_do(&mut self, cx: &mut Context<Self>) {
        let (Some(drive), Some(f)) = (self.drive.clone(), self.folder.filing.as_ref()) else { return };
        let typed = f.new_name.read(cx).text().trim().to_string();
        if (0..f.rows.len()).any(|i| problem(&f.rows, i, None).is_some()) {
            if let Some(f) = self.folder.filing.as_mut() {
                f.problem = Some("Eine Nummer kommt zweimal vor. „Der Reihe nach nummerieren“ hilft.".into());
            }
            cx.notify();
            return;
        }
        let (id, title) = match &f.series {
            Some(id) => match self.merk.items.iter().find(|i| &i.id == id) {
                Some(item) => (item.id.clone(), item.title.clone()),
                None => return,
            },
            None if typed.is_empty() => {
                if let Some(f) = self.folder.filing.as_mut() {
                    f.problem = Some("Bitte eine Serie wählen oder einen Namen eintragen.".into());
                }
                cx.notify();
                return;
            }
            None => {
                let mut ids = sondra_merk::normalize::Context::system();
                let raw = serde_json::json!({ "title": typed, "status": "watching", "season": f.season.max(1), "episode": 1, "updatedAt": ids.now, "seasons": [{ "number": f.season, "episodes": null, "watched": [] }] });
                let item = sondra_merk::normalize::normalize(&raw, &mut ids);
                let id = item.id.clone();
                self.merk.items.insert(0, item);
                self.merk.save();
                (id, typed)
            }
        };
        let season = f.season;
        let moves: Vec<(String, Option<String>, i64)> = f.rows.iter().filter(|r| r.keep).filter_map(|r| r.file.drive.as_ref().map(|d| (d.id.clone(), d.parent.clone(), r.number))).collect();
        if moves.is_empty() {
            return;
        }
        self.folder.filing = None;
        self.folder.busy = true;
        cx.notify();
        Self::in_background(
            cx,
            move || -> Result<usize, String> {
                let client = DriveClient::new(drive.tokens.clone(), drive.api.clone());
                let [serien, series, folder] = season_path(&title, season);
                let target = client.ensure_path(&["Sondra", &serien, &series, &folder]).map_err(|e| crate::drive_hub::says(&e))?;
                for (file, parent, episode) in &moves {
                    let hint = EpisodeHint { series: id.clone(), season, episode: *episode };
                    client.move_file(file, &target, parent.as_deref(), &hint_properties(&hint)).map_err(|e| crate::drive_hub::says(&e))?;
                }
                Ok(moves.len())
            },
            |shell, result, cx| {
                shell.folder.busy = false;
                match result {
                    Ok(n) => {
                        shell.folder.notice = Some(format!("{n} {} eingeordnet (Sondra/Serien).", if n == 1 { "Datei" } else { "Dateien" }));
                        shell.open_drive_folder(cx);
                    }
                    Err(why) => {
                        shell.folder.notice = Some(why);
                        cx.notify();
                    }
                }
            },
        );
    }

    /// The window.
    pub(crate) fn filing_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let f = self.folder.filing.as_ref()?;
        let me = cx.entity();
        let item = f.series.as_ref().and_then(|id| self.merk.items.iter().find(|i| &i.id == id));
        let title = item.map(|i| i.title.clone()).unwrap_or_else(|| {
            let typed = f.new_name.read(cx).text().trim().to_string();
            if typed.is_empty() { "Neue Serie".into() } else { typed }
        });
        let seasons = item.map(seasons_of).unwrap_or_default();
        let season_len = seasons.iter().find(|s| s.number == f.season).and_then(|s| s.episodes);
        let kept = f.rows.iter().filter(|r| r.keep).count();
        let [serien, series_dir, season_dir] = season_path(&title, f.season);

        // What comes out.
        let preview = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(ui.subheading("Wohin"))
            .child(ui.value(format!("Sondra / {serien} / {series_dir} / {season_dir}")))
            .child(ui.hint(format!("+ {kept} {}", if kept == 1 { "Datei" } else { "Dateien" })));

        // The series: the list's, the suggested first, or a new one.
        let mut pills = div().flex().flex_wrap().gap(px(6.));
        let mut order: Vec<&Item> = self.merk.items.iter().collect();
        if let Some(id) = &f.series {
            order.sort_by_key(|i| &i.id != id);
        }
        for it in order.into_iter().take(12) {
            let (me, id) = (me.clone(), it.id.clone());
            let on = f.series.as_deref() == Some(it.id.as_str());
            pills = pills.child(ui.chip(format!("einordnen-serie-{}", it.id), it.title.clone(), on).accessible_name(format!("Serie {}", it.title)).on_click(move |_, app| {
                let id = id.clone();
                me.update(app, |shell, cx| shell.filing_change(|f| f.series = Some(id), true, cx))
            }));
        }
        {
            let me = me.clone();
            pills = pills.child(ui.chip("einordnen-neu", "Neue Serie", f.series.is_none()).on_click(move |_, app| me.update(app, |shell, cx| shell.filing_change(|f| f.series = None, true, cx))));
        }
        let mut series_block = div().flex().flex_col().gap(px(8.)).child(ui.subheading("Serie")).child(pills);
        if f.series.is_none() {
            series_block = series_block.child(div().w(px(320.)).child(f.new_name.clone()));
        }

        // The season: the known ones, a new one after them, the films.
        let mut season_pills = div().flex().flex_wrap().items_center().gap(px(6.));
        let mut numbers: Vec<i64> = seasons.iter().map(|s| s.number).collect();
        let next = numbers.iter().copied().max().unwrap_or(0).max(0) + 1;
        if !numbers.contains(&f.season) {
            numbers.push(f.season);
        }
        numbers.sort_by_key(|n| if *n == 0 { i64::MAX } else { *n });
        for n in numbers {
            let me = me.clone();
            let label = if n == 0 { "Filme".to_string() } else { format!("Staffel {n}") };
            season_pills = season_pills.child(ui.chip(format!("einordnen-staffel-{n}"), label, f.season == n).on_click(move |_, app| me.update(app, |shell, cx| shell.filing_change(|f| f.season = n, true, cx))));
        }
        if !seasons.iter().any(|s| s.number == next) && f.season != next {
            let me = me.clone();
            season_pills = season_pills.child(ui.chip("einordnen-staffel-neu", format!("Neu: Staffel {next}"), false).on_click(move |_, app| me.update(app, |shell, cx| shell.filing_change(|f| f.season = next, true, cx))));
        }

        // The files.
        let unit = if f.season == 0 { "Film" } else { "Folge" };
        let mut rows = div().flex().flex_col().gap(px(8.));
        for (i, row) in f.rows.iter().enumerate() {
            let (keep, less, more) = (me.clone(), me.clone(), me.clone());
            let wrong = problem(&f.rows, i, season_len);
            let mut line = div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .child(ui.chip(format!("einordnen-mit-{i}"), if row.keep { "✓" } else { "–" }, row.keep).accessible_name(format!("{} mitnehmen", row.file.name)).on_click(move |_, app| keep.update(app, |shell, cx| shell.filing_change(|f| f.rows[i].keep = !f.rows[i].keep, false, cx))))
                .child(div().w(px(260.)).child(ui.value(row.file.name.clone())))
                .child(ui.button(format!("einordnen-weniger-{i}"), "−").small().ghost().accessible_name(format!("{}: eine Nummer weniger", row.file.name)).on_click(move |_, app| less.update(app, |shell, cx| shell.filing_change(|f| f.rows[i].number = (f.rows[i].number - 1).max(1), false, cx))))
                .child(ui.value(format!("{unit} {}", row.number)))
                .child(ui.button(format!("einordnen-mehr-{i}"), "+").small().ghost().accessible_name(format!("{}: eine Nummer mehr", row.file.name)).on_click(move |_, app| more.update(app, |shell, cx| shell.filing_change(|f| f.rows[i].number += 1, false, cx))))
                .child(ui.hint(row.from.said()));
            if let Some(w) = wrong {
                line = line.child(ui.hint(format!("! {w}")));
            }
            rows = rows.child(line);
        }
        let (order_me, again_me) = (me.clone(), me.clone());
        let tools = div()
            .flex()
            .flex_wrap()
            .gap(px(8.))
            .child(ui.button("einordnen-reihe", "Der Reihe nach nummerieren").small().on_click(move |_, app| order_me.update(app, |shell, cx| shell.filing_change(|f| in_order(&mut f.rows), false, cx))))
            .child(ui.button("einordnen-erkannt", "Wie erkannt").small().ghost().on_click(move |_, app| again_me.update(app, |shell, cx| shell.filing_change(|_| {}, true, cx))));

        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(preview)
            .child(series_block)
            .child(div().flex().flex_col().gap(px(8.)).child(ui.subheading("Staffel")).child(season_pills))
            .child(div().flex().flex_col().gap(px(8.)).child(ui.subheading("Dateien")).child(rows).child(tools))
            .child(ui.hint("Umbenannt wird nichts. Jede Datei wandert in den Ordner der Staffel und trägt eine Notiz, welche Folge sie ist."));
        if let Some(p) = &f.problem {
            body = body.child(ui.notice(NoticeKind::Warning, p.clone()));
        }
        let (go, close, away) = (me.clone(), me.clone(), me.clone());
        Some(
            ui.dialog("in-staffel-einordnen", "In Staffel einordnen")
                .width(760.)
                .child(body)
                .action(ui.button("einordnen-abbrechen", "Abbrechen").ghost().on_click(move |_, app| close.update(app, |shell, cx| {
                    shell.folder.filing = None;
                    cx.notify();
                })))
                .action(ui.button("einordnen-los", format!("{kept} einordnen")).primary().disabled(kept == 0).accessible_name("In Staffel einordnen").on_click(move |_, app| go.update(app, |shell, cx| shell.filing_do(cx))))
                .on_close(move |_, app| away.update(app, |shell, cx| {
                    shell.folder.filing = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sondra_merk::folder::DriveInfo;

    fn file(name: &str) -> FolderFile {
        FolderFile { path: name.into(), name: name.into(), dir: String::new(), size: 1, modified: 0, kind: sondra_merk::folder::kind_from_mime("video/mp4", name), drive: Some(DriveInfo { id: name.into(), mime: "video/mp4".into(), parent: None, hint: None }) }
    }

    #[test]
    fn numbers_come_from_the_name_or_are_counted_on_and_said_where_wrong() {
        let files = [file("Frieren S02E01.mkv"), file("Bonus.mkv"), file("Frieren S02E01 (1).mkv")];
        let mut rows = recognised(&files, &[], None, 2);
        assert_eq!(rows.iter().map(|r| (r.number, r.from)).collect::<Vec<_>>(), vec![(1, From::Name), (2, From::Counted), (1, From::Name)]);
        assert_eq!(problem(&rows, 0, None).as_deref(), Some("Nummer 1 kommt zweimal vor"));
        assert_eq!(problem(&rows, 1, Some(1)).as_deref(), Some("über das Ende der Staffel (1)"));
        rows[1].keep = false;
        in_order(&mut rows);
        assert_eq!(rows.iter().filter(|r| r.keep).map(|r| r.number).collect::<Vec<_>>(), vec![1, 2]);
        assert!(problem(&rows, 0, None).is_none());
    }
}
