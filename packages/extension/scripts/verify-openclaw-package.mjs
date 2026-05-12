import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = new URL("../dist/openclaw-package/", import.meta.url);

function packagePath(...parts) {
  return join(packageRoot.pathname, ...parts);
}

function assertFile(relativePath) {
  assert.equal(
    existsSync(packagePath(relativePath)),
    true,
    `expected packaged file ${relativePath}`,
  );
}

const packageJson = JSON.parse(readFileSync(packagePath("package.json"), "utf8"));
assert.deepEqual(packageJson.openclaw?.extensions, ["./surf-ace.ts"]);
assert.deepEqual(packageJson.openclaw?.runtimeExtensions, ["./dist/extension/src/index.js"]);

const pluginJson = JSON.parse(readFileSync(packagePath("openclaw.plugin.json"), "utf8"));
const { surfAceToolNames } = await import(
  pathToFileURL(packagePath("dist/extension/src/surf-ace-tools.js")).href
);
assert.deepEqual(pluginJson.tools, surfAceToolNames);
assert.deepEqual(pluginJson.contracts?.tools, surfAceToolNames);

assertFile("surf-ace.ts");
assertFile("dist/surf-ace.js");
assertFile("dist/extension/src/index.js");
assertFile("dist/protocol/schema.json");
assertFile("node_modules/bonjour-service/package.json");
assertFile("node_modules/ws/package.json");

const runtimeEntry = readFileSync(packagePath("dist/extension/src/index.js"), "utf8");
assert.match(
  runtimeEntry,
  /from "openclaw\/plugin-sdk"/,
  "runtime extension entry must be the file that imports openclaw/plugin-sdk so OpenClaw applies SDK alias resolution",
);

const schemaLoader = readFileSync(packagePath("dist/protocol/src/schemas.js"), "utf8");
assert.match(
  schemaLoader,
  /new URL\("\.\.\/schema\.json", import\.meta\.url\)/,
  "compiled protocol schema loader must read dist/protocol/schema.json",
);
