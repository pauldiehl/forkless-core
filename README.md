# @forkless/core

Config-driven journey state machine with a conversational interface.

Zero business-specific logic in the runtime. Journeys are JSON config. Blocks are declarative contracts. Capabilities are isolated integrations. The LLM only parses intent — it never decides actions.

## Install

```bash
npm install
```

## Quick Start

```js
const { createCore } = require('./index');
const core = createCore({ useMockLLM: true });

// Define a journey — an ordered sequence of blocks
core.registerJourney({
  journey_type: 'onboarding',
  blocks: [
    { block: 'presentation', params: { offering_slug: 'my-product' } },
    { block: 'simple_intake', params: { required_fields: ['customerName', 'customerEmail'] } },
    { block: 'recommendation', params: { price_cents: 9900 } },
    { block: 'payment', params: { amount_cents: 9900, product_slug: 'my-product', provider: 'square' } }
  ]
});

// Create user + journey instance
const user = core.db.users.create({ email: 'jane@example.com', name: 'Jane' });
const ctx = core.context.create({
  journey_type: 'onboarding',
  user_id: user.id,
  initialBlock: 'presentation'
});
ctx.journey_status = 'in_progress';

const ji = core.db.journeyInstances.create({
  user_id: user.id,
  journey_type: 'onboarding',
  context: ctx,
  status: 'in_progress'
});

// Send events
const result = await core.eventRouter.handleEvent({
  type: 'conversation',
  journey_id: ji.id,
  payload: { text: 'I need help with my health' }
});

console.log(result.newBlock);     // 'simple_intake'
console.log(result.transitioned); // true
```

## Interactive REPL

The fastest way to see the system in action:

```bash
node
```

```js
const r = require('./repl').start()
await r.say('I have been really tired and gaining weight')
await r.say('Jane Smith')
await r.say('jane@example.com')
await r.say('Yes let\'s do it')
await r.webhook({ status: 'completed', order_id: 'SQ-001' })
r.messages()   // see full conversation
r.state()      // see journey context
r.history()    // see block transitions
```

## Core Concepts

### Three Stores

| Store | Answers | Contains |
|-------|---------|----------|
| **DB** | "Where is this user?" | Identity, journey state, business records |
| **Config** | "What should happen next?" | Journey definitions, block contracts, transition rules |
| **LLM** | "What did the user mean?" | Intent parsing from conversation context |

### JSM Core Loop

Every event follows this cycle:

```
context + event → before-actions → transition → after-actions → new context
```

- **Before-actions**: validate, parse_intent (LLM), execute_capability
- **Transition**: next_block, internal state change, or none
- **After-actions**: respond, transaction_note, update_context, schedule, log

### Events

| Type | Example | LLM? |
|------|---------|------|
| `conversation` | User sends a message | Yes |
| `api` | Payment webhook fires | No |
| `scheduled` | 48h reminder triggers | No |
| `system` | Widget loaded | No |

Only conversation events involve the LLM. Everything else is deterministic config.

### Blocks

Two categories:

**Conversational** — LLM drives the flow within guardrails defined by the contract.
- `presentation` — present an offering, transition on engagement
- `simple_intake` — collect required fields via conversation
- `recommendation` — present recommendation, transition on agreement
- `followup` — post-journey check-ins

**Capability** — deterministic, driven by webhooks and config handlers.
- `payment` — handle payment lifecycle via API events

Each block contract defines: params schema, reads/writes, handled event types, completion conditions, and event handlers.

### Context

Single JSON document per journey instance. Namespaced by block:

```js
{
  journey_type: 'medical_consult',
  current_block: 'simple_intake',
  block_state: null,
  journey_status: 'in_progress',
  // Block namespaces — each block writes to its own
  presentation: { engaged: true },
  simple_intake: { customerName: 'Jane', customerEmail: 'jane@x.com' },
  payment: { order_id: 'SQ-001', status: 'pending' },
  // Metadata
  block_history: [...]
}
```

Snapshot and restore any context for testing:
```js
const snap = core.context.snapshot(journeyId);
// ... do things ...
core.context.restore(journeyId, snap);
```

## API Reference

### `createCore(opts)`

Creates a fully wired Forkless Core instance.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | string | `':memory:'` | SQLite database path |
| `useMockLLM` | boolean | `false` | Use built-in mock LLM |
| `llm` | object | `null` | Custom LLM adapter `{ parseIntent, generateResponse }` |
| `logger` | object | `console` | Logger `{ log, info, error }` |
| `tickIntervalMs` | number | `60000` | Scheduler tick interval |
| `extraBlocks` | array | `[]` | Additional block contracts |

Returns:

| Property | Description |
|----------|-------------|
| `db` | Database adapter (users, journeyInstances, conversations, eventsLog, businessRecords, campaigns) |
| `context` | Context manager (create, read, update, snapshot, restore, applyUpdate) |
| `eventRouter` | Event router — `handleEvent(event)` |
| `blockExecutor` | Block executor — `execute({ event, context, blockDef, journeyDef })` |
| `capabilityRegistry` | Capability registry — `register(name, { execute })`, `get(name)`, `list()` |
| `scheduler` | Scheduler — `schedule(job)`, `registerHandler(type, fn)`, `start()`, `stop()` |
| `registerJourney(def)` | Register a journey definition |
| `close()` | Shut down (stops scheduler, closes DB) |

### `eventRouter.handleEvent(event)`

```js
await core.eventRouter.handleEvent({
  type: 'conversation',        // conversation | api | scheduled | system
  journey_id: 'ji_abc123',    // direct routing (or use conversation_id)
  conversation_id: 'convo_1', // routes via conversation's linked journey
  source: 'customer',         // event source identifier
  payload: { text: '...' }    // event data
});
```

### Registering Capabilities

```js
core.capabilityRegistry.register('square_checkout', {
  execute: async (params, context) => {
    // Call external API
    return { order_id: 'SQ-001', checkout_url: '...' };
  }
});
```

### Creating Custom Blocks

```js
const myBlock = {
  type: 'conversational',     // or 'capability'
  name: 'my_custom_block',
  params_schema: { ... },
  reads: ['intake.*'],
  writes: ['my_custom_block.*'],
  handles_events: ['conversation'],
  on_conversation_event: {
    completion_condition: 'custom_check'
  },
  checkCompletion(blockDef, context) {
    return context.my_custom_block?.done === true;
  }
};

// Pass via createCore
const core = createCore({ extraBlocks: [myBlock] });
```

## Testing

```bash
npm test              # run all tests
npm run test:verbose  # with spec reporter
```

## Project Structure

```
index.js              ← createCore() factory, wires all modules
repl.js               ← Interactive REPL helper

runtime/
  event-router.js     ← Routes events to journey/block
  block-executor.js   ← JSM core loop (before → transition → after)
  action-dispatcher.js← Routes actions to systems
  capability-registry.js ← External capability map

core/
  context.js          ← Context CRUD + snapshot/restore
  scheduler.js        ← Tick-based job runner
  journey-loader.js   ← Journey definition validation
  mock-llm.js         ← Mock LLM for testing

db/
  schema.sql          ← 6 tables (SQLite)
  adapter.js          ← CRUD wrapper

blocks/               ← Block contracts
  presentation.js
  simple_intake.js
  recommendation.js
  payment.js
  followup.js

test/                 ← Unit + integration + e2e tests
```

## Design Docs

Full design documentation lives in `~/projects/forkless-design/`:

| File | Contents |
|------|----------|
| `BUILD_SPEC.md` | Build order and target structure |
| `CANDIDATE_DESIGN_V1.md` | Full JSM spec, context/events/actions, block contracts |
| `RUNTIME_SKETCH.md` | Runtime architecture with code sketches |
| `SEQUENCE_medical_consult_labs.md` | 28-event journey walkthrough |
