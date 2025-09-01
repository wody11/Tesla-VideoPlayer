// 单元测试：h264-annexb-avcc
import { annexBToAvcc, avccToAnnexB, extractSpsPps } from './h264-annexb-avcc';

describe('h264-annexb-avcc', () => {
  it('should export functions', () => {
    expect(typeof annexBToAvcc).toBe('function');
    expect(typeof avccToAnnexB).toBe('function');
    expect(typeof extractSpsPps).toBe('function');
  });
  // TODO: 补充真实 NALU/AVCC 测试
});
