export const OUTPUT_LIMIT = 1024 * 1024;

/** 只保留指定字节数，继续消费后续数据，避免远端因背压阻塞或本地内存持续增长。 */
export class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private length = 0;
  truncated = false;

  constructor(private readonly limit = OUTPUT_LIMIT) {}

  append(chunk: Buffer | string): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.limit - this.length;
    if (data.length > remaining) this.truncated = true;
    if (remaining > 0) {
      // 拷贝切片，避免少量保留数据意外引用一个巨大的原始 Buffer。
      const kept = Buffer.from(data.subarray(0, remaining));
      this.chunks.push(kept);
      this.length += kept.length;
    }
  }

  text(): string {
    // stream=true 在截断位置忽略不完整的 UTF-8 尾字符，避免制造乱码。
    return new TextDecoder('utf-8').decode(Buffer.concat(this.chunks, this.length), { stream: this.truncated });
  }
}
