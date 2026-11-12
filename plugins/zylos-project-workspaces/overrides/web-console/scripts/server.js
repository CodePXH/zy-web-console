#!/usr/bin/env node
/**
 * Web Console Server with WebSocket
 * Provides HTTP API + WebSocket for real-time browser-based Claude communication
 *
 * Run with PM2: pm2 start server.js --name web-console
 * Default port: 3456
 */

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import {
  MAX_ATTACHMENTS,
  buildAnnotatedContent,
  classifyConversationMessage,
  contentDisposition,
  generateStoredFileName,
  parseMediaContent,
  resolveAllowedPathSync,
  sanitizeDisplayName,
  sniffImage,
  splitContentAndAttachments,
  uploadKind
} from './attachment-utils.js';
import { openDb, SessionStore, PersistentUploadRegistry, UserStore, UsageAuditStore } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.WEB_CONSOLE_PORT || 3456;

// Paths
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const SKILLS_DIR = process.env.WEB_CONSOLE_SKILLS_DIR || path.join(os.homedir(), 'zylos', '.claude', 'skills');
const DB_DIR = path.join(ZYLOS_DIR, 'comm-bridge');
const DB_PATH = path.join(DB_DIR, 'c4.db');
const STATUS_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'agent-status.json');
const CODEX_CONFIG_FILE = path.join(os.homedir(), '.codex', 'config.toml');
const MEDIA_DIR = path.join(ZYLOS_DIR, 'web-console', 'media');
const PROJECT_WORKSPACE_ROOT = path.join(ZYLOS_DIR, 'workspace', 'web-console-projects');
const MAX_UPLOAD_MB = Number.parseInt(process.env.WEB_CONSOLE_MAX_UPLOAD_MB || '20', 10);
const MAX_UPLOAD_BYTES = Math.max(1, MAX_UPLOAD_MB) * 1024 * 1024;
const C4_SCRIPT_DIR = path.join(SKILLS_DIR, 'comm-bridge', 'scripts');

const USER_CAPABILITIES = [
  {
    id: 'projects', title: '项目工作区', category: 'Zylos',
    description: '每个项目有独立工作目录和会话；切换会话时未发送草稿会自动保留。',
    how: '使用左侧 + New project 创建项目，再在项目下创建会话即可。'
  },
  {
    id: 'attachments', title: '文件与图片附件', category: 'Zylos',
    description: '上传图片或文件后与当前会话绑定，可让助手分析、总结或基于资料完成工作。',
    how: '点击输入框左侧 Attach，上传后直接说明希望助手如何处理。'
  },
  {
    id: 'cangjie', title: '仓颉语言开发', category: '专业技能', skillPath: path.join(os.homedir(), '.codex', 'skills', 'cangjie-lang-skill', 'SKILL.md'),
    description: '生成、分析、审查和调试仓颉语言代码，并覆盖常见语法陷阱。',
    how: '直接提问：帮我用仓颉实现一个带单元测试的 LRU 缓存。'
  },
  {
    id: 'document-style', title: '文档风格复刻与技能包', category: '专业技能', skillPath: path.join(os.homedir(), '.codex', 'skills', 'style-distiller', 'SKILL.md'),
    description: '从你上传的参考文档中提取结构、语气和写作技巧，生成可复用的风格技能包。',
    how: '上传 2–5 份参考文档后说：根据这些文档生成一个写作风格技能，并用它写一份新需求文档。'
  },
  {
    id: 'writing-style-builder', title: '写作风格构建与审计', category: '专业技能', skillPath: path.join(os.homedir(), '.codex', 'skills', 'style-skill-builder', 'SKILL.md'),
    description: '将文章、品牌规范或访谈材料转为中性的写作规范，也可审查现有风格指南。',
    how: '直接提问：分析这些样稿，提炼可执行的品牌写作规范，并指出缺失的约束。'
  },
  {
    id: 'personal-style', title: '个人写作风格学习', category: '专业技能', skillPath: path.join(os.homedir(), '.codex', 'skills', 'docwriter-style-generator', 'SKILL.md'),
    description: '分析个人文章的用词、句式和段落习惯，生成可持续更新的个人风格能力。',
    how: '上传自己的文章后说：学习我的写作风格，之后用这个风格帮我写周报。'
  },
  {
    id: 'imagegen', title: '图片生成与编辑', category: '创作', skillPath: path.join(os.homedir(), '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'),
    description: '根据文字生成图片，或基于上传图片进行修改、扩图和风格转换。',
    how: '直接提问：生成一张深色科技风的产品封面图；或上传图片后说明要修改的部分。'
  },
  {
    id: 'scheduler', title: '定时任务', category: 'Zylos', skillPath: path.join(SKILLS_DIR, 'scheduler', 'SKILL.md'),
    description: '创建一次性、定期或 Cron 定时任务，在指定时间执行后续工作。',
    how: '直接提问：每周一上午 9 点提醒我整理本周项目进度。'
  },
  {
    id: 'github', title: 'GitHub 集成', category: '已安装集成',
    description: '已安装 GitHub 插件；连接授权后可基于你的 GitHub 权限处理仓库、Issue 和代码协作。',
    how: '先完成 GitHub 授权，然后说明：查看这个仓库的未解决 Issue 并给出优先级建议。',
    connectionRequired: true
  },
  {
    id: 'gmail', title: 'Gmail 集成', category: '已安装集成',
    description: '已安装 Gmail 插件；连接授权后可基于你的 Gmail 权限检索和处理邮件。',
    how: '先完成 Gmail 授权，然后说明：汇总我今天未读邮件中的待办事项。',
    connectionRequired: true
  },
  {
    id: 'usage', title: '个人使用监控', category: 'Zylos',
    description: '查看自己项目、会话、消息、附件和近期活动的使用情况。',
    how: '点击左侧 My usage。仅展示当前登录用户自己的数据。'
  },
  {
    id: 'admin-audit', title: '用户使用审计', category: '管理员', adminOnly: true,
    description: '查看全体用户汇总、最后活动时间和操作元数据审计记录。',
    how: '管理员登录后点击左侧 Usage audit。不会显示消息正文或凭据。'
  },
  {
    id: 'admin-dashboard', title: '运行驾驶舱', category: '管理员', adminOnly: true,
    description: '总览全体用户的估算 Token、请求趋势、活跃度、工作区和既有操作监控。',
    how: '管理员登录后点击左侧 Operations dashboard。Token 为本地消息文本估算值，不是模型供应商账单。'
  },
  {
    id: 'account-management', title: '账号管理', category: '管理员', adminOnly: true,
    description: '创建普通用户或管理员账号，并停用普通用户账号。',
    how: '管理员登录后点击左侧 Manage accounts。'
  }
];

// Paths - __dirname is scripts/, public/ is one level up
const SKILL_ROOT = path.join(__dirname, '..');

// --- Authentication ---
import { parse as parseDotenv } from 'dotenv';

function readEnv() {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    return parseDotenv(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}

const ENV = readEnv();

const wcDb = openDb();
const sessionStore = new SessionStore(wcDb);
const userStore = new UserStore(wcDb);
const uploadRegistry = new PersistentUploadRegistry(wcDb);
const usageAudit = new UsageAuditStore(wcDb);

wcDb.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    workspace_path TEXT,
    runner_session TEXT,
    runner_status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_projects_owner_updated ON projects(owner_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    project_id TEXT,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_owner_updated ON conversations(owner_id, updated_at DESC);
`);
const projectColumns = wcDb.prepare("PRAGMA table_info(projects)").all().map((column) => column.name);
if (!projectColumns.includes('workspace_path')) wcDb.exec('ALTER TABLE projects ADD COLUMN workspace_path TEXT');
if (!projectColumns.includes('runner_session')) wcDb.exec('ALTER TABLE projects ADD COLUMN runner_session TEXT');
if (!projectColumns.includes('runner_status')) wcDb.exec("ALTER TABLE projects ADD COLUMN runner_status TEXT NOT NULL DEFAULT 'pending'");
const conversationColumns = wcDb.prepare("PRAGMA table_info(conversations)").all().map((column) => column.name);
if (!conversationColumns.includes('project_id')) wcDb.exec('ALTER TABLE conversations ADD COLUMN project_id TEXT');
const legacyOwners = wcDb.prepare('SELECT DISTINCT owner_id FROM conversations WHERE project_id IS NULL').all();
for (const { owner_id: ownerId } of legacyOwners) {
  const projectId = crypto.randomUUID();
  const now = Date.now();
  wcDb.prepare('INSERT INTO projects (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(projectId, ownerId, 'Legacy conversations', now, now);
  wcDb.prepare('UPDATE conversations SET project_id = ? WHERE owner_id = ? AND project_id IS NULL').run(projectId, ownerId);
}
wcDb.exec('CREATE INDEX IF NOT EXISTS idx_conversations_project_updated ON conversations(project_id, updated_at DESC)');

// Preserve access on upgrade: the existing console password becomes the initial admin password.
if (userStore.count() === 0) {
  const legacyPassword = ENV.ZYLOS_WEB_PASSWORD || ENV.WEB_CONSOLE_PASSWORD || '';
  if (!legacyPassword) throw new Error('Web Console needs ZYLOS_WEB_PASSWORD to create the initial administrator');
  userStore.create({ username: ENV.WEB_CONSOLE_ADMIN_USERNAME || 'admin', password: legacyPassword, role: 'admin' });
}

fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(PROJECT_WORKSPACE_ROOT, { recursive: true });

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name] = rest.join('=');
  }
  return cookies;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies.wc_session || !sessionStore.has(cookies.wc_session)) return false;
  const session = sessionStore.get(cookies.wc_session);
  if (!session?.user_id || !userStore.get(session.user_id)) return false;
  sessionStore.touch(cookies.wc_session);
  return true;
}

function getIdentity(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies.wc_session) return null;
  const session = sessionStore.get(cookies.wc_session);
  if (!session?.user_id) return null;
  const user = userStore.get(session.user_id);
  return user ? { sessionId: cookies.wc_session, user } : null;
}

function authMiddleware(req, res, next) {
  // Auth endpoints are always accessible
  if (req.path === '/auth') return next();
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(SKILL_ROOT, 'public')));
app.use('/api', authMiddleware);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
    filename: (_req, file, cb) => cb(null, generateStoredFileName(file.originalname))
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1
  }
});

// Initialize database connection
let db;
try {
  // Verify database file exists
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found: ${DB_PATH}`);
    console.error('Make sure comm-bridge is initialized first (run c4-db.js init)');
    process.exit(1);
  }

  db = new Database(DB_PATH, { readonly: false });

  // Verify schema exists
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get();
  if (!tableCheck) {
    console.error('Database schema not initialized');
    console.error('Run: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js init');
    process.exit(1);
  }
} catch (err) {
  console.error(`Failed to open database: ${err.message}`);
  console.error('Make sure comm-bridge is initialized first');
  process.exit(1);
}

// Track connected WebSocket clients
const clients = new Set();

// Last known state for change detection
let lastStatus = null;
let lastMessageId = 0;

function readModelInfo() {
  try {
    const config = fs.readFileSync(CODEX_CONFIG_FILE, 'utf8');
    const model = config.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
    const reasoningEffort = config.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
    return { model: model || 'Not configured', reasoningEffort: reasoningEffort || 'Default' };
  } catch {
    return { model: 'Unavailable', reasoningEffort: 'Unavailable' };
  }
}

/**
 * Read current Claude status together with the configured Codex model.
 */
function readStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return { ...JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')), modelInfo: readModelInfo() };
    }
    return { state: 'unknown', message: 'Status file not found', modelInfo: readModelInfo() };
  } catch (err) {
    return { state: 'error', message: err.message, modelInfo: readModelInfo() };
  }
}

/**
 * Strip internal routing info from message content for display
 */
function stripReplyVia(content) {
  // Remove "---- reply via: ..." suffix
  const idx = content.indexOf(' ---- reply via:');
  if (idx !== -1) {
    return content.substring(0, idx);
  }
  return content;
}

/**
 * Clean message for display (strip internal routing info)
 */
function cleanMessageForDisplay(msg, conversation = null) {
  const cleaned = {
    ...msg,
    content: stripReplyVia(msg.content)
  };
  const classified = classifyConversationMessage(cleaned);
  if (classified.kind === 'media') return classified;
  if (cleaned.direction === 'in') {
    const parsed = splitContentAndAttachments(cleaned.content);
    if (parsed.attachments.length > 0) {
      return {
        ...cleaned,
        content: parsed.content,
        attachments: parsed.attachments.map((attachment) => {
          const result = {
            kind: attachment.kind,
            name: attachment.name,
            size_label: attachment.sizeLabel
          };
          const basename = path.basename(attachment.path || '');
          if (conversation && basename && attachment.path === path.join(MEDIA_DIR, basename)) {
            result.href = `/api/inbound-media/${encodeURIComponent(basename)}?project_id=${encodeURIComponent(conversation.project_id)}&conversation_id=${encodeURIComponent(conversation.id)}`;
          }
          return result;
        })
      };
    }
  }
  return cleaned;
}

/**
 * Get new messages since given ID
 */
function endpointFor(conversation) {
  const project = wcDb.prepare('SELECT id, runner_status FROM projects WHERE id = ? AND owner_id = ?').get(conversation.project_id, conversation.owner_id);
  if (project?.runner_status === 'running') return `wcp-${project.id}-${conversation.owner_id}-${conversation.id}`;
  return `wc-${conversation.owner_id}-${conversation.id}`;
}

function getConversation(userId, projectId, conversationId) {
  return wcDb.prepare('SELECT * FROM conversations WHERE id = ? AND owner_id = ? AND project_id = ?').get(conversationId, userId, projectId) || null;
}

function createConversation(userId, projectId, title = 'New conversation') {
  const conversation = { id: crypto.randomUUID(), owner_id: userId, project_id: projectId, title: String(title).trim().slice(0, 80) || 'New conversation', created_at: Date.now(), updated_at: Date.now() };
  wcDb.prepare('INSERT INTO conversations (id, owner_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(conversation.id, conversation.owner_id, conversation.project_id, conversation.title, conversation.created_at, conversation.updated_at);
  return conversation;
}

function getProject(userId, projectId) {
  return wcDb.prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?').get(projectId, userId) || null;
}

function workspacePathForProject(ownerId, projectId) {
  return path.join(PROJECT_WORKSPACE_ROOT, ownerId, projectId);
}

function ensureProjectWorkspace(project) {
  const workspacePath = project.workspace_path || workspacePathForProject(project.owner_id, project.id);
  const root = path.resolve(PROJECT_WORKSPACE_ROOT);
  const resolved = path.resolve(workspacePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Invalid project workspace path');
  fs.mkdirSync(resolved, { recursive: true });
  if (project.workspace_path !== resolved) {
    wcDb.prepare('UPDATE projects SET workspace_path = ? WHERE id = ? AND owner_id = ?').run(resolved, project.id, project.owner_id);
    project.workspace_path = resolved;
  }
  return project;
}

function projectRunnerSession(project) {
  return `codex-project-${project.id}`;
}

function startProjectRunner(project) {
  const session = project.runner_session || projectRunnerSession(project);
  const workspacePath = ensureProjectWorkspace(project).workspace_path;
  const exists = spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
  if (!exists) {
    const runnerPath = '/home/zylos-cm/.nvm/versions/node/v22.22.3/bin:/usr/local/bin:/usr/bin:/bin';
    const launched = spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', workspacePath, `exec env -u CODEX_CI PATH=${JSON.stringify(runnerPath)} codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen`], { stdio: 'ignore' });
    if (launched.status !== 0) {
      wcDb.prepare("UPDATE projects SET runner_session = ?, runner_status = 'failed' WHERE id = ? AND owner_id = ?").run(session, project.id, project.owner_id);
      return { ...project, runner_session: session, runner_status: 'failed' };
    }
    // A fresh Codex workspace asks once whether to trust its local contents.
    // Project directories are created by this service and contain no user-supplied
    // bootstrap code, so accepting the initial prompt is safe and prevents the
    // first routed message from being stuck behind it.
    const confirmTrust = setTimeout(() => {
      spawnSync('tmux', ['send-keys', '-t', session, 'Enter'], { stdio: 'ignore' });
    }, 750);
    confirmTrust.unref();
    spawnSync('tmux', ['set-option', '-t', session, 'remain-on-exit', 'on'], { stdio: 'ignore' });
  }
  wcDb.prepare("UPDATE projects SET runner_session = ?, runner_status = 'running' WHERE id = ? AND owner_id = ?").run(session, project.id, project.owner_id);
  return { ...project, runner_session: session, runner_status: 'running' };
}

function createProject(userId, title = 'New project') {
  const project = { id: crypto.randomUUID(), owner_id: userId, title: String(title).trim().slice(0, 80) || 'New project', created_at: Date.now(), updated_at: Date.now() };
  project.workspace_path = workspacePathForProject(project.owner_id, project.id);
  wcDb.prepare('INSERT INTO projects (id, owner_id, title, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(project.id, project.owner_id, project.title, project.workspace_path, project.created_at, project.updated_at);
  return startProjectRunner(project);
}

function deleteProject(userId, projectId) {
  const project = getProject(userId, projectId);
  if (!project) return false;

  // Delete only the canonical owner/project directory, never a path persisted
  // in the database, so a project cannot reach outside the workspace root.
  const root = path.resolve(PROJECT_WORKSPACE_ROOT);
  const workspacePath = path.resolve(workspacePathForProject(project.owner_id, project.id));
  if (!workspacePath.startsWith(`${root}${path.sep}`)) throw new Error('Invalid project workspace path');

  // Stop the project's own runner before its working directory is removed.
  spawnSync('tmux', ['kill-session', '-t', projectRunnerSession(project)], { stdio: 'ignore' });
  fs.rmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

  wcDb.transaction(() => {
    wcDb.prepare('DELETE FROM conversations WHERE project_id = ? AND owner_id = ?').run(project.id, project.owner_id);
    wcDb.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(project.id, project.owner_id);
  })();
  return true;
}

function titleFromFirstMessage(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'New conversation';
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function getOrCreateConversation(userId, projectId) {
  const existing = wcDb.prepare('SELECT * FROM conversations WHERE owner_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 1').get(userId, projectId);
  return existing || createConversation(userId, projectId);
}

function getNewMessages(sinceId, endpoint, conversation) {
  try {
    const stmt = db.prepare(`
      SELECT id, direction, channel, endpoint_id, content, timestamp
      FROM conversations
      WHERE channel = 'web-console' AND endpoint_id = ? AND id > ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(endpoint, sinceId).map((message) => cleanMessageForDisplay(message, conversation));
  } catch (err) {
    return [];
  }
}

/**
 * Broadcast message to all connected clients
 */
function broadcast(type, data, predicate = () => true) {
  const message = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.ws.readyState === 1 && predicate(client)) {
      client.ws.send(message);
    }
  }
}

function normalizeAttachmentIds(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === 'string' && id.length > 0);
}

function validateSendPayload(content, attachmentIds) {
  if (attachmentIds.length > MAX_ATTACHMENTS) {
    const err = new Error(`Maximum ${MAX_ATTACHMENTS} attachments per message`);
    err.status = 400;
    err.code = 'too_many_attachments';
    throw err;
  }

  if (!String(content || '').trim() && attachmentIds.length === 0) {
    const err = new Error('Message is required');
    err.status = 400;
    err.code = 'message_required';
    throw err;
  }
}

function buildSendContent(content, attachmentEntries) {
  const message = buildAnnotatedContent(content, attachmentEntries);
  if (!message.trim()) {
    const err = new Error('Message is required');
    err.status = 400;
    err.code = 'message_required';
    throw err;
  }
  return message;
}

function sendToC4(content, endpoint) {
  const c4Receive = path.join(C4_SCRIPT_DIR, 'c4-receive.js');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      c4Receive,
      '--channel', 'web-console',
      '--endpoint', endpoint,
      '--content', content
    ], { stdio: 'pipe' });

    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(stderr || 'Failed to send message');
        err.status = 500;
        err.code = 'send_failed';
        reject(err);
      }
    });
    child.on('error', (err) => {
      err.status = 500;
      err.code = 'send_failed';
      reject(err);
    });
  });
}

async function sendConsoleMessage({ content, attachmentIds, sessionId, userId, conversation }) {
  const ids = normalizeAttachmentIds(attachmentIds);
  validateSendPayload(content, ids);

  let attachmentEntries = [];
  if (ids.length > 0) {
    attachmentEntries = uploadRegistry.getMany(ids, sessionId, userId);
    if (attachmentEntries.length !== ids.length) {
      const err = new Error('Attachment upload id is invalid or expired');
      err.status = 400;
      err.code = 'invalid_attachment';
      throw err;
    }
  }

  const combined = buildSendContent(content, attachmentEntries);
  if (ids.length > 0) {
    attachmentEntries = uploadRegistry.consumeMany(ids, sessionId, userId, conversation.id);
    if (!attachmentEntries) {
      const err = new Error('Attachment upload id is invalid or expired');
      err.status = 400;
      err.code = 'invalid_attachment';
      throw err;
    }
  }
  try {
    await sendToC4(combined, endpointFor(conversation));
  } catch (err) {
    uploadRegistry.restoreMany(attachmentEntries);
    throw err;
  }
  wcDb.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversation.id);
  if (conversation.title === 'New conversation') {
    wcDb.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(titleFromFirstMessage(content), Date.now(), conversation.id);
  }
  usageAudit.log({
    userId,
    eventType: 'message_sent',
    projectId: conversation.project_id,
    conversationId: conversation.id,
    details: { characters: String(content || '').length, attachments: attachmentEntries.length }
  });
  return {
    content: combined,
    attachments: attachmentEntries.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      size_label: entry.sizeLabel || null
    }))
  };
}

function jsonError(res, err) {
  return res.status(err.status || 500).json({
    success: false,
    error: err.code || err.message || 'request_failed',
    message: err.message
  });
}

function getMediaRow(messageId, endpoint) {
  const row = db.prepare(`
    SELECT id, direction, channel, endpoint_id, content, timestamp
    FROM conversations
    WHERE id = ?
  `).get(messageId);

  if (!row || row.direction !== 'out' || row.channel !== 'web-console' || row.endpoint_id !== endpoint) {
    return null;
  }

  const media = parseMediaContent(row.content);
  if (!media) return null;
  return { row, media };
}

/**
 * Check for status changes and new messages
 */
function checkUpdates() {
  // Check status changes
  const currentStatus = readStatus();
  if (!lastStatus || currentStatus.state !== lastStatus.state || currentStatus.modelInfo?.model !== lastStatus.modelInfo?.model || currentStatus.modelInfo?.reasoningEffort !== lastStatus.modelInfo?.reasoningEffort) {
    lastStatus = currentStatus;
    broadcast('status', currentStatus);
  }

  // Check for new messages
  const newMessages = (() => {
    try {
      return db.prepare(`SELECT id, direction, channel, endpoint_id, content, timestamp FROM conversations WHERE channel = 'web-console' AND id > ? ORDER BY timestamp ASC`).all(lastMessageId);
    } catch { return []; }
  })();
  if (newMessages.length > 0) {
    lastMessageId = Math.max(...newMessages.map(m => m.id));
    for (const client of clients) {
      const scoped = newMessages
        .filter((message) => message.endpoint_id === client.endpoint)
        .map((message) => cleanMessageForDisplay(message, client.conversation));
      if (scoped.length > 0) broadcast('messages', scoped, (candidate) => candidate === client);
    }
  }
}

// Start update checker (every 500ms for responsiveness)
setInterval(checkUpdates, 500);

// Initialize lastMessageId
try {
  const stmt = db.prepare(`SELECT MAX(id) as maxId FROM conversations WHERE channel = 'web-console'`);
  const result = stmt.get();
  lastMessageId = result?.maxId || 0;
} catch (err) {
  // Ignore
}

/**
 * WebSocket connection handler
 */
wss.on('connection', (ws, req) => {
  if (!isAuthenticated(req)) {
    ws.close(4001, 'Authentication required');
    return;
  }

  const identity = getIdentity(req);
  const client = { ws, identity, endpoint: null, conversation: null };

  clients.add(client);
  console.log(`WebSocket client connected (${clients.size} total)`);

  // Send current status immediately
  const status = readStatus();
  ws.send(JSON.stringify({ type: 'status', data: status }));

  // Handle client messages
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'send') {
        const tempId = msg.tempId; // Track client's temp ID
        try {
          const conversation = getConversation(identity.user.id, msg.projectId, msg.conversationId);
          if (!conversation) throw new Error('Conversation not found');
          await sendConsoleMessage({
            content: msg.content || '',
            attachmentIds: msg.attachments,
            sessionId: identity.sessionId,
            userId: identity.user.id,
            conversation
          });
          ws.send(JSON.stringify({ type: 'sent', success: true, tempId }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'sent',
            success: false,
            error: err.code || err.message,
            message: err.message,
            tempId
          }));
        }
      }
      if (msg.type === 'select_conversation') {
        const conversation = getConversation(identity.user.id, msg.projectId, msg.conversationId);
        if (!conversation) throw new Error('Conversation not found');
          client.endpoint = endpointFor(conversation);
          client.conversation = conversation;
      }
    } catch (err) {
      // Ignore invalid messages
    }
  });

  ws.on('close', () => {
    clients.delete(client);
    console.log(`WebSocket client disconnected (${clients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    clients.delete(client);
  });
});

/**
 * Get Claude status (HTTP fallback)
 */
app.get('/api/status', (req, res) => {
  res.json(readStatus());
});

/**
 * Get conversation history
 */
app.get('/api/conversations', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const identity = getIdentity(req);
    const conversation = getConversation(identity.user.id, req.query.project_id, req.query.conversation_id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    // channel is caller-controlled; 'void' is the internal record-only
    // channel (#689) and must never reach a display surface.
    const stmt = db.prepare(`
      SELECT id, direction, channel, endpoint_id, content, timestamp
      FROM conversations
      WHERE channel = 'web-console' AND endpoint_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const conversations = stmt.all(endpointFor(conversation), limit).map((message) => cleanMessageForDisplay(message, conversation));
    res.json(conversations.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get all recent conversations (for display)
 */
app.get('/api/conversations/recent', (req, res) => {
  req.query.conversation_id = req.query.conversation_id || '';
  return res.redirect(307, `/api/conversations?conversation_id=${encodeURIComponent(req.query.conversation_id)}&limit=${encodeURIComponent(req.query.limit || 100)}`);
});

/**
 * Upload one attachment for a later send call
 */
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          error: 'upload_too_large',
          message: `File exceeds ${MAX_UPLOAD_MB}MB limit`
        });
      }
      return res.status(400).json({ success: false, error: 'upload_failed', message: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'file_required' });
    }

    const identity = getIdentity(req);
    const name = sanitizeDisplayName(req.file.originalname, 'attachment');
    const entry = uploadRegistry.add({
      sessionId: identity.sessionId,
      userId: identity.user.id,
      path: req.file.path,
      name,
      size: req.file.size,
      sizeLabel: req.file.size < 1024 ? `${req.file.size}B`
        : req.file.size < 1024 * 1024 ? `${(req.file.size / 1024).toFixed(1)}KB`
          : `${(req.file.size / (1024 * 1024)).toFixed(1)}MB`,
      mime: req.file.mimetype || 'application/octet-stream',
      kind: uploadKind(req.file)
    });
    usageAudit.log({
      userId: identity.user.id,
      eventType: 'attachment_uploaded',
      details: { bytes: req.file.size, kind: entry.kind }
    });

    return res.json({
      id: entry.id,
      name: entry.name,
      size: entry.size,
      mime: entry.mime,
      kind: entry.kind
    });
  });
});

/**
 * Send message to Claude (HTTP fallback)
 */
app.post('/api/send', (req, res) => {
  const identity = getIdentity(req);
  const conversation = getConversation(identity.user.id, req.body.projectId, req.body.conversationId);
  if (!conversation) return res.status(404).json({ success: false, error: 'conversation_not_found' });
  sendConsoleMessage({
    content: req.body.message || '',
    attachmentIds: req.body.attachments,
    sessionId: identity.sessionId,
    userId: identity.user.id,
    conversation
  }).then(() => {
    res.json({ success: true, message: 'Message sent to Claude' });
  }).catch((err) => jsonError(res, err));
});

app.get('/api/me', (req, res) => {
  const identity = getIdentity(req);
  res.json({ user: identity.user });
});

app.get('/api/capabilities', (req, res) => {
  const identity = getIdentity(req);
  const capabilities = USER_CAPABILITIES
    .filter((capability) => !capability.adminOnly || identity.user.role === 'admin')
    .filter((capability) => !capability.skillPath || fs.existsSync(capability.skillPath))
    .map(({ skillPath: _skillPath, adminOnly: _adminOnly, ...capability }) => capability);
  res.json({ capabilities });
});

app.get('/api/usage/me', (req, res) => {
  const identity = getIdentity(req);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 50);
  res.json(usageAudit.personalUsage(identity.user.id, limit));
});

app.get('/api/projects', (req, res) => {
  const identity = getIdentity(req);
  const projects = wcDb.prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC').all(identity.user.id)
    .map(ensureProjectWorkspace)
    .map((project) => project.runner_status === 'running' ? startProjectRunner(project) : project);
  res.json(projects.map(({ id, title, created_at, updated_at }) => ({ id, title, created_at, updated_at })));
});

app.post('/api/projects', (req, res) => {
  const identity = getIdentity(req);
  const project = createProject(identity.user.id, req.body.title);
  usageAudit.log({ userId: identity.user.id, eventType: 'project_created', projectId: project.id });
  res.status(201).json(project);
});

app.patch('/api/projects/:id', (req, res) => {
  const identity = getIdentity(req);
  const project = getProject(identity.user.id, req.params.id);
  const title = String(req.body.title || '').trim().slice(0, 80);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!title) return res.status(400).json({ error: 'Project name is required' });
  const updatedAt = Date.now();
  wcDb.prepare('UPDATE projects SET title = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(title, updatedAt, project.id, identity.user.id);
  res.json({ ...project, title, updated_at: updatedAt });
});

app.delete('/api/projects/:id', (req, res) => {
  const identity = getIdentity(req);
  try {
    if (!deleteProject(identity.user.id, req.params.id)) return res.status(404).json({ error: 'Project not found' });
    usageAudit.log({ userId: identity.user.id, eventType: 'project_deleted', projectId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete project:', err);
    res.status(500).json({ error: 'Could not delete project' });
  }
});

app.get('/api/conversation-list', (req, res) => {
  const identity = getIdentity(req);
  const project = getProject(identity.user.id, req.query.project_id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const conversations = wcDb.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE owner_id = ? AND project_id = ? ORDER BY updated_at DESC').all(identity.user.id, project.id);
  res.json(conversations);
});

app.post('/api/conversations', (req, res) => {
  const identity = getIdentity(req);
  const project = getProject(identity.user.id, req.body.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const conversation = createConversation(identity.user.id, project.id, req.body.title);
  usageAudit.log({ userId: identity.user.id, eventType: 'conversation_created', projectId: project.id, conversationId: conversation.id });
  res.status(201).json(conversation);
});

app.patch('/api/conversations/:id', (req, res) => {
  const identity = getIdentity(req);
  const conversation = getConversation(identity.user.id, req.body.projectId, req.params.id);
  const title = String(req.body.title || '').trim().slice(0, 80);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  if (!title) return res.status(400).json({ error: 'Conversation name is required' });
  wcDb.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), conversation.id);
  res.json({ ...conversation, title, updated_at: Date.now() });
});

app.delete('/api/conversations/:id', (req, res) => {
  const identity = getIdentity(req);
  const conversation = getConversation(identity.user.id, req.query.project_id, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  // C4 messages remain retained for audit; removing this index entry only removes it from this user's workspace.
  wcDb.prepare('DELETE FROM conversations WHERE id = ? AND owner_id = ?').run(conversation.id, identity.user.id);
  usageAudit.log({ userId: identity.user.id, eventType: 'conversation_deleted', projectId: conversation.project_id, conversationId: conversation.id });
  res.json({ success: true });
});

function requireAdmin(req, res, next) {
  const identity = getIdentity(req);
  if (identity?.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  next();
}

let nativeUsageCache = { expiresAt: 0, records: [] };

function collectNativeTokenUsage(days) {
  const now = Date.now();
  if (nativeUsageCache.expiresAt > now) return nativeUsageCache.records;
  const cutoff = now - days * 86400000;
  const workspaceOwners = new Map(wcDb.prepare('SELECT owner_id, workspace_path FROM projects WHERE workspace_path IS NOT NULL').all()
    .map((project) => [path.resolve(project.workspace_path), project.owner_id]));
  const endpointOwners = new Map();
  for (const conversation of wcDb.prepare('SELECT id, owner_id, project_id FROM conversations').all()) {
    endpointOwners.set(`wc-${conversation.owner_id}-${conversation.id}`, conversation.owner_id);
    if (conversation.project_id) endpointOwners.set(`wcp-${conversation.project_id}-${conversation.owner_id}-${conversation.id}`, conversation.owner_id);
  }
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files = [];
  const walk = (directory) => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { if (fs.statSync(candidate).mtimeMs >= cutoff) files.push(candidate); } catch { /* file rotated */ }
      }
    }
  };
  walk(root);
  const records = [];
  const seen = new Set();
  for (const file of files) {
    let cwd = null;
    let routedUserId = null;
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const contextCwd = event.type === 'turn_context' ? event.payload?.cwd : event.payload?.thread_settings?.cwd;
      if (contextCwd) cwd = path.resolve(contextCwd);
      // C4 fetch output records the exact web-console endpoint that a Codex
      // turn is handling. It lets the native CLI usage log be attributed to
      // the owning user even when the runner is the shared root session.
      const eventText = event.payload?.output?.map?.((item) => item?.text || '').join('\n') || event.payload?.item?.aggregated_output || '';
      if (eventText) {
        const endpoints = [...new Set([...String(eventText).matchAll(/web-console:(wcp?-[A-Za-z0-9-]+)/g)].map((match) => match[1]))];
        routedUserId = endpoints.length === 1 ? endpointOwners.get(endpoints[0]) || null : null;
      }
      const ownerId = workspaceOwners.get(cwd) || routedUserId;
      if (event.type !== 'token_usage_record' || !ownerId) continue;
      const usage = event.payload?.usage;
      const responseId = event.payload?.response_id;
      const timestamp = Date.parse(event.timestamp);
      if (!usage || !responseId || !Number.isFinite(timestamp) || timestamp < cutoff) continue;
      const key = `${cwd}:${responseId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({
        response_id: responseId, user_id: ownerId, date: new Date(timestamp).toISOString().slice(0, 10), occurred_at: timestamp, requests: 1,
        input_tokens: usage.input_tokens || 0, cached_input_tokens: usage.cached_input_tokens || 0,
        output_tokens: usage.output_tokens || 0, reasoning_output_tokens: usage.reasoning_output_tokens || 0,
        total_tokens: usage.total_tokens || 0
      });
    }
  }
  nativeUsageCache = { expiresAt: now + 60000, records };
  return records;
}

app.get('/api/users', requireAdmin, (_req, res) => res.json(userStore.list()));

app.get('/api/admin/usage', requireAdmin, (req, res) => {
  const userId = typeof req.query.user_id === 'string' && req.query.user_id ? req.query.user_id : null;
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 250);
  res.json(usageAudit.adminUsage({ userId, limit }));
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 14, 1), 90);
  const nativeUsage = collectNativeTokenUsage(days);
  const insertNativeUsage = wcDb.prepare(`INSERT OR IGNORE INTO native_token_usage
    (response_id, user_id, usage_date, occurred_at, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const persistNativeUsage = wcDb.transaction((records) => records.forEach((record) => insertNativeUsage.run(
    record.response_id, record.user_id, record.date, record.occurred_at, record.input_tokens,
    record.cached_input_tokens, record.output_tokens, record.reasoning_output_tokens, record.total_tokens
  )));
  persistNativeUsage(nativeUsage);
  res.json(usageAudit.dashboardUsage(db, { days, nativeUsage }));
});

app.post('/api/users', requireAdmin, (req, res) => {
  try {
    const user = userStore.create({ username: req.body.username, password: req.body.password, role: req.body.role || 'user' });
    res.status(201).json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  try {
    userStore.disable(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Serve an outbound media row by message id
 */
app.get('/api/media/:messageId', (req, res) => {
  try {
    const messageId = Number.parseInt(req.params.messageId, 10);
    if (!Number.isSafeInteger(messageId)) return res.sendStatus(404);

    const identity = getIdentity(req);
    const conversation = getConversation(identity.user.id, req.query.project_id, req.query.conversation_id);
    if (!conversation) return res.sendStatus(404);
    const result = getMediaRow(messageId, endpointFor(conversation));
    if (!result) return res.sendStatus(404);

    const allowedPath = resolveAllowedPathSync(result.media.path, [ZYLOS_DIR, '/tmp']);
    if (!allowedPath) {
      console.warn(`Blocked web-console media path outside allowlist: ${result.media.path}`);
      return res.sendStatus(404);
    }

    let stat;
    try {
      stat = fs.statSync(allowedPath);
    } catch {
      return res.sendStatus(404);
    }
    if (!stat.isFile()) return res.sendStatus(404);

    const fd = fs.openSync(allowedPath, 'r');
    const head = Buffer.alloc(Math.min(16, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);

    const image = result.media.media_type === 'image' ? sniffImage(head) : null;
    const disposition = image ? 'inline' : 'attachment';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', image?.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(disposition, result.media.name));
    res.sendFile(allowedPath);
  } catch {
    res.sendStatus(404);
  }
});

/**
 * Serve a user-uploaded inbound media file by filename
 */
app.get('/api/inbound-media/:filename', (req, res) => {
  try {
    const identity = getIdentity(req);
    const conversation = getConversation(identity.user.id, req.query.project_id, req.query.conversation_id);
    if (!conversation) return res.sendStatus(404);
    const filename = path.basename(req.params.filename);
    if (!filename || filename === '.' || filename === '..') return res.sendStatus(404);
    const target = path.join(MEDIA_DIR, filename);

    const allowedPath = resolveAllowedPathSync(target, [MEDIA_DIR]);
    if (!allowedPath || !uploadRegistry.isAccessible(allowedPath, identity.user.id, conversation.id)) return res.sendStatus(404);

    let stat;
    try {
      stat = fs.statSync(allowedPath);
    } catch {
      return res.sendStatus(404);
    }
    if (!stat.isFile()) return res.sendStatus(404);

    const fd = fs.openSync(allowedPath, 'r');
    const head = Buffer.alloc(Math.min(16, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);

    const image = sniffImage(head);
    const disposition = image ? 'inline' : 'attachment';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', image?.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(disposition, filename));
    res.sendFile(allowedPath);
  } catch {
    res.sendStatus(404);
  }
});

/**
 * Poll for new messages since given ID (HTTP fallback)
 */
app.get('/api/poll', (req, res) => {
  try {
    const sinceId = parseInt(req.query.since_id) || 0;
    const identity = getIdentity(req);
    const conversation = getConversation(identity.user.id, req.query.project_id, req.query.conversation_id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(getNewMessages(sinceId, endpointFor(conversation), conversation));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Check auth status
 */
app.get('/api/auth', (req, res) => {
  const identity = isAuthenticated(req) ? getIdentity(req) : null;
  res.json({
    required: true,
    authenticated: Boolean(identity),
    timezone: ENV.TZ || null,
    user: identity?.user || null
  });
});

/**
 * Login
 */
app.post('/api/auth', (req, res) => {
  const { username, password, remember } = req.body;
  const user = userStore.authenticate(username, password);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Incorrect username or password' });
  }

  const token = sessionStore.create(user.id);
  usageAudit.log({ userId: user.id, eventType: 'login_success' });
  const maxAge = remember !== false ? `; Max-Age=${sessionStore.maxAgeSec}` : '';
  res.setHeader('Set-Cookie', `wc_session=${token}; Path=/; HttpOnly; SameSite=Strict${maxAge}`);
  res.json({ success: true, timezone: ENV.TZ || null, user });
});

/**
 * Logout
 */
app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.wc_session) sessionStore.delete(cookies.wc_session);
  res.setHeader('Set-Cookie', 'wc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ success: true });
});

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    websocket_clients: clients.size
  });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(SKILL_ROOT, 'public', 'index.html'));
});

// Start server (bind to localhost only for security)
const BIND_HOST = process.env.WEB_CONSOLE_BIND || '127.0.0.1';
server.listen(PORT, BIND_HOST, () => {
  console.log(`Web Console server running on http://${BIND_HOST}:${PORT}`);
  console.log(`WebSocket available at ws://${BIND_HOST}:${PORT}`);
  console.log('Authentication: multi-user enabled');
  console.log(`Database: ${DB_PATH}`);
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  wss.close();
  if (db) db.close();
  if (wcDb) wcDb.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
