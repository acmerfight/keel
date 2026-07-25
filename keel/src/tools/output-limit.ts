import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

interface TempOutputSpill {
  readonly directory: string;
  readonly filePath: string;
  readonly fd: number;
}

function writeAllSync(fd: number, chunk: Buffer, bytes: number): void {
  let offset = 0;
  while (offset < bytes) {
    const writtenBytes = writeSync(fd, chunk, offset, bytes - offset);
    if (writtenBytes <= 0) {
      throw new Error("temporary output capture write made no progress");
    }
    offset += writtenBytes;
  }
}

export class TempFileByteOutputCapture {
  readonly #prefix: string;
  readonly #maxBytes: number;
  readonly #spillBytes: number;
  #spill: TempOutputSpill | undefined;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;
  #cleanedUp = false;

  constructor(prefix: string, maxBytes: number, spillBytes: number) {
    this.#prefix = prefix;
    this.#maxBytes = maxBytes;
    this.#spillBytes = Math.min(spillBytes, maxBytes);
  }

  #spillToFile(): TempOutputSpill {
    if (this.#spill !== undefined) return this.#spill;

    const directory = mkdtempSync(join(tmpdir(), this.#prefix));
    const filePath = join(directory, "output.bin");
    let fd: number | undefined;

    try {
      const openedFd = openSync(filePath, "w+", 0o600);
      fd = openedFd;
      for (const chunk of this.#chunks) {
        writeAllSync(openedFd, chunk, chunk.length);
      }
      const spill = { directory, filePath, fd: openedFd };
      this.#spill = spill;
      this.#chunks = [];
      return spill;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  append(chunk: Buffer): void {
    if (this.#cleanedUp) return;
    if (this.#bytes >= this.#maxBytes) {
      this.#truncated = true;
      return;
    }

    if (
      this.#spill === undefined &&
      this.#bytes + chunk.length <= this.#spillBytes
    ) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.length;
      return;
    }

    const remainingBytes = this.#maxBytes - this.#bytes;
    const capturedChunk =
      chunk.length <= remainingBytes
        ? chunk
        : chunk.subarray(0, remainingBytes);
    const capturedBytes = capturedChunk.length;

    const spill = this.#spillToFile();
    writeAllSync(spill.fd, capturedChunk, capturedBytes);
    this.#bytes += capturedBytes;
    if (chunk.length > capturedBytes) this.#truncated = true;
  }

  cleanup(): void {
    const spill = this.#spill;
    this.#spill = undefined;
    if (spill !== undefined) {
      closeSync(spill.fd);
      rmSync(spill.directory, { recursive: true, force: true });
    }
    this.#chunks = [];
    this.#cleanedUp = true;
  }

  capture(): CapturedByteOutput {
    const spill = this.#spill;
    if (spill === undefined) {
      try {
        return {
          text: Buffer.concat(this.#chunks, this.#bytes).toString("utf8"),
          truncated: this.#truncated,
        };
      } finally {
        this.cleanup();
      }
    }

    this.#spill = undefined;
    try {
      closeSync(spill.fd);
      return {
        text: readFileSync(spill.filePath, "utf8"),
        truncated: this.#truncated,
      };
    } finally {
      this.#chunks = [];
      this.#cleanedUp = true;
      rmSync(spill.directory, { recursive: true, force: true });
    }
  }
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

export class MemoryByteOutputCapture {
  readonly #output: HeadByteOutputLimit;

  constructor(maxBytes: number) {
    this.#output = new HeadByteOutputLimit(maxBytes);
  }

  append(chunk: Buffer): void {
    this.#output.append(chunk);
  }

  capture(): CapturedByteOutput {
    return this.#output.capture();
  }

  cleanup(): void {}
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
    if (this.#bytes <= this.#maxBytes) return;

    let excessBytes = this.#bytes - this.#maxBytes;
    let removedChunks = 0;
    for (const bufferedChunk of this.#chunks) {
      if (excessBytes <= 0) break;
      if (bufferedChunk.length <= excessBytes) {
        excessBytes -= bufferedChunk.length;
        removedChunks++;
      } else {
        this.#chunks[removedChunks] = bufferedChunk.subarray(excessBytes);
        excessBytes = 0;
      }
    }
    if (removedChunks > 0) this.#chunks.splice(0, removedChunks);
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
