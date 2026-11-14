# 药师帮比价接口 · 调用说明（可直接转发）

> 接口名：`ysbang_price`（单查）/ `ysbang_batch_price`（批量） ｜ 路径：`/api/v1/ysbang/price`、`/api/v1/ysbang/batch`  
> 服务地址：`http://127.0.0.1:8090`（仅本机）  
> 版本：web-to-openapi v1.8.0

---

## 一、先看这三条前提（不满足就调不通）

| 前提                      | 说明                                                                     |
| ----------------------- | ---------------------------------------------------------------------- |
| **必须同一台电脑**             | 服务只监听 `127.0.0.1:8090`，不对外开放。外网 / 手机 / 别的机器一律连不上，这是设计如此（用的是本机浏览器的登录态）。 |
| **浏览器必须已登录药师帮**         | 地址 `https://dian.ysbang.cn`，登录态掉了接口会返回 503/504。等于用被借用的那个账号去查。          |
| **Chrome + 扩展 + 服务都在跑** | 三个都得活着。扩展断了服务会显示 `extension_connected: false`。                         |

自检一条命令：

```bash
curl -s http://127.0.0.1:8090/health
```

返回 `"status":"ok"` 且 `"extension_connected": true` 才算就绪。

---

## 二、怎么调（三种方式，按人挑）

### 方式 1 · 说一句话（不会写代码的人）

> 在 WorkBuddy 里直接说：「查药师帮 藿香正气颗粒 的报价」  
> 或：「药师帮查一下 复方川芎吲哚美辛胶囊，按价格从低到高排」

### 方式 2 · HTTP 调用（Python / Java / Excel VBA / 任何脚本）

**POST（推荐，中文不用转码）**

```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/ysbang/price \
  -H "Content-Type: application/json" \
  -d '{"q":"藿香正气颗粒","pages":3,"sort":"price_asc"}'
```

Python：

```python
import requests

r = requests.post(
    "http://127.0.0.1:8090/api/v1/ysbang/price",
    json={"q": "藿香正气颗粒", "pages": 0, "sort": "price_asc"},
    timeout=180,          # 首次调用要开浏览器，给足时间
)
data = r.json()
cheapest = data["items"][0]
print(cheapest["price"], cheapest["shop"], cheapest["factory"])
```

**GET**（中文要 URL 编码）

```bash
curl -s "http://127.0.0.1:8090/api/v1/ysbang/price?q=%E8%97%BF%E9%A6%99%E6%AD%A3%E6%B0%94%E9%A2%97%E7%B2%92&pages=3"
```

### 方式 3 · MCP / AI 客户端

工具名：`ysbang_price`，入参同下。已在 `/openapi.json` 与 `/docs` 暴露，可直接导入 Postman / Apifox。

---

## 三、参数

| 参数             | 类型     | 必填 | 说明                                         |
| -------------- | ------ | -- | ------------------------------------------ |
| `q`            | string | ✅  | 搜索关键词，建议「品名」或「品名+厂家核心词」                    |
| `pages`        | int    |    | 最多翻几页。`0` = 全部（默认），上限 20。**只要比价用 1，全量用 0** |
| `tabs`         | int    |    | 页级并发标签数，`1`（默认）顺序翻页。`2`～`3` 在该站**实测不可用**（SPA 会把冷启动页号改写回第 1 页），会自动降级串行；真并发请用 `batch` |
| `mode`         | string |    | `full`（默认全量）/ `cheapest`（扫有限页取最低 top 条） |
| `sort`         | string |    | `price_asc` / `price_desc`，不传保持页面原顺序       |
| `include_zero` | bool   |    | `true` 时保留解码失败的条目（默认过滤）                    |
| `names`        | string |    | `font`（默认，快，可并发）/ `hook`（品名更纯，约慢 1 倍，不能并发）   |
| `ttl`          | int    |    | 缓存秒数，默认 43200（12 小时），`0` = 关缓存             |

**耗时**：`pages=1` 约 5–8 秒；`pages=0` 看结果多少，通常 15–40 秒。  
`tabs=3` 抓 3 页约 6–8 秒（原来约 12–15 秒）；标签数只压缩等待，不增加请求速率 —— 所有请求共用一把页级节流闸。

---

## 三·补充、批量询价（多品种一次问完）

比价通常是 5～10 个品种，逐个调等于把队列拉长。用批量端点：

```bash
curl -s -X POST http://127.0.0.1:8090/api/v1/ysbang/batch \
  -H "Content-Type: application/json" \
  -d '{"qs":["复方川芎吲哚美辛胶囊","藿香正气颗粒","三七伤药片"],"mode":"cheapest","pages":3}'
```

- `qs`：品种数组，也可传逗号分隔字符串；**单次最多 10 个**
- 默认 2 个标签并发（`tabs=1` 可强制串行），每个品种内部仍是单标签翻页
- 任意品种撞到验证码即整体停手：`aborted: true`，**已完成的结果照常返回**（部分可用优于全军覆没）
- 返回按入参顺序：`results[{q, ok, data|error}]` + `ok_count / failed_count`
- 同词在 `ttl` 内仍走缓存，重复跑同一批品种几乎不发请求

---

## 四、返回

```json
{
  "query": "藿香正气颗粒",
  "pages_fetched": 1,
  "total": 163,
  "count": 60,
  "price_min": 3.50,
  "price_max": 28.00,
  "reused_tab": true,
  "fetched_at": "2026-10-19T09:12:33.000Z",
  "items": [
    {
      "name": "藿香正气颗粒",
      "factory": "太极集团重庆涪陵制药厂",
      "warehouse": "500免邮 众远快益达",
      "shop": "众远快益达",
      "free_ship_floor": "500",
      "moq": "5盒起",
      "expiry": "2027-05",
      "price": "3.50",
      "price_ok": true,
      "discount": "折后",
      "promo": "满1000降50",
      "stock": "正常",
      "page": 1
    }
  ]
}
```

| 字段                        | 含义                              |
| ------------------------- | ------------------------------- |
| `count` / `total`         | 本次拿到条数 / 页面声明的结果总数              |
| `price_min` / `price_max` | 本次结果的价格区间                       |
| `items[].price`           | 折后单价（**字符串**，用前转 float）         |
| `items[].moq`             | 起订量，出现「盒」是单盒价，出现「件/箱」是整件价       |
| `items[].warehouse`       | 店铺+仓库，「500免邮」是包邮门槛              |
| `reused_tab`              | `true` = 借用了你已开的药师帮标签（会切走你的搜索词） |

---

## 五、报错怎么读

| 状态码               | 含义          | 怎么办                                   |
| ----------------- | ----------- | ------------------------------------- |
| 400               | 缺 `q`       | 补关键词                                  |
| 503 `needs_human` | 需要登录        | 到 Chrome 登录 `dian.ysbang.cn`，再调一次     |
| 504               | 页面没渲染出列表    | 把 Chrome 窗口切到前台（最小化时后台标签会被冻结），或关键词无结果 |
| 连不上               | 服务没起 / 扩展没连 | 跑 `run_host.bat`，检查扩展是否启用             |



---

## 六、两个坑，先说清楚

**1. 价格单位不统一。** 同一品种有人报单盒、有人报中包装、有人报整件，直接取最低价会踩坑。做比价时用你自己的「最后进价」当锚，按包装倍率折算（±15% 容差）再比。

**2. 会占用你的浏览器。** 接口是驱动真实浏览器工作的，调用期间那个标签页会被切到目标关键词。批量跑的时候，最好别同时手工操作药师帮。

**3. 页级并发（`tabs>1`）在药师帮上不成立，已自动降级。** 实测该站 SPA 会把冷启动窗口的 `page=N` 改写回 `page=1` 再渲染，新标签拿到的其实是第 1 页（或切换途中的半页）。v1.5.2 起：首次探测到就判死并降级串行（`degrade_reason = "page_url_not_accepted"`），10 分钟内不再尝试；即便探测到了半截数据，也会被完整性闸门作废（`"parallel_incomplete"`）后重跑串行。**结论：无论传不传 `tabs`，返回的都是完整的串行数据。**

**3.1 真正的并发是多品种：`batch`。** `POST /api/v1/ysbang/batch`（或工具 `ysbang_batch_price`）默认 2 个标签并发跑不同品种，每个品种内部单标签串行，共享熔断与缓存；实测 2/2 成功。要开窗口更少可显式传 `tabs=1`。风控收紧时把 `host/config.json` 的 `browser_concurrency` 设为 `1`，即回到全局串行。

**4. 并发需要 v1.5.1 版扩展，否则自动降级为串行。** 旧扩展的 `chrome_navigate` 只按 `pathname + search` 判断「URL 是否已打开」，而药师帮是 hash 路由（`#/indexContent?...&page=N`）——所有页码的 pathname 都是 `/`，会被判成同一个 URL 而直接复用标签、根本不导航。装完 1.5.1 后**要在 `chrome://extensions` 点一次重新加载**。没重载也能用，只是 `tabs>1` 会自动退回串行，响应里会写明 `concurrency.degrade_reason = "tab_reuse_extension_reused_tab"`。
