const { CancelledError } = require('./http');

/**
 * 下载/安装任务进度收集器：汇总阶段、文件数、字节数与瞬时速度。
 */
class TaskProgress {
  constructor(emit, label = '') {
    this.emit = emit || (() => {});
    this.label = label;
    this.phase = '';
    this.taskTotal = 0;
    this.taskDone = 0;
    this.bytesDone = 0;
    this.bytesTotal = 0;
    this.speed = 0;
    this.startedAt = Date.now();
    this.lastEmitAt = 0;
    this.lastSpeedAt = Date.now();
    this.lastSpeedBytes = 0;
    this.finished = false;
  }

  startPhase(phase, taskTotal = 0, bytesTotal = 0) {
    this.phase = phase;
    this.taskTotal = taskTotal;
    this.taskDone = 0;
    this.bytesDone = 0;
    this.bytesTotal = bytesTotal;
    this.speed = 0;
    this.lastSpeedAt = Date.now();
    this.lastSpeedBytes = 0;
    this.flush(true);
  }

  setTotals(taskTotal, bytesTotal) {
    this.taskTotal = taskTotal;
    if (bytesTotal) this.bytesTotal = bytesTotal;
  }

  addBytes(n) {
    this.bytesDone += n;
    const now = Date.now();
    const dt = now - this.lastSpeedAt;
    if (dt >= 500) {
      const instant = ((this.bytesDone - this.lastSpeedBytes) * 1000) / dt;
      this.speed = Math.round(instant * 0.5 + this.speed * 0.5);
      this.lastSpeedAt = now;
      this.lastSpeedBytes = this.bytesDone;
    }
    this.flush(false);
  }

  completeTask() {
    this.taskDone += 1;
    this.flush(false);
  }

  flush(force) {
    const now = Date.now();
    if (!force && now - this.lastEmitAt < 150) return;
    this.lastEmitAt = now;
    // 剩余时间按当前速度估算（字节优先，其次文件数）
    let eta = null;
    if (!this.finished) {
      if (this.speed > 0 && this.bytesTotal > this.bytesDone) {
        eta = (this.bytesTotal - this.bytesDone) / this.speed;
      }
    }
    this.emit({
      phase: this.phase,
      label: this.label,
      taskTotal: this.taskTotal,
      taskDone: this.taskDone,
      bytesDone: this.bytesDone,
      bytesTotal: this.bytesTotal,
      speed: this.speed,
      eta,
      elapsed: Math.round((now - this.startedAt) / 1000),
      finished: this.finished
    });
  }

  finish() {
    this.finished = true;
    this.flush(true);
  }
}

/**
 * 并发执行任务池，任一任务失败会尽快中止其它任务。
 */
async function runPool(items, concurrency, worker, signal) {
  let index = 0;
  let firstError = null;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const runners = [];
  for (let i = 0; i < limit; i++) {
    runners.push(
      (async () => {
        while (true) {
          if (firstError) return;
          if (signal && signal.aborted) throw new CancelledError();
          const current = index++;
          if (current >= items.length) return;
          try {
            await worker(items[current], current);
          } catch (e) {
            if (!firstError) firstError = e;
            return;
          }
        }
      })()
    );
  }
  await Promise.all(runners);
  if (firstError) throw firstError;
}

module.exports = { TaskProgress, runPool };
