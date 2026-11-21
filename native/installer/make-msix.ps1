# The native program as an MSIX package for the Microsoft Store: the program, FFmpeg, yt-dlp and the licences in a folder,
# a manifest that says who it is and what it opens, tiles made from the icon, `makeappx pack`. The Store signs the
# package itself; the unsigned setup it refuses. The identity comes from Partner Center (the repository variables
# STORE_IDENTITY_NAME, STORE_PUBLISHER, STORE_PUBLISHER_NAME, STORE_DISPLAY_NAME); without them test values make a
# package that proves the build and is not for submitting.
#
#   make-msix.ps1 -Exe <sondra.exe> -FFmpegDir <folder with ffmpeg.exe and ffprobe.exe> -YtDlp <yt-dlp.exe> `
#                 -Licenses <folder> -Version 1.2.3 -Out <file.msix>
#
# yt-dlp lies in the package because the Store allows no program fetched later (policy 10.2.2): bundled, it is part
# of what the Store checks, and „Herunterladen“ works without anything to install.
#
# There is no uninstaller in the package, which is how the program knows it is not to look for updates itself: the
# Store updates the package (`updater::is_installed`).
param(
  [Parameter(Mandatory)] [string] $Exe,
  [Parameter(Mandatory)] [string] $FFmpegDir,
  [Parameter(Mandatory)] [string] $YtDlp,
  [Parameter(Mandatory)] [string] $Licenses,
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $Out,
  [string] $Arch = 'x64'
)
$ErrorActionPreference = 'Stop'

$name = if ($env:SONDRA_STORE_IDENTITY_NAME) { $env:SONDRA_STORE_IDENTITY_NAME } else { 'Sondra.Nativ.Test' }
$publisher = if ($env:SONDRA_STORE_PUBLISHER) { $env:SONDRA_STORE_PUBLISHER } else { 'CN=Sondra Test' }
$publisherName = if ($env:SONDRA_STORE_PUBLISHER_NAME) { $env:SONDRA_STORE_PUBLISHER_NAME } else { 'Sondra Test' }
$display = if ($env:SONDRA_STORE_DISPLAY_NAME) { $env:SONDRA_STORE_DISPLAY_NAME } else { 'Sondra Studio' }
$four = "$Version.0"

$layout = Join-Path $env:RUNNER_TEMP 'msix-layout'
Remove-Item $layout -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$layout\Assets" | Out-Null
Copy-Item $Exe "$layout\sondra.exe"
Copy-Item "$FFmpegDir\ffmpeg.exe", "$FFmpegDir\ffprobe.exe" $layout
Copy-Item $YtDlp "$layout\yt-dlp.exe"
Copy-Item $Licenses "$layout\Lizenzen" -Recurse

# The tiles, from the 512 px icon (the same plain-Node drawing the other package uses).
$tiles = Join-Path $env:RUNNER_TEMP 'msix-tiles'
node -e "import('./scripts/store-tiles.mjs').then(m => m.makeStoreTiles('public/icon-512.png', process.argv[1]))" $tiles
if ($LASTEXITCODE -ne 0) { throw 'Kacheln nicht gemacht.' }
foreach ($t in 'StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png', 'Wide310x150Logo.png') { Copy-Item "$tiles\$t" "$layout\Assets\$t" }

function Types($list) { ($list | ForEach-Object { "<uap:FileType>.$_</uap:FileType>" }) -join '' }
function Assoc($id, $text, $list) { "<uap:Extension Category=`"windows.fileTypeAssociation`"><uap:FileTypeAssociation Name=`"$id`"><uap:DisplayName>$text</uap:DisplayName><uap:SupportedFileTypes>$(Types $list)</uap:SupportedFileTypes></uap:FileTypeAssociation></uap:Extension>" }
$extensions = (Assoc 'sondraton' 'Ton' @('mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'wma')) +
  (Assoc 'sondravideo' 'Video' @('mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi')) +
  (Assoc 'sondrabild' 'Bild' @('png', 'jpg', 'jpeg', 'webp', 'gif')) +
  (Assoc 'sondraliste' 'Geteilte Merkliste' @('sondra-liste')) +
  (Assoc 'sondraprojekt' 'Sondra-Projekt' @('sondra'))

@"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap rescap">
  <Identity Name="$name" Publisher="$publisher" Version="$four" ProcessorArchitecture="$Arch" />
  <Properties>
    <DisplayName>$display</DisplayName>
    <PublisherDisplayName>$publisherName</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Resources><Resource Language="de-DE" /></Resources>
  <Applications>
    <Application Id="Sondra" Executable="sondra.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="$display" Description="Ton, Video und Bilder bearbeiten, Filme und Serien — gerechnet auf Ihrem Gerät."
                          BackgroundColor="#0f3e1c" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png" />
      </uap:VisualElements>
      <Extensions>$extensions</Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <Capability Name="internetClient" />
    <Capability Name="privateNetworkClientServer" />
    <DeviceCapability Name="microphone" />
  </Capabilities>
</Package>
"@ | Set-Content -Path "$layout\AppxManifest.xml" -Encoding utf8

$tools = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter makeappx.exe
$makeappx = $tools | Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw 'makeappx.exe nicht gefunden.' }
& $makeappx.FullName pack /d $layout /p $Out /o
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Out)) { throw 'Paket nicht gebaut.' }
"Paket: $Out, $([math]::Round((Get-Item $Out).Length / 1MB)) MB · $name $four"
