# Dasiiproxy Kurulum Betiği (Windows)

Write-Host "--- Dasiiproxy Kurulumu Başlıyor ---" -ForegroundColor Cyan

# 1. Node.js Kontrolü
try {
    $nodeVersion = node -v
    Write-Host "Node.js kontrol edildi: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "Hata: Node.js kurulu değil. Lütfen önce Node.js (https://nodejs.org) kurun." -ForegroundColor Red
    exit 1
}

# 2. PM2 Kontrolü / Kurulumu
try {
    $pm2Version = pm2 -v
    Write-Host "pm2 kontrol edildi: $pm2Version" -ForegroundColor Green
} catch {
    Write-Host "pm2 bulunamadı, kuruluyor..." -ForegroundColor Yellow
    npm install pm2@latest -g
    # Windows'ta startup scripti için pm2-windows-startup kullanılabilir ama basitlik için npm komutu veriyoruz
    npm install pm2-windows-startup -g
    pm2-startup install
}

# 3. Klonlama ve Dizin Ayarlama
$TARGET_DIR = "C:\dasiiproxy"
$REPO_URL = "https://github.com/d4s1337/dasiproxy.git"

if (Test-Path -Path $TARGET_DIR) {
    Write-Host "Uyarı: $TARGET_DIR dizini zaten mevcut. İçeriği silinip baştan kurulacak..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force -Path $TARGET_DIR
}

Write-Host "Git deposu klonlanıyor..." -ForegroundColor Cyan
git clone $REPO_URL $TARGET_DIR

if (-Not (Test-Path -Path $TARGET_DIR)) {
    Write-Host "Hata: Depo klonlanamadı." -ForegroundColor Red
    exit 1
}

Set-Location -Path $TARGET_DIR

# 4. NPM Install
Write-Host "Bağımlılıklar yükleniyor (npm install)..." -ForegroundColor Cyan
npm install

# 5. Yapılandırma Adımı
Write-Host "Yapılandırma sihirbazı başlatılıyor..." -ForegroundColor Cyan
node setup.js

# 6. PM2 ile Başlatma
Write-Host "Uygulama PM2 ile başlatılıyor..." -ForegroundColor Cyan
pm2 start server.js --name dasiiproxy
pm2 save

Write-Host "--- Kurulum Tamamlandı! ---" -ForegroundColor Green
