const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createBlockExecutor, getHandler, getNextBlock, resolveTransition, applyContextUpdate } = require('../runtime/block-executor');
const { createActionDispatcher } = require('../runtime/action-dispatcher');
const { createCapabilityRegistry } = require('../runtime/capability-registry');
const { createMockLLM } = require('../core/mock-llm');

// Block contracts
const simpleIntake = require('../blocks/simple_intake');
const payment = require('../blocks/payment');
const presentation = require('../blocks/presentation');

describe('getHandler', () => {
  it('finds api handler via block getApiHandler', () => {
    const event = { type: 'api', payload: { status: 'completed' } };
    const handler = getHandler(payment, event);
    assert.ok(handler);
    assert.equal(handler.transition, 'next_block');
  });

  it('finds scheduled handler by job_type', () => {
    const followup = require('../blocks/followup');
    const event = { type: 'scheduled', payload: { job_type: 'checkin_reminder' } };
    const handler = getHandler(followup, event);
    assert.ok(handler);
  });

  it('finds system handler by source', () => {
    const event = { type: 'system', source: 'widget_loaded' };
    const handler = getHandler(presentation, event);
    assert.ok(handler);
  });

  it('returns null for unhandled event type', () => {
    const event = { type: 'api', payload: {} };
    assert.equal(getHandler(simpleIntake, event), null);
  });
});

describe('getNextBlock', () => {
  const journeyDef = {
    blocks: [
      { block: 'presentation' },
      { block: 'simple_intake' },
      { block: 'payment' }
    ]
  };

  it('finds next block', () => {
    const next = getNextBlock(journeyDef, { block: 'presentation' });
    assert.equal(next.block, 'simple_intake');
  });

  it('returns null for last block', () => {
    assert.equal(getNextBlock(journeyDef, { block: 'payment' }), null);
  });

  it('returns null if block not in journey', () => {
    assert.equal(getNextBlock(journeyDef, { block: 'nonexistent' }), null);
  });
});

describe('resolveTransition', () => {
  it('returns literal transition value', () => {
    assert.equal(resolveTransition('next_block', {}), 'next_block');
  });

  it('resolves derived_from_ paths', () => {
    const event = { payload: { labcorp_status: 'results_ready' } };
    assert.equal(resolveTransition('derived_from_payload.labcorp_status', event), 'results_ready');
  });
});

describe('applyContextUpdate', () => {
  it('applies flat updates', () => {
    const result = applyContextUpdate({ a: 1 }, { b: 2 });
    assert.equal(result.b, 2);
  });

  it('applies dot-notation updates', () => {
    const result = applyContextUpdate({}, { 'payment.status': 'completed' });
    assert.equal(result.payment.status, 'completed');
  });

  it('preserves existing nested values', () => {
    const result = applyContextUpdate(
      { payment: { order_id: 'SQ-1' } },
      { 'payment.status': 'completed' }
    );
    assert.equal(result.payment.order_id, 'SQ-1');
    assert.equal(result.payment.status, 'completed');
  });
});

describe('block executor', () => {
  let executor;
  let sentMessages;

  beforeEach(() => {
    sentMessages = [];
    const llm = createMockLLM();
    const capRegistry = createCapabilityRegistry();
    const conversationStore = {
      addMessage: async (id, msg) => sentMessages.push({ id, ...msg })
    };

    const dispatcher = createActionDispatcher({
      conversationStore,
      capabilityRegistry: capRegistry,
      scheduler: null,
      logger: console,
      llm
    });

    const blockRegistry = {
      presentation,
      simple_intake: simpleIntake,
      payment
    };

    executor = createBlockExecutor({ actionDispatcher: dispatcher, blockRegistry });
  });

  const journeyDef = {
    journey_type: 'test',
    blocks: [
      { block: 'presentation', params: { offering_slug: 'hormone-panel' } },
      { block: 'simple_intake', params: { required_fields: ['customerName', 'customerEmail'] } },
      { block: 'payment', params: { amount_cents: 14900, product_slug: 'labs', provider: 'square' } }
    ]
  };

  it('ignores events the block does not handle', async () => {
    const result = await executor.execute({
      event: { type: 'api', payload: {} },
      context: { current_block: 'simple_intake' },
      blockDef: journeyDef.blocks[1],
      journeyDef
    });
    assert.equal(result.transitioned, false);
    assert.equal(result.actions.length, 0);
  });

  it('handles conversational block — LLM parses and responds', async () => {
    const result = await executor.execute({
      event: { type: 'conversation', payload: { text: 'I am so tired and gaining weight' } },
      context: { current_block: 'presentation', journey_status: 'in_progress', block_history: [{ block: 'presentation', entered: '2026-01-01', exited: null }] },
      blockDef: journeyDef.blocks[0],
      journeyDef
    });

    // Presentation block: user engaged → should transition to simple_intake
    assert.equal(result.transitioned, true);
    assert.equal(result.newContext.current_block, 'simple_intake');
    assert.ok(result.actions.length > 0);
  });

  it('handles conversational block — stays when not complete', async () => {
    const result = await executor.execute({
      event: { type: 'conversation', payload: { text: 'Jane Smith' } },
      context: {
        current_block: 'simple_intake',
        journey_status: 'in_progress',
        block_history: [{ block: 'simple_intake', entered: '2026-01-01', exited: null }],
        intake: {}
      },
      blockDef: journeyDef.blocks[1],
      journeyDef
    });

    // Extracted name but still missing email → no transition
    assert.equal(result.transitioned, false);
    assert.equal(result.newContext.current_block, 'simple_intake');
    assert.equal(result.newContext.simple_intake.customerName, 'Jane Smith');
  });

  it('handles conversational block — transitions when complete', async () => {
    const result = await executor.execute({
      event: { type: 'conversation', payload: { text: 'jane@example.com' } },
      context: {
        current_block: 'simple_intake',
        journey_status: 'in_progress',
        block_history: [{ block: 'simple_intake', entered: '2026-01-01', exited: null }],
        intake: { customerName: 'Jane Smith' },
        simple_intake: { customerName: 'Jane Smith' }
      },
      blockDef: journeyDef.blocks[1],
      journeyDef
    });

    // Email extracted + name already present → all required fields met → transition
    assert.equal(result.newContext.simple_intake.customerEmail, 'jane@example.com');
    assert.equal(result.transitioned, true);
    assert.equal(result.newContext.current_block, 'payment');
  });

  it('handles capability block — api event triggers transition', async () => {
    const result = await executor.execute({
      event: { type: 'api', source: 'square_webhook', payload: { status: 'completed', order_id: 'SQ-1' } },
      context: {
        current_block: 'payment',
        journey_status: 'in_progress',
        block_history: [{ block: 'payment', entered: '2026-01-01', exited: null }],
        payment: { order_id: 'SQ-1', status: 'pending' },
        conversation_id: 'c1'
      },
      blockDef: journeyDef.blocks[2],
      journeyDef
    });

    // Payment completed on last block → journey complete
    assert.equal(result.newContext.payment.status, 'completed');
    assert.equal(result.newContext.journey_status, 'completed');
  });

  it('handles capability block — failed payment stays in block', async () => {
    const result = await executor.execute({
      event: { type: 'api', source: 'square_webhook', payload: { status: 'failed' } },
      context: {
        current_block: 'payment',
        journey_status: 'in_progress',
        block_history: [{ block: 'payment', entered: '2026-01-01', exited: null }],
        payment: { order_id: 'SQ-1', status: 'pending' },
        conversation_id: 'c1'
      },
      blockDef: journeyDef.blocks[2],
      journeyDef
    });

    assert.equal(result.transitioned, false);
    assert.equal(result.newContext.current_block, 'payment');
    assert.equal(result.newContext.payment.status, 'failed');
  });

  it('handles system event on presentation block', async () => {
    const result = await executor.execute({
      event: { type: 'system', source: 'widget_loaded', payload: {} },
      context: {
        current_block: 'presentation',
        journey_status: 'not_started',
        block_history: [{ block: 'presentation', entered: '2026-01-01', exited: null }]
      },
      blockDef: journeyDef.blocks[0],
      journeyDef
    });

    assert.equal(result.newContext.journey_status, 'in_progress');
    assert.equal(result.transitioned, false);
  });
});
