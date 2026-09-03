import { stripAnsi } from './ci-evidence-contract.mjs';

// Allowlisted source locations and fixed categories only. Never publish test
// titles, assertion values, request payloads, traces, screenshots or raw errors.
export function failureDiagnostics(log, { sourceFiles, report } = {}) {
  const allowed = new Set(sourceFiles || []);
  const locations = new Map();
  const categories = new Set();
  const add = (file, line, column = 0) => {
    // Vitest reports paths relative to a workspace such as apps/server.
    if (!allowed.has(file)) {
      const candidates = [...allowed].filter((name) => name.endsWith('/' + file));
      if (candidates.length === 1) file = candidates[0];
    }
    if (!allowed.has(file) || !Number.isSafeInteger(line) || line < 1
      || !Number.isSafeInteger(column) || column < 0 || locations.size >= 100) return;
    const location = { file, line, column };
    locations.set(JSON.stringify(location), location);
  };
  const inspect = (raw) => {
    const text = stripAnsi(String(raw || '')).replaceAll('\\', '/');
    for (const match of text.matchAll(/((?:apps|packages|scripts|deployment|tests|src)\/[a-zA-Z0-9_./-]+\.(?:m?[jt]sx?|cjs)):(\d+)(?::(\d+))?/g)) {
      add(match[1], Number(match[2]), Number(match[3] || 0));
    }
    for (const [category, pattern] of [
      ['ASSERTION', /ERR_ASSERTION|AssertionError|expect\(/],
      ['TIMEOUT', /TimeoutError|[Tt]imed out|[Tt]imeout.*exceeded/],
      ['PERMISSION', /EACCES|EPERM|Permission denied/],
      ['MISSING_FILE', /ENOENT/],
      ['DIRTY_FIXTURE', /clean, committed/],
      ['MISSING_ENCODER', /Unknown encoder|Encoder .*not found/],
      ['OUTBOUND_BLOCKED', /E2E_OUTBOUND_HTTP_BLOCKED/]
    ]) if (pattern.test(text)) categories.add(category);
  };
  inspect(log);
  const failedCases = [];
  const visit = (suite, inheritedFile = '') => {
    const file = String(suite.file || inheritedFile).replaceAll('\\', '/');
    const relative = file.startsWith('tests/e2e/') ? file : 'tests/e2e/' + file;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const results = test.results || [];
        if (test.expectedStatus === 'skipped' && results.length && results.every((r) => r.status === 'skipped')) continue;
        if (test.status === 'expected' && results.length && results.every((r) => r.status === 'passed')) continue;
        if (allowed.has(relative) && Number.isSafeInteger(spec.line) && spec.line > 0 && failedCases.length < 100) {
          failedCases.push({ file: relative, line: spec.line });
        }
        for (const result of results) for (const error of result.errors || []) inspect(error.stack || error.message);
      }
    }
    for (const child of suite.suites || []) visit(child, file);
  };
  for (const suite of report?.suites || []) visit(suite);
  return { sourceLocations: [...locations.values()], failedCases, categories: [...categories].sort(), rawDetailsPublished: false };
}
