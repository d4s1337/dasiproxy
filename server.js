const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const fs = require('fs'); 
const path = require('path');
const crypto = require('crypto');
let config = require('./config.json');
const configPath = path.join(__dirname, 'config.json');

function normalizeIp(value) {
    return String(value || '').trim().split(',')[0];
}

function getClientIp(req) {
    return normalizeIp(
        req.headers['cf-connecting-ip'] ||
        req.headers['x-forwarded-for'] ||
        req.socket.remoteAddress
    );
}

function persistConfig() {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
}

function sanitizeIpList(list) {
    if (!Array.isArray(list)) return [];
    return Array.from(new Set(list.map(normalizeIp).filter(Boolean)));
}

let whitelist = new Set();

function loadWhitelist() {
    whitelist = new Set(sanitizeIpList(config.ipWhitelist));
    config.ipWhitelist = Array.from(whitelist);
}

function isWhitelisted(ip) {
    return whitelist.has(normalizeIp(ip));
}

function saveWhitelist() {
    config.ipWhitelist = Array.from(whitelist);
    persistConfig();
}

if (!Array.isArray(config.ipWhitelist)) {
    config.ipWhitelist = [];
}
if (typeof config.maintenanceMode !== 'boolean') {
    config.maintenanceMode = false;
}
loadWhitelist();

// Sunucu IP'sini otomatik algıla
if (!config.serverPublicIp) {
    https.get('https://api.ipify.org', (res) => {
        let ip = '';
        res.on('data', d => ip += d);
        res.on('end', () => {
            if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip.trim())) {
                config.serverPublicIp = ip.trim();
                fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 4));
                console.log('\x1b[36m[AUTO-IP]\x1b[0m Sunucu Public IP Adresi Algılandı: ' + config.serverPublicIp);
            }
        });
    }).on('error', e => console.error('\x1b[31m[AUTO-IP HATA]\x1b[0m', e.message));
}



const recentLogs = [];
function addLog(type, args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
   
    const cleanMsg = msg.replace(/\x1b\[[0-9;]*m/g, '');
    recentLogs.push({ time: new Date().toISOString(), type, message: cleanMsg });
    if (recentLogs.length > 200) recentLogs.shift();
}
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = function(...args) { addLog('info', args); originalLog.apply(console, args); };
console.warn = function(...args) { addLog('warn', args); originalWarn.apply(console, args); };
console.error = function(...args) { addLog('error', args); originalError.apply(console, args); };

const hotDomainDetect = config.hotDomainDetect; 
const enableAccessLogs = config.enableAccessLogs; 

// Log Klasörü Hazırlığı
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Asenkron Loglama Fonksiyonu (Sunucuyu yavaşlatmaması için fs.appendFile kullanıldı)
function logRequest(ip, method, host, url, sessionId) {
    const date = new Date();
    const ymd = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const time = date.toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
    const logLine = `[${ymd} ${time}] [SESSION: ${sessionId}] IP: ${ip} | METHOD: ${method} | URL: ${host}${url}\n`;
    
    fs.appendFile(path.join(logsDir, `access-${ymd}.log`), logLine, (err) => {
        if (err) console.error('\x1b[31m[LOG ERROR]\x1b[0m', err.message);
    });
}

const staticPagesCache = {};
const errorPagesDir = path.join(__dirname, 'staticPages');
[400, 401, 403, 404, 429, 500, 502, 503, 504, 505].forEach(code => {
    let content = null;
    const candidates = [
        path.join(errorPagesDir, `${code}.html`),
        path.join(__dirname, `${code}.html`)
    ];
    for (const filePathCandidate of candidates) {
        try {
            content = fs.readFileSync(filePathCandidate, 'utf8');
            break;
        } catch (e) {
            // dosya yoksa diğer adaya devam et
        }
    }
    staticPagesCache[code] = content || `Error ${code} / Hatali sayfa dosyasi bulunamadi.`;
});

const supportedErrorCodes = new Set(['400', '401', '403', '404', '429', '500', '502', '503', '504', '505']);
const errorPages = new Proxy(staticPagesCache, {
    get: function(target, prop) {
        if (!supportedErrorCodes.has(String(prop))) {
            return undefined;
        }
        if (config.preferDefaultStaticPages === false) {
            return undefined; // Vhost'un kendi sayfasını/yanıtını kullanmasına izin ver
        }
        return target[prop] || `Error ${prop}`;
    }
});

const proxy = httpProxy.createProxyServer({
    proxyTimeout: 30000,
    timeout: 30000,
    changeOrigin: true,
    xfwd: true,
    selfHandleResponse: true
});

const discordAlertCooldown = new Map();

function notifyDiscordWebhook(domain, errMessage) {
    if (!config.discordWebhook || !config.discordWebhook.startsWith('http')) return;
    
    const now = Date.now();
    const lastAlert = discordAlertCooldown.get(domain) || 0;
    if (now - lastAlert < 5 * 60 * 1000) return; // 5 dakika cooldown
    discordAlertCooldown.set(domain, now);

    const embed = {
        content: "@here",
        embeds: [{
            title: "dasiiProxy Uyarı",
            color: 0xff0000,
            fields: [
                { name: "Domain", value: `\`${domain}\``, inline: true },
                { name: "Zaman", value: `\`${new Date().toLocaleString('tr-TR')}\``, inline: true },
                { name: "Hata", value: `\`${errMessage}\``, inline: false }
            ],
            footer: { text: "dasiiproxy v2 - otomatik uyarı sistemi" }
        }]
    };

    const client = config.discordWebhook.startsWith('https') ? require('https') : require('http');
    const webhookReq = client.request(config.discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    
    webhookReq.on('error', (e) => console.error('\x1b[31m[DISCORD WEBHOOK ERROR]\x1b[0m', e.message));
    webhookReq.write(JSON.stringify(embed));
    webhookReq.end();
}

proxy.on('error', (err, req, res) => {
    const rawHost = req.headers.host || '';
    const host = rawHost.split(':')[0] || 'Bilinmeyen Domain';
    
    console.error('\x1b[31m[PROXY ERROR]\x1b[0m', err.message);
    notifyDiscordWebhook(host, err.message);

    if (!res.headersSent) {
        res.writeHead(503, { 
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
        });
    }
    // cf çakal olduğundan bizde kazma değiliz dodgeluyoruz
    res.end(errorPages[502] || `502 Bad Gateway - Vhost Offline (${err.message})`);
});

proxy.on('proxyRes', (proxyRes, req, res) => {
    if (errorPages[proxyRes.statusCode]) {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[proxyRes.statusCode]);
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
});

// ratelimit koruma - gemini
const rateLimit = new Map();
const LIMIT = 120;
const WINDOW = 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of rateLimit.entries()) {
        if (now - data.time > WINDOW) {
            rateLimit.delete(ip);
        }
    }
}, 30000);

const dashboardExemptIPs = new Set();
function isRateLimited(ip) {
    if (isWhitelisted(ip)) return false;
    if (dashboardExemptIPs.has(ip)) return false;
    if (blacklist.has(ip)) return true;

    // ddos korumasında 10k ip ile memory leak koruması. -gemini ekledi
    if (rateLimit.size > 10000) rateLimit.clear();

    const record = rateLimit.get(ip);
    if (!record) {
        rateLimit.set(ip, { count: 1, time: Date.now() });
        return false;
    }
    record.count++;

    // Otomatik Ban (Çok fazla spam yaparsa)
    if (record.count > LIMIT * 5) {
        if (!blacklist.has(ip)) {
            blacklist.add(ip);
            saveBlacklist();
            console.log('\x1b[35m[AUTO BAN]\x1b[0m Aşırı spam algılandı, IP kara listeye alındı:', ip);
        }
        return true;
    }

    return record.count > LIMIT;
}


const vhostsPath = path.join(__dirname, 'vhosts.json');
let vhosts = {};

const blacklistPath = path.join(__dirname, 'blacklist.json');
let blacklist = new Set();

function loadBlacklist() {
    try {
        if (!fs.existsSync(blacklistPath)) {
            fs.writeFileSync(blacklistPath, '[]');
        }
        const data = fs.readFileSync(blacklistPath, 'utf8');
        blacklist = new Set(JSON.parse(data));
        console.log('\x1b[36m[BLACKLIST]\x1b[0m Liste yüklendi. Yasaklı IP sayısı:', blacklist.size);
    } catch (e) {
        console.error('\x1b[31m[BLACKLIST ERROR]\x1b[0m blacklist.json okunamadı veya hatalı:', e.message);
    }
}

function saveBlacklist() {
    try {
        fs.writeFileSync(blacklistPath, JSON.stringify(Array.from(blacklist), null, 4));
    } catch (e) {
        console.error('\x1b[31m[BLACKLIST ERROR]\x1b[0m Kaydedilemedi:', e.message);
    }
}

function loadVhosts() {
    try {
        const data = fs.readFileSync(vhostsPath, 'utf8');
        vhosts = JSON.parse(data);
        console.log('\x1b[36m[dasiHotProxy 2.0]\x1b[0m Domain listesi yüklendi. Aktif domain sayısı:', Object.keys(vhosts).length);
    } catch (e) {
        console.error('\x1b[31m[dasiHP ERROR]\x1b[0m vhosts.json okunamadı veya JSON hatalı:', e.message);
    }
}


loadVhosts();
loadBlacklist();

// öncelik sistemi  + ziyaret statları  dasii Adaptive Traffic Router (ATR)
const statsPath = path.join(__dirname, 'visit_stats.json');
const priorityPath = path.join(__dirname, 'priority_sites.json');
let visitStats = {};
let topSites = new Set();

function loadVisitStats() {
    try {
        if (!fs.existsSync(statsPath)) fs.writeFileSync(statsPath, '{}');
        visitStats = JSON.parse(fs.readFileSync(statsPath, 'utf8')) || {};
    } catch (e) {
        visitStats = {};
    }
}

function saveVisitStats() {
    try { fs.writeFileSync(statsPath, JSON.stringify(visitStats, null, 4)); } catch (e) {}
}

function loadTopSites() {
    try {
        if (!fs.existsSync(priorityPath)) fs.writeFileSync(priorityPath, '[]');
        const data = JSON.parse(fs.readFileSync(priorityPath, 'utf8')) || [];
        topSites = new Set(data);
    } catch (e) {
        topSites = new Set();
    }
}

function saveTopSites() {
    try { fs.writeFileSync(priorityPath, JSON.stringify(Array.from(topSites), null, 4)); } catch (e) {}
}

function recordVisit(host) {
    if (!host) return;
    visitStats[host] = (visitStats[host] || 0) + 1;
}

function evaluatePriorities() {
    try {
        const topCount = Number(config.priorityTopCount) || 10;
        const entries = Object.entries(visitStats);
        entries.sort((a, b) => b[1] - a[1]);
        const top = entries.slice(0, topCount).map(e => e[0]);
        topSites = new Set(top);
        saveTopSites();
        visitStats = {}; // reset for next period
        saveVisitStats();
        console.log('\x1b[36m[PRIORITY]\x1b[0m Monthly priority evaluated. Top sites:', top);
    } catch (e) {
        console.error('\x1b[31m[PRIORITY ERROR]\x1b[0m', e.message);
    }
}

loadVisitStats();
loadTopSites();

if (hotDomainDetect) {
    fs.watch(vhostsPath, (eventType) => {
        if (eventType === 'change') {
            
            setTimeout(() => {
                console.log('\x1b[33m[dasiHotProxy 2.0]\x1b[0m vhosts.json değişikliği algılandı, güncelleniyor...');
                loadVhosts();
            }, 100);
        }
    });

    fs.watch(blacklistPath, (eventType) => {
        if (eventType === 'change') {
            setTimeout(() => {
                loadBlacklist();
            }, 100);
        }
    });

    // watch config so toggles take effect without restart
    fs.watch(configPath, (eventType) => {
        if (eventType === 'change') {
            setTimeout(() => {
                try {
                    delete require.cache[require.resolve('./config.json')];
                    config = require('./config.json');
                    if (!Array.isArray(config.ipWhitelist)) config.ipWhitelist = [];
                    if (typeof config.maintenanceMode !== 'boolean') config.maintenanceMode = false;
                    loadWhitelist();
                    console.log('\x1b[33m[CONFIG]\x1b[0m config.json değişikliği yüklendi.');
                } catch (e) {
                    console.error('\x1b[31m[CONFIG ERROR]\x1b[0m', e.message);
                }
            }, 100);
        }
    });
}



const dpSessionsPath = path.join(__dirname, 'dpsessions.json');
let dpSessions = new Map();

function loadDpSessions() {
    try {
        if (!fs.existsSync(dpSessionsPath)) {
            fs.writeFileSync(dpSessionsPath, '{}');
        }
        const data = fs.readFileSync(dpSessionsPath, 'utf8');
        dpSessions = new Map(Object.entries(JSON.parse(data)));
        console.log('\x1b[36m[dpSession]\x1b[0m Session listesi yüklendi. Kayıtlı session sayısı:', dpSessions.size);
    } catch (e) {
        console.error('\x1b[31m[dpSession ERROR]\x1b[0m dpsessions.json okunamadı:', e.message);
    }
}

function saveDpSessions() {
    try {
        fs.writeFileSync(dpSessionsPath, JSON.stringify(Object.fromEntries(dpSessions), null, 4));
    } catch (e) {
        console.error('\x1b[31m[dpSession ERROR]\x1b[0m Kaydedilemedi:', e.message);
    }
}

loadDpSessions();

function getDpSession(ip, req) {
    
    const ua = req.headers['user-agent'] || 'unknown';
    const acceptLang = req.headers['accept-language'] || 'unknown';
    
    // Kullanıcıya özgü parmak izi
    const fingerprint = `${ip}|${ua}|${acceptLang}`;
    
    
    if (dpSessions.size > 50000) {
        dpSessions.clear();
        saveDpSessions();
    }

    if (dpSessions.has(fingerprint)) {
        return dpSessions.get(fingerprint);
    } else {
        const sessionId = crypto.randomUUID();
        dpSessions.set(fingerprint, sessionId);
        saveDpSessions(); // Dosyaya kaydet
        return sessionId;
    }
}

global.totalRequests = 0;
global.aiBotBlocks = 0;
global.totalResponseTime = 0;
global.completedRequests = 0;

const server = http.createServer((req, res) => {
    
    global.totalRequests++;
    const reqStartTime = Date.now();
    res.on('finish', () => {
        global.completedRequests++;
        global.totalResponseTime += (Date.now() - reqStartTime);
    });

    const rawHost = req.headers.host || '';
    const host = rawHost.split(':')[0];
    const targetPort = vhosts[host];

    const realIP = getClientIp(req);

    const dpSessionId = getDpSession(realIP, req);
    // record visit stats and global traffic
    try {
        recordVisit(host);
    } catch (e) {}

    // simple global requests counter per WINDOW to detect high traffic
    if (typeof global.requestsInWindow === 'undefined') global.requestsInWindow = 0;
    global.requestsInWindow++;
    
    
    if (config.enableDpSessionApi && host === config.dpSessionApiDomain && req.url.startsWith('/dpsession/api/')) {
        const urlParams = new URL(req.url, `http://${host}`).searchParams;
        const banUUID = urlParams.get('ban');
        const unbanUUID = urlParams.get('unban');
        const auth = urlParams.get('auth');

        if (auth !== config.dpSessionApiKey) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Geçersiz Yetki Kodu (Auth Mismatch)');
        }

        if (banUUID) {
            let bannedIPs = [];
            for (const [fingerprint, sid] of dpSessions.entries()) {
                if (sid === banUUID) {
                    const ip = fingerprint.split('|')[0];
                    if (!blacklist.has(ip)) {
                        blacklist.add(ip);
                        bannedIPs.push(ip);
                    }
                }
            }
            if (bannedIPs.length > 0) saveBlacklist();
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(`Session [ ${banUUID} ] BANLANDI. Yasaklanan IP'ler: ${bannedIPs.join(', ')}`);
        } else if (unbanUUID) {
            let unbannedIPs = [];
            for (const [fingerprint, sid] of dpSessions.entries()) {
                if (sid === unbanUUID) {
                    const ip = fingerprint.split('|')[0];
                    if (blacklist.has(ip)) {
                        blacklist.delete(ip);
                        unbannedIPs.push(ip);
                    }
                }
            }
            if (unbannedIPs.length > 0) saveBlacklist();
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(`Session [ ${unbanUUID} ] BAN KALDIRILDI. Izin acilan IP'ler: ${unbannedIPs.join(', ')}`);
        } else {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Geçersiz İstek (Parametre Eksik)');
        }
    }

    if (enableAccessLogs) {
        logRequest(realIP, req.method, host, req.url, dpSessionId);
    }

    if (config.maintenanceMode && !isWhitelisted(realIP) && targetPort !== '8081') {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[503]);
    }

    
    if (blacklist.has(realIP) && !isWhitelisted(realIP)) {
        console.warn('\x1b[31m[dasiproxy BL]\x1b[0m HTTP İstemi reddedildi:', realIP);
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[403]);
    }

    
    if (!req.headers['cf-ray']) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[403]);
    }

    // direkt vds ip üzerinden erişimi engelle
    if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[403]);
    }

    // Mini WAF (Web Application Firewall) - Zararlı URL Taraması
    try {
        const urlDecoded = decodeURIComponent(req.url).toLowerCase();
        const wafPatterns = /(\.\.\/|\.env|union\s+select|<script>|javascript:|base64_decode|etc\/passwd)/i;
        if (wafPatterns.test(urlDecoded)) {
            console.warn('\x1b[41m\x1b[37m[WAF BLOCKED]\x1b[0m', realIP, req.url);
            res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(errorPages[403]);
        }
    } catch (err) {
        // decodeURIComponent hatasına karşı (geçersiz byte dizisi gönderilirse)
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[400]);
    }

    // rate limtii with traffic-priority bypass
    const rateLimited = isRateLimited(realIP);
    if (rateLimited) {
        const highTraffic = Boolean(global.isHighTraffic);
        const priorityEnabled = Boolean(config.enablePriorityByTraffic);
        const hostIsTop = topSites.has(host);
        if (!(priorityEnabled && highTraffic && hostIsTop)) {
            console.warn('\x1b[33m[RATE LIMIT]\x1b[0m', realIP);
            res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(errorPages[429]);
        } else {
            console.log('\x1b[36m[PRIORITY ALLOW]\x1b[0m', host, realIP);
        }
    }

    
    const allowedMethods = ['GET', 'POST', 'HEAD', 'OPTIONS']; 
    if (!allowedMethods.includes(req.method)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[403]);
    }

    // user-agent kontrolü
    const ua = req.headers['user-agent'];
    if (!ua || ua.length < 5) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[403]);
    }

    // AI Bot koruması
    if (config.blockAIBots) {
        const aiPattern = /(claude|searchbot|gptbot|chatgpt|anthropic|bytespider|diffbot|applebot|amazonbot|perplexity|meta-externalfetcher|meta-externalagent|oai-searchbot|bingbot|googlebot|google-cloudvertexbot|googleother|duckassistbot|petalbot|tiktokspider|ccbot)/i;
        if (aiPattern.test(ua)) {
            global.aiBotBlocks++;
            console.warn('\x1b[33m[AI BOT BLOCKED]\x1b[0m İstek reddedildi:', realIP, ua);
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end("Bu sitede dasiiproxy ile AI erişimi engellenmiş, dasiiproxy'i sende denemek istiyorsan proxy.dasii.live adresini ziyaret et!");
        }
    }

    // güvenlik headerları
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=()');

    // yönlendirme 2.0 (reverse proxy dalgası)

    if (targetPort === 'maintenance') {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[503]);
    } else if (targetPort) {
        proxy.web(req, res, { target: `http://127.0.0.1:${targetPort}` });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorPages[404]);
    }
});


server.keepAliveTimeout = 75000;
server.headersTimeout = 80000;

// wss destek
server.on('upgrade', (req, socket, head) => {
    const realIP = getClientIp(req);

    // bl ws kapat
    if (!isWhitelisted(realIP) && blacklist.has(realIP)) {
        console.warn('\x1b[31m[BLACKLIST BLOCKED]\x1b[0m WS İsteci reddedildi:', realIP);
        return socket.destroy();
    }

    if (config.maintenanceMode && !isWhitelisted(realIP)) {
        return socket.destroy();
    }

    const rawHost = req.headers.host || '';
    const host = rawHost.split(':')[0];
    const targetPort = vhosts[host];

    if (targetPort && targetPort !== 'maintenance') {
        proxy.ws(req, socket, head, { target: `http://127.0.0.1:${targetPort}` });
    } else {
        // Hedef yoksa veya bakım modundaysa soketi kopar
        socket.destroy();
    }
});

server.listen(80, '0.0.0.0', () => {
    console.log('\x1b[32m%s\x1b[0m', '-----------------------------------------');
    console.log('\x1b[32m%s\x1b[0m', 'dasiiProxy 2.0');
    
    if (enableAccessLogs) {
        console.log('\x1b[36m%s\x1b[0m', 'erişim ip loglama: aktif');
    } else {
        console.log('\x1b[33m%s\x1b[0m', 'erişim ip loglama: inaktif');
    }

    console.log('\x1b[32m%s\x1b[0m', '-----------------------------------------');
});

// Dashboard Auth & Rate Limit
const loginRateLimit = new Map();

function renderDashboardGate() {
    return `<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>dasiiproxy dashboard kilitli</title>
    <style>
        :root { --bg:#010204; --border:rgba(255,255,255,.08); --muted:rgba(255,255,255,.45); --primary:#ADD8E6; }
        * { box-sizing:border-box; font-family: Arial, sans-serif; }
        html, body { margin:0; height:100%; background:var(--bg); color:#fff; }
        body { display:flex; align-items:center; justify-content:center; }
        .card {
            width:min(420px, calc(100% - 32px));
            padding:32px;
            border:1px solid var(--border);
            border-radius:20px;
            background:rgba(1,2,4,.88);
            box-shadow:0 20px 50px rgba(0,0,0,.45);
        }
        h1 { margin:0 0 10px; font-size:22px; }
        p { margin:0 0 20px; color:var(--muted); line-height:1.5; }
        input, button {
            width:100%; border-radius:12px; border:1px solid var(--border); padding:14px 16px;
            font-size:16px; outline:none;
        }
        input { background:rgba(0,0,0,.25); color:#fff; margin-bottom:12px; }
        button { background:#fff; color:#010204; font-weight:700; cursor:pointer; }
        button:hover { background:var(--primary); }
        #err { min-height:18px; color:#f87171; font-size:14px; margin-bottom:12px; }
    </style>
</head>
<body>
    <div class="card">
        <h1>dasiiproxy dashboard</h1>
        <p>erişim için şifre gerekir. giriş yaptıktan sonra panel otomatik açılır.</p>
        <form id="login-form">
            <input id="password" type="password" placeholder="şifre" autocomplete="current-password" required>
            <div id="err"></div>
            <button type="submit">giriş yap</button>
        </form>
    </div>
    <script>
        const form = document.getElementById('login-form');
        const err = document.getElementById('err');
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            err.textContent = '';
            const password = document.getElementById('password').value;
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ password })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    err.textContent = data.error || 'hatalı şifre';
                    return;
                }
                location.reload();
            } catch (e) {
                err.textContent = 'sunucuya bağlanılamadı';
            }
        });
    </script>
</body>
</html>`;
}

function isLoginRateLimited(ip) {
    const now = Date.now();
    const record = loginRateLimit.get(ip) || { count: 0, time: now };
    if (now - record.time > 60000) {
        record.count = 0;
        record.time = now;
    }
    record.count++;
    loginRateLimit.set(ip, record);
    return record.count > 5; // 5 attempts per minute
}

const os = require('os');
const dashboardServer = http.createServer((req, res) => {
    // CORS headers for local/development access if needed
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, authorization');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const realIP = getClientIp(req);

    // Helper to parse JSON body
    function parseBody(callback) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                callback(JSON.parse(body));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    const requestPassword = req.headers['x-dashboard-password'];
    const hasDashboardAuth = requestPassword && requestPassword === config.dashboardPassword;

    if (config.maintenanceMode && !isWhitelisted(realIP)) {
        const isDashboardControlRequest = req.url === '/api/login' || req.url === '/api/logout' || (req.url.startsWith('/api/') && hasDashboardAuth);
        if (!isDashboardControlRequest) {
            res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ error: 'Maintenance mode active' }));
        }
    }

    if (req.url === '/api/login' && req.method === 'POST') {
        if (isLoginRateLimited(realIP)) {
            res.writeHead(429);
            return res.end(JSON.stringify({ error: 'Too many login attempts. Please try again later.' }));
        }
        
        parseBody(data => {
            const password = data.password;
            if (password && password === config.dashboardPassword) {
                dashboardExemptIPs.add(realIP);
                res.writeHead(200);
                res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'Invalid password' }));
            }
        });
        return;
    }

    if (req.url === '/api/logout' && req.method === 'POST') {
        dashboardExemptIPs.delete(realIP);
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true }));
    }

    // Require Auth for other APIs
    if (req.url.startsWith('/api/')) {
        if (!hasDashboardAuth) {
            res.writeHead(401);
            return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
    }

    if (req.url === '/api/status' && req.method === 'GET') {
        res.writeHead(200);
        return res.end(JSON.stringify({
            uptime: Math.floor(process.uptime()),
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            loadAvg: os.loadavg(),
            cpus: os.cpus().length,
            connections: dpSessions.size,
            totalRequests: global.totalRequests || 0,
            aiBotBlocks: global.aiBotBlocks || 0,
            avgResponseTime: global.completedRequests ? Math.floor(global.totalResponseTime / global.completedRequests) : 0,
            maintenanceMode: Boolean(config.maintenanceMode),
            whitelistCount: whitelist.size
        }));
    } else if (req.url === '/api/config' && req.method === 'GET') {
        res.writeHead(200);
        return res.end(JSON.stringify(config));
    } else if (req.url === '/api/config' && req.method === 'POST') {
        parseBody(data => {
            // Sadece gelen datadaki propertyleri güncelle, eskisini silme
            for (const key in data) {
                config[key] = data[key];
            }
            if (!Array.isArray(config.ipWhitelist)) config.ipWhitelist = [];
            if (typeof config.maintenanceMode !== 'boolean') config.maintenanceMode = false;
            loadWhitelist();
            persistConfig();
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, config }));
        });
    } else if (req.url === '/api/whitelist' && req.method === 'GET') {
        res.writeHead(200);
        return res.end(JSON.stringify(Array.from(whitelist)));
    } else if (req.url === '/api/whitelist/add' && req.method === 'POST') {
        parseBody(data => {
            const ip = normalizeIp(data.ip);
            if (!ip) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: 'IP required' }));
            }
            whitelist.add(ip);
            saveWhitelist();
            res.writeHead(200);
            return res.end(JSON.stringify({ success: true, whitelist: Array.from(whitelist) }));
        });
    } else if (req.url === '/api/whitelist/delete' && req.method === 'POST') {
        parseBody(data => {
            const ip = normalizeIp(data.ip);
            if (!ip) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: 'IP required' }));
            }
            whitelist.delete(ip);
            saveWhitelist();
            res.writeHead(200);
            return res.end(JSON.stringify({ success: true, whitelist: Array.from(whitelist) }));
        });
    } else if (req.url === '/api/blacklist' && req.method === 'GET') {
        res.writeHead(200);
        return res.end(JSON.stringify(Array.from(blacklist)));
    } else if (req.url === '/api/vhosts' && req.method === 'GET') {
        res.writeHead(200);
        return res.end(JSON.stringify(vhosts));
    } else if (req.url === '/api/vhosts/add' && req.method === 'POST') {
        parseBody(data => {
            if (data.domain && data.port) {
                vhosts[data.domain] = data.port.toString();
                fs.writeFileSync(vhostsPath, JSON.stringify(vhosts, null, 4));
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, vhosts }));
                
                // Cloudflare Rota 2.0 Integration
                if (config.enableCloudflare && config.cfApiToken && config.cfZoneId && config.serverPublicIp) {
                    const cfData = JSON.stringify({
                        type: 'A',
                        name: data.domain,
                        content: config.serverPublicIp,
                        proxied: true,
                        comment: 'Added via dasiiproxy'
                    });
                    
                    const cfReq = https.request({
                        method: 'POST',
                        hostname: 'api.cloudflare.com',
                        path: `/client/v4/zones/${config.cfZoneId}/dns_records`,
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${config.cfApiToken}`,
                            'Content-Length': Buffer.byteLength(cfData)
                        }
                    }, cfRes => {
                        let cfBody = '';
                        cfRes.on('data', chunk => cfBody += chunk);
                        cfRes.on('end', () => {
                            if (cfRes.statusCode === 200 || cfRes.statusCode === 201) {
                                console.log(`\x1b[32m[CLOUDFLARE]\x1b[0m Başarıyla DNS kaydı oluşturuldu: ${data.domain}`);
                            } else {
                                console.error(`\x1b[31m[CLOUDFLARE HATA]\x1b[0m ${cfRes.statusCode} - ${cfBody}`);
                            }
                        });
                    });
                    cfReq.on('error', err => console.error(`\x1b[31m[CLOUDFLARE HATA]\x1b[0m API isteği başarısız:`, err.message));
                    cfReq.write(cfData);
                    cfReq.end();
                }
            } else {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Domain and port required' }));
            }
        });
    } else if (req.url === '/api/vhosts/delete' && req.method === 'POST') {
        parseBody(data => {
            if (data.domain && vhosts[data.domain]) {
                delete vhosts[data.domain];
                fs.writeFileSync(vhostsPath, JSON.stringify(vhosts, null, 4));
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, vhosts }));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Domain not found' }));
            }
        });
    } else if (req.url === '/api/logs' && req.method === 'GET') {
        res.writeHead(200);
        return res.end(JSON.stringify(recentLogs));
    } else if (req.url === '/api/access-logs' && req.method === 'GET') {
        const date = new Date();
        const ymd = date.toISOString().split('T')[0];
        const logFile = path.join(__dirname, 'logs', `access-${ymd}.log`);
        fs.readFile(logFile, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(200);
                return res.end(JSON.stringify([]));
            }
            const lines = data.split('\n').filter(l => l.trim() !== '');
            const last80 = lines.slice(-80);
            res.writeHead(200);
            res.end(JSON.stringify(last80));
        });
    } else if (req.url === '/api/sessions' && req.method === 'GET') {
        res.writeHead(200);
        return res.end(JSON.stringify(Object.fromEntries(dpSessions)));
    } else if (req.url.startsWith('/api/sessions/logs') && req.method === 'GET') {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const sid = urlObj.searchParams.get('sid');
        
        const date = new Date();
        const ymd = date.toISOString().split('T')[0];
        const logFile = path.join(__dirname, 'logs', `access-${ymd}.log`);
        
        fs.readFile(logFile, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(200);
                return res.end(JSON.stringify([]));
            }
            const lines = data.split('\n')
                .filter(l => l.includes(`[SESSION: ${sid}]`) && l.trim() !== '')
                .slice(-50); // Get last 50 logs for this session
            res.writeHead(200);
            res.end(JSON.stringify(lines));
        });
    } else if (req.url.startsWith('/api/sessions/list') && req.method === 'GET') {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const page = parseInt(urlObj.searchParams.get('page')) || 1;
        const search = (urlObj.searchParams.get('search') || '').toLowerCase();
        
        let results = [];
        for (const [fingerprint, sid] of dpSessions.entries()) {
            if (!search || fingerprint.toLowerCase().includes(search) || sid.toLowerCase().includes(search)) {
                const ip = fingerprint.split('|')[0];
                results.push({ fingerprint, sid, ip, isBanned: blacklist.has(ip) });
            }
        }
        
        const total = results.length;
        const totalPages = Math.ceil(total / 20) || 1;
        const pagedResults = results.slice((page - 1) * 20, page * 20);
        
        res.writeHead(200);
        return res.end(JSON.stringify({
            items: pagedResults,
            total,
            page,
            totalPages
        }));
    } else if (req.url === '/api/sessions/ban' && req.method === 'POST') {
        parseBody(data => {
            if (data.ip) {
                blacklist.add(data.ip);
                saveBlacklist(); /* Need to make sure saveBlacklist is accessible. It is. */
                res.writeHead(200);
                res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'IP required' }));
            }
        });
    } else if (req.url === '/api/sessions/unban' && req.method === 'POST') {
        parseBody(data => {
            if (data.ip) {
                blacklist.delete(data.ip);
                saveBlacklist();
                res.writeHead(200);
                res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'IP required' }));
            }
        });
    } else if (req.url.startsWith('/classic')) {
        const classicPath = path.join(__dirname, 'dashboard2.html');
        fs.readFile(classicPath, 'utf8', (err, content) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end('<h1>Classic Dashboard not found</h1>');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
                return res.end(content);
            }
        });
    } else {
        // Serve dashboard.html
        const dashboardPath = path.join(__dirname, 'dashboard.html');
        fs.readFile(dashboardPath, 'utf8', (err, content) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end('<h1>Dashboard (dashboard.html not found)</h1><p>API is running on /api/status, /api/config, /api/vhosts, /api/blacklist</p>');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate' });
                return res.end(content);
            }
        });
    }
});

dashboardServer.listen(8081, '0.0.0.0', () => {
    console.log('\x1b[36m%s\x1b[0m', '[DASHBOARD] Dashboard API server listening on port 8081');
});