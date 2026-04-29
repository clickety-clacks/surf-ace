function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(markdown: string): string {
  let html = "";
  let index = 0;

  while (index < markdown.length) {
    const rest = markdown.slice(index);
    if (rest.startsWith("`")) {
      const end = markdown.indexOf("`", index + 1);
      if (end > index) {
        html += `<code>${escapeHtml(markdown.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (rest.startsWith("**")) {
      const end = markdown.indexOf("**", index + 2);
      if (end > index) {
        html += `<strong>${renderInline(markdown.slice(index + 2, end))}</strong>`;
        index = end + 2;
        continue;
      }
    }

    if (rest.startsWith("*")) {
      const end = markdown.indexOf("*", index + 1);
      if (end > index) {
        html += `<em>${renderInline(markdown.slice(index + 1, end))}</em>`;
        index = end + 1;
        continue;
      }
    }

    if (rest.startsWith("[")) {
      const labelEnd = markdown.indexOf("]", index + 1);
      const hrefStart = labelEnd >= 0 ? markdown.indexOf("(", labelEnd) : -1;
      const hrefEnd = hrefStart >= 0 ? markdown.indexOf(")", hrefStart) : -1;
      if (labelEnd > index && hrefStart === labelEnd + 1 && hrefEnd > hrefStart) {
        const label = renderInline(markdown.slice(index + 1, labelEnd));
        const href = escapeHtml(markdown.slice(hrefStart + 1, hrefEnd).trim());
        html += `<a data-href="${href}" title="${href}">${label}</a>`;
        index = hrefEnd + 1;
        continue;
      }
    }

    html += escapeHtml(markdown[index]!);
    index += 1;
  }

  return html;
}

function isFence(line: string): boolean {
  return /^```/.test(line.trim());
}

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s+/.exec(line);
  return match ? match[1]!.length : 0;
}

function isUnorderedListItem(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line);
}

function isOrderedListItem(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

function listItemText(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    !line.trim() ||
    isFence(line) ||
    headingLevel(line) > 0 ||
    isUnorderedListItem(line) ||
    isOrderedListItem(line) ||
    line.trimStart().startsWith(">") ||
    (index + 1 < lines.length && line.includes("|") && isTableDivider(lines[index + 1]!))
  );
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (isFence(line)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !isFence(lines[index]!)) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const level = headingLevel(line);
    if (level > 0) {
      blocks.push(`<h${level}>${renderInline(line.replace(/^#{1,6}\s+/, ""))}</h${level}>`);
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && line.includes("|") && isTableDivider(lines[index + 1]!)) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) {
        rows.push(tableCells(lines[index]!));
        index += 1;
      }
      blocks.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>` +
          `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }

    if (isUnorderedListItem(line) || isOrderedListItem(line)) {
      const ordered = isOrderedListItem(line);
      const tag = ordered ? "ol" : "ul";
      const items: string[] = [];
      while (index < lines.length && (ordered ? isOrderedListItem(lines[index]!) : isUnorderedListItem(lines[index]!))) {
        items.push(`<li>${renderInline(listItemText(lines[index]!))}</li>`);
        index += 1;
      }
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      const quoted: string[] = [];
      while (index < lines.length && lines[index]!.trimStart().startsWith(">")) {
        quoted.push(lines[index]!.replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${markdownToHtml(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return blocks.join("");
}
