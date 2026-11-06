#!/usr/bin/env node
/** 把 src/client.ts 编译成 CJS 并包上 ModuleLoader 横幅 → lib/client.js。
 *
 *  仓内 tsdown 0.4.x 没有 banner/footer 输出能力，而 client bundle 的横幅形状
 *  （window.__ModuleLoader__.load({ id, factory: (require) => {...} }) + module/exports
 *  intro + return module.exports footer）是浏览器 ModuleLoader 的装载契约
 *  （与官方 dsh-superagent、dsh-superagent-console 的 lib/client.js 逐字节同构），
 *  所以用仓内已有的 typescript 直接编译单文件再包装——零新增 npm 依赖。
 *
 *  横幅 id 必须等于 package.json 的包名 dsh-superagent-wechat（ModuleLoader 注册 id）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'dsh-wechat-client-'))
try {
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/client.ts',
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'es2024',
      '--strict',
      '--skipLibCheck',
      '--types', 'node',
      '--noEmit', 'false',
      '--outDir', tmp,
    ],
    { cwd: root, stdio: 'inherit' },
  )
  const body = readFileSync(join(tmp, 'client.js'), 'utf8')
  const banner = 'window.__ModuleLoader__.load({ id: "dsh-superagent-wechat", factory: (require) => {'
  const intro = 'var module = { exports: {} }; var exports = module.exports;'
  const footer = 'return module.exports; } });'
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'client.js'), banner + '\n' + intro + '\n' + body + '\n' + footer + '\n')
  console.log('[build-client] lib/client.js written (body ' + body.length + ' bytes)')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
