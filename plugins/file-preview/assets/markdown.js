/**
 * 安全 Markdown 渲染器（浏览器端）
 *
 * 安全模型：输入文本先整体 HTML 转义，之后所有生成的标签都由本模块
 * 白名单产生；链接/图片仅允许 http(s)、相对路径、锚点与 data:image。
 * 因此绝无「文件内容被当作 HTML 执行」的可能（等效 GitHub 纯净模式，
 * Markdown 中书写的原始 HTML 将按字面显示）。
 *
 * 支持：标题、粗斜体/删除线、行内代码、围栏代码块（高亮由
 * highlight.js 模块负责）、引用块、有序/无序列表（两级缩进）、
 * 链接、图片、表格（GFM 对齐）、分隔线、自动换行、硬换行。
 */

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** URL 白名单校验：仅放行 http(s)、相对路径、锚点；图片额外放行 data:image */
function safeUrl(url, allowDataImage) {
    const u = String(url || '').trim();
    const low = u.toLowerCase();
    if (low.startsWith('javascript:') || low.startsWith('vbscript:') || low.startsWith('data:text')) {
        return null;
    }
    if (low.startsWith('data:')) {
        return allowDataImage && /^data:image\//i.test(u) ? u : null;
    }
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (u.startsWith('#') || u.startsWith('/') || u.startsWith('./') || u.startsWith('../')) return u;
    if (/^[a-z][\w+.-]*:/i.test(u)) return null; // 其他协议一律拒绝
    return u; // 相对路径
}

// ==================== 行内解析 ====================

/** 行内渲染（输入必须是已转义文本） */
function renderInline(escaped) {
    // 1. 先摘出行内代码（内容不再处理其他规则）
    const codes = [];
    let text = escaped.replace(/`([^`\n]+)`/g, (m, c) => {
        codes.push(`<code class="md-code">${c}</code>`);
        return `\u0000${codes.length - 1}\u0000`;
    });

    // 2. 图片 ![alt](url)
    text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt, url) => {
        const u = safeUrl(unescapeAttr(url), true);
        if (!u) return m;
        return `<img class="md-img" src="${escapeHtml(u)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`;
    });

    // 3. 链接 [text](url)
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
        const u = safeUrl(unescapeAttr(url), false);
        if (!u) return m;
        return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
    });

    // 4. 裸链接自动转 <a>
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => {
        const u = safeUrl(url, false);
        if (!u) return m;
        return `${pre}<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`;
    });

    // 5. 粗体 / 斜体 / 删除线 / 硬换行
    text = text
        .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[^_])_([^_\n]+)_(?!\d)/g, '$1<em>$2</em>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
        .replace(/  \n/g, '<br>');

    // 6. 还原行内代码
    text = text.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[+i] || '');
    return text;
}

/** 链接 URL 反转义（因输入整体被 escapeHtml 处理过） */
function unescapeAttr(s) {
    return String(s)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

// ==================== 块级解析 ====================

/**
 * 渲染 Markdown 为安全 HTML 字符串
 * @param {string} src 原始 Markdown 文本
 * @param {{highlight: (code: string, lang: string) => string}} [opt] 代码高亮回调
 * @returns {string} HTML
 */
export function renderMarkdown(src, opt) {
    const highlight = (opt && typeof opt.highlight === 'function') ? opt.highlight : null;
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    const para = [];

    const flushPara = () => {
        if (para.length) {
            out.push(`<p>${renderInline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br>')}</p>`);
            para.length = 0;
        }
    };

    while (i < lines.length) {
        const line = lines[i];

        // ---- 围栏代码块 ----
        const fence = /^```[ \t]*([\w+#-]*)[ \t]*$/.exec(line);
        if (fence) {
            flushPara();
            const lang = fence[1] || '';
            const buf = [];
            i++;
            while (i < lines.length && !/^```[ \t]*$/.test(lines[i])) {
                buf.push(lines[i]);
                i++;
            }
            i++; // 跳过收尾 ```
            const code = escapeHtml(buf.join('\n'));
            const body = highlight ? highlight(buf.join('\n'), lang) : code;
            out.push(`<pre class="md-pre"><code class="md-code-block">${body}</code></pre>`);
            continue;
        }

        // ---- 标题 ----
        const h = /^(#{1,6})[ \t]+(.*)$/.exec(line);
        if (h) {
            flushPara();
            const level = h[1].length;
            out.push(`<h${level} class="md-h">${renderInline(escapeHtml(h[2].trim()))}</h${level}>`);
            i++;
            continue;
        }

        // ---- 分隔线 ----
        if (/^[ \t]{0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(line)) {
            flushPara();
            out.push('<hr class="md-hr">');
            i++;
            continue;
        }

        // ---- 引用块 ----
        if (/^[ \t]*>/.test(line)) {
            flushPara();
            const buf = [];
            while (i < lines.length && /^[ \t]*>/.test(lines[i])) {
                buf.push(lines[i].replace(/^[ \t]*>[ \t]?/, ''));
                i++;
            }
            out.push(`<blockquote class="md-quote">${renderInline(escapeHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`);
            continue;
        }

        // ---- 表格 ----
        // GFM 表格：分隔行每个非空单元格形如 :--- / --- / :---: / -
        const isTableSeparator = (l) => {
            if (!l.includes('-') || !l.includes('|')) return false;
            return splitTableRow(l).every(c => {
                const t = c.trim();
                return t === '' || /^:?-+:?$/.test(t);
            }) && splitTableRow(l).some(c => c.trim() !== '');
        };
        if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
            flushPara();
            const header = splitTableRow(line);
            const aligns = splitTableRow(lines[i + 1]).map(c => {
                const l = /^[ \t]*:/.test(c), r = /:[ \t]*$/.test(c);
                return l && r ? 'center' : r ? 'right' : 'left';
            });
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                rows.push(splitTableRow(lines[i]));
                i++;
            }
            let table = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
            header.forEach((c, ci) => {
                table += `<th style="text-align:${aligns[ci] || 'left'}">${renderInline(escapeHtml(c.trim()))}</th>`;
            });
            table += '</tr></thead><tbody>';
            rows.forEach(r => {
                table += '<tr>';
                for (let ci = 0; ci < header.length; ci++) {
                    table += `<td style="text-align:${aligns[ci] || 'left'}">${renderInline(escapeHtml((r[ci] || '').trim()))}</td>`;
                }
                table += '</tr>';
            });
            table += '</tbody></table></div>';
            out.push(table);
            continue;
        }

        // ---- 列表 ----
        const isUl = (l) => /^[ \t]*[-*+][ \t]+/.test(l);
        const isOl = (l) => /^[ \t]*\d{1,9}[.)][ \t]+/.test(l);
        if (isUl(line) || isOl(line)) {
            flushPara();
            const ordered = isOl(line);
            let html = ordered ? '<ol class="md-list">' : '<ul class="md-list">';
            while (i < lines.length && (isUl(lines[i]) || isOl(lines[i]) || /^[ \t]{2,}\S/.test(lines[i]))) {
                const l = lines[i];
                if (isUl(l) || isOl(l)) {
                    const indented = /^[ \t]{2,}/.test(l);
                    const content = l.replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/, '');
                    if (indented) {
                        html += `<li class="md-sub">${renderInline(escapeHtml(content))}</li>`;
                    } else {
                        html += `<li>${renderInline(escapeHtml(content))}</li>`;
                    }
                } else {
                    // 列表续行
                    html += `<br>${renderInline(escapeHtml(l.replace(/^[ \t]+/, '')))}`;
                }
                i++;
            }
            html += ordered ? '</ol>' : '</ul>';
            out.push(html);
            continue;
        }

        // ---- 空行 ----
        if (line.trim() === '') {
            flushPara();
            i++;
            continue;
        }

        // ---- 普通段落 ----
        para.push(line);
        i++;
    }
    flushPara();
    return out.join('\n');
}

function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|');
}
