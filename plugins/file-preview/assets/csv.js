/**
 * CSV/TSV 解析器（浏览器端）
 * 支持引号包裹、双引号转义、自动分隔符检测（, ; \t |）。
 * 安全模型：单元格内容仅作为 textContent 渲染，不参与 HTML 拼接。
 */

const MAX_ROWS = 3000;
const MAX_COLS = 200;

export function parseCSV(text) {
    const src = String(text || '');
    const firstLine = src.split('\n', 1)[0] || '';
    const candidates = [',', ';', '\t', '|'];
    let delimiter = ',';
    let maxCount = -1;
    for (const d of candidates) {
        const c = firstLine.split(d).length;
        if (c > maxCount) {
            maxCount = c;
            delimiter = d;
        }
    }

    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    let truncated = false;

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                cell += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === delimiter) {
            row.push(cell);
            cell = '';
        } else if (ch === '\n') {
            row.push(cell.replace(/\r$/, ''));
            cell = '';
            if (row.some(c => c !== '')) {
                if (rows.length >= MAX_ROWS) {
                    truncated = true;
                    break;
                }
                rows.push(row.slice(0, MAX_COLS));
            }
            row = [];
        } else if (ch !== '\r') {
            cell += ch;
        }
    }
    // 末行（无换行结尾）
    row.push(cell);
    if (row.some(c => c !== '') && rows.length < MAX_ROWS) {
        rows.push(row.slice(0, MAX_COLS));
    }

    return { rows, delimiter, truncated, maxRows: MAX_ROWS };
}
