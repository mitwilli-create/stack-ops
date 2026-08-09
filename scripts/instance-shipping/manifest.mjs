const REQUIRED_COMMANDS = ['verify', 'deploy', 'liveCheck'];

function validCommands(value) {
  return Array.isArray(value) && value.length > 0 && value.every(
    (command) => typeof command === 'string' && command.trim().length > 0,
  );
}

export function branchPatternMatches(pattern, branch) {
  if (typeof pattern !== 'string' || typeof branch !== 'string') return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(branch);
}

export function validateDeployManifest(manifest) {
  const errors = [];
  for (const key of REQUIRED_COMMANDS) {
    if (!validCommands(manifest?.[key])) errors.push(`${key} must be a non-empty array of commands`);
  }
  if (!Array.isArray(manifest?.branches) || manifest.branches.length === 0) {
    errors.push('branches must be a non-empty array');
  }
  if (manifest?.autoDeploy !== true) errors.push('autoDeploy must be true for automatic deployment');
  return { valid: errors.length === 0, errors };
}

export function manifestAllowsBranch(manifest, branch) {
  const validation = validateDeployManifest(manifest);
  if (!validation.valid) return { allowed: false, reason: validation.errors.join('; ') };
  if (!manifest.branches.some((pattern) => branchPatternMatches(pattern, branch))) {
    return { allowed: false, reason: `branch ${branch} does not match the deployment policy` };
  }
  return { allowed: true, reason: 'branch matches the opt-in deployment policy' };
}
