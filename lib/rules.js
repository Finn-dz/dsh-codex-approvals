/**
 * 规则引擎 + 规则存储 + 审计日志。
 *
 * 这一层是纯逻辑，不 import 任何 DSH 包，因此可以直接用 node 单测。
 *
 * @module dsh-codex-approvals/rules
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 默认存储目录；可用环境变量覆盖（测试用）。 */
export function defaultStoreDir() {
	return process.env.CODEX_APPROVALS_DIR ?? path.join(os.homedir(), ".dsh", "codex-approvals");
}

/** 合法的审查模式。 */
export const MODES = ["off", "rules", "auto", "guardian"];

/**
 * 解析审批请求的 reason 文本。
 *
 * DSH 里唯一会发起审批的消费方是 `dsh-sandbox` 的 `approveEscalation()`，
 * 它固定产出 `escalate sandbox to <mode>: <justification>`（见
 * `@deepseek-ai/dsh-sandbox` 的 escalation 模块）。这里把这个固定形状解出来，
 * 让规则可以按「目标模式 + 理由文本」匹配。
 *
 * 非该形状的 reason（例如内置 auto-review 退回的 ask）归为 `other`，
 * 此时 justification 就是整段 reason，规则仍可匹配，但不会匹配 mode。
 *
 * @param reason - 审批请求携带的 reason 原文。
 * @returns 解析结果：形状、目标沙箱模式、理由文本。
 */
export function parseApprovalReason(reason) {
	const text = typeof reason === "string" ? reason : "";
	const match = /^escalate sandbox to ([^:]+): ([\s\S]*)$/.exec(text);
	if (match) {
		return {
			kind: "sandbox-escalation",
			mode: match[1].trim(),
			justification: match[2]
		};
	}
	return {
		kind: "other",
		mode: undefined,
		justification: text
	};
}

/** 把文本规范化为可稳定匹配的形式：折叠空白、转小写。 */
export function normalizeText(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 判断一条规则是否命中给定的调用上下文。
 *
 * 规则里的每个条件是「如果写了就必须全部满足」：
 * - `tool`：对 toolName 的正则
 * - `mode`：目标沙箱模式精确相等
 * - `match`：对理由文本的正则（大小写不敏感）
 * - `scope === "session"`：只对创建它的会话生效
 *
 * 一条什么条件都没写的规则视为不命中（避免"空规则放行一切"）。
 *
 * @param rule - 规则对象。
 * @param context - 待判定的调用上下文。
 * @returns 是否命中。
 */
export function ruleMatches(rule, context) {
	if (!rule || typeof rule !== "object") return false;
	if (rule.scope === "session" && rule.session !== context.sessionId) return false;

	let hasCondition = false;

	if (typeof rule.tool === "string" && rule.tool.length > 0) {
		hasCondition = true;
		if (!safeTest(rule.tool, context.toolName)) return false;
	}
	if (typeof rule.mode === "string" && rule.mode.length > 0) {
		hasCondition = true;
		if (rule.mode !== context.mode) return false;
	}
	if (typeof rule.match === "string" && rule.match.length > 0) {
		hasCondition = true;
		if (!safeTest(rule.match, context.justification)) return false;
	}

	return hasCondition;
}

/** 正则测试，非法正则一律视为不命中（不抛异常）。 */
function safeTest(pattern, value) {
	try {
		return new RegExp(pattern, "i").test(String(value ?? ""));
	} catch {
		return false;
	}
}

/**
 * 按规则给出裁决。
 *
 * 优先级：deny 先于 allow —— 这是有意的 fail-closed 设计，
 * 只要有一条 deny 命中，就不会被另一条 allow 救回来。
 *
 * @param rules - 规则数组。
 * @param context - 待判定的调用上下文。
 * @returns `{ decision: "deny" | "allow" | "none", rule? }`。
 */
export function decideByRules(rules, context) {
	const list = Array.isArray(rules) ? rules : [];
	const matched = list.filter((rule) => ruleMatches(rule, context));

	const deny = matched.find((rule) => rule.decision === "deny");
	if (deny !== undefined) return { decision: "deny", rule: deny };

	const allow = matched.find((rule) => rule.decision === "allow");
	if (allow !== undefined) return { decision: "allow", rule: allow };

	return { decision: "none" };
}

/** 生成一个短规则 id。 */
export function newRuleId() {
	return Math.random().toString(36).slice(2, 8);
}

/**
 * 规则存储：`rules.json`（规则 + 设置 + 命中统计）与 `audit.jsonl`（审计）。
 *
 * 写盘用「临时文件 + rename」，避免进程被杀时留下半截 JSON。
 */
export class RuleStore {
	/** @param dir - 存储目录，缺省用 {@link defaultStoreDir}。 */
	constructor(dir = defaultStoreDir()) {
		this.dir = dir;
		this.rulesPath = path.join(dir, "rules.json");
		this.auditPath = path.join(dir, "audit.jsonl");
		this.state = { version: 1, mode: "rules", rules: [] };
	}

	/** 从磁盘读取；文件不存在或损坏时回落到默认状态（不抛）。 */
	load() {
		try {
			const raw = fs.readFileSync(this.rulesPath, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed !== null && typeof parsed === "object") {
				this.state = {
					version: 1,
					mode: MODES.includes(parsed.mode) ? parsed.mode : "rules",
					rules: Array.isArray(parsed.rules) ? parsed.rules : []
				};
			}
		} catch {
			// 首次运行或文件损坏：保留默认状态。
		}
		return this.state;
	}

	/** 原子写回磁盘。 */
	save() {
		fs.mkdirSync(this.dir, { recursive: true });
		const tmp = `${this.rulesPath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
		fs.renameSync(tmp, this.rulesPath);
	}

	/** 当前所有规则。 */
	all() {
		return this.state.rules;
	}

	/** 当前审查模式。 */
	get mode() {
		return this.state.mode;
	}

	/** 切换审查模式；非法值返回 false。 */
	setMode(mode) {
		if (!MODES.includes(mode)) return false;
		this.state.mode = mode;
		this.save();
		return true;
	}

	/**
	 * 追加一条规则。
	 * @param spec - `{ decision, match?, tool?, mode?, scope?, session?, note? }`。
	 * @returns 新规则。
	 */
	add(spec) {
		const rule = {
			id: newRuleId(),
			decision: spec.decision === "deny" ? "deny" : "allow",
			scope: spec.scope === "session" ? "session" : "global",
			createdAt: new Date().toISOString(),
			hits: 0
		};
		if (spec.scope === "session" && spec.session !== undefined) rule.session = spec.session;
		if (typeof spec.match === "string" && spec.match.length > 0) rule.match = spec.match;
		if (typeof spec.tool === "string" && spec.tool.length > 0) rule.tool = spec.tool;
		if (typeof spec.mode === "string" && spec.mode.length > 0) rule.mode = spec.mode;
		if (typeof spec.note === "string" && spec.note.length > 0) rule.note = spec.note;

		this.state.rules.push(rule);
		this.save();
		return rule;
	}

	/** 按 id 删除规则；返回是否删掉了一条。 */
	remove(id) {
		const before = this.state.rules.length;
		this.state.rules = this.state.rules.filter((rule) => rule.id !== id);
		const removed = this.state.rules.length !== before;
		if (removed) this.save();
		return removed;
	}

	/** 给命中的规则累加计数（不落盘，避免每次命中都写文件）。 */
	bumpHit(id) {
		const rule = this.state.rules.find((item) => item.id === id);
		if (rule !== undefined) rule.hits = (rule.hits ?? 0) + 1;
	}

	/** 追加一条审计记录。写失败不影响审批结果。 */
	audit(entry) {
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			fs.appendFileSync(this.auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
		} catch {
			// 审计是尽力而为，绝不因为写日志失败而改变审批裁决。
		}
	}

	/** 读取最近 n 条审计记录（从旧到新）。 */
	tail(count = 20) {
		try {
			const lines = fs.readFileSync(this.auditPath, "utf8").split("\n").filter((line) => line.length > 0);
			return lines.slice(-count).map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return { at: "?", outcome: "unparsable" };
				}
			});
		} catch {
			return [];
		}
	}
}
