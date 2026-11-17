/**
 * The first event line of a runner run: the harness writes it once the run's box runs, with the
 * source checked out, before Claude Code starts. The daemon's window for the run's first model
 * output starts when it reads this line, so the image pull, the box's start and the clone are
 * not in that window. A run whose first line is another ends `runner_start`.
 */
export const boxReadyLine = JSON.stringify({ type: "system", subtype: "workflowd_box_ready" })
