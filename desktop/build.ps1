param(
    [Parameter(Mandatory=$true)][string]$Output,
    [string]$WebViewSdkArchive,
    [string]$NodeLicense,
    [uri]$ServerUrl
)

$ErrorActionPreference = 'Stop'
if ($ServerUrl -and (!$ServerUrl.IsAbsoluteUri -or
    ($ServerUrl.Scheme -ne 'https' -and !($ServerUrl.Scheme -eq 'http' -and $ServerUrl.IsLoopback)) -or
    $ServerUrl.UserInfo -or $ServerUrl.AbsolutePath -ne '/' -or $ServerUrl.Query -or $ServerUrl.Fragment)) {
    throw 'Specify the HTTPS server origin, with no path, query or fragment. HTTP is supported for loopback testing.'
}
$root = Split-Path -Parent $PSScriptRoot
$outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
$outputDir = Get-Item -LiteralPath (Split-Path -Parent $outputPath)
if (!$outputDir.PSIsContainer) { throw 'The output directory does not exist.' }
$work = Join-Path $outputDir.FullName ('wangwang-desktop-' + [guid]::NewGuid().ToString('N'))
$buildFolder = New-Item -ItemType Directory -Path $work
try {
    $payload = Join-Path $work 'payload'
    $sdk = Join-Path $work 'sdk'
    New-Item -ItemType Directory -Path $payload, $sdk | Out-Null

    if (!$WebViewSdkArchive) {
        $WebViewSdkArchive = Join-Path $work 'webview2.zip'
        $sdkVersion = '1.0.3124.44'
        $sdkUrl = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"
        Invoke-WebRequest -Uri $sdkUrl -OutFile $WebViewSdkArchive
    }
    # Expand-Archive expects a ZIP extension, whereas NuGet often supplies .nupkg.
    $sdkZip = Join-Path $work 'sdk.zip'
    Copy-Item -LiteralPath $WebViewSdkArchive -Destination $sdkZip
    Expand-Archive -LiteralPath $sdkZip -DestinationPath $sdk

    if (!$ServerUrl) {
        $node = (Get-Command node.exe).Source
        if ((& $node -p 'process.arch') -ne 'x64') { throw 'The desktop package requires an x64 Node executable.' }
        $version = (& $node -p 'process.version').Trim()
        if ([version]$version.TrimStart('v') -lt [version]'22.18.0') { throw 'Install Node.js 22.18 or newer.' }
        if (!$NodeLicense) {
            $NodeLicense = Join-Path $work 'Node-LICENSE.txt'
            Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$version/LICENSE" -OutFile $NodeLicense
        }
        Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $payload 'Node-LICENSE.txt')
        Copy-Item -LiteralPath $node -Destination (Join-Path $payload 'node.exe')

        $gameFiles = @('engine', 'server.js', 'accounts.js', 'room-store.js', 'league.js', 'replay-data.js', 'drills.js', 'drill-bank.json',
            'index.html', 'account-ui.js', 'replay.js', 'drill-ui.js', 'tiles.js', 'meshes.js', 'table.css',
            'faces.png', 'author-payment.jpg', 'tiles.glb', 'tiles.glb.gz', 'package.json', 'package-lock.json')
        foreach ($file in $gameFiles) {
            Copy-Item -LiteralPath (Join-Path $root $file) -Destination $payload -Recurse
        }
        Push-Location $payload
        try {
            npm.cmd ci --omit=dev --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Could not install game dependencies.' }
        }
        finally { Pop-Location }
    }

    $assemblies = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')
    foreach ($name in $assemblies) {
        Copy-Item -LiteralPath (Join-Path $sdk "lib/net462/$name") -Destination $payload
    }
    Copy-Item -LiteralPath (Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $payload
    Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $payload 'WebView2-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $sdk 'NOTICE.txt') -Destination (Join-Path $payload 'WebView2-NOTICE.txt')

    $package = Join-Path $work 'game.zip'
    Compress-Archive -Path (Join-Path $payload '*') -DestinationPath $package -CompressionLevel Optimal
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $references = $assemblies | ForEach-Object { '/reference:' + (Join-Path $payload $_) }
    $appIcon = Join-Path $PSScriptRoot 'app.ico'
    $compile = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+',
        ('/win32manifest:' + (Join-Path $PSScriptRoot 'app.manifest')),
        ('/win32icon:' + $appIcon),
        ('/resource:' + $appIcon + ',WangWangRiichi.App.ico'),
        ('/out:' + $outputPath), ('/resource:' + $package + ',WangWangRiichi.Game.zip'),
        '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
        '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
        '/reference:System.Net.Http.dll', '/reference:System.Security.dll', '/reference:System.Web.Extensions.dll')
    if ($ServerUrl) {
        $addressFile = Join-Path $work 'server-url.txt'
        Set-Content -LiteralPath $addressFile -Value $ServerUrl.AbsoluteUri -Encoding utf8
        $compile += '/resource:' + $addressFile + ',WangWangRiichi.ServerUrl'
    }
    $sources = @('Program.cs', 'NetworkMenu.cs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
    & $compiler @compile @references @sources
    if ($LASTEXITCODE -ne 0) { throw 'Desktop EXE compilation failed.' }
    Get-Item -LiteralPath $outputPath
}
finally {
    $createdFolder = Get-Item -LiteralPath $buildFolder.FullName -ErrorAction SilentlyContinue
    if ($createdFolder -and $createdFolder.PSIsContainer -and $createdFolder.Parent.FullName -eq $outputDir.FullName -and
        $createdFolder.FullName -eq $buildFolder.FullName -and !($createdFolder.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $createdFolder.FullName -Recurse -Force
    }
}
