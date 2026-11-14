# CHANGELOG

本项目为本地部署 + 安全加固分支。上游：https://github.com/dengzhh/web-to-openapi

版本号遵循 SemVer：MAJOR.MINOR.PATCH（修复 PATCH / 兼容增强 MINOR / 破坏性 MAJOR）。
⚠ 标记表示安全相关问题。

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
