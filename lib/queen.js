const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const DEFAULT_CONFIG = {
  enabled: true,
  audit_interval_s: 15,
  heartbeat_stale_s: 300,
  escalation: { notice_s: 0, warning_s: 300, directive_s: 600, override_s: 1200 },
  brain: { section_max_lines: 50, total_max_lines: 300, audit_interval_s: 3600 }
};

function bk(hivePath, beeId) { return `${hivePath}::${beeId}`; }

class Queen {
  constructor(getGlobalConfig, getLiveInstances) {
    this.getGlobalConfig = getGlobalConfig;
    this.getLiveInstances = getLiveInstances || (() => new Map());
    this.heartbeats = new Map();
    this.escalations = new Map();
    this.drones = new Map();
    this.tmuxPanes = [];
    this.notifications = new Map();
    this._notifSeq = 0;
    this._timer = null;
    this._brainTimer = null;
    this._paneTimer = null;
    this.startedAt = null;
    this.auditCount = 0;
    this._droneSeq = 0;
    this._disconnectGrace = new Map();
  }

  hiveConfig(hivePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(hivePath, '.fleet', 'queen', 'config.json'), 'utf8'));
      return {
        ...DEFAULT_CONFIG, ...raw,
        escalation: { ...DEFAULT_CONFIG.escalation, ...(raw.escalation || {}) },
        brain: { ...DEFAULT_CONFIG.brain, ...(raw.brain || {}) }
      };
    } catch { return { ...DEFAULT_CONFIG }; }
  }

  start() {
    this.startedAt = Date.now();
    this._timer = setInterval(() => this.auditAll(), 15000);
    this._paneTimer = setInterval(() => this.refreshPanes(), 30000);
    this._brainTimer = setInterval(() => this.brainAuditAll(), 3600000);
    this._gitTimer = setInterval(() => this.gitSyncAll(), 300000);
    this.refreshPanes();
    this.brainSyncAll();
    setTimeout(() => this.auditAll(), 2000);
  }

  stop() {
    [this._timer, this._brainTimer, this._paneTimer, this._gitTimer].forEach(t => { if (t) clearInterval(t); });
    this._timer = this._brainTimer = this._paneTimer = this._gitTimer = null;
  }

  // ── Heartbeat tracking (called from MCP handlers) ──

  recordHeartbeat(beeId, hivePath) {
    const k = bk(hivePath, beeId);
    const prev = this.heartbeats.get(k) || {};
    const isFirstPing = !prev.lastPing;
    const wasDisconnected = prev.disconnected;
    this.heartbeats.set(k, { ...prev, lastPing: Date.now(), bee: beeId, hive: hivePath, disconnected: false });
    if (wasDisconnected) this.logEvent(hivePath, { type: 'bee_reconnect', bee: beeId });
    // Auto-deescalate if bee is pinging but has no claim (problem resolved externally)
    if (this.escalations.has(k)) {
      const claimFile = path.join(hivePath, '.fleet', 'active', `${beeId}.md`);
      if (!fs.existsSync(claimFile)) {
        this.escalations.delete(k);
        this.logEvent(hivePath, { type: 'deescalation', bee: beeId, reason: 'Bee pinged with no claim — resolved' });
      }
    }
    if (isFirstPing) return this.onboardBee(beeId, hivePath);
    return null;
  }

  // ── Bee birth protocol ──

  onboardBee(beeId, hivePath) {
    this.logEvent(hivePath, { type: 'bee_connect', bee: beeId });
    const issues = [];

    // Check for stale claim from a previous session
    const claimFile = path.join(hivePath, '.fleet', 'active', `${beeId}.md`);
    try {
      const content = fs.readFileSync(claimFile, 'utf8').trim();
      issues.push(`You have a stale claim from a previous session: "${content.substring(0, 60)}". Call fleet_release() if done, or fleet_claim() to update.`);
    } catch {}

    // Check pending inbox
    const inbox = this.readInbox(beeId, hivePath);
    if (inbox.length) issues.push(`You have ${inbox.length} unread inbox message(s). Call fleet_check_inbox() to read them.`);

    // Check git branch freshness
    const beeDir = path.join(hivePath, beeId);
    try {
      const behind = execSync('git rev-list --count HEAD..@{upstream} 2>/dev/null', { cwd: beeDir, encoding: 'utf8', timeout: 5000 }).trim();
      if (behind && parseInt(behind) > 0) issues.push(`Your branch is ${behind} commit(s) behind upstream. Consider pulling before starting work.`);
    } catch {}

    return issues.length ? issues : null;
  }

  recordClaim(beeId, hivePath, task) {
    const k = bk(hivePath, beeId);
    this.heartbeats.set(k, { lastPing: Date.now(), bee: beeId, hive: hivePath, task });
    this.escalations.delete(k);
  }

  recordRelease(beeId, hivePath) {
    const k = bk(hivePath, beeId);
    const prev = this.heartbeats.get(k) || {};
    this.heartbeats.set(k, { ...prev, lastPing: Date.now(), task: null });
    this.escalations.delete(k);
  }

  // ── Pending messages for a bee (returned in fleet_ping) ──

  pendingForBee(beeId, hivePath) {
    const k = bk(hivePath, beeId);
    const esc = this.escalations.get(k);
    const inbox = this.readInbox(beeId, hivePath);
    const items = [];
    if (esc) items.push({ type: 'escalation', level: esc.level, reason: esc.reason });
    items.push(...inbox);
    return items;
  }

  // ── Claim validation ──

  validateClaim(beeId, hivePath, task) {
    const activeDir = path.join(hivePath, '.fleet', 'active');
    const activeBees = [];
    try {
      for (const f of fs.readdirSync(activeDir)) {
        if (!f.endsWith('.md') || f === `${beeId}.md`) continue;
        const content = fs.readFileSync(path.join(activeDir, f), 'utf8').trim();
        const entry = { bee: f.replace('.md', ''), task: content };
        const beeDir = path.join(hivePath, entry.bee);
        try {
          const files = execSync('git diff --name-only HEAD 2>/dev/null', { cwd: beeDir, encoding: 'utf8', timeout: 5000 }).trim();
          if (files) entry.touchedFiles = files.split('\n');
        } catch {}
        activeBees.push(entry);
      }
    } catch {}

    // Detect file conflicts: check if the claiming bee touches files another bee is editing
    const conflicts = [];
    const claimingDir = path.join(hivePath, beeId);
    let myFiles = [];
    try {
      const out = execSync('git diff --name-only HEAD 2>/dev/null', { cwd: claimingDir, encoding: 'utf8', timeout: 5000 }).trim();
      if (out) myFiles = out.split('\n');
    } catch {}
    if (myFiles.length) {
      for (const other of activeBees) {
        if (!other.touchedFiles) continue;
        const overlap = myFiles.filter(f => other.touchedFiles.includes(f));
        if (overlap.length) conflicts.push({ bee: other.bee, files: overlap });
      }
    }

    return { approved: true, activeBees, conflicts: conflicts.length ? conflicts : undefined };
  }

  // ── Main audit loop ──

  auditAll() {
    this.auditCount++;
    const cfg = this.getGlobalConfig();
    for (const hive of (cfg.hives || [])) {
      try { this.auditHive(hive.path); } catch {}
    }
    // Prune completed drones older than 1 hour
    const cutoff = Date.now() - 3600000;
    for (const [id, d] of this.drones) {
      if (d.status !== 'running' && d.finishedAt && d.finishedAt < cutoff) this.drones.delete(id);
    }
    // Prune expired leases
    this.pruneExpiredLeases();
    // Process disconnect grace timers
    this.handleDisconnectGrace();
    // Process resolved action notifications
    for (const [, notif] of this.notifications) {
      if (notif.type === 'action' && notif.resolved && !notif._handled) {
        notif._handled = true;
        this.handleNotificationAction(notif);
      }
    }
    // Prune old resolved notifications (older than 24h)
    const notifCutoff = Date.now() - 86400000;
    for (const [id, n] of this.notifications) {
      if (n.resolved && n.timestamp < notifCutoff) this.notifications.delete(id);
    }
  }

  auditHive(hivePath) {
    const cfg = this.hiveConfig(hivePath);
    if (!cfg.enabled) return;
    if (!fs.existsSync(path.join(hivePath, '.fleet', 'fleet.json'))) return;

    const activeDir = path.join(hivePath, '.fleet', 'active');
    const now = Date.now();
    const staleMs = cfg.heartbeat_stale_s * 1000;
    const seenBees = new Set();

    try {
      for (const f of fs.readdirSync(activeDir)) {
        if (!f.endsWith('.md')) continue;
        const beeId = f.replace('.md', '');
        seenBees.add(beeId);
        const content = fs.readFileSync(path.join(activeDir, f), 'utf8').trim();
        const lower = content.toLowerCase();

        if (lower.includes('idle') || lower.includes('done') || lower.includes('complete') || lower.includes('awaiting')) {
          this.escalate(beeId, hivePath, `Claim file says "${content.substring(0, 80)}" — use fleet_release() when done`, cfg);
          continue;
        }

        const k = bk(hivePath, beeId);
        const hb = this.heartbeats.get(k);
        if (hb && (now - hb.lastPing) > staleMs) {
          this.escalate(beeId, hivePath, `No heartbeat for ${Math.round((now - hb.lastPing) / 1000)}s — claim may be stale: "${content.substring(0, 60)}"`, cfg);
        }
      }
    } catch {}

    // De-escalate bees whose claims were resolved
    for (const [k, esc] of this.escalations) {
      if (esc.hive !== hivePath) continue;
      if (!seenBees.has(esc.bee)) {
        this.escalations.delete(k);
        this.logEvent(hivePath, { type: 'deescalation', bee: esc.bee, reason: 'Claim resolved' });
      }
    }

    // Bee death detection: known bees with stale heartbeats and open claims
    for (const [k, hb] of this.heartbeats) {
      if (hb.hive !== hivePath) continue;
      if (hb.disconnected) continue;
      if ((now - hb.lastPing) > staleMs && seenBees.has(hb.bee)) {
        hb.disconnected = true;
        this.logEvent(hivePath, { type: 'bee_disconnect', bee: hb.bee, lastPing: new Date(hb.lastPing).toISOString(), hadClaim: true });
        this.scheduleDisconnectAssessment(hb.bee, hivePath);
      }
    }
  }

  // ── Graduated escalation ──

  escalate(beeId, hivePath, reason, cfg) {
    const k = bk(hivePath, beeId);
    const existing = this.escalations.get(k);
    const now = Date.now();

    if (!existing) {
      this.escalations.set(k, { level: 'notice', since: now, reason, bee: beeId, hive: hivePath });
      this.logEvent(hivePath, { type: 'escalation', level: 'notice', bee: beeId, reason });
      return;
    }

    // Thresholds are time since first detection
    const elapsed = (now - existing.since) / 1000;
    const esc = cfg.escalation;
    let next = existing.level;

    if (existing.level === 'notice' && elapsed >= esc.warning_s) next = 'warning';
    else if (existing.level === 'warning' && elapsed >= esc.directive_s) next = 'directive';
    else if (existing.level === 'directive' && elapsed >= esc.override_s) next = 'override';

    if (next !== existing.level) {
      existing.level = next;
      existing.reason = reason;
      this.logEvent(hivePath, { type: 'escalation', level: next, bee: beeId, reason });

      if (next === 'warning') {
        this.enqueueInbox(beeId, hivePath, { type: 'warning', text: `Queen warning: ${reason}. Resolve or release your claim.` });
        this.notify(`${beeId}: escalation warning`, reason, { type: 'warning', hive: hivePath, bee: beeId });
      } else if (next === 'directive') {
        this.injectViaTmux(beeId, hivePath, `QUEEN DIRECTIVE: ${reason}. Use fleet_release() if done, or fleet_claim() to update your task.`);
      } else if (next === 'override') {
        this.overrideCleanup(beeId, hivePath, reason);
      }
    }
  }

  // ── Override (direct action — Queen acts when drones/tmux can't) ──

  overrideCleanup(beeId, hivePath, reason) {
    const claimFile = path.join(hivePath, '.fleet', 'active', `${beeId}.md`);
    try {
      const content = fs.readFileSync(claimFile, 'utf8').trim();
      fs.unlinkSync(claimFile);
      const date = new Date().toISOString().split('T')[0];
      const journalPath = path.join(hivePath, '.fleet', 'journal.md');
      fs.appendFileSync(journalPath, `\n## ${date} — queen\n- Override: removed stale claim for ${beeId} ("${content.substring(0, 60)}")\n`);
      this.logEvent(hivePath, { type: 'override_cleanup', bee: beeId, action: 'claim_deleted', content: content.substring(0, 100) });
    } catch (e) {
      this.logEvent(hivePath, { type: 'override_failed', bee: beeId, error: e.message });
    }
  }

  // ── tmux ──

  refreshPanes() {
    this.tmuxPanes = [];
    try {
      const out = execSync("tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index} #{pane_pid} #{pane_current_path}'", { encoding: 'utf8', timeout: 5000 });
      const psOut = execSync('ps -eo pid,ppid,comm', { encoding: 'utf8', timeout: 5000 });
      const procs = psOut.trim().split('\n').slice(1).map(l => {
        const p = l.trim().split(/\s+/);
        return { pid: p[0], ppid: p[1], comm: p[2] || '' };
      });
      for (const line of out.trim().split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split(' ');
        if (parts.length < 3) continue;
        const target = parts[0];
        const panePid = parts[1];
        const panePath = path.resolve(parts.slice(2).join(' '));
        const pids = new Set([panePid]);
        let hasClaude = false;
        for (const proc of procs) {
          if (pids.has(proc.ppid)) {
            pids.add(proc.pid);
            if (proc.comm.includes('claude')) hasClaude = true;
          }
        }
        this.tmuxPanes.push({ target, path: panePath, pid: panePid, hasClaude });
      }
    } catch {}
  }

  findPanesForBee(beePath) {
    const resolved = path.resolve(beePath);
    const matches = [];
    for (const pane of this.tmuxPanes) {
      if (!pane.hasClaude) continue;
      if (pane.path === resolved || resolved.startsWith(pane.path + '/') || pane.path.startsWith(resolved + '/')) {
        matches.push(pane.target);
      }
    }
    return matches;
  }

  isBeeAlive(beePath) {
    const resolved = path.resolve(beePath);
    const live = this.getLiveInstances();
    return (live.get(resolved) || []).length > 0;
  }

  injectViaTmux(beeId, hivePath, message) {
    const beePath = path.resolve(path.join(hivePath, beeId));
    if (!this.isBeeAlive(beePath)) {
      this.enqueueInbox(beeId, hivePath, { type: 'directive', text: message });
      return false;
    }
    const targets = this.findPanesForBee(beePath);
    let injected = false;
    for (const target of targets) {
      try {
        const escaped = message.replace(/'/g, "'\\''");
        execSync(`tmux send-keys -t '${target}' -l '${escaped}'`, { timeout: 5000 });
        execSync(`sleep 0.2 && tmux send-keys -t '${target}' Enter`, { timeout: 5000 });
        this.logEvent(hivePath, { type: 'tmux_inject', bee: beeId, target, message: message.substring(0, 100) });
        injected = true;
      } catch {}
    }
    if (!injected) {
      this.enqueueInbox(beeId, hivePath, { type: 'directive', text: message });
    }
    return injected;
  }

  // ── Inbox ──

  enqueueInbox(beeId, hivePath, message) {
    const dir = path.join(hivePath, '.fleet', 'inbox');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const entry = { ...message, from: message.from || 'queen', at: new Date().toISOString() };
    fs.appendFileSync(path.join(dir, `${beeId}.jsonl`), JSON.stringify(entry) + '\n');
  }

  readInbox(beeId, hivePath) {
    try {
      const lines = fs.readFileSync(path.join(hivePath, '.fleet', 'inbox', `${beeId}.jsonl`), 'utf8').trim().split('\n').filter(Boolean);
      return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  clearInbox(beeId, hivePath) {
    try { fs.unlinkSync(path.join(hivePath, '.fleet', 'inbox', `${beeId}.jsonl`)); } catch {}
  }

  // ── Leases ──

  acquireLease(resource, beeId, hivePath, leaseSeconds = 300) {
    const dir = path.join(hivePath, '.fleet', 'leases');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const file = path.join(dir, `${resource}.json`);
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      const expiresAt = new Date(existing.claimedAt).getTime() + existing.leaseSeconds * 1000;
      if (Date.now() < expiresAt && existing.owner !== beeId) {
        return { granted: false, owner: existing.owner, expiresIn: Math.round((expiresAt - Date.now()) / 1000) };
      }
    } catch {}
    const lease = { resource, owner: beeId, claimedAt: new Date().toISOString(), leaseSeconds };
    fs.writeFileSync(file, JSON.stringify(lease));
    this.logEvent(hivePath, { type: 'lease_acquired', resource, bee: beeId, leaseSeconds });
    return { granted: true, lease };
  }

  releaseLease(resource, beeId, hivePath) {
    const file = path.join(hivePath, '.fleet', 'leases', `${resource}.json`);
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing.owner !== beeId) return { released: false, reason: `Owned by ${existing.owner}` };
      fs.unlinkSync(file);
      this.logEvent(hivePath, { type: 'lease_released', resource, bee: beeId });
      return { released: true };
    } catch { return { released: true }; }
  }

  pruneExpiredLeases() {
    const cfg = this.getGlobalConfig();
    const now = Date.now();
    for (const hive of (cfg.hives || [])) {
      const dir = path.join(hive.path, '.fleet', 'leases');
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          const lease = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const expiresAt = new Date(lease.claimedAt).getTime() + lease.leaseSeconds * 1000;
          if (now >= expiresAt) {
            fs.unlinkSync(path.join(dir, f));
            this.logEvent(hive.path, { type: 'lease_expired', resource: lease.resource, bee: lease.owner });
          }
        }
      } catch {}
    }
  }

  activeLeaseCount() {
    const cfg = this.getGlobalConfig();
    let count = 0;
    for (const hive of (cfg.hives || [])) {
      try {
        const files = fs.readdirSync(path.join(hive.path, '.fleet', 'leases')).filter(f => f.endsWith('.json'));
        count += files.length;
      } catch {}
    }
    return count;
  }

  // ── Drones ──

  spawnDrone(hivePath, beeId, task) {
    const id = `drone-${++this._droneSeq}`;
    const cwd = path.join(hivePath, beeId);
    if (!fs.existsSync(cwd)) {
      this.logEvent(hivePath, { type: 'drone_error', drone: id, bee: beeId, error: 'Bee directory not found' });
      return null;
    }

    this.logEvent(hivePath, { type: 'drone_spawn', drone: id, bee: beeId, task: task.substring(0, 200) });
    const proc = spawn('claude', ['--print', task], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', () => {});

    const drone = { id, bee: beeId, hive: hivePath, task, pid: proc.pid, startedAt: Date.now(), status: 'running' };
    this.drones.set(id, drone);

    proc.on('close', code => {
      drone.status = code === 0 ? 'completed' : 'failed';
      drone.finishedAt = Date.now();
      drone.result = stdout.substring(0, 1000);
      this.logEvent(hivePath, { type: 'drone_done', drone: id, bee: beeId, status: drone.status, result: drone.result.substring(0, 200) });
    });

    return id;
  }

  // ── Brain audit ──

  brainAudit(hivePath) {
    try {
      const lines = fs.readFileSync(path.join(hivePath, 'CLAUDE.md'), 'utf8').split('\n');
      const sections = [];
      let cur = null;
      for (let i = 0; i < lines.length; i++) {
        if (/^## /.test(lines[i])) {
          if (cur) cur.end = i;
          cur = { title: lines[i].replace(/^## /, ''), start: i };
          sections.push(cur);
        }
      }
      if (cur) cur.end = lines.length;
      const mapped = sections.map(s => ({ title: s.title, lines: s.end - s.start, start: s.start, end: s.end }));
      return { totalLines: lines.length, sections: mapped, extractCandidates: mapped.filter(s => s.lines > 50) };
    } catch { return null; }
  }

  brainAuditAll() {
    const cfg = this.getGlobalConfig();
    for (const hive of (cfg.hives || [])) {
      const hCfg = this.hiveConfig(hive.path);
      if (!hCfg.enabled) continue;
      const audit = this.brainAudit(hive.path);
      if (!audit) continue;
      if (audit.extractCandidates.length > 0 || audit.totalLines > hCfg.brain.total_max_lines) {
        const dir = path.join(hive.path, '.fleet', 'queen');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        fs.writeFileSync(path.join(dir, 'brain-audit.json'), JSON.stringify(audit, null, 2));
        this.logEvent(hive.path, { type: 'brain_audit', totalLines: audit.totalLines, candidates: audit.extractCandidates.map(c => c.title) });
        this.extractBrainSections(hive.path, audit);
      }
    }
  }

  extractBrainSections(hivePath, audit) {
    if (audit.extractCandidates.length === 0) return;
    const brainPath = path.join(hivePath, 'CLAUDE.md');
    let lines;
    try { lines = fs.readFileSync(brainPath, 'utf8').split('\n'); } catch { return; }

    const docsDir = path.join(hivePath, 'docs');
    try { fs.mkdirSync(docsDir, { recursive: true }); } catch {}

    // Process from bottom up so line offsets don't shift
    const candidates = [...audit.extractCandidates].sort((a, b) => b.start - a.start);
    let extracted = 0;

    for (const section of candidates) {
      const slug = section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const docPath = path.join(docsDir, `${slug}.md`);
      if (fs.existsSync(docPath)) continue;

      const content = lines.slice(section.start, section.end).join('\n');
      fs.writeFileSync(docPath, content + '\n');
      const pointer = [`## ${section.title}`, `See [docs/${slug}.md](docs/${slug}.md) for details.`, ''];
      lines.splice(section.start, section.end - section.start, ...pointer);
      extracted++;
      this.logEvent(hivePath, { type: 'brain_extract', section: section.title, lines: section.lines, target: `docs/${slug}.md` });
    }

    if (extracted > 0) fs.writeFileSync(brainPath, lines.join('\n'));
  }

  // ── Brain versioning ──

  static COORDINATION_TEMPLATE = [
    '## Coordination (Queen-managed)',
    '',
    'This project uses fleet with a Queen supervisor. Multiple Claude Code sessions run in parallel - each in its own `bee*/` directory. The Queen monitors all bees, detects problems, and escalates.',
    '',
    '**All coordination through MCP tools - never touch `.fleet/` files directly.**',
    '',
    '### Lifecycle (MUST follow)',
    '1. `fleet_ping()` - call immediately on session start and every 60s after. Check `activeBees` to understand what others are working on.',
    '2. `fleet_claim(task)` - claim before doing ANY work. Check the response for `conflicts` (files another bee is also editing) and coordinate if found.',
    '3. Before coding, briefly assess: what files will you touch? Do they overlap with other bees\' work? Any risks?',
    '4. Work on your task',
    '5. `fleet_journal(entry)` - log what you accomplished',
    '6. `fleet_release()` - release your claim when done. NEVER write "idle" or "done" to claim files.',
    '7. `fleet_request_review(summary)` - ask Queen to review (optional)',
    '',
    '### Available MCP tools',
    '- `fleet_ping()` - heartbeat (MUST call every 60s), returns Queen status + pending messages + what other bees are doing',
    '- `fleet_claim(task)` - claim a task (Queen validates no conflicts, detects file overlaps)',
    '- `fleet_release()` - release your claim',
    '- `fleet_journal(entry)` - log completed work',
    '- `fleet_check_inbox()` - check for messages from Queen or other bees',
    '- `fleet_lock(resource)` / `fleet_unlock(resource)` - exclusive lease on shared resources (use for CLAUDE.md, shared configs)',
    '- `fleet_announce(message)` - broadcast to all bees in your hive',
    '- `fleet_request_review(summary)` - request Queen review',
    '',
    '### Queen escalation (what happens if you don\'t follow the rules)',
    '- **Notice** (5min no ping) - logged, returned in your next `fleet_ping`',
    '- **Warning** (10min) - message added to your inbox',
    '- **Directive** (15min) - Queen injects instruction via tmux',
    '- **Override** (25min) - Queen DELETES your stale claim file directly and journals it',
    '',
    '### Quick reference',
    '- `CLAUDE.md` - this file, the shared brain',
    '- `.fleet/journal.md` - work history (managed by `fleet_journal`)',
    '- `.fleet/active/` - claims (managed by `fleet_claim` / `fleet_release`)',
    '- `.fleet/queen/event-log.jsonl` - everything Queen did',
    '- `.claude/settings.local.json` - shared permissions',
    '',
    '### If MCP tools are not available',
    'If the fleet MCP tools (fleet_ping, fleet_claim, etc.) are not listed in your available tools, tell the user:',
    '"Fleet MCP tools are not connected. Please run `fleet serve` and restart this session."',
    'Do NOT skip coordination or touch .fleet/ files directly. Wait for the user to fix the connection.',
  ];

  brainCoordinationVersion() {
    return crypto.createHash('sha256').update(Queen.COORDINATION_TEMPLATE.join('\n')).digest('hex').substring(0, 8);
  }

  extractCoordinationSection(content) {
    const coordStart = content.indexOf('## Coordination (Queen-managed)');
    if (coordStart < 0) return null;
    const nextSection = content.indexOf('\n## ', coordStart + 1);
    const raw = nextSection >= 0 ? content.substring(coordStart, nextSection) : content.substring(coordStart);
    return raw.replace(/<!-- fleet-brain .*? -->\n?/, '').trim();
  }

  hiveCoordinationVersion(hivePath) {
    try {
      const content = fs.readFileSync(path.join(hivePath, 'CLAUDE.md'), 'utf8');
      const section = this.extractCoordinationSection(content);
      if (!section) return null;
      return crypto.createHash('sha256').update(section).digest('hex').substring(0, 8);
    } catch { return null; }
  }

  stripLegacyCoordination(content) {
    const marker = '## Session Coordination (fleet-managed)';
    const idx = content.indexOf(marker);
    if (idx < 0) return content;
    const nextSection = content.indexOf('\n## ', idx + 1);
    if (nextSection >= 0) return content.substring(0, idx) + content.substring(nextSection + 1);
    return content.substring(0, idx);
  }

  brainSyncHive(hivePath) {
    const brainPath = path.join(hivePath, 'CLAUDE.md');
    let content;
    try { content = fs.readFileSync(brainPath, 'utf8'); } catch { return { synced: false, reason: 'No CLAUDE.md' }; }

    const hadLegacy = content.includes('## Session Coordination (fleet-managed)');
    if (hadLegacy) {
      content = this.stripLegacyCoordination(content);
      this.logEvent(hivePath, { type: 'brain_legacy_removed', section: 'Session Coordination (fleet-managed)' });
    }

    const templateVersion = this.brainCoordinationVersion();
    const newCoord = Queen.COORDINATION_TEMPLATE.join('\n');
    const stamp = `<!-- fleet-brain build:${templateVersion} synced:${new Date().toISOString().split('T')[0]} -->`;
    const stamped = newCoord.replace('## Coordination (Queen-managed)\n', `## Coordination (Queen-managed)\n${stamp}\n`);

    const coordStart = content.indexOf('## Coordination (Queen-managed)');

    if (coordStart >= 0) {
      const existing = this.extractCoordinationSection(content);
      if (existing === newCoord.trim() && !hadLegacy) return { synced: false, reason: 'Already up to date', version: templateVersion };
      if (existing === newCoord.trim() && hadLegacy) {
        fs.writeFileSync(brainPath, content);
        return { synced: true, version: templateVersion, cleaned: true };
      }
      const nextSection = content.indexOf('\n## ', coordStart + 1);
      const updated = nextSection >= 0
        ? content.substring(0, coordStart) + stamped + '\n\n' + content.substring(nextSection + 1)
        : content.substring(0, coordStart) + stamped + '\n';
      fs.writeFileSync(brainPath, updated);
    } else {
      fs.writeFileSync(brainPath, content.trimEnd() + '\n\n' + stamped + '\n');
    }

    this.logEvent(hivePath, { type: 'brain_sync', version: templateVersion });
    return { synced: true, version: templateVersion };
  }

  brainSyncAll() {
    const cfg = this.getGlobalConfig();
    const results = {};
    for (const hive of (cfg.hives || [])) {
      if (!fs.existsSync(path.join(hive.path, '.fleet', 'fleet.json'))) continue;
      results[hive.name] = this.brainSyncHive(hive.path);
    }
    return results;
  }

  brainStatus() {
    const cfg = this.getGlobalConfig();
    const templateVersion = this.brainCoordinationVersion();
    const hives = [];
    for (const hive of (cfg.hives || [])) {
      if (!fs.existsSync(path.join(hive.path, '.fleet', 'fleet.json'))) continue;
      const version = this.hiveCoordinationVersion(hive.path);
      const synced = version === templateVersion;
      hives.push({ name: hive.name, path: hive.path, version, synced });
    }
    return { templateVersion, hives };
  }

  // ── Git sync ──

  gitSyncAll() {
    const cfg = this.getGlobalConfig();
    for (const hive of (cfg.hives || [])) {
      try { this.gitSyncHive(hive.path); } catch {}
    }
  }

  gitSyncHive(hivePath) {
    // Only repo hives (with .git) need git sync
    if (!fs.existsSync(path.join(hivePath, 'bee1', '.git'))) return;

    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

    // Fetch origin once for the whole hive (from bee1)
    const bee1Dir = path.join(hivePath, 'bee1');
    try { execSync('git fetch origin 2>/dev/null', { cwd: bee1Dir, timeout: 30000, env: gitEnv }); } catch { return; }

    // Check each bee
    try {
      for (const e of fs.readdirSync(hivePath, { withFileTypes: true })) {
        if (!e.isDirectory() || !e.name.startsWith('bee')) continue;
        const beeDir = path.join(hivePath, e.name);
        if (!fs.existsSync(path.join(beeDir, '.git'))) continue;
        this.gitSyncBee(e.name, beeDir, hivePath);
      }
    } catch {}
  }

  gitSyncBee(beeId, beeDir, hivePath) {
    try {
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      execSync('git fetch origin 2>/dev/null', { cwd: beeDir, timeout: 30000, env: gitEnv });

      // Compare against the bee's own branch upstream, not the repo default
      let currentBranch;
      try {
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { cwd: beeDir, encoding: 'utf8', timeout: 5000 }).trim();
      } catch { return; }

      // Check if this branch has a remote tracking ref
      let upstream;
      try {
        upstream = execSync(`git rev-parse --abbrev-ref ${currentBranch}@{upstream} 2>/dev/null`, { cwd: beeDir, encoding: 'utf8', timeout: 5000 }).trim();
      } catch {
        // No upstream set - nothing to sync against
        return;
      }

      const behind = execSync(`git rev-list --count HEAD..${upstream} 2>/dev/null`, { cwd: beeDir, encoding: 'utf8', timeout: 5000 }).trim();
      const behindCount = parseInt(behind) || 0;
      if (behindCount === 0) return;

      const dirty = execSync('git status --porcelain 2>/dev/null', { cwd: beeDir, encoding: 'utf8', timeout: 5000 }).trim();

      if (!dirty) {
        try {
          execSync(`git pull --rebase 2>/dev/null`, { cwd: beeDir, timeout: 30000, env: gitEnv });
          this.logEvent(hivePath, { type: 'git_sync', bee: beeId, branch: currentBranch, action: 'auto_rebase', behind: behindCount });
        } catch {
          this.logEvent(hivePath, { type: 'git_sync', bee: beeId, branch: currentBranch, action: 'rebase_failed', behind: behindCount });
          this.enqueueInbox(beeId, hivePath, { type: 'git_sync', text: `Auto-rebase failed - you are ${behindCount} commits behind ${upstream}. Manual rebase needed.` });
          this.notify(`${beeId}: rebase failed`, `${behindCount} commits behind ${upstream}. Manual rebase needed.`, { type: 'warning', hive: hivePath, bee: beeId });
        }
      } else {
        this.logEvent(hivePath, { type: 'git_sync', bee: beeId, branch: currentBranch, action: 'skipped_dirty', behind: behindCount });
      }
    } catch {}
  }

  // ── Announce ──

  announce(hivePath, message, from = 'queen') {
    const label = from === 'royal_decree' ? 'ROYAL DECREE' : 'ANNOUNCEMENT';
    try {
      for (const e of fs.readdirSync(hivePath, { withFileTypes: true })) {
        if (e.isDirectory() && e.name.startsWith('bee')) {
          this.enqueueInbox(e.name, hivePath, { type: 'announcement', text: message, from });
          const beePath = path.resolve(path.join(hivePath, e.name));
          if (this.isBeeAlive(beePath)) {
            this.injectViaTmux(e.name, hivePath, `${label}: ${message}`);
          }
        }
      }
      this.logEvent(hivePath, { type: 'announce', message: message.substring(0, 200), from });
    } catch {}
  }

  // ── Notifications ──

  notify(title, body, opts = {}) {
    const id = `notif-${++this._notifSeq}`;
    const notif = {
      id, type: opts.type || 'info', title, body,
      hive: opts.hive || null, bee: opts.bee || null,
      timestamp: Date.now(), read: false, resolved: false,
      actions: opts.actions || null, result: null
    };
    this.notifications.set(id, notif);
    if (opts.hive) this.logEvent(opts.hive, { type: 'notification', notifId: id, title });
    this.systemNotify(title, body);
    return id;
  }

  promptUser(title, body, actions, opts = {}) {
    return this.notify(title, body, { ...opts, type: 'action', actions });
  }

  resolveNotification(id, actionId) {
    const notif = this.notifications.get(id);
    if (!notif || notif.resolved) return null;
    notif.resolved = true;
    notif.result = { actionId, timestamp: Date.now() };
    if (notif.hive) this.logEvent(notif.hive, { type: 'notification_resolved', notifId: id, actionId });
    return notif;
  }

  getNotifications(opts = {}) {
    let list = [...this.notifications.values()];
    if (opts.pending) list = list.filter(n => !n.resolved && n.type === 'action');
    if (opts.unread) list = list.filter(n => !n.read);
    return list.sort((a, b) => b.timestamp - a.timestamp);
  }

  markRead(id) {
    const notif = this.notifications.get(id);
    if (notif) notif.read = true;
    return notif;
  }

  systemNotify(title, body) {
    if (process.platform !== 'darwin') return;
    try {
      const t = title.replace(/"/g, '\\"');
      const b = body.replace(/"/g, '\\"').substring(0, 200);
      execSync(`osascript -e 'display notification "${b}" with title "Fleet: ${t}"'`, { timeout: 3000 });
    } catch {}
  }

  // ── Post-disconnect flow ──

  handleDisconnectGrace() {
    const now = Date.now();
    for (const [k, grace] of this._disconnectGrace) {
      if (now < grace.assessAt) continue;

      const hb = this.heartbeats.get(k);
      if (hb && !hb.disconnected) {
        this._disconnectGrace.delete(k);
        continue;
      }

      this._disconnectGrace.delete(k);
      this.assessDisconnectedBee(grace.beeId, grace.hivePath);
    }
  }

  scheduleDisconnectAssessment(beeId, hivePath) {
    const k = bk(hivePath, beeId);
    if (this._disconnectGrace.has(k)) return;
    this._disconnectGrace.set(k, {
      beeId, hivePath,
      assessAt: Date.now() + 60000
    });
  }

  assessDisconnectedBee(beeId, hivePath) {
    const beeDir = path.join(hivePath, beeId);
    const assessment = { bee: beeId, hive: hivePath, uncommitted: [], task: null };

    const claimFile = path.join(hivePath, '.fleet', 'active', `${beeId}.md`);
    try { assessment.task = fs.readFileSync(claimFile, 'utf8').trim(); } catch {}

    if (fs.existsSync(path.join(beeDir, '.git'))) {
      try {
        const status = execSync('git status --porcelain 2>/dev/null', { cwd: beeDir, encoding: 'utf8', timeout: 5000 }).trim();
        if (status) assessment.uncommitted = status.split('\n').map(l => l.trim());
      } catch {}
      try {
        const diff = execSync('git diff --stat HEAD 2>/dev/null', { cwd: beeDir, encoding: 'utf8', timeout: 5000 }).trim();
        if (diff) assessment.diffStat = diff;
      } catch {}
    }

    this.logEvent(hivePath, { type: 'disconnect_assessment', bee: beeId, task: assessment.task, uncommittedFiles: assessment.uncommitted.length });

    const hasWork = assessment.uncommitted.length > 0;
    const taskDesc = assessment.task ? `Task: "${assessment.task.substring(0, 80)}"` : 'No active task';
    const workDesc = hasWork ? `${assessment.uncommitted.length} uncommitted file(s)` : 'No uncommitted changes';
    const body = `${taskDesc}. ${workDesc}.${assessment.diffStat ? '\n' + assessment.diffStat : ''}`;

    this.promptUser(
      `${beeId} disconnected`,
      body,
      [
        { id: 'release_announce', label: 'Release & announce' },
        { id: 'release_only', label: 'Release claim only' },
        { id: 'keep', label: 'Keep claim' }
      ],
      { hive: hivePath, bee: beeId, meta: { assessment } }
    );
  }

  handleNotificationAction(notif) {
    const actionId = notif.result.actionId;
    const hivePath = notif.hive;
    const beeId = notif.bee;
    if (!hivePath || !beeId) return;

    if (actionId === 'release_announce' || actionId === 'release_only') {
      const claimFile = path.join(hivePath, '.fleet', 'active', `${beeId}.md`);
      try {
        const content = fs.readFileSync(claimFile, 'utf8').trim();
        fs.unlinkSync(claimFile);
        const date = new Date().toISOString().split('T')[0];
        fs.appendFileSync(path.join(hivePath, '.fleet', 'journal.md'),
          `\n## ${date} — queen\n- Released disconnected ${beeId}'s claim ("${content.substring(0, 60)}")\n`);
        this.logEvent(hivePath, { type: 'disconnect_release', bee: beeId, action: actionId });
        this.escalations.delete(bk(hivePath, beeId));
      } catch {}
    }

    if (actionId === 'release_announce') {
      const meta = notif.actions ? null : null;
      this.announce(hivePath, `${beeId} disconnected and its task has been released. The work may need to be picked up by another bee.`, 'queen');
    }

    if (actionId === 'keep') {
      this.logEvent(hivePath, { type: 'disconnect_keep', bee: beeId });
    }
  }

  // ── Event log ──

  logEvent(hivePath, event) {
    const dir = path.join(hivePath, '.fleet', 'queen');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    fs.appendFileSync(path.join(dir, 'event-log.jsonl'), JSON.stringify({ ...event, at: new Date().toISOString() }) + '\n');
  }

  recentEvents(hivePath, limit = 50) {
    try {
      const lines = fs.readFileSync(path.join(hivePath, '.fleet', 'queen', 'event-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch { return []; }
  }

  // ── Status ──

  getStatus() {
    const pending = this.getNotifications({ pending: true });
    const unread = this.getNotifications({ unread: true });
    const now = Date.now();
    const escalationDetails = [...this.escalations.values()].map(e => ({
      bee: e.bee, level: e.level, reason: e.reason,
      elapsed: Math.round((now - e.since) / 1000),
    }));
    const beeDetails = [...this.heartbeats.values()].map(hb => ({
      bee: hb.bee, hive: path.basename(hb.hive),
      lastSeen: Math.round((now - hb.lastPing) / 1000),
      task: hb.task || null,
      disconnected: !!hb.disconnected,
    }));
    return {
      alive: !!this._timer,
      startedAt: this.startedAt,
      uptime: this.startedAt ? Math.round((now - this.startedAt) / 1000) : 0,
      auditCount: this.auditCount,
      bees: this.heartbeats.size,
      beeDetails,
      escalations: this.escalations.size,
      escalationDetails,
      drones: this.drones.size,
      leases: this.activeLeaseCount(),
      notifications: { total: this.notifications.size, pending: pending.length, unread: unread.length }
    };
  }

  hiveStatus(hivePath) {
    const bees = {};
    for (const [, v] of this.heartbeats) { if (v.hive === hivePath) bees[v.bee] = v; }
    const esc = {};
    for (const [, v] of this.escalations) { if (v.hive === hivePath) esc[v.bee] = v; }
    const activeDrones = [...this.drones.values()].filter(d => d.hive === hivePath).map(d => ({
      id: d.id, bee: d.bee, task: d.task.substring(0, 100), status: d.status, startedAt: d.startedAt, finishedAt: d.finishedAt
    }));
    const leases = [];
    try {
      const dir = path.join(hivePath, '.fleet', 'leases');
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const lease = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const expiresAt = new Date(lease.claimedAt).getTime() + lease.leaseSeconds * 1000;
        lease.expiresIn = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
        leases.push(lease);
      }
    } catch {}
    return { bees, escalations: esc, drones: activeDrones, leases, brain: this.brainAudit(hivePath), events: this.recentEvents(hivePath, 30) };
  }
}

module.exports = { Queen, DEFAULT_CONFIG };
