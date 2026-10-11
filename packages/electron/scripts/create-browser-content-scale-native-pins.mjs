import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectNativeScalePinSnapshot, sha256 } from "./native-scale-runner-guard.mjs";

function readArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error(`Expected --name value, got ${key}`);
    }
    if (values.has(key)) throw new Error(`Duplicate argument ${key}`);
    values.set(key, argv[++index]);
  }
  return values;
}

async function main(argv) {
  const args = readArgs(argv);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(scriptDir, "..");
  const repoDir = path.resolve(packageDir, "../..");
  if (!args.has("--output")) throw new Error("--output must be an external manifest path outside the source worktree");
  let cursor = path.resolve(args.get("--output"));
  const suffix = [];
  let output;
  while (!output) {
    try {
      output = path.join(await fs.realpath(cursor), ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
  const relative = path.relative(await fs.realpath(repoDir), output);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error("--output must be an external manifest path outside the source worktree");
  }
  const pins = await collectNativeScalePinSnapshot({ repoDir, packageDir, electronVersion: args.get("--electron-version") });
  const bytes = Buffer.from(`${JSON.stringify(pins, null, 2)}\n`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, bytes, { flag: "wx" });
  process.stdout.write(JSON.stringify({ file: output, sha256: sha256(bytes), head: pins.head,
    tree: pins.tree, distTreeSha256: pins.distTreeSha256 }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
