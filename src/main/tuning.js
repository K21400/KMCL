const fs = require('fs');
const os = require('os');
const path = require('path');

/** 统计实例 mods 目录里的 jar 数量，用于估算内存需求 */
function countMods(gameDir) {
  try {
    return fs.readdirSync(path.join(gameDir, 'mods')).filter((f) => f.toLowerCase().endsWith('.jar')).length;
  } catch (e) {
    return 0;
  }
}

/**
 * 自动调节运行配置：按物理内存、Java 大版本、mod 数量给出 -Xms / -Xmx 与 GC 参数。
 * 原则：给系统留出至少 2 GB，最大不超过物理内存的 60%，并限制在 512 MB - 12 GB 之间。
 */
function recommend(opts = {}) {
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  const javaMajor = Number(opts.javaMajor) || 8;
  const modsCount = Number(opts.modsCount) || 0;
  const modern = javaMajor >= 17;

  // 基础上限：按物理内存分档
  let max;
  if (totalMb >= 32000) max = 8192;
  else if (totalMb >= 16000) max = 6144;
  else if (totalMb >= 12000) max = 4608;
  else if (totalMb >= 8000) max = 3072;
  else if (totalMb >= 6000) max = 2048;
  else max = 1536;

  // 模组越多，堆内存需求越大（每 50 个 mod 约 +512 MB，最多 +2048）
  if (modsCount > 0) {
    const extra = Math.min(2048, Math.ceil(modsCount / 50) * 512);
    max += extra;
  }
  // 大版本客户端（1.17+）本身更吃内存
  if (modern) max += 512;

  // 不超过物理内存的 60%，且给系统留 2 GB
  max = Math.min(max, Math.floor((totalMb - 2048) * 0.6));
  max = Math.max(1024, Math.min(12288, Math.round(max / 256) * 256));

  const min = Math.min(max, Math.max(512, Math.round((max / 4) / 256) * 256));

  const args = modern
    ? ['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=50', '-XX:+UnlockExperimentalVMOptions']
    : ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=50'];

  const reasons = [
    `物理内存 ${(totalMb / 1024).toFixed(1)} GB`,
    `Java ${javaMajor}${modern ? '（新版 GC 参数）' : ''}`,
    modsCount > 0 ? `检测到 ${modsCount} 个 mod` : '未检测到 mod'
  ];

  return { minMemory: min, maxMemory: max, jvmArgs: args.join(' '), reason: reasons.join(' · ') };
}

module.exports = { recommend, countMods };
