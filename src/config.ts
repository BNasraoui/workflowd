import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { normalizeWorkflowDefinition, type WorkflowDefinition } from "./qrspi/domain"

interface HttpConfig {
  readonly host: string
  readonly port: number
  readonly maxWebhookBytes: number
}

interface GitHubConfig {
  readonly appId: number
  readonly privateKeyPath: string
  readonly webhookSecret: string
}

interface StorageConfig {
  readonly databasePath: string
}

interface FixWorkConfig {
  readonly enabled: boolean
}

interface WorkspaceConfig {
  readonly repositoryRoot: string
  readonly worktreeRoot: string
  readonly worktreeRegistry: string
  readonly localRepositories: ReadonlyArray<string>
  readonly maxDiffBytes: number
  readonly gitSigningKey?: string
}

interface OpenCodeConfig {
  readonly baseUrl: string
  readonly serverId: string
  readonly endpointAlias: string
  readonly username: string
  readonly password: string
  readonly model: string
  readonly reviewerAgent: string
  readonly fixerAgent: string
  readonly pollIntervalMs: number
}

interface WorkerConfig {
  readonly concurrency: number
  readonly pollIntervalMs: number
  readonly jobTimeoutMs: number
  readonly jobLeaseDurationMs: number
  readonly publicationTimeoutMs: number
  readonly publicationLeaseDurationMs: number
  readonly agentBranchPrefixes: ReadonlyArray<string>
  readonly trustedAgentUsers: ReadonlyArray<string>
  readonly commandUsers: ReadonlyArray<string>
}

export interface QrspiConfig {
  readonly token: string
  readonly installationId: number
  readonly repository: {
    readonly providerInstanceId: string
    readonly repositoryId: string
    readonly repositoryFullName: string
  }
  readonly trackerInstanceId: string
  readonly beadsWorkspace: string
  readonly baseRef: string
  readonly repositoryOperationTimeoutMs: number
  readonly operationCompletionMarginMs: number
  readonly leaseDurationMs: number
  readonly workflowDefinition: WorkflowDefinition
}

export interface AppConfig {
  readonly http: HttpConfig
  readonly github: GitHubConfig
  readonly storage: StorageConfig
  readonly fixWork: FixWorkConfig
  readonly workspace: WorkspaceConfig
  readonly openCode: OpenCodeConfig
  readonly worker: WorkerConfig
  readonly qrspi?: QrspiConfig
}

export interface ConfigLoadOptions {
  readonly home?: string
  readonly readFile?: (path: string) => Promise<string>
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function booleanSetting(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false
  if (value === "true") return true
  throw new Error(`${name} must be true or false`)
}

function port(value: string | undefined): number {
  const parsed = value === undefined ? 8787 : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("WORKFLOWD_PORT must be between 1 and 65535")
  }
  return parsed
}

function httpUrl(value: string, name: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error()
    return parsed.toString().replace(/\/$/, "")
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL`)
  }
}

function agentId(value: string, name: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/.test(value)) {
    throw new Error(`${name} must be a valid agent ID`)
  }
  return value
}

function modelId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s/]\S*$/.test(value)) {
    throw new Error("WORKFLOWD_MODEL must use provider/model syntax")
  }
  return value
}

function branchPrefixes(value: string | undefined): ReadonlyArray<string> {
  const values = (value ?? "opencode/,plan/").split(",").map((item) => item.trim())
  if (values.length === 0 || values.some((item) => item === "")) {
    throw new Error("WORKFLOWD_AGENT_BRANCH_PREFIXES must contain non-empty prefixes")
  }
  return values
}

function commandUsers(value: string | undefined): ReadonlyArray<string> {
  if (value === undefined || value.trim() === "") return []
  const values = value.split(",").map((item) => item.trim().toLowerCase())
  if (
    values.some(
      (item) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(item) ||
        item.length > 39 ||
        item.includes("--"),
    )
  ) {
    throw new Error("WORKFLOWD_COMMAND_USERS must contain valid GitHub users")
  }
  return values
}

function trustedAgentUsers(value: string | undefined): ReadonlyArray<string> {
  if (value === undefined || value.trim() === "") return []
  const values = value.split(",").map((item) => item.trim().toLowerCase())
  if (
    values.some(
      (item) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?(?:\[bot\])?$/.test(item) || item.includes("--"),
    )
  ) {
    throw new Error("WORKFLOWD_TRUSTED_AGENT_USERS must contain valid GitHub users")
  }
  return values
}

async function secret(
  env: Record<string, string | undefined>,
  directName: string,
  fileName: string,
  read: (path: string) => Promise<string>,
): Promise<string> {
  const direct = env[directName]
  const path = env[fileName]
  if (direct !== undefined && path !== undefined) {
    throw new Error(`${directName} and ${fileName} cannot both be set`)
  }
  if (direct === undefined && path === undefined) {
    throw new Error(`Set exactly one of ${directName} or ${fileName}`)
  }
  if (direct !== undefined) {
    if (direct === "") throw new Error(`${directName} must not be empty`)
    return direct
  }
  if (path === undefined || path.trim() === "") {
    throw new Error(`${fileName} must name a file`)
  }
  let value: string
  try {
    value = await read(path)
  } catch (cause) {
    throw new Error(`Could not read ${fileName} at ${path}`, { cause })
  }
  value = value.replace(/\r?\n$/, "")
  if (value === "") throw new Error(`${fileName} must not be empty`)
  return value
}

export async function loadConfig(
  env: Record<string, string | undefined>,
  options: ConfigLoadOptions = {},
): Promise<AppConfig> {
  const home = options.home ?? homedir()
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"))
  const stateRoot = env.WORKFLOWD_STATE_DIR ?? join(home, ".local/state/workflowd")
  const cacheRoot = env.WORKFLOWD_CACHE_DIR ?? join(home, ".local/share/workflowd")
  const webhookSecret = await secret(
    env,
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_WEBHOOK_SECRET_FILE",
    read,
  )
  const openCodePassword = await secret(
    env,
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_SERVER_PASSWORD_FILE",
    read,
  )
  const jobTimeoutMs = positiveInteger(
    env.WORKFLOWD_JOB_TIMEOUT_MS,
    30 * 60_000,
    "WORKFLOWD_JOB_TIMEOUT_MS",
  )
  const jobLeaseDurationMs = positiveInteger(
    env.WORKFLOWD_JOB_LEASE_MS,
    jobTimeoutMs + 60_000,
    "WORKFLOWD_JOB_LEASE_MS",
  )
  if (jobLeaseDurationMs <= jobTimeoutMs) {
    throw new Error("WORKFLOWD_JOB_LEASE_MS must be greater than WORKFLOWD_JOB_TIMEOUT_MS")
  }
  const publicationTimeoutMs = positiveInteger(
    env.WORKFLOWD_PUBLICATION_TIMEOUT_MS,
    60_000,
    "WORKFLOWD_PUBLICATION_TIMEOUT_MS",
  )
  const publicationLeaseDurationMs = positiveInteger(
    env.WORKFLOWD_PUBLICATION_LEASE_MS,
    publicationTimeoutMs + 60_000,
    "WORKFLOWD_PUBLICATION_LEASE_MS",
  )
  if (publicationLeaseDurationMs <= publicationTimeoutMs) {
    throw new Error(
      "WORKFLOWD_PUBLICATION_LEASE_MS must be greater than WORKFLOWD_PUBLICATION_TIMEOUT_MS",
    )
  }
  const qrspi = loadQrspiConfig(env)
  const fixWorkEnabled = booleanSetting(
    env.WORKFLOWD_FIX_WORK_ENABLED,
    "WORKFLOWD_FIX_WORK_ENABLED",
  )
  const configuredTrustedAgentUsers = trustedAgentUsers(env.WORKFLOWD_TRUSTED_AGENT_USERS)
  const gitSigningKey = env.WORKFLOWD_GIT_SIGNING_KEY
  if (fixWorkEnabled && gitSigningKey === undefined) {
    throw new Error("WORKFLOWD_GIT_SIGNING_KEY is required when Fix Work is enabled")
  }
  if (fixWorkEnabled && configuredTrustedAgentUsers.length === 0) {
    throw new Error("WORKFLOWD_TRUSTED_AGENT_USERS is required when Fix Work is enabled")
  }
  if (gitSigningKey !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(gitSigningKey)) {
    throw new Error("WORKFLOWD_GIT_SIGNING_KEY must be a full OpenPGP fingerprint")
  }

  return {
    http: {
      host: env.WORKFLOWD_HOST ?? "127.0.0.1",
      port: port(env.WORKFLOWD_PORT),
      maxWebhookBytes: positiveInteger(
        env.WORKFLOWD_MAX_WEBHOOK_BYTES,
        1_048_576,
        "WORKFLOWD_MAX_WEBHOOK_BYTES",
      ),
    },
    github: {
      appId: positiveInteger(required(env, "GITHUB_APP_ID"), 0, "GITHUB_APP_ID"),
      privateKeyPath: required(env, "GITHUB_PRIVATE_KEY_PATH"),
      webhookSecret,
    },
    storage: {
      databasePath: env.WORKFLOWD_DATABASE_PATH ?? join(stateRoot, "workflowd.db"),
    },
    fixWork: {
      enabled: fixWorkEnabled,
    },
    workspace: {
      repositoryRoot: env.WORKFLOWD_REPOSITORY_ROOT ?? join(cacheRoot, "repositories"),
      worktreeRoot: env.WORKFLOWD_WORKTREE_ROOT ?? join(cacheRoot, "worktrees"),
      worktreeRegistry:
        env.OPENCODE_WORKTREE_REGISTRY ?? join(home, ".local/share/opencode/worktree-jobs"),
      localRepositories: (env.WORKFLOWD_LOCAL_REPOSITORIES ?? join(home, "Documents/repos"))
        .split(":")
        .filter(Boolean),
      maxDiffBytes: positiveInteger(
        env.WORKFLOWD_MAX_DIFF_BYTES,
        2_000_000,
        "WORKFLOWD_MAX_DIFF_BYTES",
      ),
      ...(gitSigningKey === undefined ? {} : { gitSigningKey }),
    },
    openCode: {
      baseUrl: httpUrl(env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096", "OPENCODE_SERVER_URL"),
      serverId: agentId(
        env.WORKFLOWD_OPENCODE_SERVER_ID ?? "opencode-primary",
        "WORKFLOWD_OPENCODE_SERVER_ID",
      ),
      endpointAlias: agentId(
        env.WORKFLOWD_OPENCODE_ENDPOINT_ALIAS ?? "private-opencode",
        "WORKFLOWD_OPENCODE_ENDPOINT_ALIAS",
      ),
      username: required(
        {
          OPENCODE_SERVER_USERNAME: env.OPENCODE_SERVER_USERNAME ?? "opencode",
        },
        "OPENCODE_SERVER_USERNAME",
      ),
      password: openCodePassword,
      model: modelId(env.WORKFLOWD_MODEL ?? "openai/gpt-5.6-sol"),
      reviewerAgent: agentId(
        env.WORKFLOWD_REVIEWER_AGENT ?? "pr-reviewer",
        "WORKFLOWD_REVIEWER_AGENT",
      ),
      fixerAgent: agentId(env.WORKFLOWD_FIXER_AGENT ?? "pr-fixer", "WORKFLOWD_FIXER_AGENT"),
      pollIntervalMs: positiveInteger(
        env.WORKFLOWD_OPENCODE_POLL_INTERVAL_MS,
        1_000,
        "WORKFLOWD_OPENCODE_POLL_INTERVAL_MS",
      ),
    },
    worker: {
      concurrency: positiveInteger(
        env.WORKFLOWD_WORKER_CONCURRENCY,
        2,
        "WORKFLOWD_WORKER_CONCURRENCY",
      ),
      pollIntervalMs: positiveInteger(
        env.WORKFLOWD_POLL_INTERVAL_MS,
        1_000,
        "WORKFLOWD_POLL_INTERVAL_MS",
      ),
      jobTimeoutMs,
      jobLeaseDurationMs,
      publicationTimeoutMs,
      publicationLeaseDurationMs,
      agentBranchPrefixes: branchPrefixes(env.WORKFLOWD_AGENT_BRANCH_PREFIXES),
      trustedAgentUsers: configuredTrustedAgentUsers,
      commandUsers: commandUsers(env.WORKFLOWD_COMMAND_USERS),
    },
    ...(qrspi === undefined ? {} : { qrspi }),
  }
}

function loadQrspiConfig(env: Record<string, string | undefined>): QrspiConfig | undefined {
  const token = env.WORKFLOWD_QRSPI_TOKEN
  const names = [
    "WORKFLOWD_QRSPI_INSTALLATION_ID",
    "WORKFLOWD_QRSPI_PROVIDER_INSTANCE_ID",
    "WORKFLOWD_QRSPI_REPOSITORY_ID",
    "WORKFLOWD_QRSPI_REPOSITORY",
    "WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID",
    "WORKFLOWD_QRSPI_BEADS_WORKSPACE",
    "WORKFLOWD_QRSPI_DEFINITION_JSON",
    "WORKFLOWD_QRSPI_REPOSITORY_TIMEOUT_MS",
    "WORKFLOWD_QRSPI_COMPLETION_MARGIN_MS",
    "WORKFLOWD_QRSPI_LEASE_MS",
    "WORKFLOWD_QRSPI_BASE_REF",
  ] as const
  if (token === undefined) {
    if (names.some((name) => env[name] !== undefined)) {
      throw new Error("WORKFLOWD_QRSPI_TOKEN is required when QRSPI settings are present")
    }
    return undefined
  }
  if (token.length < 8) throw new Error("WORKFLOWD_QRSPI_TOKEN must contain at least 8 characters")
  const repositoryFullName = required(env, "WORKFLOWD_QRSPI_REPOSITORY")
  if (!/^[^/\s]+\/[^/\s]+$/.test(repositoryFullName)) {
    throw new Error("WORKFLOWD_QRSPI_REPOSITORY must use owner/name syntax")
  }
  const definitionJson = required(env, "WORKFLOWD_QRSPI_DEFINITION_JSON")
  let workflowDefinition: WorkflowDefinition
  try {
    workflowDefinition = normalizeWorkflowDefinition(JSON.parse(definitionJson))
  } catch (cause) {
    throw new Error("WORKFLOWD_QRSPI_DEFINITION_JSON must be a valid workflow definition", {
      cause,
    })
  }
  const appId = positiveInteger(required(env, "GITHUB_APP_ID"), 0, "GITHUB_APP_ID")
  const repositoryOperationTimeoutMs = positiveInteger(
    env.WORKFLOWD_QRSPI_REPOSITORY_TIMEOUT_MS,
    30_000,
    "WORKFLOWD_QRSPI_REPOSITORY_TIMEOUT_MS",
  )
  const operationCompletionMarginMs = positiveInteger(
    env.WORKFLOWD_QRSPI_COMPLETION_MARGIN_MS,
    10_000,
    "WORKFLOWD_QRSPI_COMPLETION_MARGIN_MS",
  )
  const leaseDurationMs = positiveInteger(
    env.WORKFLOWD_QRSPI_LEASE_MS,
    60_000,
    "WORKFLOWD_QRSPI_LEASE_MS",
  )
  if (leaseDurationMs <= repositoryOperationTimeoutMs + operationCompletionMarginMs) {
    throw new Error(
      "WORKFLOWD_QRSPI_LEASE_MS must be greater than repository timeout plus completion margin",
    )
  }
  return {
    token,
    installationId: positiveInteger(
      required(env, "WORKFLOWD_QRSPI_INSTALLATION_ID"),
      0,
      "WORKFLOWD_QRSPI_INSTALLATION_ID",
    ),
    repository: {
      providerInstanceId: env.WORKFLOWD_QRSPI_PROVIDER_INSTANCE_ID ?? `github-app-${appId}`,
      repositoryId: required(env, "WORKFLOWD_QRSPI_REPOSITORY_ID"),
      repositoryFullName,
    },
    trackerInstanceId: required(env, "WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID"),
    beadsWorkspace: required(env, "WORKFLOWD_QRSPI_BEADS_WORKSPACE"),
    baseRef: env.WORKFLOWD_QRSPI_BASE_REF ?? "main",
    repositoryOperationTimeoutMs,
    operationCompletionMarginMs,
    leaseDurationMs,
    workflowDefinition,
  }
}
