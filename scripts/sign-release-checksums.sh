#!/usr/bin/env bash
# Writes SHA256SUMS and SHA256SUMS.sig for the installers in a directory.
#
# The in-app updater (src-tauri/src/update_verify.rs) installs an update only if
# SHA256SUMS verifies against the Ed25519 public key compiled into the app
# (src-tauri/update-public-key.hex) and the downloaded installer hashes to the
# value listed there.
#
# Usage: UPDATE_SIGNING_KEY="<PKCS#8 PEM private key>" \
#        scripts/sign-release-checksums.sh <artifacts-dir> <output-dir> [public-key-hex-file]
#
# Without UPDATE_SIGNING_KEY it prints a warning and exits 0, writing nothing:
# the release is then published without signed checksums and the app refuses to
# auto-install it (users install from the release page). With a key it fails
# loudly on any problem, including a private key that does not match the public
# key compiled into the app (which would produce a release no app accepts).
set -euo pipefail

artifacts="${1:?artifacts directory}"
out="${2:?output directory}"
public_key_file="${3:-}"

if [ -z "${UPDATE_SIGNING_KEY:-}" ]; then
  echo "::warning::UPDATE_SIGNING_KEY is not set: this release is published WITHOUT signed checksums, so the in-app updater will refuse to install it (users must install from the release page)."
  exit 0
fi

# Expected format: an UNENCRYPTED Ed25519 private key in PKCS#8 PEM, the whole file with its line
# breaks (openssl genpkey -algorithm ED25519). Say clearly what is wrong; never echo the key.
case "$UPDATE_SIGNING_KEY" in
  *"BEGIN ENCRYPTED PRIVATE KEY"*)
    echo "UPDATE_SIGNING_KEY is passphrase-protected; CI cannot type a passphrase. Store the unencrypted PKCS#8 PEM (openssl pkey -in key.pem -out plain.pem)." >&2
    exit 1 ;;
  *"BEGIN OPENSSH PRIVATE KEY"*)
    echo "UPDATE_SIGNING_KEY is an OpenSSH key; it must be a PKCS#8 PEM Ed25519 key (openssl genpkey -algorithm ED25519)." >&2
    exit 1 ;;
  *"-----BEGIN PRIVATE KEY-----"*"-----END PRIVATE KEY-----"*) ;;
  *)
    echo "UPDATE_SIGNING_KEY is not a PKCS#8 PEM private key (expected the whole file, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----)." >&2
    exit 1 ;;
esac
if [ "$(printf '%s' "$UPDATE_SIGNING_KEY" | wc -l | tr -d ' ')" -lt 2 ]; then
  echo "UPDATE_SIGNING_KEY has lost its line breaks (pasted as one line). Paste the PEM file exactly as it is." >&2
  exit 1
fi

mkdir -p "$out"
sums="$out/SHA256SUMS"
: > "$sums"

# One "<sha256>  <file name>" line per installer, sorted by name; names are bare
# (no directories), exactly what the app looks up.
while IFS= read -r -d '' file; do
  (cd "$(dirname "$file")" && sha256sum "$(basename "$file")") >> "$sums"
done < <(find "$artifacts" -type f \( -name '*.deb' -o -name '*.AppImage' -o -name '*.appimage' \
  -o -name '*.rpm' -o -name '*.exe' -o -name '*.msi' -o -name '*.dmg' \) -print0 | sort -z)

if [ ! -s "$sums" ]; then
  echo "No installers found under $artifacts; refusing to sign an empty checksum list." >&2
  exit 1
fi
# A file name must appear once: the app drops ambiguous names.
if [ "$(cut -c67- "$sums" | sort | uniq -d | wc -l)" -ne 0 ]; then
  echo "Duplicate installer file names; refusing to sign:" >&2
  cut -c67- "$sums" | sort | uniq -d >&2
  exit 1
fi

key="$(mktemp)"
trap 'rm -f "$key"' EXIT
chmod 600 "$key"
printf '%s\n' "$UPDATE_SIGNING_KEY" > "$key"

# Raw Ed25519 signature (64 bytes) over the exact bytes of SHA256SUMS.
openssl pkeyutl -sign -inkey "$key" -passin pass: -rawin -in "$sums" -out "$out/SHA256SUMS.sig"
if [ "$(wc -c < "$out/SHA256SUMS.sig" | tr -d ' ')" -ne 64 ]; then
  echo "Signature is not 64 bytes; is UPDATE_SIGNING_KEY an Ed25519 private key?" >&2
  exit 1
fi

# The matching public key, as the app stores it: 32 raw bytes, lowercase hex.
derived="$(openssl pkey -in "$key" -passin pass: -pubout -outform DER | tail -c 32 | od -An -tx1 | tr -d ' \n')"
if [ -n "$public_key_file" ]; then
  embedded="$(tr -d '[:space:]' < "$public_key_file")"
  if [ "$derived" != "$embedded" ]; then
    echo "UPDATE_SIGNING_KEY does not match src-tauri/update-public-key.hex." >&2
    echo "  signing key public half: $derived" >&2
    echo "  compiled into the app:   $embedded" >&2
    echo "A release signed with it would be refused by every installed app." >&2
    rm -f "$out/SHA256SUMS" "$out/SHA256SUMS.sig"
    exit 1
  fi
fi

# Verify what was just written, the way a client will.
pub="$(mktemp)"
trap 'rm -f "$key" "$pub"' EXIT
openssl pkey -in "$key" -passin pass: -pubout -out "$pub"
openssl pkeyutl -verify -pubin -inkey "$pub" -rawin -in "$sums" -sigfile "$out/SHA256SUMS.sig" > /dev/null

echo "Signed $(wc -l < "$sums" | tr -d ' ') installer checksums with key $derived:"
cat "$sums"
