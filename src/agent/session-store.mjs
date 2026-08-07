import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE_NAME = 'sessions.json';

function now() {
  return new Date().toISOString();
}

export class SessionStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.filePath = join(stateDir, FILE_NAME);
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8'));
      return Array.isArray(value) ? value : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async save(sessions) {
    await mkdir(this.stateDir, { recursive: true });
    const temporaryPath = this.filePath + '.' + process.pid + '.tmp';
    await writeFile(temporaryPath, JSON.stringify(sessions, null, 2) + '\n', 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  async createSession(title = 'New session') {
    const timestamp = now();
    const session = {
      id: randomUUID(),
      title: String(title || 'New session').trim() || 'New session',
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
    };
    const sessions = await this.load();
    sessions.push(session);
    await this.save(sessions);
    return session;
  }

  async getSession(id) {
    const session = (await this.load()).find((item) => item.id === id);
    if (!session) {
      const error = new Error('session not found: ' + id);
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    return session;
  }

  async appendMessage(id, message) {
    if (!['user', 'assistant', 'system'].includes(message?.role)) throw new Error('message role is invalid');
    if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('message content is empty');
    const sessions = await this.load();
    const session = sessions.find((item) => item.id === id);
    if (!session) {
      const error = new Error('session not found: ' + id);
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    session.messages.push({
      id: randomUUID(),
      role: message.role,
      content: message.content,
      createdAt: now(),
      metadata: message.metadata || null,
    });
    session.updatedAt = now();
    if (session.title === 'New session' && message.role === 'user') {
      session.title = message.content.replace(/\s+/g, ' ').trim().slice(0, 72) || 'New session';
    }
    await this.save(sessions);
    return session;
  }

  async listSessions() {
    return (await this.load())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, title, createdAt, updatedAt, messages }) => ({
        id, title, createdAt, updatedAt, messageCount: messages.length,
      }));
  }
}
