const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../db/adapter');

let db, user, ji, convo;

beforeEach(() => {
  db = createAdapter(':memory:');
  user = db.users.create({ email: 'jane@example.com' });
  ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'test' });
  convo = db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
});

// ── Phase A: Message Schema ──

describe('addMessage visibility defaults', () => {
  it('applies defaults when no visibility fields provided', () => {
    db.conversations.addMessage(convo.id, { role: 'customer', text: 'hello' });
    const msgs = db.conversations.get(convo.id).messages;
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0].visibility, ['all']);
    assert.equal(msgs[0].actor, 'customer');
    assert.equal(msgs[0].block, null);
    assert.equal(msgs[0].llm_routed, true);
  });

  it('preserves explicit visibility fields', () => {
    db.conversations.addMessage(convo.id, {
      role: 'agent',
      text: 'physician note',
      visibility: ['physician', 'agent'],
      actor: 'agent',
      block: 'encounter',
      llm_routed: false
    });
    const msg = db.conversations.get(convo.id).messages[0];
    assert.deepEqual(msg.visibility, ['physician', 'agent']);
    assert.equal(msg.actor, 'agent');
    assert.equal(msg.block, 'encounter');
    assert.equal(msg.llm_routed, false);
  });
});

describe('getMessages with viewer filter', () => {
  beforeEach(() => {
    // Build a mixed-visibility conversation
    db.conversations.addMessage(convo.id, { role: 'customer', text: 'Hi', visibility: ['customer', 'agent'] });
    db.conversations.addMessage(convo.id, { role: 'agent', text: 'Hello!', visibility: ['customer', 'agent'] });
    db.conversations.addMessage(convo.id, { role: 'physician', text: 'Clinical note', visibility: ['physician', 'agent'] });
    db.conversations.addMessage(convo.id, { role: 'agent', text: 'System broadcast', visibility: ['all'] });
    db.conversations.addMessage(convo.id, { role: 'admin', text: 'Internal', visibility: ['admin'] });
  });

  it('returns all messages when no viewer specified', () => {
    const msgs = db.conversations.getMessages(convo.id);
    assert.equal(msgs.length, 5);
  });

  it('filters for customer viewer', () => {
    const msgs = db.conversations.getMessages(convo.id, { viewer: 'customer' });
    assert.equal(msgs.length, 3); // customer msg + agent reply + system broadcast
    assert.ok(msgs.every(m => m.visibility.includes('customer') || m.visibility.includes('all')));
    assert.ok(!msgs.some(m => m.text === 'Clinical note'));
    assert.ok(!msgs.some(m => m.text === 'Internal'));
  });

  it('filters for physician viewer', () => {
    const msgs = db.conversations.getMessages(convo.id, { viewer: 'physician' });
    assert.equal(msgs.length, 2); // clinical note + system broadcast
    assert.ok(msgs.some(m => m.text === 'Clinical note'));
    assert.ok(msgs.some(m => m.text === 'System broadcast'));
  });

  it('filters for agent viewer', () => {
    const msgs = db.conversations.getMessages(convo.id, { viewer: 'agent' });
    assert.equal(msgs.length, 4); // all except admin-only
    assert.ok(!msgs.some(m => m.text === 'Internal'));
  });

  it('filters for admin viewer', () => {
    const msgs = db.conversations.getMessages(convo.id, { viewer: 'admin' });
    assert.equal(msgs.length, 2); // admin msg + system broadcast
  });

  it('[all] visibility visible to every viewer', () => {
    for (const viewer of ['customer', 'physician', 'agent', 'admin', 'pho']) {
      const msgs = db.conversations.getMessages(convo.id, { viewer });
      assert.ok(msgs.some(m => m.text === 'System broadcast'), `${viewer} should see [all] messages`);
    }
  });

  it('backward compat: messages without visibility field visible to all', () => {
    // Simulate a legacy message (no visibility field)
    const c = db.conversations.get(convo.id);
    c.messages.push({ role: 'agent', text: 'legacy msg', timestamp: new Date().toISOString() });
    db.db.prepare('UPDATE conversations SET messages = ? WHERE id = ?').run(JSON.stringify(c.messages), convo.id);

    const msgs = db.conversations.getMessages(convo.id, { viewer: 'customer' });
    assert.ok(msgs.some(m => m.text === 'legacy msg'), 'legacy messages should be visible');
  });

  it('returns null for nonexistent conversation', () => {
    assert.equal(db.conversations.getMessages('bad_id', { viewer: 'customer' }), null);
  });
});

// ── Phase B: Block Actor + Respond Visibility ──

describe('block executor visibility metadata', () => {
  const { createBlockExecutor } = require('../runtime/block-executor');
  const { createActionDispatcher } = require('../runtime/action-dispatcher');
  const { createCapabilityRegistry } = require('../runtime/capability-registry');
  const { createMockLLM } = require('../core/mock-llm');

  it('respond action carries visibility from block definition', async () => {
    const sentMessages = [];
    const llm = createMockLLM();
    const dispatcher = createActionDispatcher({
      conversationStore: { addMessage: async (id, msg) => sentMessages.push(msg) },
      capabilityRegistry: createCapabilityRegistry(),
      scheduler: null, logger: { log() {}, info() {}, error() {} },
      llm
    });

    const blockRegistry = {
      simple_intake: require('../blocks/simple_intake')
    };
    const executor = createBlockExecutor({ actionDispatcher: dispatcher, blockRegistry });

    const journeyDef = {
      journey_type: 'test',
      blocks: [
        { block: 'simple_intake', params: { required_fields: ['customerName'] }, default_visibility: ['customer', 'agent'] },
        { block: 'simple_intake', params: { required_fields: [] } }
      ]
    };

    await executor.execute({
      event: { type: 'conversation', payload: { text: 'Jane Smith' } },
      context: { current_block: 'simple_intake', conversation_id: 'c1', journey_status: 'in_progress', block_history: [] },
      blockDef: journeyDef.blocks[0],
      journeyDef
    });

    assert.ok(sentMessages.length > 0, 'should have sent a message');
    const agentMsg = sentMessages.find(m => m.role === 'agent');
    assert.ok(agentMsg, 'should have agent message');
    assert.deepEqual(agentMsg.visibility, ['customer', 'agent']);
    assert.equal(agentMsg.actor, 'agent');
    assert.equal(agentMsg.block, 'simple_intake');
    assert.equal(agentMsg.llm_routed, true);
  });

  it('physician-facing block uses physician visibility', async () => {
    const sentMessages = [];
    const llm = createMockLLM();
    const dispatcher = createActionDispatcher({
      conversationStore: { addMessage: async (id, msg) => sentMessages.push(msg) },
      capabilityRegistry: createCapabilityRegistry(),
      scheduler: null, logger: { log() {}, info() {}, error() {} },
      llm
    });

    const blockRegistry = {
      simple_intake: require('../blocks/simple_intake')
    };
    const executor = createBlockExecutor({ actionDispatcher: dispatcher, blockRegistry });

    const journeyDef = {
      journey_type: 'test',
      blocks: [
        { block: 'simple_intake', params: { required_fields: ['customerName'] }, actor: 'physician', default_visibility: ['physician', 'agent'] }
      ]
    };

    await executor.execute({
      event: { type: 'conversation', payload: { text: 'Jane Smith' } },
      context: { current_block: 'simple_intake', conversation_id: 'c1', journey_status: 'in_progress', block_history: [] },
      blockDef: journeyDef.blocks[0],
      journeyDef
    });

    const agentMsg = sentMessages.find(m => m.role === 'agent');
    assert.ok(agentMsg);
    assert.deepEqual(agentMsg.visibility, ['physician', 'agent']);
  });

  it('block without actor field defaults to customer visibility', async () => {
    const sentMessages = [];
    const llm = createMockLLM();
    const dispatcher = createActionDispatcher({
      conversationStore: { addMessage: async (id, msg) => sentMessages.push(msg) },
      capabilityRegistry: createCapabilityRegistry(),
      scheduler: null, logger: { log() {}, info() {}, error() {} },
      llm
    });
    const blockRegistry = { simple_intake: require('../blocks/simple_intake') };
    const executor = createBlockExecutor({ actionDispatcher: dispatcher, blockRegistry });

    await executor.execute({
      event: { type: 'conversation', payload: { text: 'Jane Smith' } },
      context: { current_block: 'simple_intake', conversation_id: 'c1', journey_status: 'in_progress', block_history: [] },
      blockDef: { block: 'simple_intake', params: { required_fields: ['customerName'] } },
      journeyDef: { journey_type: 'test', blocks: [{ block: 'simple_intake', params: { required_fields: ['customerName'] } }] }
    });

    const agentMsg = sentMessages.find(m => m.role === 'agent');
    assert.ok(agentMsg);
    assert.deepEqual(agentMsg.visibility, ['customer', 'agent'], 'should default to customer+agent');
  });

  it('transaction notes carry visibility and llm_routed:false', async () => {
    const sentMessages = [];
    const dispatcher = createActionDispatcher({
      conversationStore: { addMessage: async (id, msg) => sentMessages.push(msg) },
      capabilityRegistry: createCapabilityRegistry(),
      scheduler: null, logger: { log() {}, info() {}, error() {} },
      llm: null
    });

    await dispatcher.dispatch(
      { type: 'transaction_note', text: 'Payment received', visibility: ['customer', 'agent'], block: 'payment' },
      { conversation_id: 'c1' },
      {}
    );

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].role, 'transaction');
    assert.deepEqual(sentMessages[0].visibility, ['customer', 'agent']);
    assert.equal(sentMessages[0].llm_routed, false);
  });
});

// ── Phase C: Event Router Actor Matching + DM ──

describe('event router actor matching', () => {
  const { createEventRouter } = require('../runtime/event-router');
  const { createBlockExecutor } = require('../runtime/block-executor');
  const { createActionDispatcher } = require('../runtime/action-dispatcher');
  const { createCapabilityRegistry } = require('../runtime/capability-registry');
  const { createMockLLM } = require('../core/mock-llm');
  const { createContextManager } = require('../core/context');
  const presentation = require('../blocks/presentation');
  const simpleIntake = require('../blocks/simple_intake');

  function setupRouter() {
    const testDb = createAdapter(':memory:');
    const llm = createMockLLM();
    const blockRegistry = { presentation, simple_intake: simpleIntake };
    const dispatcher = createActionDispatcher({
      conversationStore: testDb.conversations,
      capabilityRegistry: createCapabilityRegistry(),
      scheduler: null, logger: { log() {}, info() {}, error() {} }, llm
    });
    const executor = createBlockExecutor({ actionDispatcher: dispatcher, blockRegistry });

    const journeyDef = {
      journey_type: 'actor_test',
      blocks: [
        { block: 'presentation', params: { offering_slug: 'test' }, actor: 'customer' },
        { block: 'simple_intake', params: { required_fields: ['customerName'] }, actor: 'physician', default_visibility: ['physician', 'agent'] }
      ]
    };
    const router = createEventRouter({ db: testDb, blockExecutor: executor, journeyDefinitions: { actor_test: journeyDef } });

    const u = testDb.users.create({ email: 'actor@test.com' });
    const ctx = createContextManager({ db: testDb });
    const initCtx = ctx.create({ journey_type: 'actor_test', user_id: u.id, initialBlock: 'presentation' });
    initCtx.journey_status = 'in_progress';
    const jiObj = testDb.journeyInstances.create({ user_id: u.id, journey_type: 'actor_test', context: initCtx, status: 'in_progress' });
    const convoObj = testDb.conversations.create({ user_id: u.id, journey_instance_id: jiObj.id });
    ctx.update(jiObj.id, { conversation_id: convoObj.id });

    return { db: testDb, router, ji: jiObj, convo: convoObj };
  }

  it('matching actor processes normally', async () => {
    const { router, ji } = setupRouter();
    const result = await router.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'customer',
      payload: { text: 'I am tired' }
    });
    assert.equal(result.handled, true);
  });

  it('default actor (no event.actor) matches customer block', async () => {
    const { router, ji } = setupRouter();
    const result = await router.handleEvent({
      type: 'conversation', journey_id: ji.id,
      payload: { text: 'hello' }
    });
    assert.equal(result.handled, true);
  });

  it('mismatched actor without dm flag returns actor_mismatch', async () => {
    const { router, ji } = setupRouter();
    const result = await router.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      payload: { text: 'clinical note' }
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'actor_mismatch');
    assert.ok(result.detail.includes('physician'));
  });

  it('mismatched actor with dm:true stores as DM passthrough', async () => {
    const { router, ji, convo, db: testDb } = setupRouter();
    const result = await router.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      conversation_id: convo.id, dm: true, dm_to: 'customer',
      payload: { text: 'Please schedule a follow-up' }
    });
    assert.equal(result.handled, true);
    assert.equal(result.dm, true);
    assert.equal(result.transitioned, false);

    // DM should be in conversation
    const msgs = testDb.conversations.get(convo.id).messages;
    const dmMsg = msgs.find(m => m.text === 'Please schedule a follow-up');
    assert.ok(dmMsg);
    assert.deepEqual(dmMsg.visibility, ['physician', 'customer']);
    assert.equal(dmMsg.llm_routed, false);
    assert.equal(dmMsg.actor, 'physician');
  });

  it('DM visible to both participants, not to others', async () => {
    const { router, ji, convo, db: testDb } = setupRouter();
    await router.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      conversation_id: convo.id, dm: true, dm_to: 'customer',
      payload: { text: 'Private note for you' }
    });

    const customerView = testDb.conversations.getMessages(convo.id, { viewer: 'customer' });
    const physicianView = testDb.conversations.getMessages(convo.id, { viewer: 'physician' });
    const adminView = testDb.conversations.getMessages(convo.id, { viewer: 'admin' });

    assert.ok(customerView.some(m => m.text === 'Private note for you'));
    assert.ok(physicianView.some(m => m.text === 'Private note for you'));
    assert.ok(!adminView.some(m => m.text === 'Private note for you'));
  });

  it('DM events are logged in events_log', async () => {
    const { router, ji, convo, db: testDb } = setupRouter();
    await router.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      conversation_id: convo.id, dm: true, dm_to: 'customer',
      payload: { text: 'DM log test' }
    });

    const events = testDb.eventsLog.findByJourney(ji.id);
    const dmEvent = events.find(e => e.source === 'dm');
    assert.ok(dmEvent);
    assert.equal(dmEvent.payload.from, 'physician');
    assert.equal(dmEvent.payload.to, 'customer');
  });

  it('DM does not trigger block transitions', async () => {
    const { router, ji, db: testDb, convo } = setupRouter();
    const ctxBefore = testDb.journeyInstances.get(ji.id).context.current_block;
    await router.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      conversation_id: convo.id, dm: true, dm_to: 'customer',
      payload: { text: 'Just a note' }
    });
    const ctxAfter = testDb.journeyInstances.get(ji.id).context.current_block;
    assert.equal(ctxBefore, ctxAfter);
  });

  it('DM on completed journey is rejected', async () => {
    const { router, ji, convo, db: testDb } = setupRouter();
    testDb.journeyInstances.put(ji.id, { context: testDb.journeyInstances.get(ji.id).context, status: 'completed' });
    const result = await router.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      conversation_id: convo.id, dm: true, dm_to: 'customer',
      payload: { text: 'Too late' }
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'journey_not_active');
  });

  it('non-conversation events ignore actor matching', async () => {
    const { router, ji } = setupRouter();
    // System events should work regardless of actor
    const result = await router.handleEvent({
      type: 'system', journey_id: ji.id, source: 'widget_loaded',
      payload: {}
    });
    assert.equal(result.handled, true);
  });
});

// ── Phase E: Multi-Actor Integration Test ──

describe('multi-actor journey integration', () => {
  const { createCore } = require('../index');

  it('walks intake (customer) → encounter (physician) → summary (customer) with visibility isolation', async () => {
    // Custom encounter block (physician-facing)
    const encounterBlock = {
      type: 'conversational', name: 'encounter',
      params_schema: {}, reads: ['simple_intake.*'], writes: ['encounter.*'],
      handles_events: ['conversation'],
      on_conversation_event: { completion_condition: 'physician_done' },
      checkCompletion(blockDef, context) { return context.encounter?.done === true; }
    };

    // Custom summary block
    const summaryBlock = {
      type: 'conversational', name: 'summary',
      params_schema: {}, reads: ['encounter.*'], writes: ['summary.*'],
      handles_events: ['conversation'],
      on_conversation_event: { completion_condition: null },
      checkCompletion() { return false; }
    };

    const core = createCore({ useMockLLM: true, extraBlocks: [encounterBlock, summaryBlock] });

    const journeyDef = {
      journey_type: 'multi_actor_test',
      blocks: [
        { block: 'simple_intake', params: { required_fields: ['customerName'] }, actor: 'customer', default_visibility: ['customer', 'agent'] },
        { block: 'encounter', params: {}, actor: 'physician', default_visibility: ['physician', 'agent'] },
        { block: 'summary', params: {}, actor: 'customer', default_visibility: ['customer', 'agent'] }
      ]
    };
    core.registerJourney(journeyDef);

    const user = core.db.users.create({ email: 'multi@test.com' });
    const initCtx = core.context.create({ journey_type: 'multi_actor_test', user_id: user.id, initialBlock: 'simple_intake' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'multi_actor_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });

    // 1. Customer intake message
    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'customer',
      payload: { text: 'Jane Smith' }
    });

    let ctx = core.context.read(ji.id);
    // Should have transitioned to encounter (name collected)
    assert.equal(ctx.current_block, 'encounter');

    // 2. Physician message on physician-facing block
    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      payload: { text: 'Patient presents with fatigue' }
    });

    ctx = core.context.read(ji.id);
    assert.equal(ctx.current_block, 'encounter'); // still in encounter

    // 3. Physician DMs customer (cross-actor, dm:true)
    await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'physician',
      conversation_id: convo.id, dm: true, dm_to: 'customer',
      payload: { text: 'Hi Jane, please fast 12h before your blood draw' }
    });

    // 4. Customer tries to message on physician block → actor_mismatch
    const mismatchResult = await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id, actor: 'customer',
      payload: { text: 'Can I eat before the test?' }
    });
    assert.equal(mismatchResult.handled, false);
    assert.equal(mismatchResult.reason, 'actor_mismatch');

    // 5. Verify visibility filtering
    const customerView = core.db.conversations.getMessages(convo.id, { viewer: 'customer' });
    const physicianView = core.db.conversations.getMessages(convo.id, { viewer: 'physician' });

    // Customer should see: their intake messages + DM + agent responses to them
    assert.ok(customerView.some(m => m.text.includes('Jane Smith') || m.actor === 'customer'), 'customer sees own messages');
    assert.ok(customerView.some(m => m.text.includes('fast 12h')), 'customer sees DM from physician');
    assert.ok(!customerView.some(m => m.text === 'Patient presents with fatigue'), 'customer does NOT see physician clinical note');

    // Physician should see: their clinical notes + DM + agent responses to them
    assert.ok(physicianView.some(m => m.text === 'Patient presents with fatigue'), 'physician sees own messages');
    assert.ok(physicianView.some(m => m.text.includes('fast 12h')), 'physician sees own DM');
    assert.ok(!physicianView.some(m => m.text === 'Jane Smith'), 'physician does NOT see customer intake messages');

    // 6. Verify LLM prompt filtering
    const { getConversationHistory } = require('../runtime/block-executor');
    const llmHistory = getConversationHistory(core.db.conversations, convo.id, { viewer: 'physician' });
    assert.ok(!llmHistory.some(m => m.text.includes('fast 12h')), 'DM (llm_routed:false) excluded from LLM prompt');

    core.close();
  });

  it('backward compat: blocks without actor default to customer, messages without visibility visible to all', async () => {
    const core = createCore({ useMockLLM: true });
    core.registerJourney({
      journey_type: 'compat_test',
      blocks: [
        { block: 'presentation', params: { offering_slug: 'test' } },
        { block: 'simple_intake', params: { required_fields: ['customerName'] } }
      ]
    });

    const user = core.db.users.create({ email: 'compat@test.com' });
    const initCtx = core.context.create({ journey_type: 'compat_test', user_id: user.id, initialBlock: 'presentation' });
    initCtx.journey_status = 'in_progress';
    const ji = core.db.journeyInstances.create({ user_id: user.id, journey_type: 'compat_test', context: initCtx, status: 'in_progress' });
    const convo = core.db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    core.context.update(ji.id, { conversation_id: convo.id });

    // Works without actor field
    const result = await core.eventRouter.handleEvent({
      type: 'conversation', journey_id: ji.id,
      payload: { text: 'hello' }
    });
    assert.equal(result.handled, true);

    // Messages on blocks without explicit actor/visibility default to ['customer', 'agent']
    const customerMsgs = core.db.conversations.getMessages(convo.id, { viewer: 'customer' });
    assert.ok(customerMsgs.length > 0, 'customer sees messages from blocks without explicit visibility');
    const agentMsgs = core.db.conversations.getMessages(convo.id, { viewer: 'agent' });
    assert.ok(agentMsgs.length > 0, 'agent sees messages from blocks without explicit visibility');

    core.close();
  });
});

// ── Phase D: LLM Prompt Conversation History Filtering ──

describe('getConversationHistory', () => {
  const { getConversationHistory } = require('../runtime/block-executor');

  it('filters by viewer visibility', () => {
    const testDb2 = createAdapter(':memory:');
    const u2 = testDb2.users.create({ email: 'hist@test.com' });
    const ji2 = testDb2.journeyInstances.create({ user_id: u2.id, journey_type: 'test' });
    const c2 = testDb2.conversations.create({ user_id: u2.id, journey_instance_id: ji2.id });

    testDb2.conversations.addMessage(c2.id, { role: 'customer', text: 'Hi', visibility: ['customer', 'agent'] });
    testDb2.conversations.addMessage(c2.id, { role: 'physician', text: 'Clinical note', visibility: ['physician', 'agent'] });
    testDb2.conversations.addMessage(c2.id, { role: 'agent', text: 'Broadcast', visibility: ['all'] });

    const customerHistory = getConversationHistory(testDb2.conversations, c2.id, { viewer: 'customer' });
    assert.equal(customerHistory.length, 2); // customer msg + broadcast
    assert.ok(!customerHistory.some(m => m.text === 'Clinical note'));

    const physicianHistory = getConversationHistory(testDb2.conversations, c2.id, { viewer: 'physician' });
    assert.equal(physicianHistory.length, 2); // clinical note + broadcast
    assert.ok(!physicianHistory.some(m => m.text === 'Hi'));
  });

  it('excludes llm_routed:false messages by default', () => {
    const testDb2 = createAdapter(':memory:');
    const u2 = testDb2.users.create({ email: 'llmroute@test.com' });
    const ji2 = testDb2.journeyInstances.create({ user_id: u2.id, journey_type: 'test' });
    const c2 = testDb2.conversations.create({ user_id: u2.id, journey_instance_id: ji2.id });

    testDb2.conversations.addMessage(c2.id, { role: 'customer', text: 'Hello', visibility: ['all'], llm_routed: true });
    testDb2.conversations.addMessage(c2.id, { role: 'physician', text: 'DM', visibility: ['physician', 'customer'], llm_routed: false });
    testDb2.conversations.addMessage(c2.id, { role: 'transaction', text: 'Payment', visibility: ['all'], llm_routed: false });

    const history = getConversationHistory(testDb2.conversations, c2.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].text, 'Hello');
  });

  it('includes llm_routed:false when opted in', () => {
    const testDb2 = createAdapter(':memory:');
    const u2 = testDb2.users.create({ email: 'llmall@test.com' });
    const ji2 = testDb2.journeyInstances.create({ user_id: u2.id, journey_type: 'test' });
    const c2 = testDb2.conversations.create({ user_id: u2.id, journey_instance_id: ji2.id });

    testDb2.conversations.addMessage(c2.id, { role: 'customer', text: 'Hello', visibility: ['all'] });
    testDb2.conversations.addMessage(c2.id, { role: 'physician', text: 'DM', visibility: ['physician'], llm_routed: false });

    const history = getConversationHistory(testDb2.conversations, c2.id, { includeLlmRouted: true });
    assert.equal(history.length, 2);
  });

  it('system messages with [all] visibility appear in all prompts', () => {
    const testDb2 = createAdapter(':memory:');
    const u2 = testDb2.users.create({ email: 'sysall@test.com' });
    const ji2 = testDb2.journeyInstances.create({ user_id: u2.id, journey_type: 'test' });
    const c2 = testDb2.conversations.create({ user_id: u2.id, journey_instance_id: ji2.id });

    testDb2.conversations.addMessage(c2.id, { role: 'system', text: 'Journey started', visibility: ['all'], llm_routed: true });

    for (const viewer of ['customer', 'physician', 'admin', 'agent']) {
      const history = getConversationHistory(testDb2.conversations, c2.id, { viewer });
      assert.ok(history.some(m => m.text === 'Journey started'), `${viewer} should see [all] system msg`);
    }
  });
});
