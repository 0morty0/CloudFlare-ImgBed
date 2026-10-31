/**
 * file-preview 前端模块：HTML 安全审计（纯函数，无 DOM 依赖）
 *
 * 作用：在 HTML 预览前对文件内容做静态分析，展示脚本/表单/内联事件/
 * 外部资源引用等风险要素，帮助管理员判断是否值得信任该文件。
 *
 * 实现说明：采用正则扫描而非 DOMParser——一方面审计是启发式的，
 * 不需要完整解析树；另一方面纯函数无 DOM 依赖，可在 Node 中直接
 * 单元测试（见 test/plugins-security.test.mjs）。
 *
 * 本模块输出的所有用户可控文本，渲染时必须经 renderAuditCard 的
 * escapeHtml 转义（已内置），确保审计卡自身不成为 XSS 载体。
 */

const MAX_AUDIT_BYTES = 2 * 1024 * 1024; // 超出则跳过外链资源扫描细节

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 从字符串中提取 src/href 属性值的 host（仅 http/https 绝对地址） */
export function extractExternalHosts(text, limit) {
    const hosts = new Set();
    if (typeof text !== 'string' || text.length > MAX_AUDIT_BYTES) return [];
    const re = /(?:src|href|action)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const val = m[1].trim();
        if (/^https?:\/\//i.test(val)) {
            try {
                hosts.add(new URL(val).host);
            } catch (e) { /* 非法 URL，忽略 */ }
        }
        if (hosts.size >= (limit || 30)) break;
    }
    return [...hosts];
}

/** 统计内联事件属性（onerror、onclick 等）出现次数 */
export function countInlineEvents(text) {
    if (typeof text !== 'string') return 0;
    const re = /\son[a-z]+\s*=\s*["'][^"']*["']/gi;
    let n = 0;
    while (re.exec(text) !== null) n++;
    return n;
}

/** 标签粗计数（启发式：开标签形式，含前导空白防误配） */
export function countTags(text, tagName) {
    if (typeof text !== 'string') return 0;
    const re = new RegExp('<' + tagName + '(?=[\\s>])', 'gi');
    let n = 0;
    while (re.exec(text) !== null) n++;
    return n;
}

/** 扫描内联脚本中的典型高危调用模式 */
export function scanRiskyPatterns(text) {
    const risky = [];
    if (typeof text !== 'string') return risky;
    const checks = [
        [/\beval\s*\(/, 'eval() 动态执行'],
        [/\bnew\s+Function\s*\(/, 'new Function() 动态执行'],
        [/document\.cookie/, '读取 Cookie'],
        [/localStorage|sessionStorage/, '访问本地存储'],
        [/\bfetch\s*\(|\bXMLHttpRequest\b/, '发起网络请求'],
        [/top\.location|parent\.location|window\.open\s*\(/, '窗口跳转/弹窗'],
        [/document\.write\s*\(/, 'document.write 输出'],
    ];
    const inlineScripts = text.match(/<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi) || [];
    const scriptBody = inlineScripts.map(s => s.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')).join('\n');
    const scope = scriptBody || text;
    for (const [re, label] of checks) {
        if (re.test(scope)) risky.push(label);
    }
    return risky;
}

/**
 * 完整审计：输入 HTML 文本，输出摘要对象
 */
export function auditHtml(html) {
    const scripts = countTags(html, 'script');
    const externalScripts = (html.match(/<script[^>]*\bsrc\s*=/gi) || []).length;
    const forms = countTags(html, 'form');
    const iframes = countTags(html, 'iframe');
    const inlineEvents = countInlineEvents(html);
    const metaRefresh = /<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html || '');
    let title = '';
    const tm = (html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (tm) title = tm[1].trim().slice(0, 120);
    return {
        title,
        counts: {
            scripts,
            externalScripts,
            inlineScripts: Math.max(0, scripts - externalScripts),
            forms,
            iframes,
            inlineEvents,
        },
        hosts: extractExternalHosts(html, 30),
        metaRefresh,
        risky: scanRiskyPatterns(html),
    };
}

/**
 * 渲染审计卡片 HTML 字符串（所有动态值已转义）
 */
export function renderAuditCard(audit, trusted) {
    const c = audit.counts;
    const parts = [];
    const head = trusted ? 'HTML 安全审计 · 已信任（脚本可执行）' : 'HTML 安全审计 · 沙箱模式（脚本已禁用）';
    parts.push('<div class="audit-head">' + escapeHtml(head) + '</div>');

    if (audit.title) {
        parts.push('<div class="audit-title">&lt;title&gt;: ' + escapeHtml(audit.title) + '</div>');
    }

    const rows = [
        ['外部脚本', c.externalScripts],
        ['内联脚本', c.inlineScripts],
        ['表单', c.forms],
        ['内嵌框架 iframe', c.iframes],
        ['内联事件 (on*)', c.inlineEvents],
    ];
    const chips = rows
        .map(([label, n]) => '<span class="chip' + (n > 0 ? ' chip-warn' + (label.indexOf('脚本') >= 0 ? ' chip-hot' : '') : '') + '">' + escapeHtml(label) + ' ' + n + '</span>')
        .join('');
    parts.push('<div class="audit-chips">' + chips + '</div>');

    if (audit.metaRefresh) {
        parts.push('<div class="audit-flag">检测到 meta refresh 自动跳转</div>');
    }
    if (audit.risky.length) {
        parts.push('<div class="audit-flag">高危调用: ' + audit.risky.map(escapeHtml).join(' · ') + '</div>');
    }
    if (audit.hosts.length) {
        parts.push('<div class="audit-hosts">外部资源域名: ' + audit.hosts.map(h => escapeHtml(h)).join(' · ') + '</div>');
    }
    if (!audit.risky.length && !c.scripts && !c.forms) {
        parts.push('<div class="audit-ok">未发现脚本、表单或高危调用</div>');
    }
    return '<div class="audit-card">' + parts.join('') + '</div>';
}
