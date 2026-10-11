/**
 * HCNSec 每日签到脚本
 * 核心策略：始终使用 GitHub Secrets 中的账号密码进行完整登录，
 * 确保每日签到都有有效的认证 Cookie，不依赖不完整的 storageState 缓存。
 *
 * 环境变量（GitHub Secrets 或本地 .env）：
 *   HCNSEC_USERNAME / HCNSEC_PASSWORD   — 用于自动登录
 *
 * 签到流程：
 *   1. 用 HCNSEC_USERNAME/HCNSEC_PASSWORD 打开登录页并填入表单
 *   2. 勾选同意条款，处理 Cloudflare Turnstile 验证
 *   3. 点击登录按钮，等待登录成功（/api/user/self 返回 200 或页面跳转）
 *   4. 使用 Playwright page.request.post 自动携带所有有效 Cookie 进行签到
 *   5. 输出签到结果：成功 / 已签到 / 失败
 *
 * 输出：
 *   - 签到成功 / 已签到 / 失败，并返回相应 exit code
 */
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

const USERNAME = process.env.HCNSEC_USERNAME;
const PASSWORD = process.env.HCNSEC_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('[FATAL] 缺少 HCNSEC_USERNAME / HCNSEC_PASSWORD 环境变量');
  console.error('请在 GitHub Repository Settings → Secrets → Actions 中添加这两个 secret。');
  process.exit(1);
}

/* ────────────────────────────────────────────────────────────── */
/* 2. 主要逻辑 – 始终使用账号密码登录 */
/* ────────────────────────────────────────────────────────────── */
(async () => {
  try {
    console.log('[INFO] HCNSec daily check-in starting...');

  /* --- 第一步：使用账号密码自动登录 --- */
  console.log('[1/5] 使用账号密码自动登录...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 设置更长的默认超时（站点可能有 Cloudflare 延迟）
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  // --- 关键：全局响应监听器捕获登录响应的 Set-Cookie 头 ---
  let capturedLoginCookies = [];
  page.on('response', async response => {
    const url = response.url();
    const setCookie = response.headers()['set-cookie'];
    if (setCookie && url.includes('/login') && response.request().method() === 'POST') {
      // 登录 POST 响应，捕获所有 Set-Cookie
      console.log('[DEBUG LOGIN RESPONSE] Full Set-Cookie headers:', setCookie);
      capturedLoginCookies = setCookie.map(c => c.split(';')[0].trim()).join('; ');
      console.log('[DEBUG] Captured login cookie string:', capturedLoginCookies);
    } else if (setCookie && url.includes('api.hcnsec.cn')) {
      console.log(`[DEBUG RESPONSE] ${url} -> Set-Cookie:`, setCookie);
    }
  });

  // 1. 打开登录页
  console.log('[1.1/5] 打开登录页...');
  try {
    await page.goto('https://api.hcnsec.cn/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.warn('[WARN] 登录页加载超时，尝试继续...', e.message);
  }

  // 等待页面 JS 渲染稳定
  await page.waitForTimeout(3000);

  // 2. 填入用户名 - 使用通用、稳定的选择器（不依赖 ref）
  console.log('[1.2/5] 填入用户名...');
  let usernameFilled = false;
  const usernameSelectors = [
    'input[placeholder=\"用户名或电子邮件\"]',
    'input[placeholder*=\"用户名\"]',
    'input[name=\"username\"]',
    'input[type=\"text\"]:not([type=\"hidden\"])',
    'input:not([type=\"password\"]):not([type=\"hidden\"]):not([type=\"submit\"]):not([type=\"button\"])',
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

  // 3. 填入密码
  console.log('[1.3/5] 填入密码...');
  let passwordFilled = false;
  const passwordSelectors = [
    'input[placeholder=\"密码\"]',
    'input[type=\"password\"]',
    'input[name=\"password\"]',
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

  // 4. 勾选同意条款 - 使用多层级备选选择器
  console.log('[1.4/5] 勾选同意条款...');
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
      const checkbox = page.locator('label:has-text(\"我已阅读并同意\") >> input[type=\"checkbox\"]');
      await checkbox.waitFor({ state: 'visible', timeout: 10000 });
      await checkbox.check({ force: true });
      console.log('    ✅ 已勾选同意条款 (label 关联)');
      checkboxChecked = true;
    } catch (e2) {
          // 方案 3：页面上唯一的 checkbox（通常就是同意条款）
      try {
        const checkbox = page.locator('input[type=\"checkbox\"]').first();
        await checkbox.waitFor({ state: 'visible', timeout: 10000 });
        await checkbox.check({ force: true });
        console.log('    ✅ 已勾选同意条款 (首个 checkbox)');
        checkboxChecked = true;
      } catch (e3) {
            // 方案 4：通过 evaluate 直接操作 DOM（最后手段）
        try {
          await page.evaluate(() => {
            const checkboxes = document.querySelectorAll('input[type=\"checkbox\"]');
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

  // 5. 处理 Cloudflare 验证（如果出现）
  console.log('[1.5/5] 检查 Cloudflare 验证...');
  try {
      // 检查是否存在 Cloudflare iframe（常见 title）
    const cfIframe = page.frameLocator('iframe[title*=\"Cloudflare\"], iframe[title*=\"challenge\"], iframe[title*=\"验证\"]');
      // 尝试查找验证元素是否可见
    const cfVisible = await cfIframe.locator('input[type=\"checkbox\"], button:has-text(\"验证\"), button:has-text(\"Verify\")').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => null);
    if (cfVisible) {
      console.log('    检测到 Cloudflare 验证，尝试处理...');

          // 尝试在 iframe 中点击验证按钮/复选框
      await cfIframe.locator('input[type=\"checkbox\"]').first().check({ force: true, timeout: 5000 }).catch(() => {});
      await cfIframe.locator('button:has-text(\"验证\"), button:has-text(\"Verify\"), button:has-text(\"我是人类\")').first().click({ force: true, timeout: 5000 }).catch(() => {});

          // 等待验证完成
      await page.waitForTimeout(5000);
      console.log('    ✅ Cloudflare 验证处理尝试完成');
    } else {
      console.log('    未检测到 Cloudflare 验证，或已通过');
    }
  } catch (e) {
    console.log('    Cloudflare 验证检查出错:', e.message, '- 继续流程');
  }

  // 6. 提交表单 - 查找并点击登录按钮
  console.log('[1.6/5] 查找并点击登录按钮...');
  let loginClicked = false;

  const loginButtonSelectors = [
    'button[type=\"submit\"]',
    'button:has-text(\"登录\")',
    'button:has-text(\"登 录\")',
    'button:has-text(\"登  录\")',
    'button:has-text(\"Sign in\")',
    'button:has-text(\"Sign In\")',
    'input[type=\"submit\"]',
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

  // --- 关键：拦截登录响应以直接捕获 Set-Cookie headers ---
  let loginResponseCookies = [];
  // 监听所有响应，捕获登录 POST 的 Set-Cookie
  const responseHandler = async (resp) => {
    const url = resp.url();
    if (url.includes('/login') && resp.request().method() === 'POST') {
      const setCookie = resp.headers()['set-cookie'];
      if (setCookie) {
        console.log('[DEBUG LOGIN RESPONSE] Set-Cookie headers captured:', setCookie);
        loginResponseCookies = setCookie;
      }
    }
  };
  page.on('response', responseHandler);

  // 7. 等待登录成功（等待 /api/user/self 返回 200 或页面跳转）
  console.log('[1.7/5] 等待登录验证...');
  let loginSuccess = false;

  try {
      // 方式 1：监听 /api/user/self 请求成功
    await page.waitForResponse(async (resp) => {
      return resp.url().includes('/api/user/self') && resp.status() === 200;
    }, { timeout: 15000 });
    console.log('    ✅ 登录成功（/api/user/self 返回 200）');
    loginSuccess = true;
    // --- 关键：完整的 Cookie 捕获序列 ---
    // 步骤1：等待页面静态，确保所有 Set-Cookie 已处理
    await page.waitForTimeout(3000);
    
    // 步骤2：访问根路径，触发可能的 Cookie 重新评估
    try {
      await page.goto('https://api.hcnsec.cn/', { waitUntil: 'networkidle0', timeout: 15000 });
    } catch (e) {
      // 忽略根路径访问失败
    }
    
    // 步骤3：确认登录有效性
    try {
      await page.goto('https://api.hcnsec.cn/api/user/self', { waitUntil: 'networkidle0', timeout: 15000 });
    } catch (e) {
      // 忽略验证失败
    }
    
    // 步骤4：访问 /api/user/auth 激活 HttpOnly cookie
    try {
      await page.goto('https://api.hcnsec.cn/api/user/auth', { waitUntil: 'networkidle0', timeout: 15000 });
    } catch (e) {
      // 忽略 /api/user/auth 访问失败
    }
    // --- 新增：访问 /api/user/auth 以激活 Cookie path 范围 ---
    // new_api_refresh 的 path=/api/user/auth，通过访问该路径让浏览器将其范围扩大到 /api/user/checkin
    try {
      await page.goto('https://api.hcnsec.cn/api/user/auth', { waitUntil: 'networkidle0', timeout: 10000 })
    } catch (e) {
      // 忽略访问失败，仅作为 Cookie 激活的尝试
    }
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

  // --- 第二步：确保所有认证 Cookie 已存入浏览器上下文 ---
  // 登录后，访问设置关键 Cookie 的路径，以确保它们被浏览器上下文捕获。
  // 即使是 HttpOnly Cookie，也会被 Playwright 的 request 上下文自动携带。
  console.log('[2.5/5] 访问关键路径以捕获所有认证 Cookie...');
  try {
    // 访问 /api/user/auth 以获取 new_api_refresh (path=/api/user/auth, HttpOnly)
    console.log('[DEBUG] Visiting /api/user/auth');
    const authResponse = await page.goto(`${BASE}/api/user/auth`, { waitUntil: 'networkidle', timeout: 10000 });
    if (authResponse) {
      const headers = authResponse.headers();
      console.log(`[DEBUG] /api/user/auth response status:`, authResponse.status());
      // 关键：记录 Set-Cookie headers
      const setCookie = headers['set-cookie'];
      if (setCookie) {
        console.log('[DEBUG] /api/user/auth Set-Cookie headers:', setCookie);
      } else {
        console.log('[DEBUG] /api/user/auth no Set-Cookie headers found');
      }
    }
    await page.waitForTimeout(1000);
    console.log('[DEBUG] Cookies after visiting /api/user/auth:', await page.context().cookies());

    // 访问 首页 / 以获取 new_api_has_session (path=/)
    console.log('[DEBUG] Visiting /');
    const rootResponse = await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 10000 });
    if (rootResponse) {
      const headers = rootResponse.headers();
      console.log(`[DEBUG] / response status:`, rootResponse.status());
      // 关键：记录 Set-Cookie headers
      const setCookie = headers['set-cookie'];
      if (setCookie) {
        console.log('[DEBUG] / Set-Cookie headers:', setCookie);
      } else {
        console.log('[DEBUG] / no Set-Cookie headers found');
      }
    }
    await page.waitForTimeout(1000);
    console.log('[DEBUG] Cookies after visiting /:', await page.context().cookies());

    console.log('    ✅ 已访问 /api/user/auth 和 /');
  } catch (e) {
    console.warn('    ⚠️ 访问关键路径时出错，但继续:', e.message);
  }

  // 可选：调试查看页面可访问的 Cookie（包括 HttpOnly 和非 HttpOnly）
  const allCookies = await page.context().cookies();
  console.log('[DEBUG] All page cookies count:', allCookies.length);
  for (const cookie of allCookies) {
    console.log(`    Cookie: ${cookie.name}=${cookie.value} (domain: ${cookie.domain}, path: ${cookie.path}, httpOnly: ${cookie.httpOnly}, secure: ${cookie.secure})`);
  }

  // 构建包含所有 Cookie 的字符串（包括 HttpOnly）
  let cookieString = '';
  for (const cookie of allCookies) {
    cookieString += `${cookie.name}=${cookie.value}; `;
  }
  cookieString = cookieString.replace(/; $/, '');
  console.log('[DEBUG] Constructed Cookie string for checkin:', cookieString || '(空)');

    // --- 第三步：使用新登录会话进行签到 ---
  // 使用 page.evaluate 发送请求，这样可以确保浏览器上下文中的所有 Cookie（包括 HttpOnly）都被自动携带
  console.log('[3/5] 使用新登录会话进行签到...');
  console.log('[3.1/5] 发送签到请求...');

  // 关键：使用捕获的登录响应 Cookie 手动构建 Cookie 头
  // 如果浏览器上下文没有捕获到 HttpOnly cookie，我们手动补充
  const manualCookieHeader = (typeof capturedLoginCookies !== 'undefined' && capturedLoginCookies) ? capturedLoginCookies : '';
  console.log('[DEBUG] Manual cookie header for checkin:', manualCookieHeader || '(无捕获到的登录响应 Cookie)');

  const checkinText = await page.evaluate(async ({ url, cookieHeader }) => {
    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
      'Content-Type': 'application/json',
    };
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({}),
      credentials: 'include' // 确保发送 Cookie
    });
    return await response.text();
  }, { url: CHECKIN_URL, cookieHeader: manualCookieHeader });

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

  if (success) {
    const quota = checkinData?.data?.quota_awarded;
    const date = checkinData?.data?.checkin_date;
    const extra = quota !== undefined ? ` | 获得额度: ${quota}` : '';
    const dateStr = date ? ` | 日期: ${date}` : '';
    console.log(`[SUCCESS] 签到成功${dateStr}${extra}`);
    await browser.close();
    process.exit(0);
  } else if (isAlready) {
    console.log(`[INFO] 已签到: ${message || '今日已签到'}`);
    await browser.close();
    process.exit(0);
  } else {
    console.error(`[FAIL] 签到失败: ${message || checkinText || '未知错误'}`);
    await browser.close();
    process.exit(1);
  }
} catch (err) { console.error("[ERROR] 脚本异常:", err); process.exit(1); } })()