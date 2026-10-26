const fs = require('fs');
const path = require('path');
const { download } = require('./http');
const { runPool } = require('./progress');
const source = require('./source');
const version = require('./version');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function librariesDir(gameDir) {
  return path.join(gameDir, 'libraries');
}

function assetsDir(gameDir) {
  return path.join(gameDir, 'assets');
}

/**
 * 下载并安装一个版本（可自动补齐缺失文件，支持 inheritsFrom 的加载器版本）。
 */
async function installVersion(cfg, versionId, { entry = null, progress, signal } = {}) {
  const gameDir = cfg.gameDir;
  ensureDir(path.join(gameDir, 'versions', versionId));

  progress.startPhase('获取版本信息', 1);
  const detail = await version.getVersionDetail(cfg, versionId, entry);
  if (!version.readInstalledVersion(gameDir, versionId)) {
    version.writeInstalledVersion(gameDir, versionId, detail);
  }
  progress.completeTask();

  const resolved = version.resolveFullVersion(gameDir, versionId);
  const merged = resolved.json;
  const baseJson = resolved.baseJson;
  const baseId = resolved.baseId;
  const concurrency = Math.max(1, Math.min(64, cfg.downloadThreads || 16));

  const libs = version.collectLibraries(cfg, merged);
  const tasks = [];

  // 客户端核心 jar
  const clientDl = baseJson.downloads && baseJson.downloads.client;
  if (clientDl) {
    const dest = path.join(version.versionDir(gameDir, baseId), `${baseId}.jar`);
    tasks.push({
      kind: 'client',
      urls: source.clientUrls(cfg, baseId, clientDl.url),
      dest,
      sha1: clientDl.sha1,
      size: clientDl.size
    });
  }

  // 依赖库
  for (const lib of libs) {
    tasks.push({
      kind: 'library',
      urls: lib.urls,
      dest: path.join(librariesDir(gameDir), lib.path),
      sha1: lib.sha1,
      size: lib.size
    });
  }

  const knownBytes = tasks.reduce((sum, t) => sum + (t.size || 0), 0);
  progress.startPhase('下载核心与依赖库', tasks.length, knownBytes);
  await runPool(
    tasks,
    concurrency,
    async (task) => {
      const result = await download(task.urls, task.dest, {
        size: task.size,
        sha1: task.sha1,
        signal,
        onBytes: (n) => progress.addBytes(n)
      });
      if (result.skipped) progress.addBytes(task.size || 0);
      progress.completeTask();
    },
    signal
  );

  // 资源索引与资源文件
  const assetIndex = baseJson.assetIndex;
  if (assetIndex && assetIndex.id && assetIndex.url) {
    const indexesDir = path.join(assetsDir(gameDir), 'indexes');
    ensureDir(indexesDir);
    const indexPath = path.join(indexesDir, `${assetIndex.id}.json`);
    progress.startPhase('下载资源索引', 1);
    await download(
      source.assetIndexUrls(cfg, assetIndex.url),
      indexPath,
      { size: assetIndex.size, sha1: assetIndex.sha1, signal }
    );
    progress.completeTask();

    let index = null;
    try {
      index = version.readJsonFile(indexPath);
    } catch (e) {
      throw new Error('资源索引解析失败: ' + e.message);
    }
    const objects = Object.values((index && index.objects) || {});
    const objectsDir = path.join(assetsDir(gameDir), 'objects');
    const totalBytes = objects.reduce((sum, o) => sum + (o.size || 0), 0);
    progress.startPhase('下载资源文件', objects.length, totalBytes);
    const unique = new Map();
    for (const obj of objects) {
      if (!obj || !obj.hash) continue;
      if (!unique.has(obj.hash)) unique.set(obj.hash, obj);
    }
    const list = [...unique.values()];
    progress.setTotals(list.length, totalBytes);
    await runPool(
      list,
      concurrency,
      async (obj) => {
        const sub = obj.hash.slice(0, 2);
        const dest = path.join(objectsDir, sub, obj.hash);
        const official = `${source.OFFICIAL_ASSETS}${sub}/${obj.hash}`;
        const result = await download(source.assetObjectUrls(cfg, obj.hash, official), dest, {
          size: obj.size,
          sha1: obj.hash,
          signal,
          // 资源节点偶尔迟迟不返回数据，超时后回退到其它下载源
          timeout: 25000,
          firstByteTimeout: 8000,
          retries: 1,
          onBytes: (n) => progress.addBytes(n)
        });
        if (result.skipped) progress.addBytes(obj.size || 0);
        progress.completeTask();
      },
      signal
    );

    if (index && (index.virtual || String(index.id || assetIndex.id).startsWith('legacy') || String(index.id || '').startsWith('pre-1.6'))) {
      progress.startPhase('生成旧版资源目录', 1);
      buildVirtualAssets(gameDir, assetIndex.id, index);
      progress.completeTask();
    }
  }

  // 日志配置
  const logFile = merged.logging && merged.logging.client && merged.logging.client.file;
  if (logFile && logFile.url) {
    progress.startPhase('下载日志配置', 1);
    const dest = path.join(assetsDir(gameDir), 'log_configs', logFile.id);
    await download([logFile.url], dest, { size: logFile.size, sha1: logFile.sha1, signal });
    progress.completeTask();
  }

  return { versionId };
}

function buildVirtualAssets(gameDir, indexId, index) {
  const objectsDir = path.join(assetsDir(gameDir), 'objects');
  const targetDir = path.join(assetsDir(gameDir), 'virtual', indexId);
  let count = 0;
  for (const [name, obj] of Object.entries(index.objects || {})) {
    if (!obj || !obj.hash) continue;
    const src = path.join(objectsDir, obj.hash.slice(0, 2), obj.hash);
    const dest = path.join(targetDir, name);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      count++;
    } catch (e) {
      // 个别资源（音效等）缺失不影响启动
    }
  }
  return count;
}

/** 仅安装某版本 json 中声明的依赖库（用于加载器版本） */
async function installLibrariesOnly(cfg, detail, { progress, signal, phaseName = '下载依赖库' } = {}) {
  const gameDir = cfg.gameDir;
  const concurrency = Math.max(1, Math.min(64, cfg.downloadThreads || 16));
  const libs = version.collectLibraries(cfg, detail);
  const tasks = libs.map((lib) => ({
    urls: lib.urls,
    dest: path.join(librariesDir(gameDir), lib.path),
    sha1: lib.sha1,
    size: lib.size
  }));
  progress.startPhase(phaseName, tasks.length, tasks.reduce((s, t) => s + (t.size || 0), 0));
  await runPool(
    tasks,
    concurrency,
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

module.exports = { installVersion, installLibrariesOnly, librariesDir, assetsDir, ensureDir, buildVirtualAssets };
