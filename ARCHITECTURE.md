# Forkless Core — Architecture

## Overview

`@forkless/core` is a config-driven journey state machine (JSM) with a conversational interface. It interprets journey definitions (JSON config) through a generic runtime. No business-specific logic lives in the runtime.

## Three Stores

| Store | Answers | Implementation |
|-------|---------|---------------|
| **DB** | "Where is this user?" | SQLite via better-sqlite3 (`db/adapter.js`) |
| **Config** | "What should happen next?" | Journey JSON files + block contracts |
| **LLM** | "What did the user mean?" | Pluggable adapter (injected at boot) |

## Module Map

```
index.js                    ← Factory exports, createCore() wires everything ✅
runtime/
  event-router.js           ← Routes events to correct journey/block ✅
  block-executor.js         ← Core JSM loop: event+context → actions → new state ✅
  action-dispatcher.js      ← Routes action objects to systems ✅
  capability-registry.js    ← Maps capability names to execute functions ✅
core/
  context.js                ← Context CRUD: create, read, update, snapshot, restore ✅
  scheduler.js              ← Tick-based job runner ✅
  journey-loader.js         ← Reads journey JSONs, validates block refs ✅
  mock-llm.js               ← Deterministic mock LLM for testing ✅
db/
  schema.sql                ← 6 tables ✅
  adapter.js                ← SQLite CRUD wrapper ✅
blocks/
  presentation.js           ← Conversational: present offering ✅
  simple_intake.js          ← Conversational: collect required fields ✅
  recommendation.js         ← Conversational: present recommendation, collect agreement ✅
  payment.js                ← Capability: handle payment via webhooks ✅
  followup.js               ← Conversational: post-journey follow-up ✅
capabilities/               ← External API integrations (Week 4)
auth/                       ← OTP + JWT (Week 4)
test/                       ← Test suite ✅
```

## Feature Roadmap

### Week 1: Foundation ✅
- [x] DB schema (6 tables) + SQLite adapter
- [x] Context manager (create/read/update/snapshot/restore)
- [x] Capability registry
- [x] Action dispatcher (8 action types)
- [x] Scheduler (adapted from forkless repo)

### Week 2: Core Runtime ✅
- [x] Block executor (JSM core loop: before → transition → after)
- [x] Event router (routes events to journey/block, persists state + event log)
- [x] Journey loader (validates journey definitions against block registry)
- [x] Block contracts: presentation, simple_intake, recommendation, payment, followup
- [x] Mock LLM adapter (parseIntent + generateResponse, pattern-based)
- [x] E2E journey test: presentation → intake → recommendation → payment
- [x] 111 tests passing

### Week 3: Testing + First Journey
- [ ] Sequence log generator
- [ ] Teleport testing
- [ ] Seed data generator
- [ ] Test CLI
- [ ] labs-only journey e2e

### Week 4: MVH Onboarding
- [ ] Extract MVH capabilities (labcorp, square, calcom)
- [ ] MVH journey JSONs
- [ ] Server wiring
- [ ] Auth (OTP + JWT + test bypass)

## Key Design Decisions

1. **JSM Core Loop**: `context + event → before-actions → transition → after-actions → new context`
2. **Context is one JSON column**: Single serializable document per journey instance. No joins needed for state.
3. **Actions are declarative**: Block contracts declare what actions to fire. The action dispatcher routes them. No business logic in the dispatcher.
4. **Capabilities are isolated**: One file per external API. The only place where real integrations live.
5. **SQLite default**: In-memory for tests, file-backed for dev/prod. WAL mode for concurrent reads.
6. **No frameworks**: Vanilla Node.js. The AI is the framework.
7. **Block namespace convention**: The block executor writes extracted data to `context[blockDef.block]`. Block contracts check their own namespace for completion conditions.
8. **Two block types**: Conversational blocks delegate flow to LLM within guardrails. Capability blocks handle events deterministically via config handlers.
9. **Mock LLM for testing**: Pattern-based mock enables full e2e testing without external API calls. Swappable for real LLM adapter.

## DB Schema

6 tables: `users`, `journey_instances`, `conversations`, `events_log`, `business_records`, `campaigns`

`journey_instances.context` holds the full journey state as JSON. `business_records` is a typed store — `record_type` discriminates.

## Runtime Flow

```
Event arrives
  → Event Router finds journey instance + loads context
    → Block Executor reads block contract, matches handler
      → Before-actions run (validate, parse_intent, execute_capability)
      → Transition determined (next_block, internal state, or none)
      → After-actions run (respond, transaction_note, update_context, schedule)
    → Updated context saved to DB
    → Event logged
```
