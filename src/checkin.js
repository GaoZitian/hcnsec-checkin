/**
 * HCNSec 每日签到脚本
 * 功能：
 *   1. 优先使用已保存的 Playwright storageState（Cookie + localStorage）
 *   2. 如果没有保存的状态，使用 GitHub Secrets 里的账号密码自动登录
 *   3. 登录成功后保存 storageState，供下次使用
 *   4. 使用保持有效会话的 Cookie 进行签到
 *
 * 环境变量（GitHub Secrets 或本地 .env）：
 *   HCNSEC_USERNAME / HCNSEC_PASSWORD   — 用于首次登录/重新登录
 *   HCNSEC_NEW_API_USER                 — 登录后提取的 new-api-user 值（登录脚本会自动探测）
 *
 * 输出：
 *   - 签到成功 / 已签到 / 失败，并返回相应 exit code
 */

import fetch from 'node-fetch';
import { chromium } from 'playwright';
import * as dotenv from 'dotenv';

// 加载 .env（GitHub Actions 中会自动将 secrets 注入为环境变量）
dotenv.config();

// ──────────────────────────────────────────────────────────────
// 1. 配置
// ──────────────────────────────────────────────────────────────
const HOST = 'api.hcnsec.cn';
const BASE = `https://${HOST}`;
const SELF_URL = `${BASE}/api/user/self`;
const CHECKIN_URL = `${BASE}/api/user/checkin`;

// 必要的 env 检查
const USERNAME = process.env.HCNSEC_USERNAME;
const PASSWORD = process.env.HCNSEC_PASSWORD;
const NEW_API_USER = process.env.HCNSEC_NEW_API_USER; // 可选，如果有则直接用

if (!USERNAME || !PASSWORD) {
  console.error('[FATAL] 缺少 HCNSEC_USERNAME / HCNSEC_PASSWORD 环境变量');
  console.error('请在 GitHub Repository Settings → Secrets → Actions 中添加这两个 secret。');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────
// 2. 主要逻辑
// ──────────────────────────────────────────────────────────────
(async () => {
  console.log('[INFO] HCNSec daily check-in starting...');

  // --- 第一步：尝试恢复已保存的登录态 ---
  let authFailed = false;
  let cookies = [];
  let newApiUserValue = null;

  try {
    // Playwright 会自动查找 ./.playwright/storageState.json（相对于运行工作目录）
    // 如果存在，chromium launch 时会自动注入 Cookie + Storage
    console.log('[INFO] 尝试恢存已保存的登录态...');
    
    // 启动浏览器并携带 storageState
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: '.playwright/storageState.json',
    });
    const page = await context.newPage();

    // 直接访问受保护的 API（无需再次登录）
    const resp = await page.goto(SELF_URL, { waitUntil: 'networkidle' });
    if (resp && resp.status() === 200) {
      const data = await page.evaluate(() => {
        // 在页面上下文中获取 JSON（实际可能需要通过 API 响应捕获）
        // 这里简化处理：直接尝试 fetch 一次验证
        return 'session_valid';
      });
      console.log('[INFO] 已成功恢复登录态（storageState 有效）');

      // 获取当前的 cookies
      cookies = await context.cookies();
      
      // 从 cookies 里找 new-api-user
      for (const c of cookies) {
        if (c.name === 'new-api-user' || c.name === 'NEW_API_USER') {
          newApiUserValue = c.value;
          break;
        }
      }

      if (!newApiUserValue) {
        console.warn('[WARN] 未在 cookies 中找到 new-api-user，将尝试从响应头/body 中解析');
      }

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
          // 如果有 new-api-user header 就加上
          ...(newApiUserValue ? { 'new-api-user': newApiUserValue } : {}),
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

  // --- 第二步：如果已保存的态失效，使用账号密码自动登录 ---
  if (authFailed) {
    console.log('[INFO] 开始使用账号密码自动登录...');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // 1. 打开登录页
    console.log('[1/5] 打开登录页...');
    await page.goto('https://api.hcnsec.cn/login', { waitUntil: 'networkidle' });

    // 2. 填入账号密码
    console.log('[2/5] 填入用户名和密码...');
    // 这里使用通用的输入选择器，实际站点可能需要调整
    await page.fill('input[placeholder*="username"] || input[placeholder*="user"] || input[name="username"]', USERNAME);
    await page.fill('input[type="password"]', PASSWORD);

    // 3. 点击登录
    console.log('[3/5] 点击登录...');
    const [request] = await Promise.all([
      page.waitForRequest(req => req.url().includes('/api/user/self') && req.method() === 'GET'),
      await page.click('button:has-text("登录") || input[type="submit"]')
    ]);

    // 4. 等待登录成功（等待 /api/user/self 返回 200）
    console.log('[4/5] 等待登录验证...');
    try {
      await page.waitForResponse(async (resp) => {
        return resp.url().includes('/api/user/self') && resp.status() === 200;
      }, { timeout: 15000 });
      console.log('    ✅ 登录成功（/api/user/self 返回 200）');
    } catch (e) {
      console.error('    ❌ 登录失败，可能验证码挑战或账号密码错误');
      await browser.close();
      process.exit(1);
    }

    // 5. 保存 storageState 供下次使用
    console.log('[5/5] 保存登录状态，供下次使用...');
    await context.storageState({ path: '.playwright/storageState.json' });
    console.log('    ✅ 状态已保存到 .playwright/storageState.json');

    // 获取登录后的 cookies
    cookies = await context.cookies();

    // 尝试从 cookies 或响应中提取 new-api-user
    for (const c of cookies) {
      if (c.name === 'new-api-user' || c.name === 'NEW_API_USER') {
        newApiUserValue = c.value;
        break;
      }
    }
    if (!newApiUserValue) {
      // 备用：尝试从 /api/user/self 的响应中解析（此处省略复杂解析，实际可通过 page.content() 获取）
      console.warn('    ⚠️ 未自动探测到 new-api-user，将尝试使用已保存的状态或手动提供');
    }

    // --- 第三步：使用新获取的 cookies 进行签到 ---
    console.log('[INFO] 使用新登录会话进行签到...');
    const checkinResp = await fetch(CHECKIN_URL, {
      method: 'POST',
      headers: {
        'Host': HOST,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
        'Cookie': cookies.map(c => `${c.name}=${c.value}`).join('; ') || '',
        'Content-Type': 'application/json',
        ...(newApiUserValue ? { 'new-api-user': newApiUserValue } : {}),
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
  }
})().catch(err => {
  console.error('[ERROR] 脚本异常:', err);
  process.exit(1);
});