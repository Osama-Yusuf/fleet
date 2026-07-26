const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const fleet = path.join(__dirname, '..', 'bin', 'fleet');

test('fleet shell script has valid Bash syntax', () => {
  const result = spawnSync('bash', ['-n', fleet], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('fleet help documents stray discovery and exits successfully', () => {
  const result = spawnSync(fleet, ['--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scan\s+Scan for hives and standalone stray bees/);
});

test('fleet event appends a durable event from inside a bee', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hive = path.join(root, 'hive');
  const bee = path.join(hive, 'bee1');
  fs.mkdirSync(path.join(hive, '.fleet'), { recursive: true });
  fs.mkdirSync(bee);
  fs.writeFileSync(path.join(hive, '.fleet', 'fleet.json'), JSON.stringify({
    name: 'test',
    type: 'brain',
    bees: { bee1: { created: '2026-07-26' } },
  }));

  const result = spawnSync(fleet, ['event', 'decision', 'Use permanent JSONL'], {
    cwd: bee,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const line = fs.readFileSync(path.join(hive, '.fleet', 'bees', 'bee1', 'events.jsonl'), 'utf8').trim();
  const event = JSON.parse(line);
  assert.equal(event.type, 'decision');
  assert.equal(event.message, 'Use permanent JSONL');
  assert.deepEqual(event.meta, {});
});
