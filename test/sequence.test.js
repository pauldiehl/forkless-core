const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runSequence, formatMarkdown, buildEvent, computeDelta } = require('./sequence');

const labsOnly = require('./fixtures/labs-only.json');

describe('buildEvent', () => {
  it('builds conversation event from CUSTOMER actor', () => {
    const event = buildEvent({ actor: 'CUSTOMER', text: 'hello' }, 'ji_1');
    assert.equal(event.type, 'conversation');
    assert.equal(event.payload.text, 'hello');
    assert.equal(event.journey_id, 'ji_1');
  });

  it('builds api event from WEBHOOK actor', () => {
    const event = buildEvent({ actor: 'WEBHOOK', source: 'square', payload: { status: 'ok' } }, 'ji_1');
    assert.equal(event.type, 'api');
    assert.equal(event.source, 'square');
    assert.equal(event.payload.status, 'ok');
  });

  it('builds scheduled event from SCHEDULER actor', () => {
    const event = buildEvent({ actor: 'SCHEDULER', payload: { job_type: 'reminder' } }, 'ji_1');
    assert.equal(event.type, 'scheduled');
  });

  it('builds system event from SYSTEM actor', () => {
    const event = buildEvent({ actor: 'SYSTEM', source: 'widget_loaded' }, 'ji_1');
    assert.equal(event.type, 'system');
  });
});

describe('computeDelta', () => {
  it('detects added keys', () => {
    const delta = computeDelta({ a: 1 }, { a: 1, b: 2 });
    assert.equal(delta.b, 2);
    assert.equal(delta.a, undefined);
  });

  it('detects changed keys', () => {
    const delta = computeDelta({ a: 1 }, { a: 2 });
    assert.equal(delta.a, 2);
  });

  it('detects nested changes', () => {
    const delta = computeDelta(
      { intake: { name: 'Jane' } },
      { intake: { name: 'Jane', email: 'j@x.com' } }
    );
    assert.ok(delta.intake);
    assert.equal(delta.intake.email, 'j@x.com');
  });
});

describe('runSequence', () => {
  it('runs a basic script and collects entries', async () => {
    const log = await runSequence({
      journeyDef: labsOnly,
      script: [
        { actor: 'CUSTOMER', text: 'I have been so tired and gaining weight' },
        { actor: 'CUSTOMER', text: 'Jane Smith' }
      ]
    });

    assert.equal(log.entries.length, 2);
    assert.equal(log.entries[0].actor, 'CUSTOMER');
    assert.equal(log.entries[0].transitioned, true);
    assert.equal(log.entries[0].afterBlock, 'simple_intake');
    assert.equal(log.entries[1].transitioned, false);
  });

  it('tracks context deltas between events', async () => {
    const log = await runSequence({
      journeyDef: labsOnly,
      script: [
        { actor: 'CUSTOMER', text: 'I am tired and gaining weight' }
      ]
    });

    // Should have delta showing block changed
    const entry = log.entries[0];
    assert.ok(entry.delta);
    assert.equal(entry.delta.current_block, 'simple_intake');
  });
});

describe('formatMarkdown', () => {
  it('produces valid markdown output', async () => {
    const log = await runSequence({
      journeyDef: labsOnly,
      script: [
        { actor: 'CUSTOMER', text: 'I am tired' },
        { actor: 'CUSTOMER', text: 'Jane Smith' }
      ]
    });

    const md = formatMarkdown(log);
    assert.ok(md.includes('# Sequence Log: labs_only'));
    assert.ok(md.includes('### BLOCK:'));
    assert.ok(md.includes('[CUSTOMER]'));
    assert.ok(md.includes('### Final Context'));
  });
});
