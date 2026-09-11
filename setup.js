const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const ask = (query) => new Promise(resolve => rl.question(query, resolve));

const getPublicIp = () => {
    return new Promise((resolve) => {
        https.get('https://api.ipify.org', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data.trim()));
        }).on('error', () => {
            console.log('Public IP otomatik alınamadı.');
            resolve('');
        });
    });
};

const validateDiscordWebhook = (webhookUrl) => {
    return new Promise((resolve) => {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const payload = JSON.stringify({
            content: `Dasiiproxy doğrulama kodunuz: **${code}**`
        });

        const url = new URL(webhookUrl);
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ success: true, code });
            } else {
                resolve({ success: false });
            }
        });

        req.on('error', (error) => {
            console.error('Webhook bağlantı hatası:', error.message);
            resolve({ success: false });
        });

        req.write(payload);
        req.end();
    });
};

async function main() {
    console.log('--- Dasiiproxy Yapılandırma ---');
    console.log('Bu aşamada config.json dosyanız oluşturulacaktır.\n');

    const configPath = path.join(__dirname, 'config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.error('Mevcut config.json okunamadı, varsayılanlar kullanılacak.');
        }
    }

    const ansHotDomain = await ask(`Anlık Host Güncellemesi (domain eklediğinizde restartsız yansır) (E/h) [varsayılan: ${config.hotDomainDetect !== false ? 'E' : 'h'}]: `);
    config.hotDomainDetect = ansHotDomain.toLowerCase() === 'h' ? false : true;

    const ansLogs = await ask(`Erişim Logları tutulsun mu? (E/h) [varsayılan: ${config.enableAccessLogs !== false ? 'E' : 'h'}]: `);
    config.enableAccessLogs = ansLogs.toLowerCase() === 'h' ? false : true;

    const ansTraffic = await ask(`Trafiğe bağlı yönlendirme aktif edilsin mi? (E/h) [varsayılan: ${config.enablePriorityByTraffic !== false ? 'E' : 'h'}]: `);
    config.enablePriorityByTraffic = ansTraffic.toLowerCase() === 'h' ? false : true;

    let ansPass = await ask(`Dashboard şifresi belirleyin (Boş bırakırsanız mevcut şifre korunur): `);
    if (ansPass.trim()) {
        config.dashboardPassword = ansPass.trim();
    }

    const ansAIBots = await ask(`AI botları engellensin mi? (e/H) [varsayılan: ${config.blockAIBots ? 'e' : 'H'}]: `);
    config.blockAIBots = ansAIBots.toLowerCase() === 'e' ? true : false;

    const ansStaticPages = await ask(`Statik HTTP Response (varsayılan statik sayfalar) aktif edilsin mi? (E/h) [varsayılan: ${config.preferDefaultStaticPages !== false ? 'E' : 'h'}]: `);
    config.preferDefaultStaticPages = ansStaticPages.toLowerCase() === 'h' ? false : true;

    const ansIps = await ask('Önden whitelist eklenecek IP adresleri (virgülle ayırın, boş bırakabilirsiniz): ');
    if (ansIps.trim()) {
        const ips = ansIps.split(',').map(ip => ip.trim()).filter(ip => ip);
        config.ipWhitelist = [...new Set([...(config.ipWhitelist || []), ...ips])];
    }

    while (true) {
        const ansWebhook = await ask('Discord Webhook linki (Kullanmak istemiyorsanız boş bırakın): ');
        if (!ansWebhook.trim()) {
            break;
        }

        console.log('Webhook adresine doğrulama kodu gönderiliyor...');
        const result = await validateDiscordWebhook(ansWebhook.trim());

        if (result.success) {
            const enteredCode = await ask('Discord\'a gönderilen 6 haneli kodu girin: ');
            if (enteredCode.trim() === result.code) {
                console.log('Webhook başarıyla doğrulandı!');
                config.discordWebhook = ansWebhook.trim();
                break;
            } else {
                console.log('Hatalı kod! Webhook kaydedilmedi. Lütfen tekrar deneyin.');
            }
        } else {
            console.log('Webhook adresine mesaj gönderilemedi. Geçerli bir link olduğundan emin olun.');
        }
    }

    console.log('Sunucu Public IP adresi alınıyor...');
    const ip = await getPublicIp();
    if (ip) {
        console.log(`Sunucu IP adresi bulundu: ${ip}`);
        config.serverPublicIp = ip;
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    console.log('Yapılandırma başarıyla tamamlandı');
    rl.close();
}

main().catch(err => {
    console.error('Yapılandırma sırasında hata:', err);
    process.exit(1);
});
