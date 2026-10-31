/**
 * 插件：file-stats —— 文件访问统计
 *
 * 介入方式：onResponse 响应后置钩子（统计 /file/* 的 200 GET 响应）
 *
 * 行为：
 *   1. 浏览器或程序成功取走文件（GET /file/... 返回 200）时计数
 *   2. 计数按文件路径分别存 KV：plugins:file-stats:count:<编码路径>
 *   3. 最近访问流水存 KV：plugins:file-stats:recent（环形 50 条）
 *   4. 管理面板 /plugins/file-stats/ 展示 Top 榜 / 总量 / 最近流水
 *
 * 鉴权：统计接口与重置接口仅管理员；统计写入本身无需鉴权（只记路径与次数，
 * 不记录任何访问者身份信息，无隐私敏感数据）。
 *
 * 已知限制（如实告知）：
 *   - KV 无原子自增，多实例并发写入可能丢失少量计数（尽力而为语义）
 *   - 免费版 KV 每天约 1000 次写入上限，高频站可能触顶，
 *     触顶后统计暂停（不影响文件访问本身），适合个人量级
 */

import { ASSET_MAP, PLUGIN_VERSION } from './_assets.js';

const COUNT_PREFIX = 'plugins:file-stats:count:';
const RECENT_KEY = 'plugins:file-stats:recent';
const RECENT_LIMIT = 50;
const MAX_KEYS_SCAN = 5000;

// ==================== 纯函数（可测试） ====================

/** 归一化统计路径：仅保留 pathname，限制长度。返回 null 表示不应统计 */
export function normalizeStatsPath(pathname) {
    if (typeof pathname !== 'string') return null;
    if (pathname !== '/file' && !pathname.startsWith('/file/')) return null;
    if (pathname.length > 512) return null;
    return pathname;
}

/** 统计页聚合（纯函数）：把 KV 记录数组转为 Top 榜与总量 */
export function aggregateStats(records) {
    const list = (records || [])
        .filter(r => r && typeof r.path === 'string' && Number.isFinite(r.n))
        .map(r => ({ path: r.path, n: Math.max(0, Math.floor(r.n)), last: r.last || null }));
    const total = list.reduce((s, r) => s + r.n, 0);
    list.sort((a, b) => b.n - a.n);
    return { total, files: list };
}

// ==================== 统计写入 ====================

async function recordHit(env, path, waitUntil) {
    const enc = encodeURIComponent(path).slice(0, 300);
    const countKey = COUNT_PREFIX + enc;
    const now = Math.floor(Date.now() / 1000);

    const doWrite = async () => {
        try {
            let cur = null;
            try {
                cur = JSON.parse((await env.img_url.get(countKey)) || 'null');
            } catch (e) { cur = null; }
            const n = (cur && Number.isFinite(cur.n) ? cur.n : 0) + 1;
            await env.img_url.put(countKey, JSON.stringify({ path, n, last: now }));

            let recent = [];
            try {
                recent = JSON.parse((await env.img_url.get(RECENT_KEY)) || '[]');
            } catch (e) { recent = []; }
            if (!Array.isArray(recent)) recent = [];
            recent.unshift({ p: path, t: now });
            await env.img_url.put(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_LIMIT)));
        } catch (e) {
            console.warn('[plugins] file-stats 写入失败（可能已达每日 KV 写入限额）:', e);
        }
    };

    if (typeof waitUntil === 'function') {
        waitUntil(doWrite()); // 不阻塞响应返回
    } else {
        await doWrite();
    }
}

// ==================== 响应钩子 ====================

export async function onResponse(context) {
    const { request, env, url, response, waitUntil } = context;

    if (request.method !== 'GET') return response;
    if (response.status !== 200) return response;

    const path = normalizeStatsPath(url.pathname);
    if (!path) return response;

    await recordHit(env, path, waitUntil);
    return response;
}

// ==================== 管理面板 ====================

async function isAdmin(context) {
    const { env, request, url } = context;
    try {
        const { authenticate, AUTH_SCOPE } = await import('../functions/utils/auth/authCore.js');
        const result = await authenticate({
            env, request, url, authScope: AUTH_SCOPE.ADMIN,
        });
        return Boolean(result && result.authorized);
    } catch (e) {
        console.warn('[plugins] file-stats 鉴权模块加载失败:', e);
        return false;
    }
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

async function readAllStats(env) {
    const records = [];
    let cursor = undefined;
    let scanned = 0;
    do {
        const page = await env.img_url.list({ prefix: COUNT_PREFIX, cursor, limit: 100 });
        const keys = (page.keys || []).map(k => k.name).filter(n => n.startsWith(COUNT_PREFIX));
        scanned += keys.length;
        // 并发分批读取，避免串行太慢
        for (let i = 0; i < keys.length; i += 20) {
            const batch = keys.slice(i, i + 20);
            const values = await Promise.all(batch.map(k => env.img_url.get(k)));
            values.forEach((raw, j) => {
                try {
                    const obj = JSON.parse(raw || 'null');
                    if (obj && typeof obj.path === 'string') records.push(obj);
                } catch (e) { /* 跳过坏记录 */ }
            });
        }
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && scanned < MAX_KEYS_SCAN);
    return records;
}

export async function handleRoute(context, subPath) {
    const { request, env } = context;

    if (request.method === 'GET' && (subPath === '' || subPath === 'manager' || subPath === 'index.html')) {
        const html = ASSET_MAP['manager.html'];
        if (html) {
            return new Response(html, {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
            });
        }
    }

    if (subPath === 'api/stats' && request.method === 'GET') {
        if (!(await isAdmin(context))) {
            return jsonResponse({ error: 'unauthorized' }, 401);
        }
        let records = [];
        try {
            records = await readAllStats(env);
        } catch (e) {
            return jsonResponse({ error: 'kv_read_failed' }, 500);
        }
        const agg = aggregateStats(records);
        let recent = [];
        try {
            recent = JSON.parse((await env.img_url.get(RECENT_KEY)) || '[]');
        } catch (e) { recent = []; }
        if (!Array.isArray(recent)) recent = [];
        return jsonResponse({
            total: agg.total,
            fileCount: agg.files.length,
            files: agg.files.slice(0, 50),
            recent: recent.slice(0, RECENT_LIMIT),
        });
    }

    if (subPath === 'api/reset' && request.method === 'POST') {
        if (!(await isAdmin(context))) {
            return jsonResponse({ error: 'unauthorized' }, 401);
        }
        try {
            let cursor = undefined;
            do {
                const page = await env.img_url.list({ prefix: COUNT_PREFIX, cursor, limit: 100 });
                await Promise.all((page.keys || []).map(k => env.img_url.delete(k.name)));
                cursor = page.list_complete ? undefined : page.cursor;
            } while (cursor);
            await env.img_url.delete(RECENT_KEY);
        } catch (e) {
            return jsonResponse({ error: 'kv_delete_failed' }, 500);
        }
        return jsonResponse({ ok: true });
    }

    if (subPath === 'version') {
        return jsonResponse({ plugin: 'file-stats', version: PLUGIN_VERSION });
    }

    return new Response('Not Found', { status: 404 });
}
