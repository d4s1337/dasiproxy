const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const net = require('net');
let config = require('./config.json');
const configPath = path.join(__dirname, 'config.json');

const jsonsDir = path.join(__dirname, 'jsons');
if (!fs.existsSync(jsonsDir)) {
    fs.mkdirSync(jsonsDir, { recursive: true });
}

function jsonPath(fileName) {
    return path.join(jsonsDir, fileName);
}

(function migrateJsonFiles() {
    const managed = ['vhosts.json', 'blacklist.json', 'dpsessions.json', 'visit_stats.json', 'priority_sites.json', 'ssl.json'];
    for (const fileName of managed) {
        const oldPath = path.join(__dirname, fileName);
        const newPath = jsonPath(fileName);
        if (!fs.existsSync(oldPath)) continue;
        try {
            if (fs.existsSync(newPath)) {
                fs.renameSync(oldPath, oldPath + '.bak');
                console.log('\x1b[33m[MIGRATE]\x1b[0m jsons/' + fileName + ' zaten var, eski dosya ' + fileName + '.bak olarak saklandı.');
            } else {
                fs.renameSync(oldPath, newPath);
                console.log('\x1b[36m[MIGRATE]\x1b[0m ' + fileName + ' -> jsons/' + fileName);
            }
        } catch (e) {
            console.error('\x1b[31m[MIGRATE ERROR]\x1b[0m ' + fileName + ':', e.message);
        }
    }
})();

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

if (config.discordWebhook && !config.proxyWebhook) {
    config.proxyWebhook = config.discordWebhook;
    config.discordWebhook = '';
    persistConfig();
    console.log('\x1b[36m[CONFIG]\x1b[0m discordWebhook -> proxyWebhook olarak taşındı.');
}
if (typeof config.proxyWebhook !== 'string') config.proxyWebhook = '';
if (typeof config.ddosWebhook !== 'string') config.ddosWebhook = '';

loadWhitelist();

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



const util = require('util');

const recentLogs = [];
function addLog(type, args) {
    const msg = util.format(...args);

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

const NOTIFICATION_LIMIT = 100;
const NOTIFICATION_LEVELS = new Set(['critical', 'warning', 'info', 'success']);
const notificationsPath = jsonPath('notifications.json');
const notifications = [];
const notificationDedupe = new Map();
let notificationSeq = 0;
let notificationSaveTimer = null;

function loadNotifications() {
    try {
        if (!fs.existsSync(notificationsPath)) {
            fs.writeFileSync(notificationsPath, '[]');
            return;
        }
        const data = JSON.parse(fs.readFileSync(notificationsPath, 'utf8'));
        if (!Array.isArray(data)) return;

        for (const row of data) {
            if (!row || typeof row !== 'object') continue;
            const id = Number(row.id);
            const ts = Number(row.ts);
            if (!Number.isFinite(id) || !Number.isFinite(ts)) continue;
            if (!NOTIFICATION_LEVELS.has(row.level)) continue;

            notifications.push({
                id,
                ts,
                level: row.level,
                title: String(row.title || ''),
                message: String(row.message || ''),
                read: Boolean(row.read)
            });
        }

        notifications.sort((a, b) => a.id - b.id);
        while (notifications.length > NOTIFICATION_LIMIT) notifications.shift();
        notificationSeq = notifications.reduce((max, n) => Math.max(max, n.id), 0);

        console.log('\x1b[36m[BİLDİRİM]\x1b[0m Kayıtlar yüklendi:', notifications.length,
            '| okunmamış:', notifications.filter(n => !n.read).length);
    } catch (e) {
        console.error('\x1b[31m[BİLDİRİM HATA]\x1b[0m notifications.json okunamadı:', e.message);
        notifications.length = 0;
    }
}

function saveNotificationsNow() {
    try {
        fs.writeFileSync(notificationsPath, JSON.stringify(notifications, null, 4));
    } catch (e) {
        console.error('\x1b[31m[BİLDİRİM HATA]\x1b[0m Kaydedilemedi:', e.message);
    }
}

function scheduleNotificationSave() {
    clearTimeout(notificationSaveTimer);
    notificationSaveTimer = setTimeout(saveNotificationsNow, 1000);
    if (notificationSaveTimer.unref) notificationSaveTimer.unref();
}

loadNotifications();

function pushNotification(level, title, message, opts = {}) {
    const { key, cooldownMs = 5 * 60 * 1000 } = opts;

    if (key) {
        const last = notificationDedupe.get(key) || 0;
        if (Date.now() - last < cooldownMs) return null;
        notificationDedupe.set(key, Date.now());

        if (notificationDedupe.size > 500) {
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            for (const [k, t] of notificationDedupe) if (t < cutoff) notificationDedupe.delete(k);
        }
    }

    const item = {
        id: ++notificationSeq,
        ts: Date.now(),
        level,
        title: String(title),
        message: String(message == null ? '' : message),
        read: false
    };
    notifications.push(item);
    while (notifications.length > NOTIFICATION_LIMIT) notifications.shift();
    scheduleNotificationSave();
    return item;
}

function unreadNotificationCount() {
    return notifications.reduce((sum, n) => sum + (n.read ? 0 : 1), 0);
}

let flushedOnExit = false;
function flushStateOnExit() {
    if (flushedOnExit) return;
    flushedOnExit = true;
    clearTimeout(notificationSaveTimer);
    saveNotificationsNow();
    try { saveVisitStats(); } catch (e) {   }
}

process.on('exit', flushStateOnExit);
process.on('SIGINT',  () => { flushStateOnExit(); process.exit(0); });
process.on('SIGTERM', () => { flushStateOnExit(); process.exit(0); });

const hotDomainDetect = config.hotDomainDetect;
const enableAccessLogs = config.enableAccessLogs; 

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

function logRequest(ip, method, host, url, sessionId) {
    const date = new Date();
    const ymd = date.toISOString().split('T')[0];
    const time = date.toISOString().split('T')[1].split('.')[0];
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
            return undefined;
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

const ERROR_HINTS = {
    ECONNREFUSED: 'Hedef port dinlemiyor. Uygulama çökmüş veya hiç başlatılmamış olabilir.',
    ECONNRESET: 'Hedef uygulama bağlantıyı yarıda kesti. Uygulama içinde crash olabilir.',
    ETIMEDOUT: 'Hedef zamanında yanıt vermedi. Uygulama kilitlenmiş veya aşırı yüklü.',
    ENOTFOUND: 'Hedef adres çözümlenemedi. vhosts.json kaydını kontrol edin.',
    EHOSTUNREACH: 'Hedef sunucuya ulaşılamıyor. Ağ/firewall kuralı engelliyor olabilir.',
    EPIPE: 'Bağlantı yazma sırasında koptu.',
    EPROTO: 'Protokol uyuşmazlığı. Hedef muhtemelen düz HTTP beklemiyor.',
    ERR_STREAM_WRITE_AFTER_END: 'Yanıt kapandıktan sonra veri yazılmaya çalışıldı.'
};

function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return `${bytes || 0} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d > 0) return `${d}g ${h}s ${m}dk`;
    if (h > 0) return `${h}s ${m}dk`;
    if (m > 0) return `${m}dk ${s}sn`;
    return `${s}sn`;
}

function truncate(value, max) {
    const str = String(value == null ? '-' : value);
    if (str.length <= max) return str;
    return str.slice(0, max - 3) + '...';
}

function getProxyWebhook() {
    const url = config.proxyWebhook || config.discordWebhook || '';
    return url.startsWith('http') ? url : '';
}

function getDdosWebhook() {
    const url = config.ddosWebhook || '';
    return url.startsWith('http') ? url : '';
}

function sendDiscordEmbed(embed, content, webhookUrl) {
    const url = webhookUrl || getProxyWebhook();
    if (!url || !url.startsWith('http')) return;

    const payload = JSON.stringify({
        username: 'dasiiproxy',
        content: content || undefined,
        embeds: [embed]
    });

    const client = url.startsWith('https') ? https : http;
    const webhookReq = client.request(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    });

    webhookReq.on('error', (e) => console.error('\x1b[31m[DISCORD WEBHOOK ERROR]\x1b[0m', e.message));
    webhookReq.write(payload);
    webhookReq.end();
}

function notifyDiscordWebhook(domain, err, req) {
    if (!getProxyWebhook()) return;

    const now = Date.now();
    const lastAlert = discordAlertCooldown.get(domain) || 0;
    const suppressed = discordAlertCooldown.get(domain + ':count') || 0;
    if (now - lastAlert < 5 * 60 * 1000) {
        discordAlertCooldown.set(domain + ':count', suppressed + 1);
        return;
    }
    discordAlertCooldown.set(domain, now);
    discordAlertCooldown.set(domain + ':count', 0);

    const errCode = (err && err.code) || 'UNKNOWN';
    const errMessage = (err && err.message) || String(err);
    const targetPort = vhosts[domain];
    const mem = process.memoryUsage();
    const clientIp = req ? getClientIp(req) : null;
    const ua = req && req.headers ? req.headers['user-agent'] : null;
    const requestLine = req ? `${req.method} ${truncate(req.url, 180)}` : '-';
    const sslState = sslContexts.has(domain) ? 'aktif' : (config.enableSSL ? 'sertifika yok' : 'kapalı');

    const fields = [
        { name: '🌐 Domain', value: `\`${domain}\``, inline: true },
        { name: '🎯 Hedef', value: targetPort ? `\`127.0.0.1:${targetPort}\`` : '`tanımsız (vhost yok)`', inline: true },
        { name: '🔐 SSL', value: `\`${sslState}\``, inline: true },

        { name: '⚠️ Hata Kodu', value: `\`${errCode}\``, inline: true },
        { name: '🕒 Zaman', value: `\`${new Date().toLocaleString('tr-TR')}\``, inline: true },
        { name: '🔁 Bastırılan', value: `\`${suppressed} hata (son 5dk)\``, inline: true },

        { name: '📝 Hata Mesajı', value: `\`\`\`${truncate(errMessage, 300)}\`\`\``, inline: false },
        { name: '💡 Olası Sebep', value: ERROR_HINTS[errCode] || 'Bilinmeyen hata. Hedef uygulamanın loglarına bakın.', inline: false },

        { name: '📨 İstek', value: `\`${requestLine}\``, inline: false },
        { name: '👤 İstemci IP', value: `\`${clientIp || '-'}\``, inline: true },
        { name: '🧭 Session', value: `\`${req && req.dpSessionId ? req.dpSessionId : '-'}\``, inline: true },
        { name: '🖥️ User-Agent', value: `\`${truncate(ua, 120)}\``, inline: false },

        { name: '📊 Toplam İstek', value: `\`${(global.totalRequests || 0).toLocaleString('tr-TR')}\``, inline: true },
        { name: '📈 Son 1dk', value: `\`${global.requestsInWindow || 0} istek\``, inline: true },
        { name: '⚡ Ort. Yanıt', value: `\`${global.completedRequests ? Math.floor(global.totalResponseTime / global.completedRequests) : 0} ms\``, inline: true },

        { name: '🗂️ Aktif Rota', value: `\`${Object.keys(vhosts).length}\``, inline: true },
        { name: '🚫 Yasaklı IP', value: `\`${blacklist.size}\``, inline: true },
        { name: '🤖 AI Blok', value: `\`${global.aiBotBlocks || 0}\``, inline: true },

        { name: '⏱️ Uptime', value: `\`${formatDuration(process.uptime())}\``, inline: true },
        { name: '🧠 Bellek (RSS)', value: `\`${formatBytes(mem.rss)}\``, inline: true },
        { name: '🛰️ Sunucu IP', value: `\`${config.serverPublicIp || 'bilinmiyor'}\``, inline: true }
    ];

    sendDiscordEmbed({
        title: `🔴 Vhost yanıt vermiyor: ${domain}`,
        url: `https://${domain}`,
        description: `**${domain}** adresine gelen istek proxy edilemedi. Hedef servis çevrimdışı olabilir.`,
        color: 0xff3b30,
        fields,
        timestamp: new Date().toISOString(),
        footer: { text: `dasiiproxy ${config.version || 'v2'} - otomatik uyarı sistemi` }
    }, '@here');
}

proxy.on('error', (err, req, res) => {
    const rawHost = req.headers.host || '';
    const host = rawHost.split(':')[0] || 'Bilinmeyen Domain';

    console.error('\x1b[31m[PROXY ERROR]\x1b[0m', err.message);
    notifyDiscordWebhook(host, err, req);
    pushNotification('critical', 'Vhost yanıt vermiyor',
        `${host} — ${(err && err.code) || 'HATA'}: ${err.message}`,
        { key: 'vhost:' + host, cooldownMs: 5 * 60 * 1000 });

    if (!res.headersSent) {
        res.writeHead(502, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
        });
    }
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

    if (rateLimit.size > 10000) rateLimit.clear();

    const record = rateLimit.get(ip);
    if (!record) {
        rateLimit.set(ip, { count: 1, time: Date.now() });
        return false;
    }
    record.count++;

    if (record.count > LIMIT * 5) {
        if (!blacklist.has(ip)) {
            blacklist.add(ip);
            saveBlacklist();
            ddosWindow.autoBans++;
            console.log('\x1b[35m[AUTO BAN]\x1b[0m Aşırı spam algılandı, IP kara listeye alındı:', ip);
            pushNotification('warning', 'IP otomatik banlandı',
                `${ip} rate limit sınırını 5 kat aştı, kara listeye alındı.`,
                { key: 'autoban', cooldownMs: 60 * 1000 });
        }
        return true;
    }

    return record.count > LIMIT;
}


const vhostsPath = jsonPath('vhosts.json');
let vhosts = {};

const blacklistPath = jsonPath('blacklist.json');
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
        if (!fs.existsSync(vhostsPath)) {
            fs.writeFileSync(vhostsPath, '{}');
        }
        const data = fs.readFileSync(vhostsPath, 'utf8');
        vhosts = JSON.parse(data);
        console.log('\x1b[36m[dasiHotProxy 2.0]\x1b[0m Domain listesi yüklendi. Aktif domain sayısı:', Object.keys(vhosts).length);
    } catch (e) {
        console.error('\x1b[31m[dasiHP ERROR]\x1b[0m vhosts.json okunamadı veya JSON hatalı:', e.message);
    }
}


loadVhosts();
loadBlacklist();


const healthStatus = new Map();
let healthTimer = null;

function probeTarget(port) {
    return new Promise(resolve => {
        const timeout = Number(config.healthCheckTimeoutMs) || 3000;
        const started = Date.now();
        let settled = false;

        const socket = new net.Socket();
        const finish = (up, error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve({ up, latencyMs: Date.now() - started, error: error || null });
        };

        socket.setTimeout(timeout);
        socket.once('connect', () => finish(true, null));
        socket.once('timeout', () => finish(false, 'ETIMEDOUT'));
        socket.once('error', err => finish(false, err.code || err.message));

        try {
            socket.connect(Number(port), '127.0.0.1');
        } catch (e) {
            finish(false, e.code || e.message);
        }
    });
}

async function runHealthChecks() {
    const entries = Object.entries(vhosts);

    const live = new Set(entries.map(e => e[0]));
    for (const domain of healthStatus.keys()) {
        if (!live.has(domain)) healthStatus.delete(domain);
    }

    await Promise.all(entries.map(async ([domain, port]) => {
        const previous = healthStatus.get(domain);

        if (String(port) === 'maintenance') {
            healthStatus.set(domain, { up: null, maintenance: true, latencyMs: null, error: null, checkedAt: Date.now(), since: previous && previous.maintenance ? previous.since : Date.now() });
            return;
        }

        const result = await probeTarget(port);
        const changed = !previous || previous.up !== result.up;

        healthStatus.set(domain, {
            up: result.up,
            maintenance: false,
            latencyMs: result.latencyMs,
            error: result.error,
            checkedAt: Date.now(),
            since: changed ? Date.now() : previous.since
        });

        if (!changed) return;

        if (!previous && result.up) return;

        if (result.up) {
            console.log('\x1b[32m[HEALTH]\x1b[0m Hedef tekrar çevrimiçi:', domain, `(127.0.0.1:${port})`);
            pushNotification('success', 'Hedef tekrar çevrimiçi',
                `${domain} → 127.0.0.1:${port} yanıt veriyor (${result.latencyMs} ms).`,
                { key: 'health:' + domain, cooldownMs: 30 * 1000 });
        } else {
            console.warn('\x1b[31m[HEALTH]\x1b[0m Hedef çevrimdışı:', domain, `(127.0.0.1:${port})`, result.error);
            pushNotification('critical', 'Hedef çevrimdışı',
                `${domain} → 127.0.0.1:${port} yanıt vermiyor (${result.error}).`,
                { key: 'health:' + domain, cooldownMs: 30 * 1000 });
        }
    }));
}

function scheduleHealthChecks() {
    clearTimeout(healthTimer);
    const seconds = Math.max(5, Number(config.healthCheckIntervalSeconds) || 15);
    healthTimer = setTimeout(async () => {
        if (config.enableHealthChecks !== false) {
            try {
                await runHealthChecks();
            } catch (e) {
                console.error('\x1b[31m[HEALTH ERROR]\x1b[0m', e.message);
            }
        }
        scheduleHealthChecks();
    }, seconds * 1000);
    healthTimer.unref && healthTimer.unref();
}

scheduleHealthChecks();


const certsDir = path.join(__dirname, 'certs');
const sslIndexPath = jsonPath('ssl.json');
let sslIndex = {};
const sslContexts = new Map();

if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true });
}

function sanitizeCertName(domain) {
    return String(domain || '')
        .trim()
        .toLowerCase()
        .replace(/^\*\./, 'wildcard_')
        .replace(/[^a-z0-9._-]/g, '_');
}

function isValidCertDomain(domain) {
    return /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/i.test(String(domain || '').trim().toLowerCase());
}

function readCertMeta(certPem) {
    try {
        const x509 = new crypto.X509Certificate(certPem);
        const validTo = new Date(x509.validTo);
        const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);
        return {
            subject: (x509.subject || '').split('\n').join(', '),
            issuer: (x509.issuer || '').split('\n').join(', '),
            altNames: x509.subjectAltName || '',
            validFrom: new Date(x509.validFrom).toISOString(),
            validTo: validTo.toISOString(),
            daysLeft,
            fingerprint: x509.fingerprint256 || ''
        };
    } catch (e) {
        return { subject: '', issuer: '', altNames: '', validFrom: null, validTo: null, daysLeft: null, fingerprint: '', parseError: e.message };
    }
}

function loadSslIndex() {
    try {
        if (!fs.existsSync(sslIndexPath)) {
            fs.writeFileSync(sslIndexPath, '{}');
        }
        sslIndex = JSON.parse(fs.readFileSync(sslIndexPath, 'utf8')) || {};
    } catch (e) {
        console.error('\x1b[31m[SSL ERROR]\x1b[0m ssl.json okunamadı:', e.message);
        sslIndex = {};
    }
}

function saveSslIndex() {
    try {
        fs.writeFileSync(sslIndexPath, JSON.stringify(sslIndex, null, 4));
    } catch (e) {
        console.error('\x1b[31m[SSL ERROR]\x1b[0m ssl.json kaydedilemedi:', e.message);
    }
}

function rebuildSslContexts() {
    sslContexts.clear();
    for (const [domain, entry] of Object.entries(sslIndex)) {
        try {
            const certPath = path.join(certsDir, entry.certFile);
            const keyPath = path.join(certsDir, entry.keyFile);
            const cert = fs.readFileSync(certPath, 'utf8');
            const key = fs.readFileSync(keyPath, 'utf8');
            const context = tls.createSecureContext({
                cert,
                key,
                minVersion: 'TLSv1.2'
            });
            sslContexts.set(domain.toLowerCase(), context);
        } catch (e) {
            console.error(`\x1b[31m[SSL ERROR]\x1b[0m ${domain} sertifikası yüklenemedi:`, e.message);
        }
    }
    if (sslContexts.size > 0) {
        console.log('\x1b[36m[SSL]\x1b[0m Sertifika sayısı:', sslContexts.size);
    }
}

function lookupSslContext(servername) {
    const host = String(servername || '').toLowerCase();
    if (!host) return null;
    if (sslContexts.has(host)) return sslContexts.get(host);

    const parts = host.split('.');
    if (parts.length > 2) {
        const wildcard = '*.' + parts.slice(1).join('.');
        if (sslContexts.has(wildcard)) return sslContexts.get(wildcard);
    }
    return null;
}

function validateCertPair(certPem, keyPem) {
    if (!/-----BEGIN CERTIFICATE-----/.test(certPem)) {
        return { ok: false, error: 'Sertifika PEM formatında değil (-----BEGIN CERTIFICATE----- bulunamadı).' };
    }
    if (!/-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(keyPem)) {
        return { ok: false, error: 'Özel anahtar PEM formatında değil (-----BEGIN PRIVATE KEY----- bulunamadı).' };
    }
    if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(keyPem)) {
        return { ok: false, error: 'Şifrelenmiş özel anahtar desteklenmiyor. Parolasız (decrypted) anahtar yükleyin.' };
    }

    try {
        const x509 = new crypto.X509Certificate(certPem);
        const privateKey = crypto.createPrivateKey(keyPem);
        if (!x509.checkPrivateKey(privateKey)) {
            return { ok: false, error: 'Özel anahtar bu sertifikaya ait değil (key/cert eşleşmiyor).' };
        }
    } catch (e) {
        return { ok: false, error: 'Sertifika veya anahtar çözümlenemedi: ' + e.message };
    }

    try {
        tls.createSecureContext({ cert: certPem, key: keyPem, minVersion: 'TLSv1.2' });
    } catch (e) {
        return { ok: false, error: 'TLS context oluşturulamadı: ' + e.message };
    }

    return { ok: true };
}

function installCertificate(domain, certPem, keyPem) {
    const normalized = String(domain).trim().toLowerCase();
    if (!isValidCertDomain(normalized)) {
        return { ok: false, error: 'Geçersiz domain. Örnek: example.com veya *.example.com' };
    }

    const validation = validateCertPair(certPem, keyPem);
    if (!validation.ok) return validation;

    const base = sanitizeCertName(normalized);
    const certFile = `${base}.crt`;
    const keyFile = `${base}.key`;

    try {
        fs.writeFileSync(path.join(certsDir, certFile), certPem, { mode: 0o644 });
        fs.writeFileSync(path.join(certsDir, keyFile), keyPem, { mode: 0o600 });
    } catch (e) {
        return { ok: false, error: 'Sertifika diske yazılamadı: ' + e.message };
    }

    const meta = readCertMeta(certPem);
    sslIndex[normalized] = {
        certFile,
        keyFile,
        uploadedAt: new Date().toISOString(),
        ...meta
    };
    saveSslIndex();
    rebuildSslContexts();
    syncHttpsServer();

    console.log('\x1b[32m[SSL]\x1b[0m Sertifika yüklendi:', normalized, '| bitiş:', meta.validTo, `(${meta.daysLeft} gün)`);
    pushNotification('success', 'Sertifika yüklendi', `${normalized} — ${meta.daysLeft} gün geçerli.`);
    return { ok: true, entry: sslIndex[normalized] };
}

function removeCertificate(domain) {
    const normalized = String(domain).trim().toLowerCase();
    const entry = sslIndex[normalized];
    if (!entry) return { ok: false, error: 'Bu domain için sertifika bulunamadı.' };

    for (const file of [entry.certFile, entry.keyFile]) {
        try {
            fs.unlinkSync(path.join(certsDir, file));
        } catch (e) {
        }
    }
    delete sslIndex[normalized];
    saveSslIndex();
    rebuildSslContexts();
    syncHttpsServer();
    console.log('\x1b[33m[SSL]\x1b[0m Sertifika silindi:', normalized);
    return { ok: true };
}

function checkCertificateExpiry() {
    const soon = [];
    for (const [domain, entry] of Object.entries(sslIndex)) {
        if (typeof entry.daysLeft !== 'number') continue;
        const validTo = entry.validTo ? new Date(entry.validTo).getTime() : 0;
        const daysLeft = Math.floor((validTo - Date.now()) / 86400000);
        entry.daysLeft = daysLeft;
        if (daysLeft <= 14) soon.push({ domain, daysLeft });
    }
    if (soon.length === 0) return;

    console.warn('\x1b[33m[SSL]\x1b[0m Süresi yaklaşan sertifikalar:', soon.map(s => `${s.domain} (${s.daysLeft}g)`).join(', '));
    soon.forEach(s => pushNotification(
        s.daysLeft < 0 ? 'critical' : 'warning',
        s.daysLeft < 0 ? 'Sertifika süresi doldu' : 'Sertifika süresi doluyor',
        s.daysLeft < 0 ? `${s.domain} sertifikasının süresi doldu.` : `${s.domain} için ${s.daysLeft} gün kaldı.`,
        { key: 'cert:' + s.domain, cooldownMs: 24 * 60 * 60 * 1000 }
    ));
    sendDiscordEmbed({
        title: '🔐 SSL sertifikaları yenilenmeli',
        color: 0xfbbf24,
        description: soon.map(s => `• \`${s.domain}\` — **${s.daysLeft} gün** kaldı`).join('\n'),
        timestamp: new Date().toISOString(),
        footer: { text: `dasiiproxy ${config.version || 'v2'} - sertifika takibi` }
    });
}

loadSslIndex();
rebuildSslContexts();
setInterval(checkCertificateExpiry, 24 * 60 * 60 * 1000);


const TRAFFIC_BUCKET_MS = 60 * 1000;
const TRAFFIC_MAX_BUCKETS = 60;
const trafficHistory = [];
let trafficBucket = { requests: 0, blocked: 0, aiBlocked: 0, proxied: 0, responseMs: 0, completed: 0 };

function resetTrafficBucket() {
    trafficBucket = { requests: 0, blocked: 0, aiBlocked: 0, proxied: 0, responseMs: 0, completed: 0 };
}

function trafficSnapshot(startedAt) {
    return {
        t: startedAt,
        requests: trafficBucket.requests,
        blocked: trafficBucket.blocked,
        aiBlocked: trafficBucket.aiBlocked,
        proxied: trafficBucket.proxied,
        avgMs: trafficBucket.completed ? Math.round(trafficBucket.responseMs / trafficBucket.completed) : 0
    };
}

let trafficBucketStart = Date.now();

setInterval(() => {
    trafficHistory.push(trafficSnapshot(trafficBucketStart));
    while (trafficHistory.length > TRAFFIC_MAX_BUCKETS) trafficHistory.shift();

    const threshold = Number(config.highTrafficThresholdRequestsPerWindow) || 1000;
    global.isHighTraffic = trafficBucket.requests >= threshold;

    resetTrafficBucket();
    trafficBucketStart = Date.now();
    global.requestsInWindow = 0;
}, TRAFFIC_BUCKET_MS);

const DDOS_WINDOW_MS = 10 * 1000;
const DDOS_QUIET_WINDOWS = 6;

function newCounterSet() {
    return { blocked: 0, autoBans: 0, ips: new Map(), hosts: new Map(), countries: new Map(), uas: new Map(), paths: new Map() };
}

function bump(map, key, amount) {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + (amount || 1));
}

function mergeCounters(target, source) {
    target.blocked += source.blocked;
    target.autoBans += source.autoBans;
    for (const field of ['ips', 'hosts', 'countries', 'uas', 'paths']) {
        for (const [key, value] of source[field]) bump(target[field], key, value);
    }
}

function topEntries(map, limit) {
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function formatTop(map, limit, emptyText) {
    const rows = topEntries(map, limit);
    if (rows.length === 0) return emptyText || '`-`';
    return rows.map(([key, count]) => `\`${truncate(key, 60)}\` — **${count.toLocaleString('tr-TR')}**`).join('\n');
}

function cloudflareColo(req) {
    const ray = req.headers['cf-ray'];
    if (!ray || ray.indexOf('-') === -1) return null;
    return ray.split('-').pop().toUpperCase();
}

let ddosWindow = newCounterSet();
const ddosState = {
    active: false,
    startedAt: 0,
    lastNotifyAt: 0,
    quietWindows: 0,
    peakPerWindow: 0,
    totals: newCounterSet()
};

function recordAttackHit(ip, req) {
    ddosWindow.blocked++;
    bump(ddosWindow.ips, ip);
    if (req) {
        const rawHost = req.headers.host || '';
        bump(ddosWindow.hosts, rawHost.split(':')[0] || 'bilinmiyor');
        bump(ddosWindow.countries, (req.headers['cf-ipcountry'] || 'XX').toUpperCase());
        bump(ddosWindow.uas, truncate(req.headers['user-agent'] || 'yok', 60));
        bump(ddosWindow.paths, truncate(String(req.url || '/').split('?')[0], 60));
        const colo = cloudflareColo(req);
        if (colo) bump(ddosWindow.countries, 'CF:' + colo);
    }
}

function buildDdosEmbed(title, color, description) {
    const totals = ddosState.totals;
    const durationSec = Math.max(1, Math.floor((Date.now() - ddosState.startedAt) / 1000));
    const avgRps = Math.round(totals.blocked / durationSec);
    const peakRps = Math.round(ddosState.peakPerWindow / (DDOS_WINDOW_MS / 1000));

    const countries = new Map();
    const colos = new Map();
    for (const [key, value] of totals.countries) {
        if (key.startsWith('CF:')) colos.set(key.slice(3), value);
        else countries.set(key, value);
    }

    return {
        title,
        color,
        description,
        fields: [
            { name: 'Başlangıç', value: `\`${new Date(ddosState.startedAt).toLocaleString('tr-TR')}\``, inline: true },
            { name: 'Süre', value: `\`${formatDuration(durationSec)}\``, inline: true },
            { name: 'Durum', value: ddosState.active ? '`devam ediyor`' : '`sona erdi`', inline: true },

            { name: 'Engellenen İstek', value: `\`${totals.blocked.toLocaleString('tr-TR')}\``, inline: true },
            { name: 'Zirve', value: `\`~${peakRps.toLocaleString('tr-TR')} istek/sn\``, inline: true },
            { name: 'Ortalama', value: `\`~${avgRps.toLocaleString('tr-TR')} istek/sn\``, inline: true },

            { name: 'Saldırgan IP', value: `\`${totals.ips.size.toLocaleString('tr-TR')} farklı adres\``, inline: true },
            { name: 'Otomatik Ban', value: `\`${totals.autoBans.toLocaleString('tr-TR')}\``, inline: true },
            { name: 'Toplam Blacklist', value: `\`${blacklist.size.toLocaleString('tr-TR')}\``, inline: true },

            { name: 'En Çok İstek Atan IP\'ler', value: formatTop(totals.ips, 8), inline: false },
            { name: 'Ülkeler (cf-ipcountry)', value: formatTop(countries, 6, '`cloudflare ülke bilgisi yok`'), inline: true },
            { name: 'Cloudflare Lokasyonu', value: formatTop(colos, 6, '`bilinmiyor`'), inline: true },

            { name: 'Hedeflenen Domainler', value: formatTop(totals.hosts, 5), inline: false },
            { name: 'Hedeflenen Yollar', value: formatTop(totals.paths, 5), inline: false },
            { name: 'User-Agent Dağılımı', value: formatTop(totals.uas, 4), inline: false },

            { name: 'Sunucu Toplam İstek', value: `\`${(global.totalRequests || 0).toLocaleString('tr-TR')}\``, inline: true },
            { name: 'Ort. Yanıt', value: `\`${global.completedRequests ? Math.floor(global.totalResponseTime / global.completedRequests) : 0} ms\``, inline: true },
            { name: 'Bellek (RSS)', value: `\`${formatBytes(process.memoryUsage().rss)}\``, inline: true }
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `dasiiproxy ${config.version || 'v2'} - ddos izleme` }
    };
}

function notifyDdos(kind) {
    const webhook = getDdosWebhook();
    if (!webhook) return;

    if (kind === 'start') {
        sendDiscordEmbed(
            buildDdosEmbed('DDoS saldırısı algılandı', 0xff3b30, 'Rate limit eşiği aşıldı. Saldırı trafiği engelleniyor.'),
            '@here',
            webhook
        );
    } else if (kind === 'update') {
        sendDiscordEmbed(
            buildDdosEmbed('DDoS saldırısı sürüyor', 0xfbbf24, 'Saldırı devam ediyor. Güncel durum aşağıda.'),
            null,
            webhook
        );
    } else if (kind === 'end') {
        sendDiscordEmbed(
            buildDdosEmbed('DDoS saldırısı sona erdi', 0x34d399, 'Trafik normale döndü. Saldırının özeti aşağıda.'),
            null,
            webhook
        );
    }
    ddosState.lastNotifyAt = Date.now();
}

setInterval(() => {
    const threshold = Number(config.ddosDetectThreshold) || 100;
    const minAttackers = Number(config.ddosMinAttackerIps) || 1;
    const cooldownMs = (Number(config.ddosAlertCooldownMinutes) || 5) * 60 * 1000;

    const isAttackWindow = ddosWindow.blocked >= threshold && ddosWindow.ips.size >= minAttackers;

    if (isAttackWindow) {
        if (!ddosState.active) {
            ddosState.active = true;
            ddosState.startedAt = Date.now();
            ddosState.peakPerWindow = 0;
            ddosState.totals = newCounterSet();
            mergeCounters(ddosState.totals, ddosWindow);
            ddosState.peakPerWindow = ddosWindow.blocked;
            ddosState.quietWindows = 0;
            console.warn('\x1b[41m\x1b[37m[DDOS]\x1b[0m Saldırı algılandı. Pencere başına engellenen:', ddosWindow.blocked, '| Farklı IP:', ddosWindow.ips.size);
            pushNotification('critical', 'DDoS saldırısı algılandı',
                `10 saniyede ${ddosWindow.blocked} istek engellendi, ${ddosWindow.ips.size} farklı IP.`,
                { key: 'ddos:start', cooldownMs: 60 * 1000 });
            notifyDdos('start');
        } else {
            mergeCounters(ddosState.totals, ddosWindow);
            if (ddosWindow.blocked > ddosState.peakPerWindow) ddosState.peakPerWindow = ddosWindow.blocked;
            ddosState.quietWindows = 0;
            if (Date.now() - ddosState.lastNotifyAt >= cooldownMs) notifyDdos('update');
        }
    } else if (ddosState.active) {
        mergeCounters(ddosState.totals, ddosWindow);
        ddosState.quietWindows++;
        if (ddosState.quietWindows >= DDOS_QUIET_WINDOWS) {
            ddosState.active = false;
            console.log('\x1b[32m[DDOS]\x1b[0m Saldırı sona erdi. Toplam engellenen:', ddosState.totals.blocked);
            pushNotification('success', 'DDoS saldırısı sona erdi',
                `Toplam ${ddosState.totals.blocked} istek engellendi, ${ddosState.totals.ips.size} farklı IP.`,
                { key: 'ddos:end', cooldownMs: 60 * 1000 });
            notifyDdos('end');
        }
    }

    ddosWindow = newCounterSet();
}, DDOS_WINDOW_MS);


const statsPath = jsonPath('visit_stats.json');
const priorityPath = jsonPath('priority_sites.json');
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
        const entries = Object.entries(visitStats);
        if (entries.length === 0) {
            return false;
        }
        const topCount = Number(config.priorityTopCount) || 10;
        entries.sort((a, b) => b[1] - a[1]);
        const top = entries.slice(0, topCount).map(e => e[0]);
        topSites = new Set(top);
        saveTopSites();
        visitStats = {};
        saveVisitStats();
        console.log('\x1b[36m[PRIORITY]\x1b[0m Öncelik listesi güncellendi. En çok ziyaret edilenler:', top);
        return true;
    } catch (e) {
        console.error('\x1b[31m[PRIORITY ERROR]\x1b[0m', e.message);
        return false;
    }
}

loadVisitStats();
loadTopSites();

const PRIORITY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const priorityStatePath = jsonPath('priority_state.json');
let lastPriorityEvalAt = 0;

function loadPriorityState() {
    try {
        if (fs.existsSync(priorityStatePath)) {
            const state = JSON.parse(fs.readFileSync(priorityStatePath, 'utf8')) || {};
            lastPriorityEvalAt = Number(state.lastEvaluatedAt) || 0;
        }
    } catch (e) {
        lastPriorityEvalAt = 0;
    }
    if (!lastPriorityEvalAt) {
        lastPriorityEvalAt = Date.now();
        savePriorityState();
    }
}

function savePriorityState() {
    try {
        fs.writeFileSync(priorityStatePath, JSON.stringify({ lastEvaluatedAt: lastPriorityEvalAt }, null, 4));
    } catch (e) {
        console.error('\x1b[31m[PRIORITY ERROR]\x1b[0m priority_state.json kaydedilemedi:', e.message);
    }
}

loadPriorityState();

setInterval(() => {
    if (!config.enablePriorityByTraffic) return;
    const intervalDays = Math.max(1, Number(config.priorityEvaluateIntervalDays) || 30);
    if (Date.now() - lastPriorityEvalAt < intervalDays * 24 * 60 * 60 * 1000) return;

    evaluatePriorities();
    lastPriorityEvalAt = Date.now();
    savePriorityState();
}, PRIORITY_CHECK_INTERVAL_MS);

setInterval(saveVisitStats, 60 * 1000);

function watchFileDebounced(filePath, label, handler, delay = 150) {
    let timer = null;
    try {
        fs.watch(filePath, (eventType) => {
            if (eventType !== 'change') return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                try {
                    handler();
                } catch (e) {
                    console.error(`\x1b[31m[WATCH ERROR]\x1b[0m ${label}:`, e.message);
                }
            }, delay);
        });
    } catch (e) {
        console.error(`\x1b[31m[WATCH ERROR]\x1b[0m ${label} izlenemiyor:`, e.message);
    }
}

if (hotDomainDetect) {
    watchFileDebounced(vhostsPath, 'vhosts.json', () => {
        console.log('\x1b[33m[dasiHotProxy 2.0]\x1b[0m vhosts.json değişikliği algılandı, güncelleniyor...');
        loadVhosts();
    });

    watchFileDebounced(blacklistPath, 'blacklist.json', loadBlacklist);

    watchFileDebounced(configPath, 'config.json', () => {
        delete require.cache[require.resolve('./config.json')];
        config = require('./config.json');
        if (!Array.isArray(config.ipWhitelist)) config.ipWhitelist = [];
        if (typeof config.maintenanceMode !== 'boolean') config.maintenanceMode = false;
        loadWhitelist();
        syncHttpsServer();
        console.log('\x1b[33m[CONFIG]\x1b[0m config.json değişikliği yüklendi.');
    });
}



const dpSessionsPath = jsonPath('dpsessions.json');
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
        saveDpSessions();
        return sessionId;
    }
}

global.totalRequests = 0;
global.aiBotBlocks = 0;
global.totalResponseTime = 0;
global.completedRequests = 0;

function handleProxyRequest(req, res) {

    global.totalRequests++;
    trafficBucket.requests++;
    const reqStartTime = Date.now();
    res.on('finish', () => {
        const elapsed = Date.now() - reqStartTime;
        global.completedRequests++;
        global.totalResponseTime += elapsed;
        trafficBucket.completed++;
        trafficBucket.responseMs += elapsed;
        if (res.statusCode === 403 || res.statusCode === 429) trafficBucket.blocked++;
    });

    const rawHost = req.headers.host || '';
    const host = rawHost.split(':')[0];
    const targetPort = vhosts[host];

    const realIP = getClientIp(req);

    const dpSessionId = getDpSession(realIP, req);
    req.dpSessionId = dpSessionId;
    try {
        recordVisit(host);
    } catch (e) {}

    if (typeof global.requestsInWindow === 'undefined') global.requestsInWindow = 0;
    global.requestsInWindow++;

    if (config.enableSSL && config.forceHttps && !req.socket.encrypted && lookupSslContext(host)) {
        res.writeHead(301, { 'Location': `https://${rawHost}${req.url}` });
        return res.end();
    }


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
        recordAttackHit(realIP, req);
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[403]);
    }

    
    if (!req.headers['cf-ray']) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[403]);
    }

    if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[403]);
    }

    try {
        const urlDecoded = decodeURIComponent(req.url).toLowerCase();
        const wafPatterns = /(\.\.\/|\.env|union\s+select|<script>|javascript:|base64_decode|etc\/passwd)/i;
        if (wafPatterns.test(urlDecoded)) {
            console.warn('\x1b[41m\x1b[37m[WAF BLOCKED]\x1b[0m', realIP, req.url);
            res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(errorPages[403]);
        }
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[400]);
    }

    const rateLimited = isRateLimited(realIP);
    if (rateLimited) {
        const highTraffic = Boolean(global.isHighTraffic);
        const priorityEnabled = Boolean(config.enablePriorityByTraffic);
        const hostIsTop = topSites.has(host);
        if (!(priorityEnabled && highTraffic && hostIsTop)) {
            console.warn('\x1b[33m[RATE LIMIT]\x1b[0m', realIP);
            recordAttackHit(realIP, req);
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

    const ua = req.headers['user-agent'];
    if (!ua || ua.length < 5) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[403]);
    }

    if (config.blockAIBots) {
        const aiPattern = /(claude|searchbot|gptbot|chatgpt|anthropic|bytespider|diffbot|applebot|amazonbot|perplexity|meta-externalfetcher|meta-externalagent|oai-searchbot|bingbot|googlebot|google-cloudvertexbot|googleother|duckassistbot|petalbot|tiktokspider|ccbot)/i;
        if (aiPattern.test(ua)) {
            global.aiBotBlocks++;
            trafficBucket.aiBlocked++;
            console.warn('\x1b[33m[AI BOT BLOCKED]\x1b[0m İstek reddedildi:', realIP, ua);
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end("Bu sitede dasiiproxy ile AI erişimi engellenmiş, dasiiproxy'i sende denemek istiyorsan proxy.dasii.live adresini ziyaret et!");
        }
    }

    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=()');


    if (targetPort === 'maintenance') {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(errorPages[503]);
    } else if (targetPort) {
        trafficBucket.proxied++;
        proxy.web(req, res, { target: `http://127.0.0.1:${targetPort}` });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorPages[404]);
    }
}

function handleProxyUpgrade(req, socket, head) {
    const realIP = getClientIp(req);

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
        socket.destroy();
    }
}

const server = http.createServer(handleProxyRequest);
server.keepAliveTimeout = 75000;
server.headersTimeout = 80000;
server.on('upgrade', handleProxyUpgrade);

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


let httpsServer = null;

function startHttpsServer() {
    if (httpsServer) return { ok: true, alreadyRunning: true };
    if (!config.enableSSL) return { ok: false, error: 'SSL kapalı (config.enableSSL=false).' };
    if (sslContexts.size === 0) return { ok: false, error: 'Yüklü sertifika yok. Önce sertifika yükleyin.' };

    const httpsPort = Number(config.httpsPort) || 443;

    httpsServer = https.createServer({
        SNICallback: (servername, cb) => {
            const context = lookupSslContext(servername);
            if (context) return cb(null, context);
            cb(null, sslContexts.values().next().value);
        },
        minVersion: 'TLSv1.2',
        honorCipherOrder: true
    }, handleProxyRequest);

    httpsServer.keepAliveTimeout = 75000;
    httpsServer.headersTimeout = 80000;
    httpsServer.on('upgrade', handleProxyUpgrade);
    httpsServer.on('tlsClientError', (err) => {
        if (err && err.code !== 'ECONNRESET') {
            console.warn('\x1b[33m[TLS]\x1b[0m İstemci el sıkışma hatası:', err.message);
        }
    });
    httpsServer.on('error', (err) => {
        console.error('\x1b[31m[HTTPS ERROR]\x1b[0m', err.message);
        pushNotification('critical', 'HTTPS sunucusu başlatılamadı',
            `${err.code || 'HATA'}: ${err.message}`, { key: 'https:error', cooldownMs: 60 * 1000 });
        httpsServer = null;
    });

    httpsServer.listen(httpsPort, '0.0.0.0', () => {
        console.log('\x1b[32m[HTTPS]\x1b[0m TLS sunucusu dinlemede. Port:', httpsPort, '| Sertifika:', sslContexts.size);
        pushNotification('success', 'HTTPS sunucusu başlatıldı',
            `Port ${httpsPort}, ${sslContexts.size} sertifika yüklü.`, { key: 'https:up', cooldownMs: 30 * 1000 });
    });

    return { ok: true };
}

function stopHttpsServer() {
    if (!httpsServer) return;
    httpsServer.close();
    httpsServer = null;
    console.log('\x1b[33m[HTTPS]\x1b[0m TLS sunucusu durduruldu.');
}

function syncHttpsServer() {
    if (config.enableSSL && sslContexts.size > 0) {
        if (!httpsServer) startHttpsServer();
    } else if (httpsServer) {
        stopHttpsServer();
    }
}

syncHttpsServer();

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
    return record.count > 5;
}

const os = require('os');
const dashboardServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, authorization');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const realIP = getClientIp(req);

    function parseBody(callback) {
        let body = '';
        let aborted = false;
        const MAX_BODY = 512 * 1024;
        req.on('data', chunk => {
            if (aborted) return;
            body += chunk;
            if (body.length > MAX_BODY) {
                aborted = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Payload too large' }));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (aborted) return;
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
            whitelistCount: whitelist.size,
            sslEnabled: Boolean(config.enableSSL),
            sslCertCount: sslContexts.size,
            httpsRunning: Boolean(httpsServer),
            httpsPort: Number(config.httpsPort) || 443,
            highTraffic: Boolean(global.isHighTraffic),
            requestsLastMinute: trafficBucket.requests,
            ddosActive: ddosState.active,
            ddosStartedAt: ddosState.active ? ddosState.startedAt : null,
            ddosBlocked: ddosState.active ? ddosState.totals.blocked : 0,
            ddosAttackerIps: ddosState.active ? ddosState.totals.ips.size : 0,
            proxyWebhookSet: Boolean(getProxyWebhook()),
            ddosWebhookSet: Boolean(getDdosWebhook())
        }));
    } else if (req.url === '/api/health' && req.method === 'GET') {
        const items = {};
        for (const [domain, state] of healthStatus) items[domain] = state;
        res.writeHead(200);
        return res.end(JSON.stringify({
            enabled: config.enableHealthChecks !== false,
            intervalSeconds: Math.max(5, Number(config.healthCheckIntervalSeconds) || 15),
            items
        }));
    } else if (req.url === '/api/logs/stats' && req.method === 'GET') {
        let files = 0, bytes = 0, oldest = null, newest = null;
        try {
            for (const name of fs.readdirSync(logsDir)) {
                if (!/^access-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
                const stat = fs.statSync(path.join(logsDir, name));
                files++;
                bytes += stat.size;
                const day = name.slice(7, 17);
                if (!oldest || day < oldest) oldest = day;
                if (!newest || day > newest) newest = day;
            }
        } catch (e) {   }

        res.writeHead(200);
        return res.end(JSON.stringify({ files, bytes, oldest, newest, systemLogs: recentLogs.length }));
    } else if (req.url === '/api/logs/clear' && req.method === 'POST') {
        parseBody(data => {
            const olderThanDays = Number(data && data.olderThanDays) || 0;
            const cutoff = olderThanDays > 0
                ? new Date(Date.now() - olderThanDays * 86400000).toISOString().split('T')[0]
                : null;

            let removed = 0, freed = 0;
            const errors = [];
            try {
                for (const name of fs.readdirSync(logsDir)) {
                    if (!/^access-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
                    if (cutoff && name.slice(7, 17) >= cutoff) continue;
                    const filePath = path.join(logsDir, name);
                    try {
                        freed += fs.statSync(filePath).size;
                        fs.unlinkSync(filePath);
                        removed++;
                    } catch (e) {
                        errors.push(`${name}: ${e.message}`);
                    }
                }
            } catch (e) {
                errors.push(e.message);
            }

            let systemCleared = 0;
            if (!cutoff) {
                systemCleared = recentLogs.length;
                recentLogs.length = 0;
            }

            console.log('\x1b[33m[LOGS]\x1b[0m Log temizliği:', removed, 'dosya silindi,', freed, 'bayt boşaltıldı.');
            pushNotification('info', 'Loglar temizlendi',
                `${removed} erişim log dosyası silindi, ${systemCleared} sistem kaydı kaldırıldı.`, { cooldownMs: 0 });

            res.writeHead(200);
            res.end(JSON.stringify({ success: true, removed, freed, systemCleared, errors }));
        });
    } else if (req.url === '/api/notifications' && req.method === 'GET') {
        res.writeHead(200);
        return res.end(JSON.stringify({
            items: notifications.slice().reverse(),
            unread: unreadNotificationCount()
        }));
    } else if (req.url === '/api/notifications/read' && req.method === 'POST') {
        notifications.forEach(n => { n.read = true; });
        saveNotificationsNow();
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, unread: 0 }));
    } else if (req.url === '/api/notifications/clear' && req.method === 'POST') {
        notifications.length = 0;
        saveNotificationsNow();
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, unread: 0 }));
    } else if (req.url === '/api/traffic' && req.method === 'GET') {
        const buckets = trafficHistory.concat([trafficSnapshot(trafficBucketStart)]);
        res.writeHead(200);
        return res.end(JSON.stringify({
            bucketMs: TRAFFIC_BUCKET_MS,
            maxBuckets: TRAFFIC_MAX_BUCKETS,
            buckets,
            topSites: Object.entries(visitStats)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([domain, hits]) => ({ domain, hits }))
        }));
    } else if (req.url === '/api/ssl' && req.method === 'GET') {
        const items = Object.entries(sslIndex).map(([domain, entry]) => {
            const validTo = entry.validTo ? new Date(entry.validTo).getTime() : null;
            return {
                domain,
                subject: entry.subject || '',
                issuer: entry.issuer || '',
                altNames: entry.altNames || '',
                validFrom: entry.validFrom,
                validTo: entry.validTo,
                daysLeft: validTo ? Math.floor((validTo - Date.now()) / 86400000) : null,
                fingerprint: entry.fingerprint || '',
                uploadedAt: entry.uploadedAt,
                active: sslContexts.has(domain.toLowerCase())
            };
        });
        res.writeHead(200);
        return res.end(JSON.stringify({
            enabled: Boolean(config.enableSSL),
            forceHttps: Boolean(config.forceHttps),
            httpsPort: Number(config.httpsPort) || 443,
            running: Boolean(httpsServer),
            items
        }));
    } else if (req.url === '/api/ssl/upload' && req.method === 'POST') {
        parseBody(data => {
            const domain = String(data.domain || '').trim();
            const cert = String(data.cert || '').trim();
            const key = String(data.key || '').trim();

            if (!domain || !cert || !key) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: 'domain, cert ve key alanları zorunludur.' }));
            }

            const result = installCertificate(domain, cert + '\n', key + '\n');
            if (!result.ok) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: result.error }));
            }
            res.writeHead(200);
            return res.end(JSON.stringify({ success: true, entry: result.entry, running: Boolean(httpsServer) }));
        });
    } else if (req.url === '/api/ssl/delete' && req.method === 'POST') {
        parseBody(data => {
            if (!data.domain) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: 'domain zorunludur.' }));
            }
            const result = removeCertificate(data.domain);
            if (!result.ok) {
                res.writeHead(404);
                return res.end(JSON.stringify({ error: result.error }));
            }
            res.writeHead(200);
            return res.end(JSON.stringify({ success: true }));
        });
    } else if (req.url === '/api/config' && req.method === 'GET') {
        res.writeHead(200);
        return res.end(JSON.stringify(config));
    } else if (req.url === '/api/config' && req.method === 'POST') {
        parseBody(data => {
            const wasMaintenance = Boolean(config.maintenanceMode);
            const wasBlockAIBots = Boolean(config.blockAIBots);

            for (const key in data) {
                config[key] = data[key];
            }
            if (!Array.isArray(config.ipWhitelist)) config.ipWhitelist = [];
            if (typeof config.maintenanceMode !== 'boolean') config.maintenanceMode = false;
            loadWhitelist();
            persistConfig();

            if ('maintenanceMode' in data && data.maintenanceMode !== wasMaintenance) {
                pushNotification(
                    data.maintenanceMode ? 'warning' : 'success',
                    data.maintenanceMode ? 'Bakım modu açıldı' : 'Bakım modu kapatıldı',
                    data.maintenanceMode
                        ? 'Yalnızca beyaz listedeki IP\'ler erişebilir.'
                        : 'Site normal trafiğe açıldı.',
                    { cooldownMs: 0 }
                );
            }
            if ('blockAIBots' in data && data.blockAIBots !== wasBlockAIBots) {
                pushNotification('info',
                    data.blockAIBots ? 'AI bot filtresi açıldı' : 'AI bot filtresi kapatıldı',
                    data.blockAIBots ? 'AI tarayıcıları reddedilecek.' : 'AI tarayıcıları artık engellenmiyor.',
                    { cooldownMs: 0 });
            }

            if ('enableSSL' in data || 'httpsPort' in data) {
                if ('httpsPort' in data) stopHttpsServer();
                syncHttpsServer();
            }
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
                pushNotification('info', 'Rota eklendi', `${data.domain} → 127.0.0.1:${data.port}`, { cooldownMs: 0 });
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, vhosts }));
                
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
                                pushNotification('warning', 'Cloudflare DNS kaydı oluşturulamadı',
                                    `${data.domain} — HTTP ${cfRes.statusCode}`, { key: 'cf:' + data.domain });
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
                pushNotification('info', 'Rota silindi', String(data.domain), { cooldownMs: 0 });
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
    } else if (req.url.startsWith('/api/access-logs') && req.method === 'GET') {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const limit = Math.min(2000, Math.max(1, parseInt(urlObj.searchParams.get('limit'), 10) || 300));

        const ymd = new Date().toISOString().split('T')[0];
        const logFile = path.join(logsDir, `access-${ymd}.log`);
        fs.readFile(logFile, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(200);
                return res.end(JSON.stringify([]));
            }
            const lines = data.split('\n').filter(l => l.trim() !== '');
            res.writeHead(200);
            res.end(JSON.stringify(lines.slice(-limit)));
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
                .slice(-50);
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
                saveBlacklist();
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
        res.writeHead(302, { 'Location': '/' });
        return res.end();
    } else {
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