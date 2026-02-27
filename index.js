const express = require('express');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ============================================================
// CONFIGURATION (from environment variables)
// ============================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,

    // Your Wolt merchant menu page URL
    WOLT_MENU_URL: process.env.WOLT_MENU_URL || 'https://merchant.wolt.com',

    // Your Wolt login email
    WOLT_EMAIL: process.env.WOLT_EMAIL || '',

    // Google Apps Script Web App URL
    APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL || '',

    // Green API for WhatsApp alerts (optional)
    GREEN_API_INSTANCE: process.env.GREEN_API_INSTANCE || '',
    GREEN_API_TOKEN: process.env.GREEN_API_TOKEN || '',
    WHATSAPP_CHAT_ID: process.env.WHATSAPP_CHAT_ID || '',

    // Scrape interval (ms) - how often to read the page
    SCRAPE_INTERVAL: parseInt(process.env.SCRAPE_INTERVAL) || 20000,

    // Sheet send interval (ms) - minimum time between sends if no changes
    SHEET_SEND_INTERVAL: parseInt(process.env.SHEET_SEND_INTERVAL) || 300000,

    // Cookie file path (persistent storage)
    COOKIE_PATH: process.env.COOKIE_PATH || path.join(__dirname, 'data', 'cookies.json'),

    // Simple auth password for the web UI
    UI_PASSWORD: process.env.UI_PASSWORD || 'wolt2024',
};

// ============================================================
// STATE
// ============================================================
let browser = null;
let page = null;
let isLoggedIn = false;
let lastScrapeTime = null;
let lastSendTime = null;
let lastSentHash = '';
let lastSheetSendTimestamp = 0;
let lastItems = [];
let scrapeErrors = 0;
let totalScrapes = 0;
let loginAlertSent = false;
let scrapeInterval = null;

// ============================================================
// CONTACTS MANAGEMENT (persistent, switchable from UI)
// ============================================================
const CONTACTS_PATH = path.join(path.dirname(CONFIG.COOKIE_PATH), 'contacts.json');

// Default contacts - customize these
const DEFAULT_CONTACTS = [
    { id: 'mateo', name: 'Mateo', chatId: CONFIG.WHATSAPP_CHAT_ID || '', active: true },
];

function loadContacts() {
    try {
        if (fs.existsSync(CONTACTS_PATH)) {
            return JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf-8'));
        }
    } catch (err) {
        console.error('[Contacts] Error loading:', err.message);
    }
    // Initialize with defaults
    saveContacts(DEFAULT_CONTACTS);
    return DEFAULT_CONTACTS;
}

function saveContacts(contacts) {
    const dir = path.dirname(CONTACTS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONTACTS_PATH, JSON.stringify(contacts, null, 2));
}

function getActiveContacts() {
    return loadContacts().filter(c => c.active && c.chatId);
}

// ============================================================
// COOKIE MANAGEMENT
// ============================================================
function saveCookies(cookies) {
    const dir = path.dirname(CONFIG.COOKIE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG.COOKIE_PATH, JSON.stringify(cookies, null, 2));
    console.log(`[Cookies] Saved ${cookies.length} cookies to disk`);
}

function loadCookies() {
    try {
        if (fs.existsSync(CONFIG.COOKIE_PATH)) {
            const cookies = JSON.parse(fs.readFileSync(CONFIG.COOKIE_PATH, 'utf-8'));
            console.log(`[Cookies] Loaded ${cookies.length} cookies from disk`);
            return cookies;
        }
    } catch (err) {
        console.error('[Cookies] Error loading cookies:', err.message);
    }
    return null;
}

// ============================================================
// WHATSAPP ALERT
// ============================================================
function sendWhatsAppAlert(message) {
    if (!CONFIG.GREEN_API_INSTANCE || !CONFIG.GREEN_API_TOKEN) {
        console.log('[WhatsApp] Alert skipped (not configured):', message);
        return;
    }

    const activeContacts = getActiveContacts();
    if (activeContacts.length === 0) {
        console.log('[WhatsApp] No active contacts, skipping alert');
        return;
    }

    activeContacts.forEach(contact => {
        const url = `https://api.green-api.com/waInstance${CONFIG.GREEN_API_INSTANCE}/sendMessage/${CONFIG.GREEN_API_TOKEN}`;
        const payload = JSON.stringify({
            chatId: contact.chatId,
            message: message,
        });

        const urlObj = new URL(url);
        const req = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => console.log(`[WhatsApp] Alert sent to ${contact.name}:`, data));
        });
        req.on('error', err => console.error(`[WhatsApp] Alert error (${contact.name}):`, err.message));
        req.write(payload);
        req.end();
    });
}

// ============================================================
// SEND TO GOOGLE APPS SCRIPT
// ============================================================
function sendToAppsScript(items) {
    if (!CONFIG.APPS_SCRIPT_URL) {
        console.log('[Sheet] Skipped (not configured)');
        return;
    }

    const hash = JSON.stringify(items.map(i => `${i.type}:${i.name}`).sort());
    const now = Date.now();

    if (hash === lastSentHash && (now - lastSheetSendTimestamp) < CONFIG.SHEET_SEND_INTERVAL) {
        return; // No changes and not enough time passed
    }

    lastSentHash = hash;
    lastSheetSendTimestamp = now;
    lastSendTime = new Date().toISOString();

    const payload = JSON.stringify({
        action: 'update_disabled',
        timestamp: new Date().toISOString(),
        items: items,
    });

    const urlObj = new URL(CONFIG.APPS_SCRIPT_URL);
    const client = urlObj.protocol === 'https:' ? https : http;

    const req = client.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => console.log(`[Sheet] Sent ${items.length} items, response: ${res.statusCode}`));
    });
    req.on('error', err => console.error('[Sheet] Send error:', err.message));
    req.write(payload);
    req.end();
}

// ============================================================
// BROWSER MANAGEMENT
// ============================================================
async function launchBrowser() {
    console.log('[Browser] Launching (low-memory mode)...');
    browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--no-first-run',
            '--single-process',
            '--no-zygote',
            '--disable-breakpad',
            '--disable-component-update',
            '--disable-domain-reliability',
            '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
            '--disable-hang-monitor',
            '--disable-ipc-flooding-protection',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-renderer-backgrounding',
            '--disable-site-isolation-trials',
            '--disable-speech-api',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--js-flags=--max-old-space-size=128',
        ],
    });
    console.log('[Browser] Launched successfully');
}

async function setupPage() {
    if (!browser) await launchBrowser();
    page = await browser.newPage();

    // Aggressive memory saving: block images, fonts, media, stylesheets
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        if (['image', 'font', 'media'].includes(type)) {
            req.abort();
        } else {
            req.continue();
        }
    });

    // Set viewport small to save memory
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Load cookies if available
    const cookies = loadCookies();
    if (cookies) {
        await page.setCookie(...cookies);
        console.log('[Browser] Restored saved cookies');
    }

    return page;
}

// ============================================================
// SCRAPING LOGIC (mirrors Tampermonkey script)
// ============================================================
async function scrapeDisabledItems() {
    return await page.evaluate(() => {
        const items = [];
        let currentCategory = 'Uncategorized';

        const rows = document.querySelectorAll('[class*="gQlFER"]');

        rows.forEach(row => {
            // Category header
            const categoryEl = row.querySelector('[class*="itoaO"]');
            if (categoryEl) {
                currentCategory = categoryEl.textContent.trim();
                return;
            }

            // Get tags
            const tagEls = row.querySelectorAll('[class*="al-Tag-lbl-d84"]');
            let hasDisabledTag = false;
            let hasDisabledChoice = false;

            tagEls.forEach(tag => {
                const text = tag.textContent.trim().toUpperCase();
                if (text === 'DISABLED') hasDisabledTag = true;
                if (text.match(/^DISABLED CHOICE\s*\(\d+\)$/)) hasDisabledChoice = true;
            });

            // CASE 1: Standalone disabled item
            if (hasDisabledTag) {
                const nameEl = row.querySelector('[class*="hgTNKZ"], [class*="al-t-caption-label"]');
                const name = nameEl ? nameEl.textContent.trim() : 'Unknown';
                const descEl = row.querySelector('[class*="iWwtCn"]');
                const description = descEl ? descEl.textContent.trim() : '';
                const priceEl = row.querySelector('[class*="cgreXg"]');
                let price = priceEl ? priceEl.textContent.trim() : '';
                price = price.replace(/ALL\s*/i, '').replace(/\u00A0/g, ' ').trim();

                items.push({ name, description, price, category: currentCategory, type: 'item' });
            }

            // CASE 2: Option group with disabled choices
            if (hasDisabledChoice) {
                const groupNameEl = row.querySelector('[class*="al-t-caption-label"]');
                const groupName = groupNameEl ? groupNameEl.textContent.trim() : 'Unknown Option Group';

                // Find disabled options via span[disabled]
                const disabledSpans = row.querySelectorAll('span[disabled]');
                disabledSpans.forEach(span => {
                    const priceEl = span.querySelector('[class*="cgreXg"]');
                    let price = '';
                    if (priceEl) {
                        price = priceEl.textContent.trim().replace(/ALL\s*/i, '').replace(/\u00A0/g, ' ').trim();
                    }
                    const fullText = span.textContent.trim();
                    let optionName = fullText.replace(/\s*\([^)]*ALL[^)]*\)\s*$/, '').trim();
                    if (optionName === fullText && price) {
                        optionName = fullText.replace(price, '').replace(/ALL/gi, '').replace(/[()]/g, '').replace(/\u00A0/g, ' ').trim();
                    }
                    optionName = optionName.replace(/,\s*$/, '').trim();

                    if (optionName) {
                        items.push({
                            name: optionName,
                            description: `Option in: ${groupName}`,
                            price,
                            category: currentCategory,
                            type: 'option',
                            optionGroup: groupName,
                        });
                    }
                });

                // Fallback: check for jQyrIl class
                if (disabledSpans.length === 0) {
                    const allOptionSpans = row.querySelectorAll('span[dir="auto"][lang]');
                    allOptionSpans.forEach(span => {
                        if (span.className.includes('jQyrIl') || span.hasAttribute('disabled')) {
                            const priceEl = span.querySelector('[class*="cgreXg"]');
                            let price = '';
                            if (priceEl) {
                                price = priceEl.textContent.trim().replace(/ALL\s*/i, '').replace(/\u00A0/g, ' ').trim();
                            }
                            const fullText = span.textContent.trim();
                            let optionName = fullText.replace(/\s*\([^)]*ALL[^)]*\)\s*$/, '').trim();
                            if (optionName === fullText && price) {
                                optionName = fullText.replace(price, '').replace(/ALL/gi, '').replace(/[()]/g, '').replace(/\u00A0/g, ' ').trim();
                            }
                            optionName = optionName.replace(/,\s*$/, '').trim();

                            if (optionName) {
                                items.push({
                                    name: optionName,
                                    description: `Option in: ${groupName}`,
                                    price,
                                    category: currentCategory,
                                    type: 'option',
                                    optionGroup: groupName,
                                });
                            }
                        }
                    });
                }
            }
        });

        return items;
    });
}

// ============================================================
// SCROLL TO LOAD ALL ITEMS (virtual list needs scrolling)
// ============================================================
async function scrollToLoadAll() {
    await page.evaluate(async () => {
        const container = document.querySelector('[class*="virtual-list"], [style*="overflow"]') || document.documentElement;
        const scrollTarget = container === document.documentElement ? window : container;

        let lastHeight = 0;
        let sameCount = 0;

        for (let i = 0; i < 25; i++) { // max 25 scroll steps
            if (scrollTarget === window) {
                window.scrollBy(0, 800);
            } else {
                container.scrollTop += 800;
            }
            await new Promise(r => setTimeout(r, 300));

            const currentHeight = scrollTarget === window
                ? document.documentElement.scrollHeight
                : container.scrollHeight;

            if (currentHeight === lastHeight) {
                sameCount++;
                if (sameCount >= 3) break; // no more content
            } else {
                sameCount = 0;
            }
            lastHeight = currentHeight;
        }

        // Scroll back to top
        if (scrollTarget === window) {
            window.scrollTo(0, 0);
        } else {
            container.scrollTop = 0;
        }
    });
}

// ============================================================
// CHECK LOGIN STATUS
// ============================================================
async function checkLoginStatus() {
    try {
        const url = page.url();
        // If redirected to login page or shows login form
        const isLoginPage = url.includes('/login') || url.includes('/auth');
        const hasLoginForm = await page.evaluate(() => {
            return !!document.querySelector('input[type="email"]') ||
                   !!document.querySelector('[class*="login"]') ||
                   document.body.textContent.includes('Sign in') ||
                   document.body.textContent.includes('Log in');
        });
        return !(isLoginPage || hasLoginForm);
    } catch {
        return false;
    }
}

// ============================================================
// MAIN SCRAPE LOOP
// ============================================================
async function doScrape() {
    try {
        totalScrapes++;

        // Check if still logged in
        const loggedIn = await checkLoginStatus();
        if (!loggedIn) {
            isLoggedIn = false;
            console.log('[Scrape] Not logged in! Session may have expired.');
            if (!loginAlertSent) {
                sendWhatsAppAlert('🔑 Wolt Monitor: Session expired! Please login at your Render URL.');
                loginAlertSent = true;
            }
            return;
        }

        isLoggedIn = true;
        loginAlertSent = false;

        // Dismiss any cookie banners that might have appeared
        await dismissCookieBanner();

        // Only do full scroll every 5th scrape (~100s) to save memory
        // Other scrapes just check what's visible
        if (totalScrapes % 5 === 0) {
            await scrollToLoadAll();
        }

        // Scrape
        const items = await scrapeDisabledItems();
        lastScrapeTime = new Date().toISOString();
        lastItems = items;
        scrapeErrors = 0;

        const itemCount = items.filter(i => i.type === 'item').length;
        const optionCount = items.filter(i => i.type === 'option').length;
        console.log(`[Scrape] Found ${itemCount} items + ${optionCount} options disabled`);

        if (items.length > 0) {
            sendToAppsScript(items);
        }

        // Save cookies periodically
        const cookies = await page.cookies();
        saveCookies(cookies);

        // Clear browser cache every 50 scrapes to prevent memory growth
        if (totalScrapes % 50 === 0) {
            try {
                const client = await page.target().createCDPSession();
                await client.send('Network.clearBrowserCache');
                await client.detach();
                console.log('[Memory] Browser cache cleared');
            } catch (e) { /* ignore */ }
        }

    } catch (err) {
        scrapeErrors++;
        console.error(`[Scrape] Error (${scrapeErrors}):`, err.message);

        // If too many errors, try refreshing the page
        if (scrapeErrors >= 5) {
            console.log('[Scrape] Too many errors, refreshing page...');
            try {
                await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                scrapeErrors = 0;
            } catch (reloadErr) {
                console.error('[Scrape] Reload failed:', reloadErr.message);
                // Try full browser restart
                await restartBrowser();
            }
        }
    }
}

async function restartBrowser() {
    console.log('[Browser] Restarting...');
    try {
        if (scrapeInterval) clearInterval(scrapeInterval);
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    } catch {}

    await setupPage();
    await navigateToMenu();
    startScraping();
}

async function navigateToMenu() {
    console.log(`[Nav] Going to ${CONFIG.WOLT_MENU_URL}...`);
    try {
        await page.goto(CONFIG.WOLT_MENU_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('[Nav] Page loaded:', page.url());
        await dismissCookieBanner();
        // Wait a bit for React to render
        await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
        console.error('[Nav] Failed:', err.message);
    }
}

// Auto-dismiss cookie consent banners
async function dismissCookieBanner() {
    try {
        const dismissed = await page.evaluate(() => {
            // Wolt's specific cookie accept button
            const acceptBtn = document.querySelector('[data-test-id="consent-banner-accept-button"]');
            if (acceptBtn) {
                acceptBtn.click();
                return 'wolt-accept';
            }
            // Fallback: any button that says "Allow" or "Accept"
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = btn.textContent.trim().toLowerCase();
                if (text === 'allow' || text === 'accept' || text === 'accept all') {
                    btn.click();
                    return 'generic-accept';
                }
            }
            return false;
        });
        if (dismissed) {
            await new Promise(r => setTimeout(r, 1000));
            console.log(`[Nav] Cookie banner dismissed via: ${dismissed}`);
        }
    } catch (err) {
        console.log('[Nav] No cookie banner found or already dismissed');
    }
}

function startScraping() {
    console.log(`[Scrape] Starting loop every ${CONFIG.SCRAPE_INTERVAL / 1000}s`);
    scrapeInterval = setInterval(doScrape, CONFIG.SCRAPE_INTERVAL);
    // Do first scrape immediately
    setTimeout(doScrape, 5000);
}

// ============================================================
// EXPRESS WEB SERVER (status + login UI)
// ============================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check for Render
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Status page + Login UI
app.get('/', (req, res) => {
    const itemCount = lastItems.filter(i => i.type === 'item').length;
    const optionCount = lastItems.filter(i => i.type === 'option').length;

    res.send(`<!DOCTYPE html>
<html><head><title>Wolt Monitor</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f0f1a; color: #e0e0e0; padding: 20px; }
  .container { max-width: 600px; margin: 0 auto; }
  h1 { color: #00ff88; margin-bottom: 20px; }
  .card { background: #1a1a2e; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .status { display: flex; align-items: center; gap: 10px; font-size: 18px; margin-bottom: 12px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot.green { background: #00ff88; }
  .dot.red { background: #ff4444; }
  .dot.yellow { background: #ffaa00; }
  .info { color: #888; font-size: 14px; margin: 6px 0; }
  .info span { color: #ccc; }
  .items-list { max-height: 300px; overflow-y: auto; font-size: 13px; margin-top: 10px; }
  .items-list div { padding: 4px 0; border-bottom: 1px solid #2a2a3e; }
  .items-list .option { padding-left: 20px; color: #aaa; }
  h2 { color: #00aaff; margin-bottom: 12px; font-size: 16px; }
  input, button { width: 100%; padding: 12px; margin: 6px 0; border-radius: 8px; border: 1px solid #333; font-size: 14px; }
  input { background: #0f0f1a; color: #e0e0e0; }
  button { background: #00ff88; color: #0f0f1a; font-weight: bold; cursor: pointer; border: none; }
  button:hover { background: #00cc6a; }
  .btn-secondary { background: #333; color: #e0e0e0; }
  .btn-secondary:hover { background: #444; }
  .msg { padding: 10px; border-radius: 8px; margin: 10px 0; font-size: 14px; }
  .msg.ok { background: #0a3d1f; color: #00ff88; }
  .msg.err { background: #3d0a0a; color: #ff4444; }
</style></head><body>
<div class="container">
  <h1>🔍 Wolt Monitor</h1>

  <div class="card">
    <div class="status">
      <div class="dot ${isLoggedIn ? 'green' : 'red'}"></div>
      <strong>${isLoggedIn ? 'Online & Monitoring' : 'Session Expired - Login Required'}</strong>
    </div>
    <div class="info">Last scrape: <span>${lastScrapeTime || 'Never'}</span></div>
    <div class="info">Last sent to sheet: <span>${lastSendTime || 'Never'}</span></div>
    <div class="info">Total scrapes: <span>${totalScrapes}</span></div>
    <div class="info">Memory: <span>${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS / ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB heap</span></div>
    <div class="info">Disabled: <span>${itemCount} items + ${optionCount} options</span></div>
    <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
      <a href="/screenshot" style="background:#1e3a5f; color:#00aaff; padding:8px 14px; border-radius:8px; text-decoration:none; font-size:13px;">📸 Live Preview</a>
      <a href="/screenshot/full" style="background:#1e3a5f; color:#00aaff; padding:8px 14px; border-radius:8px; text-decoration:none; font-size:13px;">📜 Full Page</a>
      <a href="/api/status" style="background:#1e3a5f; color:#00aaff; padding:8px 14px; border-radius:8px; text-decoration:none; font-size:13px;">📊 JSON Status</a>
    </div>
  </div>

  ${lastItems.length > 0 ? `
  <div class="card">
    <h2>Currently Disabled</h2>
    <div class="items-list">
      ${lastItems.map(i => i.type === 'option'
        ? `<div class="option">↳ [${i.optionGroup}] ${i.name} (${i.price} ALL)</div>`
        : `<div><strong>${i.name}</strong> - ${i.price} ALL <em style="color:#666">${i.category}</em></div>`
      ).join('')}
    </div>
  </div>` : ''}

  <div class="card">
    <h2>📱 WhatsApp Contacts</h2>
    <p style="color:#888; font-size:13px; margin-bottom:12px;">
      Toggle who receives alerts. Green = active.
    </p>
    ${(() => {
        const contacts = loadContacts();
        return contacts.map((c, i) => `
        <div style="display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid #2a2a3e;">
          <div class="dot ${c.active ? 'green' : 'red'}" style="flex-shrink:0;"></div>
          <div style="flex:1;">
            <strong>${c.type === 'group' ? '👥' : '👤'} ${c.name}</strong>
            <span style="color:#666; font-size:12px; margin-left:6px;">${c.chatId || 'no number'}</span>
          </div>
          <form method="POST" action="/contacts/toggle" style="margin:0;">
            <input type="hidden" name="password" value="">
            <input type="hidden" name="id" value="${c.id}">
            <button type="submit" style="width:auto; padding:4px 12px; font-size:12px; background:${c.active ? '#333' : '#00ff88'}; color:${c.active ? '#e0e0e0' : '#0f0f1a'};">
              ${c.active ? 'Disable' : 'Enable'}
            </button>
          </form>
        </div>`).join('');
    })()}
    <details style="margin-top:14px;">
      <summary style="color:#00aaff; cursor:pointer; font-size:13px;">➕ Add new contact or group</summary>
      <form method="POST" action="/contacts/add" style="margin-top:10px;">
        <input type="password" name="password" placeholder="UI Password" required>
        <input type="text" name="name" placeholder="Name (e.g. Lona or Staff Group)" required>
        <select name="type" style="width:100%;padding:12px;margin:6px 0;border-radius:8px;border:1px solid #333;background:#0f0f1a;color:#e0e0e0;font-size:14px;">
          <option value="person">👤 Person (phone number)</option>
          <option value="group">👥 Group chat</option>
        </select>
        <input type="text" name="chatId" placeholder="Phone number OR group ID (see below)" required>
        <p style="color:#666; font-size:11px; margin:4px 0;">
          Person: just the number like <b>355694022227</b><br>
          Group: the full ID like <b>120363XXXXX@g.us</b>
        </p>
        <button type="submit" class="btn-secondary">Add Contact</button>
      </form>
      <form method="POST" action="/contacts/list-groups" style="margin-top:8px;">
        <input type="password" name="password" placeholder="UI Password" required>
        <button type="submit" class="btn-secondary" style="font-size:12px;">📋 Show my WhatsApp groups (find group IDs)</button>
      </form>
    </details>
    <details style="margin-top:8px;">
      <summary style="color:#ff6666; cursor:pointer; font-size:13px;">🗑️ Remove contact</summary>
      <form method="POST" action="/contacts/remove" style="margin-top:10px;">
        <input type="password" name="password" placeholder="UI Password" required>
        <select name="id" style="width:100%;padding:12px;margin:6px 0;border-radius:8px;border:1px solid #333;background:#0f0f1a;color:#e0e0e0;font-size:14px;">
          ${loadContacts().map(c => `<option value="${c.id}">${c.name} (${c.chatId})</option>`).join('')}
        </select>
        <button type="submit" style="background:#ff4444; color:white; width:100%; padding:12px; margin:6px 0; border-radius:8px; border:none; cursor:pointer;">Remove</button>
      </form>
    </details>
    <form method="POST" action="/contacts/test" style="margin-top:14px;">
      <input type="password" name="password" placeholder="UI Password" required style="display:inline-block;width:60%;margin-right:4px;">
      <button type="submit" class="btn-secondary" style="font-size:13px;width:38%;display:inline-block;">🧪 Test Alert</button>
    </form>
  </div>

  <div class="card">
    <h2>🔑 Login / Refresh Session</h2>
    <p style="color:#888; font-size:13px; margin-bottom:12px;">
      1. Click "Request Login Email" → Wolt sends magic link to your email<br>
      2. Copy the magic link URL from the email<br>
      3. Paste it below and click "Authenticate"
    </p>
    <form method="POST" action="/auth/request-login">
      <input type="password" name="password" placeholder="UI Password" required>
      <button type="submit" class="btn-secondary">📧 Request Login Email</button>
    </form>
    <br>
    <form method="POST" action="/auth/magic-link">
      <input type="password" name="password" placeholder="UI Password" required>
      <input type="url" name="magic_link" placeholder="Paste magic link URL from email..." required>
      <button type="submit">🔓 Authenticate</button>
    </form>
  </div>
</div>
<script>setTimeout(() => location.reload(), 30000);</script>
</body></html>`);
});

// ── CONTACTS MANAGEMENT ENDPOINTS ──

// Toggle contact active/inactive
app.post('/contacts/toggle', (req, res) => {
    const contacts = loadContacts();
    const contact = contacts.find(c => c.id === req.body.id);
    if (contact) {
        contact.active = !contact.active;
        saveContacts(contacts);
        console.log(`[Contacts] ${contact.name} → ${contact.active ? 'ACTIVE' : 'DISABLED'}`);
    }
    res.redirect('/');
});

// Add new contact
app.post('/contacts/add', (req, res) => {
    if (req.body.password !== CONFIG.UI_PASSWORD) {
        return res.send('<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ Wrong password. <a href="/" style="color:#00aaff;">Back</a></body></html>');
    }
    const contacts = loadContacts();
    const id = req.body.name.toLowerCase().replace(/[^a-z0-9]/g, '') + '_' + Date.now().toString(36);
    let chatId = req.body.chatId.trim();
    const type = req.body.type || 'person';

    // Auto-format based on type
    if (chatId && !chatId.includes('@')) {
        if (type === 'group') {
            chatId = chatId + '@g.us';
        } else {
            chatId = chatId.replace(/[^0-9]/g, '') + '@c.us';
        }
    }

    contacts.push({
        id,
        name: req.body.name.trim(),
        chatId,
        type, // 'person' or 'group'
        active: true,
    });
    saveContacts(contacts);
    console.log(`[Contacts] Added ${type}: ${req.body.name} (${chatId})`);
    res.redirect('/');
});

// List WhatsApp groups (to find group IDs)
app.post('/contacts/list-groups', async (req, res) => {
    if (req.body.password !== CONFIG.UI_PASSWORD) {
        return res.send('<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ Wrong password. <a href="/" style="color:#00aaff;">Back</a></body></html>');
    }
    if (!CONFIG.GREEN_API_INSTANCE || !CONFIG.GREEN_API_TOKEN) {
        return res.send('<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ Green API not configured. <a href="/" style="color:#00aaff;">Back</a></body></html>');
    }

    const url = `https://api.green-api.com/waInstance${CONFIG.GREEN_API_INSTANCE}/getContacts/${CONFIG.GREEN_API_TOKEN}`;

    try {
        const data = await new Promise((resolve, reject) => {
            https.get(url, (resp) => {
                let body = '';
                resp.on('data', chunk => body += chunk);
                resp.on('end', () => resolve(body));
            }).on('error', reject);
        });

        const contacts = JSON.parse(data);
        const groups = contacts.filter(c => c.id && c.id.endsWith('@g.us'));

        const groupRows = groups.map(g =>
            `<tr>
                <td style="padding:8px;border-bottom:1px solid #2a2a3e;">${g.name || '(unnamed)'}</td>
                <td style="padding:8px;border-bottom:1px solid #2a2a3e;font-family:monospace;font-size:12px;color:#00ff88;">${g.id}</td>
                <td style="padding:8px;border-bottom:1px solid #2a2a3e;">
                    <form method="POST" action="/contacts/add" style="margin:0;display:inline;">
                        <input type="hidden" name="password" value="${req.body.password}">
                        <input type="hidden" name="name" value="${(g.name || 'Group').replace(/"/g, '&quot;')}">
                        <input type="hidden" name="chatId" value="${g.id}">
                        <input type="hidden" name="type" value="group">
                        <button type="submit" style="background:#00ff88;color:#0f0f1a;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">+ Add</button>
                    </form>
                </td>
            </tr>`
        ).join('');

        res.send(`<!DOCTYPE html><html><head><title>WhatsApp Groups</title>
        <style>body{background:#0f0f1a;color:#e0e0e0;font-family:sans-serif;padding:20px;}
        table{width:100%;border-collapse:collapse;margin-top:16px;}
        th{text-align:left;padding:8px;border-bottom:2px solid #333;color:#00aaff;}
        a{color:#00aaff;}</style></head><body>
        <h2>📋 Your WhatsApp Groups (${groups.length})</h2>
        <p style="color:#888;">Click "Add" to add any group as an alert recipient.</p>
        <table><tr><th>Group Name</th><th>Group ID</th><th></th></tr>${groupRows}</table>
        <br><a href="/">← Back to Dashboard</a></body></html>`);

    } catch (err) {
        console.error('[Groups] Error fetching:', err.message);
        res.send(`<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ Error: ${err.message}<br><a href="/" style="color:#00aaff;">Back</a></body></html>`);
    }
});

// Remove contact
app.post('/contacts/remove', (req, res) => {
    if (req.body.password !== CONFIG.UI_PASSWORD) {
        return res.send('<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ Wrong password. <a href="/" style="color:#00aaff;">Back</a></body></html>');
    }
    let contacts = loadContacts();
    const removed = contacts.find(c => c.id === req.body.id);
    contacts = contacts.filter(c => c.id !== req.body.id);
    saveContacts(contacts);
    if (removed) console.log(`[Contacts] Removed: ${removed.name}`);
    res.redirect('/');
});

// Send test message to all active contacts
app.post('/contacts/test', (req, res) => {
    if (req.body.password !== CONFIG.UI_PASSWORD) {
        return res.send('<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ Wrong password. <a href="/" style="color:#00aaff;">Back</a></body></html>');
    }
    sendWhatsAppAlert('🧪 Test alert from Wolt Monitor — if you see this, alerts are working!');
    res.redirect('/');
});

// Request login email (navigates to Wolt login and enters email)
app.post('/auth/request-login', async (req, res) => {
    if (req.body.password !== CONFIG.UI_PASSWORD) {
        return res.send('<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ Wrong password. <a href="/" style="color:#00aaff;">Back</a></body></html>');
    }

    try {
        console.log('[Auth] Requesting login email...');
        await page.goto('https://merchant.wolt.com', { waitUntil: 'networkidle2', timeout: 30000 });

        // Must dismiss cookie banner first, otherwise it may block the form
        await dismissCookieBanner();
        await new Promise(r => setTimeout(r, 1500));

        // Try to find and fill email input
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
        await page.type('input[type="email"], input[name="email"]', CONFIG.WOLT_EMAIL, { delay: 50 });

        // Click submit/next button
        const buttons = await page.$$('button[type="submit"], button');
        for (const btn of buttons) {
            const text = await page.evaluate(el => el.textContent.toLowerCase(), btn);
            if (text.includes('next') || text.includes('continue') || text.includes('sign') || text.includes('log') || text.includes('send')) {
                await btn.click();
                break;
            }
        }

        await new Promise(r => setTimeout(r, 2000));
        console.log('[Auth] Login email requested for:', CONFIG.WOLT_EMAIL);
        res.send('<html><body style="background:#0f0f1a;color:#00ff88;padding:40px;">✅ Login email requested! Check your inbox for the magic link, then paste it below.<br><br><a href="/" style="color:#00aaff;">← Back to paste magic link</a></body></html>');
    } catch (err) {
        console.error('[Auth] Request login error:', err.message);
        res.send(`<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ Error: ${err.message}<br><a href="/" style="color:#00aaff;">Back</a></body></html>`);
    }
});

// Process magic link
app.post('/auth/magic-link', async (req, res) => {
    if (req.body.password !== CONFIG.UI_PASSWORD) {
        return res.send('<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ Wrong password. <a href="/" style="color:#00aaff;">Back</a></body></html>');
    }

    const magicLink = req.body.magic_link?.trim();
    if (!magicLink) {
        return res.send('<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ No magic link provided. <a href="/" style="color:#00aaff;">Back</a></body></html>');
    }

    try {
        console.log('[Auth] Navigating to magic link...');
        await page.goto(magicLink, { waitUntil: 'networkidle2', timeout: 60000 });
        await dismissCookieBanner();
        await new Promise(r => setTimeout(r, 3000));

        // Save cookies immediately
        const cookies = await page.cookies();
        saveCookies(cookies);

        // Navigate to menu page
        console.log('[Auth] Magic link processed, navigating to menu...');
        await page.goto(CONFIG.WOLT_MENU_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await dismissCookieBanner();
        await new Promise(r => setTimeout(r, 3000));

        // Check if logged in
        isLoggedIn = await checkLoginStatus();
        loginAlertSent = false;

        // Save cookies again after navigation
        const finalCookies = await page.cookies();
        saveCookies(finalCookies);

        console.log('[Auth] Login status:', isLoggedIn ? 'SUCCESS' : 'FAILED');

        if (isLoggedIn) {
            sendWhatsAppAlert('✅ Wolt Monitor: Successfully logged in! Monitoring resumed.');
            res.send('<html><body style="background:#0f0f1a;color:#00ff88;padding:40px;font-size:20px;">✅ Successfully logged in! Monitoring will resume.<br><br><a href="/" style="color:#00aaff;">← Back to dashboard</a></body></html>');
        } else {
            res.send('<html><body style="background:#0f0f1a;color:#ffaa00;padding:40px;">⚠️ Magic link processed but login unclear. Check dashboard.<br><a href="/" style="color:#00aaff;">Back</a></body></html>');
        }
    } catch (err) {
        console.error('[Auth] Magic link error:', err.message);
        res.send(`<html><body style="background:#0f0f1a;color:#ff4444;padding:40px;">❌ Error: ${err.message}<br><a href="/" style="color:#00aaff;">Back</a></body></html>`);
    }
});

// API: JSON status
app.get('/api/status', (req, res) => {
    res.json({
        isLoggedIn,
        lastScrapeTime,
        lastSendTime,
        totalScrapes,
        scrapeErrors,
        disabledItems: lastItems.filter(i => i.type === 'item').length,
        disabledOptions: lastItems.filter(i => i.type === 'option').length,
        items: lastItems,
        uptime: process.uptime(),
    });
});

// Live screenshot of what the browser sees
app.get('/screenshot', async (req, res) => {
    try {
        if (!page) return res.status(500).send('Browser not ready');
        const screenshot = await page.screenshot({ fullPage: false, type: 'png' });
        const pageUrl = page.url();
        const pageTitle = await page.title().catch(() => '');

        res.send(`<!DOCTYPE html><html><head><title>Live Preview</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { background:#0f0f1a; color:#e0e0e0; font-family:sans-serif; padding:20px; margin:0; }
          .bar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
          .url { background:#1a1a2e; padding:8px 14px; border-radius:8px; font-family:monospace; font-size:13px; color:#00aaff; word-break:break-all; flex:1; min-width:200px; }
          img { max-width:100%; border:2px solid #333; border-radius:8px; }
          a { color:#00aaff; text-decoration:none; }
          button, .btn { background:#333; color:#e0e0e0; border:none; padding:8px 16px; border-radius:8px; cursor:pointer; font-size:13px; text-decoration:none; display:inline-block; }
          button:hover, .btn:hover { background:#444; }
          .refresh { background:#00ff88; color:#0f0f1a; }
          .info { color:#888; font-size:13px; margin-bottom:8px; }
        </style></head><body>
          <div class="bar">
            <a href="/" class="btn">← Dashboard</a>
            <a href="/screenshot" class="btn refresh">🔄 Refresh Screenshot</a>
            <a href="/screenshot/full" class="btn">📜 Full Page</a>
          </div>
          <div class="info">📍 Current URL:</div>
          <div class="url">${pageUrl}</div>
          <div class="info" style="margin-top:12px;">📸 Page title: <strong>${pageTitle}</strong> | Captured: ${new Date().toLocaleTimeString('en-GB')}</div>
          <img src="/screenshot/raw" alt="Browser screenshot" style="margin-top:12px;">
          <div class="info" style="margin-top:16px;">Auto-refreshes every 15s</div>
          <script>setTimeout(() => location.reload(), 15000);</script>
        </body></html>`);
    } catch (err) {
        res.status(500).send(`Error: ${err.message}`);
    }
});

// Raw screenshot image (viewport only)
app.get('/screenshot/raw', async (req, res) => {
    try {
        if (!page) return res.status(500).send('Browser not ready');
        const screenshot = await page.screenshot({ fullPage: false, type: 'png' });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(screenshot);
    } catch (err) {
        res.status(500).send(`Error: ${err.message}`);
    }
});

// Raw screenshot image (full page)
app.get('/screenshot/full', async (req, res) => {
    try {
        if (!page) return res.status(500).send('Browser not ready');
        const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(screenshot);
    } catch (err) {
        res.status(500).send(`Error: ${err.message}`);
    }
});

// Force refresh page
app.post('/api/refresh', async (req, res) => {
    try {
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        res.json({ ok: true, message: 'Page refreshed' });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

// ============================================================
// STARTUP
// ============================================================
async function main() {
    console.log('='.repeat(60));
    console.log('  Wolt Disabled Items Monitor - Cloud Edition v1.1');
    console.log('='.repeat(60));
    console.log(`  Menu URL: ${CONFIG.WOLT_MENU_URL}`);
    console.log(`  Scrape interval: ${CONFIG.SCRAPE_INTERVAL / 1000}s`);
    console.log(`  Apps Script: ${CONFIG.APPS_SCRIPT_URL ? 'configured' : 'NOT SET'}`);
    console.log(`  WhatsApp: ${CONFIG.GREEN_API_INSTANCE ? 'configured' : 'NOT SET'}`);
    console.log('='.repeat(60));

    // Start Express server
    app.listen(CONFIG.PORT, () => {
        console.log(`[Server] Web UI running on port ${CONFIG.PORT}`);
    });

    // Launch browser and navigate
    await setupPage();
    await navigateToMenu();

    // Check initial login status
    isLoggedIn = await checkLoginStatus();
    console.log('[Init] Login status:', isLoggedIn ? 'LOGGED IN ✅' : 'NOT LOGGED IN ❌');

    if (!isLoggedIn) {
        sendWhatsAppAlert('🔑 Wolt Monitor started but needs login. Visit your Render URL to authenticate.');
    }

    // Start scraping loop
    startScraping();
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
    console.log('[Shutdown] Received SIGTERM, cleaning up...');
    if (scrapeInterval) clearInterval(scrapeInterval);
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
    console.error('[Error] Unhandled rejection:', err);
});

main().catch(err => {
    console.error('[Fatal]', err);
    process.exit(1);
});