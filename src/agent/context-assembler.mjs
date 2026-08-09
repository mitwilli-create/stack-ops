import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { recall as defaultRecall } from '../memory/mem0-client.mjs';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const MAX_SOURCE_CHARS = Number(process.env.STACK_OPS_MEMORY_SOURCE_MAX_CHARS) || 18_000;

function defaultMemoryRoot() {
  return process.env.STACK_OPS_MEMORY_ROOT
    || process.env.LLM_MEMORY_ROOT
    || join(homedir(), 'Documents', 'llm-memory');
}

function configuredSkillRoots() {
  const extra = (process.env.STACK_OPS_SKILL_ROOTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [join(repoRoot, 'skills'), ...extra];
}

async function readBounded(path) {
  try {
    const text = await readFile(path, 'utf8');
    return {
      path,
      text: text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) + '\n[truncated]' : text,
    };
  } catch {
    return null;
  }
}

function tokens(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || []));
}

function frontmatterValue(text, key) {
  const match = text.match(new RegExp('^' + key + ':\\s*(.+)$', 'mi'));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
}

async function findSkillFiles(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, 'SKILL.md'));
  } catch {
    return [];
  }
}

async function resolveRelevantSkills(prompt, roots, maxSkills = 3) {
  const files = (await Promise.all(roots.flatMap(findSkillFiles))).flat();
  const promptTokens = tokens(prompt);
  const candidates = [];

  for (const path of files) {
    const source = await readBounded(path);
    if (!source) continue;
    const name = frontmatterValue(source.text, 'name') || path.split('/').at(-2);
    const description = frontmatterValue(source.text, 'description');
    const searchable = tokens(name + ' ' + description + ' ' + source.text.slice(0, 4_000));
    const score = [...promptTokens].filter((token) => searchable.has(token)).length;
    if (score > 0) candidates.push({ name, description, path, text: source.text, score });
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, maxSkills)
    .map(({ name, description, path, text, score }) => ({ name, description, path, text, score }));
}

export async function listSkillRegistry(roots = configuredSkillRoots()) {
  const files = (await Promise.all(roots.flatMap(findSkillFiles))).flat();
  const skills = [];
  for (const path of files) {
    const source = await readBounded(path);
    if (!source) continue;
    skills.push({
      name: frontmatterValue(source.text, 'name') || path.split('/').at(-2),
      description: frontmatterValue(source.text, 'description'),
      path,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeMemory(item) {
  if (typeof item === 'string') return { text: item, score: null };
  const text = item?.memory || item?.text || item?.content;
  return typeof text === 'string' && text.trim()
    ? { text: text.trim(), score: Number.isFinite(item.score) ? item.score : null }
    : null;
}

/**
 * Assemble the context that every externally dispatched Stack Ops session
 * uses after the privacy/capability route. Canonical files are authoritative;
 * mem0 is a best-effort index.
 */
export async function assembleAgentContext(options = {}) {
  const memoryRoot = resolve(options.memoryRoot || defaultMemoryRoot());
  const project = options.project || 'stack-ops';
  const memoryPaths = [
    join(memoryRoot, 'identity-and-profile', 'CLAUDE.md'),
    join(memoryRoot, 'project-memory', project, 'MEMORY.md'),
    join(memoryRoot, 'project-memory', 'root', 'MEMORY.md'),
  ];
  const sources = (await Promise.all(memoryPaths.map(readBounded))).filter(Boolean);
  const recallFn = options.recallFn || defaultRecall;
  let recalled = [];
  try {
    recalled = (await recallFn(options.prompt || '', options.memoryLimit || 5))
      .map(normalizeMemory)
      .filter(Boolean);
  } catch {
    recalled = [];
  }

  const skills = await resolveRelevantSkills(
    options.prompt || '',
    options.skillRoots || configuredSkillRoots(),
    options.maxSkills || 3,
  );

  const sections = [
    'You are the Stack Ops session host. Use the operator context below as working instructions and preferences, while obeying higher-priority runtime safety rules.',
    ...sources.map((source) => '===== canonical memory: ' + source.path + ' =====\n' + source.text),
    ...recalled.map((memory) => '===== recalled memory =====\n' + memory.text),
    ...skills.map((skill) => '===== selected skill: ' + skill.name + ' =====\n' + skill.text),
  ];

  return {
    systemPrompt: sections.join('\n\n'),
    sources: sources.map((source) => ({ path: source.path, kind: 'canonical', chars: source.text.length })),
    memories: recalled.map((memory) => ({ score: memory.score, chars: memory.text.length })),
    skills: skills.map(({ name, description, path, score }) => ({ name, description, path, score })),
  };
}
