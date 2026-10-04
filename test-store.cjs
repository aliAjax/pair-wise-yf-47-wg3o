const fs = require("fs");
const path = require("path");
const ts = require("typescript");

// 环境垫片
const memory = new Map();
global.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k)
};

async function loadStore() {
  const src = fs.readFileSync(path.join(__dirname, "store/incident.ts"), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: "incident.ts"
  });
  const mod = { exports: {} };
  new Function("exports", "require", "module", out.outputText)(mod.exports, require, mod);
  return mod.exports;
}

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
function throws(name, fn) {
  try { fn(); failed++; console.log(`  ✗ ${name}（未抛错）`); }
  catch (e) { passed++; console.log(`  ✓ ${name}（${e.message}）`); }
}

(async () => {
  const { useIncidentStore, missingApprovals } = await loadStore();
  const get = () => useIncidentStore.getState();

  console.log("\n[1] 车站状态变化联动确认作废");
  useIncidentStore.setState({ online: true, role: "调度员" });
  const before = get().plans.find((p) => p.id === "p1");
  check("种子计划 p1 待确认且已有调度员确认", before.status === "待确认" && before.approvals.includes("调度员"));
  get().setStationStatus("s1", "限流", "站台积水消退中");
  let p1 = get().plans.find((p) => p.id === "p1");
  check("滨江站变为限流后 p1 确认被作废（approvals 清空）", p1.approvals.length === 0);
  check("p1 退回待确认", p1.status === "待确认");
  check("时间线记录作废", get().timeline.some((t) => t.action === "接驳确认作废"));

  console.log("\n[2] 双重确认与执行前校验");
  // p1 已被作废，重新走确认流程
  get().approvePlan("p1"); // 调度员
  p1 = get().plans.find((p) => p.id === "p1");
  check("仅调度员确认时仍为待确认", p1.status === "待确认" && missingApprovals(p1).join() === "公交接驳负责人");
  throws("待确认状态执行被拒绝", () => get().executePlan("p1"));
  useIncidentStore.setState({ role: "公交接驳负责人" });
  get().approvePlan("p1");
  p1 = get().plans.find((p) => p.id === "p1");
  check("双方确认后变为已确认", p1.status === "已确认" && missingApprovals(p1).length === 0);
  get().executePlan("p1");
  check("已确认可执行", get().plans.find((p) => p.id === "p1").status === "已执行");

  console.log("\n[3] 车辆数变化作废确认");
  useIncidentStore.setState({ role: "调度员" });
  const id = get().addPlan({ stations: ["东港站"], vehicles: 4, interval: 10, operator: "东城公交", note: " test" });
  get().submitPlan(id);
  useIncidentStore.setState({ role: "公交接驳负责人" });
  get().approvePlan(id);
  useIncidentStore.setState({ role: "调度员" });
  get().approvePlan(id);
  check("新计划已确认", get().plans.find((p) => p.id === id).status === "已确认");
  get().updatePlanVehicles(id, 6);
  const changed = get().plans.find((p) => p.id === id);
  check("车辆数更新", changed.vehicles === 6);
  check("车辆变化后确认作废退回待确认", changed.status === "待确认" && changed.approvals.length === 0);
  throws("作废后执行被拒绝", () => get().executePlan(id));

  console.log("\n[4] 角色权限收敛到 store");
  useIncidentStore.setState({ role: "客服主管" });
  throws("客服主管改车站状态被拒", () => get().setStationStatus("s3", "封闭"));
  throws("客服主管确认计划被拒", () => get().approvePlan(id));
  check("客服主管操作未产生队列", get().pendingActions.length === 0);
  useIncidentStore.setState({ role: "车站值班员" });
  get().setStationStatus("s3", "限流");
  check("车站值班员可改车站状态", get().stations.find((s) => s.id === "s3").status === "限流");

  console.log("\n[5] 弱网队列：按依赖排队、合并、失败保留原因与重试");
  useIncidentStore.setState({ online: false, role: "调度员" });
  get().setStationStatus("s1", "封闭");
  get().setStationStatus("s1", "限流"); // 同站多次变更 → 合并为最新
  get().setStationStatus("s2", "恢复中");
  const qId = get().addPlan({ stations: ["滨江站"], vehicles: 3, interval: 8, operator: "东城公交", note: "弱网测试" });
  get().submitPlan(qId);
  useIncidentStore.setState({ role: "公交接驳负责人" });
  get().approvePlan(qId);
  useIncidentStore.setState({ role: "调度员" });
  get().approvePlan(qId);
  get().executePlan(qId);
  const queued = get().pendingActions;
  check("弱网操作全部入队", queued.length === 8);
  const stationQueued = queued.filter((a) => a.kind === "station:status");
  check("同站状态变更保留多条待合并", stationQueued.length === 3);

  // 模拟弱网波动：首次同步全部失败
  const timelineBeforeSync = get().timeline.length;
  const origRandom = Math.random;
  Math.random = () => 0;
  useIncidentStore.setState({ online: true });
  const result = await get().syncActions();
  Math.random = origRandom;
  check("首次同步：提交 0 条", result.submitted === 0);
  check("首次同步：失败 7 条（8 条合并为 7 条）", result.failed === 7);
  const afterFail = get().pendingActions;
  check("失败项保留在队列中", afterFail.length === 7);
  check("失败项带原因", afterFail.every((a) => a.status === "同步失败" && typeof a.error === "string" && a.error.length > 0));
  check("失败项带重试次数", afterFail.every((a) => a.retries === 1));

  console.log("\n[6] 失败后重试：后续操作仍提交，队列合并后状态正确");
  // 逐条重试（模拟用户在确认中心点重试）
  for (const action of [...afterFail].reverse()) {
    get().retryAction(action.id);
  }
  const left = get().pendingActions;
  check("重试后队列清空", left.length === 0);
  const qPlan = get().plans.find((p) => p.id === qId);
  check("弱网计划最终已执行", qPlan && qPlan.status === "已执行");
  check("双重确认记录齐全", qPlan.approvals.includes("调度员") && qPlan.approvals.includes("公交接驳负责人"));
  check("车站状态以最后一次合并结果为准（s1 限流）", get().stations.find((s) => s.id === "s1").status === "限流");
  check("s2 恢复中已同步", get().stations.find((s) => s.id === "s2").status === "恢复中");
  check("同步后时间线增量 = 合并后重放的 7 条操作（2 车站 + 新建/提交/2确认/执行）", get().timeline.length - timelineBeforeSync === 7);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
