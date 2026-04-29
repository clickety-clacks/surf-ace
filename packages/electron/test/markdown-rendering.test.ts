import assert from "node:assert/strict";
import test from "node:test";

import { markdownToHtml } from "../src/renderer/markdown.js";

test("markdown renderer emits document-oriented HTML blocks", () => {
  const html = markdownToHtml([
    "# Title",
    "",
    "A **bold** paragraph with [a link](https://example.com) and `code`.",
    "",
    "- one",
    "- two",
    "",
    "> quoted",
    "",
    "```",
    "<tag>",
    "```",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| A | B |",
  ].join("\n"));

  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a data-href="https:\/\/example\.com" title="https:\/\/example\.com">a link<\/a>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>&lt;tag&gt;<\/code><\/pre>/);
  assert.match(html, /<table><thead><tr><th>Name<\/th><th>Value<\/th><\/tr><\/thead><tbody><tr><td>A<\/td><td>B<\/td><\/tr><\/tbody><\/table>/);
});

test("markdown renderer escapes raw html source", () => {
  const html = markdownToHtml("Hello <script>alert(1)</script>");

  assert.equal(html, "<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>");
});

test("markdown renderer keeps links inert", () => {
  const html = markdownToHtml("[bad](javascript:alert('x'))");

  assert.equal(html, '<p><a data-href="javascript:alert(&#39;x&#39;" title="javascript:alert(&#39;x&#39;">bad</a>)</p>');
  assert.doesNotMatch(html, /\shref=/);
});
