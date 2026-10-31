/**
 * file-preview 预览页主程序（浏览器端）
 *
 * 运行位置：/file/<id>（服务器钩子在浏览器导航时返回本页）。
 * 数据获取：fetch 同一 URL 加 ?raw=1 拿原始内容（同源、带凭据），
 *           因此原有的鉴权 / 白名单逻辑全部照常生效。
 * 渲染原则：文本内容一律经转义或白名单生成器（markdown.js /
 *           highlight.js / csv.js）产出，绝不直接 innerHTML 文件内容。
 */

import { renderMarkdown } from './markdown.js';
import { highlightCode } from './highlight.js';
import { parseCSV } from './csv.js';
import { auditHtml, renderAuditCard } from './htmlaudit.js';

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024; // 与服务端插件配置一致
const MAX_RENDER_LINES = 30000;

// ==================== 工具 ====================

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

/** 与服务端一致的类型分类（依据响应头） */
function classifyPreview(contentType, fileName) {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    const name = String(fileName || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';

    if (type === 'text/html' || ['html', 'htm', 'xhtml'].includes(ext)) return 'html';
    if (type === 'image/svg+xml' || ['svg', 'svgz'].includes(ext)) return 'svg';
    if (type === 'text/markdown' || ['md', 'markdown'].includes(ext)) return 'md';
    if (type === 'text/csv' || ['csv', 'tsv'].includes(ext)) return 'csv';
    if (type === 'application/json' || type.endsWith('+json') || ['json', 'jsonc', 'geojson'].includes(ext)) return 'json';
    if (type === 'application/xml' || type === 'text/xml' || ['xml', 'rss', 'atom', 'plist'].includes(ext)) return 'xml';
    if (type === 'text/plain') return CODE_EXTS.has(ext) ? 'code' : 'text';
    if (type === '' || type === 'application/octet-stream' || type === 'binary/octet-stream') {
        if (['md', 'markdown'].includes(ext)) return 'md';
        if (['csv', 'tsv'].includes(ext)) return 'csv';
        if (['html', 'htm'].includes(ext)) return 'html';
        if (['svg'].includes(ext)) return 'svg';
        if (['json'].includes(ext)) return 'json';
        if (['xml'].includes(ext)) return 'xml';
        if (CODE_EXTS.has(ext)) return 'code';
        if (['txt', 'log', 'text'].includes(ext)) return 'text';
        return null;
    }
    if (type.startsWith('text/')) return 'code'; // text/css, text/javascript, application/javascript…
    if (type === 'application/javascript' || type === 'text/javascript' || type === 'application/x-sh' || type === 'application/x-yaml' || type === 'application/yaml' || type === 'application/toml') return 'code';
    return null;
}

const CODE_EXTS = new Set(['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'rb', 'sh', 'bash', 'zsh', 'fish', 'lua', 'pl', 'r', 'java', 'kt', 'kts', 'dart', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'php', 'swift', 'scala', 'vue', 'svelte', 'sql', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'gitignore', 'dockerfile', 'makefile', 'diff', 'patch', 'log', 'graphql', 'bat', 'ps1']);

/** 从 Content-Disposition 提取文件名 */
function fileNameFromHeaders(headers, fallbackUrl) {
    const cd = headers.get('Content-Disposition') || '';
    const star = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
    if (star) {
        try { return decodeURIComponent(star[1]); } catch (e) { /* ignore */ }
    }
    const plain = /filename="([^"]*)"/.exec(cd) || /filename=([^;\s]+)/.exec(cd);
    if (plain) {
        try { return decodeURIComponent(plain[1]); } catch (e) { return plain[1]; }
    }
    const seg = String(fallbackUrl || '').split('/').filter(Boolean).pop() || '';
    try { return decodeURIComponent(seg); } catch (e) { return seg; }
}

/** 有限读取响应体：超过上限即中止，避免超大文件拖垮内存 */
async function readBodyCapped(response, cap) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let oversized = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > cap) {
            oversized = true;
            try { await reader.cancel(); } catch (e) { /* ignore */ }
            break;
        }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        buf.set(c, off);
        off += c.length;
    }
    return { buf, oversized };
}

/** 智能解码：UTF-8 优先，回退 latin1（避免整篇乱码） */
function decodeText(buf) {
    const utf8 = new TextDecoder('utf-8').decode(buf);
    const bad = (utf8.match(/\uFFFD/g) || []).length;
    if (bad > 0 && bad > utf8.length * 0.1) {
        try { return new TextDecoder('windows-1252').decode(buf); } catch (e) { return utf8; }
    }
    return utf8;
}

// ==================== 状态与视图 ====================

let currentText = '';
let currentKind = null;
let viewMode = 'preview'; // preview | source
let wrapOn = false;

function buildRawUrl(extra) {
    const p = new URLSearchParams(location.search);
    p.set('raw', '1');
    if (extra) Object.keys(extra).forEach(k => p.set(k, extra[k]));
    return location.pathname + '?' + p.toString();
}

function setToolbar(name, kind, sizeBytes, info) {
    document.title = (name || '文件预览') + ' - 在线预览';
    $('fname').textContent = name || '未命名文件';
    $('badge').textContent = (kind || 'FILE').toUpperCase();
    $('badge').dataset.kind = kind || 'other';
    $('fsize').textContent = formatSize(sizeBytes);
    $('finfo').textContent = info || '';
}

function show(kind, name, sizeBytes, info) {
    setToolbar(name, kind, sizeBytes, info);
}

function setView(html) {
    $('view').innerHTML = html;
}

function errorCard(title, detail, hint) {
    setView(`<div class="card card-error">
      <div class="card-title">${escapeHtml(title)}</div>
      ${detail ? `<div class="card-detail">${escapeHtml(detail)}</div>` : ''}
      ${hint ? `<div class="card-hint">${escapeHtml(hint)}</div>` : ''}
      <div class="card-actions">
        <a class="btn" href="${escapeHtml(buildRawUrl())}" target="_blank" rel="noopener noreferrer">打开原始文件</a>
        <a class="btn btn-primary" href="${escapeHtml(buildRawUrl({ download: '1' }))}">下载文件</a>
      </div>
    </div>`);
}

// ---------- 代码/文本视图（行号 + 高亮） ----------

function codeViewHtml(code, lang) {
    const lines = code.split('\n');
    const capped = lines.length > MAX_RENDER_LINES;
    const shown = capped ? lines.slice(0, MAX_RENDER_LINES) : lines;
    const highlighted = shown.map(l => highlightCode(l, lang));
    // 逐行渲染，保持行号对齐（自动换行时行号不漂移）
    let html = '<div class="code-wrap' + (wrapOn ? ' wrap-on' : '') + '"><table class="code-table"><tbody>';
    for (let i = 0; i < shown.length; i++) {
        html += `<tr class="code-line"><td class="ln">${i + 1}</td><td class="lc">${highlighted[i] || '&nbsp;'}</td></tr>`;
    }
    html += '</tbody></table></div>';
    if (capped) html += `<div class="render-note">内容过长，仅渲染前 ${MAX_RENDER_LINES.toLocaleString()} 行（共 ${lines.length.toLocaleString()} 行），可下载查看完整内容</div>`;
    return html;
}

// ---------- 各类型渲染 ----------

function renderTextView(text, ext) {
    setView(codeViewHtml(text, ext || 'txt'));
}

function renderCodeView(text, ext) {
    setView(codeViewHtml(text, ext));
}

function renderJsonView(text) {
    try {
        const obj = JSON.parse(text);
        const pretty = JSON.stringify(obj, null, 2);
        currentText = pretty;
        setView(codeViewHtml(pretty, 'json'));
        return true;
    } catch (e) {
        setView('<div class="render-note warn">JSON 解析失败，已按纯文本显示</div>' + codeViewHtml(text, 'txt'));
        return false;
    }
}

function renderCsvView(text, fileName) {
    const { rows, delimiter, truncated } = parseCSV(text);
    if (!rows.length) {
        setView(codeViewHtml(text, 'txt'));
        return;
    }
    const header = rows[0];
    const body = rows.slice(1);
    const delimName = delimiter === '\t' ? 'TAB' : (delimiter === '|' ? '|' : delimiter);
    let html = `<div class="csv-meta">${rows.length} 行 × ${header.length} 列 · 分隔符 ${escapeHtml(delimName)}</div>`;
    html += '<div class="csv-table-wrap"><table class="csv-table"><thead><tr>';
    header.forEach(h => { html += `<th>${escapeHtml(h)}</th>`; });
    html += '</tr></thead><tbody>';
    body.forEach(r => {
        html += '<tr>';
        for (let i = 0; i < header.length; i++) {
            html += `<td>${escapeHtml(r[i] != null ? r[i] : '')}</td>`;
        }
        html += '</tr>';
    });
    html += '</tbody></table></div>';
    if (truncated) html += `<div class="render-note">行数过多，仅显示前 ${rows.length} 行</div>`;
    setView(html);
    void fileName;
}

function renderMarkdownView(text) {
    const html = renderMarkdown(text, { highlight: highlightCode });
    setView('<article class="md-body">' + html + '</article>');
}

// ---------- HTML 视图：审计卡 + 信任授权 + 全屏 ----------

let trustState = null;   // null=未查询；true/false=信任状态
let htmlBlobUrl = null;  // 信任模式下的 Blob URL（离开视图时回收）

async function fetchTrust() {
    try {
        const r = await fetch('/plugins/file-preview/api/trust?path=' + encodeURIComponent(location.pathname), {
            credentials: 'same-origin',
        });
        if (r.ok) {
            const j = await r.json();
            return j.trusted === true;
        }
    } catch (e) { /* 网络异常按未信任处理 */ }
    return false;
}

async function setTrust(trusted) {
    const btnId = trusted ? 'btnTrust' : 'btnUntrust';
    try {
        const r = await fetch('/plugins/file-preview/api/trust', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: location.pathname, trusted }),
        });
        if (r.status === 401) {
            flashBtn(btnId, '需先登录管理端');
            return;
        }
        if (r.ok) {
            const j = await r.json();
            trustState = j.trusted;
            renderHtmlView();
        } else {
            flashBtn(btnId, '失败');
        }
    } catch (e) {
        flashBtn(btnId, '网络错误');
    }
}

function releaseBlobUrl() {
    if (htmlBlobUrl) {
        URL.revokeObjectURL(htmlBlobUrl);
        htmlBlobUrl = null;
    }
}

async function renderHtmlView() {
    if (trustState === null) trustState = await fetchTrust();
    const trusted = trustState === true;
    const audit = auditHtml(currentText);

    let frameHtml;
    if (trusted) {
        releaseBlobUrl();
        const blob = new Blob([currentText], { type: 'text/html' });
        htmlBlobUrl = URL.createObjectURL(blob);
        frameHtml = `
        <div class="frame-tools">
            <span class="frame-note">信任模式：脚本 / 表单 / 弹窗已开启（隔离源运行，无本站权限）</span>
            <button id="btnFullscreen" class="btn" type="button">全屏</button>
            <button id="btnUntrust" class="btn" type="button">取消信任</button>
        </div>
        <div class="frame-wrap"><iframe id="trustedFrame" class="sandbox-frame" src="${htmlBlobUrl}" sandbox="allow-scripts allow-forms allow-modals allow-popups" allowfullscreen referrerpolicy="no-referrer" title="HTML 交互预览"></iframe></div>
        <div class="render-note">相对路径的资源在信任模式下无法解析（仅绝对地址可用）；点「全屏」可放大查看</div>`;
    } else {
        const src = escapeHtml(buildRawUrl());
        frameHtml = `
        <div class="frame-tools">
            <span class="frame-note">沙箱模式：脚本、表单、弹窗均已被禁用，仅展示页面外观</span>
            <button id="btnTrust" class="btn btn-primary" type="button">信任此文件并启用交互</button>
        </div>
        <div class="frame-wrap"><iframe class="sandbox-frame" src="${src}" sandbox="" referrerpolicy="no-referrer" title="HTML 沙箱预览"></iframe></div>
        <div class="render-note">信任后文件内脚本可执行（隔离沙箱，无法读取本站 Cookie 与数据）</div>`;
    }

    setView('<div class="html-stage">' + renderAuditCard(audit, trusted) + frameHtml + '</div>');

    const trustBtn = $('btnTrust');
    if (trustBtn) trustBtn.addEventListener('click', () => {
        if (!window.confirm('信任后，该文件的 JavaScript 将被执行（在隔离沙箱内，无法访问本站数据）。确认信任此文件？')) return;
        setTrust(true);
    });
    const untrustBtn = $('btnUntrust');
    if (untrustBtn) untrustBtn.addEventListener('click', () => setTrust(false));
    const fsBtn = $('btnFullscreen');
    if (fsBtn) fsBtn.addEventListener('click', () => {
        const frame = $('trustedFrame');
        if (frame && frame.requestFullscreen) {
            frame.requestFullscreen().catch(() => flashBtn('btnFullscreen', '被浏览器拒绝'));
        }
    });
}

function renderSvgView() {
    const src = buildRawUrl();
    setView('<div class="img-wrap"><p id="svgError" class="render-note" style="display:none">图片加载失败：文件可能不是有效的 SVG</p></div>' +
        '<div class="render-note">以图片方式渲染（该上下文不执行脚本）</div>');
    const wrap = document.querySelector('.img-wrap');
    const img = document.createElement('img');
    img.className = 'svg-img';
    img.alt = 'SVG 预览';
    img.addEventListener('error', () => {
        const p = $('svgError');
        if (p) p.style.display = '';
        if (img.parentNode) img.remove();
        wrap.classList.add('img-error');
    });
    img.src = src;
    wrap.appendChild(img);
}

function renderSourceView() {
    const ext = currentKind === 'md' ? 'md'
        : currentKind === 'html' || currentKind === 'svg' || currentKind === 'xml' ? (currentKind === 'svg' ? 'svg' : 'html')
            : 'txt';
    setView(codeViewHtml(currentText, ext));
}

// ---------- 源码/预览切换 ----------

function rerender() {
    if (currentKind === 'md') {
        viewMode === 'preview' ? renderMarkdownView(currentText) : renderSourceView();
    } else if (currentKind === 'html') {
        viewMode === 'preview' ? renderHtmlView() : renderSourceView();
    } else if (currentKind === 'svg') {
        viewMode === 'preview' ? renderSvgView() : renderSourceView();
    } else if (currentKind === 'csv') {
        viewMode === 'preview' ? renderCsvView(currentText) : renderSourceView();
    } else if (currentKind === 'json') {
        renderJsonView(currentText); // json 固定美化源码视图
    } else if (currentKind === 'code') {
        setView(codeViewHtml(currentText, lastExt || 'txt'));
    } else {
        renderTextView(currentText, lastExt);
    }
}

// ==================== 交互 ====================

let lastExt = '';

async function copyContent() {
    const text = currentText;
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
        flashBtn('btnCopy', '已复制');
    } catch (e) {
        // 非 https 环境降级
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); flashBtn('btnCopy', '已复制'); } catch (e2) { flashBtn('btnCopy', '复制失败'); }
        ta.remove();
    }
}

function flashBtn(id, okText) {
    const btn = $(id);
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = okText;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1200);
}

function toggleWrap() {
    wrapOn = !wrapOn;
    document.body.classList.toggle('wrap-mode', wrapOn);
    const wrapEl = document.querySelector('.code-wrap');
    if (wrapEl) wrapEl.classList.toggle('wrap-on', wrapOn);
}

function toggleSource() {
    viewMode = viewMode === 'preview' ? 'source' : 'preview';
    const btn = $('btnSource');
    if (btn) btn.textContent = viewMode === 'preview' ? '查看源码' : '返回预览';
    rerender();
}

// ==================== 启动 ====================

async function main() {
    $('btnCopy').addEventListener('click', copyContent);
    $('btnWrap').addEventListener('click', toggleWrap);
    $('btnSource').addEventListener('click', toggleSource);
    $('btnRaw').addEventListener('click', () => window.open(buildRawUrl(), '_blank', 'noopener'));
    $('btnDownload').addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = buildRawUrl({ download: '1' });
        document.body.appendChild(a);
        a.click();
        a.remove();
    });

    let resp;
    try {
        resp = await fetch(buildRawUrl(), { credentials: 'same-origin' });
    } catch (e) {
        errorCard('网络错误', String(e && e.message || e), '无法获取文件内容，请检查网络后重试');
        return;
    }

    const headers = resp.headers;
    const fileName = fileNameFromHeaders(headers, location.pathname);
    lastExt = fileName.toLowerCase().includes('.') ? fileName.split('.').pop() : '';
    const contentType = headers.get('Content-Type') || '';
    const kind = classifyPreview(contentType, fileName);
    const sizeHeader = headers.get('Content-Length');
    const size = sizeHeader ? parseInt(sizeHeader, 10) : null;

    if (!resp.ok) {
        const hint = resp.status === 401 || resp.status === 403
            ? '无访问权限（可能处于白名单/鉴权模式），请先在管理端登录后再试'
            : (resp.status === 404 ? '文件不存在或已被删除' : '');
        errorCard('无法获取文件（HTTP ' + resp.status + '）', '', hint);
        show(kind, fileName, size, '');
        return;
    }

    if (!kind) {
        // 不可预览类型：展示信息卡
        setView(`<div class="card">
          <div class="card-title">${escapeHtml(fileName || '文件')}</div>
          <div class="card-detail">${escapeHtml(contentType || '未知类型')} · ${formatSize(size)}</div>
          <div class="card-hint">该类型不支持在线预览</div>
          <div class="card-actions">
            <a class="btn" href="${escapeHtml(buildRawUrl())}" target="_blank" rel="noopener noreferrer">打开原始文件</a>
            <a class="btn btn-primary" href="${escapeHtml(buildRawUrl({ download: '1' }))}">下载文件</a>
          </div>
        </div>`);
        show(null, fileName, size, '');
        $('btnSource').style.display = 'none';
        $('btnWrap').style.display = 'none';
        $('btnCopy').style.display = 'none';
        return;
    }

    // 体积限制
    if (size != null && size > MAX_PREVIEW_BYTES) {
        errorCard('文件过大，不提供在线预览', `文件大小 ${formatSize(size)}，超过预览上限 ${formatSize(MAX_PREVIEW_BYTES)}`, '可直接下载查看');
        show(kind, fileName, size, '');
        return;
    }

    let buf, oversized;
    try {
        ({ buf, oversized } = await readBodyCapped(resp, MAX_PREVIEW_BYTES));
    } catch (e) {
        errorCard('读取文件失败', String(e && e.message || e), '');
        return;
    }
    if (oversized) {
        errorCard('文件过大，不提供在线预览', `超过预览上限 ${formatSize(MAX_PREVIEW_BYTES)}`, '可直接下载查看');
        show(kind, fileName, size, '');
        return;
    }

    currentKind = kind;
    currentText = decodeText(buf);
    const lineCount = currentText.split('\n').length;

    // 控制按钮可见性
    const dual = ['md', 'html', 'svg', 'csv'].includes(kind);
    $('btnSource').style.display = dual ? '' : 'none';
    $('btnWrap').style.display = '';
    $('btnCopy').style.display = '';

    viewMode = 'preview';
    show(kind, fileName, size, `${lineCount.toLocaleString()} 行`);
    rerender();
}

main();

// 离开预览页时回收信任模式的 Blob URL
window.addEventListener('beforeunload', releaseBlobUrl);
