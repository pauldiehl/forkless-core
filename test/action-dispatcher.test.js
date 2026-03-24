const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createActionDispatcher, resolveTemplate, runValidation, computeRunAt } = require('../runtime/action-dispatcher');
const { createCapabilityRegistry } = require('../runtime/capability-registry');
const { createScheduler } = require('../core/scheduler');

describe('resolveTemplate', () => {
  it('resolves flat variables', () => {
    assert.equal(resolveTemplate('Hello {{name}}!', { name: 'Jane' }), 'Hello Jane!');
  });

  it('resolves nested variables', () => {
    assert.equal(
      resolveTemplate('Paid {{payment.amount_cents}} cents', { payment: { amount_cents: 14900 } }),
      'Paid 14900 cents'
    );
  });

  it('leaves unresolved placeholders intact', () => {
    assert.equal(resolveTemplate('Hi {{missing}}', {}), 'Hi {{missing}}');
  });
});

describe('runValidation', () => {
  it('passes when required fields exist', () => {
    const result = runValidation(
      { type: 'validate', rules: [{ field: 'intake.name', required: true }] },
      { intake: { name: 'Jane' } },
      {}
    );
    assert.equal(result.valid, true);
  });

  it('fails when required field is missing', () => {
    const result = runValidation(
      { type: 'validate', rules: [{ field: 'intake.name', required: true }] },
      { intake: {} },
      {}
    );
    assert.equal(result.valid, false);
    assert.ok(result.reason.includes('intake.name'));
  });

  it('validates patterns', () => {
    const action = { type: 'validate', rules: [{ field: 'intake.email', pattern: '^.+@.+\\..+$' }] };
    assert.equal(runValidation(action, { intake: { email: 'jane@x.com' } }, {}).valid, true);
    assert.equal(runValidation(action, { intake: { email: 'bad' } }, {}).valid, false);
  });
});

describe('computeRunAt', () => {
  it('computes minutes delay', () => {
    const result = new Date(computeRunAt('30m'));
    const expected = Date.now() + 30 * 60000;
    assert.ok(Math.abs(result.getTime() - expected) < 1000);
  });

  it('computes hours delay', () => {
    const result = new Date(computeRunAt('48h'));
    const expected = Date.now() + 48 * 3600000;
    assert.ok(Math.abs(result.getTime() - expected) < 1000);
  });

  it('computes days delay', () => {
    const result = new Date(computeRunAt('7d'));
    const expected = Date.now() + 7 * 86400000;
    assert.ok(Math.abs(result.getTime() - expected) < 1000);
  });

  it('returns ISO string as-is', () => {
    const iso = '2026-04-01T00:00:00Z';
    assert.equal(computeRunAt(iso), iso);
  });
});

describe('action-dispatcher dispatch', () => {
  let dispatcher;
  let sentMessages;
  let capRegistry;
  let scheduler;

  beforeEach(() => {
    sentMessages = [];
    const conversationStore = {
      addMessage: async (convoId, msg) => {
        sentMessages.push({ convoId, ...msg });
      }
    };
    capRegistry = createCapabilityRegistry();
    scheduler = createScheduler();

    dispatcher = createActionDispatcher({
      conversationStore,
      capabilityRegistry: capRegistry,
      scheduler,
      logger: { log: () => {}, info: () => {}, error: () => {} },
      llm: null
    });
  });

  it('dispatches respond with template', async () => {
    const result = await dispatcher.dispatch(
      { type: 'respond', template: 'Hello {{intake.name}}!' },
      { conversation_id: 'c1', intake: { name: 'Jane' } },
      {}
    );
    assert.equal(result.sent, true);
    assert.equal(result.text, 'Hello Jane!');
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].text, 'Hello Jane!');
  });

  it('dispatches respond without LLM returns not sent', async () => {
    const result = await dispatcher.dispatch(
      { type: 'respond', payload: { intent: 'greeting', context: {}, block: {} } },
      { conversation_id: 'c1' },
      {}
    );
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'no_llm_configured');
  });

  it('dispatches transaction_note', async () => {
    const result = await dispatcher.dispatch(
      { type: 'transaction_note', text: 'Payment received' },
      { conversation_id: 'c1' },
      {}
    );
    assert.equal(result.sent, true);
    assert.equal(sentMessages[0].role, 'transaction');
  });

  it('dispatches execute_capability', async () => {
    capRegistry.register('test_cap', {
      execute: async (params) => ({ result: params.x * 2 })
    });
    const result = await dispatcher.dispatch(
      { type: 'execute_capability', capability: 'test_cap', params: { x: 5 } },
      {},
      {}
    );
    assert.equal(result.result, 10);
  });

  it('throws for unknown capability', async () => {
    await assert.rejects(
      () => dispatcher.dispatch({ type: 'execute_capability', capability: 'nope' }, {}, {}),
      /Unknown capability: nope/
    );
  });

  it('dispatches validate', async () => {
    const result = await dispatcher.dispatch(
      { type: 'validate', rules: [{ field: 'name', required: true }] },
      { name: 'Jane' },
      {}
    );
    assert.equal(result.valid, true);
  });

  it('dispatches schedule', async () => {
    const result = await dispatcher.dispatch(
      { type: 'schedule', payload: { job_type: 'reminder', delay: '48h' } },
      { journey_id: 'j1' },
      {}
    );
    assert.equal(result.scheduled, true);
    const jobs = await scheduler.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, 'reminder');
  });

  it('dispatches log', async () => {
    const result = await dispatcher.dispatch(
      { type: 'log', payload: { level: 'info', message: 'test' } },
      {},
      {}
    );
    assert.equal(result.logged, true);
  });

  it('dispatches update_context', async () => {
    const result = await dispatcher.dispatch({ type: 'update_context' }, {}, {});
    assert.equal(result.applied, true);
  });

  it('dispatches transition', async () => {
    const result = await dispatcher.dispatch({ type: 'transition' }, {}, {});
    assert.equal(result.noted, true);
  });

  it('throws for unknown action type', async () => {
    await assert.rejects(
      () => dispatcher.dispatch({ type: 'unknown_action' }, {}, {}),
      /Unknown action type/
    );
  });
});
