---
doc_id: operations/configuration
audience: maintainer
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Configuration

This page lists operator-facing configuration found in source. It intentionally does not invent undocumented environment variables.

## Capability and dock selection

Configuration is read before any package registration on each extension activation and is re-read by a real Pi `/reload`. Invalid input throws a bounded `pi_bg_config_invalid` error; it never partially activates a requested subset or falls back to defaults.

| Variable | Default | Accepted values and effect |
|---|---|---|
| `PI_BG_FEATURES` | `process,delegate,fusion,attested,attribution` | A comma-separated set of exact lowercase, unique tokens from `process`, `delegate`, `fusion`, `attested`, `attribution`. Whitespace, blanks, duplicates, unknown values, and omission of mandatory `process` are errors. |
| `PI_BG_DOCK_SHORTCUT` | `shift+down` | Exactly `shift+down`, `ctrl+alt+b`, or `off`. Only the selected literal key is registered; `off` registers no dock shortcut. |

Capabilities are independent except for the derived result surface:

- `process` is mandatory and owns ordinary process commands/tools, the task UI/renderer, footer, and EventBus service.
- `delegate` registers `bg_delegate`.
- `fusion` registers `/fusion`, `/fusion-models`, the four `fusion_*` tools, and its result renderer.
- `attested` registers `bg_run_pi_attested`.
- `attribution` is accepted for backward compatibility and has no effect; this fork does not register an Anthropic provider, hooks, or `/claude-cache`.
- `bg_result` is not a feature token. It is registered exactly once when `delegate` or `fusion` is enabled, and is absent when neither producer is enabled.

Disabled package tools, commands, renderers, and shortcuts are absent from registration and discovery. Pi's registry rebuild drops stale active names that have no current definition; the package does not deactivate an unrelated extension tool merely because its name matches a disabled capability. `/tasks` and `/bg-tasks` are always available. With the dock shortcut off, the footer advertises `/tasks`; the alternate footer hint is `CtrlAltB`. `Ctrl+Alt+C` remains the terminal-dependent `/bg-clear` fallback in every configuration.

Package-owned Delegate, Fusion, and attested children load only their own guard/metadata extension. Anthropic routes use Pi's built-in Anthropic transport and the credential configured in Pi (for example `ANTHROPIC_API_KEY`).

These flags select functionality only. They do not claim to reduce cold-start import cost; deferred loading and performance measurement are separate work.

## Initialized-host SDK contract

Normal Pi TUI, RPC, print, and JSON modes provide lifecycle bindings that initialize post-bind package resources and cause `session_start` to run after reload. An SDK host must call `bindExtensions()` with at least one binding Pi counts (UI context, command-context actions, shutdown handling, or `onError`). With only `{}` or `{ mode: "print" }`, the first explicit bind initializes resources, but `reload()` does not emit the rebuilt runner's `session_start`; the host must explicitly bind again after every `reload()`.

Bare `createAgentSession()` without `bindExtensions()` leaves session-start context services uninitialized. It also means an opted shell cannot be claimed after an empty/mode-only SDK reload unless the embedder explicitly binds again. Direct `AgentSession.dispose()` invalidates without `session_shutdown`; extension-bearing SDK hosts must use `AgentSessionRuntime.dispose()` or another awaited host shutdown path. The generated availability tables describe this initialized-host contract and are not a pre-bind availability guarantee.

## Opt-in reload survival

Reload survival is a per-launch field/flag, not a global environment setting:

- `bg_run({ isAgent:false, surviveReload:true, ... })`
- `/bg --survive-reload ...`

Omitted/false keeps default kill-on-reload behavior. Survival is supported only for ordinary shell tasks across a real same-process Pi reload with the exact session id and canonical cwd. Agent, managed, delegate, Fusion, attested, EventBus-v1, new/resume/fork/clone/quit, crash, and process-restart paths do not opt in. The live execution retains its launch-time shell policy, timeout deadline, output cap, and cumulative bytes even if environment/config changes before reload; a dock rerun is new work and uses current configuration.

## Update check

At `session_start`, the extension performs a one-shot, time-boxed npm latest-version lookup. Failures are offline-safe: the footer simply shows no update segment.

| Variable | Effect |
|---|---|
| `PI_BG_DISABLE_UPDATE_CHECK=1` | Skip the update check. |
| `PI_OFFLINE=1` | Skip the update check. |
| `PI_BG_REGISTRY_URL=<url>` | Use a registry mirror instead of `https://registry.npmjs.org`. |

`/bg-update` only prints update commands; it does not install or self-update.

## Shell selection

### POSIX

The policy is resolved once per extension activation. Changing these variables takes effect on the next Pi start or `/reload`, not midway through an activation.

| Variable | Effect |
|---|---|
| `PI_BG_POSIX_SHELL=inherit` | Default. Preserve the existing behavior: use non-empty `SHELL`, otherwise `/bin/sh`, with `-c`. |
| `PI_BG_POSIX_SHELL=bash` | Select Bash explicitly. Check executable `/bin/bash` first, then `bash` in `PATH` order; fail if unavailable. |
| `PI_BG_POSIX_SHELL=sh` | Select sh explicitly. Check executable `/bin/sh` first, then `sh` in `PATH` order; fail if unavailable. |
| `PI_BG_POSIX_SHELL_PATH=<absolute-file>` | Optional only with `bash` or `sh`. The target must be a regular executable file. Invalid, empty, relative, or unavailable paths fail without search fallback. |

Executable paths are structured spawn arguments, not interpolated command text. Bash and sh receive `-c`, never `-lc`; selecting them does not implicitly load login-shell startup files. For explicit search, `/bin` wins over `PATH`; relative `PATH` directories are resolved at activation so task cwd changes cannot retarget the selected executable.

In `inherit` mode, known Bourne-family names are reported as POSIX-compatible, `bash` is reported as Bash, and Nu/fish/csh/unknown names are reported as `user-non-posix`. The inherited executable itself is intentionally not validated or replaced, preserving compatibility. Before each agent run, guidance reports the exact resolved executable/dialect/args. A non-POSIX inherited shell receives explicit `PI_BG_POSIX_SHELL=bash` remediation.

### Windows

Windows defaults to `cmd.exe`/`ComSpec`. The generic `SHELL` variable is ignored on Windows so existing `cmd` syntax does not silently change language.

| Variable | Effect |
|---|---|
| `PI_BG_SHELL=cmd` | Use Windows `cmd` dialect. |
| `PI_BG_SHELL=bash` | Use POSIX-style `bash -c` on Windows. |
| `PI_BG_SHELL_PATH=<absolute .exe/.com>` | Explicit shell path; requires `PI_BG_SHELL`. |

Invalid Windows shell settings fail loudly instead of falling back. `bash` is invoked with `-c`, not `-lc`. `PI_BG_POSIX_SHELL` and `PI_BG_POSIX_SHELL_PATH` are ignored on Windows, even when present, so they cannot change existing cmd/Bash/ComSpec selection or structured argv behavior.

## Output and log caps

| Setting/surface | Value/behavior |
|---|---|
| `PI_BG_MAX_OUTPUT_BYTES` | Optional environment override for task output cap. Default is 20 MiB. Exceeding it fails/kills the task rather than claiming success. |
| `bg_logs.maxBytes` / `/logs <id> [maxBytes]` | Bounded model-visible read. The package cap is 50 KiB. |
| Full output | Written under `.pi/tasks/<session-id>-<pid>/<task-id>.output`. |

Bounded logs are for context safety; they point to the full local output file when more bytes exist.

## Pi-agent telemetry opt-out

| Variable | Effect |
|---|---|
| `PI_BG_DISABLE_PI_TELEMETRY=1` | Do not wrap shell commands that appear to launch `pi -p ...` or `pi --mode json ...` when `isAgent:true`. Raw stdout is preserved. |

Telemetry wrapping is best-effort and task-owned. Missing telemetry is reported as unavailable, never as zero. Wrapping requires a resolved shell with compatible POSIX function syntax. Under Windows `cmd` or an inherited Nu/fish/csh/unknown shell, safe interception is unavailable, the command is left unchanged, and task metadata records the reason.

## Anthropic requests and caching

This package does not replace or wrap Pi's Anthropic provider. Parent sessions and package-owned children send Anthropic requests through Pi's built-in transport with whatever credential Pi is configured with; use an Anthropic API key (`ANTHROPIC_API_KEY` or `pi auth`) for third-party harness use. The package never reads `~/.claude.json` and never sends Claude Code client identity headers or system prompts.

| Variable | Effect |
|---|---|
| `PI_CACHE_RETENTION=long` | Fusion children default to one-hour Anthropic cache breakpoints where the model supports them. This is the Fusion default when unset. |
| `PI_CACHE_RETENTION=short` | Default to ordinary ephemeral cache breakpoints without a one-hour TTL. |
| `PI_CACHE_RETENTION=none` | Do not add default cache breakpoints. Explicit call-level policy remains authoritative. |

## Fusion model configuration

Fusion model slots are stored globally under the Pi agent directory as:

```text
fusion-models.json
```

Use `/fusion-models` in TUI mode to configure five slots:

- Candidate 1
- Candidate 2
- Candidate 3
- Evaluator
- Merger

Missing config means all five slots are `$current`. Config entries are qualified `provider/model` selections or `$current`; malformed config, stale explicit models, unavailable current models, and concurrent selector conflicts fail loudly before child inference.

Fusion accepts any model route configured in Pi, including API-key (metered) routes. Provider credential environment variables are inherited by Fusion children; only session/model selection variables and Fusion-internal variables are removed. Anthropic children use Pi's built-in Anthropic transport, and budgets use the model's advertised context window.

## Fusion Claude prompt caching

| Variable | Effect |
|---|---|
| `PI_CACHE_RETENTION=long` | Request `ttl: "1h"` on Pi-selected Anthropic cache breakpoints. This is Fusion's default when the variable is unset. |
| `PI_CACHE_RETENTION=short` | Use normal ephemeral retention without a `ttl` field (approximately five minutes). |
| `PI_CACHE_RETENTION=none` | Remove Anthropic cache breakpoints from normal Fusion provider payloads. Pi compaction payloads that already contain no breakpoints remain unmarked under every policy. |

Fusion children are isolated with `--no-session --no-extensions`; use `PI_CACHE_RETENTION` to control Fusion cache retention. When the variable is absent, Fusion sets `long` in the Anthropic child environment so Pi's built-in provider requests `ttl: "1h"` cache controls. Explicit call-level `cacheRetention="none"` still takes precedence for compaction. The final governor validates the controls, preserves at most Anthropic's four supported breakpoints, and records requested/effective **payload** policy in each child result event. Invalid values fail before provider transport, and models that explicitly reject long retention use short retention instead.

Provider usage is preserved without inventing one-hour tokens. Positive `cacheWrite1h` is definitive evidence of a one-hour write, but zero is inconclusive on subscription OAuth: 2026-08-04 normal-spawn and Fusion-child controls accepted `ttl: "1h"`, reported `cacheWrite1h = 0`, and still returned their unique cache hits after 370 idle seconds—beyond the documented five-minute lifetime. The payload observation proves what was sent; `cacheRead` proves reuse; neither alone proves a full hour. One-hour cache creation, when itemized by the provider, has a higher write price than short retention.

## Fusion runtime limits

These are source constants, not documented operator env knobs:

| Limit | Value |
|---|---:|
| Child absolute timeout | 50 minutes |
| Child stale-output watchdog | 35 minutes |
| Child stdout cap | 32 MiB |
| Child stderr cap | 16 MiB |
| Provider requests per child | 550 |
| Tool calls per child | 600 |
| Aggregate candidate tool-result bytes | 32 MiB |
| Candidate output contract | 48 KiB JSON-rendered bytes |
| Evaluator output contract | 64 KiB JSON-rendered bytes |
| Merger output contract | 64 KiB JSON-rendered bytes |
| `fusion_web_fetch` timeout | 90 seconds |
| `fusion_web_fetch` response body cap | 4 MiB |
| `fusion_web_fetch` returned content cap | 32 KiB |
| `fusion_web_fetch` redirect cap | 5 hops |

Oversized Fusion outputs fail loudly and are preserved in local artifacts where applicable. They are not forwarded or silently truncated. Post-launch Fusion requests are not admitted or refused by estimating live input tokens and subtracting the model's possible output from its context window; Pi/provider context handling remains authoritative after Fusion's pre-spawn stage-budget checks.

## Offline behavior

- Update checks skip when `PI_OFFLINE=1` and degrade to no footer update segment on any lookup failure.
- Background shell commands may still do whatever the command does; the package does not block their network access.
- Fusion child model calls require configured Pi model routes. `fusion_research` additionally requires network access to the caller-supplied public URLs it fetches.

## Durability and platform note

Task metadata, delegate/Fusion artifacts, attestation sidecars, and `fusion-models.json` use durable write helpers. Ordinary task `.output` streams are ended and drained before terminal publication but are not explicitly fsynced. POSIX performs directory `fsync` after atomic replacement. Windows still flushes replaced file contents before rename and treats rename failures as fatal, but it does not get the same portable directory-entry crash-durability guarantee.
