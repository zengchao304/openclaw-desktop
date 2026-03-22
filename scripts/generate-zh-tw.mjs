/**
 * 由 zh-CN.json 產生 zh-TW.json（僅轉換字串值，保留 i18n 鍵名與插值如 {{port}}）。
 * 執行：pnpm run i18n:zh-tw
 */
import * as OpenCC from 'opencc-js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const zhCNPath = path.join(root, 'src/renderer/i18n/locales/zh-CN.json')
const zhTWPath = path.join(root, 'src/renderer/i18n/locales/zh-TW.json')

const converter = OpenCC.Converter({ from: 'cn', to: 'tw' })

function convertValues(obj) {
  if (typeof obj === 'string') return converter(obj)
  if (Array.isArray(obj)) return obj.map(convertValues)
  if (obj && typeof obj === 'object') {
    const out = {}
    for (const k of Object.keys(obj)) {
      out[k] = convertValues(obj[k])
    }
    return out
  }
  return obj
}

const data = JSON.parse(fs.readFileSync(zhCNPath, 'utf8'))
const out = convertValues(data)
fs.writeFileSync(zhTWPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log('Wrote', zhTWPath)
