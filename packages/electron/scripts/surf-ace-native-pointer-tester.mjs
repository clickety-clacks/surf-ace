#!/usr/bin/env node

const stdin = process.stdin;
const stdout = process.stdout;
const points = [];
let lastStatus = "waiting for native pointer input";

if (!stdin.isTTY || !stdout.isTTY) {
  console.log("NATIVE POINTER requires an interactive terminal.");
  process.exit(1);
}

stdin.setEncoding("utf8");
stdin.setRawMode(true);
stdin.resume();

enter();
drawStatic();

stdin.on("data", (chunk) => {
  if (chunk === "\u0003" || chunk === "q" || chunk === "Q") {
    exit(0);
    return;
  }
  handleMouse(chunk);
});

process.on("SIGINT", () => exit(0));
process.on("SIGTERM", () => exit(0));
process.on("exit", leave);

function enter() {
  write("\x1b]0;NATIVE POINTER\x07");
  write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[2J");
}

function leave() {
  write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l");
}

function exit(code) {
  leave();
  process.exit(code);
}

function drawStatic() {
  write("\x1b[2J");
  writeAt(3, 2, "\x1b[1;37mNATIVE POINTER\x1b[0m");
  writeAt(3, 4, "Move or click in this native terminal pane.");
  writeAt(3, 5, "The app enables SGR mouse tracking; q exits.");
  drawStatus();
}

function drawStatus() {
  const row = Math.max(7, stdout.rows - 1);
  writeAt(3, row, `\x1b[2K${lastStatus}`);
}

function handleMouse(chunk) {
  const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  for (const match of chunk.matchAll(pattern)) {
    const code = Number(match[1]);
    const x = clamp(Number(match[2]), 1, stdout.columns);
    const y = clamp(Number(match[3]), 1, stdout.rows);
    const pressed = match[4] === "M" && (code & 3) !== 3;
    const glyph = pressed ? "O" : "o";
    const color = pressed ? "\x1b[33m" : "\x1b[36m";
    points.push({ color, glyph, x, y });
    while (points.length > 120) {
      points.shift();
    }
    writeAt(x, y, `${color}${glyph}\x1b[0m`);
    lastStatus = `${pressed ? "click" : "move "} x=${x} y=${y} code=${code}`;
    drawStatus();
  }
}

function writeAt(x, y, text) {
  write(`\x1b[${y};${x}H${text}`);
}

function write(text) {
  stdout.write(text);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
