const VERSION = /^\d+\.\d+\.\d+$/;
const REVISION = /^r[1-9]\d*$/;

export function publicReleaseNames({ version, sourceRevision, toolingRevision, legacy = false }) {
  if (!VERSION.test(version ?? "")) throw new Error("release_version_invalid");
  if (!REVISION.test(sourceRevision ?? "") || !REVISION.test(toolingRevision ?? "")) {
    throw new Error("release_revision_invalid");
  }
  if (legacy && version !== "0.2.5") throw new Error("legacy_release_naming_is_v025_only");

  const stem = legacy ? "surf-ace-tightbeam" : "surf-ace";
  const skillAsset = `${stem}-skill-v${version}.md`;
  const assets = Object.freeze([
    `${stem}-server-linux-x86_64-v${version}.tar.gz`,
    `${stem}-cli-linux-x86_64-v${version}.tar.gz`,
    `${stem}-electron-linux-x86_64-v${version}.zip`,
    `${stem}-cli-macos-arm64-v${version}.tar.gz`,
    `${stem}-electron-macos-arm64-v${version}.zip`,
    skillAsset,
  ]);

  return Object.freeze({
    version,
    title: `Surf Ace v${version}`,
    channel: legacy ? "tightbeam-standalone" : "surf-ace",
    sourceTag: `${stem}-v${version}-${sourceRevision}`,
    toolingTag: legacy
      ? `surf-ace-release-tooling-tightbeam-v${version}-${toolingRevision}`
      : `surf-ace-release-tooling-v${version}-${toolingRevision}`,
    assets,
    skillAsset,
    manifest: `${stem}-v${version}-manifest.json`,
    checksums: "SHA256SUMS",
  });
}
