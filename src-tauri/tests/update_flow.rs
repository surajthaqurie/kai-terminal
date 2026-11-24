//! The download -> verify -> launch gate of the updater (SEC-02), on real files.
//!
//! These are the two steps that decide whether an installer may ever run:
//! `finalize_verified_download` (hash must equal the SIGNED digest) and
//! `ensure_installer_verified` (the launch gate, re-hashing the file on disk).
//!
//! cargo test --manifest-path src-tauri/Cargo.toml --test update_flow
#![cfg(feature = "tauri")]

use kai::update_verify::Sha256Stream;
use kai::updater::{
    ensure_installer_verified, ensure_update_download_dir, finalize_verified_download,
};
use std::path::PathBuf;

fn digest_of(bytes: &[u8]) -> [u8; 32] {
    let mut stream = Sha256Stream::new();
    stream.update(bytes).unwrap();
    stream.finish()
}

/// A unique pair of `.part` / final paths inside the real private update directory.
fn paths(tag: &str) -> (PathBuf, PathBuf) {
    let dir = ensure_update_download_dir().unwrap();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    (
        dir.join(format!("kai-update-flowtest-{tag}-{stamp}.exe.part")),
        dir.join(format!("kai-update-flowtest-{tag}-{stamp}.exe")),
    )
}

#[test]
fn an_installer_matching_the_signed_digest_is_kept_and_launchable() {
    let (part, dest) = paths("ok");
    let bytes = b"genuine installer bytes";
    std::fs::write(&part, bytes).unwrap();
    let signed = digest_of(bytes);

    finalize_verified_download(&part, &dest, &signed, &digest_of(bytes)).unwrap();

    assert!(!part.exists(), "the .part file is renamed into place");
    assert!(dest.is_file());
    ensure_installer_verified(&dest).expect("a verified installer passes the launch gate");
    let _ = std::fs::remove_file(&dest);
}

#[test]
fn an_installer_that_does_not_match_the_signed_digest_is_deleted_and_never_launchable() {
    let (part, dest) = paths("mismatch");
    std::fs::write(&part, b"malicious installer").unwrap();
    let signed = digest_of(b"the installer the release actually signed");

    let err = finalize_verified_download(&part, &dest, &signed, &digest_of(b"malicious installer"))
        .expect_err("a hash that is not the signed one must be refused");

    assert!(err.to_string().contains("could not be verified"), "{err}");
    assert!(err.to_string().contains("Nothing was run"), "{err}");
    assert!(!part.exists(), "the unverified bytes are deleted");
    assert!(!dest.exists(), "nothing is put in place");
    assert!(ensure_installer_verified(&dest).is_err());
}

#[test]
fn the_launch_gate_refuses_a_file_this_session_never_verified() {
    // E.g. a file dropped into the folder by something else, or left by an older session.
    let (_, dest) = paths("foreign");
    std::fs::write(&dest, b"planted installer").unwrap();

    let err = ensure_installer_verified(&dest).expect_err("unverified files never launch");

    assert!(
        err.to_string().contains("not downloaded and verified"),
        "{err}"
    );
    assert!(
        dest.exists(),
        "a file we did not download is left alone, not deleted"
    );
    let _ = std::fs::remove_file(&dest);
}

#[test]
fn a_file_swapped_after_verification_is_refused_and_removed_at_launch() {
    let (part, dest) = paths("swap");
    let bytes = b"genuine installer bytes";
    std::fs::write(&part, bytes).unwrap();
    let signed = digest_of(bytes);
    finalize_verified_download(&part, &dest, &signed, &signed).unwrap();
    ensure_installer_verified(&dest).unwrap();

    // Anything that can write the file between verification and launch.
    std::fs::write(&dest, b"swapped for something else").unwrap();

    let err = ensure_installer_verified(&dest).expect_err("the re-hash must catch the swap");
    assert!(err.to_string().contains("could not be verified"), "{err}");
    assert!(!dest.exists(), "the tampered file is deleted");
    assert!(
        ensure_installer_verified(&dest).is_err(),
        "and it is no longer on the verified list"
    );
}

#[test]
fn a_missing_file_is_not_launchable() {
    let (_, dest) = paths("missing");
    assert!(ensure_installer_verified(&dest).is_err());
}
