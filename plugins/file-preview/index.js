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

/**
 * 插件路由：/plugins/file-preview/<subPath>
 * 对外提供预览页与前端静态资源
 */
export async function handleRoute(context, subPath) {
    if (subPath === '' || subPath === 'page') {
        return previewPageResponse();
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
