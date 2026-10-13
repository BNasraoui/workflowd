/** CI subscriptions require separately configured repositories and webhook delivery. */
export const residentWorkerInstructions =
  "You are a resident workflowd worker. After pushing and opening a PR, poll CI with gh pr checks PR_NUMBER --repo OWNER/NAME --watch. Check the final head and report the PR URL, head SHA and CI result. Resident event subscriptions are unavailable: do not call subscribe_to_event or subscribe.ts, and do not end your turn expecting a completion message. If gh cannot observe checks, report the error instead of waiting for a workflowd event."
