# dsh-codex-approvals

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Codex 风格自动审批 ——
**保留沙箱**，只自动裁决那些本来会打断你的审批请求。

---

## 它填补的空缺

DSH 自带一个实验层 `@deepseek-ai/dsh-experimental-auto-review`，它会审查**每一个**工具调用。
为了做到这一点，它必须不受沙箱约束 —— 它的预设身份是写死的：

```js
// @deepseek-ai/dsh-permission-presets
const AUTO_PRESET_SPEC = { sandbox: "danger-full-access", approval: "ask" };
```

于是使用者只能选两个极端之一：

| 模式 | 沙箱 | 审查 | 失效方向 |
|---|---|---|---|
| `workspace-auto` | `workspace-write` | 无 | **fail safe** —— 正当的越界操作根本做不了 |
| `auto`（内置） | 无 | 每个调用 | **fail open** —— 审查者一旦误放行，没有后备 |

本插件补上中间那一档。它挂在 DSH 官方的 `approval/request` waterfall 上，作为一个**机器应答者**。
因为审批层与沙箱层是正交的，**它从不改变你的沙箱模式**。

结果是：`workspace-write` 继续约束 agent，而它产生的越界升权请求，由规则或模型审查者来回答，
而不是你。

这对应 Codex 的 `approvals_reviewer = "auto_review"`（CLI 上的 `--approve-for-me`），它的帮助文案是：

> Route approval requests through automatic review using the **workspace-write sandbox**

---

## 前提

- DeepSeek Harness 桌面端 `0.2.0-rc.2`（或兼容的运行时）
- 会话的审批策略必须是 **`ask`**

第二点很容易搞错，而且很关键。策略为 `never` 时，`ApprovalService.decide()` 会在分发到 waterfall
**之前**就短路：

```js
if (this.effectivePolicy(session) === "never") return "rejected";  // 应答者根本不会被调用
```

所以在任何审批策略为 `never` 的预设下，本插件都是**休眠**的：

| 预设 | 沙箱 | 审批 | 本插件 |
|---|---|---|---|
| `read-only` | read-only | never | ❌ 休眠 |
| **`workspace-write`** | workspace-write | **ask** | ✅ 生效 |
| `workspace-auto` | workspace-write | never | ❌ 休眠 |
| `danger-full-access` | danger-full-access | never | ❌ 休眠 |
| `auto`（内置审查） | danger-full-access | ask | ✅ 生效 |

**请用 `workspace-write`。** 这正是本插件存在的意义所在的那个"沙箱 + 审查"组合。

---

## 安装

```sh
dsh plugin --profile <你的 profile> add /path/to/dsh-codex-approvals
```

发布之后也可以直接用仓库地址安装。装好后 `/approvals` 命令即可使用。

> 修改源码后需要重启应用才生效 —— 运行时不会热重载插件模块。

---

## 用法

只有一个命令 `/approvals`：

```
/approvals                           查看状态
/approvals mode off|rules|auto|guardian
                                     off      = 全部退回人工
                                     rules    = 只裁决规则命中的（默认）
                                     auto     = 模型审查，平衡档
                                     guardian = 模型审查，严格档
/approvals allow <正则>              全局放行：理由文本匹配即自动同意
/approvals deny <正则>               全局拒绝：优先级高于 allow
/approvals allow-here <正则>         只对当前会话生效的放行
/approvals rm <id>                   删除规则
/approvals rules                     列出规则
/approvals log [n]                   看最近 n 条审计（默认 10）
```

**默认是 `rules` 模式且零规则 —— 行为与没装这个插件完全一致。** 在你加规则或切 `mode` 之前，
不会有任何东西被自动放行。

### 正则匹配的是什么

DSH 里唯一会发起审批的消费方是 `dsh-sandbox` 的 `approveEscalation()`，它产出固定形状：

```
escalate sandbox to <目标模式>: <agent 自述的理由>
```

插件把这个形状解析开，所以规则可以匹配**目标模式**和**理由文本**（大小写不敏感）。

```
/approvals allow git push            # 提到 git push → 自动放行
/approvals deny  rm -rf              # 提到 rm -rf → 硬拒绝
```

> **规则要写紧、最好锚定。** 理由是模型写的。`/approvals allow .*` 等于把审批系统整个关掉；
> 而过于宽松的模式，模型只要换一种措辞就能触发。这是一个已知弱点，见「限制」。

---

## 决策路径

1. 命中 **deny** 规则 → `rejected`
2. 命中 **allow** 规则 → `allowed-once`
3. 都没命中时，按 mode：
   - `rules` / `off` → 退回人工（`next()`）
   - `auto` / `guardian` → 交给模型审查者

审查者返回三种裁决之一：

| 裁决 | 映射 | 含义 |
|---|---|---|
| `allow` | `allowed-once` | 自动放行 |
| `ask` | `next()` | 退回人工 |
| `deny` | `rejected` | 硬拒绝 |

审查协议是严格 JSON，与上游实验层同一形状：

```jsonc
{"risk":"low","decision":"allow"}
{"risk":"medium","decision":"allow"}
{"risk":"medium","decision":"ask"}
{"risk":"medium","decision":"deny","reason":"..."}
{"risk":"high","decision":"deny","reason":"..."}
```

它以 `temperature: 0`、使用**当前会话的** provider 与 model 运行，因此每次受审的升权请求
会增加一次模型请求。

**所有失败路径都是 fail-closed。** 没有 LLM 服务、拿不到 provider/model、审查输出不合协议、
正则非法、任何未捕获异常 → 一律 `next()`，也就是最后还是问你。
没有人工应答者时，请求解析为 `unavailable`，同样是拒绝。

---

## 存储

| 路径 | 内容 |
|---|---|
| `~/.dsh/codex-approvals/rules.json` | 模式、规则、命中计数 |
| `~/.dsh/codex-approvals/audit.jsonl` | 每次裁决一行 |

用环境变量 `CODEX_APPROVALS_DIR` 可覆盖目录（测试用）。写盘用「临时文件 + rename」。
审计写失败会被吞掉 —— 它绝不会改变裁决。

---

## 限制

把这些说清楚，比功能列表更重要。

1. **审查者看不到真实命令。** `ApprovalRequestEvent` 只带
   `toolName / callId / reason / displayReason / signal`，没有参数。所以在 `auto` / `guardian` 模式下，
   审查者判断的是 agent 自己写的理由。策略文本里明确告知了这一点，并要求信息不足时返回 `ask`。
2. **规则的键是模型写的文本。** 想拿到真实命令，只能回读会话日志里的 `tool/call` 事件、
   按 `callId` 对回去 —— 这是本插件**有意不做**的绕法。后果是真实的：
   **模型可以通过在理由里写下特定字样，触发对自己的放行。**
3. **没有 UI 按钮。** 审批结果词表是封闭的（`allowed-once | rejected | cancelled | unavailable`），
   且有 invariant 插件校验，审批 UI 也是 shipped 客户端代码。所以 Codex 那种
   *approve for session / for prefix* 按钮加不进来；等价语义用 `/approvals` 命令提供。
4. **只有沙箱越界形状的请求会进模型审查。** 其它来源（例如内置 auto-review 返回的 `ask`）
   直接透传给人工，避免两层叠加审查。
5. **在 `never` 下完全不起作用。** 见「前提」。
6. **改源码要重启应用。** 已实测：`disable → enable` 和 `remove_bundle → install_bundle`
   都不会重新 import 模块，而 HMR 监听器忽略 `node_modules`，也不监听 profile 之外的目录。

---

## 开发

```sh
node --test test/logic.test.mjs
```

33 个用例，纯 Node，不需要 DSH 运行时：`lib/rules.js` 与 `lib/policy.js` 零 DSH 依赖，
插件装配部分用假的 `ctx` 驱动。

| 文件 | 职责 |
|---|---|
| `lib/rules.js` | reason 解析、规则匹配、规则存储、审计日志 |
| `lib/policy.js` | `auto` / `guardian` 审查策略与严格 JSON 协议 |
| `lib/index.js` | Cordis 装配：`approval/request` 应答者 + `/approvals` 命令 |
| `test/logic.test.mjs` | 33 个用例 |

---

## 它为什么存在

本插件是一个**可运行的原型**，用来支撑一份上游功能建议：让审批层能与受限沙箱组合，
并让规则的键落在真实命令行上。**seam 足够用这件事，已经由这里的代码证明了** ——
缺的只是 DSH 把它做成一等公民。

## 许可

[MIT](LICENSE)
