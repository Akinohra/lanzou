# lanzou

[![npm](https://img.shields.io/npm/v/lanzou)](https://www.npmjs.com/package/lanzou)
[![CI](https://github.com/Akinohra/lanzou/actions/workflows/ci.yml/badge.svg)](https://github.com/Akinohra/lanzou/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/lanzou)](https://www.npmjs.com/package/lanzou)

蓝奏云分享链接解析库：获取文件列表与下载直链。

## 特性

- **全自动 WAF 破解** — 命中 `acw_sc__v2` 反爬挑战页时本地计算通过验证，不执行远端 JS（无 vm 逃逸风险）
- **密码分享** — 支持带密码的分享链接
- **翻页获取** — 自动翻页取回文件夹内全部文件
- **域名回退** — 分享域名失效时自动切换兜底域名池（`filemoreajax` 是全局接口，任一存活子域均可查询）
- **直链提取** — 依次尝试 `vkjxld+hyggid` 拼接 / `iframe` / JS 跳转等多种页面结构，兼容站点改版
- **时间归一化** — "3 小时前"、"昨天 20:31" 等相对时间统一转为 `YYYY-MM-DD HH:mm`
- **内置限速** — 相邻请求间隔至少 1 秒，降低触发风控的概率
- **零异常抛出** — 主 API 永不 throw，失败信息通过返回值传递

## 架构

![lanzou 架构图](docs/architecture.svg)

> 图表随浏览器/系统自动切换深浅色 · [交互版（主题切换 / 导出 PNG/SVG）](docs/architecture.html)

## 安装

```sh
npm install lanzou
# 或
pnpm add lanzou
```

要求 Node.js >= 18。

## 快速开始

### 场景 A：只取最新文件（如自动更新，请求数最少）

```ts
import { getLatestFile } from 'lanzou'

const file = await getLatestFile('https://wwp.lanzouj.com/xxxxx', { pwd: 'abc1' })
if (file) {
  console.log(file.fileName) // 文件名
  console.log(file.fileSize) // 大小
  console.log(file.updateTime) // 更新时间 YYYY-MM-DD HH:mm
  console.log(file.directLink) // 下载直链
} else {
  console.log('获取失败或分享为空')
}
```

### 场景 B：获取全部文件的直链

```ts
import { getLanzouFiles } from 'lanzou'

const files = await getLanzouFiles('https://wwp.lanzouj.com/xxxxx', { debug: true })
for (const f of files) {
  console.log(f.directLink ? `✓ ${f.fileName} -> ${f.directLink}` : `✗ ${f.fileName}: ${f.error}`)
}
```

### 下载直链

直链绑定 IP/UA 且有时效，拿到后请立即下载，并携带同款移动端 UA：

```ts
import axios from 'axios'
import { BASE_UA } from 'lanzou'

const res = await axios.get(directLink, {
  headers: { 'User-Agent': BASE_UA },
  responseType: 'stream',
})
```

## API

### `getLanzouFiles(url, options?) => Promise<FileInfo[]>`

获取分享链接内全部文件的信息与直链。整体失败返回 `[]`；单个文件直链获取失败时该项 `directLink` 为 `null` 并附 `error` 说明。

### `getLatestFile(url, options?) => Promise<FileInfo | null>`

只取更新时间最新的文件：仅比较列表时间，只为该文件请求直链，其余文件不发任何请求。失败返回 `null`。

### `checkLanzouUrl(url) => { valid: true } | { valid: false; message }`

检测 URL 是否为有效的蓝奏云分享链接（`lanzou*.com`、`lanzn.com`、`lanpw.com` 等域名）。

### `LanzouOptions`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `pwd` | `string` | `''` | 分享密码（如有） |
| `debug` | `boolean` | `false` | 输出进度日志（默认静默） |
| `timeout` | `number` | `15000` | 单次请求超时（毫秒） |

### `FileInfo`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `fileName` | `string` | 文件名 |
| `fileSize` | `string` | 文件大小（站点原始字符串） |
| `updateTime` | `string?` | 更新时间 `YYYY-MM-DD HH:mm`（相对时间已换算） |
| `directLink` | `string \| null` | 下载直链，失败为 `null` |
| `error` | `string?` | 直链获取失败的原因 |

### 其他导出

- `BASE_UA` — 站点校验所用移动端 UA，下载直链时需携带
- `calcAcwScV2(arg1)` — 本地计算 `acw_sc__v2` WAF 挑战答案
- `parseSiteTime(raw)` / `absTime(raw)` — 站点时间字符串转时间戳 / 标准格式
- `resetCookies()` — 清空模块级 Cookie 容器（长驻进程重置 WAF 状态时使用）
- `CookieJar` / `extractParam` — `@internal`，测试与高级用途

## 注意事项

- **全局限速**：相邻请求间隔至少 1 秒（模块级共享，同一进程内所有调用共用），文件多时耗时线性增长，属预期行为
- **直链时效**：直链绑定 IP/UA 且会过期，请获取后立即使用；跨机器传递直链大概率失效
- **Cookie 复用**：模块级 Cookie 容器会跨调用复用 WAF 验证状态，通常有利；如遇异常可 `resetCookies()`
- **免责声明**：本项目仅供学习交流，请勿用于任何违反蓝奏云服务条款或法律法规的用途

## 开发

```sh
npm install
npm run build    # tsdown 构建 ESM + CJS + d.ts
npm test         # vitest 单元测试（不联网）
npm run example -- <分享链接> [密码]   # 端到端实测
```

### 发布

仓库已配置 [Trusted Publishing](https://docs.npmjs.com/generating-provenance-statements/)（OIDC）：

1. npmjs.com → Access Tokens → Trusted Publishers → 添加 `Akinohra/lanzou` + `release.yml`
2. 修改 `package.json` 的 `version` 并提交
3. 在 GitHub 创建对应 tag 的 Release，`release.yml` 自动执行 `npm publish --provenance`

## License

MIT
