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

function writeAllSync(fd: number, chunk: Buffer, bytes: number): void {
  let offset = 0;
  while (offset < bytes) {
    const writtenBytes = writeSync(fd, chunk, offset, bytes - offset);
    // local file writes either make progress or throw on supported platforms.
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
  #directory: string | undefined;
  #filePath: string | undefined;
  #fd: number | undefined;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;
  #cleanedUp = false;

  constructor(prefix: string, maxBytes: number, spillBytes: number) {
    this.#prefix = prefix;
    this.#maxBytes = maxBytes;
    this.#spillBytes = Math.min(spillBytes, maxBytes);
  }

  #spillToFile(): void {
    if (this.#fd !== undefined) return;

    const directory = mkdtempSync(join(tmpdir(), this.#prefix));
    const filePath = join(directory, "output.bin");
    let fd: number | undefined;

    try {
      fd = openSync(filePath, "w+", 0o600);
      for (const chunk of this.#chunks) {
        writeAllSync(fd, chunk, chunk.length);
      }
    } catch (error) {
      // temp output spill failures require filesystem faults while creating or backfilling the capture file.
      if (fd !== undefined) closeSync(fd);
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }

    this.#directory = directory;
    this.#filePath = filePath;
    this.#fd = fd;
    this.#chunks = [];
  }

  append(chunk: Buffer): void {
    // append after capture/cleanup is a stream lifecycle race guard.
    if (this.#cleanedUp) return;
    // depends on stream chunk boundaries after the cap has already been recorded.
    if (this.#bytes >= this.#maxBytes) {
      this.#truncated = true;
      return;
    }

    if (
      this.#fd === undefined &&
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

    this.#spillToFile();
    // #spillToFile either initializes the file descriptor or throws.
    if (this.#fd === undefined) return;
    writeAllSync(this.#fd, capturedChunk, capturedBytes);
    this.#bytes += capturedBytes;
    if (chunk.length > capturedBytes) this.#truncated = true;
  }

  #close(): void {
    if (this.#fd === undefined) return;
    closeSync(this.#fd);
    this.#fd = undefined;
  }

  cleanup(): void {
    this.#close();
    this.#chunks = [];
    this.#cleanedUp = true;
    if (this.#directory !== undefined) {
      rmSync(this.#directory, { recursive: true, force: true });
      this.#directory = undefined;
      this.#filePath = undefined;
    }
  }

  capture(): CapturedByteOutput {
    try {
      if (this.#fd === undefined) {
        return {
          text: Buffer.concat(this.#chunks, this.#bytes).toString("utf8"),
          truncated: this.#truncated,
        };
      }

      this.#close();
      const filePath = this.#filePath;
      // a file descriptor implies a capture file path.
      if (filePath === undefined) {
        throw new Error("temporary output capture file is missing");
      }
      return {
        text: readFileSync(filePath, "utf8"),
        truncated: this.#truncated,
      };
    } finally {
      this.cleanup();
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

    while (this.#bytes > this.#maxBytes) {
      const first = this.#chunks[0];
      // positive buffered byte count implies at least one chunk.
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
