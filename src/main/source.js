const OFFICIAL_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const OFFICIAL_ASSETS = 'https://resources.download.minecraft.net/';
const OFFICIAL_LIBRARIES = 'https://libraries.minecraft.net/';
const OFFICIAL_FORGE_MAVEN = 'https://maven.minecraftforge.net/';
const OFFICIAL_NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/';
const OFFICIAL_FABRIC_META = 'https://meta.fabricmc.net';
const OFFICIAL_FABRIC_MAVEN = 'https://maven.fabricmc.net/';
// 上海交大 BMCLAPI 镜像：仅镜像 maven 目录，可绕开 BMCLAPI 上失效的 Forge 节点
const SJTU_BMCLAPI = 'https://mirror.sjtu.edu.cn/bmclapi';

const PRESETS = {
  bmclapi: { name: 'BMCLAPI 国内镜像', base: 'https://bmclapi2.bangbang93.com' },
  official: { name: '官方源（Mojang）', base: '' },
  custom: { name: '自定义镜像地址', base: '' }
};

function mirrorBase(cfg) {
  if (!cfg) return '';
  if (cfg.mirror === 'official') return '';
  if (cfg.mirror === 'custom') return (cfg.customMirror || '').trim().replace(/\/+$/, '');
  const preset = PRESETS[cfg.mirror];
  return preset ? preset.base.replace(/\/+$/, '') : PRESETS.bmclapi.base;
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

/**
 * 把官方下载地址按 BMCLAPI 的目录规则重写为镜像地址。
 * BMCLAPI 的目标是兼容官方文件结构，仅根路径不同。
 */
function mirrorOfficialUrl(base, officialUrl) {
  if (!base || !officialUrl) return null;
  let url;
  try {
    url = new URL(officialUrl);
  } catch (e) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let prefix = '';
  let pathname = url.pathname;
  if (
    host === 'launchermeta.mojang.com' ||
    host === 'piston-meta.mojang.com' ||
    host === 'piston-data.mojang.com' ||
    host === 'launcher.mojang.com'
  ) {
    prefix = '';
  } else if (host === 'resources.download.minecraft.net') {
    prefix = '/assets';
  } else if (host === 'libraries.minecraft.net') {
    prefix = '/maven';
  } else if (host === 'maven.minecraftforge.net' || host === 'maven.fabricmc.net') {
    prefix = '/maven';
  } else if (host === 'maven.neoforged.net') {
    prefix = '/maven';
    // 官方仓库地址带 /releases 或 /snapshots 前缀，BMCLAPI 的 maven 镜像没有这一层
    pathname = pathname.replace(/^\/(releases|snapshots)(?=\/)/, '');
  } else if (host === 'files.minecraftforge.net') {
    if (!pathname.startsWith('/maven/')) return null;
    prefix = '/maven';
    pathname = pathname.slice('/maven'.length);
  } else {
    return null;
  }
  return `${base}${prefix}${pathname}${url.search || ''}`;
}

/** 版本清单 */
function manifestUrls(cfg) {
  const base = mirrorBase(cfg);
  return uniq([base && `${base}/mc/game/version_manifest_v2.json`, OFFICIAL_MANIFEST]);
}

/** 单个版本的 json */
function versionJsonUrls(cfg, id, officialUrl) {
  const base = mirrorBase(cfg);
  return uniq([
    mirrorOfficialUrl(base, officialUrl),
    base && `${base}/version/${encodeURIComponent(id)}/json`,
    officialUrl
  ]);
}

/** 客户端 jar */
function clientUrls(cfg, id, officialUrl) {
  const base = mirrorBase(cfg);
  return uniq([mirrorOfficialUrl(base, officialUrl), base && `${base}/version/${encodeURIComponent(id)}/client`, officialUrl]);
}

/** 依赖库 */
function libraryUrls(cfg, relPath, officialUrl) {
  return mavenUrls(cfg, relPath, officialUrl);
}

/** 资源索引 */
function assetIndexUrls(cfg, officialUrl) {
  const base = mirrorBase(cfg);
  return uniq([mirrorOfficialUrl(base, officialUrl), officialUrl]);
}

/** 资源对象 */
function assetObjectUrls(cfg, hash, officialUrl) {
  const base = mirrorBase(cfg);
  const tail = `${hash.slice(0, 2)}/${hash}`;
  return uniq([
    mirrorOfficialUrl(base, officialUrl || `${OFFICIAL_ASSETS}${tail}`),
    base && `${base}/assets/${tail}`,
    officialUrl || `${OFFICIAL_ASSETS}${tail}`
  ]);
}

/** 通用 maven 文件（Forge / Mojang 依赖库） */
function mavenUrls(cfg, relPath, officialUrl) {
  const base = mirrorBase(cfg);
  const urls = [];
  // Forge 的 maven 在 BMCLAPI 上经常 302 到不可达节点，优先走交大镜像
  if (base === PRESETS.bmclapi.base && isForgeMavenUrl(officialUrl)) {
    urls.push(`${SJTU_BMCLAPI}/${relPath}`);
  }
  urls.push(mirrorOfficialUrl(base, officialUrl), base && `${base}/maven/${relPath}`, officialUrl);
  return uniq(urls);
}

function isForgeMavenUrl(officialUrl) {
  if (!officialUrl) return false;
  try {
    const host = new URL(officialUrl).hostname.toLowerCase();
    return (
      host === 'maven.minecraftforge.net' ||
      host === 'files.minecraftforge.net'
    );
  } catch (e) {
    return false;
  }
}

function forgeInstallerUrls(cfg, fullVersion) {
  const rel = `net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`;
  return mavenUrls(cfg, rel, `${OFFICIAL_FORGE_MAVEN}${rel}`);
}

function forgeMetadataUrls(cfg) {
  const rel = 'net/minecraftforge/forge/maven-metadata.xml';
  return mavenUrls(cfg, rel, `${OFFICIAL_FORGE_MAVEN}${rel}`);
}

/** Fabric 元数据：BMCLAPI 提供 /fabric-meta 代理 */
function fabricMetaUrls(cfg, apiPath) {
  const base = mirrorBase(cfg);
  return uniq([base && `${base}/fabric-meta${apiPath}`, `${OFFICIAL_FABRIC_META}${apiPath}`]);
}

function fabricLoaderListUrls(cfg, mcVersion) {
  return fabricMetaUrls(cfg, `/v2/versions/loader/${encodeURIComponent(mcVersion)}`);
}

function fabricProfileUrls(cfg, mcVersion, loaderVersion) {
  return fabricMetaUrls(
    cfg,
    `/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  );
}

/** NeoForge：1.20.1 使用 net.neoforged:forge，1.20.2+ 使用 net.neoforged:neoforge */
function neoForgeGroup(mcVersion, version) {
  const v = String(version || '');
  if (/^1\.20\.1(\.|$)/.test(String(mcVersion || '')) || /^47\./.test(v)) {
    return { group: 'net/neoforged/forge', artifact: 'forge', prefix: `${mcVersion}-` };
  }
  return { group: 'net/neoforged/neoforge', artifact: 'neoforge', prefix: '' };
}

function neoForgeInstallerUrls(cfg, mcVersion, version) {
  const { group, artifact, prefix } = neoForgeGroup(mcVersion, version);
  const full = `${prefix}${version}`;
  const rel = `${group}/${full}/${artifact}-${full}-installer.jar`;
  return mavenUrls(cfg, rel, `${OFFICIAL_NEOFORGE_MAVEN}${rel}`);
}

function neoForgeMetadataUrls(cfg, group) {
  const rel = `net/neoforged/${group}/maven-metadata.xml`;
  return mavenUrls(cfg, rel, `${OFFICIAL_NEOFORGE_MAVEN}${rel}`);
}

/** OptiFine：BMCLAPI 提供独立 API */
function optifineListUrls(cfg, mcVersion) {
  const base = mirrorBase(cfg);
  return uniq([base && `${base}/optifine/${encodeURIComponent(mcVersion)}`]);
}

function optifineDownloadUrls(cfg, mcVersion, type, patch) {
  const base = mirrorBase(cfg);
  return uniq([
    base && `${base}/optifine/${encodeURIComponent(mcVersion)}/${encodeURIComponent(type)}/${encodeURIComponent(patch)}`
  ]);
}

module.exports = {
  PRESETS,
  OFFICIAL_MANIFEST,
  OFFICIAL_ASSETS,
  OFFICIAL_LIBRARIES,
  OFFICIAL_FORGE_MAVEN,
  OFFICIAL_NEOFORGE_MAVEN,
  OFFICIAL_FABRIC_META,
  OFFICIAL_FABRIC_MAVEN,
  mirrorBase,
  mirrorOfficialUrl,
  manifestUrls,
  versionJsonUrls,
  clientUrls,
  libraryUrls,
  assetIndexUrls,
  assetObjectUrls,
  mavenUrls,
  forgeInstallerUrls,
  forgeMetadataUrls,
  fabricMetaUrls,
  fabricLoaderListUrls,
  fabricProfileUrls,
  neoForgeGroup,
  neoForgeInstallerUrls,
  neoForgeMetadataUrls,
  optifineListUrls,
  optifineDownloadUrls
};
