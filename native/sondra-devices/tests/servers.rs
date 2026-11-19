//! The addresses of an own STUN/TURN server and the servers a connection is made with, against `deviceServers.ts`.

use sondra_devices::servers::{ice_servers_for, server_problem, Kind, ServerSettings};

#[test]
fn addresses_are_judged_as_the_web_app_judges_them() {
    let t: serde_json::Value = serde_json::from_str(include_str!("golden/servers.json")).unwrap();
    for case in t["problems"].as_array().unwrap() {
        let kind = if case["kind"] == "stun" { Kind::Stun } else { Kind::Turn };
        let address = case["address"].as_str().unwrap();
        assert_eq!(server_problem(address, kind), case["problem"].as_str(), "{address:?} as {kind:?}");
    }
}

#[test]
fn the_servers_of_a_connection_are_the_web_apps() {
    let t: serde_json::Value = serde_json::from_str(include_str!("golden/servers.json")).unwrap();
    for case in t["ice"].as_array().unwrap() {
        let s = &case["settings"];
        let settings = ServerSettings { stun: s["stun"].as_str().unwrap().into(), turn: s["turn"].as_str().unwrap().into(), user: s["user"].as_str().unwrap().into(), password: s["password"].as_str().unwrap().into() };
        let got: Vec<(String, Option<String>, Option<String>)> = ice_servers_for(&settings).into_iter().map(|i| (i.urls, i.username, i.credential)).collect();
        let want: Vec<(String, Option<String>, Option<String>)> = case["servers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| (x["urls"].as_str().unwrap().to_owned(), x["username"].as_str().map(str::to_owned), x["credential"].as_str().map(str::to_owned)))
            .collect();
        assert_eq!(got, want, "{settings:?}");
    }
}
