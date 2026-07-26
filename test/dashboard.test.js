const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const dashboardPath = path.join(__dirname, '..', 'lib', 'dashboard.html');
const dashboard = fs.readFileSync(dashboardPath, 'utf8');

test('dashboard JavaScript parses', () => {
  const script = dashboard.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'dashboard should contain a script');
  assert.doesNotThrow(() => new vm.Script(script[1]));
});

test('stray bees are clickable and use Active/Asleep terminology', () => {
  assert.match(dashboard, /onclick="window\._selStray/);
  assert.match(dashboard, /const status=s\.active\?'Active':'Asleep'/);
  assert.doesNotMatch(dashboard, />live</i);
});

test('stray detail view explains status and exposes quick actions', () => {
  assert.match(dashboard, /Active only means the process is running/);
  assert.match(dashboard, /Copy resume command/);
  assert.match(dashboard, /Copy path/);
  assert.match(dashboard, /Make this a hive/);
  assert.match(dashboard, /Stop the active Claude CLI before restructuring/);
  assert.match(dashboard, /Active account/);
  assert.match(dashboard, /Session accounts/);
});

test('account panel explains its data source and refreshes while open', () => {
  assert.match(dashboard, /live session files/);
  assert.match(dashboard, /Source:/);
  assert.match(dashboard, /setInterval\(refreshAccounts,10000\)/);
});

test('bee cards open a tabbed life page with prioritized enrichment', () => {
  assert.match(dashboard, /window\._openBee/);
  assert.match(dashboard, /\['timeline','Timeline'\]/);
  assert.match(dashboard, /\['git','Git & PRs'\]/);
  assert.match(dashboard, /\['files','Files'\]/);
  assert.match(dashboard, /\['decisions','Decisions'\]/);
  assert.match(dashboard, /\['tools','Tools'\]/);
  assert.match(dashboard, /\['sessions','Sessions'\]/);
  assert.match(dashboard, /beeTab='timeline'/);
});

test('hive bee cards stay concise while Sessions owns complete usage metadata', () => {
  assert.match(dashboard, /title="Current account"/);
  assert.match(dashboard, /title="Current model"/);
  assert.match(dashboard, /title="Current session cost"/);
  assert.match(dashboard, /Usage and cost by account/);
  assert.match(dashboard, /Input tokens/);
  assert.match(dashboard, /Output tokens/);
  assert.match(dashboard, /Duration/);
});

test('bee page and selected tab survive dashboard refresh through the URL hash', () => {
  assert.match(dashboard, /location\.hash=`\$\{encodeURIComponent\(sel\.name\)\}\/\$\{encodeURIComponent\(bee\)\}`/);
  assert.match(dashboard, /location\.hash=`\$\{encodeURIComponent\(sel\.name\)\}\/\$\{encodeURIComponent\(selectedBee\)\}\/\$\{encodeURIComponent\(tab\)\}`/);
  assert.match(dashboard, /if\(hashParts\[1\]\)/);
  assert.match(dashboard, /if\(hashParts\[2\]\)window\._beeTab/);
});

test('bee header summary omits the redundant Sessions tile', () => {
  const statsBlock = dashboard.match(/const stats=\[([\s\S]*?)\];/);
  assert.ok(statsBlock);
  assert.doesNotMatch(statsBlock[1], /\['Sessions'/);
});

test('file activity uses readable relative paths with visible breakdowns', () => {
  assert.match(dashboard, /function relativeFilePath\(target,base\)/);
  assert.match(dashboard, /relativeFilePath\(f\.file,b\.path\)/);
  assert.match(dashboard, /class="touch-detail"/);
  assert.match(dashboard, /\$\{f\.reads\} reads/);
  assert.match(dashboard, /\$\{f\.writes\} writes/);
});
