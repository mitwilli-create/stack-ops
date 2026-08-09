import { answerLocalPrompt as defaultLocalAnswer } from './local-handlers.mjs';
import { assembleAgentContext as defaultContext } from './context-assembler.mjs';
import { routeRequest as defaultRoute } from '../router/request-router.mjs';

export function createSessionHost(options = {}) {
  if (!options.store) throw new Error('session host requires a store');
  const context = options.context || defaultContext;
  const route = options.route || defaultRoute;
  const localAnswer = options.localAnswer || defaultLocalAnswer;
  const dispatch = options.dispatch || (async () => {
    throw new Error('session host dispatch is not configured');
  });

  return {
    listSessions: () => options.store.listSessions(),
    getSession: (id) => options.store.getSession(id),
    createSession: (title) => options.store.createSession(title),

    async submit({ sessionId, prompt, input = {} }) {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is empty');
      const session = sessionId
        ? await options.store.getSession(sessionId)
        : await options.store.createSession();
      await options.store.appendMessage(session.id, { role: 'user', content: prompt });

      const local = await localAnswer(prompt);
      if (local) {
        const metadata = { lane: 'local', taskType: 'local_clock', target: 'system-clock' };
        const updated = await options.store.appendMessage(session.id, {
          role: 'assistant',
          content: local,
          metadata,
        });
        return { session: updated, answer: local, decision: metadata, context: null, metadata };
      }

      const decision = await route({ ...input, text: prompt });
      if (decision.lane === 'local-only') {
        const metadata = { lane: 'local-only', taskType: decision.taskType || 'local_only', target: null };
        const answer = 'Stack Ops kept this request local. ' + (decision.note || 'The privacy gate refused external routing.');
        const updated = await options.store.appendMessage(session.id, {
          role: 'assistant',
          content: answer,
          metadata,
        });
        return { session: updated, answer, decision, context: null, target: null, refused: true, metadata };
      }

      const assembled = await context({ ...input, prompt });
      const dispatched = await dispatch({ prompt, decision, context: assembled, session });
      if (!dispatched || typeof dispatched.answer !== 'string') {
        throw new Error('dispatch returned no answer');
      }
      const metadata = {
        lane: decision.lane,
        taskType: decision.taskType,
        target: dispatched.target?.handle || decision.selected?.handle || null,
        memorySources: assembled.sources?.length || 0,
        skills: assembled.skills?.map((skill) => skill.name) || [],
      };
      const updated = await options.store.appendMessage(session.id, {
        role: 'assistant',
        content: dispatched.answer,
        metadata,
      });
      return { session: updated, answer: dispatched.answer, decision, context: assembled, metadata };
    },
  };
}
