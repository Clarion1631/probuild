$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot
[Environment]::SetEnvironmentVariable("NEXT_TELEMETRY_DISABLED", "1", "Process")

function Get-ProcessEnvValue {
    param([string]$Name)
    [Environment]::GetEnvironmentVariable($Name, "Process")
}

function Read-EnvValue {
    param([string]$Name)

    $existing = Get-ProcessEnvValue $Name
    if ($existing) {
        return $existing
    }

    foreach ($file in @(".env.local", ".env")) {
        if (-not (Test-Path $file)) {
            continue
        }

        foreach ($line in Get-Content $file) {
            $pattern = "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$"
            if ($line -match $pattern) {
                $value = $matches[1].Trim()
                if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                    $value = $value.Substring(1, $value.Length - 2)
                }
                return $value
            }
        }
    }

    return $null
}

function Set-ProcessEnvValue {
    param([string]$Name, [string]$Value)
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
}

function Invoke-Checked {
    param([scriptblock]$Command)

    & $Command
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$token = Read-EnvValue "VERCEL_TOKEN"
if (-not $token) {
    throw "VERCEL_TOKEN is required for production deploy automation."
}

$secret = Read-EnvValue "PLAYWRIGHT_TEST_SECRET"
if (-not $secret) {
    throw "PLAYWRIGHT_TEST_SECRET is required. Set it in the shell or .env.local before deploying."
}

Set-ProcessEnvValue "PLAYWRIGHT_TEST_SECRET" $secret

Write-Host ""
Write-Host "Creating staged production deployment without assigning the production domain..."
$deployOutput = & vercel deploy --prod --skip-domain --yes --token $token 2>&1
$deployOutput | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$deployText = $deployOutput -join "`n"
$deploymentUrl = ([regex]::Matches($deployText, "https://\S+\.vercel\.app\S*") | Select-Object -Last 1).Value
if (-not $deploymentUrl) {
    throw "Could not find the staged Vercel deployment URL in CLI output."
}

Write-Host ""
Write-Host "Staged deployment ready: $deploymentUrl"
Write-Host "Running smoke tests against staged deployment..."

Set-ProcessEnvValue "PLAYWRIGHT_BASE_URL" $deploymentUrl
Set-ProcessEnvValue "CI" "true"
Invoke-Checked { npm run test:e2e:smoke }

Write-Host ""
Write-Host "Promoting staged deployment to production..."
Invoke-Checked { vercel promote $deploymentUrl --yes --token $token }

Write-Host ""
Write-Host "Production promote completed after local and staged smoke tests."
