const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function beeStore(hivePath, bee) {
  return path.join(hivePath, '.fleet', 'bees', bee);
}

function eventFile(hivePath, bee) {
  return path.join(beeStore(hivePath, bee), 'events.jsonl');
}

function ensureBeeStore(hivePath, bee) {
  const dir = beeStore(hivePath, bee);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendEvent(hivePath, bee, type, message, meta = {}, at = new Date().toISOString()) {
  ensureBeeStore(hivePath, bee);
  const event = {
    id: crypto.randomUUID(),
    at,
    type,
    message: String(message || '').trim(),
    meta,
  };
  fs.appendFileSync(eventFile(hivePath, bee), `${JSON.stringify(event)}\n`);
  return event;
}

function readEvents(hivePath, bee) {
  try {
    return fs.readFileSync(eventFile(hivePath, bee), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  } catch {
    return [];
  }
}

function readState(hivePath, bee) {
  try { return JSON.parse(fs.readFileSync(path.join(beeStore(hivePath, bee), 'state.json'), 'utf8')); }
  catch { return { active: false, task: '', journalHashes: [] }; }
}

function writeState(hivePath, bee, state) {
  ensureBeeStore(hivePath, bee);
  fs.writeFileSync(
    path.join(beeStore(hivePath, bee), 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function taskText(activeFile) {
  try { return fs.readFileSync(activeFile, 'utf8').trim(); }
  catch { return ''; }
}

function ensureEventProtocol(hivePath) {
  const rules = path.join(hivePath, '.fleet', 'RULES.md');
  let content;
  try { content = fs.readFileSync(rules, 'utf8'); }
  catch { return; }
  if (content.includes('## Permanent bee history')) return;
  fs.appendFileSync(rules, `

## Permanent bee history

Keep the bee's durable timeline current in addition to the active claim and shared journal:
- Important progress: \`fleet event milestone "<what changed>"\`
- Decision made: \`fleet event decision "<decision and why>"\`
- Useful discovery: \`fleet event discovery "<what you learned>"\`
- Blocked: \`fleet event blocker "<blocker>"\`
- Tests run: \`fleet event test "<command and outcome>"\`
- Task finished: \`fleet event complete "<result>"\`

Do not log every prompt or file read. Record meaningful changes of state that another person would want in the bee's history.
`);
}

function journalEntries(journal, bee) {
  let content;
  try { content = fs.readFileSync(journal, 'utf8'); }
  catch { return []; }
  const heading = /^##\s+(\d{4}-\d{2}-\d{2})\s+[—-]\s+([^\s]+)\s*$/gm;
  const matches = [...content.matchAll(heading)];
  return matches.filter(match => match[2] === bee).map((match, index) => {
    const next = matches[matches.indexOf(match) + 1];
    const body = content.slice(match.index + match[0].length, next ? next.index : content.length).trim();
    const field = label => {
      const found = body.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*([^\\n]+)`, 'i'));
      return found ? found[1].trim() : '';
    };
    return {
      date: match[1],
      body,
      did: field('Did'),
      why: field('Why'),
      verified: field('Verified'),
      next: field('Next'),
      hash: crypto.createHash('sha1').update(`${match[0]}\n${body}`).digest('hex'),
      order: index,
    };
  });
}

function syncBeeEvents(hivePath, bee) {
  ensureEventProtocol(hivePath);
  const state = readState(hivePath, bee);
  const stateBefore = JSON.stringify(state);
  const activeFile = path.join(hivePath, '.fleet', 'active', `${bee}.md`);
  const task = taskText(activeFile);

  if (task && (!state.active || task !== state.task)) {
    appendEvent(
      hivePath,
      bee,
      state.active ? 'task_changed' : 'task_claimed',
      task,
      state.active ? { previous: state.task } : {},
    );
  } else if (!task && state.active) {
    appendEvent(hivePath, bee, 'task_released', state.task, { previous: state.task });
  }
  state.active = Boolean(task);
  state.task = task;

  const known = new Set(state.journalHashes || []);
  for (const entry of journalEntries(path.join(hivePath, '.fleet', 'journal.md'), bee)) {
    if (known.has(entry.hash)) continue;
    appendEvent(
      hivePath,
      bee,
      'journaled',
      entry.did || entry.body.split('\n')[0] || 'Journal entry',
      {
        body: entry.body,
        why: entry.why,
        verified: entry.verified,
        next: entry.next,
      },
      `${entry.date}T12:00:00.000Z`,
    );
    if (entry.why) appendEvent(hivePath, bee, 'decision', entry.why, { source: 'journal' }, `${entry.date}T12:00:01.000Z`);
    if (entry.verified) appendEvent(hivePath, bee, 'discovery', entry.verified, { source: 'journal' }, `${entry.date}T12:00:02.000Z`);
    known.add(entry.hash);
  }
  state.journalHashes = [...known];
  if (JSON.stringify(state) !== stateBefore) writeState(hivePath, bee, state);
  return readEvents(hivePath, bee);
}

function gitData(beePath, since) {
  if (!fs.existsSync(path.join(beePath, '.git'))) {
    return { commits: [], prs: [], files: [], dirtyFiles: [] };
  }
  const run = args => {
    try { return execFileSync('git', args, { cwd: beePath, encoding: 'utf8', timeout: 5000 }); }
    catch { return ''; }
  };
  const raw = run([
    'log', `--since=${since || '1970-01-01'}`,
    '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1e',
    '--name-only',
  ]);
  const commits = [];
  const fileCounts = new Map();
  for (const record of raw.split('\x1e')) {
    const lines = record.trim().split('\n').filter(Boolean);
    if (!lines.length) continue;
    const [hash, short, at, author, subject] = lines.shift().split('\x1f');
    if (!hash || !subject) continue;
    const files = lines.filter(line => !line.includes('\x1f'));
    for (const file of files) fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
    commits.push({ hash, short, at, author, subject, files });
  }
  const dirtyFiles = run(['status', '--porcelain']).split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim() || '?',
    path: line.slice(3),
  }));
  for (const file of dirtyFiles) fileCounts.set(file.path, (fileCounts.get(file.path) || 0) + 1);
  const files = [...fileCounts.entries()]
    .map(([file, touches]) => ({ file, touches, dirty: dirtyFiles.some(item => item.path === file) }))
    .sort((a, b) => b.touches - a.touches || a.file.localeCompare(b.file));
  const prs = [];
  for (const commit of commits) {
    for (const match of commit.subject.matchAll(/(?:pull\/|#)(\d+)/g)) {
      if (!prs.some(pr => pr.number === Number(match[1]))) {
        prs.push({ number: Number(match[1]), source: commit.short, subject: commit.subject });
      }
    }
  }
  return { commits, prs, files, dirtyFiles };
}

function claudeData(beePath, accounts, home) {
  const tools = new Map();
  const models = new Map();
  const filesTouched = new Map();
  const sessions = [];
  let messages = 0;
  for (const account of accounts || []) {
    const configDir = account.config_dir.replace(/^~/, home);
    const projectDir = path.join(configDir, 'projects', beePath.replace(/\//g, '-'));
    let files;
    try {
      const real = fs.realpathSync(projectDir);
      files = fs.readdirSync(real).filter(file => file.endsWith('.jsonl')).map(file => path.join(real, file));
    } catch { continue; }
    for (const file of files) {
      let content;
      try { content = fs.readFileSync(file, 'utf8'); }
      catch { continue; }
      let belongs = false, startedAt = null, endedAt = null, sessionMessages = 0;
      const sessionTools = new Map();
      for (const line of content.split('\n')) {
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); }
        catch { continue; }
        if (event.cwd && path.resolve(event.cwd) === path.resolve(beePath)) belongs = true;
        if (!belongs && event.cwd) continue;
        if (event.type === 'user' || event.type === 'assistant') {
          messages++; sessionMessages++;
          if (event.timestamp) {
            if (!startedAt || event.timestamp < startedAt) startedAt = event.timestamp;
            if (!endedAt || event.timestamp > endedAt) endedAt = event.timestamp;
          }
        }
        if (event.type === 'assistant' && event.message) {
          if (event.message.model) models.set(event.message.model, (models.get(event.message.model) || 0) + 1);
          for (const item of event.message.content || []) {
            if (item && item.type === 'tool_use' && item.name) {
              tools.set(item.name, (tools.get(item.name) || 0) + 1);
              sessionTools.set(item.name, (sessionTools.get(item.name) || 0) + 1);
              const input = item.input || {};
              const file = input.file_path || input.notebook_path || null;
              if (file) {
                const relative = path.isAbsolute(file) ? path.relative(beePath, file) : file;
                const key = relative.startsWith('..') ? file : relative;
                if (!filesTouched.has(key)) filesTouched.set(key, { file: key, touches: 0, reads: 0, writes: 0, tools: new Set() });
                const record = filesTouched.get(key);
                record.touches++;
                record.tools.add(item.name);
                if (/^(Read|Glob|Grep)$/.test(item.name)) record.reads++;
                if (/^(Write|Edit|NotebookEdit)$/.test(item.name)) record.writes++;
              }
            }
          }
        }
      }
      if (belongs) {
        sessions.push({
          id: path.basename(file, '.jsonl'),
          account: account.name,
          startedAt,
          endedAt,
          messages: sessionMessages,
          tools: [...sessionTools.entries()].map(([name, count]) => ({ name, count })),
        });
      }
    }
  }
  return {
    messages,
    sessions: sessions.sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt))),
    tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    models: [...models.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    files: [...filesTouched.values()].map(file => ({ ...file, tools: [...file.tools] }))
      .sort((a, b) => b.touches - a.touches || a.file.localeCompare(b.file)),
  };
}

function beeLife(hivePath, bee, options = {}) {
  const beePath = path.join(hivePath, bee);
  if (!fs.existsSync(beePath)) return null;
  const fleet = JSON.parse(fs.readFileSync(path.join(hivePath, '.fleet', 'fleet.json'), 'utf8'));
  const registered = fleet.bees && fleet.bees[bee] ? fleet.bees[bee] : {};
  const events = syncBeeEvents(hivePath, bee);
  const git = gitData(beePath, registered.created || fleet.created);
  const claude = claudeData(beePath, options.accounts || [], options.home || require('os').homedir());
  const allFiles = new Map(git.files.map(file => [file.file, { ...file, gitTouches: file.touches, claudeTouches: 0 }]));
  for (const file of claude.files) {
    if (!allFiles.has(file.file)) {
      allFiles.set(file.file, { file: file.file, touches: 0, dirty: false, gitTouches: 0, claudeTouches: 0 });
    }
    const combined = allFiles.get(file.file);
    combined.claudeTouches += file.touches;
    combined.touches += file.touches;
    combined.reads = file.reads;
    combined.writes = file.writes;
    combined.tools = file.tools;
  }
  const files = [...allFiles.values()].sort((a, b) => b.touches - a.touches || a.file.localeCompare(b.file));
  const derivedCommits = git.commits.map(commit => ({
    id: `commit-${commit.hash}`,
    at: commit.at,
    type: 'commit',
    message: commit.subject,
    meta: commit,
    derived: true,
  }));
  const timeline = [...events, ...derivedCommits]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    name: bee,
    path: beePath,
    created: registered.created || null,
    origin: registered.origin || '',
    branch: git.commits.length || fs.existsSync(path.join(beePath, '.git'))
      ? (() => {
        try { return execFileSync('git', ['branch', '--show-current'], { cwd: beePath, encoding: 'utf8' }).trim(); }
        catch { return registered.branch || ''; }
      })()
      : '',
    currentTask: taskText(path.join(hivePath, '.fleet', 'active', `${bee}.md`)),
    timeline,
    git,
    files,
    decisions: events.filter(event => event.type === 'decision' || event.type === 'discovery'),
    claude,
    sessionMetadata: options.sessionMetadata || [],
    summary: {
      events: events.length,
      tasks: events.filter(event => event.type === 'task_claimed' || event.type === 'task_changed').length,
      commits: git.commits.length,
      files: files.length,
      decisions: events.filter(event => event.type === 'decision' || event.type === 'discovery').length,
      tools: claude.tools.reduce((sum, tool) => sum + tool.count, 0),
      sessions: claude.sessions.length,
    },
  };
}

module.exports = {
  appendEvent,
  beeLife,
  claudeData,
  ensureBeeStore,
  ensureEventProtocol,
  gitData,
  journalEntries,
  readEvents,
  syncBeeEvents,
};
