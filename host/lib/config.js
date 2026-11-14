"use strict";
/*
 * 配置: 同目录 config.json {host,port,tool_timeout_ms}
 * 覆盖优先级(低 -> 高): 内置默认 < config.json < CLI --host/--port < 环境变量
 *   WEBTOOPENAPI_HOST / WEBTOOPENAPI_PORT / WEBTOOPENAPI_TOOL_TIMEOUT_MS
 * 读取失败不抛异常, 只把原因放进 CONFIG.warnings(由启动方打印), 保证 host 一定能起来。
 */
const fs = require("fs");
const path = require("path");

const HOST_DIR = path.join(__dirname, "..");
const PAGE_MODES = ["auto", "tab", "window", "window-front"];
const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 8090,
  tool_timeout_ms: 120000,
  // 页面打开策略(见 util.openPage):
  //   "auto"         按站点自选(默认): 轻量页面用后台标签, 渲染重的页面(如谷歌)用独立但不激活的窗口
  //   "tab"          一律后台标签: 不新建窗口、不抢焦点; 代价是后台标签会被浏览器节流(谷歌实测慢 4 倍)
  //   "window"       一律独立窗口但不激活(focused:false)
  //   "window-front" 独立窗口并激活: 旧行为, 每次调用都弹窗抢焦点
  page_mode: "auto",
  // v1.5.0: 浏览器并发槽上限。0 = 按站点声明(ysbang 3, 其余 1, 与旧版行为一致);
  // >0 = 对所有站点强制封顶(设 1 即恢复「全局串行」的旧语义)。风控收紧时用它。
  browser_concurrency: 0,
  // ---------------------------------------------------------------------------
  // 安全策略(2026-10-19 加固, 见 CHANGELOG v1.0.1)
  // allowed_origins: 额外的跨域白名单。默认空数组 —— 只放行 chrome-extension://(扩展自身)与
  //                  localhost/127.0.0.1(本机页面), 其他浏览器 Origin 一律 403。
  //                  需要给某个内网页面开权限时显式加, 例: ["http://192.168.1.10:3000"]
  // token:           非空时, 除 /health 与 /docs 外的所有请求都必须带
  //                  Authorization: Bearer <token> 或 ?token=<token>。
  //                  默认空 = 不启用(兼容现有脚本); 与他人共用机器时建议开启。
  allowed_origins: [],
  token: "",
};

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG, warnings: [] };
  let configPath = path.join(HOST_DIR, "config.json");
  const args = process.argv.slice(2);
  const cli = {}; // v1.7.1 修复: 命令行此前被 config.json 覆盖, 与注释声明的优先级相反
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) configPath = args[i + 1];
    if (args[i] === "--host" && args[i + 1]) cli.host = args[i + 1];
    if (args[i] === "--port" && args[i + 1]) cli.port = parseInt(args[i + 1], 10);
  }
  try {
    const fileCfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (fileCfg.host) cfg.host = fileCfg.host;
    if (fileCfg.port) cfg.port = parseInt(fileCfg.port, 10);
    if (fileCfg.tool_timeout_ms) cfg.tool_timeout_ms = parseInt(fileCfg.tool_timeout_ms, 10);
    if (fileCfg.page_mode) cfg.page_mode = String(fileCfg.page_mode).trim().toLowerCase();
    if (fileCfg.browser_concurrency !== undefined) cfg.browser_concurrency = parseInt(fileCfg.browser_concurrency, 10) || 0;
    // allowed_origins: 允许数组, 或逗号/空格分隔的字符串; 统一成去空格、去尾斜杠的数组
    if (fileCfg.allowed_origins !== undefined) {
      const raw = Array.isArray(fileCfg.allowed_origins)
        ? fileCfg.allowed_origins
        : String(fileCfg.allowed_origins).split(/[,\s]+/);
      cfg.allowed_origins = raw
        .map((s) => String(s || "").trim().replace(/\/+$/, ""))
        .filter(Boolean);
    }
    if (typeof fileCfg.token === "string") cfg.token = fileCfg.token.trim();
  } catch (e) {
    cfg.warnings.push(`config.json 读取失败(${e.message}), 使用默认/环境变量配置`);
  }
  if (process.env.WEBTOOPENAPI_HOST) cfg.host = process.env.WEBTOOPENAPI_HOST;
  if (process.env.WEBTOOPENAPI_PORT) cfg.port = parseInt(process.env.WEBTOOPENAPI_PORT, 10);
  // 命令行的优先级高于 config.json(与文件头注释一致): 放在文件之后、环境变量之前应用
  if (cli.host) cfg.host = cli.host;
  if (Number.isFinite(cli.port)) cfg.port = cli.port;
  if (process.env.WEBTOOPENAPI_TOOL_TIMEOUT_MS) cfg.tool_timeout_ms = parseInt(process.env.WEBTOOPENAPI_TOOL_TIMEOUT_MS, 10);
  if (process.env.WEBTOOPENAPI_PAGE_MODE) cfg.page_mode = process.env.WEBTOOPENAPI_PAGE_MODE.trim().toLowerCase();
  if (process.env.WEBTOOPENAPI_BROWSER_CONCURRENCY) cfg.browser_concurrency = parseInt(process.env.WEBTOOPENAPI_BROWSER_CONCURRENCY, 10) || 0;
  // v1.7.1: token 支持环境变量覆盖 —— 便于不把密钥写进任何文件(CI / 多机同步 / 临时收紧)
  if (process.env.WEBTOOPENAPI_TOKEN) cfg.token = process.env.WEBTOOPENAPI_TOKEN.trim();
  if (!PAGE_MODES.includes(cfg.page_mode)) {
    cfg.warnings.push(`page_mode "${cfg.page_mode}" 不合法(可选 ${PAGE_MODES.join(" / ")}), 已回退为 auto`);
    cfg.page_mode = "auto";
  }
  cfg.configPath = configPath;
  return cfg;
}

const CONFIG = loadConfig();
const SERVICE = "web-to-openapi";
// 本地加固版本号(v1.8.0: 可信动作层 act/observe+click+type, 带回执与门禁)。
// 上游发版时请核对 diff 后再合并。
const VERSION = "1.8.0";

// 本地状态目录(默认参数持久化也放这里)
const STATE_DIR = process.env.LOCALAPPDATA || HOST_DIR;

module.exports = { HOST_DIR, STATE_DIR, CONFIG, SERVICE, VERSION, PAGE_MODES };
