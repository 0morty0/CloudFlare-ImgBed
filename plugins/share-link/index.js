/**
 * 插件：share-link —— 临时分享链接
 *
 * 介入方式：插件命名空间路由（/plugins/share-link/...），无需钩子
 *
 * 功能：为单个文件生成带过期时间的临时访问链接。
 *   - 链接形式：/plugins/share-link/view/<token>，不暴露真实文件路径
 *   - token = base64url(payload).base64url(HMAC-SHA256 签名)
 *     payload = { p: 文件路径, e: 过期时间戳, n: 随机 nonce }
 *   - 过期自动失效；管理员可随时撤回（nonce 进黑名单）
 *   - 访问时插件以同源子请求代理 /file/<path>?raw=1 的原始内容，
 *     并把访问者的 Cookie 头透传给内部请求——若访问者自己持有
 *     管理员/用户会话，受访问控制的文件同样可以打开
 *
 * 鉴权边界：
 *   - 生成 / 列表 / 撤回接口 → 仅管理员（复用原项目 authCore）
 *   - view/<token> → 任何人（这正是分享的意义），但必须持有有效 token
 *
 * 安全设计：
 *   - HMAC 密钥存 KV（plugins:share-link:secret），首次使用时随机生成
 *   - 签名比对使用恒定时间比较，防时序侧信道
 *   - 路径白名单校验：必须以 /file/ 开头、不含 ..、无控制字符
 *   - 代理响应强制 private 缓存，防止链接内容进入共享边缘缓存
 */

import { ASSET_MAP, PLUGIN_VERSION } from './_assets.js';

const SECRET_KEY = 'plugins:share-link:secret';
const ACTIVE_KEY = 'plugins:share-link:active';
const REVOKED_KEY = 'plugins:share-link:revoked';

const MAX_ACTIVE = 500;
const MAX_REVOKED = 1000;
const MAX_PATH_LEN = 500;
const MIN_HOURS = 0.5;
const MAX_HOURS = 24 * 30;

// ==================== 基础编解码 ====================

const B64_URL_SAFE = { '+': '-', '/': '_', '=': '' };

function b64urlEncode(bytes) {
    let s = btoa(String.fromCharCode(...bytes));
    s = s.replace(/[+/=]/g, c => B64_URL_SAFE[c] ?? '');
    return s;
}

function b64urlDecodeBytes(str) {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function b64urlDecodeText(str) {
    return new TextDecoder().decode(b64urlDecodeBytes(str));
}

/** 恒定时间比较（防时序攻击） */
function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

// ==================== 密钥与签名 ====================

async function getSecret(env) {
    const stored = await env.img_url.get(SECRET_KEY);
    if (stored) {
        const bytes = b64urlDecodeBytes(stored);
        if (bytes.length === 32) return bytes;
    }
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await env.img_url.put(SECRET_KEY, b64urlEncode(secret));
    return secret;
}

async function hmacSign(secret, dataText) {
    const key = await crypto.subtle.importKey(
        'raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dataText));
    return new Uint8Array(sig);
}

// ==================== token 逻辑（纯函数部分可测试） ====================

/** 校验用户提供的文件路径（已解码形式）。返回 true/false */
export function isValidSharePath(path) {
    if (typeof path !== 'string') return false;
    if (path.length === 0 || path.length > MAX_PATH_LEN) return false;
    if (path !== '/file' && !path.startsWith('/file/')) return false;
    if (/[^\x20-\x7E]/.test(path)) return false; // 仅允许可打印 ASCII
    if (path.includes('..')) return false;
    if (path.includes('\\')) return false;
    if (/[?#]/.test(path)) return false;
    return true;
}

/** 从 token 中解析 payload（不验签，仅结构校验）。供测试与解析用 */
export function parseTokenPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    try {
        const payload = JSON.parse(b64urlDecodeText(parts[0]));
        if (!payload || typeof payload !== 'object') return null;
        if (typeof payload.p !== 'string' || !isValidSharePath(payload.p)) return null;
        if (typeof payload.e !== 'number' || !Number.isFinite(payload.e) || payload.e <= 0) return null;
        if (typeof payload.n !== 'string' || !/^[0-9a-f]{16}$/.test(payload.n)) return null;
        return payload;
    } catch (e) {
        return null;
    }
}

export async function verifyToken(env, token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || parts[0].length > 1024 || parts[1].length > 128) {
        return { ok: false, reason: 'malformed' };
    }
    const payload = parseTokenPayload(token);
    if (!payload) return { ok: false, reason: 'malformed' };

    const secret = await getSecret(env);
    const expected = await hmacSign(secret, parts[0]);
    const given = b64urlDecodeBytes(parts[1]);
    if (!timingSafeEqual(expected, given)) {
        return { ok: false, reason: 'bad_signature' };
    }

    if (Date.now() / 1000 > payload.e) {
        return { ok: false, reason: 'expired' };
    }

    // 撤回检查
    let revoked = [];
    try {
        revoked = JSON.parse((await env.img_url.get(REVOKED_KEY)) || '[]');
    } catch (e) { revoked = []; }
    if (Array.isArray(revoked) && revoked.some(r => r && r.n === payload.n)) {
        return { ok: false, reason: 'revoked' };
    }

    return { ok: true, payload };
}

export async function createToken(env, path, hours) {
    const expSec = Math.floor(Date.now() / 1000 + hours * 3600);
    const nonce = [...crypto.getRandomValues(new Uint8Array(8))]
        .map(b => b.toString(16).padStart(2, '0')).join('');
    const payloadText = JSON.stringify({ p: path, e: expSec, n: nonce });
    const payloadB64 = b64urlEncode(new TextEncoder().encode(payloadText));
    const secret = await getSecret(env);
    const sig = await hmacSign(secret, payloadB64);
    return b64urlEncode(sig) !== '' ? `${payloadB64}.${b64urlEncode(sig)}` : null;
}

// ==================== active / revoked 列表维护 ====================

async function readList(env, key, max) {
    let list;
    try {
        list = JSON.parse((await env.img_url.get(key)) || '[]');
    } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    return list.filter(x => x && typeof x === 'object').slice(0, max);
}

async function saveActive(env, list) {
    await env.img_url.put(ACTIVE_KEY, JSON.stringify(list.slice(0, MAX_ACTIVE)));
}

// ==================== 鉴权 ====================

async function isAdmin(context) {
    const { env, request, url } = context;
    try {
        const { authenticate, AUTH_SCOPE } = await import('../functions/utils/auth/authCore.js');
        const result = await authenticate({
            env, request, url, authScope: AUTH_SCOPE.ADMIN,
        });
        return Boolean(result && result.authorized);
    } catch (e) {
        console.warn('[plugins] share-link 鉴权模块加载失败:', e);
        return false;
    }
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

// ==================== 代理取回文件 ====================

function errorPage(title, detail) {
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return new Response(
        `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>分享链接</title></head>` +
        `<body style="margin:0;font:14px/1.7 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#f6f8fa;color:#1f2328;display:flex;align-items:center;justify-content:center;min-height:100vh">` +
        `<div style="max-width:480px;margin:20px;padding:32px;background:#fff;border:1px solid #d0d7de;border-radius:12px;text-align:center">` +
        `<div style="font-size:17px;font-weight:700;color:#82071e">${esc(title)}</div>` +
        `<div style="color:#6e7781;font-size:13px;margin-top:10px">${esc(detail)}</div>` +
        `</div></body></html>`,
        {
            status: 200,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Robots-Tag': 'noindex',
            },
        }
    );
}

async function proxyFile(context, path) {
    const { request, url } = context;
    const origin = url.origin;
    const target = origin + path + (path.includes('?') ? '&' : '?') + 'raw=1';

    const headers = {};
    const cookie = request.headers.get('Cookie');
    if (cookie) headers['Cookie'] = cookie;
    const range = request.headers.get('Range');
    if (range) headers['Range'] = range;

    let resp;
    try {
        resp = await fetch(target, {
            method: 'GET',
            headers,
            redirect: 'follow',
        });
    } catch (e) {
        return errorPage('无法取得文件', '分享链接代理请求失败，请稍后重试');
    }

    if (resp.status === 401 || resp.status === 403) {
        return errorPage('文件受访问控制保护', '该文件处于白名单/鉴权模式。若你是管理员或授权用户，请先登录站点后再次打开此链接。');
    }
    if (resp.status === 404) {
        return errorPage('文件不存在', '分享的文件可能已被删除');
    }
    if (!resp.ok) {
        return errorPage('无法取得文件', '源服务器返回 HTTP ' + resp.status);
    }

    const out = new Headers();
    const passthrough = ['Content-Type', 'Content-Disposition', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'];
    for (const h of passthrough) {
        const v = resp.headers.get(h);
        if (v) out.set(h, v);
    }
    out.set('Cache-Control', 'private, max-age=60');
    out.set('X-Robots-Tag', 'noindex');

    return new Response(resp.body, { status: resp.status, headers: out });
}

// ==================== 路由入口 ====================

export async function handleRoute(context, subPath) {
    const { request, env, url } = context;

    // ---- 管理页 ----
    if (request.method === 'GET' && (subPath === '' || subPath === 'manager' || subPath === 'index.html')) {
        const html = ASSET_MAP['manager.html'];
        if (html) {
            return new Response(html, {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
            });
        }
    }

    // ---- 生成链接 ----
    if (subPath === 'api/create' && request.method === 'POST') {
        if (!(await isAdmin(context))) {
            return jsonResponse({ error: 'unauthorized' }, 401);
        }
        let body;
        try {
            body = await request.json();
        } catch (e) {
            return jsonResponse({ error: 'invalid_json' }, 400);
        }
        let path = String(body && body.path || '');
        try { path = decodeURIComponent(path); } catch (e) { /* 保留原样 */ }
        if (!isValidSharePath(path)) {
            return jsonResponse({ error: 'invalid_path', message: '路径必须以 /file/ 开头且不含 .. 等非法字符' }, 400);
        }
        // 存储时使用编码形式，与 URL 一致
        let encodedPath;
        try {
            encodedPath = encodeURIComponent(path).replace(/%2F/gi, '/');
        } catch (e) {
            encodedPath = path;
        }
        const hours = Number(body && body.hours);
        if (!Number.isFinite(hours) || hours < MIN_HOURS || hours > MAX_HOURS) {
            return jsonResponse({ error: 'invalid_hours', message: `有效时长需在 ${MIN_HOURS} 至 ${MAX_HOURS} 小时之间` }, 400);
        }

        const token = await createToken(env, encodedPath, hours);
        if (!token) {
            return jsonResponse({ error: 'sign_failed' }, 500);
        }

        const payload = parseTokenPayload(token);
        const record = {
            token,
            path: encodedPath,
            exp: payload.e,
            created: Math.floor(Date.now() / 1000),
        };
        const active = (await readList(env, ACTIVE_KEY, MAX_ACTIVE)).filter(x => x.token !== token);
        active.unshift(record);
        await saveActive(env, active);

        return jsonResponse({
            ok: true,
            url: `${url.origin}/plugins/share-link/view/${token}`,
            path: encodedPath,
            exp: record.exp,
        });
    }

    // ---- 链接列表 ----
    if (subPath === 'api/list' && request.method === 'GET') {
        if (!(await isAdmin(context))) {
            return jsonResponse({ error: 'unauthorized' }, 401);
        }
        const now = Math.floor(Date.now() / 1000);
        const active = await readList(env, ACTIVE_KEY, MAX_ACTIVE);
        const live = active.filter(x => (x.exp || 0) > now);
        if (live.length !== active.length) {
            await saveActive(env, live); // 顺手清理已过期条目
        }
        return jsonResponse({ links: live });
    }

    // ---- 撤回链接 ----
    if (subPath === 'api/revoke' && request.method === 'POST') {
        if (!(await isAdmin(context))) {
            return jsonResponse({ error: 'unauthorized' }, 401);
        }
        let body;
        try {
            body = await request.json();
        } catch (e) {
            return jsonResponse({ error: 'invalid_json' }, 400);
        }
        const token = String(body && body.token || '');
        const payload = parseTokenPayload(token);
        if (!payload) {
            return jsonResponse({ error: 'invalid_token' }, 400);
        }
        const revoked = await readList(env, REVOKED_KEY, MAX_REVOKED);
        if (!revoked.some(r => r.n === payload.n)) {
            revoked.unshift({ n: payload.n, e: payload.e });
            await env.img_url.put(REVOKED_KEY, JSON.stringify(revoked.slice(0, MAX_REVOKED)));
        }
        const active = (await readList(env, ACTIVE_KEY, MAX_ACTIVE)).filter(x => x.token !== token);
        await saveActive(env, active);
        return jsonResponse({ ok: true });
    }

    // ---- 公开访问：view/<token> ----
    if (subPath.startsWith('view/') && request.method === 'GET') {
        const token = subPath.slice('view/'.length);
        if (token.length > 2048) {
            return errorPage('链接无效', 'token 格式错误');
        }
        const result = await verifyToken(env, token);
        if (!result.ok) {
            const reasonMap = {
                expired: '链接已过期',
                revoked: '链接已被撤回',
                bad_signature: '链接签名校验失败（可能被篡改）',
                malformed: '链接格式错误',
            };
            return errorPage('无法打开分享链接', reasonMap[result.reason] || '链接无效');
        }
        return await proxyFile(context, result.payload.p);
    }

    if (subPath === 'version') {
        return jsonResponse({ plugin: 'share-link', version: PLUGIN_VERSION });
    }

    return new Response('Not Found', { status: 404 });
}
