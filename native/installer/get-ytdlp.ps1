# yt-dlp for the packages, the same way FFmpeg goes into them: every setup, the portable folder and every Store
# package carry it beside sondra.exe, so „Herunterladen“ works from the first start (Sondra looks there,
# `sondra-download::ytdlp::candidates`). Taken from yt-dlp's own latest release and checked against the SHA-256 the
# release publishes; if the sum does not match, the build stops — nothing unchecked is ever bundled.
#
#   get-ytdlp.ps1 -Out <folder> [-Arch x64|arm64]   → <folder>\yt-dlp.exe, its path is written to the output

param(
  [Parameter(Mandatory)] [string] $Out,
  [ValidateSet('x64', 'arm64')] [string] $Arch = 'x64'
)
$ErrorActionPreference = 'Stop'

$base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'
# The release's Windows builds: yt-dlp.exe for x64, yt-dlp_arm64.exe for Arm.
$asset = if ($Arch -eq 'arm64') { 'yt-dlp_arm64.exe' } else { 'yt-dlp.exe' }

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$target = Join-Path $Out 'yt-dlp.exe'
$sums = $null
foreach ($try in 1..4) {
  try {
    Invoke-WebRequest "$base$asset" -OutFile $target
    $sums = (Invoke-WebRequest "${base}SHA2-256SUMS").Content
    break
  } catch {
    if ($try -eq 4) { throw "yt-dlp liess sich nicht laden: $_" }
    Start-Sleep -Seconds (5 * $try)
  }
}
if ($sums -is [byte[]]) { $sums = [System.Text.Encoding]::UTF8.GetString($sums) }
$line = $sums -split "`n" | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))\s*$" } | Select-Object -First 1
$want = if ($line) { ($line -replace '\s.*$', '').Trim().ToLower() } else { '' }
$have = (Get-FileHash $target -Algorithm SHA256).Hash.ToLower()
if (-not $want -or $have -ne $want) {
  Remove-Item $target -Force
  throw "yt-dlp ($asset) passt nicht zur veröffentlichten SHA-256 (erwartet '$want', bekommen '$have') — nichts beigelegt."
}
Write-Host "yt-dlp ($asset) beigelegt, SHA-256 wie veröffentlicht: $have"
$target
