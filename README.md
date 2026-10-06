# dsh-codex-approvals

English | [中文](README.zh.md)

Codex-style auto-approval for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
**keeping the sandbox**, and auto-deciding only the approval requests that would otherwise interrupt you.

---

## The gap this fills

DSH ships an experimental layer, `@deepseek-ai/dsh-experimental-auto-review`, that reviews **every** tool
call. To do that it has to run unconfined — its preset identity is hard-coded:

```js
// @deepseek-ai/dsh-permission-presets
const AUTO_PRESET_SPEC = { sandbox: "danger-full-access", approval: "ask" };
```

So you must pick one of two extremes:

| Mode | Sandbox | Review | How it fails |
|---|---|---|---|
| `workspace-auto` | `workspace-write` | none | **safe** — legitimate out-of-bounds work simply cannot be done |
| `auto` (built-in) | none | every call | **open** — if the reviewer errs there is no backstop |

This plugin adds the missing middle. It hooks DSH's official `approval/request` waterfall as a **machine
answerer**. Because the approval layer and the sandbox layer are orthogonal, **it never changes your
sandbox mode**.

The result: `workspace-write` keeps confining the agent, and only the sandbox-escalation requests it
raises get answered by rules or a model reviewer instead of by you.

This mirrors Codex's `approvals_reviewer = "auto_review"` (`--approve-for-me`), whose own help text reads:

> Route approval requests through automatic review using the **workspace-write sandbox**

---

## Requirements

- DeepSeek Harness desktop `0.2.0-rc.2` (or a compatible runtime)
- The session's approval policy must be **`ask`**

That second point matters and is easy to get wrong. `ApprovalService.decide()` short-circuits *before*
the waterfall when the policy is `never`:

```js
if (this.effectivePolicy(session) === "never") return "rejected";  // answerers never run
```

So this plugin is **dormant** under any preset whose approval policy is `never`:

| Preset | Sandbox | Approval | This plugin |
|---|---|---|---|
| `read-only` | read-only | never | ❌ dormant |
| **`workspace-write`** | workspace-write | **ask** | ✅ active |
| `workspace-auto` | workspace-write | never | ❌ dormant |
| `danger-full-access` | danger-full-access | never | ❌ dormant |
| `auto` (built-in review) | danger-full-access | ask | ✅ active |

**Use `workspace-write`.** That is exactly the "sandbox + review" combination this plugin exists for.

---

## Install

```sh
dsh plugin --profile <your-profile> add /path/to/dsh-codex-approvals
```

Or install it from this repository's URL once published. After installing, the `/approvals` command
becomes available.

> Source edits require an app restart to take effect — the runtime does not hot-reload plugin modules.

---

## Usage

One command, `/approvals`:

```
/approvals                           show status
/approvals mode off|rules|auto|guardian
                                     off    = delegate everything to the human
                                     rules  = only rule matches are decided here (default)
                                     auto   = model review, balanced
                                     guardian = model review, strict
/approvals allow <regex>             global allow: matching justification auto-approves
/approvals deny <regex>              global deny: takes precedence over allow
/approvals allow-here <regex>        allow scoped to the current session only
/approvals rm <id>                   remove a rule
/approvals rules                     list rules
/approvals log [n]                   show the last n audit entries (default 10)
```

**The default is `rules` with zero rules — i.e. behaviour identical to not having the plugin
installed.** Nothing is auto-approved until you add a rule or switch `mode`.

### What the regex matches

DSH's only producer of approval requests is `dsh-sandbox`'s `approveEscalation()`, which emits a
fixed shape:

```
escalate sandbox to <target-mode>: <free-text justification from the agent>
```

The plugin parses that shape, so rules can match the **target mode** and the **justification text**
(case-insensitive).

```
/approvals allow git push            # mentions "git push" → auto-approve
/approvals deny  rm -rf              # mentions "rm -rf" → hard reject
```

> **Write tight, anchored rules.** The justification is written by the model. `/approvals allow .*`
> disables the approval system entirely, and a loose pattern can be triggered by the model simply
> phrasing its reason a certain way. This is a known weakness — see Limitations.

---

## How a decision is made

1. A **deny** rule matches → `rejected`
2. An **allow** rule matches → `allowed-once`
3. Otherwise, by mode:
   - `rules` / `off` → delegate to the human (`next()`)
   - `auto` / `guardian` → the model reviewer decides

The reviewer returns one of three verdicts:

| Verdict | Outcome | Meaning |
|---|---|---|
| `allow` | `allowed-once` | auto-approve |
| `ask` | `next()` | hand back to the human |
| `deny` | `rejected` | hard reject |

The reviewer's protocol is strict JSON, and it is the same shape the upstream layer uses:

```jsonc
{"risk":"low","decision":"allow"}
{"risk":"medium","decision":"allow"}
{"risk":"medium","decision":"ask"}
{"risk":"medium","decision":"deny","reason":"..."}
{"risk":"high","decision":"deny","reason":"..."}
```

It runs with `temperature: 0` using the **current session's** provider and model, so it adds one model
request per reviewed escalation.

**Every failure path is fail-closed.** No LLM service, no provider/model route, malformed reviewer
output, an invalid regex, or any uncaught exception → `next()`, i.e. the human is asked after all.
With no human answerer the request resolves to `unavailable`, which is also a denial.

---

## Storage

| Path | Contents |
|---|---|
| `~/.dsh/codex-approvals/rules.json` | mode, rules, hit counters |
| `~/.dsh/codex-approvals/audit.jsonl` | one line per decision |

Override the directory with `CODEX_APPROVALS_DIR` (used by the tests). Writes use temp-file + rename.
Audit write failures are swallowed — they never change a decision.

---

## Limitations

Being explicit about these matters more than the feature list.

1. **The reviewer cannot see the real command.** `ApprovalRequestEvent` carries only
   `toolName / callId / reason / displayReason / signal` — no arguments. In `auto` / `guardian` mode the
   reviewer judges the agent's own justification text. The policy prompt tells it this explicitly and
   requires `ask` when the information is insufficient.
2. **Rules are keyed on model-authored text.** The only way to obtain the real command would be to
   re-read `tool/call` events from the session log and match on `callId` — a workaround this plugin
   deliberately does not do. The consequence is real: **a model can trigger its own approval by
   writing the right words in its justification.**
3. **No UI buttons.** The approval outcome vocabulary is closed
   (`allowed-once | rejected | cancelled | unavailable`) and validated by an invariant companion
   plugin, and the approval UI is shipped client code. Codex-style *approve for session / for prefix*
   buttons therefore cannot be added; the equivalent semantics live in `/approvals` commands instead.
4. **Only sandbox-escalation-shaped requests are model-reviewed.** Anything else (for example an `ask`
   returned by the built-in auto-review) is delegated straight to the human, so the two layers do not
   double-review.
5. **It does nothing under `never`.** See Requirements.
6. **Source edits need an app restart.** Verified: neither `disable → enable` nor
   `remove_bundle → install_bundle` re-imports the module, and the HMR watcher ignores `node_modules`
   and does not watch outside the profile.

---

## Development

```sh
node --test test/logic.test.mjs
```

The test suite (33 cases) is pure Node and does not need the DSH runtime: `lib/rules.js` and
`lib/policy.js` have zero DSH imports, and the plugin wiring is exercised through a fake `ctx`.

| File | Responsibility |
|---|---|
| `lib/rules.js` | reason parsing, rule matching, rule store, audit log |
| `lib/policy.js` | the `auto` / `guardian` reviewer policies and strict JSON protocol |
| `lib/index.js` | Cordis wiring: the `approval/request` answerer and the `/approvals` command |
| `test/logic.test.mjs` | 33 cases |

---

## Why this exists

This plugin is a working prototype for an upstream feature request: making the approval layer composable
with a confining sandbox, and rules keyed on the real command line. The proof that the seam is
sufficient already lives here — what is missing is first-class support in DSH.

## License

[MIT](LICENSE)
