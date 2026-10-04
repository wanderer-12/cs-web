<#
  CSP 启动器
  ==========
  平时不用手动跑这个脚本，双击项目根目录的：
      `启动游戏.cmd`   —— 直接开玩（开发模式，热更新）
      `启动器菜单.cmd` —— 菜单：生产模式 / 构建 / 测试 / 启动参数

  想用命令行时：
      powershell -File launcher\play.ps1                    # 菜单
      powershell -File launcher\play.ps1 -Mode dev          # 开发模式，端口 5174
      powershell -File launcher\play.ps1 -Mode prod         # 生产模式，需要时先构建，端口 4173
      powershell -File launcher\play.ps1 -Mode build        # 只构建 dist/
      powershell -File launcher\play.ps1 -Mode test         # 跑测试
      powershell -File launcher\play.ps1 -Mode params       # 改默认启动参数
      powershell -File launcher\play.ps1 -DryRun            # 只打印环境与 URL，不启动
      ... -NoBrowser                                        # 不自动开浏览器
      ... -UrlParams "perf=1"                               # 追加 URL 参数

  为什么不能直接双击 dist\index.html：页面是 ES module + WebGL，浏览器按 file:// 的
  跨域规则会把它拦掉（CORS），必须经由本地 HTTP 服务器。开发模式与生产模式玩到的
  是同一份游戏逻辑，区别只是「改代码即时生效」还是「加载更快」。
#>
[CmdletBinding()]
param(
  [ValidateSet('menu', 'dev', 'prod', 'build', 'test', 'params')]
  [string]$Mode = 'menu',
  [int]$Port = 0,
  [string]$UrlParams = '',
  [switch]$NoBrowser,
  [switch]$Reinstall,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$script:Root            = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:SettingsFile    = Join-Path $PSScriptRoot 'settings.txt'
$script:DefaultDevPort  = 5174
$script:DefaultProdPort = 4173
$script:Difficulties    = @('easy', 'normal', 'hard', 'expert')

# ============================================================================
# 输出
# ============================================================================

function Write-Rule([string]$title) {
  Write-Host ''
  Write-Host ('  ' + $title) -ForegroundColor Cyan
  Write-Host ('  ' + ('-' * 62)) -ForegroundColor DarkGray
}
function Write-Ok([string]$text)   { Write-Host ('  [ok] ' + $text) -ForegroundColor Green }
function Write-Info([string]$text) { Write-Host ('  [..] ' + $text) -ForegroundColor Gray }
function Write-Note([string]$text) { Write-Host ('  [!!] ' + $text) -ForegroundColor Yellow }
function Write-Bad([string]$text)  { Write-Host ('  [xx] ' + $text) -ForegroundColor Red }

function Show-Banner {
  Write-Host ''
  Write-Host '  =================================================================' -ForegroundColor DarkCyan
  Write-Host '   CSP  -  browser 3D FPS, single player vs bots        (launcher)' -ForegroundColor Cyan
  Write-Host '  =================================================================' -ForegroundColor DarkCyan
  Write-Host ('   ' + $script:Root) -ForegroundColor DarkGray
}

function Show-Controls {
  Write-Host ''
  Write-Host '  操作: WASD 移动 | 左键 射击 | R 换弹 | E 埋/拆包 | B 买枪 | Tab 计分板' -ForegroundColor DarkGray
  Write-Host '        Shift 静步 | C 下蹲 | Space 跳 | 1-5 换武器 | G 丢包 | F3 性能统计' -ForegroundColor DarkGray
}

# ============================================================================
# 环境检查
# ============================================================================

function Test-Command([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Get-NodeMajor {
  $raw = (& node --version) -replace '^v', ''
  return [int](($raw -split '\.')[0])
}

function Assert-Env {
  Write-Rule '环境'
  if (-not (Test-Command 'node')) {
    Write-Bad '找不到 node。请装 Node.js LTS: https://nodejs.org/'
    exit 1
  }
  $major = Get-NodeMajor
  Write-Ok ('node ' + (& node --version) + '  (' + $env:PROCESSOR_ARCHITECTURE + ')')
  if ($major -lt 20) {
    Write-Note ('Node ' + $major + '.x 偏旧，Vite 8 期望 20.19+ / 22.12+，可能起不来。')
  }

  if (-not (Test-Command 'pnpm')) {
    Write-Note '找不到 pnpm。'
    if (Test-Command 'corepack') {
      $answer = Read-Host '   用 corepack 打开 pnpm 吗? (y/N)'
      if ($answer -match '^[Yy]') {
        & corepack enable pnpm | Out-Host
        if ($LASTEXITCODE -ne 0 -or -not (Test-Command 'pnpm')) {
          Write-Bad 'corepack enable pnpm 失败，请手动安装: https://pnpm.io/installation'
          exit 1
        }
      } else {
        Write-Bad '这个项目必须用 pnpm（package.json 里 pin 了 pnpm@12.9.0）。'
        exit 1
      }
    } else {
      Write-Bad '请先安装 pnpm: https://pnpm.io/installation'
      exit 1
    }
  }
  Write-Ok ('pnpm ' + (& pnpm --version))

  # 依赖：平时只是为了确认装过，缺了才去联网
  $modules = Join-Path $script:Root 'node_modules'
  $broken = -not (Test-Path (Join-Path $modules 'three\package.json')) -or -not (Test-Path (Join-Path $modules '.pnpm'))
  if ($Reinstall) { Write-Note '-Reinstall 已指定，稍后重装依赖。' }
  elseif ($broken) { Write-Note '依赖缺失或不完整，稍后自动 pnpm install。' }
  else { Write-Ok 'node_modules 已就绪' }
  return $broken
}

function Install-Deps {
  Write-Info 'pnpm install …（首次会联网下载 three 与 vite，约几十 MB）'
  & pnpm install | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Bad 'pnpm install 失败。检查网络 / 代理后重试，或在别的机器上复制一份 node_modules。'
    return $false
  }
  Write-Ok '依赖安装完成'
  return $true
}

# ============================================================================
# 启动参数（保存在 launcher\settings.txt，可直接用记事本改）
# ============================================================================

function Read-Settings {
  $s = @{ difficulty = 'normal'; team = ''; seed = 'random'; name = ''; stats = '0' }
  if (Test-Path -LiteralPath $script:SettingsFile) {
    foreach ($line in (Get-Content -LiteralPath $script:SettingsFile -Encoding UTF8)) {
      $clean = $line.TrimStart([char]0xFEFF).Trim()
      if ($clean.Length -eq 0 -or $clean.StartsWith('#') -or -not $clean.Contains('=')) { continue }
      $parts = $clean.Split('=', 2)
      $key = $parts[0].Trim()
      if ($s.ContainsKey($key)) { $s[$key] = $parts[1].Trim() }
    }
  }
  return $s
}

function Save-Settings($s) {
  # 注意：Windows PowerShell 5.1 里，@() 数组字面量中的逗号比二元 + 更紧——
  # 写成 @('k=' + $v, 'k2=' + $v2) 会被解析成 4 个元素（实测 count 由 3 变 5，
  # 文件里会出现 'difficulty=' 与 'normal' 各占一行）。这里一律用字符串插值。
  $lines = @(
    '# CSP 启动器设置 —— 也可以用「启动器菜单.cmd」-> 5 来改（记事本直接改也行）',
    '# difficulty: easy | normal | hard | expert',
    '# team:       T | CT | 留空 = 随机',
    '# seed:       数字 | random',
    '# name:       玩家名字，留空 = 默认',
    '# stats:      1 = 每 5 秒打印一行帧率/绘制调用统计（也可以游戏里按 F3）',
    "difficulty=$($s['difficulty'])",
    "team=$($s['team'])",
    "seed=$($s['seed'])",
    "name=$($s['name'])",
    "stats=$($s['stats'])"
  )
  Set-Content -LiteralPath $script:SettingsFile -Value $lines -Encoding UTF8
}

function Format-Settings($s) {
  $team = '随机'
  if ($s['team']) { $team = $s['team'] }
  $seed = '随机'
  if ($s['seed'] -and $s['seed'] -ne 'random') { $seed = $s['seed'] }
  $stats = '关'
  if ($s['stats'] -eq '1') { $stats = '开' }
  return ('难度 ' + $s['difficulty'] + ' | 队伍 ' + $team + ' | 种子 ' + $seed + ' | 统计 ' + $stats)
}

function Get-GameUrl([string]$base, $s, [string]$extra) {
  $query = @()
  if ($s['difficulty']) { $query += ('difficulty=' + $s['difficulty']) }
  if ($s['team']) { $query += ('team=' + $s['team']) }
  if ($s['seed'] -and $s['seed'] -ne 'random') { $query += ('seed=' + $s['seed']) }
  if ($s['name']) { $query += ('name=' + [uri]::EscapeDataString($s['name'])) }
  if ($s['stats'] -eq '1') { $query += 'stats=1' }
  if ($extra) { $query += $extra.TrimStart('?', '&') }
  if ($query.Count -eq 0) { return $base }
  return ($base + '/?' + ($query -join '&'))
}

function Edit-Params {
  $s = Read-Settings
  Show-Banner
  Write-Rule '启动参数（每项回车 = 保持当前值）'

  while ($true) {
    $raw = Read-Host ('   难度 easy / normal / hard / expert  [当前 ' + $s['difficulty'] + ']')
    if ([string]::IsNullOrWhiteSpace($raw)) { break }
    $v = $raw.Trim().ToLower()
    if ($script:Difficulties -contains $v) { $s['difficulty'] = $v; break }
    Write-Note ('只接受: ' + ($script:Difficulties -join ' / '))
  }

  while ($true) {
    $shown = '随机'
    if ($s['team']) { $shown = $s['team'] }
    $raw = Read-Host ('   我方队伍 T / CT / 随机  [当前 ' + $shown + ']（输入 - 表示随机）')
    if ([string]::IsNullOrWhiteSpace($raw)) { break }
    $v = $raw.Trim().ToUpper()
    if ($v -eq '-' -or $v -eq 'RANDOM' -or $v -eq '随机') { $s['team'] = ''; break }
    if ($v -eq 'T' -or $v -eq 'CT') { $s['team'] = $v; break }
    Write-Note '只接受 T / CT / 随机'
  }

  while ($true) {
    $shown = '随机'
    if ($s['seed'] -and $s['seed'] -ne 'random') { $shown = $s['seed'] }
    $raw = Read-Host ('   随机种子 数字 / random  [当前 ' + $shown + ']')
    if ([string]::IsNullOrWhiteSpace($raw)) { break }
    $v = $raw.Trim().ToLower()
    if ($v -eq 'random' -or $v -eq 'rand') { $s['seed'] = 'random'; break }
    if ($v -match '^\d+$') { $s['seed'] = $v; break }
    Write-Note '只接受数字或 random'
  }

  $raw = Read-Host ('   玩家名字  [当前 ' + ($(if ($s['name']) { $s['name'] } else { '默认' })) + ']（输入 - 表示清空）')
  if (-not [string]::IsNullOrWhiteSpace($raw)) {
    $name = $raw.Trim()
    if ($name -eq '-') { $s['name'] = '' } else { $s['name'] = $name }
  }

  $raw = Read-Host ('   每 5 秒打印帧率/绘制调用统计? y/N  [当前 ' + ($(if ($s['stats'] -eq '1') { 'y' } else { 'n' })) + ']')
  if (-not [string]::IsNullOrWhiteSpace($raw)) {
    if ($raw -match '^[Yy]') { $s['stats'] = '1' } else { $s['stats'] = '0' }
  }

  Save-Settings $s
  Write-Ok ('已保存: ' + (Format-Settings $s))
  Write-Host ('   ' + $script:SettingsFile) -ForegroundColor DarkGray
}

# ============================================================================
# 端口 / 服务器
# ============================================================================

function Test-PortBusy([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $port)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Find-FreePort([int]$start, [int]$span = 20) {
  for ($p = $start; $p -lt ($start + $span); $p++) {
    if (-not (Test-PortBusy $p)) { return $p }
  }
  return $start
}

function Test-Serving([string]$url, [int]$seconds = 2) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200) { return $true }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  return $false
}

function Open-Game([string]$url) {
  if ($NoBrowser) {
    Write-Info '(-NoBrowser：不自动打开浏览器，请自己访问上面的地址)'
    return
  }
  Write-Info '正在打开浏览器…'
  Start-Process $url
}

function Test-BuildStale {
  $index = Join-Path $script:Root 'dist\index.html'
  if (-not (Test-Path -LiteralPath $index)) { return $true }
  $built = (Get-Item -LiteralPath $index).LastWriteTime
  $newest = (Get-Item -LiteralPath (Join-Path $script:Root 'index.html')).LastWriteTime
  $src = Join-Path $script:Root 'src'
  if (Test-Path -LiteralPath $src) {
    $file = Get-ChildItem -LiteralPath $src -Recurse -File |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($file -and $file.LastWriteTime -gt $newest) { $newest = $file.LastWriteTime }
  }
  $config = Join-Path $script:Root 'vite.config.ts'
  if (Test-Path -LiteralPath $config) {
    $cfg = (Get-Item -LiteralPath $config).LastWriteTime
    if ($cfg -gt $newest) { $newest = $cfg }
  }
  return ($newest -gt $built)
}

function Invoke-Pnpm([string[]]$argv, [string]$label) {
  Write-Host ''
  Write-Info ($label + '  ->  pnpm ' + ($argv -join ' '))
  # | Out-Host 而不是裸调用：否则 pnpm 的每一行输出都会进入函数返回值，
  # $code 变成一个数组（输出行 + 退出码），判断就会失灵、构建/测试的日志也看不见。
  & pnpm @argv | Out-Host
  $code = $LASTEXITCODE
  Write-Host ''
  if ($code -eq 0) { Write-Ok ($label + ' 完成') } else { Write-Bad ($label + ' 失败 (exit ' + $code + ')') }
  return [int]$code
}

# ============================================================================
# 动作
# ============================================================================

function Start-Game([string]$kind) {
  $settings = Read-Settings
  if ($Port -gt 0) { $preferred = $Port }
  elseif ($kind -eq 'prod') { $preferred = $script:DefaultProdPort }
  else { $preferred = $script:DefaultDevPort }

  $alreadyRunning = $false
  $port = $preferred
  if (Test-PortBusy $preferred) {
    # 有可能就是上一次没关掉的服务器：能应答 HTTP 就直接复用，省一次启动
    if (Test-Serving ('http://localhost:' + $preferred + '/')) {
      $alreadyRunning = $true
      Write-Ok ('端口 ' + $preferred + ' 上已经有一个服务器在跑，直接用它。')
    } else {
      $port = Find-FreePort ($preferred + 1)
      Write-Note ('端口 ' + $preferred + ' 被别的程序占用，改用 ' + $port + '。')
    }
  }

  $url = Get-GameUrl ('http://localhost:' + $port) $settings $UrlParams

  if ($alreadyRunning) {
    Write-Host ''
    Write-Host ('   游戏地址: ' + $url) -ForegroundColor Green
    Open-Game $url
    return
  }

  if ($kind -eq 'prod') {
    if (Test-BuildStale) {
      Write-Info 'dist/ 不存在或比源码旧，先构建（tsc + vite build）…'
      $code = Invoke-Pnpm @('build') '构建'
      if ($code -ne 0) { Write-Note '构建失败。可以先用开发模式（1），它的报错更直观。'; return }
    } else {
      Write-Ok 'dist/ 是最新的，跳过构建'
    }
    $argv = @('preview', '--port', "$port", '--strictPort')
    $label = '生产模式预览服务器'
  } else {
    $argv = @('dev', '--port', "$port", '--strictPort')
    $label = '开发服务器（热更新）'
  }

  Write-Rule '启动'
  Write-Host ('   游戏地址: ' + $url) -ForegroundColor Green
  Write-Host ('   停止: 在这个窗口按 Ctrl+C，或直接关闭窗口' ) -ForegroundColor DarkGray
  Write-Host ('   参数: ' + (Format-Settings $settings)) -ForegroundColor DarkGray
  Show-Controls

  # 服务器什么时候真的起来了，浏览器就什么时候开——轮询放在后台任务里，
  # 前台留给 pnpm，让它的日志原样打在控制台上。
  $watcher = $null
  if (-not $NoBrowser) {
    $watcher = Start-Job -ScriptBlock {
      param($target, $seconds)
      $deadline = (Get-Date).AddSeconds($seconds)
      while ((Get-Date) -lt $deadline) {
        try {
          $response = Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 3
          if ($response.StatusCode -ge 200) { Start-Process $target; return }
        } catch { }
        Start-Sleep -Milliseconds 300
      }
    } -ArgumentList $url, 180 | Out-Null
  }

  Write-Host ''
  & pnpm @argv
  $code = $LASTEXITCODE

  if ($watcher) {
    Stop-Job -Job $watcher -ErrorAction SilentlyContinue | Out-Null
    Remove-Job -Job $watcher -Force -ErrorAction SilentlyContinue | Out-Null
  }

  Write-Host ''
  if ($code -eq 0) { Write-Ok ($label + ' 已停止') } else { Write-Bad ($label + ' 退出 (exit ' + $code + ')') }
}

function Do-Build {
  $code = Invoke-Pnpm @('build') '构建'
  if ($code -eq 0) {
    $index = Join-Path $script:Root 'dist\index.html'
    if (Test-Path -LiteralPath $index) {
      $sizes = Get-ChildItem -LiteralPath (Join-Path $script:Root 'dist\assets') -File |
        Sort-Object Length -Descending | Select-Object -First 3
      Write-Host '   产物 (前 3 个，kB = 1000 字节，与 vite 的口径一致)' -ForegroundColor DarkGray
      foreach ($f in $sizes) {
        Write-Host ('     ' + $f.Name.PadRight(30) + [string]::Format('{0,10:N1} kB', ($f.Length / 1000))) -ForegroundColor DarkGray
      }
    }
  }
}

function Do-Test {
  Invoke-Pnpm @('test') '测试' | Out-Null
}

function Show-Menu($s) {
  Show-Banner
  Write-Host '   1) 开发模式      热更新，改代码即时生效，端口 5174     [推荐]' -ForegroundColor White
  Write-Host '   2) 生产模式      先构建再启动，首屏加载最快，端口 4173'
  Write-Host '   3) 只构建        tsc + vite build 产出 dist/'
  Write-Host '   4) 跑测试        14 个规格 / 418 条'
  Write-Host '   5) 启动参数      难度 / 队伍 / 种子 / 名字 / 统计'
  Write-Host '   6) 重装依赖      pnpm install'
  Write-Host '   0) 退出'
  Write-Host ''
  Write-Host ('   当前: ' + (Format-Settings $s)) -ForegroundColor DarkGray
  Write-Host ''
}

function Show-MenuLoop {
  while ($true) {
    Show-Menu (Read-Settings)
    $pick = Read-Host '   选择'
    switch ($pick) {
      '1' { Start-Game 'dev';  Read-Host '   回车关闭窗口' ; return }
      '2' { Start-Game 'prod'; Read-Host '   回车关闭窗口' ; return }
      '3' { Do-Build;          Read-Host '   回车返回' }
      '4' { Do-Test;           Read-Host '   回车返回' }
      '5' { Edit-Params;       Read-Host '   回车返回' }
      '6' { Install-Deps | Out-Null; Read-Host '   回车返回' }
      '0' { return }
      default { }
    }
  }
}

function Show-Diagnostics {
  $s = Read-Settings
  Write-Rule '诊断（-DryRun：不启动任何东西）'
  Write-Host ('   node      : ' + (& node --version))
  Write-Host ('   pnpm      : ' + (& pnpm --version))
  Write-Host ('   依赖      : ' + ($(if (Test-Path (Join-Path $script:Root 'node_modules\three\package.json')) { '已就绪' } else { '缺失（会自动 pnpm install）' })))
  $stale = '不需要构建'
  if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'dist\index.html'))) { $stale = 'dist/ 不存在' }
  elseif (Test-BuildStale) { $stale = 'dist/ 比源码旧' }
  Write-Host ('   构建产物  : ' + $stale)
  Write-Host ('   参数      : ' + (Format-Settings $s))
  Write-Host ('   开发模式  : ' + (Get-GameUrl ('http://localhost:' + $script:DefaultDevPort) $s $UrlParams))
  Write-Host ('   生产模式  : ' + (Get-GameUrl ('http://localhost:' + $script:DefaultProdPort) $s $UrlParams))
  Write-Host ('   5174 占用 : ' + (Test-PortBusy $script:DefaultDevPort))
  Write-Host ('   4173 占用 : ' + (Test-PortBusy $script:DefaultProdPort))
}

# ============================================================================
# 主流程
# ============================================================================

Set-Location -LiteralPath $script:Root
Assert-Env | Out-Null

if ($DryRun) {
  Show-Diagnostics
  exit 0
}

if ($Mode -eq 'params') {
  Edit-Params
  exit 0
}

# 第一次运行就把默认参数落盘，之后用记事本也能改
if (-not (Test-Path -LiteralPath $script:SettingsFile)) {
  Save-Settings (Read-Settings)
}

$depsNeeded = $false
if ($Reinstall -or -not (Test-Path (Join-Path $script:Root 'node_modules\three\package.json'))) {
  $depsNeeded = $true
}
if ($depsNeeded) {
  if (-not (Install-Deps)) { exit 1 }
}

switch ($Mode) {
  'menu' { Show-MenuLoop }
  'dev'  { Start-Game 'dev' }
  'prod' { Start-Game 'prod' }
  'build' { Do-Build }
  'test'  { Do-Test }
}