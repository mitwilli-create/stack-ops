/**
 * request-router.mjs, the content-to-capability routing seam for Stack Ops.
 *
 * This module decides which execution lane a request belongs to. It does not
 * call a model. That keeps classification deterministic, testable, and safe
 * to expose through Raycast or MCP.
 *
 * The route table uses stable provider:model handles already supported by the
 * local Stack Ops executors. Handles are implementation identifiers, not prose
 * recommendations. The selected route is based on request signals and the
 * capability evidence named on that route.
 */
import { classifyAsync, classify, buildConfig, ROUTE as PRIVACY_ROUTE } from './privacy-gate.mjs';

export const LANE = Object.freeze({
  TOIL: 'toil',
  FRONTIER: 'frontier',
  LOCAL_ONLY: 'local-only',
});

export const TASK_TYPE = Object.freeze({
  TOIL: 'toil',
  TRIAGE: 'triage',
  DEEP_RESEARCH: 'deep_research_synthesis',
  WEB_RESEARCH: 'web_research',
  REALTIME_SOCIAL: 'realtime_social',
  LONG_CONTEXT: 'long_context_500k_plus',
  MULTIMODAL: 'multimodal_understanding',
  CODE_REFACTOR: 'code_refactor_multifile',
  STRATEGIC_REASONING: 'strategic_reasoning',
  FRONTIER_SYNTHESIS: 'frontier_synthesis',
});

const SOURCE = Object.freeze({
  TOIL: 'docs/specs/open-weight-routing-2026-07-22.md',
  FRONTIER: 'career-ops/lib/council.mjs TASK_ROUTING_MATRIX',
  CAPABILITIES: 'council-os/routing-rules.md',
});

const TARGET = (handle, role, capability, evidence, confidence = 'medium') => Object.freeze({
  handle,
  role,
  capability,
  evidence,
  confidence,
});

/**
 * Route definitions. The first target is tried first by the dispatcher. A
 * fallback is a separate capability-compatible target, not a second answer
 * fan-out. This keeps a Raycast ask to one paid call unless the first target
 * is unavailable.
 */
export const ROUTE_DEFINITIONS = Object.freeze({
  [TASK_TYPE.TOIL]: Object.freeze({
    lane: LANE.TOIL,
    executionTask: 'bulk_mechanical_edit',
    targets: Object.freeze([
      // These handles mirror the existing cheap.mjs mechanical-edit ladder.
      // The cheap executor owns its ZDR provider filter and rung fallback.
      TARGET('openrouter:qwen/qwen3-coder-30b-a3b-instruct', 'open-weight execution', 'bounded mechanical work', SOURCE.TOIL, 'high'),
      TARGET('openrouter:z-ai/glm-4.7-flash', 'open-weight execution', 'mechanical-edit fallback', SOURCE.TOIL, 'high'),
    ]),
  }),
  [TASK_TYPE.TRIAGE]: Object.freeze({
    lane: LANE.TOIL,
    executionTask: 'log_triage',
    targets: Object.freeze([
      TARGET('openrouter:gpt-oss-120b', 'open-weight execution', 'classification and extraction', SOURCE.TOIL, 'high'),
      TARGET('openrouter:deepseek-flash', 'open-weight execution', 'long-context triage', SOURCE.TOIL, 'high'),
    ]),
  }),
  [TASK_TYPE.DEEP_RESEARCH]: Object.freeze({
    lane: LANE.FRONTIER,
    targets: Object.freeze([
      TARGET('perplexity:sonar-deep-research', 'frontier research', 'multi-pass web research with citations', SOURCE.CAPABILITIES, 'medium'),
      TARGET('google:gemini-3.1-pro', 'frontier research', 'grounded synthesis fallback', SOURCE.FRONTIER, 'medium'),
    ]),
  }),
  [TASK_TYPE.WEB_RESEARCH]: Object.freeze({
    lane: LANE.FRONTIER,
    targets: Object.freeze([
      TARGET('perplexity:sonar-pro', 'frontier research', 'single-call web research with citations', SOURCE.CAPABILITIES, 'high'),
      TARGET('google:gemini-3.1-pro', 'frontier research', 'grounded synthesis fallback', SOURCE.FRONTIER, 'medium'),
    ]),
  }),
  [TASK_TYPE.REALTIME_SOCIAL]: Object.freeze({
    lane: LANE.FRONTIER,
    targets: Object.freeze([
      TARGET('xai:grok-4-x-search', 'frontier retrieval', 'first-party X retrieval', SOURCE.CAPABILITIES, 'high'),
      TARGET('perplexity:sonar-pro', 'frontier retrieval', 'web retrieval fallback', SOURCE.CAPABILITIES, 'medium'),
    ]),
  }),
  [TASK_TYPE.LONG_CONTEXT]: Object.freeze({
    lane: LANE.FRONTIER,
    targets: Object.freeze([
      TARGET('google:gemini-3.1-pro', 'frontier multimodal', 'long-context multimodal input', SOURCE.CAPABILITIES, 'high'),
      TARGET('openai:gpt-5.6-sol', 'frontier reasoning', 'long-form synthesis fallback', SOURCE.FRONTIER, 'medium'),
    ]),
  }),
  [TASK_TYPE.MULTIMODAL]: Object.freeze({
    lane: LANE.FRONTIER,
    targets: Object.freeze([
      TARGET('google:gemini-3.1-pro', 'frontier multimodal', 'native image, audio, and video input', SOURCE.CAPABILITIES, 'high'),
      TARGET('openai:gpt-5.6-sol', 'frontier reasoning', 'text synthesis fallback', SOURCE.FRONTIER, 'medium'),
    ]),
  }),
  [TASK_TYPE.CODE_REFACTOR]: Object.freeze({
    lane: LANE.FRONTIER,
    targets: Object.freeze([
      TARGET('openai:gpt-5-5-pro', 'frontier coding', 'long-horizon multi-file coding', SOURCE.FRONTIER, 'medium'),
      TARGET('openai:gpt-5.6-sol', 'frontier coding', 'non-Anthropic coding fallback', SOURCE.FRONTIER, 'medium'),
    ]),
  }),
  [TASK_TYPE.STRATEGIC_REASONING]: Object.freeze({
    lane: LANE.FRONTIER,
    targets: Object.freeze([
      TARGET('openai:gpt-5-5-pro', 'frontier reasoning', 'strategic and trade-off analysis', SOURCE.FRONTIER, 'medium'),
      TARGET('google:gemini-3.1-pro', 'frontier reasoning', 'grounded reasoning fallback', SOURCE.CAPABILITIES, 'medium'),
    ]),
  }),
  [TASK_TYPE.FRONTIER_SYNTHESIS]: Object.freeze({
    lane: LANE.FRONTIER,
    targets: Object.freeze([
      TARGET('openai:gpt-5.6-sol', 'frontier reasoning', 'general high-judgment synthesis', SOURCE.FRONTIER, 'medium'),
      TARGET('google:gemini-3.1-pro', 'frontier reasoning', 'grounded synthesis fallback', SOURCE.CAPABILITIES, 'medium'),
    ]),
  }),
});

const EXPLICIT_TASK_TYPES = new Set(Object.values(TASK_TYPE));
const MEDIA_TYPES = new Set(['image', 'photo', 'screenshot', 'pdf', 'audio', 'video', 'multimodal']);

const RESEARCH_RE = /\b(?:research|investigate|look\s*up|sources?|citations?|verify|compare|current|latest|today|recent|freshness|what(?:'s| is) changed)\b/i;
const DEEP_RESEARCH_RE = /\b(?:deep|exhaustive|multi[- ]source|literature|landscape|due diligence|comprehensive)\b/i;
const SOCIAL_RE = /\b(?:x\.com|twitter|tweets?|social signal|social listening|what are people saying)\b/i;
const LONG_CONTEXT_RE = /\b(?:long document|large document|entire codebase|whole repo|all files|hundreds of files|500k|million tokens|long context)\b/i;
const JUDGMENT_RE = /\b(?:architect(?:ure)?|strategy|strategic|design|trade[- ]?off|decide|decision|security|threat model|incident|idempotenc|review|debug|diagnos|high[- ]stakes|ambiguous|plan the system)\b/i;
const CODE_RE = /\b(?:implement|build|refactor|fix|debug|patch|migrate|port|add tests?|code|function|module|api|endpoint|schema)\b/i;
const TOIL_RE = /\b(?:rename|renaming|organize|organise|sort|transfer|move|copy|label|tag|triage|format|formatting|normalize|normalise|dedupe|deduplicate|batch|boilerplate|extract|mechanical|bulk|cleanup|clean up|file hygiene|reorder)\b/i;

function textOf(input) {
  return typeof input?.text === 'string' ? input.text.trim() : '';
}

function hasMediaInput(input) {
  if (typeof input?.kind === 'string' && MEDIA_TYPES.has(input.kind.toLowerCase())) return true;
  if (!Array.isArray(input?.attachments)) return false;
  return input.attachments.some((attachment) => {
    const type = typeof attachment === 'string' ? attachment : attachment?.type;
    return typeof type === 'string' && MEDIA_TYPES.has(type.toLowerCase());
  });
}

function explicitTask(input) {
  return typeof input?.taskType === 'string' && EXPLICIT_TASK_TYPES.has(input.taskType)
    ? input.taskType
    : null;
}

/**
 * Classify the request using deterministic signals only.
 *
 * @param {object} input
 * @returns {{taskType:string, signals:string[], ambiguous:boolean}}
 */
export function classifyTask(input = {}) {
  const text = textOf(input);
  const explicit = explicitTask(input);
  if (explicit) return { taskType: explicit, signals: ['explicit-task-type'], ambiguous: false };
  if (!text && !hasMediaInput(input)) {
    return { taskType: TASK_TYPE.FRONTIER_SYNTHESIS, signals: ['missing-task-content'], ambiguous: true };
  }

  if (SOCIAL_RE.test(text)) {
    return { taskType: TASK_TYPE.REALTIME_SOCIAL, signals: ['realtime-social-signal'], ambiguous: false };
  }
  if (RESEARCH_RE.test(text) && DEEP_RESEARCH_RE.test(text)) {
    return { taskType: TASK_TYPE.DEEP_RESEARCH, signals: ['fresh-web-research', 'deep-research-scope'], ambiguous: false };
  }
  if (RESEARCH_RE.test(text)) {
    return { taskType: TASK_TYPE.WEB_RESEARCH, signals: ['fresh-web-research'], ambiguous: false };
  }
  if (hasMediaInput(input) || /\b(?:image|photo|screenshot|pdf|audio|video)\b/i.test(text)) {
    return { taskType: TASK_TYPE.MULTIMODAL, signals: ['media-input'], ambiguous: false };
  }
  if (LONG_CONTEXT_RE.test(text) || text.length >= 100_000) {
    return { taskType: TASK_TYPE.LONG_CONTEXT, signals: ['long-context-scope'], ambiguous: false };
  }
  if (JUDGMENT_RE.test(text)) {
    return { taskType: JUDGMENT_RE.test(text) && /\b(?:architecture|strategy|strategic|design|trade[- ]?off|decision|security|incident|threat model)\b/i.test(text)
      ? TASK_TYPE.STRATEGIC_REASONING
      : TASK_TYPE.FRONTIER_SYNTHESIS, signals: ['high-judgment-scope'], ambiguous: false };
  }
  if (TOIL_RE.test(text)) {
    return { taskType: TASK_TYPE.TOIL, signals: ['bounded-mechanical-scope'], ambiguous: false };
  }
  if (CODE_RE.test(text)) {
    return { taskType: TASK_TYPE.CODE_REFACTOR, signals: ['coding-scope'], ambiguous: false };
  }
  return { taskType: TASK_TYPE.FRONTIER_SYNTHESIS, signals: ['general-request'], ambiguous: false };
}

function routeForTask(taskType) {
  return ROUTE_DEFINITIONS[taskType] || ROUTE_DEFINITIONS[TASK_TYPE.FRONTIER_SYNTHESIS];
}

function safeTarget(target) {
  return {
    handle: target.handle,
    role: target.role,
    capability: target.capability,
    evidence: target.evidence,
    confidence: target.confidence,
  };
}

/**
 * Resolve privacy plus capability routing. This is the public interface used
 * by Raycast, MCP, and the ask CLI.
 *
 * @param {object} input
 * @param {object} [opts]
 * @param {object} [opts.privacyDecision] precomputed gate result for tests
 * @param {object} [opts.config] prebuilt privacy config for tests
 * @returns {Promise<object>}
 */
export async function routeRequest(input = {}, opts = {}) {
  const privacy = opts.privacyDecision || (opts.config
    ? classify(input, opts.config)
    : await classifyAsync(input));

  if (privacy.route !== PRIVACY_ROUTE.AUTO) {
    return {
      lane: LANE.LOCAL_ONLY,
      taskType: 'local_only',
      executionTask: null,
      signals: ['privacy-gate'],
      targets: [],
      selected: null,
      privacy,
      note: 'The privacy gate refused external routing. No model call is authorized by this route.',
    };
  }

  const classification = classifyTask(input);
  const definition = routeForTask(classification.taskType);
  const targets = definition.targets.map(safeTarget);
  return {
    lane: definition.lane,
    taskType: classification.taskType,
    executionTask: definition.executionTask || null,
    signals: classification.signals,
    ambiguous: classification.ambiguous,
    targets,
    selected: targets[0] || null,
    privacy,
    note: definition.lane === LANE.TOIL
      ? 'Bounded toil uses the ZDR-constrained open-weight execution path.'
      : 'High-judgment work uses one capability-selected frontier target with a cross-capability fallback.',
  };
}

export function routeDefinition(taskType) {
  const definition = routeForTask(taskType);
  return {
    lane: definition.lane,
    executionTask: definition.executionTask || null,
    targets: definition.targets.map(safeTarget),
  };
}

// Keep the default export small and useful for local inspection tools.
export default { LANE, TASK_TYPE, ROUTE_DEFINITIONS, classifyTask, routeRequest, routeDefinition };
