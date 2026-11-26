#!/usr/bin/env node
/**
 * Build the fnOS (飞牛) installable package for lxserver.
 *
 * Usage:
 *   node packaging/fnos/build-fpk.mjs [--skip-build] [--refresh-deps] [--skip-fpcalc]
 *
 * The resulting .fpk is written to packaging/fnos/dist/.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const stageRoot = path.join(here, '.stage')
const pkgDir = path.join(stageRoot, 'lxserver')
const depsDir = path.join(here, '.deps')
const distDir = path.join(here, 'dist')
const args = new Set(process.argv.slice(2))

const appName = 'lxserver'
const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const version = pkgJson.version
const fpkArch = 'x86'

const step = (msg) => console.log(`\n[fnos] ${msg}`)
const fail = (msg) => { throw new Error(msg) }
const exists = (p) => fs.existsSync(p)

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true })
}

function readManifest(file) {
  const data = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    data[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return data
}

function isElf(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(4)
  fs.readSync(fd, buf, 0, 4, 0)
  fs.closeSync(fd)
  return buf.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
}

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error(`too many redirects: ${url}`))
    https.get(url, { headers: { 'User-Agent': 'lxserver-fnos-build' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume()
        return resolve(httpGet(new URL(res.headers.location, url).toString(), redirects + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`GET ${url} -> ${res.statusCode}`))
      }
      resolve({ res, url })
    }).on('error', reject)
  })
}

async function downloadTo(url, dest) {
  const { res } = await httpGet(url)
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest)
    res.pipe(out)
    out.on('finish', () => out.close(resolve))
    out.on('error', reject)
    res.on('error', reject)
  })
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(full, name)
      if (found) return found
    } else if (entry.name === name) {
      return full
    }
  }
  return null
}

async function ensureFpcalc() {
  const binDir = path.join(repoRoot, 'public', 'music', 'bin')
  const dest = path.join(binDir, 'fpcalc-linux-x64')
  if (exists(dest)) {
    console.log('     fpcalc-linux-x64 already present')
    return
  }
  if (args.has('--skip-fpcalc')) {
    console.warn('     WARN: fpcalc-linux-x64 missing, fingerprinting will be disabled')
    return
  }

  console.log('     resolving latest chromaprint release ...')
  const latest = await httpGet('https://github.com/acoustid/chromaprint/releases/latest')
  latest.res.resume()
  const tag = /\/tag\/(v?[0-9.]+)$/.exec(latest.url)?.[1]
  if (!tag) fail(`cannot resolve chromaprint release from ${latest.url}`)
  const bare = tag.replace(/^v/, '')
  const fileName = `chromaprint-fpcalc-${bare}-linux-x86_64.tar.gz`
  const url = `https://github.com/acoustid/chromaprint/releases/download/${tag}/${fileName}`
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpcalc-'))
  const tmpArchive = path.join(tmpDir, fileName)
  const extractDir = path.join(tmpDir, 'extract')
  fs.mkdirSync(extractDir)

  console.log(`     downloading ${url}`)
  await downloadTo(url, tmpArchive)
  // Keep the archive name relative: GNU tar treats "C:\..." as a remote host.
  execSync(`tar -xzf "${fileName}" -C extract`, { cwd: tmpDir, stdio: 'inherit' })

  const binary = findFile(extractDir, 'fpcalc')
  if (!binary) fail('fpcalc binary not found in chromaprint archive')
  fs.mkdirSync(binDir, { recursive: true })
  fs.copyFileSync(binary, dest)
  try { fs.chmodSync(dest, 0o755) } catch {}

  fs.rmSync(tmpArchive, { force: true })
  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log('     fpcalc-linux-x64 ready')
}

async function ensureLinuxDeps() {
  const marker = path.join(depsDir, 'node_modules', '.package-lock.json')
  if (args.has('--refresh-deps') || !exists(marker)) {
    step('Installing linux-x64 production dependencies')
    fs.rmSync(depsDir, { recursive: true, force: true })
    fs.mkdirSync(depsDir, { recursive: true })
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(depsDir, 'package.json'))
    fs.copyFileSync(path.join(repoRoot, 'package-lock.json'), path.join(depsDir, 'package-lock.json'))
    execSync(
      'npm ci --omit=dev --ignore-scripts --no-audit --no-fund --os=linux --cpu=x64 --libc=glibc',
      { cwd: depsDir, stdio: 'inherit' },
    )
  } else {
    step('Reusing cached linux-x64 dependencies')
  }

  const required = [
    ['sharp native module', path.join(depsDir, 'node_modules/@img/sharp-linux-x64')],
    ['sharp libvips', path.join(depsDir, 'node_modules/@img/sharp-libvips-linux-x64')],
    ['music-tag native', path.join(depsDir, 'node_modules/music-tag-native-linux-x64-gnu')],
  ]
  for (const [label, dir] of required) {
    if (!exists(dir)) fail(`${label} missing (${dir}); run with --refresh-deps`)
  }
}

function findElfFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findElfFiles(full, acc)
    else if (entry.name.endsWith('.node') || entry.name.endsWith('.so') || entry.name.includes('.so.')) acc.push(full)
  }
  return acc
}

function validateLinuxBinaries(nodeModules) {
  const dirs = [
    path.join(nodeModules, '@img/sharp-linux-x64'),
    path.join(nodeModules, '@img/sharp-libvips-linux-x64'),
    path.join(nodeModules, 'music-tag-native-linux-x64-gnu'),
  ]
  for (const dir of dirs) {
    const elfFiles = findElfFiles(dir)
    if (!elfFiles.length) fail(`no ELF binaries found in ${dir}`)
    for (const file of elfFiles) {
      if (!isElf(file)) fail(`not a linux ELF binary: ${file} (wrong platform?)`)
    }
  }
  const bufferutil = path.join(nodeModules, 'bufferutil', 'prebuilds')
  if (exists(bufferutil)) {
    const linux = fs.readdirSync(bufferutil).filter((n) => n.startsWith('linux-x64'))
    if (!linux.length) console.warn('[fnos] WARN: bufferutil has no linux-x64 prebuild (optional, ws falls back to JS)')
  }
}

async function generateIcons() {
  step('Generating fnOS icons')
  const sharp = require('sharp')
  const source = path.join(repoRoot, 'public', 'icon.png')
  if (!exists(source)) fail('public/icon.png is missing')

  const tile = Buffer.from(
    `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
       <defs>
         <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
           <stop offset="0" stop-color="#f8fbff"/>
           <stop offset="1" stop-color="#e3efff"/>
         </linearGradient>
       </defs>
       <rect width="512" height="512" rx="112" ry="112" fill="url(#bg)"/>
     </svg>`,
  )
  const glyph = await sharp(source).resize(348, 348, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  const composed = await sharp(tile)
    .composite([{ input: glyph, gravity: 'center' }])
    .png()
    .toBuffer()

  const rootIcon = path.join(pkgDir, 'ICON.PNG')
  const rootIcon256 = path.join(pkgDir, 'ICON_256.PNG')
  const uiImages = path.join(pkgDir, 'app', 'ui', 'images')
  fs.mkdirSync(uiImages, { recursive: true })

  await sharp(composed).resize(64, 64).png().toFile(rootIcon)
  await sharp(composed).resize(256, 256).png().toFile(rootIcon256)
  await sharp(composed).resize(64, 64).png().toFile(path.join(uiImages, 'icon_64.png'))
  await sharp(composed).resize(256, 256).png().toFile(path.join(uiImages, 'icon_256.png'))

  const check = await sharp(rootIcon).metadata()
  if (check.width !== 64 || check.height !== 64) fail('ICON.PNG is not 64x64')
  const check256 = await sharp(rootIcon256).metadata()
  if (check256.width !== 256 || check256.height !== 256) fail('ICON_256.PNG is not 256x256')
}

function validatePackage() {
  step('Validating package layout')
  const required = [
    'manifest',
    'ICON.PNG',
    'ICON_256.PNG',
    'config/privilege',
    'config/resource',
    'cmd/main',
    'cmd/install_callback',
    'wizard/install',
    'app/ui/config',
    'app/ui/images/icon_64.png',
    'app/ui/images/icon_256.png',
    'app/index.js',
    'app/server/index.js',
    'app/public/index.html',
  ]
  for (const rel of required) {
    if (!exists(path.join(pkgDir, rel))) fail(`missing ${rel}`)
  }

  const manifest = readManifest(path.join(pkgDir, 'manifest'))
  if (manifest.appname !== appName) fail(`manifest.appname must be ${appName}`)
  if (manifest.version !== version) fail(`manifest.version must be ${version}`)
  if (manifest.platform !== fpkArch) fail(`manifest.platform must be ${fpkArch}`)
  if (!manifest.install_dep_apps?.includes('nodejs_v22')) fail('manifest.install_dep_apps must include nodejs_v22')
  if (manifest.desktop_applaunchname !== `${appName}.main`) fail('manifest.desktop_applaunchname mismatch')

  for (const rel of ['config/privilege', 'config/resource', 'app/ui/config', 'wizard/install']) {
    JSON.parse(fs.readFileSync(path.join(pkgDir, rel), 'utf8'))
  }

  const entryConfig = JSON.parse(fs.readFileSync(path.join(pkgDir, 'app/ui/config'), 'utf8'))
  const entry = entryConfig['.url']?.[`${appName}.main`]
  if (!entry) fail(`app/ui/config is missing ${appName}.main`)
  if (String(entry.port) !== '${wizard_port}') fail('app/ui/config port must use ${wizard_port}')
  if (!String(entry.icon).includes('{0}')) fail('app/ui/config icon must use {0}')

  const resource = JSON.parse(fs.readFileSync(path.join(pkgDir, 'config/resource'), 'utf8'))
  const shares = resource['data-share']?.shares?.map((s) => s.name) ?? []
  if (!shares.includes(`${appName}/music`)) fail(`config/resource must declare ${appName}/music`)

  const bundledConfig = require(path.join(pkgDir, 'app', 'config.js'))
  if (!Array.isArray(bundledConfig.users) || bundledConfig.users.length) {
    fail('app/config.js must not ship demo users')
  }
  if (bundledConfig['admin.password'] !== '123456') {
    fail('app/config.js admin.password template changed unexpectedly')
  }

  validateLinuxBinaries(path.join(pkgDir, 'app', 'node_modules'))
  console.log('     manifest, configs, icons and linux binaries look good')
}

function runFnpack() {
  step('Packing with fnpack')
  fs.mkdirSync(distDir, { recursive: true })
  const tool = process.env.FNPACK
    || (process.platform === 'win32'
      ? path.join(here, '.tools', 'fnpack.exe')
      : (exists(path.join(here, '.tools', 'fnpack')) ? path.join(here, '.tools', 'fnpack') : 'fnpack'))
  if (tool.includes(path.sep) && !exists(tool)) {
    fail(`fnpack not found at ${tool}. Download it from https://static2.fnnas.com/fnpack/`)
  }
  const before = new Set(fs.readdirSync(here).filter((n) => n.endsWith('.fpk')))
  execSync(`"${tool}" build --directory "${path.join(stageRoot, 'lxserver')}"`, { cwd: here, stdio: 'inherit' })

  const produced = fs.readdirSync(here)
    .filter((n) => n.endsWith('.fpk') && !before.has(n))
    .map((n) => path.join(here, n))
  if (!produced.length) fail('fnpack did not produce an .fpk file')

  const source = produced.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
  const target = path.join(distDir, `${appName}-${version}-${fpkArch}.fpk`)
  fs.rmSync(target, { force: true })
  fs.renameSync(source, target)
  return target
}

async function main() {
  if (!args.has('--skip-build')) {
    step('Building server and frontend assets')
    execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' })
  }

  await ensureFpcalc()
  await ensureLinuxDeps()

  step('Preparing fnOS package directory')
  fs.rmSync(stageRoot, { recursive: true, force: true })
  fs.mkdirSync(pkgDir, { recursive: true })

  for (const name of ['manifest', 'config', 'cmd', 'wizard']) {
    copyDir(path.join(here, name), path.join(pkgDir, name))
  }
  copyDir(path.join(here, 'app'), path.join(pkgDir, 'app'))

  const appPieces = ['index.js', 'package.json']
  for (const name of appPieces) {
    const src = path.join(repoRoot, name)
    if (!exists(src)) fail(`missing build artifact: ${name}`)
    fs.copyFileSync(src, path.join(pkgDir, 'app', name))
  }
  // The bundled fallback config must be the clean template, never the local
  // development config that may contain users and credentials.
  fs.copyFileSync(path.join(here, 'config.template.js'), path.join(pkgDir, 'app', 'config.js'))
  for (const name of ['server', 'public']) {
    const src = path.join(repoRoot, name)
    if (!exists(src)) fail(`missing build artifact: ${name}`)
    copyDir(src, path.join(pkgDir, 'app', name))
  }
  // The fnOS package only needs the linux helper binary.
  fs.rmSync(path.join(pkgDir, 'app', 'public', 'music', 'bin', 'fpcalc.exe'), { force: true })

  copyDir(path.join(depsDir, 'node_modules'), path.join(pkgDir, 'app', 'node_modules'))

  await generateIcons()
  validatePackage()

  const fpk = runFnpack()
  const size = (fs.statSync(fpk).size / 1024 / 1024).toFixed(1)
  console.log(`\n[fnos] Done: ${fpk} (${size} MB)`)
  console.log('[fnos] Install via 飞牛应用中心 -> 手动安装, or: appcenter-cli install-fpk <file>')
}

main().catch((err) => {
  console.error(`\n[fnos] Build failed: ${err.message}`)
  process.exit(1)
})
