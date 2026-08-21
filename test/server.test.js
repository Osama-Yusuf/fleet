const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  accountStats,
  lastAssistantMeta,
  mcpToolCall,
  readJSON,
  setQueen,
  setTestConfig,
  strayBees,
} = require('../lib/server');
const { Queen } = require('../lib/queen');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  return { root, home, claude };
}

function writeSession(claudeDir, projectName, cwd, events = []) {
  const project = path.join(claudeDir, 'projects', projectName);
  fs.mkdirSync(project, { recursive: true });
  const records = [{ type: 'user', cwd, timestamp: '2026-07-25T09:59:00.000Z' }, ...events];
  fs.writeFileSync(
    path.join(project, 'session.jsonl'),
    `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
  );
}

function discover(home, config = {}, liveInstances = new Map()) {
  return strayBees({
    home,
    config: { accounts: [], hives: [], scan_paths: [], ...config },
    liveInstances,
    sessionInfo: () => null,
  });
}

test('discovers asleep stray bees from Claude metadata without scan paths', t => {
  const { home, claude, root } = fixture(t);
  const project = path.join(root, 'standalone');
  fs.mkdirSync(project);
  writeSession(claude, 'encoded-project', project);

  const result = discover(home);

  assert.equal(result.length, 1);
  assert.equal(result[0].path, project);
  assert.equal(result[0].active, false);
  assert.deepEqual(result[0].markers, ['sessions']);
});

test('marks running Claude directories active and sorts them first', t => {
  const { home, claude, root } = fixture(t);
  const asleep = path.join(root, 'alpha');
  const active = path.join(root, 'zulu');
  fs.mkdirSync(asleep);
  fs.mkdirSync(active);
  writeSession(claude, 'alpha', asleep);
  writeSession(claude, 'zulu', active);

  const result = discover(
    home,
    { accounts: [{ name: 'primary', config_dir: claude }] },
    new Map([[active, [
      { pid: 123, configDir: claude },
      { pid: 456, configDir: claude },
    ]]]),
  );

  assert.deepEqual(result.map(item => item.name), ['zulu', 'alpha']);
  assert.equal(result[0].active, true);
  assert.deepEqual(result[0].activePids, [123, 456]);
  assert.deepEqual(result[0].activeAccounts, ['primary']);
  assert.equal(result[1].active, false);
});

test('excludes registered hives and every bee inside them', t => {
  const { home, claude, root } = fixture(t);
  const hive = path.join(root, 'hive');
  const bee = path.join(hive, 'bee1');
  const stray = path.join(root, 'stray');
  fs.mkdirSync(bee, { recursive: true });
  fs.mkdirSync(stray);
  writeSession(claude, 'hive', hive);
  writeSession(claude, 'bee', bee);
  writeSession(claude, 'stray', stray);

  const result = discover(home, { hives: [{ name: 'hive', path: hive }] });

  assert.deepEqual(result.map(item => item.path), [stray]);
});

test('scan paths find project-shaped directories and ignore plain folders', t => {
  const { home, root } = fixture(t);
  const repos = path.join(root, 'repos');
  const gitProject = path.join(repos, 'git-project');
  const brainProject = path.join(repos, 'brain-project');
  const plain = path.join(repos, 'plain');
  fs.mkdirSync(path.join(gitProject, '.git'), { recursive: true });
  fs.mkdirSync(brainProject, { recursive: true });
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(brainProject, 'CLAUDE.md'), '# Brain\n');

  const result = discover(home, { scan_paths: [repos] });
  const byName = Object.fromEntries(result.map(item => [item.name, item]));

  assert.deepEqual(Object.keys(byName).sort(), ['brain-project', 'git-project']);
  assert.deepEqual(byName['brain-project'].markers, ['CLAUDE.md']);
  assert.deepEqual(byName['git-project'].markers, ['git']);
});

test('lastAssistantMeta reads the newest valid assistant model and speed', t => {
  const { root } = fixture(t);
  const session = path.join(root, 'session.jsonl');
  fs.writeFileSync(session, [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-20260101', usage: { speed: 'standard' } } }),
    '{not valid json}',
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-20260725', usage: { speed: 'fast' } } }),
  ].join('\n'));

  assert.deepEqual(lastAssistantMeta(session), { model: 'opus', speed: 'fast' });
});

test('readJSON returns null for missing or malformed JSON', t => {
  const { root } = fixture(t);
  const malformed = path.join(root, 'bad.json');
  fs.writeFileSync(malformed, '{bad');

  assert.equal(readJSON(path.join(root, 'missing.json')), null);
  assert.equal(readJSON(malformed), null);
});

test('accountStats aggregates live JSONL data when Claude has no stats cache', t => {
  const { claude, root } = fixture(t);
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  writeSession(claude, 'project', cwd, [
    { type: 'assistant', timestamp: '2026-07-25T10:00:00.000Z', message: {
      model: 'claude-opus-4-8-20260725',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      content: [{ type: 'tool_use', name: 'Read' }],
    } },
  ]);
  fs.writeFileSync(
    path.join(claude, 'history.jsonl'),
    `${JSON.stringify({ timestamp: Date.parse('2026-07-26T08:00:00.000Z'), project: cwd })}\n`,
  );

  const stats = accountStats(claude);

  assert.equal(stats.source, 'session-files');
  assert.equal(stats.totalSessions, 1);
  assert.equal(stats.totalMessages, 2);
  assert.equal(stats.firstSession, '2026-07-26T08:00:00.000Z');
  assert.equal(stats.dailyActivity[0].messageCount, 2);
  assert.equal(stats.dailyActivity[0].toolCallCount, 1);
  assert.deepEqual(stats.modelUsage['opus-4-8'], {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
  });
  assert.ok(stats.updatedAt);
});

// ── MCP tool tests ──

function mcpFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mcp-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setQueen(null);
    setTestConfig(null);
  });
  const hive = path.join(root, 'hive');
  fs.mkdirSync(path.join(hive, '.fleet', 'active'), { recursive: true });
  fs.mkdirSync(path.join(hive, 'bee1'));
  fs.mkdirSync(path.join(hive, 'bee2'));
  fs.writeFileSync(path.join(hive, '.fleet', 'fleet.json'), JSON.stringify({ name: 'test-hive', type: 'brain' }));
  const q = new Queen(() => ({ hives: [{ path: hive, name: 'test-hive' }] }));
  setQueen(q);
  setTestConfig({ hives: [{ path: hive, name: 'test-hive' }], accounts: [], scan_paths: [] });
  return { root, hive, queen: q };
}

test('fleet_ping returns alive status and records heartbeat', t => {
  const { queen: q } = mcpFixture(t);
  const result = JSON.parse(mcpToolCall('fleet_ping', {}, 'bee1', 'test-hive'));
  assert.equal(result.status, 'alive');
  assert.equal(result.bee, 'bee1');
  assert.equal(q.getStatus().bees, 1);
});

test('fleet_claim writes claim file and returns active bees', t => {
  const { hive } = mcpFixture(t);
  const result = JSON.parse(mcpToolCall('fleet_claim', { task: 'implement login' }, 'bee1', 'test-hive'));
  assert.equal(result.status, 'claimed');
  assert.equal(result.task, 'implement login');
  const content = fs.readFileSync(path.join(hive, '.fleet', 'active', 'bee1.md'), 'utf8');
  assert.ok(content.includes('implement login'));
});

test('fleet_claim detects file overlap conflicts', t => {
  const { hive } = mcpFixture(t);
  mcpToolCall('fleet_claim', { task: 'edit lib/server.js and lib/queen.js' }, 'bee1', 'test-hive');
  const result = JSON.parse(mcpToolCall('fleet_claim', { task: 'refactor lib/server.js' }, 'bee2', 'test-hive'));
  assert.equal(result.status, 'claimed');
  assert.ok(result.activeBees.length > 0);
});

test('fleet_release removes claim file', t => {
  const { hive } = mcpFixture(t);
  mcpToolCall('fleet_claim', { task: 'test task' }, 'bee1', 'test-hive');
  assert.ok(fs.existsSync(path.join(hive, '.fleet', 'active', 'bee1.md')));
  const result = JSON.parse(mcpToolCall('fleet_release', {}, 'bee1', 'test-hive'));
  assert.equal(result.status, 'released');
  assert.ok(!fs.existsSync(path.join(hive, '.fleet', 'active', 'bee1.md')));
});

test('fleet_journal appends to journal file', t => {
  const { hive } = mcpFixture(t);
  fs.writeFileSync(path.join(hive, '.fleet', 'journal.md'), '# Fleet Journal\n');
  const result = JSON.parse(mcpToolCall('fleet_journal', { entry: 'Completed the auth module' }, 'bee1', 'test-hive'));
  assert.equal(result.status, 'journaled');
  const journal = fs.readFileSync(path.join(hive, '.fleet', 'journal.md'), 'utf8');
  assert.ok(journal.includes('Completed the auth module'));
  assert.ok(journal.includes('bee1'));
});

test('fleet_lock acquires and fleet_unlock releases a lease', t => {
  mcpFixture(t);
  const lockResult = JSON.parse(mcpToolCall('fleet_lock', { resource: 'CLAUDE.md' }, 'bee1', 'test-hive'));
  assert.equal(lockResult.granted, true);
  const conflictResult = JSON.parse(mcpToolCall('fleet_lock', { resource: 'CLAUDE.md' }, 'bee2', 'test-hive'));
  assert.equal(conflictResult.granted, false);
  assert.equal(conflictResult.owner, 'bee1');
  const unlockResult = JSON.parse(mcpToolCall('fleet_unlock', { resource: 'CLAUDE.md' }, 'bee1', 'test-hive'));
  assert.equal(unlockResult.released, true);
  const retryResult = JSON.parse(mcpToolCall('fleet_lock', { resource: 'CLAUDE.md' }, 'bee2', 'test-hive'));
  assert.equal(retryResult.granted, true);
});

test('fleet_ping shows other active bees', t => {
  mcpFixture(t);
  mcpToolCall('fleet_claim', { task: 'working on tests' }, 'bee1', 'test-hive');
  const result = JSON.parse(mcpToolCall('fleet_ping', {}, 'bee2', 'test-hive'));
  assert.ok(result.activeBees);
  assert.equal(result.activeBees.length, 1);
  assert.equal(result.activeBees[0].bee, 'bee1');
});

test('fleet_ping warns when claim contains idle/done keywords', t => {
  const { hive } = mcpFixture(t);
  fs.writeFileSync(path.join(hive, '.fleet', 'active', 'bee1.md'), 'Task is done, waiting for review\n');
  const result = JSON.parse(mcpToolCall('fleet_ping', {}, 'bee1', 'test-hive'));
  assert.ok(result.instruction);
  assert.ok(result.instruction.includes('fleet_release()'));
});

test('fleet_check_inbox returns and clears messages', t => {
  const { queen: q, hive } = mcpFixture(t);
  q.enqueueInbox('bee1', hive, { type: 'info', text: 'Hello bee1' });
  const result = JSON.parse(mcpToolCall('fleet_check_inbox', {}, 'bee1', 'test-hive'));
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, 'Hello bee1');
  const empty = JSON.parse(mcpToolCall('fleet_check_inbox', {}, 'bee1', 'test-hive'));
  assert.equal(empty.messages.length, 0);
});

test('fleet_message delivers to recipient inbox and logs event', t => {
  const { hive } = mcpFixture(t);
  const result = JSON.parse(mcpToolCall('fleet_message', { to: 'bee2', message: 'Need review on PR #5' }, 'bee1', 'test-hive'));
  assert.equal(result.status, 'sent');
  assert.equal(result.from, 'bee1');
  assert.equal(result.to, 'bee2');
  const inbox = JSON.parse(mcpToolCall('fleet_check_inbox', {}, 'bee2', 'test-hive'));
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].type, 'bee_message');
  assert.equal(inbox.messages[0].from, 'bee1');
  assert.equal(inbox.messages[0].text, 'Need review on PR #5');
});

test('fleet_ping includes peer hint when other bees active', t => {
  mcpFixture(t);
  mcpToolCall('fleet_claim', { task: 'working on tests' }, 'bee1', 'test-hive');
  const result = JSON.parse(mcpToolCall('fleet_ping', {}, 'bee2', 'test-hive'));
  assert.ok(result.activeBees);
  assert.ok(result.peerHint);
  assert.ok(result.peerHint.includes('SendMessage'));
});

test('fleet_message requires to and message args', t => {
  mcpFixture(t);
  const result = JSON.parse(mcpToolCall('fleet_message', {}, 'bee1', 'test-hive'));
  assert.equal(result.status, 'error');
  assert.ok(result.message.includes('Required'));
});
