import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, ROUTE as PRIVACY_ROUTE } from './privacy-gate.mjs';
import { classifyTask, routeRequest, LANE, TASK_TYPE } from './request-router.mjs';

const safeConfig = buildConfig({
  privatePathPatterns: [/^\/contract\//],
  employerPatterns: [],
  allowlist: [],
});

const safe = { route: PRIVACY_ROUTE.AUTO, sensitive: false, reasons: [] };

test('classifyTask routes rename and organize work to bounded toil', () => {
  const result = classifyTask({ text: 'Rename these files, organize them by project, and move the folders.' });
  assert.equal(result.taskType, TASK_TYPE.TOIL);
  assert.deepEqual(result.signals, ['bounded-mechanical-scope']);
});

test('classifyTask routes current multi-source research to deep research', () => {
  const result = classifyTask({ text: 'Do deep research with current sources and citations on this market.' });
  assert.equal(result.taskType, TASK_TYPE.DEEP_RESEARCH);
});

test('classifyTask routes X requests to the realtime social target', () => {
  const result = classifyTask({ text: 'What are people saying on X about this release today?' });
  assert.equal(result.taskType, TASK_TYPE.REALTIME_SOCIAL);
});

test('classifyTask routes architecture and trade-off work to strategic reasoning', () => {
  const result = classifyTask({ text: 'Design the architecture and explain the trade-offs for this system.' });
  assert.equal(result.taskType, TASK_TYPE.STRATEGIC_REASONING);
});

test('classifyTask routes code changes without toil signals to frontier coding', () => {
  const result = classifyTask({ text: 'Implement the authentication flow and add tests.' });
  assert.equal(result.taskType, TASK_TYPE.CODE_REFACTOR);
});

test('classifyTask accepts an explicit known task type', () => {
  const result = classifyTask({ text: 'anything', taskType: TASK_TYPE.LONG_CONTEXT });
  assert.equal(result.taskType, TASK_TYPE.LONG_CONTEXT);
  assert.deepEqual(result.signals, ['explicit-task-type']);
});

test('routeRequest selects the open-weight toil lane', async () => {
  const result = await routeRequest({ text: 'Batch-format and rename these documents.' }, { privacyDecision: safe });
  assert.equal(result.lane, LANE.TOIL);
  assert.equal(result.executionTask, 'bulk_mechanical_edit');
  assert.equal(result.selected.handle, 'openrouter:qwen/qwen3-coder-30b-a3b-instruct');
  assert.equal(result.targets[1].handle, 'openrouter:z-ai/glm-4.7-flash');
});

test('routeRequest selects a frontier capability target for research', async () => {
  const result = await routeRequest({ text: 'Research the latest evidence and cite sources.' }, { privacyDecision: safe });
  assert.equal(result.lane, LANE.FRONTIER);
  assert.equal(result.taskType, TASK_TYPE.WEB_RESEARCH);
  assert.equal(result.selected.handle, 'perplexity:sonar-pro');
});

test('routeRequest keeps privacy-gated requests local and emits no target', async () => {
  const result = await routeRequest({ text: 'Summarize this contract', paths: ['/contract/legal.md'] }, { config: safeConfig });
  assert.equal(result.lane, LANE.LOCAL_ONLY);
  assert.equal(result.targets.length, 0);
  assert.equal(result.privacy.route, PRIVACY_ROUTE.ANTHROPIC_DIRECT);
});

test('routeRequest keeps empty requests local by deny-by-default', async () => {
  const result = await routeRequest({}, { config: safeConfig });
  assert.equal(result.lane, LANE.LOCAL_ONLY);
  assert.equal(result.privacy.reasons[0].signal, 'ambiguous');
});
