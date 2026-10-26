const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

/** 便携版由 electron-builder 注入 PORTABLE_EXECUTABLE_DIR；开发时使用工程根目录 */
function projectRoot() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (/^electron(\.exe)?$/i.test(path.basename(process.execPath))) {
    return path.join(__dirname, '..', '..');
  }
  return path.dirname(process.execPath);
}

const DEFAULT_GAME_DIR = path.join(projectRoot(), 'minecraft');
const LEGACY_GAME_DIR = path.join(app.getPath('appData'), '.minecraft');

const DEFAULTS = {
  gameDir: DEFAULT_GAME_DIR,
  mirror: 'bmclapi', // bmclapi | official | custom
  customMirror: '',
  downloadThreads: 16,
  username: 'Steve',
  authMode: 'offline', // offline | msa
  lastVersion: '',
  javaPath: '',
  minMemory: 512,
  maxMemory: 4096,
  jvmArgs: '',
  // 自动调节：按物理内存、Java 版本与 mod 数量动态计算内存与 GC 参数
  autoTune: true,
  // 启动器背景图：空字符串使用内置的我的世界风景图
  backgroundImage: ''
};

let cache = null;

function load() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    saved = {};
  }
  cache = { ...DEFAULTS, ...saved };
  // 旧版本默认把游戏目录放在 %APPDATA%\.minecraft，这里迁移到工程目录内
  if (!saved.gameDir || path.resolve(saved.gameDir) === path.resolve(LEGACY_GAME_DIR)) {
    cache.gameDir = DEFAULT_GAME_DIR;
  }
  cache.maxMemory = clampMemory(cache.maxMemory);
  cache.minMemory = clampMemory(cache.minMemory);
  if (cache.maxMemory < cache.minMemory) cache.maxMemory = cache.minMemory;
  return cache;
}

function clampMemory(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 2048;
  return Math.round(Math.min(Math.max(n, 256), 65536) / 256) * 256;
}

function get() {
  return load();
}

function save() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error('保存配置失败', e);
  }
}

function update(patch) {
  cache = { ...load(), ...patch };
  cache.maxMemory = clampMemory(cache.maxMemory);
  cache.minMemory = clampMemory(cache.minMemory);
  if (cache.maxMemory < cache.minMemory) cache.maxMemory = cache.minMemory;
  save();
  return cache;
}

function gameDir() {
  return load().gameDir;
}

module.exports = { get, update, gameDir, CONFIG_FILE, DEFAULTS };
