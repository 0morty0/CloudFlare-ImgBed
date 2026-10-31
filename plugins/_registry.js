/**
 * cf-imgbed 插件注册表（由 plugins/scan.mjs 自动生成，请勿手动编辑）
 * 新增/删除插件后运行：node plugins/scan.mjs
 */

import * as plugin_file_preview from './file-preview/index.js';

export const PLUGINS = [
  {
    name: "file-preview",
    displayName: "文件在线预览",
    version: "1.0.0",
    enabled: true,
    order: 100,
    module: plugin_file_preview,
  }
];
