import { Migrator, SqlClient } from "effect/unstable/sql"
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

const qrspiStageDefinitions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE qrspi_stage_definitions (
      stage_definition_sha256 TEXT NOT NULL CHECK (
        length(stage_definition_sha256) = 64
          AND stage_definition_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      workflow_definition_sha256 TEXT NOT NULL
        REFERENCES qrspi_workflow_definitions (definition_sha256),
      stage_key TEXT NOT NULL CHECK (length(stage_key) BETWEEN 1 AND 64),
      sequence_position INTEGER NOT NULL CHECK (sequence_position > 0),
      definition_json TEXT NOT NULL CHECK (
        json_valid(definition_json) = 1 AND json_type(definition_json, '$') = 'object'
      ),
      contract_name TEXT NOT NULL,
      contract_version INTEGER NOT NULL CHECK (contract_version > 0),
      contract_registration_sha256 TEXT NOT NULL CHECK (
        length(contract_registration_sha256) = 64
          AND contract_registration_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      harness_name TEXT NOT NULL,
      harness_version INTEGER NOT NULL CHECK (harness_version > 0),
      harness_registration_sha256 TEXT NOT NULL CHECK (
        length(harness_registration_sha256) = 64
          AND harness_registration_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL,
      PRIMARY KEY (workflow_definition_sha256, stage_definition_sha256),
      UNIQUE (workflow_definition_sha256, stage_key),
      UNIQUE (workflow_definition_sha256, sequence_position)
    ) STRICT
  `
})

const qrspiGenerationFormat = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE qrspi_generations
    ADD COLUMN generation_format TEXT NOT NULL DEFAULT 'legacy'
      CHECK (generation_format IN ('legacy', 'stage_snapshots_v1'))
  `
})

const kernelEventWaitStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE kernel_workflow_instances (
      instance_id TEXT PRIMARY KEY CHECK (
        length(CAST(instance_id AS BLOB)) BETWEEN 1 AND 256
      ),
      workflow_type TEXT NOT NULL CHECK (
        length(CAST(workflow_type AS BLOB)) BETWEEN 1 AND 128
      ),
      workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
      workflow_key TEXT NOT NULL CHECK (
        length(CAST(workflow_key AS BLOB)) BETWEEN 1 AND 256
      ),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) = 1
          AND length(CAST(payload_json AS BLOB)) BETWEEN 1 AND 65536
      ),
      event_cursor INTEGER NOT NULL CHECK (event_cursor >= 0),
      created_at TEXT NOT NULL
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_events (
      sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
      source TEXT NOT NULL CHECK (
        length(CAST(source AS BLOB)) BETWEEN 1 AND 128
      ),
      source_event_id TEXT NOT NULL CHECK (
        length(CAST(source_event_id AS BLOB)) BETWEEN 1 AND 256
      ),
      event_type TEXT NOT NULL CHECK (
        length(CAST(event_type AS BLOB)) BETWEEN 1 AND 128
      ),
      event_version INTEGER NOT NULL CHECK (event_version > 0),
      event_key TEXT NOT NULL CHECK (
        length(CAST(event_key AS BLOB)) BETWEEN 1 AND 256
      ),
      correlation TEXT NOT NULL CHECK (
        length(CAST(correlation AS BLOB)) BETWEEN 1 AND 256
      ),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) = 1
          AND length(CAST(payload_json AS BLOB)) BETWEEN 1 AND 65536
      ),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (source, source_event_id)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_waits (
      instance_id TEXT NOT NULL REFERENCES kernel_workflow_instances (instance_id),
      wait_id TEXT NOT NULL CHECK (
        length(CAST(wait_id AS BLOB)) BETWEEN 1 AND 256
      ),
      event_type TEXT NOT NULL CHECK (
        length(CAST(event_type AS BLOB)) BETWEEN 1 AND 128
      ),
      event_version INTEGER NOT NULL CHECK (event_version > 0),
      event_key TEXT NOT NULL CHECK (
        length(CAST(event_key AS BLOB)) BETWEEN 1 AND 256
      ),
      correlation TEXT NOT NULL CHECK (
        length(CAST(correlation AS BLOB)) BETWEEN 1 AND 256
      ),
      after_sequence INTEGER NOT NULL CHECK (after_sequence >= 0),
      state TEXT NOT NULL CHECK (state IN (
        'pending', 'matched', 'consumed', 'cancelled'
      )),
      registered_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, wait_id)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_wait_event_deliveries (
      instance_id TEXT NOT NULL,
      wait_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
      state TEXT NOT NULL CHECK (state IN ('ready', 'consumed', 'cancelled')),
      delivered_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, wait_id),
      FOREIGN KEY (instance_id, wait_id)
        REFERENCES kernel_waits (instance_id, wait_id),
      FOREIGN KEY (event_sequence) REFERENCES kernel_events (sequence)
    ) STRICT
  `
  yield* sql`
    CREATE UNIQUE INDEX kernel_waits_active
    ON kernel_waits (instance_id) WHERE state IN ('pending', 'matched')
  `
  yield* sql`
    CREATE INDEX kernel_events_match
    ON kernel_events (event_type, event_version, event_key, correlation, sequence)
  `
  yield* sql`
    CREATE INDEX kernel_waits_match
    ON kernel_waits (
      state, event_type, event_version, event_key, correlation, after_sequence
    )
  `
  yield* sql`
    CREATE INDEX kernel_deliveries_ready
    ON kernel_wait_event_deliveries (instance_id, event_sequence, wait_id)
    WHERE state = 'ready'
  `
  yield* sql`
    CREATE TRIGGER kernel_events_immutable_insert
    BEFORE INSERT ON kernel_events
    WHEN EXISTS (
      SELECT 1 FROM kernel_events AS existing
      WHERE existing.source = NEW.source
        AND existing.source_event_id = NEW.source_event_id
        AND NOT (
          existing.sequence = NEW.sequence
          AND existing.event_type = NEW.event_type
          AND existing.event_version = NEW.event_version
          AND existing.event_key = NEW.event_key
          AND existing.correlation = NEW.correlation
          AND existing.payload_json = NEW.payload_json
          AND existing.recorded_at = NEW.recorded_at
        )
    ) OR (
      EXISTS (
        SELECT 1 FROM kernel_events AS existing
        WHERE existing.sequence = NEW.sequence
        AND NOT (
          existing.source = NEW.source
          AND existing.source_event_id = NEW.source_event_id
          AND existing.event_type = NEW.event_type
          AND existing.event_version = NEW.event_version
          AND existing.event_key = NEW.event_key
          AND existing.correlation = NEW.correlation
          AND existing.payload_json = NEW.payload_json
          AND existing.recorded_at = NEW.recorded_at
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'kernel event immutable conflict');
    END
  `
  yield* sql`
    CREATE TRIGGER kernel_events_immutable_update
    BEFORE UPDATE ON kernel_events
    BEGIN
      SELECT RAISE(ABORT, 'kernel events are immutable');
    END
  `
  yield* sql`
    CREATE TRIGGER kernel_events_immutable_delete
    BEFORE DELETE ON kernel_events
    BEGIN
      SELECT RAISE(ABORT, 'kernel events are immutable');
    END
  `
})

const kernelWorkflowJobs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE kernel_workflow_jobs (
      job_id TEXT PRIMARY KEY CHECK (length(CAST(job_id AS BLOB)) BETWEEN 1 AND 256),
      instance_id TEXT NOT NULL REFERENCES kernel_workflow_instances (instance_id),
      wait_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
      expected_cursor INTEGER NOT NULL CHECK (expected_cursor >= 0),
      input_version INTEGER NOT NULL CHECK (input_version > 0),
      input_json TEXT NOT NULL CHECK (
        json_valid(input_json) = 1
          AND length(CAST(input_json AS BLOB)) BETWEEN 1 AND 65536
      ),
      state TEXT NOT NULL CHECK (state IN (
        'ready', 'leased', 'retry_scheduled', 'succeeded', 'failed', 'operator_required',
        'data_error'
      )),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= max_attempts),
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      run_at TEXT NOT NULL,
      lease_worker_id TEXT,
      claim_token TEXT,
      lease_until TEXT,
      failure_category TEXT CHECK (failure_category IN (
        'transient', 'permanent', 'operator_required', 'data_error'
      )),
      failure_version INTEGER CHECK (failure_version IS NULL OR failure_version > 0),
      failure_json TEXT CHECK (
        failure_json IS NULL OR (
          json_valid(failure_json) = 1
            AND length(CAST(failure_json AS BLOB)) BETWEEN 1 AND 65536
        )
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (instance_id, wait_id)
        REFERENCES kernel_waits (instance_id, wait_id),
      FOREIGN KEY (event_sequence) REFERENCES kernel_events (sequence),
      CHECK (
        (state = 'leased' AND lease_worker_id IS NOT NULL
          AND claim_token IS NOT NULL AND lease_until IS NOT NULL)
        OR
        (state <> 'leased' AND lease_worker_id IS NULL
          AND claim_token IS NULL AND lease_until IS NULL)
      ),
      CHECK (
        (failure_json IS NULL AND failure_category IS NULL AND failure_version IS NULL)
        OR
        (failure_json IS NOT NULL AND failure_category IS NOT NULL AND failure_version IS NOT NULL)
      )
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_workflow_job_results (
      result_id TEXT PRIMARY KEY CHECK (
        length(CAST(result_id AS BLOB)) BETWEEN 1 AND 256
      ),
      job_id TEXT NOT NULL UNIQUE REFERENCES kernel_workflow_jobs (job_id),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      worker_id TEXT NOT NULL CHECK (length(CAST(worker_id AS BLOB)) BETWEEN 1 AND 256),
      claim_token TEXT NOT NULL CHECK (length(CAST(claim_token AS BLOB)) BETWEEN 1 AND 256),
      lease_until TEXT NOT NULL,
      result_version INTEGER NOT NULL CHECK (result_version > 0),
      result_json TEXT NOT NULL CHECK (
        json_valid(result_json) = 1
          AND length(CAST(result_json AS BLOB)) BETWEEN 1 AND 65536
      ),
      completed_at TEXT NOT NULL
    ) STRICT
  `
  yield* sql`
    CREATE INDEX kernel_workflow_jobs_claimable
    ON kernel_workflow_jobs (state, run_at, lease_until, job_id)
    WHERE state IN ('ready', 'retry_scheduled', 'leased')
  `
})

const kernelSessionStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE kernel_working_resources (
      resource_id TEXT PRIMARY KEY CHECK (length(CAST(resource_id AS BLOB)) BETWEEN 1 AND 256),
      owning_host_id TEXT NOT NULL CHECK (length(CAST(owning_host_id AS BLOB)) BETWEEN 1 AND 256),
      absolute_path TEXT NOT NULL CHECK (
        length(CAST(absolute_path AS BLOB)) BETWEEN 1 AND 4096
          AND substr(absolute_path, 1, 1) = '/'
          AND absolute_path NOT GLOB '*/../*' AND absolute_path NOT GLOB '*/./*'
          AND absolute_path NOT GLOB '*/..' AND absolute_path NOT GLOB '*/.'
          AND (absolute_path = '/' OR substr(absolute_path, -1) <> '/')
      ),
      kind TEXT NOT NULL CHECK (kind IN ('workspace', 'worktree', 'checkout')),
      state TEXT NOT NULL CHECK (state IN (
        'reserved', 'cleanup_required', 'cleanup_leased', 'cleaned', 'missing', 'operator_required', 'data_error'
      )),
      cleanup_reason TEXT,
      cleanup_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (resource_id, owning_host_id),
      UNIQUE (owning_host_id, absolute_path),
      CHECK (state NOT IN ('cleanup_required', 'cleanup_leased', 'operator_required', 'data_error')
        OR cleanup_reason IS NOT NULL),
      CHECK (cleanup_error IS NULL OR state IN ('operator_required', 'data_error'))
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_sessions (
      session_id TEXT PRIMARY KEY CHECK (length(CAST(session_id AS BLOB)) BETWEEN 1 AND 256),
      provider_kind TEXT NOT NULL CHECK (provider_kind IN ('opencode', 'codex', 'claude')),
      provider_version INTEGER NOT NULL CHECK (provider_version > 0),
      provider_id TEXT NOT NULL CHECK (length(CAST(provider_id AS BLOB)) BETWEEN 1 AND 256),
      server_id TEXT NOT NULL CHECK (length(CAST(server_id AS BLOB)) BETWEEN 1 AND 256),
      owning_host_id TEXT NOT NULL CHECK (length(CAST(owning_host_id AS BLOB)) BETWEEN 1 AND 256),
      endpoint_alias TEXT NOT NULL CHECK (length(CAST(endpoint_alias AS BLOB)) BETWEEN 1 AND 256),
      endpoint_identity TEXT NOT NULL CHECK (length(CAST(endpoint_identity AS BLOB)) BETWEEN 1 AND 512),
      native_session_id TEXT NOT NULL CHECK (length(CAST(native_session_id AS BLOB)) BETWEEN 1 AND 256),
      resource_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'ready', 'active', 'completed', 'missing', 'cleanup_required', 'cleaned',
        'operator_required', 'data_error'
      )),
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (session_id, owning_host_id),
      FOREIGN KEY (resource_id, owning_host_id)
        REFERENCES kernel_working_resources (resource_id, owning_host_id)
    ) STRICT
  `
  yield* sql`CREATE UNIQUE INDEX kernel_sessions_active_native ON kernel_sessions (
    provider_kind, provider_id, server_id, endpoint_identity, native_session_id
  ) WHERE state IN ('ready', 'active')`
  yield* sql`
    CREATE TABLE kernel_resume_requests (
      request_id TEXT PRIMARY KEY CHECK (length(CAST(request_id AS BLOB)) BETWEEN 1 AND 256),
      session_id TEXT NOT NULL,
      owning_host_id TEXT NOT NULL CHECK (length(CAST(owning_host_id AS BLOB)) BETWEEN 1 AND 256),
      prompt_json TEXT NOT NULL CHECK (
        json_valid(prompt_json) = 1 AND length(CAST(prompt_json AS BLOB)) BETWEEN 1 AND 65536
      ),
      prompt_text TEXT NOT NULL CHECK (length(CAST(prompt_text AS BLOB)) BETWEEN 1 AND 65536),
      prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'),
      output_contract TEXT CHECK (output_contract IS NULL OR length(CAST(output_contract AS BLOB)) BETWEEN 1 AND 256),
      output_contract_version INTEGER CHECK (output_contract_version IS NULL OR output_contract_version > 0),
      state TEXT NOT NULL CHECK (state IN (
        'ready', 'leased', 'sent', 'observation_required', 'completed', 'failed', 'cancelled',
        'operator_required', 'data_error'
      )),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= max_attempts),
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      run_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (request_id, owning_host_id),
      CHECK ((output_contract IS NULL) = (output_contract_version IS NULL)),
      FOREIGN KEY (session_id, owning_host_id) REFERENCES kernel_sessions (session_id, owning_host_id)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_resume_attempts (
      request_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      owning_host_id TEXT NOT NULL CHECK (length(CAST(owning_host_id AS BLOB)) BETWEEN 1 AND 256),
      worker_id TEXT NOT NULL CHECK (length(CAST(worker_id AS BLOB)) BETWEEN 1 AND 256),
      claim_token TEXT NOT NULL CHECK (length(CAST(claim_token AS BLOB)) BETWEEN 1 AND 256),
      lease_until TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'leased', 'sent', 'observation_required', 'completed', 'failed', 'cancelled', 'released',
        'operator_required', 'data_error'
      )),
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (request_id, attempt),
      UNIQUE (request_id, attempt, owning_host_id),
      CHECK ((state = 'leased' AND sent_at IS NULL) OR (state <> 'leased' AND sent_at IS NOT NULL)
        OR state IN ('failed', 'cancelled', 'released')),
      FOREIGN KEY (request_id, owning_host_id)
        REFERENCES kernel_resume_requests (request_id, owning_host_id)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_resume_checkpoints (
      checkpoint_id TEXT PRIMARY KEY CHECK (length(CAST(checkpoint_id AS BLOB)) BETWEEN 1 AND 256),
      request_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      checkpoint_version INTEGER NOT NULL CHECK (checkpoint_version > 0),
      checkpoint_json TEXT NOT NULL CHECK (
        json_valid(checkpoint_json) = 1 AND length(CAST(checkpoint_json AS BLOB)) BETWEEN 1 AND 65536
      ),
      created_at TEXT NOT NULL,
      FOREIGN KEY (request_id, attempt) REFERENCES kernel_resume_attempts (request_id, attempt)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_resume_results (
      result_id TEXT PRIMARY KEY CHECK (length(CAST(result_id AS BLOB)) BETWEEN 1 AND 256),
      request_id TEXT NOT NULL UNIQUE,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      result_version INTEGER NOT NULL CHECK (result_version > 0),
      result_json TEXT NOT NULL CHECK (
        json_valid(result_json) = 1 AND length(CAST(result_json AS BLOB)) BETWEEN 1 AND 65536
      ),
      completed_at TEXT NOT NULL,
      FOREIGN KEY (request_id, attempt) REFERENCES kernel_resume_attempts (request_id, attempt)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_resume_observations (
      observation_id TEXT PRIMARY KEY CHECK (length(CAST(observation_id AS BLOB)) BETWEEN 1 AND 256),
      request_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      observer_host_id TEXT NOT NULL CHECK (length(CAST(observer_host_id AS BLOB)) BETWEEN 1 AND 256),
      observer_worker_id TEXT NOT NULL CHECK (length(CAST(observer_worker_id AS BLOB)) BETWEEN 1 AND 256),
      observer_token TEXT NOT NULL CHECK (length(CAST(observer_token AS BLOB)) BETWEEN 1 AND 256),
      disposition TEXT NOT NULL CHECK (disposition IN ('completed', 'missing', 'failed', 'operator_required')),
      evidence_version INTEGER NOT NULL CHECK (evidence_version > 0),
      evidence_json TEXT NOT NULL CHECK (
        json_valid(evidence_json) = 1 AND length(CAST(evidence_json AS BLOB)) BETWEEN 1 AND 65536
      ),
      observed_at TEXT NOT NULL,
      FOREIGN KEY (request_id, attempt) REFERENCES kernel_resume_attempts (request_id, attempt)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_cleanup_requests (
      cleanup_id TEXT PRIMARY KEY CHECK (length(CAST(cleanup_id AS BLOB)) BETWEEN 1 AND 256),
      resource_id TEXT NOT NULL UNIQUE,
      owning_host_id TEXT NOT NULL CHECK (length(CAST(owning_host_id AS BLOB)) BETWEEN 1 AND 256),
      reason TEXT NOT NULL CHECK (length(CAST(reason AS BLOB)) BETWEEN 1 AND 4096),
      state TEXT NOT NULL CHECK (state IN (
        'pending', 'leased', 'completed', 'missing', 'retry_scheduled', 'operator_required', 'data_error'
      )),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= max_attempts),
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      run_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (cleanup_id, owning_host_id),
      FOREIGN KEY (resource_id, owning_host_id)
        REFERENCES kernel_working_resources (resource_id, owning_host_id)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_cleanup_outcomes (
      outcome_id TEXT PRIMARY KEY CHECK (length(CAST(outcome_id AS BLOB)) BETWEEN 1 AND 256),
      cleanup_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      owning_host_id TEXT NOT NULL CHECK (length(CAST(owning_host_id AS BLOB)) BETWEEN 1 AND 256),
      worker_id TEXT NOT NULL CHECK (length(CAST(worker_id AS BLOB)) BETWEEN 1 AND 256),
      claim_token TEXT NOT NULL CHECK (length(CAST(claim_token AS BLOB)) BETWEEN 1 AND 256),
      lease_until TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('completed', 'missing', 'retry', 'operator_required')),
      outcome_version INTEGER NOT NULL CHECK (outcome_version > 0),
      outcome_json TEXT NOT NULL CHECK (
        json_valid(outcome_json) = 1 AND length(CAST(outcome_json AS BLOB)) BETWEEN 1 AND 65536
      ),
      completed_at TEXT NOT NULL,
      FOREIGN KEY (cleanup_id, attempt, owning_host_id)
        REFERENCES kernel_cleanup_attempts (cleanup_id, attempt, owning_host_id)
    ) STRICT
  `
  yield* sql`
    CREATE TABLE kernel_cleanup_attempts (
      cleanup_id TEXT NOT NULL REFERENCES kernel_cleanup_requests (cleanup_id),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      owning_host_id TEXT NOT NULL CHECK (length(CAST(owning_host_id AS BLOB)) BETWEEN 1 AND 256),
      worker_id TEXT NOT NULL CHECK (length(CAST(worker_id AS BLOB)) BETWEEN 1 AND 256),
      claim_token TEXT NOT NULL CHECK (length(CAST(claim_token AS BLOB)) BETWEEN 1 AND 256),
      lease_until TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('leased', 'completed', 'missing', 'retry', 'operator_required')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (cleanup_id, attempt),
      UNIQUE (cleanup_id, attempt, owning_host_id),
      FOREIGN KEY (cleanup_id, owning_host_id)
        REFERENCES kernel_cleanup_requests (cleanup_id, owning_host_id)
    ) STRICT
  `
  yield* sql`CREATE INDEX kernel_resume_requests_claimable
    ON kernel_resume_requests (state, run_at, request_id)
    WHERE state IN ('ready', 'leased', 'sent', 'observation_required')`
  yield* sql`CREATE INDEX kernel_cleanup_requests_claimable
    ON kernel_cleanup_requests (state, run_at, cleanup_id)
    WHERE state IN ('pending', 'leased', 'retry_scheduled')`
  yield* sql`CREATE UNIQUE INDEX kernel_cleanup_outcomes_attempt
    ON kernel_cleanup_outcomes (cleanup_id, attempt)`
  yield* sql`CREATE UNIQUE INDEX kernel_resume_observations_attempt
    ON kernel_resume_observations (request_id, attempt)`
})

const kernelAgentHandoff = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE kernel_agent_completion_watches (
      instance_id TEXT PRIMARY KEY REFERENCES kernel_workflow_instances (instance_id),
      wait_id TEXT NOT NULL CHECK (length(CAST(wait_id AS BLOB)) BETWEEN 1 AND 256),
      child_session_id TEXT NOT NULL REFERENCES kernel_sessions (session_id),
      child_session_generation INTEGER NOT NULL CHECK (child_session_generation > 0),
      provider_kind TEXT NOT NULL CHECK (provider_kind IN ('opencode', 'codex', 'claude')),
      provider_version INTEGER NOT NULL CHECK (provider_version > 0),
      provider_id TEXT NOT NULL CHECK (length(CAST(provider_id AS BLOB)) BETWEEN 1 AND 256),
      server_id TEXT NOT NULL CHECK (length(CAST(server_id AS BLOB)) BETWEEN 1 AND 256),
      owning_host_id TEXT NOT NULL CHECK (length(CAST(owning_host_id AS BLOB)) BETWEEN 1 AND 256),
      endpoint_alias TEXT NOT NULL CHECK (length(CAST(endpoint_alias AS BLOB)) BETWEEN 1 AND 256),
      endpoint_identity TEXT NOT NULL CHECK (length(CAST(endpoint_identity AS BLOB)) BETWEEN 1 AND 512),
      native_session_id TEXT NOT NULL CHECK (length(CAST(native_session_id AS BLOB)) BETWEEN 1 AND 256),
      resource_id TEXT NOT NULL REFERENCES kernel_working_resources (resource_id),
      baseline_version INTEGER NOT NULL CHECK (baseline_version > 0),
      baseline_json TEXT NOT NULL CHECK (
        json_valid(baseline_json) = 1 AND length(CAST(baseline_json AS BLOB)) BETWEEN 1 AND 65536
      ),
      state TEXT NOT NULL CHECK (state IN ('watching', 'completed', 'operator_required', 'data_error')),
      completion_event_sequence INTEGER REFERENCES kernel_events (sequence),
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (instance_id, wait_id),
      CHECK ((state = 'completed') = (completion_event_sequence IS NOT NULL))
    ) STRICT
  `
  yield* sql`CREATE INDEX kernel_agent_completion_watches_active
    ON kernel_agent_completion_watches (provider_kind, owning_host_id, state, registered_at)
    WHERE state = 'watching'`
})

const kernelRemoteDispatch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE kernel_remote_dispatches (
      command_id TEXT PRIMARY KEY CHECK (length(CAST(command_id AS BLOB)) BETWEEN 1 AND 256),
      job_id TEXT NOT NULL REFERENCES kernel_workflow_jobs (job_id),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      generation INTEGER NOT NULL CHECK (generation > 0),
      host_id TEXT NOT NULL CHECK (
        length(host_id) BETWEEN 1 AND 64 AND host_id NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      worker_id TEXT NOT NULL CHECK (length(CAST(worker_id AS BLOB)) BETWEEN 1 AND 256),
      claim_token TEXT NOT NULL CHECK (length(CAST(claim_token AS BLOB)) BETWEEN 1 AND 256),
      lease_until TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'prepared', 'publishing', 'published', 'completed', 'superseded', 'cancelled'
      )),
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      publish_started_at TEXT,
      published_at TEXT,
      completed_at TEXT,
      UNIQUE (job_id, attempt),
      UNIQUE (job_id, generation),
      CHECK (state != 'prepared' OR publish_started_at IS NULL),
      CHECK (state NOT IN ('publishing', 'published', 'completed')
        OR publish_started_at IS NOT NULL),
      CHECK (state != 'published' OR published_at IS NOT NULL),
      CHECK ((state = 'completed') = (completed_at IS NOT NULL))
    ) STRICT
  `
  yield* sql`CREATE INDEX kernel_remote_dispatch_pending
    ON kernel_remote_dispatches (state, issued_at, command_id)
    WHERE state IN ('prepared', 'publishing', 'published')`
  yield* sql`
    CREATE TABLE kernel_remote_result_inbox (
      delivery_id TEXT PRIMARY KEY CHECK (length(CAST(delivery_id AS BLOB)) BETWEEN 1 AND 256),
      result_id TEXT,
      command_id TEXT,
      disposition TEXT NOT NULL CHECK (disposition IN (
        'accepted', 'duplicate', 'malformed', 'oversized', 'wrong_host', 'stale',
        'expired', 'conflict'
      )),
      payload_sha256 TEXT NOT NULL CHECK (
        length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
      received_at TEXT NOT NULL
    ) STRICT
  `
  yield* sql`CREATE INDEX kernel_remote_result_inbox_result
    ON kernel_remote_result_inbox (result_id, received_at)`
})

const kernelRemoteCancellationOutbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE kernel_remote_cancellation_outbox (
      command_id TEXT PRIMARY KEY REFERENCES kernel_remote_dispatches (command_id),
      job_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      host_id TEXT NOT NULL CHECK (
        length(host_id) BETWEEN 1 AND 64 AND host_id NOT GLOB '*[^A-Za-z0-9_-]*'
      ),
      issued_at TEXT NOT NULL,
      published_at TEXT
    ) STRICT
  `
  yield* sql`CREATE INDEX kernel_remote_cancellation_outbox_pending
    ON kernel_remote_cancellation_outbox (issued_at, command_id)
    WHERE published_at IS NULL`
})

const removeAgentCompletionBaseline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP INDEX kernel_agent_completion_watches_active`
  yield* sql`ALTER TABLE kernel_agent_completion_watches RENAME TO kernel_agent_completion_watches_old`
  yield* sql`
    CREATE TABLE kernel_agent_completion_watches (
      instance_id TEXT PRIMARY KEY REFERENCES kernel_workflow_instances (instance_id),
      wait_id TEXT NOT NULL CHECK (length(CAST(wait_id AS BLOB)) BETWEEN 1 AND 256),
      child_session_id TEXT NOT NULL REFERENCES kernel_sessions (session_id),
      child_session_generation INTEGER NOT NULL CHECK (child_session_generation > 0),
      provider_kind TEXT NOT NULL CHECK (provider_kind IN ('opencode', 'codex', 'claude')),
      provider_version INTEGER NOT NULL CHECK (provider_version > 0),
      provider_id TEXT NOT NULL CHECK (length(CAST(provider_id AS BLOB)) BETWEEN 1 AND 256),
      server_id TEXT NOT NULL CHECK (length(CAST(server_id AS BLOB)) BETWEEN 1 AND 256),
      owning_host_id TEXT NOT NULL CHECK (length(CAST(owning_host_id AS BLOB)) BETWEEN 1 AND 256),
      endpoint_alias TEXT NOT NULL CHECK (length(CAST(endpoint_alias AS BLOB)) BETWEEN 1 AND 256),
      endpoint_identity TEXT NOT NULL CHECK (length(CAST(endpoint_identity AS BLOB)) BETWEEN 1 AND 512),
      native_session_id TEXT NOT NULL CHECK (length(CAST(native_session_id AS BLOB)) BETWEEN 1 AND 256),
      resource_id TEXT NOT NULL REFERENCES kernel_working_resources (resource_id),
      state TEXT NOT NULL CHECK (state IN ('watching', 'completed', 'operator_required', 'data_error')),
      completion_event_sequence INTEGER REFERENCES kernel_events (sequence),
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (instance_id, wait_id),
      CHECK ((state = 'completed') = (completion_event_sequence IS NOT NULL))
    ) STRICT
  `
  yield* sql`INSERT INTO kernel_agent_completion_watches (
      instance_id, wait_id, child_session_id, child_session_generation, provider_kind,
      provider_version, provider_id, server_id, owning_host_id, endpoint_alias,
      endpoint_identity, native_session_id, resource_id, state, completion_event_sequence,
      registered_at, updated_at
    ) SELECT instance_id, wait_id, child_session_id, child_session_generation, provider_kind,
      provider_version, provider_id, server_id, owning_host_id, endpoint_alias,
      endpoint_identity, native_session_id, resource_id, state, completion_event_sequence,
      registered_at, updated_at FROM kernel_agent_completion_watches_old`
  yield* sql`DROP TABLE kernel_agent_completion_watches_old`
  yield* sql`CREATE INDEX kernel_agent_completion_watches_active
    ON kernel_agent_completion_watches (provider_kind, owning_host_id, state, registered_at)
    WHERE state = 'watching'`
})

const kernelAgentRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE kernel_agent_runs (
      run_id TEXT PRIMARY KEY CHECK (length(CAST(run_id AS BLOB)) BETWEEN 1 AND 256),
      route TEXT NOT NULL CHECK (length(CAST(route AS BLOB)) BETWEEN 1 AND 128),
      provider_id TEXT NOT NULL CHECK (length(CAST(provider_id AS BLOB)) BETWEEN 1 AND 256),
      model_id TEXT NOT NULL CHECK (length(CAST(model_id AS BLOB)) BETWEEN 1 AND 256),
      agent TEXT NOT NULL CHECK (length(CAST(agent AS BLOB)) BETWEEN 1 AND 64),
      repository TEXT NOT NULL CHECK (length(CAST(repository AS BLOB)) BETWEEN 1 AND 128),
      directory TEXT NOT NULL CHECK (length(CAST(directory AS BLOB)) BETWEEN 1 AND 4096),
      prompt TEXT NOT NULL CHECK (length(CAST(prompt AS BLOB)) BETWEEN 1 AND 32768),
      prompt_sha256 TEXT NOT NULL CHECK (
        length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      parent_session_id TEXT CHECK (
        parent_session_id IS NULL OR length(CAST(parent_session_id AS BLOB)) BETWEEN 1 AND 256
      ),
      resume_prompt TEXT CHECK (
        resume_prompt IS NULL OR length(CAST(resume_prompt AS BLOB)) BETWEEN 1 AND 32768
      ),
      resource_id TEXT REFERENCES kernel_working_resources (resource_id),
      session_id TEXT REFERENCES kernel_sessions (session_id),
      native_session_id TEXT CHECK (
        native_session_id IS NULL OR length(CAST(native_session_id AS BLOB)) BETWEEN 1 AND 256
      ),
      state TEXT NOT NULL CHECK (state IN (
        'accepted', 'spawning', 'spawned', 'verified', 'completed', 'failed', 'operator_required'
      )),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      last_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (last_output_tokens >= 0),
      last_progress_at TEXT,
      diagnostic TEXT CHECK (
        diagnostic IS NULL OR length(CAST(diagnostic AS BLOB)) BETWEEN 1 AND 4096
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((parent_session_id IS NULL) = (resume_prompt IS NULL)),
      CHECK (state NOT IN ('spawned', 'verified') OR session_id IS NOT NULL)
    ) STRICT
  `
  yield* sql`CREATE INDEX kernel_agent_runs_watchable
    ON kernel_agent_runs (state, updated_at, run_id)
    WHERE state IN ('accepted', 'spawning', 'spawned', 'verified')`
})

const migrationsThrough0008 = {
  "0001_initial_schema": initialSchema,
  "0002_agent_harness": agentHarnessSchema,
  "0003_agent_session_cleanup_leases": agentSessionCleanupLeases,
  "0004_agent_session_recovery_and_payload_envelopes": agentSessionRecoveryAndPayloadEnvelopes,
  "0005_qrspi_workflow_start": qrspiWorkflowStart,
  "0006_fix_publication_signing_evidence": fixPublicationSigningEvidence,
  "0007_reconciliation_observation_watermark": reconciliationObservationWatermark,
  "0008_reconciliation_observation_sequence": reconciliationObservationSequence,
}

export const runStoreMigrationsThrough0008 = Migrator.make({})({
  loader: Migrator.fromRecord(migrationsThrough0008),
})

const migrationsThrough0010 = {
  ...migrationsThrough0008,
  "0009_qrspi_stage_definitions": qrspiStageDefinitions,
  "0010_qrspi_generation_format": qrspiGenerationFormat,
}

export const runStoreMigrationsThrough0010 = Migrator.make({})({
  loader: Migrator.fromRecord(migrationsThrough0010),
})

const migrationsThrough0011 = {
  ...migrationsThrough0010,
  "0011_kernel_event_wait_store": kernelEventWaitStore,
}

export const runStoreMigrationsThrough0011 = Migrator.make({})({
  loader: Migrator.fromRecord(migrationsThrough0011),
})

const migrationsThrough0012 = {
  ...migrationsThrough0011,
  "0012_kernel_workflow_jobs": kernelWorkflowJobs,
}

export const runStoreMigrationsThrough0012 = Migrator.make({})({
  loader: Migrator.fromRecord(migrationsThrough0012),
})

const migrationsThrough0016 = {
  ...migrationsThrough0012,
  "0013_kernel_session_store": kernelSessionStore,
  "0014_kernel_agent_handoff": kernelAgentHandoff,
  "0015_kernel_remote_dispatch": kernelRemoteDispatch,
  "0016_kernel_remote_cancellation_outbox": kernelRemoteCancellationOutbox,
}

export const runStoreMigrationsThrough0016 = Migrator.make({})({
  loader: Migrator.fromRecord(migrationsThrough0016),
})

export const runStoreMigrations = Migrator.make({})({
  loader: Migrator.fromRecord({
    ...migrationsThrough0016,
    "0017_remove_agent_completion_baseline": removeAgentCompletionBaseline,
    "0018_kernel_agent_runs": kernelAgentRuns,
  }),
})
