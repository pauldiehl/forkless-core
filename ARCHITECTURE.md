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
index.js                    ← Factory exports, createCore() wires everything
runtime/
  event-router.js           ← Routes events to correct journey/block (Week 2)
  block-executor.js         ← Core JSM loop: event+context → actions → new state (Week 2)
  action-dispatcher.js      ← Routes action objects to systems ✅
  capability-registry.js    ← Maps capability names to execute functions ✅
core/
  context.js                ← Context CRUD: create, read, update, snapshot, restore ✅
  scheduler.js              ← Tick-based job runner ✅
  journey-loader.js         ← Reads journey JSONs, validates block refs (Week 2)
db/
  schema.sql                ← 6 tables ✅
  adapter.js                ← SQLite CRUD wrapper ✅
blocks/                     ← Block contracts (Week 2)
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
- [x] 67 tests passing

### Week 2: Core Runtime
- [ ] Block executor (JSM core loop)
- [ ] Event router
- [ ] First blocks: simple_intake, payment
- [ ] LLM integration (mock first, real later)

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

## DB Schema

6 tables: `users`, `journey_instances`, `conversations`, `events_log`, `business_records`, `campaigns`

`journey_instances.context` holds the full journey state as JSON. `business_records` is a typed store — `record_type` discriminates.
