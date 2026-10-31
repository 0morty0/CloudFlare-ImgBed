/**
 * 根中间件 = 原有运行时标记 + 插件系统钩子
 *
 * 第一段（原有逻辑，保留勿删）：自定义适配器通过请求上下文声明平台；
 *   Pages 使用原生 Functions 入口。覆盖同名环境变量，
 *   避免用户配置将 Pages/Workers 误判为 Node。
 *
 * 第二段（插件系统，cf-imgbed-plugins-kit 接入）：
 *   请求前 → 插件请求钩子（含 /plugins/ 命名空间分发）
 *   请求后 → 插件响应钩子（文件预览等在此生效）
 *   插件本体位于仓库根目录 plugins/ 文件夹，与原项目代码完全隔离。
 *   插件出错时自动降级为直接放行，不影响主站。
 */

import { runRequestHooks, runResponseHooks } from '../plugins/_loader.js';

export async function onRequest(context) {
    // --- 原有逻辑：运行时环境标记 ---
    const runtime = context.data.serverRuntime;
    context.env.SERVER_RUNTIME = runtime === 'node' || runtime === 'worker' ? runtime : 'pages';

    // --- 插件系统：请求钩子（可拦截 /plugins/<name>/... 命名空间路由）---
    let intercepted = null;
    try {
        intercepted = await runRequestHooks(context);
    } catch (e) {
        console.warn('[plugins] 请求钩子异常，按原流程处理:', e);
    }
    if (intercepted) return intercepted;

    // 原始路由 / 静态资源处理
    const response = await context.next();

    // --- 插件系统：响应钩子（文件预览在此生效）---
    try {
        return await runResponseHooks(context, response);
    } catch (e) {
        console.warn('[plugins] 响应钩子异常，返回原响应:', e);
        return response;
    }
}
