/**
 * 插件：referer-guard —— 防盗链（Referer 白名单）
 *
 * 介入方式：onRequest 请求前置钩子（在原路由执行前拦截 /file/* 请求）
 *
 * 行为：
 *   1. 仅拦截浏览器对 /file/* 的 GET/HEAD 请求
 *   2. 请求带 Referer：解析其 host，命中白名单（精确或子域后缀）→ 放行；
 *      未命中 → 返回 403
 *   3. 请求不带 Referer（直接打开地址栏/书签/新窗口）：
 *      按 allowEmptyReferer 配置决定放行或拒绝
 *   4. /plugins/、/manage、/login、/api 等管理路径一律不拦截
 *
 * 安全默认：安装后默认停用拦截（enabled:false），需在管理面板
 * /plugins/referer-guard/ 中显式开启，避免一上线就误伤。
 *
 * 配置存 KV（img_url 命名空间，键 plugins:referer-guard:config）：
 *   { "enabled": false, "allowEmptyReferer": true, "whitelist": ["example.com"] }
 */

const CONFIG_KEY = 'plugins:referer-guard:config';
const CONFIG_CACHE_MS = 10 * 1000;

const DEFAULT_CONFIG = {
    enabled: false,
    allowEmptyReferer: true,
    whitelist: [],
};

let configCache = { value: null, ts: 0 };

// ==================== 配置读写 ====================

function sanitizeConfig(raw) {
    let cfg = DEFAULT_CONFIG;
    if (raw) {
        try {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object') cfg = obj;
        } catch (e) { /* 配置损坏时用默认值 */ }
    }
    const whitelist = Array.isArray(cfg.whitelist)
        ? cfg.whitelist
            .filter(h => typeof h === 'string')
            .map(h => h.trim().toLowerCase().replace(/^\.+/, ''))
            .filter(h => h.length > 0 && h.length <= 253 && /^[a-z0-9.*-]+$/.test(h) && !h.includes('/'))
        : [];
    return {
        enabled: cfg.enabled === true,
        allowEmptyReferer: cfg.allowEmptyReferer !== false,
        whitelist: [...new Set(whitelist)].slice(0, 200),
    };
}

async function getConfig(env) {
    const now = Date.now();
    if (configCache.value && now - configCache.ts < CONFIG_CACHE_MS) {
        return configCache.value;
    }
    let raw = null;
    try {
        raw = await env.img_url.get(CONFIG_KEY);
    } catch (e) {
        raw = null;
    }
    const value = sanitizeConfig(raw);
    configCache = { value, ts: now };
    return value;
}

async function saveConfig(env, cfg) {
    configCache = { value: cfg, ts: Date.now() };
    await env.img_url.put(CONFIG_KEY, JSON.stringify(cfg));
}

// ==================== 判定逻辑（纯函数，可测试） ====================

/** 校验白名单条目与 Referer host 是否匹配（精确或子域后缀） */
export function hostMatchesWhitelist(host, whitelist) {
    if (!host) return false;
    const h = String(host).toLowerCase();
    for (const entry of whitelist) {
        if (h === entry) return true;
        if (h.endsWith('.' + entry)) return true;
    }
    return false;
}

/**
 * 防盗链判定（纯函数）
 * @returns 'allow' | 'deny' —— 空 Referer 按 allowEmptyReferer 策略处理
 */
export function checkRefererPolicy(refererValue, config) {
    if (!config || config.enabled !== true) return 'allow';
    const referer = String(refererValue || '').trim();
    if (!referer) {
        return config.allowEmptyReferer !== false ? 'allow' : 'deny';
    }
    let host = '';
    try {
        host = new URL(referer).hostname.toLowerCase();
    } catch (e) {
        return 'deny'; // 非法 Referer 一律拒绝
    }
    return hostMatchesWhitelist(host, config.whitelist) ? 'allow' : 'deny';
}

// ==================== 请求钩子 ====================

export async function onRequest(context) {
    const { request, env, url } = context;

    if (url.pathname !== '/file' && !url.pathname.startsWith('/file/')) return null;
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;

    let config;
    try {
        config = await getConfig(env);
    } catch (e) {
        return null; // 配置读取失败：放行（安全降级为不拦截）
    }

    const verdict = checkRefererPolicy(request.headers.get('Referer'), config);
    if (verdict === 'allow') return null;

    const body = request.method === 'HEAD' ? null : '403 Forbidden: hotlinking is not allowed\n';
    return new Response(body, {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

// ==================== 管理面板路由 ====================

async function isAdmin(context) {
    const { env, request, url } = context;
    try {
        const { authenticate, AUTH_SCOPE } = await import('../functions/utils/auth/authCore.js');
        const result = await authenticate({
            env, request, url, authScope: AUTH_SCOPE.ADMIN,
        });
        return Boolean(result && result.authorized);
    } catch (e) {
        console.warn('[plugins] referer-guard 鉴权模块加载失败:', e);
        return false;
    }
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

export async function handleRoute(context, subPath) {
    const { request, env } = context;

    if (subPath === 'api/config' && request.method === 'GET') {
        if (!(await isAdmin(context))) {
            return jsonResponse({ error: 'unauthorized' }, 401);
        }
        return jsonResponse({ config: await getConfig(env) });
    }

    if (subPath === 'api/save' && request.method === 'POST') {
        if (!(await isAdmin(context))) {
            return jsonResponse({ error: 'unauthorized' }, 401);
        }
        let body;
        try {
            body = await request.json();
        } catch (e) {
            return jsonResponse({ error: 'invalid_json' }, 400);
        }
        const cfg = sanitizeConfig(JSON.stringify({
            enabled: body.enabled === true,
            allowEmptyReferer: body.allowEmptyReferer !== false,
            whitelist: body.whitelist,
        }));
        try {
            await saveConfig(env, cfg);
        } catch (e) {
            return jsonResponse({ error: 'kv_write_failed' }, 500);
        }
        return jsonResponse({ ok: true, config: cfg });
    }

    if (request.method === 'GET' && (subPath === '' || subPath === 'manager' || subPath === 'index.html')) {
        const { ASSET_MAP } = await import('./_assets.js');
        const html = ASSET_MAP['manager.html'];
        if (html) {
            return new Response(html, {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
            });
        }
    }

    if (subPath === 'version') {
        return jsonResponse({ plugin: 'referer-guard', version: '1.0.0' });
    }

    return new Response('Not Found', { status: 404 });
}
