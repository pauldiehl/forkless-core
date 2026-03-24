const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../db/adapter');

let db;

beforeEach(() => {
  db = createAdapter(':memory:');
});

describe('users', () => {
  it('creates and retrieves a user', () => {
    const user = db.users.create({ email: 'jane@example.com', name: 'Jane Smith' });
    assert.ok(user.id.startsWith('user_'));
    assert.equal(user.email, 'jane@example.com');
    assert.equal(user.name, 'Jane Smith');

    const fetched = db.users.get(user.id);
    assert.deepEqual(fetched, user);
  });

  it('finds user by email', () => {
    db.users.create({ email: 'jane@example.com', name: 'Jane' });
    const found = db.users.getByEmail('jane@example.com');
    assert.equal(found.name, 'Jane');
    assert.equal(db.users.getByEmail('nobody@x.com'), null);
  });

  it('updates a user', () => {
    const user = db.users.create({ email: 'jane@example.com' });
    const updated = db.users.update(user.id, { name: 'Jane Updated', phone: '555-0001' });
    assert.equal(updated.name, 'Jane Updated');
    assert.equal(updated.phone, '555-0001');
  });

  it('lists users', () => {
    db.users.create({ email: 'a@x.com' });
    db.users.create({ email: 'b@x.com' });
    const list = db.users.list();
    assert.equal(list.length, 2);
  });

  it('enforces unique email', () => {
    db.users.create({ email: 'jane@example.com' });
    assert.throws(() => db.users.create({ email: 'jane@example.com' }));
  });
});

describe('journey_instances', () => {
  let user;

  beforeEach(() => {
    user = db.users.create({ email: 'jane@example.com' });
  });

  it('creates with default context', () => {
    const ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'medical_consult_labs' });
    assert.ok(ji.id.startsWith('ji_'));
    assert.equal(ji.journey_type, 'medical_consult_labs');
    assert.equal(ji.status, 'not_started');
    assert.deepEqual(ji.context, {});
  });

  it('creates with initial context', () => {
    const ctx = { current_block: 'presentation', journey_status: 'in_progress' };
    const ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'labs', context: ctx });
    assert.equal(ji.context.current_block, 'presentation');
  });

  it('puts updated context', () => {
    const ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'labs' });
    const newCtx = { current_block: 'intake', journey_status: 'in_progress', intake: { name: 'Jane' } };
    db.journeyInstances.put(ji.id, { context: newCtx, status: 'in_progress' });
    const fetched = db.journeyInstances.get(ji.id);
    assert.equal(fetched.status, 'in_progress');
    assert.equal(fetched.context.intake.name, 'Jane');
  });

  it('finds by user', () => {
    db.journeyInstances.create({ user_id: user.id, journey_type: 'a' });
    db.journeyInstances.create({ user_id: user.id, journey_type: 'b' });
    const found = db.journeyInstances.findByUser(user.id);
    assert.equal(found.length, 2);
  });

  it('filters by status', () => {
    const ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'a' });
    db.journeyInstances.put(ji.id, { context: {}, status: 'completed' });
    const active = db.journeyInstances.findByUser(user.id, { status: 'not_started' });
    assert.equal(active.length, 0);
    const completed = db.journeyInstances.findByUser(user.id, { status: 'completed' });
    assert.equal(completed.length, 1);
  });
});

describe('conversations', () => {
  let user, ji;

  beforeEach(() => {
    user = db.users.create({ email: 'jane@example.com' });
    ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'labs' });
  });

  it('creates a conversation', () => {
    const convo = db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    assert.ok(convo.id.startsWith('convo_'));
    assert.deepEqual(convo.messages, []);
    assert.equal(convo.mode, 'agent');
  });

  it('adds messages', () => {
    const convo = db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    db.conversations.addMessage(convo.id, { role: 'customer', text: 'Hello' });
    db.conversations.addMessage(convo.id, { role: 'agent', text: 'Hi there!' });
    const fetched = db.conversations.get(convo.id);
    assert.equal(fetched.messages.length, 2);
    assert.equal(fetched.messages[0].role, 'customer');
    assert.equal(fetched.messages[1].text, 'Hi there!');
  });

  it('finds by journey', () => {
    db.conversations.create({ user_id: user.id, journey_instance_id: ji.id });
    const found = db.conversations.findByJourney(ji.id);
    assert.equal(found.length, 1);
  });
});

describe('events_log', () => {
  let user, ji;

  beforeEach(() => {
    user = db.users.create({ email: 'jane@example.com' });
    ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'labs' });
  });

  it('logs and retrieves events', () => {
    db.eventsLog.put({ journey_instance_id: ji.id, type: 'conversation', source: 'customer', payload: { text: 'hi' } });
    db.eventsLog.put({ journey_instance_id: ji.id, type: 'api', source: 'labcorp', payload: { status: 'ready' } });
    const all = db.eventsLog.findByJourney(ji.id);
    assert.equal(all.length, 2);
    assert.equal(all[0].payload.status, 'ready'); // DESC order
  });

  it('filters by type', () => {
    db.eventsLog.put({ journey_instance_id: ji.id, type: 'conversation', payload: {} });
    db.eventsLog.put({ journey_instance_id: ji.id, type: 'api', payload: {} });
    const apis = db.eventsLog.findByJourney(ji.id, { type: 'api' });
    assert.equal(apis.length, 1);
  });
});

describe('business_records', () => {
  let user, ji;

  beforeEach(() => {
    user = db.users.create({ email: 'jane@example.com' });
    ji = db.journeyInstances.create({ user_id: user.id, journey_type: 'labs' });
  });

  it('creates and retrieves records', () => {
    const rec = db.businessRecords.create({
      journey_instance_id: ji.id,
      record_type: 'lab_order',
      data: { lab_id: 'LAB123', panels: ['cbc'] }
    });
    assert.ok(rec.id.startsWith('br_'));
    assert.equal(rec.record_type, 'lab_order');
    assert.equal(rec.data.lab_id, 'LAB123');
  });

  it('finds by journey and type', () => {
    db.businessRecords.create({ journey_instance_id: ji.id, record_type: 'order', data: {} });
    db.businessRecords.create({ journey_instance_id: ji.id, record_type: 'lab_order', data: {} });
    const labs = db.businessRecords.findByJourney(ji.id, { record_type: 'lab_order' });
    assert.equal(labs.length, 1);
  });
});

describe('campaigns', () => {
  it('creates and updates campaigns', () => {
    const camp = db.campaigns.create({ name: 'Q1 Labs', config: { discount: 10 } });
    assert.ok(camp.id.startsWith('camp_'));
    assert.equal(camp.status, 'draft');
    assert.equal(camp.config.discount, 10);

    const updated = db.campaigns.update(camp.id, { status: 'active', started_at: '2026-03-01' });
    assert.equal(updated.status, 'active');
  });

  it('lists by status', () => {
    db.campaigns.create({ name: 'A' });
    const b = db.campaigns.create({ name: 'B' });
    db.campaigns.update(b.id, { status: 'active' });
    const active = db.campaigns.list({ status: 'active' });
    assert.equal(active.length, 1);
    assert.equal(active[0].name, 'B');
  });
});
