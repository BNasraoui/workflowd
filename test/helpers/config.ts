import { agentGitTestEnvironment } from "./agent-git-config"

export const requiredEnvironment: Record<string, string | undefined> = {
  ...agentGitTestEnvironment,
  GITHUB_APP_ID: "123",
  WORKFLOWD_AGENT_GIT_NAME: "Agent",
  WORKFLOWD_AGENT_GIT_EMAIL: "agent@example.test",
  WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
  WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
  GITHUB_PRIVATE_KEY_PATH: "/run/credentials/github-key.pem",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
  OPENCODE_SERVER_PASSWORD: "server-password",
  WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
  WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
  WORKFLOWD_HOST_ID: "mint",
}

export const qrspiDefinition = {
  contractVersion: 1,
  definitionVersion: 1,
  stages: [
    {
      key: "questions",
      kind: "document",
      contract: { name: "qrspi.questions", contractVersion: 1 },
      activation: { mode: "enabled" },
      definitionVersion: 1,
      maxEncodedInputBytes: 16_384,
      producer: {
        harness: { name: "opencode", version: 1 },
        agent: "qrspi-questions",
        model: "openai/gpt-5.6-sol",
        timeoutMs: 60_000,
        retry: { maxAttempts: 3, backoffMs: 1_000 },
      },
      outputPolicy: {
        _tag: "Artifact",
        pathTemplate: "docs/qrspi/{ticketId}/01-questions.md",
        mediaType: "text/markdown",
      },
      reviewPolicy: { mode: "none" },
      humanGatePolicy: { mode: "none" },
    },
  ],
} as const
