const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { teleport, teleportSequence } = require('./teleport');

const labsOnly = require('./fixtures/labs-only.json');

describe('teleport', () => {
  it('teleports to a block and fires an event', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'api',
        source: 'labcorp_webhook',
        payload: { labcorp_status: 'results_ready', lab_order_id: 'lab_test_001' }
      }
    });

    // Should transition to followup (lab_results_ready is an exit state)
    assert.equal(result.result.handled, true);
    assert.equal(result.context.current_block, 'followup');
    assert.equal(result.beforeContext.current_block, 'lab_processing');
    result.core.close();
  });

  it('teleports to payment and fires failed payment', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'payment',
      event: {
        type: 'api',
        source: 'square_webhook',
        payload: { status: 'failed' }
      }
    });

    assert.equal(result.result.handled, true);
    assert.equal(result.result.transitioned, false);
    assert.equal(result.context.current_block, 'payment');
    assert.equal(result.context.payment.status, 'failed');
    // Should have a response message
    assert.ok(result.messages.length > 0);
    result.core.close();
  });

  it('applies context overrides', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'lab_processing',
      event: {
        type: 'api',
        source: 'labcorp_webhook',
        payload: { labcorp_status: 'results_ready', lab_order_id: 'custom_lab_id' }
      },
      contextOverrides: {
        'lab_processing.lab_order_id': 'custom_lab_id'
      }
    });

    assert.equal(result.result.handled, true);
    result.core.close();
  });

  it('records events in log', async () => {
    const result = await teleport({
      journeyDef: labsOnly,
      atBlock: 'payment',
      event: {
        type: 'api',
        source: 'square_webhook',
        payload: { status: 'completed', order_id: 'sq_test_001' }
      }
    });

    assert.ok(result.events.length >= 1);
    assert.equal(result.events[0].type, 'api');
    result.core.close();
  });
});

describe('teleportSequence', () => {
  it('fires multiple events in sequence', async () => {
    const { results, core } = await teleportSequence({
      journeyDef: labsOnly,
      atBlock: 'presentation',
      events: [
        { type: 'conversation', payload: { text: 'I have been so tired' } },
        { type: 'conversation', payload: { text: 'Jane Smith' } }
      ]
    });

    assert.equal(results.length, 2);
    // First event should transition from presentation to intake
    assert.equal(results[0].result.transitioned, true);
    assert.equal(results[0].context.current_block, 'simple_intake');
    // Second event stays in intake
    assert.equal(results[1].context.current_block, 'simple_intake');
    core.close();
  });
});
