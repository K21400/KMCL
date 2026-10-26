const fs = require('fs');
const path = require('path');

/**
 * 版本隔离：每个版本拥有独立的游戏目录（versions/<id>），
 * 存档、mods、配置、资源包互不影响；未开启隔离时沿用游戏根目录。
 */
function versionDir(cfg, versionId) {
  return path.join(cfg.gameDir, 'versions', versionId);
}

function stateFile(cfg, versionId) {
  return path.join(versionDir(cfg, versionId), 'kmcl-instance.json');
}

function readState(cfg, versionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(cfg, versionId), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeState(cfg, versionId, patch) {
  const next = { ...readState(cfg, versionId), ...patch };
  fs.mkdirSync(versionDir(cfg, versionId), { recursive: true });
  fs.writeFileSync(stateFile(cfg, versionId), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 已存在的旧版本默认沿用根目录，新安装的版本由 initNew 显式开启隔离 */
function isIsolated(cfg, versionId) {
  return readState(cfg, versionId).isolated === true;
}

function setIsolated(cfg, versionId, isolated) {
  return writeState(cfg, versionId, { isolated: !!isolated });
}

/** 新安装版本：仅在还没有隔离配置时默认开启，避免覆盖用户的修改 */
function initNew(cfg, versionId) {
  if (!fs.existsSync(stateFile(cfg, versionId))) writeState(cfg, versionId, { isolated: true });
}

/** 游戏工作目录（存档、options.txt、资源包所在目录） */
function gameDirOf(cfg, versionId) {
  return isIsolated(cfg, versionId) ? versionDir(cfg, versionId) : cfg.gameDir;
}

function modsDirOf(cfg, versionId) {
  return path.join(gameDirOf(cfg, versionId), 'mods');
}

function savesDirOf(cfg, versionId) {
  return path.join(gameDirOf(cfg, versionId), 'saves');
}

function ensureInstance(cfg, versionId) {
  const dir = gameDirOf(cfg, versionId);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'saves'), { recursive: true });
  return dir;
}

/**
 * 游戏设置默认值：
 * - lang:zh_CN 保证首次进入即为简体中文
 * - guiScale:2 保证底部快捷栏、血量与饥饿值在常见分辨率下正常可见
 * 已有 options.txt 时只补缺失项，不覆盖玩家自己的设置。
 */
function ensureGameOptions(gameDir) {
  if (!gameDir) return;
  const file = path.join(gameDir, 'options.txt');
  const defaults = [
    ['lang', 'zh_CN'],
    ['guiScale', '2'],
    ['fullscreen', 'false'],
    ['autoJump', 'false'],
    ['pauseOnLostFocus', 'false']
  ];
  try {
    fs.mkdirSync(gameDir, { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, defaults.map(([k, v]) => `${k}:${v}`).join('\n') + '\n', 'utf8');
      return;
    }
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const existing = new Set(
      lines.map((line) => {
        const i = line.indexOf(':');
        return i > 0 ? line.slice(0, i) : '';
      })
    );
    // 只补 lang / guiScale，其它设置保持玩家现状
    const missing = defaults.filter(([k]) => k === 'lang' || k === 'guiScale').filter(([k]) => !existing.has(k));
    if (!missing.length) return;
    const kept = lines.filter((line) => line.trim() !== '');
    fs.writeFileSync(file, [...kept, ...missing.map(([k, v]) => `${k}:${v}`)].join('\n') + '\n', 'utf8');
  } catch (e) {
    // 设置文件写入失败不应阻断安装或启动
  }
}

/** 给版本列表补充隔离信息 */
function decorate(cfg, versions) {
  return versions.map((v) => ({
    ...v,
    isolated: isIsolated(cfg, v.id),
    gameDir: gameDirOf(cfg, v.id),
    modpack: readState(cfg, v.id).modpack || null
  }));
}

module.exports = {
  versionDir,
  readState,
  writeState,
  isIsolated,
  setIsolated,
  initNew,
  gameDirOf,
  modsDirOf,
  savesDirOf,
  ensureInstance,
  ensureGameOptions,
  decorate
};
