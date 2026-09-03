const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const allowed = manifest.files.map((entry) => entry.replaceAll(path.sep, '/').replace(/\/$/, ''));
allowed.push('package.json');

const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const report = JSON.parse(output);
const files = report[0]?.files;
if (!Array.isArray(files)) {
  throw new Error('npm pack did not return a file list');
}

const isAllowed = (file) => allowed.some((entry) => file === entry || file.startsWith(`${entry}/`));
const forbidden = files
  .map((entry) => entry.path)
  .filter((file) => {
    const normalized = file.replaceAll('\\', '/');
    const segments = normalized.toLowerCase().split('/');
    return segments.includes('node_modules') || segments.includes('test') || segments.includes('tests');
  });
const packed = files.map((entry) => entry.path.replaceAll('\\', '/'));
const unexpected = packed.filter((file) => !isAllowed(file));
const missing = allowed.filter(
  (entry) => !packed.some((file) => file === entry || file.startsWith(`${entry}/`)),
);

if (forbidden.length > 0) {
  throw new Error(`forbidden package entries: ${forbidden.join(', ')}`);
}
if (unexpected.length > 0) {
  throw new Error(`unexpected package entries: ${unexpected.join(', ')}`);
}
if (missing.length > 0) {
  throw new Error(`missing package entries: ${missing.join(', ')}`);
}

console.log(`Pack verification passed (${files.length} files)`);
