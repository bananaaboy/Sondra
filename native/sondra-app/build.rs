//! On Windows the program gets its icon and its version information from `sondra.rc`.

fn main() {
    println!("cargo:rerun-if-changed=sondra.rc");
    println!("cargo:rerun-if-changed=sondra.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile("sondra.rc", embed_resource::NONE).manifest_required().expect("the icon could not be put into the program");
    }
}
