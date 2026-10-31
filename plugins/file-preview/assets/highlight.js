/**
 * 轻量语法高亮器（浏览器端，零依赖）
 *
 * 安全模型：对原始代码做词法扫描，输出时全部经 escapeHtml，
 * 产生的 HTML 仅包含本模块生成的 <span class="t-*"> 标签。
 *
 * 支持语言族：c-like(js/ts/java/c/go/rs/php…)、hash(py/sh/yaml/ini…)、
 * json、css、html/xml/svg/vue、sql、markdown、generic 兜底。
 * 超过 maxBytes 的内容不高亮，直接纯文本返回（防大文件卡顿）。
 */

const MAX_HIGHLIGHT_BYTES = 1.5 * 1024 * 1024;

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---------- 各语言族的词法规则（pattern 内一律使用非捕获组） ----------

const STR = {
    dq: /"(?:\\[\s\S]|[^"\\\n])*"?/,
    sq: /'(?:\\[\s\S]|[^'\\\n])*'?/,
    bt: /`(?:\\[\s\S]|[^`\\])*`?/,
};

const KW = (words) => new RegExp('(?:' + words.map(w => w.replace(/[$]/g, '[$]')).join('|') + ')\\b');

const LANGS = {
    'js': {
        rules: [
            { re: /\/\/[^\n]*/, cls: 't-com' },
            { re: /\/\*[\s\S]*?\*\//, cls: 't-com' },
            { re: STR.dq, cls: 't-str' },
            { re: STR.sq, cls: 't-str' },
            { re: STR.bt, cls: 't-str' },
            { re: /\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/, cls: 't-num' },
            { re: KW(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends', 'super', 'import', 'export', 'from', 'default', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'async', 'await', 'yield', 'static', 'get', 'set', 'delete', 'void']), cls: 't-kw' },
            { re: /\b(?:true|false|null|undefined|NaN|Infinity|this)\b/, cls: 't-lit' },
            { re: /[A-Za-z_$][\w$]*(?=\s*\()/, cls: 't-fn' },
        ],
    },
    'hash': {
        rules: [
            { re: /#[^\n]*/, cls: 't-com' },
            { re: /"""[\s\S]*?"""/, cls: 't-str' },
            { re: STR.dq, cls: 't-str' },
            { re: STR.sq, cls: 't-str' },
            { re: /\b\d+(?:\.\d+)?\b/, cls: 't-num' },
            { re: KW(['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'pass', 'global', 'nonlocal', 'yield', 'async', 'await', 'self', 'None', 'True', 'False', 'not', 'and', 'or', 'in', 'is']), cls: 't-kw' },
            { re: /[A-Za-z_][\w]*(?=\s*\()/, cls: 't-fn' },
        ],
    },
    'json': {
        rules: [
            { re: STR.dq, cls: 't-str' },
            { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, cls: 't-num' },
            { re: /\b(?:true|false|null)\b/, cls: 't-lit' },
        ],
    },
    'css': {
        rules: [
            { re: /\/\*[\s\S]*?\*\//, cls: 't-com' },
            { re: STR.dq, cls: 't-str' },
            { re: STR.sq, cls: 't-str' },
            { re: /#[0-9a-fA-F]{3,8}\b/, cls: 't-num' },
            { re: /\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms|deg|fr)?\b/, cls: 't-num' },
            { re: /@[\w-]+/, cls: 't-kw' },
            { re: /[\w-]+(?=\s*:)/, cls: 't-prop' },
            { re: /[.#][\w-]+/, cls: 't-fn' },
        ],
    },
    'html': {
        rules: [
            { re: /<!--[\s\S]*?-->/, cls: 't-com' },
            { re: /<\/?[\w:-]+/, cls: 't-tag' },
            { re: /"/, cls: '' }, // 占位（见下方 attribute 处理）
            { re: /[\w:-]+(?==)/, cls: 't-attr' },
            { re: /=/, cls: 't-punc' },
        ],
        // html 需要专门的「属性值字符串」处理，单独走函数
    },
    'sql': {
        rules: [
            { re: /--[^\n]*/, cls: 't-com' },
            { re: /\/\*[\s\S]*?\*\//, cls: 't-com' },
            { re: STR.sq, cls: 't-str' },
            { re: STR.dq, cls: 't-str' },
            { re: /\b\d+(?:\.\d+)?\b/, cls: 't-num' },
            { re: KW(['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'ALTER', 'DROP', 'INDEX', 'VIEW', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'OFFSET', 'HAVING', 'UNION', 'ALL', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'AS', 'DISTINCT', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DEFAULT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'LIKE', 'IN', 'BETWEEN', 'TRUE', 'FALSE']), cls: 't-kw' },
        ],
    },
    'md': {
        rules: [
            { re: /^#{1,6}[^\n]*/, cls: 't-kw' },
            { re: /`[^`\n]*`/, cls: 't-str' },
            { re: /\*\*[^*\n]+\*\*/, cls: 't-kw' },
            { re: /\*[^*\n]+\*/, cls: 't-fn' },
            { re: /\[[^\]\n]*\]\([^)\n]*\)/, cls: 't-str' },
            { re: /^>[^\n]*/m, cls: 't-com' },
        ],
    },
    'generic': {
        rules: [
            { re: /#[^\n]*/, cls: 't-com' },
            { re: /\/\/[^\n]*/, cls: 't-com' },
            { re: STR.dq, cls: 't-str' },
            { re: STR.sq, cls: 't-str' },
            { re: /\b\d+(?:\.\d+)?\b/, cls: 't-num' },
            { re: /\b(?:true|false|null|undefined)\b/, cls: 't-lit' },
        ],
    },
};

// 扩展名 / 语言名 → 语言族
const ALIASES = new Map(Object.entries({
    js: 'js', mjs: 'js', cjs: 'js', ts: 'js', jsx: 'js', tsx: 'js', json: 'json', jsonc: 'json',
    java: 'js', kt: 'js', kts: 'js', dart: 'js', go: 'js', rs: 'js', php: 'js', c: 'js', h: 'js',
    cpp: 'js', hpp: 'js', cs: 'js', swift: 'js', scala: 'js', groovy: 'js',
    py: 'hash', rb: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', fish: 'hash', lua: 'hash',
    pl: 'hash', r: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash', ini: 'hash', conf: 'hash',
    cfg: 'hash', env: 'hash', properties: 'hash', gitignore: 'hash', dockerfile: 'hash',
    makefile: 'hash', graphql: 'hash',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
    jsx2: 'html', xhtml: 'html', plist: 'html', rss: 'html', atom: 'html', csproj: 'html',
    sql: 'sql', md: 'md', markdown: 'md',
    txt: 'generic', log: 'generic', diff: 'generic', patch: 'generic',
}));

/** 词法扫描并输出高亮 HTML */
function scanTokens(code, lang) {
    const config = LANGS[lang] || LANGS.generic;
    let rules = config.rules;
    if (lang === 'html') {
        // html：把属性值字符串（= "..."）作为整体处理
        rules = [
            { re: /<!--[\s\S]*?-->/, cls: 't-com' },
            { re: /<\/?[\w:-]+/, cls: 't-tag' },
            { re: /=\s*"(?:[^"]*)"?\s*/, cls: 't-str' },
            { re: /=\s*'(?:[^']*)'?\s*/, cls: 't-str' },
            { re: /[\w:-]+(?=\s*=)/, cls: 't-attr' },
            { re: /\/?>/, cls: 't-tag' },
        ];
    }
    const master = new RegExp(rules.map(r => '(' + r.re.source + ')').join('|'), 'gm');
    let out = '';
    let last = 0;
    let m;
    while ((m = master.exec(code)) !== null) {
        if (m.index > last) out += escapeHtml(code.slice(last, m.index));
        for (let g = 1; g < m.length; g++) {
            if (m[g] !== undefined) {
                const cls = rules[g - 1].cls;
                out += cls ? `<span class="${cls}">${escapeHtml(m[g])}</span>` : escapeHtml(m[g]);
                break;
            }
        }
        last = m.index + m[0].length;
        if (m[0].length === 0) master.lastIndex++; // 防零宽死循环
    }
    if (last < code.length) out += escapeHtml(code.slice(last));
    return out;
}

/**
 * 高亮代码，返回 HTML 字符串（已转义，安全）。
 * @param {string} code 原始代码
 * @param {string} lang 语言名/扩展名（自动归族）
 */
export function highlightCode(code, lang) {
    if (typeof code !== 'string' || !code) return '';
    if (code.length > MAX_HIGHLIGHT_BYTES) return escapeHtml(code);
    const family = ALIASES.get(String(lang || '').toLowerCase()) || 'generic';
    try {
        return scanTokens(code, family);
    } catch (e) {
        return escapeHtml(code);
    }
}
