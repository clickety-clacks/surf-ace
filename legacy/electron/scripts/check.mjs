import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function collectJsFiles(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectJsFiles(fullPath));
      continue;
    }
    if (fullPath.endsWith('.js') || fullPath.endsWith('.mjs')) {
      files.push(fullPath);
    }
  }
  return files;
}

const root = path.resolve(process.cwd(), 'src');
const files = collectJsFiles(root);
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

console.log(`Checked ${files.length} files.`);
