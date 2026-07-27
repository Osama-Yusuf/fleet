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
      .map((line, idx) => {
        try { const e = JSON.parse(line); e._seq = idx; return e; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)) || b._seq - a._seq);
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
  const entries = journalEntries(path.join(hivePath, '.fleet', 'journal.md'), bee)
    .filter(entry => !known.has(entry.hash));
  const byDate = new Map();
  for (const entry of entries) {
    if (!byDate.has(entry.date)) byDate.set(entry.date, []);
    byDate.get(entry.date).push(entry);
  }
  for (const [date, dayEntries] of byDate) {
    const count = dayEntries.length;
    dayEntries.forEach((entry, i) => {
      const hoursOffset = count > 1 ? 8 + (i / (count - 1)) * 14 : 14;
      const h = Math.floor(hoursOffset);
      const m = Math.floor((hoursOffset - h) * 60);
      const pad = n => String(n).padStart(2, '0');
      const baseTime = `${date}T${pad(h)}:${pad(m)}:00.000Z`;
      appendEvent(hivePath, bee, 'journaled',
        entry.did || entry.body.split('\n')[0] || 'Journal entry',
        { body: entry.body, why: entry.why, verified: entry.verified, next: entry.next },
        baseTime);
      if (entry.why) appendEvent(hivePath, bee, 'decision', entry.why, { source: 'journal' }, `${date}T${pad(h)}:${pad(m)}:01.000Z`);
      if (entry.verified) appendEvent(hivePath, bee, 'discovery', entry.verified, { source: 'journal' }, `${date}T${pad(h)}:${pad(m)}:02.000Z`);
      known.add(entry.hash);
    });
  }
  state.journalHashes = [...known];
  if (JSON.stringify(state) !== stateBefore) writeState(hivePath, bee, state);
  return readEvents(hivePath, bee);
}

function parseCommits(raw) {
  const commits = [];
  const fileCounts = new Map();
  for (const record of raw.split('\x1e')) {
    const lines = record.trim().split('\n').filter(Boolean);
    if (!lines.length) continue;
    const headerIdx = lines.findIndex(l => l.includes('\x1f'));
    if (headerIdx < 0) continue;
    const parts = lines.splice(headerIdx, 1)[0].split('\x1f');
    const [hash, short, at, author, subject] = parts;
    const adds = parseInt(parts[5]) || 0;
    const dels = parseInt(parts[6]) || 0;
    if (!hash || !subject) continue;
    const files = lines.filter(line => !line.includes('\x1f'));
    for (const file of files) fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
    commits.push({ hash, short, at, author, subject, files, additions: adds, deletions: dels });
  }
  return { commits, fileCounts };
}

function detectDefaultBranch(run) {
  const headRef = run(['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (headRef) return headRef.replace('refs/remotes/origin/', '');
  for (const c of ['main', 'master', 'develop']) {
    if (run(['rev-parse', '--verify', `origin/${c}`])) return c;
  }
  return '';
}

function ghPullRequests(beePath, branch, defaultBranch) {
  if (!branch) return [];
  const onDefault = !defaultBranch || branch === defaultBranch;
  try {
    const args = [
      'pr', 'list', '--state', 'all', '--limit', '100',
      '--json', 'number,title,state,url,createdAt,mergedAt,additions,deletions,headRefName,baseRefName',
    ];
    if (onDefault) {
      args.push('--base', branch);
    } else {
      args.push('--head', branch);
    }
    const raw = execFileSync('gh', args, { cwd: beePath, encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function gitData(beePath, opts) {
  if (typeof opts === 'string') opts = { since: opts };
  opts = opts || {};
  const { since, branch, origin } = opts;

  if (!fs.existsSync(path.join(beePath, '.git'))) {
    return { commits: [], prs: [], files: [], dirtyFiles: [], branch: '', defaultBranch: '', divergence: null };
  }
  const run = args => {
    try { return execFileSync('git', args, { cwd: beePath, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
    catch { return ''; }
  };

  const currentBranch = branch || run(['branch', '--show-current']) || '';
  const defaultBranch = detectDefaultBranch(run);
  const onDefault = !defaultBranch || currentBranch === defaultBranch;

  const sinceDate = (origin === 'spawn') ? (since || '1970-01-01') : null;
  const logFmt = '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%x1e';
  const statFmt = '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%x1e';

  let branchCommits = { commits: [], fileCounts: new Map() };
  let defaultCommits = { commits: [], fileCounts: new Map() };

  if (!onDefault && defaultBranch) {
    const branchRaw = run([
      'log', `origin/${defaultBranch}..${currentBranch}`,
      '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%x1e', '--name-only',
    ]);
    branchCommits = parseCommits(branchRaw);
    for (const c of branchCommits.commits) c.scope = 'branch';

    if (sinceDate) {
      const defRaw = run([
        'log', `--since=${sinceDate}`, `origin/${defaultBranch}`,
        '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%x1e', '--name-only',
      ]);
      defaultCommits = parseCommits(defRaw);
      for (const c of defaultCommits.commits) c.scope = 'default';
    }
  } else {
    const args = ['log', '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%x1e', '--name-only'];
    if (sinceDate) args.splice(1, 0, `--since=${sinceDate}`);
    const raw = run(args);
    branchCommits = parseCommits(raw);
    for (const c of branchCommits.commits) c.scope = onDefault ? 'default' : 'branch';
  }

  const seenHashes = new Set();
  const commits = [];
  for (const c of [...branchCommits.commits, ...defaultCommits.commits]) {
    if (!seenHashes.has(c.hash)) { seenHashes.add(c.hash); commits.push(c); }
  }
  commits.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const fileCounts = new Map();
  for (const [k, v] of branchCommits.fileCounts) fileCounts.set(k, (fileCounts.get(k) || 0) + v);
  for (const [k, v] of defaultCommits.fileCounts) fileCounts.set(k, (fileCounts.get(k) || 0) + v);

  const dirtyFiles = run(['status', '--porcelain']).split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim() || '?',
    path: line.slice(3),
  }));
  for (const file of dirtyFiles) fileCounts.set(file.path, (fileCounts.get(file.path) || 0) + 1);
  const files = [...fileCounts.entries()]
    .map(([file, touches]) => ({ file, touches, dirty: dirtyFiles.some(item => item.path === file) }))
    .sort((a, b) => b.touches - a.touches || a.file.localeCompare(b.file));

  const regexPrs = [];
  for (const commit of commits) {
    for (const match of commit.subject.matchAll(/(?:pull\/|#)(\d+)/g)) {
      if (!regexPrs.some(pr => pr.number === Number(match[1]))) {
        regexPrs.push({ number: Number(match[1]), source: commit.short, subject: commit.subject });
      }
    }
  }

  const ghPrs = ghPullRequests(beePath, currentBranch, defaultBranch);
  const prs = ghPrs !== null ? ghPrs.map(pr => ({
    number: pr.number, title: pr.title, state: pr.state,
    url: pr.url, createdAt: pr.createdAt, mergedAt: pr.mergedAt,
    additions: pr.additions, deletions: pr.deletions,
    head: pr.headRefName, base: pr.baseRefName, source: 'github',
  })) : regexPrs;
  if (ghPrs !== null) {
    for (const rp of regexPrs) {
      if (!prs.some(p => p.number === rp.number)) prs.push({ ...rp, source: 'commit' });
    }
  }

  let divergence = null;
  let totalAdditions = 0, totalDeletions = 0;
  if (!onDefault && defaultBranch) {
    const ahead = parseInt(run(['rev-list', '--count', `origin/${defaultBranch}..${currentBranch}`])) || 0;
    const behind = parseInt(run(['rev-list', '--count', `${currentBranch}..origin/${defaultBranch}`])) || 0;
    divergence = { ahead, behind, defaultBranch };
    const diffStat = run(['diff', '--shortstat', `origin/${defaultBranch}...${currentBranch}`]);
    const addM = diffStat.match(/(\d+) insertion/);
    const delM = diffStat.match(/(\d+) deletion/);
    totalAdditions = addM ? parseInt(addM[1]) : 0;
    totalDeletions = delM ? parseInt(delM[1]) : 0;
  } else {
    const logStat = run(['log', '--format=', '--shortstat', ...(sinceDate ? [`--since=${sinceDate}`] : [])]);
    for (const line of logStat.split('\n')) {
      const addM = line.match(/(\d+) insertion/);
      const delM = line.match(/(\d+) deletion/);
      if (addM) totalAdditions += parseInt(addM[1]);
      if (delM) totalDeletions += parseInt(delM[1]);
    }
  }

  let repoUrl = '';
  const remote = run(['remote', 'get-url', 'origin']);
  if (remote) {
    repoUrl = remote
      .replace(/\.git$/, '')
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
  }

  return {
    commits, prs, files, dirtyFiles,
    branch: currentBranch, defaultBranch,
    divergence, repoUrl,
    stats: { totalAdditions, totalDeletions, commitCount: commits.length, prCount: prs.length },
  };
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
  const git = gitData(beePath, {
    since: registered.created || fleet.created,
    branch: registered.branch || '',
    origin: registered.origin || 'init',
  });
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
    branch: git.branch || registered.branch || '',
    defaultBranch: git.defaultBranch || '',
    divergence: git.divergence || null,
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
      prs: git.prs.length,
      files: files.length,
      decisions: events.filter(event => event.type === 'decision' || event.type === 'discovery').length,
      tools: claude.tools.reduce((sum, tool) => sum + tool.count, 0),
      sessions: claude.sessions.length,
      additions: git.stats ? git.stats.totalAdditions : 0,
      deletions: git.stats ? git.stats.totalDeletions : 0,
    },
  };
}

function syncDefaultBranch(hivePath) {
  const fleet = JSON.parse(fs.readFileSync(path.join(hivePath, '.fleet', 'fleet.json'), 'utf8'));
  if (fleet.type !== 'repo') return;
  const beeNames = Object.keys(fleet.bees || {});
  if (!beeNames.length) return;

  const run = (args, cwd) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
    catch { return ''; }
  };

  const repoBees = beeNames.filter(name =>
    fs.existsSync(path.join(hivePath, name, '.git'))
  );
  if (!repoBees.length) return;

  const refPath = path.join(hivePath, repoBees[0]);

  let defaultBranch = '';
  const headRef = run(['symbolic-ref', 'refs/remotes/origin/HEAD'], refPath);
  if (headRef) {
    defaultBranch = headRef.replace('refs/remotes/origin/', '');
  } else {
    for (const c of ['main', 'master', 'develop']) {
      if (run(['rev-parse', '--verify', `origin/${c}`], refPath)) { defaultBranch = c; break; }
    }
  }
  if (!defaultBranch) return;

  const remoteHead = run(['ls-remote', 'origin', `refs/heads/${defaultBranch}`], refPath).split(/\s/)[0];
  if (!remoteHead) return;

  const syncPath = path.join(hivePath, '.fleet', 'default-branch-sync.json');
  let sync;
  try { sync = JSON.parse(fs.readFileSync(syncPath, 'utf8')); }
  catch { sync = { lastRemoteHead: '', bees: {} }; }

  const headChanged = sync.lastRemoteHead !== remoteHead;

  if (headChanged && sync.lastRemoteHead) {
    try { execFileSync('git', ['fetch', 'origin', defaultBranch, '--quiet'], { cwd: refPath, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return; }
  }

  let newCommits = [];
  if (headChanged && sync.lastRemoteHead) {
    const log = run(['log', `${sync.lastRemoteHead}..origin/${defaultBranch}`, '--format=%H%x1f%h%x1f%an%x1f%s'], refPath);
    if (log) {
      newCommits = log.split('\n').filter(Boolean).map(line => {
        const [hash, short, author, subject] = line.split('\x1f');
        return { hash, short, author, subject };
      });
    }
  }

  for (const name of repoBees) {
    const beePath = path.join(hivePath, name);
    const localHead = run(['rev-parse', 'HEAD'], beePath);
    const beeSync = sync.bees[name] || { notifiedHead: '', lastLocalHead: '' };

    if (beeSync.lastLocalHead && beeSync.lastLocalHead !== localHead && beeSync.notifiedHead) {
      const wasBehind = run(['rev-list', '--count', `${beeSync.lastLocalHead}..${beeSync.notifiedHead}`], refPath);
      const nowBehind = run(['rev-list', '--count', `${localHead}..${beeSync.notifiedHead}`], refPath);
      if (parseInt(wasBehind) > 0 && parseInt(nowBehind) === 0) {
        const pulled = run(['log', `${beeSync.lastLocalHead}..${localHead}`, '--format=%h %s'], beePath);
        const subjects = pulled ? pulled.split('\n').filter(Boolean) : [];
        appendEvent(hivePath, name, 'peer_update',
          `Pulled ${subjects.length} commit${subjects.length !== 1 ? 's' : ''} from ${defaultBranch}`,
          { defaultBranch, commits: subjects.slice(0, 20) });
        beeSync.notifiedHead = '';
        const inboxFile = path.join(hivePath, '.fleet', 'inbox', `${name}.md`);
        try { fs.unlinkSync(inboxFile); } catch {}
      }
    }

    if (headChanged && newCommits.length) {
      const behind = run(['merge-base', '--is-ancestor', remoteHead, localHead], beePath);
      const isAncestor = behind !== '';
      let behindCount = 0;
      if (!isAncestor) {
        const countStr = run(['rev-list', '--count', `${localHead}..${remoteHead}`], refPath);
        behindCount = parseInt(countStr) || 0;
      }

      if (behindCount > 0 && beeSync.notifiedHead !== remoteHead) {
        appendEvent(hivePath, name, 'sync_needed',
          `${behindCount} new commit${behindCount !== 1 ? 's' : ''} on ${defaultBranch}`,
          { defaultBranch, behindCount, commits: newCommits.slice(0, 10), remoteHead });

        const inboxDir = path.join(hivePath, '.fleet', 'inbox');
        fs.mkdirSync(inboxDir, { recursive: true });
        fs.writeFileSync(path.join(inboxDir, `${name}.md`),
          `# Sync needed - ${defaultBranch} updated\n\n` +
          `**${behindCount}** new commit${behindCount !== 1 ? 's' : ''} on \`${defaultBranch}\`.\n\n` +
          `## Recent commits\n` +
          newCommits.slice(0, 10).map(c => `- \`${c.short}\` ${c.subject} (${c.author})`).join('\n') + '\n\n' +
          `Run \`git pull origin ${defaultBranch}\` when ready.\n`);
        beeSync.notifiedHead = remoteHead;
      }
    }

    beeSync.lastLocalHead = localHead;
    sync.bees[name] = beeSync;
  }

  sync.lastRemoteHead = remoteHead;
  fs.writeFileSync(syncPath, JSON.stringify(sync, null, 2) + '\n');
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
  syncDefaultBranch,
};
