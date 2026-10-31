/**
 * cf-imgbed 插件加载器（运行时核心）
 *
 * 职责：
 *   1. 读取 _registry.js 中静态注册的插件（由 scan.mjs 递归扫描生成）
 *   2. 提供三种介入点：
 *      - handlePluginRoute() : 处理 /plugins/<name>/... 命名空间路由
 *      - runRequestHooks()   : 在原路由执行前，允许插件拦截请求
 *      - runResponseHooks()  : 在原路由返回后，允许插件改写响应
 *   3. 插件崩溃时自动降级，不影响主站任何功能
 *   4. 运行时开关：停用状态存入 KV（img_url 命名空间，键 plugins:disabled），
 *      通过 /plugins/_manager/ 管理页热切换，无需重新部署
 *
 * 本文件属于「插件系统本体」，与原项目文件零耦合，上游更新无需改动。
 */

import { PLUGINS } from './_registry.js';
import { handleManagerRoute } from './_manager.js';

const PLUGIN_URL_PREFIX = '/plugins/';

// ==================== 插件注册与初始化 ====================

const ALLOWED_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE']);

/** 归一化插件声明的可路由方法：非法值一律剔除，默认只读 */
function normalizeAllowMethods(declared) {
    if (!Array.isArray(declared)) return [];
    return declared
        .filter(m => typeof m === 'string')
        .map(m => m.toUpperCase())
        .filter(m => ALLOWED_HTTP_METHODS.has(m));
}

/** 判断插件是否声明了某方法（GET/HEAD 由网关统一放行，不查此表） */
function pluginAllowsMethod(plugin, method) {
    return Array.isArray(plugin && plugin.allowMethods) && plugin.allowMethods.includes(method);
}

let initPromise = null;

/** 已解析的插件列表（plugin.json 中 enabled 的插件，按 order 升序） */
let activePlugins = [];

function resolvePlugins() {
    const list = [];
    for (const entry of PLUGINS) {
        try {
            const mod = entry.module && entry.module.default ? entry.module.default : entry.module;
            if (!mod || typeof mod !== 'object') continue;
            list.push({
                name: entry.name,
                displayName: entry.displayName || entry.name,
                version: entry.version || '0.0.0',
                order: Number.isFinite(entry.order) ? entry.order : 100,
                enabled: entry.enabled !== false,
                // 允许的 HTTP 方法（插件路由安全边界：默认只读）
                allowMethods: normalizeAllowMethods(entry.allowMethods),
                module: mod,
            });
        } catch (e) {
            console.warn(`[plugins] 注册插件 ${entry.name} 失败:`, e);
        }
    }
    return list.filter(p => p.enabled).sort((a, b) => a.order - b.order);
}

/** 惰性初始化：每个 Worker 实例只执行一次 */
async function ensureInit(env) {
    if (!initPromise) {
        initPromise = (async () => {
            activePlugins = resolvePlugins();
            for (const plugin of activePlugins) {
                if (typeof plugin.module.init === 'function') {
                    try {
                        await plugin.module.init({
                            env,
                            pluginName: plugin.name,
                            pluginVersion: plugin.version,
                        });
                        console.log(`[plugins] 已加载 ${plugin.name}@${plugin.version}`);
                    } catch (e) {
                        console.warn(`[plugins] 插件 ${plugin.name} init 失败（已禁用）:`, e);
                        plugin.enabled = false;
                    }
                }
            }
        })();
    }
    return initPromise;
}

// ==================== 运行时开关（KV 持久化） ====================

const DISABLED_KEY = 'plugins:disabled';
const SWITCH_CACHE_TTL_MS = 10 * 1000; // 短缓存，避免每个请求都读 KV

let switchCache = { value: new Set(), ts: 0, ready: null };

/** 读取停用插件集合（带短缓存；无 KV 绑定时退化为内存态） */
async function getDisabledSet(env) {
    const now = Date.now();
    if (switchCache.ready && now - switchCache.ts < SWITCH_CACHE_TTL_MS) {
        return switchCache.value;
    }
    if (!switchCache.ready) {
        switchCache.ready = (async () => {
            try {
                const raw = await env.img_url.get(DISABLED_KEY);
                const names = raw ? JSON.parse(raw) : [];
                switchCache.value = new Set(Array.isArray(names) ? names.filter(n => typeof n === 'string') : []);
            } catch (e) {
                // 无 KV 绑定或读取失败：退化为内存态（开关仍可用，但重启后还原）
                switchCache.value = new Set(switchCache.value || []);
            }
            switchCache.ts = now;
        })();
    }
    await switchCache.ready;
    switchCache.ready = null; // 下次到期后重新读取
    return switchCache.value;
}

/** 写入停用插件集合（KV + 更新缓存） */
async function setDisabledSet(env, set) {
    const names = Array.from(set);
    switchCache.value = new Set(names);
    switchCache.ts = Date.now();
    switchCache.ready = null;
    try {
        await env.img_url.put(DISABLED_KEY, JSON.stringify(names));
    } catch (e) {
        console.warn('[plugins] 开关状态写入 KV 失败（仅内存生效）:', e);
    }
}

/** 查询单个插件的运行时启用状态 */
async function isRuntimeEnabled(env, name) {
    const disabled = await getDisabledSet(env);
    return !disabled.has(name);
}

/** 供管理模块读取/修改开关状态 */
export async function getPluginStatuses(env) {
    await ensureInit(env);
    const disabled = await getDisabledSet(env);
    return activePlugins.map(p => ({
        name: p.name,
        displayName: p.displayName,
        version: p.version,
        order: p.order,
        installed: true,
        runtimeEnabled: !disabled.has(p.name),
    }));
}

export async function setPluginEnabled(env, name, enabled) {
    await ensureInit(env);
    const plugin = activePlugins.find(p => p.name === name);
    if (!plugin) return { ok: false, error: `Plugin not found: ${name}` };
    const disabled = new Set(await getDisabledSet(env));
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await setDisabledSet(env, disabled);
    return { ok: true, name, runtimeEnabled: enabled };
}

// ==================== 路由分发 ====================

/**
 * 判断请求是否属于插件命名空间（/plugins/<name>/...）
 */
export function isPluginRoute(pathname) {
    return pathname === '/plugins' || pathname.startsWith(PLUGIN_URL_PREFIX);
}

/**
 * 分发 /plugins/<name>/<subPath> 请求到对应插件
 * 供 functions/plugins/[[path]].js 网关调用，也被根中间件优先拦截。
 * _manager 命名空间保留给插件管理面板。
 */
export async function handlePluginRoute(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    await ensureInit(env);

    const parts = url.pathname.split('/').filter(Boolean); // ['plugins', name, ...rest]
    const pluginName = parts[1] || '';
    const subPath = parts.slice(2).join('/');

    // ---- 内置管理面板 ----
    if (pluginName === '_manager') {
        return await handleManagerRoute(context, subPath);
    }

    const plugin = activePlugins.find(p => p.name === pluginName);
    if (!plugin) {
        return new Response(
            JSON.stringify({ error: `Plugin not found: ${pluginName}` }),
            { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
    }

    // 方法白名单：GET/HEAD 始终允许；其余方法需插件在 plugin.json
    // 中通过 allowMethods 显式声明（默认只读，缩小攻击面）
    if (request.method !== 'GET' && request.method !== 'HEAD' && !pluginAllowsMethod(plugin, request.method)) {
        return new Response('Method Not Allowed', { status: 405 });
    }
    if (!(await isRuntimeEnabled(env, pluginName))) {
        return new Response(
            JSON.stringify({ error: `Plugin disabled: ${pluginName}` }),
            { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
    }
    if (typeof plugin.module.handleRoute !== 'function') {
        return new Response(
            JSON.stringify({ error: `Plugin ${pluginName} has no routes` }),
            { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
    }

    try {
        const response = await plugin.module.handleRoute(
            { request, env, url, subPath, plugin },
            subPath
        );
        return response || new Response('Not Found', { status: 404 });
    } catch (e) {
        console.error(`[plugins] 插件 ${pluginName} 路由处理出错:`, e);
        return new Response('Plugin Route Error', { status: 500 });
    }
}

// ==================== 请求 / 响应钩子 ====================

/**
 * 请求前置钩子：在任何原路由执行之前调用。
 * 返回 Response 则直接返回给客户端；返回 null 继续原流程。
 * 插件命名空间的请求优先分发给插件。
 */
export async function runRequestHooks(context) {
    const { request, env } = context;
    let url;
    try {
        url = new URL(request.url);
    } catch (e) {
        return null;
    }

    // 插件命名空间优先
    if (isPluginRoute(url.pathname)) {
        try {
            return await handlePluginRoute(context);
        } catch (e) {
            console.error('[plugins] 插件路由出错，回退静态资源:', e);
            return null;
        }
    }

    try {
        await ensureInit(env);
    } catch (e) {
        console.warn('[plugins] 初始化失败，本次请求跳过钩子:', e);
        return null;
    }

    for (const plugin of activePlugins) {
        if (typeof plugin.module.onRequest !== 'function') continue;
        if (!(await isRuntimeEnabled(env, plugin.name))) continue;
        try {
            const response = await plugin.module.onRequest({ request, env, url, plugin });
            if (response) return response;
        } catch (e) {
            console.warn(`[plugins] 插件 ${plugin.name} onRequest 钩子出错（忽略）:`, e);
        }
    }
    return null;
}

/**
 * 响应后置钩子：在原路由返回响应之后调用。
 * 插件可返回新 Response 或修改后的 Response；异常时保持原响应。
 */
export async function runResponseHooks(context, response) {
    const { request, env } = context;
    if (!response) return response;

    let url;
    try {
        url = new URL(request.url);
    } catch (e) {
        return response;
    }

    // 插件命名空间的响应由插件路由自己负责
    if (isPluginRoute(url.pathname)) return response;

    try {
        await ensureInit(env);
    } catch (e) {
        return response;
    }

    for (const plugin of activePlugins) {
        if (typeof plugin.module.onResponse !== 'function') continue;
        if (!(await isRuntimeEnabled(env, plugin.name))) continue;
        try {
            const next = await plugin.module.onResponse({ request, env, url, response, plugin }, response);
            if (next instanceof Response) response = next;
        } catch (e) {
            console.warn(`[plugins] 插件 ${plugin.name} onResponse 钩子出错（保持原响应）:`, e);
        }
    }
    return response;
}
