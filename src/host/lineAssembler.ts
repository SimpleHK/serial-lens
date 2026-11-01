/**
 * Data seam: byte chunks → lines.
 *
 * Pure module, tested with vitest without hardware. Accepts byte chunks of
 * arbitrary size and boundary alignment, decodes them as UTF-8 (streaming, so
 * multibyte characters split across chunks survive), and terminates lines on
 * LF, bare CR, and CRLF — including a CRLF whose two halves arrive in
 * different chunks. An incomplete trailing line stays pending until more
 * data arrives; `flush` surfaces it (used when the port closes).
 */
export class LineAssembler {
  private readonly decoder = new TextDecoder('utf-8');
  private pending = '';
  private pendingCR = false;

  push(chunk: Uint8Array): string[] {
    return this.pushText(this.decoder.decode(chunk, { stream: true }));
  }

  flush(): string[] {
    const tail = this.pending + this.decoder.decode();
    this.pending = '';
    this.pendingCR = false;
    return tail === '' ? [] : [tail];
  }

  private pushText(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') {
        if (this.pendingCR) {
          this.pendingCR = false; // CRLF: the CR already terminated the line
        } else {
          lines.push(this.pending + text.slice(start, i));
          this.pending = '';
        }
        start = i + 1;
      } else if (ch === '\r') {
        lines.push(this.pending + text.slice(start, i));
        this.pending = '';
        this.pendingCR = true;
        start = i + 1;
      } else if (this.pendingCR) {
        this.pendingCR = false;
      }
    }
    this.pending += text.slice(start);
    return lines;
  }
}
