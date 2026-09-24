/**
 * 使用示例：npm run example -- <分享链接> [密码]
 * 例如：npm run example -- https://wwp.lanzouj.com/xxxxx abc1
 */
import { BASE_UA, checkLanzouUrl, getLanzouFiles, getLatestFile } from '../src'

const url = process.argv[2] ?? ''
const pwd = process.argv[3] ?? ''

async function main() {
  if (!url) {
    console.error('用法: npm run example -- <分享链接> [密码]')
    process.exit(1)
  }

  const check = checkLanzouUrl(url)
  if (!check.valid) {
    console.error(check.message)
    process.exit(1)
  }

  // 场景A：只取最新文件（如自动更新场景，请求数最少）
  const latest = await getLatestFile(url, { pwd, debug: true })
  if (latest) {
    console.log('\n=== 最新文件 ===')
    console.log(`文件名: ${latest.fileName}`)
    console.log(`大小: ${latest.fileSize}`)
    console.log(`更新时间: ${latest.updateTime ?? '未知'}`)
    console.log(`直链: ${latest.directLink}`)
    console.log(`（下载时请携带同款UA:\n  User-Agent: ${BASE_UA}）`)
  } else {
    console.error('未获取到最新文件')
  }

  // 场景B：获取全部文件的直链（文件较多时耗时较长，已内置1秒/请求限速）
  // const files = await getLanzouFiles(url, { pwd, debug: true })
  // for (const f of files) {
  //   console.log(f.directLink ? `✓ ${f.fileName} -> ${f.directLink}` : `✗ ${f.fileName}: ${f.error}`)
  // }
}

main()
