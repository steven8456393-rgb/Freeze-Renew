看快照，页面已经在 Dashboard 了，但脚本还在等跳转。问题是：**OAuth 处理完后页面已经到了 dashboard，但 `waitForURL` 没捕捉到这个状态**，因为跳转在 `waitForURL` 开始监听之前就已经完成了。

直接改成检查当前 URL，不等跳转：

```javascript
// ── 等待最终落地 dashboard ────────────────────────────
console.log('⏳ 等待跳转 Dashboard...');
try {
    await page.waitForURL(
        url => url.includes('/callback') || url.includes('/dashboard'),
        { timeout: 10000 }
    );
} catch {
    // 可能已经在 dashboard 了，检查当前 URL
}

// 如果在 callback，继续等 dashboard
if (page.url().includes('/callback')) {
    await page.waitForURL(/free\.freezehost\.pro\/dashboard/);
}

// 如果既不在 callback 也不在 dashboard，报错
if (!page.url().includes('/dashboard')) {
    throw new Error(`❌ 登录后未到达 Dashboard，当前 URL: ${page.url()}`);
}
console.log(`✅ 登录成功！当前：${page.url()}`);
```

同时 OAuth 那段也要改，**处理完授权后要等页面真正离开 Discord**：

```javascript
console.log('⏳ 等待 OAuth 授权...');
try {
    await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
    console.log('🔍 进入 OAuth 授权页，处理中...');
    await page.waitForTimeout(2000);
    await handleOAuthPage(page);
    // 等待离开 Discord
    await page.waitForURL(/free\.freezehost\.pro/, { timeout: 15000 });
    console.log(`✅ 已离开 Discord，当前：${page.url()}`);
} catch {
    console.log(`✅ 静默授权或已跳转，当前：${page.url()}`);
}
```

完整 `freeze.spec.js`：

```javascript
// tests/freeze.spec.js
const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 30000;

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
            `📊 续期结果: ${result}`,
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
    for (let i = 0; i < 5; i++) {
        let btn;
        try {
            btn = await page.waitForSelector('button.primary_a22cb0', { timeout: 8000 });
        } catch {
            try { btn = await page.locator('button:has-text("授权")').first().elementHandle(); }
            catch {
                try { btn = await page.locator('button:has-text("Authorize")').first().elementHandle(); }
                catch { break; }
            }
        }
        if (!btn) break;

        const text = (await btn.innerText()).trim();
        console.log(`  🔍 OAuth 按钮: "${text}"`);

        if (text.includes('滚动') || text.toLowerCase().includes('scroll')) {
            await page.evaluate(() => {
                const s = document.querySelector('[class*="scroller"]')
                       || document.querySelector('[class*="scrollerBase"]')
                       || document.querySelector('[class*="content"]');
                if (s) s.scrollTop = s.scrollHeight;
                window.scrollTo(0, document.body.scrollHeight);
            });
            await page.waitForTimeout(1500);
            await btn.click();
            await page.waitForTimeout(1500);
            continue;
        }

        if (text.includes('授权') || text.toLowerCase().includes('authorize')) {
            const disabled = await btn.evaluate(el => el.disabled || el.classList.contains('disabled'));
            if (disabled) { await page.waitForTimeout(1500); continue; }
            await btn.click();
            console.log('  ✅ 已点击授权按钮');
            return;
        }

        const disabled = await btn.evaluate(el => el.disabled || el.classList.contains('disabled'));
        if (!disabled) { await btn.click(); await page.waitForTimeout(1500); }
        else break;
    }
}

test('FreezeHost 自动续期', async () => {
    if (!DISCORD_EMAIL || !DISCORD_PASSWORD) {
        throw new Error('❌ 缺少 DISCORD_ACCOUNT，格式: email,password');
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

        // ── 登录 ──────────────────────────────────────────────
        console.log('🔑 打开 FreezeHost 登录页...');
        await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });

        console.log('📤 点击 Login with Discord...');
        await page.click('span.text-lg:has-text("Login with Discord")');

        console.log('⏳ 等待服务条款弹窗...');
        const confirmBtn = page.locator('button#confirm-login');
        await confirmBtn.waitFor({ state: 'visible' });
        await confirmBtn.click();
        console.log('✅ 已接受服务条款');

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

        // ── OAuth 授权 ────────────────────────────────────────
        console.log('⏳ 等待 OAuth 授权...');
        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
            console.log('🔍 进入 OAuth 授权页，处理中...');
            await page.waitForTimeout(2000);
            await handleOAuthPage(page);
            // 等待离开 Discord
            await page.waitForURL(/free\.freezehost\.pro/, { timeout: 15000 });
            console.log(`✅ 已离开 Discord，当前：${page.url()}`);
        } catch {
            console.log(`✅ 静默授权或已跳转，当前：${page.url()}`);
        }

        // ── 确认到达 Dashboard ────────────────────────────────
        console.log('⏳ 确认到达 Dashboard...');
        try {
            await page.waitForURL(
                url => url.includes('/callback') || url.includes('/dashboard'),
                { timeout: 10000 }
            );
        } catch { /* 可能已经在 dashboard */ }

        if (page.url().includes('/callback')) {
            await page.waitForURL(/free\.freezehost\.pro\/dashboard/);
        }

        if (!page.url().includes('/dashboard')) {
            throw new Error(`❌ 未到达 Dashboard，当前 URL: ${page.url()}`);
        }
        console.log(`✅ 登录成功！当前：${page.url()}`);

        // ── 续期 ──────────────────────────────────────────────
        console.log('🔍 查找 Manage 按钮...');
        const manageBtn = page.locator('a[href*="/server-console"]').first();
        await manageBtn.waitFor({ state: 'visible' });
        await manageBtn.scrollIntoViewIfNeeded();
        await manageBtn.click();
        console.log('✅ 已点击 Manage');

        console.log('⏳ 等待进入 Server Console...');
        await page.waitForURL(/\/server-console/);
        console.log(`📄 Server Console: ${page.url()}`);

        console.log('🔍 查找 RENEW 按钮...');
        const renewBtn = page.locator('a#renew-link').first();
        await renewBtn.waitFor({ state: 'visible' });
        await renewBtn.click();
        console.log('📤 已点击 RENEW，等待结果...');

        await page.waitForURL(
            url => url.includes('/dashboard') || url.includes('/server-console'),
        );
        const finalUrl = page.url();
        console.log(`📄 最终跳转地址：${finalUrl}`);

        // ── 结果判断 ──────────────────────────────────────────
        if (finalUrl.includes('success=RENEWED')) {
            console.log('🎉 续期成功！');
            await sendTG('✅ 续期成功！');
            expect(finalUrl).toContain('success=RENEWED');

        } else if (finalUrl.includes('err=CANNOTAFFORDRENEWAL')) {
            console.log('⚠️ 余额不足，无法续期');
            await sendTG('⚠️ 余额不足，请前往挂机页面赚取金币');
            test.skip(true, '余额不足');

        } else {
            await sendTG(`⚠️ 续期结果未知：${finalUrl}`);
            throw new Error('续期结果未知，URL: ' + finalUrl);
        }

    } catch (e) {
        if (!e.message?.includes('余额不足')) {
            await sendTG(`❌ 脚本异常：${e.message}`);
        }
        throw e;

    } finally {
        await browser.close();
    }
});
```
