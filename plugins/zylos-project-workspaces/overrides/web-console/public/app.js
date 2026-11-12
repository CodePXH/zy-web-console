/**
 * Zylos Web Console - Frontend Application with WebSocket
 */

class ZylosConsole {
  constructor(timezone, user) {
    this.messagesContainer = document.getElementById('messages');
    this.messageForm = document.getElementById('message-form');
    this.messageInput = document.getElementById('message-input');
    this.sendButton = document.getElementById('send-button');
    this.attachButton = document.getElementById('attach-button');
    this.fileInput = document.getElementById('file-input');
    this.attachmentTray = document.getElementById('attachment-tray');
    this.statusDot = document.querySelector('.status-dot');
    this.statusText = document.querySelector('.status-text');
    this.modelInfoValue = document.querySelector('.model-info-value');

    this.lastMessageId = 0;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.pendingMessages = new Map(); // Track messages being sent
    this.pendingAttachments = [];
    this.maxAttachments = 20;
    this.timezone = timezone || null;
    this.user = user || null;
    this.awaitingResponses = this.restoreAwaitingResponses();
    this.agentState = 'unknown';
    this.currentConversation = null;
    this.currentProject = null;
    this.projects = [];
    this.projectList = document.getElementById('project-list');
    this.newProjectButton = document.getElementById('new-project-btn');

    // Detect base path for API/WS calls (handles /console/ proxy)
    this.basePath = this.detectBasePath();

    this.initMarkdown();
    this.init();
  }

  detectBasePath() {
    const path = window.location.pathname;
    if (path.startsWith('/console')) {
      return '/console';
    }
    return '';
  }

  thinkingStorageKey() {
    return `zylos.awaiting-responses.${this.user?.id || 'anonymous'}`;
  }

  restoreAwaitingResponses() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(this.thinkingStorageKey()) || '[]');
      return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  }

  persistAwaitingResponses() {
    try {
      sessionStorage.setItem(this.thinkingStorageKey(), JSON.stringify([...this.awaitingResponses]));
    } catch {
      // The indicator still works for this page when browser storage is unavailable.
    }
  }

  draftStorageKey() {
    return `zylos.conversation-drafts.${this.user?.id || 'anonymous'}`;
  }

  readDrafts() {
    try {
      const drafts = JSON.parse(sessionStorage.getItem(this.draftStorageKey()) || '{}');
      return drafts && typeof drafts === 'object' && !Array.isArray(drafts) ? drafts : {};
    } catch {
      return {};
    }
  }

  writeDrafts(drafts) {
    try {
      sessionStorage.setItem(this.draftStorageKey(), JSON.stringify(drafts));
    } catch {
      // Drafts still remain available until the current page is closed.
    }
  }

  draftId(projectId = this.currentProject?.id, conversationId = this.currentConversation?.id) {
    return projectId && conversationId ? `${projectId}:${conversationId}` : null;
  }

  saveCurrentDraft() {
    const id = this.draftId();
    if (!id) return;
    const drafts = this.readDrafts();
    const content = this.messageInput.value;
    if (content) drafts[id] = content;
    else delete drafts[id];
    this.writeDrafts(drafts);
  }

  restoreCurrentDraft() {
    const id = this.draftId();
    const drafts = this.readDrafts();
    this.messageInput.value = id ? (typeof drafts[id] === 'string' ? drafts[id] : '') : '';
    this.autoResize();
  }

  clearConversationDraft(projectId = this.currentProject?.id, conversationId = this.currentConversation?.id) {
    const id = this.draftId(projectId, conversationId);
    if (!id) return;
    const drafts = this.readDrafts();
    delete drafts[id];
    this.writeDrafts(drafts);
  }

  clearProjectDrafts(projectId) {
    if (!projectId) return;
    const drafts = this.readDrafts();
    const prefix = `${projectId}:`;
    Object.keys(drafts).forEach((id) => {
      if (id.startsWith(prefix)) delete drafts[id];
    });
    this.writeDrafts(drafts);
  }

  getWebSocketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    // WebSocket needs trailing slash for proxy path matching
    const wsPath = this.basePath ? `${this.basePath}/` : '/';
    return `${protocol}//${host}${wsPath}`;
  }

  init() {
    // Event listeners
    this.messageForm.addEventListener('submit', (e) => this.handleSubmit(e));
    this.messageInput.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.messageInput.addEventListener('input', () => {
      this.saveCurrentDraft();
      this.autoResize();
    });
    this.attachButton.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', (e) => {
      this.addFiles(Array.from(e.target.files || []));
      this.fileInput.value = '';
    });
    this.messagesContainer.addEventListener('dragover', (e) => this.handleDragOver(e));
    this.messagesContainer.addEventListener('dragleave', () => this.messagesContainer.classList.remove('drag-over'));
    this.messagesContainer.addEventListener('drop', (e) => this.handleDrop(e));
    document.addEventListener('paste', (e) => this.handlePaste(e));
    this.newProjectButton.addEventListener('click', () => this.createProject());
    document.getElementById('current-user').textContent = this.user?.username || '';

    // Load initial conversations via HTTP (for history)
    this.loadProjectList();
    this.connectWebSocket();
  }

  async loadProjectList() {
    try {
      const response = await fetch(`${this.basePath}/api/projects`);
      const projects = await response.json();
      if (projects.length === 0) {
        this.projects = [];
        this.currentProject = null;
        this.currentConversation = null;
        this.renderProjectList([]);
        this.messagesContainer.textContent = '';
        this.messageInput.disabled = true;
        this.sendButton.disabled = true;
        this.attachButton.disabled = true;
        this.showEmptyState();
        return;
      }
      this.projects = projects;
      this.messageInput.disabled = false;
      this.sendButton.disabled = false;
      this.attachButton.disabled = false;
      if (!this.currentProject) this.currentProject = projects[0];
      this.renderProjectList(projects);
      await this.loadConversationList();
    } catch (err) { console.error('Failed to load projects:', err); }
  }

  renderProjectList(projects) {
    this.projects = projects;
    this.projectList.textContent = '';
    projects.forEach((project) => {
      const group = document.createElement('section');
      const isActive = this.currentProject?.id === project.id;
      group.className = `project-group${isActive ? ' active' : ''}`;
      const row = document.createElement('div');
      row.className = 'project-row';
      const button = document.createElement('button');
      button.className = 'project-item';
      button.textContent = project.title;
      button.title = project.title;
      button.addEventListener('click', async () => {
        if (this.currentProject?.id === project.id) return;
        this.saveCurrentDraft();
        this.currentProject = project;
        this.currentConversation = null;
        this.renderProjectList(projects);
        await this.loadConversationList();
      });
      const add = document.createElement('button');
      add.className = 'project-action project-add'; add.textContent = '+'; add.title = `New conversation in ${project.title}`;
      add.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (this.currentProject?.id !== project.id) {
          this.saveCurrentDraft();
          this.currentProject = project;
          this.currentConversation = null;
          this.renderProjectList(projects);
        }
        await this.createConversation();
      });
      const edit = document.createElement('button');
      edit.className = 'project-action'; edit.textContent = '✎'; edit.title = 'Rename project';
      edit.addEventListener('click', (event) => { event.stopPropagation(); this.renameProject(project, projects); });
      const remove = document.createElement('button');
      remove.className = 'project-action delete'; remove.textContent = '×'; remove.title = `Delete ${project.title}`;
      remove.addEventListener('click', (event) => { event.stopPropagation(); this.deleteProject(project); });
      row.append(button, add, edit, remove);
      const conversations = document.createElement('div');
      conversations.className = 'project-conversation-list';
      conversations.dataset.projectId = project.id;
      group.append(row, conversations);
      this.projectList.appendChild(group);
    });
  }

  async createProject(defaultTitle = null) {
    const title = defaultTitle || window.prompt('Project name', 'New project');
    if (title === null) return;
    try {
      this.saveCurrentDraft();
      const response = await fetch(`${this.basePath}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
      const project = await response.json();
      if (!response.ok) throw new Error(project.error || 'Failed to create project');
      this.currentProject = project;
      await this.loadProjectList();
    } catch (err) { window.alert(err.message); }
  }

  async renameProject(project, projects) {
    const title = window.prompt('Project name', project.title);
    if (title === null) return;
    try {
      const response = await fetch(`${this.basePath}/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not rename project');
      if (this.currentProject?.id === project.id) this.currentProject = result;
      const updatedProjects = projects.map((item) => item.id === result.id ? { ...item, ...result } : item);
      this.renderProjectList(updatedProjects);
      if (this.currentProject?.id === result.id) {
        this.renderConversationList(await (await fetch(`${this.basePath}/api/conversation-list?project_id=${encodeURIComponent(result.id)}`)).json());
      }
    } catch (err) { window.alert(err.message); }
  }

  async deleteProject(project) {
    if (!window.confirm(`Delete project “${project.title}” and all of its conversations and files? This cannot be undone.`)) return;
    try {
      const response = await fetch(`${this.basePath}/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not delete project');
      this.clearProjectDrafts(project.id);
      if (this.currentProject?.id === project.id) {
        this.currentProject = null;
        this.currentConversation = null;
        this.lastMessageId = 0;
        this.clearThinkingIndicator();
        this.messagesContainer.textContent = '';
      }
      await this.loadProjectList();
    } catch (err) { window.alert(err.message); }
  }

  connectWebSocket() {
    const wsUrl = this.getWebSocketUrl();
    console.log('Connecting to WebSocket:', wsUrl);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        this.updateConnectionStatus(true);
        this.selectWebSocketConversation();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleWebSocketMessage(msg);
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.updateConnectionStatus(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        this.updateConnectionStatus(false);
      };
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      this.scheduleReconnect();
    }
  }

  async loadConversationList() {
    try {
      if (!this.currentProject) return;
      const response = await fetch(`${this.basePath}/api/conversation-list?project_id=${encodeURIComponent(this.currentProject.id)}`);
      let conversations = await response.json();
      if (conversations.length === 0) {
        await this.createConversation();
        return;
      }
      this.renderConversationList(conversations);
      await this.selectConversation(conversations[0]);
    } catch (err) { console.error('Failed to load conversations:', err); }
  }

  renderConversationList(conversations) {
    const list = this.projectList.querySelector(`.project-conversation-list[data-project-id="${this.currentProject?.id}"]`);
    if (!list) return;
    list.textContent = '';
    conversations.forEach((conversation) => {
      const row = document.createElement('div');
      row.className = `conversation-row${this.currentConversation?.id === conversation.id ? ' active' : ''}`;
      const button = document.createElement('button');
      button.className = 'conversation-item';
      button.textContent = conversation.title;
      button.title = conversation.title;
      button.addEventListener('click', () => this.selectConversation(conversation));
      const edit = document.createElement('button');
      edit.className = 'conversation-action'; edit.textContent = '✎'; edit.title = 'Rename conversation';
      edit.addEventListener('click', (event) => { event.stopPropagation(); this.renameConversation(conversation); });
      const remove = document.createElement('button');
      remove.className = 'conversation-action delete'; remove.textContent = '×'; remove.title = 'Delete conversation';
      remove.addEventListener('click', (event) => { event.stopPropagation(); this.deleteConversation(conversation); });
      row.append(button, edit, remove);
      list.appendChild(row);
    });
  }

  async createConversation() {
    try {
      const response = await fetch(`${this.basePath}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'New conversation', projectId: this.currentProject.id }) });
      const conversation = await response.json();
      if (!response.ok) throw new Error(conversation.error || 'Failed to create conversation');
      const listResponse = await fetch(`${this.basePath}/api/conversation-list?project_id=${encodeURIComponent(this.currentProject.id)}`);
      const conversations = await listResponse.json();
      this.renderConversationList(conversations);
      await this.selectConversation(conversation);
    } catch (err) { console.error(err); }
  }

  async selectConversation(conversation) {
    if (this.currentConversation?.id === conversation.id) return;
    this.saveCurrentDraft();
    this.currentConversation = conversation;
    this.lastMessageId = 0;
    this.hideThinkingIndicator();
    this.messagesContainer.textContent = '';
    this.renderConversationList(await (await fetch(`${this.basePath}/api/conversation-list?project_id=${encodeURIComponent(this.currentProject.id)}`)).json());
    this.selectWebSocketConversation();
    this.restoreCurrentDraft();
    await this.loadConversations();
  }

  async renameConversation(conversation) {
    const title = window.prompt('Conversation name', conversation.title);
    if (title === null) return;
    try {
      const response = await fetch(`${this.basePath}/api/conversations/${encodeURIComponent(conversation.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, projectId: this.currentProject.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not rename conversation');
      if (this.currentConversation?.id === conversation.id) this.currentConversation = result;
      this.renderConversationList(await (await fetch(`${this.basePath}/api/conversation-list?project_id=${encodeURIComponent(this.currentProject.id)}`)).json());
    } catch (err) { window.alert(err.message); }
  }

  async deleteConversation(conversation) {
    if (!window.confirm(`Delete “${conversation.title}” from your workspace? Its messages are retained in the system audit log.`)) return;
    try {
      const response = await fetch(`${this.basePath}/api/conversations/${encodeURIComponent(conversation.id)}?project_id=${encodeURIComponent(this.currentProject.id)}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not delete conversation');
      this.clearConversationDraft(this.currentProject?.id, conversation.id);
      const listResponse = await fetch(`${this.basePath}/api/conversation-list?project_id=${encodeURIComponent(this.currentProject.id)}`);
      const conversations = await listResponse.json();
      this.currentConversation = null;
      this.lastMessageId = 0;
      this.messagesContainer.textContent = '';
      if (conversations.length === 0) await this.createConversation();
      else { this.renderConversationList(conversations); await this.selectConversation(conversations[0]); }
    } catch (err) { window.alert(err.message); }
  }

  selectWebSocketConversation() {
    if (this.ws?.readyState === WebSocket.OPEN && this.currentConversation) this.ws.send(JSON.stringify({ type: 'select_conversation', projectId: this.currentProject.id, conversationId: this.currentConversation.id }));
  }

  scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
      console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connectWebSocket(), delay);
    } else {
      console.error('Max reconnect attempts reached, falling back to polling');
      this.startPolling();
    }
  }

  startPolling() {
    // Fallback to HTTP polling if WebSocket fails
    this.pollInterval = setInterval(() => this.pollMessages(), 2000);
    this.statusInterval = setInterval(() => this.updateStatusViaHttp(), 5000);
  }

  handleWebSocketMessage(msg) {
    switch (msg.type) {
      case 'status':
        this.updateStatusDisplay(msg.data);
        break;

      case 'messages':
        if (Array.isArray(msg.data)) {
          this.clearEmptyState();
          msg.data.forEach((m) => this.addMessage(m, true));
          if (msg.data.length > 0) {
            this.lastMessageId = Math.max(...msg.data.map((m) => m.id));
          }
        }
        break;

      case 'sent':
        // Message send confirmation
        if (msg.success) {
          // Message was sent successfully, it will appear via 'messages' event
        } else {
          console.error('Failed to send message:', msg.error);
          // Mark the specific message as error if tempId is provided
          if (msg.tempId) {
            const pending = this.pendingMessages.get(msg.tempId);
            this.markMessageError(msg.tempId, pending?.message, pending?.projectId, pending?.conversationId);
          }
        }
        break;
    }
  }

  updateConnectionStatus(connected) {
    if (!connected) {
      this.statusDot.className = 'status-dot offline';
      this.statusText.textContent = 'Disconnected';
    }
  }

  updateStatusDisplay(status) {
    this.statusDot.className = 'status-dot';
    this.agentState = status.state || 'unknown';
    const { model, reasoningEffort } = status.modelInfo || {};
    if (this.modelInfoValue) {
      this.modelInfoValue.textContent = model ? `${model} · ${reasoningEffort || 'Default'}` : 'Unavailable';
    }

    switch (status.state) {
      case 'busy':
        this.statusDot.classList.add('busy');
        this.statusText.textContent = 'Claude is busy';
        break;
      case 'idle':
        this.statusDot.classList.add('online');
        this.statusText.textContent = 'Claude is ready';
        break;
      case 'offline':
      case 'stopped':
        this.statusDot.classList.add('offline');
        this.statusText.textContent = 'Claude is offline';
        break;
      default:
        this.statusText.textContent = 'Unknown status';
    }
  }

  async loadConversations() {
    if (!this.currentConversation) return;
    try {
      const response = await fetch(`${this.basePath}/api/conversations?project_id=${encodeURIComponent(this.currentProject.id)}&conversation_id=${encodeURIComponent(this.currentConversation.id)}&limit=100`);
      const conversations = await response.json();

      if (conversations.length === 0) {
        this.showEmptyState();
        return;
      }

      this.clearEmptyState();
      conversations.forEach((msg) => this.addMessage(msg, false));

      if (conversations.length > 0) {
        this.lastMessageId = Math.max(...conversations.map((m) => m.id));
      }

      this.restoreThinkingIndicator(conversations);

      this.scrollToBottom();
    } catch (err) {
      console.error('Failed to load conversations:', err);
    }
  }

  // HTTP fallback methods
  async pollMessages() {
    if (!this.currentConversation) return;
    try {
      const response = await fetch(`${this.basePath}/api/poll?project_id=${encodeURIComponent(this.currentProject.id)}&conversation_id=${encodeURIComponent(this.currentConversation.id)}&since_id=${this.lastMessageId}`);
      const messages = await response.json();

      if (messages.length > 0) {
        this.clearEmptyState();
        messages.forEach((msg) => this.addMessage(msg, true));
        this.lastMessageId = Math.max(...messages.map((m) => m.id));
      }
    } catch (err) {
      console.error('Failed to poll messages:', err);
    }
  }

  async updateStatusViaHttp() {
    try {
      const response = await fetch(`${this.basePath}/api/status`);
      const status = await response.json();
      this.updateStatusDisplay(status);
    } catch (err) {
      this.statusDot.className = 'status-dot offline';
      this.statusText.textContent = 'Connection error';
    }
  }

  async handleSubmit(e) {
    e.preventDefault();

    const message = this.messageInput.value.trim();
    const readyAttachments = this.pendingAttachments.filter((item) => item.status === 'ready');
    const uploading = this.pendingAttachments.some((item) => item.status === 'uploading');
    if (!this.currentProject || !this.currentConversation) return;
    if (!message && readyAttachments.length === 0) return;
    if (uploading) return;

    const projectId = this.currentProject.id;
    const conversationId = this.currentConversation.id;

    // A submitted message is no longer a draft. It is restored if sending fails.
    this.clearConversationDraft(projectId, conversationId);

    // Disable input while sending
    this.sendButton.disabled = true;
    this.attachButton.disabled = true;
    this.messageInput.value = '';
    this.autoResize();

    // Add temporary message
    const tempId = `temp-${Date.now()}`;
    const tempAttachments = readyAttachments.map((item) => ({
      kind: item.kind,
      name: item.name,
      size_label: this.formatBytes(item.size),
      url: item.previewUrl || null
    }));
    this.addTempMessage(message, tempId, tempAttachments);
    this.pendingMessages.set(tempId, { message, projectId, conversationId });
    this.showThinkingIndicator();
    this.pendingAttachments = this.pendingAttachments.filter((item) => item.status !== 'ready');
    this.updateAttachmentTray();
    const attachmentIds = readyAttachments.map((item) => item.id);

    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Send via WebSocket
        // Note: Don't mark as sent immediately - wait for server confirmation
        // or for message to appear via polling
        const payload = { type: 'send', content: message, tempId, projectId, conversationId };
        if (attachmentIds.length > 0) payload.attachments = attachmentIds;
        this.ws.send(JSON.stringify(payload));
      } else {
        // Fallback to HTTP
        const body = { message, projectId, conversationId };
        if (attachmentIds.length > 0) body.attachments = attachmentIds;
        const response = await fetch(`${this.basePath}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const result = await response.json();

        if (result.success) {
          this.markMessageSent(tempId);
        } else {
          console.error('Failed to send:', result.error);
          this.markMessageError(tempId, message, projectId, conversationId);
        }
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      this.markMessageError(tempId, message, projectId, conversationId);
    } finally {
      this.sendButton.disabled = false;
      this.attachButton.disabled = false;
      this.messageInput.focus();
    }
  }

  handleDragOver(e) {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    this.messagesContainer.classList.add('drag-over');
  }

  handleDrop(e) {
    if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    this.messagesContainer.classList.remove('drag-over');
    this.addFiles(Array.from(e.dataTransfer.files));
  }

  handlePaste(e) {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length === 0) return;
    e.preventDefault();
    this.addFiles(files);
  }

  addFiles(files) {
    const slots = this.maxAttachments - this.pendingAttachments.length;
    files.slice(0, Math.max(0, slots)).forEach((file) => this.queueUpload(file));
  }

  queueUpload(file) {
    const localId = `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const item = {
      localId,
      file,
      name: file.name || 'attachment',
      size: file.size,
      kind: file.type.startsWith('image/') ? 'image' : 'file',
      status: 'uploading',
      progress: 0,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    };
    this.pendingAttachments.push(item);
    this.updateAttachmentTray();
    this.uploadAttachment(item);
  }

  uploadAttachment(item) {
    const form = new FormData();
    form.append('file', item.file, item.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${this.basePath}/api/upload`);
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      item.progress = Math.round((event.loaded / event.total) * 100);
      this.updateAttachmentTray();
    });
    xhr.addEventListener('load', () => {
      let result = {};
      try {
        result = JSON.parse(xhr.responseText || '{}');
      } catch {
        // Keep generic error below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && result.id) {
        item.status = 'ready';
        item.progress = 100;
        item.id = result.id;
        item.name = result.name || item.name;
        item.kind = result.kind || item.kind;
        item.size = result.size ?? item.size;
      } else {
        item.status = 'error';
        item.error = result.message || result.error || 'Upload failed';
      }
      this.updateAttachmentTray();
    });
    xhr.addEventListener('error', () => {
      item.status = 'error';
      item.error = 'Upload failed';
      this.updateAttachmentTray();
    });
    xhr.send(form);
  }

  removeAttachment(localId) {
    const item = this.pendingAttachments.find((candidate) => candidate.localId === localId);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    this.pendingAttachments = this.pendingAttachments.filter((candidate) => candidate.localId !== localId);
    this.updateAttachmentTray();
  }

  updateAttachmentTray() {
    this.attachmentTray.textContent = '';
    if (this.pendingAttachments.length === 0) {
      this.attachmentTray.hidden = true;
      return;
    }
    this.attachmentTray.hidden = false;

    this.pendingAttachments.forEach((item) => {
      const chip = document.createElement('div');
      chip.className = `attachment-preview ${item.status}`;
      if (item.previewUrl) {
        const img = document.createElement('img');
        img.src = item.previewUrl;
        img.alt = '';
        chip.appendChild(img);
      }

      const details = document.createElement('div');
      details.className = 'attachment-details';
      const name = document.createElement('span');
      name.className = 'attachment-name';
      name.textContent = item.name;
      const status = document.createElement('span');
      status.className = 'attachment-status';
      status.textContent = item.status === 'uploading'
        ? `Uploading ${item.progress}%`
        : item.status === 'error' ? item.error : this.formatBytes(item.size);
      details.appendChild(name);
      details.appendChild(status);
      chip.appendChild(details);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.textContent = 'x';
      remove.setAttribute('aria-label', `Remove ${item.name}`);
      remove.addEventListener('click', () => this.removeAttachment(item.localId));
      chip.appendChild(remove);
      this.attachmentTray.appendChild(chip);
    });
  }

  handleKeydown(e) {
    // Send on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.messageForm.dispatchEvent(new Event('submit'));
    }
  }

  autoResize() {
    this.messageInput.style.height = 'auto';
    this.messageInput.style.height =
      Math.min(this.messageInput.scrollHeight, 150) + 'px';
  }

  addMessage(msg, scroll = true) {
    this.clearEmptyState();

    // A response from Zylos completes the visible waiting state.
    if (msg.direction !== 'in') this.clearThinkingIndicator(this.currentConversation?.id);

    // Check if message already exists (by id)
    if (this.messagesContainer.querySelector(`[data-id="${msg.id}"]`)) {
      return; // Skip duplicate
    }

    // For incoming user messages, remove matching temp message
    if (msg.direction === 'in') {
      const tempMessages = this.messagesContainer.querySelectorAll('[data-temp-id]');
      for (const temp of tempMessages) {
        if (temp.dataset.rawContent === msg.content) {
          temp.remove();
          break;
        }
      }
      if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
        const temp = this.messagesContainer.querySelector('.message.user.sending[data-has-attachments="true"]');
        if (temp) temp.remove();
      }
    }

    const div = document.createElement('div');
    div.className = `message ${msg.direction === 'in' ? 'user' : 'claude'}`;
    div.dataset.id = msg.id;

    const content = this.renderMessageContent(msg);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = this.formatTime(msg.timestamp);

    div.appendChild(content);
    div.appendChild(meta);
    this.messagesContainer.appendChild(div);

    // The server echoes the user's message after the temporary message is
    // replaced. Keep the waiting marker beneath that confirmed message.
    if (msg.direction === 'in' && this.awaitingResponses.has(this.currentConversation?.id)) {
      const indicator = this.messagesContainer.querySelector('.thinking-indicator');
      if (indicator) this.messagesContainer.appendChild(indicator);
    }

    if (scroll) {
      this.scrollToBottom();
    }
  }

  addTempMessage(content, tempId, attachments = []) {
    this.clearEmptyState();

    const div = document.createElement('div');
    div.className = 'message user sending';
    div.dataset.tempId = tempId;
    div.dataset.rawContent = content;
    div.dataset.hasAttachments = attachments.length > 0 ? 'true' : 'false';

    const contentDiv = this.renderMessageContent({
      direction: 'in',
      content,
      attachments
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'Sending...';

    div.appendChild(contentDiv);
    div.appendChild(meta);
    this.messagesContainer.appendChild(div);

    this.scrollToBottom();
  }

  markMessageSent(tempId) {
    const msg = this.messagesContainer.querySelector(
      `[data-temp-id="${tempId}"]`
    );
    if (msg) {
      msg.classList.remove('sending');
      const meta = msg.querySelector('.meta');
      if (meta) meta.textContent = this.formatTime(new Date().toISOString());
    }
    this.pendingMessages.delete(tempId);
  }

  markMessageError(tempId, draftContent = '', projectId = this.currentProject?.id, conversationId = this.currentConversation?.id) {
    const msg = this.messagesContainer.querySelector(
      `[data-temp-id="${tempId}"]`
    );
    if (msg) {
      msg.classList.remove('sending');
      msg.classList.add('error');
      const meta = msg.querySelector('.meta');
      if (meta) meta.textContent = 'Failed to send';
    }
    this.pendingMessages.delete(tempId);
    this.clearThinkingIndicator(this.currentConversation?.id);
    if (draftContent) {
      const id = this.draftId(projectId, conversationId);
      const drafts = this.readDrafts();
      if (id) drafts[id] = draftContent;
      this.writeDrafts(drafts);
      if (this.currentProject?.id === projectId && this.currentConversation?.id === conversationId && !this.messageInput.value) {
        this.restoreCurrentDraft();
      }
    }
  }

  showThinkingIndicator(conversationId = this.currentConversation?.id) {
    if (!conversationId) return;
    this.awaitingResponses.add(conversationId);
    this.persistAwaitingResponses();
    if (conversationId !== this.currentConversation?.id) return;
    let indicator = this.messagesContainer.querySelector('.thinking-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'thinking-indicator';
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-live', 'polite');

      const label = document.createElement('span');
      label.textContent = 'Zylos is thinking';
      const dots = document.createElement('span');
      dots.className = 'thinking-dots';
      dots.setAttribute('aria-hidden', 'true');
      dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
      indicator.append(label, dots);
      this.messagesContainer.appendChild(indicator);
    }
    this.scrollToBottom();
  }

  hideThinkingIndicator() {
    this.messagesContainer.querySelector('.thinking-indicator')?.remove();
  }

  clearThinkingIndicator(conversationId = this.currentConversation?.id) {
    if (conversationId) this.awaitingResponses.delete(conversationId);
    else this.awaitingResponses.clear();
    this.persistAwaitingResponses();
    if (!this.awaitingResponses.has(this.currentConversation?.id)) this.hideThinkingIndicator();
  }

  restoreThinkingIndicator(messages = []) {
    const conversationId = this.currentConversation?.id;
    if (!conversationId) return;
    const latest = messages.at(-1);
    if (this.awaitingResponses.has(conversationId) || (this.agentState === 'busy' && latest?.direction === 'in')) {
      this.showThinkingIndicator(conversationId);
    } else {
      this.hideThinkingIndicator();
    }
  }

  showEmptyState() {
    if (this.messagesContainer.querySelector('.empty-state')) return;

    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="empty-avatar"><img src="logo.png" alt="Zylos"></div>
      <h2>Welcome to Zylos</h2>
      <p>Start a conversation</p>
    `;
    this.messagesContainer.appendChild(empty);
  }

  clearEmptyState() {
    const empty = this.messagesContainer.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  scrollToBottom() {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  formatTime(timestamp) {
    const ts = timestamp.endsWith('Z') ? timestamp : timestamp + 'Z';
    const date = new Date(ts);
    const opts = { hour: '2-digit', minute: '2-digit' };
    if (this.timezone) opts.timeZone = this.timezone;
    return date.toLocaleTimeString([], opts);
  }

  resolveHref(href) {
    if (!href || !href.startsWith('/')) return href;
    return `${this.basePath}${href}`;
  }

  formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '?B';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  initMarkdown() {
    if (typeof window.markdownit === 'function') {
      this.md = window.markdownit({ html: false, linkify: true });
      const defaultRender = this.md.renderer.rules.link_open || function (tokens, idx, options, _env, self) {
        return self.renderToken(tokens, idx, options);
      };
      this.md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
        tokens[idx].attrSet('target', '_blank');
        tokens[idx].attrSet('rel', 'noopener noreferrer');
        return defaultRender(tokens, idx, options, env, self);
      };
    }
  }

  renderMarkdown(container, text) {
    if (this.md) {
      container.innerHTML = this.md.render(text);
      for (const li of container.querySelectorAll('li')) {
        const children = li.children;
        if (children.length === 1 && children[0].tagName === 'P') {
          li.innerHTML = children[0].innerHTML;
        }
      }
    } else {
      container.textContent = text;
    }
  }

  renderMessageContent(msg) {
    const content = document.createElement('div');
    content.className = 'content';

    if (msg.kind === 'media') {
      content.appendChild(this.renderMediaMessage(msg));
      return content;
    }

    if (msg.content) {
      const text = document.createElement('div');
      text.className = 'markdown-body';
      this.renderMarkdown(text, msg.content);
      content.appendChild(text);
    }

    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      const list = document.createElement('div');
      list.className = 'message-attachments';
      msg.attachments.forEach((attachment) => {
        const resolved = attachment.href ? { ...attachment, href: this.resolveHref(attachment.href) } : attachment;
        if (resolved.kind === 'image' && resolved.href) {
          const link = document.createElement('a');
          link.href = resolved.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'media-image-link';
          const img = document.createElement('img');
          img.src = resolved.href;
          img.alt = resolved.name || 'Image';
          img.className = 'media-image';
          img.addEventListener('error', () => {
            link.replaceWith(this.renderAttachmentChip(resolved));
          }, { once: true });
          link.appendChild(img);
          list.appendChild(link);
        } else {
          list.appendChild(this.renderAttachmentChip(resolved));
        }
      });
      content.appendChild(list);
    }

    return content;
  }

  renderMediaMessage(msg) {
    const href = `${this.basePath}/api/media/${msg.message_id}?conversation_id=${encodeURIComponent(this.currentConversation?.id || '')}`;
    if (msg.media_type === 'image') {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'media-image-link';
      const img = document.createElement('img');
      img.src = href;
      img.alt = msg.name || 'Image';
      img.className = 'media-image';
      link.appendChild(img);
      return link;
    }
    return this.renderAttachmentChip({
      kind: 'file',
      name: msg.name || 'download',
      size_label: Number.isFinite(msg.size) ? this.formatBytes(msg.size) : '',
      href
    });
  }

  renderAttachmentChip(attachment) {
    const wrapper = attachment.href ? document.createElement('a') : document.createElement('div');
    wrapper.className = `message-attachment ${attachment.kind === 'image' ? 'image' : 'file'}`;
    if (attachment.href) {
      wrapper.href = attachment.href;
      wrapper.target = '_blank';
      wrapper.rel = 'noopener noreferrer';
    }
    const icon = document.createElement('span');
    icon.className = 'attachment-icon';
    icon.textContent = attachment.kind === 'image' ? 'IMG' : 'FILE';
    const label = document.createElement('span');
    label.className = 'attachment-label';
    label.textContent = attachment.name || 'attachment';
    const size = document.createElement('span');
    size.className = 'attachment-size';
    size.textContent = attachment.size_label || '';
    wrapper.appendChild(icon);
    wrapper.appendChild(label);
    if (size.textContent) wrapper.appendChild(size);
    if (attachment.href) {
      const dl = document.createElement('span');
      dl.className = 'attachment-download';
      dl.textContent = '⬇';
      wrapper.appendChild(dl);
    }
    return wrapper;
  }
}

function showLogoutButton(basePath, user) {
  const btn = document.getElementById('logout-btn');
  if (!btn) return;
  btn.style.display = '';
  btn.addEventListener('click', async () => {
    await fetch(`${basePath}/api/logout`, { method: 'POST' });
    window.location.reload();
  });
}

const usageEventLabels = {
  login_success: 'Signed in',
  project_created: 'Created a project',
  project_deleted: 'Deleted a project',
  conversation_created: 'Created a conversation',
  conversation_deleted: 'Deleted a conversation',
  message_sent: 'Sent a message',
  attachment_uploaded: 'Uploaded an attachment'
};

function formatUsageTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function formatUsageBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function appendUsageEvents(container, events, includeUser = false) {
  container.textContent = '';
  if (!events?.length) {
    const empty = document.createElement('p'); empty.className = 'usage-empty'; empty.textContent = 'No activity recorded yet.'; container.appendChild(empty);
    return;
  }
  events.forEach((event) => {
    const row = document.createElement('div'); row.className = 'usage-event';
    const label = document.createElement('span'); label.className = 'usage-event-label';
    label.textContent = `${includeUser ? `${event.username} · ` : ''}${usageEventLabels[event.event_type] || event.event_type}`;
    const meta = document.createElement('span'); meta.className = 'usage-event-meta';
    const suffix = event.event_type === 'attachment_uploaded' ? ` · ${formatUsageBytes(event.details?.bytes)}`
      : event.event_type === 'message_sent' ? ` · ${event.details?.attachments || 0} attachment(s)` : '';
    meta.textContent = `${formatUsageTime(event.created_at)}${suffix}`;
    row.append(label, meta); container.appendChild(row);
  });
}

function setupUsageMonitoring(basePath, user) {
  if (!user) return;
  const button = document.getElementById('usage-btn');
  const modal = document.getElementById('usage-modal');
  const summary = document.getElementById('usage-summary');
  const events = document.getElementById('usage-events');
  if (!button || !modal || !summary || !events) return;
  button.style.display = '';
  const loadUsage = async () => {
    const response = await fetch(`${basePath}/api/usage/me`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load usage');
    summary.textContent = '';
    [
      ['Projects', data.summary.projects],
      ['Conversations', data.summary.conversations],
      ['Messages sent', data.summary.messages_sent],
      ['Attachments', data.summary.attachments_uploaded],
      ['Uploaded', formatUsageBytes(data.summary.uploaded_bytes)]
    ].forEach(([label, value]) => {
      const card = document.createElement('div'); card.className = 'usage-card';
      const number = document.createElement('span'); number.className = 'usage-value'; number.textContent = value;
      const caption = document.createElement('span'); caption.className = 'usage-label'; caption.textContent = label;
      card.append(number, caption); summary.appendChild(card);
    });
    appendUsageEvents(events, data.events);
  };
  button.addEventListener('click', async () => {
    modal.hidden = false;
    try { await loadUsage(); } catch (err) { summary.textContent = ''; appendUsageEvents(events, []); events.firstChild.textContent = err.message; }
  });
  document.getElementById('close-usage-modal').addEventListener('click', () => { modal.hidden = true; });
}

function setupSkillsGuide(basePath, user) {
  if (!user) return;
  const button = document.getElementById('guide-btn');
  const modal = document.getElementById('guide-modal');
  const list = document.getElementById('guide-list');
  if (!button || !modal || !list) return;
  button.style.display = '';
  const loadGuide = async () => {
    const response = await fetch(`${basePath}/api/capabilities`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load skills');
    list.textContent = '';
    data.capabilities.forEach((capability) => {
      const card = document.createElement('article'); card.className = 'guide-card';
      const header = document.createElement('div'); header.className = 'guide-card-header';
      const title = document.createElement('h3'); title.textContent = capability.title;
      const category = document.createElement('span'); category.className = 'guide-category';
      category.textContent = capability.connectionRequired ? `${capability.category} · connect first` : capability.category;
      header.append(title, category);
      const description = document.createElement('p'); description.textContent = capability.description;
      const how = document.createElement('p'); how.className = 'guide-how';
      const prefix = document.createElement('strong'); prefix.textContent = 'How to use: ';
      how.append(prefix, document.createTextNode(capability.how));
      card.append(header, description, how); list.appendChild(card);
    });
  };
  button.addEventListener('click', async () => {
    modal.hidden = false;
    try { await loadGuide(); } catch (err) { list.textContent = ''; const message = document.createElement('p'); message.className = 'usage-empty'; message.textContent = err.message; list.appendChild(message); }
  });
  document.getElementById('close-guide-modal').addEventListener('click', () => { modal.hidden = true; });
}

function setupUsageAudit(basePath, user) {
  if (user?.role !== 'admin') return;
  const button = document.getElementById('audit-btn');
  const modal = document.getElementById('audit-modal');
  const filter = document.getElementById('audit-user-filter');
  const summary = document.getElementById('audit-user-summary');
  const events = document.getElementById('audit-events');
  button.style.display = '';
  const loadAudit = async () => {
    const query = filter.value ? `?user_id=${encodeURIComponent(filter.value)}` : '';
    const response = await fetch(`${basePath}/api/admin/usage${query}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load audit');
    const selected = filter.value;
    filter.textContent = '';
    const all = document.createElement('option'); all.value = ''; all.textContent = 'All users'; filter.appendChild(all);
    data.users.forEach((account) => {
      const option = document.createElement('option'); option.value = account.id; option.textContent = account.username; filter.appendChild(option);
    });
    filter.value = selected;
    summary.textContent = '';
    const table = document.createElement('table');
    const head = document.createElement('thead'); const headerRow = document.createElement('tr');
    ['User', 'Role', 'Projects', 'Conversations', 'Messages', 'Attachments', 'Last active'].forEach((title) => { const cell = document.createElement('th'); cell.textContent = title; headerRow.appendChild(cell); });
    head.appendChild(headerRow); table.appendChild(head);
    const body = document.createElement('tbody');
    data.users.forEach((account) => {
      const row = document.createElement('tr');
      [account.username, account.role, account.projects, account.conversations, account.messages_sent, account.attachments_uploaded, formatUsageTime(account.last_active_at)].forEach((value) => { const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell); });
      body.appendChild(row);
    });
    table.appendChild(body); summary.appendChild(table);
    appendUsageEvents(events, data.events, true);
  };
  button.addEventListener('click', async () => { modal.hidden = false; try { await loadAudit(); } catch (err) { summary.textContent = err.message; } });
  filter.addEventListener('change', () => loadAudit().catch((err) => { summary.textContent = err.message; }));
  document.getElementById('close-audit-modal').addEventListener('click', () => { modal.hidden = true; });
}

function setupAccountManagement(basePath, user) {
  if (user?.role !== 'admin') return;
  const button = document.getElementById('account-btn');
  const modal = document.getElementById('account-modal');
  const error = document.getElementById('account-error');
  const list = document.getElementById('user-list');
  button.style.display = '';
  const loadUsers = async () => {
    const response = await fetch(`${basePath}/api/users`);
    const users = await response.json();
    list.textContent = '';
    users.forEach((account) => {
      const row = document.createElement('div'); row.className = 'user-row';
      const label = document.createElement('div'); label.textContent = account.username;
      const role = document.createElement('span'); role.textContent = account.role;
      label.appendChild(document.createTextNode(' ')); label.appendChild(role); row.appendChild(label);
      if (account.role !== 'admin') { const remove = document.createElement('button'); remove.textContent = 'Disable'; remove.addEventListener('click', async () => { if (!window.confirm(`Disable ${account.username}?`)) return; const response = await fetch(`${basePath}/api/users/${encodeURIComponent(account.id)}`, { method: 'DELETE' }); if (!response.ok) error.textContent = (await response.json()).error || 'Could not disable account'; else loadUsers(); }); row.appendChild(remove); }
      list.appendChild(row);
    });
  };
  button.addEventListener('click', async () => { error.textContent = ''; modal.hidden = false; await loadUsers(); });
  document.getElementById('close-account-modal').addEventListener('click', () => { modal.hidden = true; });
  document.getElementById('create-user-form').addEventListener('submit', async (event) => {
    event.preventDefault(); error.textContent = '';
    const response = await fetch(`${basePath}/api/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('new-username').value, password: document.getElementById('new-password').value, role: document.getElementById('new-role').value }) });
    const result = await response.json();
    if (!response.ok) { error.textContent = result.error || 'Could not create account'; return; }
    event.target.reset(); await loadUsers();
  });
}

/**
 * Auth guard - check if login is required before showing chat
 */
async function checkAuth() {
  const loginScreen = document.getElementById('login-screen');
  const chatScreen = document.getElementById('chat-screen');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const basePath = window.location.pathname.startsWith('/console') ? '/console' : '';

  try {
    const res = await fetch(`${basePath}/api/auth`);
    const auth = await res.json();

    if (!auth.required || auth.authenticated) {
      // No password set, or already authenticated
      chatScreen.style.display = '';
      showLogoutButton(basePath, auth.user);
      setupSkillsGuide(basePath, auth.user);
      setupUsageMonitoring(basePath, auth.user);
      setupUsageAudit(basePath, auth.user);
      setupAccountManagement(basePath, auth.user);
      new ZylosConsole(auth.timezone, auth.user);
      return;
    }

    // Show login screen
    loginScreen.style.display = '';
    chatScreen.style.display = 'none';

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      loginError.textContent = '';
      const username = document.getElementById('login-username').value;
      const password = document.getElementById('login-password').value;
      const remember = document.getElementById('login-remember')?.checked ?? true;

      const loginRes = await fetch(`${basePath}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember }),
      });
      const result = await loginRes.json();

      if (result.success) {
        loginScreen.style.display = 'none';
        chatScreen.style.display = '';
        showLogoutButton(basePath, result.user);
        setupSkillsGuide(basePath, result.user);
        setupUsageMonitoring(basePath, result.user);
        setupUsageAudit(basePath, result.user);
        setupAccountManagement(basePath, result.user);
        new ZylosConsole(result.timezone, result.user);
      } else {
        loginError.textContent = result.error || 'Login failed';
      }
    });
  } catch (err) {
    // Can't reach server, just show chat (will show connection error)
    chatScreen.style.display = '';
    new ZylosConsole();
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', checkAuth);
