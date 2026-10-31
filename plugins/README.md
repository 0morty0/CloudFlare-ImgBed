# cf-imgbed 插件系统

一套以「最小侵入」为原则的插件架构：对原项目的全部改动只有 **2 个新增文件**（`functions/_middleware.js` 与 `functions/plugins/[[path]].js`），其余一切扩展能力都收敛在本目录。

## 目录结构

```
plugins/
├── _registry.js      # 插件注册表（scan.mjs 自动生成，提交进 git）
├── _loader.js        # 运行时加载器（路由分发 + 请求/响应钩子 + 运行时开关）
├── _manager.js       # 插件管理面板（/plugins/_manager/）
├── scan.mjs          # 递归扫描器（新增/修改插件后运行）
├── file-preview/     # 文件在线预览（HTML 审计 / 信任沙箱 / 全屏）
├── share-link/       # 临时分享链接（带过期与撤回）
├── referer-guard/    # 防盗链（Referer 白名单）
├── file-stats/       # 文件访问统计（Top 榜 + 流水）
└── <你的插件>/
    ├── plugin.json   # 插件清单
    ├── index.js      # 插件入口
    └── assets/       # （可选）前端资源，scan 时内嵌为 _assets.js
```

## 已装插件速览

| 插件 | 面板地址 | 说明 |
|---|---|---|
| 文件在线预览 | —（挂在 `/file/*`） | 文本/代码/CSV/Markdown 预览；HTML 默认全禁沙箱，管理员可对单个文件开启信任（Blob + iframe sandbox 无同源权限，可跑脚本/表单/弹窗，带安全审计卡与全屏按钮） |
| 临时分享链接 | `/plugins/share-link/` | 为单个文件生成带过期时间的 HMAC 签名链接，可撤回，不暴露真实路径 |
| 防盗链 | `/plugins/referer-guard/` | Referer 白名单（含子域），站外盗链 403；默认停用，需面板开启 |
| 访问统计 | `/plugins/file-stats/` | 每文件 GET 计数、Top 榜与最近流水；注意 KV 免费版每日约 1000 次写上限 |

插件图标：在 `/plugins/_manager/` 每个插件卡片的「设置」里填图标 URL（http/https），保存在 KV。

## 快速开始

1. 新建目录 `plugins/my-plugin/`，放入 `plugin.json` 与 `index.js`
2. 运行 `node plugins/scan.mjs`（递归检测任意层级嵌套的插件）
3. 提交代码并部署（Pages 直接推送即可；Worker 需先运行 `node deploy/worker/generate-routes.js`）

## plugin.json 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| name | string | 插件名，也是 URL 命名空间（`/plugins/<name>/`），默认取目录名 |
| displayName | string | 管理面板显示名 |
| version | string | 版本号 |
| enabled | boolean | 安装级开关：false 则 scan 不注册（需重跑 scan） |
| order | number | 钩子执行顺序，升序 |
| allowMethods | string[] | 插件路由允许的非幂等方法（如 `["POST"]`）；GET/HEAD 始终允许，默认仅只读 |
| description | string | 描述（管理面板展示） |

## 插件入口 API（index.js）

```js
export default {
    // 初始化（每个 Worker 实例一次）
    async init({ env }) {},

    // 自有路由：处理 /plugins/my-plugin/<subPath>
    async handleRoute(context, subPath) {
        // context.request / context.env 与 Pages Functions 一致
        return new Response('hi');
    },

    // 请求前置钩子：返回 Response 拦截原路由；返回 null/undefined 放行
    async onRequest({ request, env, url }) { return null; },

    // 响应后置钩子：可改写并返回新 Response；异常自动降级为原响应
    async onResponse({ request, env, url, response }, response) { return response; },
}
```

钩子约定：

- **命名空间路由**只在 `/plugins/<name>/...` 下生效，`_manager` 为内置管理面板保留字。
- **onRequest / onResponse** 对全站生效（静态资源除外），请务必先判断路径再处理。
- 插件抛出异常只会被记录告警，不会影响主站请求。
- 前端资源放 `assets/` 子目录，scan 后通过 `/plugins/<name>/assets/<文件名>` 访问；在 index.js 中 `import { ASSET_MAP } from './_assets.js'` 获取内容并自组路由。

## 运行时开关

- 管理面板：`/plugins/_manager/`（需管理员登录，与主站后台同一会话）
- 开关状态存于 KV `img_url` 的 `plugins:disabled` 键，约 10 秒全实例生效，无需重新部署
- `plugin.json` 的 `enabled: false` 是安装级卸载（需重跑 scan 并部署），适合彻底移除

## 三种部署模式兼容性

| 模式 | 插件路由 | 钩子 | 备注 |
|---|---|---|---|
| CF Pages | ✅ 自动 | ✅ 自动 | 推送即生效 |
| CF Worker | ✅ 自动 | ✅ 自动 | 部署前跑 `generate-routes.js`（原项目既有流程） |
| Docker | ✅ 需 1 行 | ✅ 自动 | `deploy/server/index.js` 的 `FUNCTION_PREFIXES` 加 `'/plugins'` |
