# Forkless Core — Architecture

## Overview

`@forkless/core` is a config-driven journey state machine (JSM) with a conversational interface. It interprets journey definitions (JSON config) through a generic runtime. No business-specific logic lives in the runtime.

Journey definitions are **consumer config** — they live in the consuming application, not in this package. Test fixtures in `test/fixtures/` exist solely for validating the framework.

## Three Stores

| Store | Answers | Implementation |
|-------|---------|---------------|
| **DB** | "Where is this user?" | SQLite via better-sqlite3 (`db/adapter.js`) |
| **Config** | "What should happen next?" | Journey JSON files + block contracts |
| **LLM** | "What did the user mean?" | Pluggable adapter (injected at boot) |

## Module Map

```
index.js                    ← Factory exports, createCore() wires everything ✅
repl.js                     ← Interactive REPL for manual testing ✅

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
  lab_processing.js         ← Capability: multi-state (internal states, exit states) ✅
  followup.js               ← Conversational: post-journey follow-up ✅

test/
  seed.js                   ← Seed journey state to any block with realistic data ✅
  teleport.js               ← Isolated block testing (seed + fire event) ✅
  sequence.js               ← Markdown sequence log generator ✅
  cli.js                    ← CLI: forkless-test seed|teleport|sequence ✅
  fixtures/
    labs-only.json           ← Test fixture journey definition ✅
    labs-script.json         ← Scripted event sequence for sequence generator ✅
    mock-capabilities.js     ← Mock lab, payment, scheduling capabilities ✅

capabilities/               ← External API integrations (consumer-provided)
auth/                       ← OTP + JWT (Week 4)
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

### Week 3: Testing Infrastructure ✅
- [x] lab_processing block — multi-state capability block (internal states, exit states, derived transitions)
- [x] Mock capabilities — lab, payment, scheduling mock adapters
- [x] Seed — generate realistic journey state up to any block
- [x] Teleport — isolated block testing (seed to block, fire event, assert result)
- [x] Sequence — replay scripted events, generate markdown log with state/action/delta
- [x] CLI — `forkless-test seed|teleport|sequence`
- [x] Test fixture journey (labs-only) — not consumer config
- [x] 139 tests passing

### Week 4: Consumer Onboarding
- [ ] Real capability interface documentation
- [ ] Consumer journey JSON examples
- [ ] Server wiring (HTTP layer for webhooks + conversation)
- [ ] Auth (OTP + JWT + test bypass)

## Key Design Decisions

1. **JSM Core Loop**: `context + event → before-actions → transition → after-actions → new context`
2. **Context is one JSON column**: Single serializable document per journey instance. No joins needed for state.
3. **Actions are declarative**: Block contracts declare what actions to fire. The action dispatcher routes them.
4. **Capabilities are isolated**: One file per external API. The only place where real integrations live.
5. **SQLite default**: In-memory for tests, file-backed for dev/prod. WAL mode for concurrent reads.
6. **No frameworks**: Vanilla Node.js. The AI is the framework.
7. **Block namespace convention**: Block executor writes extracted data to `context[blockDef.block]`. Block contracts check their own namespace.
8. **Two block types**: Conversational (LLM within guardrails) and Capability (deterministic config handlers).
9. **Journey definitions are consumer config**: This package provides the engine. Journey JSONs live in the consuming application.
10. **Test infrastructure is first-class**: Seed, teleport, and sequence are core testing tools, not afterthoughts.

## Capability Interface

Capabilities follow a simple contract:

```js
{
  execute: async (params, context) => result
}
```

Register on boot, reference by name in block contracts. See `test/fixtures/mock-capabilities.js` for examples.

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

## Testing Tools

```bash
# Seed a journey to a specific block
npx forkless-test seed --journey path/to/journey.json --up-to-block payment

# Teleport to a block and fire an event
npx forkless-test teleport --journey path/to/journey.json --at-block lab_processing \
  --event '{"type":"api","payload":{"labcorp_status":"results_ready"}}'

# Generate a sequence log from a script
npx forkless-test sequence --journey path/to/journey.json --script path/to/script.json \
  --output ./output/
```
