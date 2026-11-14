"use strict";
/*
 * 可信动作层单测(v1.8.0)
 * 全程 mock util.callTool, 不碰真浏览器、不发 native messaging。
 * 覆盖方案文档里承诺的每一条契约:
 *   - known-set 拒绝未观察的 ref, 且拒绝时绝不派发
 *   - DOCUMENT_CHANGED / OBSCURED / DISABLED 各有明确 stale 值
 *   - 超时 -> dispatched:"unknown" 且 retryable:false, 派发只发生一次
 *   - verdict 三态: 强信号 changed / 弱信号+页面在动 unattributable / 弱信号+页面静止 changed
 *   - postcondition 逐条 met/unmet
 *   - type 先聚焦点击再键入
 */
const test = require("node:test");
const assert = require("node:assert");
const util = require("../lib/util");
const action = require("../lib/action");

const TAB = 77;
let calls = [];

function reply(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function page(obj) {
  return reply({ success: true, tabId: TAB, result: obj });
}

/*
 * 装 mock: impl.resolve() / impl.settle() / impl.observe() 提供三段脚本各自的返回值。
 * dispatch 决定 chrome_computer 的反应('ok' | 'timeout' | 'error')。
 */
function mock(impl) {
  calls = [];
  const dispatch = impl.dispatch || "ok";
  util.callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "chrome_computer") {
      if (impl.computer) return reply(impl.computer(args));
      if (dispatch === "timeout") throw new Error("tool call timed out after 30000ms: chrome_computer");
      if (dispatch === "error") return reply({ success: false, error: "click failed" });
      return reply({ success: true, action: args.action, trusted: true, transport: "cdp", withheld: false });
    }
    if (name !== "chrome_javascript") throw new Error("unexpected tool: " + name);
    const code = args.code || "";
    if (code.indexOf("var LIMIT =") >= 0) return page(impl.settle ? impl.settle() : { verdict: "none", checks: [] });
    if (code.indexOf("var REF =") >= 0) return page(impl.resolve ? impl.resolve() : {});
    if (code.indexOf("var SEL =") >= 0) return page(impl.observe ? impl.observe() : {});
    throw new Error("unrecognized injected script");
  };
}

function resolveOk(over) {
  return Object.assign({
    stale: null,
    tok: "p1a.r",
    quiet: 0,
    target: { ref: "p1a.r3", tag: "button", role: "button", name: "搜索", cx: 420, cy: 310, hit: "self", in_view: true, rect: { x: 400, y: 295 } },
    before: { uh: 111, path: "/list", title: "列表", mut: 10, focus: null, ready: "complete" },
    base: { value: null, checked: null, disabled: false },
  }, over || {});
}

const CHANGED = { verdict: "changed", signal: "url_changed", elapsed_ms: 320, checks: [], alive: true };
const CALLS_TO_TOOL = (n) => calls.filter((c) => c.name === n).length;

// ------------------------------------------------------------------ observe
test("observe: 返回 page_token 与元素清单, ref 也带 pageToken 前缀", async () => {
  mock({
    observe: () => ({
      tok: "p1a.r",
      state: { path: "/list", title: "订单列表" },
      scanned: 12,
      shown: 2,
      truncated: true,
      elements: [
        { ref: "p1a.r1", tag: "input", role: "textbox", name: "搜索框", hit: "self", in_view: true, disabled: false, rect: { x: 10, y: 20, cx: 60, cy: 34 } },
        { ref: "p1a.r2", tag: "button", role: "button", name: "查询", hit: "self", in_view: true, disabled: false, rect: { x: 90, y: 20, cx: 110, cy: 34 } },
      ],
    }),
  });
  const r = await action.observe({ tabId: TAB });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tab_id, TAB);
  assert.strictEqual(r.page_token, "p1a.r");
  assert.strictEqual(r.shown, 2);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.elements.every((e) => e.ref.indexOf("p1a.r") === 0), "ref 必须以 pageToken 为前缀");
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0, "observe 不应派发任何输入");
});

// ------------------------------------------------------------- known-set
test("known-set: 未 observe 过的 ref 被拒绝, 且浏览器一个输入都没收到", async () => {
  mock({ resolve: () => ({ stale: "REF_NOT_PRESENTED", tok: "p1a.r", why: "该 ref 不在本页观察集合里" }) });
  const r = await action.click({ ref: "p1a.r999" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stale, "REF_NOT_PRESENTED");
  assert.strictEqual(r.dispatched, false);
  assert.match(r.stale_reason, /观察集合/);
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0, "门禁拒绝后绝不派发");
});

test("DOCUMENT_CHANGED: 页面换文档后旧 ref 明确失效, 原因可读", async () => {
  mock({ resolve: () => ({ stale: "DOCUMENT_CHANGED", tok: "p9z.q", why: "页面已重新加载或更换文档" }) });
  const r = await action.click({ ref: "p1a.r3", page_token: "p1a.r" });
  assert.strictEqual(r.stale, "DOCUMENT_CHANGED");
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0);
});

test("OBSCURED / DISABLED: 遮挡与禁用分别报错, 并能重试判定区分", async () => {
  mock({ resolve: () => ({ stale: "OBSCURED", tok: "p1a.r", hit: "overlay:div.mask", why: "目标被其他元素遮挡" }) });
  const a = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(a.stale, "OBSCURED");
  assert.strictEqual(a.hit, "overlay:div.mask");
  assert.strictEqual(a.retryable, true, "遮挡属于环境问题, 可重试");

  mock({ resolve: () => ({ stale: "DISABLED", tok: "p1a.r", hit: "self", why: "元素处于禁用态" }) });
  const b = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(b.stale, "DISABLED");
  assert.strictEqual(b.retryable, false, "禁用是确定性拒绝, 重试无意义");
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0);
});

// ------------------------------------------------------------- 超时不重试
test("超时: dispatched=unknown, retryable=false, 且只派发一次(绝不双发)", async () => {
  mock({ resolve: () => resolveOk(), dispatch: "timeout" });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.dispatched, "unknown");
  assert.strictEqual(r.retryable, false);
  assert.match(r.note, /双发/);
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 1, "超时后严禁重新派发");
  assert.strictEqual(CALLS_TO_TOOL("chrome_javascript"), 1, "超时后也不该再跑 settle");
});

test("派发失败(非超时): dispatched=false 且允许重试", async () => {
  mock({ resolve: () => resolveOk(), dispatch: "error" });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.retryable, true);
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 1);
});

// ------------------------------------------------------------- verdict 三态
test("verdict: 强信号(URL 变化) -> changed", async () => {
  mock({ resolve: () => resolveOk(), settle: () => CHANGED });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.effect.verdict, "changed");
  assert.ok(r.effect.signals.some((s) => s.indexOf("url_changed") >= 0));
  assert.strictEqual(r.reached_target, null, "无法证明输入到达时必须为 null, 不假装 true");
  assert.strictEqual(r.input_kind, "trusted", "扩展回报 trusted 时才标 trusted");
});

test("旧扩展不回报 trusted -> input_kind 如实降级为 synthetic, 不冒充真输入", async () => {
  mock({
    resolve: () => resolveOk(),
    settle: () => CHANGED,
    computer: (args) => ({ success: true, action: args.action }), // 老版本扩展的回包, 没有 trusted 字段
  });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.input_kind, "synthetic");
});

// ------------------------------------------------------------- 阶段 C: withheld
test("withheld: press 后目标变了 -> 扣发 release, 判 none 且不跑 settle", async () => {
  mock({
    resolve: () => resolveOk(),
    settle: () => CHANGED,
    computer: () => ({
      success: true, action: "left_click", transport: "cdp", trusted: true,
      withheld: true, target_before: "BUTTON#go", target_after: "DIV.toast<BUTTON#go",
    }),
  });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.withheld, true);
  assert.strictEqual(r.effect.verdict, "none");
  assert.strictEqual(r.retryable, true);
  assert.deepStrictEqual(r.swapped, { before: "BUTTON#go", after: "DIV.toast<BUTTON#go" });
  assert.match(r.note, /没有激活任何元素/);
  assert.strictEqual(CALLS_TO_TOOL("chrome_javascript"), 1, "扣发后不该再跑 settle");
});

test("type: 聚焦点击被扣发 -> 停止键入, 文字不会打到别处", async () => {
  mock({
    resolve: () => resolveOk({ target: { ref: "p1a.r9", tag: "input", role: "textbox", name: "搜索", cx: 200, cy: 100, hit: "self", in_view: true } }),
    computer: () => ({ success: true, trusted: true, withheld: true, target_before: "INPUT#kw", target_after: "DIV.mask" }),
  });
  const r = await action.type({ ref: "p1a.r9", text: "金银花" });
  assert.strictEqual(r.withheld, true);
  assert.strictEqual(r.mechanism, "keyboard");
  assert.match(r.note, /停止键入/);
  const cpu = calls.filter((c) => c.name === "chrome_computer");
  assert.strictEqual(cpu.length, 1, "只允许有那次聚焦点击, 不得继续 insertText");
});

test("verdict: 弱信号(仅 mutation) + 派发前页面就在动 -> unattributable, 不冒领", async () => {
  mock({
    resolve: () => resolveOk({ quiet: 37 }),
    settle: () => ({ verdict: "weak", signal: "mutations:12", elapsed_ms: 1500, checks: [], alive: true }),
  });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.effect.verdict, "unattributable");
  assert.match(r.note, /无法归因/);
});

test("verdict: 弱信号 + 派发前页面静止 -> changed(变动可归因于本次动作)", async () => {
  mock({
    resolve: () => resolveOk({ quiet: 0 }),
    settle: () => ({ verdict: "weak", signal: "mutations:5", elapsed_ms: 900, checks: [], alive: true }),
  });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.effect.verdict, "changed");
});

test("verdict: 完全无信号 -> none, 且标为可重试", async () => {
  mock({ resolve: () => resolveOk(), settle: () => ({ verdict: "none", signal: null, elapsed_ms: 1500, checks: [], alive: true }) });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.effect.verdict, "none");
  assert.strictEqual(r.retryable, true);
});

// ------------------------------------------------------------- postcondition
test("postcondition: 期望逐条判定, 任一 unmet 则整体不通过", async () => {
  mock({
    resolve: () => resolveOk(),
    settle: () => CHANGED,
  });
  // 第一条 met / 第二条 unmet
  util.callTool = (orig => async (name, args) => {
    if (name === "chrome_javascript" && (args.code || "").indexOf("var LIMIT =") >= 0) {
      return page({
        verdict: "changed", signal: "url_changed", elapsed_ms: 200, alive: true,
        checks: [
          { expect: "url", value: "/search", ok: true },
          { expect: "text", value: "共 0 条", ok: false },
        ],
      });
    }
    return orig(name, args);
  })(util.callTool);

  const r = await action.click({ ref: "p1a.r3", expect: [{ expect: "url", value: "/search" }, { expect: "text", value: "共 0 条" }] });
  assert.strictEqual(r.postcondition.met, false);
  assert.strictEqual(r.postcondition.checks.length, 2);
  assert.strictEqual(r.postcondition.checks[0].ok, true);
  assert.strictEqual(r.postcondition.checks[1].ok, false);
});

// ------------------------------------------------------------- type
test("type: 先点击聚焦再键入, 顺序与机制正确", async () => {
  mock({
    resolve: () => resolveOk({ target: { ref: "p1a.r9", tag: "input", role: "textbox", name: "搜索", cx: 200, cy: 100, hit: "self", in_view: true } }),
    settle: () => ({ verdict: "changed", signal: "focus_moved", elapsed_ms: 120, checks: [], alive: true }),
  });
  const r = await action.type({ ref: "p1a.r9", text: "金银花", mode: "replace" });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.mechanism, "keyboard");
  const cpu = calls.filter((c) => c.name === "chrome_computer");
  assert.strictEqual(cpu.length, 3, "replace 模式: 聚焦点击 + ctrl+a + 键入");
  assert.strictEqual(cpu[0].args.action, "left_click");
  assert.strictEqual(cpu[1].args.action, "key");
  assert.strictEqual(cpu[1].args.text, "ctrl+a");
  assert.strictEqual(cpu[2].args.action, "type");
  assert.strictEqual(cpu[2].args.text, "金银花");
  assert.ok(!("ref" in cpu[2].args), "不能把自己的 ref 透给扩展(那是另一套 ref 体系)");
});

test("type: 缺少 text 直接 400, 不碰浏览器", async () => {
  mock({});
  await assert.rejects(() => action.type({ ref: "p1a.r9" }), (e) => e.status === 400);
  assert.strictEqual(calls.length, 0);
});
