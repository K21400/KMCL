const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USER_AGENT = 'KMCL/1.0.0 (Minecraft Launcher)';

// 复用连接，减少高并发下载时的 TLS 握手开销
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64 })
};

// 记录各下载源的健康度：超时/低速会累计罚分，从而自动降低其优先级（5 分钟后自动衰减）
const hostPenalty = new Map();
const PENALTY_TTL = 5 * 60 * 1000;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
}

function penaltyOf(host) {
  const entry = hostPenalty.get(host);
  if (!entry) return 0;
  return Date.now() - entry.at > PENALTY_TTL ? 0 : entry.score;
}

function penalizeHost(url) {
  const host = hostOf(url);
  if (!host) return;
  const prev = penaltyOf(host);
  hostPenalty.set(host, { score: prev + 1, at: Date.now() });
}

function sortByHealth(urls) {
  return [...urls].sort((a, b) => penaltyOf(hostOf(a)) - penaltyOf(hostOf(b)));
}

function isTimeoutError(e) {
  if (!e) return false;
  if (/超时|timeout|ECONNRESET|socket hang up|ETIMEDOUT/i.test(e.message || '')) return true;
  return e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET';
}

class CancelledError extends Error {
  constructor() {
    super('任务已取消');
    this.cancelled = true;
  }
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw new CancelledError();
}

function openStream(rawUrl, { headers = {}, timeout = 30000, redirects = 10, signal } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (e) {
      reject(new Error('无效的下载地址: ' + rawUrl));
      return;
    }
    if (signal && signal.aborted) {
      reject(new CancelledError());
      return;
    }
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.get(
      url,
      {
        agent: agents[url.protocol],
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers }
      },
      (res) => {
        const status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          resolve(openStream(next, { headers, timeout, redirects: redirects - 1, signal }));
          return;
        }
        if (status !== 200 && status !== 206) {
          res.resume();
          const err = new Error(`HTTP ${status}`);
          err.statusCode = status;
          reject(err);
          return;
        }
        resolve(res);
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('连接超时')));
    req.on('error', (e) => reject(e));
    if (signal) {
      signal.addEventListener('abort', () => req.destroy(new CancelledError()), { once: true });
    }
  });
}

async function readAll(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * 多源竞速：同时向所有候选地址发起请求，第一个成功返回的结果胜出，
 * 其余请求立即中断。用于小文件（清单 / 版本 json / maven 元数据）。
 */
async function raceFirst(urls, worker) {
  const list = [...new Set(urls.filter(Boolean))];
  if (!list.length) throw new Error('没有可用的下载地址');
  if (list.length === 1) return worker(list[0], null);

  const controllers = list.map(() => new AbortController());
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = list.length;
    let lastErr = null;
    const fail = (e) => {
      lastErr = e;
      pending -= 1;
      if (pending === 0 && !settled) {
        settled = true;
        reject(lastErr);
      }
    };
    list.forEach((url, i) => {
      worker(url, controllers[i].signal).then(
        (value) => {
          if (settled) return;
          settled = true;
          controllers.forEach((c, j) => {
            if (j !== i) c.abort();
          });
          resolve(value);
        },
        fail
      );
    });
  });
}

async function fetchBuffer(urls, { timeout = 30000, signal, retries = 2 } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr;
  for (const url of list) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      checkAbort(signal);
      try {
        const res = await openStream(url, { timeout });
        return await readAll(res);
      } catch (e) {
        lastErr = e;
        if (e.cancelled) throw e;
        if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) break;
        if (isTimeoutError(e)) {
          penalizeHost(url);
          break;
        }
      }
    }
  }
  throw new Error('下载失败 ' + list[list.length - 1] + ': ' + (lastErr && lastErr.message));
}

/** 竞速版本的缓冲下载：优先返回最先成功的源 */
async function fetchBufferFast(urls, { timeout = 20000, signal } = {}) {
  return raceFirst(urls, (url, ctl) => {
    checkAbort(signal);
    return (async () => {
      const res = await openStream(url, { timeout, signal: ctl });
      if (ctl) {
        ctl.addEventListener('abort', () => res.destroy(new CancelledError()), { once: true });
      }
      return readAll(res);
    })();
  });
}

async function fetchJson(urls, opts = {}) {
  const buf = opts.race ? await fetchBufferFast(urls, opts) : await fetchBuffer(urls, opts);
  try {
    return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error('返回内容不是有效的 JSON');
  }
}

async function fetchText(urls, opts = {}) {
  const buf = opts.race ? await fetchBufferFast(urls, opts) : await fetchBuffer(urls, opts);
  return buf.toString('utf8');
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function isComplete(dest, size, sha1) {
  let stat;
  try {
    stat = fs.statSync(dest);
  } catch (e) {
    return false;
  }
  if (!stat.isFile() || stat.size === 0) return false;
  if (sha1) {
    try {
      return (await sha1File(dest)) === sha1.toLowerCase();
    } catch (e) {
      return false;
    }
  }
  if (size && size > 0) return stat.size === size;
  return true;
}

async function downloadFrom(
  url,
  partFile,
  dest,
  { size, sha1, onBytes, signal, timeout, firstByteTimeout, headers: extraHeaders, minRate }
) {
  let start = 0;
  try {
    start = fs.statSync(partFile).size;
  } catch (e) {
    start = 0;
  }
  if (size && start > size) start = 0;

  const headers = { ...(extraHeaders || {}) };
  if (start > 0) headers.Range = `bytes=${start}-`;
  checkAbort(signal);
  const res = await openStream(url, { timeout: timeout || 60000, headers });
  const resuming = res.statusCode === 206 && start > 0;
  if (!resuming) start = 0;

  // 镜像节点可能出现「连上了但迟迟不给数据」的情况，超时后交给下一个下载源
  let idleTimer = null;
  const stopIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  if (firstByteTimeout) {
    idleTimer = setTimeout(() => res.destroy(new Error('镜像响应超时')), firstByteTimeout);
  }

  // 持续低速同样视为不可用（部分镜像节点会以几 KB/s 拖住整批下载）
  let receivedBytes = 0;
  let windowStart = Date.now();
  let windowBytes = 0;
  const slowTimer = setInterval(() => {
    const now = Date.now();
    const secs = (now - windowStart) / 1000;
    if (secs < 6) return;
    const rate = (receivedBytes - windowBytes) / secs;
    windowStart = now;
    windowBytes = receivedBytes;
    const finished = size ? receivedBytes >= size : false;
    if (!finished && rate < (minRate || 60 * 1024)) {
      res.destroy(new Error('镜像响应超时'));
    }
  }, 6000);

  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(partFile, resuming ? { flags: 'a' } : { flags: 'w' });
      let received = 0;
      const done = (err) => {
        stopIdleTimer();
        clearInterval(slowTimer);
        out.close(() => (err ? reject(err) : resolve()));
      };
      res.on('data', (chunk) => {
        stopIdleTimer();
        receivedBytes += chunk.length;
        if (signal && signal.aborted) {
          res.destroy(new CancelledError());
          return;
        }
        received += chunk.length;
        if (onBytes) onBytes(chunk.length);
      });
      res.on('error', (e) => {
        out.destroy();
        done(e);
      });
      out.on('error', (e) => {
        res.destroy();
        done(e);
      });
      res.pipe(out);
      out.on('finish', () => done(null));
    });
  } finally {
    stopIdleTimer();
    clearInterval(slowTimer);
  }

  const finalSize = fs.statSync(partFile).size;
  if (size && finalSize !== size) {
    throw new Error(`文件大小不一致（期望 ${size}，实际 ${finalSize}）`);
  }
  if (sha1) {
    const got = await sha1File(partFile);
    if (got !== sha1.toLowerCase()) {
      try {
        fs.unlinkSync(partFile);
      } catch (e) {}
      throw new Error('文件校验失败 (SHA1)');
    }
  }
  fs.renameSync(partFile, dest);
}

async function download(urls, dest, opts = {}) {
  const { size, sha1, onBytes, signal, retries = 2, timeout = 60000, firstByteTimeout, headers, minRate } = opts;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (await isComplete(dest, size, sha1)) return { skipped: true };

  const list = sortByHealth((Array.isArray(urls) ? urls : [urls]).filter(Boolean));
  const partFile = dest + '.part';
  let lastErr;
  for (const url of list) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      checkAbort(signal);
      try {
        await downloadFrom(url, partFile, dest, {
          size,
          sha1,
          onBytes,
          signal,
          timeout,
          firstByteTimeout,
          headers,
          minRate
        });
        return { skipped: false };
      } catch (e) {
        lastErr = e;
        if (e.cancelled || (signal && signal.aborted)) throw e;
        // 4xx/5xx 说明该地址本身有问题，重试同一地址没有意义
        if (e.statusCode && e.statusCode >= 400) break;
        // 超时类错误说明该节点当前不可用：多源时换源，单源时换一次负载均衡节点
        if (isTimeoutError(e)) {
          penalizeHost(url);
          if (list.length > 1) break;
        }
      }
    }
  }
  throw new Error(`下载失败: ${path.basename(dest)} (${lastErr ? lastErr.message : '未知错误'})`);
}

/**
 * 多通道并发下载：同一地址在不同通道会命中不同的镜像节点，任一通道完成即采用。
 * 用于镜像节点质量随机、单通道可能极慢的小文件（如 OptiFine 安装包）。
 */
async function downloadFast(urls, dest, opts = {}) {
  const lanes = Math.max(1, Number(opts.lanes) || 3);
  if (lanes === 1) return download(urls, dest, opts);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const laneFiles = [];
  const controllers = [];
  const promises = [];
  const cleanup = () => {
    for (const file of laneFiles) {
      for (const target of [file, `${file}.part`]) {
        try {
          fs.rmSync(target, { force: true });
        } catch (e) {}
      }
    }
  };
  // Windows 上文件句柄释放有延迟，重复尝试避免残留 .laneN.part
  const cleanupLanes = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      cleanup();
      if (!laneFiles.some((f) => fs.existsSync(f) || fs.existsSync(`${f}.part`))) return;
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  };

  for (let i = 0; i < lanes; i++) {
    const laneFile = `${dest}.lane${i}`;
    // 上次异常退出可能留下通道临时文件，必须清掉，否则会被误判为「已完成」
    for (const stale of [laneFile, `${laneFile}.part`]) {
      try {
        fs.rmSync(stale, { force: true });
      } catch (e) {}
    }
    laneFiles.push(laneFile);
    const controller = new AbortController();
    controllers.push(controller);
    promises.push(
      download(urls, laneFile, {
        ...opts,
        // 首通道上报进度，避免多通道重复计数
        onBytes: i === 0 ? opts.onBytes : undefined,
        signal: controller.signal,
        retries: opts.retries == null ? 2 : opts.retries
      }).then(() => i)
    );
  }

  try {
    const index = await Promise.any(promises);
    fs.renameSync(laneFiles[index], dest);
    controllers.forEach((c, i) => {
      if (i !== index) c.abort();
    });
    // 等待其余通道真正关闭文件句柄后再清理，否则 Windows 上会残留 .laneN.part
    await Promise.allSettled(promises);
    await cleanupLanes();
    return { skipped: false };
  } catch (e) {
    if (opts.signal && opts.signal.aborted) throw new CancelledError();
    // 多通道同时发起的首个连接可能被镜像短暂拒绝：全部失败时回退单通道再试一次
    if (lanes > 1) {
      await Promise.allSettled(promises);
      await cleanupLanes();
      try {
        return await download(urls, dest, { ...opts, retries: opts.retries == null ? 2 : opts.retries });
      } catch (fallbackError) {
        throw new Error(`下载失败: ${path.basename(dest)} (${fallbackError.message || '未知错误'})`);
      }
    }
    throw new Error(`下载失败: ${path.basename(dest)} (${(e && e.message) || '未知错误'})`);
  } finally {
    // 兜底：句柄释放较慢时再清理一次
    setTimeout(cleanup, 2000);
  }
}

module.exports = {
  USER_AGENT,
  CancelledError,
  checkAbort,
  openStream,
  fetchBuffer,
  fetchJson,
  fetchText,
  download,
  downloadFast,
  isComplete,
  sha1File
};
