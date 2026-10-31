/**
 * cf-imgbed 插件网关路由（/plugins/<name>/...）
 *
 * 这是原项目中需要「新增」的 2 个文件之二。
 * 作用：让 /plugins/* 命名空间在三种部署模式下都能命中路由：
 *   - Pages：文件路由天然生效
 *   - Worker：deploy/worker/generate-routes.js 自动扫描本文件，无需改它
 *   - Docker：在 deploy/server/index.js 的 FUNCTION_PREFIXES 中加入 '/plugins'（可选，1 行）
 *
 * 通常请求会先被 functions/_middleware.js 拦截并分发到插件，
 * 本文件作为兜底入口，保证没有根中间件时插件路由依然可用。
 */

import { handlePluginRoute } from '../../plugins/_loader.js';

export async function onRequest(context) {
    return await handlePluginRoute(context);
}
