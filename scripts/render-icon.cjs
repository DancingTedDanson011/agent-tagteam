// Renders build/icon.svg to build/icon.png (512x512) with Playwright; electron-builder makes the .ico from it.
// Usage: node scripts/render-icon.cjs <path to a node_modules folder that contains playwright>
const path = require('node:path')
const { readFileSync } = require('node:fs')

const modules = process.argv[2]
if (!modules) throw new Error('usage: node scripts/render-icon.cjs <node_modules with playwright>')
const { chromium } = require(path.join(modules, 'playwright'))

;(async () => {
  const svg = readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8')
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)
  await page.locator('svg').screenshot({ path: path.join(__dirname, '..', 'build', 'icon.png'), omitBackground: true })
  await browser.close()
  console.log('build/icon.png written')
})()
