//! A folder read, sorted, filtered, selected and set into series — against the web app's answers on a
//! made-up folder (`scripts/make-folder-golden.mts`).

use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::{json, Value};
use sondra_merk::folder::*;
use sondra_merk::matching::EpisodeHint;
use sondra_merk::Item;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/folder.json")).unwrap()
}

fn kind(name: &str) -> AssetKind {
    match name {
        "video" => AssetKind::Video,
        "audio" => AssetKind::Audio,
        "image" => AssetKind::Image,
        "document" => AssetKind::Document,
        "archive" => AssetKind::Archive,
        _ => AssetKind::Unknown,
    }
}

fn file(v: &Value) -> FolderFile {
    FolderFile {
        path: v["path"].as_str().unwrap().into(),
        name: v["name"].as_str().unwrap().into(),
        dir: v["dir"].as_str().unwrap().into(),
        size: v["size"].as_u64().unwrap(),
        modified: v["modified"].as_i64().unwrap(),
        kind: kind(v["kind"].as_str().unwrap()),
        drive: v.get("drive").map(|d| DriveInfo {
            id: d["id"].as_str().unwrap().into(),
            mime: d["mime"].as_str().unwrap().into(),
            parent: d["parent"].as_str().map(String::from),
            hint: d.get("hint").map(|h| EpisodeHint {
                series: h["series"].as_str().unwrap().into(),
                season: h["season"].as_i64().unwrap(),
                episode: h["episode"].as_i64().unwrap(),
            }),
        }),
    }
}

struct World {
    items: Vec<Item>,
    files: Vec<FolderFile>,
    scan: FolderScan,
}

fn world(g: &Value) -> World {
    let items: Vec<Item> = serde_json::from_value(g["items"].clone()).unwrap();
    let files: Vec<FolderFile> = g["files"].as_array().unwrap().iter().map(file).collect();
    let dirs: Vec<String> = g["dirs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d.as_str().unwrap().into())
        .collect();
    let scan = FolderScan {
        name: "Test".into(),
        files: files.clone(),
        dirs,
        truncated: false,
        drive: false,
    };
    World { items, files, scan }
}

fn paths(list: &[FolderFile]) -> Vec<String> {
    list.iter().map(|f| f.path.clone()).collect()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn kinds_names_and_notes_are_the_web_apps() {
    let g = golden();
    for c in g["kinds"].as_array().unwrap() {
        assert_eq!(
            kind_from_mime(c["mime"].as_str().unwrap(), c["name"].as_str().unwrap()),
            kind(c["kind"].as_str().unwrap()),
            "{c}"
        );
    }
    for c in g["names"].as_array().unwrap() {
        let t = c["t"].as_str().unwrap();
        assert_eq!(
            series_folder_name(t),
            c["folder"].as_str().unwrap(),
            "{t:?}"
        );
        assert_eq!(json!(season_path(t, 0)), c["path"]);
        assert_eq!(json!(season_path(t, 3)), c["path2"]);
    }
    for c in g["hints"].as_array().unwrap() {
        let props: HashMap<String, String> = c["p"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().into()))
            .collect();
        let mine = hint_of(&props)
            .map(|h| json!({"series": h.series, "season": h.season, "episode": h.episode}));
        assert_eq!(mine.unwrap_or(Value::Null), c["hint"], "{}", c["p"]);
    }
    let props = hint_properties(&EpisodeHint {
        series: "fr".into(),
        season: 2,
        episode: 5,
    });
    assert_eq!(json!(props), g["hintProps"]);
    assert!(
        is_skipped(".hidden")
            && is_skipped("Thumbs.db")
            && is_skipped("Sondra-Papierkorb")
            && !is_skipped("Film.mp4")
    );
}

#[test]
fn every_view_of_the_folder_is_the_web_apps() {
    let g = golden();
    let w = world(&g);
    let filters = [
        KindFilter::All,
        KindFilter::Video,
        KindFilter::Audio,
        KindFilter::Image,
        KindFilter::Other,
    ];
    let name = |f: &str| match f {
        "alle" => KindFilter::All,
        "video" => KindFilter::Video,
        "audio" => KindFilter::Audio,
        "image" => KindFilter::Image,
        _ => KindFilter::Other,
    };
    let sort = |s: &str| match s {
        "name" => SortKey::Name,
        "modified" => SortKey::Modified,
        "size" => SortKey::Size,
        _ => SortKey::Kind,
    };
    let mut checked = 0;
    for c in g["listings"].as_array().unwrap() {
        let options = ListingOptions {
            dir: c["dir"].as_str().unwrap().into(),
            deep: c["deep"].as_bool().unwrap(),
            filter: name(c["filter"].as_str().unwrap()),
            query: c["query"].as_str().unwrap().into(),
            sort: sort(c["sort"].as_str().unwrap()),
            descending: c["descending"].as_bool().unwrap(),
        };
        let l = listing(&w.scan, &options);
        assert_eq!(paths(&l.files), strings(&c["files"]), "files of {c}");
        let dirs: Vec<Value> = l
            .dirs
            .iter()
            .map(|d| json!([d.path, d.name, d.count, d.size]))
            .collect();
        assert_eq!(Value::Array(dirs), c["dirs"], "dirs of {c}");
        let counts = &c["counts"];
        for (f, key) in filters
            .iter()
            .zip(["alle", "video", "audio", "image", "andere"])
        {
            assert_eq!(
                l.counts[f] as i64,
                counts[key].as_i64().unwrap(),
                "count {key} of {c}"
            );
        }
        checked += 1;
    }
    assert_eq!(checked, 360);
    for c in g["sortedAll"].as_array().unwrap() {
        let sorted = sort_files(
            &w.files,
            sort(c["sort"].as_str().unwrap()),
            c["descending"].as_bool().unwrap(),
        );
        assert_eq!(paths(&sorted), strings(&c["paths"]), "sorted by {c}");
    }
    for c in g["crumbs"].as_array().unwrap() {
        let mine: Vec<Value> = crumbs("Test", c["dir"].as_str().unwrap())
            .iter()
            .map(|(l, p)| json!({"label": l, "path": p}))
            .collect();
        assert_eq!(Value::Array(mine), c["crumbs"]);
    }
}

#[test]
fn clicks_select_the_way_a_file_manager_does() {
    let g = golden();
    let order = strings(&g["selecting"]["order"]);
    let mut selected: BTreeSet<String> = BTreeSet::new();
    let mut anchor: Option<String> = None;
    for step in g["selecting"]["steps"].as_array().unwrap() {
        let (next, a) = click_select(
            &selected,
            &order,
            anchor.as_deref(),
            step["path"].as_str().unwrap(),
            step["toggle"].as_bool().unwrap(),
            step["range"].as_bool().unwrap(),
        );
        selected = next;
        anchor = Some(a);
        assert_eq!(
            selected.iter().cloned().collect::<Vec<_>>(),
            strings(&step["selected"]),
            "after {step}"
        );
        assert_eq!(anchor.as_deref(), step["anchor"].as_str());
    }
}

#[test]
fn episodes_series_and_what_the_folder_does_not_know_are_the_web_apps() {
    let g = golden();
    let w = world(&g);
    for c in g["matches"].as_array().unwrap() {
        let f = w
            .files
            .iter()
            .find(|f| f.path == c["path"].as_str().unwrap())
            .unwrap();
        let mine = match_file(f, &w.items)
            .map(|m| json!({"item": m.item, "season": m.season, "episode": m.episode}));
        assert_eq!(
            mine.unwrap_or(Value::Null),
            c["match"],
            "match of {}",
            c["path"]
        );
    }
    let found = find_new_series(&w.files, &w.items, &HashSet::new());
    let theirs = g["found"].as_array().unwrap();
    assert_eq!(found.len(), theirs.len());
    for (m, t) in found.iter().zip(theirs) {
        assert_eq!(m.key, t["key"].as_str().unwrap());
        assert_eq!(m.title, t["title"].as_str().unwrap());
        assert_eq!(m.files as i64, t["files"].as_i64().unwrap());
        let seasons: Vec<Value> = m
            .seasons
            .iter()
            .map(|(n, e)| json!({"number": n, "episodes": e}))
            .collect();
        assert_eq!(Value::Array(seasons), t["seasons"]);
        assert_eq!(series_to_merk_item(m), t["item"]);
    }
    let ignored: HashSet<String> = [found[0].key.clone()].into();
    let keys: Vec<String> = find_new_series(&w.files, &w.items, &ignored)
        .into_iter()
        .map(|s| s.key)
        .collect();
    assert_eq!(keys, strings(&g["foundIgnored"]));

    let unfiled = unfiled_episodes(&w.files, &w.items);
    let mine: Vec<Value> = unfiled.iter().map(|u| json!({"item": u.item, "season": u.season, "files": u.files.iter().map(|(f, e)| json!([f.path, e])).collect::<Vec<_>>()})).collect();
    assert_eq!(Value::Array(mine), g["unfiled"]);

    let by_series = folder_episodes(&w.files, &w.items);
    let mine: Vec<Value> = by_series.iter().map(|(id, list)| json!({"id": id, "episodes": list.iter().map(|e| json!([e.file.path, e.season, e.episode, e.seen])).collect::<Vec<_>>()})).collect();
    assert_eq!(Value::Array(mine), g["episodesBySeries"]);

    let series = folder_series(&w.files, &w.items);
    let mine: Vec<Value> = series
        .iter()
        .map(|s| {
            json!({
                "item": s.item,
                "episodes": s.episodes.iter().map(|e| e.file.path.clone()).collect::<Vec<_>>(),
                "next": [s.next.file.path, s.next.season, s.next.episode],
                "queue": s.queue.iter().map(|e| e.file.path.clone()).collect::<Vec<_>>(),
            })
        })
        .collect();
    assert_eq!(Value::Array(mine), g["series"]);

    let frieren = by_series
        .iter()
        .find(|(id, _)| id == "fr")
        .map(|(_, l)| l.clone())
        .unwrap_or_default();
    for c in g["queues"].as_array().unwrap() {
        let q: Vec<String> =
            play_queue(&frieren, c["s"].as_i64().unwrap(), c["e"].as_i64().unwrap())
                .into_iter()
                .map(|e| e.file.path)
                .collect();
        assert_eq!(q, strings(&c["queue"]), "queue from {c}");
    }
}

#[test]
fn the_page_sets_files_into_series_as_the_web_page_does() {
    let g = golden();
    let w = world(&g);
    let grouped = group_by_series(&w.files, &w.items);
    let t = &g["grouped"];
    let groups: Vec<Value> = grouped.groups.iter().map(|x| json!({
        "key": x.key, "files": paths(&x.files), "here": x.here, "seenHere": x.seen_here, "seen": x.seen, "total": x.total,
    })).collect();
    assert_eq!(Value::Array(groups), t["groups"]);
    assert_eq!(paths(&grouped.rest), strings(&t["rest"]));
    assert_eq!(paths(&grouped.ordered), strings(&t["ordered"]));
    let mut episodes: Vec<Value> = grouped
        .episodes
        .iter()
        .map(|(p, e)| json!([p, e.season, e.episode, e.seen]))
        .collect();
    let mut theirs: Vec<Value> = t["episodes"].as_array().unwrap().clone();
    episodes.sort_by_key(|v| v[0].as_str().unwrap().to_string());
    theirs.sort_by_key(|v| v[0].as_str().unwrap().to_string());
    assert_eq!(episodes, theirs);
    let mut key_of: Vec<Value> = grouped.key_of.iter().map(|(p, k)| json!([p, k])).collect();
    let mut theirs: Vec<Value> = t["keyOf"].as_array().unwrap().clone();
    key_of.sort_by_key(|v| v[0].as_str().unwrap().to_string());
    theirs.sort_by_key(|v| v[0].as_str().unwrap().to_string());
    assert_eq!(key_of, theirs);
}

#[test]
fn copies_are_found_and_the_original_is_kept_as_the_web_app_does() {
    use sondra_merk::duplicates::*;
    use std::io::Cursor;
    let g = golden();
    let d = &g["dup"];
    for c in d["names"].as_array().unwrap() {
        assert_eq!(
            looks_like_copy(c["n"].as_str().unwrap()),
            c["copy"].as_bool().unwrap(),
            "{}",
            c["n"]
        );
    }
    let files: Vec<FolderFile> = d["files"].as_array().unwrap().iter().map(file).collect();
    assert_eq!(paths(&keep_first(&files[..3])), strings(&d["keepFirst"]));
    // Compared by what the golden says a file is: the same rule as the web's stand-in key.
    let key = |f: &FolderFile| -> std::io::Result<String> {
        if f.name.contains("Unlesbar") {
            return Err(std::io::Error::other("nicht lesbar"));
        }
        let stem = regex::Regex::new(r"(?i) \(\d+\)| - Kopie| copy")
            .unwrap()
            .replace(&f.name, "")
            .into_owned();
        let stem = regex::Regex::new(r"\.[^.]+$")
            .unwrap()
            .replace(&stem, "")
            .into_owned();
        Ok(format!("g:{}:{stem}", f.size))
    };
    let mut seen = 0;
    let report = find_duplicates(&files, key, |done, total| {
        seen = done;
        assert!(done <= total);
        true
    })
    .unwrap();
    assert_eq!(seen, report.read);
    let theirs = &d["report"];
    let groups: Vec<Value> = report
        .groups
        .iter()
        .map(|g| json!({"size": g.size, "files": paths(&g.files), "whole": g.whole}))
        .collect();
    assert_eq!(Value::Array(groups), theirs["groups"]);
    assert_eq!(report.read as i64, theirs["read"].as_i64().unwrap());
    assert_eq!(report.spare as i64, theirs["spare"].as_i64().unwrap());
    assert_eq!(paths(&copies_of(&report)), strings(&theirs["copies"]));
    // Asked to stop, it stops.
    assert!(find_duplicates(&files, |_| Ok("g:x".into()), |_, _| false).is_none());

    // The real keys: SHA-256 whole up to 32 MB, 32 slices of 64 KB above it.
    let small: Vec<u8> = (0..1000u32).map(|i| ((i * 7) & 0xff) as u8).collect();
    let big: Vec<u8> = (0..33u32 * 1024 * 1024)
        .map(|i| ((i * 31 + (i >> 8) * 7 + (i >> 16)) & 0xff) as u8)
        .collect();
    let keys = d["contentKeys"].as_array().unwrap();
    assert_eq!(
        content_key(&mut Cursor::new(&small)).unwrap(),
        keys[0]["key"].as_str().unwrap()
    );
    assert_eq!(
        content_key(&mut Cursor::new(&big[..32 * 1024 * 1024])).unwrap(),
        keys[1]["key"].as_str().unwrap()
    );
    assert_eq!(
        content_key(&mut Cursor::new(&big)).unwrap(),
        keys[2]["key"].as_str().unwrap()
    );
}
