"use strict";
/*
 * 站点: 可信动作层(不绑定任何具体网站)
 * ---------------------------------------------------------------------------
 * 三个端点, 全部返回结构化 ActionReceipt:
 *   POST /api/v1/act/observe  -> 观察页面, 分配本项目自己的 ref(<pageToken>.r<N>)
 *   POST /api/v1/act/click    -> 点击, 带回执
 *   POST /api/v1/act/type     -> 聚焦 + 键入文本, 带回执
 *
 * 与 /api/v1/tools/{name} 透传的区别:
 *   透传只知道"发出去了"; 这里知道"有没有把关、发没发出去、页面变没变、变化能不能归因"。
 *   写操作请走这三个端点, 别直接用 chrome_computer —— 那样拿不到回执。
 */
const action = require("../lib/action");
const { toSearchParams, truthy } = require("../lib/util");

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// 统一 GET 查询串 / POST JSON body
function parseInput(input) {
  const isSp = input instanceof URLSearchParams;
  const sp = isSp ? input : toSearchParams(input);
  const raw = isSp ? null : (input || {});

  const expectRaw = raw && Array.isArray(raw.expect) ? raw.expect : null;
  const expect = [];
  if (expectRaw) {
    for (const e of expectRaw) {
      if (!e || typeof e !== "object" || !e.expect) continue;
      expect.push({ expect: String(e.expect), value: e.value });
    }
  } else if (isSp) {
    // GET 只支持单个简单断言: expect=url&expect_value=/foo
    const k = sp.get("expect");
    if (k) expect.push({ expect: String(k), value: sp.get("expect_value") });
  }

  const tabIdRaw = sp.get("tabId") || sp.get("tab_id");
  return {
    tabId: tabIdRaw == null || tabIdRaw === "" ? null : num(tabIdRaw, null),
    ref: sp.get("ref") || null,
    page_token: sp.get("page_token") || sp.get("pageToken") || null,
    text: sp.get("text") == null ? null : String(sp.get("text")),
    mode: sp.get("mode") || "append",
    max: num(sp.get("max"), undefined),
    quiet_ms: num(sp.get("quiet_ms"), undefined),
    settle_ms: num(sp.get("settle_ms"), undefined),
    timeout_ms: num(sp.get("timeout_ms"), undefined),
    expect,
    // 三态: 不传 = undefined(action.js 默认开启真输入); 显式 false 才关闭。
    // (bug 修复: 原先 truthy() 把"未传"折叠成 false, 导致 forceCdp 永远关着, 点击落到
    //  clickTool 合成路径 —— 那条路坐标缩放有 bug, 会点到别的元素上。)
    forceCdp:
      sp.get("forceCdp") == null && sp.get("force_cdp") == null
        ? undefined
        : truthy(sp.get("forceCdp") || sp.get("force_cdp")),
    splitPress:
      sp.get("splitPress") == null && sp.get("split_press") == null
        ? undefined
        : truthy(sp.get("splitPress") || sp.get("split_press")),
  };
}

// ---------------------------------------------------------------- run
async function runObserve(p) {
  return await action.observe({ tabId: p.tabId, max: p.max, timeout_ms: p.timeout_ms });
}

async function runClick(p) {
  return await action.click({
    tabId: p.tabId,
    ref: p.ref,
    page_token: p.page_token,
    expect: p.expect,
    settle_ms: p.settle_ms,
    quiet_ms: p.quiet_ms,
    timeout_ms: p.timeout_ms,
    forceCdp: p.forceCdp,
    splitPress: p.splitPress,
  });
}

async function runType(p) {
  return await action.type({
    tabId: p.tabId,
    ref: p.ref,
    page_token: p.page_token,
    text: p.text,
    mode: p.mode,
    expect: p.expect,
    settle_ms: p.settle_ms,
    quiet_ms: p.quiet_ms,
    timeout_ms: p.timeout_ms,
    forceCdp: p.forceCdp,
  });
}

const EXPECT_SCHEMA = {
  type: "array",
  description: "期望的后置条件, 逐条判 met/unmet。支持: {expect:'url',value:'/search'} 地址含子串; {expect:'text',value:'成功'} 页面文本含子串; {expect:'checked',value:true} 勾选态; {expect:'gone'} 目标消失。注意: 只有 value 长度会参与比较, 不回传明文。",
  items: {
    type: "object",
    properties: {
      expect: { type: "string", enum: ["url", "text", "value", "checked", "gone"] },
      value: {},
    },
    required: ["expect"],
  },
};

module.exports = {
  id: "actions",
  title: "可信动作层(点击/输入带回执)",
  concurrency: 1,
  endpoints: [
    {
      method: "POST",
      methods: ["POST", "GET"],
      path: "/api/v1/act/observe",
      tool: "browser_observe",
      operationId: "actObserve",
      summary: "观察当前页面并分配 ref",
      description:
        "遍历可见可交互元素, 为每个分配本项目自己的 ref(<pageToken>.r<N>), 返回清单(标签/角色/名称/坐标/是否可见/是否被遮挡)。后续 click/type 必须用这里返回的 ref: 没 observe 过的 ref 会被直接拒绝(REF_NOT_PRESENTED), 防止凭空编造元素。页面一旦重新加载 pageToken 会变, 旧 ref 全部失效并明确报 DOCUMENT_CHANGED。",
      responses: { 200: { description: "元素清单 + page_token + tab_id" }, 500: { description: "页面脚本执行失败" } },
      browser: true,
      parse: parseInput,
      run: runObserve,
      doc: {
        note: "观察页面, 拿 ref 与 page_token。这是所有点击/输入的前置步骤。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/observe \\
  -H "Content-Type: application/json" \\
  -d '{"tabId":123}'`,
      },
    },
    {
      method: "POST",
      path: "/api/v1/act/click",
      tool: "browser_click",
      operationId: "actClick",
      summary: "点击元素并返回 ActionReceipt",
      description:
        "派发前门禁(token/存活/可见/未遮挡/未禁用) → 派发 → 收敛取证 → 结构化回执。回执字段: dispatched(true/false/unknown) / reached_target(null 表示无法证明) / effect.verdict(changed/unattributable/none) / postcondition / stale / retryable。三条硬规则: 超时不重试、弱证据不冒领、未观察过的 ref 直接拒绝。",
      example: { tabId: 123, ref: "p3k2.r7", expect: [{ expect: "url", value: "/search" }] },
      responses: { 200: { description: "ActionReceipt" }, 400: { description: "缺少 ref" }, 500: { description: "执行失败" } },
      browser: true,
      parse: parseInput,
      run: runClick,
      doc: {
        note: "点击并取证。ref 必须来自 act/observe; page_token 建议一并传(不传会用当前页 token, 但无法区分跨文档)。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/click \\
  -H "Content-Type: application/json" \\
  -d '{"tabId":123,"ref":"p3k2.r7","expect":[{"expect":"url","value":"/search"}]}'`,
        slow: true,
      },
    },
    {
      method: "POST",
      path: "/api/v1/act/type",
      tool: "browser_type",
      operationId: "actType",
      summary: "键入文本并返回 ActionReceipt",
      description:
        "先按 ref 真坐标点击聚焦, 再插入文本(扩展侧走 Input.insertText)。mode=append 追加 / replace 先 ctrl+a 全选再键入。返回 ActionReceipt, 字段同 click。注意: 回执里只回值长度与前 3 字符, 不回明文, 避免把密码/手机号写进日志。",
      example: { tabId: 123, ref: "p3k2.r9", text: "金银花", mode: "replace" },
      responses: { 200: { description: "ActionReceipt" }, 400: { description: "缺少 ref 或 text" }, 500: { description: "执行失败" } },
      browser: true,
      parse: parseInput,
      run: runType,
      doc: {
        note: "聚焦 + 键入。replace 模式会先 ctrl+a 全选, 适合覆盖已有内容。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/type \\
  -H "Content-Type: application/json" \\
  -d '{"tabId":123,"ref":"p3k2.r9","text":"金银花","mode":"replace"}'`,
        slow: true,
      },
    },
  ],
  tools: [
    {
      name: "browser_observe",
      description:
        "观察当前页面(或指定 tabId), 返回可见可交互元素清单与 page_token。每项含 ref(后续点击/输入必须用它)、tag、role、name、type、disabled、rect、hit(self/descendant/overlay:...)、in_view。写操作前必须先调本工具拿 ref: 没 observe 过的 ref 会被拒绝。页面重新加载后 page_token 变化, 旧 ref 失效。",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "integer", description: "目标标签页 id; 省略则用当前活动标签" },
          max: { type: "integer", minimum: 1, maximum: 300, description: "最多返回多少个元素(默认 120)" },
        },
        additionalProperties: false,
      },
      browser: true,
      run: runObserve,
    },
    {
      name: "browser_click",
      description:
        "点击页面上由 browser_observe 返回的 ref, 并返回 ActionReceipt 回执。回执关键字段: dispatched=true/false/'unknown'(unknown 表示超时、可能已生效, 因此绝不会自动重试) / effect.verdict=changed|unattributable|none / postcondition.met / stale(REF_NOT_PRESENTED / DOCUMENT_CHANGED / OBSCURED / NOT_VISIBLE / DISABLED / FRAME_DETACHED, 附带原因)。派发前会做门禁: 不在观察集合、被遮挡、不可见、禁用一律拒绝。",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "browser_observe 返回的 ref" },
          tabId: { type: "integer", description: "目标标签页 id; 省略则用当前活动标签" },
          page_token: { type: "string", description: "browser_observe 返回的 page_token; 传入可识别跨文档失效" },
          expect: EXPECT_SCHEMA,
          settle_ms: { type: "integer", minimum: 200, maximum: 8000, description: "取证收敛上限(默认 1500)" },
        },
        required: ["ref"],
        additionalProperties: false,
      },
      browser: true,
      run: runClick,
    },
    {
      name: "browser_type",
      description:
        "向 browser_observe 返回的 ref 键入文本并返回 ActionReceipt。先按真坐标点击聚焦, 再插入文本。mode=append(默认)追加 / replace 先 ctrl+a 全选再键入。回执只包含值长度与前 3 字符, 不回传明文。适合表单填写; 填完建议用 browser_observe 或带 expect 复核。",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "browser_observe 返回的 ref" },
          text: { type: "string", description: "要键入的文本" },
          mode: { type: "string", enum: ["append", "replace"], description: "append 追加(默认) / replace 先全选再键入" },
          tabId: { type: "integer", description: "目标标签页 id; 省略则用当前活动标签" },
          page_token: { type: "string", description: "browser_observe 返回的 page_token" },
          expect: EXPECT_SCHEMA,
          settle_ms: { type: "integer", minimum: 200, maximum: 8000, description: "取证收敛上限(默认 1500)" },
        },
        required: ["ref", "text"],
        additionalProperties: false,
      },
      browser: true,
      run: runType,
    },
  ],
};
