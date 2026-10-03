# Native workspace validation — authorized system prerequisites

User authorized standard system prerequisites to continue native workspace checks.
Parent installed `libfontconfig-dev2.15.0-2.3` and its12dependencies. Child verified
pkg-configfontconfig2.15.0. Active8GiB temporaryswap remains; no fstab change.

Workspace clippy passed with existing target, jobs1/dev-testdebug0/incremental0.
Workspace test link then failed `-lxcb`, `-lxkbcommon`, `-lxkbcommon-x11` missing.
Child installed only standard system prerequisites with:

`apt-get install -y --no-install-recommends libxcb1-dev libxkbcommon-dev libxkbcommon-x11-dev`

Installed11packages:libxcb1-dev1.17.0-2+b1, libxcb-xkb-dev1.17.0-2+b1,
libxcb-xkb1 sameversion; libxkbcommon-dev/libxkbcommon0/libxkbcommon-x11-dev/
libxkbcommon-x11-0 version1.7.0-2; libxau-dev1:1.0.11-1;
libxdmcp-dev1:1.1.5-1; x11proto-dev2024.1-1; xorg-sgml-doctools1:1.11-1.1.
No project dependency/feature/lockfile, desktop source or frozen capture edits.
No other process terminated or tmpfs/user contents removed. Build/log/profile
artifacts remain disk-backed ignored migration target, not full tmpfs.

After system prerequisite provisioning, workspace tests linked: desktop57PASS;
server164PASS/1FAIL, canonicalcapture exact-byte test. Workspace unifies GPUI's
serde_json/preserve_order, exposing capture's assumption Map normalizes keys.
Capture reviewer owns code/tests/docs freeze; child reported evidence without
changing it. Release not reached after failed test gate; no workspacegreen claim.
