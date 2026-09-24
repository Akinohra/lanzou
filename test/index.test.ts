import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BASE_UA,
  CookieJar,
  absTime,
  calcAcwScV2,
  checkLanzouUrl,
  extractParam,
  parseSiteTime,
  resetCookies,
} from '../src'

describe('calcAcwScV2', () => {
  // 固定向量回归测试：锁定重排表与异或密钥，防止算法被意外改动
  it('已知arg1输出正确（向量1）', () => {
    expect(calcAcwScV2('69C95C2BE48A9057D0E7B0EDEDBAF2E9CB3D6F5B')).toBe('63fdd00f4e6bdb08efdd51283b9efb29f24ab5d8')
  })

  it('已知arg1输出正确（向量2）', () => {
    expect(calcAcwScV2('0123456789ABCDEF0123456789ABCDEF01234567')).toBe('d2c7186598ab1a508a4f6064e4fa746323ab17c6')
  })

  it('输出为40位小写hex且确定性', () => {
    const out = calcAcwScV2('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF')
    expect(out).toMatch(/^[0-9a-f]{40}$/)
    expect(calcAcwScV2('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF')).toBe(out)
  })
})

describe('parseSiteTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 24, 12, 0, 0)) // 2026-09-24 12:00 本地时间
  })
  afterEach(() => vi.useRealTimers())

  const ts = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime()

  it.each([
    ['3 小时前', ts(2026, 9, 24, 9)],
    ['30分钟前', ts(2026, 9, 24, 11, 30)],
    ['5秒前', ts(2026, 9, 24, 11, 59, 55)],
    ['2天前', ts(2026, 9, 22, 12)],
    ['昨天 20:31', ts(2026, 9, 23, 20, 31)],
    ['前天 08:05', ts(2026, 9, 22, 8, 5)],
    ['刚刚', ts(2026, 9, 24, 12)],
    ['2026-08-30', ts(2026, 8, 30)],
    ['2026-08-30 12:34', ts(2026, 8, 30, 12, 34)],
    ['2026/08/30 12:34', ts(2026, 8, 30, 12, 34)],
  ])('解析 %s', (raw, expected) => {
    expect(parseSiteTime(raw)).toBe(expected)
  })

  it('无法解析返回0', () => {
    expect(parseSiteTime('乱码')).toBe(0)
    expect(parseSiteTime('')).toBe(0)
  })
})

describe('absTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 24, 12, 0, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('相对时间转为标准格式', () => {
    expect(absTime('3 小时前')).toBe('2026-09-24 09:00')
    expect(absTime('昨天 20:31')).toBe('2026-09-23 20:31')
  })

  it('无法解析原样返回', () => {
    expect(absTime('n/a')).toBe('n/a')
  })
})

describe('checkLanzouUrl', () => {
  it.each([
    'https://wwp.lanzouj.com/i1a2b3c',
    'https://wwa.lanzouq.com/i1a2b3c',
    'https://ricarda.lanzouu.com/i1a2b3c',
    'https://foo.lanzn.com/i1a2b3c',
    'https://www.lanpw.com/i1a2b3c',
  ])('接受 %s', (url) => {
    expect(checkLanzouUrl(url)).toEqual({ valid: true })
  })

  it.each(['https://example.com/abc', 'https://lanzou.com.cn/abc', '不是链接', ''])('拒绝 %s', (url) => {
    const result = checkLanzouUrl(url)
    expect(result.valid).toBe(false)
  })
})

describe('CookieJar', () => {
  it('精确域名Cookie不下发到子域', () => {
    const jar = new CookieJar()
    jar.set('wwp.lanzouu.com', 'a', '1')
    expect(jar.headerFor('https://wwp.lanzouu.com/x')).toBe('a=1')
    expect(jar.headerFor('https://other.lanzouu.com/x')).toBe('')
  })

  it('父域Cookie下发到所有子域', () => {
    const jar = new CookieJar()
    jar.set('.lanzouu.com', 'b', '2')
    expect(jar.headerFor('https://wwp.lanzouu.com/x')).toBe('b=2')
    expect(jar.headerFor('https://ricarda.lanzouu.com/x')).toBe('b=2')
  })

  it('addFromResponse优先使用Domain属性', () => {
    const jar = new CookieJar()
    jar.addFromResponse(['x=9; Domain=.lanzouu.com; Path=/'], 'https://wwp.lanzouu.com/a')
    expect(jar.headerFor('https://ricarda.lanzouu.com/x')).toBe('x=9')
  })

  it('addFromResponse无Domain属性时归属请求域名', () => {
    const jar = new CookieJar()
    jar.addFromResponse(['y=8; Path=/'], 'https://wwp.lanzouu.com/a')
    expect(jar.headerFor('https://wwp.lanzouu.com/x')).toBe('y=8')
    expect(jar.headerFor('https://other.lanzouu.com/x')).toBe('')
  })

  it('addFromResponse忽略无值条目', () => {
    const jar = new CookieJar()
    jar.addFromResponse(['; Path=/', '=x'], 'https://wwp.lanzouu.com/a')
    expect(jar.headerFor('https://wwp.lanzouu.com/x')).toBe('')
  })

  it('clear清空全部Cookie', () => {
    const jar = new CookieJar()
    jar.set('wwp.lanzouu.com', 'a', '1')
    jar.clear()
    expect(jar.headerFor('https://wwp.lanzouu.com/x')).toBe('')
  })
})

describe('extractParam', () => {
  it('提取带引号的key:value', () => {
    expect(extractParam(`var data = {'fid':'ABC123'}`, 'fid')).toBe('ABC123')
  })

  it('提取带引号的var定义', () => {
    expect(extractParam(`var k = "xyz789";`, 'k')).toBe('xyz789')
  })

  it('提取不带引号的字面值', () => {
    expect(extractParam(`var t = 1695000000;`, 't')).toBe('1695000000')
  })

  it('不带引号的变量名回查var定义', () => {
    const html = `var someVar = '12345'; data:{uid:someVar}`
    expect(extractParam(html, 'uid')).toBe('12345')
  })

  it('缺失时返回null', () => {
    expect(extractParam('<html></html>', 'fid')).toBeNull()
  })
})

describe('模块级状态', () => {
  it('resetCookies可安全调用', () => {
    expect(() => resetCookies()).not.toThrow()
  })

  it('BASE_UA为移动端UA', () => {
    expect(BASE_UA).toContain('Mozilla/5.0')
    expect(BASE_UA).toContain('Mobile')
  })
})
