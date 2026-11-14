# 可信动作层方案（ActionReceipt）

**状态：已实施于 v1.8.0（2026-11-14）**
**实施备注：阶段 B 被提前到阶段 A 之前落地** —— 真机验证发现 `chrome_computer` 的坐标点击本身不可用：
`clickTool`（内容脚本合成事件）失败后，fallback 的 CDP 路径会经 `project()` 用截图上下文缩放坐标，
缩放参数为空时算出 NaN，CDP 直接报 `Failed to deserialize params.x`。也就是说阶段 A 的 click 原本
没有任何可用的派发通道。因此先做 forceCdp（阶段 B）再回填阶段 A 的编排层，同时把阶段 C 的
press/release 分离与 withheld 一并做进同一条 CDP 通道（见 `extension/background.js` 的 `forceCdp` 分支）。
**依据：nanobrowser v0.3.0 CDP 交互层（`D:/Temp/nanobrowser-src/src/browser-control/`，Apache-2.0）**

---

## 1. 现状盘点（代码级，v1.6.0）

| 事实 | 位置 | 含义 |
|---|---|---|
| `callTool` 超时直接 reject，无法知道扩展是否已执行 | `host/lib/nm.js:44-56` | 所有「可能双发」风险源头；重试 = 二次点击 |
| `browser_tool` 全局单槽原样转发，零回执 | `host/sites/_service.js:47-51` | 透传语义仅「已发出」 |
| 已有 `chrome_computer`（hover/click/drag/scroll） | `extension/background.js:33342` | 交互工具现成 |
| 已有 `chrome_get_interactive_elements` + `ref_N` | `background.js:26347` / `inject-scripts/accessibility-tree-helper.js:1824` | ref 体系现成 |
| 已有 `chrome_handle_dialog` / `chrome_network_capture` / `chrome_console` | `background.js` | 回执证据源现成 |
| ⚠ 点击实际走内容脚本**合成事件**：坐标路径先调 `clickTool`，仅它报错才 fallback CDP | `background.js:33582-33700`、`26500` | 当前点击 `isTrusted:false`，不是真输入 |
| ⚠ 键盘同为合成（日志 "simulating keyboard events"） | `background.js:28720` 附近 | 同上 |
| ref 为页面内 `ref_1..N` 计数器 + WeakMap，无 epoch / 无文档标识 | `accessibility-tree-helper.js:1824` | 刷新后同名 ref 指向新元素，跨文档复用是隐患 |

结论：**地基具备（ref、坐标、CDP、对话框、网络证据），缺的是「门禁 + 回执」这层，以及一条真输入通道。**

---

## 2. 目标与边界

把「透传」升级为「受控动作」：每次动作有派发前门禁、派发后取证、结构化回执。

三层职责：

```
调用方
  ↓ POST /api/v1/act/click  {target:{ref|selector|text}, expect:{url,text,value,checked,gone}}
host/lib/action.js
  ① resolve  目标解析 + 快照
  ② guard    派发前门禁（在文档/未遮挡/未禁用/在视口）
  ③ dispatch 真输入通道（阶段 B 后才为 trusted）
  ④ settle   派发后收敛 + 变化取证
  ⑤ verdict  changed / unattributable / none
  ↓ 唯一出口 callTool → native messaging → 扩展
```

**不做**：
- 不改现有 6 个站点模块（ysbang/baidu/google/translate/scnet/qshtyy）行为
- 不引入新依赖、不搬 nanobrowser 代码（要模式不要框架）
- 不做「LLM 现场决策」——8090 定位是确定性工具层，这条边界不能模糊
- 新端点不加入 `http.js` 的 `publicPath`（将来启用 token 时自动受保护，不留后门）

---

## 3. 阶段 A：host 侧可信层（不动扩展）

### 新增文件
- `host/lib/action.js`（约 550 行）——resolve/guard/dispatch/settle/verdict
- `host/lib/refs.js`（约 120 行）——ref 注册表 + pageToken
- `host/sites/actions.js`（约 200 行）——站点模块，`sites/index.js` 加一行注册
- `host/test/action.test.js`（8-10 例，mock callTool，不碰真浏览器）

### 端点 / MCP 工具

| 端点 | MCP 工具 | 作用 |
|---|---|---|
| `POST /api/v1/act/observe` | `browser_observe` | 观察页面，返回元素清单 + 本轮可用 ref 集合（写入 known-set） |
| `POST /api/v1/act/click` | `browser_click` | 点击，返回 ActionReceipt |
| `POST /api/v1/act/type` | `browser_type` | 输入文本，返回 ActionReceipt |

### ActionReceipt 契约（字段一次定死）

```json
{
  "ok": true,
  "input_kind": "synthetic",
  "target": {
    "ref": "p7x2.ref_5", "tag": "BUTTON", "role": "button", "name": "搜索",
    "rect": {"x":420,"y":310,"w":64,"h":30},
    "in_viewport": true, "hit": "self"
  },
  "dispatched": true,
  "reached_target": true,
  "mechanism": "pointer",
  "effect": {
    "verdict": "changed",
    "signals": ["url:/search?q=金银花", "mutations:37", "focus:moved"],
    "elapsed_ms": 640
  },
  "postcondition": {"met": true, "checks": [{"expect":"url~/search","ok":true}]},
  "stale": null,
  "retryable": false
}
```

字段语义：
- `dispatched`：`true` / `false` / `"unknown"`（callTool 超时即 unknown）
- `hit`：`self` / `descendant` / `overlay:<tag.class>`（`elementFromPoint` 命中判定）
- `verdict`：强信号（URL/值/checked/焦点/新标签/下载/alert）→ `changed`；仅 mutation 等弱信号且派发前 400ms 页面自身在动 → `unattributable`；无信号 → `none`
- `stale`：`DOCUMENT_CHANGED` / `FRAME_DETACHED` / `DEBUGGER_DETACHED` / `REF_NOT_PRESENTED`

### 三条硬规则（照抄 nanobrowser 的「诚实」）

1. **超时不重试**：`callTool` 超时 → `dispatched:"unknown"` + `retryable:false`，错误信息写明「可能已生效，重复调用有双发风险」
2. **不冒领**：只有弱证据时判 `unattributable`，不判 changed
3. **known-set 防幻觉**：`observe` 未呈现的 ref 直接返回 `REF_NOT_PRESENTED`；pageToken（注入脚本生成，存 `window.__w2o_tok`）作为 ref 前缀，刷新后旧 ref 自动失效并说明原因

### settle 算法
派发前取基线（URL + 目标状态 + 外层 block mutation 计数 + 焦点）；派发后 100ms 轮询，上限 1.5s；有 `expect` 时等到满足或超时；新文档导航则等 DOMContentLoaded + networkIdle（上限 5s）；仅弱证据时再做 400ms 挥发性检查。

---

## 4. 阶段 B：真输入通道（需改扩展，最小改法）

**推荐：给 `chrome_computer` 加 `forceCdp: true`（约 15 行）**
- 位置：`background.js:33582` 的 `left_click` 分支，`forceCdp` 时跳过 `clickTool.execute`，直接走同分支 fallback 里已有的 CDP 序列（move → pressed → released）
- 键盘同理：`forceCdp` 时走 `Input.dispatchKeyEvent`
- 优点：不新增工具名，注册表/schema/host 调用全不用改
- 风险：改 6.3 万行打包产物，须重载扩展 + 回归全部现有端点（ysbang 6 个测试 + baidu/google 各 1 次真机）

**备选：新增 `chrome_pointer`（move/press/release 三态）** —— 改动大，但支撑阶段 C。

阶段 B 完成后 `input_kind` 变 `trusted`。

---

## 5. 阶段 C：split press/release + withheld（可选）

仅在真遇到「点击被覆盖层劫持」或「hover 后目标换行」时做。内容：
- release 前二次验证目标，已变则扣发（withheld）并在回执注明
- 在目标 frame 及祖先 frame 部署卫兵，覆盖层劫持报 `INTERCEPTED` 并说明「前 N 个 press 已送达」
- 依赖阶段 B 的 `chrome_pointer`

---

## 6. 验证方式

1. 单测（阶段 A）：known-set 拒绝未呈现 ref / 超时返回 unknown 且不重试 / verdict 三态 / postcondition 逐条 met-unmet —— 全 mock，不碰真浏览器
2. 真机冒烟：无害页面点登录按钮，检查 `hit`、`signals`、`verdict`
3. 反例：先 observe 再刷新页面，用旧 ref → 必须返回 `stale: DOCUMENT_CHANGED`，而非「element not found」

---

## 7. 何时启动（触发条件）

**关键判断：阶段 A 的价值全在「写操作」上。** 当前 8090 日常（药师帮询价、百度/谷歌搜索、scnet 额度）全是读操作，失败重跑无副作用，回执边际价值低。

出现任意一条再做：

1. 开始用 8090 做**提交类**动作（下单、填表、上传、改价）
2. 药师帮等站点出现「**点了没反应**」（合成事件被识破的典型症状）→ 直接跳阶段 B
3. 有 agent 自动编排 8090 做事，需要区分「失败」与「不知道成没成」→ 阶段 A 最值钱

**推荐起步：MVP**——只做 `act/click` + ActionReceipt + known-set（约 200 行），跑一周真场景再决定是否补齐。
