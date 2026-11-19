/**
 * 极简异步互斥锁。Node 虽为单线程，但 await 之间会交错执行，
 * 并发发布必须靠串行化保证版本号分配与 WAL 写入不产生竞争。
 */
export class Mutex {
  #queue = Promise.resolve();

  async run(fn) {
    const result = this.#queue.then(fn, fn);
    // 无论上一个任务成功与否，链都继续向下传递
    this.#queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/** 按 key（主题名）分发的锁，不同主题之间仍可并行。 */
export class KeyedLock {
  #locks = new Map();

  async run(key, fn) {
    let lock = this.#locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.#locks.set(key, lock);
    }
    return lock.run(fn);
  }
}
