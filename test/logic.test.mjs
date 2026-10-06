/**
 * 纯 node 单测：不依赖 DSH 运行时。
 *
 * 运行：
 *   node --test test/logic.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuleStore, decideByRules, newRuleId, normalizeText, parseApprovalReason, ruleMatches } from "../lib/rules.js";
import { RISKS, parseReviewDecision, policyFor, reviewUserText } from "../lib/policy.js";
import { apply } from "../lib/index.js";

/** 建一个临时存储目录。 */
function tempStore() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-approvals-test-"));
	return new RuleStore(dir);
}

// ---------------------------------------------------------------------------
// reason 解析
// ---------------------------------------------------------------------------

test("parseApprovalReason 解出沙箱越界升权的固定形状", () => {
	const parsed = parseApprovalReason('escalate sandbox to danger-full-access: 需要把构建产物写到 ~/out');
	assert.equal(parsed.kind, "sandbox-escalation");
	assert.equal(parsed.mode, "danger-full-access");
	assert.equal(parsed.justification, "需要把构建产物写到 ~/out");
});

test("parseApprovalReason 对非越界 reason 归为 other，且 mode 为 undefined", () => {
	const parsed = parseApprovalReason('Auto review denied tool "bash"');
	assert.equal(parsed.kind, "other");
	assert.equal(parsed.mode, undefined);
	assert.equal(parsed.justification, 'Auto review denied tool "bash"');
});

test("parseApprovalReason 容忍空值", () => {
	for (const value of [undefined, null, "", 42]) {
		const parsed = parseApprovalReason(value);
		assert.equal(parsed.kind, "other");
		assert.equal(parsed.justification, "");
	}
});

test("normalizeText 折叠空白并转小写", () => {
	assert.equal(normalizeText("  Git   PUSH  main "), "git push main");
});

// ---------------------------------------------------------------------------
// 规则匹配
// ---------------------------------------------------------------------------

const baseContext = {
	toolName: "bash",
	mode: "danger-full-access",
	justification: "git push origin main",
	sessionId: "session-1"
};

test("ruleMatches：match 正则命中理由文本，大小写不敏感", () => {
	assert.equal(ruleMatches({ match: "git push", decision: "allow" }, baseContext), true);
	assert.equal(ruleMatches({ match: "GIT PUSH", decision: "allow" }, baseContext), true);
	assert.equal(ruleMatches({ match: "rm -rf /", decision: "allow" }, baseContext), false);
});

test("ruleMatches：mode 必须精确相等", () => {
	assert.equal(ruleMatches({ mode: "danger-full-access", decision: "allow" }, baseContext), true);
	assert.equal(ruleMatches({ mode: "workspace-write", decision: "allow" }, baseContext), false);
});

test("ruleMatches：tool 正则可选", () => {
	assert.equal(ruleMatches({ tool: "^bash$", match: "git", decision: "allow" }, baseContext), true);
	assert.equal(ruleMatches({ tool: "^read$", match: "git", decision: "allow" }, baseContext), false);
});

test("ruleMatches：会话作用域只对本会话生效", () => {
	const rule = { scope: "session", session: "session-1", match: "git", decision: "allow" };
	assert.equal(ruleMatches(rule, baseContext), true);
	assert.equal(ruleMatches(rule, { ...baseContext, sessionId: "session-2" }), false);
});

test("ruleMatches：无条件规则不命中（防止空规则放行一切）", () => {
	assert.equal(ruleMatches({ decision: "allow" }, baseContext), false);
	assert.equal(ruleMatches({ scope: "global", decision: "allow" }, baseContext), false);
});

test("ruleMatches：非法正则不命中且不抛", () => {
	assert.equal(ruleMatches({ match: "([unclosed", decision: "allow" }, baseContext), false);
});

test("decideByRules：deny 优先于 allow", () => {
	const rules = [
		{ id: "a", decision: "allow", match: "git" },
		{ id: "b", decision: "deny", match: "push" }
	];
	const verdict = decideByRules(rules, baseContext);
	assert.equal(verdict.decision, "deny");
	assert.equal(verdict.rule.id, "b");
});

test("decideByRules：无命中返回 none", () => {
	assert.equal(decideByRules([{ id: "a", decision: "allow", match: "nope" }], baseContext).decision, "none");
	assert.equal(decideByRules([], baseContext).decision, "none");
	assert.equal(decideByRules(undefined, baseContext).decision, "none");
});

// ---------------------------------------------------------------------------
// 规则存储
// ---------------------------------------------------------------------------

test("RuleStore：增删改保存与重载", () => {
	const store = tempStore();
	assert.equal(store.mode, "rules");

	const rule = store.add({ decision: "allow", match: "git push" });
	assert.equal(store.all().length, 1);
	assert.equal(rule.hits, 0);

	store.bumpHit(rule.id);
	assert.equal(store.all()[0].hits, 1);

	assert.equal(store.setMode("auto"), true);
	assert.equal(store.setMode("bogus"), false);

	const reloaded = new RuleStore(store.dir);
	reloaded.load();
	assert.equal(reloaded.mode, "auto");
	assert.equal(reloaded.all().length, 1);
	assert.equal(reloaded.all()[0].match, "git push");

	assert.equal(store.remove(rule.id), true);
	assert.equal(store.remove(rule.id), false);
	assert.equal(store.all().length, 0);
});

test("RuleStore：会话作用域规则带 session", () => {
	const store = tempStore();
	const rule = store.add({ decision: "allow", match: "x", scope: "session", session: "s-9" });
	assert.equal(rule.scope, "session");
	assert.equal(rule.session, "s-9");
});

test("RuleStore：损坏的 rules.json 回落到默认状态而不抛", () => {
	const store = tempStore();
	fs.mkdirSync(store.dir, { recursive: true });
	fs.writeFileSync(store.rulesPath, "{ not json");
	const reloaded = new RuleStore(store.dir);
	reloaded.load();
	assert.equal(reloaded.mode, "rules");
	assert.deepEqual(reloaded.all(), []);
});

test("RuleStore：审计写入与读取", () => {
	const store = tempStore();
	assert.deepEqual(store.tail(5), []);
	store.audit({ outcome: "allowed-once", tool: "bash" });
	store.audit({ outcome: "rejected", tool: "bash" });
	const tail = store.tail(10);
	assert.equal(tail.length, 2);
	assert.equal(tail[0].outcome, "allowed-once");
	assert.equal(tail[1].outcome, "rejected");
	assert.ok(typeof tail[0].at === "string");
});

test("newRuleId 返回 6 位短 id", () => {
	assert.match(newRuleId(), /^[a-z0-9]{6}$/);
});

// ---------------------------------------------------------------------------
// 审查协议
// ---------------------------------------------------------------------------

test("parseReviewDecision：接受全部合法形态", () => {
	assert.deepEqual(parseReviewDecision('{"risk":"low","decision":"allow"}'), { risk: "low", decision: "allow" });
	assert.deepEqual(parseReviewDecision('{"risk":"medium","decision":"allow"}'), { risk: "medium", decision: "allow" });
	assert.deepEqual(parseReviewDecision('{"risk":"medium","decision":"ask"}'), { risk: "medium", decision: "ask" });
	assert.deepEqual(parseReviewDecision('{"risk":"medium","decision":"deny"}'), { risk: "medium", decision: "deny" });
	assert.deepEqual(parseReviewDecision('{"risk":"medium","decision":"deny","reason":"越界了"}'), {
		risk: "medium",
		decision: "deny",
		reason: "越界了"
	});
	assert.deepEqual(parseReviewDecision('{"risk":"high","decision":"deny"}'), { risk: "high", decision: "deny" });
});

test("parseReviewDecision：拒绝非法组合", () => {
	const bad = [
		'{"risk":"low","decision":"deny"}',
		'{"risk":"low","decision":"ask"}',
		'{"risk":"high","decision":"allow"}',
		'{"risk":"high","decision":"ask"}',
		'{"risk":"medium","decision":"allow","reason":"x"}',
		'{"risk":"medium","decision":"ask","reason":"x"}',
		'{"risk":"low","decision":"allow","reason":"x"}',
		'{"risk":"urgent","decision":"allow"}',
		'{"risk":"low","decision":"maybe"}',
		'{"risk":"low","decision":"allow","extra":1}',
		'{"risk":"low"}',
		'{"risk":"low","decision":"allow","reason":5}'
	];
	for (const text of bad) {
		assert.throws(() => parseReviewDecision(text), undefined, `应当拒绝：${text}`);
	}
});

test("parseReviewDecision：拒绝重复键（顶层成员数校验）", () => {
	assert.throws(() => parseReviewDecision('{"risk":"low","decision":"allow","risk":"high"}'));
});

test("parseReviewDecision：非 JSON 与非法根类型都抛", () => {
	for (const text of ["", "not json", "[]", "null", '"str"', "42"]) {
		assert.throws(() => parseReviewDecision(text), undefined, `应当拒绝：${text}`);
	}
});

test("parseReviewDecision：容忍 JSON 之外的空白", () => {
	assert.deepEqual(parseReviewDecision('\n  {"risk":"low","decision":"allow"}  \n'), { risk: "low", decision: "allow" });
});

test("policyFor：auto 与 guardian 是两份不同策略，且都含协议", () => {
	const auto = policyFor("auto");
	const guardian = policyFor("guardian");
	assert.notEqual(auto, guardian);
	assert.match(auto, /REVIEW_POLICY/);
	assert.match(guardian, /strict mode/i);
	assert.match(auto, /"risk":"low","decision":"allow"/);
	assert.match(guardian, /"risk":"high","decision":"deny"/);
	assert.equal(policyFor("anything-else"), auto);
});

test("RISKS 只含三档", () => {
	assert.deepEqual(RISKS, ["low", "medium", "high"]);
});

test("reviewUserText：如实声明看不到真实命令", () => {
	const text = reviewUserText({ toolName: "bash", mode: "danger-full-access", justification: "x" });
	assert.match(text, /PENDING_APPROVAL_REQUEST/);
	assert.match(text, /The actual command and arguments are not available to you/);
	assert.match(text, /danger-full-access/);
});

// ---------------------------------------------------------------------------
// 插件装配（用假 ctx）
// ---------------------------------------------------------------------------

/** 用假 ctx 装配插件，返回捕获到的监听器与命令定义。 */
function mount() {
	// 每个装配实例用一个独立临时目录，避免用例之间规则互相泄漏，
	// 也避免污染真实的 ~/.dsh/codex-approvals。
	process.env.CODEX_APPROVALS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-approvals-mount-"));
	const captured = {};
	const ctx = {
		on(name, fn) {
			captured[name] = fn;
			return () => {};
		},
		inject(deps, callback) {
			callback({
				commands: {
					register(definition) {
						captured.command = definition;
						return () => {};
					}
				}
			});
		},
		get() {
			return undefined;
		}
	};
	apply(ctx);
	return captured;
}

test("装配：注册了 approval/request 监听器与 approvals 命令", () => {
	const captured = mount();
	assert.equal(typeof captured["approval/request"], "function");
	assert.equal(captured.command.name, "approvals");
	assert.equal(typeof captured.command.handler, "function");
});

test("应答者：规则放行时返回 allowed-once，且不调用 next", async () => {
	const captured = mount();
	const handler = captured["approval/request"];
	// 先通过命令加一条全局放行规则。
	captured.command.handler({ agent: { id: "s1" }, rawInput: "allow git push" });

	let nextCalled = false;
	const outcome = await handler(
		{ toolName: "bash", reason: "escalate sandbox to danger-full-access: git push origin main", agent: { id: "s1" } },
		async () => {
			nextCalled = true;
			return "unavailable";
		}
	);
	assert.equal(outcome, "allowed-once");
	assert.equal(nextCalled, false);
});

test("应答者：deny 规则优先，返回 rejected", async () => {
	const captured = mount();
	const handler = captured["approval/request"];
	captured.command.handler({ agent: { id: "s1" }, rawInput: "allow .*" });
	captured.command.handler({ agent: { id: "s1" }, rawInput: "deny rm -rf" });

	const outcome = await handler(
		{ toolName: "bash", reason: "escalate sandbox to danger-full-access: rm -rf /tmp/x", agent: { id: "s1" } },
		async () => "unavailable"
	);
	assert.equal(outcome, "rejected");
});

test("应答者：默认 rules 模式下未命中就退回人工", async () => {
	const captured = mount();
	const handler = captured["approval/request"];
	const outcome = await handler(
		{ toolName: "bash", reason: "escalate sandbox to danger-full-access: something else", agent: { id: "s1" } },
		async () => "unavailable"
	);
	assert.equal(outcome, "unavailable");
});

test("应答者：已中止的信号直接返回 cancelled", async () => {
	const captured = mount();
	const controller = new AbortController();
	controller.abort();
	const outcome = await captured["approval/request"](
		{ toolName: "bash", reason: "x", agent: { id: "s1" }, signal: controller.signal },
		async () => "unavailable"
	);
	assert.equal(outcome, "cancelled");
});

test("应答者：auto 模式下非越界形状的请求不去二次审查，直接退回人工", async () => {
	const captured = mount();
	captured.command.handler({ agent: { id: "s1" }, rawInput: "mode auto" });
	const outcome = await captured["approval/request"](
		{ toolName: "bash", reason: 'Auto review denied tool "bash"', agent: { id: "s1" } },
		async () => "unavailable"
	);
	assert.equal(outcome, "unavailable");
});

test("应答者：auto 模式但拿不到 llm 服务时 fail-closed 退回人工", async () => {
	const captured = mount();
	captured.command.handler({ agent: { id: "s1" }, rawInput: "mode auto" });
	const outcome = await captured["approval/request"](
		{ toolName: "bash", reason: "escalate sandbox to danger-full-access: git push", agent: { id: "s1" } },
		async () => "unavailable"
	);
	assert.equal(outcome, "unavailable");
});

test("命令：非法输入给出 error 结果而不是抛异常", () => {
	const captured = mount();
	const { handler } = captured.command;
	const agent = { id: "s1" };

	assert.equal(handler({ agent, rawInput: "" }).kind, "success");
	assert.equal(handler({ agent, rawInput: "help" }).kind, "success");
	assert.equal(handler({ agent, rawInput: "mode bogus" }).kind, "error");
	assert.equal(handler({ agent, rawInput: "mode" }).kind, "error");
	assert.equal(handler({ agent, rawInput: "allow" }).kind, "error");
	assert.equal(handler({ agent, rawInput: "allow ([bad" }).kind, "error");
	assert.equal(handler({ agent, rawInput: "rm nonexistent" }).kind, "error");
	assert.equal(handler({ agent, rawInput: "nonsense" }).kind, "error");
	assert.equal(handler({ agent, rawInput: "mode guardian" }).kind, "success");
	assert.equal(handler({ agent, rawInput: "rules" }).kind, "success");
	assert.equal(handler({ agent, rawInput: "log 5" }).kind, "success");
});
