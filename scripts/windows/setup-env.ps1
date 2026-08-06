<#
.SYNOPSIS
  Génère les secrets et écrit server\.env pour un déploiement MEMS sous Windows.

.DESCRIPTION
  À lancer une fois, depuis la racine du dépôt, dans PowerShell. Le script :
    - tire JWT_SECRET et DATA_KEY au hasard (32 octets chacun) ;
    - compose DATABASE_URL à partir des paramètres fournis ;
    - écrit server\.env (refuse d'écraser un fichier existant sans -Force) ;
    - crée le dossier des sauvegardes.
  Il NE crée PAS la base : voir docs/WINDOWS.md §2. Il NE stocke aucun secret
  ailleurs que dans le .env produit.

.EXAMPLE
  .\scripts\windows\setup-env.ps1 -DbPassword 'MotDePasseFort' `
      -CorsOrigin 'https://mems.mon-domaine.org' -BootstrapEmail 'admin@mon-domaine.org'
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $DbPassword,
  [string] $DbUser = 'mems',
  [string] $DbHost = '127.0.0.1',
  [int]    $DbPort = 5432,
  [string] $DbName = 'mems',
  [Parameter(Mandatory = $true)] [string] $CorsOrigin,
  [Parameter(Mandatory = $true)] [string] $BootstrapEmail,
  [int]    $Port = 4000,
  [switch] $TrustProxy = $true,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'

# Racine du dépôt = deux niveaux au-dessus de ce script (scripts\windows\)
$root    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envPath = Join-Path $root 'server\.env'
$backup  = Join-Path $root 'data\sauvegardes'

if ((Test-Path $envPath) -and -not $Force) {
  throw "server\.env existe déjà. Relancez avec -Force pour l'écraser (vos secrets actuels seraient perdus)."
}

function New-Secret {
  $bytes = New-Object 'System.Byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

# Le mot de passe voyage dans une URL : on encode les caractères réservés.
$encPw = [System.Uri]::EscapeDataString($DbPassword)
$jwt   = New-Secret
$data  = New-Secret
$trust = if ($TrustProxy) { '1' } else { '0' }

$content = @"
# Généré par scripts\windows\setup-env.ps1 le $(Get-Date -Format 'yyyy-MM-dd HH:mm')
# Ne versionnez jamais ce fichier.

NODE_ENV=production
PORT=$Port
HOST=0.0.0.0

DATABASE_URL=postgres://$DbUser`:$encPw@$DbHost`:$DbPort/$DbName
DB_POOL_MAX=10

BACKUP_DIR=$backup
BACKUP_TIMEOUT_S=600

JWT_SECRET=$jwt
DATA_KEY=$data
TOKEN_TTL=8h

CORS_ORIGINS=$CorsOrigin
TRUST_PROXY=$trust

BOOTSTRAP_EMAIL=$BootstrapEmail
BOOTSTRAP_PASSWORD=

LOG_LEVEL=info
"@

# Écriture en UTF-8 sans BOM (dotenv n'aime pas le BOM).
[System.IO.File]::WriteAllText($envPath, $content, (New-Object System.Text.UTF8Encoding($false)))
New-Item -ItemType Directory -Force $backup | Out-Null

Write-Host "server\.env écrit."                              -ForegroundColor Green
Write-Host "Dossier des sauvegardes : $backup"
Write-Host ""
Write-Host "Étapes suivantes (docs\WINDOWS.md) :" -ForegroundColor Cyan
Write-Host "  1. Créez le rôle et la base PostgreSQL (§2) si ce n'est pas fait."
Write-Host "  2. npm run install:all"
Write-Host "  3. npm run build"
Write-Host "  4. cd server; npm run migrate; npm run seed   # notez le mot de passe admin affiché"
Write-Host "  5. npm start   (puis installez le service, §8)"
