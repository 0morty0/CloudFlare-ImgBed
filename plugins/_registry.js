/**
 * cf-imgbed 插件注册表（由 plugins/scan.mjs 自动生成，请勿手动编辑）
 * 新增/删除插件后运行：node plugins/scan.mjs
 */

import * as plugin_referer_guard from './referer-guard/index.js';
import * as plugin_share_link from './share-link/index.js';
import * as plugin_file_stats from './file-stats/index.js';
import * as plugin_file_preview from './file-preview/index.js';

export const PLUGINS = [
  {
    name: "referer-guard",
    displayName: "防盗链",
    version: "1.0.0",
    enabled: true,
    order: 10,
    allowMethods: ["POST"],
    configPath: "/plugins/referer-guard/manager",
    module: plugin_referer_guard,
  },
  {
    name: "share-link",
    displayName: "临时分享链接",
    version: "1.0.0",
    enabled: true,
    order: 20,
    allowMethods: ["POST"],
    configPath: "/plugins/share-link/manager",
    module: plugin_share_link,
  },
  {
    name: "file-stats",
    displayName: "访问统计",
    version: "1.0.0",
    enabled: true,
    order: 30,
    allowMethods: ["POST"],
    configPath: "/plugins/file-stats/manager",
    module: plugin_file_stats,
  },
  {
    name: "file-preview",
    displayName: "文件在线预览",
    version: "1.2.0",
    enabled: true,
    order: 100,
    allowMethods: ["POST"],
    configPath: "/plugins/file-preview/manager",
    module: plugin_file_preview,
  }
];
