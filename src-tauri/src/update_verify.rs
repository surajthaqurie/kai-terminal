//! Integrity and authenticity checks for downloaded updates (SEC-02).
//!
//! Releases publish two extra assets next to the installers:
//!
//! * `SHA256SUMS`: `sha256sum` output, one `<hex>  <file name>` line per installer;
//! * `SHA256SUMS.sig`: a raw 64-byte Ed25519 signature over those exact bytes.
//!
//! The matching public key is compiled into the app (`update-public-key.hex`), so
//! an installer is trusted only if (1) the checksums file verifies against the
//! embedded key and (2) the downloaded bytes hash to the value signed for that
//! file name. TLS and the GitHub account are therefore no longer the only thing
//! standing between a stolen release token and a silent installer on every
//! user's machine. Nothing here touches the network or the filesystem layout;
//! `updater.rs` drives the download and refuses to launch anything this module
//! has not verified.

use ring::{digest, signature};
use std::collections::HashMap;
use std::fmt;
use std::io::Read;
use std::path::Path;

/// Public half of the release signing key (32 raw bytes, lowercase hex).
const UPDATE_PUBLIC_KEY_HEX: &str = include_str!("../update-public-key.hex");

/// Most bytes accepted for `SHA256SUMS` / `SHA256SUMS.sig`: both are tiny.
pub const MAX_CHECKSUMS_BYTES: usize = 1024 * 1024;
/// Most bytes accepted for one installer. The largest shipped installer is well
/// under 250 MB; this only stops an endless stream from filling the disk.
pub const MAX_INSTALLER_BYTES: u64 = 1024 * 1024 * 1024;
/// Length of an Ed25519 signature.
const SIGNATURE_LEN: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum UpdateVerifyError {
    /// No usable public key is compiled in (a build misconfiguration).
    NoPublicKey,
    /// The checksums file is not signed by the release key (or the signature is malformed).
    BadSignature,
    /// The signed checksums do not list this installer.
    NotListed(String),
    /// The downloaded bytes do not hash to the signed value.
    HashMismatch { expected: String, actual: String },
    /// The installer is larger than [`MAX_INSTALLER_BYTES`].
    TooLarge,
    /// Reading the downloaded file failed.
    Io(String),
}

impl fmt::Display for UpdateVerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoPublicKey => write!(f, "this build has no update signing key"),
            Self::BadSignature => write!(
                f,
                "the release checksums are not signed by the Kai release key"
            ),
            Self::NotListed(name) => write!(f, "the signed checksums do not list {name}"),
            Self::HashMismatch { expected, actual } => write!(
                f,
                "the downloaded file does not match its signed checksum (expected {expected}, got {actual})"
            ),
            Self::TooLarge => write!(f, "the update file is larger than the allowed maximum"),
            Self::Io(e) => write!(f, "could not read the downloaded file: {e}"),
        }
    }
}

/// The embedded release public key, or `None` if the key file is not 32 hex bytes.
pub fn embedded_public_key() -> Option<[u8; 32]> {
    decode_hex_32(UPDATE_PUBLIC_KEY_HEX.trim())
}

fn decode_hex_32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Verifies `signature` (raw 64 bytes) over `message` against `public_key`.
pub fn verify_signature(
    public_key: &[u8; 32],
    message: &[u8],
    signature: &[u8],
) -> Result<(), UpdateVerifyError> {
    if signature.len() != SIGNATURE_LEN {
        return Err(UpdateVerifyError::BadSignature);
    }
    signature::UnparsedPublicKey::new(&signature::ED25519, public_key)
        .verify(message, signature)
        .map_err(|_| UpdateVerifyError::BadSignature)
}

/// Parses `sha256sum` output into `file name -> digest`. Lines that are not a
/// 64-hex digest followed by a file name are ignored; `*name` (binary mode) is
/// accepted. A name that appears twice with different digests is dropped
/// entirely so an ambiguous file can never verify.
pub fn parse_checksums(text: &str) -> HashMap<String, [u8; 32]> {
    let mut out: HashMap<String, [u8; 32]> = HashMap::new();
    let mut conflicted: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let Some((hex, rest)) = line.split_once(' ') else {
            continue;
        };
        let Some(digest) = decode_hex_32(&hex.to_ascii_lowercase()) else {
            continue;
        };
        let name = rest.trim_start_matches([' ', '*']).trim();
        if name.is_empty() || name.contains('/') || name.contains('\\') {
            continue;
        }
        match out.get(name) {
            Some(existing) if *existing != digest => conflicted.push(name.to_string()),
            _ => {
                out.insert(name.to_string(), digest);
            }
        }
    }
    for name in conflicted {
        out.remove(&name);
    }
    out
}

/// Verifies the signed checksums document and returns the digest it lists for
/// `asset_name`. Fails closed: an unsigned, tampered or foreign document, or an
/// asset the document does not list, never yields a digest.
pub fn trusted_digest_for(
    public_key: &[u8; 32],
    checksums: &[u8],
    signature: &[u8],
    asset_name: &str,
) -> Result<[u8; 32], UpdateVerifyError> {
    verify_signature(public_key, checksums, signature)?;
    let text = String::from_utf8_lossy(checksums);
    parse_checksums(&text)
        .get(asset_name)
        .copied()
        .ok_or_else(|| UpdateVerifyError::NotListed(asset_name.to_string()))
}

/// Streaming SHA-256 so a large installer is hashed while it downloads.
pub struct Sha256Stream {
    context: digest::Context,
    bytes: u64,
}

impl Default for Sha256Stream {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256Stream {
    pub fn new() -> Self {
        Self {
            context: digest::Context::new(&digest::SHA256),
            bytes: 0,
        }
    }

    /// Feeds more bytes; errors once more than [`MAX_INSTALLER_BYTES`] arrived.
    pub fn update(&mut self, chunk: &[u8]) -> Result<(), UpdateVerifyError> {
        self.bytes = self.bytes.saturating_add(chunk.len() as u64);
        if self.bytes > MAX_INSTALLER_BYTES {
            return Err(UpdateVerifyError::TooLarge);
        }
        self.context.update(chunk);
        Ok(())
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    pub fn finish(self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(self.context.finish().as_ref());
        out
    }
}

/// Compares a computed digest with the signed one.
pub fn check_digest(expected: &[u8; 32], actual: &[u8; 32]) -> Result<(), UpdateVerifyError> {
    if expected == actual {
        Ok(())
    } else {
        Err(UpdateVerifyError::HashMismatch {
            expected: to_hex(expected),
            actual: to_hex(actual),
        })
    }
}

/// SHA-256 of a file on disk (re-checked right before an installer is launched).
pub fn sha256_file(path: &Path) -> Result<[u8; 32], UpdateVerifyError> {
    let mut file = std::fs::File::open(path).map_err(|e| UpdateVerifyError::Io(e.to_string()))?;
    let mut stream = Sha256Stream::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| UpdateVerifyError::Io(e.to_string()))?;
        if n == 0 {
            break;
        }
        stream.update(&buf[..n])?;
    }
    Ok(stream.finish())
}

/// `[major, minor, patch]` of a version string or release tag (`v0.2.3`,
/// `0.2.3-beta.1` ...): the numeric core only, `None` if it is not numeric.
fn version_core(version: &str) -> Option<[u64; 3]> {
    let trimmed = version.trim().trim_start_matches(['v', 'V']);
    let core = trimmed.split(['-', '+']).next().filter(|c| !c.is_empty())?;
    let mut parts = [0u64; 3];
    for (i, piece) in core.split('.').enumerate() {
        if i >= 3 {
            break;
        }
        parts[i] = piece.parse().ok()?;
    }
    Some(parts)
}

/// True only when `candidate` is strictly newer than `current`. Unparseable
/// input is never "newer", so a malformed tag can never authorise an install.
/// (A pre-release suffix is ignored: `1.2.3-rc.1` equals `1.2.3`, which is not newer.)
pub fn is_strictly_newer(candidate: &str, current: &str) -> bool {
    match (version_core(candidate), version_core(current)) {
        (Some(c), Some(cur)) => c > cur,
        _ => false,
    }
}

/// The release tag in `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`.
pub fn release_tag(asset_url: &str) -> Option<&str> {
    let rest = asset_url.split("/releases/download/").nth(1)?;
    let tag = rest.split('/').next()?;
    (!tag.is_empty()).then_some(tag)
}

/// URL of `file_name` in the same release as `asset_url` (same directory).
pub fn companion_url(asset_url: &str, file_name: &str) -> Option<String> {
    let base = asset_url.rsplit_once('/')?.0;
    release_tag(asset_url)?;
    Some(format!("{base}/{file_name}"))
}

/// Whether a redirect hop may be followed: HTTPS and an allow-listed host only.
pub fn redirect_allowed(scheme: &str, host: Option<&str>, allowed_hosts: &[&str]) -> bool {
    scheme == "https"
        && host.is_some_and(|h| allowed_hosts.iter().any(|a| h.eq_ignore_ascii_case(a)))
}
