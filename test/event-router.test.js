const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../db/adapter');
const { createContextManager } = require('../core/context');
const { createBlockExecutor } = require('../runtime/block-executor');
const { createActionDispatcher } = require('../runtime/action-dispatcher');
const { createCapabilityRegistry } = require('../runtime/capability-registry');
const { createEventRouter } = require('../runtime/event-router');
const { createMockLLM } = require('../core/mock-llm');
const { buildBlockRegistry } = require('../core/journey-loader');

const presentation = require('../blocks/presentation');
const simpleIntake = require('../blocks/simple_intake');
const payment = require('../blocks/payment');
const recommendation = require('../blocks/recommendation');

describe('event-router', () => {
  let db, router, user, ji, convo;

  const journeyDef = {
    journey_type: 'test_journey',
    display_name: 'Test Journey',
    blocks: [
      { block: 'presentation', params: { offering_slug: 'test' } },
      { block: 'simple_intake', params: { required_fields: ['customerName', 'customerEmail'] } },
      { block: 'recommendation', params: { price_cents: 14900 } },
      { block: 'payment', params: { amount_cents: 14900, product_slug: 'test', provider: 'square' } }
    ]
  };

  beforeEach(() => {
    db = createAdapter(':memory:');
    const llm = createMockLLM();
    const blockRegistry = buildBlockRegistry([presentation, simpleIntake, payment, recommendation]);
    const capRegistry = createCapabilityRegistry();

    const dispatcher = createActionDispatcher({
      conversationStore: db.conversations,
      capabilityRegistry: capRegistry,
      scheduler: null,
      logger: { log: () => {}, info: () => {}, error: () => {} },
      llm
    });

    const blockExecutor = createBlockExecutor({ actionDispatcher: dispatcher, blockRegistry });

    router = createEventRouter({
      db,
      blockExecutor,
      journeyDefinitions: { test_journey: journeyDef }
    });

    // Set up test data
    user = db.users.create({ email: 'jane@example.com', name: 'Jane Smith' });
    const ctx = createContextManager({ db });
    const initCtx = ctx.create({
      journey_type: 'test_journey',
      user_id: user.id,
      initialBlock: 'presentation'
    });
    initCtx.journey_status = 'in_progress';
    ji = db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'test_journey',
      context: initCtx,
      status: 'in_progress'
    });
    convo = db.conversations.create({
      user_id: user.id,
      journey_instance_id: ji.id
    });
  });

  it('routes conversation event via journey_id', async () => {
    const result = await router.handleEvent({
      type: 'conversation',
      journey_id: ji.id,
      payload: { text: 'I have been really tired lately' }
    });

    assert.equal(result.handled, true);
    assert.equal(result.transitioned, true);
    assert.equal(result.newBlock, 'simple_intake');
  });

  it('routes conversation event via conversation_id', async () => {
    const result = await router.handleEvent({
      type: 'conversation',
      conversation_id: convo.id,
      payload: { text: 'I am so fatigued' }
    });

    assert.equal(result.handled, true);
    assert.equal(result.transitioned, true);
  });

  it('logs the event', async () => {
    await router.handleEvent({
      type: 'conversation',
      journey_id: ji.id,
      payload: { text: 'hello' }
    });

    const events = db.eventsLog.findByJourney(ji.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'conversation');
  });

  it('saves updated context to DB', async () => {
    await router.handleEvent({
      type: 'conversation',
      journey_id: ji.id,
      payload: { text: 'I am tired and gaining weight' }
    });

    const updated = db.journeyInstances.get(ji.id);
    assert.equal(updated.context.current_block, 'simple_intake');
  });

  it('rejects events for completed journeys', async () => {
    db.journeyInstances.put(ji.id, { context: ji.context, status: 'completed' });

    const result = await router.handleEvent({
      type: 'conversation',
      journey_id: ji.id,
      payload: { text: 'hello' }
    });

    assert.equal(result.handled, false);
    assert.equal(result.reason, 'journey_not_active');
  });

  it('throws for unknown journey type', async () => {
    const badJi = db.journeyInstances.create({
      user_id: user.id,
      journey_type: 'nonexistent',
      context: { current_block: 'x', journey_status: 'in_progress' },
      status: 'in_progress'
    });

    await assert.rejects(
      () => router.handleEvent({ type: 'conversation', journey_id: badJi.id, payload: { text: 'hi' } }),
      /No definition for journey type/
    );
  });

  it('throws when no routing info provided', async () => {
    await assert.rejects(
      () => router.handleEvent({ type: 'api', payload: {} }),
      /Cannot route event/
    );
  });
});
