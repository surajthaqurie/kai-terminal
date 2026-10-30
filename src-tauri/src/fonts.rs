//! Installed font families, for the Settings font list.
//!
//! The WebView cannot enumerate fonts portably (`queryLocalFonts` needs a
//! permission prompt and is missing from WKWebView / WebKitGTK), so the
//! backend asks the OS. Family names only; the frontend keeps the monospace
//! ones by measuring glyph widths.
//! - Windows: the `Fonts` registry keys (`reg query`, no console window).
//! - Linux: `fc-list : family`.
//! - macOS: font file names under the system / user font folders.
//!
//! No new crates, same approach as `clipboard.rs`.

use std::collections::BTreeMap;

/// Trailing words that name a style, not a family ("Cascadia Code SemiBold").
const STYLE_WORDS: &[&str] = &[
    "regular",
    "bold",
    "italic",
    "oblique",
    "light",
    "semilight",
    "semibold",
    "demibold",
    "medium",
    "thin",
    "extralight",
    "ultralight",
    "extrabold",
    "ultrabold",
    "heavy",
    "book",
    "roman",
    "retina",
];

/// Drops trailing style words, keeping at least the first word.
fn strip_style(name: &str) -> String {
    let mut words: Vec<&str> = name.split_whitespace().collect();
    while words.len() > 1
        && words
            .last()
            .is_some_and(|w| STYLE_WORDS.contains(&w.to_ascii_lowercase().as_str()))
    {
        words.pop();
    }
    words.join(" ")
}

/// Sorted, de-duplicated (case-insensitive) family names; blanks dropped.
fn normalize(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut by_key: BTreeMap<String, String> = BTreeMap::new();
    for name in names {
        let name = name.trim().to_string();
        if name.is_empty() || name.starts_with('.') || name.starts_with('@') {
            continue;
        }
        by_key.entry(name.to_lowercase()).or_insert(name);
    }
    by_key.into_values().collect()
}

/// Families named by one `reg query` value line such as
/// `    Cascadia Code SemiBold (TrueType)    REG_SZ    CascadiaCode.ttf`.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn families_from_registry_line(line: &str) -> Vec<String> {
    let Some(end) = line.find("    REG_") else {
        return Vec::new();
    };
    let mut name = line[..end].trim();
    if name.ends_with(')') {
        if let Some(open) = name.rfind(" (") {
            name = name[..open].trim();
        }
    }
    name.split(" & ")
        .map(strip_style)
        .filter(|f| !f.is_empty())
        .collect()
}

/// Families from `fc-list : family` output (one line per face; a face with
/// several localized names lists them comma-separated, preferred first).
#[cfg_attr(not(any(all(unix, not(target_os = "macos")), test)), allow(dead_code))]
fn families_from_fc_list(out: &str) -> Vec<String> {
    out.lines()
        .filter_map(|line| line.split(',').next())
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect()
}

/// Family guessed from a font file name (`Menlo-BoldItalic.ttc` -> `Menlo`).
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn family_from_file_name(file_name: &str) -> Option<String> {
    let stem = file_name
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(file_name);
    let ext = file_name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase());
    if !matches!(ext.as_deref(), Some("ttf" | "otf" | "ttc" | "otc")) {
        return None;
    }
    let family = strip_style(stem.split('-').next().unwrap_or(stem));
    (!family.is_empty()).then_some(family)
}

/// `AndaleMono` -> `Andale Mono`. File names carry no spaces, so the frontend
/// is offered both spellings and keeps whichever one is a real family.
#[cfg_attr(not(any(unix, test)), allow(dead_code))]
fn spaced_camel_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    let mut prev: Option<char> = None;
    for c in name.chars() {
        if c.is_uppercase() && prev.is_some_and(|p| p.is_lowercase() || p.is_ascii_digit()) {
            out.push(' ');
        }
        out.push(c);
        prev = Some(c);
    }
    out
}

/// Families guessed from font files under `dir`, searched `depth` levels deep
/// (font folders nest by vendor: `truetype/dejavu/`, `Supplemental/`).
#[cfg_attr(not(any(unix, test)), allow(dead_code))]
fn families_from_font_dir(dir: &std::path::Path, depth: u8) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                out.extend(families_from_font_dir(&path, depth - 1));
            }
        } else if let Some(family) = family_from_file_name(&entry.file_name().to_string_lossy()) {
            let spaced = spaced_camel_case(&family);
            if spaced != family {
                out.push(spaced);
            }
            out.push(family);
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn raw_families() -> Vec<String> {
    use std::os::windows::process::CommandExt;
    let mut out = Vec::new();
    for key in [
        r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
        r"HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
    ] {
        let Ok(res) = std::process::Command::new("reg")
            .args(["query", key])
            .creation_flags(0x08000000)
            .output()
        else {
            continue;
        };
        if !res.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&res.stdout).lines() {
            out.extend(families_from_registry_line(line));
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn raw_families() -> Vec<String> {
    let mut dirs = vec![
        std::path::PathBuf::from("/System/Library/Fonts"),
        std::path::PathBuf::from("/Library/Fonts"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(std::path::Path::new(&home).join("Library/Fonts"));
    }
    dirs.iter()
        .flat_map(|d| families_from_font_dir(d, 2))
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn raw_families() -> Vec<String> {
    let from_fontconfig = std::process::Command::new("fc-list")
        .args([":", "family"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| families_from_fc_list(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default();
    if !from_fontconfig.is_empty() {
        return from_fontconfig;
    }
    // No fontconfig (minimal image, odd sandbox): read the standard font
    // folders, including the host fonts a Flatpak exposes.
    let mut dirs = vec![
        std::path::PathBuf::from("/usr/share/fonts"),
        std::path::PathBuf::from("/usr/local/share/fonts"),
        std::path::PathBuf::from("/run/host/fonts"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::Path::new(&home);
        dirs.push(home.join(".local/share/fonts"));
        dirs.push(home.join(".fonts"));
    }
    dirs.iter()
        .flat_map(|d| families_from_font_dir(d, 4))
        .collect()
}

#[cfg(not(any(unix, target_os = "windows")))]
fn raw_families() -> Vec<String> {
    Vec::new()
}

/// Installed font family names, sorted and de-duplicated. Empty when the OS
/// cannot be asked (the Settings list then shows only the built-in presets).
pub fn list_system_fonts() -> Vec<String> {
    normalize(raw_families())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lines_become_family_names() {
        let line = "    Cascadia Code SemiBold (TrueType)    REG_SZ    CascadiaCode.ttf";
        assert_eq!(families_from_registry_line(line), ["Cascadia Code"]);
        let line = "    Consolas Bold Italic (TrueType)    REG_SZ    consolaz.ttf";
        assert_eq!(families_from_registry_line(line), ["Consolas"]);
        let line = "    Arial & Arial Black (TrueType)    REG_SZ    ariblk.ttf";
        assert_eq!(families_from_registry_line(line), ["Arial", "Arial Black"]);
        assert!(families_from_registry_line("HKEY_LOCAL_MACHINE\\SOFTWARE").is_empty());
    }

    #[test]
    fn style_words_never_erase_a_whole_name() {
        assert_eq!(strip_style("Light"), "Light");
        assert_eq!(strip_style("Segoe UI Semilight"), "Segoe UI");
        assert_eq!(strip_style("Arial Narrow Bold"), "Arial Narrow");
    }

    #[test]
    fn fc_list_keeps_the_first_localized_name() {
        let out = "DejaVu Sans Mono\nNoto Sans CJK JP,Noto Sans CJK JP Regular\n\n";
        assert_eq!(
            families_from_fc_list(out),
            ["DejaVu Sans Mono", "Noto Sans CJK JP"]
        );
    }

    #[test]
    fn font_files_map_to_families() {
        assert_eq!(
            family_from_file_name("Menlo-BoldItalic.ttc").as_deref(),
            Some("Menlo")
        );
        assert_eq!(
            family_from_file_name("Monaco.ttf").as_deref(),
            Some("Monaco")
        );
        assert_eq!(family_from_file_name("README.txt"), None);
    }

    #[test]
    fn camel_case_file_names_get_a_spaced_spelling() {
        assert_eq!(spaced_camel_case("AndaleMono"), "Andale Mono");
        assert_eq!(spaced_camel_case("Menlo"), "Menlo");
        assert_eq!(spaced_camel_case("JetBrainsMono"), "Jet Brains Mono");
    }

    #[test]
    fn font_dirs_are_searched_recursively_and_ignore_other_files() {
        let root = std::env::temp_dir().join(format!("kai-fonts-{}", std::process::id()));
        let nested = root.join("truetype").join("dejavu");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("DejaVuSansMono-Bold.ttf"), b"").unwrap();
        std::fs::write(nested.join("fonts.dir"), b"").unwrap();
        let found = normalize(families_from_font_dir(&root, 4));
        let _ = std::fs::remove_dir_all(&root);
        assert!(found.iter().any(|f| f == "DejaVuSansMono"));
        assert!(found.iter().any(|f| f == "Deja Vu Sans Mono"));
        assert!(!found.iter().any(|f| f.contains("fonts")));
    }

    #[test]
    fn normalize_sorts_dedups_and_drops_hidden_families() {
        let names = ["menlo", "Menlo", ".SF NS", "@Vertical", "Courier New", " "].map(String::from);
        assert_eq!(normalize(names), ["Courier New", "menlo"]);
    }
}
