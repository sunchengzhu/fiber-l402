// 复现 #56 浮点精度 Bug：文章价格 1.1 CKB 时 invoice 金额是否准确
const FIBER_RPC = "http://43.198.254.225:8227";

async function main() {
  // Step 1: 请求 1.1 CKB 价格的文章，获取 402 challenge
  const res = await fetch("http://localhost:3001/api/articles/make-selfhost-great-again/content");
  const body = await res.json();
  console.log("=== Step 1: 获取 402 challenge ===");
  console.log("status:", res.status);
  console.log("response body:", JSON.stringify(body, null, 2));

  // Step 2: 用 Fiber RPC 解析 invoice，查看实际金额
  const rpc = await fetch(FIBER_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "parse_invoice",
      params: [{ invoice: body.invoice }]
    })
  });
  const parsed = await rpc.json();

  console.log("=== Step 2: 解析 invoice 实际金额 ===");
  const amount = parsed.result.invoice.amount;
  const decimal = parseInt(amount, 16);
  console.log("金额 (hex):", amount);
  console.log("金额 (decimal):", decimal, "shannons");
  console.log("金额 (CKB):", decimal / 100000000, "CKB");
  console.log("期望: 110000000 shannons = 1.1 CKB");
  console.log("差异:", decimal - 110000000, "shannons\n");

  // Step 3: 展示代码层面的问题
  console.log("=== Step 3: 代码层面的计算 ===");
  const priceCkb = 1.1;
  const rawCalc = priceCkb * 100000000;
  const hexSent = "0x" + rawCalc.toString(16);
  const correctHex = "0x" + Math.round(rawCalc).toString(16);
  console.log("priceCkb:", priceCkb);
  console.log("priceCkb * 100000000:", rawCalc);
  console.log("middleware 传给 Fiber 的 hex:", hexSent);
  console.log("Math.round 后正确的 hex:", correctHex);
  console.log("两者一致?", hexSent === correctHex);
}
main().catch(console.error);
