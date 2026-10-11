/**
 * HCNSec 每日签到脚本
 * 功能:
 *   1. 优先使用已保存的 Playwright storageState（Cookie + localStorage）
 *   2. 如果没有保存的状态，使用 GitHub Secrets 里的账号密码自动登录
 *   3. 登录成功后保存 storageState，供下次使用
 *   4. 使用保持有效会话的 Cookie 进行签到
 *
 * 环境变量（GitHub Secrets 或本地 .env）：
 *   HCNSEC_USERNAME / HCNSEC_PASSWORD   — 用于首次登录/重新登录
 *
 * 输出：
 *   - 签到成功 / 已签到 / 失败，并返回相应 exit code
 */
import fetch from 'node-fetch';
import { chromium } from 'playwright';
import * as dotenv from 'dotenv';

/* 加载 .env（GitHub Actions 中会自动将 secrets 注入为环境变量） */
dotenv.config();

/* ────────────────────────────────────────────────────────────── */
/* 1. 配置 */
/* ────────────────────────────────────────────────────────────── */
const HOST = 'api.hcnsec.cn';
const BASE = `https://${HOST}`;
const SELF_URL = `${BASE}/api/user/self`;
const CHECKIN_URL = `${BASE}/api/user/checkin`;

/* 必要的 env 检查 */
const USERNAME = process.env.HCNSEC_USERNAME;
const PASSWORD = process.env.HCNSEC_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('[FATAL] 缺少 HCNSEC_USERNAME / HCNSEC_PASSWORD 环境变量');
  console.error('请在 GitHub Repository Settings → Secrets → Actions 中添加这两个 secret。');
  process.exit(1);
}

/* ────────────────────────────────────────────────────────────── */
/* 2. 主要逻辑 */
/* ────────────────────────────────────────────────────────────── */
(async () => {
  console.log('[INFO] HCNSec daily check-in starting...');

  /* --- 第一步：尝试恢复已保存的登录态 --- */
  let authFailed = false;
  let cookies = [];

  try {
    console.log('[INFO] 尝试恢复已保存的登录态...');

    // 启动浏览器并携带 storageState
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: '.playwright/storageState.json',
    });
    const page = await context.newPage();

    // 直接访问受保护的 API（无需再次登录）
    const resp = await page.goto(SELF_URL, { waitUntil: 'networkidle' });
    if (resp && resp.status() === 200) {
      console.log('[INFO] 已成功恢复登录态（storageState 有效）');

      // 获取当前的 cookies
      cookies = await context.cookies();
      console.log('[DEBUG] Retrieved cookies from storageState:', cookies.map(c => `${c.name}=${c.value}`).join('; '));

      // --- 第四步：执行签到 ---
      console.log('[INFO] 使用有效会话进行签到...');
      const checkinResp = await fetch(CHECKIN_URL, {
        method: 'POST',
        headers: {
          'Host': HOST,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
          'Cookie': cookies.map(c => `${c.name}=${c.value}`).join('; ') || '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      const checkinText = await checkinResp.text();
      let checkinData;
      try { checkinData = JSON.parse(checkinText); } catch { checkinData = { raw: checkinText }; }

      console.log('[INFO] Check-in response:', JSON.stringify(checkinData).slice(0, 200));

      // 处理签到结果
      const success = checkinData?.success === true;
      const message = checkinData?.message || '';
      const isAlready = !success &&
        (message.includes('今日已签到') ||
         message.includes('已经签到') ||
         message.toLowerCase().includes('already'));

      if (resp.status === 200 && success) {
        const quota = checkinData?.data?.quota_awarded;
        const date = checkinData?.data?.checkin_date;
        const extra = quota !== undefined ? ` | 获得额度: ${quota}` : '';
        const dateStr = date ? ` | 日期: ${date}` : '';
        console.log(`[SUCCESS] 签到成功${dateStr}${extra}`);
        process.exit(0);
      } else if (resp.status === 200 && isAlready) {
        console.log(`[INFO] 已签到: ${message || '今日已签到'}`);
        process.exit(0);
      } else {
        console.error(`[FAIL] 签到失败: ${message || checkinText || `HTTP ${checkinResp.status}`}`);
        process.exit(1);
      }

      await browser.close();
      return; // 正常退出
    } else {
      console.warn('[WARN] storageState 失效（可能已过期或损坏），将重新登录...');
      await browser.close();
      authFailed = true; // 标记需要重新登录
    }
  } catch (err) {
    console.warn('[WARN] 恢复 storageState 失败（可能第一次运行或已过期）: ', err.message);
    authFailed = true;
  }

  /* --- 第二步：如果已保存的态失效，使用账号密码自动登录 --- */
  if (authFailed) {
    console.log('[INFO] 开始使用账号密码自动登录...');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // 设置更长的默认超时
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    // 1. 打开登录页
    console.log('[1/5] 打开登录页...');
    try {
      await page.goto('https://api.hcnsec.cn/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.warn('[WARN] 页面加载超时，尝试继续...', e.message);
    }

    // 等待页面稳定（给 JS 渲染时间）
    await page.waitForTimeout(3000);

    // 2. 填入账号密码 - 使用通用、稳定的选择器（不依赖 ref）
    console.log('[2/5] 填入用户名和密码...');

    // 用户名：优先 placeholder，其次 name，最后 type
    let usernameFilled = false;
    const usernameSelectors = [
      'input[placeholder="用户名或电子邮件"]',
      'input[placeholder*="用户名"]',
      'input[name="username"]',
      'input[type="text"]:not([type="hidden"])',
      'input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"])',
    ];

    for (const selector of usernameSelectors) {
      try {
        await page.waitForSelector(selector, { state: 'visible', timeout: 8000 });
        await page.fill(selector, USERNAME, { timeout: 5000 });
        console.log(`    ✅ 用户名已填入 (${selector})`);
        usernameFilled = true;
        break;
      } catch (e) {
        // 尝试下一个选择器
      }
    }

    if (!usernameFilled) {
      console.error('    ❌ 无法填入用户名：所有选择器均失败');
      await browser.close();
      process.exit(1);
    }

    // 密码：优先 placeholder，其次 type=password
    let passwordFilled = false;
    const passwordSelectors = [
      'input[placeholder="密码"]',
      'input[type="password"]',
      'input[name="password"]',
    ];

    for (const selector of passwordSelectors) {
      try {
        await page.waitForSelector(selector, { state: 'visible', timeout: 8000 });
        await page.fill(selector, PASSWORD, { timeout: 5000 });
        console.log(`    ✅ 密码已填入 (${selector})`);
        passwordFilled = true;
        break;
      } catch (e) {
        // 尝试下一个选择器
      }
    }

    if (!passwordFilled) {
      console.error('    ❌ 无法填入密码：所有选择器均失败');
      await browser.close();
      process.exit(1);
    }

    // 3. 勾选同意条款 - 使用多层级备选选择器
    console.log('[2.5/5] 勾选同意条款...');
    let checkboxChecked = false;

    // 方案 1：role 选择器（最语义化、最稳定）
    try {
      const checkbox = page.getByRole('checkbox', { name: /我已阅读并同意/ });
      await checkbox.waitFor({ state: 'visible', timeout: 15000 });
      await checkbox.check({ force: true });
      console.log('    ✅ 已勾选同意条款 (role: checkbox + name)');
      checkboxChecked = true;
    } catch (e) {
      // 方案 2：label 文本关联的 checkbox
      try {
        const checkbox = page.locator('label:has-text("我已阅读并同意") >> input[type="checkbox"]');
        await checkbox.waitFor({ state: 'visible', timeout: 10000 });
        await checkbox.check({ force: true });
        console.log('    ✅ 已勾选同意条款 (label 关联)');
        checkboxChecked = true;
      } catch (e2) {
        // 方案 3：页面上唯一的 checkbox（通常就是同意条款）
        try {
          const checkbox = page.locator('input[type="checkbox"]').first();
          await checkbox.waitFor({ state: 'visible', timeout: 10000 });
          await checkbox.check({ force: true });
          console.log('    ✅ 已勾选同意条款 (首个 checkbox)');
          checkboxChecked = true;
        } catch (e3) {
          // 方案 4：通过 evaluate 直接操作 DOM（最后手段）
          try {
            await page.evaluate(() => {
              const checkboxes = document.querySelectorAll('input[type="checkbox"]');
              for (const cb of checkboxes) {
                if (!cb.checked) {
                  cb.click();
                  return true;
                }
              }
              return false;
            });
            console.log('    ✅ 已勾选同意条款 (evaluate 强制点击)');
            checkboxChecked = true;
          } catch (e4) {
            console.warn('    ⚠️ 勾选同意条款失败，继续尝试登录:', e4.message);
          }
        }
      }
    }

    // 给勾选后的 UI 状态更新一点时间
    await page.waitForTimeout(1000);

    // 4. 处理 Cloudflare 验证（如果出现）
    console.log('[2.6/5] 检查 Cloudflare 验证...');
    try {
      // 检查是否存在 Cloudflare iframe（常见 title）
      const cfIframe = page.frameLocator('iframe[title*="Cloudflare"], iframe[title*="challenge"], iframe[title*="验证"]');
      await cfIframe.locator('input[type="checkbox"], button:has-text("验证"), button:has-text("Verify")').first().waitFor({ state: 'visible', timeout: 5000 });
      console.log('    检测到 Cloudflare 验证，尝试处理...');

      // 尝试在 iframe 中点击验证按钮/复选框
      await cfIframe.locator('input[type="checkbox"]').first().check({ force: true, timeout: 5000 }).catch(() => {});
      await cfIframe.locator('button:has-text("验证"), button:has-text("Verify"), button:has-text("我是人类")').first().click({ force: true, timeout: 5000 }).catch(() => {});

      // 等待验证完成
      await page.waitForTimeout(5000);
      console.log('    ✅ Cloudflare 验证处理尝试完成');
    } catch (e) {
      console.log('    未检测到 Cloudflare 验证，或已通过');
    }

    // 5. 提交表单 - 查找并点击登录按钮
    console.log('[2.7/5] 查找并点击登录按钮...');
    let loginClicked = false;

    const loginButtonSelectors = [
      'button[type="submit"]',
      'button:has-text("登录")',
      'button:has-text("登 录")',
      'button:has-text("登  录")',
      'button:has-text("Sign in")',
      'button:has-text("Sign In")',
      'input[type="submit"]',
      'button:not([disabled]):visible',
      'button', // 最后兜底：页面上第一个可见的 button
    ];

    for (const selector of loginButtonSelectors) {
      try {
        const btn = page.locator(selector).first();
        await btn.waitFor({ state: 'visible', timeout: 8000 });

        // 检查是否禁用
        const isDisabled = await btn.isDisabled();
        if (isDisabled) {
          console.log(`    ⏳ 按钮 ${selector} 当前禁用，等待启用...`);
          await page.waitForFunction((sel) => {
            const el = document.querySelector(sel);
            return el && !el.disabled;
          }, selector, { timeout: 30000 });
        }

        await btn.click({ force: true, timeout: 5000 });
        console.log(`    ✅ 登录按钮已点击 (${selector})`);
        loginClicked = true;
        break;
      } catch (e) {
        // 尝试下一个选择器
      }
    }

    if (!loginClicked) {
      // 最后尝试：按 Enter 键提交表单
      try {
        await page.keyboard.press('Enter');
        console.log('    ✅ 已按 Enter 键提交表单');
        loginClicked = true;
      } catch (e) {
        console.error('    ❌ 无法找到或点击登录按钮，且 Enter 提交失败');
        await browser.close();
        process.exit(1);
      }
    }

    // 6. 等待登录成功（等待 /api/user/self 返回 200 或页面跳转）
    console.log('[3/5] 等待登录验证...');
    let loginSuccess = false;

    try {
      // 方式 1：监听 /api/user/self 请求成功
      await page.waitForResponse(async (resp) => {
        return resp.url().includes('/api/user/self') && resp.status() === 200;
      }, { timeout: 15000 });
      console.log('    ✅ 登录成功（/api/user/self 返回 200）');
      loginSuccess = true;
    } catch (e) {
      // 方式 2：检查是否跳转离开登录页
      try {
        await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 10000 });
        console.log('    ✅ 登录成功（页面已跳转离开登录页）');
        loginSuccess = true;
      } catch (e2) {
        // 方式 3：直接请求 /api/user/self 验证
        try {
          const testResp = await page.goto(SELF_URL, { waitUntil: 'networkidle', timeout: 10000 });
          if (testResp && testResp.status() === 200) {
            console.log('    ✅ 登录成功（直接访问 /api/user/self 返回 200）');
            loginSuccess = true;
          }
        } catch (e3) {
          console.error('    ❌ 登录失败，可能验证码挑战或账号密码错误');
          await browser.close();
          process.exit(1);
        }
      }
    }

    if (!loginSuccess) {
      console.error('    ❌ 未能验证登录成功');
      await browser.close();
      process.exit(1);
    }

    // 7. 保存 storageState 供下次使用
    console.log('[4/5] 保存登录状态，供下次使用...');
    const fs = await import('fs');
    if (!fs.existsSync('.playwright')) {
      fs.mkdirSync('.playwright', { recursive: true });
    }
    
    // 关键步骤：在保存 storageState 前，访问关键路径确保所有 cookies 都被捕获
    // new_api_refresh 通常在 /api/user/auth 设置，new_api_has_session 在根路径
    // 但有时需要多次尝试或更长的等待时间
    console.log('[DEBUG] Attempting to capture all cookies before storageState save...');
    
    // 尝试多次访问以确保 cookies 被设置
    for (let i = 0; i < 3; i++) {
      await page.goto(`${BASE}/api/user/auth`, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page.goto(BASE, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    
    // 保存 storageState - 应该包含所有 3 个 cookie
    await context.storageState({ path: '.playwright/storageState.json' });
    console.log('    ✅ 状态已保存到 .playwright/storageState.json');

    // 读取并显示storageState内容用于调试
    const storageState = JSON.parse(fs.readFileSync('.playwright/storageState.json', 'utf8'));
    console.log('[DEBUG] storageState contents:');
    console.log(JSON.stringify(storageState, null, 2));

    // 8. 获取登录后的 cookies (打印详细信息)
    cookies = await context.cookies();
    console.log('[DEBUG] Retrieved cookies after login:');
    cookies.forEach(c => {
      console.log(`    ${c.name}=${c.value} (domain: ${c.domain}, path: ${c.path}, httpOnly: ${c.httpOnly}, secure: ${c.secure}, expires: ${c.expires}, sameSite: ${c.sameSite})`);
    });
    
    // 同时获取所有可用的cookies（包括可能被过滤掉的）
    const allCookies = await context.cookies();
    console.log('[DEBUG] All cookies count:', allCookies.length);

    // --- 第三步：使用新获取的 cookies 进行签到 ---
    console.log('[5/5] 使用新登录会话进行签到...');
    const checkinResp = await fetch(CHECKIN_URL, {
      method: 'POST',
      headers: {
        'Host': HOST,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
        'Cookie': cookies.map(c => `${c.name}=${c.value}`).join('; ') || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const checkinText = await checkinResp.text();
    let checkinData;
    try { checkinData = JSON.parse(checkinText); } catch { checkinData = { raw: checkinText }; }

    console.log('[INFO] Check-in response:', JSON.stringify(checkinData).slice(0, 200));

    // 处理签到结果
    const success = checkinData?.success === true;
    const message = checkinData?.message || '';
    const isAlready = !success &&
      (message.includes('今日已签到') ||
       message.includes('已经签到') ||
       message.toLowerCase().includes('already'));

    if (checkinResp.ok && success) {
      const quota = checkinData?.data?.quota_awarded;
      const date = checkinData?.data?.checkin_date;
      const extra = quota !== undefined ? ` | 获得额度: ${quota}` : '';
      const dateStr = date ? ` | 日期: ${date}` : '';
      console.log(`[SUCCESS] 签到成功${dateStr}${extra}`);
      process.exit(0);
    } else if (checkinResp.ok && isAlready) {
      console.log(`[INFO] 已签到: ${message || '今日已签到'}`);
      process.exit(0);
    } else {
      console.error(`[FAIL] 签到失败: ${message || checkinText || `HTTP ${checkinResp.status}`}`);
      process.exit(1);
    }

    await browser.close();
  }
})().catch(err => {
  console.error('[ERROR] 脚本异常:', err);
  process.exit(1);
});