const fs = require('fs');
const path = require('path');
const os = require('os');
const { fetchJson } = require('./http');
const source = require('./source');

function versionDir(gameDir, id) {
  return path.join(gameDir, 'versions', id);
}

function versionJsonPath(gameDir, id) {
  return path.join(versionDir(gameDir, id), `${id}.json`);
}

function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function readInstalledVersion(gameDir, id) {
  try {
    return readJsonFile(versionJsonPath(gameDir, id));
  } catch (e) {
    return null;
  }
}

function writeInstalledVersion(gameDir, id, data) {
  const dir = versionDir(gameDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(versionJsonPath(gameDir, id), JSON.stringify(data, null, 2), 'utf8');
}

/** 列出已安装版本（含加载器版本），按修改时间倒序 */
function listInstalled(gameDir) {
  const dir = path.join(gameDir, 'versions');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const json = readInstalledVersion(gameDir, id);
    if (!json) continue;
    const jarPath = path.join(versionDir(gameDir, id), `${id}.jar`);
    const hasJar = fs.existsSync(jarPath);
    result.push({
      id,
      type: json.type || 'unknown',
      baseVersion: json.inheritsFrom || null,
      hasJar,
      installed: hasJar || !!json.inheritsFrom,
      mtime: safeMtime(path.join(dir, id))
    });
  }
  return result.sort((a, b) => b.mtime - a.mtime);
}

function safeMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (e) {
    return 0;
  }
}

/** 获取版本 json：优先本地，其次远程 */
async function getVersionDetail(cfg, id, entry) {
  const local = readInstalledVersion(cfg.gameDir, id);
  if (local) return local;
  const urls = source.versionJsonUrls(cfg, id, entry && entry.url);
  if (!entry && !source.mirrorBase(cfg)) {
    throw new Error('版本 ' + id + ' 尚未安装');
  }
  try {
    return await fetchJson(urls, { race: true, timeout: 25000 });
  } catch (e) {
    if (!entry) throw new Error(`无法获取版本 ${id} 的信息：${e.message}`);
    throw e;
  }
}

/** 判断 rules 是否允许当前环境（Windows 64 位） */
function rulesAllow(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== 'windows') match = false;
      if (match && rule.os.arch && rule.os.arch !== 'x86_64' && rule.os.arch !== 'amd64') match = false;
    }
    if (match && rule.features) {
      for (const key of Object.keys(rule.features)) {
        const want = rule.features[key];
        const have = !!features[key];
        if (want !== have) {
          match = false;
          break;
        }
      }
    }
    if (!match) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

/** 合并父版本与子版本（Forge / OptiFine 的 inheritsFrom） */
function mergeVersions(parent, child) {
  const out = { ...parent, ...child };
  if (!child.mainClass && parent.mainClass) out.mainClass = parent.mainClass;
  if (!child.minecraftArguments && parent.minecraftArguments) out.minecraftArguments = parent.minecraftArguments;
  if (!child.assets && parent.assets) out.assets = parent.assets;
  if (!child.assetIndex && parent.assetIndex) out.assetIndex = parent.assetIndex;
  if (!child.javaVersion && parent.javaVersion) out.javaVersion = parent.javaVersion;
  if (!child.downloads && parent.downloads) out.downloads = parent.downloads;
  if (!child.logging && parent.logging) out.logging = parent.logging;

  const libMap = new Map();
  for (const lib of parent.libraries || []) libMap.set(libKey(lib), lib);
  for (const lib of child.libraries || []) libMap.set(libKey(lib), lib);
  out.libraries = [...libMap.values()];

  const parentArgs = parent.arguments || {};
  const childArgs = child.arguments || {};
  if (parent.arguments || child.arguments) {
    out.arguments = {
      game: [...(parentArgs.game || []), ...(childArgs.game || [])],
      jvm: [...(parentArgs.jvm || []), ...(childArgs.jvm || [])]
    };
    if (!out.arguments.jvm.length) delete out.arguments.jvm;
    if (!out.arguments.game.length) delete out.arguments.game;
  }
  out.id = child.id || parent.id;
  return out;
}

function libKey(lib) {
  const name = lib.name || '';
  const at = name.lastIndexOf('@');
  const coords = at >= 0 ? name.slice(0, at) : name;
  const parts = coords.split(':');
  if (parts.length < 2) return name;
  // 同一 group:artifact 的版本升级要覆盖旧版本（如 Forge 覆盖 log4j），
  // 但按平台分流的同坐标条目必须共存：1.12.2 同时提供 lwjgl 2.9.4（Windows）与 2.9.2（仅 macOS），
  // 若只按 group:artifact 去重，Windows 可用的 2.9.4 会被仅 macOS 的 2.9.2 覆盖掉。
  const [group, artifact, , classifier] = parts;
  return `${group}:${artifact}:${classifier || ''}:${JSON.stringify(lib.rules || null)}`;
}

/**
 * 解析版本链，返回合并后的版本、基础版本 id 与基础版本 json。
 */
function resolveFullVersion(gameDir, id, depth = 0) {
  if (depth > 5) throw new Error('版本继承层级过深');
  const json = readInstalledVersion(gameDir, id);
  if (!json) throw new Error(`版本 ${id} 未安装`);
  if (json.inheritsFrom) {
    const parent = resolveFullVersion(gameDir, json.inheritsFrom, depth + 1);
    return {
      json: mergeVersions(parent.json, json),
      baseId: parent.baseId,
      baseJson: parent.baseJson,
      chain: [id, ...parent.chain]
    };
  }
  return { json, baseId: id, baseJson: json, chain: [id] };
}

/** maven 坐标转路径 */
function mavenToPath(name) {
  let coords = name;
  let ext = 'jar';
  const at = name.lastIndexOf('@');
  if (at >= 0) {
    coords = name.slice(0, at);
    ext = name.slice(at + 1);
  }
  const parts = coords.split(':');
  const [group, artifact, version, classifier] = parts;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${
    classifier ? '-' + classifier : ''
  }.${ext}`;
}

/**
 * 收集当前环境需要下载/加载的依赖库。
 * 返回 [{ name, path, urls, sha1, size, native, extract }]
 */
function collectLibraries(cfg, detail) {
  const result = [];
  const seen = new Set();
  for (const lib of detail.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const name = lib.name;
    if (!name) continue;

    const dl = (lib.downloads && lib.downloads.artifact) || null;
    const relPath = (dl && dl.path) || (lib.natives ? null : mavenToPath(name));
    if (relPath && !seen.has(relPath)) {
      seen.add(relPath);
      let official;
      if (dl && dl.url) official = dl.url;
      else if (lib.url) official = joinUrl(lib.url, relPath);
      else official = source.OFFICIAL_LIBRARIES + relPath;

      result.push({
        name,
        path: relPath,
        urls: source.libraryUrls(cfg, relPath, official),
        sha1: dl && dl.sha1,
        size: dl && dl.size,
        native: false,
        extract: null
      });
    }

    // 旧格式（natives 字段）需要额外解压本地库，主 jar 依然要进 classpath
    if (!lib.natives) continue;
    const template = lib.natives.windows;
    if (!template) continue;
    const classifier = template.replace('${arch}', '64');
    const nativeDl = (lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[classifier]) || null;
    const nativePath = (nativeDl && nativeDl.path) || mavenToPath(`${name}:${classifier}`);
    if (seen.has(nativePath)) continue;
    seen.add(nativePath);
    const nativeOfficial =
      (nativeDl && nativeDl.url) || (lib.url ? joinUrl(lib.url, nativePath) : source.OFFICIAL_LIBRARIES + nativePath);
    result.push({
      name,
      path: nativePath,
      urls: source.libraryUrls(cfg, nativePath, nativeOfficial),
      sha1: nativeDl && nativeDl.sha1,
      size: nativeDl && nativeDl.size,
      native: true,
      extract: lib.extract || null
    });
  }
  return result;
}

function joinUrl(base, relPath) {
  return base.endsWith('/') ? base + relPath : base + '/' + relPath;
}

function platformInfo() {
  return {
    arch: os.arch(),
    platform: process.platform,
    version: os.release()
  };
}

module.exports = {
  versionDir,
  versionJsonPath,
  readInstalledVersion,
  writeInstalledVersion,
  listInstalled,
  getVersionDetail,
  resolveFullVersion,
  mergeVersions,
  rulesAllow,
  mavenToPath,
  collectLibraries,
  readJsonFile,
  platformInfo
};
