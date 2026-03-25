/**
 * Interactive REPL helper for Forkless Core.
 *
 * Usage:
 *   node -e "require('./repl').start()"
 *   — or —
 *   In node REPL:  const r = require('./repl').start()
 *   Then:          await r.say('I have been so tired lately')
 *                  r.state()
 *                  r.messages()
 */

const { createCore } = require('./index');

function start() {
  const core = createCore({ useMockLLM: true });

  core.registerJourney({
    journey_type: 'medical_consult',
    display_name: 'Medical Consultation',
    blocks: [
      { block: 'presentation', params: { offering_slug: 'hormone-panel' } },
      { block: 'simple_intake', params: { required_fields: ['customerName', 'customerEmail'] } },
      { block: 'recommendation', params: { price_cents: 19900 } },
      { block: 'payment', params: { amount_cents: 19900, product_slug: 'hormone-panel', provider: 'square' } }
    ]
  });

  const user = core.db.users.create({ email: 'paul@test.com', name: 'Paul' });
  const initCtx = core.context.create({
    journey_type: 'medical_consult',
    user_id: user.id,
    initialBlock: 'presentation'
  });
  initCtx.journey_status = 'in_progress';

  const ji = core.db.journeyInstances.create({
    user_id: user.id,
    journey_type: 'medical_consult',
    context: initCtx,
    status: 'in_progress'
  });

  const convo = core.db.conversations.create({
    user_id: user.id,
    journey_instance_id: ji.id
  });

  // Link conversation to context
  core.context.update(ji.id, { conversation_id: convo.id });

  console.log('--- Forkless Core REPL ---');
  console.log(`Journey: ${ji.id}`);
  console.log(`User: ${user.name} (${user.email})`);
  console.log(`Block: ${initCtx.current_block}`);
  console.log('');
  console.log('Commands:');
  console.log('  await r.say("your message")  — send a conversation event');
  console.log('  await r.webhook(payload)     — send an API event');
  console.log('  r.state()                    — show current context');
  console.log('  r.messages()                 — show conversation messages');
  console.log('  r.block()                    — show current block');
  console.log('  r.history()                  — show block history');
  console.log('');

  return {
    core,
    ji,
    convo,

    async say(text) {
      const result = await core.eventRouter.handleEvent({
        type: 'conversation',
        journey_id: ji.id,
        payload: { text }
      });

      const ctx = core.context.read(ji.id);
      const msgs = core.db.conversations.get(convo.id).messages;
      const lastMsg = msgs[msgs.length - 1];

      console.log('');
      console.log(`[${result.transitioned ? 'TRANSITIONED → ' + ctx.current_block : 'STAYED in ' + ctx.current_block}]`);
      if (lastMsg) {
        console.log(`Agent: ${lastMsg.text}`);
      }
      console.log('');
      return result;
    },

    async webhook(payload) {
      const result = await core.eventRouter.handleEvent({
        type: 'api',
        journey_id: ji.id,
        source: payload.source || 'webhook',
        payload
      });

      const ctx = core.context.read(ji.id);
      console.log('');
      console.log(`[Webhook: ${result.transitioned ? 'TRANSITIONED → ' + ctx.current_block : 'STAYED in ' + ctx.current_block}]`);
      console.log(`Journey status: ${ctx.journey_status}`);
      console.log('');
      return result;
    },

    state() {
      const ctx = core.context.read(ji.id);
      console.log(JSON.stringify(ctx, null, 2));
      return ctx;
    },

    block() {
      const ctx = core.context.read(ji.id);
      console.log(`Block: ${ctx.current_block} | State: ${ctx.block_state || 'none'} | Status: ${ctx.journey_status}`);
      return ctx.current_block;
    },

    messages() {
      const msgs = core.db.conversations.get(convo.id).messages;
      msgs.forEach((m, i) => {
        console.log(`  [${m.role}] ${m.text}`);
      });
      return msgs;
    },

    history() {
      const ctx = core.context.read(ji.id);
      (ctx.block_history || []).forEach(h => {
        console.log(`  ${h.block}: entered ${h.entered}${h.exited ? ', exited ' + h.exited : ' (current)'}`);
      });
      return ctx.block_history;
    }
  };
}

module.exports = { start };
