import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(packageDir, "..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");
const protocolSchemaPath = path.resolve(rootDir, "../protocol/schema.json");

await fs.rm(distDir, { force: true, recursive: true });
await fs.mkdir(path.join(distDir, "renderer"), { recursive: true });
await fs.mkdir(path.join(distDir, "renderer", "fonts"), { recursive: true });
await fs.mkdir(path.join(distDir, "test"), { recursive: true });
await fs.copyFile(protocolSchemaPath, path.join(distDir, "schema.json"));

const shared = {
  bundle: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
  sourcemap: true,
  target: "node24",
  tsconfig: path.join(rootDir, "tsconfig.json"),
};

await build({
  ...shared,
  entryPoints: [
    path.join(srcDir, "central-server.ts"),
    path.join(srcDir, "guest-preload.ts"),
    path.join(srcDir, "main.ts"),
    path.join(srcDir, "preload.ts"),
  ],
  external: ["electron"],
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  outdir: distDir,
  platform: "node",
});

await build({
  ...shared,
  entryPoints: [path.join(srcDir, "renderer", "renderer.ts")],
  format: "esm",
  loader: {
    ".html": "text",
  },
  outdir: path.join(distDir, "renderer"),
  platform: "browser",
  target: "chrome138",
});

await build({
  ...shared,
  entryPoints: [
    path.join(rootDir, "test", "bonjour-advertiser.test.ts"),
    path.join(rootDir, "test", "client-flight-recorder.test.ts"),
    path.join(rootDir, "test", "identity.test.ts"),
    path.join(rootDir, "test", "lockless-acceptance.test.ts"),
    path.join(rootDir, "test", "lockless-client-authority.test.ts"),
    path.join(rootDir, "test", "lockless-ws-server.test.ts"),
    path.join(rootDir, "test", "native-pane-bridge.test.ts"),
    path.join(rootDir, "test", "overlay-rects.test.ts"),
    path.join(rootDir, "test", "persistent-state-file.test.ts"),
    path.join(rootDir, "test", "port-selection.test.ts"),
    path.join(rootDir, "test", "disabled-native-pane-demo.test.ts"),
    path.join(rootDir, "test", "markdown-rendering.test.ts"),
    path.join(rootDir, "test", "renderer-sizing.test.ts"),
    path.join(rootDir, "test", "renderer-dom-integration.test.ts"),
    path.join(rootDir, "test", "renderer-ui-projection.test.ts"),
    path.join(rootDir, "test", "runtime-identity.test.ts"),
    path.join(rootDir, "test", "surface-core.test.ts"),
    path.join(rootDir, "test", "autostart-host-guard.test.ts"),
    path.join(rootDir, "test", "webauthn-support.test.ts"),
    path.join(rootDir, "test", "window-options.test.ts"),
    path.join(rootDir, "test", "window-placement.test.ts"),
  ],
  external: [
    "@surf-ace/protocol",
    "bonjour-service",
    "ws",
  ],
  format: "esm",
  outdir: path.join(distDir, "test"),
  platform: "node",
});

await fs.copyFile(
  path.join(srcDir, "renderer", "index.html"),
  path.join(distDir, "renderer", "index.html"),
);
await fs.copyFile(
  path.join(srcDir, "renderer", "styles.css"),
  path.join(distDir, "renderer", "styles.css"),
);
await fs.copyFile(
  path.join(srcDir, "renderer", "fonts", "Rajdhani-Regular.ttf"),
  path.join(distDir, "renderer", "fonts", "Rajdhani-Regular.ttf"),
);
await fs.copyFile(
  path.join(srcDir, "renderer", "fonts", "Rajdhani-Bold.ttf"),
  path.join(distDir, "renderer", "fonts", "Rajdhani-Bold.ttf"),
);
await fs.copyFile(
  path.join(srcDir, "renderer", "fonts", "OFL-Rajdhani.txt"),
  path.join(distDir, "renderer", "fonts", "OFL-Rajdhani.txt"),
);
