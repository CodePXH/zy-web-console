#!/usr/bin/env node
/**
 * Reapply locally-owned Zylos Console customizations after a Core upgrade.
 * Uses: git merge-file -p <current> <baseline> <custom>. All files are staged
 * first, so a conflict leaves every live file untouched.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zylosRoot = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const skillsRoot = path.join(zylosRoot, '.claude', 'skills');
const mappings = [
  ['web-console/public/app.js', path.join(skillsRoot, 'web-console/public/app.js')],
  ['web-console/public/index.html', path.join(skillsRoot, 'web-console/public/index.html')],
  ['web-console/public/styles.css', path.join(skillsRoot, 'web-console/public/styles.css')],
  ['web-console/scripts/server.js', path.join(skillsRoot, 'web-console/scripts/server.js')],
  ['web-console/scripts/db.js', path.join(skillsRoot, 'web-console/scripts/db.js')],
  ['comm-bridge/scripts/c4-dispatcher.js', path.join(skillsRoot, 'comm-bridge/scripts/c4-dispatcher.js')]
];
const args = process.argv.slice(2);
const mode = args.includes('--apply') ? 'apply' : 'check';
if (args.some((arg) => !['--apply', '--check'].includes(arg))) {
  console.error('Usage: apply-overrides.mjs [--check|--apply]');
  process.exit(64);
}
const contents = (file) => fs.readFileSync(file, 'utf8');
const equal = (a, b) => a === b;
const staged = [];
let conflicts = 0;

for (const [relative, target] of mappings) {
  const baseline = path.join(pluginRoot, 'baseline', relative);
  const custom = path.join(pluginRoot, 'overrides', relative);
  if (![baseline, custom, target].every(fs.existsSync)) {
    console.error(`Missing required source for ${relative}`);
    process.exit(2);
  }
  const currentText = contents(target);
  const baselineText = contents(baseline);
  const customText = contents(custom);
  if (equal(currentText, customText)) {
    console.log(`applied  ${relative}`);
    continue;
  }
  let merged;
  try {
    merged = execFileSync('git', ['merge-file', '-p', target, baseline, custom], { encoding: 'utf8' });
  } catch (error) {
    if (error.status === 1) {
      console.error(`conflict ${relative}`);
      conflicts += 1;
      continue;
    }
    throw error;
  }
  if (equal(merged, currentText)) console.log(`unchanged ${relative}`);
  else {
    console.log(`pending  ${relative}`);
    staged.push({ relative, target, text: merged });
  }
}

if (conflicts) {
  console.error(`No files were changed: ${conflicts} merge conflict(s) require review.`);
  process.exit(1);
}
if (mode === 'check') {
  console.log(staged.length ? `${staged.length} file(s) need the overlay applied.` : 'All customizations are applied.');
  process.exit(0);
}
if (staged.length) {
  const backupRoot = path.join(pluginRoot, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  for (const { relative, target, text } of staged) {
    const backup = path.join(backupRoot, relative);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(target, backup);
    fs.writeFileSync(target, text);
  }
  console.log(`Applied ${staged.length} file(s). Backup: ${backupRoot}`);
} else {
  console.log('Nothing to apply.');
}
