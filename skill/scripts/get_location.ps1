# get_location.ps1 — Windows 本机定位（三级降级链的第一级）
# 调 WinRT Geolocator 拿 WGS-84 精确经纬度。
# 输出契约：永远 exit 0 + 单行 JSON，由调用方看 JSON 判断成败：
#   成功: {"ok":true,"lat":31.2,"lon":121.4,"accuracy":25,"source":"gps"}
#   失败: {"ok":false,"reason":"service_disabled|timeout|unavailable","detail":"..."}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

function OutJson($o) { Write-Output ($o | ConvertTo-Json -Compress) }

try {
    # AsTask 扩展方法所在的程序集，PowerShell 默认不加载，必须手动加
    Add-Type -AssemblyName System.Runtime.WindowsRuntime

    # 加载 WinRT 类型（PowerShell 5.1 的标准方式）
    [Windows.Devices.Geolocation.Geolocator, Windows.Devices.Geolocation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Devices.Geolocation.PositionAccuracy, Windows.Devices.Geolocation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Devices.Geolocation.PositionStatus, Windows.Devices.Geolocation, ContentType = WindowsRuntime] | Out-Null

    $locator = New-Object Windows.Devices.Geolocation.Geolocator
    $locator.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::High

    # 预检：系统定位服务关闭时秒级失败降级，不白等 15 秒
    if ($locator.LocationStatus -eq [Windows.Devices.Geolocation.PositionStatus]::Disabled) {
        OutJson @{ ok = $false; reason = 'service_disabled'; detail = 'Windows 定位服务已关闭（设置 > 隐私和安全性 > 位置）' }
        exit 0
    }

    $op = $locator.GetGeopositionAsync()   # IAsyncOperation<Geoposition>

    # 桥接 IAsyncOperation -> Task（反射取 AsTask 扩展方法，成熟模式）
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    $asTask = $asTaskGeneric.MakeGenericMethod([Windows.Devices.Geolocation.Geoposition])
    $task = $asTask.Invoke($null, @($op))

    if (-not $task.Wait(15000)) {
        OutJson @{ ok = $false; reason = 'timeout'; detail = '定位 15 秒未返回' }
        exit 0
    }

    $pos = $task.Result
    $p = $pos.Coordinate.Point.Position
    OutJson @{
        ok        = $true
        lat       = [math]::Round($p.Latitude, 6)
        lon       = [math]::Round($p.Longitude, 6)
        accuracy  = [math]::Round($pos.Coordinate.Accuracy)
        source    = 'gps'
    }
    exit 0
}
catch {
    # 定位权限被拒/服务未开等常抛 UnauthorizedAccessException —— 统一归为 unavailable，让上层降级
    OutJson @{ ok = $false; reason = 'unavailable'; detail = ($_.Exception.Message -replace "`r`n", ' ') }
    exit 0
}
