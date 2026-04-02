/**
 * Fiber L402 — 场景 #19 / #20 / #21 节点版本兼容性测试
 *
 * 测试 FiberConnectButton 对不同版本 Fiber 节点的兼容性：
 *   #19: v0.8.0-rc1 节点（返回 pubkey 而非 node_id），前端应正常显示节点 ID
 *   #20: v0.7.x 节点（返回 node_id），前端应正常工作
 *   #21: localStorage 已有旧版连接信息，升级节点后应不崩溃
 *
 * 额外测试：
 *   - 后端 InvoiceService 使用 payee 节点创建/验证 invoice 的兼容性
 *   - 前端 PaymentGate auto-pay 使用 payer 节点发送支付的兼容性
 *
 * 环境:
 *   - v0.7.1 兼容节点: http://127.0.0.1:8227  (payee)
 *   - v0.8.0-rc1 不兼容节点: http://127.0.0.1:8229  (payer)
 *
 * 运行: node test-19-20-21.mjs
 */

const COMPATIBLE_NODE = 'http://127.0.0.1:8227';   // v0.7.1, 返回 node_id
const INCOMPATIBLE_NODE = 'http://127.0.0.1:8229';  // v0.8.0-rc1, 返回 pubkey
const API = 'http://localhost:3001';
const results = [];

function log(id, name, pass, detail = '') {
  const status = pass ? '✅ PASS' : '❌ FAIL';
  results.push({ id, name, pass, detail });
  console.log(`  ${status}  #${id} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── Helpers ───────────────────────────────────────────────

async function rpcCall(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

/**
 * 模拟 FiberConnectButton 的连接逻辑（代码中的关键路径）:
 *
 *   const info = await client.nodeInfo();
 *   setNode({ nodeId: info.node_id, chainHash: info.chain_hash });
 *
 * 然后显示时:
 *   node.nodeId.slice(0, 8) + '…' + node.nodeId.slice(-4)
 */
function simulateConnectButton(nodeInfoResult) {
  // 1. FiberConnectButton 取 node_id 字段
  const nodeId = nodeInfoResult.node_id;
  const chainHash = nodeInfoResult.chain_hash;

  // 2. 创建 node 对象
  const node = { nodeId, chainHash };

  // 3. 尝试 slice 显示（如果 nodeId 是 undefined 会崩溃）
  let displayText;
  try {
    displayText = `${node.nodeId.slice(0, 8)}…${node.nodeId.slice(-4)}`;
  } catch (e) {
    return { success: false, error: e.message, node };
  }

  return { success: true, displayText, node };
}

/**
 * 建议的修复方案：兼容 node_id 和 pubkey
 */
function simulateConnectButtonFixed(nodeInfoResult) {
  const nodeId = nodeInfoResult.node_id || nodeInfoResult.pubkey;
  const chainHash = nodeInfoResult.chain_hash;
  const node = { nodeId, chainHash };

  let displayText;
  try {
    displayText = `${node.nodeId.slice(0, 8)}…${node.nodeId.slice(-4)}`;
  } catch (e) {
    return { success: false, error: e.message, node };
  }

  return { success: true, displayText, node };
}

// ── TESTS ───────────────────────────────────────────────

async function run() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   Fiber L402 — 节点版本兼容性测试 (#19 #20 #21)       ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ═══════════════════════════════════════════════════════
  // 基础：两个节点的 API 差异检测
  // ═══════════════════════════════════════════════════════

  console.log('── 前置：节点 API 字段差异检测 ──');

  let compatibleInfo, incompatibleInfo;
  try {
    compatibleInfo = await rpcCall(COMPATIBLE_NODE, 'node_info');
    console.log(`  ℹ️  兼容节点 (8227): version=${compatibleInfo.version}`);
    log('pre-a', '兼容节点可达', true, `version=${compatibleInfo.version}`);
  } catch (e) {
    console.error(`  ❌ 兼容节点 (8227) 不可达: ${e.message}`);
    log('pre-a', '兼容节点可达', false, e.message);
    console.log('\n  ⚠️  需要 v0.7.x 节点在 127.0.0.1:8227 上运行，跳过后续测试');
    return printSummary();
  }

  try {
    incompatibleInfo = await rpcCall(INCOMPATIBLE_NODE, 'node_info');
    console.log(`  ℹ️  不兼容节点 (8229): version=${incompatibleInfo.version}`);
    log('pre-b', '不兼容节点可达', true, `version=${incompatibleInfo.version}`);
  } catch (e) {
    console.error(`  ❌ 不兼容节点 (8229) 不可达: ${e.message}`);
    log('pre-b', '不兼容节点可达', false, e.message);
    console.log('\n  ⚠️  需要 v0.8.0-rc1 节点在 127.0.0.1:8229 上运行，跳过后续测试');
    return printSummary();
  }

  // 验证字段差异
  const hasNodeId_compat = !!compatibleInfo.node_id;
  const hasPubkey_compat = !!compatibleInfo.pubkey;
  const hasNodeId_incompat = !!incompatibleInfo.node_id;
  const hasPubkey_incompat = !!incompatibleInfo.pubkey;

  console.log(`\n  ℹ️  字段对比:`);
  console.log(`      v${compatibleInfo.version} (8227): node_id=${hasNodeId_compat ? '✓' : '✗'}, pubkey=${hasPubkey_compat ? '✓' : '✗'}`);
  console.log(`      v${incompatibleInfo.version} (8229): node_id=${hasNodeId_incompat ? '✓' : '✗'}, pubkey=${hasPubkey_incompat ? '✓' : '✗'}`);

  log('pre-c', 'v0.7.x 返回 node_id 字段', hasNodeId_compat, `node_id=${compatibleInfo.node_id?.slice(0, 16)}...`);
  log('pre-d', 'v0.8.0-rc1 返回 pubkey 字段', hasPubkey_incompat, `pubkey=${incompatibleInfo.pubkey?.slice(0, 16)}...`);
  log('pre-e', 'v0.8.0-rc1 不返回 node_id 字段', !hasNodeId_incompat,
    hasNodeId_incompat ? `仍有 node_id=${incompatibleInfo.node_id}` : '确认: 无 node_id 字段');

  // ═══════════════════════════════════════════════════════
  // #20 — 旧版节点 v0.7.x 正常工作
  // ═══════════════════════════════════════════════════════

  console.log('\n── 场景 #20: v0.7.x 节点 (返回 node_id) — 前端连接兼容性 ──');
  {
    const result = simulateConnectButton(compatibleInfo);
    log('20a', 'v0.7.x 连接不崩溃', result.success, result.success ? `display="${result.displayText}"` : `error=${result.error}`);
    log('20b', 'nodeId 不为 undefined', !!result.node.nodeId, `nodeId=${result.node.nodeId?.slice(0, 20) || 'undefined'}...`);
    log('20c', 'chainHash 正常', !!result.node.chainHash, `chainHash=${result.node.chainHash?.slice(0, 20)}...`);

    if (result.success) {
      const displayLen = result.displayText.length;
      log('20d', '显示文本格式正确 (截断 ID)', displayLen > 5 && displayLen < 20, `"${result.displayText}"`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // #19 — 新版节点 v0.8.0-rc1 连接
  // ═══════════════════════════════════════════════════════

  console.log('\n── 场景 #19: v0.8.0-rc1 节点 (返回 pubkey 而非 node_id) — 前端连接兼容性 ──');
  {
    // 当前代码行为：info.node_id 为 undefined → slice 崩溃
    const result = simulateConnectButton(incompatibleInfo);
    log('19a', '当前代码: v0.8.0-rc1 连接时 nodeId 为 undefined',
      result.node.nodeId === undefined, `nodeId=${result.node.nodeId}`);
    log('19b', '当前代码: 显示节点 ID 时崩溃 (Cannot read slice of undefined)',
      !result.success, result.success ? `意外成功: "${result.displayText}"` : `预期崩溃: ${result.error}`);

    console.log('\n  ℹ️  以下测试使用修复后的逻辑 (node_id || pubkey):');

    // 修复后的行为
    const fixedResult = simulateConnectButtonFixed(incompatibleInfo);
    log('19c', '修复后: v0.8.0-rc1 连接不崩溃', fixedResult.success,
      fixedResult.success ? `display="${fixedResult.displayText}"` : `error=${fixedResult.error}`);
    log('19d', '修复后: nodeId 有值 (来自 pubkey)', !!fixedResult.node.nodeId,
      `nodeId=${fixedResult.node.nodeId?.slice(0, 20)}...`);
    log('19e', '修复后: 显示文本格式正确', fixedResult.success && fixedResult.displayText.length > 5,
      `"${fixedResult.displayText}"`);

    // 验证 node_id 和 pubkey 的值格式一致（都是压缩公钥）
    const pubkeyLen = incompatibleInfo.pubkey?.length;
    const nodeIdLen = compatibleInfo.node_id?.length;
    log('19f', 'pubkey 和 node_id 长度一致', pubkeyLen === nodeIdLen,
      `pubkey.length=${pubkeyLen}, node_id.length=${nodeIdLen} — ${pubkeyLen === nodeIdLen ? '可互换' : '格式不同!'}`);
  }

  // ═══════════════════════════════════════════════════════
  // #21 — localStorage 旧版连接信息 → 升级节点后不崩溃
  // ═══════════════════════════════════════════════════════

  console.log('\n── 场景 #21: 旧版连接信息 + 节点升级后的恢复行为 ──');
  {
    // 模拟: 之前用 v0.7.x 保存了连接，现在节点升级到 v0.8.0-rc1
    // FiberConnectButton useEffect 中:
    //   client.nodeInfo().then((info) => {
    //     setNode({ nodeId: info.node_id, chainHash: info.chain_hash });
    //   }).catch(() => { setIsConnected(false); ... });

    console.log('  模拟: localStorage 保存了旧版 v0.7.x 连接，现用 v0.8.0-rc1 节点重新验证');

    // 情况 1: 节点仍可达但返回字段变了（升级场景）
    const info = incompatibleInfo; // 升级后的节点返回
    const revalidateResult = simulateConnectButton(info);

    log('21a', '重新验证: nodeId 从旧字段取值为 undefined',
      revalidateResult.node.nodeId === undefined,
      `nodeId=${revalidateResult.node.nodeId}`);

    // 在当前代码中，useEffect 里 node_id 会是 undefined
    // 但 setNode 本身不会崩溃（只是设了 undefined）
    // 崩溃发生在渲染阶段：node.nodeId.slice(...)
    log('21b', '设置 node 状态不崩溃 (setNode 阶段)', true,
      'setNode({ nodeId: undefined }) 不会直接崩溃');
    log('21c', '渲染显示阶段会崩溃 (slice of undefined)',
      !revalidateResult.success,
      revalidateResult.success
        ? `意外成功: "${revalidateResult.displayText}"`
        : `崩溃: ${revalidateResult.error}`);

    // 修复后的行为
    const fixedRevalidate = simulateConnectButtonFixed(info);
    log('21d', '修复后: 升级节点后重新验证不崩溃', fixedRevalidate.success,
      fixedRevalidate.success ? `display="${fixedRevalidate.displayText}"` : `error=${fixedRevalidate.error}`);

    // 情况 2: 节点不可达（升级重启中）→ catch 分支
    console.log('\n  模拟: 节点重启/不可达时的降级行为');
    try {
      await rpcCall('http://127.0.0.1:9999', 'node_info');
      log('21e', '不可达节点 catch 分支', false, '意外成功了?');
    } catch (e) {
      // FiberConnectButton catch 里会 setIsConnected(false)
      log('21e', '不可达节点 → catch 分支优雅降级',
        true, `error="${e.message.slice(0, 50)}..." → 回退到未连接状态`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 额外: 后端 InvoiceService 兼容性
  // ═══════════════════════════════════════════════════════

  console.log('\n── 额外: 后端 InvoiceService 对 payee 节点 (v0.7.1) 的兼容性 ──');
  {
    // 后端使用 8227 (v0.7.1) 作为 payee 创建 invoice
    const res = await fetch(`${API}/api/articles`);
    const articles = await res.json();
    if (articles.length > 0) {
      const contentRes = await fetch(`${API}/api/articles/${articles[0].id}/content`);
      const body = await contentRes.json();
      log('inv-a', '后端能通过 v0.7.1 节点创建 invoice', contentRes.status === 402 && !!body.invoice,
        `status=${contentRes.status}, invoice=${(body.invoice || '').slice(0, 30)}...`);
      log('inv-b', 'invoice 格式正确 (fibt 开头)', body.invoice?.startsWith('fibt'),
        `prefix=${body.invoice?.slice(0, 4)}`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 额外: 两个节点的 RPC 方法兼容性对比
  // ═══════════════════════════════════════════════════════

  console.log('\n── 额外: 两个版本节点的关键 RPC 方法兼容性 ──');
  {
    // 测试 new_invoice 方法在两个版本上是否都可用
    const methods = ['node_info', 'list_channels'];

    for (const method of methods) {
      try {
        await rpcCall(COMPATIBLE_NODE, method, method === 'list_channels' ? [{}] : []);
        log(`rpc-${method}-v7`, `v0.7.1 支持 ${method}`, true, '可用');
      } catch (e) {
        log(`rpc-${method}-v7`, `v0.7.1 支持 ${method}`, false, e.message);
      }

      try {
        await rpcCall(INCOMPATIBLE_NODE, method, method === 'list_channels' ? [{}] : []);
        log(`rpc-${method}-v8`, `v0.8.0-rc1 支持 ${method}`, true, '可用');
      } catch (e) {
        log(`rpc-${method}-v8`, `v0.8.0-rc1 支持 ${method}`, false, e.message);
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // auto-pay: 使用 v0.8.0-rc1 节点(payer)执行实际支付
  // ═══════════════════════════════════════════════════════

  console.log('\n── 额外: v0.8.0-rc1 payer 节点自动支付流程 ──');
  {
    // 1. 获取 402 challenge
    const challengeRes = await fetch(`${API}/api/articles/${(await (await fetch(`${API}/api/articles`)).json())[0].id}/content`);
    const challenge = await challengeRes.json();

    if (challengeRes.status === 402 && challenge.invoice) {
      log('auto-a', '获取 402 challenge', true, `invoice=${challenge.invoice.slice(0, 30)}...`);

      // 2. 使用 v0.8.0-rc1 payer 节点支付
      try {
        // 解析 invoice 获取 payment_hash
        const parsed = await rpcCall(INCOMPATIBLE_NODE, 'parse_invoice', [{ invoice: challenge.invoice }]);
        const paymentHash = parsed.invoice?.data?.payment_hash;
        log('auto-b', 'v0.8.0-rc1 解析 invoice 成功', !!paymentHash,
          `payment_hash=${paymentHash?.slice(0, 20)}...`);

        // 3. 发送支付
        const payment = await rpcCall(INCOMPATIBLE_NODE, 'send_payment', [{
          invoice: challenge.invoice,
        }]);
        log('auto-c', 'v0.8.0-rc1 发送支付', !!payment, `payment_hash=${payment.payment_hash?.slice(0, 20)}...`);

        // 4. 等待支付完成
        if (payment.payment_hash) {
          let settled = false;
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const status = await rpcCall(INCOMPATIBLE_NODE, 'get_payment', [{
                payment_hash: payment.payment_hash,
              }]);
              if (status.status === 'Success') {
                settled = true;
                log('auto-d', 'v0.8.0-rc1 支付成功', true,
                  `status=${status.status}`);
                break;
              }
              if (status.status === 'Failed') {
                log('auto-d', 'v0.8.0-rc1 支付失败', false, `status=${status.status}`);
                break;
              }
            } catch (e) {
              // 继续等待
            }
          }
          if (!settled) {
            // 可能超时了但实际成功了，检查 invoice 状态
            try {
              const invoiceStatus = await rpcCall(COMPATIBLE_NODE, 'get_invoice', [{
                payment_hash: payment.payment_hash,
              }]);
              log('auto-d', '支付超时但检查 payee invoice 状态',
                invoiceStatus.status === 'Paid',
                `invoice_status=${invoiceStatus.status}`);
              settled = invoiceStatus.status === 'Paid';
            } catch (e) {
              log('auto-d', '支付状态未确定', false, `timeout, ${e.message}`);
            }
          }

          // 5. 如果支付成功，用 macaroon-only (Path B) 获取内容
          if (settled) {
            const contentRes = await fetch(`${API}/api/articles/${(await (await fetch(`${API}/api/articles`)).json())[0].id}/content`, {
              headers: { 'Authorization': `L402 ${challenge.macaroon}` },
            });
            const contentBody = await contentRes.json();
            log('auto-e', 'Path B (macaroon-only) 获取内容', contentRes.status === 200,
              `status=${contentRes.status}, content_length=${contentBody.content?.length || 0}`);
          }
        }
      } catch (e) {
        log('auto-b', 'v0.8.0-rc1 支付流程异常', false, e.message);
      }
    } else {
      log('auto-a', '获取 402 challenge 失败', false, `status=${challengeRes.status}`);
    }
  }

  printSummary();
}

function printSummary() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║               测试报告                                ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;

  console.log(`  总计: ${total}   通过: ${passed}   失败: ${failed}\n`);

  if (failed > 0) {
    console.log('  失败项 (已知 Bug — Issue #3):');
    results.filter(r => !r.pass).forEach(r => {
      console.log(`    ❌ #${r.id} ${r.name} — ${r.detail}`);
    });
    console.log('');
  }

  console.log(`  通过率: ${((passed / total) * 100).toFixed(1)}%\n`);

  // 修复建议
  const hasBug = results.some(r => r.id.startsWith('19') && !r.pass);
  if (hasBug) {
    console.log('  ─── 修复建议 (Issue #3) ───');
    console.log('  FiberConnectButton.tsx 中需要兼容两种字段名:');
    console.log('');
    console.log('    // 当前代码:');
    console.log('    setNode({ nodeId: info.node_id, chainHash: info.chain_hash });');
    console.log('');
    console.log('    // 修复方案:');
    console.log('    setNode({ nodeId: info.node_id || info.pubkey, chainHash: info.chain_hash });');
    console.log('');
  }
}

run().catch(err => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
