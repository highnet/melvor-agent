/**
 * Commit message rules.
 *
 * Deliberately close to the defaults. The one adjustment is the subject-case
 * rule: the default forbids sentence-case subjects, which reads oddly for
 * messages that begin with a proper noun or an identifier.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Types that release-please maps to changelog sections, plus the standard
    // housekeeping ones it ignores.
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert'],
    ],
    // Bodies here carry the reasoning behind a change and wrap at 80; the
    // default 100-char body limit fights that for no benefit.
    'body-max-line-length': [0],
    'subject-case': [0],
  },
};
