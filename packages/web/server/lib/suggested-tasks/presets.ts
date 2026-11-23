// Starting points for a lens. Adding a preset copies its prompt into the
// project's config, where the user edits it; a later change here never
// reaches a lens that already exists.
//
// The prompt says only what to look for. How to report, what is out of
// scope, what is already known and the read-only rules come from the scan
// prompt (`scan-prompt.js`), so every lens reports the same way.

export const LENS_PRESETS = Object.freeze([
  {
    id: 'todo-fixme',
    web: false,
    prompt: [
      'Find TODO, FIXME, HACK and XXX comments that point at real unfinished work.',
      'Skip comments that are notes to the reader rather than work to do, and comments about code that no longer exists.',
      'Group comments that describe the same piece of work into one suggestion, and say what finishing it involves.',
    ].join('\n'),
  },
  {
    id: 'security',
    web: false,
    prompt: [
      'Look for security problems a reviewer would block a change for:',
      'injection (shell, SQL, path, HTML), missing authorization or authentication checks, secrets in code or logs,',
      'unsafe deserialization, weak cryptography, server-side request forgery, and unvalidated input crossing a trust boundary.',
      'Report only what you can point to in the code, with the path an attacker would take.',
    ].join('\n'),
  },
  {
    id: 'performance',
    web: false,
    prompt: [
      'Look for work the code repeats or does more expensively than needed on paths that run often:',
      'quadratic loops over growing collections, repeated I/O or network calls inside loops, missing pagination,',
      'synchronous work on hot paths, and caches that never evict.',
      'Explain what grows and why it matters; skip micro-optimizations.',
    ].join('\n'),
  },
  {
    id: 'accessibility',
    web: false,
    prompt: [
      'Look for accessibility problems in user interface code:',
      'interactive elements without an accessible name, click handlers on non-interactive elements, missing keyboard support,',
      'images without alternative text, form fields without labels, and focus that gets lost or trapped.',
    ].join('\n'),
  },
  {
    id: 'test-coverage',
    web: false,
    prompt: [
      'Find important behavior that no test covers: error paths, boundary values, and code that changed recently without a test change.',
      'Each suggestion names the behavior to test and the file that holds the tests for it.',
    ].join('\n'),
  },
  {
    id: 'dependencies',
    web: true,
    prompt: [
      'Read the dependency manifests and lockfiles. Find dependencies that are deprecated, unmaintained,',
      'several major versions behind, or affected by known vulnerabilities, and dependencies the code no longer uses.',
      'Use the web to check current versions and advisories when web access is allowed. Say what upgrading involves.',
    ].join('\n'),
  },
  {
    id: 'docs',
    web: false,
    prompt: [
      'Compare the documentation (README files, docs folders, module documentation, public API comments) with the code.',
      'Report documentation that describes behavior, options, commands or file names that no longer match the code,',
      'and public behavior that has no documentation at all.',
    ].join('\n'),
  },
  {
    id: 'dead-code',
    web: false,
    prompt: [
      'Find code nothing uses anymore: unexported functions without callers, exports nobody imports,',
      'feature flags that are always on or off, and branches that can no longer run.',
      'Check for dynamic uses (string lookups, reflection, public entry points) before you call something unused.',
    ].join('\n'),
  },
]);
