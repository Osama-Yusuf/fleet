# Fleetode Queen — Research & Validation Log

## Validation 1: Session Injection ✅ PROVEN

**Question:** Can the Queen inject instructions into a running Claude Code session?

**Result:** Yes, via `tmux send-keys`.

**Test conducted (2026-07-27):**

```
tmux new-session -d -s queen-test -n bee-test
tmux send-keys -t queen-test:bee-test "claude --verbose" Enter
# Wait for boot...
tmux send-keys -t queen-test:bee-test "create a file called /tmp/queen-test.txt with the text 'The queen says hello'" Enter
# Claude processes it, asks for tool approval...
tmux send-keys -t queen-test:bee-test Enter  # approve
# File created successfully: "The queen says hello"
```

**What works:**
- `tmux send-keys` injects text as if the user typed it
- Claude Code treats injected text as normal user input
- The Queen can approve tool calls (Enter on the approval prompt)
- Full control loop: instruct → bee processes → Queen approves → work done

**What doesn't work on macOS:**
- `TIOCSTI` (pty keystroke injection) — removed since Ventura for security
- Ghostty AppleScript — read-only (can list tabs/properties, can't write or switch)
- System Events keystrokes — works but steals focus (unusable for background Queen)
- `/dev/ttysXXX` write — display only, not input injection

**Architecture decision:**
```
tmux send-keys   (primary)  → instant push when bee runs in tmux
MCP piggyback    (fallback) → instructions ride along with tool responses
File inbox       (last resort) → bee checks on next turn start
```

**Requirement:** Fleetode works best when Claude Code sessions run in tmux. Not required — MCP fallback covers non-tmux setups.

---

## Validation 2: MCP Server in fleet serve ✅ PROVEN

**Question:** Can `fleet serve` expose MCP tools alongside its existing HTTP API?

**Result:** Yes. Full bee lifecycle works end-to-end via MCP tool calls.

**Research findings (2026-07-27):**

**Transport:** Use `http` (streamable-http), not SSE (deprecated). Claude Code supports:
- `http` — POST-based JSON-RPC 2.0, recommended for local/remote
- `stdio` — subprocess stdin/stdout
- `ws` — WebSocket, bidirectional push
- `sse` — deprecated, use http instead

**Architecture:** Single process, single port. Added `/mcp` route to existing `http.createServer` in `lib/server.js`. No new process needed.

**Bee identity:** Custom header `X-Bee-Id` in each bee's `.mcp.json`:
```json
{
  "mcpServers": {
    "fleetode": {
      "type": "http",
      "url": "http://127.0.0.1:3847/mcp",
      "headers": { "X-Bee-Id": "bee1" }
    }
  }
}
```

**Registration:** `claude mcp add --transport http fleetode http://127.0.0.1:3847/mcp -H "X-Bee-Id: bee1"`

**SDK:** Zero-dep — implemented JSON-RPC 2.0 by hand (fleet is zero-dependency by convention).

**Config location:** `~/.claude.json` (per-user) or `.mcp.json` in project root (per-hive).

**Test conducted (2026-07-27):**

```
# 1. Start fleet serve with MCP endpoint
fleet serve  # port 3847, /mcp route added

# 2. curl tests (all passed)
curl -s -X POST http://127.0.0.1:3847/mcp -H "Content-Type: application/json" \
  -H "X-Bee-Id: bee1" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# → {"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"fleetode","version":"0.1.0"}}

curl -s -X POST http://127.0.0.1:3847/mcp -H "Content-Type: application/json" \
  -H "X-Bee-Id: bee1" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
# → 4 tools: fleet_ping, fleet_claim, fleet_release, fleet_journal

# 3. Real Claude Code session test (in tmux)
tmux new-session -d -s mcp-test -n bee-mcp
tmux send-keys -t mcp-test:bee-mcp "claude --verbose" Enter
# Wait for boot...

# 4. fleet_ping ✅
tmux send-keys -t mcp-test:bee-mcp "use the fleet_ping tool to check if the queen is alive" Enter
# → "The Queen is alive. No pending instructions for bee1."

# 5. fleet_claim ✅
tmux send-keys -t mcp-test:bee-mcp "use fleet_claim to claim the task: Testing MCP queen integration" Enter
# → "Task claimed successfully. bee1 is now working on 'Testing MCP queen integration'."
# Verified: .fleet/active/bee1.md created with claim text

# 6. fleet_journal ✅
tmux send-keys -t mcp-test:bee-mcp "use fleet_journal to log: MCP lifecycle test complete" Enter
# → "Journal entry logged for bee1."
# Verified: journal.md has new entry under ## 2026-07-27 — bee1

# 7. fleet_release ✅
tmux send-keys -t mcp-test:bee-mcp "use fleet_release to release your current claim" Enter
# → "Claim released. bee1 is now free for new tasks."
# Verified: .fleet/active/bee1.md deleted
```

**What works:**
- All 4 MCP tools callable from a real Claude Code session
- Claude Code auto-discovers tools via `tools/list`
- User gets approval prompt for each tool call (security boundary maintained)
- Full lifecycle: ping → claim → journal → release all pass
- tmux injection + MCP combined: Queen can push instructions AND bee responds via MCP tools

**Bug found and fixed:** `mcpToolCall()` originally used `hivePaths[0]` (first hive in config), so tools always wrote to the wrong hive when multiple hives existed. Fix: added `X-Hive-Id` header alongside `X-Bee-Id`, plus `resolveHive(beeId, hiveId)` that matches hive name first, falls back to scanning bee directories. War-tested with 10 edge cases including cross-hive isolation, ambiguous bees, double claims, and non-existent hives.

**Queen instructions in tool responses:** MCP tool results are text content arrays. Instructions can be embedded in the response text of any tool call (e.g., `fleet_ping` returns pending messages). Additionally, a dedicated `fleet_check_inbox()` tool handles explicit polling.

**MCP tools implemented (v0):**
- `fleet_ping()` — heartbeat, returns Queen status + pending inbox messages
- `fleet_claim(task)` — writes claim file to `.fleet/active/<bee>.md`
- `fleet_journal(entry)` — appends to `.fleet/journal.md`
- `fleet_release()` — deletes claim file

**MCP tools planned (v1):**
- `fleet_lock(resource)` / `fleet_unlock(resource)` — lease-based exclusive access
- `fleet_announce(discovery)` — broadcast to all connected bees
- `fleet_request_review(summary)` — ask Queen for review
- `fleet_check_inbox()` — pull pending instructions

---

## Validation 3: Prompt Engineering ✅ PROVEN (with caveats)

**Question:** Can we write RULES.md/brain instructions that bees follow consistently without drifting?

**Result:** Partially — rules in CLAUDE.md stick well, but bees still drift on filesystem-based workflows. MCP tools solve this by enforcing behavior at the protocol layer.

**Empirical evidence (from real fleet usage across multiple hives):**

**What bees DO follow consistently:**
- Code style and conventions in CLAUDE.md
- Architecture decisions (zero-dependency, no build step)
- File naming and placement patterns
- Test patterns and frameworks
- Git commit conventions when specified
- Technical constraints ("use raw http.createServer, no Express")

**What bees DRIFT on (filesystem-based coordination):**
- Writing "Idle —" or "done" to claim files instead of deleting them (all-quite/bee2: `Working on: Idle — staging escalation disabled`)
- Forgetting to claim before starting work
- Journaling but not cleaning up the claim
- Writing claims to wrong format (`bee2.md` existing as stale from a prior session in fleet hive)
- Adding content to claim files beyond what was specified

**Root causes of drift:**
1. **CLAUDE.md vs RULES.md split** — CLAUDE.md is auto-loaded as system context; RULES.md requires the bee to voluntarily read it. Bees that skip reading RULES.md miss the coordination rules entirely.
2. **Context compaction** — long sessions compact early instructions. Coordination rules from RULES.md (read voluntarily) are more likely to be compacted than CLAUDE.md (system prompt).
3. **Ambiguity in rules** — "DELETE your active file" vs "write idle to your active file" — bees interpret the intent, not the exact instruction, and sometimes interpret wrong.
4. **No enforcement** — filesystem operations have no feedback loop. A bee can write "done" to a claim file and nothing tells it that's wrong.

**The MCP solution:**
MCP tools fundamentally change the compliance model:

| Old (filesystem rules) | New (MCP tools) |
|---|---|
| "Write a file to .fleet/active/" | `fleet_claim(task)` — tool handles the format |
| "Delete .fleet/active/bee.md" | `fleet_release()` — tool handles cleanup |
| "Append to journal.md" | `fleet_journal(entry)` — tool handles format + placement |
| "Check .fleet/active/ for conflicts" | Queen validates on `fleet_claim` |
| "Read RULES.md first" | Tool descriptions ARE the rules |

**Key insight:** The MCP tool's `description` field IS the rule. Claude Code reads tool descriptions on every tool call. A bee using `fleet_claim` always sees "Claim a task. The Queen validates there are no conflicts before approving." — the rule is embedded in the action, not in a separate file the bee might skip.

**What this means for the Queen architecture:**
1. **RULES.md becomes much simpler** — only high-level workflow ("use MCP tools, not filesystem") and decision-making guidance (not file format specs)
2. **Tool descriptions are the primary rule surface** — they survive context compaction because they're re-read on every call
3. **Queen validates on every tool call** — no relying on bees to self-police
4. **Graduated escalation handles the remaining drift** — when a bee forgets to call `fleet_claim` entirely, Queen detects via missing heartbeats and escalates

**Decision: Merge RULES.md into CLAUDE.md.**
RULES.md requires voluntary reading — bees that skip it miss coordination rules entirely. Moving all rules into CLAUDE.md means they're always loaded as system prompt, never skipped. This eliminates root cause #1 and #2 (compaction can't lose system prompt content).

**The new rule surface hierarchy:**
1. **CLAUDE.md `## Coordination` section** — always loaded, high-level workflow ("use MCP tools")
2. **MCP tool descriptions** — re-read on every tool call, carry the specific rules
3. **MCP tool responses** — Queen can embed instructions in any response (piggyback)
4. **tmux injection** — Queen's last resort for bees that don't call MCP tools

**Prompt engineering patterns that DO stick (for CLAUDE.md):**
- **Imperative with specific commands:** "Use `fleet_claim(task)` before starting work" > "Claim your task"
- **Negative examples:** "Never write 'idle' or 'done' — use `fleet_release()` instead" catches the exact drift pattern
- **MUST/NEVER keywords:** Claude Code treats these as hard constraints in system prompts
- **Why explanations:** "The Queen validates claims to prevent conflicts" — understanding purpose reduces creative reinterpretation
- **Tool-centric rules:** "All coordination through MCP tools — never touch .fleet/ files directly"

**Remaining risk:** A bee that never calls any MCP tool is invisible to the Queen. Mitigation: Queen monitors for Claude processes with no MCP heartbeat and escalates via tmux injection.

---

## Validation 4: Brain Auto-Restructuring ✅ PROVEN (deterministic rules viable)

**Question:** Can deterministic rules + drone execution reliably fragment a growing brain?

**Result:** Yes. Section size detection is deterministic and reliable. Drone execution for extract-and-pointer is straightforward.

**Real-world data (2026-07-28):**

```
fleet (66 lines) — healthy, no sections > 50 lines
all-quite (477 lines) — NEEDS RESTRUCTURING
  ## Payload mapping — the key to rich alerts    85 lines ← extract candidate
  ## Work Status                                 66 lines ← extract candidate
  ## Alertmanager config (per cluster)           51 lines ← borderline
Golazo (25 lines) — healthy
```

**Detection algorithm (pure Node.js, no dependencies):**

```javascript
function brainAudit(brainPath) {
  const lines = fs.readFileSync(brainPath, 'utf8').split('\n');
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^## /)) {
      if (current) current.end = i;
      current = { title: lines[i].replace(/^## /, ''), start: i, end: lines.length };
      sections.push(current);
    }
  }
  if (current) current.end = lines.length;
  return {
    totalLines: lines.length,
    sections: sections.map(s => ({
      title: s.title,
      lines: s.end - s.start,
      start: s.start,
      end: s.end
    })),
    extractCandidates: sections
      .filter(s => (s.end - s.start) > 50)
      .map(s => s.title)
  };
}
```

**Extract-and-pointer pattern:**
```
BEFORE (in CLAUDE.md):
  ## Payload mapping — the key to rich alerts
  [85 lines of content]

AFTER (drone executes):
  1. Creates brain/payload-mapping.md with the 85 lines
  2. Replaces section in CLAUDE.md with:
     ## Payload mapping — the key to rich alerts
     See [brain/payload-mapping.md](brain/payload-mapping.md) for details.
```

**Determinism verified:** The same CLAUDE.md always produces the same audit result. No randomness, no AI judgment needed for detection — pure line counting and heading parsing.

**What the Queen drone does (exact steps):**
1. Queen runs `brainAudit()` on a timer (configurable, default hourly)
2. If `extractCandidates.length > 0`, Queen spawns a drone per candidate
3. Drone reads the section content from CLAUDE.md
4. Drone creates `brain/<slug>.md` with the content
5. Drone replaces the section in CLAUDE.md with a pointer
6. Drone commits: `"brain: extract <section> to brain/<slug>.md"`
7. Queen logs the restructuring event

**Edge cases handled:**
- **Nested headings (###, ####):** Section boundary is the next `##`, not `###`. Sub-headings travel with their parent section during extraction.
- **Cross-references:** Pointers use relative paths. If other sections reference the extracted content, the drone adds a note.
- **Tables spanning sections:** Rare. The line-count boundary catches this — a table that pushes a section over 50 lines triggers extraction of the whole section including the table.
- **Multiple candidates in one pass:** Process largest first to avoid line-number shifts affecting smaller sections.

**Thresholds (configurable in Queen config):**
- `brain_section_max_lines: 50` — sections above this are extraction candidates
- `brain_total_max_lines: 300` — total brain size that triggers a restructuring audit
- `brain_audit_interval: 3600` — seconds between audits

---

## Architecture Summary

```
fleet serve (one process, one port)
  ├── HTTP server (dashboard + REST API)      ← exists
  ├── MCP server (bee tools via HTTP)          ← validation 2 ✅
  └── Queen supervisor loop                    ← ready to build (all validations ✅)
        ├── connection manager (heartbeats via fleet_ping / WebSocket)
        ├── tmux injector (send-keys to bee panes)
        ├── audit loop (claims, journals, git state)
        ├── brain monitor (size, staleness thresholds)
        ├── escalation engine (notice → warning → directive → override)
        ├── drone spawner (all actions delegated to drones)
        └── event log (everything Queen does)
```

**Communication channels (degrading gracefully):**
```
tmux send-keys     → instant push (requires tmux)
MCP tool piggyback → instructions in tool responses (requires MCP connection)
File inbox         → .fleet/inbox/<bee>.jsonl (always works)
```

**Bee lifecycle (enforced by MCP tools):**
```
connect → fleet_ping() → Queen onboarding check
       → fleet_claim(task) → Queen validates, approves
       → [work]
       → fleet_journal(entry) → Queen records
       → fleet_release() → Queen spawns review drone
       → drone reviews → APPROVED / ISSUE
       → bee outputs result (or fixes and re-requests)
disconnect → Queen detects via heartbeat loss
          → drone audits: open claim? missing journal?
          → graduated escalation if issues found
```

**Queen never acts directly — all actions via drones:**
```
Queen detects stale claim
  → spawns drone: "clean up bee1's stale claim, verify no work in progress"
  → drone executes, reports back
  → Queen logs result

Queen detects brain section > 50 lines
  → spawns drone: "extract ## API Reference to brain/api-reference.md, leave pointer"
  → drone executes, reports back
  → Queen logs result

Queen detects main branch moved
  → spawns drone per bee: "rebase bee2 onto latest main"
  → drone executes (or reports conflicts)
  → Queen logs result, escalates if conflicts
```

**File structure:**
```
.fleet/
  queen/
    config.yaml          # escalation rules, timers, thresholds
    event-log.jsonl      # everything Queen did
    brain-audit.json     # last brain analysis
  inbox/
    bee1.jsonl           # per-bee message queue (append-only, ack-based)
    bee2.jsonl
  leases/
    routing.json         # { owner, claimed_at, lease_seconds, mode }
  active/                # claims (managed by fleet_claim tool)
  journal.md             # work history (managed by fleet_journal tool)
```

**Dashboard additions:**
- Queen panel: live state, active leases, pending reviews, drone activity
- Royal Decree: user broadcasts to all bees
- Queen config: toggle passive/active per behavior, set timers
- Doctor removed — all health checks are Queen drone tasks
