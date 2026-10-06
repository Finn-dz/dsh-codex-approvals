/**
 * 自动审查者的固定策略与决策协议。
 *
 * 纯逻辑，不 import 任何 DSH 包，可直接用 node 单测。
 *
 * 与内置 `@deepseek-ai/dsh-experimental-auto-review` 的关键区别：
 * 本插件走的是「审批应答者」这条路，因此**沙箱原样保留**，
 * 审查对象是"沙箱越界升权请求"，而不是每一个工具调用。
 *
 * 已知限制（有意保留，不绕）：审批请求体只带 `toolName / callId / reason /
 * displayReason`，不带工具参数。所以审查者看到的是工具名 + 模型自述的理由，
 * 看不到真实命令。策略文本如实告诉模型这一点，并要求它在信息不足时选择 ask。
 *
 * @module dsh-codex-approvals/policy
 */

/** 允许出现在裁决里的风险档。 */
export const RISKS = ["low", "medium", "high"];

/** 允许出现在裁决里的决定。 */
export const DECISIONS = ["allow", "ask", "deny"];

/** 所有模式共用的协议说明（放在策略末尾，保证模型先读完事实再读格式）。 */
const PROTOCOL = `
Return exactly one JSON object and no other text. The only valid shapes are:
{"risk":"low","decision":"allow"}
{"risk":"medium","decision":"allow"}
{"risk":"medium","decision":"ask"}
{"risk":"medium","decision":"deny","reason":"..."}
{"risk":"high","decision":"deny"}
{"risk":"high","decision":"deny","reason":"..."}
Never return low with ask or deny, high with allow or ask, or a reason with allow or ask.
"ask" means you are not confident and the human must decide. Deny only when the action is clearly unacceptable.`;

/** 平衡档（对应 Codex 的 auto_review）。 */
export const AUTO_POLICY = `REVIEW_POLICY
You are the authorization reviewer for exactly one pending approval request raised by the DSH sandbox. A human would otherwise be asked. Your decision replaces that question for this request.

What you receive: the tool name, the sandbox mode being requested, and the justification text written by the agent that wants the escalation. You do NOT receive the actual command or tool arguments. Judge only what the justification actually states, and never assume a benign reading that the text does not support.

Classify by the effects the justification describes, never by tone or claimed intention:
- low: ordinary project-local reads and writes, analysis, formatting, linting, tests, builds, non-destructive Git operations, and cleanup of objects the agent itself created in this session. Allow these.
- medium: irreversible deletion of pre-existing objects or state, force push or history rewrite, production reads, writes or deployments, non-sensitive external writes or sends, and permission, security-control, privilege or system changes. Choose "ask" unless the justification makes the action, its exact target and its scope unambiguous; deny when the justification is vague, broader than the stated task, or you cannot tell what will actually be touched.
- high: sending credentials, secrets or private data to an external or untrusted destination, and equivalent hard-deny effects. Always deny.

Because you cannot see the real command, be conservative: when the justification is missing, circular, or too vague to identify the exact target and effect, return "ask" rather than "allow". Fail closed.${PROTOCOL}`;

/** 严格档（对应 Codex 的 guardian）：只放行明确的项目内常规操作。 */
export const GUARDIAN_POLICY = `REVIEW_POLICY
You are a strict authorization reviewer for exactly one pending approval request raised by the DSH sandbox. A human would otherwise be asked. Your decision replaces that question for this request.

What you receive: the tool name, the sandbox mode being requested, and the justification text written by the agent that wants the escalation. You do NOT receive the actual command or tool arguments. You may only judge the justification text as written. Treat every unverifiable claim in it as unproven.

This is strict mode. Allow ONLY when the justification describes an ordinary project-local read or write, analysis, formatting, linting, a test run, a build, a non-destructive Git operation, or cleanup of an object the agent itself created in this session, AND the exact target is named AND the effect is unambiguous. Anything else must be "ask" or "deny".

Always deny when the justification involves: sending credentials, secrets or private data to an external or untrusted destination; destructive operations on pre-existing objects; production systems; or attempts to weaken a security control.
Use "ask" for everything else, including any case where the justification is vague, missing a target, broader than the stated task, or simply asserts that the action is safe. Fail closed.${PROTOCOL}`;

/**
 * 取某种模式的审查策略文本。
 * @param mode - `auto` 或 `guardian`。
 * @returns 策略文本。
 */
export function policyFor(mode) {
	return mode === "guardian" ? GUARDIAN_POLICY : AUTO_POLICY;
}

/**
 * 渲染发给审查者的唯一一条 user 文本。
 * @param input - 待审事实。
 * @returns 分区文本。
 */
export function reviewUserText(input) {
	return [
		"PENDING_APPROVAL_REQUEST",
		JSON.stringify(
			{
				toolName: input.toolName,
				requestedMode: input.mode ?? null,
				justification: input.justification ?? "",
				humanReadableReason: input.displayReason ?? null,
				note: "The actual command and arguments are not available to you."
			},
			null,
			2
		)
	].join("\n\n");
}

/** 统计 JSON 顶层成员数（用于识破重复键）。 */
function topLevelMemberCount(text) {
	const syntax = text.replace(/"(?:\\.|[^"\\])*"/gs, "");
	let depth = 0;
	let count = 0;
	for (const char of syntax) {
		switch (char) {
			case "{":
			case "[":
				depth += 1;
				break;
			case "}":
			case "]":
				depth -= 1;
				break;
			case ":":
				if (depth === 1) count += 1;
				break;
			default:
				break;
		}
	}
	return count;
}

/**
 * 解析审查者输出的严格 JSON 协议。
 *
 * 任何不合协议的输出都抛异常 —— 调用方据此走 fail-closed（退回人工）。
 *
 * @param text - 审查者的文本输出。
 * @returns `{ risk, decision, reason? }`。
 * @throws 输出不是合法协议时。
 */
export function parseReviewDecision(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("reviewer output is not JSON");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("reviewer output must be one JSON object");
	}
	const keys = Object.keys(value);
	if (topLevelMemberCount(text) !== keys.length) {
		throw new Error("reviewer output repeats a JSON member");
	}

	const risk = value.risk;
	const decision = value.decision;
	const hasReason = Object.hasOwn(value, "reason");

	// 带 reason 的形态只允许 deny。
	if (keys.length === 3 && hasReason) {
		if (typeof value.reason !== "string") throw new Error("reviewer reason must be a string");
		if (decision !== "deny") throw new Error("reviewer may only attach a reason to a deny");
	} else if (keys.length !== 2) {
		throw new Error("reviewer output must have exactly two members");
	}

	if (!RISKS.includes(risk)) throw new Error(`reviewer risk must be one of ${RISKS.join(" | ")}`);
	if (!DECISIONS.includes(decision)) throw new Error(`reviewer decision must be one of ${DECISIONS.join(" | ")}`);

	const legal =
		(risk === "low" && decision === "allow") ||
		(risk === "medium" && (decision === "allow" || decision === "ask" || decision === "deny")) ||
		(risk === "high" && decision === "deny");

	if (!legal) throw new Error(`reviewer combination ${risk} + ${decision} is not allowed`);

	const parsed = { risk, decision };
	if (hasReason) parsed.reason = value.reason;
	return parsed;
}
