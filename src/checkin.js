/**
 * HCNSec 每日签到脚本 - 极速诊断增强版
 */

console.log('====================================================');
console.log('[DEBUG] [Step 0] Node.js 进程已启动，进入诊断模式...');
console.log('====================================================');

process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] 捕捉到未处理的异常 (uncaughtException):');
  console.error(err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL] 捕捉到未处理的 Promise 拒绝 (unhandledRejection):');
  console.error(reason);
  process.exit(1);
});

async function run() {
  try {
    console.log('[DEBUG] [Step 1] 尝试加载依赖模块...');
    const { chromium } = await import('playwright');
    const dotenv = await import('dotenv');
    const fs = await import('fs');
    console.log('[DEBUG] [Step 2] 依赖加载成功');

    dotenv.config();

    const HOST = 'api.hcnsec.cn';
    const BASE = `https://${HOST}`;
    const LOGIN_PAGE = `${BASE}/login`;
    const STATE_FILE = 'state.json';
    const USERNAME = process.env.HCNSEC_USERNAME;
    const PASSWORD = process.env.HCNSEC_PASSWORD;
    const STORAGE_STATE_B64 = process.env.HCNSEC_STORAGE_STATE;

    if (!USERNAME || !PASSWORD) {
      console.error('[FATAL] 缺少 HCNSEC_USERNAME / HCNSEC_PASSWORD 环境变量');
      process.exit(1);
    }

    console.log('[INFO] HCNSec daily check-in starting...');

    let storageState = null;
    if (STORAGE_STATE_B64) {
      try {
        console.log('[1/4] 解码预生成的登录状态...');
        const json = Buffer.from(STORAGE_STATE_B64.trim(), 'base64').toString('utf-8');
        storageState = JSON.parse(json);
        console.log('    ✅ 状态解码成功');
      } catch (e) {
        console.error('[FATAL] HCNSEC_STORAGE_STATE 格式错误:', e.message);
        process.exit(1);
      }
    }

    let browser, context;
    if (storageState) {
      console.log('[2/4] 启动浏览器并加载状态...');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      context = await browser.newContext({ storageState });
    } else {
      if (process.env.GITHUB_ACTIONS === 'true') {
        console.error('[FATAL] 远程环境缺失有效状态，无法继续。请更新 HCNSEC_STORAGE_STATE');
        process.exit(1);
      }
      console.log('[1/4] 本地模式：启动可见浏览器...');
      browser = await chromium.launch({ headless: false });
      context = await browser.newContext();
    }

    const page = await context.newPage();
    console.log('[3/4] 验证登录状态...');
    const selfResponse = await context.request.get(`${BASE}/api/user/self`);
    
    if (selfResponse.status() !== 200) {
      console.error('    ❌ 登录状态已失效');
      process.exit(1);
    }
    console.log('    ✅ 登录状态有效');

    console.log('[4/4] 执行签到...');
    const refreshResponse = await context.request.post(`${BASE}/api/user/auth/refresh`);
    const refreshData = await refreshResponse.json();
    const accessToken = refreshData.data?.access_token || refreshData.access_token || '';

    const checkinResponse = await context.request.post(`${BASE}/api/user/checkin`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const checkinData = await checkinResponse.json();
    
    if (checkinData.success) {
      console.log(`[SUCCESS] 签到成功: ${checkinData.message}`);
    } else {
      console.log(`[INFO] 签到结果: ${checkinData.message}`);
    }
    
    await browser.close();
    process.exit(0);

  } catch (err) {
    console.error('[CRITICAL] 运行过程中发生致命错误:');
    console.error(err);
    process.exit(1);
  }
}

run();
