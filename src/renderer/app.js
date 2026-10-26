const api = window.kmcl;

const state = {
  config: null,
  presets: {},
  versions: [],
  javas: [],
  manifest: null,
  manifestLoading: false,
  forge: null,
  forgeLoading: false,
  fabric: { mc: '', items: [] },
  fabricLoading: false,
  neoforge: [],
  neoforgeLoading: false,
  optifine: { mc: '', items: [] },
  optifineLoading: false,
  page: 'home',
  tab: 'game',
  typeFilter: 'release',
  search: '',
  busy: null,
  gameRunning: false,
  javaScanning: false,
  account: null,
  authMode: 'offline',
  loginDevice: null,
  loginPending: false,
  mods: [],
  modsDir: '',
  modsLoading: false,
  modsSearch: '',
  modsVersion: '',
  modTab: 'installed',
  modResults: [],
  modTotal: 0,
  modPage: 0,
  modCategory: '',
  modLoading: false,
  packResults: [],
  packTotal: 0,
  packPage: 0,
  packLoading: false,
  taskDetail: null,
  taskPhases: [],
  progressOpen: false,
  installTarget: null,
  installForgeList: null,
  installFabricList: null,
  installNeoForgeList: null,
  installOfList: null,
  installAvail: {},
  installing: new Set(),
  modDetail: null,
  pendingMod: null,
  // 英文 mod 名 → MC 百科中文名（当前会话缓存）
  cnNames: {},
  // 待确认导入的本地整合包信息
  pendingPack: null,
  taskHideTimer: null,
  jvmTimer: null,
  memTimer: null,
  nameTimer: null
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanError(err) {
  let msg = (err && err.message) || String(err || '未知错误');
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*/, '');
  msg = msg.replace(/^Error:\s*/, '');
  return msg;
}

function toast(message, type = 'info', timeout = 4200) {
  const box = $('#toasts');
  const div = document.createElement('div');
  div.className = 'toast' + (type === 'error' ? ' error' : type === 'warn' ? ' warn' : '');
  div.textContent = message;
  box.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transform = 'translateX(20px)';
    div.style.transition = 'all 0.25s ease';
    setTimeout(() => div.remove(), 260);
  }, timeout);
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN');
}

function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)} 亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  return String(v);
}

function openModal(sel) {
  const el = $(sel);
  if (el) el.classList.remove('hidden');
}

function closeModal(sel) {
  const el = $(sel);
  if (el) el.classList.add('hidden');
}

function appendLog(line) {
  const pre = $('#console');
  pre.textContent += (pre.textContent ? '\n' : '') + line;
  const lines = pre.textContent.split('\n');
  if (lines.length > 500) pre.textContent = lines.slice(-500).join('\n');
  const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 120;
  if (nearBottom) pre.scrollTop = pre.scrollHeight;
}

function installedIds() {
  return new Set(state.versions.map((v) => v.id));
}

function baseVersions() {
  return state.versions.filter((v) => !v.baseVersion && v.hasJar);
}

function versionKind(v) {
  const id = (v.id || '').toLowerCase();
  if (v.modpack) return '整合包';
  if (id.includes('neoforge')) return 'NeoForge';
  if (id.includes('forge')) return 'Forge';
  if (id.includes('optifine')) return 'OptiFine';
  return '原版';
}

/** 版本的 Minecraft 基版本（加载器版本取 inheritsFrom） */
function versionMcOf(v) {
  if (!v) return '';
  return v.baseVersion || v.id || '';
}

/** 版本对应的模组加载器 */
function loaderOf(v) {
  const id = ((v && v.id) || '').toLowerCase();
  if (id.includes('neoforge')) return 'neoforge';
  if (id.includes('forge')) return 'forge';
  if (id.includes('fabric')) return 'fabric';
  return '';
}

function selectedModVersion() {
  return state.versions.find((v) => v.id === state.modsVersion) || null;
}

function currentConfig() {
  return state.config || {};
}

function mirrorLabel() {
  const c = currentConfig();
  if (c.mirror === 'official') return '官方源 Mojang';
  if (c.mirror === 'custom') return c.customMirror || '自定义镜像（未填写）';
  return 'BMCLAPI 国内镜像';
}

async function applyConfig(patch, opts = {}) {
  try {
    const cfg = await api.updateConfig(patch);
    state.config = cfg;
    $('#mirror-badge').textContent = mirrorLabel();
    if (opts.rerender) renderAll();
  } catch (e) {
    toast(cleanError(e), 'error');
  }
}

/* ------------------------------ 导航 ------------------------------ */

function switchPage(page) {
  state.page = page;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'download') {
    if (!state.manifest && !state.manifestLoading) loadManifest();
    if (state.tab === 'forge' && !state.forge && !state.forgeLoading) loadForgeList();
    if (state.tab === 'fabric' && !state.fabricLoading && state.fabric.mc !== $('#fabric-mc').value) ensureFabricList();
    if (state.tab === 'neoforge' && !state.neoforge.length && !state.neoforgeLoading) loadNeoForgeList();
    if (state.tab === 'optifine' && !state.optifineLoading && state.optifine.mc !== $('#of-mc').value) ensureOptiFineList();
  }
  if (page === 'versions') refreshVersions();
  if (page === 'mods') {
    renderModsVersionSelect();
    if (state.modTab === 'installed') loadMods();
    else if (state.modTab === 'browse' && !state.modResults.length) searchMods(true);
    else if (state.modTab === 'packs' && !state.packResults.length) searchPacks(true);
  }
  if (page === 'settings') {
    renderSettings();
    if (!state.javas.length) scanJavaInBackground();
  }
}

function switchTab(tab) {
  state.tab = tab;
  $$('#dl-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $$('#page-download .tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'forge' && !state.forge && !state.forgeLoading) loadForgeList();
  if (tab === 'fabric' && !state.fabricLoading && state.fabric.mc !== $('#fabric-mc').value) ensureFabricList();
  if (tab === 'neoforge' && !state.neoforge.length && !state.neoforgeLoading) loadNeoForgeList();
  if (tab === 'optifine' && !state.optifineLoading && state.optifine.mc !== $('#of-mc').value) ensureOptiFineList();
}

/* ------------------------------ 渲染：启动页 ------------------------------ */

function renderHome() {
  const select = $('#home-version');
  const installed = state.versions;
  let html = '';
  const bases = installed.filter((v) => !v.baseVersion);
  const others = installed.filter((v) => v.baseVersion);
  if (bases.length) {
    html += '<optgroup label="原版">';
    for (const v of bases) {
      html += `<option value="${escapeHtml(v.id)}">${escapeHtml(v.id)}</option>`;
    }
    html += '</optgroup>';
  }
  if (others.length) {
    html += '<optgroup label="加载器 / 优化">';
    for (const v of others) {
      html += `<option value="${escapeHtml(v.id)}">${escapeHtml(v.id)}</option>`;
    }
    html += '</optgroup>';
  }

  const prev = select.value || currentConfig().lastVersion;
  select.innerHTML = html;
  if (!installed.length) {
    select.innerHTML = '<option value="">暂无已安装版本</option>';
  } else if (prev && installed.some((v) => v.id === prev)) {
    select.value = prev;
  }

  $('#home-username').value = currentConfig().username || 'Steve';
  renderAccount();
  $('#btn-launch').disabled = !installed.length || state.gameRunning || !!state.busy;
  $('#btn-launch').textContent = state.gameRunning ? '游戏运行中' : '启动游戏';
  $('#btn-kill').hidden = !state.gameRunning;
  renderHomeMeta();
  renderMemorySummary();
  $('#mirror-badge').textContent = mirrorLabel();
}

function renderHomeMeta() {
  const id = $('#home-version').value;
  const v = state.versions.find((x) => x.id === id);
  const meta = $('#home-version-meta');
  if (!v) {
    meta.textContent = '尚未安装任何版本，请前往“下载中心”安装';
    return;
  }
  const parts = [versionKind(v)];
  if (v.baseVersion) parts.push(`基于 ${v.baseVersion}`);
  parts.push(v.hasJar || v.baseVersion ? '文件完整' : '缺少核心文件');
  meta.textContent = parts.join(' · ');
}

function renderMemorySummary() {
  const c = currentConfig();
  const box = $('#home-memory');
  const java = c.javaPath ? c.javaPath.split(/[\\/]/).slice(-1)[0] : '自动选择';
  const mem = c.autoTune
    ? '<b>自动调节</b>（按物理内存 / Java / mod 数量）'
    : `<b>${c.minMemory} MB</b> ～ <b>${c.maxMemory} MB</b>`;
  box.innerHTML = `内存分配：${mem}<br />Java：${escapeHtml(java)} · 下载线程：${c.downloadThreads}`;
}

function renderAccount() {
  const acc = state.account;
  const mode = acc ? state.authMode || 'offline' : 'offline';
  const name = (currentConfig().username || 'Steve').trim() || 'Steve';
  const title = $('#account-title');
  const sub = $('#account-sub');
  if (acc) {
    title.textContent = acc.name;
    sub.textContent = `正版 Microsoft 账号 · ${String(acc.uuid || '').slice(0, 8)}`;
  } else {
    title.textContent = `离线账号 · ${name}`;
    sub.textContent = '未登录正版账号';
  }
  $$('#account-mode .chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.mode === mode);
  });
  $('#btn-login-ms').hidden = !!acc;
  $('#btn-logout-ms').hidden = !acc;
  const msaMode = mode === 'msa';
  $('#home-username').hidden = msaMode;
  $('#account-hint').textContent = msaMode
    ? '启动时使用正版账号，可进入正版服务器（Hybrid / 正版验证）'
    : '离线昵称仅用于本地存档；正版账号可进入正版服务器';
}

function switchAuthMode(mode) {
  if (mode === 'msa' && !state.account) {
    openLoginModal();
    return;
  }
  state.authMode = mode;
  applyConfig({ authMode: mode });
  renderAccount();
}

function closeLoginModal() {
  state.loginPending = false;
  state.loginDevice = null;
  $('#login-modal').classList.add('hidden');
}

async function openLoginModal() {
  if (state.loginPending) return;
  state.loginPending = true;
  state.loginDevice = null;
  $('#login-modal').classList.remove('hidden');
  $('#login-code').textContent = '------';
  $('#login-status').textContent = '正在申请登录代码…';
  $('#btn-open-verify').disabled = true;
  try {
    const info = await api.authLogin();
    state.loginDevice = info;
    $('#login-code').textContent = info.userCode;
    $('#login-status').textContent = `等待授权…（代码 ${Math.max(
      1,
      Math.round(info.expiresIn / 60)
    )} 分钟内有效）`;
    $('#btn-open-verify').disabled = false;
    api.openExternal(info.verificationUri).catch(() => {});
  } catch (e) {
    state.loginPending = false;
    $('#login-status').textContent = '发起登录失败：' + cleanError(e);
    $('#btn-open-verify').disabled = true;
  }
}

async function cancelLogin() {
  await api.authCancel();
  closeLoginModal();
  toast('已取消正版登录', 'warn');
}

async function logoutAccount() {
  if (!window.confirm('确定退出当前正版账号吗？')) return;
  await api.authLogout();
  state.account = null;
  state.authMode = 'offline';
  await applyConfig({ authMode: 'offline' });
  renderAll();
  toast('已退出正版账号', 'info');
}

function handleAuthChange(payload) {
  if (payload.status === 'success') {
    state.account = payload.account;
    state.authMode = 'msa';
    closeLoginModal();
    applyConfig({ authMode: 'msa' });
    renderAll();
    toast(`正版登录成功：${payload.account.name}`, 'info');
    return;
  }
  if (payload.status === 'error') {
    state.loginPending = false;
    $('#login-status').textContent = `登录失败：${payload.message}`;
    $('#btn-open-verify').disabled = true;
    toast('正版登录失败：' + payload.message, 'error', 9000);
    return;
  }
  if (payload.status === 'cancelled') {
    closeLoginModal();
  }
}

/* ------------------------------ 渲染：下载页 ------------------------------ */

async function loadManifest(force = false) {
  state.manifestLoading = true;
  const list = $('#dl-list');
  list.innerHTML = '<div class="empty">正在获取版本列表…</div>';
  try {
    state.manifest = await api.getManifest(force);
    state.manifestLoading = false;
    renderDownloadGame();
  } catch (e) {
    state.manifestLoading = false;
    list.innerHTML = `<div class="empty">获取版本列表失败：${escapeHtml(cleanError(e))}</div>`;
    toast('获取版本列表失败：' + cleanError(e), 'error');
  }
}

function filterManifest() {
  const all = (state.manifest && state.manifest.versions) || [];
  const keyword = state.search.trim().toLowerCase();
  return all.filter((v) => {
    let typeOk = true;
    if (state.typeFilter === 'release') typeOk = v.type === 'release';
    else if (state.typeFilter === 'snapshot') typeOk = v.type === 'snapshot';
    else if (state.typeFilter === 'old') typeOk = v.type === 'old_beta' || v.type === 'old_alpha';
    if (!typeOk) return false;
    if (keyword && !v.id.toLowerCase().includes(keyword)) return false;
    return true;
  });
}

function typeBadge(type) {
  if (type === 'release') return '<span class="badge release">正式版</span>';
  if (type === 'snapshot') return '<span class="badge snapshot">快照</span>';
  return '<span class="badge old">远古</span>';
}

function renderDownloadGame() {
  const list = $('#dl-list');
  if (state.manifestLoading) return;
  if (!state.manifest) {
    list.innerHTML = '<div class="empty">正在获取版本列表…</div>';
    return;
  }
  const items = filterManifest();
  const installed = installedIds();
  if (!items.length) {
    list.innerHTML = '<div class="empty">没有匹配的版本</div>';
    return;
  }
  const shown = items.slice(0, 250);
  list.innerHTML =
    shown
      .map((v) => {
        const isInstalled = installed.has(v.id);
        const busy = state.installing.has(v.id) || state.busy;
        return `<div class="row-item ${isInstalled ? 'installed' : ''}">
          <div class="row-main">
            <div>
              <div class="row-title">
                ${escapeHtml(v.id)}
                ${typeBadge(v.type)}
                ${isInstalled ? '<span class="badge installed">已安装</span>' : ''}
              </div>
              <div class="row-sub">发布于 ${formatDate(v.releaseTime) || '未知'}</div>
            </div>
          </div>
          <div class="row-actions">
            <button class="btn mini ${isInstalled ? 'ghost' : 'primary'} dl-install" data-id="${escapeHtml(v.id)}" ${
          busy ? 'disabled' : ''
        }>${isInstalled ? '修复 / 重装' : '安装'}</button>
          </div>
        </div>`;
      })
      .join('') +
    (items.length > shown.length
      ? `<div class="hint" style="text-align:center;padding:10px">共 ${items.length} 个版本，仅显示前 ${shown.length} 个，请使用搜索缩小范围</div>`
      : '');
}

/* ------------------------------ 安装版本（可选注入加载器） ------------------------------ */

const LOADER_LABELS = { forge: 'Forge', fabric: 'Fabric', neoforge: 'NeoForge', optifine: 'OptiFine' };
const LOADER_TYPES = ['forge', 'fabric', 'neoforge'];

async function openInstallModal(id) {
  if (state.busy) {
    toast('已有任务正在进行', 'warn');
    return;
  }
  state.installTarget = id;
  state.installForgeList = null;
  state.installFabricList = null;
  state.installNeoForgeList = null;
  state.installOfList = null;
  state.installAvail = {};
  $('#install-title').textContent = `安装 ${id}`;
  $('#install-modal').classList.remove('hidden');

  LOADER_TYPES.concat('optifine').forEach((t) => {
    const chk = $(`#chk-${t}`);
    chk.checked = false;
    chk.disabled = true;
  });
  ['#install-forge-ver', '#install-fabric-ver', '#install-neoforge-ver', '#install-of-ver'].forEach((sel) => {
    $(sel).disabled = true;
  });
  $$('#install-modal .opt-row').forEach((row) => {
    row.classList.remove('unavailable', 'locked');
    row.title = '';
    delete row.dataset.conflicted;
  });
  ['install-forge-hint', 'install-fabric-hint', 'install-neoforge-hint', 'install-of-hint'].forEach((hid) => {
    const hint = $(`#${hid}`);
    delete hint.dataset.base;
    hint.innerHTML = '正在检查适配情况…';
  });
  $('#install-combo-hint').textContent = '';
  // 加载器列表仍在后台获取，先允许用户直接安装原版，避免长时间等待
  $('#btn-install-start').disabled = false;

  try {
    // 四类加载器分别获取：任一接口失败不影响其它选项
    const [forgeRes, fabricRes, neoRes, ofRes] = await Promise.allSettled([
      state.forge ? Promise.resolve(state.forge) : api.listForge(),
      api.listFabric(id),
      state.neoforge.length ? Promise.resolve(state.neoforge) : api.listNeoForge(),
      api.listOptiFine(id)
    ]);
    if (state.installTarget !== id) return;
    const errors = {};
    if (forgeRes.status === 'fulfilled') {
      state.forge = state.forge || forgeRes.value;
      state.installForgeList = (forgeRes.value || [])
        .filter((v) => v.mc === id)
        .sort((a, b) => compareNumeric(b.loader, a.loader));
    } else {
      state.installForgeList = [];
      errors.forge = cleanError(forgeRes.reason);
    }
    if (fabricRes.status === 'fulfilled') {
      state.installFabricList = (fabricRes.value || [])
        .slice()
        .sort((a, b) => (b.stable ? 1 : 0) - (a.stable ? 1 : 0) || compareNumeric(b.version, a.version));
    } else {
      state.installFabricList = [];
      errors.fabric = cleanError(fabricRes.reason);
    }
    if (neoRes.status === 'fulfilled') {
      if (!state.neoforge.length && Array.isArray(neoRes.value)) state.neoforge = neoRes.value;
      state.installNeoForgeList = (neoRes.value || [])
        .filter((v) => v.mc === id)
        .sort((a, b) => compareNumeric(b.version, a.version));
    } else {
      state.installNeoForgeList = [];
      errors.neoforge = cleanError(neoRes.reason);
    }
    if (ofRes.status === 'fulfilled') {
      state.installOfList = ofRes.value || [];
    } else {
      state.installOfList = [];
      errors.optifine = cleanError(ofRes.reason);
    }
    if (state.installTarget !== id) return;
    renderInstallOptions(errors);
  } catch (e) {
    if (state.installTarget !== id) return;
    state.installForgeList = [];
    state.installFabricList = [];
    state.installNeoForgeList = [];
    state.installOfList = [];
    renderInstallOptions({ forge: cleanError(e), fabric: cleanError(e), neoforge: cleanError(e), optifine: cleanError(e) });
  }
}

function markUnavailable(select, hint, label) {
  select.innerHTML = '<option value="">—</option>';
  select.disabled = true;
  hint.innerHTML = `<span class="badge no-adapt">当前版本暂不适配</span> 未找到该版本的 ${label}`;
}

/** 渲染一行加载器：列表 / 不适配 / 获取失败 */
function renderInstallRow(cfg) {
  const select = $(cfg.select);
  const hint = $(cfg.hint);
  const row = $(cfg.row);
  const check = $(cfg.check);
  const prev = select.value;
  const list = cfg.list || [];
  delete hint.dataset.base;
  if (list.length) {
    row.classList.remove('unavailable');
    check.disabled = false;
    select.disabled = false;
    select.innerHTML = list
      .map((v) => {
        const option = cfg.option(v);
        return `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`;
      })
      .join('');
    if (prev && list.some((v) => String(cfg.option(v).value) === prev)) select.value = prev;
    hint.textContent = cfg.describe(list);
    return true;
  }
  row.classList.add('unavailable');
  check.disabled = true;
  check.checked = false;
  if (cfg.error) {
    select.innerHTML = '<option value="">—</option>';
    select.disabled = true;
    hint.innerHTML = `<span class="badge no-adapt">获取失败</span> ${escapeHtml(cfg.error)}`;
  } else {
    markUnavailable(select, hint, cfg.label);
  }
  return false;
}

function renderInstallOptions(errors = {}) {
  const avails = {
    forge: renderInstallRow({
      list: state.installForgeList,
      error: errors.forge,
      select: '#install-forge-ver',
      hint: '#install-forge-hint',
      row: '#row-forge',
      check: '#chk-forge',
      label: 'Forge',
      option: (v) => ({ value: v.loader, label: `forge ${v.loader}` }),
      describe: (list) => `该版本共有 ${list.length} 个 Forge 可选（默认最新）`
    }),
    fabric: renderInstallRow({
      list: state.installFabricList,
      error: errors.fabric,
      select: '#install-fabric-ver',
      hint: '#install-fabric-hint',
      row: '#row-fabric',
      check: '#chk-fabric',
      label: 'Fabric',
      option: (v) => ({ value: v.version, label: `fabric-loader ${v.version}${v.stable ? '（稳定）' : ''}` }),
      describe: (list) => `该版本共有 ${list.length} 个 Fabric Loader 可选（默认最新稳定版）`
    }),
    neoforge: renderInstallRow({
      list: state.installNeoForgeList,
      error: errors.neoforge,
      select: '#install-neoforge-ver',
      hint: '#install-neoforge-hint',
      row: '#row-neoforge',
      check: '#chk-neoforge',
      label: 'NeoForge',
      option: (v) => ({ value: v.version, label: `neoforge ${v.version}` }),
      describe: (list) => `该版本共有 ${list.length} 个 NeoForge 可选（默认最新）`
    }),
    optifine: renderInstallRow({
      list: state.installOfList,
      error: errors.optifine,
      select: '#install-of-ver',
      hint: '#install-of-hint',
      row: '#row-optifine',
      check: '#chk-optifine',
      label: 'OptiFine',
      option: (v) => ({ value: v.edition, label: v.label || v.edition }),
      describe: (list) => `该版本共有 ${list.length} 个 OptiFine 可选（默认最新）`
    })
  };
  state.installAvail = avails;
  if (errors.forge || errors.fabric || errors.neoforge || errors.optifine) {
    $('#install-combo-hint').textContent = '部分适配信息获取失败，可关闭后重试，或仅安装原版';
  }
  syncInstallConflicts();
  $('#btn-install-start').disabled = false;
}

/** 当前已勾选且可用的加载器（Forge / Fabric / NeoForge 互斥） */
function selectedInstallLoader() {
  return LOADER_TYPES.find((t) => {
    const chk = $(`#chk-${t}`);
    return chk && chk.checked && !chk.disabled;
  }) || '';
}

/**
 * 加载器互斥：
 * - Forge / Fabric / NeoForge 只能选一个，选中后其余两项直接禁用
 * - OptiFine 仅能与原版或 Forge 共存，选择 Fabric / NeoForge 时禁用并提示冲突
 */
function syncInstallConflicts() {
  const avail = state.installAvail || {};
  const loader = selectedInstallLoader();
  LOADER_TYPES.forEach((t) => {
    const chk = $(`#chk-${t}`);
    const row = $(`#row-${t}`);
    const conflicted = !!loader && loader !== t;
    chk.disabled = !avail[t] || conflicted;
    row.classList.toggle('locked', conflicted);
    if (avail[t] && conflicted) {
      row.title = `与已选择的 ${LOADER_LABELS[loader]} 冲突，无法同时安装`;
      const hint = $(`#install-${t}-hint`);
      hint.innerHTML = `${hint.dataset.base || hint.textContent} <span class="badge conflict">与 ${LOADER_LABELS[loader]} 冲突</span>`;
    } else if (row.classList.contains('locked') || row.dataset.conflicted === '1') {
      row.title = '';
    }
    // 记录未被冲突覆盖的原始提示，避免反复追加徽章
    const hint = $(`#install-${t}-hint`);
    if (!conflicted) {
      if (row.dataset.conflicted === '1') {
        hint.innerHTML = hint.dataset.base || hint.textContent;
        row.dataset.conflicted = '';
      }
    } else {
      if (!hint.dataset.base) hint.dataset.base = hint.innerHTML;
      row.dataset.conflicted = '1';
    }
  });
  const ofConflict = !!loader && loader !== 'forge';
  const chkOf = $('#chk-optifine');
  const ofHint = $('#install-of-hint');
  const ofRow = $('#row-optifine');
  if (ofConflict) chkOf.checked = false;
  chkOf.disabled = !avail.optifine || ofConflict;
  ofRow.classList.toggle('locked', ofConflict);
  if (ofConflict) {
    ofRow.title = `OptiFine 与 ${LOADER_LABELS[loader]} 冲突，仅支持原版或 Forge`;
    if (!ofHint.dataset.base) ofHint.dataset.base = ofHint.innerHTML;
    ofHint.innerHTML = `${ofHint.dataset.base} <span class="badge conflict">与 ${LOADER_LABELS[loader]} 冲突</span>`;
    ofRow.dataset.conflicted = '1';
  } else if (ofRow.dataset.conflicted === '1') {
    ofRow.title = '';
    ofHint.innerHTML = ofHint.dataset.base || ofHint.textContent;
    ofRow.dataset.conflicted = '';
  }
  updateComboHint(loader);
}

function updateComboHint(loader) {
  const hint = $('#install-combo-hint');
  const ofChecked = $('#chk-optifine').checked && !$('#chk-optifine').disabled;
  if (loader === 'forge') {
    hint.textContent = ofChecked
      ? '将安装 Forge，并把 OptiFine 作为 mod 放入 mods 目录'
      : '将安装 Forge 加载器版本';
  } else if (loader === 'fabric') {
    hint.textContent = '将安装 Fabric 加载器版本；OptiFine 与 Fabric 冲突，已禁用';
  } else if (loader === 'neoforge') {
    hint.textContent = '将安装 NeoForge 加载器版本；OptiFine 与 NeoForge 冲突，已禁用';
  } else if (ofChecked) {
    hint.textContent = '将安装独立的 OptiFine 版本（基于原版）';
  } else {
    hint.textContent = 'Forge / Fabric / NeoForge 三者互斥，只能选择其中一个；OptiFine 可与原版或 Forge 共存';
  }
  $('#install-forge-ver').disabled = !(loader === 'forge');
  $('#install-fabric-ver').disabled = !(loader === 'fabric');
  $('#install-neoforge-ver').disabled = !(loader === 'neoforge');
  $('#install-of-ver').disabled = !ofChecked;
}

function closeInstallModal() {
  state.installTarget = null;
  $('#install-modal').classList.add('hidden');
}

async function startInstall() {
  const id = state.installTarget;
  if (!id) return;
  const checked = (t) => {
    const el = $(`#chk-${t}`);
    return !!(el && el.checked && !el.disabled);
  };
  const loaders = LOADER_TYPES.filter(checked);
  if (loaders.length > 1) {
    toast('Forge / Fabric / NeoForge 相互冲突，只能选择一个', 'warn');
    return;
  }
  const forgeVersion = checked('forge') ? $('#install-forge-ver').value : '';
  const fabricVersion = checked('fabric') ? $('#install-fabric-ver').value : '';
  const neoforgeVersion = checked('neoforge') ? $('#install-neoforge-ver').value : '';
  const optifineEdition = checked('optifine') ? $('#install-of-ver').value : '';
  if (optifineEdition && (fabricVersion || neoforgeVersion)) {
    toast('OptiFine 与 Fabric / NeoForge 冲突，无法同时安装', 'warn');
    return;
  }
  closeInstallModal();

  state.installing.add(id);
  state.busy = 'install';
  renderDownloadGame();
  renderHome();
  $('#task-title').textContent = `安装 ${id}`;
  const parts = [id];
  if (forgeVersion) parts.push(`Forge ${forgeVersion}`);
  if (fabricVersion) parts.push(`Fabric ${fabricVersion}`);
  if (neoforgeVersion) parts.push(`NeoForge ${neoforgeVersion}`);
  if (optifineEdition) parts.push(`OptiFine ${optifineEdition}`);
  appendLog(`[KMCL] 开始安装：${parts.join(' + ')}`);
  try {
    const result = await api.installVersionPlus({
      id,
      forgeVersion,
      fabricVersion,
      neoforgeVersion,
      optifineEdition
    });
    state.versions = result.versions || state.versions;
    const extras = [
      forgeVersion && 'Forge',
      fabricVersion && 'Fabric',
      neoforgeVersion && 'NeoForge',
      optifineEdition && 'OptiFine'
    ].filter(Boolean);
    toast(`${result.versionId || id} 安装完成${extras.length ? '（含 ' + extras.join(' + ') + '）' : ''}`, 'info');
    await refreshVersions();
    if (result.versionId) $('#home-version').value = result.versionId;
  } catch (e) {
    if (/取消/.test(cleanError(e))) toast('已取消安装', 'warn');
    else toast('安装失败：' + cleanError(e), 'error', 9000);
  } finally {
    state.installing.delete(id);
    state.busy = null;
    renderDownloadGame();
    renderHome();
    renderVersions();
    hideTaskPanel();
  }
}

/* ------------------------------ Mod 管理 ------------------------------ */

function renderModsVersionSelect() {
  const sel = $('#mods-version');
  if (!sel) return;
  const ids = state.versions.map((v) => v.id);
  const prev = state.modsVersion || currentConfig().lastVersion || '';
  sel.innerHTML = ids.length
    ? ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('')
    : '<option value="">暂无版本</option>';
  if (prev && ids.includes(prev)) sel.value = prev;
  state.modsVersion = sel.value || '';
  if (!state.modsVersion && ids.length) {
    state.modsVersion = ids[0];
    sel.value = ids[0];
  }
  sel.disabled = !ids.length;
}

async function loadMods() {
  state.modsLoading = true;
  const list = $('#mods-list');
  if (list) list.innerHTML = '<div class="empty">正在读取 mods 目录…</div>';
  try {
    const data = await api.listMods(state.modsVersion);
    state.mods = data.items || [];
    state.modsDir = data.dir || '';
    renderMods();
  } catch (e) {
    if (list) list.innerHTML = `<div class="empty">读取失败：${escapeHtml(cleanError(e))}</div>`;
    toast('读取 mods 失败：' + cleanError(e), 'error');
  } finally {
    state.modsLoading = false;
  }
}

function renderMods() {
  const list = $('#mods-list');
  if (!list) return;
  const keyword = state.modsSearch.trim().toLowerCase();
  const items = state.mods.filter((m) => !keyword || m.name.toLowerCase().includes(keyword));
  const enabledCount = state.mods.filter((m) => m.enabled).length;
  const summary = $('#mods-summary');
  if (summary) {
    summary.innerHTML = state.mods.length
      ? `${escapeHtml(state.modsVersion || '')}：共 ${state.mods.length} 个 mod · 已启用 ${enabledCount} 个 · 已禁用 ${
          state.mods.length - enabledCount
        } 个<br /><span class="muted">${escapeHtml(state.modsDir || '')}</span>`
      : `${escapeHtml(state.modsVersion || '')}：mods 目录为空，可在“下载 Mod”中安装，或点击“打开 mods 目录”手动放入`;
  }

  if (!items.length) {
    list.innerHTML = `<div class="empty">${state.mods.length ? '没有匹配的 mod' : '暂无 mod'}</div>`;
    return;
  }
  list.innerHTML = items
    .map(
      (m) => `<div class="mod-item ${m.enabled ? '' : 'disabled'}">
        <div class="mod-main">
          <div class="mod-name">${escapeHtml(m.name)}<span class="mod-state ${
        m.enabled ? '' : 'off'
      }">${m.enabled ? '已启用' : '已禁用'}</span></div>
          <div class="mod-sub">${formatBytes(m.size)} · ${formatDate(m.mtime) || '未知时间'}</div>
        </div>
        <div class="mod-actions">
          <button class="btn mini ${m.enabled ? 'ghost' : 'primary'} mod-toggle" data-name="${escapeHtml(
        m.name
      )}" data-enabled="${m.enabled ? '1' : '0'}">${m.enabled ? '禁用' : '启用'}</button>
          <button class="btn mini danger mod-delete" data-name="${escapeHtml(m.name)}">删除</button>
        </div>
      </div>`
    )
    .join('');
}

/* ------------------------------ Mod 下载 / 整合包 ------------------------------ */

const MOD_CATS = [
  { id: '', label: '全部' },
  { id: 'tech', label: '科技' },
  { id: 'magic', label: '魔法' },
  { id: 'adventure', label: '冒险' },
  { id: 'optimization', label: '优化' },
  { id: 'storage', label: '存储' },
  { id: 'worldgen', label: '世界生成' },
  { id: 'decoration', label: '装饰' },
  { id: 'utility', label: '实用' },
  { id: 'library', label: '前置库' }
];

function renderModCats() {
  const box = $('#mod-cats');
  if (!box) return;
  box.innerHTML = MOD_CATS.map(
    (c) =>
      `<button class="chip ${state.modCategory === c.id ? 'active' : ''}" data-cat="${c.id}">${c.label}</button>`
  ).join('');
}

function renderModCards(target, items, emptyText, buttonText) {
  const box = $(target);
  if (!box) return;
  if (!items.length) {
    box.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  box.innerHTML = items
    .map((m) => {
      const icon = m.icon
        ? `<img class="modcard-icon" src="${escapeHtml(m.icon)}" loading="lazy" alt="" />`
        : '<div class="modcard-icon"></div>';
      const tags = (m.categories || [])
        .slice(0, 3)
        .map((c) => `<span class="modcard-tag">${escapeHtml(c)}</span>`)
        .join('');
      // 优先显示 MC 百科的中文社区名称，原名作为副标题保留方便核对
      const zh = (state.cnNames && state.cnNames[m.name]) || '';
      const title = zh || m.name;
      const alt = zh ? `<div class="modcard-alt">${escapeHtml(m.name)}</div>` : '';
      return `<div class="modcard clickable" data-source="${escapeHtml(m.source)}" data-id="${escapeHtml(
        m.id
      )}" data-type="${escapeHtml(m.type)}" data-name="${escapeHtml(m.name)}" data-zh="${escapeHtml(
        zh
      )}" data-icon="${escapeHtml(m.icon || '')}" data-summary="${escapeHtml(m.summary || '')}">
        ${icon}
        <div class="modcard-body">
          <div class="modcard-title" title="${escapeHtml(m.name)}">${escapeHtml(title)}</div>
          ${alt}
          <div class="modcard-desc">${escapeHtml(m.summary || '暂无简介')}</div>
          <div class="modcard-tags">${tags}</div>
          <div class="modcard-meta">
            <span>${m.downloads ? formatCount(m.downloads) + ' 次下载' : escapeHtml(m.author || '')}</span>
            <button class="btn mini primary mod-download" data-source="${escapeHtml(
              m.source
            )}" data-id="${escapeHtml(m.id)}" data-type="${escapeHtml(m.type)}" data-name="${escapeHtml(
        m.name
      )}">${buttonText}</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

/**
 * 批量把列表中的英文 mod 名换成 MC 百科中文名。
 * 百科有请求频率限制，因此分批（每批 10 个）请求并即时刷新，避免界面等待过久。
 */
async function applyChineseNames(kind) {
  const items = kind === 'modpack' ? state.packResults : state.modResults;
  if (!items || !items.length) return;
  if (!state.cnNames) state.cnNames = {};
  for (let round = 0; round < 4; round++) {
    const pending = [...new Set(items.map((m) => m.name).filter((n) => n && !(n in state.cnNames)))].slice(0, 10);
    if (!pending.length) return;
    try {
      const map = await api.getChineseNames({ names: pending });
      for (const name of pending) state.cnNames[name] = map[name] || '';
      if (state.page === 'mods') {
        if (kind === 'modpack') renderModCards('#pack-results', items, '没有找到相关整合包', '查看');
        else renderModCards('#mod-results', items, '没有找到相关模组', '查看');
      }
    } catch (e) {
      return;
    }
  }
}

async function searchMods(reset = true) {
  if (state.modLoading) return;
  const targetVersion = selectedModVersion();
  state.modLoading = true;
  if (reset) {
    state.modPage = 0;
    state.modResults = [];
    renderModCards('#mod-results', [], '正在搜索…', '查看');
  }
  const hint = $('#mod-browse-hint');
  if (hint) hint.textContent = '正在从国内镜像搜索…（首次按版本搜索可能需要十几秒）';
  try {
    const res = await api.searchMods({
      source: $('#mod-source').value,
      type: 'mod',
      query: ($('#mod-search').value || '').trim(),
      mcVersion: ($('#mod-mc').value || '').trim() || versionMcOf(targetVersion),
      loader: $('#mod-loader').value || loaderOf(targetVersion),
      category: state.modCategory,
      page: state.modPage,
      pageSize: 20
    });
    state.modResults = reset ? res.items : state.modResults.concat(res.items);
    state.modTotal = res.total || 0;
    renderModCards('#mod-results', state.modResults, '没有找到相关 Mod，换个关键字试试', '查看');
    const more = $('#mod-more-wrap');
    if (more) more.hidden = state.modResults.length >= state.modTotal || !state.modResults.length;
    if (hint) {
      hint.textContent = state.modResults.length
        ? `共 ${state.modTotal} 个结果 · 来源：${res.source === 'modrinth' ? 'Modrinth 国内镜像' : 'CurseForge 国内镜像'}${
            res.fallback ? '（已自动切换备用源）' : ''
          }`
        : '没有找到相关 Mod';
    }
    applyChineseNames('mod');
  } catch (e) {
    renderModCards('#mod-results', [], '搜索失败：' + cleanError(e), '查看');
    if (hint) hint.textContent = '搜索失败：' + cleanError(e);
  } finally {
    state.modLoading = false;
  }
}

async function searchPacks(reset = true) {
  if (state.packLoading) return;
  const targetVersion = selectedModVersion();
  state.packLoading = true;
  if (reset) {
    state.packPage = 0;
    state.packResults = [];
    renderModCards('#pack-results', [], '正在搜索…', '查看');
  }
  const hint = $('#pack-hint');
  if (hint) hint.textContent = '正在从国内镜像搜索…';
  try {
    const res = await api.searchMods({
      source: $('#pack-source').value,
      type: 'modpack',
      query: ($('#pack-search').value || '').trim(),
      mcVersion: ($('#pack-mc').value || '').trim(),
      loader: '',
      category: '',
      page: state.packPage,
      pageSize: 20
    });
    state.packResults = reset ? res.items : state.packResults.concat(res.items);
    state.packTotal = res.total || 0;
    renderModCards('#pack-results', state.packResults, '没有找到整合包', '查看');
    const more = $('#pack-more-wrap');
    if (more) more.hidden = state.packResults.length >= state.packTotal || !state.packResults.length;
    if (hint) {
      hint.textContent = state.packResults.length
        ? `共 ${state.packTotal} 个整合包 · 来源：${res.source === 'modrinth' ? 'Modrinth 国内镜像' : 'CurseForge 国内镜像'}${
            res.fallback ? '（已自动切换备用源）' : ''
          }`
        : `没有找到整合包${targetVersion ? '' : '，请先选择游戏版本'} · 也可点“导入本地整合包”`;
    }
    applyChineseNames('modpack');
  } catch (e) {
    renderModCards('#pack-results', [], '搜索失败：' + cleanError(e), '查看');
    if (hint) hint.textContent = '搜索失败：' + cleanError(e);
  } finally {
    state.packLoading = false;
  }
}

const CHANNEL_LABELS = { release: '正式版', beta: '测试版', alpha: '预览版' };

function channelLabel(channel) {
  return CHANNEL_LABELS[channel] || channel || '正式版';
}

/** MC 百科搜索地址（项目名称为空时作为兜底） */
function mcmodSearchUrl(name) {
  return `https://search.mcmod.cn/s?key=${encodeURIComponent(String(name || ''))}`;
}

function setDetailIcon(url, name) {
  const img = $('#md-icon');
  const wrap = img.closest('.md-icon-wrap');
  const initial = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  if (wrap) {
    wrap.dataset.initial = initial;
    wrap.dataset.empty = url ? '0' : '1';
  }
  if (url) {
    img.src = url;
    img.style.visibility = 'visible';
  } else {
    img.removeAttribute('src');
    img.style.visibility = 'hidden';
  }
}

/** 打开 Mod / 整合包详情：展示项目信息、MC 百科入口与可选文件版本 */
function openModDetail(item) {
  const type = item.type === 'modpack' ? 'modpack' : 'mod';
  const target = type === 'mod' ? selectedModVersion() : null;
  state.modDetail = { item, type, target, project: null, files: [] };
  state.pendingMod = null;
  $('#md-name').textContent = item.name || '详情';
  $('#md-meta').textContent = type === 'modpack' ? '整合包 · 正在读取详情…' : 'Mod · 正在读取详情…';
  $('#md-summary').textContent = item.summary || '正在从国内镜像获取简介…';
  $('#md-tags').innerHTML = '';
  setDetailIcon(item.icon || '', item.name);
  $('#md-files').innerHTML = '<option>正在获取文件版本…</option>';
  $('#md-file-hint').textContent = '';
  $('#btn-md-install').disabled = true;
  $('#btn-md-install').textContent = type === 'modpack' ? '下载并安装整合包' : '下载并安装';
  $('#btn-md-website').hidden = true;
  $('#btn-md-wiki').hidden = true;
  const mcmodBtn = $('#btn-md-mcmod');
  mcmodBtn.dataset.url = mcmodSearchUrl(item.name);
  mcmodBtn.dataset.name = item.name || '';
  mcmodBtn.disabled = false;
  if (type === 'mod' && !target) {
    $('#md-target-hint').textContent = '尚未选择游戏版本：请先在顶部“游戏版本”下拉框选择一个版本，再下载 Mod。';
  } else if (type === 'mod') {
    $('#md-target-hint').textContent = `安装到 ${target.id}（Minecraft ${versionMcOf(target)}${
      loaderOf(target) ? ' · ' + loaderOf(target) : ''
    }）`;
  } else {
    $('#md-target-hint').textContent = '安装整合包时会自动下载并配置其适配的原版与加载器，无需手动选择。';
  }
  openModal('#mod-detail-modal');
  loadModDetail();
}

async function loadModDetail() {
  const detail = state.modDetail;
  if (!detail) return;
  const { item, type, target } = detail;
  const [pRes, fRes] = await Promise.allSettled([
    api.getModProject({ source: item.source, projectId: item.id }),
    api.listModFiles({
      source: item.source,
      type,
      projectId: item.id,
      // 整合包会创建独立版本，不按当前版本过滤；Mod 按当前游戏版本与加载器筛选
      mcVersion: type === 'mod' && target ? versionMcOf(target) : '',
      loader: type === 'mod' && target ? loaderOf(target) : ''
    })
  ]);
  if (state.modDetail !== detail) return;

  const project = pRes.status === 'fulfilled' ? pRes.value : null;
  const files = fRes.status === 'fulfilled' ? fRes.value || [] : [];
  const filesError = fRes.status === 'rejected' ? cleanError(fRes.reason) : '';
  detail.project = project;
  detail.files = files;

  if (project) {
    const zhName = project.nameZh || (state.cnNames && state.cnNames[project.name]) || '';
    $('#md-name').textContent = zhName || project.name || item.name;
    if (zhName && project.name) $('#md-name-alt').textContent = project.name;
    else $('#md-name-alt').textContent = '';
    const meta = [
      project.author,
      project.downloads ? `${formatCount(project.downloads)} 次下载` : '',
      project.source === 'modrinth' ? 'Modrinth' : 'CurseForge'
    ].filter(Boolean);
    $('#md-meta').textContent = meta.join(' · ');
    $('#md-summary').textContent = project.summary || '暂无简介';
    $('#md-tags').innerHTML = (project.categories || [])
      .slice(0, 8)
      .map((c) => `<span class="md-tag">${escapeHtml(c)}</span>`)
      .join('');
    setDetailIcon(project.icon || item.icon || '', project.name || item.name);
    const mcmodBtn = $('#btn-md-mcmod');
    mcmodBtn.dataset.url = project.mcmod || mcmodSearchUrl(project.name || item.name);
    mcmodBtn.dataset.name = project.name || item.name || '';
    mcmodBtn.disabled = false;
    const webBtn = $('#btn-md-website');
    webBtn.hidden = !project.website;
    webBtn.dataset.url = project.website || '';
    const wikiBtn = $('#btn-md-wiki');
    wikiBtn.hidden = !project.wiki;
    wikiBtn.dataset.url = project.wiki || '';
  }

  if (type === 'mod' && !target) {
    $('#md-files').innerHTML = '<option>请先选择游戏版本</option>';
    $('#md-file-hint').textContent = '';
    return;
  }
  if (filesError) {
    $('#md-files').innerHTML = '<option>获取失败</option>';
    $('#md-file-hint').textContent = '获取文件列表失败：' + filesError;
    return;
  }
  if (!files.length) {
    $('#md-files').innerHTML = '<option>暂无可用文件</option>';
    $('#md-file-hint').textContent =
      type === 'modpack'
        ? '该整合包没有可下载的文件'
        : `当前游戏版本（${versionMcOf(target)}）没有找到兼容文件，可切换游戏版本或加载器后重试`;
    return;
  }
  $('#md-files').innerHTML = files
    .map(
      (f, i) =>
        `<option value="${i}">${escapeHtml(f.fileName || f.name)} · ${escapeHtml(
          channelLabel(f.channel)
        )} · ${f.size ? formatBytes(f.size) : '未知大小'}${
          f.gameVersions && f.gameVersions.length ? ' · MC ' + escapeHtml(f.gameVersions.slice(0, 4).join('/')) : ''
        }</option>`
    )
    .join('');
  // 默认优先选择正式版，避免一进来就选中测试版
  const preferred = files.findIndex((f) => f.channel === 'release');
  $('#md-files').value = String(preferred >= 0 ? preferred : 0);
  onDetailFileChange();
  $('#btn-md-install').disabled = false;
}

function detailSelectedFile() {
  const detail = state.modDetail;
  if (!detail || !detail.files.length) return null;
  const idx = Number($('#md-files').value) || 0;
  return detail.files[idx] || detail.files[0];
}

/** 详情页选择文件后更新提示 */
function onDetailFileChange() {
  const file = detailSelectedFile();
  if (!file) return;
  const range = file.gameVersions && file.gameVersions.length ? ` · MC ${file.gameVersions.slice(0, 6).join('/')}` : '';
  const total = state.modDetail && state.modDetail.files ? state.modDetail.files.length : 0;
  $('#md-file-hint').textContent = `已选择 ${file.fileName || file.name} · ${channelLabel(file.channel)}${range}${
    file.size ? ' · ' + formatBytes(file.size) : ''
  }${total ? `（共 ${total} 个版本）` : ''}`;
}

/** 点击“下载并安装”：整合包直接安装，Mod 先检查必需前置 */
async function installModDetail() {
  const detail = state.modDetail;
  if (!detail || !detail.files.length) return;
  const file = detailSelectedFile();
  if (!file) return;
  const { item, type, target } = detail;

  if (type === 'modpack') {
    return startModpackInstall(item, file);
  }
  if (!target) {
    toast('请先选择游戏版本', 'warn');
    return;
  }
  const mcVersion = versionMcOf(target);
  const loader = loaderOf(target);
  const required = (file.dependencies || []).filter((d) => d.required);
  if (!required.length) {
    return startModInstall(item, file, target, false);
  }

  const btn = $('#btn-md-install');
  btn.disabled = true;
  btn.textContent = '正在检查前置…';
  let deps = [];
  try {
    deps = await api.getModDeps({
      source: item.source,
      projectId: item.id,
      fileId: file.id,
      mcVersion,
      loader
    });
  } catch (e) {
    deps = [];
    appendLog(`[KMCL] 获取前置列表失败：${cleanError(e)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '下载并安装';
  }
  if (!deps.length) {
    return startModInstall(item, file, target, false);
  }
  state.pendingMod = { item, file, target, mcVersion, loader, deps };
  renderDepModal(deps, item);
}

/** 详情页外链：MC 百科 / 项目主页 / Wiki 用系统浏览器打开 */
function openDetailLink(sel) {
  const url = ($(sel) && $(sel).dataset.url) || '';
  if (!url) return;
  api.openExternal(url).catch((e) => toast('打开链接失败：' + cleanError(e), 'error'));
}

/** MC 百科：点击时再解析具体条目页，失败则打开搜索页 */
async function openMcmodLink() {
  const btn = $('#btn-md-mcmod');
  const fallback = btn.dataset.url || mcmodSearchUrl(btn.dataset.name || '');
  const name = btn.dataset.name || '';
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在打开…';
  try {
    const url = name
      ? await api.getMcmodUrl({ name, type: (state.modDetail && state.modDetail.type) || 'mod' })
      : fallback;
    await api.openExternal(url || fallback);
  } catch (e) {
    try {
      await api.openExternal(fallback);
    } catch (err) {
      toast('打开链接失败：' + cleanError(err), 'error');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function closeDepModal() {
  state.pendingMod = null;
  closeModal('#dep-modal');
}

function renderDepModal(deps, item) {
  $('#dep-sub').textContent = `「${item.name}」需要以下 ${deps.length} 个前置 Mod，是否一并安装？`;
  $('#dep-list').innerHTML = deps
    .map((dep) => {
      const icon = dep.icon
        ? `<img class="dep-icon" src="${escapeHtml(dep.icon)}" loading="lazy" alt="" />`
        : `<div class="dep-icon dep-initial">${escapeHtml(
            String(dep.name || dep.fileName || '?').trim().charAt(0).toUpperCase() || '?'
          )}</div>`;
      return `<div class="dep-item">
        ${icon}
        <div class="dep-body">
          <div class="dep-name">${escapeHtml(dep.name || dep.fileName)}</div>
          <div class="dep-file">${escapeHtml(dep.fileName || '')}${dep.size ? ' · ' + formatBytes(dep.size) : ''}</div>
        </div>
        <span class="dep-badge">必需</span>
      </div>`;
    })
    .join('');
  $('#dep-hint').textContent = '连同前置一起安装可以避免启动时提示缺少依赖。';
  openModal('#dep-modal');
}

async function startModInstall(item, file, target, withDependencies) {
  closeModal('#dep-modal');
  closeModal('#mod-detail-modal');
  state.busy = 'mod';
  $('#task-title').textContent = `下载 ${item.name}`;
  try {
    const r = await api.installMod({
      source: item.source,
      projectId: item.id,
      fileId: file.id,
      versionId: target.id,
      mcVersion: versionMcOf(target),
      loader: loaderOf(target),
      name: item.name,
      withDependencies
    });
    const depNames = (r.installedDependencies || []).map((x) => x.name).filter(Boolean);
    toast(
      `已安装 ${r.fileName} → ${target.id}${depNames.length ? `，含前置：${depNames.join('、')}` : ''}`,
      'info',
      9000
    );
    appendLog(`[KMCL] 已安装 mod ${r.fileName} 到 ${target.id}`);
    if (depNames.length) appendLog(`[KMCL] 同时安装前置：${depNames.join('、')}`);
    if (state.modsVersion === target.id) await loadMods();
  } catch (e) {
    toast('下载失败：' + cleanError(e), 'error', 10000);
    appendLog(`[KMCL] mod 下载失败：${cleanError(e)}`);
  } finally {
    state.busy = null;
    hideTaskPanel();
    renderAll();
  }
}

async function startModpackInstall(item, file) {
  closeModal('#mod-detail-modal');
  state.busy = 'modpack';
  $('#task-title').textContent = `安装整合包 ${item.name}`;
  try {
    // 不传 mcVersion / loader：由整合包清单自动确定并安装适配的原版与加载器
    const r = await api.installModpack({
      source: item.source,
      projectId: item.id,
      fileId: file.id
    });
    state.versions = r.versions || state.versions;
    toast(`整合包「${r.name}」已安装为版本 ${r.versionId}`, 'info', 9000);
    appendLog(`[KMCL] 整合包 ${r.name} 安装完成：${r.versionId}`);
    await refreshVersions();
  } catch (e) {
    toast('安装整合包失败：' + cleanError(e), 'error', 10000);
    appendLog(`[KMCL] 整合包安装失败：${cleanError(e)}`);
  } finally {
    state.busy = null;
    hideTaskPanel();
    renderAll();
  }
}

async function importModpack() {
  try {
    const filePath = await api.pickModpack();
    if (!filePath) return;
    await openPackImport(filePath);
  } catch (e) {
    toast('读取整合包失败：' + cleanError(e), 'error', 9000);
  }
}

const PACK_KIND_LABEL = {
  mrpack: 'Modrinth 整合包',
  curseforge: 'CurseForge 整合包',
  generic: '本地整合包'
};

/** 打开导入确认窗口：显示识别到的版本 / 加载器，确认后自动下载所需内容 */
async function openPackImport(filePath) {
  let info;
  try {
    info = await api.inspectModpack({ localPath: filePath });
  } catch (e) {
    toast('无法识别该压缩包：' + cleanError(e), 'error', 9000);
    return;
  }
  state.pendingPack = info;
  $('#pack-import-file').textContent =
    `${info.fileName} · ${PACK_KIND_LABEL[info.kind] || '整合包'} · ${info.modCount} 个 mod`;

  // 游戏版本：包内已指定就置顶显示，否则从已安装版本 + 官方版本列表中选择
  if (!state.manifest && !state.manifestLoading) await loadManifest();
  const select = $('#pack-import-mc');
  const ids = [];
  if (info.mc) ids.push(info.mc);
  for (const v of baseVersions()) if (!ids.includes(v.id)) ids.push(v.id);
  const manifest = state.manifest;
  if (manifest && Array.isArray(manifest.versions)) {
    const releases = manifest.versions.filter((v) => v.type === 'release').map((v) => v.id);
    for (const id of releases) if (!ids.includes(id)) ids.push(id);
  }
  select.innerHTML = ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
  if (info.mc) {
    select.value = info.mc;
  } else {
    // 包内没有版本信息时留空，强制用户选择，避免装错版本
    select.insertAdjacentHTML('afterbegin', '<option value="">请选择整合包对应的游戏版本</option>');
    select.value = '';
  }

  // 加载器：包内已指定则锁定，未知时由用户选择
  const loaderSelect = $('#pack-import-loader');
  if (info.loader) {
    const label = info.loader.type === 'forge' ? 'Forge'
      : info.loader.type === 'neoforge' ? 'NeoForge'
        : info.loader.type === 'fabric' ? 'Fabric' : info.loader.type;
    loaderSelect.innerHTML = `<option value="${escapeHtml(info.loader.type)}">${label} ${escapeHtml(info.loader.version)}（包内指定）</option>`;
    loaderSelect.value = info.loader.type;
    loaderSelect.disabled = true;
  } else {
    loaderSelect.innerHTML = `
      <option value="">原版（不安装加载器）</option>
      <option value="forge">Forge（自动选最新）</option>
      <option value="fabric">Fabric（自动选最新）</option>
      <option value="neoforge">NeoForge（自动选最新）</option>`;
    loaderSelect.value = '';
    loaderSelect.disabled = false;
  }

  const mcHint = info.mc
    ? `将自动下载 Minecraft ${info.mc}`
    : '该压缩包未写明游戏版本，请手动选择';
  const loaderLabel = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric' };
  const loaderHint = info.loader
    ? `并安装 ${loaderLabel[info.loader.type] || info.loader.type} ${info.loader.version}`
    : (loaderSelect.value ? '并安装所选加载器的最新版本' : '不安装加载器');
  $('#pack-import-hint').textContent = `${mcHint}，${loaderHint}；压缩包内的存档、配置与 mod 会一并解压到独立版本目录。`;
  openModal('#pack-import-modal');
}

async function confirmPackImport() {
  const info = state.pendingPack;
  if (!info) return;
  const mcVersion = $('#pack-import-mc').value;
  const loaderType = $('#pack-import-loader').disabled ? '' : $('#pack-import-loader').value;
  if (!mcVersion) {
    toast('请选择整合包对应的游戏版本', 'warn');
    return;
  }
  closeModal('#pack-import-modal');
  state.busy = 'modpack';
  try {
    const r = await api.importModpack({ localPath: info.path, mcVersion, loaderType });
    if (!r) return;
    toast(`整合包「${r.name}」已导入为版本 ${r.versionId}`, 'info', 9000);
    appendLog(`[KMCL] 已导入整合包：${r.name} → ${r.versionId}`);
    state.pendingPack = null;
    await refreshVersions();
  } catch (e) {
    toast('导入整合包失败：' + cleanError(e), 'error', 10000);
    appendLog(`[KMCL] 导入整合包失败：${cleanError(e)}`);
  } finally {
    state.busy = null;
    hideTaskPanel();
    renderAll();
  }
}

/** 支持把整合包压缩包直接拖进启动器窗口 */
function setupDropZone() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.add('hidden');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const packFile = files.find((f) => /\.(zip|mrpack)$/i.test(f.name || ''));
    if (!packFile) {
      toast('只能拖入 .zip 或 .mrpack 格式的整合包', 'warn');
      return;
    }
    const filePath = api.pathForFile(packFile);
    if (!filePath) {
      toast('无法读取拖入文件的路径，请改用“导入本地整合包”按钮', 'error', 8000);
      return;
    }
    openPackImport(filePath);
  });
}

function switchModTab(tab) {
  state.modTab = tab;
  $$('#mods-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mtab === tab));
  $$('#page-mods .tab-panel').forEach((p) => p.classList.toggle('active', p.id === `mtab-${tab}`));
  if (tab === 'installed') loadMods();
  else if (tab === 'browse' && !state.modResults.length && !state.modLoading) searchMods(true);
  else if (tab === 'packs' && !state.packResults.length && !state.packLoading) searchPacks(true);
}

/* ------------------------------ Forge / OptiFine ------------------------------ */

function fillBaseSelect(select, hintEl) {
  const bases = baseVersions();
  const prev = select.value;
  select.innerHTML = bases.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.id)}</option>`).join('');
  if (prev && bases.some((v) => v.id === prev)) select.value = prev;
  select.disabled = !bases.length;
  if (hintEl) {
    hintEl.textContent = bases.length
      ? `已安装 ${bases.length} 个原版版本`
      : '还没有原版版本，请先在“游戏版本”标签页安装一个版本';
  }
  return bases;
}

function compareNumeric(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function loadForgeList() {
  state.forgeLoading = true;
  const select = $('#forge-ver');
  select.innerHTML = '<option>正在获取 Forge 版本列表…</option>';
  try {
    state.forge = await api.listForge();
    state.forgeLoading = false;
    renderForge();
  } catch (e) {
    state.forgeLoading = false;
    select.innerHTML = '<option>获取失败</option>';
    toast('获取 Forge 列表失败：' + cleanError(e), 'error');
  }
}

function renderForge() {
  if (state.forgeLoading) return;
  const mc = $('#forge-mc').value;
  const select = $('#forge-ver');
  if (!mc || !state.forge) {
    select.innerHTML = '<option value="">请先安装原版版本</option>';
    select.disabled = true;
    $('#btn-install-forge').disabled = true;
    return;
  }
  const list = state.forge
    .filter((v) => v.mc === mc)
    .sort((a, b) => compareNumeric(b.loader, a.loader));
  $('#forge-ver-hint').textContent = list.length ? `该游戏版本共有 ${list.length} 个 Forge 版本` : '该游戏版本没有可用的 Forge';
  if (!list.length) {
    select.innerHTML = '<option value="">无可用版本</option>';
    select.disabled = true;
    $('#btn-install-forge').disabled = true;
    return;
  }
  const prev = select.value;
  select.innerHTML = list
    .map((v) => `<option value="${escapeHtml(v.loader)}">forge ${escapeHtml(v.loader)}</option>`)
    .join('');
  if (prev && list.some((v) => v.loader === prev)) select.value = prev;
  select.disabled = false;
  $('#btn-install-forge').disabled = !!state.busy;
}

async function installForge() {
  const mc = $('#forge-mc').value;
  const forgeVersion = $('#forge-ver').value;
  if (!mc || !forgeVersion) {
    toast('请选择 Minecraft 版本与 Forge 版本', 'warn');
    return;
  }
  if (state.busy) {
    toast('已有任务正在进行', 'warn');
    return;
  }
  const targetId = `${mc}-forge-${forgeVersion}`;
  if (installedIds().has(targetId) && !window.confirm(`${targetId} 已安装，是否重新安装？`)) return;

  state.busy = 'forge';
  $('#btn-install-forge').disabled = true;
  $('#btn-install-forge').textContent = '正在安装…';
  $('#task-title').textContent = `安装 Forge ${forgeVersion}`;
  try {
    const result = await api.installForge({ mcVersion: mc, forgeVersion });
    await refreshVersions();
    toast(`Forge 安装完成：${result.versionId}`, 'info');
    $('#home-version').value = result.versionId;
  } catch (e) {
    if (/取消/.test(cleanError(e))) toast('已取消安装', 'warn');
    else toast('Forge 安装失败：' + cleanError(e), 'error', 8000);
  } finally {
    state.busy = null;
    $('#btn-install-forge').disabled = false;
    $('#btn-install-forge').textContent = '安装 Forge';
    hideTaskPanel();
    renderAll();
  }
}

/* ------------------------------ Fabric / NeoForge ------------------------------ */

async function loadFabricList(mc, force) {
  if (!mc) {
    state.fabric = { mc: '', items: [] };
    renderFabric();
    return;
  }
  state.fabricLoading = true;
  const select = $('#fabric-ver');
  select.innerHTML = '<option>正在获取 Fabric 版本列表…</option>';
  try {
    const items = await api.listFabric(mc);
    state.fabric = { mc, items: items || [] };
    state.fabricLoading = false;
    renderFabric();
  } catch (e) {
    state.fabricLoading = false;
    select.innerHTML = '<option>获取失败</option>';
    toast('获取 Fabric 列表失败：' + cleanError(e), 'error');
  }
}

function ensureFabricList() {
  const mc = $('#fabric-mc').value;
  if (!mc) {
    state.fabric = { mc: '', items: [] };
    renderFabric();
    return;
  }
  if (state.fabric.mc !== mc) loadFabricList(mc);
}

function renderFabric() {
  if (state.fabricLoading) return;
  const mc = $('#fabric-mc').value;
  const select = $('#fabric-ver');
  const list = state.fabric.mc === mc ? state.fabric.items : [];
  if (!mc) {
    select.innerHTML = '<option value="">请先安装原版版本</option>';
    select.disabled = true;
    $('#btn-install-fabric').disabled = true;
    return;
  }
  $('#fabric-ver-hint').textContent = list.length
    ? `该游戏版本共有 ${list.length} 个 Fabric Loader 版本`
    : '正在获取或该游戏版本没有可用的 Fabric';
  if (!list.length) {
    select.innerHTML = '<option value="">无可用版本</option>';
    select.disabled = true;
    $('#btn-install-fabric').disabled = true;
    return;
  }
  select.innerHTML = list
    .map((v) => `<option value="${escapeHtml(v.version)}">fabric-loader ${escapeHtml(v.version)}${v.stable ? '（稳定）' : ''}</option>`)
    .join('');
  select.disabled = false;
  $('#btn-install-fabric').disabled = !!state.busy;
}

async function installFabric() {
  const mc = $('#fabric-mc').value;
  const loaderVersion = $('#fabric-ver').value;
  if (!mc || !loaderVersion) {
    toast('请选择 Minecraft 版本与 Fabric 版本', 'warn');
    return;
  }
  if (state.busy) {
    toast('已有任务正在进行', 'warn');
    return;
  }
  const targetId = `fabric-loader-${loaderVersion}-${mc}`;
  if (installedIds().has(targetId) && !window.confirm(`${targetId} 已安装，是否重新安装？`)) return;

  state.busy = 'fabric';
  $('#btn-install-fabric').disabled = true;
  $('#btn-install-fabric').textContent = '正在安装…';
  $('#task-title').textContent = `安装 Fabric ${loaderVersion}`;
  try {
    const result = await api.installFabric({ mcVersion: mc, loaderVersion });
    await refreshVersions();
    toast(`Fabric 安装完成：${result.versionId}`, 'info');
    $('#home-version').value = result.versionId;
  } catch (e) {
    if (/取消/.test(cleanError(e))) toast('已取消安装', 'warn');
    else toast('Fabric 安装失败：' + cleanError(e), 'error', 9000);
  } finally {
    state.busy = null;
    $('#btn-install-fabric').disabled = false;
    $('#btn-install-fabric').textContent = '安装 Fabric';
    hideTaskPanel();
    renderAll();
  }
}

async function loadNeoForgeList(silent) {
  state.neoforgeLoading = true;
  const select = $('#neoforge-ver');
  select.innerHTML = '<option>正在获取 NeoForge 版本列表…</option>';
  $('#neoforge-ver-hint').textContent = '正在从国内镜像获取版本列表…';
  try {
    state.neoforge = await api.listNeoForge();
    state.neoforgeLoading = false;
    renderNeoForge();
  } catch (e) {
    state.neoforgeLoading = false;
    select.innerHTML = '<option>获取失败</option>';
    if (!silent) toast('获取 NeoForge 列表失败：' + cleanError(e), 'error');
  }
}

function renderNeoForge() {
  if (state.neoforgeLoading) return;
  const mc = $('#neoforge-mc').value;
  const select = $('#neoforge-ver');
  if (!mc) {
    select.innerHTML = '<option value="">请先安装原版版本</option>';
    select.disabled = true;
    $('#btn-install-neoforge').disabled = true;
    return;
  }
  const list = state.neoforge
    .filter((v) => v.mc === mc)
    .sort((a, b) => compareNumeric(b.version, a.version));
  if (!state.neoforge.length) {
    $('#neoforge-ver-hint').textContent = '版本列表尚未加载，请稍候或切换标签页重试';
    select.innerHTML = '<option value="">暂无版本列表</option>';
    select.disabled = true;
    $('#btn-install-neoforge').disabled = true;
    return;
  }
  $('#neoforge-ver-hint').textContent = list.length
    ? `该游戏版本共有 ${list.length} 个 NeoForge 版本`
    : '该游戏版本没有可用的 NeoForge（1.20.1 请使用 Forge）';
  if (!list.length) {
    select.innerHTML = '<option value="">无可用版本</option>';
    select.disabled = true;
    $('#btn-install-neoforge').disabled = true;
    return;
  }
  const prev = select.value;
  select.innerHTML = list
    .map((v) => `<option value="${escapeHtml(v.version)}">neoforge ${escapeHtml(v.version)}</option>`)
    .join('');
  if (prev && list.some((v) => v.version === prev)) select.value = prev;
  select.disabled = false;
  $('#btn-install-neoforge').disabled = !!state.busy;
}

async function installNeoForge() {
  const mc = $('#neoforge-mc').value;
  const loaderVersion = $('#neoforge-ver').value;
  if (!mc || !loaderVersion) {
    toast('请选择 Minecraft 版本与 NeoForge 版本', 'warn');
    return;
  }
  if (state.busy) {
    toast('已有任务正在进行', 'warn');
    return;
  }
  const targetId = `neoforge-${loaderVersion}`;
  if (installedIds().has(targetId) && !window.confirm(`${targetId} 已安装，是否重新安装？`)) return;

  state.busy = 'neoforge';
  $('#btn-install-neoforge').disabled = true;
  $('#btn-install-neoforge').textContent = '正在安装…';
  $('#task-title').textContent = `安装 NeoForge ${loaderVersion}`;
  try {
    const result = await api.installNeoForge({ mcVersion: mc, loaderVersion });
    await refreshVersions();
    toast(`NeoForge 安装完成：${result.versionId}`, 'info');
    $('#home-version').value = result.versionId;
  } catch (e) {
    if (/取消/.test(cleanError(e))) toast('已取消安装', 'warn');
    else toast('NeoForge 安装失败：' + cleanError(e), 'error', 9000);
  } finally {
    state.busy = null;
    $('#btn-install-neoforge').disabled = false;
    $('#btn-install-neoforge').textContent = '安装 NeoForge';
    hideTaskPanel();
    renderAll();
  }
}

async function loadOptiFineList(mc, force = false) {
  if (!mc) {
    state.optifine = { mc: '', items: [] };
    renderOptiFine();
    return;
  }
  state.optifineLoading = true;
  const select = $('#of-ver');
  select.innerHTML = '<option>正在获取 OptiFine 列表…</option>';
  try {
    const items = await api.listOptiFine(mc);
    state.optifine = { mc, items: items || [] };
    state.optifineLoading = false;
    renderOptiFine();
  } catch (e) {
    state.optifineLoading = false;
    select.innerHTML = '<option>获取失败</option>';
    toast('获取 OptiFine 列表失败：' + cleanError(e), 'error');
  }
}

function ensureOptiFineList() {
  const mc = $('#of-mc').value;
  if (!mc) {
    state.optifine = { mc: '', items: [] };
    renderOptiFine();
    return;
  }
  if (state.optifine.mc !== mc) loadOptiFineList(mc);
}

function renderOptiFine() {
  if (state.optifineLoading) return;
  const mc = $('#of-mc').value;
  const select = $('#of-ver');
  const list = state.optifine.mc === mc ? state.optifine.items : [];
  if (!mc) {
    select.innerHTML = '<option value="">请先安装原版版本</option>';
    select.disabled = true;
    $('#btn-install-of').disabled = true;
    return;
  }
  $('#of-ver-hint').textContent = list.length
    ? `该游戏版本共有 ${list.length} 个 OptiFine 版本`
    : '正在获取或该游戏版本没有可用的 OptiFine';
  if (!list.length) {
    select.innerHTML = '<option value="">无可用版本</option>';
    select.disabled = true;
    $('#btn-install-of').disabled = true;
    return;
  }
  select.innerHTML = list
    .map((v) => `<option value="${escapeHtml(v.edition)}">${escapeHtml(v.label || v.edition)}</option>`)
    .join('');
  select.disabled = false;
  $('#btn-install-of').disabled = !!state.busy;
}

async function installOptiFine() {
  const mc = $('#of-mc').value;
  const edition = $('#of-ver').value;
  if (!mc || !edition) {
    toast('请选择 Minecraft 版本与 OptiFine 版本', 'warn');
    return;
  }
  if (state.busy) {
    toast('已有任务正在进行', 'warn');
    return;
  }
  state.busy = 'optifine';
  $('#btn-install-of').disabled = true;
  $('#btn-install-of').textContent = '正在安装…';
  $('#task-title').textContent = `安装 OptiFine ${edition}`;
  try {
    const result = await api.installOptiFine({ mcVersion: mc, edition });
    await refreshVersions();
    toast(`OptiFine 安装完成：${result.versionId}`, 'info');
    $('#home-version').value = result.versionId;
  } catch (e) {
    if (/取消/.test(cleanError(e))) toast('已取消安装', 'warn');
    else toast('OptiFine 安装失败：' + cleanError(e), 'error', 9000);
  } finally {
    state.busy = null;
    $('#btn-install-of').disabled = false;
    $('#btn-install-of').textContent = '安装 OptiFine';
    hideTaskPanel();
    renderAll();
  }
}

/* ------------------------------ 版本管理 ------------------------------ */

async function refreshVersions() {
  try {
    const info = await api.gameInfo();
    state.versions = info.versions || [];
    state.gameRunning = !!info.gameRunning;
    fillBaseSelect($('#forge-mc'), $('#forge-mc-hint'));
    fillBaseSelect($('#of-mc'), $('#of-mc-hint'));
    renderVersions();
    renderHome();
    renderForge();
    renderOptiFine();
  } catch (e) {
    toast('刷新版本列表失败：' + cleanError(e), 'error');
  }
}

function renderVersions() {
  const list = $('#versions-list');
  if (!state.versions.length) {
    list.innerHTML = '<div class="empty">还没有安装任何版本，去“下载中心”看看吧</div>';
    return;
  }
  list.innerHTML = state.versions
    .map((v) => {
      const kind = versionKind(v);
      const sub = [kind, v.baseVersion ? `基于 ${v.baseVersion}` : '独立版本', v.hasJar || v.baseVersion ? '文件完整' : '缺少核心文件']
        .filter(Boolean)
        .join(' · ');
      const iso = v.isolated
        ? '<span class="version-badge">独立存档</span>'
        : '<span class="version-badge off">共享存档</span>';
      const pack = v.modpack ? `<span class="version-badge pack">${escapeHtml(v.modpack.name || '整合包')}</span>` : '';
      return `<div class="version-card">
        <div class="version-main">
          <div class="version-icon">${escapeHtml(v.id.slice(0, 2).toUpperCase())}</div>
          <div>
            <div class="version-name">${escapeHtml(v.id)}${iso}${pack}</div>
            <div class="version-sub">${escapeHtml(sub)}</div>
          </div>
        </div>
        <div class="version-actions">
          <button class="btn mini primary ver-launch" data-id="${escapeHtml(v.id)}" ${state.gameRunning ? 'disabled' : ''}>启动</button>
          <button class="btn mini ghost ver-folder" data-id="${escapeHtml(v.id)}">版本目录</button>
          <button class="btn mini ghost ver-instance" data-id="${escapeHtml(v.id)}">${v.isolated ? '存档目录' : '游戏目录'}</button>
          <button class="btn mini ghost ver-isolate" data-id="${escapeHtml(v.id)}" data-on="${v.isolated ? '1' : '0'}">${v.isolated ? '关闭隔离' : '开启隔离'}</button>
          <button class="btn mini danger ver-delete" data-id="${escapeHtml(v.id)}">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

async function launchVersion(id) {
  if (!id) {
    toast('请选择一个已安装的版本', 'warn');
    return;
  }
  if (state.gameRunning) {
    toast('游戏已在运行中', 'warn');
    return;
  }
  if (state.busy) {
    toast('请等待当前任务完成', 'warn');
    return;
  }
  const authMode = state.authMode || 'offline';
  if (authMode === 'msa' && !state.account) {
    toast('请先登录正版账号', 'warn');
    openLoginModal();
    return;
  }
  if (authMode === 'offline') {
    const username = ($('#home-username').value || '').trim() || 'Steve';
    await applyConfig({ username, authMode });
  } else {
    await applyConfig({ authMode });
  }
  state.busy = 'launch';
  $('#task-title').textContent = `启动 ${id}`;
  try {
    await api.launch(id);
    switchPage('home');
    appendLog(`[KMCL] 已启动 ${id}，等待游戏窗口出现…`);
  } catch (e) {
    toast('启动失败：' + cleanError(e), 'error', 9000);
    appendLog(`[KMCL] 启动失败：${cleanError(e)}`);
  } finally {
    state.busy = null;
    hideTaskPanel();
    renderHome();
    renderVersions();
  }
}

/* ------------------------------ 设置页 ------------------------------ */

function renderSettings() {
  const c = currentConfig();
  $('#set-gamedir').value = c.gameDir || '';
  $$('input[name="mirror"]').forEach((r) => {
    r.checked = r.value === c.mirror;
  });
  $('#set-custom-mirror').value = c.customMirror || '';
  $('#set-custom-mirror').disabled = c.mirror !== 'custom';
  $('#set-threads').value = c.downloadThreads;
  $('#set-mem-min').value = c.minMemory;
  $('#set-mem-max').value = c.maxMemory;
  $('#set-mem-min-val').textContent = `${c.minMemory} MB`;
  $('#set-mem-max-val').textContent = `${c.maxMemory} MB`;
  $('#mem-label').textContent = `${c.minMemory} - ${c.maxMemory} MB`;
  $('#set-jvm-args').value = c.jvmArgs || '';
  $('#set-bg-path').value = c.backgroundImage || '';
  $('#set-auto-tune').checked = !!c.autoTune;
  syncAutoTuneUi();
  renderJavaList();
}

/** 自动调节开启时，手动内存滑杆与 JVM 参数不再生效，置灰提示 */
function syncAutoTuneUi() {
  const on = !!($('#set-auto-tune') && $('#set-auto-tune').checked);
  $$('#page-settings .mem-row input[type="range"], #set-jvm-args').forEach((el) => {
    el.disabled = on;
  });
  const label = $('#mem-label');
  if (label) {
    if (on) label.textContent = '自动调节';
    else label.textContent = `${$('#set-mem-min').value} - ${$('#set-mem-max').value} MB`;
  }
  const hint = $('#auto-tune-hint');
  if (hint) hint.textContent = on ? '已开启：启动时按硬件与 mod 数量自动分配' : '关闭中：使用下方的手动设置';
}

/** 展示推荐配置（不直接修改设置，避免误覆盖用户手动值） */
async function showAutoTuneRecommend() {
  const hint = $('#auto-tune-hint');
  try {
    const target = selectedModVersion();
    const rec = await api.recommendTuning({ versionId: target ? target.id : '' });
    if (hint) {
      hint.textContent = `推荐 ${rec.minMemory} - ${rec.maxMemory} MB · ${rec.reason}`;
    }
  } catch (e) {
    if (hint) hint.textContent = '推荐配置获取失败：' + cleanError(e);
  }
}

/** 应用启动器背景：留空时由 CSS 使用内置的我的世界风景图 */
async function applyBackground() {
  const layer = $('#app-bg');
  if (!layer) return;
  const custom = (state.config && state.config.backgroundImage) || '';
  if (!custom) {
    layer.style.backgroundImage = '';
    return;
  }
  try {
    const dataUrl = await api.getBackground();
    layer.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : '';
  } catch (e) {
    layer.style.backgroundImage = '';
  }
}

async function scanJavaInBackground() {
  if (state.javaScanning) return;
  state.javaScanning = true;
  try {
    state.javas = await api.scanJava();
    if (state.page === 'settings') renderJavaList();
  } catch (e) {
    // 后台扫描失败不打扰用户，可在设置页手动重试
  } finally {
    state.javaScanning = false;
  }
}

function renderJavaList() {
  const box = $('#java-list');
  const c = currentConfig();
  let html = `<label class="java-item ${!c.javaPath ? 'selected' : ''}">
    <input type="radio" name="java-pick" value="" ${!c.javaPath ? 'checked' : ''} />
    <div class="java-text"><b>自动选择（推荐）</b><br /><span>按游戏版本需求匹配已安装的 Java</span></div>
  </label>`;
  if (!state.javas.length) {
    html += `<div class="hint" style="margin:6px 2px">${
      state.javaScanning ? '正在搜索本机 Java…' : '尚未发现 Java，可点击“重新搜索”或手动添加'
    }</div>`;
  }
  for (const j of state.javas) {
    const selected = c.javaPath && c.javaPath.toLowerCase() === j.path.toLowerCase();
    html += `<label class="java-item ${selected ? 'selected' : ''}">
      <input type="radio" name="java-pick" value="${escapeHtml(j.path)}" ${selected ? 'checked' : ''} />
      <div class="java-text"><b>Java ${escapeHtml(j.version)}</b>${j.bits === 32 ? '（32 位）' : ''}<br />
      <span>${escapeHtml(j.path)}</span></div>
    </label>`;
  }
  box.innerHTML = html;
}

/* ------------------------------ 关于页 ------------------------------ */

// 预留扩展位：后续可以在这里追加卡片内容，无需改动其它页面的逻辑
const ABOUT_EXTRA_SLOTS = [
  // 示例：{ title: '更新日志', html: '<p>v1.0.0 首个版本</p>' }
];

function renderAbout() {
  const box = $('#about-extra');
  if (!box) return;
  if (!ABOUT_EXTRA_SLOTS.length) {
    box.innerHTML = `<div class="slot-empty">预留位已就绪，可在 app.js 的 ABOUT_EXTRA_SLOTS 中追加内容</div>`;
    return;
  }
  box.innerHTML = ABOUT_EXTRA_SLOTS.map((slot) => `
    <div class="slot-item">
      <b>${escapeHtml(slot.title || '')}</b>
      <div>${slot.html || ''}</div>
    </div>`).join('');
}

/* ------------------------------ 任务进度 ------------------------------ */

const TASK_NAMES = {
  install: '安装游戏版本',
  forge: '安装 Forge',
  optifine: '安装 OptiFine',
  launch: '启动游戏'
};

function showTaskPanel() {
  if (state.taskHideTimer) {
    clearTimeout(state.taskHideTimer);
    state.taskHideTimer = null;
  }
  $('#task-panel').classList.remove('hidden');
}

function hideTaskPanel(delay = 0) {
  if (state.taskHideTimer) clearTimeout(state.taskHideTimer);
  state.taskHideTimer = setTimeout(() => {
    $('#task-panel').classList.add('hidden');
    state.taskHideTimer = null;
  }, delay);
}

function renderProgress(p) {
  showTaskPanel();
  state.taskDetail = p;
  if (p.phase) {
    const last = state.taskPhases[state.taskPhases.length - 1];
    if (!last || last.phase !== p.phase) {
      state.taskPhases.push({
        phase: p.phase,
        at: Date.now(),
        bytesDone: p.bytesDone || 0,
        taskDone: p.taskDone || 0
      });
      if (state.taskPhases.length > 60) state.taskPhases.shift();
    }
  }
  $('#task-title').textContent = p.label || TASK_NAMES[p.kind] || '任务';
  $('#task-phase').textContent = p.phase || '准备中…';
  const bar = $('#task-bar');
  let percent = 0;
  let indeterminate = false;
  if (p.bytesTotal > 0) {
    percent = Math.min(100, (p.bytesDone / p.bytesTotal) * 100);
  } else if (p.taskTotal > 0) {
    percent = Math.min(100, (p.taskDone / p.taskTotal) * 100);
  } else {
    indeterminate = true;
  }
  bar.classList.toggle('indeterminate', indeterminate);
  if (!indeterminate) bar.style.width = `${percent.toFixed(1)}%`;

  const parts = [];
  if (p.taskTotal) parts.push(`${p.taskDone}/${p.taskTotal} 文件`);
  if (p.bytesTotal) parts.push(`${formatBytes(p.bytesDone)} / ${formatBytes(p.bytesTotal)}`);
  else if (p.bytesDone) parts.push(formatBytes(p.bytesDone));
  $('#task-stats').innerHTML = `<span>${parts.join(' · ')}</span><span>${
    p.speed ? formatBytes(p.speed) + '/s' : ''
  }</span>`;

  $('#task-cancel').hidden = p.kind === 'launch';
  if (state.progressOpen) renderTaskDetail();
  if (p.finished) hideTaskPanel(700);
}

/** 独立窗口中的详细进度：阶段、速度、已下载量与耗时 */
function renderTaskDetail() {
  const p = state.taskDetail;
  if (!p) return;
  const total = p.bytesTotal || 0;
  const done = p.bytesDone || 0;
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : p.taskTotal ? Math.min(100, (p.taskDone / p.taskTotal) * 100) : 0;
  $('#progress-title').textContent = `${p.label || TASK_NAMES[p.kind] || '任务'}${p.finished ? '（已完成）' : ''}`;
  const pbar = $('#progress-bar');
  pbar.style.width = `${percent.toFixed(1)}%`;
  const rows = [
    ['当前阶段', p.phase || '准备中…'],
    ['总体进度', `${percent.toFixed(1)}%`],
    ['文件', p.taskTotal ? `${p.taskDone} / ${p.taskTotal}` : '—'],
    ['数据量', total ? `${formatBytes(done)} / ${formatBytes(total)}` : formatBytes(done)],
    ['实时速度', p.speed ? `${formatBytes(p.speed)}/s` : '—'],
    ['剩余时间', p.eta != null ? `${Math.max(0, Math.round(p.eta))} 秒` : '—'],
    ['已用时', p.elapsed != null ? `${Math.round(p.elapsed)} 秒` : '—']
  ];
  $('#progress-grid').innerHTML = rows
    .map(([k, v]) => `<div class="detail-k">${escapeHtml(k)}</div><div>${escapeHtml(String(v))}</div>`)
    .join('');
  const phases = state.taskPhases
    .map((ph) => {
      const secs = Math.max(0, Math.round((Date.now() - ph.at) / 1000));
      return `<div>· ${escapeHtml(ph.phase)} <span class="muted">（${secs} 秒前开始）</span></div>`;
    })
    .join('');
  $('#progress-phases').innerHTML = phases || '<div class="muted">尚无阶段记录</div>';
  $('#btn-progress-cancel').hidden = p.finished || p.kind === 'launch';
}

async function exportLog() {
  const versionId = $('#home-version').value || state.modsVersion || '';
  try {
    const r = await api.exportLog({ versionId });
    if (!r) return;
    toast(`报错日志已导出：${r.path}`, 'info', 9000);
    appendLog(`[KMCL] 报错日志已导出：${r.path}`);
  } catch (e) {
    toast('导出失败：' + cleanError(e), 'error', 9000);
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents() {
  $$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchPage(btn.dataset.page)));
  $$('#dl-tabs .tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  $$('#mods-tabs .tab').forEach((tab) => tab.addEventListener('click', () => switchModTab(tab.dataset.mtab)));

  // 无边框窗口控制
  $('#win-min').addEventListener('click', () => api.winMinimize());
  $('#win-max').addEventListener('click', () => api.winToggleMaximize());
  $('#win-close').addEventListener('click', () => api.winClose());
  api.onWindowState((s) => {
    const max = !!(s && s.maximized);
    const btn = $('#win-max');
    btn.title = max ? '还原' : '最大化';
    btn.innerHTML = max
      ? '<svg viewBox="0 0 12 12"><rect x="2" y="4" width="6" height="6" rx="1.1" /><path d="M4.2 4V2.6h5.2V8H8" /></svg>'
      : '<svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2" /></svg>';
  });

  // 运行配置自动调节
  $('#set-auto-tune').addEventListener('change', async (e) => {
    await applyConfig({ autoTune: !!e.target.checked });
    syncAutoTuneUi();
    if (e.target.checked) showAutoTuneRecommend();
    else renderMemorySummary();
  });
  $('#btn-auto-tune').addEventListener('click', showAutoTuneRecommend);

  // 整合包导入确认窗口 + 全窗口拖拽导入
  setupDropZone();
  $('#btn-pack-cancel').addEventListener('click', () => {
    state.pendingPack = null;
    closeModal('#pack-import-modal');
  });
  $('#btn-pack-confirm').addEventListener('click', confirmPackImport);

  $('#home-version').addEventListener('change', () => {
    renderHomeMeta();
    const id = $('#home-version').value;
    if (id) applyConfig({ lastVersion: id });
  });

  $('#home-username').addEventListener('input', (e) => {
    clearTimeout(state.nameTimer);
    state.nameTimer = setTimeout(() => {
      applyConfig({ username: e.target.value.trim() || 'Steve' });
      renderAccount();
    }, 500);
  });

  $('#btn-login-ms').addEventListener('click', openLoginModal);
  $('#btn-logout-ms').addEventListener('click', logoutAccount);
  $$('#account-mode .chip').forEach((chip) =>
    chip.addEventListener('click', () => switchAuthMode(chip.dataset.mode))
  );

  $('#btn-open-verify').addEventListener('click', () => {
    const device = state.loginDevice;
    if (device && device.verificationUri) api.openExternal(device.verificationUri).catch(() => {});
  });

  $('#btn-copy-code').addEventListener('click', () => {
    const device = state.loginDevice;
    if (!device || !device.userCode) return;
    api.copyText(device.userCode);
    toast('登录代码已复制到剪贴板', 'info');
  });

  $('#btn-cancel-login').addEventListener('click', cancelLogin);

  $('#btn-launch').addEventListener('click', () => launchVersion($('#home-version').value));
  $('#btn-open-game').addEventListener('click', () => api.openVersionFolder($('#home-version').value || null));
  $('#btn-open-mods').addEventListener('click', () => api.openModsFolder($('#home-version').value || ''));
  $('#btn-clear-log').addEventListener('click', () => {
    $('#console').textContent = '';
  });

  $('#btn-kill').addEventListener('click', async () => {
    await api.killGame();
    state.gameRunning = false;
    appendLog('[KMCL] 已请求结束游戏进程');
    renderAll();
  });

  $('#task-cancel').addEventListener('click', async () => {
    await api.cancelTask();
    toast('正在取消任务…', 'warn');
  });

  // 下载页：版本列表
  $('#dl-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderDownloadGame();
  });
  $$('#dl-types .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      state.typeFilter = chip.dataset.type;
      $$('#dl-types .chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderDownloadGame();
    })
  );
  $('#dl-refresh').addEventListener('click', () => loadManifest(true));

  $('#dl-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.dl-install');
    if (!btn) return;
    openInstallModal(btn.dataset.id);
  });

  // 安装选项弹窗：Forge / Fabric / NeoForge 互斥，OptiFine 与 Fabric / NeoForge 冲突
  ['#chk-forge', '#chk-fabric', '#chk-neoforge', '#chk-optifine'].forEach((sel) => {
    $(sel).addEventListener('change', () => syncInstallConflicts());
  });
  $('#btn-install-cancel').addEventListener('click', closeInstallModal);
  $('#btn-install-start').addEventListener('click', startInstall);
  $('#install-modal').addEventListener('click', (e) => {
    if (e.target === $('#install-modal')) closeInstallModal();
  });

  // Mod 管理
  $('#btn-mods-refresh').addEventListener('click', loadMods);
  $('#btn-mods-open').addEventListener('click', () => api.openModsFolder(state.modsVersion));
  $('#mods-version').addEventListener('change', (e) => {
    state.modsVersion = e.target.value;
    $('#mod-mc').value = versionMcOf(selectedModVersion());
    $('#pack-mc').value = '';
    if (state.modTab === 'installed') loadMods();
    if (state.modTab === 'browse') searchMods(true);
  });
  $('#mods-search').addEventListener('input', (e) => {
    state.modsSearch = e.target.value;
    renderMods();
  });
  $('#mods-list').addEventListener('click', async (e) => {
    const toggle = e.target.closest('.mod-toggle');
    const del = e.target.closest('.mod-delete');
    if (!toggle && !del) return;
    const name = (toggle || del).dataset.name;
    if (toggle) {
      const enabled = toggle.dataset.enabled === '1';
      try {
        await api.toggleMod({ name, enabled: !enabled, versionId: state.modsVersion });
        toast(`${name} 已${enabled ? '禁用' : '启用'}`, 'info');
        await loadMods();
      } catch (err) {
        toast('操作失败：' + cleanError(err), 'error');
      }
      return;
    }
    if (!window.confirm(`确定删除 mod「${name}」吗？文件将从当前版本 mods 目录移除。`)) return;
    try {
      await api.deleteMod({ name, versionId: state.modsVersion });
      toast(`已删除 ${name}`, 'info');
      await loadMods();
    } catch (err) {
      toast('删除失败：' + cleanError(err), 'error');
    }
  });

  // Mod 浏览
  renderModCats();
  $('#btn-mod-search').addEventListener('click', () => searchMods(true));
  $('#mod-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchMods(true);
  });
  $('#mod-source').addEventListener('change', () => searchMods(true));
  $('#mod-loader').addEventListener('change', () => {
    const v = selectedModVersion();
    if (!$('#mod-mc').value && v) $('#mod-mc').value = versionMcOf(v);
    searchMods(true);
  });
  $('#mod-cats').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.modCategory = chip.dataset.cat;
    $$('#mod-cats .chip').forEach((c) => c.classList.toggle('active', c === chip));
    searchMods(true);
  });
  const cardItem = (e) => {
    const card = e.target.closest('.modcard');
    if (!card || !card.dataset.id) return null;
    return {
      source: card.dataset.source,
      id: card.dataset.id,
      type: card.dataset.type,
      name: card.dataset.name,
      icon: card.dataset.icon,
      summary: card.dataset.summary
    };
  };
  $('#mod-results').addEventListener('click', (e) => {
    const item = cardItem(e);
    if (item) openModDetail({ ...item, type: 'mod' });
  });
  $('#btn-mod-more').addEventListener('click', () => {
    state.modPage += 1;
    searchMods(false);
  });

  // 整合包
  $('#btn-pack-search').addEventListener('click', () => searchPacks(true));
  $('#pack-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchPacks(true);
  });
  $('#pack-source').addEventListener('change', () => searchPacks(true));
  $('#btn-pack-import').addEventListener('click', importModpack);
  $('#pack-results').addEventListener('click', (e) => {
    const item = cardItem(e);
    if (item) openModDetail({ ...item, type: 'modpack' });
  });
  $('#btn-pack-more').addEventListener('click', () => {
    state.packPage += 1;
    searchPacks(false);
  });

  // Mod / 整合包详情
  $('#btn-md-cancel').addEventListener('click', () => closeModal('#mod-detail-modal'));
  $('#btn-md-install').addEventListener('click', installModDetail);
  $('#md-files').addEventListener('change', onDetailFileChange);
  $('#btn-md-mcmod').addEventListener('click', openMcmodLink);
  $('#btn-md-website').addEventListener('click', () => openDetailLink('#btn-md-website'));
  $('#btn-md-wiki').addEventListener('click', () => openDetailLink('#btn-md-wiki'));
  $('#mod-detail-modal').addEventListener('click', (e) => {
    if (e.target === $('#mod-detail-modal')) closeModal('#mod-detail-modal');
  });

  // 前置 Mod 确认
  $('#btn-dep-cancel').addEventListener('click', closeDepModal);
  $('#btn-dep-skip').addEventListener('click', () => {
    const pending = state.pendingMod;
    if (!pending) return;
    state.pendingMod = null;
    startModInstall(pending.item, pending.file, pending.target, false);
  });
  $('#btn-dep-install').addEventListener('click', () => {
    const pending = state.pendingMod;
    if (!pending) return;
    state.pendingMod = null;
    startModInstall(pending.item, pending.file, pending.target, true);
  });
  $('#dep-modal').addEventListener('click', (e) => {
    if (e.target === $('#dep-modal')) closeDepModal();
  });

  // 任务详情
  $('#task-detail').addEventListener('click', () => {
    state.progressOpen = true;
    openModal('#progress-modal');
    renderTaskDetail();
  });
  $('#btn-progress-close').addEventListener('click', () => {
    state.progressOpen = false;
    closeModal('#progress-modal');
  });
  $('#btn-progress-cancel').addEventListener('click', async () => {
    await api.cancelTask();
    toast('正在取消任务…', 'warn');
  });

  // 报错日志导出
  $('#btn-export-log').addEventListener('click', exportLog);

  // Forge
  $('#forge-mc').addEventListener('change', renderForge);
  $('#btn-install-forge').addEventListener('click', installForge);

  // Fabric / NeoForge
  $('#fabric-mc').addEventListener('change', () => {
    ensureFabricList();
    renderFabric();
  });
  $('#btn-install-fabric').addEventListener('click', installFabric);
  $('#neoforge-mc').addEventListener('change', renderNeoForge);
  $('#btn-install-neoforge').addEventListener('click', installNeoForge);

  // OptiFine
  $('#of-mc').addEventListener('change', () => {
    ensureOptiFineList();
    renderOptiFine();
  });
  $('#btn-install-of').addEventListener('click', installOptiFine);

  // 版本页
  $('#btn-refresh-versions').addEventListener('click', refreshVersions);
  $('#versions-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.classList.contains('ver-launch')) launchVersion(id);
    if (btn.classList.contains('ver-folder')) api.openVersionFolder(id);
    if (btn.classList.contains('ver-instance')) api.openInstanceFolder(id);
    if (btn.classList.contains('ver-isolate')) {
      const next = btn.dataset.on !== '1';
      try {
        state.versions = await api.setIsolated(id, next);
        toast(next ? `${id} 已开启版本隔离（独立存档与 mods）` : `${id} 已改为共享游戏目录`, 'info', 6000);
        renderAll();
        if (state.page === 'mods') {
          renderModsVersionSelect();
          if (state.modTab === 'installed') loadMods();
        }
      } catch (err) {
        toast('切换版本隔离失败：' + cleanError(err), 'error');
      }
    }
    if (btn.classList.contains('ver-delete')) {
      if (!window.confirm(`确定删除版本 ${id} 吗？该操作会删除版本目录。`)) return;
      try {
        state.versions = await api.deleteVersion(id);
        toast(`已删除 ${id}`, 'info');
        renderAll();
      } catch (err) {
        toast('删除失败：' + cleanError(err), 'error');
      }
    }
  });

  // 设置
  $('#btn-choose-dir').addEventListener('click', async () => {
    const dir = await api.selectDir();
    if (!dir) return;
    await applyConfig({ gameDir: dir });
    $('#set-gamedir').value = dir;
    toast('游戏目录已更新，正在刷新版本列表…', 'info');
    await refreshVersions();
  });

  $('#set-gamedir').addEventListener('change', async (e) => {
    const dir = e.target.value.trim();
    if (!dir) {
      renderSettings();
      return;
    }
    await applyConfig({ gameDir: dir });
    await refreshVersions();
  });

  $$('input[name="mirror"]').forEach((r) =>
    r.addEventListener('change', async () => {
      const mirror = r.value;
      $('#set-custom-mirror').disabled = mirror !== 'custom';
      await applyConfig({ mirror });
      toast(`下载源已切换为：${mirrorLabel()}`, 'info');
      state.manifest = null;
      state.forge = null;
      state.optifine = null;
    })
  );

  $('#set-custom-mirror').addEventListener('change', async (e) => {
    await applyConfig({ customMirror: e.target.value.trim() });
    state.manifest = null;
  });

  $('#set-threads').addEventListener('change', (e) => {
    const n = Math.max(1, Math.min(64, parseInt(e.target.value, 10) || 16));
    e.target.value = n;
    applyConfig({ downloadThreads: n });
  });

  $('#set-mem-min').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    $('#set-mem-min-val').textContent = `${v} MB`;
    if (parseInt($('#set-mem-max').value, 10) < v) {
      $('#set-mem-max').value = v;
      $('#set-mem-max-val').textContent = `${v} MB`;
    }
    updateMemLabel();
    queueMemSave();
  });

  $('#set-mem-max').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    $('#set-mem-max-val').textContent = `${v} MB`;
    if (parseInt($('#set-mem-min').value, 10) > v) {
      $('#set-mem-min').value = v;
      $('#set-mem-min-val').textContent = `${v} MB`;
    }
    updateMemLabel();
    queueMemSave();
  });

  $('#set-jvm-args').addEventListener('input', (e) => {
    clearTimeout(state.jvmTimer);
    state.jvmTimer = setTimeout(() => applyConfig({ jvmArgs: e.target.value }), 500);
  });

  $('#java-list').addEventListener('change', async (e) => {
    if (e.target.name !== 'java-pick') return;
    await applyConfig({ javaPath: e.target.value });
    renderJavaList();
    renderMemorySummary();
  });

  $('#btn-scan-java').addEventListener('click', async () => {
    const btn = $('#btn-scan-java');
    btn.disabled = true;
    btn.textContent = '搜索中…';
    try {
      state.javas = await api.scanJava();
      renderJavaList();
      toast(`发现 ${state.javas.length} 个 Java 运行时`, 'info');
    } catch (err) {
      toast('搜索 Java 失败：' + cleanError(err), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '重新搜索';
    }
  });

  $('#btn-add-java').addEventListener('click', async () => {
    const p = await api.selectJava();
    if (!p) return;
    try {
      state.javas = await api.addJava(p);
      renderJavaList();
      toast('Java 已添加', 'info');
    } catch (err) {
      toast('添加失败：' + cleanError(err), 'error');
    }
  });

  // 启动器外观
  $('#btn-choose-bg').addEventListener('click', async () => {
    const file = await api.selectImage();
    if (!file) return;
    await applyConfig({ backgroundImage: file });
    $('#set-bg-path').value = file;
    await applyBackground();
    toast('界面背景已更新', 'info');
  });
  $('#btn-reset-bg').addEventListener('click', async () => {
    await applyConfig({ backgroundImage: '' });
    $('#set-bg-path').value = '';
    await applyBackground();
    toast('已恢复默认风景图', 'info');
  });
}

function updateMemLabel() {
  const min = parseInt($('#set-mem-min').value, 10);
  const max = parseInt($('#set-mem-max').value, 10);
  $('#mem-label').textContent = `${min} - ${max} MB`;
}

function queueMemSave() {
  clearTimeout(state.memTimer);
  state.memTimer = setTimeout(async () => {
    await applyConfig({
      minMemory: parseInt($('#set-mem-min').value, 10),
      maxMemory: parseInt($('#set-mem-max').value, 10)
    });
    renderMemorySummary();
  }, 350);
}

/* ------------------------------ 初始化 ------------------------------ */

function renderAll() {
  renderHome();
  fillBaseSelect($('#forge-mc'), $('#forge-mc-hint'));
  fillBaseSelect($('#fabric-mc'), $('#fabric-mc-hint'));
  fillBaseSelect($('#neoforge-mc'), $('#neoforge-mc-hint'));
  fillBaseSelect($('#of-mc'), $('#of-mc-hint'));
  renderDownloadGame();
  renderForge();
  renderFabric();
  renderNeoForge();
  renderOptiFine();
  renderVersions();
  renderModsVersionSelect();
  renderAbout();
  if (state.page === 'mods') renderMods();
  if (state.page === 'settings') renderSettings();
}

async function boot() {
  try {
    const s = await api.getState();
    state.config = s.config;
    state.presets = s.presets || {};
    state.versions = s.versions || [];
    state.javas = s.javas || [];
    state.account = s.account || null;
    state.authMode = (s.config && s.config.authMode) || 'offline';
    if (state.authMode === 'msa' && !state.account) state.authMode = 'offline';
    state.busy = s.busy;
    state.gameRunning = !!s.gameRunning;
  } catch (e) {
    toast('初始化失败：' + cleanError(e), 'error');
  }

  bindEvents();
  renderAll();
  applyBackground();
  if (!state.neoforge.length && !state.neoforgeLoading) loadNeoForgeList(true);
  if (!state.javas.length) scanJavaInBackground();

  if (state.config && state.config.lastVersion) {
    const sel = $('#home-version');
    if (Array.from(sel.options).some((o) => o.value === state.config.lastVersion)) {
      sel.value = state.config.lastVersion;
    }
  }
  renderHomeMeta();

  let lastTaskKind = null;
  api.onProgress((p) => {
    if (p.kind !== 'launch') state.busy = p.kind;
    if (p.kind !== lastTaskKind) {
      lastTaskKind = p.kind;
      state.taskPhases = [];
    }
    renderProgress(p);
    if (p.finished) {
      state.busy = null;
      state.taskPhases = [];
      renderHome();
      renderForge();
      renderOptiFine();
    }
  });

  api.onTaskLog(({ line }) => {
    if (line == null) return;
    appendLog(line);
  });

  api.onGameExit((info) => {
    state.gameRunning = false;
    appendLog(`[KMCL] 游戏已退出${info && info.code != null ? `（代码 ${info.code}）` : ''}`);
    if (info && info.error) toast('游戏异常退出：' + info.error, 'error');
    renderAll();
  });

  api.onAuthChange(handleAuthChange);

  $('#mirror-badge').textContent = mirrorLabel();
}

boot();
