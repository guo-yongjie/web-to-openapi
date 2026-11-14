"use strict";
/*
 * 站点: 服务自身能力(不属于任何具体网页)
 * 与站点模块同构, 因此 health / browser_tool 也自动出现在 MCP 工具列表与文档里。
 */
const { CONFIG, SERVICE, VERSION, PAGE_MODES } = require("../lib/config");
const state = require("../lib/state");
const nm = require("../lib/nm");
const stats = require("../lib/stats");
const ysbangStore = require("./ysbang-store");
const { callTool, withBrowserLock } = require("../lib/util");

function health() {
  return {
    status: "ok",
    service: SERVICE,
    version: VERSION,
    listen: `http://${CONFIG.host}:${state.httpPort || CONFIG.port}`,
    extension_connected: nm.isConnected(),
    uptime_s: state.startedAt ? Math.floor((Date.now() - state.startedAt.getTime()) / 1000) : null,
    // 页面打开策略: tab(后台标签, 默认, 不弹窗) / window(不激活的独立窗口) / window-front(弹窗)
    page_mode: CONFIG.page_mode,
    page_modes: PAGE_MODES,
  };
}

// v1.6.0: 运行观测 —— 各端点调用次数/耗时/失败率 + 药师帮缓存与熔断状态。
// 数据只在内存里, host 重启即从零计(生命周期本来就跟浏览器走)。
function serviceStats() {
  return {
    service: SERVICE,
    version: VERSION,
    uptime_s: state.startedAt ? Math.floor((Date.now() - state.startedAt.getTime()) / 1000) : null,
    requests: stats.snapshot(),
    ysbang: ysbangStore.stats(),
  };
}

async function browserTool(args) {
  const name = args && args.name;
  if (!name) throw new Error("browser_tool requires args.name");
  return await withBrowserLock(() => callTool(name, (args && args.args) || {}));
}

module.exports = {
  id: "service",
  title: "服务自身",
  endpoints: [
    {
      method: "GET",
      path: "/health",
      tool: "service_health",
      operationId: "health",
      summary: "存活探针",
      description: "存活探针: 服务状态、扩展连接状态、运行时长、当前页面打开策略(page_mode)。",
      responses: { 200: { description: "服务状态" } },
      run: health,
      doc: { note: "存活探针: 服务状态、扩展连接状态、运行时长、当前页面打开策略(page_mode)。" },
    },
    {
      method: "GET",
      path: "/stats",
      tool: "service_stats",
      operationId: "stats",
      summary: "运行观测(端点调用统计 + 药师帮缓存/熔断状态)",
      description: "v1.6.0: 各端点调用次数/平均与最大耗时/失败数(自 host 启动起), 药师帮缓存命中率与熔断冷却状态。数据在内存中, host 重启即清零。",
      responses: { 200: { description: "观测数据" } },
      run: serviceStats,
      doc: { note: "只读观测, 不触发任何浏览器操作。" },
    },
  ],
  tools: [
    {
      name: "service_health",
      description: "查看 web-to-openapi 服务健康状态。返回 {status,service,version,listen,extension_connected,uptime_s,page_mode}: 服务是否在监听、浏览器扩展(Edge / Chrome)是否连通、运行时长(秒)、当前页面打开策略(tab=后台标签不弹窗, window=不激活的独立窗口, window-front=弹窗)。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: health,
    },
    {
      name: "service_stats",
      description: "查看 web-to-openapi 运行观测(v1.6.0): requests.endpoints 各端点调用次数/平均与最大耗时/错误数; ysbang.cache 药师帮缓存(条数/命中/写入/落盘文件); ysbang.block 熔断状态(是否冷却中/剩余秒数/累计次数)。只读, 不触发浏览器操作。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: serviceStats,
    },
    {
      name: "browser_tool",
      description: "透传调用任意浏览器工具(经浏览器扩展执行, 完整列表见 GET /api/v1/tools)。常用: chrome_navigate(打开 URL, 返回 tabId) / chrome_javascript(在指定标签页执行 JS) / chrome_read_page(读取页面结构) / get_windows_and_tabs(窗口与标签列表) / chrome_screenshot(截图)。适合固化端点覆盖不到的场景。",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "工具名, 如 chrome_javascript / chrome_navigate / chrome_read_page / get_windows_and_tabs / chrome_screenshot" },
          args: { type: "object", description: "工具参数对象(各工具字段不同, 如 chrome_javascript 需要 {tabId, code})" },
        },
        required: ["name"],
      },
      // 自己内部包浏览器锁(HTTP 透传端点同样调用它), 不再由框架重复加锁
      run: browserTool,
    },
  ],
};
