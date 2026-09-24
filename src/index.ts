import axios from 'axios'

// ===== 配置 =====

/** 站点校验用的移动端 UA，下载直链时建议携带同款，否则可能 403 */
export const BASE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36'

const DEFAULT_TIMEOUT = 15000
/** 文件列表接口的兜底域名池：filemoreajax是全局接口，任一活着的蓝奏子域均可查询；分享域名失效时按序尝试 */
const FALLBACK_HOSTS = ['ricarda.lanzouu.com', 'wwa.lanzouq.com', 'wwa.lanzouw.com']

export interface FileInfo {
  fileName: string
  fileSize: string
  /** 更新时间 YYYY-MM-DD HH:mm（站点返回相对时间时已换算，精度受限于相对单位） */
  updateTime?: string
  directLink: string | null
  /** 直链获取失败时的原因（directLink 为 null 时存在） */
  error?: string
}

export interface LanzouOptions {
  /** 分享密码（如有） */
  pwd?: string
  /** 开启进度日志，默认静默 */
  debug?: boolean
  /** 单次请求超时（毫秒），默认 15000 */
  timeout?: number
}

/** 内部请求上下文：日志闭包与超时随调用链传递，避免模块级可变配置 */
interface Ctx {
  log: (message: string) => void
  timeout: number
}

// ===== Cookie 与 WAF =====

/** 按域名存储Cookie，供跨请求携带（WAF验证需要）；`@internal` */
export class CookieJar {
  private store = new Map<string, Map<string, string>>()

  set(domain: string, name: string, value: string): void {
    const key = domain.toLowerCase().replace(/^\./, '')
    const bucket = this.store.get(key) ?? new Map()
    bucket.set(name, value)
    this.store.set(key, bucket)
  }

  /** 记录响应Set-Cookie，优先使用其Domain属性，否则归属请求域名 */
  addFromResponse(setCookie: string[] | undefined, requestUrl: string): void {
    for (const item of setCookie ?? []) {
      const [pair] = item.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const domain = item.match(/domain=([^;]+)/i)?.[1].trim() ?? new URL(requestUrl).hostname
      this.set(domain, pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  /** 生成请求应携带的Cookie头（包含当前域名及其父域的Cookie） */
  headerFor(url: string): string {
    const parts = new URL(url).hostname.toLowerCase().split('.')
    const cookies: string[] = []
    for (let i = 0; i < parts.length - 1; i++) {
      this.store.get(parts.slice(i).join('.'))?.forEach((value, name) => cookies.push(`${name}=${value}`))
    }
    return cookies.join('; ')
  }

  /** 清空全部Cookie */
  clear(): void {
    this.store.clear()
  }
}

const cookieJar = new CookieJar()

/** 清空模块级Cookie容器（长驻进程中重置WAF状态时使用） */
export const resetCookies = (): void => cookieJar.clear()

/** 判断页面是否为WAF挑战页（acw_sc__v2反爬验证） */
const isAcwChallenge = (html: string) => html.includes('acw_sc__v2') && html.includes('arg1')

/** acw_sc__v2算法的固定参数：40位重排表与异或密钥 */
const ACW_POS = [
  15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23, 25, 13, 6, 11, 39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4,
  17, 5, 3, 28, 34, 37, 12, 36,
]
const ACW_KEY = '3000176000856006061501533003690027800375'

/** 本地计算acw_sc__v2：按固定表重排arg1(40位hex)，再与密钥逐字节异或 */
export const calcAcwScV2 = (arg1: string): string => {
  const mixed = ACW_POS.map((pos) => arg1[pos - 1]).join('')
  return mixed
    .match(/../g)!
    .map(
      (pair, i) =>
        (parseInt(pair, 16) ^ parseInt(ACW_KEY.slice(i * 2, i * 2 + 2), 16)).toString(16).padStart(2, '0'),
    )
    .join('')
}

/** 从挑战页提取arg1并本地算出acw_sc__v2写入Cookie容器（不执行远端JS，规避vm逃逸风险） */
const solveAcwChallenge = (html: string, url: string): boolean => {
  const arg1 = html.match(/arg1\s*=\s*['"]([0-9A-Fa-f]{40})['"]/)?.[1]
  if (!arg1) return false
  cookieJar.set(new URL(url).hostname, 'acw_sc__v2', calcAcwScV2(arg1))
  return true
}

// ===== HTTP =====

let lastRequestAt = 0

/** 全局限速：相邻请求间隔至少1秒（模块级，同一进程内所有调用共享，属礼貌性限速） */
async function rateLimit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, lastRequestAt + 1000 - Date.now())))
  lastRequestAt = Date.now()
}

const buildHeaders = (url: string, referer?: string): Record<string, string> => {
  const headers: Record<string, string> = { 'User-Agent': BASE_UA }
  const cookie = cookieJar.headerFor(url)
  if (cookie) headers.Cookie = cookie
  if (referer) headers.Referer = referer
  return headers
}

/** 发送请求，命中WAF挑战页时算出acw_sc__v2后重试（最多3次） */
const httpSend = async (
  method: 'get' | 'post',
  url: string,
  ctx: Ctx,
  data?: URLSearchParams,
  referer?: string,
): Promise<any> => {
  let body: any = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await axios.request({ method, url, data, headers: buildHeaders(url, referer), timeout: ctx.timeout })
    cookieJar.addFromResponse(response.headers['set-cookie'], url)
    body = response.data
    if (typeof body !== 'string' || !isAcwChallenge(body)) return body
    ctx.log(`命中WAF挑战页，计算acw_sc__v2后重试 (${attempt + 1}/3)`)
    if (!solveAcwChallenge(body, url)) break
  }
  return body
}

/** GET页面文本 */
const httpGetText = async (url: string, ctx: Ctx, referer?: string): Promise<string> => {
  const body = await httpSend('get', url, ctx, undefined, referer)
  return typeof body === 'string' ? body : String(body ?? '')
}

// ===== 参数提取 =====

/** 从页面提取key对应的值（'key':value / key=value、引号均可）；不带引号且像变量名的值回查var定义；`@internal` */
export const extractParam = (html: string, key: string): string | null => {
  const m = html.match(new RegExp(`['"]?\\b${key}\\b['"]?\\s*[:=]\\s*(['"]?)([^,'";\\s}]+)`, 'i'))
  if (!m) return null
  const [, quote, raw] = m
  if (quote) return raw // 带引号：字面值
  if (/^[A-Za-z_$][\w$]*$/.test(raw)) {
    // 不带引号：可能是变量引用
    return html.match(new RegExp(`var\\s+${raw}\\s*=\\s*['"]([^'"]+)['"]`))?.[1] ?? null
  }
  return raw
}

/** 从分享页提取filemoreajax接口所需参数 */
const prepareData = async (url: string, pwd: string, ctx: Ctx): Promise<Record<string, string>> => {
  ctx.log(`正在获取分享页: ${url}`)
  const html = await httpGetText(url, ctx)

  const get = (key: string) => extractParam(html, key)
  const fid = get('fid')
  const t = get('t') ?? html.match(/var\s+\w+\s*=\s*['"](\d{10})['"]/)?.[1]
  const k = get('k')
  if (!fid || !t || !k) {
    throw new Error(`无法从页面提取必要参数 fid=${fid}, t=${t}, k=${k}`)
  }

  return {
    lx: get('lx') ?? '2',
    fid,
    uid: get('uid') ?? '0',
    rep: get('rep') ?? '0',
    t,
    k,
    up: get('up') ?? '1',
    ls: get('ls') ?? '1',
    pwd,
  }
}

// ===== 文件列表 =====

interface LanzouFileData {
  name_all: string
  size: string
  id: string
  time?: string
  [key: string]: any
}

/** 请求单页文件列表：zt=1返回文件，zt=2返回[]，其他情况返回null（由调用方重试） */
const fetchFilePage = async (data: Record<string, string>, pg: number, host: string, ctx: Ctx): Promise<LanzouFileData[] | null> => {
  const hosts = FALLBACK_HOSTS.includes(host) ? FALLBACK_HOSTS : [host, ...FALLBACK_HOSTS]

  for (const h of hosts) {
    try {
      ctx.log(`请求文件列表 第${pg}页 @ ${h}`)
      const result = await httpSend('post', `https://${h}/filemoreajax.php`, ctx, new URLSearchParams({ ...data, pg: String(pg) }))

      if (!result || typeof result.zt === 'undefined') continue // 响应无效，换下一个域名
      if (result.zt === 1) return result.text
      if (result.zt === 2) return [] // 无文件或已到末页
      ctx.log(`触发频率限制或未知状态(zt=${result.zt}): ${result.info}`)
      return null
    } catch (error: any) {
      ctx.log(`域名 ${h} 请求失败: ${error.message}`)
    }
  }
  return null
}

/** 翻页获取全部文件，单页失败最多重试4次 */
const getAllFileList = async (url: string, pwd: string, ctx: Ctx): Promise<LanzouFileData[]> => {
  const data = await prepareData(url, pwd, ctx)
  const host = new URL(url).host
  const files: LanzouFileData[] = []

  for (let pg = 1; ; pg++) {
    let page: LanzouFileData[] | null = null
    for (let retry = 0; retry < 4 && page === null; retry++) {
      await rateLimit()
      page = await fetchFilePage(data, pg, host, ctx)
    }
    if (!page?.length) return files // 空页=已到末页；重试耗尽=返回已获取的部分
    ctx.log(`第${pg}页获取到 ${page.length} 个文件`)
    files.push(...page)
  }
}

// ===== 直链提取 =====

/** 处理下载跳转页，提取最终直链 */
const processDownloadPage = async (tp: string, host: string, filePageUrl: string, ctx: Ctx): Promise<string> => {
  const tpUrl = /^https?:\/\//i.test(tp) ? tp : `https://${host}${tp}`
  const tpHtml = await httpGetText(tpUrl, ctx, filePageUrl)

  // 依次尝试：vkjxld+hyggid拼接 → 含/file/的JS变量 → iframe
  const vkjxld = tpHtml.match(/var\s+vkjxld\s*=\s*'([^']+)'/)?.[1]
  const hyggid = tpHtml.match(/var\s+hyggid\s*=\s*'([^']+)'/)?.[1]
  const found = (vkjxld && hyggid ? vkjxld + hyggid : null)
    ?? tpHtml.match(/var\s+\w+\s*=\s*'(https?:\/\/[^']+\/file\/[^']*)'/)?.[1]
    ?? tpHtml.match(/<iframe[^>]+src="([^"]+)"/)?.[1]
  if (!found) throw new Error('无法从下载页提取跳转参数(vkjxld/hyggid)')
  const finalPageUrl = /^https?:\/\//i.test(found) ? found : new URL(found, tpUrl).href

  ctx.log(`获取最终下载页: ${finalPageUrl}`)
  const finalHtml = await httpGetText(finalPageUrl, ctx, tpUrl)

  // 依次尝试：JS跳转 → a标签 → download链接
  const link = finalHtml.match(/location\.(?:href\s*=|replace\()\s*["']([^"']+)["']/)?.[1]
    ?? finalHtml.match(/<a\s+href="(https?:\/\/[^"]+)"/)?.[1]
    ?? finalHtml.match(/href="(https?:\/\/[^"]+download[^"]*)"/i)?.[1]
  if (!link) throw new Error('最终页面未找到下载直链')
  return /^https?:\/\//i.test(link) ? link : new URL(link, finalPageUrl).href
}

/** 获取单个文件的最终下载链接，失败抛出异常 */
const getFinalLink = async (id: string, host: string, ctx: Ctx, referer?: string): Promise<string> => {
  const filePageUrl = `https://${host}/${id}`
  const html = await httpGetText(filePageUrl, ctx, referer)
  if (isAcwChallenge(html)) throw new Error('文件页被WAF拦截且挑战破解失败')

  const tp = html.match(/<a[^>]+href="([^"]+)"[^>]*id="downurl"/)?.[1]
    ?? html.match(/<a[^>]+id="downurl"[^>]+href="([^"]+)"/)?.[1]
    ?? html.match(/<iframe[^>]+src="([^"]+)"/)?.[1]
  if (!tp) throw new Error('文件页未找到下载入口(downurl)，页面可能需要密码或结构已变更')

  ctx.log(`文件 ${id} 跳转链接: ${tp}`)
  return processDownloadPage(tp, host, filePageUrl, ctx)
}

// ===== 时间解析 =====

const TIME_UNITS: Record<string, number> = { 秒: 1e3, 分钟: 6e4, 小时: 36e5, 天: 864e5 }

/** 站点时间字符串转时间戳（相对"3 小时前"/"昨天 20:31"/"刚刚"与绝对"2026-08-30"均支持），无法解析返回0 */
export const parseSiteTime = (raw: string): number => {
  const rel = raw.match(/(\d+)\s*(秒|分钟|小时|天)前/)
  if (rel) return Date.now() - +rel[1] * TIME_UNITS[rel[2]]!
  const day = raw.match(/(昨天|前天)\s*(\d{1,2}):(\d{2})/)
  if (day) {
    const d = new Date(Date.now() - (day[1] === '昨天' ? 1 : 2) * 864e5)
    d.setHours(+day[2], +day[3], 0, 0)
    return +d
  }
  if (raw.includes('刚刚')) return Date.now()
  const s = raw.replace(/\//g, '-')
  return +new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s} 00:00` : s) || 0
}

/** 时间戳统一格式化为 "YYYY-MM-DD HH:mm" */
const fmtTime = (ts: number): string => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 站点时间统一为 "YYYY-MM-DD HH:mm"，无法解析则原样返回 */
export const absTime = (raw: string): string => {
  const ts = parseSiteTime(raw)
  return ts ? fmtTime(ts) : raw
}

// ===== 对外接口 =====

const buildCtx = (options: LanzouOptions): Ctx => ({
  log: options.debug ? (message) => console.log(message) : () => {},
  timeout: options.timeout ?? DEFAULT_TIMEOUT,
})

/**
 * 获取蓝奏云文件夹中所有文件的信息和直链
 *
 * 永不抛出异常：整体失败返回 `[]`，单个文件直链获取失败时该项 `directLink` 为 `null` 并附 `error` 说明。
 *
 * @param url - 蓝奏云分享URL
 * @param options - 可选配置（密码 / 调试日志 / 超时）
 */
export const getLanzouFiles = async (url: string, options: LanzouOptions = {}): Promise<FileInfo[]> => {
  const ctx = buildCtx(options)
  try {
    const host = new URL(url).host
    const fileList = await getAllFileList(url, options.pwd ?? '', ctx)
    if (!fileList.length) {
      ctx.log('未找到文件或文件列表为空')
      return []
    }

    ctx.log(`共 ${fileList.length} 个文件，开始获取直链`)
    const results: FileInfo[] = []
    for (const [index, file] of fileList.entries()) {
      ctx.log(`(${index + 1}/${fileList.length}) ${file.name_all}`)
      await rateLimit()
      try {
        const directLink = await getFinalLink(file.id, host, ctx, url)
        results.push({
          fileName: file.name_all,
          fileSize: file.size,
          updateTime: file.time ? absTime(file.time) : undefined,
          directLink,
        })
        ctx.log(`✓ ${file.name_all} 直链获取成功`)
      } catch (error: any) {
        ctx.log(`✗ ${file.name_all} 直链获取失败: ${error.message}`)
        results.push({
          fileName: file.name_all,
          fileSize: file.size,
          updateTime: file.time ? absTime(file.time) : undefined,
          directLink: null,
          error: error.message,
        })
      }
    }
    ctx.log(`完成：${results.filter((f) => f.directLink).length}/${fileList.length} 个直链获取成功`)
    return results
  } catch (error: any) {
    ctx.log(`获取蓝奏云文件失败: ${error.message}`)
    return []
  }
}

/** 检测URL是否为有效的蓝奏云分享链接 */
export const checkLanzouUrl = (url: string): { valid: true } | { valid: false; message: string } => {
  const valid = /https?:\/\/[\w.-]+\.(?:lanzou[a-z]?|lanzn|lanpw|lanpv|lanzv)\.com\/\w+/i.test(url)
  return valid
    ? { valid: true }
    : { valid: false, message: 'URL不是有效的蓝奏云链接，蓝奏云域名包括：lanzou*.com、lanzn.com等' }
}

/**
 * 只取更新时间最新的文件：仅用列表比较时间，只为该文件请求直链，其余文件不发任何请求
 *
 * 失败返回 `null`，不抛出异常。
 *
 * @param url - 蓝奏云分享URL
 * @param options - 可选配置（密码 / 调试日志 / 超时）
 */
export const getLatestFile = async (url: string, options: LanzouOptions = {}): Promise<FileInfo | null> => {
  const ctx = buildCtx(options)
  try {
    const host = new URL(url).host
    const fileList = await getAllFileList(url, options.pwd ?? '', ctx)
    if (!fileList.length) return null
    const newest = fileList.reduce((a, b) => (parseSiteTime(b.time ?? '') > parseSiteTime(a.time ?? '') ? b : a))
    ctx.log(`最新文件: ${newest.name_all}，获取其直链`)
    await rateLimit()
    const directLink = await getFinalLink(newest.id, host, ctx, url)
    ctx.log(`✓ ${newest.name_all} 直链获取成功`)
    return {
      fileName: newest.name_all,
      fileSize: newest.size,
      updateTime: newest.time ? absTime(newest.time) : undefined,
      directLink,
    }
  } catch (error: any) {
    ctx.log(`获取最新文件失败: ${error.message}`)
    return null
  }
}
