// 单元测试：aac-adts-raw
import { adtsToRaw, extractASC } from './aac-adts-raw';

describe('aac-adts-raw', () => {
  it('should export functions', () => {
    expect(typeof adtsToRaw).toBe('function');
    expect(typeof extractASC).toBe('function');
  });
  // TODO: 补充真实 ADTS/ASC 测试
});
