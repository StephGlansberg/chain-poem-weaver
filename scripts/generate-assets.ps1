Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Assets = Join-Path $Root "assets"
if (-not (Test-Path -LiteralPath $Assets)) {
  New-Item -ItemType Directory -Path $Assets -Force | Out-Null
}

Add-Type -AssemblyName System.Drawing

# The gold quill-over-weave logo. All production assets are composited from this
# single source so the brand mark stays consistent and never distorts.
$SourcePath = Join-Path $Assets "source-logo.png"
if (-not (Test-Path -LiteralPath $SourcePath)) {
  throw "missing source logo: $SourcePath"
}

$source = [System.Drawing.Bitmap]::FromFile($SourcePath)
# Background sampled from the logo's own corner so wide pillarboxes blend seamlessly.
$corner = $source.GetPixel(2, 2)
$bgColor = [System.Drawing.Color]::FromArgb($corner.R, $corner.G, $corner.B)

function Save-ChainPoemAsset {
  param(
    [string]$Path,
    [int]$Width,
    [int]$Height,
    [string]$Kind
  )

  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  try {
    $bg = New-Object System.Drawing.SolidBrush $bgColor
    $graphics.FillRectangle($bg, 0, 0, $Width, $Height)
    $bg.Dispose()

    $square = ($Width -eq $Height)
    if ($square) {
      # Square icon/splash: full-bleed cover (source is already square).
      $graphics.DrawImage($source, 0, 0, $Width, $Height)
    } else {
      # Wide cards: contain the logo centered, padded on matching black.
      $scale = ($Height * 0.92) / $source.Height
      $drawW = [int]($source.Width * $scale)
      $drawH = [int]($source.Height * $scale)
      $x = [int](($Width - $drawW) / 2)
      $y = [int](($Height - $drawH) / 2)
      $graphics.DrawImage($source, $x, $y, $drawW, $drawH)
    }

    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

Save-ChainPoemAsset -Path (Join-Path $Assets "chain-poem-icon.png") -Width 1024 -Height 1024 -Kind "icon"
Save-ChainPoemAsset -Path (Join-Path $Assets "poem-splash.png") -Width 200 -Height 200 -Kind "splash"
Save-ChainPoemAsset -Path (Join-Path $Assets "chain-poem-weaver.png") -Width 1200 -Height 800 -Kind "embed"
Save-ChainPoemAsset -Path (Join-Path $Assets "chain-poem-hero.png") -Width 1200 -Height 630 -Kind "hero"
Save-ChainPoemAsset -Path (Join-Path $Assets "chain-poem-og.png") -Width 1200 -Height 630 -Kind "og"

$source.Dispose()

Get-ChildItem -LiteralPath $Assets -Filter *.png | Select-Object Name, Length | ConvertTo-Json -Depth 3
