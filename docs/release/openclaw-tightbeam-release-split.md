# Surf Ace release split

Revision: 5, superseding proposed revision 4 `art_0922f408`

Status: proposed. This specification creates no source change, Git ref,
workflow, artifact, release, deployment, service, fleet, or product state.

## Spec home

The canonical repository home is
`docs/release/openclaw-tightbeam-release-split.md` in
`clickety-clacks/surf-ace`. Until reviewed bytes merge there, the immutable
Tightbeam artifact ID and SHA-256 named by the review are the authority.

## Goal

Publish one reproducible final OpenClaw-compatible release from exact commit
`58ac8c435679e6611903d31abaecec11bb9d7f75`. Then move `main` to a separately
reviewed Tightbeam-first commit and publish a reproducible Tightbeam-first
release without an OpenClaw compatibility obligation.

Every published file must pass tests, two-clean-build comparison, and artifact
smoke before publication.

## Non-goals

- This specification does not perform a release action.
- It does not preserve OpenClaw provider compatibility after `58ac8c4`.
- It does not publish iPad Simulator, `SurfAceSpatial`, Linux compositor, or
  OpenClaw Rust CLI artifacts.
- It does not define physical-device signing or installation as a publication
  gate.
- It does not permit local, fleet, or manual release inputs.

## Terms

- **Cutoff**: the exact last OpenClaw-compatible commit, `58ac8c4`.
- **Boundary**: `779c493`, where mainline discovery moves into the controller.
- **Candidate**: the exact reviewed commit proposed for Tightbeam-first
  `main`. The current candidate is `ec623c54616b`.
- **Release owner**: an authorized human who alone may move Git refs after all
  earlier gates pass. An agent may prepare evidence but may not create, move,
  delete, or push a branch or tag under this specification.
- **Tooling ref**: immutable tag `surf-ace-release-tooling-v0.1.0` at the exact
  reviewed implementation commit that contains the canonical spec, workflows,
  build programs, and smoke programs. It is not a product source tag.
- **Artifact smoke**: install, health, upgrade, rollback, and post-rollback
  health checks against the packaged files in a new environment.
- **Immutable**: an existing tag or published file is never moved, deleted,
  recreated, or replaced.

## Assumptions

- The release implementation will establish `clickety-clacks/surf-ace`
  before any ref cut.
- GitHub Actions can build both exact source commits on pinned Linux and macOS
  environments.
- OpenClaw smoke uses immediate predecessor commit
  `d889f2f4bfb554bc3bfde0eb9927372552d40e51` as its test-only baseline.
- Tightbeam-first smoke uses immediate predecessor commit
  `24b4a389bd2dceb29307a2308b70520adb3571db` as its test-only baseline.
- Baseline bytes are test inputs only. They are never public release inputs.

## Invariants

1. `surf-ace-openclaw-v0.1.0` always resolves to `58ac8c4`.
2. `surf-ace-release-tooling-v0.1.0` always resolves to the one reviewed
   tooling commit approved at Gate 2.
3. A published tag, checksum, manifest, and file never change.
4. GitHub Actions builds every public file from its recorded product source
   tag while executing only tooling checked out at the recorded tooling tag.
5. Tooling never changes a tracked byte in a product-tag checkout.
6. The bytes that pass artifact smoke are the bytes that GitHub Releases
   publishes.
7. Both clean builds produce identical SHA-256 records before smoke starts.
8. Each channel uses distinct tags and filenames.
9. No publication occurs before artifact smoke passes for that channel.
10. A reviewer approves the exact spec and source commit before each ref move.

## Architecture

### Source boundary

The final OpenClaw-compatible cutoff is
`58ac8c435679e6611903d31abaecec11bb9d7f75` (`58ac8c4`, `Fix lockless
acknowledgement reconnects`). The release owner creates
`release/openclaw-final` and `surf-ace-openclaw-v0.1.0` at that exact commit.

Commit `779c49347f7152c20f62f0bed0bab13ab2710769` (`779c493`) is the
mainline architecture boundary. It moves fleet discovery from the OpenClaw
extension to the controller package.

Commit `8b17d39200ef8c5e8cedc1930378ca2daf1999e0` (`8b17d39`) is a sibling
direct child of `58ac8c4`. It is not a child of `779c493` and not an ancestor
of the current candidate. Both children confirm the cutoff.

The current Tightbeam-first candidate is
`ec623c54616b6c71a180cede45a91bc54269238c` (`ec623c54616b`). It contains
the resident controller, thin local CLI, half-close fix, corrected install
layout, and graceful supervisor shutdown.

After separate source review, the release owner fast-forwards `main` to the
approved full candidate SHA and pushes `refs/heads/main`. A merge commit is
not permitted unless a separate review approves that exact merge commit as
the candidate. The release owner then creates
`surf-ace-tightbeam-v0.2.0` at the exact new `main` commit.

### Public destination

The only authorized public repository is `clickety-clacks/surf-ace` on
GitHub. GitHub Actions must build, test, attest, package, and smoke every
public file. GitHub Releases in that repository must publish every public
file. Each third-party action must use an immutable commit SHA.

### Release files

The final OpenClaw release uses tag `surf-ace-openclaw-v0.1.0` and source
commit `58ac8c435679e6611903d31abaecec11bb9d7f75`.

1. `surf-ace-openclaw-extension-v0.1.0.tgz`
   - Build only from `packages/extension`.
   - Include the built extension, plugin manifest, skills, protocol schemas,
     and production runtime dependencies.
2. `surf-ace-openclaw-electron-macos-arm64-v0.1.0.zip`
   - Build only from `packages/electron` at the same source commit.
3. `surf-ace-openclaw-v0.1.0-manifest.json`
   - Record the product tag, full source commit, tooling tag, full tooling
     commit, checksums, toolchains, commands, test outcomes, smoke
     requirements, dependency inventory or SBOM, and provenance.

The Tightbeam-first release uses tag `surf-ace-tightbeam-v0.2.0` and the
exact reviewed `main` commit. The current candidate is
`ec623c54616b6c71a180cede45a91bc54269238c`.

1. `surf-ace-tightbeam-linux-x86_64-v0.2.0.tar.gz`
   - Include the resident controller, thin Rust CLI, systemd unit,
     supervisor, and production runtime dependencies.
2. `surf-ace-tightbeam-electron-macos-arm64-v0.2.0.zip`
   - Build only from `packages/electron` at the same source commit.
3. `surf-ace-tightbeam-v0.2.0-manifest.json`
   - Record the product tag, full source commit, tooling tag, full tooling
     commit, checksums, toolchains, commands, test outcomes, smoke
     requirements, dependency inventory or SBOM, compatibility, and
     provenance.

The channel name is part of every filename.

### Unsupported artifacts

The release matrix contains no iPad Simulator or `SurfAceSpatial` artifact.
The clean checkout lacks shared build and test schemes for those targets.

The matrix contains no Linux compositor client. The repository lacks a
deterministic CI package target for it.

The OpenClaw matrix contains no Rust CLI. At `58ac8c4`, that CLI is a direct
per-invocation controller and lacks the required resident behavior.

### Immutable tooling and source checkouts

Gate 2 adds the repository-owned release programs under
`scripts/release/` and workflows under `.github/workflows/`. An independent
review approves their exact implementation commit. The release owner then
creates `surf-ace-release-tooling-v0.1.0` at that commit and verifies the
remote tag peels to the reviewed full SHA.

Every release job checks that tooling tag into `tooling/` and checks the
product source tag into a separate new `source/` directory. Commands that
operate on the product run with `source/` as their source directory. They may
create only dependency and generated-build paths ignored by that product
commit; public outputs go only to a new job-owned `build/` directory. No
command may edit an input tracked at the product tag. Before and after every
test, package, and smoke phase, these commands must succeed and print no
diff:

```sh
git -C source diff --exit-code HEAD -- .
git -C source diff --cached --exit-code HEAD -- .
```

The workflow stops if the tooling tag or product tag does not peel to the
manifest’s full commit or if a tracked product input changes. Each build job
removes its whole workspace, including ignored dependency and generated-build
paths, after retaining only the compared files and receipts. The tooling tag
may be superseded only by a newly named, separately reviewed tooling tag; it
is never moved.

### Reproducible builds

The workflow must pin every applicable toolchain before packaging review.
Node jobs must pin exact Node and pnpm versions. Every Node install must use
the committed root `pnpm-lock.yaml`. Before installation, the job records that
lockfile's SHA-256 in the manifest. It then populates the content-addressed
pnpm store and installs the workspace with these exact commands:

```sh
pnpm --dir source fetch --frozen-lockfile
pnpm --dir source install --offline --frozen-lockfile
```

The offline install must fail when a package is absent from the fetched store
or when package bytes do not match an integrity value in `pnpm-lock.yaml`.
No command may update that lockfile or substitute a registry resolution. The
OpenClaw production dependency tree must come only from the resulting frozen
pnpm closure; `npm install` is forbidden when assembling that release file.

The Tightbeam Rust job must pin the Rust toolchain and target. Every Cargo
command must use `packages/cli/Cargo.lock` with `--locked`. Linux jobs must pin
their build container by digest. macOS jobs must pin the runner image and the
exact Xcode version when a packaging command calls an Xcode tool. The manifest
records every pinned value.

Each channel must pass this procedure:

1. GitHub Actions checks out the exact tooling tag and exact product source
   tag into new, separate workspaces.
2. Two independent build jobs each create a new `source/` checkout and an
   empty `build/` directory.
3. Each job installs only from frozen lockfiles and pinned tools.
4. Each job runs the same test and package commands.
5. Each job generates the complete three-file release set, including a
   canonical JSON manifest with sorted keys and no clock, host, workspace, or
   run-specific value.
6. Each job writes filename-sorted SHA-256 records for all three files.
7. The workflow compares the two record sets byte for byte and then compares
   the three files byte for byte.

The tooling build programs normalize archive entry order, paths, modes,
owners, group, and modification times from `SOURCE_DATE_EPOCH`, which equals
the product commit time. They reject absolute paths and links escaping the
archive root. Changing metadata stays outside the compared files. Any
mismatch stops the release.

### Executable tests

The immutable cutoff already contains the complete extension suite but only
names `test:lockless` in `packages/extension/package.json`. The tooling
workflow must leave those tagged bytes unchanged and run all five
`src/*.test.ts` files plus `scripts/rollback-preflight.test.mjs` directly:

```sh
pnpm --dir source/packages/extension exec sh -c \
  'node --import tsx --test src/*.test.ts scripts/*.test.mjs'
```

The OpenClaw workflow must then run these exact commands at `58ac8c4`:

```sh
pnpm --dir source --filter @surf-ace/controller test
pnpm --dir source --filter @surf-ace/protocol test
pnpm --dir source --filter @surf-ace/electron build
pnpm --dir source --filter @surf-ace/electron test
```

Success means every extension test, every controller test, every protocol
test, and every built Electron test passes. `test:lockless` alone is not
sufficient. The tracked source bytes must remain unchanged.

The Tightbeam-first workflow must run these exact commands at the approved
candidate:

```sh
pnpm --dir source --filter @surf-ace/controller test
pnpm --dir source --filter @surf-ace/protocol test
cargo test --manifest-path source/packages/cli/Cargo.toml --locked
pnpm --dir source --filter @surf-ace/electron build
pnpm --dir source --filter @surf-ace/electron test
```

Success means all controller and protocol tests pass, all Rust CLI tests pass,
and all built Electron tests pass. The controller suite includes
`src/packaging.test.ts`, which must prove `SIGTERM` and `SIGINT` stop and reap
both supervisor children.

### Deterministic packaging commands

After OpenClaw tests pass, each clean-build job runs exactly:

```sh
node tooling/scripts/release/build-openclaw-release.mjs \
  --source-dir source \
  --output-dir build/release/openclaw \
  --source-tag surf-ace-openclaw-v0.1.0 \
  --source-commit 58ac8c435679e6611903d31abaecec11bb9d7f75 \
  --version 0.1.0
```

The program must not invoke the cutoff Makefile's `package` or
`verify-package` targets, because that path runs an unlocked `npm install`.
Instead, it must run these exact build and frozen-deployment commands:

```sh
pnpm --dir source --filter @surf-ace/protocol build
pnpm --dir source --filter @surf-ace/controller build
pnpm --dir source --filter @surf-ace/extension build
pnpm --dir source --filter @surf-ace/extension --prod deploy \
  --legacy "$GITHUB_WORKSPACE/build/release/openclaw/dependency-closure"
pnpm --dir source --filter @surf-ace/electron package
```

The tooling program must assemble the same extension, plugin manifest, skills,
protocol schemas, compiled controller/protocol workspace packages, and runtime
entry layout that the cutoff verifier requires. It may copy production
`node_modules` only from `dependency-closure`, which `pnpm deploy` derives
from the already installed frozen root lockfile. It must then run:

```sh
node tooling/scripts/release/verify-openclaw-package.mjs \
  --package-dir build/release/openclaw/package-root \
  --lockfile source/pnpm-lock.yaml
```

The verifier must fail unless every packaged third-party production package
has the exact name, version, and integrity recorded by `pnpm-lock.yaml`, both
workspace packages have the expected built files, and the complete cutoff
package contract passes. The canonical manifest records the lockfile SHA-256
and a filename-sorted production dependency inventory of those locked
name/version/integrity triples.

Only after that verification may the build program create a normalized
tar-gzip containing the complete package tree, including its production
`node_modules`, and a normalized zip from
`source/packages/electron/dist/package/mac-arm64/Surf Ace.app`. It must
produce exactly the three OpenClaw filenames listed in **Release files**, with
no extra public file. The tracked source bytes must remain unchanged.

After Tightbeam-first tests pass, each clean-build job runs exactly:

```sh
node tooling/scripts/release/build-tightbeam-release.mjs \
  --source-dir source \
  --output-dir build/release/tightbeam \
  --source-tag surf-ace-tightbeam-v0.2.0 \
  --source-commit ec623c54616b6c71a180cede45a91bc54269238c \
  --version 0.2.0 \
  --target x86_64-unknown-linux-gnu
```

If source review approves another candidate, both the product tag and
`--source-commit` must name that same full SHA. The program must run
`pnpm --dir source --filter @surf-ace/controller package:linux -- <new-stage>`,
run `pnpm --dir source --filter @surf-ace/electron package`, normalize and
rename the staged Linux archive and Electron app zip, and write the canonical
manifest. It must produce exactly the three Tightbeam-first filenames listed
in **Release files**, with no extra public file. Packaging must use a new
output path and a valid unit without changing the checkout. The Tightbeam
smoke installs the package at `/opt/surf-ace` and runs:

```sh
systemd-analyze verify /opt/surf-ace/surf-ace-controller.service
```

### OpenClaw smoke host contract

OpenClaw smoke uses a disposable GitHub Actions macOS environment and pins the
host to npm package `openclaw@2026.7.1-2`, integrity
`sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==`.
The workflow gives the process a new empty `HOME`, installs no global package
outside its job-owned prefix, and exposes no fleet credentials or state.

For candidate clean-install, upgrade, and rollback phases, the smoke program
must execute these host operations against the appropriate candidate or
test-only baseline extension archive:

```sh
npm pack --pack-destination "$OPENCLAW_FETCH" openclaw@2026.7.1-2
node tooling/scripts/release/verify-sri.mjs \
  --file "$OPENCLAW_FETCH/openclaw-2026.7.1-2.tgz" \
  --expected "sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g=="
npm install --global --prefix "$OPENCLAW_PREFIX" \
  "$OPENCLAW_FETCH/openclaw-2026.7.1-2.tgz"
openclaw --version
openclaw plugins install "$EXTENSION_TGZ" --force
openclaw plugins enable surf-ace
SURF_ACE_ALLOW_NON_TARS_PROVIDER=1 \
  openclaw gateway --port 18789 --verbose
openclaw gateway status --deep --require-rpc
openclaw plugins inspect surf-ace --runtime --json
```

Here `$OPENCLAW_FETCH`, `$OPENCLAW_PREFIX`, and `HOME` are new job-owned
directories; `openclaw` resolves only from `$OPENCLAW_PREFIX/bin`; and
`$EXTENSION_TGZ` resolves to the smoke phase's checksum-verified archive.
`verify-sri.mjs` must compute SRI SHA-512 over the downloaded tarball, compare
it byte for byte with the literal `--expected` value, and stop before
installation on any mismatch. The local verified tarball is the only permitted
OpenClaw install input. Before gateway start, the program must write this exact
plugin admission shape into that profile's `.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["surf-ace"],
    "entries": {"surf-ace": {"enabled": true}}
  },
  "tools": {
    "alsoAllow": ["surf-ace"],
    "profile": "coding"
  }
}
```

`SURF_ACE_ALLOW_NON_TARS_PROVIDER=1` is an explicit test-only override already
defined by the cutoff. It applies only to the disposable gateway process and
does not authorize a non-TARS deployment.

The phase passes only when the OpenClaw tarball passes the literal SRI check
before installation, `openclaw --version` reports `2026.7.1-2`, gateway
status exits zero with the deep RPC check satisfied, and plugin inspection
returns JSON identifying `surf-ace` as enabled and runtime-loaded with
`surf_ace_list` among its registered tools and no load diagnostic. Any other
version, failed RPC, absent tool, disabled/unloaded plugin, diagnostic, or
early gateway exit fails the phase. The program must terminate the gateway,
prove no child remains, and remove the profile and install prefix after each
phase.

### Artifact smoke before publication

The immutable tooling tag owns two smoke programs. They run only in disposable
GitHub Actions environments. They must fail on an unexpected checksum,
install path, process owner, health response, upgrade result, rollback result,
or residual process.

Before OpenClaw publication, GitHub Actions must run:

```sh
node tooling/scripts/release/smoke-openclaw-release.mjs \
  --baseline-commit d889f2f4bfb554bc3bfde0eb9927372552d40e51 \
  --candidate-commit 58ac8c435679e6611903d31abaecec11bb9d7f75 \
  --openclaw-version 2026.7.1-2 \
  --manifest build/release/openclaw/surf-ace-openclaw-v0.1.0-manifest.json \
  --extension build/release/openclaw/surf-ace-openclaw-extension-v0.1.0.tgz \
  --electron build/release/openclaw/surf-ace-openclaw-electron-macos-arm64-v0.1.0.zip
```

The command must verify checksums and clean-install both candidate packages.
It must satisfy the pinned OpenClaw host contract above, launch the packaged
Electron client in the disposable macOS smoke job, and receive its expected
protocol handshake. It must then install the test-only baseline, upgrade to
the candidate, repeat the host and Electron health checks, restore the
baseline, repeat post-rollback health, and remove every process and temporary
profile. The baseline is built in a separate test-only directory and never
enters the public file set.

Before Tightbeam-first publication, GitHub Actions must run:

```sh
node tooling/scripts/release/smoke-tightbeam-release.mjs \
  --baseline-commit 24b4a389bd2dceb29307a2308b70520adb3571db \
  --candidate-commit ec623c54616b6c71a180cede45a91bc54269238c \
  --manifest build/release/tightbeam/surf-ace-tightbeam-v0.2.0-manifest.json \
  --backend build/release/tightbeam/surf-ace-tightbeam-linux-x86_64-v0.2.0.tar.gz \
  --electron build/release/tightbeam/surf-ace-tightbeam-electron-macos-arm64-v0.2.0.zip
```

If review approves a different candidate, the command must use that exact SHA
instead of `ec623c54616b`. The command must verify checksums and clean-install
both candidate packages. It must start exactly one packaged controller, run
the packaged CLI health and list requests, and verify the Electron handshake.
It must upgrade from the test-only baseline, verify health and canonical state
reuse, restore the baseline, verify post-rollback health, and remove every
process and temporary state directory.

GitHub Actions must store each smoke receipt as an immutable attestation for
the tooling tag and commit, product source tag and commit, manifest SHA-256,
and release-file SHA-256 set. It must not change any release file after the
two-clean-build comparison. The GitHub Release must link the passing
attestation before publication.

### Compatibility

- `surf-ace-openclaw-v0.1.0` supports the canonical OpenClaw provider contract
  at `58ac8c4` on pinned host `openclaw@2026.7.1-2`.
- Tightbeam-first `main` uses one resident controller for discovery, durable
  topology, identity, reconnects, and discovery-loss retention.
- The Tightbeam Rust CLI is only a local thin client.
- Tightbeam-first work does not preserve the OpenClaw provider API or its
  deployment model.
- A manifest promises shared wire compatibility only when its protocol tests
  pass.

### Immutable withdrawal and rollback

A bad public release remains as historical evidence. Withdrawal uses a new,
append-only patch release. Its manifest names the withdrawn tag and checksums
in `withdraws` and names the new tag in `supersedes`. GitHub Release notes must
show the same relationship.

An OpenClaw correction starts from `58ac8c4` plus separately reviewed security
or critical data-loss fixes. It uses the next `0.1.x` tag and
channel-specific filenames. A Tightbeam-first correction uses a reviewed
forward fix or revert commit and the next `0.2.x` tag. No rollback moves
`main` backward or moves an existing tag.

Consumers roll back by installing the last non-withdrawn immutable release.
The replacement must pass all tests, two-clean-build comparison, and artifact
smoke before it supersedes the bad release.

## Acceptance

The release must follow these gates in order:

1. An independent reviewer approves the exact revision-5 bytes.
2. A reviewed implementation lands the canonical spec, GitHub Actions,
   pinned tools, direct immutable-checkout tests, deterministic package
   programs, and both smoke programs in `clickety-clacks/surf-ace`. The
   release owner creates `surf-ace-release-tooling-v0.1.0` at that exact
   reviewed commit and verifies its remote peel.
3. The release owner creates `release/openclaw-final` and immutable tag
   `surf-ace-openclaw-v0.1.0` at exact commit `58ac8c4`. The owner verifies
   both remote refs peel to that commit.
4. GitHub Actions executes from the immutable tooling tag, checks out the
   OpenClaw product tag separately, runs every test, builds the three files
   twice, and verifies identical SHA-256 records and file bytes.
5. GitHub Actions runs the OpenClaw artifact smoke against those exact files.
   Clean install, pinned-host RPC health, plugin runtime inspection, Electron
   health, upgrade, rollback, and post-rollback health pass.
6. GitHub Actions publishes only the smoke-approved OpenClaw files to the
   matching GitHub Release.
7. A clean consumer downloads every OpenClaw file and verifies its checksum.
8. A separate review approves the exact Tightbeam-first target commit.
9. The release owner fast-forwards and pushes `refs/heads/main` to that full
   SHA. The owner verifies the remote `main` ref and the unchanged OpenClaw
   refs.
10. The release owner creates immutable tag `surf-ace-tightbeam-v0.2.0` at the
    exact new `main` commit and verifies the remote tag peels to that commit.
11. GitHub Actions executes from the immutable tooling tag, checks out the
    Tightbeam-first product tag separately, runs every test, builds the three
    files twice, and verifies identical SHA-256 records and file bytes.
12. GitHub Actions runs the Tightbeam-first artifact smoke against those exact
    files. Clean install, health, upgrade, rollback, state reuse, and
    post-rollback health pass.
13. GitHub Actions publishes only the smoke-approved Tightbeam-first files to
    the matching GitHub Release.
14. A clean consumer downloads every Tightbeam-first file and verifies its
    checksum, install, service ownership, and health.
15. The fleet soak uses only the published files. Device installation remains
    later user verification.

Stop before the next gate when a required review is not clean. Stop when any
ref, source, destination, version, toolchain, lockfile, command, or checksum is
ambiguous. Stop when a test does not run, two builds differ, smoke fails, or
the publish set differs from the smoke set. Stop when any public file comes
from a local, fleet, or manual build.

## Open questions

None. A newly discovered unresolved question requires a reviewed spec revision
before any later gate continues.
