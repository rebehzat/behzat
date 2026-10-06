# behzat

An independent harness for Pi, maintained by [rebehzat](https://github.com/rebehzat).

Behzat keeps Pi unmodified and separately updateable. Its independent terminal
interface uses OpenTUI and the OpenCode V2 theme and layout as its reference. The
usual screen shows the conversation, composer, model, effort, context and cost.
Ultracode, workflows, subagents and terminals show status only while active;
`Ctrl+T` opens details.

## Install

Download the archive for your platform from [Releases](https://github.com/rebehzat/behzat/releases),
check its SHA-256 checksum, extract it, and run `sh install.sh` inside it.
This installs the executable at `~/.local/bin/behzat` and the independent Pi
runtime at `~/.local/share/behzat/runtime`. Put `~/.local/bin` on your PATH.
Linux and macOS, x64 and ARM64, have native binary CI.

For a source build, install Bun 1.4.2 and run:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test
bun run licenses
bun run build
sh dist/package/install.sh
```

The release includes the Bun runtime; running Behzat does not require a separate
Bun installation. Updating Pi uses npm 22-compatible tooling on your machine:

```sh
behzat update-pi 1.0.4
```

Choose an explicit Pi release. The SDK is bundled into a separate runtime file,
without altering upstream source. The TUI executable stays unchanged. A failed
compatibility smoke check rolls the package back. Source dependency updates are
reviewed as PRs with the locked dependency graph and binary CI.

## Providers and credentials

`/models` uses Pi's provider/model catalog. `/login` forwards Pi's own API-key,
subscription, device-code, browser callback and manual-code interactions through
the terminal UI. Existing `~/.pi/agent/auth.json`, provider environments and
`models.json` remain usable. Secret entry is masked and excluded from transcripts.
`/logout` disconnects a provider from the shared Pi credential store.

Credentials supplied by a Pi extension are deliberately unavailable because
**all Pi extensions are disabled**: global, project, package, built-in, inline,
and reload discovery. Both main sessions and subagents use a closed resource
loader, and tests install a poisoned extension to verify that it never executes.
Markdown `AGENTS.md` and `CLAUDE.md` context files are still read.

## Controls

| Control | Behavior |
| --- | --- |
| `/models`, `/login`, `/logout` | Pi models and provider authentication |
| `Ctrl+E`, `/effort` | Keyboard effort slider; supported effort is shown in the footer |
| `/effort ultracode` | Request xhigh and enable automatic workflow orchestration |
| `/ultracode on`, `/ultracode off` | Toggle orchestration independently from model effort |
| `Shift+Tab`, `/approval ask\|auto\|plan` | Cycle approval modes |
| `Ctrl+Y`, `Ctrl+N` | Allow or deny the first pending tool request |
| `Ctrl+P`, Tab | Command palette and slash completion |
| Esc | Cancel the current run, agents and workflows |
| `/new`, `/resume`, `/fork` | Persistent sessions and conversation branches |
| `/compact`, `/context`, `/export` | Context management, usage and JSONL export |
| `/diff` | Inspect workspace changes |
| `/subagent [worktree] PROMPT` | Independent bounded research or isolated git editing |
| `/workflow run FILE`, `/workflows` | Durable background workflow DAGs and saved runs |
| `/workflow show ID`, `resume ID`, `cancel ID` | Inspect, recover or cancel a run |
| `/deep-research QUESTION` | Research, counterpoint, verification and cited synthesis |
| `/terminal start COMMAND` | Start a native background PTY |
| `/terminal read ID`, `send ID TEXT`, `stop ID` | Inspect output, send input and terminate the process group |
| `/skill NAME` | Read project `.behzat/skills/NAME/SKILL.md` or `.claude/skills/NAME/SKILL.md` |
| `/tasks`, `Ctrl+T` | Task and approval details |

Shift+Enter inserts a newline. PageUp/PageDown scroll the conversation. Up from
an empty composer recalls input. Use `--reduced-motion` to stop animations.

## TinyFish

Export `TINYFISH_API_KEY` before launching. The `web_search` and `web_fetch` tools
use TinyFish's documented search and markdown fetch APIs. Search supports domain
filters and web, news and research-paper modes. Without a key the tools return an
actionable configuration error. No key is embedded in the repository or release.

## Workflows and Ultracode

Behzat independently implements the orchestration pattern described in
[Claude Code's workflow docs](https://code.claude.com/docs/en/workflows).
It does not include Claude Code code or call an Anthropic-only harness feature.
Ultracode tells the main agent to author a workflow for substantive tasks, with
investigation, adversarial verification and synthesis. Selection depends on the
model following those instructions; an explicit workflow works deterministically.
The rainbow status appears only when the mode is on.

Workflows are validated JSON DAGs, rather than Claude's arbitrary orchestration
scripts. See `examples/review.workflow.json`. Each stage has an ID, prompt,
dependencies, optional `provider/model`, and research or worktree mode. A stage
receives its dependency reports. Results are atomically checkpointed outside the
main context; completed stages are skipped on resume. Failures block dependent
stages. `/workflow resume ID` recovers a cancelled or failed run in the original
workspace. Workflow stages and direct subagents share a global concurrency cap.

Research subagents have read/search tools and no shell or mutation tools.
Worktree subagents edit a detached checkout retained under the Behzat state
directory. Integrate their changes explicitly after inspecting them. A worktree
is filesystem separation, **not an OS sandbox**. Approvals wrap all mutation and
shell tools, including child agents. Auto mode deliberately allows these tools
with your process permissions. Plan mode blocks them; a denied tool returns an
error to the agent.

Background PTYs retain 128 KB of recent output. Closing Behzat stops its agents,
workflows and terminals and saves workflow state. Background programs do not
survive closing Behzat.

## Headless use

```sh
behzat doctor
behzat providers
behzat --model openai-codex/gpt-5.4 --auto-approve -p 'Run tests and fix the failure'
behzat --plan --json -p 'Review this repository'
git diff | behzat -p -
```

Use a model currently present in `behzat providers` and `/models`. Headless ask
mode denies tools needing approval; use `--auto-approve` for unattended execution.
`--json` streams Pi events as JSON lines. Headless mode waits for launched
workflows and final synthesis before exiting. Model/provider errors produce a
nonzero exit status.

Configuration is stored in `$BEHZAT_HOME/config.json`, or by default
`~/.local/state/behzat/config.json`. It supports `model`, `effort`, `approval`,
`concurrency` (1–16; default 4), `maxAgentTurns` (default 24), and `reducedMotion`.
Set `BEHZAT_PI_PACKAGE` to a Pi package directory for development compatibility
testing. Behzat never writes to Pi's source checkout.

## Validation and limitations

CI runs types, native TUI tests, fake-model tool dispatch, poisoned-extension,
workflow recovery, TinyFish contract and PTY cancellation tests. Binary CI builds
and smoke-tests release installation on four native platforms. Release archives
include checksums and license notices. All implementation changes land via PRs.

`bun run bench` measures 400-message local TUI streaming updates. Network and
model latency are outside this benchmark; no universal lag-free guarantee or
measured comparison with Codex is claimed. Real OAuth success and TinyFish
account access require your own credentials and are not exercised by CI. This
release does not include an LSP, MCP connections, Claude hooks, peer-agent teams,
or arbitrary-script workflow execution.

MIT license. Upstream references and exact versions are in `upstream.json`;
copyright notices are retained in `licenses/` and `THIRD_PARTY_NOTICES.md`.
