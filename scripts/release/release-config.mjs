export const TOOLING_TAG = "surf-ace-release-tooling-v0.1.0";

export const TOOLCHAINS = Object.freeze({
  linuxContainer: "rust:1.89.0-bookworm@sha256:948f9b08a66e7fe01b03a98ef1c7568292e07ec2e4fe90d88c07bb14563c84ff",
  macosRunner: "macos-15",
  node: "24.3.0",
  pnpm: "10.15.1",
  rust: "1.89.0",
  rustTarget: "x86_64-unknown-linux-gnu",
  xcode: "16.4",
});

export const OPENCLAW = Object.freeze({
  baselineCommit: "d889f2f4bfb554bc3bfde0eb9927372552d40e51",
  candidateCommit: "58ac8c435679e6611903d31abaecec11bb9d7f75",
  files: [
    "surf-ace-openclaw-electron-macos-arm64-v0.1.0.zip",
    "surf-ace-openclaw-extension-v0.1.0.tgz",
    "surf-ace-openclaw-v0.1.0-manifest.json",
  ],
  hostIntegrity: "sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==",
  hostVersion: "2026.7.1-2",
  sourceTag: "surf-ace-openclaw-v0.1.0",
  version: "0.1.0",
});

export const TIGHTBEAM = Object.freeze({
  baselineCommit: "24b4a389bd2dceb29307a2308b70520adb3571db",
  candidateCommit: "ec623c54616b6c71a180cede45a91bc54269238c",
  files: [
    "surf-ace-tightbeam-electron-macos-arm64-v0.2.0.zip",
    "surf-ace-tightbeam-linux-x86_64-v0.2.0.tar.gz",
    "surf-ace-tightbeam-v0.2.0-manifest.json",
  ],
  sourceTag: "surf-ace-tightbeam-v0.2.0",
  version: "0.2.0",
});

export const OPENCLAW_TEST_COMMANDS = Object.freeze([
  "pnpm --dir source/packages/extension exec sh -c 'node --import tsx --test src/*.test.ts scripts/*.test.mjs'",
  "pnpm --dir source --filter @surf-ace/controller test",
  "pnpm --dir source --filter @surf-ace/protocol test",
  "pnpm --dir source --filter @surf-ace/electron build",
  "pnpm --dir source --filter @surf-ace/electron test",
]);

export const OPENCLAW_BUILD_COMMANDS = Object.freeze([
  "pnpm --dir source fetch --frozen-lockfile",
  "pnpm --dir source install --offline --frozen-lockfile",
  "pnpm --dir source --filter @surf-ace/protocol build",
  "pnpm --dir source --filter @surf-ace/controller build",
  "pnpm --dir source --filter @surf-ace/extension build",
  "pnpm --dir source --filter @surf-ace/extension --prod deploy --legacy $GITHUB_WORKSPACE/build/release/openclaw/dependency-closure",
  "pnpm --dir source --filter @surf-ace/electron package",
  "node tooling/scripts/release/verify-openclaw-package.mjs --package-dir build/release/openclaw/package-root --lockfile source/pnpm-lock.yaml",
]);

export const TIGHTBEAM_TEST_COMMANDS = Object.freeze([
  "pnpm --dir source --filter @surf-ace/controller test",
  "pnpm --dir source --filter @surf-ace/protocol test",
  "cargo test --manifest-path source/packages/cli/Cargo.toml --locked",
  "pnpm --dir source --filter @surf-ace/electron build",
  "pnpm --dir source --filter @surf-ace/electron test",
]);

export const TIGHTBEAM_BUILD_COMMANDS = Object.freeze([
  "pnpm --dir source fetch --frozen-lockfile",
  "pnpm --dir source install --offline --frozen-lockfile",
  "pnpm --dir source --filter @surf-ace/controller package:linux -- <new-stage>",
  "pnpm --dir source --filter @surf-ace/electron package",
]);
