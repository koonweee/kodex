fn main() {
    println!("cargo:rerun-if-changed=src/desktop/native");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/desktop/native/virtual_display.m")
            .file("src/desktop/native/session_lock.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("kodex_virtual_display");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=IOKit");
    }
}
