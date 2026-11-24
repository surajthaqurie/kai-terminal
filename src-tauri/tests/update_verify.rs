//! Update integrity and authenticity checks (SEC-02). Pure functions: no network.
//!
//! cargo test --manifest-path src-tauri/Cargo.toml --test update_verify
#![cfg(feature = "tauri")]

use kai::update_verify::*;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};

/// Produced by Node's `crypto.sign(null, ...)` (Ed25519), NOT by `ring`, so these
/// tests prove the verifier accepts what an independent signer outputs — the
/// release workflow signs with OpenSSL, a third implementation of the same standard.
const NODE_PUB_HEX: &str = "231bdfc2aa4ca5b8306682c85b68a7f823f2b95512d47e98c83d72d0b155d07b";
const NODE_SUMS: &str =
    "d0bd1de4000d69caa41ef8e3b5e0b8d0bca0c2cd1f1e3b8b8a5a2f8e1c9b7a65  kai_9.9.9_x64-setup.exe\n";
const NODE_SIG_HEX: &str = "0f49bb2ec6b2c8a5430a15f5cd77acd570952f5d0826726d0f9c04c62b7fc75838f088dd5b89044dfcbdae4e4ec9032ace024f6e2fc1dec8861ccb25112a430d";

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

fn node_key() -> [u8; 32] {
    unhex(NODE_PUB_HEX).try_into().unwrap()
}

/// A fresh keypair signing `message` with `ring`.
fn ring_sign(message: &[u8]) -> ([u8; 32], Vec<u8>) {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
    let public: [u8; 32] = pair.public_key().as_ref().try_into().unwrap();
    (public, pair.sign(message).as_ref().to_vec())
}

fn sha256_hex_of(bytes: &[u8]) -> String {
    let mut stream = Sha256Stream::new();
    stream.update(bytes).unwrap();
    stream.finish().iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn the_compiled_in_release_key_is_a_valid_32_byte_key() {
    let key = embedded_public_key().expect("update-public-key.hex must hold 64 hex characters");
    assert_ne!(key, [0u8; 32]);
}

#[test]
fn accepts_a_signature_made_by_an_independent_ed25519_implementation() {
    let digest = trusted_digest_for(
        &node_key(),
        NODE_SUMS.as_bytes(),
        &unhex(NODE_SIG_HEX),
        "kai_9.9.9_x64-setup.exe",
    )
    .expect("a valid signature over the checksums must verify");
    assert_eq!(
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        "d0bd1de4000d69caa41ef8e3b5e0b8d0bca0c2cd1f1e3b8b8a5a2f8e1c9b7a65"
    );
}

#[test]
fn rejects_tampered_checksums_wrong_key_and_malformed_signatures() {
    let sig = unhex(NODE_SIG_HEX);
    let name = "kai_9.9.9_x64-setup.exe";

    // One changed digit: an attacker swapping the hash for a malicious installer.
    let tampered = NODE_SUMS.replacen("d0bd", "d0be", 1);
    assert_eq!(
        trusted_digest_for(&node_key(), tampered.as_bytes(), &sig, name),
        Err(UpdateVerifyError::BadSignature)
    );
    // A different (attacker's) key.
    let (other_key, _) = ring_sign(b"x");
    assert_eq!(
        trusted_digest_for(&other_key, NODE_SUMS.as_bytes(), &sig, name),
        Err(UpdateVerifyError::BadSignature)
    );
    // Truncated, empty and flipped signatures.
    assert_eq!(
        trusted_digest_for(&node_key(), NODE_SUMS.as_bytes(), &sig[..63], name),
        Err(UpdateVerifyError::BadSignature)
    );
    assert_eq!(
        trusted_digest_for(&node_key(), NODE_SUMS.as_bytes(), &[], name),
        Err(UpdateVerifyError::BadSignature)
    );
    let mut flipped = sig.clone();
    flipped[10] ^= 1;
    assert_eq!(
        trusted_digest_for(&node_key(), NODE_SUMS.as_bytes(), &flipped, name),
        Err(UpdateVerifyError::BadSignature)
    );
}

#[test]
fn a_correctly_signed_document_does_not_vouch_for_an_unlisted_file() {
    let sums = format!("{}  kai_1.0.0_x64-setup.exe\n", "ab".repeat(32));
    let (key, sig) = ring_sign(sums.as_bytes());
    assert_eq!(
        trusted_digest_for(&key, sums.as_bytes(), &sig, "kai_1.0.0_x64.dmg"),
        Err(UpdateVerifyError::NotListed(
            "kai_1.0.0_x64.dmg".to_string()
        ))
    );
    assert!(trusted_digest_for(&key, sums.as_bytes(), &sig, "kai_1.0.0_x64-setup.exe").is_ok());
}

#[test]
fn parses_sha256sum_output_strictly() {
    let a = "11".repeat(32);
    let b = "22".repeat(32);
    let text = format!(
        "{a}  plain.exe\r\n{b} *binary.msi\n\
         {upper}  UPPER.dmg\n\
         not-a-digest  junk.deb\n\
         {a}  dir/escape.exe\n\
         {a}  ..\\escape2.exe\n\
         {a}\n\
         \n",
        upper = "AB".repeat(32)
    );
    let parsed = parse_checksums(&text);
    assert_eq!(parsed.len(), 3, "{parsed:?}");
    assert_eq!(parsed["plain.exe"], [0x11; 32]);
    assert_eq!(parsed["binary.msi"], [0x22; 32]);
    assert_eq!(parsed["UPPER.dmg"], [0xab; 32]);
}

#[test]
fn a_file_listed_twice_with_different_digests_can_never_verify() {
    let text = format!(
        "{}  twice.exe\n{}  twice.exe\n{}  once.exe\n{}  same.exe\n{}  same.exe\n",
        "11".repeat(32),
        "22".repeat(32),
        "33".repeat(32),
        "44".repeat(32),
        "44".repeat(32)
    );
    let parsed = parse_checksums(&text);
    assert!(!parsed.contains_key("twice.exe"));
    assert!(parsed.contains_key("once.exe"));
    assert!(
        parsed.contains_key("same.exe"),
        "identical duplicates are harmless"
    );
}

#[test]
fn hashes_installers_incrementally_and_detects_a_swapped_file() {
    // SHA-256("abc") from FIPS 180-2.
    assert_eq!(
        sha256_hex_of(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let mut stream = Sha256Stream::new();
    stream.update(b"a").unwrap();
    stream.update(b"bc").unwrap();
    assert_eq!(stream.bytes(), 3);
    let digest = stream.finish();
    assert!(check_digest(&digest, &digest).is_ok());
    let mut other = digest;
    other[0] ^= 1;
    assert!(matches!(
        check_digest(&digest, &other),
        Err(UpdateVerifyError::HashMismatch { .. })
    ));
}

#[test]
fn hashes_a_file_on_disk() {
    let dir = std::env::temp_dir().join(format!("kai-verify-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("installer.bin");
    // Larger than the read buffer so more than one read is exercised.
    let content: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &content).unwrap();
    let from_file = sha256_file(&path).unwrap();
    let mut direct = Sha256Stream::new();
    direct.update(&content).unwrap();
    assert_eq!(from_file, direct.finish());
    assert!(matches!(
        sha256_file(&dir.join("missing.bin")),
        Err(UpdateVerifyError::Io(_))
    ));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_a_strictly_newer_release_may_be_installed() {
    assert!(is_strictly_newer("v0.2.4", "0.2.3"));
    assert!(is_strictly_newer("0.3.0", "0.2.9"));
    assert!(is_strictly_newer("v1.0.0", "0.99.99"));
    assert!(
        is_strictly_newer("v0.10.0", "0.9.0"),
        "numeric, not lexicographic"
    );
    // Same or older: a replayed (validly signed) old release must not install.
    assert!(!is_strictly_newer("v0.2.3", "0.2.3"));
    assert!(!is_strictly_newer("v0.2.2", "0.2.3"));
    assert!(!is_strictly_newer("v0.1.9", "0.2.3"));
    // A pre-release of the current version is not newer.
    assert!(!is_strictly_newer("v0.2.3-rc.1", "0.2.3"));
    // Malformed input never authorises anything.
    for bad in ["", "v", "latest", "v1.x.0", "..", "v-1.0.0"] {
        assert!(!is_strictly_newer(bad, "0.2.3"), "{bad:?}");
    }
    assert!(!is_strictly_newer("v9.9.9", "not-a-version"));
}

#[test]
fn derives_the_signed_checksum_urls_from_the_installer_url() {
    let url = "https://github.com/surajthaqurie/kai-terminal/releases/download/v0.2.4/kai_0.2.4_x64-setup.exe";
    assert_eq!(release_tag(url), Some("v0.2.4"));
    assert_eq!(
        companion_url(url, "SHA256SUMS").as_deref(),
        Some("https://github.com/surajthaqurie/kai-terminal/releases/download/v0.2.4/SHA256SUMS")
    );
    assert_eq!(release_tag("https://github.com/x/y/archive/main.zip"), None);
    assert_eq!(
        companion_url("https://example.test/file.exe", "SHA256SUMS"),
        None
    );
}

#[test]
fn redirects_stay_on_https_and_allow_listed_hosts() {
    let hosts = ["github.com", "objects.githubusercontent.com"];
    assert!(redirect_allowed("https", Some("github.com"), &hosts));
    assert!(redirect_allowed(
        "https",
        Some("OBJECTS.githubusercontent.com"),
        &hosts
    ));
    assert!(
        !redirect_allowed("http", Some("github.com"), &hosts),
        "no downgrade to http"
    );
    assert!(!redirect_allowed("https", Some("evil.example"), &hosts));
    assert!(!redirect_allowed(
        "https",
        Some("github.com.evil.example"),
        &hosts
    ));
    assert!(!redirect_allowed("https", None, &hosts));
}

/// Opt-in interop check against the REAL release signing output.
///
/// `scripts/sign-release-checksums.sh` signs with OpenSSL; the app verifies with
/// `ring` and its compiled-in key. Point `KAI_TEST_SIGNED_RELEASE_DIR` at a folder
/// holding `SHA256SUMS` and `SHA256SUMS.sig` (the script's output, or a downloaded
/// release) to prove the two agree. `KAI_TEST_SIGNED_RELEASE_FILE` names an
/// installer listed in it (default: the sample `kai_9.9.9_x64-setup.exe`).
///
/// ```text
/// KAI_TEST_SIGNED_RELEASE_DIR=/path/to/out cargo test --test update_verify openssl
/// ```
#[test]
fn verifies_the_openssl_signed_release_files_when_provided() {
    let Some(dir) = std::env::var_os("KAI_TEST_SIGNED_RELEASE_DIR") else {
        eprintln!("note: KAI_TEST_SIGNED_RELEASE_DIR not set; skipping the OpenSSL interop check");
        return;
    };
    let name = std::env::var("KAI_TEST_SIGNED_RELEASE_FILE")
        .unwrap_or_else(|_| "kai_9.9.9_x64-setup.exe".to_string());
    let dir = std::path::PathBuf::from(dir);
    let sums = std::fs::read(dir.join("SHA256SUMS")).unwrap();
    let sig = std::fs::read(dir.join("SHA256SUMS.sig")).unwrap();
    let key = embedded_public_key().expect("embedded key");

    let digest = trusted_digest_for(&key, &sums, &sig, &name)
        .expect("the app must accept what the release script signed");
    // The listed hash really is the one in the document.
    let listed = String::from_utf8_lossy(&sums);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert!(listed.contains(&hex));

    let mut tampered = sums.clone();
    tampered[0] = if tampered[0] == b'0' { b'1' } else { b'0' };
    assert!(trusted_digest_for(&key, &tampered, &sig, &name).is_err());
}
