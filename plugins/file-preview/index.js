/**
 * 插件：file-preview —— 文件在线预览（后端部分）
 *
 * 介入方式：onResponse 响应钩子（包裹 /file/* 的原始响应）
 *
 * 行为：
 *   1. 浏览器导航访问 /file/<id>（Sec-Fetch-Dest: document）且文件属于可预览类型
 *      → 返回预览页（单页应用，客户端拉取 ?raw=1 内容后渲染）
 *   2. ?raw=1 / ?download=1 → 完全跳过预览；download=1 额外改为附件下载
 *   3. text/html、image/svg+xml、application/xml 等危险类型
 *      → 原始响应追加 Content-Security-Policy: sandbox（浏览器侧禁脚本 + 隔离源）
 *      → 并降为私有缓存，防止共享缓存投毒绕过预览页
 *   4. XHR/fetch/嵌入（Accept 为任意类型、Sec-Fetch-Dest != document）→ 保持原有行为
 *
 * 安全设计（纵深防御，防止恶意文件攻击宿主站点）：
 *   - 预览页响应头 CSP：default-src 'none'，仅允许同源脚本/样式/连接
 *   - html 预览在 iframe sandbox（无 allow-scripts、无 allow-same-origin）中渲染
 *   - svg 预览用 <img> 渲染（图片上下文天然不执行脚本）
 *   - 原始 html/svg/xml 响应加 CSP sandbox，直接访问/被外站嵌入也无法执行脚本
 *   - 前端渲染全部走转义/白名单，绝无 innerHTML 直插文件内容
 */

import { ASSET_MAP, PLUGIN_VERSION } from './_assets.js';

// ==================== 配置 ====================

const CONFIG = {
    // 超过此大小不拦截预览（前端也会二次校验）
    maxPreviewBytes: 5 * 1024 * 1024,
    // 是否对 html/svg/xml 的原始响应加 CSP sandbox（强烈建议开启）
    sanitizeDangerousTypes: true,
};

const PREVIEW_PAGE_CACHE = 'public, max-age=3600';
const ASSET_CACHE = 'public, max-age=86400';

// ==================== MIME 与类型分类 ====================

const MIME_BY_EXT = {
    js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    css: 'text/css', json: 'application/json', map: 'application/json',
    html: 'text/html', svg: 'image/svg+xml',
};

/** 判断文件是否可预览，返回预览类型；不可预览返回 null */
export function classifyPreview(contentType, fileName) {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    const name = String(fileName || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';

    // 文本类（明确 MIME 优先）
    if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
    if (type === 'image/svg+xml') return 'svg';
    if (type === 'text/markdown' || type === 'text/x-markdown') return 'md';
    if (type === 'text/csv' || type === 'text/tab-separated-values') return 'csv';
    if (type === 'application/json' || type.endsWith('+json')) return 'json';
    if (type === 'application/javascript' || type === 'text/javascript') return 'code';
    if (type === 'text/plain' || type === 'text/plain;charset=utf-8') {
        if (ext === 'md' || ext === 'markdown') return 'md';
        if (ext === 'csv' || ext === 'tsv') return 'csv';
        return CODE_EXTENSIONS.has(ext) ? 'code' : 'text';
    }
    if (type.startsWith('text/')) return 'code'; // text/css、text/x-python 等
    if (type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml')) return 'xml';
    if (type === 'application/octet-stream' || type === 'binary/octet-stream' || type === '') {
        // MIME 缺失/通用时按扩展名兜底
        if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html';
        if (ext === 'svg' || ext === 'svgz') return 'svg';
        if (ext === 'md' || ext === 'markdown') return 'md';
        if (ext === 'csv' || ext === 'tsv') return 'csv';
        if (ext === 'json' || ext === 'geojson' || ext === 'jsonc') return 'json';
        if (ext === 'xml' || ext === 'rss' || ext === 'atom') return 'xml';
        if (ext === 'txt' || ext === 'log') return 'text';
        if (CODE_EXTENSIONS.has(ext)) return 'code';
    }
    return null;
}

const CODE_EXTENSIONS = new Set([
    'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'jsonc', 'geojson', 'map',
    'py', 'pyw', 'rb', 'php', 'pl', 'lua', 'java', 'kt', 'kts', 'swift',
    'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs', 'dart', 'scala',
    'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1', 'dockerfile', 'makefile', 'gitignore',
    'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'editorconfig',
    'sql', 'vue', 'svelte', 'graphql', 'gql', 'diff', 'patch', 'log', 'txt',
]);

/** 判断是否属于需要 CSP sandbox 的危险可执行文档类型 */
function isDangerousDocument(contentType, fileName) {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (type === 'text/html' || type === 'application/xhtml+xml') return true;
    if (type === 'image/svg+xml' || type === 'image/svg') return true;
    if (type === 'application/xml' || type === 'text/xml') return true;
    const ext = String(fileName || '').toLowerCase();
    return /\.(html?|xhtml|svg|svgz|xml|rss|atom)$/.test(ext);
}

/** 从 Content-Disposition 解析文件名 */
function fileNameFromDisposition(cd) {
    if (!cd) return '';
    const star = /filename\*=UTF-8''([^;\s]+)/i.exec(cd);
    if (star) {
        try { return decodeURIComponent(star[1]); } catch (e) { /* ignore */ }
    }
    const quoted = /filename="((?:[^"\\]|\\.)*)"/i.exec(cd);
    if (quoted) return quoted[1].replace(/\\"/g, '"');
    const plain = /filename=([^;\s]+)/i.exec(cd);
    if (plain) return plain[1];
    return '';
}

/** 判断请求是否为浏览器页面导航 */
function isBrowserNavigation(request) {
    const dest = (request.headers.get('sec-fetch-dest') || '').toLowerCase();
    if (dest === 'document') return true;
    if (dest && dest !== 'document') return false; // image/audio/video/iframe/empty 等
    const accept = request.headers.get('accept') || '';
    return accept.includes('text/html'); // 无 Sec-Fetch 头时的兼容判断
}

// ==================== 预览页与资源路由 ====================

function textResponse(body, contentType, cacheControl) {
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': cacheControl,
        },
    });
}

const PREVIEW_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "frame-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

/** 预览页 HTML（嵌入插件版本号便于前端缓存控制） */
function previewPageResponse() {
    const html = (ASSET_MAP['page.html'] || '<!DOCTYPE html><title>preview</title>')
        .replace(/{{VERSION}}/g, PLUGIN_VERSION);
    return new Response(html, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': PREVIEW_CSP,
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex',
        },
    });
}

// ==================== HTML 信任授权（可交互 HTML 预览） ====================
//
// 信任列表存 KV：plugins:file-preview:trusted（JSON 数组，封顶 200 条）。
// 信任后预览页改用 Blob URL + sandbox 属性装载（allow-scripts / allow-forms /
// allow-modals / allow-popups，始终不含 allow-same-origin），脚本运行在
// opaque origin，无法读取宿主站点的 Cookie / localStorage / 凭据请求。
// 原始文件的 CSP sandbox 响应头防线保持原样，外站嵌入 / 直接访问不受影响。

const TRUSTED_KEY = 'plugins:file-preview:trusted';
const TRUSTED_LIMIT = 200;

function jsonRes(obj, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex',
        },
    });
}

/** 校验可信任的文件路径：必须是 /file/*、无目录穿越、无控制字符 */
function isValidFilePath(path) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 500) return false;
    if (path !== '/file' && !path.startsWith('/file/')) return false;
    if (path.includes('..') || path.includes('\\')) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(path)) return false;
    return true;
}

async function readTrustedList(env) {
    if (!env.img_url) return [];
    try {
        const raw = await env.img_url.get(TRUSTED_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.filter(p => typeof p === 'string');
    } catch (e) {
        return [];
    }
}

async function writeTrustedList(env, list) {
    await env.img_url.put(TRUSTED_KEY, JSON.stringify(list));
}

async function isAdminRequest(context) {
    const { env, request, url } = context;
    try {
        const { authenticate, AUTH_SCOPE } = await import('../functions/utils/auth/authCore.js');
        const result = await authenticate({ env, request, url, authScope: AUTH_SCOPE.ADMIN });
        return Boolean(result && result.authorized);
    } catch (e) {
        console.warn('[file-preview] 鉴权模块不可用:', e);
        return false;
    }
}

async function handleTrustApi(context, subPath) {
    const { request, env, url } = context;

    if (!env.img_url) {
        return jsonRes({ error: 'kv_unavailable' }, 503);
    }

    // GET api/trust?path=... → {trusted}（公开只读，仅返回布尔值）
    if (subPath === 'api/trust' && request.method === 'GET') {
        const path = url.searchParams.get('path') || '';
        if (!isValidFilePath(path)) {
            return jsonRes({ trusted: false });
        }
        const list = await readTrustedList(env);
        return jsonRes({ trusted: list.includes(path) });
    }

    // GET api/trust/list → 完整信任列表（仅管理员）
    if (subPath === 'api/trust/list' && request.method === 'GET') {
        if (!(await isAdminRequest(context))) {
            return jsonRes({ error: 'unauthorized' }, 401);
        }
        return jsonRes({ trusted: await readTrustedList(env) });
    }

    // POST api/trust {path, trusted} → 添加/移除信任（仅管理员）
    if (subPath === 'api/trust' && request.method === 'POST') {
        if (!(await isAdminRequest(context))) {
            return jsonRes({ error: 'unauthorized', message: '需要管理员权限' }, 401);
        }
        let body;
        try {
            body = await request.json();
        } catch (e) {
            return jsonRes({ error: 'invalid_json' }, 400);
        }
        const path = typeof body.path === 'string' ? body.path : '';
        const trusted = body.trusted !== false;
        if (!isValidFilePath(path)) {
            return jsonRes({ error: 'invalid_path', message: '路径必须是 /file/ 开头且不含非法字符' }, 400);
        }
        let list = await readTrustedList(env);
        if (trusted) {
            if (!list.includes(path)) {
                list.unshift(path);
                if (list.length > TRUSTED_LIMIT) list = list.slice(0, TRUSTED_LIMIT);
                await writeTrustedList(env, list);
            }
        } else {
            list = list.filter(p => p !== path);
            await writeTrustedList(env, list);
        }
        return jsonRes({ ok: true, path, trusted, count: list.length });
    }

    return new Response('Method Not Allowed', { status: 405 });
}

/**
 * 插件路由：/plugins/file-preview/<subPath>
 * 对外提供预览页、前端静态资源与「HTML 信任」接口
 */
export async function handleRoute(context, subPath) {
    if (subPath === '' || subPath === 'page') {
        return previewPageResponse();
    }
    // ---- HTML 信任授权接口 ----
    if (subPath === 'api/trust' || subPath === 'api/trust/list') {
        return await handleTrustApi(context, subPath);
    }
    if (subPath.startsWith('assets/')) {
        const key = subPath.slice('assets/'.length);
        const content = ASSET_MAP[key];
        if (content === undefined) {
            return new Response('Not Found', { status: 404 });
        }
        const ext = key.includes('.') ? key.split('.').pop().toLowerCase() : '';
        const mime = MIME_BY_EXT[ext] || 'text/plain; charset=utf-8';
        const headers = {
            'Content-Type': `${mime}; charset=utf-8`,
            'Cache-Control': `${ASSET_CACHE}, immutable`,
            'X-Content-Type-Options': 'nosniff',
        };
        if (ext === 'js') headers['Content-Security-Policy'] = PREVIEW_CSP;
        return new Response(content, { status: 200, headers });
    }
    if (subPath === 'version') {
        return textResponse(
            JSON.stringify({ plugin: 'file-preview', version: PLUGIN_VERSION }),
            'application/json; charset=utf-8',
            'no-store'
        );
    }
    return new Response('Not Found', { status: 404 });
}

// ==================== 响应钩子（核心逻辑） ====================

export async function init({ env }) {
    // 允许用环境变量覆盖默认配置
    if (env && env.PLUGIN_PREVIEW_MAX_BYTES) {
        const n = parseInt(env.PLUGIN_PREVIEW_MAX_BYTES, 10);
        if (Number.isFinite(n) && n > 0) CONFIG.maxPreviewBytes = n;
    }
}

export async function onResponse(context, response) {
    const { request, url } = context;

    // 只处理 GET/HEAD 的 /file/* 文件请求
    if (url.pathname !== '/file' && !url.pathname.startsWith('/file/')) return response;
    if (request.method !== 'GET' && request.method !== 'HEAD') return response;

    const forceRaw = url.searchParams.has('raw');
    const forceDownload = url.searchParams.has('download') || url.searchParams.has('dl');
    if (request.headers.get('range')) return response; // 分段请求（播放器等）不干预

    const contentType = response.headers.get('Content-Type') || '';
    const fileName = fileNameFromDisposition(response.headers.get('Content-Disposition'))
        || decodeURIComponent(url.pathname.split('/').pop() || '');

    // ---- 1) 强制下载：改为附件响应 ----
    if (forceDownload && response.status === 200) {
        const headers = new Headers(response.headers);
        headers.set('Content-Disposition', 'attachment' + (fileName ? `; filename*=UTF-8''${encodeURIComponent(fileName)}` : ''));
        headers.delete('Cache-Control');
        headers.set('Cache-Control', 'no-store');
        return new Response(response.body, { status: response.status, headers });
    }

    const wantsPreview = !forceRaw && response.status === 200 && request.method === 'GET';

    // ---- 2) 浏览器导航 + 可预览类型 → 返回预览页 ----
    if (wantsPreview && isBrowserNavigation(request)) {
        const kind = classifyPreview(contentType, fileName);
        if (kind) {
            return previewPageResponse();
        }
    }

    // ---- 3) 危险文档类型 → 追加 CSP sandbox（防脚本执行 / 缓存投毒）----
    if (CONFIG.sanitizeDangerousTypes && isDangerousDocument(contentType, fileName) && !forceDownload) {
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', 'sandbox');
        headers.set('X-Content-Type-Options', 'nosniff');
        // 降为私有缓存：不同 Accept 的客户端共享边缘缓存时，避免原始文档被直接下发给浏览器导航
        const cc = headers.get('Cache-Control') || '';
        if (cc.includes('public')) {
            headers.set('Cache-Control', cc.replace(/public/g, 'private'));
        }
        return new Response(response.body, { status: response.status, headers });
    }

    return response;
}
