const { fetchJson } = require('./http');
const source = require('./source');

let cache = { at: 0, data: null };

async function getManifest(cfg, force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < 10 * 60 * 1000) return cache.data;
  // 镜像与官方源同时请求，谁先返回用谁：镜像快时走镜像，镜像卡住也不会拖慢界面
  const data = await fetchJson(source.manifestUrls(cfg), { race: true, timeout: 25000 });
  if (!data || !Array.isArray(data.versions)) throw new Error('版本清单格式异常');
  cache = { at: now, data };
  return data;
}

function findEntry(manifest, id) {
  return (manifest.versions || []).find((v) => v.id === id) || null;
}

module.exports = { getManifest, findEntry };
