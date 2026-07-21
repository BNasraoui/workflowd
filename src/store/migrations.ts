import { Migrator, SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { MAX_AGENT_LAUNCH_INTENT_BYTES, MAX_AGENT_OUTPUT_BYTES } from "../agent-payload"

const initialSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      action TEXT,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL
    ) STRICT
  `
  yield* sql`
    CREATE TABLE pull_requests (
      repository_id INTEGER NOT NULL CHECK (repository_id > 0),
      pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
      installation_id INTEGER NOT NULL CHECK (installation_id > 0),
      repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) > 0),
      repository_owner TEXT NOT NULL CHECK (length(repository_owner) > 0),
      repository_name TEXT NOT NULL CHECK (length(repository_name) > 0),
      author TEXT NOT NULL CHECK (length(author) > 0),
      base_ref TEXT NOT NULL CHECK (length(base_ref) > 0),
      base_sha TEXT NOT NULL CHECK (
        length(base_sha) IN (40, 64) AND base_sha NOT GLOB '*[^0-9a-fA-F]*'
      ),
      draft INTEGER NOT NULL CHECK (draft IN (0, 1)),
      head_ref TEXT NOT NULL CHECK (length(head_ref) > 0),
      head_repository_full_name TEXT NOT NULL
        CHECK (length(head_repository_full_name) > 0),
      head_sha TEXT NOT NULL CHECK (
        length(head_sha) IN (40, 64) AND head_sha NOT GLOB '*[^0-9a-fA-F]*'
      ),
      github_updated_at TEXT,
      state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
      generation INTEGER NOT NULL CHECK (generation > 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, pull_request_number)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
      operation_key TEXT NOT NULL UNIQUE CHECK (length(operation_key) > 0),
      installation_id INTEGER NOT NULL CHECK (installation_id > 0),
      repository_id INTEGER NOT NULL CHECK (repository_id > 0),
      repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) > 0),
      pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
      base_ref TEXT NOT NULL CHECK (length(base_ref) > 0),
      base_sha TEXT NOT NULL CHECK (
        length(base_sha) IN (40, 64) AND base_sha NOT GLOB '*[^0-9a-fA-F]*'
      ),
      expected_head_sha TEXT NOT NULL CHECK (
        length(expected_head_sha) IN (40, 64)
          AND expected_head_sha NOT GLOB '*[^0-9a-fA-F]*'
      ),
      head_ref TEXT NOT NULL CHECK (length(head_ref) > 0),
      head_repository_full_name TEXT NOT NULL
        CHECK (length(head_repository_full_name) > 0),
      generation INTEGER NOT NULL CHECK (generation > 0),
      review_request_number INTEGER NOT NULL CHECK (review_request_number > 0),
      review_json TEXT NOT NULL CHECK ((
        json_valid(review_json) = 1
        AND json_type(review_json, '$') = 'object'
        AND json_type(review_json, '$.summary') = 'text'
        AND length(json_extract(review_json, '$.summary')) BETWEEN 1 AND 4000
        AND json_type(review_json, '$.findings') = 'array'
        AND (
          (json_extract(review_json, '$.verdict') = 'pass'
            AND json_array_length(review_json, '$.findings') = 0)
          OR (json_extract(review_json, '$.verdict') = 'changes_requested'
            AND json_array_length(review_json, '$.findings') > 0)
        )
      ) IS TRUE),
      state TEXT NOT NULL CHECK (state IN (
        'ready', 'leased', 'retry_scheduled', 'succeeded', 'failed',
        'superseded', 'data_error'
      )),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      run_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts),
      CHECK ((state = 'leased') =
        (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
      CHECK (lease_owner IS NULL OR length(lease_owner) > 0),
      CHECK (
        (state IN ('retry_scheduled', 'failed', 'data_error')
          AND last_error IS NOT NULL AND length(last_error) > 0)
        OR (state IN ('ready', 'leased', 'succeeded') AND last_error IS NULL)
        OR state = 'superseded'
      ),
      FOREIGN KEY (repository_id, pull_request_number)
        REFERENCES pull_requests (repository_id, pull_request_number)
        ON DELETE CASCADE
    ) STRICT
  `
  yield* sql`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
      kind TEXT NOT NULL CHECK (kind IN ('review', 'fix')),
      installation_id INTEGER NOT NULL CHECK (installation_id > 0),
      repository_id INTEGER NOT NULL CHECK (repository_id > 0),
      repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) > 0),
      pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
      author TEXT NOT NULL CHECK (length(author) > 0),
      base_ref TEXT NOT NULL CHECK (length(base_ref) > 0),
      base_sha TEXT NOT NULL CHECK (
        length(base_sha) IN (40, 64) AND base_sha NOT GLOB '*[^0-9a-fA-F]*'
      ),
      expected_head_sha TEXT NOT NULL CHECK (
        length(expected_head_sha) IN (40, 64)
          AND expected_head_sha NOT GLOB '*[^0-9a-fA-F]*'
      ),
      head_ref TEXT NOT NULL CHECK (length(head_ref) > 0),
      head_repository_full_name TEXT NOT NULL
        CHECK (length(head_repository_full_name) > 0),
      generation INTEGER NOT NULL CHECK (generation > 0),
      review_request_number INTEGER NOT NULL CHECK (review_request_number > 0),
      publication_id INTEGER CHECK (publication_id > 0),
      review_json TEXT,
      fix_result_json TEXT,
      state TEXT NOT NULL CHECK (state IN (
        'ready', 'leased', 'retry_scheduled', 'succeeded', 'failed',
        'superseded', 'data_error'
      )),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0
        CHECK (cancel_requested IN (0, 1)),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts),
      CHECK ((state = 'leased') =
        (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
      CHECK (lease_owner IS NULL OR length(lease_owner) > 0),
      CHECK (
        (state IN ('retry_scheduled', 'failed', 'data_error')
          AND last_error IS NOT NULL AND length(last_error) > 0)
        OR (state IN ('ready', 'leased', 'succeeded') AND last_error IS NULL)
        OR state = 'superseded'
      ),
      CHECK ((
        (kind = 'review' AND publication_id IS NULL
          AND review_json IS NULL AND fix_result_json IS NULL)
        OR (kind = 'fix' AND publication_id IS NOT NULL
          AND json_valid(review_json) = 1
          AND json_type(review_json, '$') = 'object'
          AND json_type(review_json, '$.summary') = 'text'
          AND length(json_extract(review_json, '$.summary')) BETWEEN 1 AND 4000
          AND json_extract(review_json, '$.verdict') = 'changes_requested'
          AND json_type(review_json, '$.findings') = 'array'
          AND json_array_length(review_json, '$.findings') > 0
          AND (fix_result_json IS NULL OR (
            json_valid(fix_result_json) = 1
            AND json_type(fix_result_json, '$') = 'object'
            AND json_type(fix_result_json, '$.summary') = 'text'
            AND length(json_extract(fix_result_json, '$.summary')) BETWEEN 1 AND 4000
            AND (
              (json_extract(fix_result_json, '$._tag') = 'NoChanges'
                AND json_type(fix_result_json, '$.commitSha') IS NULL)
              OR (json_extract(fix_result_json, '$._tag') = 'CommitPrepared'
                AND json_type(fix_result_json, '$.commitSha') = 'text'
                AND length(json_extract(fix_result_json, '$.commitSha')) IN (40, 64)
                AND json_extract(fix_result_json, '$.commitSha')
                  NOT GLOB '*[^0-9a-fA-F]*')
            )
          ))
        )
      ) IS TRUE),
      FOREIGN KEY (repository_id, pull_request_number)
        REFERENCES pull_requests (repository_id, pull_request_number)
        ON DELETE CASCADE,
      FOREIGN KEY (publication_id) REFERENCES publications (id) ON DELETE CASCADE
    ) STRICT
  `
  yield* sql`
    CREATE TABLE commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
      delivery_id TEXT NOT NULL UNIQUE,
      command TEXT NOT NULL CHECK (command IN ('review', 'fix', 'status')),
      comment_id INTEGER NOT NULL CHECK (comment_id > 0),
      commenter TEXT NOT NULL CHECK (length(commenter) > 0),
      installation_id INTEGER NOT NULL CHECK (installation_id > 0),
      repository_id INTEGER NOT NULL CHECK (repository_id > 0),
      repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) > 0),
      pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
      state TEXT NOT NULL CHECK (state IN (
        'ready', 'leased', 'retry_scheduled', 'succeeded', 'failed', 'data_error'
      )),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts),
      CHECK ((state = 'leased') =
        (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
      CHECK (lease_owner IS NULL OR length(lease_owner) > 0),
      CHECK (
        (state IN ('retry_scheduled', 'failed', 'data_error')
          AND last_error IS NOT NULL AND length(last_error) > 0)
        OR (state IN ('ready', 'leased', 'succeeded') AND last_error IS NULL)
      ),
      FOREIGN KEY (delivery_id) REFERENCES webhook_deliveries (delivery_id)
        ON DELETE CASCADE
    ) STRICT
  `
  yield* sql`
    CREATE TABLE reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
      installation_id INTEGER NOT NULL CHECK (installation_id > 0),
      repository_id INTEGER NOT NULL CHECK (repository_id > 0),
      repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) > 0),
      pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
      state TEXT NOT NULL CHECK (state IN (
        'ready', 'leased', 'retry_scheduled', 'succeeded', 'failed', 'data_error'
      )),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      run_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (repository_id, pull_request_number),
      CHECK (attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts),
      CHECK ((state = 'leased') =
        (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
      CHECK (lease_owner IS NULL OR length(lease_owner) > 0),
      CHECK (
        (state IN ('retry_scheduled', 'failed', 'data_error')
          AND last_error IS NOT NULL AND length(last_error) > 0)
        OR (state IN ('ready', 'leased', 'succeeded') AND last_error IS NULL)
      ),
      FOREIGN KEY (repository_id, pull_request_number)
        REFERENCES pull_requests (repository_id, pull_request_number)
        ON DELETE CASCADE
    ) STRICT
  `

  yield* sql`CREATE UNIQUE INDEX jobs_identity ON jobs (
    kind, repository_id, pull_request_number, generation, review_request_number
  )`
  yield* sql`CREATE INDEX jobs_claimable ON jobs (state, run_at, lease_until, id)`
  yield* sql`CREATE INDEX publications_claimable
    ON publications (state, run_at, lease_until, id)`
  yield* sql`CREATE INDEX commands_claimable
    ON commands (state, run_at, lease_until, id)`
  yield* sql`CREATE INDEX publications_identity ON publications (
    repository_id, pull_request_number, generation, review_request_number
  )`
  yield* sql`CREATE INDEX reconciliations_claimable
    ON reconciliations (state, run_at, lease_until, id)`
})

const agentHarnessSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE agent_executions (
      session_reference_id TEXT PRIMARY KEY CHECK (
        length(session_reference_id) BETWEEN 1 AND 128
      ),
      job_id INTEGER NOT NULL CHECK (job_id > 0),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      lease_token TEXT NOT NULL CHECK (length(lease_token) BETWEEN 16 AND 128),
      launch_intent_json TEXT NOT NULL CHECK (
        json_valid(launch_intent_json) = 1
          AND json_type(launch_intent_json, '$') = 'object'
      ),
      session_reference_json TEXT CHECK (
        session_reference_json IS NULL OR (
          json_valid(session_reference_json) = 1
            AND json_type(session_reference_json, '$') = 'object'
            AND length(session_reference_json) <= 16384
        )
      ),
      output_json TEXT CHECK (
        output_json IS NULL OR (
          json_valid(output_json) = 1
        )
      ),
      state TEXT NOT NULL CHECK (state IN (
        'launch_intent', 'session_ready', 'succeeded', 'failed', 'superseded'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'launch_intent'
          AND session_reference_json IS NULL AND output_json IS NULL)
        OR (state = 'session_ready'
          AND session_reference_json IS NOT NULL AND output_json IS NULL)
        OR (state = 'succeeded'
          AND session_reference_json IS NOT NULL AND output_json IS NOT NULL)
        OR state IN ('failed', 'superseded')
      ),
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
    ) STRICT
  `
  yield* sql`
    ALTER TABLE publications ADD COLUMN session_reference_id TEXT
      REFERENCES agent_executions (session_reference_id) ON DELETE SET NULL
      CHECK (
        session_reference_id IS NULL OR length(session_reference_id) BETWEEN 1 AND 128
      )
  `
  yield* sql`CREATE INDEX agent_executions_job ON agent_executions (job_id, attempt)`
})

const agentSessionCleanupLeases = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent_executions ADD COLUMN cleanup_lease_owner TEXT`
  yield* sql`ALTER TABLE agent_executions ADD COLUMN cleanup_lease_until TEXT`
  yield* sql`
    ALTER TABLE agent_executions
    ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0)
  `
})

const agentSessionRecoveryAndPayloadEnvelopes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE agent_executions ADD COLUMN cleanup_disposition TEXT
      CHECK (cleanup_disposition IN ('operator_required', 'data_error'))
  `
  yield* sql`ALTER TABLE agent_executions ADD COLUMN cleanup_last_error TEXT`
  const oversized = yield* sql<{ readonly count: number }>`
    SELECT count(*) AS count
    FROM agent_executions
    WHERE length(CAST(launch_intent_json AS BLOB)) > ${MAX_AGENT_LAUNCH_INTENT_BYTES}
      OR (
        output_json IS NOT NULL
        AND length(CAST(output_json AS BLOB)) > ${MAX_AGENT_OUTPUT_BYTES}
      )
  `
  if (Number(oversized[0]?.count ?? 0) > 0) {
    return yield* Effect.fail(
      new Error("Existing agent execution payload exceeds the durable envelope"),
    )
  }
  yield* sql.unsafe(`
    CREATE TRIGGER agent_execution_payload_insert
    BEFORE INSERT ON agent_executions
    WHEN length(CAST(NEW.launch_intent_json AS BLOB)) > ${MAX_AGENT_LAUNCH_INTENT_BYTES}
      OR (
        NEW.output_json IS NOT NULL
        AND length(CAST(NEW.output_json AS BLOB)) > ${MAX_AGENT_OUTPUT_BYTES}
      )
    BEGIN
      SELECT RAISE(ABORT, 'agent execution payload exceeds durable envelope');
    END
  `)
  yield* sql.unsafe(`
    CREATE TRIGGER agent_execution_payload_update
    BEFORE UPDATE OF launch_intent_json, output_json ON agent_executions
    WHEN length(CAST(NEW.launch_intent_json AS BLOB)) > ${MAX_AGENT_LAUNCH_INTENT_BYTES}
      OR (
        NEW.output_json IS NOT NULL
        AND length(CAST(NEW.output_json AS BLOB)) > ${MAX_AGENT_OUTPUT_BYTES}
      )
    BEGIN
      SELECT RAISE(ABORT, 'agent execution payload exceeds durable envelope');
    END
  `)
})

const qrspiWorkflowStart = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE qrspi_workflows (
      workflow_id TEXT PRIMARY KEY CHECK (length(workflow_id) BETWEEN 1 AND 256),
      branch_name TEXT NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 256),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `
  yield* sql`
    CREATE TABLE qrspi_ticket_revisions (
      workflow_id TEXT NOT NULL REFERENCES qrspi_workflows (workflow_id),
      ticket_revision_sha256 TEXT NOT NULL CHECK (
        length(ticket_revision_sha256) = 64
          AND ticket_revision_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      revision_json TEXT NOT NULL CHECK (
        json_valid(revision_json) = 1 AND json_type(revision_json, '$') = 'object'
      ),
      checked_at TEXT NOT NULL,
      PRIMARY KEY (workflow_id, ticket_revision_sha256)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE qrspi_workflow_definitions (
      definition_sha256 TEXT PRIMARY KEY CHECK (
        length(definition_sha256) = 64
          AND definition_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      definition_json TEXT NOT NULL CHECK (
        json_valid(definition_json) = 1 AND json_type(definition_json, '$') = 'object'
      ),
      created_at TEXT NOT NULL
    ) STRICT
  `
  yield* sql`
    CREATE TABLE workflow_operations (
      operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 512),
      logical_operation_id TEXT NOT NULL CHECK (length(logical_operation_id) BETWEEN 1 AND 512),
      operation_revision INTEGER NOT NULL CHECK (operation_revision > 0),
      retry_of TEXT REFERENCES workflow_operations (operation_id),
      kind TEXT NOT NULL CHECK (kind IN (
        'WorkflowStart', 'StageProduce', 'ArtifactPublish', 'ReviewContribute',
        'ReviewSynthesize', 'TicketUpdate', 'TargetReconcile', 'ProvenancePublish',
        'PrePullRequestVerify', 'PullRequestPublish', 'PullRequestRetire',
        'GenericReviewHandoff'
      )),
      scope_json TEXT NOT NULL CHECK (
        json_valid(scope_json) = 1 AND json_type(scope_json, '$') = 'object'
      ),
      input_json TEXT NOT NULL CHECK (
        json_valid(input_json) = 1 AND json_type(input_json, '$') = 'object'
      ),
      input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
      output_json TEXT CHECK (
        output_json IS NULL OR (json_valid(output_json) = 1 AND json_type(output_json, '$') = 'object')
      ),
      state TEXT NOT NULL CHECK (state IN (
        'blocked', 'ready', 'leased', 'waiting_external', 'waiting_human',
        'succeeded', 'failed', 'cancelled', 'superseded', 'data_error'
      )),
      is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
      attempt INTEGER NOT NULL CHECK (attempt >= 0),
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0 AND attempt <= max_attempts),
      lease_owner TEXT,
      lease_token TEXT,
      lease_until TEXT,
      run_at TEXT NOT NULL,
      external_intent_json TEXT CHECK (
        external_intent_json IS NULL OR json_valid(external_intent_json) = 1
      ),
      external_observation_json TEXT CHECK (
        external_observation_json IS NULL OR json_valid(external_observation_json) = 1
      ),
      observation_attempts INTEGER NOT NULL CHECK (observation_attempts >= 0),
      max_observation_attempts INTEGER NOT NULL CHECK (max_observation_attempts > 0),
      parent_effect_json TEXT NOT NULL CHECK (json_valid(parent_effect_json) = 1),
      last_error TEXT,
      terminal_failure_reason TEXT,
      terminal_retry_policy TEXT CHECK (terminal_retry_policy IN (
        'retryable', 'retry_budget_exhausted', 'operator_required', 'cancelled', 'data_error'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (logical_operation_id, operation_revision),
      CHECK ((state = 'leased') =
        (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
      CHECK (
        kind != 'WorkflowStart' OR state NOT IN ('failed', 'cancelled', 'data_error') OR
        (terminal_failure_reason IS NOT NULL AND terminal_retry_policy IS NOT NULL)
      ),
      CHECK (
        kind != 'WorkflowStart' OR state != 'waiting_human' OR
        (terminal_failure_reason IS NOT NULL AND terminal_retry_policy = 'operator_required')
      ),
      CHECK (terminal_retry_policy != 'retryable' OR state = 'failed')
    ) STRICT
  `
  yield* sql`
    CREATE UNIQUE INDEX workflow_operations_current
    ON workflow_operations (logical_operation_id) WHERE is_current = 1
  `
  yield* sql`
    CREATE INDEX workflow_operations_claimable
    ON workflow_operations (state, run_at, lease_until, operation_id)
  `
  yield* sql`
    CREATE TABLE workflow_operation_gates (
      operation_id TEXT PRIMARY KEY REFERENCES workflow_operations (operation_id),
      state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'cancelled')),
      reason TEXT NOT NULL CHECK (length(reason) > 0),
      created_at TEXT NOT NULL
    ) STRICT
  `
  yield* sql`
    CREATE TABLE qrspi_generations (
      workflow_id TEXT NOT NULL REFERENCES qrspi_workflows (workflow_id),
      generation INTEGER NOT NULL CHECK (generation > 0),
      repository_json TEXT NOT NULL CHECK (
        json_valid(repository_json) = 1 AND json_type(repository_json, '$') = 'object'
      ),
      base_ref TEXT NOT NULL CHECK (length(base_ref) > 0),
      base_sha TEXT NOT NULL CHECK (length(base_sha) IN (40, 64)),
      head_ref TEXT NOT NULL CHECK (length(head_ref) > 0),
      root_sha TEXT NOT NULL CHECK (length(root_sha) IN (40, 64)),
      current_head_sha TEXT NOT NULL CHECK (length(current_head_sha) IN (40, 64)),
      ticket_revision_sha256 TEXT NOT NULL,
      workflow_definition_sha256 TEXT NOT NULL
        REFERENCES qrspi_workflow_definitions (definition_sha256),
      state TEXT NOT NULL CHECK (state IN (
        'running', 'waiting_ticket', 'waiting_human', 'reconciling', 'finalizing',
        'completed', 'rejected', 'cancelled', 'failed', 'superseded'
      )),
      is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workflow_id, generation),
      FOREIGN KEY (workflow_id, ticket_revision_sha256)
        REFERENCES qrspi_ticket_revisions (workflow_id, ticket_revision_sha256)
    ) STRICT
  `
  yield* sql`
    CREATE UNIQUE INDEX qrspi_generations_current
    ON qrspi_generations (workflow_id) WHERE is_current = 1
  `
})

const fixPublicationSigningEvidence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE jobs ADD COLUMN controller_signing_fingerprint TEXT CHECK (
      controller_signing_fingerprint IS NULL OR (
        length(controller_signing_fingerprint) IN (40, 64)
        AND controller_signing_fingerprint NOT GLOB '*[^0-9a-fA-F]*'
      )
    )
  `
})

const reconciliationObservationWatermark = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE reconciliations ADD COLUMN observation_received_at TEXT`
  yield* sql`
    UPDATE reconciliations
    SET observation_received_at = created_at
  `
})

export const reconciliationObservationSequence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE webhook_deliveries ADD COLUMN observation_sequence INTEGER`
  yield* sql`UPDATE webhook_deliveries SET observation_sequence = rowid`
  yield* sql`
    CREATE UNIQUE INDEX webhook_deliveries_observation_sequence
    ON webhook_deliveries (observation_sequence)
  `
  yield* sql`ALTER TABLE reconciliations ADD COLUMN observation_sequence INTEGER`
  yield* sql`
    UPDATE reconciliations
    SET
      observation_received_at = updated_at,
      observation_sequence = COALESCE(
        (SELECT MAX(observation_sequence) FROM webhook_deliveries),
        0
      )
  `
})

export const runStoreMigrations = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_initial_schema": initialSchema,
    "0002_agent_harness": agentHarnessSchema,
    "0003_agent_session_cleanup_leases": agentSessionCleanupLeases,
    "0004_agent_session_recovery_and_payload_envelopes": agentSessionRecoveryAndPayloadEnvelopes,
    "0005_qrspi_workflow_start": qrspiWorkflowStart,
    "0006_fix_publication_signing_evidence": fixPublicationSigningEvidence,
    "0007_reconciliation_observation_watermark": reconciliationObservationWatermark,
    "0008_reconciliation_observation_sequence": reconciliationObservationSequence,
  }),
})
