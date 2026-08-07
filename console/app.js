const state = { sessions: [], activeSession: null, status: null, busy: false };

const $ = (selector) => document.querySelector(selector);
const elements = {
  newSession: $('#new-session'),
  list: $('#conversation-list'),
  count: $('#session-count'),
  title: $('#session-title'),
  messages: $('#message-list'),
  empty: $('#empty-state'),
  form: $('#prompt-form'),
  input: $('#prompt-input'),
  send: $('#send-button'),
  route: $('#route-card'),
  memoryCount: $('#memory-count'),
  recalledCount: $('#recalled-count'),
  skillsCount: $('#selected-skills'),
  connectors: $('#connector-list'),
  memoryState: $('#memory-state'),
  connectorState: $('#connector-state'),
  skillState: $('#skill-state'),
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

function escapeText(value) {
  return String(value ?? '');
}

function renderSessions() {
  elements.count.textContent = state.sessions.length;
  elements.list.replaceChildren();
  if (!state.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'conversation-empty';
    empty.textContent = 'No sessions yet. Start one below.';
    elements.list.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const button = document.createElement('button');
    button.className = 'conversation-item' + (session.id === state.activeSession?.id ? ' is-active' : '');
    button.type = 'button';
    button.innerHTML = '<span class="conversation-title"></span><span class="conversation-meta"></span>';
    button.querySelector('.conversation-title').textContent = session.title;
    button.querySelector('.conversation-meta').textContent = session.messageCount + ' messages';
    button.addEventListener('click', () => openSession(session.id));
    elements.list.append(button);
  }
}

function metadataChip(text, accent = false) {
  const chip = document.createElement('span');
  chip.className = 'metadata-chip' + (accent ? ' accent' : '');
  chip.textContent = text;
  return chip;
}

function renderMessages() {
  elements.messages.replaceChildren();
  if (!state.activeSession?.messages?.length) {
    elements.messages.append(elements.empty);
    return;
  }
  for (const message of state.activeSession.messages) {
    const wrapper = document.createElement('article');
    wrapper.className = 'message ' + message.role;
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = message.role === 'user' ? 'You' : 'Stack Ops';
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = escapeText(message.content);
    if (message.metadata && message.role === 'assistant') {
      const meta = document.createElement('div');
      meta.className = 'message-metadata';
      if (message.metadata.lane) meta.append(metadataChip(message.metadata.lane, true));
      if (message.metadata.taskType) meta.append(metadataChip(message.metadata.taskType));
      if (message.metadata.target) meta.append(metadataChip(message.metadata.target));
      body.append(meta);
    }
    wrapper.append(label, body);
    elements.messages.append(wrapper);
  }
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderTrace(result = null) {
  const decision = result?.decision;
  if (!decision) {
    elements.route.innerHTML = '<span class="route-placeholder">No request yet</span>';
    elements.memoryCount.textContent = '0';
    elements.recalledCount.textContent = '0';
    elements.skillsCount.textContent = '0';
    return;
  }
  elements.route.innerHTML = '';
  const lane = document.createElement('div');
  lane.className = 'route-lane';
  lane.textContent = String(decision.lane || 'local').toUpperCase();
  const task = document.createElement('div');
  task.className = 'route-task';
  task.textContent = decision.taskType || 'local_clock';
  const target = document.createElement('div');
  target.className = 'route-target';
  target.textContent = result.target?.handle || decision.selected?.handle || 'system-clock';
  elements.route.append(lane, task, target);
  elements.memoryCount.textContent = result.context?.sources?.length || 0;
  elements.recalledCount.textContent = result.context?.memories?.length || 0;
  elements.skillsCount.textContent = result.context?.skills?.length || 0;
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  elements.memoryState.textContent = status.memory?.canonicalFiles ? 'CANONICAL MEMORY' : 'MEMORY OFF';
  elements.connectorState.textContent = (status.connectors?.length || 0) + ' CONNECTORS';
  elements.skillState.textContent = (status.skills?.length || 0) + ' SKILLS READY';
  elements.connectors.replaceChildren();
  for (const connector of status.connectors || []) {
    const row = document.createElement('div');
    row.className = 'connector-row';
    const name = document.createElement('span');
    name.textContent = connector.name;
    const transport = document.createElement('span');
    transport.textContent = connector.transport;
    row.append(name, transport);
    elements.connectors.append(row);
  }
  if (!status.connectors?.length) {
    const empty = document.createElement('span');
    empty.className = 'conversation-empty';
    empty.textContent = 'No MCP connectors registered.';
    elements.connectors.append(empty);
  }
}

async function loadSessions() {
  state.sessions = await request('/api/sessions');
  renderSessions();
}

async function openSession(id) {
  state.activeSession = await request('/api/sessions/' + encodeURIComponent(id));
  elements.title.textContent = state.activeSession.title;
  renderSessions();
  renderMessages();
}

async function newSession() {
  state.activeSession = await request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'New session' }),
  });
  elements.title.textContent = state.activeSession.title;
  renderTrace();
  await loadSessions();
  renderMessages();
  elements.input.focus();
}

function setBusy(busy) {
  state.busy = busy;
  elements.send.disabled = busy;
  elements.send.querySelector('span').textContent = busy ? 'Routing...' : 'Send';
  elements.input.disabled = busy;
}

async function sendPrompt(prompt) {
  const text = prompt.trim();
  if (!text || state.busy) return;
  setBusy(true);
  try {
    if (!state.activeSession) await newSession();
    const result = await request('/api/sessions/' + encodeURIComponent(state.activeSession.id) + '/messages', {
      method: 'POST',
      body: JSON.stringify({ prompt: text }),
    });
    state.activeSession = result.session;
    elements.title.textContent = state.activeSession.title;
    elements.input.value = '';
    renderTrace(result);
    renderMessages();
    await loadSessions();
  } catch (error) {
    const message = document.createElement('article');
    message.className = 'message assistant';
    message.innerHTML = '<div class="message-label">System</div><div class="message-body"></div>';
    message.querySelector('.message-body').textContent = error.message;
    elements.messages.append(message);
  } finally {
    setBusy(false);
    elements.input.focus();
  }
}

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendPrompt(elements.input.value);
});
elements.input.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    sendPrompt(elements.input.value);
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    sendPrompt(elements.input.value);
  }
});
elements.newSession.addEventListener('click', newSession);
document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => sendPrompt(button.dataset.prompt));
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    newSession();
  }
});

async function boot() {
  try {
    state.status = await request('/api/status');
    renderStatus();
    await loadSessions();
    if (state.sessions[0]) await openSession(state.sessions[0].id);
    else renderMessages();
  } catch (error) {
    elements.route.innerHTML = '<span class="route-placeholder"></span>';
    elements.route.querySelector('span').textContent = 'Console unavailable: ' + error.message;
  }
}

boot();
