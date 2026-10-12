<#
.SYNOPSIS
  Downloads the audio of the URLs listed in a file, with yt-dlp, into a folder - and says truthfully what happened.

.DESCRIPTION
  A corrected version of the owner's C:\Tools\download-music.ps1 (which is left as it was). What changed, and why:

  - The URL list is a parameter (-InputFile). The old script read .\urls.txt only, and the list supplied with it is named "urls - Copy.txt".
  - The tools are found explicitly and reported with their versions:
    - yt-dlp from -YtDlp, then $env:ANYTUNE_YTDLP, then PATH;
    - FFmpeg and ffprobe from -FfmpegLocation, then $env:ANYTUNE_FFMPEG's folder, then PATH.
    yt-dlp needs both FFmpeg and ffprobe to extract and convert audio, so neither may be missing.
  - Completion is reported truthfully. The old script printed "Download complete" whatever happened. This one counts what each URL gave:
    - completed;
    - already downloaded (in the archive);
    - failed, with yt-dlp's errors listed.
    It exits 1 when anything failed.
  - Downloads are recorded in a download archive (<OutputDir>\downloaded.txt), so a re-run fetches only what is missing. --continue is kept for partial files.
  - User configuration is ignored (--ignore-config), so the run is the same on every machine.

  It downloads only what yt-dlp can fetch plainly. It adds no cookies, no account and no way around a provider's access controls or DRM. Use it only for
  media you may download.

  This is a personal library tool for a Windows desktop. It is not part of AnyTune's real-time audio path, and the Android app never runs it. AnyTune's own
  import (one video, or a deliberately chosen playlist, transcribed into a reference) is services/import-worker.

.EXAMPLE
  .\download-music.ps1 -InputFile 'C:\Tools\urls - Copy.txt' -OutputDir 'D:\Music' -YtDlp 'C:\Tools\yt-dlp.exe'

.EXAMPLE
  .\download-music.ps1 -InputFile .\urls.txt -CheckOnly     # find and report the tools, read the list; download nothing
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InputFile,
    [string]$OutputDir = '.\music',
    [string]$YtDlp,
    [string]$FfmpegLocation,
    [ValidateSet('m4a', 'mp3', 'opus', 'flac', 'wav')][string]$AudioFormat = 'm4a',
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-Executable([string]$Explicit, [string]$EnvValue, [string]$Name) {
    foreach ($candidate in @($Explicit, $EnvValue)) {
        if ($candidate) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
            throw "$Name was given as '$candidate', which is not a file."
        }
    }
    $found = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
    return $null
}

function Find-FfmpegFolder([string]$Explicit) {
    $folders = @()
    if ($Explicit) { $folders += $Explicit }
    if ($env:ANYTUNE_FFMPEG) { $folders += (Split-Path -Parent $env:ANYTUNE_FFMPEG) }
    $onPath = Get-Command 'ffmpeg' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { $folders += (Split-Path -Parent $onPath.Source) }
    foreach ($folder in $folders) {
        if ((Test-Path -LiteralPath (Join-Path $folder 'ffmpeg.exe')) -and (Test-Path -LiteralPath (Join-Path $folder 'ffprobe.exe'))) { return (Resolve-Path -LiteralPath $folder).Path }
    }
    return $null
}

# --- the tools, found explicitly ---------------------------------------------------------------------------------------------------------------------
$ytDlpPath = Find-Executable $YtDlp $env:ANYTUNE_YTDLP 'yt-dlp'
if (-not $ytDlpPath) { Write-Error 'yt-dlp was not found: pass -YtDlp <path>, set ANYTUNE_YTDLP, or put it on PATH.'; exit 1 }
$ffmpegFolder = Find-FfmpegFolder $FfmpegLocation
if (-not $ffmpegFolder) { Write-Error 'FFmpeg and ffprobe were not both found (yt-dlp needs both to extract audio): pass -FfmpegLocation <folder>, or put them on PATH.'; exit 1 }
# the whole output is taken before the exit code is read: piping a native command into Select-Object -First stops it before it sets $LASTEXITCODE
function Get-Version([string]$Executable, [string[]]$Arguments) {
    $output = @(& $Executable @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "$Executable did not run (exit $LASTEXITCODE): $($output -join ' ')" }
    return "$($output[0])".Trim()
}
$ytDlpVersion = Get-Version $ytDlpPath @('--version')
$ffmpegVersion = Get-Version (Join-Path $ffmpegFolder 'ffmpeg.exe') @('-hide_banner', '-version')
$ffprobeVersion = Get-Version (Join-Path $ffmpegFolder 'ffprobe.exe') @('-hide_banner', '-version')
Write-Host "yt-dlp  : $ytDlpVersion ($ytDlpPath)"
Write-Host "ffmpeg  : $ffmpegVersion"
Write-Host "ffprobe : $ffprobeVersion"

# --- the list ---------------------------------------------------------------------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $InputFile -PathType Leaf)) { Write-Error "The URL list was not found: $InputFile"; exit 1 }
$urls = @(Get-Content -LiteralPath $InputFile -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
$notHttps = @($urls | Where-Object { -not $_.StartsWith('https://') })
if ($notHttps.Count -gt 0) { Write-Error ("Only https URLs are downloaded; these are not: " + ($notHttps -join ', ')); exit 1 }
Write-Host "list    : $($urls.Count) URL(s) in $InputFile"
if ($urls.Count -eq 0) { Write-Warning 'The list has no URLs: nothing to do.'; exit 0 }

if ($CheckOnly) { Write-Host 'Checked the tools and the list; -CheckOnly: nothing downloaded.'; exit 0 }

# --- download, one URL at a time, counting what each gave -------------------------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$archive = Join-Path $OutputDir 'downloaded.txt'
$completed = 0; $skipped = 0; $failed = @()
foreach ($url in $urls) {
    $arguments = @(
        '--ignore-config', '--continue', '--no-overwrites',
        '--download-archive', $archive,
        '--extract-audio', '--audio-format', $AudioFormat, '--audio-quality', '0',
        '--ffmpeg-location', $ffmpegFolder,
        '--embed-metadata',
        '--output', (Join-Path $OutputDir '%(artist,uploader)s - %(title)s.%(ext)s'),
        '--print', 'after_move:filepath',
        '--', $url
    )
    $output = & $ytDlpPath @arguments 2>&1
    $code = $LASTEXITCODE
    $files = @($output | Where-Object { $_ -is [string] -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    $errors = @($output | ForEach-Object { "$_" } | Where-Object { $_ -match '^ERROR:' })
    $already = @($output | ForEach-Object { "$_" } | Where-Object { $_ -match 'has already been recorded in the archive' })
    if ($code -eq 0) {
        $completed += $files.Count; $skipped += $already.Count
        Write-Host ("ok      : {0} - {1} new file(s), {2} already downloaded" -f $url, $files.Count, $already.Count)
    } else {
        $completed += $files.Count; $skipped += $already.Count
        $failed += [pscustomobject]@{ Url = $url; Exit = $code; Errors = ($errors -join ' | ') }
        Write-Warning ("failed  : {0} (yt-dlp exit {1}) {2}" -f $url, $code, ($errors -join ' | '))
    }
}

Write-Host ''
Write-Host "Files written: $completed; already downloaded: $skipped; URLs that failed: $($failed.Count) of $($urls.Count). Folder: $((Resolve-Path -LiteralPath $OutputDir).Path)"
if ($failed.Count -gt 0) {
    Write-Warning 'Not everything was downloaded. Re-run the same command to retry only what is missing (the archive remembers what was done).'
    exit 1
}
Write-Host 'Every URL in the list completed.'
exit 0
