const SHA256_HEX = /^[a-f0-9]{64}$/i;
const FLOATING = /[~^*x]|>=|<=|>(?!=)|<(?!=)|\blatest\b/i;

function itemEntries(lock) {
  return [
    ...Object.entries(lock.toolchain ?? {}).map(([key, value]) => [`toolchain.${key}`, value]),
    ...Object.entries(lock.dependencies ?? {}).map(([key, value]) => [`dependencies.${key}`, value]),
    ...Object.entries(lock.transitiveDependencies ?? {}).map(([key, value]) => [`transitiveDependencies.${key}`, value]),
  ];
}

function checkDigest(errors, path, digest) {
  if (typeof digest !== 'string' || !SHA256_HEX.test(digest) || digest.includes('REVIEW_REQUIRED')) {
    errors.push(`${path}: reviewed 64-character SHA-256 digest is required`);
  }
}

function checkApproved(errors, path, status) {
  if (status !== 'approved') errors.push(`${path}: production requires approved status; found ${String(status)}`);
}

export function validateProductionLock(lock) {
  const errors = [];
  if (!lock || typeof lock !== 'object') return ['lock: non-null object is required'];
  if (lock.lockVersion !== 1) errors.push('lockVersion: expected 1');
  if (!['x64', 'arm64'].includes(lock.architecture)) errors.push('architecture: unsupported value');
  if (!lock.reviewedBy) errors.push('reviewedBy: reviewer is required');
  if (!lock.reviewDate || Number.isNaN(Date.parse(lock.reviewDate))) errors.push('reviewDate: valid review date is required');

  const policy = lock.policy ?? {};
  for (const key of ['allowFloatingRanges', 'allowUnlistedDependencies', 'allowAutoDownload', 'allowAlternateCompilers']) {
    if (policy[key] !== false) errors.push(`policy.${key}: must be false`);
  }

  for (const [path, item] of itemEntries(lock)) {
    if (!item || typeof item !== 'object') { errors.push(`${path}: item is required`); continue; }
    if (typeof item.version !== 'string' || !item.version || FLOATING.test(item.version)) errors.push(`${path}.version: exact version is required`);
    checkApproved(errors, `${path}.reviewStatus`, item.reviewStatus);
    checkDigest(errors, `${path}.integrity.digest`, item.integrity?.digest);
  }

  const ci = lock.ciEnvironment;
  if (!ci || typeof ci !== 'object') return [...errors, 'ciEnvironment: required'];
  checkApproved(errors, 'ciEnvironment.reviewStatus', ci.reviewStatus);
  checkDigest(errors, 'ciEnvironment.imageDigest', ci.imageDigest);
  checkDigest(errors, 'ciEnvironment.integrity.digest', ci.integrity?.digest);
  if (!Array.isArray(ci.snapshots) || ci.snapshots.length !== 3) {
    errors.push('ciEnvironment.snapshots: exactly three reviewed snapshots are required');
  } else {
    for (const [index, snapshot] of ci.snapshots.entries()) {
      const path = `ciEnvironment.snapshots.${index}`;
      if (!/^stage-c-win(?:10|11)-[a-z0-9-]+-v\d+$/.test(snapshot.runnerLabel ?? '')) errors.push(`${path}.runnerLabel: invalid versioned label`);
      checkApproved(errors, `${path}.reviewStatus`, snapshot.reviewStatus);
      checkDigest(errors, `${path}.imageDigest`, snapshot.imageDigest);
      checkDigest(errors, `${path}.collectorManifestDigest`, snapshot.collectorManifestDigest);
      checkDigest(errors, `${path}.integrity.digest`, snapshot.integrity?.digest);
      if (!Array.isArray(snapshot.webView2Runtimes) || snapshot.webView2Runtimes.length === 0) {
        errors.push(`${path}.webView2Runtimes: preinstalled runtimes are required`);
      } else {
        for (const [runtimeIndex, runtime] of snapshot.webView2Runtimes.entries()) {
          const runtimePath = `${path}.webView2Runtimes.${runtimeIndex}`;
          if (typeof runtime.version !== 'string' || FLOATING.test(runtime.version)) errors.push(`${runtimePath}.version: exact version is required`);
          if (typeof runtime.path !== 'string' || !runtime.path) errors.push(`${runtimePath}.path: path is required`);
          checkApproved(errors, `${runtimePath}.reviewStatus`, runtime.reviewStatus);
          checkDigest(errors, `${runtimePath}.integrity.digest`, runtime.integrity?.digest);
        }
      }
    }
  }
  return errors;
}

export function findSnapshot(lock, runnerLabel) {
  return lock.ciEnvironment?.snapshots?.find((snapshot) => snapshot.runnerLabel === runnerLabel) ?? null;
}

export function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has invalid fields; expected exactly: ${wanted.join(', ')}`);
  }
}