import "./test-release-env.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { publicReleaseNames, publicReleaseNamesFromTags } from "./public-release-names.mjs";
import { TIGHTBEAM, TIGHTBEAM_SKILL_ASSET, TIGHTBEAM_TOOLING_TAG } from "./tightbeam-release-config.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

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

test("stable public release names identify Surf Ace", () => {
  const names = publicReleaseNames({ version: "0.2.8", sourceRevision: "r1", toolingRevision: "r1" });
  assert.equal(names.title, "Surf Ace v0.2.8");
  assert.equal(names.channel, "surf-ace");
  assert.equal(names.sourceTag, "surf-ace-v0.2.8-r1");
  assert.equal(names.toolingTag, "surf-ace-release-tooling-v0.2.8-r1");
  assert.equal(names.assets[0], "surf-ace-server-linux-x86_64-v0.2.8.tar.gz");
  assert.equal(names.assets[5], "surf-ace-skill-v0.2.8.md");
  assert.equal(names.manifest, "surf-ace-v0.2.8-manifest.json");
  assert.doesNotMatch(JSON.stringify(names), /tightbeam/i);
  assert.throws(() => publicReleaseNames({ version: "0.2.8", sourceRevision: "r1", toolingRevision: "r1", legacy: true }), /legacy_release_naming_is_v025_only/);
});

test("the selected rc2 names bind the exact candidate version and source", () => {
  const names = publicReleaseNames({ version: "0.2.10-rc2", sourceRevision: "r2", toolingRevision: "r3" });
  assert.equal(names.title, "Surf Ace v0.2.10-rc2");
  assert.equal(names.channel, "surf-ace");
  assert.equal(names.sourceTag, "surf-ace-v0.2.10-rc2-r2");
  assert.equal(names.toolingTag, "surf-ace-release-tooling-v0.2.10-rc2-r3");
  assert.equal(names.assets[0], "surf-ace-server-linux-x86_64-v0.2.10-rc2.tar.gz");
  assert.equal(names.assets[5], "surf-ace-skill-v0.2.10-rc2.md");
  assert.equal(names.manifest, "surf-ace-v0.2.10-rc2-manifest.json");
  assert.deepEqual(TIGHTBEAM.assets, names.assets);
  assert.equal(TIGHTBEAM.version, names.version);
  assert.equal(TIGHTBEAM_SKILL_ASSET, names.skillAsset);
  assert.equal(TIGHTBEAM_TOOLING_TAG, names.toolingTag);
  assert.doesNotMatch(JSON.stringify(names), /tightbeam/i);
  assert.throws(() => publicReleaseNames({ version: "0.2.10-beta.1", sourceRevision: "r1", toolingRevision: "r1" }), /release_version_invalid/);
});

test("release names derive from distinct product and tooling tags", () => {
  const names = publicReleaseNamesFromTags({
    productTag: "surf-ace-v0.2.10-rc2-r2",
    toolingTag: "surf-ace-release-tooling-v0.2.10-rc2-r3",
  });
  assert.equal(names.version, "0.2.10-rc2");
  assert.equal(names.sourceTag, "surf-ace-v0.2.10-rc2-r2");
  assert.equal(names.toolingTag, "surf-ace-release-tooling-v0.2.10-rc2-r3");
  const versionNameMismatch = publicReleaseNamesFromTags({
    productTag: "surf-ace-v0.2.10-rc2-r2",
    toolingTag: "surf-ace-release-tooling-v0.2.10-rc1-r3",
  });
  assert.equal(versionNameMismatch.version, "0.2.10-rc2");
  assert.equal(versionNameMismatch.sourceTag, "surf-ace-v0.2.10-rc2-r2");
  assert.equal(versionNameMismatch.toolingTag, "surf-ace-release-tooling-v0.2.10-rc1-r3");
  assert.throws(() => publicReleaseNamesFromTags({
    productTag: "surf-ace-v0.2.10-rc2",
    toolingTag: "surf-ace-release-tooling-v0.2.10-rc2-r9",
  }), /release_tag_invalid/);
});

test("the pinned release workflow uses the product title, not integration branding", async () => {
  const workflow = await fs.readFile(new URL("../../.github/workflows/release-tightbeam.yml", import.meta.url), "utf8");
  assert.match(workflow, /^name: Build standalone Surf Ace release$/m);
  assert.ok(workflow.includes("PRODUCT_TAG: ${{ inputs.product_tag }}"));
  assert.ok(workflow.includes("TOOLING_TAG: ${{ inputs.tooling_tag }}"));
  assert.match(workflow, /product_version: \$\{\{ steps\.identity\.outputs\.product_version \}\}/);
  assert.doesNotMatch(workflow, /PRODUCT_VERSION:\s*\d+\.\d+\.\d+/);
  assert.match(workflow, /--title "Surf Ace v\$\{PRODUCT_VERSION\}"/);
  assert.doesNotMatch(workflow, /--title "Surf Ace Tightbeam/);
  for (const name of [...TIGHTBEAM.assets, TIGHTBEAM.manifest]) {
    const shellTemplate = name.replace(TIGHTBEAM.version, "${PRODUCT_VERSION}");
    const actionTemplate = name.replace(TIGHTBEAM.version, "${{ env.PRODUCT_VERSION }}");
    assert.ok(workflow.includes(shellTemplate) || workflow.includes(actionTemplate), `release workflow omits configured asset ${name}`);
  }
});

test("RC releases are prereleases while stable releases stay regular releases", async () => {
  const workflow = await fs.readFile(new URL("../../.github/workflows/release-tightbeam.yml", import.meta.url), "utf8");
  const stepMarker = "      - name: Publish after included platform receipts verify\n";
  const runMarker = "        run: |\n";
  const stepStart = workflow.indexOf(stepMarker);
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.ok(stepStart >= 0 && runStart >= 0, "release publish step is present");
  const publishBody = workflow.slice(runStart + runMarker.length);
  const channelStart = publishBody.indexOf("          release_channel_args=()");
  const notesStart = publishBody.indexOf("          cat > release-notes.md", channelStart);
  assert.ok(channelStart >= 0 && notesStart > channelStart, "release channel selection is present");
  const channelScript = publishBody.slice(channelStart, notesStart)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
  assert.ok(publishBody.includes('"${release_channel_args[@]+"${release_channel_args[@]}"}"'));

  for (const { version, prerelease } of [
    { version: "0.2.10-rc2", prerelease: true },
    { version: "0.2.10-rc10", prerelease: true },
    { version: "0.2.10", prerelease: false },
  ]) {
    const { stdout } = await execFileAsync("bash", ["--noprofile", "--norc", "-e", "-u", "-o", "pipefail", "-c",
      `${channelScript}\nprintf '%s\\n' "\${release_channel_args[@]}"`], {
      env: { ...process.env, PRODUCT_VERSION: version },
    });
    assert.equal(stdout.trim(), prerelease ? "--prerelease" : "", `${version} prerelease flag`);
  }
});

test("the release guard accepts a72e77c with distinct immutable RC2 tag inputs", async (t) => {
  const workflow = await fs.readFile(new URL("../../.github/workflows/release-tightbeam.yml", import.meta.url), "utf8");
  const stepMarker = "      - name: Require exact manual tooling and immutable release tags\n";
  const runMarker = "        run: |\n";
  const stepStart = workflow.indexOf(stepMarker);
  const runStart = workflow.indexOf(runMarker, stepStart);
  const bodyStart = runStart + runMarker.length;
  const bodyEnd = workflow.indexOf("\n  build-linux:\n", bodyStart);
  assert.ok(stepStart >= 0 && runStart >= 0 && bodyEnd > bodyStart, "workflow guard step is present");
  const script = workflow.slice(bodyStart, bodyEnd).replace(/^ {10}/gm, "");

  const productTag = "surf-ace-v0.2.10-rc2-r2";
  const toolingTag = "surf-ace-release-tooling-v0.2.10-rc2-r3";
  const productCommit = "a72e77c503f4bbc057d08819bb77066a62ca8092";
  const workflowCommit = (await execFileAsync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"])).stdout.trim();
  assert.notEqual(productTag, toolingTag);
  assert.match(workflowCommit, /^[a-f0-9]{40}$/);
  assert.notEqual(productCommit, workflowCommit);

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-release-guard-"));
  t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const ghStubPath = path.join(temporaryDirectory, "gh");
  const callsPath = path.join(temporaryDirectory, "gh-calls");
  const outputPath = path.join(temporaryDirectory, "github-output");
  await fs.writeFile(ghStubPath, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_API_CALLS"
case "$*" in
  *"git/ref/tags/$EXPECTED_TOOLING_TAG"*) printf 'commit %s\\n' "$EXPECTED_WORKFLOW_SHA" ;;
  *"git/ref/tags/$EXPECTED_PRODUCT_TAG"*) printf 'commit %s\\n' "$EXPECTED_PRODUCT_SHA" ;;
  *) echo "unexpected_gh_api_request:$*" >&2; exit 3 ;;
esac
`);
  await fs.chmod(ghStubPath, 0o755);

  await execFileAsync("bash", ["--noprofile", "--norc", "-e", "-u", "-o", "pipefail", "-c", script], {
    env: {
      PATH: `${temporaryDirectory}:/usr/bin:/bin`,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF: `refs/tags/${toolingTag}`,
      GITHUB_SHA: workflowCommit,
      GITHUB_REPOSITORY: "clickety-clacks/surf-ace",
      GITHUB_OUTPUT: outputPath,
      GH_API_CALLS: callsPath,
      EXPECTED_TOOLING_TAG: toolingTag,
      EXPECTED_PRODUCT_TAG: productTag,
      EXPECTED_WORKFLOW_SHA: workflowCommit,
      EXPECTED_PRODUCT_SHA: productCommit,
      PRODUCT_COMMIT_INPUT: productCommit,
      PRODUCT_TAG_INPUT: productTag,
      TOOLING_TAG_INPUT: toolingTag,
      PRODUCT_TAG: productTag,
      TOOLING_TAG: toolingTag,
    },
  });

  assert.equal(await fs.readFile(outputPath, "utf8"), `product_commit=${productCommit}\nproduct_version=0.2.10-rc2\ntooling_version=0.2.10-rc2\nversion_name_mismatch=false\n`);
  const calls = await fs.readFile(callsPath, "utf8");
  assert.ok(calls.includes(`git/ref/tags/${toolingTag}`));
  assert.ok(calls.includes(`git/ref/tags/${productTag}`));
});
