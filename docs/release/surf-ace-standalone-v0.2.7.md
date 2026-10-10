# Surf Ace standalone release v0.2.7

This specification defines the standalone v0.2.7 release. Product and tooling
inputs are independently pinned; build lanes do not resolve either input from a
moving branch.

This release uses the Surf Ace public naming profile: `surf-ace-v<version>-rN`
product tags, `surf-ace-release-tooling-v<version>-rN` tooling tags, and
`surf-ace-<component>-<platform>-v<version>` platform assets. The published
v0.2.5 tags, URLs, and bytes retain their legacy names unchanged.

## Immutable identity

- Product source: tag `surf-ace-v0.2.7-r3` at product commit
  `800d0ea77eb030eea1eb8e690dfb431651e67414`.
- Product version: `0.2.7`.
- Tooling: proposed tag `surf-ace-release-tooling-v0.2.7-r7` at the
  exact reviewed tooling commit.
- Node `24.3.0`, pnpm `10.15.1`, Rust `1.89.0`, PostgreSQL `16`, Linux
  `rust:1.89.0-bookworm`, and Xcode `27.0` on `xcode-27` are recorded in the
  manifest.

The manifest binds both source identities, toolchains, dependency and lockfile
inventories, and the digest and size of every published asset.

## Exact published file set

The release contains six assets, one manifest, and `SHA256SUMS`:

1. `surf-ace-server-linux-x86_64-v0.2.7.tar.gz` — standalone
   registry/server, CLI, schemas, and operations guide.
2. `surf-ace-cli-linux-x86_64-v0.2.7.tar.gz` — Linux CLI.
3. `surf-ace-electron-linux-x86_64-v0.2.7.zip` — Linux desktop app.
4. `surf-ace-cli-macos-arm64-v0.2.7.tar.gz` — macOS arm64 CLI.
5. `surf-ace-electron-macos-arm64-v0.2.7.zip` — macOS arm64 desktop
   app.
6. `surf-ace-skill-v0.2.7.md` — optional Surf Ace skill for Tightbeam agents,
   copied byte-for-byte from the pinned tooling checkout.
7. `surf-ace-v0.2.7-manifest.json` — release identities, toolchain,
   dependency inventory, and asset checksums.
8. `SHA256SUMS` — sorted SHA-256 records for the six assets and manifest.

The Linux server archive carries `schemas/allocator/003_annotation_journal.sql`.
The operator applies it to a stopped, backed-up fleet after the pane schema is
present. This release does not auto-migrate a serving database. A verified
annotation journal makes the public native CLI's foreground `annotations watch`
and `resume` streams available to any agent or script using its own consumer
identity; records are acknowledged explicitly with `annotations ack`.

The iPadOS app is development-signed separately for a device and is not a
hosted release asset. No IPA or distribution-signing credential is part of this
workflow. The signed app's source identity, `0.2.7` marketing version and
incremented build number must be recorded with the installed version/build on
the exact physical Aleph device before device acceptance is claimed.

Legacy clients with confirmed labels require the owner-verified fleet and
allocator identity migration in DESIGN §3.1.2. The provisioned binding must
match preserved client, surface, pane, and lineage claims; discovery or an
empty live registration row is not migration evidence. Pre-marker unconfirmed
local letters additionally require independent allocation-history, local
provenance, and other-fleet evidence. Absent or ambiguous evidence leaves
registration pending while preserving local display and data.

## Product and operation boundaries

The Linux registry/server accepts client registrations and coordinates global
window labels and fleet-unique pane numbers through an already-provisioned
PostgreSQL 16 allocator. A pane has no visible number until the registry
confirms its durable, never-reused number; clients do not guess locally.
Electron clients register with the registry; the packaged CLI connects
directly to the selected client's `/ws` endpoint. Tailnet is the network security
boundary. PostgreSQL provisioning, service-manager installation, and changes
to a serving database remain operator-owned.

The server archive includes its foreground launcher, schemas, operations guide,
and optional service-unit template. The release does not install or enable the
template, provision PostgreSQL, or apply initialization SQL over an existing
database. The operations guide requires a PostgreSQL custom-format backup and
restores only into a separate staged cluster before any serving-database
migration; it documents health and rollback as well.

The server advertises its effective listener through `_surf-ace._tcp` with
`role=server`, `v=1`, and `ws=/ws`. Its readiness requires browsing that actual
record and a read-only `fleet.topology` handshake through the advertised
transport addresses. The packaged Linux smoke exercises the shipped registry;
the macOS smoke exercises the packaged desktop client and CLI. The release
ships no Darwin registry publisher, so the macOS smoke is not evidence for one.
Live cross-host desktop discovery and physical Aleph discovery-only registration remain rollout gates;
clients do not autostart on boot or require a manual iOS registry endpoint.

## Build, comparison, smoke, and coverage

Independent Linux and macOS build lanes use the exact product and tooling
identities above. Runtime packages build from the immutable product checkout;
the versioned skill asset and operations guide come from the immutable tooling
checkout. Hosted comparison checks the same six asset bytes from both lanes.
The manifest and `SHA256SUMS` bind all six assets, and publication allowlists
only those assets, the manifest, and the checksum file.

Smoke is an explicit candidate-only gate. It verifies the manifest, checksums,
source/tooling identities, and participating server, CLI, and clients before
operations. Linux acceptance exercises two distinct registered clients
against one registry/server and PostgreSQL instance. It requires distinct
registry-assigned pane numbers, direct CLI targeting of each client, visible
labels, current content on the selected pane, screenshot pixel evidence, and
wrong-surface rejection. The smoke is not satisfied by a second registration
that is not bound to its own client endpoint. macOS acceptance uses the matching
packaged client and CLI. No old-version participant is part of this release
smoke qualification. Historical old-version results remain archived as
diagnostic evidence only.

The Linux candidate smoke also verifies the packaged annotation schema and
journal head on a disposable PostgreSQL fleet. It exercises a packaged CLI
consumer against the packaged registry with a generated source record,
checking live delivery, durable acknowledgement, resume, and retirement.
The Electron and iOS publishers retain their separate exact-source fault-test
evidence; a synthetic source record alone is not proof of a user stroke from a
packaged app.

The release test maps implemented UI/UX index rows to concrete checks. The
following rows retain their recorded v0.2.4 known-gap status and remain
visible for v0.2.7 acceptance:

- **Blocked:** Accessibility Contrast. The §15.1 pane-label-opacity and §15.2
  WCAG AA requirements conflict pending Mike's ruling; neither spec nor check
  is changed here.
- **Pending:** Canvas Presentation.
- **Pending:** Native Overlay Visual Distinction Gap.
- **Pending:** Native Overlay Model Markup Goal.
- **Pending:** Future Interactive Affordances.

Any named index row is either backed by a mapped release check or listed above
as a pending/blocked known gap. These gaps are disclosed to the product owner;
release checks for fleet-unique pane numbers and always-visible window/pane
labels remain required.

Publication is separately opt-in and unreachable until build comparison,
smokes, receipts, attestations, and exact-file checks succeed. This
specification does not create tags, dispatch workflows, publish assets, install
fleet software, or claim hosted acceptance; those are separate operator
actions.
