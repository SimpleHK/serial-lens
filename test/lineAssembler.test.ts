import { describe, expect, it } from 'vitest';

import { LineAssembler } from '../src/host/lineAssembler';

const bytes = (s: string): Uint8Array => Buffer.from(s, 'utf-8');

describe('LineAssembler (data seam: byte chunks → lines)', () => {
  it('assembles lines from a single chunk terminated by LF', () => {
    const asm = new LineAssembler();
    expect(asm.push(bytes('hello\nworld\n'))).toEqual(['hello', 'world']);
    expect(asm.flush()).toEqual([]);
  });

  it('terminates lines on LF, bare CR, and CRLF within one chunk', () => {
    const asm = new LineAssembler();
    expect(asm.push(bytes('a\nb\rc\r\nd'))).toEqual(['a', 'b', 'c']);
    expect(asm.flush()).toEqual(['d']);
  });

  it('reassembles a line split across chunk boundaries', () => {
    const asm = new LineAssembler();
    expect(asm.push(bytes('he'))).toEqual([]);
    expect(asm.push(bytes('llo\nwo'))).toEqual(['hello']);
    expect(asm.push(bytes('rld\n'))).toEqual(['world']);
    expect(asm.flush()).toEqual([]);
  });

  it('treats CRLF split across chunks as one line break, not two', () => {
    const asm = new LineAssembler();
    expect(asm.push(bytes('a\r'))).toEqual(['a']);
    expect(asm.push(bytes('\nb\n'))).toEqual(['b']);
    expect(asm.flush()).toEqual([]);
  });

  it('treats a bare trailing CR followed by text as a completed line', () => {
    const asm = new LineAssembler();
    expect(asm.push(bytes('a\r'))).toEqual(['a']);
    expect(asm.push(bytes('b'))).toEqual([]);
    expect(asm.flush()).toEqual(['b']);
  });

  it('preserves empty lines', () => {
    const asm = new LineAssembler();
    expect(asm.push(bytes('\n\n'))).toEqual(['', '']);
    expect(asm.push(bytes('a\r\n\r\nb\n'))).toEqual(['a', '', 'b']);
  });

  it('holds an incomplete trailing line until more data arrives', () => {
    const asm = new LineAssembler();
    expect(asm.push(bytes('abc'))).toEqual([]);
    expect(asm.push(bytes('def'))).toEqual([]);
    expect(asm.flush()).toEqual(['abcdef']);
  });

  it('flush returns nothing when no pending text remains', () => {
    const asm = new LineAssembler();
    asm.push(bytes('x\n'));
    expect(asm.flush()).toEqual([]);
    expect(asm.flush()).toEqual([]);
  });

  it('reassembles a UTF-8 multibyte character split across chunks', () => {
    const asm = new LineAssembler();
    const whole = bytes('x好\ny\n');
    expect(asm.push(whole.subarray(0, 2))).toEqual([]);
    expect(asm.push(whole.subarray(2))).toEqual(['x好', 'y']);
    expect(asm.flush()).toEqual([]);
  });

  it('decodes bytes as UTF-8', () => {
    const asm = new LineAssembler();
    expect(asm.push(bytes('温度=25°C\n'))).toEqual(['温度=25°C']);
  });
});
