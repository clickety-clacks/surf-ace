import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { publicReleaseNames } from "./public-release-names.mjs";
import { TIGHTBEAM, TIGHTBEAM_SKILL_ASSET, TIGHTBEAM_TOOLING_TAG } from "./tightbeam-release-config.mjs";

test("published v0.2.5 download identities remain exact legacy names", () => {
  const names = publicReleaseNames({ version: "0.2.5", sourceRevision: "r4", toolingRevision: "r11", legacy: true });
  assert.equal(names.title, "Surf Ace v0.2.5");
  assert.equal(names.channel, "tightbeam-standalone");
  assert.equal(names.sourceTag, "surf-ace-tightbeam-v0.2.5-r4");
  assert.equal(names.toolingTag, "surf-ace-release-tooling-tightbeam-v0.2.5-r11");
  assert.deepEqual(names.assets, [
    "surf-ace-tightbeam-server-linux-x86_64-v0.2.5.tar.gz",
    "surf-ace-tightbeam-cli-linux-x86_64-v0.2.5.tar.gz",
    "surf-ace-tightbeam-electron-linux-x86_64-v0.2.5.zip",
    "surf-ace-tightbeam-cli-macos-arm64-v0.2.5.tar.gz",
    "surf-ace-tightbeam-electron-macos-arm64-v0.2.5.zip",
    "surf-ace-tightbeam-skill-v0.2.5.md",
  ]);
  assert.equal(names.skillAsset, "surf-ace-tightbeam-skill-v0.2.5.md");
  assert.equal(names.manifest, "surf-ace-tightbeam-v0.2.5-manifest.json");
  assert.equal(names.checksums, "SHA256SUMS");
});

test("future public release names identify Surf Ace without a Tightbeam product prefix", () => {
  const names = publicReleaseNames({ version: "0.2.8", sourceRevision: "r1", toolingRevision: "r1" });
  assert.equal(names.title, "Surf Ace v0.2.8");
  assert.equal(names.channel, "surf-ace");
  assert.equal(names.sourceTag, "surf-ace-v0.2.8-r1");
  assert.equal(names.toolingTag, "surf-ace-release-tooling-v0.2.8-r1");
  assert.equal(names.assets[0], "surf-ace-server-linux-x86_64-v0.2.8.tar.gz");
  assert.equal(names.assets[5], "surf-ace-skill-v0.2.8.md");
  assert.equal(names.manifest, "surf-ace-v0.2.8-manifest.json");
  assert.deepEqual(TIGHTBEAM.assets, names.assets);
  assert.equal(TIGHTBEAM_SKILL_ASSET, names.skillAsset);
  assert.equal(TIGHTBEAM_TOOLING_TAG, names.toolingTag);
  assert.doesNotMatch(JSON.stringify(names), /tightbeam/i);
  assert.throws(() => publicReleaseNames({ version: "0.2.8", sourceRevision: "r1", toolingRevision: "r1", legacy: true }), /legacy_release_naming_is_v025_only/);
});

test("the pinned release workflow uses the product title, not integration branding", async () => {
  const workflow = await fs.readFile(new URL("../../.github/workflows/release-tightbeam.yml", import.meta.url), "utf8");
  assert.match(workflow, /^name: Build standalone Surf Ace release$/m);
  assert.ok(workflow.includes(`PRODUCT_VERSION: ${TIGHTBEAM.version}`));
  assert.match(workflow, /--title "Surf Ace v\$\{PRODUCT_VERSION\}"/);
  assert.doesNotMatch(workflow, /--title "Surf Ace Tightbeam/);
  for (const name of [...TIGHTBEAM.assets, TIGHTBEAM.manifest]) {
    assert.ok(workflow.includes(name), `release workflow omits configured asset ${name}`);
  }
});
