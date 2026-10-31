#!/usr/bin/env node
/**
 * cf-imgbed 插件扫描器
 *
 * 用法：node plugins/scan.mjs
 *
 * 做两件事（产物需提交进 git，CF Pages 部署时无需任何 CI 步骤）：
 *   1. 递归扫描 plugins/ 下所有含 plugin.json 的目录（支持任意层级嵌套），
 *      生成 plugins/_registry.js —— 插件静态注册表。
 *   2. 将每个插件 assets/ 目录下的前端源文件（.html/.css/.js）内容
 *      内嵌为 plugins/<name>/_assets.js —— 因为 Workers/Pages 运行时
 *      无法读取文件系统，必须以 JS 字符串形式随代码一起部署。
 *
 * 何时需要重新运行：新增/删除/重命名插件、修改 plugin.json、
 * 修改任何插件的 assets/ 文件之后。
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { join, relative, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = __dirname; // plugins/ 本身
const REGISTRY_FILE = join(PLUGINS_DIR, '_registry.js');

const PLUGIN_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ASSET_EXTS = new Set(['.html', '.css', '.js', '.txt', '.svg']);

// ==================== 递归发现插件 ====================

function discoverPluginDirs(dir, results = []) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return results;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('_') || entry.name === 'node_modules') continue;
        const sub = join(dir, entry.name);
        if (existsSync(join(sub, 'plugin.json'))) {
            results.push(sub);
        } else {
            discoverPluginDirs(sub, results); // 递归：插件可以放在任意子目录
        }
    }
    return results;
}

function loadManifest(pluginDir) {
    const rel = relative(PLUGINS_DIR, pluginDir).replace(/\\/g, '/');
    const folderName = basename(pluginDir);
    let manifest = {};
    try {
        manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
    } catch (e) {
        console.warn(`[scan] ${rel}/plugin.json 解析失败，跳过该插件: ${e.message}`);
        return null;
    }
    const name = manifest.name || folderName;
    if (!PLUGIN_NAME_RE.test(name)) {
        console.warn(`[scan] 插件名 "${name}" 不合法（仅限字母数字-_），跳过`);
        return null;
    }
    return {
        name,
        displayName: manifest.displayName || name,
        version: String(manifest.version || '0.0.0'),
        enabled: manifest.enabled !== false,
        order: Number.isFinite(manifest.order) ? manifest.order : 100,
        relDir: rel,
        assetsDir: join(pluginDir, 'assets'),
    };
}

// ==================== 内嵌前端资源 ====================

function collectAssets(assetsDir) {
    const files = [];
    function walk(dir) {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (ASSET_EXTS.has(require_ext(entry.name))) {
                files.push(full);
            }
        }
    }
    function require_ext(name) {
        const i = name.lastIndexOf('.');
        return i >= 0 ? name.slice(i).toLowerCase() : '';
    }
    walk(assetsDir);
    return files;
}

function generateAssetsModule(plugin) {
    const assetFiles = existsSync(plugin.assetsDir) ? collectAssets(plugin.assetsDir) : [];
    const map = {};
    for (const file of assetFiles) {
        const key = relative(plugin.assetsDir, file).replace(/\\/g, '/');
        const content = readFileSync(file, 'utf8');
        map[key] = content;
    }
    const lines = [
        '/**',
        ` * 插件 ${plugin.name} 的前端资源（由 plugins/scan.mjs 自动生成，请勿手动编辑）`,
        ` * 源文件位于 plugins/${plugin.relDir}/assets/，修改后需重新运行 node plugins/scan.mjs`,
        ' */',
        '',
        `export const PLUGIN_VERSION = ${JSON.stringify(plugin.version)};`,
        '',
        'export const ASSET_MAP = ' + JSON.stringify(map, null, 2) + ';',
        '',
        'export default ASSET_MAP;',
        '',
    ];
    return { code: lines.join('\n'), count: assetFiles.length };
}

// ==================== 生成注册表 ====================

function main() {
    const pluginDirs = discoverPluginDirs(PLUGINS_DIR);
    const plugins = pluginDirs.map(loadManifest).filter(Boolean);
    plugins.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

    if (plugins.length === 0) {
        console.warn('[scan] 未发现任何插件（plugins/ 下没有含 plugin.json 的目录）');
    }

    const imports = [];
    const entries = [];
    let assetTotal = 0;

    for (const plugin of plugins) {
        // 1) 生成/更新 _assets.js
        const assets = generateAssetsModule(plugin);
        const assetsFile = join(PLUGINS_DIR, plugin.relDir, '_assets.js');
        writeFileSync(assetsFile, assets.code, 'utf8');
        assetTotal += assets.count;

        // 2) 注册表条目（静态 import，兼容 Pages / Worker / Docker 三种部署）
        const varName = 'plugin_' + plugin.name.replace(/-/g, '_');
        imports.push(`import * as ${varName} from './${plugin.relDir}/index.js';`);
        entries.push(
            '  {\n' +
            `    name: ${JSON.stringify(plugin.name)},\n` +
            `    displayName: ${JSON.stringify(plugin.displayName)},\n` +
            `    version: ${JSON.stringify(plugin.version)},\n` +
            `    enabled: ${plugin.enabled},\n` +
            `    order: ${plugin.order},\n` +
            `    module: ${varName},\n` +
            '  }'
        );
        console.log(`[scan] ${plugin.enabled ? '+' : '-'} ${plugin.relDir} (${plugin.name}@${plugin.version}${plugin.enabled ? '' : '，已停用'})`);
    }

    const registry = [
        '/**',
        ' * cf-imgbed 插件注册表（由 plugins/scan.mjs 自动生成，请勿手动编辑）',
        ' * 新增/删除插件后运行：node plugins/scan.mjs',
        ' */',
        '',
        ...imports,
        '',
        'export const PLUGINS = [',
        entries.join(',\n'),
        '];',
        '',
    ].join('\n');

    writeFileSync(REGISTRY_FILE, registry, 'utf8');
    console.log(`[scan] 已生成 _registry.js（${plugins.length} 个插件，内嵌 ${assetTotal} 个前端资源文件）`);
}

main();
