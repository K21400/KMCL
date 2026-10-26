const fs = require('fs');
const path = require('path');
const { fetchJson, downloadFast } = require('./http');
const instance = require('./instance');

/** MCIM：面向国内用户的 Modrinth / CurseForge 信息与文件镜像 */
const MCIM = 'https://mod.mcimirror.top';
const MR_OFFICIAL = 'https://api.modrinth.com';
const CF_GAME_ID = 432;

const SOURCES = [
  { id: 'curseforge', label: 'CurseForge 国内镜像' },
  { id: 'modrinth', label: 'Modrinth 国内镜像' }
];

/** 分类：CurseForge 用 categoryId，Modrinth 用 category 名 */
const CATEGORIES = [
  { id: 'tech', label: '科技', cf: 412, mr: 'technology' },
  { id: 'magic', label: '魔法', cf: 419, mr: 'magic' },
  { id: 'adventure', label: '冒险', cf: 422, mr: 'adventure' },
  { id: 'optimization', label: '优化', cf: 6814, mr: 'optimization' },
  { id: 'storage', label: '存储', cf: 420, mr: 'storage' },
  { id: 'worldgen', label: '世界生成', cf: 406, mr: 'worldgen' },
  { id: 'decoration', label: '装饰', cf: 424, mr: 'decoration' },
  { id: 'utility', label: '实用', cf: 5191, mr: 'utility' },
  { id: 'library', label: '前置库', cf: 421, mr: 'library' }
];

const LOADERS = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const CLASS_IDS = { mod: 6, modpack: 4471 };

const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

function cached(key, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  // 失败时不缓存，避免一次网络抖动让后续请求在 TTL 内一直失败
  const value = Promise.resolve()
    .then(producer)
    .catch((e) => {
      cache.delete(key);
      throw e;
    });
  cache.set(key, { at: Date.now(), value });
  return value;
}

function mirrorDownloadUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'cdn.modrinth.com' || u.hostname === 'edge.forgecdn.net') {
      u.hostname = new URL(MCIM).hostname;
      return u.toString();
    }
  } catch (e) {}
  return url;
}

function downloadUrlsFor(url) {
  return [...new Set([mirrorDownloadUrl(url), url].filter(Boolean))];
}

function apiPath(source, p) {
  return source === 'modrinth' ? `/modrinth${p}` : `/curseforge${p}`;
}

async function apiJson(source, p, query = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const full = `${p}${qs ? '?' + qs : ''}`;
  const urls = [MCIM + apiPath(source, full)];
  if (source === 'modrinth') urls.push(MR_OFFICIAL + full);
  // CurseForge 在「按游戏版本 + 空关键字」搜索时需要扫描较多数据，放宽超时避免误判失败
  return fetchJson(urls, { timeout: 45000, race: true });
}

function cfIcon(mod) {
  return (mod.logo && (mod.logo.thumbnailUrl || mod.logo.url)) || '';
}

/** 搜索 Mod / 整合包 */
async function searchMods(cfg, opts = {}) {
  const wanted = opts.source === 'modrinth' ? 'modrinth' : 'curseforge';
  try {
    const res = await searchSource(cfg, wanted, opts);
    if (res.items.length) return res;
    // 国内镜像搜不到结果时，改用另一个源再试一次
    const alt = wanted === 'curseforge' ? 'modrinth' : 'curseforge';
    const fallback = await searchSource(cfg, alt, opts);
    if (fallback.items.length) return { ...fallback, fallback: wanted };
    return res;
  } catch (e) {
    const alt = wanted === 'curseforge' ? 'modrinth' : 'curseforge';
    try {
      const fallback = await searchSource(cfg, alt, opts);
      return { ...fallback, fallback: wanted };
    } catch (e2) {
      throw e;
    }
  }
}

async function searchSource(cfg, source, opts = {}) {
  const type = opts.type === 'modpack' ? 'modpack' : 'mod';
  const query = String(opts.query || '').trim();
  const page = Math.max(0, Number(opts.page) || 0);
  const pageSize = Math.min(40, Math.max(10, Number(opts.pageSize) || 20));
  const mcVersion = String(opts.mcVersion || '').trim();
  const loader = LOADERS[opts.loader] ? String(opts.loader) : '';
  const category = CATEGORIES.find((c) => c.id === opts.category) || null;

  const key = JSON.stringify({ source, type, query, page, pageSize, mcVersion, loader, category: category && category.id });
  return cached(key, async () => {
    if (source === 'curseforge') {
      const data = await apiJson(source, '/v1/mods/search', {
        gameId: CF_GAME_ID,
        classId: CLASS_IDS[type],
        searchFilter: query,
        gameVersion: mcVersion,
        modLoaderType: loader ? LOADERS[loader] : '',
        categoryId: category ? category.cf : '',
        index: page * pageSize,
        pageSize,
        sortField: 2,
        sortOrder: 'desc'
      });
      return {
        source,
        type,
        page,
        pageSize,
        total: (data.pagination && data.pagination.totalCount) || (data.data || []).length,
        items: (data.data || []).map((m) => ({
          source,
          type,
          id: String(m.id),
          name: m.name,
          slug: m.slug,
          summary: m.summary || '',
          icon: cfIcon(m),
          downloads: m.downloadCount || 0,
          author: (m.authors && m.authors[0] && m.authors[0].name) || '',
          categories: (m.categories || []).map((c) => c.name),
          versions: []
        }))
      };
    }

    const facets = [[`project_type:${type}`]];
    if (mcVersion) facets.push([`versions:${mcVersion}`]);
    if (loader) facets.push([`categories:${loader}`]);
    if (category) facets.push([`categories:${category.mr}`]);
    // Modrinth 的 index 是排序方式，分页要用 offset
    const data = await apiJson(source, '/v2/search', {
      query,
      facets: JSON.stringify(facets),
      index: 'relevance',
      offset: page * pageSize,
      limit: pageSize
    });
    return {
      source,
      type,
      page,
      pageSize,
      total: data.total_hits || 0,
      items: (data.hits || []).map((h) => ({
        source,
        type: h.project_type === 'modpack' ? 'modpack' : 'mod',
        id: h.project_id,
        name: h.title,
        slug: h.slug,
        summary: h.description || '',
        icon: h.icon_url || '',
        downloads: h.downloads || 0,
        author: h.author || '',
        categories: h.display_categories || h.categories || [],
        versions: h.versions || []
      }))
    };
  });
}

/** CurseForge 关系类型 3 = 必需前置 */
function cfDependencies(file) {
  return (file.dependencies || [])
    .filter((d) => d && d.modId)
    .map((d) => ({
      projectId: String(d.modId),
      versionId: '',
      required: Number(d.relationType) === 3
    }));
}

/** Modrinth 依赖：required / optional / incompatible / embedded */
function mrDependencies(version) {
  return (version.dependencies || [])
    .filter((d) => d && (d.project_id || d.version_id))
    .map((d) => ({
      projectId: d.project_id ? String(d.project_id) : '',
      versionId: d.version_id ? String(d.version_id) : '',
      required: d.dependency_type === 'required'
    }));
}

function mcmodSearchUrl(name) {
  return `https://search.mcmod.cn/s?key=${encodeURIComponent(String(name || ''))}`;
}

/**
 * 尽量解析出 MC 百科的具体条目页（/class/xxx.html 或 /modpack/xxx.html）。
 * 搜索页不可用时回退到搜索地址，保证按钮始终可用。
 */
const mcmodCache = new Map();
const mcmodItemsCache = new Map();
let mcmodLastAt = 0;

/**
 * 限制请求频率，避免百科限流返回空白页。
 * 用串行队列而不是简单的时间戳等待：多个解析并发时不会同时唤醒造成突发请求。
 */
let mcmodQueue = Promise.resolve();

function mcmodThrottle(minGap = 3000) {
  const task = mcmodQueue.then(async () => {
    const wait = mcmodLastAt + minGap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    mcmodLastAt = Date.now();
  });
  mcmodQueue = task.catch(() => {});
  return task;
}

function mcmodKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[[\]()（）【】]/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 逐层剥掉括号内容：FerriteCore ((Neo)Forge) → FerriteCore */
function stripParens(text) {
  let prev = String(text || '');
  for (let i = 0; i < 4; i++) {
    const next = prev.replace(/[(（][^()（）]*[)）]/g, ' ').replace(/\s+/g, ' ').trim();
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

/** 用完整名称搜不到时，逐步退化为更短的关键词 */
function mcmodQueryCandidates(name) {
  const raw = String(name || '').trim();
  const list = [];
  const push = (s) => {
    const v = String(s || '').replace(/\s+/g, ' ').trim();
    if (v && !list.includes(v)) list.push(v);
  };
  const noParen = stripParens(raw);
  // 括号里的全大写缩写通常是社区通用简称，如 Just Enough Items (JEI) → JEI
  const abbrs = [];
  const re = /[(（]([A-Za-z0-9]{2,10})[)）]/g;
  let m;
  while ((m = re.exec(raw))) {
    if (/^[A-Z][A-Z0-9]*$/.test(m[1])) abbrs.push(m[1]);
  }
  const base = noParen.split(/\s[-–—]\s/)[0].split(/[:：]/)[0].trim();
  push(raw);
  for (const a of abbrs) push(a);
  push(noParen);
  push(base);
  // 去掉数字版本尾缀：All the Mods 10 → All the Mods
  push(base.replace(/\b\d+(\.\d+)*\b/g, ' '));
  // 去掉空格：AlltheMods（MC 百科里这类词经常连写）
  const words = base.split(/[\s:：\-–—]+/).filter(Boolean);
  if (words.length > 1) {
    push(words.filter((w) => !/^\d+(\.\d+)*$/.test(w)).join(''));
  }
  return list.filter((v) => v && v.length > 1).slice(0, 5);
}

function parseMcmodResults(html) {
  const items = [];
  const re = /<a[^>]+href="(?:https?:\/\/(?:www\.)?mcmod\.cn)?(\/(?:class|modpack)\/\d+\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.includes('www.mcmod.cn')) continue;
    items.push({
      url: `https://www.mcmod.cn${m[1]}`,
      kind: m[1].startsWith('/modpack/') ? 'modpack' : 'mod',
      title
    });
  }
  return items;
}

/**
 * 从百科结果里提取「中文名 (EnglishName)」形式的社区名称。
 * 只认第一条结果，避免把扩展模组（如 “CNPC可穿戴饰品 (Curios API)”）误当成本体中文名。
 */
function pickChineseTranslation(items, name) {
  if (!items.length) return '';
  const target = mcmodKey(stripParens(name));
  const tokens = target.split(' ').filter((t) => t.length > 1);
  const item = items[0];
  if (!item || !/[\u4e00-\u9fa5]/.test(item.title)) return '';
  const m = item.title.match(/^(.+?)\s*[(（]([^()（）]+)[)）]\s*$/);
  if (!m) return '';
  const cn = m[1].replace(/^[[【][^\])】]{1,12}[\]】]\s*/, '').trim();
  if (!cn || !/[\u4e00-\u9fa5]/.test(cn)) return '';
  const enParts = mcmodKey(m[2]).split(' ').filter(Boolean);
  // 英文括注必须覆盖目标全部关键词，且不能包含无关词
  for (const token of tokens) {
    if (!enParts.some((p) => p === token || p.includes(token))) return '';
  }
  for (const p of enParts) {
    if (!tokens.some((t) => p === t || p.includes(t))) return '';
  }
  return cn;
}

/** 按名称相似度挑选最匹配的结果，优先与项目类型一致 */
function pickMcmodResult(items, name, type) {
  const target = mcmodKey(name);
  const tokens = target.split(' ').filter((t) => t.length > 1);
  let best = null;
  for (const item of items) {
    const title = mcmodKey(item.title);
    const parts = title.split(' ').filter(Boolean);
    // 目标词的覆盖率
    let matched = 0;
    for (const token of tokens) {
      if (parts.some((p) => p === token || p.includes(token))) matched++;
    }
    // 标题里与目标无关的额外词，越少越接近
    let extra = 0;
    for (const p of parts) {
      if (!tokens.some((t) => p === t || p.includes(t))) extra++;
    }
    let score = matched / Math.max(1, tokens.length + extra);
    if (matched === tokens.length) score += 0.05;
    if (title === target) score += 0.3;
    if (type === 'modpack') score += item.kind === 'modpack' ? 0.12 : 0;
    else score += item.kind === 'mod' ? 0.08 : 0;
    // 百科结果本身按相关度排序：分数接近时优先保留更靠前（更官方）的条目
    if (!best || score > best.score + 0.15 || matched > best.matched + 1) best = { ...item, score, matched };
  }
  return best;
}

/** 在主进程中取一次百科搜索结果（优先 Electron 网络栈，走系统代理） */
async function mcmodFetchPage(query) {
  let doFetch = typeof fetch === 'function' ? fetch : null;
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') doFetch = electron.net.fetch.bind(electron.net);
  } catch (e) {}
  if (!doFetch) return '';
  await mcmodThrottle();
  try {
    const res = await doFetch(`https://search.mcmod.cn/s?key=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(6000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });
    if (!res.ok) return '';
    const html = await res.text();
    // 只有带「找到约 / 没有找到」的页面才是正常搜索页，否则是被限流
    return /找到约|没有找到/.test(html) ? html : '';
  } catch (e) {
    return '';
  }
}

/** 按名称搜索百科，返回解析后的条目（带内存缓存） */
async function searchMcmodItems(name) {
  const key = String(name || '').trim();
  if (!key) return [];
  const cacheKey = `items:${key}`;
  if (mcmodItemsCache.has(cacheKey)) return mcmodItemsCache.get(cacheKey);
  let blankStreak = 0;
  for (const query of mcmodQueryCandidates(key)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const html = await mcmodFetchPage(query);
      if (!html) {
        // 空白页说明被限流，放慢速度再试；连续两次仍失败就放弃，避免拖慢整批解析
        blankStreak++;
        if (blankStreak >= 2) {
          mcmodItemsCache.set(cacheKey, []);
          return [];
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      blankStreak = 0;
      const items = parseMcmodResults(html);
      // 搜索页正常但没有结果：换下一个候选关键词，不要提前结束
      if (items.length) {
        mcmodItemsCache.set(cacheKey, items);
        return items;
      }
      break;
    }
  }
  mcmodItemsCache.set(cacheKey, []);
  return [];
}

async function resolveMcmodUrl(name, type) {
  const key = String(name || '').trim();
  const search = mcmodSearchUrl(key);
  if (!key) return search;
  const cacheKey = `${type || 'mod'}:${key}`;
  if (mcmodCache.has(cacheKey)) return mcmodCache.get(cacheKey);
  const targetTokens = mcmodKey(key).split(' ').filter((t) => t.length > 1);
  const items = await searchMcmodItems(key);
  if (!items.length) return search;
  const best = pickMcmodResult(items, key, type);
  if (best && best.matched >= 1 && best.matched / Math.max(1, targetTokens.length) >= 0.34) {
    mcmodCache.set(cacheKey, best.url);
    return best.url;
  }
  return search;
}

/* ------------------------- MC 百科中文名称 ------------------------- */

const cnNameStore = { data: null, timer: null };

function cnNameFile() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'mod-names-zh.json');
  } catch (e) {
    return '';
  }
}

function loadCnNames() {
  if (cnNameStore.data) return cnNameStore.data;
  const file = cnNameFile();
  try {
    cnNameStore.data = file ? JSON.parse(fs.readFileSync(file, 'utf8')) || {} : {};
  } catch (e) {
    cnNameStore.data = {};
  }
  return cnNameStore.data;
}

function scheduleSaveCnNames() {
  const file = cnNameFile();
  if (!file) return;
  if (cnNameStore.timer) clearTimeout(cnNameStore.timer);
  cnNameStore.timer = setTimeout(() => {
    try {
      const store = loadCnNames();
      const keys = Object.keys(store);
      if (keys.length > 4000) for (const k of keys.slice(0, keys.length - 4000)) delete store[k];
      fs.writeFileSync(file, JSON.stringify(store), 'utf8');
    } catch (e) {}
  }, 1200);
}

/** 去掉百科标题里的缩写标签 / 版本号 / 英文括注 / 表情符号，保留纯中文社区名称 */
function cleanChineseTitle(title) {
  let t = String(title || '').trim();
  t = t.replace(/\s*[-–—]\s*MC百科\s*$/i, '').trim();
  // 去掉 [JEI] / 【XMM】 这类社区缩写前缀
  t = t.replace(/^[[【][^\])】]{1,12}[\]】]\s*/, '').trim();
  const stripped = t.replace(/\s*[(（][^()（）]*[)）]\s*$/, '').trim();
  if (stripped && /[\u4e00-\u9fa5]/.test(stripped)) t = stripped;
  // 去掉 🔍 等表情符号，避免出现“玉 🔍”这种名字
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '');
  return t.replace(/\s+/g, ' ').trim();
}

// 短时间内不重复请求的失败记录（不写盘，下次启动可重试）
const cnMissCache = new Map();
const CN_MISS_TTL = 10 * 60 * 1000;

async function resolveChineseName(name) {
  const key = String(name || '').trim();
  if (!key) return '';
  // 名称本身已是中文，直接使用
  if (/[\u4e00-\u9fa5]/.test(key)) return key;
  const store = loadCnNames();
  if (Object.prototype.hasOwnProperty.call(store, key)) return store[key];
  const missedAt = cnMissCache.get(key);
  if (missedAt && Date.now() - missedAt < CN_MISS_TTL) return '';
  let result = '';
  try {
    const items = await searchMcmodItems(key);
    const cn = pickChineseTranslation(items, key);
    if (cn) {
      result = cleanChineseTitle(cn);
    } else {
      const best = pickMcmodResult(items, key, 'mod');
      if (best && /[\u4e00-\u9fa5]/.test(best.title)) result = cleanChineseTitle(best.title);
    }
    if (result && !/[\u4e00-\u9fa5]/.test(result)) result = '';
  } catch (e) {
    result = '';
  }
  // 只持久化成功结果，失败的下次启动还能重新解析
  if (result) {
    store[key] = result;
    scheduleSaveCnNames();
  } else {
    cnMissCache.set(key, Date.now());
  }
  return result;
}

/** 批量获取中文名：{ 英文名: 中文名 }，拿不到的对应空字符串 */
async function resolveChineseNames(names) {
  const list = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean))].slice(
    0,
    40
  );
  const out = {};
  let index = 0;
  const workers = Array.from({ length: Math.min(3, list.length || 1) }, async () => {
    while (index < list.length) {
      const name = list[index++];
      try {
        const cn = await resolveChineseName(name);
        if (cn) out[name] = cn;
      } catch (e) {}
    }
  });
  await Promise.all(workers);
  return out;
}

/** 获取项目详情（用于详情弹窗与 MC 百科链接） */
async function getProject(cfg, opts = {}) {
  const source = opts.source === 'modrinth' ? 'modrinth' : 'curseforge';
  const projectId = String(opts.projectId || '');
  const info =
    source === 'modrinth' ? await modrinthProject(source, projectId) : await curseforgeProject(source, projectId);
  // 中文社区名称：用于详情弹窗标题与搜索列表
  try {
    info.nameZh = await resolveChineseName(info.name);
  } catch (e) {
    info.nameZh = '';
  }
  return info;
}

async function modrinthProject(source, projectId) {
  const d = await apiJson(source, `/v2/project/${encodeURIComponent(projectId)}`);
  return {
    source,
    id: projectId,
    name: d.title || '',
    slug: d.slug || '',
    summary: d.description || '',
    body: d.body || '',
    icon: d.icon_url || '',
    downloads: d.downloads || 0,
    author: '',
    categories: d.categories || [],
    website: d.source_url || d.issues_url || '',
    wiki: d.wiki_url || '',
    mcmod: mcmodSearchUrl(d.title || ''),
    projectType: d.project_type || ''
  };
}

async function curseforgeProject(source, projectId) {
  const data = await apiJson(source, `/v1/mods/${encodeURIComponent(projectId)}`);
  const m = data.data || {};
  const links = m.links || {};
  return {
    source,
    id: projectId,
    name: m.name || '',
    slug: m.slug || '',
    summary: m.summary || '',
    body: '',
    icon: cfIcon(m),
    downloads: m.downloadCount || 0,
    author: (m.authors && m.authors[0] && m.authors[0].name) || '',
    categories: (m.categories || []).map((c) => c.name),
    website: links.websiteUrl || '',
    wiki: links.wikiUrl || '',
    mcmod: mcmodSearchUrl(m.name || ''),
    projectType: ''
  };
}

/** 为前置项目挑选与当前游戏版本 / 加载器匹配的文件 */
async function pickDependencyFile(cfg, dep, { mcVersion, loader, type = 'mod' }) {
  let files = [];
  try {
    files = await listFiles(cfg, {
      source: dep.source,
      type,
      projectId: dep.projectId,
      mcVersion,
      loader
    });
  } catch (e) {
    files = [];
  }
  if (!files.length) {
    try {
      files = await listFiles(cfg, { source: dep.source, type, projectId: dep.projectId });
    } catch (e) {
      files = [];
    }
  }
  if (dep.versionId) {
    const exact = files.find((f) => String(f.id) === String(dep.versionId));
    if (exact) return exact;
  }
  return files[0] || null;
}

/** 获取某个项目的可用文件（按游戏版本与加载器过滤） */
async function listFiles(cfg, opts = {}) {
  const source = opts.source === 'modrinth' ? 'modrinth' : 'curseforge';
  const type = opts.type === 'modpack' ? 'modpack' : 'mod';
  const projectId = String(opts.projectId || '');
  const mcVersion = String(opts.mcVersion || '').trim();
  const loader = LOADERS[opts.loader] ? String(opts.loader) : '';

  if (source === 'modrinth') {
    const data = await apiJson(source, `/v2/project/${encodeURIComponent(projectId)}/version`, {
      game_versions: mcVersion ? JSON.stringify([mcVersion]) : '',
      loaders: loader ? JSON.stringify([loader]) : ''
    });
    return (Array.isArray(data) ? data : []).map((v) => {
      const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0] || {};
      return {
        source,
        type,
        id: v.id,
        name: v.name || file.filename || '',
        fileName: file.filename || '',
        url: file.url || '',
        size: file.size || 0,
        sha1: (file.hashes && file.hashes.sha1) || '',
        gameVersions: v.game_versions || [],
        loaders: v.loaders || [],
        channel: v.version_type || 'release',
        date: v.date_published || '',
        dependencies: mrDependencies(v)
      };
    });
  }

  const data = await apiJson(source, `/v1/mods/${encodeURIComponent(projectId)}/files`, {
    gameVersion: mcVersion,
    modLoaderType: loader ? LOADERS[loader] : '',
    pageSize: 50
  });
  const files = (data.data || [])
    .filter((f) => !mcVersion || (f.gameVersions || []).includes(mcVersion))
    .sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
  return files.map((f) => {
    // CurseForge 官方 API 不给 downloadUrl 时，用镜像的直链接口与官方 CDN 兜底
    const apiUrl = `${MCIM}/curseforge/v1/mods/${encodeURIComponent(projectId)}/files/${f.id}/download`;
    const cdnUrl = `https://edge.forgecdn.net/files/${Math.floor(f.id / 1000)}/${String(f.id % 1000).padStart(3, '0')}/${encodeURIComponent(f.fileName)}`;
    return {
      source,
      type,
      id: String(f.id),
      name: f.displayName || f.fileName,
      fileName: f.fileName,
      url: f.downloadUrl || apiUrl,
      urls: [...new Set([f.downloadUrl, apiUrl, cdnUrl].filter(Boolean))],
      size: f.fileLength || 0,
      sha1: ((f.hashes || []).find((h) => h.algo === 1) || {}).value || '',
      gameVersions: f.gameVersions || [],
      loaders: [],
      channel: f.releaseType === 1 ? 'release' : f.releaseType === 2 ? 'beta' : 'alpha',
      date: f.fileDate || '',
      dependencies: cfDependencies(f)
    };
  });
}

function uniqueDest(dir, fileName) {
  const safeName = path.basename(String(fileName || 'download.jar')).replace(/[\\/:*?"<>|]/g, '_');
  let dest = path.join(dir, safeName);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${base}-${i}${ext}`);
    i++;
  }
  return dest;
}

/** 下载单个文件（优先国内镜像，失败回退官方 CDN；可传入多个候选地址） */
async function downloadTo(url, dest, { size, sha1, onBytes, signal } = {}) {
  // 大文件（整合包）用单通道，避免多通道各自完整下载造成数倍流量
  const lanes = Number(size) > 64 * 1024 * 1024 ? 1 : 3;
  const candidates = (Array.isArray(url) ? url : [url]).flatMap((u) => downloadUrlsFor(u));
  return downloadFast([...new Set(candidates.filter(Boolean))], dest, {
    size,
    sha1,
    onBytes,
    signal,
    lanes,
    retries: 3,
    timeout: 30000,
    firstByteTimeout: 8000,
    minRate: 8 * 1024
  });
}

/** 解析前置依赖：返回需要一起安装的前置项目（含适配文件） */
async function resolveDependencies(cfg, opts = {}) {
  const source = opts.source === 'modrinth' ? 'modrinth' : 'curseforge';
  const mcVersion = String(opts.mcVersion || '');
  const loader = LOADERS[opts.loader] ? String(opts.loader) : '';
  const visited = new Set();
  const items = [];

  async function walk(src, projectId, fileId, depth) {
    if (depth > 2 || !projectId) return;
    const key = `${src}:${projectId}`;
    if (visited.has(key)) return;
    visited.add(key);
    let files = [];
    try {
      files = await listFiles(cfg, { source: src, type: 'mod', projectId });
    } catch (e) {
      return;
    }
    const file = fileId ? files.find((f) => String(f.id) === String(fileId)) : files[0];
    if (!file) return;
    const required = (file.dependencies || []).filter((d) => d.required);
    for (const dep of required) {
      let depProjectId = dep.projectId;
      if (!depProjectId && dep.versionId && src === 'modrinth') {
        try {
          const v = await apiJson('modrinth', `/v2/version/${encodeURIComponent(dep.versionId)}`);
          depProjectId = v.project_id || '';
        } catch (e) {}
      }
      if (!depProjectId) continue;
      const depKey = `${src}:${depProjectId}`;
      if (visited.has(depKey)) continue;
      let info = null;
      try {
        info = await getProject(cfg, { source: src, projectId: depProjectId });
      } catch (e) {}
      const depFile = await pickDependencyFile(cfg, { source: src, projectId: depProjectId, versionId: dep.versionId }, {
        mcVersion,
        loader
      });
      if (!depFile || !depFile.url) continue;
      visited.add(depKey);
      items.push({
        source: src,
        projectId: depProjectId,
        name: (info && info.name) || depFile.fileName || depProjectId,
        icon: (info && info.icon) || '',
        fileId: depFile.id,
        fileName: depFile.fileName,
        size: depFile.size || 0,
        url: depFile.url,
        sha1: depFile.sha1 || ''
      });
      await walk(src, depProjectId, depFile.id, depth + 1);
    }
  }

  await walk(source, String(opts.projectId || ''), opts.fileId, 0);
  return items;
}

/** 下载单个 mod 文件到指定版本 */
async function installModFile(cfg, { versionId, file, progress, signal, onLog }) {
  const dir = instance.modsDirOf(cfg, versionId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = uniqueDest(dir, file.fileName || 'mod.jar');
  if (progress) progress.startPhase(`下载 ${file.fileName}`, 1, file.size || 0);
  await downloadTo(file.urls && file.urls.length ? file.urls : file.url, dest, {
    size: file.size,
    sha1: file.sha1,
    signal,
    onBytes: (n) => progress && progress.addBytes(n)
  });
  if (progress) progress.completeTask();
  if (onLog) onLog(`[Mod] 已下载 ${path.basename(dest)} → ${dir}`);
  return { path: dest, fileName: path.basename(dest) };
}

/** 把选中的 mod 文件安装到指定版本的 mods 目录（可选连同前置一起安装） */
async function installMod(cfg, opts = {}) {
  const versionId = String(opts.versionId || '');
  if (!versionId) throw new Error('请选择要安装到的游戏版本');
  const files = await listFiles(cfg, {
    source: opts.source,
    type: 'mod',
    projectId: opts.projectId,
    mcVersion: opts.mcVersion,
    loader: opts.loader
  });
  const file = opts.fileId ? files.find((f) => String(f.id) === String(opts.fileId)) : files[0];
  if (!file) throw new Error('没有找到与当前游戏版本匹配的文件');
  if (!file.url && !(file.urls && file.urls.length)) throw new Error('该文件未提供下载地址（作者可能关闭了第三方下载）');

  const installedDependencies = [];
  if (opts.withDependencies) {
    const deps = await resolveDependencies(cfg, {
      source: opts.source,
      projectId: opts.projectId,
      fileId: file.id,
      mcVersion: opts.mcVersion,
      loader: opts.loader
    });
    for (const dep of deps) {
      const r = await installModFile(cfg, { versionId, file: dep, progress: opts.progress, signal: opts.signal, onLog: opts.onLog });
      installedDependencies.push({ name: dep.name, fileName: r.fileName });
    }
  }

  const result = await installModFile(cfg, {
    versionId,
    file,
    progress: opts.progress,
    signal: opts.signal,
    onLog: opts.onLog
  });
  return { ...result, file, installedDependencies };
}

module.exports = {
  MCIM,
  SOURCES,
  CATEGORIES,
  LOADERS,
  mirrorDownloadUrl,
  downloadUrlsFor,
  searchMods,
  listFiles,
  getProject,
  mcmodSearchUrl,
  resolveMcmodUrl,
  resolveChineseName,
  resolveChineseNames,
  resolveDependencies,
  installMod,
  installModFile,
  downloadTo,
  uniqueDest
};
