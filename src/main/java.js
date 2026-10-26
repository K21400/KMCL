const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function execFileSafe(file, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function candidateRoots() {
  const home = os.homedir();
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  const roots = [
    process.env.JAVA_HOME,
    path.join(pf, 'Java'),
    path.join(pf86, 'Java'),
    path.join(pf, 'Eclipse Adoptium'),
    path.join(pf, 'Eclipse Foundation'),
    path.join(pf, 'AdoptOpenJDK'),
    path.join(pf, 'Microsoft'),
    path.join(pf, 'Zulu'),
    path.join(pf, 'BellSoft'),
    path.join(pf, 'Amazon Corretto'),
    path.join(pf, 'IBM'),
    path.join(pf, 'Semeru'),
    path.join(pf, 'GraalVM'),
    path.join(pf, 'Common Files', 'Oracle', 'Java'),
    path.join(pf, 'Android', 'Android Studio', 'jbr'),
    path.join(pf, 'JetBrains'),
    path.join(localAppData, 'Programs', 'Eclipse Adoptium'),
    path.join(localAppData, 'Programs', 'Microsoft'),
    path.join(localAppData, 'JetBrains', 'Toolbox', 'apps'),
    path.join(home, '.jdks'),
    path.join(home, 'scoop', 'apps'),
    path.join(home, '.sdkman', 'candidates', 'java'),
    path.join(appData, '.minecraft', 'runtime')
  ].filter(Boolean);

  return roots;
}

function findJavaExes(root, depth = 0, found = []) {
  if (depth > 5 || found.length > 200) return found;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === 'bin') {
      const exe = path.join(full, process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(exe)) {
        found.push(exe);
        continue;
      }
    }
    if (entry.name === 'jre' || entry.name === 'bin' || entry.name.startsWith('.')) continue;
    findJavaExes(full, depth + 1, found);
  }
  return found;
}

function parseReleaseFile(home) {
  const tries = [path.join(home, 'release'), path.join(home, '..', 'release')];
  for (const file of tries) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const versionMatch = text.match(/JAVA_VERSION="([^"]+)"/);
      const archMatch = text.match(/OS_ARCH="([^"]+)"/);
      const implMatch = text.match(/IMPLEMENTOR="([^"]*)"/);
      if (versionMatch) {
        return {
          version: versionMatch[1],
          archText: archMatch ? archMatch[1] : '',
          vendor: implMatch ? implMatch[1] : ''
        };
      }
    } catch (e) {
      // 继续尝试下一个位置
    }
  }
  return null;
}

function majorFromVersion(version) {
  if (!version) return 0;
  const cleaned = String(version).trim();
  if (cleaned.startsWith('1.')) {
    const n = parseInt(cleaned.split('.')[1], 10);
    return Number.isFinite(n) ? n : 0;
  }
  const n = parseInt(cleaned.split(/[._-]/)[0], 10);
  return Number.isFinite(n) ? n : 0;
}

async function describeJava(exe) {
  const home = path.dirname(path.dirname(exe));
  let info = parseReleaseFile(home);
  let version = info ? info.version : '';
  let vendor = info ? info.vendor : '';
  let archText = info ? info.archText : '';
  if (!version) {
    const { stdout, stderr } = await execFileSafe(exe, ['-version']);
    const text = `${stdout}\n${stderr}`;
    const m = text.match(/version\s+"([^"]+)"/);
    if (m) version = m[1];
    const vm = text.match(/(?:Java HotSpot|OpenJDK|Eclipse Adoptium|Microsoft|Zulu|GraalVM|Corretto)[^\n]*/);
    if (vm && !vendor) vendor = vm[0].trim();
  }
  const major = majorFromVersion(version);
  let is64 = true;
  if (/x86_64|amd64|aarch64/i.test(archText)) is64 = true;
  else if (/^x86$/i.test(archText)) is64 = false;
  else if (/\(x86\)/i.test(home)) is64 = false;
  if (!version) return null;
  if (!major) return null;
  return {
    path: exe,
    home,
    version,
    major,
    vendor: vendor || '',
    bits: is64 ? 64 : 32,
    is64
  };
}

async function registryJavaHomes() {
  const keys = [
    'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
    'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Development Kit',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Runtime Environment'
  ];
  const homes = [];
  for (const key of keys) {
    const { stdout } = await execFileSafe('reg', ['query', key, '/s', '/v', 'JavaHome']);
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/JavaHome\s+REG_SZ\s+(.+)$/i);
      if (m) homes.push(m[1].trim());
    }
  }
  return homes;
}

async function whereJava() {
  if (process.platform !== 'win32') return [];
  const { stdout } = await execFileSafe('where', ['java']);
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /java\.exe$/i.test(s));
}

/**
 * 扫描本机所有可用的 Java。
 */
async function scanJava() {
  const exes = new Set();

  const roots = candidateRoots();
  for (const root of roots) {
    for (const exe of findJavaExes(root)) exes.add(exe);
  }

  const homes = await registryJavaHomes();
  for (const home of homes) {
    const exe = path.join(home, 'bin', 'java.exe');
    if (fs.existsSync(exe)) exes.add(exe);
  }

  for (const exe of await whereJava()) exes.add(exe);

  const list = [];
  const seenReal = new Set();
  for (const exe of exes) {
    let real = exe;
    try {
      real = fs.realpathSync(exe);
    } catch (e) {}
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    const info = await describeJava(exe);
    if (info) list.push(info);
  }

  list.sort((a, b) => b.major - a.major || compareVersion(b.version, a.version));
  return list;
}

function compareVersion(a, b) {
  const pa = String(a).split(/[._+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[._+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 按版本需求挑选 Java：优先精确匹配大版本，其次选择大于需求的最低版本。
 */
function pickJava(javas, requiredMajor) {
  const req = requiredMajor || 8;
  const usable = javas.filter((j) => j.major >= req && j.is64 !== false);
  if (!usable.length) return javas.filter((j) => j.major >= req).sort((a, b) => a.major - b.major)[0] || null;
  const exact = usable.filter((j) => j.major === req);
  if (exact.length) return exact.sort((a, b) => compareVersion(b.version, a.version))[0];
  return usable.sort((a, b) => a.major - b.major || compareVersion(b.version, a.version))[0];
}

async function validateJava(exe) {
  if (!exe || !fs.existsSync(exe)) return null;
  return describeJava(exe);
}

module.exports = { scanJava, pickJava, validateJava, describeJava, majorFromVersion };
