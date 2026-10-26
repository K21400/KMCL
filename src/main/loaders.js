const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const source = require('./source');
const version = require('./version');
const installer = require('./installer');
const instance = require('./instance');
const javaUtil = require('./java');
const { getManifest, findEntry } = require('./manifest');
const { fetchText, fetchJson, download, downloadFast } = require('./http');
const { runPool } = require('./progress');

const FORGE_MAVEN = source.OFFICIAL_FORGE_MAVEN;

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

function forgeFullVersion(mcVersion, forgeVersion) {
  return forgeVersion.startsWith(`${mcVersion}-`) ? forgeVersion : `${mcVersion}-${forgeVersion}`;
}

function compareNumeric(a, b) {
  const pa = String(a).split(/[._+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[._+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 下载地址集合：镜像 -> 官方 maven（按坐标自动选择 Forge / NeoForge / Mojang） */
function artifactUrls(cfg, relPath) {
  const urls = [];
  if (/^net\/neoforged(\/|\.)/.test(relPath)) {
    urls.push(...source.mavenUrls(cfg, relPath, `${source.OFFICIAL_NEOFORGE_MAVEN}${relPath}`));
  }
  urls.push(...source.mavenUrls(cfg, relPath, `${FORGE_MAVEN}${relPath}`));
  urls.push(...source.mavenUrls(cfg, relPath, `${source.OFFICIAL_LIBRARIES}${relPath}`));
  return uniq(urls);
}

/* ----------------------------- Forge ----------------------------- */

async function listForge(cfg) {
  // BMCLAPI 的 Forge maven 会 302 到失效节点，与官方源竞速可避免长时间等待
  const xml = await fetchText(source.forgeMetadataUrls(cfg), { race: true, timeout: 25000 });
  if (!xml || !xml.includes('<version>')) throw new Error('Forge 版本列表格式异常');
  const list = [];
  for (const m of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
    const full = m[1].trim();
    const idx = full.indexOf('-');
    if (idx <= 0) continue;
    const mc = full.slice(0, idx);
    const loader = full.slice(idx + 1);
    if (!/^\d+(\.\d+)+$/.test(mc)) continue;
    if (!/^\d+\.\d+/.test(loader)) continue;
    list.push({ mc, loader, full });
  }
  return list;
}

function ensureBaseInstalled(cfg, mcVersion, progress, signal) {
  return (async () => {
    const jarPath = path.join(version.versionDir(cfg.gameDir, mcVersion), `${mcVersion}.jar`);
    if (fs.existsSync(jarPath) && version.readInstalledVersion(cfg.gameDir, mcVersion)) return;
    const manifest = await getManifest(cfg);
    const entry = findEntry(manifest, mcVersion);
    if (!entry) throw new Error(`找不到游戏版本 ${mcVersion}，请先在“游戏版本”中安装它`);
    await installer.installVersion(cfg, mcVersion, { entry, progress, signal });
  })();
}

async function pickInstallJava(cfg, mcVersion) {
  let required = 8;
  try {
    const json = version.readInstalledVersion(cfg.gameDir, mcVersion);
    if (json && json.javaVersion && json.javaVersion.majorVersion) required = json.javaVersion.majorVersion;
  } catch (e) {}
  // 手动指定的 Java 只有满足版本要求才能用于运行安装处理器，否则改用自动扫描结果
  if (cfg.javaPath) {
    const info = await javaUtil.validateJava(cfg.javaPath);
    if (info && info.major >= required) return info;
  }
  const javas = await javaUtil.scanJava();
  const info = javaUtil.pickJava(javas, required);
  if (!info) throw new Error(`未找到可用的 Java（需要 Java ${required}+），请先在“设置”中指定 Java`);
  return info;
}

function runProcess(javaPath, args, cwd, { signal, onLog, name } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true });
    let output = '';
    const handle = (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      if (output.length > 30000) output = output.slice(-30000);
      if (onLog) {
        for (const line of text.split(/\r?\n/)) if (line.trim()) onLog(`[Forge] ${line}`);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    if (signal) {
      if (signal.aborted) {
        child.kill();
        return reject(new Error('任务已取消'));
      }
      signal.addEventListener('abort', () => child.kill(), { once: true });
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Forge 安装处理器${name ? ' ' + name : ''}执行失败（退出码 ${code}）\n${output.slice(-1500)}`
          )
        );
    });
  });
}

function readMainClass(jarPath) {
  try {
    const zip = new AdmZip(jarPath);
    const entry = zip.getEntry('META-INF/MANIFEST.MF');
    if (!entry) return null;
    const text = zip.readAsText(entry);
    const m = text.match(/^Main-Class:\s*(.+)$/mi);
    return m ? m[1].trim() : null;
  } catch (e) {
    return null;
  }
}

function extractEmbeddedMaven(zip, libsDir) {
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    if (!name.startsWith('maven/')) continue;
    const rel = name.slice('maven/'.length);
    if (!rel) continue;
    const dest = path.join(libsDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }
}

async function ensureCoord(cfg, coord, progress, signal) {
  const rel = version.mavenToPath(coord);
  const dest = path.join(installer.librariesDir(cfg.gameDir), rel);
  if (!fs.existsSync(dest)) {
    await download(artifactUrls(cfg, rel), dest, {
      signal,
      onBytes: (n) => progress.addBytes(n)
    });
  }
  return dest;
}

/** 坐标对应的本地路径（不下载，可能由安装处理器生成） */
function coordPath(cfg, coord) {
  return path.join(installer.librariesDir(cfg.gameDir), version.mavenToPath(coord));
}

async function ensureProfileLibraries(cfg, libraries, progress, signal, phaseName) {
  const libsDir = installer.librariesDir(cfg.gameDir);
  const tasks = [];
  for (const lib of libraries || []) {
    if (lib.rules && !version.rulesAllow(lib.rules)) continue;
    const name = lib.name;
    if (!name) continue;
    const dl = (lib.downloads && lib.downloads.artifact) || null;
    const rel = (dl && dl.path) || version.mavenToPath(name);
    const dest = path.join(libsDir, rel);
    if (fs.existsSync(dest)) continue;
    let urls;
    if (dl && dl.url) urls = source.mavenUrls(cfg, rel, dl.url);
    else if (lib.url) urls = source.mavenUrls(cfg, rel, lib.url.endsWith('/') ? lib.url + rel : `${lib.url}/${rel}`);
    else urls = artifactUrls(cfg, rel);
    tasks.push({ urls, dest, sha1: dl && dl.sha1, size: dl && dl.size });
  }
  if (!tasks.length) return;
  progress.startPhase(phaseName, tasks.length, tasks.reduce((s, t) => s + (t.size || 0), 0));
  await runPool(
    tasks,
    Math.max(1, Math.min(32, cfg.downloadThreads || 16)),
    async (task) => {
      await download(task.urls, task.dest, {
        size: task.size,
        sha1: task.sha1,
        signal,
        onBytes: (n) => progress.addBytes(n)
      });
      progress.completeTask();
    },
    signal
  );
}

function substituteVars(text, vars) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (m, key) => (vars[key] !== undefined ? vars[key] : m));
}

function isQuoted(text) {
  return typeof text === 'string' && text.length >= 2 && text.startsWith("'") && text.endsWith("'");
}

function isCoord(text) {
  return typeof text === 'string' && text.startsWith('[') && text.endsWith(']');
}

async function runProcessors({ cfg, profile, zip, installerJar, mcVersion, tmpRoot, javaInfo, progress, signal, onLog }) {
  const vars = {
    SIDE: 'client',
    MINECRAFT_JAR: path.join(version.versionDir(cfg.gameDir, mcVersion), `${mcVersion}.jar`),
    MINECRAFT_VERSION: mcVersion,
    MINECRAFT_VERSION_JSON: path.join(version.versionDir(cfg.gameDir, mcVersion), `${mcVersion}.json`),
    // ROOT 必须是游戏目录：安装处理器会自行写入 {ROOT}/libraries 与 {ROOT}/...
    ROOT: cfg.gameDir,
    INSTALLER: installerJar,
    LIBRARY_DIR: installer.librariesDir(cfg.gameDir)
  };

  const dataVars = {};
  for (const [key, value] of Object.entries(profile.data || {})) {
    const raw = typeof value === 'string' ? value : (value && (value.client || value.server)) || '';
    if (raw) dataVars[key] = raw;
  }

  for (let round = 0; round < 3; round++) {
    for (const key of Object.keys(dataVars)) {
      let raw = dataVars[key];
      if (/^\[[^\]]+\]$/.test(raw)) {
        // 坐标可能指向稍后由处理器生成的产物，这里只解析路径
        dataVars[key] = coordPath(cfg, raw.slice(1, -1));
        continue;
      }
      if (isQuoted(raw)) {
        dataVars[key] = raw.slice(1, -1);
        continue;
      }
      if (raw.startsWith('/')) {
        const zipPath = raw.slice(1);
        const entry = zip.getEntry(zipPath);
        if (entry && !entry.isDirectory) {
          const dest = path.join(tmpRoot, zipPath);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          if (!fs.existsSync(dest)) fs.writeFileSync(dest, entry.getData());
          dataVars[key] = dest;
          continue;
        }
      }
      dataVars[key] = substituteVars(raw, { ...vars, ...dataVars });
    }
  }
  Object.assign(vars, dataVars);

  const processors = (profile.processors || []).filter((p) => !p.sides || p.sides.includes('client'));
  progress.startPhase('运行安装处理器', processors.length);

  for (const processor of processors) {
    const classpath = [];
    for (const coord of processor.classpath || []) {
      classpath.push(await ensureCoord(cfg, coord, progress, signal));
    }
    const jarPath = await ensureCoord(cfg, processor.jar, progress, signal);
    classpath.push(jarPath);
    const mainClass = readMainClass(jarPath);
    if (!mainClass) throw new Error(`无法读取处理器主类：${processor.jar}`);

    const args = [];
    for (const raw of processor.args || []) {
      let value = substituteVars(raw, vars);
      if (/^\[[^\]]+\]$/.test(value)) value = coordPath(cfg, value.slice(1, -1));
      args.push(value);
    }

    if (onLog) onLog(`[Forge] 执行处理器 ${processor.jar}`);
    await runProcess(javaInfo.path, ['-cp', classpath.join(';'), mainClass, ...args], cfg.gameDir, {
      signal,
      onLog,
      name: processor.jar
    });

    for (const [srcTemplate, coord] of Object.entries(processor.outputs || {})) {
      const src = substituteVars(srcTemplate, vars);
      if (!src || !fs.existsSync(src)) continue;
      const coordText = String(coord).replace(/^\[|\]$/g, '');
      const dest = path.join(installer.librariesDir(cfg.gameDir), version.mavenToPath(coordText));
      if (path.resolve(src) === path.resolve(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    progress.completeTask();
  }
}

function readVersionJsonFromZip(zip, profile) {
  const candidates = [profile && profile.json, 'version.json', 'optifine/version.json'].filter(Boolean);
  for (const name of candidates) {
    const entry = zip.getEntry(String(name).replace(/^\//, ''));
    if (entry) {
      try {
        return JSON.parse(zip.readAsText(entry));
      } catch (e) {}
    }
  }
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const n = entry.entryName.replace(/\\/g, '/');
    if (/\.json$/i.test(n) && n.toLowerCase().includes('version') && !n.startsWith('maven/')) {
      try {
        const data = JSON.parse(zip.readAsText(entry));
        if (data && data.mainClass) return data;
      } catch (e) {}
    }
  }
  return null;
}

async function installForgeModern({ cfg, profile, zip, installerJar, mcVersion, progress, signal, onLog }) {
  const targetId = profile.version;
  const tmpRoot = path.join(os.tmpdir(), `kmcl-forge-data-${Date.now()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    progress.startPhase('解压安装文件', 1);
    extractEmbeddedMaven(zip, installer.librariesDir(cfg.gameDir));

    const versionJson = readVersionJsonFromZip(zip, profile);
    if (!versionJson) throw new Error('安装器中缺少 version.json');
    versionJson.id = targetId;
    if (!versionJson.inheritsFrom) versionJson.inheritsFrom = profile.minecraft || mcVersion;
    version.writeInstalledVersion(cfg.gameDir, targetId, versionJson);
    progress.completeTask();

    await ensureProfileLibraries(cfg, profile.libraries, progress, signal, '下载 Forge 依赖库');
    // 1.13-1.16 的安装器同样带处理器，必须执行才能生成 client 端补丁后的 forge 包
    if ((profile.processors || []).length) {
      const javaInfo = await pickInstallJava(cfg, profile.minecraft || mcVersion);
      await runProcessors({ cfg, profile, zip, installerJar, mcVersion, tmpRoot, javaInfo, progress, signal, onLog });
    }
    return targetId;
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (e) {}
  }
}

async function installForgeLegacy({ cfg, profile, zip, mcVersion, progress, signal }) {
  const info = profile.versionInfo;
  if (!info) throw new Error('安装器中缺少版本信息');
  const targetId = info.id || profile.version;
  info.id = targetId;
  if (!info.inheritsFrom) info.inheritsFrom = mcVersion;

  progress.startPhase('解压安装文件', 1);
  const install = profile.install || {};
  // 旧版安装器的 install 有两种写法：path 为 maven 坐标 + filePath 为文件名，或 path 为包内文件名 + filePath 为 maven 相对路径
  if (install.path && install.filePath) {
    const libsDir = installer.librariesDir(cfg.gameDir);
    const asMavenPath = String(install.filePath).includes('/');
    const entryName = String(asMavenPath ? install.path : install.filePath).replace(/^\//, '');
    const dest = asMavenPath
      ? path.join(libsDir, String(install.filePath).replace(/^\//, ''))
      : path.join(path.dirname(path.join(libsDir, version.mavenToPath(install.path))), install.filePath);
    const entry = zip.getEntry(entryName);
    if (entry && !entry.isDirectory) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
      // 旧版 maven 只发布 -universal 包，而版本 json 引用的是不带 classifier 的坐标：补一份同名 jar
      const parts = String(install.path).split(':');
      if (!asMavenPath && parts.length === 3) {
        const plain = path.join(libsDir, version.mavenToPath(install.path));
        if (!fs.existsSync(plain)) fs.copyFileSync(dest, plain);
      }
    }
  }
  extractEmbeddedMaven(zip, installer.librariesDir(cfg.gameDir));
  version.writeInstalledVersion(cfg.gameDir, targetId, info);
  progress.completeTask();

  await ensureProfileLibraries(cfg, info.libraries, progress, signal, '下载 Forge 依赖库');
  return targetId;
}

/**
 * 把原版 jar 复制到加载器版本目录并命名为 <版本 id>.jar。
 * Forge 的 -DignoreList 会按 `${version_name}.jar` 排除这个副本，避免与原版模块冲突。
 */
function copyBaseJarFor(cfg, mcVersion, versionId) {
  const src = path.join(version.versionDir(cfg.gameDir, mcVersion), `${mcVersion}.jar`);
  const dest = path.join(version.versionDir(cfg.gameDir, versionId), `${versionId}.jar`);
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } catch (e) {
    // 复制失败时启动器会回退到原版 jar
  }
}

/**
 * 下载安装器并校验内容。
 * 镜像节点偶发返回截断内容，仅凭文件大小无法发现，因此拿 zip 结构做校验并重下。
 */
async function downloadInstallerZip(urls, dest, { signal, onBytes, label = '加载器' } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await downloadFast(urls, dest, {
        signal,
        onBytes,
        lanes: 3,
        retries: 4,
        timeout: 30000,
        firstByteTimeout: 8000,
        minRate: 12 * 1024
      });
      const zip = new AdmZip(dest);
      if (!zip.getEntry('install_profile.json')) throw new Error('安装器缺少 install_profile.json');
      return zip;
    } catch (e) {
      if (e.cancelled || (signal && signal.aborted)) throw e;
      lastErr = e;
      try {
        fs.rmSync(dest, { force: true });
      } catch (err) {}
    }
  }
  throw new Error(`${label} 安装器下载失败：` + (lastErr ? lastErr.message : '未知错误'));
}

function downloadForgeInstaller(cfg, fullVersion, dest, opts = {}) {
  return downloadInstallerZip(source.forgeInstallerUrls(cfg, fullVersion), dest, { ...opts, label: 'Forge' });
}

async function installForge(cfg, mcVersion, forgeVersion, { progress, signal, onLog, baseFresh } = {}) {
  const full = forgeFullVersion(mcVersion, forgeVersion);
  await ensureBaseInstalled(cfg, mcVersion, progress, signal);

  const tmpDir = path.join(os.tmpdir(), `kmcl-forge-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const installerJar = path.join(tmpDir, `forge-${full}-installer.jar`);
  try {
    progress.startPhase('下载 Forge 安装器', 1);
    const zip = await downloadForgeInstaller(cfg, full, installerJar, {
      signal,
      onBytes: (n) => progress.addBytes(n)
    });
    progress.completeTask();

    const profile = JSON.parse(zip.readAsText('install_profile.json'));

    const versionId = profile.versionInfo
      ? await installForgeLegacy({ cfg, profile, zip, mcVersion, progress, signal })
      : await installForgeModern({
          cfg,
          profile,
          zip,
          installerJar,
          mcVersion,
          progress,
          signal,
          onLog
        });

    if (baseFresh) {
      // 原版刚由本次任务完整安装过，这里只需补齐依赖库，避免重复校验数千个资源文件
      const resolved = version.resolveFullVersion(cfg.gameDir, versionId);
      await installer.installLibrariesOnly(cfg, resolved.json, {
        progress,
        signal,
        phaseName: '校验安装结果'
      });
    } else {
      // 单独安装 Forge 时原版可能不完整，走完整安装以保证核心与资源齐全
      await installer.installVersion(cfg, versionId, { progress, signal });
    }
    copyBaseJarFor(cfg, mcVersion, versionId);
    fs.mkdirSync(instance.modsDirOf(cfg, versionId), { recursive: true });
    return { versionId };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

/* ----------------------------- Fabric ----------------------------- */

const fabricCache = new Map();
const neoforgeCache = { at: 0, items: null };

function compareLoaderVersion(a, b) {
  return compareNumeric(b, a);
}

/** 某游戏版本可用的 Fabric Loader 列表（BMCLAPI /fabric-meta 优先） */
async function listFabric(cfg, mcVersion) {
  const cached = fabricCache.get(mcVersion);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.items;
  const data = await fetchJson(source.fabricLoaderListUrls(cfg, mcVersion), {
    timeout: 30000,
    retries: 2,
    race: true
  });
  if (!Array.isArray(data)) throw new Error('Fabric 版本列表格式异常');
  const items = data
    .map((d) => {
      const loader = (d && d.loader) || {};
      return {
        mc: mcVersion,
        version: String(loader.version || ''),
        stable: loader.stable !== false
      };
    })
    .filter((v) => v.version);
  items.sort((a, b) => (a.stable === b.stable ? compareLoaderVersion(a.version, b.version) : a.stable ? -1 : 1));
  fabricCache.set(mcVersion, { at: Date.now(), items });
  return items;
}

async function installFabric(cfg, mcVersion, loaderVersion, { progress, signal, onLog } = {}) {
  await ensureBaseInstalled(cfg, mcVersion, progress, signal);

  progress.startPhase('获取 Fabric 版本信息', 1);
  const profile = await fetchJson(source.fabricProfileUrls(cfg, mcVersion, loaderVersion), {
    timeout: 30000,
    retries: 2,
    race: true
  });
  if (!profile || !profile.mainClass) throw new Error('Fabric 返回的版本信息无效');
  profile.id = profile.id || `fabric-loader-${loaderVersion}-${mcVersion}`;
  profile.inheritsFrom = profile.inheritsFrom || mcVersion;
  version.writeInstalledVersion(cfg.gameDir, profile.id, profile);
  progress.completeTask();

  await ensureProfileLibraries(cfg, profile.libraries, progress, signal, '下载 Fabric 依赖库');

  // Fabric 版本只补充原版缺失的依赖库，核心 jar 与资源沿用原版目录
  const resolved = version.resolveFullVersion(cfg.gameDir, profile.id);
  await installer.installLibrariesOnly(cfg, resolved.json, {
    progress,
    signal,
    phaseName: '校验 Fabric 依赖'
  });

  fs.mkdirSync(instance.modsDirOf(cfg, profile.id), { recursive: true });
  if (onLog) onLog(`[Fabric] 已安装 ${profile.id}`);
  return { versionId: profile.id };
}

/* ---------------------------- NeoForge ---------------------------- */

function parseNeoForgeVersions(xml, group) {
  const items = [];
  for (const m of String(xml || '').matchAll(/<version>([^<]+)<\/version>/g)) {
    const raw = m[1].trim();
    if (!raw || /-(beta|alpha|pre)/i.test(raw)) continue;
    if (group === 'forge') {
      const idx = raw.indexOf('-');
      if (idx <= 0) continue;
      const mc = raw.slice(0, idx);
      const loader = raw.slice(idx + 1);
      if (/^1\.20\.1/.test(mc) && /^\d+\.\d+/.test(loader)) {
        items.push({ mc, version: loader, group });
      }
    } else if (/^\d+\.\d+\.\d+$/.test(raw)) {
      const [major, minor] = raw.split('.');
      items.push({ mc: `1.${major}.${minor}`, version: raw, group });
    }
  }
  return items;
}

/** NeoForge 版本列表：1.20.1 在 net.neoforged:forge，其余在 net.neoforged:neoforge */
async function listNeoForge(cfg) {
  if (neoforgeCache.items && Date.now() - neoforgeCache.at < 30 * 60 * 1000) return neoforgeCache.items;
  const groups = ['forge', 'neoforge'];
  const results = await Promise.allSettled(
    groups.map((g) =>
      fetchText(source.neoForgeMetadataUrls(cfg, g), { timeout: 45000, retries: 3, race: true })
    )
  );
  const items = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) items.push(...parseNeoForgeVersions(r.value, groups[i]));
  });
  if (!items.length) throw new Error('无法获取 NeoForge 版本列表，请检查网络或更换镜像源');
  items.sort((a, b) => (a.mc === b.mc ? compareLoaderVersion(a.version, b.version) : b.mc.localeCompare(a.mc, 'en', { numeric: true })));
  neoforgeCache.at = Date.now();
  neoforgeCache.items = items;
  return items;
}

async function installNeoForge(cfg, mcVersion, loaderVersion, { progress, signal, onLog } = {}) {
  await ensureBaseInstalled(cfg, mcVersion, progress, signal);

  const tmpDir = path.join(os.tmpdir(), `kmcl-neoforge-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const installerJar = path.join(tmpDir, `neoforge-${loaderVersion}-installer.jar`);
  try {
    progress.startPhase('下载 NeoForge 安装器', 1);
    const zip = await downloadInstallerZip(source.neoForgeInstallerUrls(cfg, mcVersion, loaderVersion), installerJar, {
      signal,
      onBytes: (n) => progress.addBytes(n),
      label: 'NeoForge'
    });
    progress.completeTask();

    const profile = JSON.parse(zip.readAsText('install_profile.json'));
    const versionId = await installForgeModern({
      cfg,
      profile,
      zip,
      installerJar,
      mcVersion,
      progress,
      signal,
      onLog
    });

    const resolved = version.resolveFullVersion(cfg.gameDir, versionId);
    await installer.installLibrariesOnly(cfg, resolved.json, {
      progress,
      signal,
      phaseName: '校验 NeoForge 依赖'
    });

    fs.mkdirSync(instance.modsDirOf(cfg, versionId), { recursive: true });
    if (onLog) onLog(`[NeoForge] 已安装 ${versionId}`);
    return { versionId };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

/* ----------------------------- OptiFine ----------------------------- */

const optifineCache = new Map();

function normalizeEdition(filename) {
  let name = String(filename || '').replace(/\.jar$/i, '');
  name = name.replace(/^preview_/i, '').replace(/^OptiFine_/i, '');
  return name;
}

function parseOptifineItem(mcDefault, raw) {
  const filename = raw.filename || `OptiFine_${raw.mcversion || mcDefault}_${raw.type}_${raw.patch}.jar`;
  const mc = raw.mcversion || mcDefault;
  let edition = raw.edition;
  if (!edition) {
    if (raw.type && raw.patch) edition = `${raw.type}_${raw.patch}`;
    else edition = normalizeEdition(filename).slice(String(mc).length + 1);
  }
  return {
    mc,
    edition,
    label: edition,
    filename,
    type: raw.type || '',
    patch: raw.patch || '',
    preview: /^preview_/i.test(filename)
  };
}

async function readOptiFineHtmlList() {
  const html = await fetchText(['https://optifine.net/downloads'], { retries: 1 });
  const list = [];
  for (const m of html.matchAll(/adloadx\?f=((?:preview_)?OptiFine_([\w.]+?)_([A-Za-z0-9_]+)\.jar)/g)) {
    const filename = m[1];
    const mc = m[2];
    const edition = m[3];
    if (list.some((v) => v.mc === mc && v.edition === edition)) continue;
    list.push({
      mc,
      edition,
      label: edition,
      filename,
      type: edition.split('_').slice(0, -1).join('_'),
      patch: edition.split('_').slice(-1)[0],
      preview: /^preview_/i.test(filename)
    });
  }
  return list;
}

/**
 * 获取某游戏版本可用的 OptiFine 列表。
 * 优先使用 BMCLAPI 的 /optifine/:mc 接口，失败时回退官网页面。
 */
async function listOptiFine(cfg, mcVersion) {
  const cached = optifineCache.get(mcVersion);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.items;

  let items = [];
  try {
    const urls = source.optifineListUrls(cfg, mcVersion);
    if (urls.length) {
      const data = await fetchJson(urls, { timeout: 25000 });
      if (Array.isArray(data)) {
        items = data.map((raw) => parseOptifineItem(mcVersion, raw));
      }
    }
  } catch (e) {
    items = [];
  }

  if (!items.length) {
    try {
      const all = await readOptiFineHtmlList();
      items = all.filter((v) => v.mc === mcVersion);
    } catch (e) {
      throw new Error('无法获取 OptiFine 列表：' + e.message);
    }
  }

  items = items.filter((v) => v.mc === mcVersion && v.edition);
  // 正式版排前面，同类内部按版本号从新到旧（HD_U_I6 比 HD_U_I5 新，pre9 比 pre4 新）
  items.sort((a, b) => {
    if (a.preview !== b.preview) return a.preview ? 1 : -1;
    return String(b.edition).localeCompare(String(a.edition), 'en', { numeric: true });
  });
  optifineCache.set(mcVersion, { at: Date.now(), items });
  return items;
}

function findOptifineItem(items, edition) {
  return items.find((v) => v.edition === edition) || null;
}

async function downloadOptifineJar(cfg, item, dest, { signal, onBytes } = {}) {
  const mirrorUrls = item.type && item.patch ? source.optifineDownloadUrls(cfg, item.mc, item.type, item.patch) : [];
  let lastErr = null;
  if (mirrorUrls.length) {
    try {
      // BMCLAPI 的下载节点按请求随机分配，个别节点极慢或中断，多通道并发取最快的
      await downloadFast(mirrorUrls, dest, {
        signal,
        onBytes,
        lanes: 4,
        retries: 5,
        timeout: 25000,
        firstByteTimeout: 6000,
        minRate: 12 * 1024
      });
      return;
    } catch (e) {
      if (e.cancelled || (signal && signal.aborted)) throw e;
      lastErr = e;
    }
  }

  // 镜像节点偶尔不可用，回退官网：先取下载页里的 downloadx 直链
  if (item.filename) {
    const adUrl = `https://optifine.net/adloadx?f=${encodeURIComponent(item.filename)}`;
    try {
      const page = await fetchText([adUrl], { retries: 1, timeout: 40000 });
      const m = page.match(/downloadx\?f=[^"'<>\s]+/i);
      if (m) {
        const url = new URL(m[0].replace(/&amp;/g, '&'), 'https://optifine.net/').toString();
        await download([url], dest, {
          signal,
          onBytes,
          retries: 1,
          timeout: 60000,
          firstByteTimeout: 15000,
          headers: { Referer: adUrl }
        });
        return;
      }
    } catch (e) {
      if (e.cancelled || (signal && signal.aborted)) throw e;
      lastErr = e;
    }
  }
  throw new Error('OptiFine 安装包下载失败：' + (lastErr ? lastErr.message : '没有可用的下载地址'));
}

/**
 * 下载并校验 OptiFine 安装包：节点可能返回截断文件，校验失败时整体重下一次。
 */
async function downloadOptifineJarValidated(cfg, item, jarPath, { signal, onBytes, attempts = 2 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await downloadOptifineJar(cfg, item, jarPath, { signal, onBytes });
      const zip = new AdmZip(jarPath);
      const entries = zip.getEntries();
      if (!entries.length || !entries.some((e) => /\.class$/i.test(e.entryName))) {
        throw new Error('下载到的 OptiFine 安装包无效');
      }
      return zip;
    } catch (e) {
      if (e.cancelled || (signal && signal.aborted)) throw e;
      lastErr = e;
      try {
        fs.rmSync(jarPath, { force: true });
      } catch (err) {}
    }
  }
  throw new Error(`${lastErr ? lastErr.message : '下载失败'}，请检查网络或更换镜像源后重试`);
}

/**
 * 按 OptiFine 安装器的方式手动安装（无需运行图形安装器）。
 */
async function installOptiFine(cfg, mcVersion, edition, { progress, signal, onLog } = {}) {
  await ensureBaseInstalled(cfg, mcVersion, progress, signal);
  const items = await listOptiFine(cfg, mcVersion);
  const item = findOptifineItem(items, edition);
  if (!item) throw new Error(`找不到 OptiFine 版本 ${edition}`);

  const targetId = `${mcVersion}-OptiFine_${item.edition}`;
  const tmpDir = path.join(os.tmpdir(), `kmcl-optifine-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const jarPath = path.join(tmpDir, item.filename || `OptiFine_${mcVersion}_${item.edition}.jar`);
  const libsDir = installer.librariesDir(cfg.gameDir);
  const editionsDir = item.edition;

  try {
    progress.startPhase('下载 OptiFine 安装包', 1);
    const zip = await downloadOptifineJarValidated(cfg, item, jarPath, {
      signal,
      onBytes: (n) => progress.addBytes(n)
    });
    progress.completeTask();

    progress.startPhase('安装 OptiFine 文件', 3);

    // 1) OptiFine 本体
    const ofDir = path.join(libsDir, 'optifine', 'OptiFine', `${mcVersion}_${editionsDir}`);
    const ofDest = path.join(ofDir, `OptiFine-${mcVersion}_${editionsDir}.jar`);
    fs.mkdirSync(ofDir, { recursive: true });
    fs.copyFileSync(jarPath, ofDest);
    const libraries = [{ name: `optifine:OptiFine:${mcVersion}_${editionsDir}` }];
    progress.completeTask();

    // 2) launchwrapper
    const lwEntry = zip
      .getEntries()
      .find((e) => /^launchwrapper-of-[^/]+\.jar$/i.test(e.entryName.replace(/\\/g, '/')));
    if (lwEntry) {
      const lwName = path.posix.basename(lwEntry.entryName.replace(/\\/g, '/'));
      const lwVer = lwName.replace(/^launchwrapper-of-|\.jar$/gi, '');
      const lwDest = path.join(libsDir, 'optifine', 'launchwrapper-of', lwVer, lwName);
      fs.mkdirSync(path.dirname(lwDest), { recursive: true });
      fs.writeFileSync(lwDest, lwEntry.getData());
      libraries.push({ name: `optifine:launchwrapper-of:${lwVer}` });
    } else if (onLog) {
      onLog('[OptiFine] 警告：安装包中未找到 launchwrapper，可能无法启动');
    }
    progress.completeTask();

    // 3) 版本目录：复制原版 jar 并写入 json
    const baseDir = version.versionDir(cfg.gameDir, mcVersion);
    const targetDir = version.versionDir(cfg.gameDir, targetId);
    fs.mkdirSync(targetDir, { recursive: true });
    const srcJar = path.join(baseDir, `${mcVersion}.jar`);
    const destJar = path.join(targetDir, `${targetId}.jar`);
    if (fs.existsSync(srcJar)) fs.copyFileSync(srcJar, destJar);

    const baseJson = version.readInstalledVersion(cfg.gameDir, mcVersion) || {};
    const json = {
      id: targetId,
      inheritsFrom: mcVersion,
      type: baseJson.type || 'release',
      time: new Date().toISOString(),
      releaseTime: new Date().toISOString(),
      mainClass: 'net.minecraft.launchwrapper.Launch',
      libraries,
      assetIndex: baseJson.assetIndex ? baseJson.assetIndex.id : undefined,
      assets: baseJson.assets
    };
    if (baseJson.minecraftArguments) {
      json.minecraftArguments = `${baseJson.minecraftArguments} --tweakClass optifine.OptiFineTweaker`;
    } else {
      json.arguments = { game: ['--tweakClass', 'optifine.OptiFineTweaker'] };
    }
    if (!json.assetIndex) delete json.assetIndex;
    if (!json.assets) delete json.assets;
    version.writeInstalledVersion(cfg.gameDir, targetId, json);
    progress.completeTask();

    // 补齐缺失的依赖文件（例如原版库）
    progress.startPhase('校验安装结果', 1);
    await installer.installVersion(cfg, targetId, { progress, signal });
    progress.completeTask();

    fs.mkdirSync(instance.modsDirOf(cfg, targetId), { recursive: true });
    return { versionId: targetId };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

/**
 * 以 Mod 形式安装 OptiFine（配合 Forge 使用），安装包本身即可作为 mod 放入 mods。
 */
async function installOptiFineAsMod(cfg, mcVersion, edition, { progress, signal, onLog, versionId } = {}) {
  await ensureBaseInstalled(cfg, mcVersion, progress, signal);
  const items = await listOptiFine(cfg, mcVersion);
  const item = findOptifineItem(items, edition);
  if (!item) throw new Error(`找不到 OptiFine 版本 ${edition}`);

  const tmpDir = path.join(os.tmpdir(), `kmcl-optifine-mod-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const jarPath = path.join(tmpDir, item.filename || `OptiFine_${mcVersion}_${edition}.jar`);

  try {
    progress.startPhase('下载 OptiFine 安装包', 1);
    await downloadOptifineJarValidated(cfg, item, jarPath, {
      signal,
      onBytes: (n) => progress.addBytes(n)
    });
    progress.completeTask();

    progress.startPhase('写入 mods 目录', 1);
    const modsDir = versionId ? instance.modsDirOf(cfg, versionId) : path.join(cfg.gameDir, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    const prefix = `OptiFine_${mcVersion}_`;
    for (const file of fs.readdirSync(modsDir)) {
      if (file.startsWith(prefix) && /\.jar(\.disabled)?$/i.test(file)) {
        try {
          fs.rmSync(path.join(modsDir, file), { force: true });
        } catch (e) {}
      }
    }
    const dest = path.join(modsDir, `OptiFine_${mcVersion}_${item.edition}.jar`);
    fs.copyFileSync(jarPath, dest);
    progress.completeTask();
    if (onLog) onLog(`[OptiFine] 已放入 mods：${path.basename(dest)}`);
    return { modPath: dest };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

module.exports = {
  listForge,
  installForge,
  listFabric,
  installFabric,
  listNeoForge,
  installNeoForge,
  listOptiFine,
  installOptiFine,
  installOptiFineAsMod
};
