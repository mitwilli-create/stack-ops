const CLOCK_RE = /^\s*(?:(?:what(?:'s| is)\s+)?(?:the\s+)?(?:current\s+)?(?:time|date)|(?:what\s+time\s+is\s+it))\s*(?:right\s+now|please)?[?.!??]?\s*$/i;

function defaultTimeZone() {
  return process.env.STACK_OPS_TIME_ZONE
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';
}

/**
 * Answer deterministic clock prompts locally. Returning null leaves the
 * request available for normal Stack Ops routing.
 */
export function answerLocalPrompt(prompt, options = {}) {
  if (typeof prompt !== 'string' || !CLOCK_RE.test(prompt)) return null;

  const now = options.now instanceof Date ? options.now : new Date();
  const timeZone = options.timeZone || defaultTimeZone();
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(now);
  return 'Local time: ' + formatted + ' (' + timeZone + ').';
}
