#!/usr/bin/env node

import process from 'node:process'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const apiBase = (process.env.LX_MUSIC_API_URL ?? 'http://127.0.0.1:23330').replace(/\/$/, '')
let frameWidth = 68
let lastFrameWidth = 0
let splitLeft = 22
let splitRight = 43
const useColor = process.env.NO_COLOR !== '1'
let latestStatus = null
let message = 'Connecting to LX Music...'
let refreshing = false
let mode = 'NORMAL'
let commandBuffer = ''
let hasRendered = false
let sidebarOpen = false
let focus = 'main'
let sidebarIndex = 0
let playlists = []
let leaderPending = false
let leaderTimer = null

const displayWidth = (value) => {
  let width = 0
  for (const char of String(value)) {
    const code = char.codePointAt(0)
    if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xa960 && code <= 0xa97f) || (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd) ||
        (code >= 0x1f300 && code <= 0x1faff)) {
      width += 2
    } else if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x1ab0 && code <= 0x1aff) ||
               (code >= 0xfe20 && code <= 0xfe2f)) {
      width += 0
    } else {
      width += 1
    }
  }
  return width
}
const fit = (value = '', width = frameWidth - 2) => {
  const text = String(value)
  let visible = ''
  let used = 0
  for (const char of text) {
    const charWidth = displayWidth(char)
    if (used + charWidth > width) break
    visible += char
    used += charWidth
  }
  return visible + ' '.repeat(width - used)
}
const paint = (code, value) => useColor ? `\x1b[${code}m${value}\x1b[0m` : value
const cyan = (value) => paint('38;5;81', value)
const violet = (value) => paint('38;5;141', value)
const green = (value) => paint('38;5;114', value)
const yellow = (value) => paint('38;5;221', value)
const dim = (value) => paint('2', value)
const inverse = (value) => paint('7', value)
const formatTime = (seconds = 0) => {
  const total = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
const progressBar = (progress = 0, duration = 0, width = 30) => {
  const filled = duration > 0 ? Math.round(Math.min(progress / duration, 1) * width) : 0
  return `${'='.repeat(filled)}>${'-'.repeat(Math.max(0, width - filled - 1))}`
}
const row = (text = '') => `│${fit(text)}│`
const divider = () => `├${'─'.repeat(frameWidth - 2)}┤`
const splitRow = (left = '', right = '') => `│${fit(left, splitLeft)}│${fit(right, splitRight)}│`
const sidebarEntries = () => [{ name: 'Now Playing', kind: 'now' }, ...playlists]

const loadPlaylists = async () => {
  try {
    const contents = await readFile(new URL('../config/playlists.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(contents)
    playlists = (Array.isArray(parsed.playlists) ? parsed.playlists : [])
      .filter((item) => item?.name && item?.source && (item.id || item.url))
    sidebarIndex = Math.min(sidebarIndex, Math.max(0, sidebarEntries().length - 1))
  } catch {
    playlists = []
  }
}

const render = () => {
  frameWidth = Math.max(40, Math.min(process.stdout.columns ?? 80, 140))
  if (frameWidth !== lastFrameWidth) {
    lastFrameWidth = frameWidth
    hasRendered = false
  }
  splitLeft = Math.max(14, Math.round((frameWidth - 3) * 0.34))
  splitRight = frameWidth - 3 - splitLeft
  const s = latestStatus
  const title = s ? `${s.name || 'Unknown title'} - ${s.singer || 'Unknown artist'}` : 'Player unavailable'
  const isPlaying = s?.status === 'playing'
  const icon = isPlaying ? '>>' : '||'
  const stateLabel = isPlaying ? 'PLAYING' : (s?.status === 'paused' ? 'PAUSED' : 'OFFLINE')
  const progress = s
    ? `${formatTime(s.progress)} [${progressBar(s.progress, s.duration)}] ${formatTime(s.duration)}`
    : 'Waiting for API response...'
  const commandLine = mode === 'COMMAND'
    ? `:${commandBuffer}`
    : 'NORMAL  Space play/pause  h/l prev/next  : command  ? help  q quit'
  const mainLines = [
    'NOW PLAYING',
    `${icon} ${title}`,
    `Album: ${s?.albumName || '-'}`,
    `Status: ${stateLabel}    Volume: ${s?.volume ?? '-'}%`,
    progress,
    '',
    s?.lyricLineText || '~',
    '',
    message,
    commandLine,
  ]
  const entries = sidebarEntries()
  const sideLines = [
    'PLAYLISTS',
    ...entries.map((entry, index) => `${focus === 'sidebar' && index === sidebarIndex ? '>' : ' '} ${entry.name}`),
    '',
    'j/k  select    Enter play',
    'Space,e       toggle panel',
    'Ctrl-h/l      change focus',
  ]
  const statusColor = isPlaying ? green : yellow
  const headerLabel = ' LX-TUI  //  MUSIC IN THE TERMINAL '
  const compactHeader = violet(`╭─${headerLabel}${'─'.repeat(Math.max(1, frameWidth - 3 - displayWidth(headerLabel)))}╮`)
  const compactFooter = dim(`╰${'─'.repeat(frameWidth - 2)}╯`)
  const splitHeader = violet(`╭${'─'.repeat(splitLeft)}┬${'─'.repeat(splitRight)}╮`)
  const splitFooter = dim(`╰${'─'.repeat(splitLeft)}┴${'─'.repeat(splitRight)}╯`)
  const screen = sidebarOpen ? [
    splitHeader,
    ...mainLines.map((line, index) => {
      const raw = splitRow(sideLines[index] || '', line)
      if (index === 0) return cyan(raw)
      if (focus === 'sidebar' && index === sidebarIndex + 1) return inverse(raw)
      if (index === 3) return statusColor(raw)
      if (index === 4) return cyan(raw)
      if (index === 8) return dim(raw)
      if (index === 9) return violet(raw)
      return raw
    }),
    splitFooter,
  ].join('\n') : [
    compactHeader,
    cyan(row(mainLines[1])),
    dim(row(mainLines[2])),
    statusColor(row(mainLines[3])),
    cyan(row(mainLines[4])),
    row(mainLines[5]),
    row(mainLines[6]),
    dim(divider()),
    dim(row(mainLines[8])),
    violet(row(mainLines[9])),
    compactFooter,
  ].join('\n')

  // Repositioning the cursor avoids PowerShell's visible clear-screen flash.
  process.stdout.write(hasRendered ? '\x1b[H' : '\x1b[2J\x1b[H')
  process.stdout.write(screen)
  hasRendered = true
}

const request = async (path, params = {}) => {
  const url = new URL(`${apiBase}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response
}

const refresh = async () => {
  if (refreshing) return
  refreshing = true
  try {
    latestStatus = await (await request('/status', {
      filter: 'status,name,singer,albumName,lyricLineText,duration,progress,volume',
    })).json()
    if (!message.startsWith('Sent ') && !message.startsWith('Command ')) message = `Connected: ${apiBase}`
  } catch (error) {
    latestStatus = null
    message = `API unavailable: ${error.message}`
  } finally {
    refreshing = false
    render()
  }
}

const control = async (path, params = {}) => {
  try {
    await request(path, params)
    message = `Sent ${path}`
  } catch (error) {
    message = `Operation failed: ${error.message}`
  }
  await refresh()
}

const playSelectedPlaylist = () => {
  const entry = sidebarEntries()[sidebarIndex]
  if (!entry || entry.kind === 'now') {
    message = 'Now Playing is already selected'
    render()
    return
  }
  const data = encodeURIComponent(JSON.stringify({ source: entry.source, ...(entry.id ? { id: entry.id } : { url: entry.url }) }))
  const schemeUrl = `lxmusic://songlist/play?data=${data}`
  const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', schemeUrl], { detached: true, stdio: 'ignore' })
  child.unref()
  message = `Opening playlist: ${entry.name}`
  render()
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const runCommand = async (input) => {
  const [name, rawValue] = input.trim().split(/\s+/, 2)
  const value = Number(rawValue)
  if (!name) return
  if (name === 'q' || name === 'quit') {
    cleanup()
    process.exit(0)
  }
  if (name === 'play') return control('/play')
  if (name === 'pause') return control('/pause')
  if (name === 'next') return control('/skip-next')
  if (name === 'prev') return control('/skip-prev')
  if (name === 'now') return refresh()
  if (name === 'reload') {
    await loadPlaylists()
    message = `Loaded ${playlists.length} configured playlists`
    render()
    return
  }
  if (name === 'vol' && Number.isFinite(value)) return control('/volume', { volume: clamp(Math.round(value), 1, 100) })
  if (name === 'seek' && Number.isFinite(value)) return control('/seek', { offset: Math.max(0, Math.round(value)) })
  message = name === 'help'
    ? 'Commands: :play :pause :next :prev :vol 50 :seek 90 :reload :now :q'
    : `Unknown command: ${name}. Try :help`
  render()
}

const cleanup = () => {
  clearTimeout(leaderTimer)
  process.stdout.write('\x1b[?25h\x1b[?1049l')
  process.stdin.setRawMode?.(false)
  process.stdin.pause()
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('lx-tui requires an interactive terminal.')
  process.exit(1)
}

process.stdout.write('\x1b[?1049h\x1b[?25l')
// Windows console resize event (Node >= 14.17); the 1s refresh interval is
// the fallback on platforms where this never fires.
process.on('resize', render)
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.setEncoding('utf8')
process.stdin.on('data', async (chunk) => {
  for (const key of chunk) {
  if (mode === 'COMMAND') {
    if (key === '\r' || key === '\n') {
      const command = commandBuffer
      commandBuffer = ''
      mode = 'NORMAL'
      await runCommand(command)
      continue
    }
    if (key === '\u001b') {
      mode = 'NORMAL'
      commandBuffer = ''
      message = 'Command cancelled'
      render()
      continue
    }
    if (key === '\u0008' || key === '\u007f') commandBuffer = commandBuffer.slice(0, -1)
    else if (key.length === 1) commandBuffer += key
    render()
    continue
  }

  if (leaderPending) {
    leaderPending = false
    clearTimeout(leaderTimer)
    leaderTimer = null
    if (key === 'e') {
      sidebarOpen = !sidebarOpen
      if (!sidebarOpen) focus = 'main'
      message = sidebarOpen ? 'Sidebar opened' : 'Sidebar closed'
      render()
      continue
    }
    // Non-'e' keys resolve the leader: play/pause fires, and the key falls
    // through to its own handler below. A second Space is consumed here
    // because the play/pause above already accounts for it.
    await control(latestStatus?.status === 'playing' ? '/pause' : '/play')
    if (key === ' ') continue
  }

  if (key === ' ') {
    leaderPending = true
    message = 'Leader: press e to toggle sidebar'
    render()
    leaderTimer = setTimeout(async () => {
      if (!leaderPending) return
      leaderPending = false
      await control(latestStatus?.status === 'playing' ? '/pause' : '/play')
    }, 350)
    continue
  }
  if (key === '\u0008' && sidebarOpen) {
    focus = 'sidebar'
    message = 'Focus: sidebar'
    render()
    continue
  }
  if (key === '\u000c' && sidebarOpen) {
    focus = 'main'
    message = 'Focus: main'
    render()
    continue
  }
  if (focus === 'sidebar' && key === 'j') {
    sidebarIndex = Math.min(sidebarIndex + 1, sidebarEntries().length - 1)
    render()
    continue
  }
  if (focus === 'sidebar' && key === 'k') {
    sidebarIndex = Math.max(sidebarIndex - 1, 0)
    render()
    continue
  }
  if (focus === 'sidebar' && (key === '\r' || key === '\n')) {
    playSelectedPlaylist()
    continue
  }

  if (key === 'q' || key === '\u0003') {
    cleanup()
    process.exit(0)
  }
  if (key === ':') {
    mode = 'COMMAND'
    commandBuffer = ''
    render()
    continue
  }
  if (key === '?') {
    message = 'Keys: Space,e sidebar; Ctrl-h/l focus; j/k select; Enter play; : command'
    render()
    return
  }
  if (key === 'h') await control('/skip-prev')
  if (key === 'l') await control('/skip-next')
  if (key === '[') await control('/seek', { offset: Math.max(0, Math.floor((latestStatus?.progress ?? 0) - 5)) })
  if (key === ']') await control('/seek', { offset: Math.floor((latestStatus?.progress ?? 0) + 5) })
  if (key === '-') await control('/volume', { volume: clamp((latestStatus?.volume ?? 50) - 5, 1, 100) })
  if (key === '+') await control('/volume', { volume: clamp((latestStatus?.volume ?? 50) + 5, 1, 100) })
  }
})
process.on('exit', cleanup)

await loadPlaylists()
await refresh()
setInterval(refresh, 1000)
