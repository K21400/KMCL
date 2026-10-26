const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const version = require('./version');
const source = require('./source');
const javaUtil = require('./java');
const installer = require('./installer');
const instance = require('./instance');
const tuning = require('./tuning');

const CLIENT_ID = 'kmcl-launcher';

function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function offlineToken() {
  return crypto.randomBytes(16).toString('hex');
}

function replaceVars(input, vars) {
  if (typeof input !== 'string') return input;
  return input.replace(/\$\{([^}]+)\}/g, (m, key) => (vars[key] !== undefined ? String(vars[key]) : ''));
}

function evalArgument(arg, vars, features) {
  if (typeof arg === 'string') return [replaceVars(arg, vars)];
  if (!arg || typeof arg !== 'object') return [];
  if (arg.rules && !version.rulesAllow(arg.rules, features)) return [];
  const value = arg.value;
  if (Array.isArray(value)) return value.map((v) => replaceVars(v, vars));
  if (typeof value === 'string') return [replaceVars(value, vars)];
  return [];
}

function buildArguments(detail, ctx) {
  const features = {
    is_demo_user: false,
    has_custom_resolution: false,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false
  };
  const vars = {
    auth_player_name: ctx.username,
    version_name: ctx.versionId,
    game_directory: ctx.gameDir,
    assets_root: path.join(ctx.rootDir, 'assets'),
    assets_index_name: ctx.assetIndexName || '',
    auth_uuid: ctx.uuid,
    auth_access_token: ctx.accessToken,
    auth_session: `token:${ctx.accessToken}:${ctx.uuid}`,
    user_type: ctx.userType || 'legacy',
    user_properties: '{}',
    version_type: detail.type || 'release',
    clientid: CLIENT_ID,
    auth_xuid: ctx.xuid || '',
    resolution_width: '854',
    resolution_height: '480',
    launcher_name: 'KMCL',
    launcher_version: '1.0.0',
    classpath: ctx.classpath,
    classpath_separator: ';',
    natives_directory: ctx.nativesDir,
    library_directory: path.join(ctx.rootDir, 'libraries')
  };

  const gameArgs = [];
  if (detail.arguments && detail.arguments.game) {
    for (const arg of detail.arguments.game) gameArgs.push(...evalArgument(arg, vars, features));
  } else if (detail.minecraftArguments) {
    for (const piece of String(detail.minecraftArguments).split(' ')) {
      gameArgs.push(replaceVars(piece, vars));
    }
  }

  const jvmArgs = [];
  if (detail.arguments && detail.arguments.jvm) {
    for (const arg of detail.arguments.jvm) jvmArgs.push(...evalArgument(arg, vars, features));
  }
  return { gameArgs, jvmArgs, vars };
}

function prepareNatives(detail, gameDir, versionId, cfg) {
  const nativesDir = path.join(version.versionDir(gameDir, versionId), 'natives');
  try {
    fs.rmSync(nativesDir, { recursive: true, force: true });
  } catch (e) {}
  fs.mkdirSync(nativesDir, { recursive: true });

  const libs = version.collectLibraries(cfg, detail).filter((l) => l.native);
  for (const lib of libs) {
    const jarPath = path.join(installer.librariesDir(gameDir), lib.path);
    if (!fs.existsSync(jarPath)) continue;
    let zip;
    try {
      zip = new AdmZip(jarPath);
    } catch (e) {
      continue;
    }
    const excludes = (lib.extract && lib.extract.exclude) || ['META-INF/'];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.replace(/\\/g, '/');
      if (excludes.some((ex) => name.startsWith(ex))) continue;
      const dest = path.join(nativesDir, name);
      if (!dest.startsWith(nativesDir)) continue;
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
      } catch (e) {
        // 个别重复dll忽略
      }
    }
  }
  return nativesDir;
}

async function ensureFiles(cfg, versionId, progress, signal, onLog) {
  const resolved = version.resolveFullVersion(cfg.gameDir, versionId);
  const merged = resolved.json;
  const libs = version.collectLibraries(cfg, merged);
  const missing = [];
  for (const lib of libs) {
    if (!fs.existsSync(path.join(installer.librariesDir(cfg.gameDir), lib.path))) missing.push(lib.path);
  }
  const jarPath = path.join(version.versionDir(cfg.gameDir, resolved.baseId), `${resolved.baseId}.jar`);
  if (!fs.existsSync(jarPath)) missing.push(`${resolved.baseId}.jar`);
  if (missing.length) {
    if (onLog) onLog(`[KMCL] 检测到 ${missing.length} 个缺失文件，正在自动补齐…`);
    await installer.installVersion(cfg, versionId, { progress, signal });
  }
  return resolved;
}

/**
 * 启动游戏
 */
async function launchGame({ cfg, versionId, account, progress, signal, onLog, onExit }) {
  const rootDir = cfg.gameDir;
  // 版本隔离：独立目录下拥有自己的存档、mods 与配置
  const isolated = instance.isIsolated(cfg, versionId);
  const gameDir = isolated ? instance.ensureInstance(cfg, versionId) : rootDir;
  // 首次启动前补齐简体中文与界面缩放，避免 HUD / 血量 / 饥饿值显示异常
  instance.ensureGameOptions(gameDir);
  const resolved = await ensureFiles(cfg, versionId, progress, signal, onLog);
  const detail = resolved.json;

  // 选择 Java
  const requiredMajor = (detail.javaVersion && detail.javaVersion.majorVersion) || 8;
  let javaInfo = null;
  if (cfg.javaPath) javaInfo = await javaUtil.validateJava(cfg.javaPath);
  if (!javaInfo) {
    const javas = await javaUtil.scanJava();
    javaInfo = javaUtil.pickJava(javas, requiredMajor);
  }
  if (!javaInfo) {
    throw new Error(`未找到可用的 Java（该版本需要 Java ${requiredMajor} 或更高）。请到“设置”页面手动指定 Java 路径。`);
  }
  if (onLog) onLog(`[KMCL] 使用 Java: ${javaInfo.path} (Java ${javaInfo.version})`);

  // 自动调节：按物理内存、Java 大版本与 mod 数量动态计算堆内存与 GC 参数
  let tune = null;
  if (cfg.autoTune) {
    tune = tuning.recommend({ javaMajor: javaInfo.major || requiredMajor, modsCount: tuning.countMods(gameDir) });
    if (onLog) onLog(`[KMCL] 自动调节：${tune.minMemory} - ${tune.maxMemory} MB（${tune.reason}）`);
  }

  // 资源索引
  const assetIndexName = (detail.assetIndex && detail.assetIndex.id) || detail.assets || '';

  // natives
  progress.startPhase('准备启动文件', 1);
  const nativesDir = prepareNatives(detail, rootDir, versionId, cfg);
  progress.completeTask();

  // classpath
  const libs = version.collectLibraries(cfg, detail);
  const cpParts = libs
    .filter((l) => !l.native)
    .map((l) => path.join(installer.librariesDir(rootDir), l.path));
  // 加载器版本目录下的 <id>.jar 是原版 jar 的副本，Forge 的 ignoreList 依赖这个命名
  const ownJar = path.join(version.versionDir(rootDir, versionId), `${versionId}.jar`);
  const baseJar = fs.existsSync(ownJar)
    ? ownJar
    : path.join(version.versionDir(rootDir, resolved.baseId), `${resolved.baseId}.jar`);
  cpParts.push(baseJar);
  const classpath = cpParts.join(';');

  const usingAccount = !!(account && account.accessToken && account.uuid);
  const username = usingAccount ? account.name : cfg.username || 'Steve';
  const uuid = usingAccount ? account.uuid : offlineUuid(username);
  const accessToken = usingAccount ? account.accessToken : offlineToken();

  const { gameArgs, jvmArgs } = buildArguments(detail, {
    username,
    versionId,
    gameDir,
    rootDir,
    uuid,
    accessToken,
    userType: usingAccount ? 'msa' : 'legacy',
    xuid: usingAccount ? account.xuid || '' : '',
    classpath,
    nativesDir,
    assetIndexName,
    type: detail.type
  });

  const logConfig = detail.logging && detail.logging.client && detail.logging.client.file;
  const jvm = [...jvmArgs];
  if (logConfig) {
    jvm.push(`-Dlog4j.configurationFile=${path.join(installer.assetsDir(rootDir), 'log_configs', logConfig.id)}`);
  }
  if (!jvm.some((a) => a === '-Djava.library.path' || a.startsWith('-Djava.library.path='))) {
    jvm.push(`-Djava.library.path=${nativesDir}`);
  }
  jvm.push(`-Dminecraft.launcher.brand=KMCL`, '-Dminecraft.launcher.version=1.0.0');

  const minMemory = tune ? tune.minMemory : Math.max(256, Number(cfg.minMemory) || 512);
  const maxMemory = tune ? tune.maxMemory : Math.max(minMemory, Number(cfg.maxMemory) || 2048);
  const userJvm = [`-Xms${minMemory}M`, `-Xmx${maxMemory}M`];
  const extraArgs = tune ? tune.jvmArgs : cfg.jvmArgs;
  if (extraArgs && extraArgs.trim()) {
    userJvm.push(...extraArgs.trim().split(/\s+/));
  }

  const hasCp = jvm.some((a) => a === '-cp' || a === '-classpath');
  const finalArgs = [...jvm, ...userJvm];
  if (!hasCp) finalArgs.push('-cp', classpath);
  finalArgs.push(detail.mainClass || 'net.minecraft.client.main.Main', ...gameArgs);

  fs.mkdirSync(path.join(gameDir, 'logs'), { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .slice(0, 19);
  const logFile = path.join(gameDir, 'logs', `kmcl-${stamp}.log`);

  if (onLog) {
    onLog(`[KMCL] 游戏目录: ${gameDir}${isolated ? '（版本隔离）' : ''}`);
    onLog(`[KMCL] 账号: ${username}（${usingAccount ? '正版 Microsoft' : '离线'}）`);
    onLog(`[KMCL] 内存分配: ${minMemory}MB - ${maxMemory}MB`);
    onLog(`[KMCL] 启动命令: ${javaInfo.path} ${finalArgs.join(' ')}`);
  }

  const child = spawn(javaInfo.path, finalArgs, {
    cwd: gameDir,
    windowsHide: false,
    env: { ...process.env }
  });

  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.write(`# KMCL launch ${new Date().toISOString()}\n# ${javaInfo.path} ${finalArgs.join(' ')}\n`);

  const forward = (chunk) => {
    const text = chunk.toString('utf8');
    logStream.write(text);
    if (onLog) onLog(text.replace(/\r?\n$/, ''));
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);

  child.on('error', (err) => {
    logStream.end();
    if (onLog) onLog(`[KMCL] 启动失败: ${err.message}`);
    if (onExit) onExit({ code: -1, error: err.message });
  });

  child.on('exit', (code, sig) => {
    logStream.end();
    if (onLog) onLog(`[KMCL] 游戏进程退出，代码 ${code}${sig ? '，信号 ' + sig : ''}`);
    if (onExit) onExit({ code, signal: sig, logFile });
  });

  return { pid: child.pid, logFile, java: javaInfo };
}

module.exports = { launchGame, offlineUuid, buildArguments, prepareNatives };
