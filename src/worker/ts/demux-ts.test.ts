// 单元测试：demuxTS
import { demuxTS, TSSample } from './demux-ts';

describe('demuxTS', () => {
  it('should parse TS stream and output Sample[]', () => {
    // 构造伪 TS 流数据（真实测试可用实际 TS 文件片段）
    const fakeTS = new Uint8Array(188 * 3); // 3 个空包
    fakeTS.fill(0x47, 0, fakeTS.length); // 填充同步字节
    const samples: TSSample[] = demuxTS(fakeTS.buffer);
    expect(Array.isArray(samples)).toBe(true);
    // TODO: 补充更详细断言和真实 TS 流测试
  });
});
