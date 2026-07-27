const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawn } = require('child_process');
const { appendEvent, beeLife, claudeData, gitData, syncBeeEvents, syncDefaultBranch } = require('./bee-life');

const PORT = parseInt(process.env.FLEET_PORT || '3847', 10);
const GLOBAL_DIR = process.env.FLEET_GLOBAL_DIR || path.join(require('os').homedir(), '.fleet');
const CONFIG_PATH = path.join(GLOBAL_DIR, 'config.json');
const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');
const jsonlStatsCache = new Map();
const lastDefaultSyncTime = new Map();
const DEFAULT_SYNC_INTERVAL = 120000;

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function globalConfig() {
  return readJSON(CONFIG_PATH) || { accounts: [], hives: [], scan_paths: [], port: PORT };
}

function hiveData(hivePath) {
  const fleet = readJSON(path.join(hivePath, '.fleet', 'fleet.json'));
  if (!fleet) return null;

  const cfg = globalConfig();
  const home = require('os').homedir();
  const liveInstances = liveClaudeInstances();
  const bees = [];
  try {
    const entries = fs.readdirSync(hivePath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('bee')) continue;
      const beePath = path.join(hivePath, e.name);
      const bee = { name: e.name, path: beePath };
      try { syncBeeEvents(hivePath, e.name); } catch {}

      if (fs.existsSync(path.join(beePath, '.git'))) {
        try { bee.branch = execSync('git branch --show-current', { cwd: beePath, encoding: 'utf8' }).trim(); }
        catch { bee.branch = '?'; }
      }

      bee.session = beeSessionInfo(beePath);
      const running = liveInstances.get(path.resolve(beePath)) || [];
      const processRunning = running.length > 0;
      const activeAccounts = [...new Set(running.map(instance => {
        const configDir = typeof instance === 'object' ? instance.configDir : path.join(home, '.claude');
        const account = (cfg.accounts || []).find(item =>
          path.resolve(item.config_dir.replace(/^~/, home)) === path.resolve(configDir)
        );
        return account ? account.name : path.basename(configDir);
      }))];
      bee.activeAccount = activeAccounts[0] || null;
      const currentSession = bee.session && (
        bee.session.find(session => session.account === bee.activeAccount) ||
        bee.session[0]
      );
      bee.current = currentSession ? {
        account: bee.activeAccount || currentSession.account,
        model: currentSession.currentModel || currentSession.models[0] || null,
        speed: currentSession.speed || null,
        cost: currentSession.cost || 0,
        duration: currentSession.duration || 0,
      } : null;

      const activeFile = path.join(hivePath, '.fleet', 'active', `${e.name}.md`);
      let claimText = null;
      if (fs.existsSync(activeFile)) {
        try { claimText = fs.readFileSync(activeFile, 'utf8').split('\n')[0].trim(); }
        catch {}
      }

      if (processRunning) {
        bee.active = true;
        bee.task = claimText || 'idle';
      } else if (claimText) {
        bee.active = false;
        bee.staleClaim = claimText;
        bee.task = 'asleep (stale claim)';
      } else {
        bee.active = false;
        bee.task = 'asleep';
      }
      const inboxFile = path.join(hivePath, '.fleet', 'inbox', `${e.name}.md`);
      if (fs.existsSync(inboxFile)) {
        try { bee.syncNeeded = fs.readFileSync(inboxFile, 'utf8').split('\n')[0].replace(/^#\s*/, '').trim(); }
        catch { bee.syncNeeded = 'Sync needed'; }
      }
      bees.push(bee);
    }
  } catch {}

  bees.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const now = Date.now();
  if (now - (lastDefaultSyncTime.get(hivePath) || 0) >= DEFAULT_SYNC_INTERVAL) {
    lastDefaultSyncTime.set(hivePath, now);
    try { syncDefaultBranch(hivePath); } catch {}
  }

  return { ...fleet, bees, path: hivePath };
}

function lastAssistantMeta(sessionFile) {
  try {
    const buf = Buffer.alloc(32768);
    const fd = fs.openSync(sessionFile, 'r');
    const size = fs.fstatSync(fd).size;
    const readFrom = Math.max(0, size - 32768);
    const bytesRead = fs.readSync(fd, buf, 0, 32768, readFrom);
    fs.closeSync(fd);
    const tail = buf.toString('utf8', 0, bytesRead);
    const lines = tail.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.type === 'assistant' && d.message) {
          const m = d.message.model || '';
          const speed = (d.message.usage && d.message.usage.speed) || '';
          return {
            model: m.replace(/^claude-/, '').replace(/-\d{8}$/, ''),
            speed,
          };
        }
      } catch {}
    }
  } catch {}
  return null;
}

function beeSessionInfo(beePath) {
  const cfg = globalConfig();
  const home = require('os').homedir();
  const results = [];
  for (const acct of (cfg.accounts || [])) {
    const configDir = acct.config_dir.replace(/^~/, home);
    const projDir = path.join(configDir, 'projects', beePath.replace(/\//g, '-'));
    let sessions = 0, lastMod = 0, newestFile = null, isSymlinked = false;
    try {
      const lstat = fs.lstatSync(projDir);
      if (lstat.isSymbolicLink()) isSymlinked = true;
      const real = fs.realpathSync(projDir);
      const files = fs.readdirSync(real).filter(f => f.endsWith('.jsonl'));
      sessions = files.length;
      for (const f of files) {
        const full = path.join(real, f);
        const mt = fs.statSync(full).mtimeMs;
        if (mt > lastMod) { lastMod = mt; newestFile = full; }
      }
    } catch {}
    if (sessions === 0) continue;
    const cjPath = path.resolve(configDir) === path.join(home, '.claude')
      ? path.join(home, '.claude.json')
      : path.join(configDir, '.claude.json');
    const cj = readJSON(cjPath);
    const proj = (cj && cj.projects && cj.projects[beePath]) || {};
    const models = Object.keys(proj.lastModelUsage || {}).map(m =>
      m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
    );
    const live = newestFile ? lastAssistantMeta(newestFile) : null;
    results.push({
      account: acct.name,
      cost: proj.lastCost || 0,
      models,
      currentModel: live ? live.model : null,
      speed: live ? live.speed : null,
      outputTokens: proj.lastTotalOutputTokens || 0,
      inputTokens: proj.lastTotalInputTokens || 0,
      duration: proj.lastDuration || 0,
      sessions,
      lastMod,
      ownSessions: !isSymlinked,
    });
  }
  results.sort((a, b) => b.lastMod - a.lastMod);
  return results.length ? results : null;
}

function jsonlFileStats(file) {
  let stat;
  try { stat = fs.statSync(file); }
  catch { return null; }
  const cached = jsonlStatsCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.data;

  const data = {
    messages: 0,
    firstSession: null,
    daily: {},
    models: {},
  };
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch { return null; }

  for (const line of content.split('\n')) {
    if (!line || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (event.type !== 'user' && event.type !== 'assistant') continue;
    data.messages++;

    const timestamp = event.timestamp || null;
    if (timestamp) {
      if (!data.firstSession || timestamp < data.firstSession) data.firstSession = timestamp;
      const date = timestamp.slice(0, 10);
      if (!data.daily[date]) data.daily[date] = { date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
      data.daily[date].messageCount++;
    }

    if (event.type !== 'assistant' || !event.message) continue;
    const model = event.message.model;
    const usage = event.message.usage || {};
    if (model) {
      if (!data.models[model]) {
        data.models[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      }
      data.models[model].input += usage.input_tokens || 0;
      data.models[model].output += usage.output_tokens || 0;
      data.models[model].cacheRead += usage.cache_read_input_tokens || 0;
      data.models[model].cacheWrite += usage.cache_creation_input_tokens || 0;
    }
    if (timestamp && Array.isArray(event.message.content)) {
      data.daily[timestamp.slice(0, 10)].toolCallCount +=
        event.message.content.filter(item => item && item.type === 'tool_use').length;
    }
  }

  jsonlStatsCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, data });
  return data;
}

function accountStats(configDir) {
  const expanded = configDir.replace(/^~/, require('os').homedir());
  const statsPath = path.join(expanded, 'stats-cache.json');
  const stats = readJSON(statsPath);

  if (!stats) {
    let sessionCount = 0, totalMessages = 0, firstSession = null, newestMtime = 0;
    const daily = {};
    const modelUsage = {};
    try {
      const projDir = path.join(expanded, 'projects');
      for (const dir of fs.readdirSync(projDir)) {
        const full = path.join(projDir, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        const pending = [full];
        while (pending.length) {
          const current = pending.pop();
          for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const item = path.join(current, entry.name);
            if (entry.isDirectory()) { pending.push(item); continue; }
            if (!entry.name.endsWith('.jsonl')) continue;
            if (current === full) sessionCount++;
            const fileStats = jsonlFileStats(item);
            if (!fileStats) continue;
            newestMtime = Math.max(newestMtime, fs.statSync(item).mtimeMs);
            totalMessages += fileStats.messages;
            if (fileStats.firstSession && (!firstSession || fileStats.firstSession < firstSession)) {
              firstSession = fileStats.firstSession;
            }
            for (const [date, activity] of Object.entries(fileStats.daily)) {
              if (!daily[date]) daily[date] = { date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
              daily[date].messageCount += activity.messageCount;
              daily[date].toolCallCount += activity.toolCallCount;
            }
            for (const [model, usage] of Object.entries(fileStats.models)) {
              const short = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
              if (!modelUsage[short]) modelUsage[short] = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
              for (const key of ['output', 'input', 'cacheRead', 'cacheWrite']) {
                modelUsage[short][key] += usage[key];
              }
            }
          }
        }
      }
    } catch {}
    if (sessionCount === 0) return null;
    const historyPath = path.join(expanded, 'history.jsonl');
    try {
      let firstHistory = null;
      for (const line of fs.readFileSync(historyPath, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const timestamp = JSON.parse(line).timestamp;
          if (Number.isFinite(timestamp) && (!firstHistory || timestamp < firstHistory)) firstHistory = timestamp;
        } catch {}
      }
      if (firstHistory) firstSession = new Date(firstHistory).toISOString();
    } catch {}
    return {
      totalSessions: sessionCount,
      totalMessages,
      firstSession,
      dailyActivity: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)).slice(-14),
      dailyModelTokens: [],
      modelUsage,
      hourCounts: {},
      source: 'session-files',
      updatedAt: newestMtime ? new Date(newestMtime).toISOString() : null,
    };
  }

  const last14 = (stats.dailyActivity || []).slice(-14);
  const modelUsage = {};
  for (const [model, data] of Object.entries(stats.modelUsage || {})) {
    const short = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    modelUsage[short] = {
      output: data.outputTokens || 0,
      input: data.inputTokens || 0,
      cacheRead: data.cacheReadInputTokens || 0,
      cacheWrite: data.cacheCreationInputTokens || 0,
    };
  }

  return {
    totalSessions: stats.totalSessions || 0,
    totalMessages: stats.totalMessages || 0,
    firstSession: stats.firstSessionDate || null,
    dailyActivity: last14,
    dailyModelTokens: (stats.dailyModelTokens || []).slice(-14),
    modelUsage,
    hourCounts: stats.hourCounts || {},
    source: 'stats-cache',
    updatedAt: fs.statSync(statsPath).mtime.toISOString(),
  };
}

function readBrain(hivePath) {
  try { return fs.readFileSync(path.join(hivePath, 'CLAUDE.md'), 'utf8'); }
  catch { return ''; }
}

function readJournal(hivePath) {
  try { return fs.readFileSync(path.join(hivePath, '.fleet', 'journal.md'), 'utf8'); }
  catch { return ''; }
}

function readProfile(hivePath) {
  try { return fs.readFileSync(path.join(hivePath, '.fleet', 'profile.md'), 'utf8'); }
  catch { return ''; }
}

function searchHive(hivePath, query, requestedSources) {
  const results = [];
  const q = query.toLowerCase();
  const fleet = readJSON(path.join(hivePath, '.fleet', 'fleet.json'));
  if (!fleet) return results;
  const beeNames = Object.keys(fleet.bees || {});

  if (requestedSources.has('brain')) {
    const brain = readBrain(hivePath);
    if (brain) {
      const lines = brain.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          results.push({ source: 'brain', text: lines[i].trim(), context: lines.slice(start, end).join('\n'), line: i + 1 });
        }
      }
    }
  }

  if (requestedSources.has('journal')) {
    const journal = readJournal(hivePath);
    if (journal) {
      for (const block of journal.split(/(?=^## )/gm)) {
        if (!block.toLowerCase().includes(q)) continue;
        const first = block.split('\n')[0];
        const m = first.match(/^## (\d{4}-\d{2}-\d{2})\s+[–-]+\s+(\S+)/);
        results.push({ source: 'journal', bee: m ? m[2] : null, date: m ? m[1] : null, text: first.replace(/^## /, '').trim(), context: block.trim().slice(0, 300) });
      }
    }
  }

  if (requestedSources.has('events')) {
    const beesDir = path.join(hivePath, '.fleet', 'bees');
    try {
      for (const bee of fs.readdirSync(beesDir)) {
        const evFile = path.join(beesDir, bee, 'events.jsonl');
        try {
          for (const line of fs.readFileSync(evFile, 'utf8').split('\n')) {
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
              if ((ev.message || '').toLowerCase().includes(q) || (ev.type || '').toLowerCase().includes(q)) {
                results.push({ source: 'events', bee, type: ev.type, text: ev.message, date: ev.at, id: ev.id });
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  if (requestedSources.has('tasks')) {
    const activeDir = path.join(hivePath, '.fleet', 'active');
    try {
      for (const file of fs.readdirSync(activeDir)) {
        const content = fs.readFileSync(path.join(activeDir, file), 'utf8').trim();
        if (content.toLowerCase().includes(q)) {
          results.push({ source: 'tasks', bee: file.replace('.md', ''), text: content.split('\n')[0], context: content.slice(0, 200) });
        }
      }
    } catch {}
  }

  if (requestedSources.has('commits')) {
    for (const bee of beeNames) {
      const beePath = path.join(hivePath, bee);
      if (!fs.existsSync(path.join(beePath, '.git'))) continue;
      try {
        const log = execFileSync('git', ['log', '--all', '--format=%H%x00%h%x00%ai%x00%an%x00%s', `--grep=${query}`, '-i', '-30'], { cwd: beePath, encoding: 'utf8', timeout: 5000 });
        for (const line of log.trim().split('\n')) {
          if (!line) continue;
          const [hash, short, date, author, subject] = line.split('\0');
          results.push({ source: 'commits', bee, hash, short, date, author, text: subject });
        }
      } catch {}
    }
  }

  if (requestedSources.has('diffs')) {
    for (const bee of beeNames) {
      const beePath = path.join(hivePath, bee);
      if (!fs.existsSync(path.join(beePath, '.git'))) continue;
      try {
        const log = execFileSync('git', ['log', '--all', '-p', '--format=FLEETCOMMIT:%H%x00%h%x00%ai%x00%an%x00%s', `-S${query}`, '-10'], { cwd: beePath, encoding: 'utf8', timeout: 10000 });
        let cur = null;
        const diffLines = [];
        for (const line of log.split('\n')) {
          if (line.startsWith('FLEETCOMMIT:')) {
            if (cur && diffLines.length) results.push({ ...cur, source: 'diffs', context: diffLines.slice(0, 5).join('\n') });
            const [hash, short, date, author, subject] = line.slice(12).split('\0');
            cur = { bee, hash, short, date, author, text: subject };
            diffLines.length = 0;
          } else if (cur && line.toLowerCase().includes(q)) {
            diffLines.push(line.trim());
          }
        }
        if (cur && diffLines.length) results.push({ ...cur, source: 'diffs', context: diffLines.slice(0, 5).join('\n') });
      } catch {}
    }
  }

  if (requestedSources.has('prs')) {
    for (const bee of beeNames) {
      const beePath = path.join(hivePath, bee);
      if (!fs.existsSync(path.join(beePath, '.git'))) continue;
      try {
        const prJson = execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', '50', '--json', 'number,title,state,url,body,createdAt,mergedAt'], { cwd: beePath, encoding: 'utf8', timeout: 10000 });
        for (const pr of JSON.parse(prJson)) {
          if (`${pr.title} ${pr.body || ''}`.toLowerCase().includes(q)) {
            results.push({ source: 'prs', bee, number: pr.number, text: pr.title, context: (pr.body || '').slice(0, 200), state: pr.state, url: pr.url, date: pr.mergedAt || pr.createdAt });
          }
        }
      } catch {}
    }
  }

  if (requestedSources.has('sessions')) {
    const home = require('os').homedir();
    const cfg = globalConfig();
    let ct = 0;
    outer: for (const acct of (cfg.accounts || [])) {
      const configDir = acct.config_dir.replace(/^~/, home);
      for (const bee of beeNames) {
        const projDir = path.join(configDir, 'projects', path.join(hivePath, bee).replace(/\//g, '-'));
        let files;
        try { files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
        for (const file of files) {
          try {
            for (const line of fs.readFileSync(path.join(projDir, file), 'utf8').split('\n')) {
              if (!line.toLowerCase().includes(q)) continue;
              try {
                const ev = JSON.parse(line);
                if (ev.type !== 'user' && ev.type !== 'assistant') continue;
                const msg = typeof ev.message === 'string' ? ev.message :
                  (ev.message && Array.isArray(ev.message.content)) ? ev.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '';
                if (!msg.toLowerCase().includes(q)) continue;
                const idx = msg.toLowerCase().indexOf(q);
                results.push({ source: 'sessions', bee, account: acct.name, role: ev.type, text: msg.slice(Math.max(0, idx - 60), idx + query.length + 60).trim(), date: ev.timestamp || null });
                if (++ct >= 50) break outer;
              } catch {}
            }
          } catch {}
        }
      }
    }
  }

  if (requestedSources.has('files')) {
    for (const bee of beeNames) {
      const beePath = path.join(hivePath, bee);
      if (!fs.existsSync(path.join(beePath, '.git'))) continue;
      try {
        for (const file of execFileSync('git', ['ls-files'], { cwd: beePath, encoding: 'utf8', timeout: 5000 }).trim().split('\n')) {
          if (file.toLowerCase().includes(q)) results.push({ source: 'files', bee, text: file });
        }
      } catch {}
    }
  }

  return results;
}

function runFleet(hivePath, args) {
  const fleetBin = path.join(__dirname, '..', 'bin', 'fleet');
  try {
    return execSync(`cd "${hivePath}" && "${fleetBin}" ${args}`, {
      encoding: 'utf8', timeout: 30000, input: 'y\n',
    });
  } catch (e) {
    return e.stdout || e.message;
  }
}

function detectTerminal() {
  try {
    const ps = execSync('ps -eo comm 2>/dev/null', { encoding: 'utf8' });
    if (ps.includes('ghostty')) return 'ghostty';
    if (ps.includes('iTerm2')) return 'iTerm.app';
    return 'Apple_Terminal';
  } catch { return 'Apple_Terminal'; }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function findHive(name) {
  const cfg = globalConfig();
  const h = cfg.hives.find(h => h.name === name);
  return h ? h.path : null;
}

let liveClaudeCache = { at: 0, data: new Map() };
function liveClaudeInstances() {
  if (Date.now() - liveClaudeCache.at < 2000) return liveClaudeCache.data;
  const live = new Map();
  let processes;
  try { processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }); }
  catch { return live; }

  for (const line of processes.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)(?:\s|$)/);
    if (!match) continue;
    const command = path.basename(match[2]);
    if (!/^claude(?:-[\w-]+)?$/.test(command)) continue;

    try {
      const output = execFileSync('lsof', ['-a', '-p', match[1], '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
        timeout: 2000,
      });
      const cwdLine = output.split('\n').find(item => item.startsWith('n/'));
      if (!cwdLine) continue;
      const cwd = path.resolve(cwdLine.slice(1));
      let configDir = path.join(require('os').homedir(), '.claude');
      try {
        const environment = execFileSync('ps', ['eww', '-p', match[1], '-o', 'command='], {
          encoding: 'utf8',
          timeout: 2000,
        });
        const configMatch = environment.match(/(?:^|\s)CLAUDE_CONFIG_DIR=([^\s]+)/);
        if (configMatch) configDir = path.resolve(configMatch[1].replace(/^~/, require('os').homedir()));
      } catch {}
      if (!live.has(cwd)) live.set(cwd, []);
      live.get(cwd).push({ pid: Number(match[1]), configDir });
    } catch {}
  }
  liveClaudeCache = { at: Date.now(), data: live };
  return live;
}

function strayBees(options = {}) {
  const cfg = options.config || globalConfig();
  const home = options.home || require('os').homedir();
  const hivePaths = (cfg.hives || []).map(h => path.resolve(h.path));
  const candidates = new Map();
  const isInHive = candidate => hivePaths.some(hive =>
    candidate === hive || candidate.startsWith(`${hive}${path.sep}`)
  );
  const addCandidate = (candidate, marker) => {
    candidate = path.resolve(candidate);
    if (isInHive(candidate)) return;
    try { if (!fs.statSync(candidate).isDirectory()) return; }
    catch { return; }
    if (!candidates.has(candidate)) {
      candidates.set(candidate, {
        name: path.basename(candidate),
        path: candidate,
        markers: new Set(),
      });
    }
    candidates.get(candidate).markers.add(marker);
  };

  const configDirs = [
    path.join(home, '.claude'),
    ...(cfg.accounts || []).map(a => a.config_dir.replace(/^~/, home)),
  ];
  const liveInstances = options.liveInstances || liveClaudeInstances();
  const sessionInfo = options.sessionInfo || beeSessionInfo;
  for (const candidate of liveInstances.keys()) addCandidate(candidate, 'active');

  // Read the real cwd recorded by Claude. Project directory names are dash
  // encoded and cannot be reliably converted back into paths.
  for (const configDir of [...new Set(configDirs)]) {
    const projectsDir = path.join(configDir, 'projects');
    let projects;
    try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }); }
    catch { continue; }
    for (const project of projects) {
      if (!project.isDirectory() && !project.isSymbolicLink()) continue;
      let files;
      try {
        files = fs.readdirSync(path.join(projectsDir, project.name))
          .filter(file => file.endsWith('.jsonl'));
      } catch { continue; }
      for (const file of files) {
        try {
          const sessionPath = path.join(projectsDir, project.name, file);
          const fd = fs.openSync(sessionPath, 'r');
          const buf = Buffer.alloc(1024 * 1024);
          const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
            try {
              const event = JSON.parse(line);
              if (event.cwd) { addCandidate(event.cwd, 'sessions'); break; }
            } catch {}
          }
        } catch {}
      }
    }
  }

  for (const configuredPath of (cfg.scan_paths || [])) {
    const scanPath = path.resolve(configuredPath.replace(/^~/, home));
    let entries;
    try { entries = fs.readdirSync(scanPath, { withFileTypes: true }); }
    catch { continue; }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const candidate = path.join(scanPath, entry.name);
      if (fs.existsSync(path.join(candidate, '.fleet', 'fleet.json'))) continue;
      if (fs.existsSync(path.join(candidate, '.git'))) addCandidate(candidate, 'git');
      if (fs.existsSync(path.join(candidate, 'CLAUDE.md'))) addCandidate(candidate, 'CLAUDE.md');
      if (fs.existsSync(path.join(candidate, '.claude'))) addCandidate(candidate, '.claude');
    }
  }

  return [...candidates.values()].map(candidate => ({
    ...(() => {
      const activeInstances = liveInstances.get(candidate.path) || [];
      const activeAccounts = [...new Set(activeInstances.map(instance => {
        const configDir = typeof instance === 'object' ? instance.configDir : path.join(home, '.claude');
        const account = (cfg.accounts || []).find(item =>
          path.resolve(item.config_dir.replace(/^~/, home)) === path.resolve(configDir)
        );
        return account ? account.name : path.basename(configDir);
      }))];
      return {
        activePids: activeInstances.map(instance =>
          typeof instance === 'object' ? instance.pid : instance
        ),
        activeAccounts,
      };
    })(),
    ...candidate,
    markers: [...candidate.markers],
    session: sessionInfo(candidate.path),
    active: liveInstances.has(candidate.path),
  })).sort((a, b) =>
    Number(b.active) - Number(a.active) ||
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Dashboard
  if (p === '/' || p === '/index.html') {
    try {
      const html = fs.readFileSync(DASHBOARD_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500); res.end('Dashboard file not found');
    }
    return;
  }

  // API routes
  if (p === '/api/hives' && method === 'GET') {
    const cfg = globalConfig();
    const hives = cfg.hives.map(h => {
      const data = hiveData(h.path);
      return data ? { ...h, ...data } : { ...h, missing: true };
    }).filter(h => !h.missing);
    return json(res, hives);
  }

  if (p === '/api/accounts' && method === 'GET') {
    const cfg = globalConfig();
    const accounts = cfg.accounts.map(a => ({
      ...a,
      stats: accountStats(a.config_dir),
    }));
    return json(res, accounts);
  }

  if (p === '/api/strays' && method === 'GET') {
    return json(res, strayBees());
  }

  const strayDetailMatch = p.match(/^\/api\/strays\/(.+)$/);
  if (strayDetailMatch && method === 'GET') {
    const strayPath = decodeURIComponent(strayDetailMatch[1]);
    if (!fs.existsSync(strayPath)) return json(res, { error: 'Path not found' }, 404);
    const accounts = globalConfig().accounts || [];
    const home = require('os').homedir();
    const git = gitData(strayPath, { origin: 'init' });
    const claude = claudeData(strayPath, accounts, home);
    const allFiles = new Map(git.files.map(f => [f.file, { ...f, gitTouches: f.touches, claudeTouches: 0 }]));
    for (const f of claude.files) {
      if (!allFiles.has(f.file)) allFiles.set(f.file, { file: f.file, touches: 0, dirty: false, gitTouches: 0, claudeTouches: 0 });
      const c = allFiles.get(f.file);
      c.claudeTouches += f.touches; c.touches += f.touches;
      c.reads = f.reads; c.writes = f.writes; c.tools = f.tools;
    }
    const files = [...allFiles.values()].sort((a, b) => b.touches - a.touches || a.file.localeCompare(b.file));
    return json(res, {
      name: path.basename(strayPath),
      path: strayPath,
      branch: git.branch || '',
      defaultBranch: git.defaultBranch || '',
      divergence: git.divergence || null,
      git,
      files,
      claude,
      sessionMetadata: beeSessionInfo(strayPath),
      summary: {
        commits: git.commits.length,
        prs: git.prs.length,
        files: files.length,
        tools: claude.tools.reduce((s, t) => s + t.count, 0),
        sessions: claude.sessions.length,
        additions: git.stats ? git.stats.totalAdditions : 0,
        deletions: git.stats ? git.stats.totalDeletions : 0,
      },
    });
  }

  const hiveMatch = p.match(/^\/api\/hives\/([^/]+)$/);
  if (hiveMatch && method === 'GET') {
    const hivePath = findHive(decodeURIComponent(hiveMatch[1]));
    if (!hivePath) return json(res, { error: 'Hive not found' }, 404);
    const data = hiveData(hivePath);
    if (!data) return json(res, { error: 'Hive data unreadable' }, 500);
    return json(res, data);
  }

  const beeLifeMatch = p.match(/^\/api\/hives\/([^/]+)\/bees\/([^/]+)$/);
  if (beeLifeMatch && method === 'GET') {
    const hivePath = findHive(decodeURIComponent(beeLifeMatch[1]));
    const bee = decodeURIComponent(beeLifeMatch[2]);
    if (!hivePath || !/^bee\d+$/.test(bee)) return json(res, { error: 'Not found' }, 404);
    const data = beeLife(hivePath, bee, {
      accounts: globalConfig().accounts || [],
      home: require('os').homedir(),
      sessionMetadata: beeSessionInfo(path.join(hivePath, bee)),
    });
    if (!data) return json(res, { error: 'Bee not found' }, 404);
    return json(res, data);
  }

  const beeEventMatch = p.match(/^\/api\/hives\/([^/]+)\/bees\/([^/]+)\/events$/);
  if (beeEventMatch && method === 'POST') {
    const hivePath = findHive(decodeURIComponent(beeEventMatch[1]));
    const bee = decodeURIComponent(beeEventMatch[2]);
    if (!hivePath || !/^bee\d+$/.test(bee) || !fs.existsSync(path.join(hivePath, bee))) {
      return json(res, { error: 'Not found' }, 404);
    }
    const body = await parseBody(req);
    const allowed = ['milestone', 'decision', 'discovery', 'blocker', 'test', 'note', 'task_completed'];
    if (!allowed.includes(body.type) || !String(body.message || '').trim()) {
      return json(res, { error: 'Invalid event' }, 400);
    }
    return json(res, appendEvent(hivePath, bee, body.type, body.message, body.meta || {}), 201);
  }

  const artifactListMatch = p.match(/^\/api\/hives\/([^/]+)\/artifacts$/);
  if (artifactListMatch && method === 'GET') {
    const hivePath = findHive(decodeURIComponent(artifactListMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const artDir = path.join(hivePath, 'artifacts');
    if (!fs.existsSync(artDir)) return json(res, []);
    const items = [];
    for (const name of fs.readdirSync(artDir)) {
      const full = path.join(artDir, name);
      try {
        const st = fs.statSync(full);
        items.push({ name, isDir: st.isDirectory(), size: st.size, modified: st.mtime.toISOString() });
      } catch {}
    }
    return json(res, items);
  }
  if (artifactListMatch && method === 'POST') {
    const hivePath = findHive(decodeURIComponent(artifactListMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const body = await parseBody(req);
    const bee = body.bee, filePath = body.path;
    if (!bee || !filePath) return json(res, { error: 'bee and path required' }, 400);
    const beePath = path.join(hivePath, bee);
    const src = path.isAbsolute(filePath) ? filePath : path.join(beePath, filePath);
    if (!fs.existsSync(src)) return json(res, { error: 'Source not found' }, 404);
    if (!src.startsWith(hivePath)) return json(res, { error: 'Path must be within hive' }, 403);
    const artDir = path.join(hivePath, 'artifacts');
    fs.mkdirSync(artDir, { recursive: true });
    const name = path.basename(src);
    const dest = path.join(artDir, name);
    if (fs.existsSync(dest)) return json(res, { error: 'Already exists in artifacts/' }, 409);
    fs.cpSync(src, dest, { recursive: true });
    return json(res, { shared: name }, 201);
  }

  const brainMatch = p.match(/^\/api\/hives\/([^/]+)\/brain$/);
  if (brainMatch && method === 'GET') {
    const hivePath = findHive(decodeURIComponent(brainMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    return json(res, { content: readBrain(hivePath) });
  }
  if (brainMatch && method === 'PUT') {
    const hivePath = findHive(decodeURIComponent(brainMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const body = await parseBody(req);
    if (body.content != null) {
      fs.writeFileSync(path.join(hivePath, 'CLAUDE.md'), body.content);
      return json(res, { ok: true });
    }
    return json(res, { error: 'Missing content' }, 400);
  }

  const journalMatch = p.match(/^\/api\/hives\/([^/]+)\/journal$/);
  if (journalMatch && method === 'GET') {
    const hivePath = findHive(decodeURIComponent(journalMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    return json(res, { content: readJournal(hivePath) });
  }

  const profileMatch = p.match(/^\/api\/hives\/([^/]+)\/profile$/);
  if (profileMatch && method === 'GET') {
    const hivePath = findHive(decodeURIComponent(profileMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    return json(res, { content: readProfile(hivePath) });
  }

  const spawnMatch = p.match(/^\/api\/hives\/([^/]+)\/spawn$/);
  if (spawnMatch && method === 'POST') {
    const hivePath = findHive(decodeURIComponent(spawnMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const body = await parseBody(req);
    const args = body.branch ? `spawn --branch "${body.branch}"` : 'spawn';
    const out = runFleet(hivePath, args);
    return json(res, { output: out });
  }

  const destroyMatch = p.match(/^\/api\/hives\/([^/]+)\/destroy\/([^/]+)$/);
  if (destroyMatch && method === 'POST') {
    const hivePath = findHive(decodeURIComponent(destroyMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const bee = decodeURIComponent(destroyMatch[2]);
    const out = runFleet(hivePath, `destroy ${bee}`);
    return json(res, { output: out });
  }

  const doctorMatch = p.match(/^\/api\/hives\/([^/]+)\/doctor$/);
  if (doctorMatch && method === 'GET') {
    const hivePath = findHive(decodeURIComponent(doctorMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const out = runFleet(hivePath, 'doctor');
    return json(res, { output: out });
  }

  const cleanMatch = p.match(/^\/api\/hives\/([^/]+)\/clean$/);
  if (cleanMatch && method === 'POST') {
    const hivePath = findHive(decodeURIComponent(cleanMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const out = runFleet(hivePath, 'clean');
    return json(res, { output: out });
  }

  if (p === '/api/hives' && method === 'POST') {
    const body = await parseBody(req);
    if (!body.path) return json(res, { error: 'Missing path' }, 400);
    const absPath = body.path.replace(/^~/, require('os').homedir());
    if (!fs.existsSync(absPath)) return json(res, { error: 'Path not found' }, 400);
    const fleetBin = path.join(__dirname, '..', 'bin', 'fleet');
    const nameFlag = body.name ? ` --name "${body.name}"` : '';
    try {
      const out = execSync(`cd "${absPath}" && "${fleetBin}" init${nameFlag}`, {
        encoding: 'utf8', timeout: 30000, input: 'y\n',
      });
      return json(res, { output: out });
    } catch (e) {
      return json(res, { output: e.stdout || e.message }, 500);
    }
  }

  const adoptMatch = p.match(/^\/api\/hives\/([^/]+)\/adopt$/);
  if (adoptMatch && method === 'POST') {
    const hivePath = findHive(decodeURIComponent(adoptMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const body = await parseBody(req);
    if (!body.path) return json(res, { error: 'Missing path' }, 400);
    const absPath = body.path.replace(/^~/, require('os').homedir());
    const out = runFleet(hivePath, `adopt "${absPath}"`);
    return json(res, { output: out });
  }

  if (p === '/api/browse' && method === 'GET') {
    let browsePath = url.searchParams.get('path') || require('os').homedir();
    browsePath = browsePath.replace(/^~/, require('os').homedir());
    try {
      const stat = fs.statSync(browsePath);
      if (!stat.isDirectory()) return json(res, { error: 'Not a directory' }, 400);
      const entries = fs.readdirSync(browsePath, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      return json(res, { path: browsePath, parent: path.dirname(browsePath), dirs: dirs.slice(0, 200) });
    } catch (e) {
      return json(res, { error: 'Cannot read directory' }, 400);
    }
  }

  if (p === '/api/scan' && method === 'POST') {
    const fleetBin = path.join(__dirname, '..', 'bin', 'fleet');
    try {
      const out = execSync(`"${fleetBin}" scan`, { encoding: 'utf8', timeout: 15000 });
      return json(res, { output: out });
    } catch (e) {
      return json(res, { output: e.stdout || e.message });
    }
  }

  if (p === '/api/config' && method === 'GET') {
    return json(res, globalConfig());
  }

  const launchMatch = p.match(/^\/api\/hives\/([^/]+)\/launch(?:\/([^/]+))?$/);
  if (launchMatch && method === 'POST') {
    const hivePath = findHive(decodeURIComponent(launchMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const body = await parseBody(req);
    const bee = launchMatch[2] ? decodeURIComponent(launchMatch[2]) : (body.bee || 'bee1');
    const all = body.all === true;
    const term = detectTerminal();
    const fleetBin = path.join(__dirname, '..', 'bin', 'fleet');
    const args = all ? 'launch --all' : `launch ${bee}`;
    try {
      const out = execSync(`cd "${hivePath}" && "${fleetBin}" ${args}`, {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, TERM_PROGRAM: term },
      });
      return json(res, { output: out });
    } catch (e) {
      return json(res, { output: e.stdout || e.message }, 500);
    }
  }

  const searchMatch = p.match(/^\/api\/hives\/([^/]+)\/search$/);
  if (searchMatch && method === 'GET') {
    const hivePath = findHive(decodeURIComponent(searchMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const q = url.searchParams.get('q');
    if (!q) return json(res, { error: 'Missing q param' }, 400);
    const sources = new Set((url.searchParams.get('sources') || 'events,journal,brain,commits,tasks').split(',').filter(Boolean));
    return json(res, { results: searchHive(hivePath, q, sources), query: q, sources: [...sources] });
  }

  const askMatch = p.match(/^\/api\/hives\/([^/]+)\/ask$/);
  if (askMatch && method === 'POST') {
    const hivePath = findHive(decodeURIComponent(askMatch[1]));
    if (!hivePath) return json(res, { error: 'Not found' }, 404);
    const body = await parseBody(req);
    if (!body.query) return json(res, { error: 'Missing query' }, 400);

    const fleet = readJSON(path.join(hivePath, '.fleet', 'fleet.json')) || {};
    const beeNames = Object.keys(fleet.bees || {}).join(', ');
    const journal = readJournal(hivePath).slice(0, 3000);
    const brain = readBrain(hivePath).slice(0, 2000);
    let eventCtx = '';
    try {
      const bd = path.join(hivePath, '.fleet', 'bees');
      for (const bee of fs.readdirSync(bd)) {
        try {
          const lines = fs.readFileSync(path.join(bd, bee, 'events.jsonl'), 'utf8').trim().split('\n').slice(-10);
          for (const l of lines) { try { const ev = JSON.parse(l); eventCtx += `[${bee}] ${ev.type}: ${ev.message}\n`; } catch {} }
        } catch {}
      }
    } catch {}

    const prompt = `You are a search assistant for a Fleet hive called "${fleet.name || 'unknown'}" (${fleet.type || 'unknown'} hive) with bees: ${beeNames || 'none'}.\n\nShared brain (CLAUDE.md):\n${brain || '(empty)'}\n\nRecent journal:\n${journal || '(empty)'}\n\nRecent bee events:\n${eventCtx || '(none)'}\n\nQuestion: ${body.query}\n\nAnswer concisely based on the hive context above. If you can't find the answer, say so.`;

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache' });
    const child = spawn('claude', ['-p', prompt], { cwd: hivePath, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => res.write(chunk));
    child.stderr.on('data', () => {});
    child.on('close', () => res.end());
    child.on('error', () => { res.write('Error: Could not run Claude CLI. Ensure `claude` is installed.'); res.end(); });
    return;
  }

  json(res, { error: 'Not found' }, 404);
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\x1b[32mFleet dashboard running at http://localhost:${PORT}\x1b[0m`);
  });
}

module.exports = {
  accountStats,
  hiveData,
  lastAssistantMeta,
  jsonlFileStats,
  liveClaudeInstances,
  readJSON,
  server,
  strayBees,
};
