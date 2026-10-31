/**
 * cf-imgbed 插件管理面板（内置模块，非扫描插件）
 *
 * 路由（挂载在 /plugins/_manager/ 下）：
 *   GET  /plugins/_manager/           管理页面（自包含单页）
 *   GET  /plugins/_manager/api/list   插件列表与开关状态（需管理员会话）
 *   POST /plugins/_manager/api/toggle 切换插件开关（需管理员会话）
 *
 * 鉴权：复用原项目的管理员会话认证（functions/utils/auth/authCore.js），
 * 与管理后台登录状态互通——先在 /login 登录管理员，再打开本页即可。
 * 若上游更新导致 authCore 路径变化，本模块自动降级返回明确错误，
 * 不影响插件系统其余功能。
 *
 * 开关状态：存于 KV（img_url 命名空间，键 plugins:disabled），
 * 所有 Worker 实例约 10 秒内同步生效，无需重新部署。
 */

import { getPluginStatuses, setPluginEnabled } from './_loader.js';

const KV_FALLBACK_HINT = '未检测到 KV 绑定，开关仅内存生效（重启后还原）';

// ==================== 鉴权 ====================

async function isAdmin(context) {
    const { env, request, url } = context;
    try {
        const { authenticate, AUTH_SCOPE } = await import('../functions/utils/auth/authCore.js');
        const result = await authenticate({
            env,
            request,
            url,
            authScope: AUTH_SCOPE.ADMIN,
        });
        return Boolean(result && result.authorized);
    } catch (e) {
        // 上游认证模块路径变化等：拒绝而不是放行
        console.warn('[plugins] 管理面板鉴权模块加载失败:', e);
        return false;
    }
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}

// ==================== API ====================

async function handleApi(context, subPath) {
    const { request, env } = context;

    if (!(await isAdmin(context))) {
        return jsonResponse({ error: 'unauthorized', message: '请先以管理员身份登录管理后台' }, 401);
    }

    if (subPath === 'api/list' && request.method === 'GET') {
        const list = await getPluginStatuses(env);
        const hasKv = Boolean(env.img_url);
        // 逐插件读取自定义图标 URL（plugins:icon:<name>）
        if (hasKv) {
            await Promise.all(list.map(async p => {
                try {
                    p.icon = (await env.img_url.get('plugins:icon:' + p.name)) || '';
                } catch (e) {
                    p.icon = '';
                }
            }));
        } else {
            list.forEach(p => { p.icon = ''; });
        }
        return jsonResponse({ plugins: list, kvPersisted: hasKv, hint: hasKv ? '' : KV_FALLBACK_HINT });
    }

    if (subPath === 'api/icon' && request.method === 'POST') {
        let body;
        try {
            body = await request.json();
        } catch (e) {
            return jsonResponse({ error: 'invalid_json' }, 400);
        }
        const name = typeof body.name === 'string' ? body.name : '';
        const icon = typeof body.icon === 'string' ? body.icon.trim() : '';
        if (!name) return jsonResponse({ error: 'missing_name' }, 400);
        if (!/^[\w.-]+$/.test(name)) return jsonResponse({ error: 'invalid_name' }, 400);
        // 图标 URL 白名单校验：仅 http(s)，长度受限；空值表示清除图标
        if (icon !== '') {
            if (icon.length > 500) return jsonResponse({ error: 'icon_too_long' }, 400);
            if (!/^https?:\/\//i.test(icon)) return jsonResponse({ error: 'icon_must_be_http_url' }, 400);
        }
        try {
            if (icon === '') {
                await env.img_url.delete('plugins:icon:' + name);
            } else {
                await env.img_url.put('plugins:icon:' + name, icon);
            }
        } catch (e) {
            return jsonResponse({ error: 'kv_write_failed' }, 500);
        }
        return jsonResponse({ ok: true, name, icon });
    }

    if (subPath === 'api/toggle' && request.method === 'POST') {
        let body;
        try {
            body = await request.json();
        } catch (e) {
            return jsonResponse({ error: 'invalid_json' }, 400);
        }
        const name = typeof body.name === 'string' ? body.name : '';
        const enabled = body.enabled === true;
        if (!name) return jsonResponse({ error: 'missing_name' }, 400);
        const result = await setPluginEnabled(env, name, enabled);
        if (!result.ok) return jsonResponse(result, 404);
        return jsonResponse(result);
    }

    return jsonResponse({ error: 'not_found' }, 404);
}

// ==================== 管理页面 ====================

const MANAGER_HTML = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<title>插件管理</title>',
    '<style>',
    ':root{--bg:#0d1117;--panel:#161b22;--fg:#e6edf3;--dim:#8b949e;--border:#30363d;--acc:#388bfd;--ok:#3fb950;--off:#484f58}',
    '@media (prefers-color-scheme: light){:root{--bg:#f6f8fa;--panel:#fff;--fg:#1f2328;--dim:#6e7781;--border:#d0d7de;--acc:#0969da;--ok:#1a7f37;--off:#afb8c1}}',
    '*{box-sizing:border-box;margin:0}',
    'body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;padding:24px}',
    '.wrap{max-width:720px;margin:0 auto}',
    'h1{font-size:20px;margin-bottom:4px}',
    '.sub{color:var(--dim);font-size:12.5px;margin-bottom:20px}',
    '.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;margin-bottom:12px}',
    '.rowline{display:flex;align-items:center;gap:14px;width:100%}',
    '.info{flex:1;min-width:0}',
    '.name{font-weight:600;font-size:15px}',
    '.meta{color:var(--dim);font-size:12px;margin-top:2px;word-break:break-all}',
    '.icon{width:40px;height:40px;border-radius:10px;flex:none;object-fit:cover;background:var(--bg);border:1px solid var(--border);display:block}',
    '.rside{display:flex;align-items:center;gap:10px;flex:none}',
    '.cog{appearance:none;border:1px solid var(--border);background:transparent;color:var(--dim);border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit}',
    '.cog:hover{color:var(--fg);border-color:var(--fg)}',
    '.setting{display:none;border-top:1px solid var(--border);margin-top:12px;padding-top:12px;gap:8px;flex-wrap:wrap;align-items:center}',
    '.setting.open{display:flex}',
    '.setting input{flex:1;min-width:200px;background:var(--bg);border:1px solid var(--border);color:var(--fg);border-radius:8px;padding:6px 10px;font-size:13px;font-family:inherit}',
    '.sbtn{border:1px solid var(--acc);background:var(--acc);color:#fff;border-radius:8px;padding:6px 14px;font-size:12.5px;cursor:pointer;font-family:inherit}',
    '.sbtn.ghost{background:transparent;color:var(--dim);border-color:var(--border)}',
    '.sbtn:disabled{opacity:.6;cursor:default}',
    '.smsg{width:100%;font-size:12px;color:var(--dim)}',
    '.switch{position:relative;width:46px;height:26px;flex:none}',
    '.switch input{opacity:0;width:0;height:0}',
    '.track{position:absolute;inset:0;background:var(--off);border-radius:999px;transition:.2s;cursor:pointer}',
    '.track:before{content:"";position:absolute;width:20px;height:20px;border-radius:50%;background:#fff;top:3px;left:3px;transition:.2s}',
    'input:checked + .track{background:var(--ok)}',
    'input:checked + .track:before{transform:translateX(20px)}',
    '.hint{color:var(--dim);font-size:12px;margin-top:8px}',
    '.err{color:var(--fg);background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px;margin-top:32px;text-align:center}',
    '.err a{color:var(--acc)}',
    '.loading{color:var(--dim);text-align:center;padding:40px 0}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="wrap">',
    '<h1>插件管理</h1>',
    '<div class="sub">cf-imgbed Plugin Manager · 开关约 10 秒内全实例生效，无需重新部署</div>',
    '<div id="list" class="loading">正在加载…</div>',
    '<div id="errbox" style="display:none" class="err"><div id="errmsg"></div></div>',
    '</div>',
    '<script>',
    '(function(){',
    'var list=document.getElementById("list");',
    'var errbox=document.getElementById("errbox");',
    'var errmsg=document.getElementById("errmsg");',
    'function showError(msg,login){',
    '  list.style.display="none";errbox.style.display="";',
    '  errmsg.textContent=msg;',
    '  if(login){var a=document.createElement("a");a.href="/login";a.textContent="前往登录";errmsg.appendChild(document.createElement("br"));errmsg.appendChild(a);}',
    '}',
    'function load(){',
    '  fetch("api/list",{credentials:"same-origin"}).then(function(r){return r.json().then(function(j){return {status:r.status,json:j};});}).then(function(res){',
    '    if(res.status===401){showError(res.json.message||"未授权，请先以管理员身份登录",true);return;}',
    '    if(res.status!==200){showError("加载失败：HTTP "+res.status);return;}',
    '    render(res.json);',
    '  }).catch(function(e){showError("网络错误："+e);});',
    '}',
    'function render(data){',
    '  list.style.display="";errbox.style.display="none";list.textContent="";',
    '    if(!data.plugins||!data.plugins.length){',
    '      var empty=document.createElement("div");empty.className="card";',
    '      var ei=document.createElement("div");ei.className="info";',
    '      var en=document.createElement("div");en.className="name";en.textContent="暂无已安装插件";',
    '      var em=document.createElement("div");em.className="meta";em.textContent="在仓库 plugins/ 目录添加插件后运行 node plugins/scan.mjs";',
    '      ei.appendChild(en);ei.appendChild(em);empty.appendChild(ei);list.appendChild(empty);return;}',
    '  data.plugins.forEach(function(p){',
    '    var card=document.createElement("div");card.className="card";',
    '    var row=document.createElement("div");row.className="rowline";',
    '    if(p.icon){',
    '      var img=document.createElement("img");img.className="icon";img.src=p.icon;img.alt="";img.loading="lazy";img.referrerPolicy="no-referrer";',
    '      img.onerror=function(){img.style.display="none";};',
    '      row.appendChild(img);',
    '    }',
    '    var info=document.createElement("div");info.className="info";',
    '    var name=document.createElement("div");name.className="name";name.textContent=p.displayName;',
    '    var meta=document.createElement("div");meta.className="meta";meta.textContent=p.name+" · v"+p.version;',
    '    info.appendChild(name);info.appendChild(meta);',
    '    var right=document.createElement("div");right.className="rside";',
    '    var sw=document.createElement("label");sw.className="switch";',
    '    var input=document.createElement("input");input.type="checkbox";input.checked=p.runtimeEnabled;',
    '    var track=document.createElement("span");track.className="track";',
    '    sw.appendChild(input);sw.appendChild(track);',
    '    input.addEventListener("change",function(){',
    '      var next=input.checked;input.disabled=true;',
    '      fetch("api/toggle",{method:"POST",credentials:"same-origin",',
    '        headers:{"Content-Type":"application/json"},',
    '        body:JSON.stringify({name:p.name,enabled:next})',
    '      }).then(function(r){return r.json();}).then(function(j){',
    '        input.disabled=false;',
    '        if(!j.ok){input.checked=!next;showError("切换失败："+(j.error||"未知错误"));setTimeout(load,1500);return;}',
    '      }).catch(function(e){input.disabled=false;input.checked=!next;showError("网络错误："+e);setTimeout(load,1500);});',
    '    });',
    '    var cog=document.createElement("button");cog.type="button";cog.className="cog";cog.textContent="设置";',
    '    right.appendChild(sw);right.appendChild(cog);',
    '    row.appendChild(info);row.appendChild(right);',
    '    card.appendChild(row);',
    '    var panel=document.createElement("div");panel.className="setting";',
    '    var inp=document.createElement("input");inp.type="text";inp.value=p.icon||"";inp.placeholder="图标 URL（https:// 开头，留空恢复默认）";',
    '    var save=document.createElement("button");save.type="button";save.className="sbtn";save.textContent="保存图标";',
    '    var cancel=document.createElement("button");cancel.type="button";cancel.className="sbtn ghost";cancel.textContent="收起";',
    '    var msg=document.createElement("div");msg.className="smsg";msg.textContent="图标显示在本页插件卡片左侧；仅支持 http(s) 图片地址。";',
    '    cog.addEventListener("click",function(){panel.classList.toggle("open");});',
    '    cancel.addEventListener("click",function(){panel.classList.remove("open");});',
    '    save.addEventListener("click",function(){',
    '      save.disabled=true;msg.textContent="保存中…";',
    '      fetch("api/icon",{method:"POST",credentials:"same-origin",',
    '        headers:{"Content-Type":"application/json"},',
    '        body:JSON.stringify({name:p.name,icon:inp.value.trim()})',
    '      }).then(function(r){return r.json();}).then(function(j){',
    '        save.disabled=false;',
    '        if(j.ok){load();}',
    '        else{msg.textContent="保存失败："+(j.error==="icon_must_be_http_url"?"图标必须是 http(s) 链接":j.error==="icon_too_long"?"图标 URL 过长":(j.error||"未知错误"));}',
    '      }).catch(function(e){save.disabled=false;msg.textContent="网络错误，请重试";});',
    '    });',
    '    panel.appendChild(inp);panel.appendChild(save);panel.appendChild(cancel);panel.appendChild(msg);',
    '    card.appendChild(panel);',
    '    list.appendChild(card);',
    '  });',
    '  if(data.hint){var h=document.createElement("div");h.className="hint";h.textContent=data.hint;list.appendChild(h);}',
    '}',
    'load();',
    '})();',
    '</script>',
    '</body>',
    '</html>',
].join('\n');

function pageResponse() {
    return new Response(MANAGER_HTML, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex',
        },
    });
}

// ==================== 入口 ====================

export async function handleManagerRoute(context, subPath) {
    const { request } = context;

    if (subPath === 'api/list' || subPath === 'api/toggle' || subPath === 'api/icon') {
        return await handleApi(context, subPath);
    }

    if (request.method === 'GET' && (subPath === '' || subPath === 'index.html' || subPath === '/')) {
        return pageResponse();
    }

    return new Response('Not Found', { status: 404 });
}
