/**
 * Bounded classification and receipt parsing for the subscription failover
 * adapter. Raw provider output never enters a receipt.
 */

export function providerFallbackEligible(text) {
  return /429|rate.?limit|weekly limit|plan limit|usage limit|quota|resource.?exhausted|credential|unauthorized|forbidden|provider unavailable|command not found|enoent/i.test(String(text || ''));
}

export function canReplayProviderFailure({ eligible, changedPaths = [] } = {}) {
  return eligible === true && Array.isArray(changedPaths) && changedPaths.length === 0;
}

export function providerAttempts(stderr) {
  const values = [];
  for (const line of String(stderr || '').split('\n')) {
    const match = line.match(/\[provider-failover-agent\] (?:resolved=[^ ]+|exhausted) attempts=(\[[^\n]+\])/);
    if (!match) continue;
    try {
      const attempts = JSON.parse(match[1]);
      if (Array.isArray(attempts)) values.push(...attempts.map((attempt) => ({
        provider: String(attempt.provider || 'unknown'),
        model: String(attempt.model || 'unknown'),
        status: String(attempt.status || 'unknown'),
        errorCode: attempt.errorCode ? String(attempt.errorCode) : null,
      })));
    } catch {
      // Keep bounded receipt metadata empty on malformed adapter diagnostics.
    }
  }
  return values;
}
