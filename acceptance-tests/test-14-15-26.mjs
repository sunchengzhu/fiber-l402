/**
 * 场景 #26 Payer 节点不可达时自动支付
 * 场景 #14 过期 invoice
 * 场景 #15 通道余额不足 (price=10000 CKB)
 *
 * 运行方式: 分阶段执行，每阶段需要不同的环境配置
 * 参数: node test-14-15-26.mjs [26|14|15]
 */

const API = 'http://localhost:3001';
const PAYER_RPC = 'http://127.0.0.1:8229';

// ───────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────

async function getChallenge(articleId) {
  const res = await fetch(`${API}/api/articles/${articleId}/content`);
  const body = await res.json();
  return { status: res.status, body };
}

async function fiberRpc(url, method, params) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [params] }),
    });
    const json = await res.json();
    return { ok: true, result: json.result, error: json.error };
  } catch (err) {
    return { ok: false, fetchError: err.message };
  }
}

async function getArticleId() {
  const res = await fetch(`${API}/api/articles`);
  const articles = await res.json();
  return articles[0]?.id;
}

// ───────────────────────────────────────────────
// #26: Payer 节点不可达时自动支付
// ───────────────────────────────────────────────

async function test26() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  #26 Payer 节点不可达时自动支付                    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // 1. 确认 payer 节点不可达
  console.log('  ① 确认 payer 节点不可达...');
  const ping = await fiberRpc(PAYER_RPC, 'node_info', {});
  if (ping.ok) {
    console.log('  ⚠️  Payer 节点仍在运行! 请先 kill 掉 8229 端口的进程');
    return;
  }
  console.log(`  ✅ Payer 节点不可达: "${ping.fetchError}"`);

  // 2. 获取 challenge (这走的是 payee 节点，应该正常)
  console.log('\n  ② 获取 402 challenge...');
  const articleId = await getArticleId();
  const challenge = await getChallenge(articleId);
  if (challenge.status !== 402) {
    console.log(`  ⚠️  未返回 402, status=${challenge.status}`);
    return;
  }
  console.log(`  ✅ 获取到 invoice: ${challenge.body.invoice?.substring(0, 30)}...`);

  // 3. 模拟浏览器调用 payer 的 send_payment
  console.log('\n  ③ 模拟 auto-pay: 调用 payer send_payment...');
  const payResult = await fiberRpc(PAYER_RPC, 'send_payment', {
    invoice: challenge.body.invoice,
    allow_self_payment: true,
  });

  console.log('\n  ┌─ 前端用户会看到的错误 ─────────────────────');
  if (!payResult.ok) {
    console.log(`  │ fetch 异常: "${payResult.fetchError}"`);
    console.log('  │');
    console.log('  │ 前端 PaymentGate catch 块会捕获此异常，');
    console.log('  │ 用户看到: "' + payResult.fetchError + '"');
  } else if (payResult.error) {
    console.log(`  │ RPC error: ${JSON.stringify(payResult.error)}`);
  } else {
    console.log(`  │ 意外成功: ${JSON.stringify(payResult.result)}`);
  }
  console.log('  └────────────────────────────────────────────\n');

  // 评估
  const errMsg = payResult.fetchError || '';
  const isMeaningful = errMsg.includes('ECONNREFUSED') || errMsg.includes('fetch failed') || errMsg.includes('connect');
  console.log(`  判定: 错误信息${isMeaningful ? '包含连接失败关键词' : '不够明确'}`);
  console.log(`  ${isMeaningful ? '✅' : '❌'} #26 Payer 不可达 → 错误信息: "${errMsg}"`);
}

// ───────────────────────────────────────────────
// #14: 过期 invoice (需要先把 L402_EXPIRY_SECONDS 改为 3 并重启后端)
// ───────────────────────────────────────────────

async function test14() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  #14 过期 invoice                                ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const articleId = await getArticleId();

  // 1. 获取 challenge
  console.log('  ① 获取 402 challenge (expiry 应为 3 秒)...');
  const challenge = await getChallenge(articleId);
  if (challenge.status !== 402) {
    console.log(`  ⚠️  未返回 402, status=${challenge.status}`);
    return;
  }
  console.log(`  ✅ 获取到 invoice: ${challenge.body.invoice?.substring(0, 30)}...`);

  // 2. 等待过期
  console.log('\n  ② 等待 5 秒让 invoice 过期...');
  await new Promise(r => setTimeout(r, 5000));

  // 3. 尝试用过期的 invoice 支付
  console.log('  ③ 用过期 invoice 调用 payer send_payment...');
  const payResult = await fiberRpc(PAYER_RPC, 'send_payment', {
    invoice: challenge.body.invoice,
    allow_self_payment: true,
  });

  console.log('\n  ┌─ send_payment 返回 ─────────────────────────');
  if (!payResult.ok) {
    console.log(`  │ fetch 异常: "${payResult.fetchError}"`);
  } else if (payResult.error) {
    console.log(`  │ RPC error code: ${payResult.error.code}`);
    console.log(`  │ RPC error message: "${payResult.error.message}"`);
  } else if (payResult.result) {
    console.log(`  │ status: ${payResult.result.status}`);
    if (payResult.result.status === 'Failed') {
      console.log(`  │ failed_error: "${payResult.result.failed_error}"`);
    } else {
      console.log(`  │ result: ${JSON.stringify(payResult.result)}`);
    }
  }
  console.log('  └────────────────────────────────────────────\n');

  // 4. 验证能获取新 invoice
  console.log('  ④ 重新请求，验证能获取新的 invoice...');
  const challenge2 = await getChallenge(articleId);
  const isNew = challenge2.body.invoice !== challenge.body.invoice;
  console.log(`  ${challenge2.status === 402 ? '✅' : '❌'} 重新请求返回 ${challenge2.status}`);
  console.log(`  ${isNew ? '✅' : '⚠️ '} invoice ${isNew ? '已更新 (新的)' : '未变化 (同一个)'}`);

  // 5. 过期 macaroon 验证
  console.log('\n  ⑤ 尝试用过期 macaroon + 伪造 preimage 请求 content...');
  const fakePreimage = '0x' + '00'.repeat(32);
  const res = await fetch(`${API}/api/articles/${articleId}/content`, {
    headers: { 'Authorization': `L402 ${challenge.body.macaroon}:${fakePreimage}` },
  });
  const body = await res.json();
  console.log(`  状态: ${res.status}`);
  console.log(`  错误: "${body.error}"`);
  const hasExpired = (body.error || '').toLowerCase().includes('expired');
  console.log(`  ${hasExpired ? '✅' : '❌'} 过期 macaroon 被拒绝 (包含 expired)`);
}

// ───────────────────────────────────────────────
// #15: 通道余额不足 (需要先把 ARTICLE_PRICE_CKB 改为 10000 并重启后端)
// ───────────────────────────────────────────────

async function test15() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  #15 通道余额不足                                ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const articleId = await getArticleId();

  // 1. 获取 challenge (高价 invoice)
  console.log('  ① 获取 402 challenge (price=10000 CKB)...');
  const challenge = await getChallenge(articleId);
  if (challenge.status !== 402) {
    console.log(`  ⚠️  未返回 402, status=${challenge.status}`);
    return;
  }
  console.log(`  ✅ 获取到 invoice: ${challenge.body.invoice?.substring(0, 30)}...`);

  // 2. 确认 payer 节点在线
  console.log('\n  ② 确认 payer 节点在线...');
  const ping = await fiberRpc(PAYER_RPC, 'node_info', {});
  if (!ping.ok) {
    console.log(`  ⚠️  Payer 节点不可达: ${ping.fetchError}`);
    console.log('  ⚠️  请先启动 payer 节点再测 #15');
    return;
  }
  console.log('  ✅ Payer 节点在线');

  // 3. 尝试支付高价 invoice
  console.log('\n  ③ 调用 send_payment (10000 CKB, 预计余额不足)...');
  const payResult = await fiberRpc(PAYER_RPC, 'send_payment', {
    invoice: challenge.body.invoice,
    allow_self_payment: true,
  });

  console.log('\n  ┌─ send_payment 返回 ─────────────────────────');
  if (!payResult.ok) {
    console.log(`  │ fetch 异常: "${payResult.fetchError}"`);
  } else if (payResult.error) {
    console.log(`  │ RPC error code: ${payResult.error.code}`);
    console.log(`  │ RPC error message: "${payResult.error.message}"`);
  } else if (payResult.result) {
    console.log(`  │ status: ${payResult.result.status}`);
    if (payResult.result.status === 'Failed') {
      console.log(`  │ failed_error: "${payResult.result.failed_error}"`);
    } else {
      const needsPoll = ['Created', 'Inflight'].includes(payResult.result.status);
      if (needsPoll) {
        console.log(`  │ 初始状态: ${payResult.result.status}, 轮询等待最终结果...`);
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const status = await fiberRpc(PAYER_RPC, 'get_payment', {
            payment_hash: payResult.result.payment_hash,
          });
          if (status.ok && status.result) {
            if (status.result.status === 'Failed') {
              console.log(`  │ 最终状态: Failed`);
              console.log(`  │ failed_error: "${status.result.failed_error}"`);
              break;
            } else if (status.result.status === 'Success') {
              console.log(`  │ 意外成功! (通道余额足够?)  `);
              break;
            }
            if (i % 3 === 0) console.log(`  │ 轮询 ${i + 1}: ${status.result.status}`);
          }
        }
      } else {
        console.log(`  │ result: ${JSON.stringify(payResult.result)}`);
      }
    }
  }
  console.log('  └────────────────────────────────────────────\n');
}

// ───────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────

const scenario = process.argv[2];

if (!scenario) {
  console.log('用法: node test-14-15-26.mjs [26|14|15]');
  console.log('');
  console.log('  26 - Payer 不可达 (先 kill 8229 端口)');
  console.log('  14 - 过期 invoice (需改 L402_EXPIRY_SECONDS=3 并重启后端)');
  console.log('  15 - 余额不足 (需改 ARTICLE_PRICE_CKB=10000 并重启后端)');
  process.exit(0);
}

try {
  if (scenario === '26') await test26();
  else if (scenario === '14') await test14();
  else if (scenario === '15') await test15();
  else console.log(`未知场景: ${scenario}`);
} catch (err) {
  console.error('脚本异常:', err);
  process.exit(1);
}
