import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "./surf-ace-runtime.js";

test("provider normalizes explicit native_surface JSON into compositor host intent", () => {
  const content = __test.normalizeContent(
    "native_surface",
    JSON.stringify({
      process: {
        args: ["--login"],
        command: "zsh",
        cwd: "/tmp",
        env: { TERM: "xterm-256color" },
      },
      targetClass: "terminal",
    }),
  );

  assert.deepEqual(content, {
    process: {
      args: ["--login"],
      command: "zsh",
      cwd: "/tmp",
      env: { TERM: "xterm-256color" },
    },
    targetClass: "terminal",
  });
});

test("provider rejects native_surface content without a process command", () => {
  assert.throws(
    () => __test.normalizeContent("native_surface", JSON.stringify({ targetClass: "terminal" })),
    /native_surface content must include targetClass=terminal and process.command/,
  );
});
