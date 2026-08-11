import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("systemd restarts the supervisor after a clean child exit", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const unit = await fs.readFile(
    path.join(here, "../packaging/surf-ace-controller.service"),
    "utf8",
  );

  assert.match(unit, /^Restart=always$/m);
  assert.doesNotMatch(unit, /^Restart=on-failure$/m);
});

test("package builder creates the default output when its parent is absent", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = await fs.readFile(
    path.join(here, "../scripts/build-linux-package.mjs"),
    "utf8",
  );

  assert.match(script, /await fs\.mkdir\(output, \{ recursive: true \}\);/);
  assert.doesNotMatch(script, /await fs\.mkdir\(output, \{ recursive: false \}\);/);
});
