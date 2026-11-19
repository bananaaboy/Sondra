//! The dragged crop rectangle, against `dragRect` of the web editors: every handle, pointer place and ratio.

use sondra_media::crop_drag::{drag_rect, Drag, Handle};
use sondra_media::image_ops::Rect;

fn rect(v: &serde_json::Value) -> Rect {
    Rect { x: v["x"].as_f64().unwrap(), y: v["y"].as_f64().unwrap(), width: v["width"].as_f64().unwrap(), height: v["height"].as_f64().unwrap() }
}

#[test]
fn every_drag_gives_the_rectangle_the_web_editors_give() {
    let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("golden/crop.json")).unwrap();
    assert!(cases.len() > 900);
    for (n, case) in cases.iter().enumerate() {
        let handle = Handle::from_name(case["handle"].as_str().unwrap()).unwrap();
        let drag = Drag { handle, start: rect(&case["start"]), origin_x: case["origin"]["x"].as_f64().unwrap(), origin_y: case["origin"]["y"].as_f64().unwrap() };
        let ratio = case["ratio"].as_f64();
        let got = drag_rect(&drag, case["point"]["x"].as_f64().unwrap(), case["point"]["y"].as_f64().unwrap(), ratio, case["sourceAspect"].as_f64().unwrap());
        let want = rect(&case["out"]);
        for (a, b, what) in [(got.x, want.x, "x"), (got.y, want.y, "y"), (got.width, want.width, "width"), (got.height, want.height, "height")] {
            assert!((a - b).abs() < 1e-9, "case {n} ({} {:?} ratio {ratio:?}): {what} is {a}, the web app has {b}", case["handle"], case["point"]);
        }
    }
}
