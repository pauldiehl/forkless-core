const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCapabilityRegistry } = require('../runtime/capability-registry');

describe('capability-registry', () => {
  it('registers and retrieves a capability', () => {
    const registry = createCapabilityRegistry();
    const mockCap = { execute: async (params) => ({ success: true }) };
    registry.register('square_checkout', mockCap);
    assert.equal(registry.get('square_checkout'), mockCap);
    assert.ok(registry.has('square_checkout'));
  });

  it('returns null for unregistered capability', () => {
    const registry = createCapabilityRegistry();
    assert.equal(registry.get('nonexistent'), null);
    assert.ok(!registry.has('nonexistent'));
  });

  it('lists registered capabilities', () => {
    const registry = createCapabilityRegistry();
    registry.register('a', { execute: async () => {} });
    registry.register('b', { execute: async () => {} });
    const names = registry.list();
    assert.deepEqual(names.sort(), ['a', 'b']);
  });

  it('rejects capabilities without execute function', () => {
    const registry = createCapabilityRegistry();
    assert.throws(() => registry.register('bad', {}), /execute function/);
    assert.throws(() => registry.register('bad', { execute: 'not a function' }), /execute function/);
  });
});
