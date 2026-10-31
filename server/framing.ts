import { AppError } from './errors.js';
export function encodeFrame(value: unknown, maxBytes = 32 * 1024 * 1024): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > maxBytes) throw new AppError('FRAME_TOO_LARGE', '桌面消息超过允许大小', 502);
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  constructor(private maxBytes = 32 * 1024 * 1024) {}
  push(chunk: Buffer): any[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > this.maxBytes) throw new AppError('INVALID_FRAME', '桌面通信帧无效', 502);
      if (this.buffer.length < length + 4) break;
      messages.push(JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')));
      this.buffer = this.buffer.subarray(length + 4);
    }
    return messages;
  }
}
