import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const label = "ai.surf-ace.electron.dev";
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
const stdoutPath = "/tmp/surf-ace-electron-launchd.out.log";
const stderrPath = "/tmp/surf-ace-electron-launchd.err.log";
// Use the packaged .app if it exists in ~/Applications; fall back to dev binary.
const appBundle = path.join(os.homedir(), "Applications", "Surf Ace.app");
const electronPackageDir = path.dirname(require.resolve("electron/package.json"));
const electronBin = path.join(
  electronPackageDir,
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);
const uid = String(process.getuid());
const domain = `gui/${uid}`;
const shouldUninstall = process.argv.includes("--uninstall");

function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `launchctl ${args.join(" ")} failed`);
  }
  return result;
}

async function uninstall() {
  runLaunchctl(["bootout", domain, plistPath], { allowFailure: true });
  await fs.rm(plistPath, { force: true });
  console.log(`Uninstalled ${label}`);
}

async function install() {
  await fs.mkdir(path.dirname(plistPath), { recursive: true });

  // Prefer launching via `open` on the packaged .app — this uses LaunchServices,
  // which sets up the full app environment (Bonjour, entitlements, etc.) correctly.
  // Fall back to direct binary invocation for dev-only runs without a packaged app.
  const useOpen = await fs.access(appBundle).then(() => true).catch(() => false);
  const programArgs = useOpen
    ? `<string>/usr/bin/open</string>\n    <string>-a</string>\n    <string>${appBundle}</string>`
    : `<string>${electronBin}</string>\n    <string>${packageDir}</string>`;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    ${programArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SURF_ACE_PORT</key>
    <string>19001</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
</dict>
</plist>
`;

  await fs.writeFile(plistPath, plist);
  runLaunchctl(["bootout", domain, plistPath], { allowFailure: true });
  runLaunchctl(["bootstrap", domain, plistPath]);
  runLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  console.log(`Installed ${label}`);
  console.log(plistPath);
}

// Only require the dev binary if no packaged .app exists
const hasApp = await fs.access(appBundle).then(() => true).catch(() => false);
if (!hasApp) {
  await fs.access(electronBin).catch(() => {
    throw new Error(`Electron binary not found at ${electronBin}. Run pnpm install or build the .app first.`);
  });
}

if (shouldUninstall) {
  await uninstall();
} else {
  await install();
}
