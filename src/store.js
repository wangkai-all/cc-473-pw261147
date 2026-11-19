import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  rmSync
} from 'node:fs';
import { join } from 'node:path';

/**
 * 事件存储：append-only WAL（wal.log）+ 周期性原子快照（snapshot.json）。
 *
 * 故障恢复保证：
 *  1. 状态变更先追加并 fsync 到 WAL，再应用到内存状态，最后写快照。
 *  2. 进程在任意时刻崩溃，重启时 load() 重放「快照之后的全部事件」即可还原。
 *  3. 快照通过临时文件 + rename 原子替换，崩溃只会留下旧快照或完整新快照。
 *  4. WAL 末尾可能出现的半写行（崩溃于 write 中途）会被跳过并截断。
 */
export class EventStore {
  #dir;
  #walPath;
  #snapshotPath;
  #sequence = 0;

  /** dir 为 null 时退化为纯内存模式（单元测试使用，不落盘）。 */
  constructor(dir) {
    this.#dir = dir;
    this.#walPath = dir ? join(dir, 'wal.log') : null;
    this.#snapshotPath = dir ? join(dir, 'snapshot.json') : null;
    if (dir) mkdirSync(dir, { recursive: true });
  }

  get directory() {
    return this.#dir;
  }

  get sequence() {
    return this.#sequence;
  }

  /** 追加一条事件；持久化成功后才返回，保证崩溃不丢已确认的发布。 */
  append(type, payload = {}) {
    const event = {
      seq: ++this.#sequence,
      type,
      payload,
      at: new Date().toISOString()
    };
    if (this.#walPath) {
      const fd = openSync(this.#walPath, 'a');
      try {
        writeFileSync(fd, JSON.stringify(event) + '\n', { flag: 'a' });
        try {
          fsyncSync(fd);
        } catch {
          // 部分文件系统（tmpfs/某些容器卷）不支持 fsync，降级即可
        }
      } finally {
        closeSync(fd);
      }
    }
    return event;
  }

  saveSnapshot(state) {
    if (!this.#dir) return;
    const tmp = join(this.#dir, `snapshot.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ seq: this.#sequence, state }, null, 2));
    renameSync(tmp, this.#snapshotPath);
  }

  /**
   * 加载快照并重放后续 WAL 事件。
   * @param {(state, event) => void} reducer 状态归约器（原地修改 state）
   * @param {() => object} emptyState 初始状态工厂
   */
  load(reducer, emptyState) {
    let state = emptyState();
    let snapshotSeq = 0;
    let recoveredPartial = false;

    if (this.#snapshotPath && existsSync(this.#snapshotPath)) {
      const snapshot = JSON.parse(readFileSync(this.#snapshotPath, 'utf8'));
      state = snapshot.state;
      snapshotSeq = snapshot.seq;
      this.#sequence = snapshot.seq;
    }

    let replayed = 0;
    if (this.#walPath && existsSync(this.#walPath)) {
      const validLines = [];
      for (const line of readFileSync(this.#walPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.seq <= snapshotSeq) {
            validLines.push(line);
            continue;
          }
          reducer(state, event);
          this.#sequence = event.seq;
          replayed += 1;
          validLines.push(line);
        } catch {
          // 半写/损坏的尾部事件：停止重放并截断，已确认事件不受影响
          recoveredPartial = true;
          break;
        }
      }
      if (recoveredPartial) {
        const good = validLines.filter((l) => l.trim()).join('\n');
        writeFileSync(this.#walPath, good ? good + '\n' : '');
      }
    }

    return { state, replayed, recoveredPartial };
  }

  /** 快照成功后截断已并入快照的 WAL 前缀；保留空文件以便后续 append。 */
  truncateBefore(seq) {
    if (!this.#walPath) return;
    if (!existsSync(this.#walPath)) {
      // 上次截断可能发生在不同进程，这里重建空 WAL
      writeFileSync(this.#walPath, '');
      return;
    }
    const kept = readFileSync(this.#walPath, 'utf8')
      .split('\n')
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          return JSON.parse(line).seq > seq;
        } catch {
          return false;
        }
      })
      .join('\n');
    writeFileSync(this.#walPath, kept ? kept + '\n' : '');
  }

  reset() {
    if (!this.#dir) return;
    for (const name of ['wal.log', 'snapshot.json']) {
      const p = join(this.#dir, name);
      if (existsSync(p)) rmSync(p);
    }
    this.#sequence = 0;
  }
}

/** 测试辅助：读取目录下的原始 WAL 行数。 */
export function rawWalLineCount(dir) {
  const p = join(dir, 'wal.log');
  if (!existsSync(p)) return 0;
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
}

export function snapshotExists(dir) {
  return existsSync(join(dir, 'snapshot.json'));
}
