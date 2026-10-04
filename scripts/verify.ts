import { useIncidentStore } from "../store/incident";

const api = useIncidentStore;
const s = () => api.getState();
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const findPlan = (id = "p1") => s().plans.find((p) => p.id === id)!;

// ---------- 场景 1：双确认 + 车站状态变化联动作废 ----------
console.log("场景1：状态联动与双重确认");
s().setRole("调度员");
ok("种子计划处于待确认", findPlan().status === "待确认");
ok("种子计划仅调度员确认", findPlan().approvals.length === 1);
let r = s().executePlan("p1");
ok("单确认不能执行", !r.ok && /双重确认/.test(r.reason ?? ""));
s().setRole("公交接驳负责人");
r = s().approvePlan("p1");
ok("公交负责人确认成功", r.ok);
ok("双确认后状态为已确认", findPlan().status === "已确认");
ok("已确认计划锁定依据(basis)", !!findPlan().basis);

s().setRole("车站值班员");
r = s().setStationStatus("s1", "恢复中");
ok("值班员可改车站状态", r.ok);
ok("车站变化后确认作废、审批清空", findPlan().approvals.length === 0 && findPlan().status === "待确认");
ok("记录了作废原因", !!findPlan().invalidReason);
ok("basis 已清除", !findPlan().basis);
r = s().executePlan("p1");
ok("旧确认无法再执行", !r.ok);
ok("时间线记录了系统作废事件", s().timeline.some((e) => e.actor === "系统" && e.action === "确认自动作废"));

// ---------- 场景 2：车辆数变化联动 ----------
console.log("场景2：车辆数变化作废确认");
s().setRole("调度员");
s().approvePlan("p1");
s().setRole("公交接驳负责人");
s().approvePlan("p1");
ok("重新双确认通过", findPlan().status === "已确认");
s().changeVehicles("p1", 12);
ok("车辆数 8→12 后作废", findPlan().status === "待确认" && findPlan().approvals.length === 0 && findPlan().vehicles === 12);

// ---------- 场景 3：权限 ----------
console.log("场景3：角色权限");
s().setRole("客服主管");
ok("客服主管不能改车站状态", !s().setStationStatus("s2", "封闭").ok);
ok("客服主管不能确认计划", !s().approvePlan("p1").ok);
ok("客服主管不能执行计划", !s().executePlan("p1").ok);
ok("客服主管不能提交计划", !s().submitPlan("p1").ok);
ok("客服主管不能调车辆数", !s().changeVehicles("p1", 5).ok);
s().setRole("车站值班员");
ok("值班员不能确认接驳计划", !s().approvePlan("p1").ok);
s().setRole("公交接驳负责人");
ok("公交负责人不能改车站状态", !s().setStationStatus("s2", "封闭").ok);

// ---------- 场景 4：弱网队列：依赖、合并、失败不阻塞后续 ----------
console.log("场景4：弱网队列与依赖");
s().setOnline(false);
s().setRole("车站值班员");
s().setStationStatus("s2", "封闭");
s().setStationStatus("s2", "正常");
s().setStationStatus("s2", "限流");
const s2base = s().stations.find((x) => x.id === "s2")!.syncedVersion;
ok("弱网下排队3条待同步", s().queue.filter((q) => q.status === "待同步").length === 3);
ok("同岗位操作形成依赖链", s().queue[0].dependsOn.length === 1);
ok("弱网本地乐观生效(限流)", s().stations.find((x) => x.id === "s2")!.status === "限流");
s().addTimeline({ action: "现场播报", detail: "站外广播已更新", phase: "响应" });
s().setRole("调度员");
s().setStationStatus("s2", "封闭");

s().setOnline(true); // 自动合并+提交
const q = s().queue;
const dutyOps = q.filter((e) => e.action === "更新车站状态" && e.actor === "车站值班员");
ok("同岗位连续修改合并为1条", dutyOps.length === 1);
const failedDuty = dutyOps.find((e) => e.status === "失败");
ok("低优先级值班员并发修改被拦截", !!failedDuty);
ok("失败原因明确", /调度员/.test((failedDuty as any)?.reason ?? ""));
const dispatcherOp = q.find((e) => e.action === "更新车站状态" && e.actor === "调度员");
ok("高优先级调度员修改放行", dispatcherOp?.status === "已同步");
ok("失败保留重试次数", (failedDuty as any)?.retries >= 1);
const tlOp = q.find((e) => e.action === "添加处置记录");
ok("前面失败后后续操作仍提交", tlOp?.status === "已同步");
ok("最终以调度员状态为准(封闭)", s().stations.find((x) => x.id === "s2")!.status === "封闭");
ok("服务端版本推进1次", s().stations.find((x) => x.id === "s2")!.syncedVersion === s2base + 1);

// ---------- 场景 5：重试与放弃 ----------
console.log("场景5：重试与放弃");
const failedId = failedDuty!.id;
s().retryQueued(failedId);
const res = s().syncQueue();
ok("重试仍失败(现场已被调度员更新)", res.failed >= 1);
ok("重试次数累加", s().queue.find((e) => e.id === failedId)!.retries >= 2);
s().dismissQueued(failedId);
ok("可放弃失败条目", !s().queue.some((e) => e.id === failedId));
s().clearSynced();
ok("可清除已同步条目", s().queue.every((e) => e.status !== "已同步"));

// ---------- 场景 6：弱网计划全生命周期的依赖排序 ----------
console.log("场景6：弱网计划操作依赖与双确认重校验");
s().setOnline(false);
s().setRole("公交接驳负责人");
s().addPlan({ stations: ["s3"], vehicles: 4, interval: 8, operator: "西城公交", note: "东港短驳" });
const newId = s().plans[0].id;
s().submitPlan(newId);
s().approvePlan(newId);
s().setRole("调度员");
s().approvePlan(newId);
const execR = s().executePlan(newId);
ok("双确认后弱网可排队执行", execR.ok);
const execEntry = s().queue.find((e) => e.action === "执行接驳计划") as any;
ok("执行依赖队列中的提交/确认动作", execEntry.dependsOn.length >= 2);
s().setOnline(true);
ok("重连提交后计划已执行", findPlan(newId).status === "已执行");
ok("队列全部已同步", s().queue.every((e) => e.status === "已同步"));

// ---------- 场景 7：弱网执行前依据被改 → 提交侧复核拦截 ----------
console.log("场景7：执行前重新校验");
s().clearSynced();
s().setOnline(false);
s().setRole("公交接驳负责人");
s().addPlan({ stations: ["s3"], vehicles: 6, interval: 7, operator: "西城公交", note: "二次短驳" });
const id2 = s().plans[0].id;
s().submitPlan(id2);
s().approvePlan(id2);
s().setRole("调度员");
s().approvePlan(id2);
s().executePlan(id2); // 排队执行
// 弱网期间，s3 车站状态被值班员改变 → 计划确认依据失效
s().setRole("车站值班员");
s().setStationStatus("s3", "限流", "临时限流");
s().setOnline(true);
const plan2 = findPlan(id2);
ok("依据失效后执行被提交侧拦截", plan2.status === "待确认" && plan2.approvals.length === 0);
ok("执行条目失败且原因保留", s().queue.some((e) => e.action === "执行接驳计划" && e.status === "失败"));
ok("车站变更本身提交成功", s().stations.find((x) => x.id === "s3")!.status === "限流");

console.log(`\n结果：${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
