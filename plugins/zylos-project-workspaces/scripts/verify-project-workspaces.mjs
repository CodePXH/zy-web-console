#!/usr/bin/env node
/**
 * Read-only compatibility verification for the project-workspace extension.
 * It deliberately does not inspect C4 conversation content.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const consoleRoot = process.env.WEB_CONSOLE_ROOT || path.join(zylosDir, '.claude', 'skills', 'web-console');
const bridgeRoot = process.env.COMM_BRIDGE_ROOT || path.join(zylosDir, '.claude', 'skills', 'comm-bridge');
const databasePath = path.join(zylosDir, 'web-console', 'web-console.db');
const workspaceRoot = path.join(zylosDir, 'workspace', 'web-console-projects');
const require = createRequire(import.meta.url);
const Database = require(path.join(consoleRoot, 'node_modules', 'better-sqlite3'));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function readSource(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { failures.push(`missing compatibility file: ${file}`); return ''; }
}

const serverSource = readSource(path.join(consoleRoot, 'scripts', 'server.js'));
const dispatcherSource = readSource(path.join(bridgeRoot, 'scripts', 'c4-dispatcher.js'));
const utilsSource = readSource(path.join(bridgeRoot, 'scripts', 'c4-utils.js'));

check(serverSource.includes('getConversation(identity.user.id, req.body.projectId, req.body.conversationId)'), 'HTTP send is not scoped by owner, project, and conversation');
check(serverSource.includes("attachment.path === path.join(MEDIA_DIR, basename)"), 'inbound attachment access is not conversation-scoped');
check(serverSource.includes('workspacePathForProject(project.owner_id, project.id)'), 'project workspace ownership binding is missing');
check(serverSource.includes("UPDATE projects SET title = ?, updated_at = ? WHERE id = ? AND owner_id = ?"), 'project rename is not owner-scoped');
check(serverSource.includes('return `wcp-${project.id}-${conversation.owner_id}-${conversation.id}`'), 'project reply endpoint is not bound to project, owner, and conversation');
check(dispatcherSource.includes('function tmuxSessionForItem(item)'), 'project endpoint dispatcher mapping is missing');
check(utilsSource.includes('process.execPath'), 'generated reply path does not use an absolute Node executable');

if (!fs.existsSync(databasePath)) {
  failures.push(`missing Web Console database: ${databasePath}`);
} else {
  const db = new Database(databasePath, { readonly: true });
  const count = (sql) => db.prepare(sql).get().n;
  check(count('SELECT count(*) AS n FROM projects p LEFT JOIN users u ON u.id = p.owner_id WHERE u.id IS NULL') === 0, 'project has no owner');
  check(count('SELECT count(*) AS n FROM conversations WHERE project_id IS NULL') === 0, 'conversation has no project');
  check(count('SELECT count(*) AS n FROM conversations c LEFT JOIN projects p ON p.id = c.project_id WHERE p.id IS NULL') === 0, 'conversation references a missing project');
  check(count('SELECT count(*) AS n FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.owner_id <> p.owner_id') === 0, 'conversation owner differs from project owner');
  const invalidWorkspace = db.prepare("SELECT count(*) AS n FROM projects WHERE workspace_path IS NOT NULL AND workspace_path <> ? || owner_id || '/' || id").get(`${workspaceRoot}/`).n;
  check(invalidWorkspace === 0, 'project workspace does not match its owner/project directory');

  const runners = db.prepare("SELECT id, owner_id, workspace_path FROM projects WHERE runner_status = 'running'").all();
  for (const runner of runners) {
    const expected = path.join(workspaceRoot, runner.owner_id, runner.id);
    check(path.resolve(runner.workspace_path || expected) === expected, 'runner workspace does not match its owner/project');
    try {
      const cwd = execFileSync('tmux', ['display-message', '-p', '-t', `codex-project-${runner.id}`, '#{pane_current_path}'], { encoding: 'utf8' }).trim();
      check(cwd === expected, 'runner tmux session has an unexpected working directory');
    } catch {
      failures.push('running project has no reachable dedicated tmux session');
    }
  }
  db.close();
}

if (failures.length) {
  console.error(`Project-workspace verification failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Project-workspace verification passed.');
