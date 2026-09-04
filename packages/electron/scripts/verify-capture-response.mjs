import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);
const electronPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(electronPackageDir, "../..");
const targetRoot = path.resolve(process.env.SURF_ACE_CAPTURE_APP_ROOT ?? repoRoot);
const targetElectronDir = path.join(targetRoot, "packages/electron");
const electronBinary = path.join(electronPackageDir, "node_modules/electron/dist/electron");
const cliBinary = path.join(repoRoot, "packages/cli/target/release/surf-ace");
const appCommit = await gitHead(targetRoot);
const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-capture-response-"));
const cliStateRoot = path.join(baseDir, "cli-state");
const userDataDir = path.join(baseDir, "electron-user-data");
const runtimeDir = path.join(baseDir, "runtime");
const waylandSocket = "wayland-capture-response";
const port = await reservePort();
const endpoint = `ws://127.0.0.1:${port}/ws`;
const electronOutput = { stderr: "", stdout: "" };
const compositorOutput = { stderr: "", stdout: "" };

await Promise.all([
  fs.access(path.join(targetElectronDir, "dist/main.cjs")),
  fs.access(electronBinary),
  fs.access(cliBinary),
  fs.mkdir(cliStateRoot, { recursive: true }),
  fs.mkdir(userDataDir, { recursive: true }),
  fs.mkdir(runtimeDir, { mode: 0o700, recursive: true }),
]);

const compositor = spawn("weston", [
  "--backend=headless",
  "--renderer=pixman",
  `--socket=${waylandSocket}`,
  "--width=960",
  "--height=720",
  "--idle-time=0",
  "--no-config",
], {
  env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
  stdio: ["ignore", "pipe", "pipe"],
});
compositor.stdout.setEncoding("utf8");
compositor.stderr.setEncoding("utf8");
compositor.stdout.on("data", (chunk) => { compositorOutput.stdout += chunk; });
compositor.stderr.on("data", (chunk) => { compositorOutput.stderr += chunk; });
await waitForPath(path.join(runtimeDir, waylandSocket), compositor, 10_000);

const electron = spawn(electronBinary, [
  "--no-sandbox",
  "--ozone-platform=wayland",
  "--enable-features=UseOzonePlatform",
  `--user-data-dir=${userDataDir}`,
  targetElectronDir,
], {
  cwd: targetRoot,
  env: {
    ...process.env,
    ELECTRON_OZONE_PLATFORM_HINT: "wayland",
    SURF_ACE_BIND: "127.0.0.1",
    SURF_ACE_DISABLE_ADVERTISING: "1",
    SURF_ACE_DISABLE_GPU: "1",
    SURF_ACE_NAME: "Capture Response Regression",
    SURF_ACE_PORT: String(port),
    XDG_CACHE_HOME: path.join(baseDir, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(baseDir, "xdg-config"),
    XDG_DATA_HOME: path.join(baseDir, "xdg-data"),
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_STATE_HOME: path.join(baseDir, "xdg-state"),
    WAYLAND_DISPLAY: waylandSocket,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
electron.stdout.setEncoding("utf8");
electron.stderr.setEncoding("utf8");
electron.stdout.on("data", (chunk) => { electronOutput.stdout += chunk; });
electron.stderr.on("data", (chunk) => { electronOutput.stderr += chunk; });

try {
  const listed = await waitForList(electron, 15_000);
  const surface = listed.result?.payload?.surfaces?.[0];
  assert.ok(surface?.surfaceId, `fresh fixture did not list a surface: ${JSON.stringify(listed)}`);
  const paneId = firstPaneId(surface.topology);
  assert.ok(paneId > 0, `fresh fixture did not list a pane: ${JSON.stringify(surface)}`);

  const html = [
    "<style>",
    "html,body{margin:0;width:100%;height:100%;overflow:hidden}",
    ".left,.right{position:absolute;top:0;bottom:0;width:50%}",
    ".left{left:0;background:#d93636}",
    ".right{right:0;background:#246bce}",
    "</style>",
    "<div class=left></div><div class=right></div>",
  ].join("");
  const contentId = "capture-response-regression";
  const pushed = await runCli("push", {
    content: { baseUrl: "https://capture-response.invalid/", html },
    contentId,
    contentType: "html",
    paneId,
    surfaceId: surface.surfaceId,
  });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));

  const captured = await runCli("capture-pane", {
    includeImage: true,
    paneId,
    surfaceId: surface.surfaceId,
  }, 20_000);
  assert.equal(captured.ok, true, JSON.stringify(captured));
  assert.equal(captured.result?.payload?.contentId, contentId);
  const png = Buffer.from(String(captured.result?.payload?.image ?? ""), "base64");
  const decoded = decodePngColors(png);
  assert.ok(decoded.colors.has("d93636"), "capture is missing rendered left fixture color #d93636");
  assert.ok(decoded.colors.has("246bce"), "capture is missing rendered right fixture color #246bce");

  console.log(JSON.stringify({
    appCommit,
    controllerInstanceId: captured.controllerInstanceId,
    endpoint,
    height: decoded.height,
    matchedFixtureColors: ["d93636", "246bce"],
    ok: true,
    paneId,
    pngBytes: png.length,
    surfaceId: surface.surfaceId,
    width: decoded.width,
  }));
} catch (error) {
  const detail = [
    error instanceof Error ? error.stack ?? error.message : String(error),
    `app commit: ${appCommit}`,
    `compositor stdout:\n${compositorOutput.stdout}`,
    `compositor stderr:\n${compositorOutput.stderr}`,
    `electron stdout:\n${electronOutput.stdout}`,
    `electron stderr:\n${electronOutput.stderr}`,
  ].join("\n");
  throw new Error(detail);
} finally {
  electron.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => electron.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (electron.exitCode === null) electron.kill("SIGKILL");
  compositor.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => compositor.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (compositor.exitCode === null) compositor.kill("SIGKILL");
  await fs.rm(baseDir, { force: true, recursive: true });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const selected = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return selected;
}

async function waitForPath(targetPath, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Weston exited before readiness with ${child.exitCode}`);
    try {
      await fs.access(targetPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Weston did not create ${targetPath} within ${timeoutMs}ms`);
}

async function waitForList(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited before readiness with ${child.exitCode}`);
    try {
      return await runCli("list", {}, 2_000);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Electron did not answer list within ${timeoutMs}ms: ${String(lastError)}`);
}

async function runCli(command, input, timeout = 10_000) {
  try {
    const { stdout } = await execFileAsync(cliBinary, [
      command,
      "--state-root", cliStateRoot,
      "--endpoint", endpoint,
      "--product-label", "Capture Response Regression",
      "--input-json", JSON.stringify(input),
    ], { maxBuffer: 32 * 1024 * 1024, timeout });
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    throw new Error(`CLI ${command} failed: ${String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

function firstPaneId(value) {
  if (!value || typeof value !== "object") return 0;
  if (Number.isInteger(value.paneId) && value.paneId > 0) return value.paneId;
  for (const child of Object.values(value)) {
    const paneId = firstPaneId(child);
    if (paneId > 0) return paneId;
  }
  return 0;
}

function decodePngColors(png) {
  assert.ok(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "capture is not a PNG",
  );
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const compressed = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      compressed.push(data);
    }
    offset += length + 12;
  }
  assert.equal(bitDepth, 8, "capture PNG must use 8-bit channels");
  assert.ok(colorType === 2 || colorType === 6, `unsupported capture PNG color type ${colorType}`);
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(compressed));
  const previous = Buffer.alloc(rowBytes);
  const current = Buffer.alloc(rowBytes);
  const colors = new Set();
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset++];
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : filter === 4 ? paeth(left, up, upLeft)
                : null;
      assert.notEqual(predictor, null, `unsupported capture PNG filter ${filter}`);
      current[x] = (raw[rawOffset + x] + predictor) & 0xff;
    }
    rawOffset += rowBytes;
    for (let x = 0; x < rowBytes; x += bytesPerPixel) {
      colors.add(current.subarray(x, x + 3).toString("hex"));
    }
    current.copy(previous);
  }
  return { colors, height, width };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

async function gitHead(root) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}
