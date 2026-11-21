// Incremental reader for append-only JSONL files (transcript.jsonl).
// Keeps a byte offset, buffers a trailing partial line, and resets if the file shrinks.

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export class JsonlTailer {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.partial = '';
    this.mtimeMs = 0;
    this.reset = false; // set when the file shrank and reading started over: the caller drops what it built
    // a read can end inside a multi-byte character (a write still in progress): keep its bytes for the next one
    this.decoder = new StringDecoder('utf8');
  }

  /** Returns rows appended since the last call ([] if none). Never throws on a missing file. */
  poll() {
    let st;
    try { st = statSync(this.file); } catch { return []; }
    if (st.size < this.offset) { this.offset = 0; this.partial = ''; this.decoder = new StringDecoder('utf8'); this.reset = true; } // truncated or replaced
    if (st.size === this.offset) return [];
    this.mtimeMs = st.mtimeMs;

    const fd = openSync(this.file, 'r');
    let text;
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, this.offset + read);
        if (n === 0) break;
        read += n;
      }
      this.offset += read;
      text = this.partial + this.decoder.write(buf.subarray(0, read));
    } finally { closeSync(fd); }

    const lines = text.split('\n');
    this.partial = lines.pop(); // '' when text ended with a newline
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    return rows;
  }
}
