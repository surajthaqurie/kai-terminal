fn main() {
    #[cfg(any(feature = "tauri", feature = "tauri-build"))]
    tauri_build::build();
}
