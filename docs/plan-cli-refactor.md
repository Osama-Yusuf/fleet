# Plan: CLI Refactor — Split bin/fleet into Modules

**Status:** Deferred
**Trigger:** When `bin/fleet` exceeds ~2,500 lines or needs complex data structures
**Current size:** ~1,475 lines, 58 functions

## Why not now

- `bin/fleet` is bash. The target is JS. This is a full rewrite, not a file shuffle.
- Bash is the right tool — the CLI is mostly git, mv, ln, cp, jq. Node would wrap those same shell commands in `child_process.execSync`.
- 1,475 lines is well within maintainable range for a bash CLI (nvm is 6,000+).
- Risk of introducing subtle bugs during rewrite with no user-facing benefit.

## When to trigger

- Script exceeds ~2,500 lines
- Commands need complex data structures (maps, nested objects, async)
- Testing bash functions in isolation becomes a bottleneck
- Multiple contributors need to work on different commands simultaneously

## Target structure

```
bin/fleet              ← thin bash wrapper: parse args, dispatch to Node
lib/
  cli.js               ← arg parsing + command dispatch
  commands/
    init.js            ← cmd_init (lines 348–545, ~200 lines)
    spawn.js           ← cmd_spawn (lines 645–698, ~55 lines)
    adopt.js           ← _adopt_impl + cmd_adopt (lines 546–643, ~100 lines)
    status.js          ← cmd_status (lines 700–742, ~45 lines)
    destroy.js         ← cmd_destroy (lines 743–770, ~30 lines)
    doctor.js          ← cmd_doctor (lines 771–859, ~90 lines)
    eject.js           ← cmd_eject (lines 860–892, ~35 lines)
    launch.js          ← cmd_launch + _open_bee_tab (lines 893–969, ~80 lines)
    scan.js            ← cmd_scan + helpers (lines 1309–1443, ~135 lines)
    event.js           ← cmd_event (lines 1082–1101, ~20 lines)
    config.js          ← cmd_config (lines 1407–1443, ~40 lines)
    interactive.js     ← cmd_interactive (lines 1148–1188, ~40 lines)
  hive.js              ← find_hive, hive_root, fleet_type, wire_symlinks, gitignore_add
  claude.js            ← _setup_bee_claude, _trust_path, _bee_has_sessions
  registry.js          ← register_bee, register_hive, ensure_global, _append_bee_event
  brain.js             ← _merge_brains, inject_protocol, inject_rules, merge_settings
  git.js               ← git clone helpers, branch detection
  ui.js                ← info, ok, warn, err, dim, bold, die, confirm
```

## Function groupings (current bash → target module)

### Shared utilities → `lib/ui.js`
- `info`, `ok`, `warn`, `err`, `dim`, `bold`, `die`, `confirm`

### Hive operations → `lib/hive.js`
- `find_hive`, `in_hive`, `hive_root`, `fleet_type`
- `next_bee_num`, `bump_next_bee`
- `wire_symlinks`, `gitignore_add`

### Claude integration → `lib/claude.js`
- `_setup_bee_claude` — copy project dirs per bee
- `_trust_path` — add to allowlist
- `_bee_has_sessions`, `_standalone_has_sessions`

### Brain/protocol → `lib/brain.js`
- `_merge_brains` — merge CLAUDE.md content
- `inject_protocol` — coordination section
- `inject_rules` — fleet rules
- `merge_settings` — jq-based .claude/settings merge

### Registry → `lib/registry.js`
- `register_bee`, `_append_bee_event`
- `register_hive`, `ensure_global`
- `_fleet_resolve_self`
- `_path_in_registered_hive`, `_known_claude_cwds`, `_live_claude_cwds`

### Commands → `lib/commands/*.js`
Each file exports a single function matching the current `cmd_*` bash function.

## Migration strategy

1. **Write comprehensive CLI tests first** — current `test/cli.test.js` has only 3 tests covering syntax check, help output, and event append. Before rewriting, add integration tests for every command: init (repo + brain), spawn, adopt, destroy, doctor, eject, status, scan, launch, config. Each test should create a temp dir, run the command, and verify the filesystem result.

2. **Rewrite one command at a time** — start with the simplest (`cmd_event`, `cmd_status`) and verify tests still pass. Work up to the complex ones (`cmd_init`, `cmd_adopt`).

3. **Keep bash as the entry point initially** — `bin/fleet` stays bash but sources/dispatches to Node for rewritten commands. This lets old and new coexist during migration.

4. **Cut over** — once all commands are in Node, replace `bin/fleet` with a Node entry point. Update `package.json` bin field.

## Test coverage targets (pre-rewrite)

| Command | Current coverage | Needed |
|---------|-----------------|--------|
| `init` (repo) | None | Create repo hive, verify bee1, symlinks, fleet.json, CLAUDE.md protocol |
| `init` (brain) | None | Create brain hive, verify structure |
| `spawn` | None | Spawn bee2, verify clone, symlinks, registration |
| `adopt` | None | Adopt external dir, verify move, merge, registration |
| `destroy` | None | Destroy bee, verify removal + deregistration |
| `doctor` | None | Broken symlinks detected and fixed |
| `eject` | None | Bee moved out, standalone, deregistered |
| `status` | None | Output lists bees with correct state |
| `scan` | None | Discovers hives and strays in scan paths |
| `event` | Covered | Append event to JSONL |
| `config` | None | Set/get scan paths |
| `help` | Covered | Documents all commands |
| `syntax` | Covered | Valid bash |

## Risks

- **Shell quoting edge cases** — bash handles paths with spaces, special chars differently than Node's `child_process`. Test with adversarial paths.
- **Exit codes** — bash functions use `return`/`exit` with specific codes. Node needs to match.
- **Terminal detection** — color output, interactive prompts, TTY checks behave differently.
- **Platform differences** — `readlink -f` (Linux) vs `readlink` (macOS) already handled in bash; Node's `fs.realpathSync` is portable.
- **jq dependency** — currently used for JSON manipulation. Node eliminates this dependency (native JSON), which is actually a win.
