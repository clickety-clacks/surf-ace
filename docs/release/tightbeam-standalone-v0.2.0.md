# Surf Ace Tightbeam standalone release v0.2.0

This specification covers the standalone Tightbeam release. The Linux server
archive includes an optional service unit template, but no service-manager
runtime dependency or host installation.

## Immutable source and version identity

- Product source: tag `surf-ace-tightbeam-v0.2.0` at commit
  `0c181cc512816ee3e03a0284fdcea9a70a175019`, a direct child of the
  reviewed `8fc9f508ae9b4371a3c25f6318920940fbad10cd` cutoff containing the
  CLI current-content retention correction.
- Product version: `0.2.0`.
- The standalone tooling tag is `surf-ace-release-tooling-tightbeam-v0.2.0`.
  It binds the release tooling used to produce this exact package set.

The manifest binds source/tooling identity, platform toolchains, dependency
inventories and lockfile digests, asset digests, and the signed iPadOS bundle
identity. No installer or package may silently resolve product source from a
moving branch.

## Public package set

The release contains exactly these six payloads, one canonical manifest, and a
checksum list covering the six payloads and manifest:

1. `surf-ace-tightbeam-server-linux-x86_64-v0.2.0.tar.gz` — standalone Rust
   CLI, callable central-server module, foreground launcher, optional service
   unit template, operations runbook, and allocator/protocol schemas.
2. `surf-ace-tightbeam-cli-linux-x86_64-v0.2.0.tar.gz` — Linux CLI only.
3. `surf-ace-tightbeam-electron-linux-x86_64-v0.2.0.zip` — Linux Electron
   client with `Surf Ace/surf-ace` launcher wrapping `surf-ace-bin`; the
   launcher passes Chromium `--no-sandbox` because a user-extracted ZIP cannot
   supply a root-owned setuid helper. See the Linux runbook for this explicit
   sandbox boundary and headless-smoke flags.
4. `surf-ace-tightbeam-cli-macos-arm64-v0.2.0.tar.gz` — macOS arm64 CLI only.
5. `surf-ace-tightbeam-electron-macos-arm64-v0.2.0.zip` — macOS arm64 Electron
   client.
6. `surf-ace-tightbeam-ios-ipad-v0.2.0.ipa` — signed iPadOS app.
7. `surf-ace-tightbeam-v0.2.0-manifest.json` — canonical source, tooling,
   dependency, platform, signing and package evidence.
8. `SHA256SUMS` — sorted SHA-256 lines for all six payloads and the manifest.

The Linux server archive exposes `startCentralServer(config, name)` and its
owned `close()` lifecycle, plus a foreground `bin/surf-ace-server` wrapper for
configuration validation, process readiness, registry health, and graceful
SIGTERM/SIGINT shutdown. This central service owns registration, global
window-label allocation, and PostgreSQL-backed registry state; it is not a
pairing/content relay. It contains a systemd unit template for separate
operator review; release tooling does not install, enable, reload, or start a
host service. PostgreSQL 16 remains external and already provisioned. The
archive neither installs/provisions PostgreSQL nor auto-migrates its schema.
Electron clients register to the central service; the packaged CLI connects
directly to the named client's own `/ws` endpoint for pair/list/capture/push/
topology/read operations. Tailnet is the network security boundary. The CLI is
not routed through the registry service.

`schemas/allocator/001_allocator.sql` initializes an empty PostgreSQL 16
database; it is not an in-place migration for an existing fleet. The Linux
operations guide defines mode-restricted configuration, the current schema
boundary, custom-format backup, restore into an isolated staged cluster, exact
schema and packaged CLI health/current/no-loss validation, and rollback by
discarding staging while retaining the original database. Staging is never
restored over the original serving database.

Both Electron packages are checked against the locked production dependency
closure for the Electron workspace; development-only packages are not counted
as shipped runtime dependencies.

The IPA is accepted only after verifying the archive signature, bundle
identifier `co.clicketyclacks.SurfAce`, Apple team `Z7R59J7QV8`, embedded
provisioning profile identity/entitlements, and profile expiry. The manifest
must bind the verification receipt and the IPA digest. Signing secrets and
private keys are never included in artifacts or logs.

## Build, smoke, and publication gates

Build uses the pinned Node, pnpm, Rust, Xcode, Linux container and PostgreSQL
toolchain declarations in the manifest. Independent Linux and macOS build
lanes produce the five reproducible Linux/macOS payloads; the iPadOS IPA is
produced separately in a protected signing environment. The comparison step
compares those five payloads byte-for-byte before the exact public file set is
assembled and checksummed.

Smoke is a separate opt-in, candidate-only v0.2.0 gate on every platform. Before
product operations, each job verifies the exact product and tooling commits,
the manifest version and tags, and the hashes of every packaged participant.
No old baseline is built or launched; the packaged server, PostgreSQL, clients,
and CLI in a smoke all come from the matching v0.2.0 candidate.

Linux smoke uses isolated PostgreSQL 16 clusters and launches the packaged
foreground registry. It verifies schema and registry health, starts the
candidate Electron client on a ready virtual display, waits for its actual
registration, and uses the packaged CLI directly against that client's own
`/ws` endpoint. It checks list, targeted push, capture, endpointless current
read, functional wrong-surface rejection, acknowledgement/no-loss, and
same-version client plus PostgreSQL/registry restart continuity. It records
participant identities and raw CLI request/response evidence. The CLI never
routes through the registry endpoint.

macOS smoke launches only the candidate Electron app and uses only the
candidate packaged CLI directly against the app's own `/ws` endpoint. It
checks list, targeted push, capture, endpointless current read, visible content,
and functional wrong-surface rejection. iOS package identity and signature are
verified through the release manifest; the smoke does not invent an iPad CLI.
Restart and reconnect checks may use the same v0.2.0 candidate, but no smoke or
release gate contains an old-version participant, upgrade-from-old phase,
rollback-to-old phase, or mixed-version pair. Historical old-version results
remain archived and neither qualify nor block this release. These tests do not
provision a shared service or use a fleet controller.

Tailnet is the deployment network-security boundary for this release; this
tooling does not add a new client-authentication protocol or central pair relay.
Surface/pane targeting and isolation remain functional acceptance requirements.
An iPad client disconnect is an ordinary client lifecycle event, not by itself
a registry/topology failure. Cross-subnet fallback is not part of this release.

## Local tagless Linux qualification

For a bounded local Linux package qualification before release refs exist, use
the builder's separate qualification-only mode with absolute paths and exact
source/tooling commit IDs:

```sh
SURF_ACE_RELEASE_COMPONENT=linux \
  node <tooling-checkout>/scripts/release/build-tightbeam-release.mjs \
  --qualification-only linux \
  --source-dir <product-checkout> \
  --source-commit 0c181cc512816ee3e03a0284fdcea9a70a175019 \
  --tooling-commit <full-40-character-tooling-commit> \
  --version 0.2.0 \
  --target x86_64-unknown-linux-gnu \
  --output-dir <fresh-absolute-scratch-directory>
```

This mode accepts no source-tag argument and reads only each checkout's `HEAD`
commit; it requires the exact product commit, a full tooling SHA matching the
tooling checkout, clean tracked inputs, and an empty or absent output directory.
It builds only the three Linux payloads, emits no manifest or checksum list,
and marks its result `qualificationOnly` and `releaseAdmitted: false`. It cannot
be used for a release. Ordinary component builds and manifest generation still
require the configured source tag and tooling tag to peel to their exact
checked-out commits.

The matching local Linux smoke qualification consumes that exact output
directory without inventing an unsigned manifest:

```sh
SURF_ACE_SMOKE_COMPONENT=linux \
  SURF_ACE_TIGHTBEAM_STATE_DRIVER=<tooling-checkout>/scripts/release/tightbeam-state-smoke-fixture.ts \
  node <tooling-checkout>/scripts/release/smoke-tightbeam-release.mjs \
  --qualification-only linux \
  --source-dir <product-checkout> \
  --source-commit 0c181cc512816ee3e03a0284fdcea9a70a175019 \
  --tooling-commit <full-40-character-tooling-commit> \
  --package-dir <same-absolute-directory-used-for-Linux-output>
```

It verifies both exact `HEAD` commits and clean tracked inputs, accepts exactly
the three Linux payload files, and hashes them before and after a candidate-only
fresh-install smoke. The smoke starts an isolated PostgreSQL registry and
packaged server, waits for a real packaged Electron client to register on a
verified display, and uses the packaged CLI directly against that client for
list, push, capture, and current-content reads. It rejects a wrong-surface
write, verifies acknowledgement and identity/content continuity through an
owned database/server restart, and proves cleanup of its owned processes. It
does not require a baseline package and makes no upgrade or rollback claim.
The ordinary manifest-based smoke uses the same candidate-only acceptance and
requires the complete six-asset checksum set plus exact source and tooling
identities.

Publication is separately opt-in and additionally protected by the release
environment. It is unreachable until both smoke jobs and their exact-file
receipts succeed, the release manifest/checksum set is verified, and build
provenance is recorded. This document and the tooling do not create a tag,
dispatch a workflow, publish assets, install a host package, or claim runtime
acceptance; those actions require separate operator authority.
