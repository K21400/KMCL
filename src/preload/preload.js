const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function on(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('kmcl', {
  getState: () => invoke('app:state'),
  updateConfig: (patch) => invoke('config:update', patch),
  scanJava: () => invoke('java:scan'),
  addJava: (path) => invoke('java:add', path),
  selectDir: () => invoke('dialog:selectDir'),
  selectJava: () => invoke('dialog:selectJava'),
  selectImage: () => invoke('dialog:selectImage'),
  getBackground: () => invoke('app:background'),
  getManifest: (force) => invoke('manifest:get', force),
  installVersion: (payload) => invoke('version:install', payload),
  installVersionPlus: (payload) => invoke('version:install-plus', payload),
  deleteVersion: (id) => invoke('version:delete', id),
  openVersionFolder: (id) => invoke('version:openFolder', id),
  setIsolated: (id, isolated) => invoke('version:isolate', { id, isolated }),
  openInstanceFolder: (id) => invoke('version:openInstance', id),
  openModsFolder: (versionId) => invoke('mods:open', versionId),
  listMods: (versionId) => invoke('mods:list', { versionId }),
  toggleMod: (payload) => invoke('mods:toggle', payload),
  deleteMod: (payload) => invoke('mods:delete', payload),
  searchMods: (payload) => invoke('mods:search', payload),
  listModFiles: (payload) => invoke('mods:files', payload),
  getModProject: (payload) => invoke('mods:project', payload),
  getMcmodUrl: (payload) => invoke('mods:mcmod', payload),
  getChineseNames: (payload) => invoke('mods:cnnames', payload),
  getModDeps: (payload) => invoke('mods:deps', payload),
  installMod: (payload) => invoke('mods:install', payload),
  installModpack: (payload) => invoke('modpack:install', payload),
  importModpack: (payload) => invoke('modpack:import', payload),
  pickModpack: () => invoke('modpack:pick'),
  inspectModpack: (payload) => invoke('modpack:inspect', payload),
  // 拖拽文件的真实路径（Electron 29+ 必须通过 webUtils 获取）
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (e) {
      return '';
    }
  },
  exportLog: (payload) => invoke('log:export', payload),
  listForge: () => invoke('forge:list'),
  installForge: (payload) => invoke('forge:install', payload),
  listFabric: (mcVersion) => invoke('fabric:list', mcVersion),
  installFabric: (payload) => invoke('fabric:install', payload),
  listNeoForge: () => invoke('neoforge:list'),
  installNeoForge: (payload) => invoke('neoforge:install', payload),
  listOptiFine: (mcVersion) => invoke('optifine:list', mcVersion),
  installOptiFine: (payload) => invoke('optifine:install', payload),
  cancelTask: () => invoke('task:cancel'),
  launch: (versionId) => invoke('game:launch', versionId),
  killGame: () => invoke('game:kill'),
  gameInfo: () => invoke('game:info'),
  authLogin: () => invoke('auth:login'),
  authCancel: () => invoke('auth:cancel'),
  authLogout: () => invoke('auth:logout'),
  openExternal: (url) => invoke('app:openExternal', url),
  recommendTuning: (payload) => invoke('tuning:recommend', payload),
  winMinimize: () => invoke('win:minimize'),
  winToggleMaximize: () => invoke('win:toggleMaximize'),
  winClose: () => invoke('win:close'),
  winIsMaximized: () => invoke('win:isMaximized'),
  copyText: (text) => clipboard.writeText(String(text)),
  onProgress: (cb) => on('task:progress', cb),
  onTaskLog: (cb) => on('task:log', cb),
  onGameExit: (cb) => on('game:exit', cb),
  onAuthChange: (cb) => on('auth:change', cb),
  onWindowState: (cb) => on('win:state', cb)
});
