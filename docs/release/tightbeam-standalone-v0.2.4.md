# Surf Ace Tightbeam standalone release v0.2.4

This specification defines the standalone v0.2.4 release. Product source and
release tooling are independently pinned; no build lane resolves either input
from a moving branch.

## Immutable identity

- Product source: proposed tag `surf-ace-tightbeam-v0.2.4` at exact candidate
  commit `3250929111ff2999f5a3fedfbfc3ae417df05357`.
- Product version: `0.2.4`.
- Tooling: proposed tag `surf-ace-release-tooling-tightbeam-v0.2.4` at the
  exact reviewed tooling commit.
- Node `24.3.0`, pnpm `10.15.1`, Rust `1.89.0`, PostgreSQL `16`, Linux
  `rust:1.89.0-bookworm`, and Xcode `27.0` on `xcode-27` are recorded in the
  manifest.

The manifest binds both source identities, toolchains, dependency and lockfile
inventories, and the digest and byte size of every published asset. Product
commit `3ea782b7` restores registry-owned, fleet-wide pane numbers and keeps
confirmed window and pane labels visible while disconnected, during pointer
movement, and during touch interaction. Unconfirmed pane numbers are omitted;
clients never guess them locally.

## Exact published file set

The release contains six assets, one manifest, and `SHA256SUMS`:

1. `surf-ace-tightbeam-server-linux-x86_64-v0.2.4.tar.gz` — standalone
   registry/server, CLI, schemas, and operations guide.
2. `surf-ace-tightbeam-cli-linux-x86_64-v0.2.4.tar.gz` — Linux CLI.
3. `surf-ace-tightbeam-electron-linux-x86_64-v0.2.4.zip` — Linux desktop app.
4. `surf-ace-tightbeam-cli-macos-arm64-v0.2.4.tar.gz` — macOS arm64 CLI.
5. `surf-ace-tightbeam-electron-macos-arm64-v0.2.4.zip` — macOS arm64 desktop
   app.
6. `surf-ace-tightbeam-skill-v0.2.4.md` — standalone Tightbeam skill source,
   copied byte-for-byte from the pinned tooling checkout.
7. `surf-ace-tightbeam-v0.2.4-manifest.json` — release identities, toolchain,
   dependency inventory, and asset checksums.
8. `SHA256SUMS` — sorted SHA-256 records for the six assets and manifest.

The skill Markdown is a separate asset, not an executable or plugin package.
Its asset name and content are sourced from the tooling commit and covered by
the manifest and checksums. The iPadOS app is development-signed separately
for a device and is not a hosted release asset. No IPA or distribution-signing
credential is part of this workflow.

## Product and operation boundaries

The Linux registry/server accepts client registrations and coordinates global
window and pane labels through an already-provisioned PostgreSQL 16 allocator.
It does not relay pair or content operations. Electron clients register with
the registry; the packaged CLI connects directly to the selected client's
`/ws` endpoint. Tailnet is the network security boundary. PostgreSQL
provisioning, service-manager installation, and changes to a serving database
remain operator-owned.

Pane numbers are allocated durably by the single fleet registry, are unique
across all clients and surfaces in the fleet, and are never reused. Every
confirmed window label and pane number remains visible, including during
pointer movement and touch interaction. Until the allocator confirms a pane
number, the client displays no number rather than a locally generated guess.

The server package includes its foreground launcher, schemas, operations guide,
and optional service-unit template. The release does not install or enable that
template, provision PostgreSQL, or apply initialization SQL over an existing
database. See `tightbeam-linux-operations.md` for the exact configuration,
backup, staged-restore, health, and rollback procedure. That procedure includes
a PostgreSQL custom-format backup and restores only into a separate staged cluster;
it never overwrites the retained original.

## Build, comparison, smoke, and publication

Independent Linux and macOS build lanes use the exact product and tooling
identities above. Runtime packages build from the immutable product checkout;
the versioned skill asset and operations guide come from the immutable tooling
checkout. Hosted comparison checks the same six asset bytes from both lanes.
The manifest and `SHA256SUMS` bind all six assets, and the publication allowlist
contains only those assets, the manifest, and the checksum file.

Smoke is an explicit candidate-only gate. Before operations it verifies the
manifest, checksum list, source/tooling identities, and each participating
server, CLI, and client. Linux acceptance registers two distinct packaged
clients with one isolated PostgreSQL-backed registry and verifies that both
receive different positive pane numbers which match their registry
assignments. A ready display and packaged CLI directly to the selected client
are required; the CLI pushes content to the selected surface and pane, captures
that pane, and the returned screenshot pixels must match the intended render.
A current-content read must identify the same write, and a wrong-surface
request must be rejected. macOS acceptance uses the matching packaged client
and CLI and the same screenshot-only capture contract. Neither smoke depends on
an older release participant or claims an iPad IPA.

No old-version participant is part of the v0.2.4 smoke qualification.
Historical old-version results remain archived as diagnostic evidence only.

**Known nonblocking specification gap (contrast):** DESIGN §15.1 specifies
pane-label gray at 30% opacity, while §15.2 requires WCAG AA contrast across
content backgrounds. This unresolved conflict is pending Mike's ruling and is
recorded as a known v0.2.4 gap under the ship-with-gaps decision. This note does
not change normative `DESIGN.md` text or the existing contrast conformance
check.

Publication is separately opt-in and unreachable until both smoke jobs,
receipts, attestations, and exact-file checks succeed. This specification does
not create tags, dispatch workflows, publish assets, install fleet software,
or claim hosted acceptance; those are separate operator actions.
