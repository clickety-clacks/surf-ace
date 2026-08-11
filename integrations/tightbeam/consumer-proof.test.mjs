import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixtureUrl = new URL("./fixtures/archetype-attachment.json", import.meta.url);
const skillUrl = new URL("./skills/surf-ace/SKILL.md", import.meta.url);
const manifestUrl = new URL("../../packages/cli/Cargo.toml", import.meta.url);
const manifestPath = fileURLToPath(manifestUrl);
const proofScriptPath = fileURLToPath(new URL("./proof/tightbeam-skill-consumer.exs", import.meta.url));
const tightbeamSourceRoot = process.env.TIGHTBEAM_SOURCE_ROOT;

async function startLocalController(socketPath) {
  const source = `
    import net from "node:net";
    const server = net.createServer((socket) => {
      let encoded = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => encoded += chunk);
      socket.on("end", () => {
        const request = JSON.parse(encoded);
        socket.end(JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            command: request.command,
            controllerInstanceId: "ci_consumer_proof",
            ok: true,
            reconciliations: [],
            result: {
              acknowledgement: null,
              cacheStatus: "unsynchronized",
              consumableLoss: null,
              records: [],
              scopeId: request.input.scopeId,
              synchronizationCutoff: null
            }
          },
          v: 1
        }) + "\\n");
      });
    });
    server.listen(process.argv[1], () => process.stdout.write("ready\\n"));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, socketPath], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await once(child.stdout, "data");
  return child;
}

test("Tight Beam consumes the unchanged general surf-ace executable", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const skill = await readFile(skillUrl, "utf8");
  const manifest = await readFile(manifestUrl, "utf8");

  assert.equal(fixture.attachment.executable, "surf-ace");
  assert.match(skill, /installed `surf-ace` executable/);
  assert.match(skill, /do not send a bare text string/);
  assert.match(skill, /"contentType":"markdown","content":\{"markdown":"# Visible result"\}/);
  for (const contentType of ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"]) {
    assert.match(skill, new RegExp("- `" + contentType + "`:"));
  }
  assert.match(manifest, /name = "surf-ace-cli"/);
  assert.match(manifest, /name = "surf-ace"/);
  assert.doesNotMatch(manifest.toLowerCase(), /tightbeam/);

  for (const vector of fixture.vectors) {
    assert.deepEqual(vector.after.skills, [...vector.before.skills, "surf-ace"]);
    const { skills: _beforeSkills, ...before } = vector.before;
    const { skills: _afterSkills, ...after } = vector.after;
    assert.deepEqual(after, before, `${vector.id} changed unrelated material`);
    if (tightbeamSourceRoot && vector.sourcePath) {
      const source = join(tightbeamSourceRoot, vector.sourcePath);
      assert.equal(
        createHash("sha256").update(await readFile(source)).digest("hex"),
        vector.sourceSha256,
      );
    }
  }
});

test("direct caller executes the installed local-controller client", async (context) => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const proofRoot = await mkdtemp(join(tmpdir(), "surf-ace-identical-binary-"));
  context.after(async () => rm(proofRoot, { recursive: true, force: true }));
  const installRoot = join(proofRoot, "install");
  const installed = spawnSync(
    "cargo",
    ["install", "--locked", "--path", dirname(manifestPath), "--root", installRoot],
    { encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const executablePath = await realpath(join(installRoot, "bin", "surf-ace"));
  const executableSha256 = createHash("sha256")
    .update(await readFile(executablePath))
    .digest("hex");
  assert.equal(basename(executablePath), fixture.attachment.executable);
  const socketPath = join(proofRoot, "controller.sock");
  const controller = await startLocalController(socketPath);
  context.after(() => controller.kill("SIGTERM"));

  const invocation = spawnSync(
    executablePath,
    [
      "--socket",
      socketPath,
      "read",
      "--input-json",
      JSON.stringify({ scopeId: "surface:proof" }),
    ],
    { encoding: "utf8" },
  );
  assert.equal(invocation.status, 0, invocation.stderr);
  const output = JSON.parse(invocation.stdout);
  assert.equal(output.command, "read");
  assert.equal(output.result.cacheStatus, "unsynchronized");
  assert.equal(output.result.repairScheduled, undefined);
  context.diagnostic(JSON.stringify({ executablePath, executableSha256 }));
});

test("ordinary Tight Beam archetypes materialize the skill and invoke identical installed bytes", {
  skip: tightbeamSourceRoot ? false : "set TIGHTBEAM_SOURCE_ROOT for the cross-repository proof gate",
}, async (context) => {
  const proofRoot = await mkdtemp(join(tmpdir(), "surf-ace-tightbeam-consumer-"));
  context.after(async () => rm(proofRoot, { recursive: true, force: true }));
  const installRoot = join(proofRoot, "install");
  const installed = spawnSync(
    "cargo",
    ["install", "--locked", "--path", dirname(manifestPath), "--root", installRoot],
    { encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const executablePath = await realpath(join(installRoot, "bin", "surf-ace"));
  const socketPath = join(proofRoot, "controller.sock");
  const controller = await startLocalController(socketPath);
  context.after(() => controller.kill("SIGTERM"));
  const mixBuildPath = join(proofRoot, "tightbeam-build");
  const compiledPriv = join(mixBuildPath, "lib", "tightbeam", "priv");
  await mkdir(dirname(compiledPriv), { recursive: true });
  await cp(join(tightbeamSourceRoot, "priv"), compiledPriv, { recursive: true });
  const exercised = spawnSync(
    "mix",
    ["run", "--no-start", proofScriptPath, "--", join(proofRoot, "tightbeam-home"), fileURLToPath(skillUrl), executablePath, socketPath],
    {
      cwd: tightbeamSourceRoot,
      encoding: "utf8",
      env: { ...process.env, MIX_BUILD_PATH: mixBuildPath, MIX_ENV: "test" },
    },
  );
  assert.equal(exercised.status, 0, exercised.stderr || exercised.stdout);
  const proof = JSON.parse(exercised.stdout.trim().split("\n").at(-1));
  assert.equal(proof.proof, "tightbeam-materialized-skill-identical-installed-bytes");
  assert.deepEqual(proof.records.map((record) => record.archetype), [
    "direct-standalone",
    "coder",
    "reviewer",
    "future-unreleased-archetype",
  ]);
  assert.equal(new Set(proof.records.map((record) => record.executablePath)).size, 1);
  assert.equal(new Set(proof.records.map((record) => record.executableSha256)).size, 1);
  assert.equal(new Set(proof.records.slice(1).map((record) => record.materializedSkillSha256)).size, 1);
  assert.ok(proof.records.slice(1).every((record) => record.materializedSkillPath.includes("tightbeam__surf-ace")));
  context.diagnostic(JSON.stringify(proof));
});
