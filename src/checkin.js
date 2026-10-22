/**
 * HCNSec 每日签到脚本（纯 HTTP 版）
 * 使用 GitHub Secret HCNSEC_API_TOKEN（个人访问令牌 / Bearer token）
 * 无需浏览器、不依赖 Cookie、不绑 IP、长期有效
 */
const TOKEN = (process.env.HCNSEC_API_TOKEN || '').trim();
if (!TOKEN) {
  console.error('[FATAL] 缺少 HCNSEC_API_TOKEN 环境变量');
  console.error('请在 GitHub Repository Settings → Secrets → Actions 中添加 HCNSEC_API_TOKEN。');
  process.exit(1);
}

const BASE = 'https://api.hcnsec.cn';
const H = {
  Accept: 'application/json, text/plain, */*',
  Authorization: `Bearer ${TOKEN}`,
};

console.log('[INFO] HCNSec daily check-in starting... (API token mode)');

// 1) /self 读账户
const r1 = await fetch(`${BASE}/api/user/self`, { headers: H }).catch(e => ({ err: e.message }));
if (!r1.err) {
  const j = await r1.json().catch(() => ({}));
  console.log(`  [1] /self   -> HTTP ${r1.status} ${j.success === false ? j.message : (j.data?.username ? `user=${j.data.username} quota=${j.data?.quota}` : '')}`);
} else console.log(`  [1] /self   -> 网络错误 ${r1.err}`);

// 2) /checkin 签到
const r2 = await fetch(`${BASE}/api/user/checkin`, {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
}).catch(e => ({ err: e.message }));

if (!r2.err) {
  const j = await r2.json().catch(() => ({}));
  const msg = j.message || (j.success ? 'OK' : '');
  console.log(`  [2] /checkin-> HTTP ${r2.status} ${msg}`);
  if (j.success) {
    console.log('\n✅ 签到成功！');
    process.exit(0);
  } else if (msg && /已签到|already/i.test(msg)) {
    console.log('\n✅ 今日已签到。');
    process.exit(0);
  } else {
    console.error('\n❌ 签到失败，请确认令牌是否正确 / 该账号是否有签到权限');
    process.exit(1);
  }
} else {
  console.log(`  [2] /checkin-> 网络错误 ${r2.err}`);
  process.exit(1);
}