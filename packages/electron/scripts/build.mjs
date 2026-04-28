import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(packageDir, "..");
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist");

await fs.rm(distDir, { force: true, recursive: true });
await fs.mkdir(path.join(distDir, "renderer"), { recursive: true });
await fs.mkdir(path.join(distDir, "test"), { recursive: true });

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
    path.join(rootDir, "test", "identity.test.ts"),
    path.join(rootDir, "test", "native-pane-bridge.test.ts"),
    path.join(rootDir, "test", "port-selection.test.ts"),
    path.join(rootDir, "test", "surface-core.test.ts"),
    path.join(rootDir, "test", "ws-server.test.ts"),
  ],
  external: ["bonjour-service", "ws"],
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
