const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const modsource = require('./modsource');
const loaders = require('./loaders');
const instance = require('./instance');
const version = require('./version');
const installer = require('./installer');
const { getManifest, findEntry } = require('./manifest');
const { runPool } = require('./progress');

function sanitizeId(name) {
  return (
    String(name || 'modpack')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'modpack'
  );
}

async function ensureBase(cfg, mcVersion, progress, signal) {
  if (version.readInstalledVersion(cfg.gameDir, mcVersion) &&
      fs.existsSync(path.join(version.versionDir(cfg.gameDir, mcVersion), `${mcVersion}.jar`))) {
    return;
  }
  const manifest = await getManifest(cfg);
  const entry = findEntry(manifest, mcVersion);
  if (!entry) throw new Error(`找不到游戏版本 ${mcVersion}，请先安装原版`);
  await installer.installVersion(cfg, mcVersion, { entry, progress, signal });
}

/**
 * 加载器版本号可能带前缀，安装器只接受纯版本号：
 * - forge-47.2.0 / fabric-0.15.11 / neoforge-21.1.66
 * - forge-1.12.2-14.23.5.2859（旧版把游戏版本写在版本号前面）
 * - forge-1.7.10-10.13.4.1614-1.7.10（更早的版本号尾部还带一次游戏版本）
 */
function stripLoaderPrefix(type, version, mc) {
  let v = String(version || '').trim();
  const lower = v.toLowerCase();
  if (lower.startsWith(`${type}-`)) v = v.slice(type.length + 1);
  if (mc && v.startsWith(`${mc}-`)) v = v.slice(mc.length + 1);
  return v;
}

function loaderDisplayName(type) {
  return type === 'forge'
    ? 'Forge'
    : type === 'neoforge'
      ? 'NeoForge'
      : type === 'fabric'
        ? 'Fabric'
        : type === 'quilt'
          ? 'Quilt'
          : type;
}

/** 已安装的加载器版本是否完整可用（避免沿用上次失败的半成品） */
function loaderInstalled(cfg, versionId, type) {
  if (!versionId) return false;
  const dir = version.versionDir(cfg.gameDir, versionId);
  if (!fs.existsSync(path.join(dir, `${versionId}.json`))) return false;
  // Forge / NeoForge 的安装产物包含补丁 jar；Fabric 只有版本 json + 依赖库
  if (type === 'fabric' || type === 'quilt') return true;
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.jar'));
  } catch (e) {
    return false;
  }
}

/** NeoForge 在不同时期的版本目录命名不一致，逐个尝试 */
function findNeoForgeId(cfg, mc, loaderVersion) {
  const candidates = [
    `neoforge-${loaderVersion}`,
    `neoforge-${mc}-${loaderVersion}`,
    `${mc}-neoforge-${loaderVersion}`,
    // NeoForge 1.20.1 沿用 Forge 的 maven 坐标，安装器生成的目录名也是 forge 形式
    `${mc}-forge-${loaderVersion}`
  ];
  return candidates.find((id) => loaderInstalled(cfg, id, 'neoforge')) || '';
}

async function ensureLoader(cfg, loader, progress, signal, onLog) {
  if (!loader || !loader.version) return loader && loader.baseId;
  const type = String(loader.type || '').toLowerCase();
  if (!loaderDisplayName(type) || !['forge', 'neoforge', 'fabric', 'quilt'].includes(type)) {
    throw new Error(`不支持的加载器：${loader.type || '未知'}`);
  }
  if (type === 'quilt') {
    throw new Error('该整合包需要 Quilt 加载器，当前启动器暂不支持，请手动安装后使用');
  }
  const mc = loader.mc || loader.baseMc;
  if (!mc) throw new Error('无法确定整合包的 Minecraft 版本');
  const version = stripLoaderPrefix(type, loader.version, mc);
  const expectedId =
    type === 'forge' ? `${mc}-forge-${version}` : type === 'neoforge' ? `neoforge-${version}` : `fabric-loader-${version}-${mc}`;
  if (loaderInstalled(cfg, expectedId, type)) return expectedId;
  if (type === 'neoforge') {
    const existing = findNeoForgeId(cfg, mc, version);
    if (existing) return existing;
  }

  if (onLog) onLog(`[整合包] 正在安装 ${loaderDisplayName(type)} ${version}（Minecraft ${mc}）`);
  try {
    if (type === 'forge') {
      // 原版已由 ensureBase 完整安装，Forge 只需补齐自身依赖，避免重复校验数千个资源文件
      const r = await loaders.installForge(cfg, mc, version, { progress, signal, onLog, baseFresh: true });
      return r.versionId;
    }
    if (type === 'neoforge') {
      const r = await loaders.installNeoForge(cfg, mc, version, { progress, signal, onLog });
      return r.versionId;
    }
    const r = await loaders.installFabric(cfg, mc, version, { progress, signal, onLog });
    return r.versionId;
  } catch (e) {
    if (onLog) onLog(`[整合包] ${loaderDisplayName(type)} 安装失败：${e.message}`);
    throw new Error(`${loaderDisplayName(type)} ${version} 安装失败：${e.message}`);
  }
}

function readZipJson(zip, name) {
  // 部分 Windows 压缩工具会把条目名写成反斜杠，这里统一归一化后再查找
  const want = String(name).replace(/\\/g, '/');
  const entry = zip
    .getEntries()
    .find((e) => !e.isDirectory && e.entryName.replace(/\\/g, '/') === want);
  if (!entry) return null;
  try {
    // 去掉 Windows 记事本 / PowerShell 写入时可能带的 BOM
    return JSON.parse(zip.readAsText(entry).replace(/^\uFEFF/, ''));
  } catch (e) {
    return null;
  }
}

/** 从版本 JSON 里识别游戏版本与加载器（HMCL / PCL / 官方布局都带这个文件） */
function parseVersionProfile(json) {
  const libs = (json.libraries || []).map((l) => String((l && l.name) || ''));
  const args = ((json.arguments && json.arguments.game) || []).map(String);
  const argValue = (key) => {
    const i = args.indexOf(key);
    return i >= 0 && args[i + 1] ? String(args[i + 1]) : '';
  };
  const rawId = String(json.id || '');
  const mc = String(json.inheritsFrom || (/^1\.\d/.test(rawId) ? rawId : ''));
  const find = (prefix) => libs.find((n) => n.startsWith(prefix)) || '';
  const libVersion = (name) => String(name).split(':')[2] || '';
  const neo = find('net.neoforged:neoforge:') || find('net.neoforged:forge:');
  const forge = find('net.minecraftforge:forge:') || find('net.minecraftforge:fmlloader:');
  const fabric = find('net.fabricmc:fabric-loader:');
  const quilt = find('org.quiltmc:quilt-loader:');
  let loader = null;
  if (neo) loader = { type: 'neoforge', version: argValue('--fml.neoForgeVersion') || libVersion(neo) };
  else if (forge) loader = { type: 'forge', version: argValue('--fml.forgeVersion') || libVersion(forge) };
  else if (fabric) loader = { type: 'fabric', version: libVersion(fabric) };
  else if (quilt) loader = { type: 'quilt', version: libVersion(quilt) };
  if (loader) loader.mc = mc;
  return { mc, loader };
}

/** MultiMC / Prism 的 mmc-pack.json */
function parseMmcPack(json) {
  const comps = Array.isArray(json.components) ? json.components : [];
  const pick = (uid) => {
    const hit = comps.find((c) => String(c && c.uid) === uid);
    return hit ? String(hit.version || '') : '';
  };
  const mc = pick('net.minecraft');
  const map = [
    ['net.minecraftforge', 'forge'],
    ['net.neoforged', 'neoforge'],
    ['net.fabricmc.fabric-loader', 'fabric'],
    ['org.quiltmc.quilt-loader', 'quilt']
  ];
  let loader = null;
  for (const [uid, type] of map) {
    const v = pick(uid);
    if (v) {
      loader = { type, version: v, mc };
      break;
    }
  }
  return { mc, loader };
}

/** 通用压缩包：从目录结构 / 版本 JSON 推断游戏版本与加载器 */
function detectGenericVersion(zip, files) {
  const mmc = readZipJson(zip, 'mmc-pack.json');
  if (mmc) {
    const info = parseMmcPack(mmc);
    if (info.mc) return info;
  }
  const versionJsonPath = files.find((f) => /(^|\/)versions\/[^/]+\/[^/]+\.json$/i.test(f));
  if (versionJsonPath) {
    const json = readZipJson(zip, versionJsonPath);
    if (json) {
      const info = parseVersionProfile(json);
      if (info.mc) return info;
    }
  }
  return { mc: '', loader: null };
}

/** 解析整合包结构 */
function inspectPack(zip, archivePath) {
  const mrp = readZipJson(zip, 'modrinth.index.json');
  if (mrp) {
    const deps = mrp.dependencies || {};
    // mrpack 的 key 与加载器名并不一致：fabric-loader / quilt-loader 都带后缀
    const loaderKeys = [
      ['forge', 'forge'],
      ['neoforge', 'neoforge'],
      ['fabric-loader', 'fabric'],
      ['quilt-loader', 'quilt']
    ];
    const found = loaderKeys.find(([key]) => deps[key]);
    return {
      kind: 'mrpack',
      name: mrp.name || path.basename(archivePath, path.extname(archivePath)),
      mc: deps.minecraft || '',
      loader: found ? { type: found[1], version: String(deps[found[0]]), mc: deps.minecraft } : null,
      files: (mrp.files || []).filter((f) => !(f.env && f.env.client === 'unsupported')),
      overrides: ['overrides/', 'client-overrides/']
    };
  }
  const manifest = readZipJson(zip, 'manifest.json');
  if (manifest && manifest.minecraft) {
    const primary = (manifest.minecraft.modLoaders || []).find((m) => m.primary) || (manifest.minecraft.modLoaders || [])[0];
    const raw = primary ? String(primary.id || '') : '';
    const idx = raw.indexOf('-');
    const type = idx > 0 ? raw.slice(0, idx) : '';
    const loadVer = idx > 0 ? raw.slice(idx + 1) : '';
    return {
      kind: 'curseforge',
      name: manifest.name || path.basename(archivePath, path.extname(archivePath)),
      mc: manifest.minecraft.version || '',
      loader: type ? { type, version: loadVer, mc: manifest.minecraft.version } : null,
      manifestFiles: (manifest.files || []).filter((f) => f.required !== false || f.required === undefined),
      optionalFiles: (manifest.files || []).filter((f) => f.required === false),
      overrides: [`${manifest.overrides || 'overrides'}/`]
    };
  }
  const genericInfo = detectGenericVersion(
    zip,
    zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName.replace(/\\/g, '/'))
  );
  return {
    kind: 'generic',
    name: path.basename(archivePath, path.extname(archivePath)),
    mc: genericInfo.mc,
    loader: genericInfo.loader,
    genericZip: zip
  };
}

async function fetchCurseForgeFile(projectID, fileID) {
  const { fetchJson } = require('./http');
  const data = await fetchJson(
    [`${modsource.MCIM}/curseforge/v1/mods/${projectID}/files/${fileID}`],
    { timeout: 20000 }
  );
  return data.data || null;
}

async function downloadFileTo(dest, urls, { size, sha1, signal, progress, onLog }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && size && fs.statSync(dest).size === size) {
    if (progress) progress.completeTask();
    return;
  }
  const list = [];
  for (const u of urls) {
    const mirrored = modsource.mirrorDownloadUrl(u);
    list.push(mirrored, u);
  }
  const clean = [...new Set(list.filter(Boolean))];
  let lastErr = null;
  for (const url of clean) {
    try {
      await modsource.downloadTo(url, dest, {
        size,
        sha1,
        signal,
        onBytes: (n) => progress && progress.addBytes(n)
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (signal && signal.aborted) throw e;
    }
  }
  if (lastErr) throw lastErr;
  if (progress) progress.completeTask();
  if (onLog) onLog(`[整合包] 已下载 ${path.basename(dest)}`);
}

/** 解析目标路径，阻止压缩包内的 ../ 路径穿越 */
function safeTarget(root, rel) {
  if (!rel) return null;
  const base = path.resolve(root);
  const dest = path.resolve(base, rel);
  if (dest !== base && !dest.startsWith(base + path.sep)) return null;
  return dest;
}

function extractOverrides(zip, prefixes, targetRoot) {
  let count = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    const prefix = prefixes.find((p) => name.startsWith(p));
    if (!prefix) continue;
    const dest = safeTarget(targetRoot, name.slice(prefix.length));
    if (!dest) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    count++;
  }
  return count;
}

/**
 * 通用整合包：定位压缩包内 .minecraft 所在的层级。
 * 兼容 PCL 导出（包名/.minecraft/mods）、HMCL 导出（.minecraft/mods）与裸 mods 布局。
 */
function detectZipRoot(names) {
  const counts = new Map();
  for (const name of names) {
    const segs = name.split('/');
    const idx = segs.findIndex((s) => s.toLowerCase() === 'mods');
    if (idx < 0) continue;
    const prefix = segs.slice(0, idx).join('/');
    const key = prefix ? `${prefix}/` : '';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!counts.size) return '';
  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const aMc = /\.minecraft\/$/.test(a[0]) ? 1 : 0;
    const bMc = /\.minecraft\/$/.test(b[0]) ? 1 : 0;
    if (bMc !== aMc) return bMc - aMc;
    return a[0].length - b[0].length;
  });
  return ranked[0][0];
}

/** 通用整合包：按识别到的根目录解压内容到实例目录 */
function extractGeneric(zip, targetRoot) {
  const names = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => e.entryName.replace(/\\/g, '/'));
  const prefix = detectZipRoot(names);
  let count = 0;
  let jarCount = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    if (prefix && !name.startsWith(prefix)) continue;
    const rel = prefix ? name.slice(prefix.length) : name;
    // 压缩包自带的版本描述不复制，避免在实例目录里再套一层 versions
    if (/^versions\//.test(rel)) continue;
    const dest = safeTarget(targetRoot, rel);
    if (!dest) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    count++;
    if (/^mods\/.+\.jar$/i.test(rel)) jarCount++;
  }
  return { count, jarCount };
}

function pickVersionId(cfg, packName, mc) {
  const base = sanitizeId(`${packName}-${mc}`);
  let id = base;
  let i = 2;
  while (true) {
    const dir = version.versionDir(cfg.gameDir, id);
    if (!fs.existsSync(dir)) return id;
    const state = instance.readState(cfg, id);
    if (state.modpack) return id; // 同一个整合包重复安装时覆盖原版本
    id = `${base}-${i++}`;
  }
}

/** 列出已安装的版本目录名 */
function listVersionIds(gameDir) {
  try {
    const dir = path.join(gameDir, 'versions');
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    return [];
  }
}

/**
 * 安装整合包时只保留「整合包本身 + 它依赖的原版与加载器」，
 * 本次安装过程中额外生成（重试遗留、临时加载器）的版本目录直接删除，不进版本列表。
 */
function cleanupExtraVersions(cfg, beforeIds, keepIds, onLog) {
  const removed = [];
  for (const id of listVersionIds(cfg.gameDir)) {
    if (beforeIds.has(id) || keepIds.has(id)) continue;
    try {
      fs.rmSync(version.versionDir(cfg.gameDir, id), { recursive: true, force: true });
      removed.push(id);
    } catch (e) {}
  }
  if (removed.length && onLog) onLog(`[整合包] 已清理多余版本：${removed.join('、')}`);
  return removed;
}

/** 读取压缩包内的 mod 数量（用于导入前提示） */
function countJars(zip) {
  let n = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    if (/mods\/[^/]+\.jar$/i.test(name)) n++;
  }
  return n;
}

/**
 * 导入前预检：只读取压缩包信息，不下载任何文件。
 * 供拖拽导入 / 文件选择后弹窗确认使用。
 */
function inspectLocalPack(archivePath) {
  const zip = new AdmZip(archivePath);
  const pack = inspectPack(zip, archivePath);
  return {
    path: archivePath,
    fileName: path.basename(archivePath),
    kind: pack.kind,
    name: pack.name,
    mc: pack.mc || '',
    loader: pack.loader ? { type: pack.loader.type, version: pack.loader.version } : null,
    modCount: countJars(zip)
  };
}

/** 数字分段比较加载器版本号 */
function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-+]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  const pb = String(b).split(/[.\-+]/).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (String(x) !== String(y)) {
      return String(x) > String(y) ? 1 : -1;
    }
  }
  return 0;
}

/** 未指定加载器版本时，取该游戏版本下最新的稳定版本 */
async function latestLoaderVersion(cfg, type, mc) {
  if (type === 'forge') {
    const list = (await loaders.listForge(cfg)).filter((v) => v.mc === mc);
    if (!list.length) throw new Error(`Forge 暂无 ${mc} 的版本`);
    return list.sort((a, b) => cmpVersion(a.loader, b.loader))[list.length - 1].loader;
  }
  if (type === 'fabric') {
    const list = await loaders.listFabric(cfg, mc);
    if (!list.length) throw new Error(`Fabric 暂无 ${mc} 的版本`);
    const stable = list.filter((v) => v.stable);
    const pool = stable.length ? stable : list;
    return pool.sort((a, b) => cmpVersion(a.version, b.version))[pool.length - 1].version;
  }
  if (type === 'neoforge') {
    const list = (await loaders.listNeoForge(cfg)).filter((v) => v.mc === mc);
    if (!list.length) throw new Error(`NeoForge 暂无 ${mc} 的版本`);
    return list.sort((a, b) => cmpVersion(a.version, b.version))[list.length - 1].version;
  }
  throw new Error(`不支持的加载器：${type}`);
}

/**
 * 安装整合包（远程下载或本地导入）
 */
async function installModpack(cfg, opts = {}) {
  const { progress, signal, onLog } = opts;
  const tmpDir = path.join(os.tmpdir(), `kmcl-pack-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  // 记录安装前已有的版本，用于之后清理本次额外产生的版本
  const beforeIds = new Set(listVersionIds(cfg.gameDir));
  let archivePath = opts.localPath || '';
  try {
    if (!archivePath) {
      const files = await modsource.listFiles(cfg, {
        source: opts.source,
        type: 'modpack',
        projectId: opts.projectId,
        // 指定了文件时不能再按当前版本过滤，否则可能找不到用户选中的文件
        mcVersion: opts.fileId ? '' : opts.mcVersion,
        loader: opts.fileId ? '' : opts.loader
      });
      const file = opts.fileId ? files.find((f) => String(f.id) === String(opts.fileId)) : files[0];
      if (!file) throw new Error('没有找到可下载的整合包文件');
      if (!file.url) throw new Error('该整合包文件未提供下载地址');
      archivePath = path.join(tmpDir, file.fileName || 'modpack.zip');
      progress.startPhase('下载整合包', 1, file.size || 0);
      await modsource.downloadTo(file.url, archivePath, {
        size: file.size,
        sha1: file.sha1,
        signal,
        onBytes: (n) => progress.addBytes(n)
      });
      progress.completeTask();
      opts.fileName = file.fileName;
      opts.fileId = file.id;
    }

    const zip = new AdmZip(archivePath);
    const pack = inspectPack(zip, archivePath);
    let mc = pack.mc || String(opts.mcVersion || '');
    if (!mc) throw new Error('无法确定整合包对应的 Minecraft 版本，请选择基础版本后重试');
    if (pack.loader && !pack.loader.mc) pack.loader.mc = mc;

    // 通用整合包没写加载器时，按用户在导入窗口里的选择自动取最新版本安装
    let loader = pack.loader;
    if (!loader && opts.loaderType) {
      progress.startPhase('获取加载器版本', 1);
      loader = { type: opts.loaderType, version: await latestLoaderVersion(cfg, opts.loaderType, mc), mc };
      progress.completeTask();
      if (onLog) onLog(`[整合包] 使用 ${loaderDisplayName(loader.type)} ${loader.version}`);
    }

    if (loader) {
      const t = String(loader.type || '').toLowerCase();
      if (!['forge', 'neoforge', 'fabric', 'quilt'].includes(t)) throw new Error(`不支持的加载器：${loader.type}`);
      if (t === 'quilt') throw new Error('该整合包需要 Quilt 加载器，当前启动器暂不支持');
    }

    await ensureBase(cfg, mc, progress, signal);
    const loaderId = await ensureLoader(cfg, loader, progress, signal, onLog);
    const packId = pickVersionId(cfg, pack.name, mc);
    const instanceDir = version.versionDir(cfg.gameDir, packId);
    fs.mkdirSync(instanceDir, { recursive: true });

    progress.startPhase('创建隔离版本', 1);
    version.writeInstalledVersion(cfg.gameDir, packId, {
      id: packId,
      inheritsFrom: loaderId || mc,
      type: 'release',
      kmcl: { modpack: { name: pack.name, mc, format: pack.kind } }
    });
    instance.writeState(cfg, packId, {
      isolated: true,
      modpack: {
        name: pack.name,
        mc,
        format: pack.kind,
        source: opts.source || (opts.localPath ? 'local' : ''),
        projectId: opts.projectId || '',
        fileId: opts.fileId || '',
        fileName: opts.fileName || path.basename(archivePath),
        installedAt: new Date().toISOString()
      }
    });
    const target = instance.ensureInstance(cfg, packId);
    progress.completeTask();

    // 确保基础库与资源齐全（新建的整合包版本只是 inheritsFrom）
    await installer.installVersion(cfg, packId, { progress, signal });

    if (pack.kind === 'mrpack') {
      const files = pack.files || [];
      const totalBytes = files.reduce((s, f) => s + (Number(f.fileSize) || 0), 0);
      progress.startPhase('下载整合包模组', files.length, totalBytes);
      await runPool(
        files,
        Math.max(1, Math.min(8, cfg.downloadThreads || 8)),
        async (f) => {
          const rel = String(f.path || '').replace(/\\/g, '/');
          if (!rel) return;
          const dest = path.join(target, rel);
          const urls = f.downloads || [];
          await downloadFileTo(dest, urls, {
            size: f.fileSize,
            sha1: (f.hashes && f.hashes.sha1) || '',
            signal,
            progress,
            onLog
          });
        },
        signal
      );
      progress.startPhase('解压覆盖文件', 1);
      const n = extractOverrides(zip, pack.overrides, target);
      progress.completeTask();
      if (onLog) onLog(`[整合包] 覆盖文件 ${n} 个`);
    } else if (pack.kind === 'curseforge') {
      const all = [...(pack.manifestFiles || []), ...(pack.optionalFiles || [])];
      progress.startPhase('解析整合包文件列表', Math.min(all.length, 200));
      const resolved = [];
      await runPool(
        all,
        Math.max(1, Math.min(6, cfg.downloadThreads || 6)),
        async (f) => {
          try {
            const file = await fetchCurseForgeFile(f.projectID, f.fileID);
            if (file && file.downloadUrl) {
              resolved.push({
                fileName: file.fileName,
                url: file.downloadUrl,
                size: file.fileLength || 0,
                hashes: file.hashes || [],
                required: f.required !== false
              });
            } else if (f.required !== false) {
              throw new Error(`缺少下载地址：${f.projectID}/${f.fileID}`);
            }
            progress.completeTask();
          } catch (e) {
            if (f.required !== false) throw e;
            progress.completeTask();
          }
        },
        signal
      );
      const totalBytes = resolved.reduce((s, f) => s + (f.size || 0), 0);
      progress.startPhase('下载整合包模组', resolved.length, totalBytes);
      await runPool(
        resolved,
        Math.max(1, Math.min(8, cfg.downloadThreads || 8)),
        async (f) => {
          const dest = path.join(target, 'mods', path.basename(f.fileName || `mod-${Date.now()}.jar`));
          const sha1 = ((f.hashes || []).find((h) => h.algo === 1) || {}).value || '';
          await downloadFileTo(dest, [f.url], { size: f.size, sha1, signal, progress, onLog });
        },
        signal
      );
      progress.startPhase('解压覆盖文件', 1);
      const n = extractOverrides(zip, pack.overrides, target);
      progress.completeTask();
      if (onLog) onLog(`[整合包] 覆盖文件 ${n} 个`);
    } else {
      progress.startPhase('解压整合包', 1);
      const res = extractGeneric(zip, target);
      if (!res.jarCount) throw new Error('压缩包中未找到 mods 目录，无法作为整合包导入');
      progress.completeTask();
      if (onLog) onLog(`[整合包] 已解压 ${res.count} 个文件（其中 ${res.jarCount} 个 mod）`);
    }

    if (onLog) onLog(`[整合包] ${pack.name} 安装完成，版本 ID：${packId}`);
    instance.ensureGameOptions(target);
    // 只留下整合包本身与它依赖的原版 / 加载器
    cleanupExtraVersions(cfg, beforeIds, new Set([packId, loaderId, mc]), onLog);
    return { versionId: packId, name: pack.name, mc, format: pack.kind };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

module.exports = { installModpack, inspectLocalPack, sanitizeId };
