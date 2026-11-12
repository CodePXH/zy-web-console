/**
 * Shared UI localization layer.
 *
 * Keep all display strings here so views only refer to stable keys. New
 * screens should use `t()` for generated content and `data-i18n` for markup.
 */
const UI_MESSAGES = {
  en: {
    loginHint: 'Sign in to your private workspace', username: 'Username', password: 'Password', remember: 'Remember me', login: 'Login',
    newProject: '+ New project', skillsGuide: 'Skills & guide', myUsage: 'My usage', dashboard: 'Operations dashboard', usageAudit: 'Usage audit', manageAccounts: 'Manage accounts', model: 'Model', messagePlaceholder: 'Type your message...',
    projectName: 'Project name', newProjectName: 'New project', conversationName: 'Conversation name', newConversation: 'New conversation',
    newConversationIn: 'New conversation in {project}', renameProject: 'Rename project', deleteProject: 'Delete {project}', renameConversation: 'Rename conversation', deleteConversation: 'Delete conversation',
    deleteProjectConfirm: 'Delete project “{project}” and all of its conversations and files? This cannot be undone.', deleteConversationConfirm: 'Delete “{conversation}” from your workspace? Its messages are retained in the system audit log.',
    disconnected: 'Disconnected', connectionError: 'Connection error', busy: 'Zylos is busy', ready: 'Zylos is ready', offline: 'Zylos is offline', unknownStatus: 'Unknown status', unavailable: 'Unavailable', defaultReasoning: 'Default', sending: 'Sending...', failedToSend: 'Failed to send', thinking: 'Zylos is thinking',
    attach: 'Attach images or files', attachLabel: 'Attach', attachment: 'attachment', image: 'Image', file: 'FILE', uploadInProgress: 'Uploading…', uploadFailed: 'Upload failed',
    noActivity: 'No activity recorded yet.', signedIn: 'Signed in', projectCreated: 'Created a project', projectDeleted: 'Deleted a project', conversationCreated: 'Created a conversation', conversationDeleted: 'Deleted a conversation', messageSent: 'Sent a message', attachmentUploaded: 'Uploaded an attachment',
    projects: 'Projects', conversations: 'Conversations', messagesSent: 'Messages sent', attachments: 'Attachments', uploaded: 'Uploaded', recentActivity: 'Recent activity', skillsGuideTitle: 'Skills & guide', guideIntro: 'Skills are used automatically when your request matches them. You can simply describe your goal in the chat; the examples below are ready to copy and adapt.', howToUse: 'How to use:', connectFirst: 'connect first',
    allUsers: 'All users', user: 'User', role: 'Role', lastActive: 'Last active', disable: 'Disable', disableConfirm: 'Disable {user}?', createAccount: 'Create account', accountManagement: 'Account management', close: 'Close',
    nativeUsage: 'Native usage', estimatedTokens: 'Estimated tokens', nativeTokens: 'Native tokens', requests: 'Requests', activeUsers: 'Active users', workspaces: 'Workspaces', lastDays: 'last {days} days', input: 'Input', cache: 'Cache', output: 'Output', reasoning: 'Reasoning', noRoutedActivity: 'No routed conversation activity in this period.', noActiveAccounts: 'No active accounts.', auditEvents: 'Audit events', dashboardUnavailable: 'Dashboard unavailable', monitoringOverview: 'Monitoring overview', userTokenRanking: 'User token ranking', tokenTrend: 'Token trend', allTime: 'all time'
  },
  zh: {
    loginHint: '登录你的专属工作区', username: '用户名', password: '密码', remember: '记住登录状态', login: '登录',
    newProject: '+ 新建项目', skillsGuide: '技能与使用指南', myUsage: '我的使用情况', dashboard: '运行驾驶舱', usageAudit: '用户使用审计', manageAccounts: '账号管理', model: '模型', messagePlaceholder: '输入消息...',
    projectName: '项目名称', newProjectName: '新项目', conversationName: '对话名称', newConversation: '新对话',
    newConversationIn: '在“{project}”中新建对话', renameProject: '重命名项目', deleteProject: '删除“{project}”', renameConversation: '重命名对话', deleteConversation: '删除对话',
    deleteProjectConfirm: '删除项目“{project}”及其所有对话和文件？此操作无法撤销。', deleteConversationConfirm: '从工作区删除“{conversation}”？系统审计日志仍会保留其消息记录。',
    disconnected: '连接已断开', connectionError: '连接错误', busy: 'Zylos 正在处理', ready: 'Zylos 已就绪', offline: 'Zylos 已离线', unknownStatus: '状态未知', unavailable: '不可用', defaultReasoning: '默认', sending: '发送中...', failedToSend: '发送失败', thinking: 'Zylos 正在思考',
    attach: '添加图片或文件', attachLabel: '附件', attachment: '附件', image: '图片', file: '文件', uploadInProgress: '上传中…', uploadFailed: '上传失败',
    noActivity: '暂无活动记录。', signedIn: '已登录', projectCreated: '已创建项目', projectDeleted: '已删除项目', conversationCreated: '已创建对话', conversationDeleted: '已删除对话', messageSent: '已发送消息', attachmentUploaded: '已上传附件',
    projects: '项目', conversations: '对话', messagesSent: '已发送消息', attachments: '附件', uploaded: '已上传', recentActivity: '最近活动', skillsGuideTitle: '技能与使用指南', guideIntro: '当你的请求与某项技能匹配时，系统会自动使用它。只需在对话中描述目标；以下示例可以直接复制并按需调整。', howToUse: '使用方法：', connectFirst: '需先连接',
    allUsers: '全部用户', user: '用户', role: '角色', lastActive: '最近活跃', disable: '停用', disableConfirm: '停用 {user}？', createAccount: '创建账号', accountManagement: '账号管理', close: '关闭',
    nativeUsage: '原生用量', estimatedTokens: '预估 Token', nativeTokens: '原生 Token', requests: '请求次数', activeUsers: '活跃用户', workspaces: '工作区', lastDays: '最近 {days} 天', input: '输入', cache: '缓存', output: '输出', reasoning: '推理', noRoutedActivity: '此期间暂无路由对话活动。', noActiveAccounts: '暂无活跃账号。', auditEvents: '审计事件', dashboardUnavailable: '驾驶舱不可用', monitoringOverview: '监控概览', userTokenRanking: '用户 Token 排名', tokenTrend: 'Token 趋势', allTime: '全部时间'
  }
};

const LOCALE_STORAGE_KEY = 'zylos.locale';
let activeLocale = localStorage.getItem(LOCALE_STORAGE_KEY) || (navigator.language.startsWith('zh') ? 'zh' : 'en');

function t(key, values = {}) {
  const template = UI_MESSAGES[activeLocale]?.[key] || UI_MESSAGES.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
}

function applyLocale() {
  document.documentElement.lang = activeLocale === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => { node.title = t(node.dataset.i18nTitle); });
  document.querySelectorAll('[data-language-toggle]').forEach((toggle) => { toggle.textContent = activeLocale === 'zh' ? 'EN' : '中文'; });
  window.dispatchEvent(new CustomEvent('zylos:locale-change'));
}

function setupLanguageSwitcher() {
  const toggles = [document.getElementById('language-toggle'), document.getElementById('login-language-toggle')].filter(Boolean);
  toggles.forEach((toggle) => {
    toggle.dataset.languageToggle = 'true';
    if (toggle.dataset.ready) return;
    toggle.dataset.ready = 'true';
    toggle.addEventListener('click', () => {
      activeLocale = activeLocale === 'zh' ? 'en' : 'zh';
      localStorage.setItem(LOCALE_STORAGE_KEY, activeLocale);
      applyLocale();
    });
  });
  applyLocale();
}
