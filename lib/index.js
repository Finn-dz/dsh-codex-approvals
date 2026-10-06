/**
 * dsh-codex-approvals —— Codex 风格的审批自动应答者。
 *
 * 它挂在 DSH 官方的 `approval/request` waterfall 事件上，作为「机器应答者」
 * 回答审批请求。因为审批与沙箱是两个正交的层，本插件**不改变沙箱模式**，
 * 所以可以做到内置实验层做不到的组合：
 *
 *     workspace-write 沙箱照旧兜底 + 越界升权请求由规则/模型审查，而不是你
 *
 * 三条决策路径，按顺序：
 * 1. 规则命中 deny  → `rejected`（硬拒绝）
 * 2. 规则命中 allow → `allowed-once`（放行这一次）
 * 3. 规则未命中     → 按 mode 决定：`off` 退回人工；`auto`/`guardian` 交给模型审
 *
 * 任何异常、任何不合协议的模型输出、任何信息不足 → 一律 `next()` 退回人工，
 * 即 fail-closed。
 *
 * @module dsh-codex-approvals
 */

import { RuleStore, decideByRules, parseApprovalReason } from "./rules.js";
import { parseReviewDecision, policyFor, reviewUserText } from "./policy.js";

/** Cordis 插件名，用于 loader 诊断。 */
export const name = "codex-approvals";

/** 硬依赖：没有审批服务就没有可挂的 seam。 */
export const inject = ["approval"];

/**
 * 插件入口。
 * @param ctx - 插件所属的 Cordis 上下文。
 */
export function apply(ctx) {
	const store = new RuleStore();
	store.load();
	store.audit({ source: "lifecycle", event: "apply", mode: store.mode, rules: store.all().length });

	ctx.on(
		"approval/request",
		async (req, next) => {
			try {
				return await handle(ctx, store, req, next);
			} catch (error) {
				// 任何意外都 fail-closed：退回后续应答者（通常是人工 UI）。
				store.audit({ outcome: "error", tool: req?.toolName, error: message(error) });
				return next();
			}
		},
		{ prepend: true }
	);

	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.commands.register({
			name: "approvals",
			description: "管理自动审批规则与审查模式（Codex 风格自动审批）",
			input: { hint: "[mode|allow|deny|allow-here|rm|rules|log|help]" },
			handler: ({ agent, rawInput }) => runCommand(store, agent, rawInput)
		});
		store.audit({ source: "lifecycle", event: "command-registered", command: "approvals" });
	});
}

/**
 * 一条审批请求的完整裁决路径。
 * @param ctx - 插件上下文。
 * @param store - 规则存储。
 * @param req - 审批请求（toolName / callId / reason / displayReason / signal / agent）。
 * @param next - waterfal 的委托函数。
 * @returns 审批结果词表里的一个值。
 */
async function handle(ctx, store, req, next) {
	if (req?.signal?.aborted) return "cancelled";

	const parsed = parseApprovalReason(req?.reason);
	const sessionId = String(req?.agent?.id ?? "");
	const context = {
		toolName: String(req?.toolName ?? ""),
		mode: parsed.mode,
		justification: parsed.justification,
		sessionId
	};

	const byRule = decideByRules(store.all(), context);
	if (byRule.decision !== "none") {
		const outcome = byRule.decision === "deny" ? "rejected" : "allowed-once";
		store.bumpHit(byRule.rule.id);
		store.audit({
			source: "rule",
			ruleId: byRule.rule.id,
			decision: byRule.decision,
			outcome,
			tool: context.toolName,
			mode: context.mode ?? null,
			justification: context.justification,
			session: sessionId
		});
		return outcome;
	}

	const mode = store.mode;
	if (mode === "off" || mode === "rules") {
		store.audit({ source: "delegate", decision: "none", tool: context.toolName, mode: context.mode ?? null, session: sessionId });
		return next();
	}

	// 只有沙箱越界形状的请求才进模型审查。其它来源（例如内置 auto-review
	// 退回的 ask）不去二次审查，直接交给人工，避免审查叠加。
	if (parsed.kind !== "sandbox-escalation") {
		store.audit({ source: "delegate", decision: "not-escalation", tool: context.toolName, session: sessionId });
		return next();
	}

	const verdict = await review(ctx, req, parsed, mode);
	store.audit({
		source: "review",
		mode,
		risk: verdict.risk ?? null,
		decision: verdict.decision,
		reason: verdict.reason ?? null,
		tool: context.toolName,
		requestedMode: context.mode ?? null,
		justification: context.justification,
		session: sessionId,
		detail: verdict.detail ?? null
	});

	if (verdict.decision === "allow") return "allowed-once";
	if (verdict.decision === "deny") return "rejected";
	return next();
}

/**
 * 用当前会话的 provider/model 审查一条请求。
 *
 * 所有失败路径都返回 `{ decision: "ask" }`，由调用方退回人工。
 *
 * @param ctx - 插件上下文。
 * @param req - 审批请求。
 * @param parsed - 解析后的 reason。
 * @param mode - `auto` 或 `guardian`。
 * @returns `{ decision: "allow" | "ask" | "deny", risk?, reason?, detail? }`。
 */
async function review(ctx, req, parsed, mode) {
	const llm = ctx.get("llm");
	if (llm === undefined) return { decision: "ask", detail: "no llm service" };

	const header = safeCall(() => req.agent?.session?.requestHeader?.());
	const provider = header?.config?.provider;
	const model = header?.config?.model;
	if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0) {
		return { decision: "ask", detail: "no request-header route" };
	}

	let BlockAssembler;
	try {
		({ BlockAssembler } = await import("@deepseek-ai/dsh-llm"));
	} catch (error) {
		return { decision: "ask", detail: `llm import failed: ${message(error)}` };
	}

	const stream = llm.stream({
		provider,
		model,
		system: policyFor(mode),
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: reviewUserText({
							toolName: req.toolName,
							mode: parsed.mode,
							justification: parsed.justification,
							displayReason: req.displayReason ?? null
						})
					}
				]
			}
		],
		temperature: 0,
		...(req.signal === undefined ? {} : { signal: req.signal })
	});

	let text;
	try {
		text = await readText(stream, BlockAssembler);
	} catch (error) {
		return { decision: "ask", detail: `reviewer stream failed: ${message(error)}` };
	}

	try {
		return parseReviewDecision(text);
	} catch (error) {
		return { decision: "ask", detail: `reviewer output rejected: ${message(error)}` };
	}
}

/**
 * 消费审查者的流：零个或多个 reasoning 块 + 恰好一个文本块 + 终结事件。
 * @param stream - `ctx.llm.stream()` 返回的异步迭代器。
 * @param BlockAssembler - 来自 `@deepseek-ai/dsh-llm` 的块组装器。
 * @returns 最终文本块内容。
 * @throws 流结构不符合要求时。
 */
async function readText(stream, BlockAssembler) {
	const assembler = new BlockAssembler();
	let finished = false;
	for await (const chunk of stream) {
		if (finished) throw new Error("reviewer emitted data after its terminal finish");
		assembler.push(chunk);
		if (chunk.type === "finish") {
			finished = true;
			if (chunk.reason?.kind !== "stop") {
				throw new Error(`reviewer ended with ${chunk.reason?.kind ?? "unknown"}`);
			}
		}
	}
	if (!finished) throw new Error("reviewer emitted no terminal finish");
	const blocks = assembler.blocks();
	const final = blocks.at(-1);
	if (final?.type !== "text") throw new Error("reviewer must end with exactly one text block");
	if (blocks.slice(0, -1).some((block) => block.type !== "reasoning")) {
		throw new Error("reviewer may only emit reasoning blocks before its text block");
	}
	return final.text;
}

/** `/approvals` 命令实现。 */
function runCommand(store, agent, rawInput) {
	const line = String(rawInput ?? "").trim();
	const [sub, ...rest] = line.split(/\s+/);
	const argument = rest.join(" ").trim();
	const sessionId = String(agent?.id ?? "");

	switch (sub) {
		case "":
		case "status": {
			return ok(
				[
					`自动审批模式：${store.mode}`,
					`规则数：${store.all().length}（全局 ${store.all().filter((r) => r.scope !== "session").length} / 会话 ${store.all().filter((r) => r.scope === "session").length}）`,
					`当前会话：${sessionId || "(未知)"}`,
					`存储目录：${store.dir}`,
					"用 /approvals help 看子命令。"
				].join("\n")
			);
		}
		case "help": {
			return ok(
				[
					"/approvals                      查看状态",
					"/approvals mode off|rules|auto|guardian",
					"                                off=全部退回人工；rules=只按规则；",
					"                                auto=模型审查（平衡）；guardian=模型审查（严格）",
					"/approvals allow <正则>          全局放行：理由文本匹配即自动同意",
					"/approvals deny <正则>           全局拒绝：优先级高于 allow",
					"/approvals allow-here <正则>     只对当前会话生效的放行",
					"/approvals rm <id>              删除规则",
					"/approvals rules                列出规则",
					"/approvals log [n]              看最近 n 条审计（默认 10）"
				].join("\n")
			);
		}
		case "mode": {
			if (argument === "") return err("用法：/approvals mode off|rules|auto|guardian");
			if (!store.setMode(argument)) return err(`未知模式 "${argument}"（可选 off / rules / auto / guardian）`);
			return ok(`自动审批模式已切到 ${argument}`);
		}
		case "allow":
		case "deny":
		case "allow-here": {
			if (argument === "") return err(`用法：/approvals ${sub} <正则>`);
			if (!isValidRegex(argument)) return err(`不是合法正则：${argument}`);
			const decision = sub === "deny" ? "deny" : "allow";
			const rule = store.add({
				decision,
				match: argument,
				...(sub === "allow-here" ? { scope: "session", session: sessionId } : {})
			});
			return ok(
				`已添加${decision === "allow" ? "放行" : "拒绝"}规则 ${rule.id}（${rule.scope === "session" ? "仅本会话" : "全局"}）\nmatch=/${argument}/i`
			);
		}
		case "rm": {
			if (argument === "") return err("用法：/approvals rm <id>");
			return store.remove(argument) ? ok(`已删除规则 ${argument}`) : err(`没有 id 为 ${argument} 的规则`);
		}
		case "rules": {
			const rules = store.all();
			if (rules.length === 0) return ok("（没有规则）");
			return ok(
				rules
					.map((rule) => {
						const bits = [`${rule.id}`, rule.decision === "deny" ? "DENY " : "ALLOW", rule.scope === "session" ? "会话" : "全局"];
						if (rule.match !== undefined) bits.push(`match=/${rule.match}/i`);
						if (rule.mode !== undefined) bits.push(`mode=${rule.mode}`);
						if (rule.tool !== undefined) bits.push(`tool=/${rule.tool}/i`);
						bits.push(`命中 ${rule.hits ?? 0} 次`);
						return bits.join("  ");
					})
					.join("\n")
			);
		}
		case "log": {
			const count = Number.parseInt(argument, 10);
			const entries = store.tail(Number.isFinite(count) && count > 0 ? count : 10);
			if (entries.length === 0) return ok("（没有审计记录）");
			return ok(entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n"));
		}
		default:
			return err(`未知子命令 "${sub}"，用 /approvals help 查看用法`);
	}
}

/** 成功结果。 */
function ok(text) {
	return { kind: "success", text };
}

/** 失败结果。 */
function err(text) {
	return { kind: "error", text };
}

/** 正则合法性检查。 */
function isValidRegex(pattern) {
	try {
		new RegExp(pattern, "i");
		return true;
	} catch {
		return false;
	}
}

/** 调用可能不存在的可选链成员，异常统一转 undefined。 */
function safeCall(fn) {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

/** 取错误消息文本。 */
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
