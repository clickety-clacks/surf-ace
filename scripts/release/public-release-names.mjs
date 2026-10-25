const VERSION = /^\d+\.\d+\.\d+(?:-rc[1-9]\d*)?$/;
const REVISION = /^r[1-9]\d*$/;
const PRODUCT_TAG = /^surf-ace-v(\d+\.\d+\.\d+(?:-rc[1-9]\d*))-(r[1-9]\d*)$/;
const TOOLING_TAG = /^surf-ace-release-tooling-v(\d+\.\d+\.\d+(?:-rc[1-9]\d*))-(r[1-9]\d*)$/;

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

export function publicReleaseNamesFromTags({ productTag, toolingTag }) {
  const productMatch = PRODUCT_TAG.exec(productTag ?? "");
  const toolingMatch = TOOLING_TAG.exec(toolingTag ?? "");
  if (!productMatch || !toolingMatch) throw new Error("release_tag_invalid");
  if (productMatch[1] !== toolingMatch[1]) throw new Error("release_tag_version_mismatch");

  const names = publicReleaseNames({
    version: productMatch[1],
    sourceRevision: productMatch[2],
    toolingRevision: toolingMatch[2],
  });
  if (names.sourceTag !== productTag || names.toolingTag !== toolingTag) {
    throw new Error("release_tag_name_mismatch");
  }
  return names;
}
