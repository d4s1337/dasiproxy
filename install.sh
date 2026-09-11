#!/bin/bash

# Dasiiproxy Kurulum Betiği (Linux)

echo "--- Dasiiproxy Kurulumu Başlıyor ---"

# 1. Node.js Kontrolü
if ! command -v node &> /dev/null
then
    echo "Hata: Node.js kurulu değil. Lütfen önce Node.js kurun."
    echo "Önerilen komut: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi
echo "Node.js kontrol edildi: Tamam."

# 2. PM2 Kontrolü / Kurulumu
if ! command -v pm2 &> /dev/null
then
    echo "pm2 bulunamadı, kuruluyor..."
    sudo npm install pm2@latest -g
    sudo pm2 startup
else
    echo "pm2 kontrol edildi: Tamam."
fi

# 3. Klonlama ve Dizin Ayarlama
TARGET_DIR="/opt/dasiiproxy"
REPO_URL="https://github.com/d4s1337/dasiproxy.git"

if [ -d "$TARGET_DIR" ]; then
    echo "Uyarı: $TARGET_DIR dizini zaten mevcut. İçeriği silinip baştan kurulacak..."
    sudo rm -rf "$TARGET_DIR"
fi

echo "Git deposu klonlanıyor..."
sudo git clone "$REPO_URL" "$TARGET_DIR"

if [ ! -d "$TARGET_DIR" ]; then
    echo "Hata: Depo klonlanamadı."
    exit 1
fi

cd "$TARGET_DIR" || exit 1

# 4. NPM Install
echo "Bağımlılıklar yükleniyor (npm install)..."
sudo npm install

# 5. Yapılandırma Adımı
echo "Yapılandırma sihirbazı başlatılıyor..."
node setup.js

# 6. PM2 ile Başlatma
echo "Uygulama PM2 ile başlatılıyor..."
sudo pm2 start server.js --name dasiiproxy
sudo pm2 save

echo "--- Kurulum Tamamlandı! ---"
