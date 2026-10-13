import { createHmac } from "node:crypto"

export const pullRequestPayload = (repository = "example-owner/example") =>
  JSON.stringify({
    action: "opened",
    installation: { id: 91 },
    repository: {
      id: 42,
      full_name: repository,
      owner: { login: repository.split("/")[0] },
      name: repository.split("/")[1],
    },
    pull_request: {
      number: 7,
      draft: false,
      state: "open",
      user: { login: "opencode-agent" },
      head: {
        sha: "a".repeat(40),
        ref: "opencode/example-job",
        repo: { full_name: repository },
      },
      base: { sha: "d".repeat(40), ref: "main" },
    },
  })

export function signedRequest(
  event: string,
  body: string,
  deliveryId: string,
  secret: string,
  url = "http://localhost/hooks/github",
) {
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  return new Request(url, {
    method: "POST",
    body,
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
  })
}
