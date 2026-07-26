const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  appendEvent,
  beeLife,
  claudeData,
  gitData,
  readEvents,
  syncBeeEvents,
} = require('../lib/bee-life');

function hiveFixture(t, type = 'brain') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-life-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hive = path.join(root, 'hive');
  const bee = path.join(hive, 'bee1');
  fs.mkdirSync(path.join(hive, '.fleet', 'active'), { recursive: true });
  fs.mkdirSync(bee, { recursive: true });
  fs.writeFileSync(path.join(hive, '.fleet', 'fleet.json'), JSON.stringify({
    name: 'test-hive',
    type,
    created: '2026-07-26',
    bees: { bee1: { created: '2026-07-26', origin: 'init', branch: '', source: '' } },
  }));
  fs.writeFileSync(path.join(hive, '.fleet', 'journal.md'), '# Fleet Journal\n\n---\n');
  return { root, hive, bee };
}

test('appendEvent creates a durable, newest-first bee history', t => {
  const { hive } = hiveFixture(t);
  appendEvent(hive, 'bee1', 'milestone', 'First', {}, '2026-07-26T10:00:00Z');
  appendEvent(hive, 'bee1', 'decision', 'Second', { why: 'test' }, '2026-07-26T11:00:00Z');

  const events = readEvents(hive, 'bee1');

  assert.deepEqual(events.map(event => event.message), ['Second', 'First']);
  assert.equal(events[0].meta.why, 'test');
  assert.ok(fs.existsSync(path.join(hive, '.fleet', 'bees', 'bee1', 'events.jsonl')));
});

test('syncBeeEvents records claim changes and release exactly once', t => {
  const { hive } = hiveFixture(t);
  const active = path.join(hive, '.fleet', 'active', 'bee1.md');
  fs.writeFileSync(active, 'Working on: first task\n');
  syncBeeEvents(hive, 'bee1');
  syncBeeEvents(hive, 'bee1');
  fs.writeFileSync(active, 'Working on: second task\n');
  syncBeeEvents(hive, 'bee1');
  fs.unlinkSync(active);
  syncBeeEvents(hive, 'bee1');
  syncBeeEvents(hive, 'bee1');

  const events = readEvents(hive, 'bee1');

  assert.equal(events.filter(event => event.type === 'task_claimed').length, 1);
  assert.equal(events.filter(event => event.type === 'task_changed').length, 1);
  assert.equal(events.filter(event => event.type === 'task_released').length, 1);
});

test('syncBeeEvents migrates structured journal insights without duplicates', t => {
  const { hive } = hiveFixture(t);
  fs.appendFileSync(path.join(hive, '.fleet', 'journal.md'), `
## 2026-07-26 — bee1
**Did:** Added the bee life page.
**Why:** Permanent history should survive active claims.
**Verified:** All timeline tests pass.
**Next:** Improve PR enrichment.
`);

  syncBeeEvents(hive, 'bee1');
  syncBeeEvents(hive, 'bee1');
  const events = readEvents(hive, 'bee1');

  assert.equal(events.filter(event => event.type === 'journaled').length, 1);
  assert.equal(events.filter(event => event.type === 'decision').length, 1);
  assert.equal(events.filter(event => event.type === 'discovery').length, 1);
  assert.match(events.find(event => event.type === 'journaled').message, /bee life page/);
});

test('gitData derives commits, touched files, dirty files, and PR references', t => {
  const { bee } = hiveFixture(t, 'repo');
  execFileSync('git', ['init'], { cwd: bee });
  execFileSync('git', ['config', 'user.name', 'Fleet Test'], { cwd: bee });
  execFileSync('git', ['config', 'user.email', 'fleet@example.com'], { cwd: bee });
  fs.writeFileSync(path.join(bee, 'app.js'), 'one\n');
  execFileSync('git', ['add', 'app.js'], { cwd: bee });
  execFileSync('git', ['commit', '-m', 'Add timeline (#42)'], { cwd: bee });
  fs.appendFileSync(path.join(bee, 'app.js'), 'two\n');
  fs.writeFileSync(path.join(bee, 'notes.md'), 'draft\n');

  const data = gitData(bee, '2020-01-01');

  assert.equal(data.commits.length, 1);
  assert.equal(data.commits[0].subject, 'Add timeline (#42)');
  assert.deepEqual(data.prs.map(pr => pr.number), [42]);
  assert.ok(data.files.some(file => file.file === 'app.js' && file.dirty));
  assert.ok(data.dirtyFiles.some(file => file.path === 'notes.md'));
});

test('claudeData attributes tools and models only to the requested bee', t => {
  const { root, bee } = hiveFixture(t);
  const config = path.join(root, '.claude-alt');
  const project = path.join(config, 'projects', bee.replace(/\//g, '-'));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'session.jsonl'), [
    JSON.stringify({ type: 'user', cwd: bee, timestamp: '2026-07-26T10:00:00Z' }),
    JSON.stringify({ type: 'assistant', cwd: bee, timestamp: '2026-07-26T10:00:01Z', message: {
      model: 'claude-opus',
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: path.join(bee, 'README.md') } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ],
    } }),
  ].join('\n'));

  const data = claudeData(bee, [{ name: 'secondary', config_dir: config }], root);

  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].account, 'secondary');
  assert.deepEqual(data.tools, [{ name: 'Read', count: 1 }, { name: 'Bash', count: 1 }]);
  assert.deepEqual(data.models, [{ name: 'claude-opus', count: 1 }]);
  assert.deepEqual(data.files, [{
    file: 'README.md',
    touches: 1,
    reads: 1,
    writes: 0,
    tools: ['Read'],
  }]);
});

test('beeLife combines permanent and derived history into tab summaries', t => {
  const { root, hive } = hiveFixture(t);
  appendEvent(hive, 'bee1', 'decision', 'Use append-only JSONL');

  const data = beeLife(hive, 'bee1', {
    accounts: [],
    home: root,
    sessionMetadata: [{ account: 'secondary', cost: 1.25, sessions: 1 }],
  });

  assert.equal(data.name, 'bee1');
  assert.equal(data.summary.decisions, 1);
  assert.equal(data.decisions[0].message, 'Use append-only JSONL');
  assert.equal(data.sessionMetadata[0].cost, 1.25);
  assert.ok(data.timeline.some(event => event.type === 'decision'));
});
