const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Microsoft 正版登录。
 *
 * 使用 Windows Live 的设备代码流程（device code），这是官方 Minecraft 启动器使用的
 * 公开客户端标识，第三方启动器同样适用。流程为：
 *   设备代码登录 → Microsoft 账号令牌 → Xbox Live 用户令牌 → XSTS → Minecraft 令牌
 * 登录成功后保存 refresh_token，后续启动静默刷新，无需重复输入代码。
 */

const LIVE_CLIENT_ID = '00000000402b5328';
const LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const XBL_USER_AUTH = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_XBOX = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_ENTITLEMENTS = 'https://api.minecraftservices.com/entitlements/mcstore';
const MC_PROFILE = 'https://api.minecraftservices.com/minecraft/profile';

const XERR_MESSAGES = {
  2148916227: '该账号因违反 Xbox 社区规范被封禁，无法登录。',
  2148916229: '该账号的在线游戏权限已被家长或监护人限制。',
  2148916233: '该账号还没有 Xbox 档案，请先到 https://signup.live.com 创建。',
  2148916234: '该账号尚未同意 Xbox 服务条款，请先登录 Xbox 官网同意条款。',
  2148916235: '该账号所在地区不被 Xbox 支持，无法登录。',
  2148916236: '该账号需要进行年龄验证，请到 https://login.live.com 完成验证。',
  2148916237: '该账号已达到游玩时间限制，暂时无法登录。',
  2148916238: '该账号未满 18 岁，需由家长加入家庭组后才能登录。'
};

function accountsFile() {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(accountsFile(), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function writeStore(data) {
  fs.mkdirSync(path.dirname(accountsFile()), { recursive: true });
  fs.writeFileSync(accountsFile(), JSON.stringify(data, null, 2), 'utf8');
}

function readAccount() {
  return readStore().account || null;
}

function saveAccount(account) {
  const store = readStore();
  store.account = account;
  writeStore(store);
}

function clearAccount() {
  const store = readStore();
  delete store.account;
  writeStore(store);
}

/** 对外只暴露展示信息，令牌不出主进程。 */
function publicAccount() {
  const account = readAccount();
  if (!account || !account.refreshToken) return null;
  return {
    name: account.name || '',
    uuid: account.uuid || '',
    xuid: account.xuid || '',
    savedAt: account.savedAt || 0
  };
}

function headers(extra = {}) {
  return {
    Accept: 'application/json',
    'User-Agent': 'MinecraftLauncher/2.2.10675',
    ...extra
  };
}

async function requestJson(url, { method = 'GET', body, form, headers: extra, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const opts = { method, headers: headers(extra), signal: controller.signal };
    if (form) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = { raw: text };
    }
    return { status: res.status, data, setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
  } finally {
    clearTimeout(timer);
  }
}

function tokenErrorText(data) {
  if (!data) return '未知错误';
  if (data.error_description) return String(data.error_description);
  if (data.error) return String(data.error);
  return '未知错误';
}

/** 申请设备代码，供界面向用户展示。 */
async function startDeviceCode() {
  const res = await requestJson(DEVICE_CODE_URL, {
    method: 'POST',
    form: {
      scope: LIVE_SCOPE,
      client_id: LIVE_CLIENT_ID,
      response_type: 'device_code'
    }
  });
  if (res.status !== 200 || !res.data || !res.data.device_code) {
    throw new Error(`申请登录代码失败：${tokenErrorText(res.data)}`);
  }
  return {
    userCode: res.data.user_code,
    deviceCode: res.data.device_code,
    verificationUri: res.data.verification_uri,
    interval: Math.max(2, Number(res.data.interval) || 5),
    expiresIn: Number(res.data.expires_in) || 900
  };
}

/** 轮询设备代码，直到用户完成授权、超时或取消。 */
async function waitForToken(deviceCode, interval, expiresIn, signal) {
  const deadline = Date.now() + expiresIn * 1000;
  let wait = interval;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error('已取消登录');
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    if (signal && signal.aborted) throw new Error('已取消登录');
    const res = await requestJson(`${TOKEN_URL}?client_id=${encodeURIComponent(LIVE_CLIENT_ID)}`, {
      method: 'POST',
      form: {
        client_id: LIVE_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      }
    });
    if (res.data && !res.data.error && res.data.access_token) return res.data;
    const error = (res.data && res.data.error) || '';
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      wait += 5;
      continue;
    }
    if (error === 'expired_token' || error === 'code_expired') {
      throw new Error('登录代码已过期，请重新发起登录');
    }
    if (error === 'authorization_declined') throw new Error('用户拒绝了登录授权');
    throw new Error(`登录失败：${tokenErrorText(res.data)}`);
  }
  throw new Error('登录超时，请重新发起登录');
}

/** 用 refresh_token 获取新的 Microsoft 访问令牌。 */
async function refreshMsaToken(refreshToken) {
  const res = await requestJson(`${TOKEN_URL}?client_id=${encodeURIComponent(LIVE_CLIENT_ID)}`, {
    method: 'POST',
    form: {
      client_id: LIVE_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: LIVE_SCOPE
    }
  });
  if (!res.data || res.data.error || !res.data.access_token) {
    const error = (res.data && res.data.error) || '';
    if (error === 'invalid_grant') throw new Error('正版登录已失效，请重新登录 Microsoft 账号');
    throw new Error(`刷新登录令牌失败：${tokenErrorText(res.data)}`);
  }
  return res.data;
}

async function xboxUserToken(msaAccessToken) {
  const res = await requestJson(XBL_USER_AUTH, {
    method: 'POST',
    body: {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `t=${msaAccessToken}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    }
  });
  if (res.status !== 200 || !res.data || !res.data.Token) {
    throw new Error(`Xbox Live 认证失败（HTTP ${res.status}）`);
  }
  const claims = (res.data.DisplayClaims && res.data.DisplayClaims.xui && res.data.DisplayClaims.xui[0]) || {};
  return { token: res.data.Token, uhs: claims.uhs };
}

async function xstsToken(xblToken) {
  const res = await requestJson(XSTS_AUTH, {
    method: 'POST',
    body: {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    }
  });
  if (res.status === 401 || (res.data && res.data.XErr)) {
    const code = res.data && res.data.XErr;
    const message = XERR_MESSAGES[code] || `Xbox Live 认证被拒绝（XErr ${code || res.status}）`;
    throw new Error(message);
  }
  if (!res.data || !res.data.Token) throw new Error(`XSTS 认证失败（HTTP ${res.status}）`);
  const claims = (res.data.DisplayClaims && res.data.DisplayClaims.xui && res.data.DisplayClaims.xui[0]) || {};
  return { token: res.data.Token, uhs: claims.uhs, xuid: claims.xid };
}

async function minecraftToken(uhs, xsts) {
  const res = await requestJson(MC_LOGIN_XBOX, {
    method: 'POST',
    body: { identityToken: `XBL3.0 x=${uhs};${xsts}` }
  });
  if (res.status !== 200 || !res.data || !res.data.access_token) {
    throw new Error(`获取 Minecraft 令牌失败（HTTP ${res.status}）：${tokenErrorText(res.data)}`);
  }
  return res.data;
}

async function minecraftProfile(mcToken) {
  const res = await requestJson(MC_PROFILE, {
    headers: { Authorization: `Bearer ${mcToken}` }
  });
  if (res.status === 401 || res.status === 404 || !res.data || !res.data.id) {
    throw new Error('该 Microsoft 账号未拥有 Minecraft Java 版');
  }
  return { uuid: res.data.id, name: res.data.name };
}

async function checkEntitlements(mcToken) {
  try {
    const res = await requestJson(MC_ENTITLEMENTS, {
      headers: { Authorization: `Bearer ${mcToken}` }
    });
    if (res.status === 200 && res.data && Array.isArray(res.data.items) && res.data.items.length === 0) {
      throw new Error('该 Microsoft 账号未拥有 Minecraft Java 版');
    }
  } catch (e) {
    if (/未拥有/.test(e.message)) throw e;
    // 权限接口异常时不阻断登录，后续 profile 接口还会再校验一次
  }
}

/** 用 MSA 令牌走完整链路，返回可持久化的账号信息。 */
async function completeChain(msaToken) {
  const xbl = await xboxUserToken(msaToken.access_token);
  const xsts = await xstsToken(xbl.token);
  const mc = await minecraftToken(xsts.uhs, xsts.token);
  await checkEntitlements(mc.access_token);
  const profile = await minecraftProfile(mc.access_token);
  const now = Date.now();
  return {
    name: profile.name,
    uuid: profile.uuid,
    xuid: xsts.xuid || '',
    refreshToken: msaToken.refresh_token || '',
    accessToken: mc.access_token,
    expiresAt: now + (Number(mc.expires_in) || 86400) * 1000,
    savedAt: now
  };
}

/** 完整登录：展示设备代码 → 等待授权 → Xbox 链路 → 保存账号。 */
async function login({ onDeviceCode, signal }) {
  const device = await startDeviceCode();
  if (onDeviceCode) onDeviceCode(device);
  const msa = await waitForToken(device.deviceCode, device.interval, device.expiresIn, signal);
  const account = await completeChain(msa);
  saveAccount(account);
  return publicAccount();
}

/** 启动前获取可用会话，令牌过期则静默刷新。 */
async function getSession() {
  const account = readAccount();
  if (!account || !account.refreshToken) {
    throw new Error('尚未登录正版账号，请先在启动页点击“正版登录”');
  }
  if (account.accessToken && account.expiresAt && Date.now() < account.expiresAt - 5 * 60 * 1000) {
    return {
      name: account.name,
      uuid: account.uuid,
      accessToken: account.accessToken,
      xuid: account.xuid || '',
      userType: 'msa'
    };
  }
  const msa = await refreshMsaToken(account.refreshToken);
  const fresh = await completeChain(msa);
  saveAccount(fresh);
  return {
    name: fresh.name,
    uuid: fresh.uuid,
    accessToken: fresh.accessToken,
    xuid: fresh.xuid,
    userType: 'msa'
  };
}

module.exports = {
  login,
  getSession,
  publicAccount,
  clearAccount,
  readAccount,
  LIVE_CLIENT_ID
};
