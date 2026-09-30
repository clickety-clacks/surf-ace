# Surf Ace Tightbeam standalone release v0.2.2

This specification defines the standalone v0.2.2 release. Product source and
release tooling are independently pinned; no build lane resolves either input
from a moving branch.

## Immutable identity

- Product source: proposed tag `surf-ace-tightbeam-v0.2.2` at commit
  `ebff52a23f2de88b179eb6472f46cffe3e32c40a`.
- Product version: `0.2.2`.
- Tooling: proposed tag `surf-ace-release-tooling-tightbeam-v0.2.2` at the
  exact reviewed tooling commit.
- Node `24.3.0`, pnpm `10.15.1`, Rust `1.89.0`, PostgreSQL `16`, Linux
  `rust:1.89.0-bookworm`, and Xcode `27.0` on `xcode-27` are recorded in the
  manifest.

The manifest binds both source identities, toolchains, dependency and lockfile
inventories, and the digest and byte size of every published asset.

## Exact published file set

The release contains six assets, one manifest, and `SHA256SUMS`:

1. `surf-ace-tightbeam-server-linux-x86_64-v0.2.2.tar.gz` — standalone
   registry/server, CLI, schemas, and operations guide.
2. `surf-ace-tightbeam-cli-linux-x86_64-v0.2.2.tar.gz` — Linux CLI.
3. `surf-ace-tightbeam-electron-linux-x86_64-v0.2.2.zip` — Linux desktop app.
4. `surf-ace-tightbeam-cli-macos-arm64-v0.2.2.tar.gz` — macOS arm64 CLI.
5. `surf-ace-tightbeam-electron-macos-arm64-v0.2.2.zip` — macOS arm64 desktop
   app.
6. `surf-ace-tightbeam-skill-v0.2.2.md` — standalone Tightbeam skill source,
   copied byte-for-byte from the pinned product checkout.
7. `surf-ace-tightbeam-v0.2.2-manifest.json` — release identities, toolchain,
   dependency inventory, and asset checksums.
8. `SHA256SUMS` — sorted SHA-256 records for the six assets and manifest.

The skill Markdown is a separate asset, not an executable or plugin package.
The iPadOS app is development-signed separately for a device and is not a
hosted release asset. No IPA or distribution-signing credential is part of this
workflow.

## Product and operation boundaries

The Linux registry/server accepts client registrations and coordinates global
window labels through an already-provisioned PostgreSQL 16 allocator. It does
not relay pair or content operations. Electron clients register with the
registry; the packaged CLI connects directly to the selected client's `/ws`
endpoint. Tailnet is the network security boundary. PostgreSQL provisioning,
service-manager installation, and changes to a serving database remain
operator-owned.

The server package includes its foreground launcher, schemas, operations
guide, and optional service-unit template. The release does not install or
enable that template, provision PostgreSQL, or apply initialization SQL over an
existing database. See `tightbeam-linux-operations.md` for the exact
configuration, backup, staged-restore, health, and rollback procedure. That
procedure includes a PostgreSQL custom-format backup and restores only into a
separate staged cluster; it never overwrites the retained original.

## Build, comparison, smoke, and publication

Independent Linux and macOS build lanes use the pinned product and tooling
identities. Both lanes copy the skill from the exact product checkout; hosted
comparison checks that file along with the five platform packages. The manifest
builder rejects a missing or changed skill copy. The manifest and
`SHA256SUMS` bind all six assets, and the publication allowlist contains only
those assets, the manifest, and the checksum file.

Smoke is an explicit candidate-only gate. Before operations it verifies the
manifest, checksum list, source/tooling identities, and each participating
server, CLI, and client. Linux acceptance uses an isolated PostgreSQL registry,
a ready display, a registered packaged client, and the packaged CLI directly
to that client's endpoint. The release fixture pushes a bare HTML paragraph
fragment (`<p>…</p>`), then requires current content with the expected content
ID and visible text, successful capture on the intended surface and pane, and
rejection of a wrong-surface request. macOS acceptance uses the matching
packaged client and CLI. Neither smoke depends on an older release participant
or claims an iPad IPA.

No old-version participant is part of the v0.2.2 smoke qualification.
Historical old-version results remain archived as diagnostic evidence only.

Publication is separately opt-in and unreachable until both smoke jobs,
receipts, attestations, and exact-file checks succeed. This specification does
not create tags, dispatch workflows, publish assets, install fleet software,
or claim hosted acceptance; those are separate operator actions.
