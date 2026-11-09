param([int]$Port = 8765, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$baseUrl = "http://localhost:$Port/"
$server = New-Object System.Net.HttpListener
$server.Prefixes.Add($baseUrl)
try {
    $server.Start()
} catch {
    # Reuse only a FrameGrid server that serves this checkout.
    try {
        $existing = Invoke-WebRequest -Uri $baseUrl -UseBasicParsing -TimeoutSec 2
        if ($existing.Headers['X-FrameGrid-Root'] -eq $PSScriptRoot) {
            if (-not $NoBrowser) { Start-Process $baseUrl }
            exit 0
        }
    } catch {}
    throw "No se pudo abrir FrameGrid en $baseUrl. El puerto puede estar ocupado."
}

$routes = @{
    '/' = @('index.html', 'text/html; charset=utf-8')
    '/index.html' = @('index.html', 'text/html; charset=utf-8')
    '/image-validation.js' = @('image-validation.js', 'text/javascript; charset=utf-8')
    '/app.js' = @('app.js', 'text/javascript; charset=utf-8')
    '/style.css' = @('style.css', 'text/css; charset=utf-8')
    '/content.json' = @('content.json', 'application/json; charset=utf-8')
    '/framegrid.png' = @('framegrid.png', 'image/png')
    '/screenshot.png' = @('screenshot.png', 'image/png')
}
$assetTypes = @{'.png'='image/png';'.ico'='image/x-icon';'.css'='text/css; charset=utf-8';'.svg'='image/svg+xml';'.woff2'='font/woff2';'.ttf'='font/ttf';'.txt'='text/plain; charset=utf-8'}
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'assets') -File -Recurse | ForEach-Object {
    if ($assetTypes.ContainsKey($_.Extension)) {
        $relative = $_.FullName.Substring($PSScriptRoot.Length + 1).Replace('\', '/')
        $routes['/' + $relative] = @($relative, $assetTypes[$_.Extension])
    }
}
Write-Host "FrameGrid: $baseUrl"
Write-Host 'Deja esta ventana abierta mientras usas FrameGrid. Cerrala para detener el servidor.'
if (-not $NoBrowser) { Start-Process $baseUrl }

try {
    while ($server.IsListening) {
        $request = $server.GetContext()
        $response = $request.Response
        try {
            $response.Headers['Cache-Control'] = 'no-store'
            $response.Headers['X-FrameGrid-Root'] = $PSScriptRoot
            $route = $routes[$request.Request.Url.AbsolutePath]
            if ($request.Request.HttpMethod -notin @('GET', 'HEAD')) {
                $response.StatusCode = 405
            } elseif ($null -eq $route) {
                $response.StatusCode = 404
            } else {
                $path = Join-Path $PSScriptRoot $route[0]
                if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                    $response.StatusCode = 404
                } else {
                    $bytes = [System.IO.File]::ReadAllBytes($path)
                    $response.ContentType = $route[1]
                    $response.ContentLength64 = $bytes.Length
                    if ($request.Request.HttpMethod -eq 'GET') {
                        $response.OutputStream.Write($bytes, 0, $bytes.Length)
                    }
                }
            }
        } catch {
            Write-Warning $_.Exception.Message
        } finally {
            $response.Close()
        }
    }
} finally {
    $server.Close()
}
