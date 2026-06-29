export interface CountLimitedOutput<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
}

export function limitCountedOutput<T>(
  items: readonly T[],
  limit: number,
): CountLimitedOutput<T> {
  const visibleItems = items.slice(0, limit);
  return {
    items: visibleItems,
    truncated: items.length > visibleItems.length,
  };
}

export class CountOutputLimit<T> {
  readonly #limit: number;
  #items: T[] = [];
  #truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(item: T): boolean {
    if (this.#items.length >= this.#limit) {
      this.#truncated = true;
      return false;
    }
    this.#items.push(item);
    return true;
  }

  capture(): CountLimitedOutput<T> {
    return {
      items: [...this.#items],
      truncated: this.#truncated,
    };
  }
}

export interface CapturedByteOutput {
  readonly text: string;
  readonly truncated: boolean;
}

export class HeadByteOutputLimit {
  readonly #maxBytes: number;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: Buffer): void {
    if (this.#bytes >= this.#maxBytes) {
      this.#truncated = true;
      return;
    }

    const remainingBytes = this.#maxBytes - this.#bytes;
    if (chunk.length <= remainingBytes) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.length;
      return;
    }

    this.#chunks.push(chunk.subarray(0, remainingBytes));
    this.#bytes = this.#maxBytes;
    this.#truncated = true;
  }

  capture(): CapturedByteOutput {
    return {
      text: Buffer.concat(this.#chunks, this.#bytes).toString("utf8"),
      truncated: this.#truncated,
    };
  }
}

export class TailByteOutputLimit {
  readonly #maxBytes: number;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: Buffer): void {
    if (chunk.length > this.#maxBytes) {
      this.#chunks = [chunk.subarray(chunk.length - this.#maxBytes)];
      this.#bytes = this.#maxBytes;
      this.#truncated = true;
      return;
    }

    this.#chunks.push(chunk);
    this.#bytes += chunk.length;

    while (this.#bytes > this.#maxBytes) {
      const first = this.#chunks[0];
      /* v8 ignore next: positive buffered byte count implies at least one chunk. */
      if (first === undefined) return;

      const excessBytes = this.#bytes - this.#maxBytes;
      if (first.length <= excessBytes) {
        this.#chunks.shift();
        this.#bytes -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excessBytes);
        this.#bytes -= excessBytes;
      }
      this.#truncated = true;
    }
  }

  capture(): CapturedByteOutput {
    return {
      text: Buffer.concat(this.#chunks, this.#bytes).toString("utf8"),
      truncated: this.#truncated,
    };
  }
}
