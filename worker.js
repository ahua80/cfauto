/**
 * Cloudflare Worker 多项目部署管理器 (智能补全版)
 * * 修复日志：
 * 1. [关键] 增加 initVars 智能合并逻辑：每次加载时，强制检查并补全默认变量 (PROXYIP/URL等)，防止消失。
 * 2. [优化] 默认变量始终置顶显示，自定义变量显示在下方。
 * 3. [保持] 严格的项目隔离 (CMliu / Joey 数据互不干扰)。
 */

// ==========================================
// 项目模板配置
// ==========================================
const TEMPLATES = {
  'cmliu': {
    name: "CMliu - EdgeTunnel",
    scriptUrl: "https://raw.githubusercontent.com/cmliu/edgetunnel/beta2.0/_worker.js",
    // 这些变量会强制显示，不会消失
    defaultVars: ["UUID", "PROXYIP", "PATH", "URL", "KEY", "ADMIN"],
    uuidField: "UUID",
    description: "CMliu 项目 (标准版)"
  },
  'joey': {
    name: "Joey - 少年你相信光吗",
    scriptUrl: "https://raw.githubusercontent.com/byJoey/cfnew/main/%E5%B0%91%E5%B9%B4%E4%BD%A0%E7%9B%B8%E4%BF%A1%E5%85%89%E5%90%97",
    defaultVars: ["u"],
    uuidField: "u",
    description: "Joey 项目 (自动修复版)"
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const correctCode = env.ACCESS_CODE; 
    const urlCode = url.searchParams.get("code");
    const cookieHeader = request.headers.get("Cookie") || "";
    
    if (correctCode && !cookieHeader.includes(`auth=${correctCode}`) && urlCode !== correctCode) {
      return new Response(loginHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    const type = url.searchParams.get("type") || "cmliu";
    const ACCOUNTS_KEY = `ACCOUNTS_UNIFIED_STORAGE`; 
    const VARS_KEY = `VARS_${type}`; // 变量按项目隔离

    // 账号管理
    if (url.pathname === "/api/accounts") {
      if (request.method === "GET") {
        const list = await env.CONFIG_KV.get(ACCOUNTS_KEY) || "[]";
        return new Response(list, { headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST") {
        const body = await request.json();
        await env.CONFIG_KV.put(ACCOUNTS_KEY, JSON.stringify(body));
        return new Response(JSON.stringify({ success: true }));
      }
    }

    // 变量管理
    if (url.pathname === "/api/settings") {
      if (request.method === "GET") {
        const vars = await env.CONFIG_KV.get(VARS_KEY);
        // 返回 null 让前端去处理默认值补全
        return new Response(vars || "null", { headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST") {
        const body = await request.json();
        await env.CONFIG_KV.put(VARS_KEY, JSON.stringify(body));
        return new Response(JSON.stringify({ success: true }));
      }
    }

    // 部署接口
    if (url.pathname === "/api/deploy" && request.method === "POST") {
      return await handleBatchDeploy(request, env, type, ACCOUNTS_KEY);
    }

    const response = new Response(mainHtml(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    if (urlCode === correctCode && correctCode) {
      response.headers.set("Set-Cookie", `auth=${correctCode}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
    }
    return response;
  }
};

async function handleBatchDeploy(request, env, type, accountsKey) {
  try {
    const { variables } = await request.json(); 
    const templateConfig = TEMPLATES[type];
    if (!templateConfig) return new Response(JSON.stringify([{ name: "错误", success: false, msg: "未知模板类型" }]));

    const accounts = JSON.parse(await env.CONFIG_KV.get(accountsKey) || "[]");
    const logs = [];

    if (accounts.length === 0) return new Response(JSON.stringify([{ name: "提示", success: false, msg: "请先添加账号" }]));
    
    // 1. 拉取代码
    let githubScriptContent = "";
    try {
        const ghRes = await fetch(templateConfig.scriptUrl);
        if (!ghRes.ok) throw new Error(`GitHub 代码拉取失败: ${ghRes.status}`);
        githubScriptContent = await ghRes.text();
    } catch (e) {
        return new Response(JSON.stringify([{ name: "网络错误", success: false, msg: "无法连接 GitHub" }]));
    }

    // 2. 注入 Joey 补丁
    if (type === 'joey') {
        githubScriptContent = 'var window = globalThis;\n' + githubScriptContent;
    }

    // 3. 遍历账号更新
    let updateCount = 0;
    for (const acc of accounts) {
      const targetWorkers = acc[`workers_${type}`] || [];
      if (!Array.isArray(targetWorkers) || targetWorkers.length === 0) continue;

      for (const wName of targetWorkers) {
          updateCount++;
          const logItem = { name: `${acc.alias} -> [${wName}]`, success: false, msg: "" };
          let step = "准备";
          
          try {
            if (acc.accountId.includes("@") || acc.accountId.length < 20) throw new Error("ID格式错误");

            const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/workers/scripts/${wName}`;
            const headers = { "Authorization": `Bearer ${acc.apiToken}` };

            step = "读取配置";
            const bindingsRes = await fetch(`${baseUrl}/bindings`, { headers });
            if (!bindingsRes.ok) {
               if (bindingsRes.status === 400 || bindingsRes.status === 403) throw new Error(`Token无效`);
               if (bindingsRes.status !== 404) throw new Error(`HTTP ${bindingsRes.status}`);
            }
            const bindingsData = bindingsRes.ok ? await bindingsRes.json() : { result: [] };
            let currentBindings = bindingsData.result || [];

            step = "合并变量";
            if (variables && variables.length > 0) {
                for (const newVar of variables) {
                    if (newVar.value && newVar.value.trim() !== "") {
                        const existingIndex = currentBindings.findIndex(b => b.name === newVar.key);
                        if (existingIndex !== -1) {
                            currentBindings[existingIndex] = { name: newVar.key, type: "plain_text", text: newVar.value };
                        } else {
                            currentBindings.push({ name: newVar.key, type: "plain_text", text: newVar.value });
                        }
                    }
                }
            }

            step = "上传部署";
            const metadata = { 
                main_module: "index.js", 
                bindings: currentBindings, 
                compatibility_date: "2024-01-01" 
            };
            const formData = new FormData();
            formData.append("metadata", JSON.stringify(metadata));
            formData.append("script", new Blob([githubScriptContent], { type: "application/javascript+module" }), "index.js");

            const updateRes = await fetch(baseUrl, { method: "PUT", headers, body: formData });
            const updateData = await updateRes.json();

            if (updateRes.ok) {
              logItem.success = true;
              logItem.msg = `✅ 更新成功`;
            } else {
              logItem.msg = `❌ API拒绝: ${updateData.errors?.[0]?.message}`;
            }

          } catch (err) {
            logItem.msg = `❌ [${step}] ${err.message}`;
          }
          logs.push(logItem);
      } 
    }
    
    if (updateCount === 0) {
        return new Response(JSON.stringify([{ name: "提示", success: true, msg: `未配置 ${type} 项目的 Worker` }]));
    }

    return new Response(JSON.stringify(logs), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify([{ name: "系统错误", success: false, msg: e.message }]));
  }
}

function loginHtml() { return `<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f3f4f6"><form method="GET"><input type="password" name="code" placeholder="密码" style="padding:10px"><button style="padding:10px">登录</button></form></body></html>`; }

function mainHtml() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Worker 智能分流中控</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .input-field { border: 1px solid #cbd5e1; padding: 0.5rem; width:100%; border-radius: 4px; transition:all 0.2s;} 
    .input-field:focus { border-color:#3b82f6; outline:none; box-shadow: 0 0 0 2px rgba(59,130,246,0.1); }
    .theme-cmliu { border-color: #ef4444; } 
    .theme-joey { border-color: #3b82f6; }  
  </style>
</head>
<body class="bg-slate-100 p-4 md:p-8">
  <div class="max-w-6xl mx-auto space-y-6">
    
    <header class="bg-white p-6 rounded shadow flex flex-col md:flex-row justify-between items-center gap-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <span>🚀</span> Worker 部署中控
        </h1>
        <div class="text-xs text-gray-500 mt-1" id="template_desc">...</div>
      </div>
      
      <div class="flex items-center gap-3 bg-slate-50 p-2 rounded border border-blue-100 shadow-sm">
        <div class="text-right">
            <div class="text-[10px] text-gray-400 uppercase font-bold">当前项目</div>
            <div class="text-sm font-bold text-blue-600" id="current_project_label">...</div>
        </div>
        <select id="template_select" onchange="switchTemplate()" class="bg-white border border-gray-300 text-gray-900 text-sm rounded focus:ring-blue-500 block p-2 cursor-pointer font-bold">
          <option value="cmliu">🔴 CMliu (EdgeTunnel)</option>
          <option value="joey">🔵 Joey (CFNew)</option>
        </select>
      </div>
    </header>
    
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      
      <div class="lg:col-span-2 bg-white p-6 rounded shadow flex flex-col h-fit">
        <h2 class="font-bold mb-4 border-b pb-2 text-gray-700">📡 账号管理 (通用)</h2>
        
        <div class="bg-slate-50 p-4 mb-4 border rounded shadow-inner">
           <div class="space-y-3 mb-3">
             <div class="flex gap-3">
                 <input id="in_alias" placeholder="备注 (如: 主力账号)" class="input-field w-1/3 font-bold">
                 <input id="in_id" placeholder="Account ID (32位)" class="input-field w-2/3 text-blue-600 font-mono">
             </div>
             <div>
                 <input id="in_token" type="password" placeholder="API Token (必须有 Edit Workers 权限)" class="input-field">
             </div>
             
             <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-gray-200 mt-2">
                 <div>
                    <label class="text-xs font-bold text-red-600 mb-1 block">🔴 CMliu Workers</label>
                    <input id="in_workers_cmliu" placeholder="用逗号隔开" class="input-field font-mono bg-red-50 border-red-200 focus:border-red-400">
                 </div>
                 <div>
                    <label class="text-xs font-bold text-blue-600 mb-1 block">🔵 Joey Workers</label>
                    <input id="in_workers_joey" placeholder="用逗号隔开" class="input-field font-mono bg-blue-50 border-blue-200 focus:border-blue-400">
                 </div>
             </div>
           </div>
           <button onclick="addAccount()" id="btnSave" class="w-full bg-slate-700 text-white py-2 rounded font-bold hover:bg-slate-800 transition shadow-md">保存 / 更新账号</button>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-sm text-left">
            <thead class="bg-gray-50 text-gray-500"><tr><th class="p-2 w-1/5">备注</th><th class="p-2">Worker 分配详情</th><th class="p-2 w-20 text-right">操作</th></tr></thead>
            <tbody id="tableBody"></tbody>
          </table>
        </div>
      </div>

      <div id="vars_panel" class="lg:col-span-1 bg-white p-6 rounded shadow h-fit border-t-4 transition-colors duration-300">
        <h2 class="font-bold mb-4 border-b pb-2 flex justify-between items-center">
          <span>⚙️ 变量配置</span>
          <span onclick="resetVars()" class="text-[10px] text-gray-400 cursor-pointer hover:text-blue-500 underline">强制重置</span>
        </h2>
        
        <div id="vars_container" class="space-y-3 mb-6 min-h-[100px]">
           <div class="text-center text-gray-400 text-xs py-4">读取中...</div>
        </div>
        
        <div class="flex justify-between items-center mb-2">
            <button onclick="addVarRow()" class="text-xs bg-gray-100 px-2 py-1 rounded hover:bg-gray-200 text-gray-600 border">+ 自定义变量</button>
            <span onclick="refreshUUID()" id="btn_refresh_uuid" class="cursor-pointer text-xs text-blue-600 font-bold hover:underline">🎲 刷新</span>
        </div>

        <button onclick="deploy()" id="btnDeploy" class="w-full bg-green-600 hover:bg-green-700 text-white py-3 rounded font-bold transition shadow-lg flex flex-col items-center justify-center gap-0 h-14">
           <span class="text-sm">🔄 立即执行更新</span>
           <span class="text-[10px] font-normal opacity-80" id="deploy_hint">...</span>
        </button>
        
        <div id="logs" class="mt-4 bg-slate-900 text-green-400 p-3 rounded text-xs font-mono hidden max-h-60 overflow-y-auto"></div>
      </div>
    </div>
  </div>

  <script>
    const TEMPLATES = {
      'cmliu': { defaultVars: ["UUID", "PROXYIP", "PATH", "URL", "KEY", "ADMIN"], uuidField: "UUID", desc: "CMliu 项目 (标准变量)" },
      'joey':  { defaultVars: ["u"], uuidField: "u", desc: "Joey 项目 (代码修复)" }
    };

    let accounts = [];
    let currentTemplate = 'cmliu';

    async function init() { 
        const params = new URLSearchParams(window.location.search);
        const type = params.get('type');
        if (type && TEMPLATES[type]) {
            currentTemplate = type;
            document.getElementById('template_select').value = type;
        }
        await loadData();
    }

    async function switchTemplate() {
        currentTemplate = document.getElementById('template_select').value;
        const url = new URL(window.location);
        url.searchParams.set('type', currentTemplate);
        window.history.pushState({}, '', url);
        document.getElementById('vars_container').innerHTML = '<div class="text-center text-gray-400 text-xs py-4">加载中...</div>';
        await loadData();
    }

    async function loadData() {
        const config = TEMPLATES[currentTemplate];
        document.getElementById('template_desc').innerText = config.desc;
        document.getElementById('current_project_label').innerText = currentTemplate === 'cmliu' ? 'CMliu' : 'Joey';
        document.getElementById('deploy_hint').innerText = \`更新 \${currentTemplate === 'cmliu' ? '🔴 CMliu' : '🔵 Joey'} 的 Worker\`;
        document.getElementById('btn_refresh_uuid').innerText = \`🎲 刷新 \${config.uuidField}\`;
        
        const panel = document.getElementById('vars_panel');
        panel.className = \`lg:col-span-1 bg-white p-6 rounded shadow h-fit border-t-4 transition-colors duration-300 \${currentTemplate === 'cmliu' ? 'theme-cmliu' : 'theme-joey'}\`;

        try {
            const [accRes, settingRes] = await Promise.all([
                fetch(\`/api/accounts\`),
                fetch(\`/api/settings?type=\${currentTemplate}\`)
            ]);
            accounts = await accRes.json();
            const savedSettings = await settingRes.json();
            renderTable(); 
            // 调用新的智能初始化函数
            initVars(savedSettings);
        } catch(e) { alert("加载失败: " + e.message); }
    }
    
    // 智能初始化变量：KV数据 + 默认补全
    function initVars(savedData) {
        const container = document.getElementById('vars_container');
        container.innerHTML = '';
        
        const defaults = TEMPLATES[currentTemplate].defaultVars;
        const uuidKey = TEMPLATES[currentTemplate].uuidField;
        
        // 将保存的数据转为 Map 方便查找
        const savedMap = new Map();
        if (savedData && Array.isArray(savedData)) {
            savedData.forEach(item => savedMap.set(item.key, item.value));
        }

        // 1. 优先按顺序渲染默认变量 (如果KV里没有，则补上空值或UUID)
        defaults.forEach(key => {
            let val = savedMap.get(key) || '';
            // 如果是 UUID 且为空，自动生成一个 (方便用户)
            if (val === '' && key === uuidKey) {
                val = crypto.randomUUID();
            }
            addVarRow(key, val);
            // 渲染完从Map中移除，避免重复
            savedMap.delete(key);
        });

        // 2. 渲染剩下的自定义变量 (如果有的话)
        savedMap.forEach((val, key) => {
            addVarRow(key, val);
        });
    }

    function resetVars() {
        if(!confirm("确定要重置为默认变量吗？")) return;
        // 传入 null，强制 initVars 使用默认逻辑
        initVars(null);
    }

    function renderTable() {
      const tb = document.getElementById('tableBody');
      if(accounts.length==0) tb.innerHTML='<tr><td colspan="3" class="text-center text-gray-400 py-4">暂无数据</td></tr>';
      else tb.innerHTML = accounts.map((a,i) => {
        const cmliuList = Array.isArray(a.workers_cmliu) ? a.workers_cmliu : [];
        const cTags = cmliuList.map(w => \`<span class="inline-block bg-red-50 text-red-600 text-[10px] px-1 rounded border border-red-100 mr-1">C:\${w}</span>\`).join('');
        const joeyList = Array.isArray(a.workers_joey) ? a.workers_joey : [];
        const jTags = joeyList.map(w => \`<span class="inline-block bg-blue-50 text-blue-600 text-[10px] px-1 rounded border border-blue-100 mr-1">J:\${w}</span>\`).join('');
        const allTags = (cTags + jTags) || '<span class="text-gray-300 text-xs">未分配</span>';
        return \`<tr class="border-b hover:bg-gray-50 transition">
          <td class="p-2 font-medium">\${a.alias}</td>
          <td class="p-2">\${allTags}</td>
          <td class="p-2 text-right space-x-1">
            <button onclick="edit(\${i})" class="text-blue-600 text-xs bg-blue-50 px-2 py-1 rounded">改</button>
            <button onclick="del(\${i})" class="text-red-600 text-xs bg-red-50 px-2 py-1 rounded">删</button>
          </td></tr>\`;
      }).join('');
    }

    function edit(i) {
      const a = accounts[i];
      document.getElementById('in_alias').value = a.alias;
      document.getElementById('in_id').value = a.accountId;
      document.getElementById('in_token').value = a.apiToken;
      document.getElementById('in_workers_cmliu').value = (a.workers_cmliu || []).join(', ');
      document.getElementById('in_workers_joey').value = (a.workers_joey || []).join(', ');
      accounts.splice(i,1); renderTable(); 
      const btn = document.getElementById('btnSave'); btn.innerText = "修改中..."; btn.classList.replace('bg-slate-700', 'bg-orange-500');
    }

    async function addAccount() {
      const alias = document.getElementById('in_alias').value.trim();
      const id = document.getElementById('in_id').value.trim();
      const token = document.getElementById('in_token').value.trim();
      const cStr = document.getElementById('in_workers_cmliu').value.trim();
      const jStr = document.getElementById('in_workers_joey').value.trim();
      if(!id || !token) return alert("ID 和 Token 必填");

      accounts.push({
          alias: alias||'未命名', 
          accountId: id, 
          apiToken: token, 
          workers_cmliu: cStr.split(/,|，/).map(s=>s.trim()).filter(s=>s.length>0),
          workers_joey:  jStr.split(/,|，/).map(s=>s.trim()).filter(s=>s.length>0)
      });
      await fetch(\`/api/accounts\`, {method:'POST', body:JSON.stringify(accounts)});
      
      document.getElementById('in_alias').value = '';
      document.getElementById('in_id').value = '';
      document.getElementById('in_token').value = '';
      document.getElementById('in_workers_cmliu').value = '';
      document.getElementById('in_workers_joey').value = '';
      const btn = document.getElementById('btnSave'); btn.innerText = "保存 / 更新账号"; btn.classList.replace('bg-orange-500', 'bg-slate-700');
      renderTable();
    }

    async function del(i) { if(confirm('确定删除?')) { accounts.splice(i,1); await fetch(\`/api/accounts\`, {method:'POST', body:JSON.stringify(accounts)}); renderTable(); } }

    function addVarRow(key = '', val = '') {
      const div = document.createElement('div');
      div.className = 'var-row flex gap-2 items-center';
      div.innerHTML = \`
        <div class="w-1/3"><input class="input-field font-mono text-xs var-key font-bold text-gray-700" value="\${key}" placeholder="Key"></div>
        <div class="w-2/3 flex gap-1"><input class="input-field font-mono text-xs var-val" value="\${val}" placeholder="Value">
        <button onclick="this.parentElement.parentElement.remove()" class="text-gray-400 hover:text-red-500 px-1">×</button></div>
      \`;
      document.getElementById('vars_container').appendChild(div);
    }

    // 精准刷新
    function refreshUUID() {
       const targetKey = TEMPLATES[currentTemplate].uuidField;
       const rows = document.querySelectorAll('.var-row');
       let found = false;
       rows.forEach(row => {
           const keyInput = row.querySelector('.var-key');
           if(keyInput && keyInput.value === targetKey) {
               const valInput = row.querySelector('.var-val');
               valInput.value = crypto.randomUUID();
               valInput.classList.add('bg-green-100');
               setTimeout(() => valInput.classList.remove('bg-green-100'), 500);
               found = true;
           }
       });
       if(!found) alert(\`未找到变量 \${targetKey}\`);
    }

    async function deploy() {
      const keys = document.querySelectorAll('.var-key');
      const vals = document.querySelectorAll('.var-val');
      const variables = [];
      for(let i=0; i<keys.length; i++) {
          const k = keys[i].value.trim();
          const v = vals[i].value.trim();
          if(k) variables.push({key: k, value: v});
      }

      const btn = document.getElementById('btnDeploy'); btn.disabled=true; 
      const log = document.getElementById('logs'); log.classList.remove('hidden'); log.innerHTML = '正在分析...';
      
      try {
        await fetch(\`/api/settings?type=\${currentTemplate}\`, {method: 'POST', body: JSON.stringify(variables)});
        const res = await fetch(\`/api/deploy?type=\${currentTemplate}\`, {method:'POST', body:JSON.stringify({variables})});
        const data = await res.json();
        log.innerHTML = data.map(l => \`<div class="\${l.success?'text-green-400':'text-red-400'} border-b border-gray-700 mb-1 pb-1">[\${l.success?'✔':'✘'}] \${l.name}<br><span class="text-gray-500 ml-4">\${l.msg}</span></div>\`).join('');
      } catch(e) { log.innerHTML = \`<div class="text-red-500">\${e.message}</div>\`; }
      btn.disabled=false; 
    }
    init();
  </script>
</body></html>
  `;
}
