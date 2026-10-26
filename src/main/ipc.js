const { app, ipcMain, dialog, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const configStore = require('./config');
const { TaskProgress } = require('./progress');
const { getManifest, findEntry } = require('./manifest');
const { listInstalled, versionDir } = require('./version');
const { installVersion, ensureDir } = require('./installer');
const javaUtil = require('./java');
const launcher = require('./launcher');
const loaders = require('./loaders');
const source = require('./source');
const auth = require('./auth');
const instance = require('./instance');
const modsource = require('./modsource');
const modpack = require('./modpack');
const tuning = require('./tuning');

let mainWindow = null;
let javas = [];
let currentTask = null;
let gameChild = null;
let authLogin = null;
let lastLaunch = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function cfg() {
  return configStore.get();
}

function listVersions(c) {
  return instance.decorate(c, listInstalled(c.gameDir));
}

/** mods 目录：按版本隔离后的实例目录，未指定版本时回退到根目录 */
function modsDirFor(c, versionId) {
  const id = String(versionId || c.lastVersion || '');
  if (!id) return path.join(c.gameDir, 'mods');
  return instance.modsDirOf(c, id);
}

function ensureLauncherProfiles(gameDir) {
  ensureDir(gameDir);
  const file = path.join(gameDir, 'launcher_profiles.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2),
      'utf8'
    );
  }
}

async function runTask(kind, label, fn) {
  if (currentTask) throw new Error('当前已有任务正在进行，请等待完成或取消');
  const controller = new AbortController();
  const progress = new TaskProgress((p) => send('task:progress', { kind, ...p }), label);
  currentTask = { kind, controller };
  try {
    return await fn({ progress, signal: controller.signal, onLog: (line) => send('task:log', { kind, line }) });
  } finally {
    currentTask = null;
    progress.finish();
  }
}

function registerIpc() {
  ipcMain.handle('app:state', async () => {
    const c = cfg();
    return {
      config: c,
      presets: source.PRESETS,
      versions: listVersions(c),
      selectedVersion: c.lastVersion || '',
      // 首次启动不阻塞界面：Java 列表由渲染层随后异步触发扫描
      javas,
      account: auth.publicAccount(),
      platform: process.platform,
      appVersion: app.getVersion(),
      busy: currentTask ? currentTask.kind : null,
      gameRunning: !!gameChild
    };
  });

  ipcMain.handle('config:update', async (e, patch) => {
    const saved = configStore.update(patch || {});
    if (patch && patch.gameDir) ensureLauncherProfiles(saved.gameDir);
    return saved;
  });

  ipcMain.handle('java:scan', async () => {
    javas = await javaUtil.scanJava();
    return javas;
  });

  ipcMain.handle('java:add', async (e, javaPath) => {
    const info = await javaUtil.validateJava(javaPath);
    if (!info) throw new Error('无效的 Java 路径');
    if (!javas.some((j) => j.path.toLowerCase() === info.path.toLowerCase())) javas.push(info);
    javas.sort((a, b) => b.major - a.major);
    return javas;
  });

  ipcMain.handle('dialog:selectDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:selectJava', async () => {
    const filters = process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: filters.length ? filters : undefined
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:selectImage', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  /** 自定义背景：读取本地图片并转成 data URL，避免渲染层访问任意文件路径 */
  ipcMain.handle('app:background', async () => {
    const file = cfg().backgroundImage;
    if (!file) return null;
    try {
      const ext = path.extname(file).toLowerCase();
      const mime =
        ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : ext === '.bmp'
                ? 'image/bmp'
                : 'image/jpeg';
      const data = fs.readFileSync(file);
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch (e) {
      return null;
    }
  });

  ipcMain.handle('auth:login', async () => {
    if (authLogin) throw new Error('正版登录正在进行中，请稍候');
    const controller = new AbortController();
    authLogin = controller;
    let resolveDevice;
    let rejectDevice;
    const deviceReady = new Promise((resolve, reject) => {
      resolveDevice = resolve;
      rejectDevice = reject;
    });
    auth
      .login({
        signal: controller.signal,
        onDeviceCode: (info) => resolveDevice(info)
      })
      .then((account) => {
        send('auth:change', { status: 'success', account });
      })
      .catch((e) => {
        if (/已取消/.test(e.message)) send('auth:change', { status: 'cancelled' });
        else send('auth:change', { status: 'error', message: e.message });
        rejectDevice(e);
      })
      .finally(() => {
        if (authLogin === controller) authLogin = null;
      });
    return deviceReady;
  });

  ipcMain.handle('auth:cancel', async () => {
    if (authLogin) authLogin.abort();
    return true;
  });

  ipcMain.handle('auth:logout', async () => {
    if (authLogin) {
      authLogin.abort();
      authLogin = null;
    }
    auth.clearAccount();
    configStore.update({ authMode: 'offline' });
    return true;
  });

  ipcMain.handle('app:openExternal', async (e, url) => {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) throw new Error('不支持的链接');
    await shell.openExternal(target);
    return true;
  });

  /* ---------------------------- 无边框窗口控制 ---------------------------- */

  ipcMain.handle('win:minimize', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return true;
  });

  ipcMain.handle('win:toggleMaximize', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  ipcMain.handle('win:close', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return true;
  });

  ipcMain.handle('win:isMaximized', async () => {
    return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized());
  });

  /* --------------------------- 运行配置自动调节 --------------------------- */

  ipcMain.handle('tuning:recommend', async (e, payload) => {
    const c = cfg();
    const versionId = String((payload && payload.versionId) || c.lastVersion || '');
    let javaMajor = 17;
    try {
      const info = c.javaPath ? await javaUtil.validateJava(c.javaPath) : null;
      if (info && info.major) javaMajor = info.major;
    } catch (err) {}
    const gameDir = versionId ? instance.gameDirOf(c, versionId) : c.gameDir;
    return tuning.recommend({ javaMajor, modsCount: tuning.countMods(gameDir) });
  });

  ipcMain.handle('manifest:get', async (e, force) => {
    const c = cfg();
    const data = await getManifest(c, !!force);
    return {
      latest: data.latest,
      versions: (data.versions || []).map((v) => ({
        id: v.id,
        type: v.type,
        releaseTime: v.releaseTime,
        url: v.url
      }))
    };
  });

  ipcMain.handle('version:install', async (e, { id }) => {
    const c = cfg();
    const data = await getManifest(c);
    const entry = findEntry(data, id);
    if (!entry) throw new Error('版本清单中找不到 ' + id);
    ensureLauncherProfiles(c.gameDir);
    const result = await runTask('install', `安装 ${id}`, ({ progress, signal }) =>
      installVersion(c, id, { entry, progress, signal })
    );
    instance.initNew(c, id);
    instance.ensureGameOptions(instance.gameDirOf(c, id));
    configStore.update({ lastVersion: id });
    return { ...result, versions: listVersions(c) };
  });

  ipcMain.handle('version:install-plus', async (e, { id, forgeVersion, fabricVersion, neoforgeVersion, optifineEdition }) => {
    const c = cfg();
    const data = await getManifest(c);
    const entry = findEntry(data, id);
    if (!entry) throw new Error('版本清单中找不到 ' + id);
    // 加载器互斥：同时传入多个时以第一个为准，避免装出混用加载器的版本
    const chosen = [
      { type: 'forge', version: forgeVersion },
      { type: 'fabric', version: fabricVersion },
      { type: 'neoforge', version: neoforgeVersion }
    ].find((x) => x.version);
    ensureLauncherProfiles(c.gameDir);
    const result = await runTask('install', `安装 ${id}`, async ({ progress, signal, onLog }) => {
      await installVersion(c, id, { entry, progress, signal });
      let versionId = id;
      if (chosen) {
        if (chosen.type === 'forge') {
          const r = await loaders.installForge(c, id, chosen.version, {
            progress,
            signal,
            onLog,
            baseFresh: true
          });
          versionId = r.versionId;
        } else if (chosen.type === 'fabric') {
          const r = await loaders.installFabric(c, id, chosen.version, { progress, signal, onLog });
          versionId = r.versionId;
        } else {
          const r = await loaders.installNeoForge(c, id, chosen.version, { progress, signal, onLog });
          versionId = r.versionId;
        }
        instance.initNew(c, versionId);
        // OptiFine 只在 Forge 环境下以 mod 形式共存；Fabric / NeoForge 不支持
        if (optifineEdition && chosen.type === 'forge') {
          await loaders.installOptiFineAsMod(c, id, optifineEdition, {
            progress,
            signal,
            onLog,
            versionId
          });
        }
      } else if (optifineEdition) {
        const ofResult = await loaders.installOptiFine(c, id, optifineEdition, { progress, signal, onLog });
        versionId = ofResult.versionId;
        instance.initNew(c, versionId);
      }
      instance.ensureGameOptions(instance.gameDirOf(c, versionId));
      return { versionId };
    });
    configStore.update({ lastVersion: result.versionId });
    return { ...result, versions: listVersions(c) };
  });

  ipcMain.handle('version:delete', async (e, id) => {
    const c = cfg();
    const dir = versionDir(c.gameDir, id);
    if (!fs.existsSync(dir)) throw new Error('版本不存在');
    fs.rmSync(dir, { recursive: true, force: true });
    return listVersions(c);
  });

  ipcMain.handle('version:openFolder', async (e, id) => {
    const c = cfg();
    shell.openPath(id ? versionDir(c.gameDir, id) : c.gameDir);
  });

  ipcMain.handle('mods:open', async (e, versionId) => {
    const c = cfg();
    const dir = modsDirFor(c, versionId);
    ensureDir(dir);
    shell.openPath(dir);
  });

  ipcMain.handle('mods:list', async (e, payload) => {
    const c = cfg();
    const versionId = typeof payload === 'string' ? payload : (payload && payload.versionId) || '';
    const dir = modsDirFor(c, versionId);
    ensureDir(dir);
    const items = [];
    for (const file of fs.readdirSync(dir)) {
      const isDisabled = /\.jar\.disabled$/i.test(file);
      if (!isDisabled && !/\.jar$/i.test(file)) continue;
      const full = path.join(dir, file);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch (e) {
        continue;
      }
      if (!stat.isFile()) continue;
      items.push({
        name: isDisabled ? file.replace(/\.disabled$/i, '') : file,
        enabled: !isDisabled,
        size: stat.size,
        mtime: stat.mtimeMs
      });
    }
    items.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    return { dir, items };
  });

  ipcMain.handle('mods:toggle', async (e, { name, enabled, versionId }) => {
    const c = cfg();
    const dir = modsDirFor(c, versionId);
    ensureDir(dir);
    const safe = path.basename(String(name || ''));
    if (!safe || safe !== name) throw new Error('非法的 mod 文件名');
    const active = path.join(dir, safe);
    const disabled = `${active}.disabled`;
    if (enabled) {
      if (!fs.existsSync(disabled)) throw new Error('该 mod 已启用或文件不存在');
      if (fs.existsSync(active)) throw new Error('同名 mod 已启用，请先检查 mods 目录');
      fs.renameSync(disabled, active);
    } else {
      if (!fs.existsSync(active)) throw new Error('该 mod 已禁用或文件不存在');
      fs.renameSync(active, disabled);
    }
    return true;
  });

  ipcMain.handle('mods:delete', async (e, payload) => {
    const c = cfg();
    const name = typeof payload === 'string' ? payload : payload && payload.name;
    const dir = modsDirFor(c, payload && payload.versionId);
    const safe = path.basename(String(name || ''));
    if (!safe || safe !== name) throw new Error('非法的 mod 文件名');
    const active = path.join(dir, safe);
    const disabled = `${active}.disabled`;
    if (!fs.existsSync(active) && !fs.existsSync(disabled)) throw new Error('mod 文件不存在');
    fs.rmSync(active, { force: true });
    fs.rmSync(disabled, { force: true });
    return true;
  });

  ipcMain.handle('version:isolate', async (e, { id, isolated }) => {
    const c = cfg();
    if (!versionDir(c.gameDir, id) || !fs.existsSync(versionDir(c.gameDir, id))) {
      throw new Error('版本不存在');
    }
    instance.setIsolated(c, id, isolated);
    if (isolated) instance.ensureInstance(c, id);
    return listVersions(c);
  });

  ipcMain.handle('version:openInstance', async (e, id) => {
    const c = cfg();
    const dir = instance.ensureInstance(c, id);
    shell.openPath(dir);
  });

  ipcMain.handle('mods:search', async (e, payload) => {
    return modsource.searchMods(cfg(), payload || {});
  });

  ipcMain.handle('mods:files', async (e, payload) => {
    return modsource.listFiles(cfg(), payload || {});
  });

  ipcMain.handle('mods:project', async (e, payload) => {
    return modsource.getProject(cfg(), payload || {});
  });

  // 点击 MC 百科时再解析具体条目页，避免详情弹窗被额外网络请求拖慢
  ipcMain.handle('mods:mcmod', async (e, payload) => {
    return modsource.resolveMcmodUrl((payload && payload.name) || '', (payload && payload.type) || 'mod');
  });

  // 批量把 mod 名称换成 MC 百科的中文社区名称
  ipcMain.handle('mods:cnnames', async (e, payload) => {
    return modsource.resolveChineseNames((payload && payload.names) || []);
  });

  ipcMain.handle('mods:deps', async (e, payload) => {
    return modsource.resolveDependencies(cfg(), payload || {});
  });

  ipcMain.handle('mods:install', async (e, payload) => {
    const c = cfg();
    const p = payload || {};
    if (!p.versionId) throw new Error('请选择要安装到的游戏版本');
    const result = await runTask('mod', `下载 ${p.name || 'Mod'}`, ({ progress, signal, onLog }) =>
      modsource.installMod(c, {
        source: p.source,
        projectId: p.projectId,
        fileId: p.fileId,
        versionId: p.versionId,
        mcVersion: p.mcVersion,
        loader: p.loader,
        name: p.name,
        withDependencies: !!p.withDependencies,
        progress,
        signal,
        onLog
      })
    );
    return { ...result, dir: modsDirFor(c, p.versionId) };
  });

  ipcMain.handle('modpack:install', async (e, payload) => {
    const c = cfg();
    const p = payload || {};
    const result = await runTask('modpack', `安装整合包 ${p.name || ''}`.trim(), ({ progress, signal, onLog }) =>
      modpack.installModpack(c, {
        source: p.source,
        projectId: p.projectId,
        fileId: p.fileId,
        mcVersion: p.mcVersion,
        loader: p.loader,
        progress,
        signal,
        onLog
      })
    );
    configStore.update({ lastVersion: result.versionId });
    instance.ensureGameOptions(instance.gameDirOf(c, result.versionId));
    return { ...result, versions: listVersions(c) };
  });

  ipcMain.handle('modpack:pick', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择整合包压缩包',
      properties: ['openFile'],
      filters: [
        { name: 'Minecraft 整合包', extensions: ['zip', 'mrpack'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    return picked.filePaths[0];
  });

  // 导入前预检：识别格式、游戏版本、加载器与 mod 数量，不做任何下载
  ipcMain.handle('modpack:inspect', async (e, payload) => {
    const localPath = String((payload && payload.localPath) || '');
    if (!localPath) throw new Error('未提供整合包路径');
    if (!fs.existsSync(localPath)) throw new Error('文件不存在：' + localPath);
    return modpack.inspectLocalPack(localPath);
  });

  ipcMain.handle('modpack:import', async (e, payload) => {
    const c = cfg();
    const p = payload || {};
    // 允许直接传入本地文件路径（自动化 / 拖拽），否则弹出文件选择框
    let localPath = p.localPath ? String(p.localPath) : '';
    if (!localPath) {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: '选择整合包压缩包',
        properties: ['openFile'],
        filters: [
          { name: 'Minecraft 整合包', extensions: ['zip', 'mrpack'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      });
      if (picked.canceled || !picked.filePaths.length) return null;
      localPath = picked.filePaths[0];
    }
    if (!fs.existsSync(localPath)) throw new Error('整合包文件不存在：' + localPath);
    const result = await runTask('modpack', `导入 ${path.basename(localPath)}`, ({ progress, signal, onLog }) =>
      modpack.installModpack(c, {
        localPath,
        mcVersion: p.mcVersion,
        loaderType: p.loaderType,
        progress,
        signal,
        onLog
      })
    );
    configStore.update({ lastVersion: result.versionId });
    return { ...result, versions: listVersions(c) };
  });

  ipcMain.handle('log:export', async (e, payload) => {
    const c = cfg();
    const versionId = (payload && payload.versionId) || c.lastVersion || '';
    const gameDir = versionId ? instance.gameDirOf(c, versionId) : c.gameDir;
    const logsDir = path.join(gameDir, 'logs');
    let logFile = lastLaunch && lastLaunch.logFile && (!versionId || lastLaunch.versionId === versionId)
      ? lastLaunch.logFile
      : '';
    if (!logFile || !fs.existsSync(logFile)) {
      const all = fs.existsSync(logsDir)
        ? fs
            .readdirSync(logsDir)
            .filter((f) => f.endsWith('.log'))
            .map((f) => ({ f, t: fs.statSync(path.join(logsDir, f)).mtimeMs }))
        : [];
      // 优先 KMCL 启动日志，其次 latest.log，最后才用其它日志（如调试日志）
      const rank = (f) => (/^kmcl-/i.test(f) ? 0 : /^latest\.log$/i.test(f) ? 1 : 2);
      all.sort((a, b) => rank(a.f) - rank(b.f) || b.t - a.t);
      logFile = all.length ? path.join(logsDir, all[0].f) : '';
    }
    const crashDir = path.join(gameDir, 'crash-reports');
    let crashFile = '';
    if (fs.existsSync(crashDir)) {
      const list = fs
        .readdirSync(crashDir)
        .filter((f) => f.endsWith('.txt'))
        .map((f) => ({ f, t: fs.statSync(path.join(crashDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (list.length) crashFile = path.join(crashDir, list[0].f);
    }
    if (!logFile && !crashFile) throw new Error('未找到可导出的日志或崩溃报告，请先启动一次游戏');

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const defaultName = `KMCL-报错日志-${versionId || 'game'}-${stamp}.txt`;
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: '导出游戏报错文档',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (picked.canceled || !picked.filePath) return null;

    const parts = [
      '# KMCL 游戏日志导出',
      `版本: ${versionId || '未知'}`,
      `导出时间: ${new Date().toLocaleString('zh-CN')}`,
      `游戏目录: ${gameDir}`,
      `日志文件: ${logFile || '（无）'}`,
      `崩溃报告: ${crashFile || '（无）'}`,
      `Java: ${c.javaPath || '自动'}  内存: ${c.minMemory || 512}MB - ${c.maxMemory || 4096}MB`,
      ''
    ];
    if (logFile) parts.push('===== 启动日志 =====', fs.readFileSync(logFile, 'utf8'));
    if (crashFile) parts.push('===== 崩溃报告 =====', fs.readFileSync(crashFile, 'utf8'));
    fs.writeFileSync(picked.filePath, parts.join('\r\n'), 'utf8');
    return { path: picked.filePath };
  });

  ipcMain.handle('forge:list', async () => {
    const c = cfg();
    return loaders.listForge(c);
  });

  ipcMain.handle('fabric:list', async (e, mcVersion) => {
    return loaders.listFabric(cfg(), mcVersion);
  });

  ipcMain.handle('fabric:install', async (e, { mcVersion, loaderVersion }) => {
    const c = cfg();
    ensureLauncherProfiles(c.gameDir);
    const result = await runTask('fabric', `安装 Fabric ${loaderVersion}`, ({ progress, signal, onLog }) =>
      loaders.installFabric(c, mcVersion, loaderVersion, { progress, signal, onLog })
    );
    instance.initNew(c, result.versionId);
    configStore.update({ lastVersion: result.versionId });
    return { ...result, versions: listVersions(c) };
  });

  ipcMain.handle('neoforge:list', async () => {
    return loaders.listNeoForge(cfg());
  });

  ipcMain.handle('neoforge:install', async (e, { mcVersion, loaderVersion }) => {
    const c = cfg();
    ensureLauncherProfiles(c.gameDir);
    const result = await runTask('neoforge', `安装 NeoForge ${loaderVersion}`, ({ progress, signal, onLog }) =>
      loaders.installNeoForge(c, mcVersion, loaderVersion, { progress, signal, onLog })
    );
    instance.initNew(c, result.versionId);
    configStore.update({ lastVersion: result.versionId });
    return { ...result, versions: listVersions(c) };
  });
  ipcMain.handle('forge:install', async (e, { mcVersion, forgeVersion }) => {
    const c = cfg();
    ensureLauncherProfiles(c.gameDir);
    const result = await runTask('forge', `安装 Forge ${forgeVersion}`, ({ progress, signal, onLog }) =>
      loaders.installForge(c, mcVersion, forgeVersion, { progress, signal, onLog })
    );
    instance.initNew(c, result.versionId);
    configStore.update({ lastVersion: result.versionId });
    return { ...result, versions: listVersions(c) };
  });

  ipcMain.handle('optifine:list', async (e, mcVersion) => {
    return loaders.listOptiFine(cfg(), mcVersion);
  });

  ipcMain.handle('optifine:install', async (e, { mcVersion, edition }) => {
    const c = cfg();
    ensureLauncherProfiles(c.gameDir);
    const result = await runTask('optifine', `安装 OptiFine ${edition}`, ({ progress, signal, onLog }) =>
      loaders.installOptiFine(c, mcVersion, edition, { progress, signal, onLog })
    );
    instance.initNew(c, result.versionId);
    configStore.update({ lastVersion: result.versionId });
    return { ...result, versions: listVersions(c) };
  });

  ipcMain.handle('task:cancel', async () => {
    if (currentTask) currentTask.controller.abort();
    return true;
  });

  ipcMain.handle('game:launch', async (e, versionId) => {
    if (gameChild) throw new Error('游戏已在运行中');
    if (currentTask) throw new Error('当前有下载/安装任务正在进行，请等待完成');
    const c = cfg();
    ensureLauncherProfiles(c.gameDir);
    let account = null;
    if (c.authMode === 'msa') {
      account = await auth.getSession();
    }
    const progress = new TaskProgress((p) => send('task:progress', { kind: 'launch', ...p }), `启动 ${versionId}`);
    try {
      const info = await launcher.launchGame({
        cfg: c,
        versionId,
        account,
        progress,
        signal: undefined,
        onLog: (line) => send('task:log', { kind: 'launch', line }),
        onExit: (info2) => {
          gameChild = null;
          send('game:exit', info2);
        }
      });
      progress.finish();
      configStore.update({ lastVersion: versionId });
      gameChild = { pid: info.pid };
      lastLaunch = { versionId, logFile: info.logFile, startedAt: Date.now() };
      return { ...info, gameRunning: true };
    } catch (err) {
      progress.finish();
      throw err;
    }
  });

  ipcMain.handle('game:kill', async () => {
    if (gameChild) {
      try {
        process.kill(gameChild.pid);
      } catch (e) {}
      gameChild = null;
    }
    return true;
  });

  ipcMain.handle('game:info', async () => ({
    versions: listVersions(cfg()),
    gameRunning: !!gameChild
  }));
}

function setWindow(win) {
  mainWindow = win;
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

module.exports = { registerIpc, setWindow, send };
