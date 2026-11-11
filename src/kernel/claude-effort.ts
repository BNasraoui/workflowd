/**
 * Claude Code does not refuse an effort level it does not take: it warns on
 * stderr and runs at its default effort. workflowd treats that warning as the
 * CLI refusing the effort that was asked.
 */
const IGNORED_EFFORT = /Unknown --effort value '([^']*)'/

/** The effort the Claude CLI said it ignored, if any. */
export const claudeIgnoredEffort = (stderr: string): string | undefined =>
  IGNORED_EFFORT.exec(stderr)?.[1]
