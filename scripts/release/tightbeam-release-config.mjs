export const TIGHTBEAM_TOOLING_TAG = "surf-ace-release-tooling-tightbeam-v0.2.5-r10";

export const TIGHTBEAM_SKILL_ASSET = "surf-ace-tightbeam-skill-v0.2.5.md";

export const TOOLCHAINS = Object.freeze({
  linuxContainer: "rust:1.89.0-bookworm@sha256:948f9b08a66e7fe01b03a98ef1c7568292e07ec2e4fe90d88c07bb14563c84ff",
  macosRunner: "xcode-27",
  node: "24.3.0",
  pnpm: "10.15.1",
  postgres: "16",
  rust: "1.89.0",
  linuxRustTarget: "x86_64-unknown-linux-gnu",
  macosRustTarget: "aarch64-apple-darwin",
  xcode: "27.0",
});

export const TIGHTBEAM = Object.freeze({
  candidateCommit: "a2f4122883fa875624f9e37d6f18dbeaef1d1072",
  sourceTag: "surf-ace-tightbeam-v0.2.5-r3",
  version: "0.2.5",
  toolingTag: TIGHTBEAM_TOOLING_TAG,
  assets: [
    "surf-ace-tightbeam-server-linux-x86_64-v0.2.5.tar.gz",
    "surf-ace-tightbeam-cli-linux-x86_64-v0.2.5.tar.gz",
    "surf-ace-tightbeam-electron-linux-x86_64-v0.2.5.zip",
    "surf-ace-tightbeam-cli-macos-arm64-v0.2.5.tar.gz",
    "surf-ace-tightbeam-electron-macos-arm64-v0.2.5.zip",
    TIGHTBEAM_SKILL_ASSET,
  ],
  manifest: "surf-ace-tightbeam-v0.2.5-manifest.json",
  checksums: "SHA256SUMS",
});

export const TIGHTBEAM_ROUTING = Object.freeze({
  clientOperations: "packaged-cli-direct-to-client-websocket",
  registryResponsibilities: ["client-registration", "global-window-label-allocation", "postgresql-backed-registry-health"],
  securityBoundary: "tailnet",
});

export const TIGHTBEAM_PUBLIC_FILES = Object.freeze([
  ...TIGHTBEAM.assets,
  TIGHTBEAM.manifest,
  TIGHTBEAM.checksums,
]);

export const TIGHTBEAM_TEST_COMMANDS = Object.freeze([
  "pnpm --dir source --filter @surf-ace/protocol build",
  "pnpm --dir source --filter @surf-ace/allocator build",
  "pnpm --dir source --filter @surf-ace/controller build",
  "pnpm --dir source --filter @surf-ace/electron build",
  "pnpm --dir source --filter @surf-ace/controller test",
  "pnpm --dir source --filter @surf-ace/protocol test",
  "cargo test --manifest-path source/packages/cli/Cargo.toml --locked",
  "pnpm --dir source --filter @surf-ace/electron test",
  "xcodebuild test -project source/packages/ios/SurfAce.xcodeproj -scheme SurfAce -configuration Release ENABLE_TESTABILITY=YES -parallel-testing-enabled NO -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5),OS=27.0'",
]);

export const TIGHTBEAM_BUILD_COMMANDS = Object.freeze([
  "pnpm --dir source fetch --frozen-lockfile",
  "pnpm --dir source install --offline --frozen-lockfile",
  "cargo build --manifest-path source/packages/cli/Cargo.toml --target-dir source/packages/cli/target --release --locked --target x86_64-unknown-linux-gnu",
  "pnpm --dir source --filter @surf-ace/protocol build",
  "pnpm --dir source --filter @surf-ace/allocator build",
  "pnpm --dir source --filter @surf-ace/controller build",
  "pnpm --dir source --filter @surf-ace/electron build",
  "pnpm --dir source --filter @surf-ace/electron exec electron-builder --linux dir --x64 --publish never --config.executableName surf-ace",
  "cargo build --manifest-path source/packages/cli/Cargo.toml --target-dir source/packages/cli/target --release --locked --target aarch64-apple-darwin",
  "pnpm --dir source --filter @surf-ace/electron exec electron-builder --mac dir --arm64 --publish never",
]);
