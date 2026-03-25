const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validate, buildBlockRegistry, loadJourney } = require('../core/journey-loader');

const simpleIntake = require('../blocks/simple_intake');
const payment = require('../blocks/payment');
const presentation = require('../blocks/presentation');

describe('buildBlockRegistry', () => {
  it('builds registry from block contracts', () => {
    const registry = buildBlockRegistry([simpleIntake, payment, presentation]);
    assert.ok(registry.simple_intake);
    assert.ok(registry.payment);
    assert.ok(registry.presentation);
    assert.equal(registry.simple_intake.type, 'conversational');
    assert.equal(registry.payment.type, 'capability');
  });

  it('throws for block without name', () => {
    assert.throws(() => buildBlockRegistry([{ type: 'conversational' }]), /must have a name/);
  });
});

describe('validate', () => {
  const blockRegistry = buildBlockRegistry([simpleIntake, payment, presentation]);

  it('validates a correct journey definition', () => {
    assert.doesNotThrow(() => validate({
      journey_type: 'test',
      blocks: [
        { block: 'presentation', params: {} },
        { block: 'simple_intake', params: { required_fields: ['name'] } },
        { block: 'payment', params: { amount_cents: 100, product_slug: 'x', provider: 'square' } }
      ]
    }, blockRegistry));
  });

  it('rejects missing journey_type', () => {
    assert.throws(() => validate({ blocks: [{ block: 'presentation' }] }, blockRegistry), /journey_type/);
  });

  it('rejects empty blocks', () => {
    assert.throws(() => validate({ journey_type: 'x', blocks: [] }, blockRegistry), /at least one block/);
  });

  it('rejects unregistered blocks', () => {
    assert.throws(() => validate({
      journey_type: 'x',
      blocks: [{ block: 'nonexistent' }]
    }, blockRegistry), /not registered/);
  });
});

describe('loadJourney from object', () => {
  const blockRegistry = buildBlockRegistry([simpleIntake, payment, presentation]);

  it('loads and validates a journey object', () => {
    const def = loadJourney({
      journey_type: 'test',
      blocks: [{ block: 'presentation', params: {} }]
    }, blockRegistry);

    assert.equal(def.journey_type, 'test');
    assert.equal(def.blocks.length, 1);
  });
});
