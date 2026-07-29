const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Queen, DEFAULT_CONFIG } = require('../lib/queen');

function makeHive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.fleet', 'active'), { recursive: true });
  fs.writeFileSync(path.join(root, '.fleet', 'fleet.json'), JSON.stringify({ name: 'test-hive', type: 'brain' }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Test\n## Short section\nline1\nline2\n');
  fs.mkdirSync(path.join(root, 'bee1'));
  return root;
}

function makeQueen(hivePath) {
  return new Queen(() => ({ hives: [{ path: hivePath, name: 'test-hive' }] }));
}

test('recordHeartbeat and getStatus track bees', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  assert.equal(q.getStatus().bees, 0);
  q.recordHeartbeat('bee1', hive);
  assert.equal(q.getStatus().bees, 1);
});

test('recordClaim clears escalation and sets task', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.escalate('bee1', hive, 'stale claim', DEFAULT_CONFIG);
  assert.equal(q.getStatus().escalations, 1);
  q.recordClaim('bee1', hive, 'new task');
  assert.equal(q.getStatus().escalations, 0);
});

test('recordRelease clears escalation and nulls task', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.recordClaim('bee1', hive, 'task A');
  q.escalate('bee1', hive, 'stale', DEFAULT_CONFIG);
  q.recordRelease('bee1', hive);
  assert.equal(q.getStatus().escalations, 0);
});

test('validateClaim returns approved with active bees list', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee2.md'), 'Working on: other task\n');
  const result = q.validateClaim('bee1', hive, 'my task');
  assert.equal(result.approved, true);
  assert.equal(result.activeBees.length, 1);
  assert.equal(result.activeBees[0].bee, 'bee2');
});

test('escalate goes through notice -> warning -> directive -> override', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const cfg = { ...DEFAULT_CONFIG, escalation: { notice_s: 0, warning_s: 0, directive_s: 0, override_s: 0 } };

  q.escalate('bee1', hive, 'stale', cfg);
  assert.equal(q.escalations.get(`${hive}::bee1`).level, 'notice');

  q.escalate('bee1', hive, 'stale', cfg);
  assert.equal(q.escalations.get(`${hive}::bee1`).level, 'warning');

  q.escalate('bee1', hive, 'stale', cfg);
  assert.equal(q.escalations.get(`${hive}::bee1`).level, 'directive');

  q.escalate('bee1', hive, 'stale', cfg);
  assert.equal(q.escalations.get(`${hive}::bee1`).level, 'override');
});

test('inbox enqueue, read, and clear', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.enqueueInbox('bee1', hive, { type: 'test', text: 'hello' });
  q.enqueueInbox('bee1', hive, { type: 'test', text: 'world' });
  const msgs = q.readInbox('bee1', hive);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, 'hello');
  q.clearInbox('bee1', hive);
  assert.equal(q.readInbox('bee1', hive).length, 0);
});

test('acquireLease grants and denies correctly', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const r1 = q.acquireLease('CLAUDE.md', 'bee1', hive, 300);
  assert.equal(r1.granted, true);
  const r2 = q.acquireLease('CLAUDE.md', 'bee2', hive, 300);
  assert.equal(r2.granted, false);
  assert.equal(r2.owner, 'bee1');
});

test('releaseLease allows re-acquisition', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.acquireLease('brain', 'bee1', hive, 300);
  const rel = q.releaseLease('brain', 'bee1', hive);
  assert.equal(rel.released, true);
  const r2 = q.acquireLease('brain', 'bee2', hive, 300);
  assert.equal(r2.granted, true);
});

test('releaseLease rejects wrong owner', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.acquireLease('res', 'bee1', hive, 300);
  const rel = q.releaseLease('res', 'bee2', hive);
  assert.equal(rel.released, false);
});

test('announce enqueues inbox for all bees', t => {
  const hive = makeHive(t);
  fs.mkdirSync(path.join(hive, 'bee2'));
  const q = makeQueen(hive);
  q.announce(hive, 'heads up', 'queen');
  const m1 = q.readInbox('bee1', hive);
  const m2 = q.readInbox('bee2', hive);
  assert.equal(m1.length, 1);
  assert.equal(m1[0].type, 'announcement');
  assert.equal(m2.length, 1);
});

test('brainAudit returns sections and extract candidates', t => {
  const hive = makeHive(t);
  const lines = ['# Test Brain\n', '## Small\n', 'a\nb\n', '## Big\n'];
  for (let i = 0; i < 60; i++) lines.push(`line ${i}\n`);
  fs.writeFileSync(path.join(hive, 'CLAUDE.md'), lines.join(''));
  const q = makeQueen(hive);
  const audit = q.brainAudit(hive);
  assert.ok(audit);
  assert.ok(audit.sections.length >= 2);
  assert.ok(audit.extractCandidates.length >= 1);
  assert.equal(audit.extractCandidates[0].title, 'Big');
});

test('logEvent and recentEvents round-trip', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.logEvent(hive, { type: 'test_event', data: 42 });
  q.logEvent(hive, { type: 'test_event', data: 43 });
  const events = q.recentEvents(hive, 10);
  assert.equal(events.length, 2);
  assert.equal(events[0].data, 43);
  assert.equal(events[1].data, 42);
});

test('auditHive detects stale idle claims and escalates', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee1.md'), 'Working on: Idle — awaiting task\n');
  q.auditHive(hive);
  assert.equal(q.getStatus().escalations, 1);
});

test('auditHive de-escalates when claim is resolved', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee1.md'), 'idle\n');
  q.auditHive(hive);
  assert.equal(q.getStatus().escalations, 1);
  fs.unlinkSync(path.join(hive, '.fleet', 'active', 'bee1.md'));
  q.auditHive(hive);
  assert.equal(q.getStatus().escalations, 0);
});

test('pendingForBee includes escalation and inbox messages', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.escalate('bee1', hive, 'stale claim', DEFAULT_CONFIG);
  q.enqueueInbox('bee1', hive, { type: 'info', text: 'check this' });
  const pending = q.pendingForBee('bee1', hive);
  assert.ok(pending.some(p => p.type === 'escalation'));
  assert.ok(pending.some(p => p.type === 'info'));
});

test('hiveStatus returns combined view', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.recordHeartbeat('bee1', hive);
  q.logEvent(hive, { type: 'test' });
  const status = q.hiveStatus(hive);
  assert.ok(status.bees.bee1);
  assert.ok(Array.isArray(status.drones));
  assert.ok(status.brain);
  assert.ok(Array.isArray(status.events));
});

test('hiveConfig returns defaults when no config file exists', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const cfg = q.hiveConfig(hive);
  assert.equal(cfg.audit_interval_s, 15);
  assert.equal(cfg.escalation.warning_s, 30);
  assert.equal(cfg.brain.section_max_lines, 50);
});

test('overrideCleanup deletes claim file and journals', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const claimFile = path.join(hive, '.fleet', 'active', 'bee1.md');
  fs.writeFileSync(claimFile, 'Working on: Idle — old task\n');
  q.overrideCleanup('bee1', hive, 'stale claim');
  assert.ok(!fs.existsSync(claimFile), 'claim file should be deleted');
  const journal = fs.readFileSync(path.join(hive, '.fleet', 'journal.md'), 'utf8');
  assert.ok(journal.includes('queen'), 'journal should mention queen');
  assert.ok(journal.includes('bee1'), 'journal should mention bee1');
  const events = q.recentEvents(hive, 10);
  assert.ok(events.some(e => e.type === 'override_cleanup'));
});

test('override level triggers overrideCleanup via escalation chain', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const cfg = { ...DEFAULT_CONFIG, escalation: { notice_s: 0, warning_s: 0, directive_s: 0, override_s: 0 } };
  const claimFile = path.join(hive, '.fleet', 'active', 'bee1.md');
  fs.writeFileSync(claimFile, 'Working on: Idle\n');
  q.escalate('bee1', hive, 'stale', cfg);
  q.escalate('bee1', hive, 'stale', cfg);
  q.escalate('bee1', hive, 'stale', cfg);
  q.escalate('bee1', hive, 'stale', cfg);
  assert.ok(!fs.existsSync(claimFile), 'override should delete claim');
});

test('extractBrainSections extracts oversized sections to docs/', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const lines = ['# Brain\n', '## Small\n', 'line1\n', '## Big Section\n'];
  for (let i = 0; i < 60; i++) lines.push(`content line ${i}\n`);
  lines.push('## After\n', 'after content\n');
  fs.writeFileSync(path.join(hive, 'CLAUDE.md'), lines.join(''));
  const audit = q.brainAudit(hive);
  q.extractBrainSections(hive, audit);
  assert.ok(fs.existsSync(path.join(hive, 'docs', 'big-section.md')), 'docs file should be created');
  const brain = fs.readFileSync(path.join(hive, 'CLAUDE.md'), 'utf8');
  assert.ok(brain.includes('See [docs/big-section.md]'), 'brain should have pointer');
  assert.ok(!brain.includes('content line 30'), 'extracted content should be removed from brain');
  assert.ok(brain.includes('## After'), 'non-extracted sections should remain');
});

test('extractBrainSections skips already-extracted sections', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const lines = ['# Brain\n', '## Big Section\n'];
  for (let i = 0; i < 60; i++) lines.push(`content line ${i}\n`);
  fs.writeFileSync(path.join(hive, 'CLAUDE.md'), lines.join(''));
  fs.mkdirSync(path.join(hive, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(hive, 'docs', 'big-section.md'), 'already exists\n');
  const audit = q.brainAudit(hive);
  q.extractBrainSections(hive, audit);
  const docContent = fs.readFileSync(path.join(hive, 'docs', 'big-section.md'), 'utf8');
  assert.equal(docContent, 'already exists\n', 'should not overwrite existing doc');
});

test('drone pruning removes completed drones older than 1 hour', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.drones.set('drone-old', { id: 'drone-old', status: 'completed', finishedAt: Date.now() - 7200000, hive });
  q.drones.set('drone-new', { id: 'drone-new', status: 'completed', finishedAt: Date.now() - 600000, hive });
  q.drones.set('drone-running', { id: 'drone-running', status: 'running', hive });
  q.auditAll();
  assert.ok(!q.drones.has('drone-old'), 'old drone should be pruned');
  assert.ok(q.drones.has('drone-new'), 'recent drone should remain');
  assert.ok(q.drones.has('drone-running'), 'running drone should remain');
});

test('recordHeartbeat auto-deescalates when claim file is gone', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const claimFile = path.join(hive, '.fleet', 'active', 'bee1.md');
  fs.writeFileSync(claimFile, 'Working on: Idle\n');
  q.escalate('bee1', hive, 'stale claim', DEFAULT_CONFIG);
  assert.equal(q.getStatus().escalations, 1);
  fs.unlinkSync(claimFile);
  q.recordHeartbeat('bee1', hive);
  assert.equal(q.getStatus().escalations, 0, 'escalation should be cleared when bee pings with no claim');
});

test('validateClaim returns activeBees with tasks', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee2.md'), 'Working on: build dashboard\n');
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee3.md'), 'Working on: fix tests\n');
  const result = q.validateClaim('bee1', hive, 'new feature');
  assert.equal(result.approved, true);
  assert.equal(result.activeBees.length, 2);
  assert.ok(result.activeBees.some(b => b.bee === 'bee2'));
  assert.ok(result.activeBees.some(b => b.bee === 'bee3'));
});

test('onboardBee detects stale claim and pending inbox', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee1.md'), 'Working on: old task from last session\n');
  q.enqueueInbox('bee1', hive, { type: 'info', text: 'hi' });
  const issues = q.onboardBee('bee1', hive);
  assert.ok(issues, 'should return issues');
  assert.ok(issues.some(i => i.includes('stale claim')));
  assert.ok(issues.some(i => i.includes('unread inbox')));
  const events = q.recentEvents(hive, 10);
  assert.ok(events.some(e => e.type === 'bee_connect'));
});

test('onboardBee returns null when bee is clean', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const issues = q.onboardBee('bee1', hive);
  assert.equal(issues, null, 'clean bee should have no issues');
});

test('first ping triggers onboarding, second does not', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee1.md'), 'Working on: stale\n');
  const first = q.recordHeartbeat('bee1', hive);
  assert.ok(first, 'first ping should return onboarding issues');
  const second = q.recordHeartbeat('bee1', hive);
  assert.equal(second, null, 'second ping should not trigger onboarding');
});

test('bee disconnect is detected when heartbeat goes stale', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const k = `${hive}::bee1`;
  // Simulate a bee that pinged 5 minutes ago (well past the 120s stale threshold)
  q.heartbeats.set(k, { lastPing: Date.now() - 300000, bee: 'bee1', hive: hive, disconnected: false });
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee1.md'), 'Working on: something\n');
  q.auditHive(hive);
  const hb = q.heartbeats.get(k);
  assert.equal(hb.disconnected, true, 'bee should be marked disconnected');
  const events = q.recentEvents(hive, 10);
  assert.ok(events.some(e => e.type === 'bee_disconnect'));
});

test('bee reconnect is logged when disconnected bee pings again', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const k = `${hive}::bee1`;
  q.heartbeats.set(k, { lastPing: Date.now() - 300000, bee: 'bee1', hive: hive, disconnected: true });
  q.recordHeartbeat('bee1', hive);
  const events = q.recentEvents(hive, 10);
  assert.ok(events.some(e => e.type === 'bee_reconnect'));
  assert.equal(q.heartbeats.get(k).disconnected, false);
});

test('start and stop manage timers', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.start();
  assert.ok(q._timer);
  assert.ok(q._brainTimer);
  assert.ok(q._paneTimer);
  assert.ok(q._gitTimer);
  assert.ok(q.startedAt);
  q.stop();
  assert.equal(q._timer, null);
  assert.equal(q._brainTimer, null);
  assert.equal(q._paneTimer, null);
  assert.equal(q._gitTimer, null);
});

// ── Notification system ──

test('notify creates an info notification and increments counter', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const id = q.notify('Test title', 'Test body', { hive });
  assert.ok(id.startsWith('notif-'));
  const notifs = q.getNotifications();
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].title, 'Test title');
  assert.equal(notifs[0].type, 'info');
  assert.equal(notifs[0].read, false);
  assert.equal(notifs[0].resolved, false);
});

test('promptUser creates an action notification with buttons', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const id = q.promptUser('Disconnect', 'bee1 disconnected', [
    { id: 'release_announce', label: 'Release & announce' },
    { id: 'keep', label: 'Keep claim' }
  ], { hive, bee: 'bee1' });
  const notif = q.notifications.get(id);
  assert.equal(notif.type, 'action');
  assert.equal(notif.actions.length, 2);
  assert.equal(notif.actions[0].id, 'release_announce');
});

test('resolveNotification marks notification resolved and records action', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const id = q.promptUser('Test', 'body', [{ id: 'ok', label: 'OK' }], { hive });
  const result = q.resolveNotification(id, 'ok');
  assert.ok(result);
  assert.equal(result.resolved, true);
  assert.equal(result.result.actionId, 'ok');
  const second = q.resolveNotification(id, 'ok');
  assert.equal(second, null, 'cannot resolve twice');
});

test('getNotifications filters by pending and unread', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.notify('Info', 'body', { hive });
  const actionId = q.promptUser('Action', 'body', [{ id: 'ok', label: 'OK' }], { hive });
  q.markRead(actionId);
  assert.equal(q.getNotifications({ pending: true }).length, 1);
  assert.equal(q.getNotifications({ unread: true }).length, 1);
  q.resolveNotification(actionId, 'ok');
  assert.equal(q.getNotifications({ pending: true }).length, 0);
});

test('getStatus includes notification counts', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.notify('A', 'body');
  q.promptUser('B', 'body', [{ id: 'x', label: 'X' }]);
  const status = q.getStatus();
  assert.equal(status.notifications.total, 2);
  assert.equal(status.notifications.unread, 2);
  assert.equal(status.notifications.pending, 1);
});

// ── Post-disconnect flow ──

test('scheduleDisconnectAssessment queues grace timer', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  q.scheduleDisconnectAssessment('bee1', hive);
  assert.equal(q._disconnectGrace.size, 1);
  q.scheduleDisconnectAssessment('bee1', hive);
  assert.equal(q._disconnectGrace.size, 1, 'should not duplicate');
});

test('assessDisconnectedBee creates action notification with assessment', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee1.md'), 'Working on: feature X\n');
  q.assessDisconnectedBee('bee1', hive);
  const notifs = q.getNotifications({ pending: true });
  assert.equal(notifs.length, 1);
  assert.ok(notifs[0].title.includes('bee1'));
  assert.ok(notifs[0].body.includes('feature X'));
  assert.equal(notifs[0].actions.length, 3);
});

test('handleNotificationAction release_announce deletes claim and announces', t => {
  const hive = makeHive(t);
  fs.mkdirSync(path.join(hive, 'bee2'));
  const q = makeQueen(hive);
  const claimFile = path.join(hive, '.fleet', 'active', 'bee1.md');
  fs.writeFileSync(claimFile, 'Working on: task Y\n');
  const id = q.promptUser('bee1 disconnected', 'Task: task Y', [
    { id: 'release_announce', label: 'Release & announce' },
    { id: 'keep', label: 'Keep' }
  ], { hive, bee: 'bee1' });
  q.resolveNotification(id, 'release_announce');
  q.handleNotificationAction(q.notifications.get(id));
  assert.ok(!fs.existsSync(claimFile), 'claim should be deleted');
  const journal = fs.readFileSync(path.join(hive, '.fleet', 'journal.md'), 'utf8');
  assert.ok(journal.includes('bee1'));
  const bee2Inbox = q.readInbox('bee2', hive);
  assert.ok(bee2Inbox.length > 0, 'should announce to other bees');
});

test('handleNotificationAction keep preserves claim file', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const claimFile = path.join(hive, '.fleet', 'active', 'bee1.md');
  fs.writeFileSync(claimFile, 'Working on: task Z\n');
  const id = q.promptUser('bee1 disconnected', 'body', [
    { id: 'release_announce', label: 'Release' },
    { id: 'keep', label: 'Keep' }
  ], { hive, bee: 'bee1' });
  q.resolveNotification(id, 'keep');
  q.handleNotificationAction(q.notifications.get(id));
  assert.ok(fs.existsSync(claimFile), 'claim should still exist');
});

test('disconnect triggers grace then assessment after timeout', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const k = `${hive}::bee1`;
  q.heartbeats.set(k, { lastPing: Date.now() - 300000, bee: 'bee1', hive: hive, disconnected: false });
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee1.md'), 'Working on: something\n');
  q.auditHive(hive);
  assert.equal(q._disconnectGrace.size, 1, 'should schedule grace timer');
  const grace = q._disconnectGrace.get(k);
  grace.assessAt = Date.now() - 1000;
  q.handleDisconnectGrace();
  assert.equal(q._disconnectGrace.size, 0, 'grace should be consumed');
  const notifs = q.getNotifications({ pending: true });
  assert.equal(notifs.length, 1, 'should create action notification');
});

test('disconnect grace is cancelled if bee reconnects before assessment', t => {
  const hive = makeHive(t);
  const q = makeQueen(hive);
  const k = `${hive}::bee1`;
  q.heartbeats.set(k, { lastPing: Date.now() - 300000, bee: 'bee1', hive: hive, disconnected: true });
  q.scheduleDisconnectAssessment('bee1', hive);
  q.recordHeartbeat('bee1', hive);
  const grace = q._disconnectGrace.get(k);
  if (grace) grace.assessAt = Date.now() - 1000;
  q.handleDisconnectGrace();
  assert.equal(q.getNotifications({ pending: true }).length, 0, 'no notification if reconnected');
});
