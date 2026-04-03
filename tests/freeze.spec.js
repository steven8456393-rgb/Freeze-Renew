const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

// 新增 Token 获取
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }

        const msg = [
            `🎮 FreezeHost 续期通知`,
            `🕐 运行时间: ${nowStr()}`,
            `🖥 服务器: FreezeHost Free`,
            `📊 续期结果: \n${result}`,
        ].join('\n');

        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            if (res.statusCode === 200) {
                console.log('📨 TG 推送成功');
            } else {
                console.log(`⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            }
            resolve();
        });

        req.on('error', (e) => {
            console.log(`⚠️ TG 推送异常：${e.message}`);
            resolve();
        });

        req.setTimeout(15000, () => {
            console.log('⚠️ TG 推送超时');
            req.destroy();
            resolve();
        });

        req.write(body);
        req.end();
    });
}

async function handleOAuthPage(page) {
    console.log(`  📄 当前 URL: ${page.url()}`);
    await page.waitForTimeout(3000);

    const selectors = [
        'button:has-text("Authorize")',
        'button:has-text("授权")',
        'button[type="submit"]',
        'div[class*="footer"] button',
        'button[class*="primary"]',
    ];

    for (let i = 0; i < 8; i++) {
        console.log(`  🔄 第 ${i + 1} 次尝试处理授权页，URL: ${page.url()}`);

        if (!page.url().includes('discord.com')) {
            console.log('  ✅ 已离开 Discord');
            return;
        }

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);

        for (const selector of selectors) {
            try {
                const btn = page.locator(selector).last();
                const visible = await btn.isVisible();
                if (!visible) continue;

                const text = (await btn.innerText()).trim();
                console.log(`  🔘 找到按钮: "${text}" (${selector})`);

                if (text.includes('取消') || text.toLowerCase().includes('cancel') ||
                    text.toLowerCase().includes('deny')) continue;

                const disabled = await btn.isDisabled();
                if (disabled) {
                    console.log('  ⏳ 按钮 disabled，等待...');
                    break;
                }

                await btn.click();
                console.log(`  ✅ 已点击: "${text}"`);
                await page.waitForTimeout(2000);

                if (!page.url().includes('discord.com')) {
                    console.log('  ✅ 授权成功，已跳转');
                    return;
                }
                break;
            } catch { continue; }
        }
        await page.waitForTimeout(2000);
    }
}

test('FreezeHost 自动续期', async () => {
    // 检查配置
    if (!DISCORD_TOKEN && (!DISCORD_EMAIL || !DISCORD_PASSWORD)) {
        throw new Error('❌ 缺少登录配置。请配置 DISCORD_TOKEN 或 DISCORD_ACCOUNT');
    }

    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        try {
            const http = require('http');
            await new Promise((resolve, reject) => {
                const req = http.request(
                    { host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 },
                    () => resolve()
                );
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.end();
            });
            proxyConfig = { server: process.env.GOST_PROXY };
            console.log('🛡️ 本地代理连通，使用 GOST 转发');
        } catch {
            console.log('⚠️ 本地代理不可达，降级为直连');
        }
    }

    console.log('🔧 启动浏览器...');
    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);
    console.log('🚀 浏览器就绪！');

    try {
        // ── 出口 IP 验证 ──────────────────────────────────────
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            const body = await res.text();
            const ip = JSON.parse(body).ip || body;
            const masked = ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx');
            console.log(`✅ 出口 IP 确认：${masked}`);
        } catch {
            console.log('⚠️ IP 验证超时，跳过');
        }

        // ── 登录 Discord (Token 优先) ──────────────────────────
        if (DISCORD_TOKEN) {
            console.log('🎫 检测到 Token，执行注入登录...');
            await page.goto('https://discord.com/login');
            await page.evaluate((token) => {
                setInterval(() => {
                    document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage.token = `"${token}"`;
                }, 50);
                setTimeout(() => { location.reload(); }, 2500);
            }, DISCORD_TOKEN);
            await page.waitForURL(/discord\.com\/channels\/@me/, { timeout: 30000 });
            console.log('✅ Discord Token 登录成功');
        }

        // ── 打开 FreezeHost ──────────────────────────────────
        console.log('🔑 打开 FreezeHost 登录页...');
        await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });

        console.log('📤 点击 Login with Discord...');
        await page.click('span.text-lg:has-text("Login with Discord")');

        console.log('⏳ 等待服务条款弹窗...');
        const confirmBtn = page.locator('button#confirm-login');
        await confirmBtn.waitFor({ state: 'visible' });
        await confirmBtn.click();
        console.log('✅ 已接受服务条款');

        // ── 如果没用 Token，则执行账号密码登录 ──────────────────
        if (!DISCORD_TOKEN) {
            console.log('⏳ 等待跳转 Discord 登录页...');
            await page.waitForURL(/discord\.com\/login/);

            console.log('✏️ 填写账号密码...');
            await page.fill('input[name="email"]', DISCORD_EMAIL);
            await page.fill('input[name="password"]', DISCORD_PASSWORD);

            console.log('📤 提交登录请求...');
            await page.click('button[type="submit"]');
            await page.waitForTimeout(2000);

            if (/discord\.com\/login/.test(page.url())) {
                let err = '账密错误或触发了 2FA / 验证码';
                try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
                await sendTG(`❌ Discord 登录失败：${err}`);
                throw new Error(`❌ Discord 登录失败: ${err}`);
            }
        }

        // ── OAuth 授权处理 ────────────────────────────────────
        console.log('⏳ 等待授权跳转...');
        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 15000 });
            await handleOAuthPage(page);
        } catch {
            console.log('✅ 自动授权或已跳转');
        }

        // ── 确认到达 Dashboard 并抓取所有服务器 ────────────────
        await page.waitForURL(/free\.freezehost\.pro\/dashboard/, { timeout: 30000 });
        console.log(`✅ 登录成功！当前：${page.url()}`);

        console.log('🔍 查找所有服务器的 Manage 按钮...');
        await page.waitForTimeout(3000);
        
        // 修改点 1：抓取所有 server-console 链接，存为数组
        const serverUrls = await page.evaluate(() => {
            const links = document.querySelectorAll('a[href*="server-console"]');
            return Array.from(links).map(link => link.href);
        });

        if (!serverUrls || serverUrls.length === 0) {
            throw new Error('❌ 未找到任何 server-console 链接');
        }
        
        console.log(`📋 共发现 ${serverUrls.length} 台服务器待处理`);

        // 用于收集所有服务器的执行结果
        let allResults = [];

        // 修改点 2：加入 for 循环遍历处理每一台服务器
        for (let i = 0; i < serverUrls.length; i++) {
            const currentUrl = serverUrls[i];
            console.log(`\n⚙️ 正在处理第 ${i + 1}/${serverUrls.length} 台服务器...`);
            
            try {
                await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(3000);

                // 读取续期状态
                console.log(`🔍 读取第 ${i + 1} 台续期状态...`);
                const renewalStatusText = await page.evaluate(() => {
                    const el = document.getElementById('renewal-status-console');
                    return el ? el.innerText.trim() : null;
                });
                console.log(`📋 状态：${renewalStatusText}`);

                if (renewalStatusText) {
                    const daysMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*day/i);
                    const remainingDays = daysMatch ? parseFloat(daysMatch[1]) : null;
                    if (remainingDays !== null && remainingDays > 7) {
                        const msg = `[第 ${i +
