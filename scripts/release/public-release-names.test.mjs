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
  assert.equal(names.toolingTag, TIGHTBEAM_TOOLING_TAG);
  assert.deepEqual(names.assets, TIGHTBEAM.assets);
  assert.equal(names.skillAsset, TIGHTBEAM_SKILL_ASSET);
  assert.equal(names.manifest, TIGHTBEAM.manifest);
  assert.equal(names.checksums, TIGHTBEAM.checksums);
});

test("future public release names identify Surf Ace without a Tightbeam product prefix", () => {
  const names = publicReleaseNames({ version: "0.2.6", sourceRevision: "r1", toolingRevision: "r1" });
  assert.equal(names.title, "Surf Ace v0.2.6");
  assert.equal(names.channel, "surf-ace");
  assert.equal(names.sourceTag, "surf-ace-v0.2.6-r1");
  assert.equal(names.toolingTag, "surf-ace-release-tooling-v0.2.6-r1");
  assert.equal(names.assets[0], "surf-ace-server-linux-x86_64-v0.2.6.tar.gz");
  assert.equal(names.assets[5], "surf-ace-skill-v0.2.6.md");
  assert.equal(names.manifest, "surf-ace-v0.2.6-manifest.json");
  assert.doesNotMatch(JSON.stringify(names), /tightbeam/i);
  assert.throws(() => publicReleaseNames({ version: "0.2.6", sourceRevision: "r1", toolingRevision: "r1", legacy: true }), /legacy_release_naming_is_v025_only/);
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
