# CHANGELOG

本项目为本地部署 + 安全加固分支。上游：https://github.com/dengzhh/web-to-openapi

版本号遵循 SemVer：MAJOR.MINOR.PATCH（修复 PATCH / 兼容增强 MINOR / 破坏性 MAJOR）。
⚠ 标记表示安全相关问题。

---

## [1.8.0] - 2026-11-14

**可信动作层（阶段 A+B+C 一次落地）**：把「透传一个工具」升级为「执行一次受控动作」——派发前门禁、真输入通道、派发后取证、结构化回执。为后续自动填表单打底，未改动任何既有站点模块。

### 新增（阶段 A：host 侧可信层）
- `host/lib/probe.js`：页面注入探针。ref 为 `<pageToken>.r<N>`，pageToken 每份文档首次注入时生成 → 刷新即变，旧 ref 报 `DOCUMENT_CHANGED` 而不是含糊的「找不到元素」。内置 MutationObserver 计数、URL 哈希、值与勾选态快照（只回长度与前 3 字符，不回明文）。
- `host/lib/action.js`：编排层。`resolve`（token/存活/可见/未遮挡/未禁用 + 300ms 静默采样）→ `dispatch` → `settle`（100ms 轮询，上限 1.5s）→ `verdict`。
- `host/sites/actions.js`：三个端点 + MCP 工具 `browser_observe` / `browser_click` / `browser_type`。
  - `POST /api/v1/act/observe`、`POST /api/v1/act/click`、`POST /api/v1/act/type`
- 三条硬规则：**超时不重试**（`dispatched:"unknown"` + `retryable:false`）、**不冒领**（仅 mutation 且派发前页面在动 → `unattributable`）、**known-set**（未 observe 的 ref 一律拒绝且不派发）。

### 新增（阶段 B：真输入通道）
- `extension/background.js`：`chrome_computer` 的 `left_click`/`right_click` 支持 `forceCdp: true` —— 直接用 `Input.dispatchMouseEvent` 发受信输入，跳过内容脚本合成事件与截图坐标缩放，回包带 `transport:"cdp"` 与 `trusted:true`。
- ⚠ 修掉一个既有缺陷：坐标点击在 `clickTool` 失败后 fallback 时，会经 `project()` 用截图上下文缩放坐标，参数缺失时算出 NaN，CDP 报 `Failed to deserialize params.x` —— 即坐标点击原本不可用。forceCdp 路径完全绕开它。
- `type` 动作原本就走 `Input.insertText`（真输入），本次只补了聚焦点击的真输入。

### 新增（阶段 C：split press/release + withheld）
- `forceCdp` 时支持 `splitPress: true`（host 默认开启）：press 后重新探测坐标处元素指纹，若已不是同一个元素，则把 release 送到视口外 `(-10,-10)` —— 既释放按键状态又不激活任何元素，回执标 `withheld:true` 并给出 `swapped:{before,after}`。`type` 的聚焦点击被扣发时立即停止键入，避免文字打到别处。

### 真机验收中发现并修掉的三个 bug（都在上线前拦住）
1. **⚠ REST 层把 `forceCdp` 折叠成 false**（`sites/actions.js` 的 `parseInput`）：`truthy(undefined)` 返回 false，
   导致不传参数时 forceCdp 永远关着，点击落到 clickTool 合成路径 —— 那条路坐标缩放有 bug，会点到**别的标签页**的元素上。
   现改为三态：不传 = 默认开启真输入，显式 `forceCdp=false` 才关闭。MCP 侧不受影响。
2. **CDP 输入事件对后台标签不可靠**：`Runtime.evaluate` 能到后台标签，但 `Input.dispatchMouseEvent` 到了渲染器也不触发 handler（实测，透传与编排路径同样复现）。`action.js` 派发输入前先用 `chrome_switch_tab` 把标签激活到前台（等 180ms），激活失败不阻断、由 settle 如实回报。
3. **`page_token` 强迫症**：ref 本身带 token 前缀（`<tok>.r<N>`），host 现在自动从 ref 推导，调用方不必再显式传 `page_token`（显式传时仍以它为准）；页面侧 token 校验与 known-set 校验保持不变，安全性无损。

### 改动
- 版本号 1.7.1 → 1.8.0（`host/lib/config.js`）。
- `host/sites/index.js` 注册 `actions` 站点。
- `docs/写操作契约.md`：契约一补上 `input_kind` / `reached_target` / `withheld` / `swapped` / `postcondition` / `retryable` 的实际取值与语义。
- `docs/可信动作层方案_ActionReceipt.md`：状态改为已实施，记录「阶段 B 被提前到 A 之前」的原因。
- 测试 51 → 67 例（新增 `host/test/action.test.js` 16 例，全 mock，不碰真浏览器）。

### 兼容性
- 既有端点行为不变；不传 `forceCdp` 的 `chrome_computer` 调用走原路径。
- 新端点**未**加入 `http.js` 的 `publicPath`，v1.7.1 起的 token 鉴权对它们自动生效。

---

## [1.7.1] - 2026-11-14

⚠ **安全：启用 token 鉴权**（此前 `token` 一直为空 = 不鉴权）。PATCH：不改任何端点行为，但**未带凭据的调用方会开始收到 401**，升级前必须同步调用方（见下）。

### 为什么现在做

`chrome_javascript` 能在登录态浏览器里执行任意 JS。token 为空 + 无 Origin 头的本机请求一律放行，等于**本机任何进程都能操控你的浏览器**。下一步要上「自动填表单」这类写操作，提交类动作出事不可逆，所以鉴权必须先于写操作落地。

### 服务端

- `host/config.json`：填入 36 位随机 token（`w2o_` + 24 字节 base64url）
- 公开路径保持 `/`、`/health`、`/stats`、`/docs`（探活与观测不设门槛），其余含 `/mcp` 全部要求 `Authorization: Bearer` 或 `?token=`
- `host/lib/config.js`：
  - 新增 `WEBTOOPENAPI_TOKEN` 环境变量覆盖（密钥可不落文件）
  - 修复 **`--host/--port` 被 config.json 覆盖**的 bug：注释声明「config.json < 命令行 < 环境变量」，代码实际是文件覆盖命令行。修复后优先级与注释一致
- `host/config.json` **移出版本控制**（`git rm --cached`，本地文件保留）并加入 `.gitignore`；新增模板 `host/config.example.json`
- `host/mcp-stdio.js`：转发 `/mcp` 时自动带凭据（env 优先，其次同目录 config.json）

### 调用方同步

| 调用方 | 改动 |
|---|---|
| WorkBuddy `~/.workbuddy/mcp.json` | `web-to-openapi` 增加 `type: streamablehttp` 与 `headers.Authorization` |
| storehub | `config.openapiToken`（env `OPENAPI_TOKEN`）+ `collector.js` 请求头 `...AUTH_HEADERS` |
| `tools/ysb-decoder/w2o.py` | token 取 env `WEBTOOPENAPI_TOKEN` 否则读宿主 `host/config.json`；`batch_enquiry.py` 复用其 `headers()` |

> 未配置 token 的调用方保持旧行为（不带头），不会静默破坏——只是会被 401 拒掉，报错明确。

### 测试

51 例全绿（基线 50 + 新增 1）。新增用例锁死公开路径清单：`/health /docs /stats /` 免凭据，`/mcp /api/v1/* /openapi.json` 必须 401。另修 `security.test.js` 与本机配置的耦合（测试内强制 `CONFIG.token=""`，此前本机一填 token 就有一半用例假失败）。

### 文档

- 新增 `docs/写操作契约.md`：写操作的 4 条契约（统一回执 / 永不自动重试 / 目标只用 ref / 赋值方式由调用方声明）+ 新增工具检查清单
- 新增 `docs/可信动作层方案_ActionReceipt.md`：ActionReceipt 实现方案（暂不实施，附触发条件）
- README「隐私与安全」同步鉴权说明

---

## [1.7.0] - 2026-11-14

新增采购比价站点「海豚药药极速版」（`pc.qshtyy.com`，兰州强生医药 B2B 平台）。MINOR：只加站点与新端点，不改任何既有端点行为。

### 为什么这次很轻

该站的搜索是**标准 JSON 接口、价格明文**：没有药师帮的字体连字反爬、没有 AES 密文、不用 DOM 抽取、不用翻页等待。药师帮模块 1411 行 + 两个辅助模块，这里是单文件。

实测摸清的两段式接口（2026-11-14 现场抓包）：

| 接口 | 作用 | 关键事实 |
|---|---|---|
| `POST /api/goods/search/onCondition` | 关键词 → 命中列表 | **只返回 `goodsId` + `goodsName`**，价格/库存都不在这里；`pageSize=500` 时服务端直接返回全部命中（92 条一次拿完），翻页不必用 |
| `POST /api/goods/goodsInfo/list` | id 列表 → 明细 | `limitSize=200` 可一次回 200 条；返回 60 余个字段，含 `sellingPrice`/`retailPrice`/`marketPrice`/`quantity`/`expirationDate`/`minimum`/`packages`/`piece`/`licenseNumber`/`ybfl`/`cgbeizhu` |

认证不是 Cookie 也不是 `Authorization`：**请求头 `token: <localStorage.token>`**。三种都实测过 —— 只带 Cookie 返回 `code:401 "登录已过期"`，带 `token` 头才是 `code:200`（顺带解释了为什么纯 curl 拿不到数据）。

### Added

- **`qshtyy_price`**（`GET|POST /api/v1/qshtyy/price`）—— 单品种报价。参数 `q` / `limit`(默认 100，上限 300) / `sort`(price_asc·price_desc·stock_desc，本地排序) / `in_stock` / `min_expiry` / `nocache`。返回 `price`(账号采购价)、`retail_price`、`market_price`、`stock`、`expiry`、`moq`、`pack`、`piece`、`approval`、`insurance`、`purchase_tag` 等。
- **`qshtyy_batch_price`**（`GET|POST /api/v1/qshtyy/batch`）—— 批量询价，单次上限 10 个品种。**同一标签内顺序跑**（不是多标签并发：单品种只有 2 个请求，开标签的开销远大于请求本身），词间留 400~800ms；单品种失败不拖垮整批，登录失效立即 `aborted=true`。
- **`price_compare`**（`GET|POST /api/v1/compare/price`）—— 跨平台并排比价：海豚药药 vs 药师帮并行跑，返回四层口径（见下）。
- **`sites/qshtyy.js`** 新模块；`sites/index.js` 注册一行；`test/helpers/fake-browser.js` 增加 qshtyy 桩（按脚本里的 `/api/goods/search/onCondition` 字面量分派，可用 `qshtyyRows/qshtyyTotal/qshtyyExpired/qshtyyNoToken/qshtyyApiError` 控制返回）。

### 三个实现决策（都是被实测数据逼出来的）

1. **页面内先裁字段再回传** —— 60 条全字段原始 JSON 是 **121KB**（均条 2028 字节）。扩展对「单字符串」返回值有 10KB 截断，所以页面内映射成短键（`i/n/s/m/p/...`）并 `return` 对象而非 `JSON.stringify`，100 条约 20KB，host 侧再还原成可读字段名。
2. **优先复用用户已开的本站标签** —— 新开一个标签要跑 20+ 个初始化请求（热词/广告/配置）。实测复用后单品种 <1.5s（冷启动约 12s），且只读 `localStorage` + 发 `fetch`，不改用户页面状态，所以**复用的标签不关**（响应带 `reused_tab`）。
3. **缓存只做 5 分钟内存版** —— 该站请求压力远小于药师帮，但也没必要让「同一个词连问三次」重复打接口；5 分钟足以去重，又不至于给出过时价格。`nocache=1` 强制重采。

### 口径与风险（写进响应里，避免误用）

- `price` 是**当前登录账号可见的采购价**（`sellingPrice`），不是全网最低价，也不是零售价；`market_price` 实测常为 `0.00`，已做容错。
- 该站是**单一供货方**（兰州强生）对同一品种的多厂家多规格报价，与药师帮的「多供应商」语义不同。
- 宽词规模实测：`片` 2730 条、`胶囊` 1259 条、`口服液` 211 条。超 `limit` 的截断并在响应里标 `truncated: true`。
- 站点接口 `code != 200` 时**显式报 502**（提示「接口可能已变更」）而不是返回 0 条 —— 空列表会被误读成「没有这个药」。
- 登录态失效（`no_token` / `code:401`）走 `needs_human`：切前台、保留标签、提示重新登录。

### ⚠ 比价为什么必须分四层（真机实测逼出来的，不是设计洁癖）

第一次真机跑「化积口服液」，diff 给出 **便宜 1496%**。逐条查下去，三层假象叠在一起：

| 层 | 药师帮最低价 | 真相 |
|---|---|---|
| 全场最低 | 0.50 元 | 店铺「药店品种预约中心」，**效期 2026-12-31（只剩一个多月）**，且品名是字体反爬残留的纯乱码 |
| 同口径（排除临期/预约/乱码） | 5.03 元 | 川奇「**消食**化积口服液」—— 保健品公司的另一个品种，不是同一个药 |
| 同品名（品名无多余修饰） | 5.40 元 | 恩威「好娃友 化积口服液」—— 但海豚药药那条 7.98 是**江西诚志永丰**的，不同厂家 |
| **同厂家（同品种同规格）** | **6.90 元** | 江西诚志永丰 10ml*6支 —— 与海豚药药 7.98 唯一可比的数字，差 1.08 元（15.65%） |

所以响应结构固定为：

- `diff`：全场最低价对比，附 `plausibility{plausible,reason,hint}`（最低价条目带 flags 或价差 >200% 时 `plausible:false`）
- `fair`：同口径 —— 两边排除效期 <6 个月；药师帮再排除预约/预售店铺、品名乱码，以及不含查询词的条目（`extra_words` 会标出多出的字，如「消食」）
- `fair.ysbang.lowest_strict` + `diff_strict`：品名完全一致的那批
- `fair.ysbang.same_manufacturer` + `diff_same_manufacturer`：同厂家（厂家名归一，括号/「有限公司」等后缀不影响判定），`manufacturer_mismatch` 直接告诉你前一层是否换了厂家

### Fixed

- **⚠ 测试把假数据写进生产缓存** —— v1.6.0 起药师帮缓存落盘，而 `fake-browser` 生成的条目（「第1页药品1 / 某某医药」）会被测试写进真实的 `%LOCALAPPDATA%\webtoopenapi\ysbang-cache.json`。真机 `price_compare` 因此命中假缓存，**返回了一整份假报价**（实测踩到，靠"第1页药品1"这种名字才发现）。
  - 修法：`fake-browser` 在 **require `lib/nm` 之前** 把 `LOCALAPPDATA` 指向临时目录。为什么必须在这个位置 —— `nm → lib/config`，`STATE_DIR` 在 config **加载那一刻**就算好了，写在 `install()` 里已经晚了（第一版就是这么漏的）。
  - 已在临时区的（`stats-persist.test.js` 自建临时目录）不覆盖，避免打断其固定路径断言。
  - 影响面：所有用假浏览器的测试文件（`ysbank-parallel*` 等此前均无隔离）；本轮已清掉缓存里 5 条历史假条目，保留 3 条真实数据。

### Changed

- `host/lib/config.js` `VERSION` → 1.7.0；`extension/manifest.json` `version` **1.5.2 → 1.7.0**（此前跟着 1.6.0 漏改一版，这轮补齐）。
- README：工具清单与 API 一览补三个新端点，`sites/` 目录说明补 `qshtyy.js`，新增「海豚药药」用法一节。

### Tests

- 新增 `host/test/qshtyy.test.js` **17 例**：短键映射与类型（价格必须是 number）、本地筛选排序、缓存命中不碰浏览器、登录失效 → 503 且不关标签、token 缺失、接口异常 → 502、宽词截断、零结果不报错、复用标签、批量单品种失败不中断、批量超 10 个 400、比价缺一方不给 diff、临期/预约/乱码识别、品名差异识别（消食化积 ≠ 化积）、厂家名归一、fair 三层结构、缺 q 400。
- 全量 **50/50 通过**（基线 33 + 新增 17）。
- 新增的 `freshInstall` 会清整个 `host/` 的 require 缓存：`lib/util` 在加载时就解构了 `nm.callTool`，只清 `sites/` 会让新装的假浏览器接不到调用。
- 校验方式：跑完全量测试后检查 `ysbang-cache.json` 不含任何「第1页药品」假条目。

### Notes

- 新端点需 **host 重启**后才出现在 `/openapi.json` 与 MCP `tools/list`（重启浏览器或重载扩展即可拉起新 host）。
- 本站点依赖内部接口，站点改版会失效；失效时按 502 提示核对两个接口路径即可，不影响其他站点。

---

## [1.6.0] - 2026-11-14

面向长期运行的运维三件套（MINOR：兼容增强，不改任何默认行为与接口契约）。

### Added

- **日志轮转** —— `lib/log.js` 按 10MB 阈值轮转（`openapi-host.log` → `openapi-host.log.1`，只保留一代），长期运行不再无限膨胀。阈值常量 `MAX_LOG_BYTES` 导出。
- **`GET /stats` 观测端点**（+ MCP 工具 `service_stats`）—— 各路由的调用次数/平均与最大耗时/错误数（自 host 启动起，内存计数，重启清零），以及药师帮缓存与熔断状态。与 `/health` 一样保持公开（探活与观测）。数据由 `lib/stats.js` 在 HTTP 层记录（含 `/mcp`），站点端点零改动接入。
- **药师帮缓存/熔断落盘持久化** —— 新模块 `sites/ysbang-store.js`（自 ysbang.js 拆出的纯状态层）：
  - 缓存条目落盘到 `%LOCALAPPDATA%\webtoopenapi\ysbang-cache.json`（最近 60 条，防抖 3 秒异步写），host 随浏览器重启后不再对同品种重复打页面；
  - **熔断冷却状态立即落盘**（安全关键）：被拦后 host 重启不会绕过 15 分钟冷却继续撞网关；`reset_block=1` 解除时同样落盘；
  - 加载时丢弃超过默认 TTL（12h）的旧条目与损坏条目；
  - `saveNow()` 返回写入 Promise，供测试与确定性落盘使用。

### Changed

- `sites/ysbang.js` 删除缓存/熔断状态实现（~70 行），改从 `ysbang-store.js` 引入；页面级请求计数器 `reqCounter` 仍留在原文件。行为完全不变。
- `host/lib/config.js` `VERSION` → 1.6.0。

### Tests

- 33 例全绿（基线 31 + 新增 `stats-persist.test.js` 3 例：/stats 统计与结构、熔断落盘契约、**子进程加载恢复冷却与缓存**——测试把 `LOCALAPPDATA` 指向临时目录，不碰真实 `%LOCALAPPDATA%`）。

### Notes

- 已知时序：`/stats` 响应体在自身请求计数写入之前生成，看不到"这一次"的统计（下一次能看到）。
- P0（token 启用 + Host 头校验防 DNS rebinding）本轮明确搁置，`config.json` 的 `token` 仍为空。
- 运行中的 8090 进程仍是旧版代码；新能力在 host 下次被浏览器拉起时生效（重启浏览器或重载扩展即可）。

---

## [1.5.2] - 2026-11-03

真机复验 1.5.1 时发现：**并发页在药师帮上拿不到完整数据**（`pages=3&tabs=3` 返回 74~77 条，同样参数串行是 171 条）。本轮修的是「不能把半截数据当结论」，并给这条路判死。

**根因（实测，非推断）**
- 窗口 URL 带 `page=2`，但该站 SPA 会把 hash 改写回 `page=1` 再渲染：前置页码检查读到的是改写**前**的值，于是检查通过、内容却是第 1 页（或第 1→2 页切换途中的半页）。
- 抽取层「两次读数相同即稳定」正好卡在切换中间态（实测停在 11~14 张卡）。

**修复**
- `lib/util.js` `extractSerp` 新增两个选项：`expect`（够一页条数立即返回，不再靠读数不变判断）与 `settleMs`（要求条数连续 N 毫秒不变才算稳定）。
- `sites/ysbang.js` 并发页抽取**之后再校验一次页码**：`d.page !== pageNo` 即判「该站改写冷启动页号」，置 `pageUrlMode=no` 并降级串行（记忆 10 分钟）。
- 新增**完整性闸门**：任何一页卡片数不到应有条数的 60%，整轮并发结果作废、降级串行，并冷却 30 分钟不再尝试并发（避免每次白开 2~3 个窗口、白发请求）。
- 新增可观测：`concurrency.short_pages`（哪几页不可信）、`concurrency.degrade_reason` 增 `parallel_incomplete`、`hint` 改查表（人话解释每种降级）。

**行为变化（只影响显式传 `tabs>1` 的调用）**
- 在该站上页级并发**实际不可用**：首次调用会探测并降级（多花约 1 个窗口），之后按冷却期直接串行。真正的并发仍是 `batch` 的多品种并发（实测 2/2 成功）。
- 无论走哪条路，**结果始终是完整的串行数据**，不会返回 60/11/6 这种半截结果。

**测试**：31 例全绿（新增 `ysbang-parallel-incomplete.test.js` 2 例、`ysbang-parallel-cooldown.test.js` 1 例；假浏览器支持 `shortOnce` 模拟「某标签打开某页只渲半页」）。

---

## [1.5.1] - 2026-11-03

真机验证 1.5.0 的并发路径时抓出的三个缺陷（PATCH：不改默认行为，只修正确性与可见性）。

### Fixed

- **⚠ 扩展把并发新窗口判成「URL 已打开」而复用同一标签** —— 这是 1.5.0 并发在真机上永远跑不起来的真正原因。`background.js` 的 `pickBestMatch` 只比 `pathname + search`，而药师帮是 hash 路由（`#/indexContent?searchkey=..&page=N`），所有页码的 `pathname` 都是 `/`、`search` 都是空 → 被判成同一 URL → 直接返回已有标签且不做 `chrome.tabs.update`。实测日志里三个并发 worker 拿到同一个 `tabId`、页码恒为 1。补丁：`newWindow/width/height` 显式要求新窗口时跳过 URL 复用匹配。**⚠ 需在 chrome://extensions 重新加载扩展才生效**（打包产物无源码，属本地补丁，上游发版需核对后重新打）。
- **探测吃掉并发** —— 3 页场景先探测 `page2`，探测完队列只剩 1 页，`tabs=min(3,1)=1`，等于没并发（日志 `parallel pages=3 tabs=1`）。改为仅 `pageCount>=4` 时才做前置探测；3 页及以下直接并发发车，走不通由 worker 的 abort 统一降级。
- **页码校验的时序竞态** —— `waitReady` 在 `readyState=complete` 就返回，此时 SPA 可能还没把 `page=N` 应用到路由，单次读取必然读到上一页，于是被误判成「页码参数不被接受」并整轮回退串行（日志中 `probe ok page=2` 与「实际 1」交替出现）。改为短轮询（最多 ~2.4s，每 400ms 一次），并把「hash 里没有 page 参数」按第 1 页处理。
- **批量并发抢同一个搜索标签** —— 两个 worker 都会复用同一个 `indexContent` 标签并互相改搜索词，两边都拿到对方的词。新增进程内 `busyTabs` 占用表：已被占用的标签不再复用，第二个 worker 另开窗口。

### Added

- **降级显式可见** —— 传了 `tabs>1` 却走串行时，响应新增 `concurrency{mode:"sequential", requested_tabs, degraded:true, degrade_reason, hint}`；`degrade_reason` 区分 `tab_reuse_extension_reused_tab` / `page_url_not_accepted` / `hook_mode_incompatible` / `parallel_precheck_failed`。静默降级是 1.5.0 之前的毛病，不该在新路径上复现。
- **`names_diag.stamp`** —— 挂钩合并成功时把 provenance 写进响应（`seq/page_match/age_ms/main_len/aligned/match_rate`），失败时写 `names_diag.last_stamp`（含 reason）。此前这些只在日志里，调用方无法事后对账。
- **`pageUrlMode=no` 增加 10 分钟冷却** —— 上一次偶发失败不再导致进程生命周期内永久串行。

### Tests

- 新增 `host/test/ysbang-parallel-timing.test.js`（3 例）：3 页并发度必须是 2、页码延迟生效时短轮询要等得住不误判、批量两个品种不抢同一标签。
- `fake-browser` 补 `PAGE_JS` 探针与 `pageApplyDelay`（模拟 SPA 延迟应用 page 参数）、`seed()`（预置用户已开的搜索页）。
- 更新 `ysbang-parallel-fallback` 的断言：降级后必须显式声明 `concurrency.mode="sequential"`（原断言「不应声明并发」已随新契约失效）。
- 全量：**28/28 通过**。

---

## [1.5.0] - 2026-11-03

药师帮捕获源选择重做 + 多标签并发询价（MINOR：新增可选参数 `tabs` 与新端点 `/api/v1/ysbang/batch`，默认行为不变；同时把版本号补齐到 1.4.0 之后 —— 1.4.0 的节奏拟人化当时漏改 `VERSION`/`manifest.json`）。

### Added

- **页级并发 `tabs`（1~3，默认 1）** —— 第 1 页留在协调标签（复用首次加载，不额外发请求），其余页各开一个独立窗口直达 `page=N`，把「翻页串行等待」压缩成并发加载。实测口径：3 页从约 12~15s 降到 6~8s，请求数不变（仍为每页一次）。
- **批量询价 `/api/v1/ysbang/batch` + 工具 `ysbang_batch_price`** —— 一次问多个品种（`qs`，上限 10 个），默认 2 个标签并发，每个品种内部仍单标签串行；按入参顺序返回 `results[{q, ok, data|error}]`、`ok_count/failed_count/aborted`。
- **客户端并发槽 `withBrowserSlot` / `slotLimitOf`** —— `browser:true` 的端点从「全局一把锁」改为按站点 id 分槽。站点可用 `concurrency` 声明（ysbang=3），其余站点默认 1 槽，行为与旧版完全一致。
- **页级节流闸 `createPacer`** —— 并发路径与串行路径共用一把闸，按 `[900,2100]ms` 随机间隔发号，保证「标签数增加 ≠ 请求速率增加」。
- **新配置 `browser_concurrency`** —— 默认 0（按站点声明）；设为 1 即恢复旧的全局串行语义，供风控收紧时使用。支持 `WEBTOOPENAPI_BROWSER_CONCURRENCY` 环境变量。

### Changed

- **挂钩捕获改环形缓冲 + 双戳校验**（`sites/ysbang-hook.js`）—— 主世界保留最近 6 次捕获，以 `(页码 + 关键词)` 分组、组内取主列表最长的那次写回传节点。解决了：晚到的小响应覆盖主列表、换词但 hash 未变时旧数据过戳、末页不足 10 条被 `m<10` 门槛挡住永远采不到。
- **回传带 provenance** —— 新增 `data-ysb-seq / -time / -len / -q`；extract 返回 `stamp`（seq、页码是否对上、关键词是否对上、捕获龄、主列表长度）。
- **歧义即报错** —— 次长候选 ≥ 最长候选 80% 时返回 `reason:"ambiguous"` 并附 `candidates`，不再静默挑一个。另新增 `reason:"page_mismatch" / "query_mismatch" / "no_capture"`。
- **host 侧按 reason 决定重试** —— 只有 `no_capture`（主列表还没到）才等 1.5s 重取；`ambiguous`/`page_mismatch`/对齐失败一律不再盲重试。响应新增 `names_diag`（merged / skipped / reasons / warnings），把「为什么没合并」写进结果。
- **末页可合并** —— 取消了 10 条硬门槛，短列表只打 `main_list_short` warning，末页品名也能走明文。

### Fixed

- **⚠ 并发路径不额外增加请求** —— 挂钩模式（`names=hook`）会忽略 `tabs`，因为每页需额外预热一次列表请求，并发会把请求数翻倍。
- **页码参数不被接受时自动降级** —— 首次并发先探测 1 个 worker 校验 `page=N` 是否生效；不生效则记 `pageUrlMode=no` 并整轮回退串行，绝不把「第 1 页数据」挂到第 2 页。

### Tests

- `host/test/ysbang-hook.test.js` —— 7 例：正常页 / 末页短列表 / 页码戳错 / 关键词戳错 / 候选并列 / 主列表更长 / 无捕获。
- `host/test/ysbang-concurrency.test.js` —— 6 例：槽位不超卖、单槽串行、异常释放槽位、节流闸间隔、mark 生效、槽位上限优先级。
- `host/test/ysbang-parallel.test.js` + `ysbang-parallel-fallback.test.js` —— 假浏览器端到端：3 标签并发 180 条不重不漏、请求数 = 页数；批量 2 品种顺序返回；page 参数不被接受时降级串行仍得 120 条。
- 运行：`node --test host/test/*.test.js`（共 25 例全绿）。

---

## [1.4.0] - 2026-10-23

药师帮节奏拟人化：随机延时 + 走入框打字搜索 + 浏览滚动（MINOR：默认路径变更——搜索由 URL 导航改为优先走入框，失败自动退回，无接口参数变化）。

### Added

- **随机延时** —— 新增 `hSleep(min, max)`；搜索后等待、挂钩预热排序、页间停顿全部由固定值改为随机区间。
- **走入框搜索 `typeSearch()`** —— 复用搜索页标签时优先往 `input.searchKey` 分块「打字」（每块 1~3 字符、块间 90~280ms，`execCommand('insertText')` 原生编辑命令），再点 `.search-btn`；打字/点击失败自动退回 `chrome_navigate` URL 导航，成功与否仍由 `waitReady` 权威校验。
- **浏览滚动 `humanScroll()`** —— 首屏就绪后 70% 概率做 2~4 段随机 `scrollBy`，主循环翻页前 55% 概率再扫一眼；12% 概率插入 2.2~4.8s 的偶发长停顿。

### Changed

- 实测依据：固定节奏（8s 节流 + 固定 1.2s 等待）连续搜索 ~35 次后网关开始成片 504（拦截的是请求形态规律，非单次行为）；加入拟人化后需复测验证。
- 版本头注释「抗风控三件套」更新为「四件套」。

---

## [1.3.0] - 2026-10-23

药师帮抗风控增强：结果缓存 + 比价快查 + 验证码熔断（MINOR：新增可选参数与返回字段，默认行为不变）。

### Added

- **`mode=cheapest` 比价快查** —— 只要最低价时不再翻页：第 1 页 + 价格从低到高，
  请求量 `1(搜索) + 1(切排序) = 2` 次，对比全量 `1 + 13 = 14` 次砍掉 86%。
  返回新增 `sorted` / `lowest_is_global` / `sort_label` / `sort_why`，
  `sorted=true` 时 `price_min` 即全站最低价；`sorted=false` 表示只是默认排序首页里的最低价。
- **结果缓存** —— 进程内 LRU（上限 200 条），key = `mode|q|pages|sort|top`，
  TTL 默认 12 小时（`ttl` 参数可调，`ttl=0` 关闭），`nocache=1` 强制重采但仍写缓存。
  命中时返回 `cached: true` / `cached_at` / `cache_age_s` / `requests: 0`（全程不发请求）。
- **验证码熔断** —— 页面探针新增 `vcode`（滑块/图形验证码容器 + 提示文案双判据），
  命中即返回 **429** 并冷却 **15 分钟**；冷却期内所有请求**快速失败、一个页面请求都不发**，
  避免在被拦后继续撞导致真实采购账号被标记。人工过完验证后带 `reset_block=1` 立即恢复。
- 所有响应新增 `requests`（本次页面级请求数）与 `mode`，便于量化抗风控效果。

### Changed

- `STAT_JS_TPL` 增加 `vcode` 探测：`iframe[src*=captcha]`、`[class*=yidun]`、`[class*=geetest]`、
  `.nc_container/.nc_scale`、`[id*=captcha]`，以及正文里的「拖动滑块 / 请完成验证 / 访问过于频繁 / 安全验证」等文案。
- `waitReady` 命中验证码立即返回，不再原地空等满 15 秒（少刷 20 次状态探针）。
- `clickPager` / `clickSort` 的等待循环识别 `vcode`，翻页途中被拦立刻终止。
- `clickSort` 支持多候选文案（`价格` / `价格从低到高` / `低价优先` / `低价`），先精确再包含匹配，
  并返回实际点到的那一项 label（站点排序项文案会随版本变）。
- 请求计数统一在 `clickPager` / `clickSort` 内部累计（点击真正生效才 +1）。

### 背景

用户反馈 8090 仍触发拦截。核查 `host-stderr.log` **无一条 429/403**，说明被拒不在 HTTP 层，
而在药师帮的页面/账号风控层。根因是**请求形态不像人**：一次比价 = 1 次搜索 + 13 次翻页，
间隔固定 1.2 秒，14 次请求挤在 70 秒内；批量查 10 个品种即 130+ 次请求。这类特征与
指纹伪装、TLS 指纹无关，换任何抓取框架都会被拦。故把优化点放在请求侧：能少要就少要（cheapest）、
能复用就复用（缓存）、被拦就立刻停手（熔断）。

---

## [1.3.1] - 2026-10-23

服务重启后端点/工具路由排查 + cheapest 模式实战验证收尾（PATCH：无代码改动，纯验证与文档修正）。

### Fixed

- 澄清调用路径：站点工具**不走** `POST /api/v1/tools/{name}`（该端点只路由到扩展 chrome_* 工具，
  调 ysbang_price 会得到 `Tool ysbang_price not found`）；正确入口是站点端点
  `POST /api/v1/ysbang/price`（JSON body，中文免编码）。`/api/v1/tools` 列表只含扩展共享工具，
  站点工具看 `/openapi.json` 或 `/docs`。

### 实测验证（2026-10-23 19:20，扩展拉起的 v1.3.0）

| 场景 | 结果 |
| --- | --- |
| 化积口服液 cheapest 首查 | 3 请求 / 15s，price_min=3.17（top8 按价升序） |
| 同词重跑（缓存命中） | 0 请求 / 0.1s，price_min 一致 |
| 藿香正气颗粒 cheapest 首查 | 3 请求 / 9.9s，price_min=2.97 |
| 复方川芎吲哚美辛胶囊 | 504（该品种在药师帮无售=控销限制，空结果的正确表现，hint 已说明） |
| 服务重启恢复 | kill 8090 后扩展自动重连拉起，sites 全部加载（routes: 15） |

### 已知边界（暂接受）

- **品名乱码 ~5%**：促销变体字体的品名 canvas 字形表未覆盖（如「哇佣囲嚅…」），价格解码不受影响。
  根因是 hook 捕获只拿到 5 条（推荐位响应）vs DOM 70 条，对齐失败退回 font 模式——
  hook armed 链路本身已验证可用（09:18 实测 armed=true），待后续修捕获源选择。
- 搜索词无结果返回 504（非 count=0），hint 已说明原因。

---

## [1.2.0] - 2026-10-23

药师帮品名改用「页面内挂钩 JSON.parse」取解密明文（MINOR：新增参数 `names`，原字体解码保留为价格权威来源，接口签名向后兼容）。

### Added

- **`host/sites/ysbang-hook.js`** — 页面内挂钩脚本，两种模式（`__YSB_MODE__` 全局文本替换注入）
  - `install`：向页面注入内联 `<script>`，让挂钩**跑在主世界**（关键：`chrome_javascript` 执行在隔离世界，
    直接包 `window.JSON.parse` 拦不到页面自己的解析，实测 `__vue_app__` 不可见即为证据）；
    主世界包裹 `JSON.parse`，命中商品列表型响应后把明文 JSON 写入隐藏节点
    `<script type="text/plain" id="__ysb_cap">`，并打页码戳 `data-ysb-page`
  - `extract`：隔离世界读回该节点 → 取**最长的商品数组**（该站不同入口键名与区块数量不一致，
    取第一个会拿到 5 条秒杀数据去对齐 70 张卡片）→ 映射品名/厂家/商家/规格/有效期/起购量
- 新参数 **`names`**：`hook`（默认，品名走解密明文，慢约 1 倍）/ `font`（与 v1.1.0 同速）
- 响应新增 `decode_mode`（hook/mixed/font）与 `names_mode`，条目新增 `spec`/`brand`/`wholesaleid`/`name_src`

### Changed

- 采集流程：导航 → 装挂钩 → **点「销量」再点回「默认排序」**（第 1 页会命中 SPA 缓存不重发请求，
  翻页预热抓不到；切排序一定重发且页码仍是 1）→ 兜底仍保留「翻到第 2 页再翻回」→ 之后每页双取合并
- 合并规则：DOM 卡片数可能多于主列表（额外渲染秒杀/推荐），改为「按位对齐 + 工厂名匹配率 ≥50%」校验，
  不达标整页不合并；失败时等 1.5 秒重试一轮
- 版本号 1.1.0 → 1.2.0（`host/lib/config.js` + `extension/manifest.json`）

### 背景与实测（藿香正气颗粒）

- 根因：`getWholesaleList` 返回 `{i:true, o:"<base64 密文>"}`，前端解密后 `JSON.parse` 再渲染；
  字体层 `ysb-din-bold` 连字让 DOM 价格变乱码汉字，促销项品名偶发变体字体同样乱码
- ⚠ 扩展侧响应脱敏：主列表这版的价格是 `goodsPrice.priceShown` 渲染片段，其 `text` 是字体密文，
  会被脱敏器整块替换成 `[BLOCKED: Base64 encoded data]` —— **密文出不了页面**。
  所以价格**必须**继续用 canvas 字形匹配（页面内完成，实测 100% 可解），挂钩只负责纯明文字段
- 效果（5 页 224 条）：品名乱码 16/126(≈5.3%) → **8/224(≈3.6%)**，剩余集中在第 1 页（该页主列表响应
  结构与其他页不同，未能对齐，已按「不合并」处理，保留字体解码结果）
- 代价：`names=hook` 每页多一次页面内提取，5 页约 67 秒；`names=font` 与旧版同速

---

## [1.1.0] - 2026-10-19

新增药师帮报价站点（MINOR：仅新增能力，不改动既有端点）。

### Added

- **新站点 `host/sites/ysbang.js`** — `GET|POST /api/v1/ysbang/price`，MCP 工具 `ysbang_price`
  - 自动翻页采集，参数：`q`（关键词，必填）、`pages`（0=全部，上限 20）、`sort`（price_asc/price_desc）、`include_zero`
  - 返回 `items[]`（品名/厂家/商家/起购门槛/免邮门槛/原价/折后价/促销/有效期/库存/页码）与 `price_min`/`price_max`/`total`
  - 标签选择：优先复用已有的搜索页标签；没有则自建独立不激活窗口，完成后关闭
- **`host/sites/ysbang-decode.js`** — 页面内解码脚本（作为文本资源读取，不走 require）
  - 价格：canvas 整段渲染触发字体连字 → 垂直投影切字形 → 归一化 16×24 位图与 0-9 模板汉明匹配
  - 文本：品名剥离「N盒起购/包邮」前缀并单列 `moq`，商家行按厂家后置位置提取（该行不含"仓"字），
    免邮门槛从「N元免邮」拆出

### Fixed

- **修复「换关键词仍返回上一个词的数据」**
  - 根因：`chrome_navigate` 对同站点会复用已有标签且**不更新 URL**（复用判断在 `newWindow` 之前），
    而该站是 hash 路由 SPA，URL 没变则搜索词没变
  - 修复：显式传 `tabId` 触发 `chrome.tabs.update`；导航后校验 `hash` 里的 `searchkey`（只回布尔，不回 URL）；
    新增 `waitReady()` 等待「目标关键词 + 列表出现 + 文档 complete」三者同时成立
- **修复翻页可能读到旧页数据**
  - 翻页完成判据从「页码变化」改为「页码变化 + 首条卡片内容指纹（`fh`）变化」

### Changed

- `host/sites/index.js` 注册 ysbang 站点
- 版本号 1.0.1 → 1.1.0（`host/lib/config.js` + `extension/manifest.json`）

### 实测

| 关键词 | 页数 | 条数 | 耗时 | 价格解码 |
|---|---|---|---|---|
| 润家 化积口服液 | 3 | 124 | 19.9s | 124/124 |
| 藿香正气颗粒 | 20 | 885 | 66.9s | 885/885 |

字段填充率：品名/厂家/商家/有效期 100%，起购门槛 99.2%。

### 已知限制

- `MAX_PAGES = 20` 是硬上限，超过 20 页的结果集会被截断（响应里 `count < total` 可判断）
- 复用标签时会就地切换用户正在看的药师帮页面，响应里以 `reused_tab: true` 提示；
  该标签不会被关闭，自建标签才会关
- 站点为 SPA，翻页依赖 `.pagination-prev` / `.pagination-next` 的类名，站方改版需同步调整

---

## [1.0.1] - 2026-10-19

安全加固版本。⚠ 修复一处可被任意网页利用的高危缺陷，无破坏性变更，调用方式不变。

### ⚠ Security

- **修复 P0：本地 HTTP 服务跨域零限制**（`host/lib/http.js`）
  - 原实现所有响应写死 `Access-Control-Allow-Origin: *`，且 `/api/v1/tools/{name}` 无任何凭据校验。
    任意网页（含广告 iframe）可跨域调用该端点，用 `chrome_javascript` 在已登录页面执行任意脚本并读回结果，
    等价于把浏览器全部登录态做成对公网开放的接口。
  - 现状：Origin 白名单化。仅放行扩展自身（`chrome-extension://<32位ID>`）、本机页面（`localhost` / `127.0.0.1` / `::1`）、
    以及 `config.json` 中 `allowed_origins` 显式配置的来源；其余一律 403 且不回 ACAO。
  - 无 `Origin` 头的请求（本机 CLI、MCP 客户端）不受影响。
  - 新增 `Vary: Origin`，避免中间缓存串味。

- **新增可选 token 鉴权**（`host/lib/http.js` + `host/lib/config.js`）
  - `config.json` 的 `token` 非空时，除 `/health` / `/docs` 外所有请求必须带
    `Authorization: Bearer <token>` 或 `?token=<token>`，比较使用 `crypto.timingSafeEqual` 防时序侧信道。
  - 默认空字符串 = 不启用，现有脚本（`tools/ysb-decoder/w2o.py` 等）无需改动。

- **清理 `clientError` 响应中的 `Access-Control-Allow-Origin: *`**
  - 畸形请求的 400 响应不再携带通配跨域头。

### Changed

- **扩展权限收敛**（`extension/manifest.json`）
  - 移除 `declarativeNetRequest`：全仓检索 **0 处使用**，属纯冗余声明。
  - 权限数 16 → 15。

### Added

- `host/test/security.test.js`：9 条安全回归测试，覆盖 403 拦截、ACAO 精确回显、扩展/本机放行、
  token 开关等路径。运行：`node --test host/test/security.test.js`

### 未处理（需评估后决定）

- `debugger` / `webRequest` / `history` / `bookmarks` 仍为常驻权限。`debugger` 是截图等 CDP 功能所依赖，
  改为 `optional_permissions` 会破坏现有能力；`history` / `bookmarks` 有对应工具实现，删除会使该工具报错。
  这两类需按实际使用范围决定，未在本版本擅自改动。
- 扩展为打包产物（`background.js` 63k 行，内联 ONNX Runtime + transformers.js，含 HuggingFace 远端模型加载路径），
  无法逐行审计。建议需要时用官方源码本地构建并 diff。

### 已知限制

- 服务仍绑定 `127.0.0.1`（默认），局域网不可达。
- Native Messaging `allowed_origins` 限定单一扩展 ID，其他扩展无法冒用 host。
- 仍无速率限制与只读模式，写操作与只读查询同等开放。
