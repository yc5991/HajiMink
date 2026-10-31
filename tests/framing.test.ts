import { describe, it, expect } from 'vitest';
import { FrameDecoder, encodeFrame } from '../server/framing';
describe('desktop framing', () => {
  it('decodes partial headers, unicode payloads and consecutive frames', () => {
    const a = encodeFrame({ text: '你好，Codex' }), b = encodeFrame({ revision: 8 }); const decoder = new FrameDecoder();
    expect(decoder.push(a.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([a.subarray(3), b]))).toEqual([{ text: '你好，Codex' }, { revision: 8 }]);
  });
  it('rejects an oversized frame before buffering the body', () => { const h = Buffer.alloc(4); h.writeUInt32LE(1025); expect(() => new FrameDecoder(1024).push(h)).toThrow('无效'); });
});
