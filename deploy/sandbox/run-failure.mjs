/**
 * The one line by which a runner job tells the daemon why its run failed: a cause of a fixed set
 * and a short detail. Only the run client writes it, through the signed event route; the run
 * client drops each line of its harness that starts as this line does, so the agent in the box
 * cannot write one. The daemon ends the run with the cause in its diagnostic; it decides no push.
 */
import { holdsHidden, visibleText } from "./hidden-text.mjs"

/** The start of a failure line. */
export const runFailurePrefix = "workflowd.run_failed "

/**
 * The causes: the launch, a step of the harness (its network, the image, the box, the source,
 * Claude Code, the box's stop, the seal), a harness that named no step, and the post of the result.
 */
export const runFailureCauses = [
  "launch",
  "network",
  "image",
  "box",
  "source",
  "claude",
  "stop",
  "seal",
  "harness",
  "result",
]

/** The most code points of a failure's detail. */
export const runFailureDetailCharacters = 300

/** The failure line of `cause` (`harness` when it is not one of the set) and `detail`. */
export const runFailureLine = (cause, detail) =>
  runFailurePrefix +
  JSON.stringify({
    cause: runFailureCauses.includes(cause) ? cause : "harness",
    detail: visibleText(typeof detail === "string" ? detail : "", runFailureDetailCharacters),
  })

/** The cause and the detail of a failure line, or undefined when `line` is not one. */
export const parseRunFailure = (line) => {
  if (!line.startsWith(runFailurePrefix)) return undefined
  let value
  try {
    value = JSON.parse(line.slice(runFailurePrefix.length))
  } catch {
    return undefined
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join() !== "cause,detail" ||
    !runFailureCauses.includes(value.cause) ||
    typeof value.detail !== "string" ||
    [...value.detail].length > runFailureDetailCharacters + 3 ||
    holdsHidden(value.detail)
  )
    return undefined
  return { cause: value.cause, detail: value.detail }
}
