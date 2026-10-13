Name:           kai
Version:        0.1.0
Release:        1%{?dist}
Summary:        A modern cross-platform terminal for Windows, Linux, and macOS.

License:        MIT
URL:            https://github.com/surajthaqurie/kai-terminal
Source0:        %{name}-%{version}.tar.gz

BuildRequires:  gcc gcc-c++ pkgconf-pkg-config openssl-devel
BuildRequires:  webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel
Requires:       webkit2gtk4.1 gtk3 libappindicator-gtk3

%description
Fast lightweight standalone cross-platform terminal emulator built with Tauri 2,
Rust (portable-pty), React, TypeScript, and xterm.js. Works with or without
local AI CLIs (Codex, Claude Code, Gemini CLI). Third-party binaries are not bundled.

%prep
%autosetup

%build
npm ci
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --release --no-default-features

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}%{_bindir}
install -p -m 755 src-tauri/target/release/kai %{buildroot}%{_bindir}/kai

%files
%license LICENSE
%doc README.md ARCHITECTURE.md SECURITY.md
%{_bindir}/kai

%changelog
* Sat Oct 10 2026 Antigravity Team <support@antigravity.ai> - 0.1.0-1
- Initial production release of Kai cross-platform terminal.
