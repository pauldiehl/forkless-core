/**
 * Registry of external capabilities (API integrations).
 *
 * Each capability is: { execute: async (params, context) => result }
 * Capabilities are the ONLY place where real business logic exists.
 * Everything else is routing and config interpretation.
 */

function createCapabilityRegistry() {
  const capabilities = {};

  function register(name, capability) {
    if (!capability || typeof capability.execute !== 'function') {
      throw new Error(`Capability "${name}" must have an execute function`);
    }
    capabilities[name] = capability;
  }

  function get(name) {
    return capabilities[name] || null;
  }

  function list() {
    return Object.keys(capabilities);
  }

  function has(name) {
    return name in capabilities;
  }

  return { register, get, list, has, capabilities };
}

module.exports = { createCapabilityRegistry };
