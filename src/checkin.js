/**
 * HCNSec 每日签到脚本 - 生产版（支持 storageState 预加载）
 * 
 * 运行模式：
 * 1. GitHub Actions: 从 HCNSEC_STORAGE_STATE 环境变量加载预生成的浏览器状态（无需 Turnstile）
 * 2. 本地开发: 无环境变量时，打开可见浏览器手动登录，保存状态到 state.json
 * 
 * 鉴权机制：
 *   1. 登录接口 /api/user/login 需要 username, password, cloudflare_token
 *   2. access_token 只在响应体里，不进 localStorage、不进 cookie
 *   3. 签到接口 /api/user/checkin 用 Authorization: Bearer *** 鉴权
 * 
 * 环境变量：
 *   HCNSEC_USERNAME / HCNSEC_PASSWORD - 必填
 *   HCNSEC_STORAGE_STATE - 可选，base64 编码的 storageState JSON（GitHub Actions 使用）
 */
import { chromium } from 'playwright';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

dotenv.config();

const HOST = 'api.hcnsec.cn';
const BASE = `https://${HOST}`;
const LOGIN_PAGE = `${BASE}/login`;
const LOGIN_URL = `${BASE}/api/user/login`;
const REFRESH_URL = `${BASE}/api/user/auth/refresh`;
const CHECKIN_URL = `${BASE}/api/user/checkin`;
const SELF_URL = `${BASE}/api/user/self`;
const STATE_FILE = 'state.json';

const USERNAME = process.env.HCNSEC_USERNAME;
const PASSWORD = process.env.HCNSEC_PASSWORD;
// 预生成的 storageState (base64 编码)，GitHub Actions 中通过 Secret 注入
const STORAGE_STATE_B64 = process.env.HCNSEC_STORAGE_STATE;

if (!USERNAME || !PASSWORD) {
  console.error('[FATAL] 缺少 HCNSEC_USERNAME / HCNSEC_PASSWORD 环境变量');
  process.exit(1);
}

function extractTokenFromResponse(body) {
  if (!body) return '';
  const data = body.data || {};
  if (data.access_token || data.accessToken || data.token) {
    return data.access_token || data.accessToken || data.token;
  }
  return body.access_token || body.accessToken || body.token || '';
}

/**
 * 从 base64 解码 storageState */
function loadStorageStateFromEnv() {
  if (!STORAGE_STATE_B64) return null;
  try {
    // 增加 trim() 防止复制时带入空格或换行
    const json = Buffer.from(STORAGE_STATE_B64.trim(), 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch (e) {
    console.error('[FATAL] HCNSEC_STORAGE_STATE 格式错误:');
    console.error('    - 请确保你复制的是纯 Base64 字符串');
    console.error('    - 错误详情:', e.message);
    if (process.env.GITHUB_ACTIONS === 'true') process.exit(1); // CI环境下直接退出，防止后续崩溃
    return null;
  }
}

/**
 * 保存 storageState 到文件（本地开发用） */
async function saveStorageState(context) {
  await context.storageState({ path: STATE_FILE });
  console.log(`    ✅ 登录状态已保存到 ${STATE_FILE}`);
}

async function checkin() {
  console.log('[INFO] HCNSec daily check-in starting...');

  // 尝试从环境变量加载预生成的 storageState
  const storageState = loadStorageStateFromEnv();
  const hasPreloadedState = !!storageState;

  let browser, context;

  if (hasPreloadedState) {
    // === 模式 1：GitHub Actions - 使用预生成的 storageState ===
    console.log('[1/4] 加载预生成的登录状态...');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    context = await browser.newContext({ storageState });
    console.log('    ✅ 状态加载成功，跳过 Turnstile 验证');
  } else {
    // === 模式 2：本地开发 - 打开可见浏览器手动登录 ===
    console.log('[1/4] 启动可见浏览器进行手动登录...');
    if (!fs.existsSync(STATE_FILE)) {
      const isCI = process.env.GITHUB_ACTIONS === 'true';
      if (isCI) {
        console.error('[FATAL] 远程 CI 环境禁止启动可见浏览器。');
        console.error('    原因：未检测到有效的 HCNSEC_STORAGE_STATE 或状态加载失败。');
        console.error('    请检查 GitHub Secrets 中是否正确配置了 Base64 编码的状态字符串。');
        process.exit(1);
      }
      browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      context = await browser.newContext();
      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 720 });

      try {
        console.log('[2/4] 访问登录页...');
        await page.goto(LOGIN_PAGE, { waitUntil: 'domcontentloaded' });

        console.log('[3/4] 填写用户名和密码...');
        await page.fill('input[name="username"]', USERNAME);
        await page.fill('input[name="password"]', PASSWORD);

        // 勾选协议 checkbox（可能被 aria-hidden / 视口外，直接用 JS 勾选更稳）
        await page.evaluate(() => {
          const boxes = document.querySelectorAll('input[type="checkbox"]');
          boxes.forEach(b => { b.checked = true; b.scrollIntoView(); b.click(); });
        });

        console.log('[4/4] 请在浏览器中完成 Turnstile 验证并点击登录...');
        console.log('    (最多等待 5 分钟，登录成功后脚本会自动保存状态并退出)');

        // 等待登录成功：URL 离开 /login 或出现用户信息元素
        await page.waitForFunction(() => {
          const url = window.location.href;
          return !url.includes('/login') || document.querySelector('.user-info, .avatar, [data-user]') !== null;
        }, { timeout: 300000 });

        console.log('    ✅ 检测到登录成功');
        await saveStorageState(context);
      } catch (err) {
        console.error('[ERROR] 手动登录失败:', err?.message || err);
        process.exit(1);
      } finally {
        await browser.close();
        return; // 首次运行退出，下次使用保存的 state.json
      }
    } else {
      // 有本地 state.json，直接加载
      console.log('[1/4] 加载本地保存的登录状态...');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      context = await browser.newContext({ storageState: STATE_FILE });
      console.log('    ✅ 本地状态加载成功');
    }
  }

  // === 通用签到流程（使用已加载的 storageState）===
  const page = await context.newPage();

  try {
    console.log('[2/4] 验证登录状态...');
    const selfResponse = await context.request.get(`${BASE}/api/user/self`, {
      headers: { Accept: 'application/json, text/plain, */*' }
    });

    if (selfResponse.status() !== 200) {
      console.error('    ❌ 登录状态已失效');
      if (!hasPreloadedState) {
        console.log('    请删除 state.json 后重新运行');
      } else {
        console.log('    请重新生成 HCNSEC_STORAGE_STATE');
      }
      process.exit(1);
    }
    console.log('    ✅ 登录状态有效');

    console.log('[3/4] 获取 access_token...');
    const refreshResponse = await context.request.post(`${BASE}/api/user/auth/refresh`, {
      headers: { Accept: 'application/json, text/plain, */*' }
    });

    let refreshData = {};
    try { refreshData = await refreshResponse.json(); }
    catch (e) { refreshData = { raw: await refreshResponse.text() } };

    if (refreshData.success !== true) {
      console.error(`    ❌ 获取 access_token 失败: ${refreshData?.message || '未知错误'}`);
      process.exit(1);
    }

    const accessToken = extractTokenFromResponse(refreshData);
    console.log(`    ✅ 获得 access_token (长度: ${accessToken.length})`);

    console.log('[4/4] 执行签到...');
    const checkinResponse = await context.request.post(`${BASE}/api/user/checkin`, {
      data: {},
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': `Bearer ${accessToken}`
      }
    });

    let checkinData;
    try {
      checkinData = await checkinResponse.json();
    } catch {
      checkinData = { raw: await checkinResponse.text() };
    }
    console.log(`    签到响应: status=${checkinResponse.status()}`);

    // 处理结果
    const success = checkinData?.success === true;
    const message = checkinData?.message || '';
    const isAlready = !success && (
      message.includes('今日已签到') || message.includes('已经签到') ||
      message.toLowerCase().includes('already')
    );

    if (success) {
      const quota = checkinData?.data?.quota_awarded;
      const date = checkinData?.data?.checkin_date;
      const extra = quota !== undefined ? ` | 获得额度: ${quota}` : '';
      const dateStr = date ? ` | 日期: ${date}` : '';
      console.log(`[SUCCESS] 签到成功${dateStr}${extra}`);
      process.exit(0);
    } else if (isAlready) {
      console.log(`[INFO] 已签到: ${message}`);
      process.exit(0);
    } else {
      console.error(`[FAIL] 签到失败: ${message}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('[ERROR] 签到过程出错:', err?.message || err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

checkin();