const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { appendEvent, beeLife, syncBeeEvents } = require('./bee-life');

const PORT = parseInt(process.env.FLEET_PORT || '3847', 10);
const GLOBAL_DIR = process.env.FLEET_GLOBAL_DIR || path.join(require('os').homedir(), '.fleet');
const CONFIG_PATH = path.join(GLOBAL_DIR, 'config.json');
const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');
const jsonlStatsCache = new Map();

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

      const activeFile = path.join(hivePath, '.fleet', 'active', `${e.name}.md`);
      if (fs.existsSync(activeFile)) {
        bee.active = true;
        try { bee.task = fs.readFileSync(activeFile, 'utf8').split('\n')[0].trim(); }
        catch { bee.task = 'working'; }
      } else {
        bee.active = false;
        bee.task = 'idle';
      }

      if (fs.existsSync(path.join(beePath, '.git'))) {
        try { bee.branch = execSync('git branch --show-current', { cwd: beePath, encoding: 'utf8' }).trim(); }
        catch { bee.branch = '?'; }
      }

      bee.session = beeSessionInfo(beePath);
      const running = liveInstances.get(path.resolve(beePath)) || [];
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
      if (!bee.active && bee.session) {
        const own = bee.session.find(s => s.ownSessions);
        if (own && own.lastMod && (Date.now() - own.lastMod) < 5 * 60 * 1000) {
          bee.active = true;
          bee.task = 'working (unclaimed)';
        }
      }
      bees.push(bee);
    }
  } catch {}

  bees.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
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
