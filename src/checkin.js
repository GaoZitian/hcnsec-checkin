/**
 * HCNSec 每日签到脚本
 *
 * 鉴权机制（已实测确认）：
 *   - 站点是 NewAPI（one-api 分支），签到接口 /api/user/checkin 用
 *     Authorization: Bearer <access_token> 鉴权，不认 Cookie。
 *   - access_token 不在 localStorage、也不在 cookie 里，
 *     它只在 /api/user/login 或 /api/user/auth/refresh 的**响应体**里。
 *   - 之前版本点按钮走 UI 登录，但按钮匹配到兜底选择器、从未真正发出
 *     POST /api/user/login，导致全程空会话，签到必然 AUTH_UNAUTHORIZED。
 *
 * 新策略：不再点按钮，直接调用登录 API。
 *   1. 打开站点首页（通过 Cloudflare、拿到 cf cookies）
 *   2. context.request.post(/api/user/login) 直接登录 → 拿 access_token
 *   3. 若登录响应没带 token，再 post(/api/user/auth/refresh) 换 token
 *      （登录时下发的 new_api_refresh cookie 已由 context 自动携带）
 *   4. context.request.post(/api/user/checkin) + Authorization: Bearer <token>
 *
 * 环境变量：HCNSEC_USERNAME / HCNSEC_PASSWORD
 */
import { chromium } from 'playwright';
import * as dotenv from 'dotenv';

dotenv.config();

const HOST = 'api.hcnsec.cn';
const BASE = `https://${HOST}`;
const LOGIN_URL = `${BASE}/api/user/login`;
const REFRESH_URL = `${BASE}/api/user/auth/refresh`;
const CHECKIN_URL = `${BASE}/api/user/checkin`;
const SELF_URL = `${BASE}/api/user/self`;

const USERNAME = process.env.HCNSEC_USERNAME;
const PASSWORD = process.env.HCNSEC_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('[FATAL] 缺少 HCNSEC_USERNAME / HCNSEC_PASSWORD 环境变量');
  console.error('请在 GitHub Repository Settings → Secrets → Actions 中添加这两个 secret。');
  process.exit(1);
}

/* 从响应体里提取 token（兼容多种 key 名） */
function extractToken(body) {
  if (!body) return '';
  const d = body.data || {};
  return (
    d.access_token || d.accessToken || d.token ||
    body.access_token || body.accessToken || body.token || ''
  );
}

async function checkin() {
  console.log('[INFO] HCNSec daily check-in starting...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  try {
    // ── 第一步：打开首页，通过 Cloudflare 拿到 cf cookies ──
    console.log('[1/5] 打开站点首页（通过 Cloudflare）...');
    let homeOk = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForTimeout(2000);
        homeOk = true;
        console.log(`    ✅ 首页加载成功 (尝试 ${attempt}/2)`);
        break;
      } catch (e) {
        console.warn(`[WARN] 首页加载失败 (尝试 ${attempt}/2): ${e.message}`);
        await page.waitForTimeout(3000);
      }
    }
    if (!homeOk) {
      console.error('    ❌ 首页加载失败');
      process.exit(1);
    }

    // ── 第二步：直接调用登录 API（不点按钮）──
    console.log('[2/5] 调用登录 API...');
    const loginResp = await context.request.post(LOGIN_URL, {
      data: { username: USERNAME, password: PASSWORD },
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: 60000,
    });
    const loginStatus = loginResp.status();
    console.log(`    登录响应 status=${loginStatus}`);
    let loginBody = null;
    try { loginBody = await loginResp.json(); } catch {}

    const loginCode = loginBody?.code || loginBody?.data?.code || '';
    console.log(`    success=${loginBody?.success} code=${loginCode} message=${loginBody?.message || ''}`);

    if (loginStatus !== 200 || loginBody?.success !== true) {
      console.error(`    ❌ 登录失败 (status=${loginStatus}, code=${loginCode}, message=${loginBody?.message || '无'})`);
      process.exit(1);
    }
    console.log('    ✅ 登录 API 成功');

    // ── 第三步：取 token ──
    console.log('[3/5] 获取 access_token...');
    let accessToken = extractToken(loginBody);

    if (!accessToken) {
      // 登录响应没带 token → 用 new_api_refresh cookie 换（cookie 已由 context 自动携带）
      console.log('    登录响应未带 token，调用 refresh 端点换取...');
      try {
        const refreshResp = await context.request.post(REFRESH_URL, {
          headers: { 'Accept': 'application/json, text/plain, */*' },
          timeout: 30000,
        });
        const refreshStatus = refreshResp.status();
        let refreshBody = null;
        try { refreshBody = await refreshResp.json(); } catch {}
        const rCode = refreshBody?.code || refreshBody?.data?.code || '';
        console.log(`    refresh 响应 status=${refreshStatus} success=${refreshBody?.success} code=${rCode}`);
        accessToken = extractToken(refreshBody);
        if (refreshBody?.success === true && !accessToken) {
          console.log('    [DEBUG] refresh success 但未找到 token 字段，响应顶层 keys=', Object.keys(refreshBody || {}));
        }
      } catch (e) {
        console.error(`    ❌ refresh 调用失败: ${e.message}`);
      }
    }

    if (!accessToken) {
      console.error('    ❌ 未获取到 access_token，无法签到');
      process.exit(1);
    }
    console.log(`    ✅ access_token 已获取 (len=${accessToken.length})`);

    // 验证 token 有效（增强可观测性）
    try {
      const selfResp = await context.request.get(SELF_URL, {
        headers: { Authorization: 'Bearer ' + accessToken },
        timeout: 20000,
      });
      console.log(`    [校验] /api/user/self status=${selfResp.status()}`);
    } catch {}

    // ── 第四步：签到 ──
    console.log('[4/5] 发送签到请求...');
    const checkinResp = await context.request.post(CHECKIN_URL, {
      data: {},
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Authorization': 'Bearer ' + accessToken,
      },
      timeout: 60000,
    });
    const checkinStatus = checkinResp.status();
    let checkinData = null;
    try { checkinData = await checkinResp.json(); }
    catch { checkinData = { raw: await checkinResp.text().catch(() => '') }; }

    console.log(`[INFO] Check-in response status=${checkinStatus}: ${JSON.stringify(checkinData).slice(0, 250)}`);

    // ── 第五步：处理结果 ──
    console.log('[5/5] 处理结果...');
    const success = checkinData?.success === true;
    const message = checkinData?.message || '';
    const code = checkinData?.code || '';
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
      console.log(`[INFO] 已签到: ${message || '今日已签到'}`);
      process.exit(0);
    } else {
      console.error(`[FAIL] 签到失败: ${message || code || JSON.stringify(checkinData)}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('[ERROR] 脚本异常:', err?.message || err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

checkin();
