# Alpha.6 development evidence traces

> **Historical evaluation record.** These traces describe the Alpha.6 corpus, development judgments, and retrieval behavior before the 0.1.0-beta.1 lexical IDF change.

These are development traces, not independent judgments. L/S/H are ordinal lexical/semantic/hybrid ranks. Cosine is an internal similarity diagnostic, never sufficiency. Full exact text and provenance are bound in the chunk manifest (`tests/fixtures/evidence/chunks.json`); grades and task requirements are in the judgment overlay (`tests/fixtures/evidence/judgments.json`). The report includes the union of channel top-five chunks and explicitly judged chunks, including low-ranked expected evidence. Missing lexical rank means no positive lexical score.
## exact-symbol-2: normalizeAppend

Requirement: Locate the normalizeAppend implementation.

Development corpus judgment: **supported**. Sufficient alternatives (AND within a set; OR between sets): `[["normalize.ts:1"]]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| normalize.ts:1 | 2 | 1 | 1 | 1 | 0.5100 |
| migrations.md:1 | 0 | — | 2 | 2 | 0.1978 |
| uploads.md:1 | 0 | — | 3 | 3 | 0.1944 |
| rename.md:1 | 0 | — | 4 | 4 | 0.1881 |
| batching.md:1 | 0 | — | 5 | 5 | 0.1858 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):

**normalize.ts:1**

````text
export function normalizeAppend(existing: string, addition: string): string {
  // Preserve the existing content and insert exactly one separating newline.
  return existing.replace(/\n*$/, "") + "\n" + addition.replace(/^\n*/, "");
}
// This helper handles text joining, not path containment or authorization.
````
## terminology-1: expand-and-contract

Requirement: Explain expand-and-contract rollout.

Development corpus judgment: **supported**. Sufficient alternatives (AND within a set; OR between sets): `[["migrations.md:1"]]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| migrations.md:1 | 2 | 1 | 7 | 1 | 0.1349 |
| migrations.md:5 | 1 | 33 | 29 | 32 | 0.0603 |
| deploy.md:1 | 1 | 18 | 41 | 27 | 0.0388 |
| health.md:1 | 0 | 2 | 68 | 20 | -0.0554 |
| roadmap.md:1 | 0 | 3 | 9 | 2 | 0.1215 |
| alerts.md:1 | 0 | 4 | 26 | 4 | 0.0630 |
| api-keys.md:1 | 0 | 5 | 35 | 8 | 0.0532 |
| normalize.ts:1 | 0 | 36 | 1 | 5 | 0.2165 |
| leases.md:1 | 0 | — | 2 | 61 | 0.1824 |
| uploads.md:1 | 0 | 56 | 3 | 14 | 0.1454 |
| uploads.md:5 | 0 | 57 | 4 | 18 | 0.1395 |
| meetings.md:1 | 0 | 32 | 5 | 7 | 0.1389 |
| batching.md:1 | 0 | 10 | 6 | 3 | 0.1352 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):

**migrations.md:1**

````text
# Schema migration rollout

Use an expand-and-contract rollout when changing a populated table. Add a nullable column first, deploy code that writes both representations, backfill historical rows, then switch readers. Remove the old column only after earlier application versions are retired. Holding an exclusive lock for a long backfill can disrupt traffic even when the schema change itself is small.

````

**migrations.md:5**

````text
## Backfill progress

Backfills process bounded key ranges and checkpoint the last completed range. They yield between batches to reduce lock pressure. Restarting the job resumes from that checkpoint, while live writes continue populating the new representation.
````

**deploy.md:1**

````text
# Canary deployment

A new version receives a small portion of production traffic before broad rollout. Compare error rate and latency against the previous version using the same request mix. Pause or roll back when guardrails are exceeded. A canary reduces exposure but does not replace schema compatibility checks. Background workers also require a controlled version transition.
````
## conceptual-1: How are earlier chats brought back when the application starts again?

Requirement: Explain how prior chats are restored at application startup.

Development corpus judgment: **supported**. Sufficient alternatives (AND within a set; OR between sets): `[["session.md:1"]]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| session.md:1 | 2 | 43 | 1 | 10 | 0.4928 |
| session.md:5 | 1 | 44 | 6 | 14 | 0.2591 |
| session-expiry.md:1 | 1 | 64 | 2 | 18 | 0.4342 |
| cookies.md:1 | 1 | 54 | 3 | 15 | 0.3801 |
| oauth.md:1 | 0 | 1 | 19 | 3 | 0.1794 |
| backup.md:1 | 0 | 2 | 8 | 1 | 0.2526 |
| backup.md:5 | 0 | 3 | 21 | 7 | 0.1711 |
| migrations.md:1 | 0 | 4 | 16 | 5 | 0.1841 |
| oauth.md:5 | 0 | 5 | 54 | 19 | 0.0661 |
| retention.md:1 | 0 | 14 | 4 | 2 | 0.2913 |
| audit.md:1 | 0 | 16 | 5 | 6 | 0.2803 |
| migrations.md:5 | 0 | 8 | 10 | 4 | 0.2314 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):

**session.md:1**

````text
# Session durability

SessionStore serializes conversation messages to a journal before acknowledging an update. At startup the service replays committed entries to rebuild the conversation timeline. An interrupted write leaves the last acknowledged messages available. Transient typing indicators are deliberately excluded from serialized state. The journal belongs to one account and is not shared with the browser response cache.

````

**session.md:5**

````text
## Recovery verification

After replay, compare the last committed message sequence with the recorded acknowledgement. A corrupt journal stops startup rather than presenting an invented conversation. A diagnostic export can inspect sequence gaps without exposing message bodies.
````

**session-expiry.md:1**

````text
# Session expiry

Authentication sessions expire after thirty minutes of inactivity in this fictional service. A successful authenticated request extends the idle deadline. Expiry removes the login grant; it does not erase saved conversation messages. Operators can revoke all sessions for an account after a credential leak. SessionStore handles message durability separately from authentication grants.
````

**cookies.md:1**

````text
# Browser cookie policy

The login cookie uses HttpOnly, Secure and SameSite=Lax attributes. Scripts cannot inspect its opaque session identifier. The server checks the session grant on each protected request rather than trusting a client flag. Clearing a cookie logs out this browser, while a server-side revocation invalidates other devices too. Cookie policy does not restore conversation history.
````
## conceptual-3: Can a paused old worker overwrite what its replacement has done?

Requirement: Explain whether a paused former worker can overwrite a replacement.

Development corpus judgment: **supported**. Sufficient alternatives (AND within a set; OR between sets): `[["leases.md:1"]]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| leases.md:1 | 2 | 1 | 2 | 1 | 0.4245 |
| lease.sql:1 | 1 | 52 | 9 | 24 | 0.3139 |
| relevance.md:1 | 0 | 2 | 66 | 21 | -0.0038 |
| deploy.md:1 | 0 | 3 | 22 | 4 | 0.2257 |
| tokenization.md:1 | 0 | 4 | 48 | 18 | 0.0919 |
| api-keys.md:1 | 0 | 5 | 39 | 15 | 0.1534 |
| queue.md:1 | 0 | 66 | 1 | 20 | 0.4657 |
| uploads.md:1 | 0 | 37 | 3 | 11 | 0.4176 |
| migrations.md:5 | 0 | 43 | 4 | 16 | 0.4030 |
| uploads.md:5 | 0 | 38 | 5 | 14 | 0.3897 |
| atomic-save.md:1 | 0 | 10 | 6 | 2 | 0.3641 |
| migrations.md:1 | 0 | 7 | 12 | 3 | 0.2847 |
| shutdown-model.md:1 | 0 | 9 | 14 | 5 | 0.2715 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):

**leases.md:1**

````text
# Worker lease ownership

A worker claims a task using a lease with a monotonically increasing fencing token. If renewal stops, another worker may take over. Downstream writes reject older fencing tokens so a paused former owner cannot overwrite newer work. Heartbeats indicate liveness but do not by themselves guarantee exclusive ownership. Lease duration balances failover delay against renewal overhead.
````

**lease.sql:1**

````text
UPDATE task_leases
SET owner = :worker, fence = fence + 1, expires_at = :deadline
WHERE task_id = :task AND expires_at < CURRENT_TIMESTAMP
RETURNING fence;
-- Downstream writers must compare the returned fence; this update alone is not sufficient.
````
## mixed-2: OAuthCallback reject a login response from the wrong browser flow

Requirement: Explain OAuthCallback rejection of a response from the wrong browser flow.

Development corpus judgment: **supported**. Sufficient alternatives (AND within a set; OR between sets): `[["oauth.md:1"], ["callback.ts:1"]]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| oauth.md:1 | 2 | 2 | 1 | 1 | 0.6376 |
| callback.ts:1 | 2 | 33 | 2 | 9 | 0.5470 |
| oauth.md:5 | 1 | 43 | 12 | 20 | 0.1782 |
| csrf.md:1 | 1 | 56 | 3 | 16 | 0.5293 |
| http-cache.md:1 | 0 | 1 | 16 | 4 | 0.1505 |
| session.md:1 | 0 | 3 | 15 | 6 | 0.1576 |
| cookies.md:1 | 0 | 4 | 4 | 2 | 0.4211 |
| pagination.md:1 | 0 | 5 | 32 | 10 | 0.0379 |
| session-expiry.md:1 | 0 | 61 | 5 | 18 | 0.2675 |
| passwords.md:1 | 0 | 6 | 6 | 3 | 0.2527 |
| api-keys.md:1 | 0 | 10 | 7 | 5 | 0.2502 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):

**oauth.md:1**

````text
# OAuth callback

OAuthCallback verifies the returned state against a short-lived nonce stored before redirecting to the identity provider. A mismatch rejects the login attempt. The handler exchanges the authorization code once and deletes the nonce after success. Callback URLs must match the registered redirect URI. This flow establishes identity; permission checks happen later at the resource boundary.

````

**callback.ts:1**

````text
export async function OAuthCallback(request, nonces, provider) {
  const expected = await nonces.consume(request.cookie);
  if (!expected || expected !== request.state) throw new Error("Invalid state");
  return provider.exchangeCode(request.code);
}
// Consumption is atomic so the same nonce cannot establish two login grants.
````

**oauth.md:5**

````text
## Redirect registration

Register a precise callback URI for each deployment environment. Wildcard redirect destinations are not allowed in this fictional service. Changing the host or path requires updating the provider registration before deployment.
````

**csrf.md:1**

````text
# Request forgery protection

State-changing browser requests require a CSRF token tied to the current login grant. The handler also checks the request origin against an allowlist. A cookie being present is insufficient because another page may cause the browser to send it. Public read-only endpoints do not accept mutations through GET. OAuth state checks protect a different redirect boundary.
````
## noisy-1: hey I think the jobs keep failing um where do they go after all the attempts are used up

Requirement: State where jobs go when retry attempts are exhausted.

Development corpus judgment: **supported**. Sufficient alternatives (AND within a set; OR between sets): `[["queue.md:1"], ["queue-config.yaml:1"]]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| queue.md:1 | 2 | 27 | 1 | 7 | 0.5457 |
| queue-config.yaml:1 | 2 | 65 | 4 | 18 | 0.2960 |
| queue.md:5 | 1 | 47 | 9 | 16 | 0.2192 |
| uploads.md:1 | 0 | 1 | 27 | 8 | 0.1517 |
| backup.md:1 | 0 | 2 | 14 | 2 | 0.2039 |
| rate-limit.md:1 | 0 | 3 | 12 | 1 | 0.2080 |
| backup.md:5 | 0 | 4 | 18 | 5 | 0.1747 |
| meetings.md:1 | 0 | 5 | 62 | 19 | 0.0147 |
| shutdown.md:1 | 0 | 17 | 2 | 3 | 0.3743 |
| migrations.md:5 | 0 | 23 | 3 | 6 | 0.3367 |
| workers.md:1 | 0 | 52 | 5 | 14 | 0.2403 |
| uploads.md:5 | 0 | 7 | 11 | 4 | 0.2083 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):

**queue.md:1**

````text
# Job retry policy

Failed jobs return to the queue with exponential backoff and jitter. After five attempts the worker moves the job to a dead-letter queue for inspection. Permanent validation failures skip retries. A worker acknowledges a job only after durable side effects complete. Replaying a failed job requires idempotent handlers because the earlier attempt may have partly succeeded.

````

**queue-config.yaml:1**

````text
worker:
  queue: notifications
  attempts: 5
  backoff: exponential
  jitter: true
  visibility_timeout_seconds: 90
  dead_letter_queue: failed-notifications
````

**queue.md:5**

````text
## Dead-letter inspection

Operators inspect the last failure category and attempt history before replaying a dead-letter item. Correct invalid input first. Replay preserves the original event identity so idempotency still protects against duplicate side effects.
````
## negative-1: What is the boiling point of liquid neon?

Requirement: What is the boiling point of liquid neon?

Development corpus judgment: **unsupported**. Sufficient alternatives (AND within a set; OR between sets): `[]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| shutdown-model.md:1 | 0 | 1 | 44 | 7 | -0.0335 |
| meetings.md:1 | 0 | 2 | 67 | 15 | -0.0849 |
| permissions.md:1 | 0 | 3 | 49 | 11 | -0.0468 |
| backup.md:1 | 0 | 4 | 71 | 22 | -0.1146 |
| network.md:1 | 0 | 5 | 33 | 5 | -0.0187 |
| health.md:1 | 0 | 18 | 1 | 1 | 0.1630 |
| db-pool.md:1 | 0 | 35 | 2 | 3 | 0.1193 |
| deployment.yaml:1 | 0 | — | 3 | 71 | 0.1100 |
| cosine.md:1 | 0 | 34 | 4 | 4 | 0.1044 |
| pool.toml:1 | 0 | 64 | 5 | 20 | 0.0920 |
| csrf.md:1 | 0 | 14 | 12 | 2 | 0.0325 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):
## near-miss-3: What is the OAuth provider client secret for production?

Requirement: Supply the specific requested value/secret/measurement, not a general procedure.

Development corpus judgment: **unsupported**. Sufficient alternatives (AND within a set; OR between sets): `[]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| oauth.md:1 | 1 | 1 | 1 | 1 | 0.4698 |
| oauth.md:5 | 1 | 3 | 13 | 6 | 0.2100 |
| api-keys.md:1 | 1 | 7 | 5 | 5 | 0.3115 |
| csrf.md:1 | 0 | 2 | 8 | 4 | 0.2846 |
| shutdown-model.md:1 | 0 | 4 | 45 | 13 | 0.0208 |
| meetings.md:1 | 0 | 5 | 69 | 22 | -0.0595 |
| callback.ts:1 | 0 | 8 | 2 | 3 | 0.3450 |
| permissions.md:1 | 0 | 6 | 3 | 2 | 0.3225 |
| users-api.md:1 | 0 | 40 | 4 | 12 | 0.3149 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):

**oauth.md:1**

````text
# OAuth callback

OAuthCallback verifies the returned state against a short-lived nonce stored before redirecting to the identity provider. A mismatch rejects the login attempt. The handler exchanges the authorization code once and deletes the nonce after success. Callback URLs must match the registered redirect URI. This flow establishes identity; permission checks happen later at the resource boundary.

````

**oauth.md:5**

````text
## Redirect registration

Register a precise callback URI for each deployment environment. Wildcard redirect destinations are not allowed in this fictional service. Changing the host or path requires updating the provider registration before deployment.
````

**api-keys.md:1**

````text
# API key rotation

Automation clients authenticate using scoped API keys. Rotation creates a replacement credential, moves clients to it, and revokes the old key after a short overlap. Keep only key digests in storage and display the secret once. Key scopes limit actions independently of a user login session. Emergency rotation can skip the overlap when compromise is suspected.
````
## near-miss-4: What was the measured restore time in last Tuesdays backup drill?

Requirement: Supply the specific requested value/secret/measurement, not a general procedure.

Development corpus judgment: **unsupported**. Sufficient alternatives (AND within a set; OR between sets): `[]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| backup.md:1 | 1 | 1 | 2 | 1 | 0.4713 |
| backup.md:5 | 1 | 2 | 1 | 2 | 0.6632 |
| pagination.md:1 | 0 | 3 | 43 | 13 | 0.0843 |
| batching.md:1 | 0 | 4 | 52 | 19 | 0.0583 |
| incident.md:1 | 0 | 5 | 19 | 3 | 0.1650 |
| retention.md:1 | 0 | 31 | 3 | 7 | 0.3437 |
| migrations.md:5 | 0 | 28 | 4 | 5 | 0.3225 |
| passwords.md:1 | 0 | 54 | 5 | 21 | 0.3105 |
| latency.md:1 | 0 | 6 | 22 | 4 | 0.1491 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):

**backup.md:1**

````text
# Backup restoration

Nightly snapshots and archived transaction logs support point-in-time restoration. Restore into an isolated database, replay logs up to the chosen timestamp, and validate row counts before switching traffic. A completed backup job is not proof that restoration works; operators run periodic recovery drills. Backups recover deleted data, whereas replicas can faithfully copy the deletion.

````

**backup.md:5**

````text
## Recovery drill report

A quarterly drill restores the latest snapshot into a temporary database and compares checksums for selected tables. Record elapsed restoration time and the final replay position. The result informs the recovery objective instead of assuming the backup timestamp is enough.
````
## multi-relevant-1: How do retries avoid duplicate effects across payments, webhooks and queued jobs?

Requirement: Explain duplicate-effect protection for each of payments, webhooks and jobs.

Development corpus judgment: **supported**. Sufficient alternatives (AND within a set; OR between sets): `[["idempotency.md:1", "webhooks.md:1", "queue.md:1"], ["idempotency.md:1", "webhooks.md:1", "queue.md:5"]]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| idempotency.md:1 | 1 | 27 | 3 | 7 | 0.4648 |
| webhooks.md:1 | 1 | 2 | 2 | 1 | 0.4751 |
| queue.md:1 | 1 | 7 | 1 | 2 | 0.4918 |
| queue.md:5 | 1 | 10 | 10 | 5 | 0.3149 |
| outbox.md:1 | 1 | 5 | 20 | 6 | 0.2804 |
| shutdown.md:1 | 0 | 1 | 14 | 3 | 0.3029 |
| health.md:1 | 0 | 3 | 41 | 11 | 0.1735 |
| network.md:1 | 0 | 4 | 35 | 9 | 0.2055 |
| leases.md:1 | 0 | 54 | 4 | 15 | 0.3712 |
| transactions.md:1 | 0 | 66 | 5 | 20 | 0.3709 |
| workers.md:1 | 0 | 13 | 7 | 4 | 0.3464 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):

**idempotency.md:1**

````text
# Idempotent requests

Clients attach an Idempotency-Key when creating a payment. The server stores the normalized request digest and completed response with that key. A retry with the same payload receives the stored response instead of creating a second payment. Reusing the key with a different payload fails. Keys expire only after the advertised retry window has elapsed.
````

**webhooks.md:1**

````text
# Webhook delivery

Outgoing webhooks include an event ID and a signature over the exact body bytes. Receivers verify the signature and remember event IDs to handle duplicate deliveries. Temporary failures retry with increasing delays. A successful HTTP status acknowledges transport; it does not prove every downstream workflow completed. Rotating signing secrets permits a bounded overlap.
````

**queue.md:1**

````text
# Job retry policy

Failed jobs return to the queue with exponential backoff and jitter. After five attempts the worker moves the job to a dead-letter queue for inspection. Permanent validation failures skip retries. A worker acknowledges a job only after durable side effects complete. Replaying a failed job requires idempotent handlers because the earlier attempt may have partly succeeded.

````

**queue.md:5**

````text
## Dead-letter inspection

Operators inspect the last failure category and attempt history before replaying a dead-letter item. Correct invalid input first. Replay preserves the original event identity so idempotency still protects against duplicate side effects.
````

**outbox.md:1**

````text
# Transactional outbox

The service records a domain change and an outgoing event in the same transaction. A separate publisher delivers outbox entries and marks successful delivery. A crash between delivery and marking can produce a duplicate, so consumers deduplicate event IDs. This avoids losing a notification when the database commits but the message broker is temporarily unavailable.
````
## multi-relevant-5: How can persisted retrieval state survive edits and renames without mixing incompatible vectors?

Requirement: Explain compatible persisted retrieval through edits/renames and safe publication.

Development corpus judgment: **supported**. Sufficient alternatives (AND within a set; OR between sets): `[["snapshot.md:1", "rename.md:1", "atomic-save.md:1"]]`.

| Chunk (document:start line) | Grade | L | S | H | Cosine |
| --- | ---: | ---: | ---: | ---: | ---: |
| snapshot.md:1 | 1 | 14 | 2 | 4 | 0.4508 |
| rename.md:1 | 1 | 1 | 1 | 1 | 0.5242 |
| atomic-save.md:1 | 1 | 8 | 7 | 5 | 0.3334 |
| deploy.md:1 | 0 | 2 | 52 | 15 | 0.0844 |
| evaluation.md:1 | 0 | 3 | 5 | 2 | 0.3668 |
| health.md:1 | 0 | 4 | 59 | 19 | 0.0182 |
| embeddings.md:1 | 0 | 5 | 12 | 6 | 0.3154 |
| search-cache.md:1 | 0 | 34 | 3 | 9 | 0.4235 |
| filesystem.md:1 | 0 | 10 | 4 | 3 | 0.3705 |

Expected/contextual chunk contents (exact source text; irrelevant returned contents remain in the linked manifest):

**snapshot.md:1**

````text
# Snapshot compatibility

Persist schema, parser, chunker and embedding-input versions with model identity and dimensions. Reject reuse when any vector-affecting configuration differs. Compatible but malformed records surface corruption rather than mixing partial old data with new content. A restored snapshot is only a reuse candidate until registered sources have been reconciled with live contents.
````

**rename.md:1**

````text
# Rename without inference

A document rename changes provenance-sensitive chunk identifiers but need not change the text sent to an embedder. Reuse vectors by exact content and structural context, never by a weak hash alone. Remove the old path from the canonical index after successful refresh. If a heading changes meaningfully, the embedding input changes even when body text is identical.
````

**atomic-save.md:1**

````text
# Atomic snapshot publication

Write the complete candidate snapshot to a temporary sibling file, flush it, close it, and rename it over the canonical file. A failed replacement leaves the previous complete snapshot readable. Publish matching live state only after storage confirms success. Directory durability and multi-process writer coordination remain separate host responsibilities.
````
