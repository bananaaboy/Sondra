//! A stand-in for yt-dlp: the same command line and the same kinds of answer, decided by the address.
//! `private` → a private video, `unsupported` → no extractor, `slow` → never finishes by itself,
//! anything else → a small file in the folder of the `-o` template.

use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--version") {
        println!("2099.01.01");
        return;
    }
    let address = args.last().cloned().unwrap_or_default();
    if args.iter().any(|a| a == "--flat-playlist") {
        println!(r#"{{"title":"Eine Liste","entries":[{{"title":"Erster","url":"https://portal.example/watch?v=1"}},{{"title":"Zweiter","url":"https://portal.example/watch?v=2"}}]}}"#);
        return;
    }
    let template = args.iter().position(|a| a == "-o").and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
    if address.contains("unsupported") {
        eprintln!("ERROR: Unsupported URL: {address}");
        std::process::exit(1);
    }
    if address.contains("private") {
        eprintln!("ERROR: [site] abc: Private video. Sign in if you have been granted access to this video");
        std::process::exit(1);
    }
    let path = template.replace("%(title).150B", "Ein Film").replace("%(ext)s", "mp4");
    if address.contains("slow") {
        let part = format!("{path}.part");
        std::fs::write(&part, vec![0u8; 2048]).unwrap();
        println!("SONDRA 100 NA 4000");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(60));
        return;
    }
    for step in 1..=4u64 {
        println!("SONDRA {} 4000 NA", step * 1000);
        std::io::stdout().flush().unwrap();
    }
    std::fs::write(&path, vec![7u8; 4000]).unwrap();
    println!("SONDRAFILE {path}");
}
