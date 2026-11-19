/**
 * 时钟抽象。生产环境使用系统时钟，测试注入 FakeClock 以验证兼容窗口到期逻辑。
 */
export class SystemClock {
  now() {
    return Date.now();
  }
}

export class FakeClock {
  #current;
  constructor(start = 1_700_000_000_000) {
    this.#current = start;
  }

  now() {
    return this.#current;
  }

  advance(ms) {
    this.#current += ms;
    return this.#current;
  }
}
