import { create, type StateCreator } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type TimelineActor = Role | "系统";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";
export type QueueStatus = "待同步" | "失败" | "已同步";

export const REQUIRED_APPROVERS: Role[] = ["调度员", "公交接驳负责人"];

// 车站状态只能由调度员和车站值班员维护；客服主管无处置权
export const STATION_WRITE_ROLES: Role[] = ["调度员", "车站值班员"];
// 接驳计划及确认只能由调度员和公交接驳负责人处理
export const PLAN_WRITE_ROLES: Role[] = ["调度员", "公交接驳负责人"];

export const canWriteStation = (role: Role) => STATION_WRITE_ROLES.includes(role);
export const canWritePlan = (role: Role) => PLAN_WRITE_ROLES.includes(role);
// 并发冲突放行优先级：调度员 > 车站值班员
export const ROLE_PRIORITY: Record<Role, number> = {
  "调度员": 3,
  "车站值班员": 2,
  "公交接驳负责人": 1,
  "客服主管": 0
};

export interface TimelineEntry {
  id: string;
  time: string;
  actor: TimelineActor;
  action: string;
  detail: string;
  phase: "发现" | "响应" | "接驳" | "恢复";
}

export interface Station {
  id: string;
  name: string;
  section: string;
  status: StationStatus;
  passengerRisk: "低" | "中" | "高";
  note: string;
  updatedAt: string;
  /** 已成功提交（服务端）状态的版本号与修改角色，用于并发覆盖判断 */
  syncedVersion: number;
  lastSyncedBy?: Role;
  /** 当前已同步版本对应的现场更新时间（OCC 时间戳） */
  syncedUpdatedAt: string;
}

export interface ApprovalState {
  role: Role;
  at: string;
}

export interface PlanBasis {
  vehicles: number;
  stations: Record<string, StationStatus>;
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: ApprovalState[];
  note: string;
  /** 确认成立时锁定的依据：车辆数及覆盖车站的状态快照 */
  basis?: PlanBasis;
  /** 最近一次确认作废的原因 */
  invalidReason?: string;
  updatedAt: string;
}

/** 弱网队列条目：携带依赖、提交状态、失败原因与重试次数 */
export type QueueEntry =
  | { id: string; time: string; actor: Role; status: QueueStatus; reason?: string; retries: number; dependsOn: string[]; action: "更新车站状态"; stationId: string; next: StationStatus; note?: string; baseVersion: number; baseUpdatedAt: string }
  | { id: string; time: string; actor: Role; status: QueueStatus; reason?: string; retries: number; dependsOn: string[]; action: "添加处置记录"; entry: Omit<TimelineEntry, "id" | "time" | "actor"> }
  | { id: string; time: string; actor: Role; status: QueueStatus; reason?: string; retries: number; dependsOn: string[]; action: "新建接驳计划"; plan: Omit<ShuttlePlan, "id" | "status" | "approvals" | "basis" | "invalidReason" | "updatedAt"> }
  | { id: string; time: string; actor: Role; status: QueueStatus; reason?: string; retries: number; dependsOn: string[]; action: "提交接驳计划"; planId: string }
  | { id: string; time: string; actor: Role; status: QueueStatus; reason?: string; retries: number; dependsOn: string[]; action: "确认接驳计划"; planId: string }
  | { id: string; time: string; actor: Role; status: QueueStatus; reason?: string; retries: number; dependsOn: string[]; action: "调整车辆数"; planId: string; vehicles: number }
  | { id: string; time: string; actor: Role; status: QueueStatus; reason?: string; retries: number; dependsOn: string[]; action: "执行接驳计划"; planId: string };

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  role: Role;
  online: boolean;
  queue: QueueEntry[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => ActionResult;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time" | "actor">) => ActionResult;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals" | "basis" | "invalidReason" | "updatedAt">) => ActionResult;
  submitPlan: (id: string) => ActionResult;
  approvePlan: (id: string) => ActionResult;
  changeVehicles: (id: string, vehicles: number) => ActionResult;
  executePlan: (id: string) => ActionResult;
  retryQueued: (id: string) => void;
  syncQueue: () => { synced: number; failed: number };
  clearSynced: () => void;
  dismissQueued: (id: string) => void;
}

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** 计划当前依据：车辆数 + 覆盖车站的实时状态 */
function currentBasis(plan: ShuttlePlan, stations: Station[]): PlanBasis {
  const map: Record<string, StationStatus> = {};
  for (const id of plan.stations) {
    const station = stations.find((item) => item.id === id);
    if (station) map[id] = station.status;
  }
  return { vehicles: plan.vehicles, stations: map };
}

/** 依据是否仍与确认快照一致（车辆数、车站状态任一变化即失效） */
export function basisMatches(plan: ShuttlePlan, stations: Station[]): boolean {
  if (!plan.basis) return false;
  const latest = currentBasis(plan, stations);
  if (latest.vehicles !== plan.basis.vehicles) return false;
  if (Object.keys(latest.stations).length !== Object.keys(plan.basis.stations).length) return false;
  return Object.entries(latest.stations).every(([id, status]) => plan.basis!.stations[id] === status);
}

/** 计划是否已集齐调度员 + 公交接驳负责人双重确认 */
export function hasDualApproval(plan: ShuttlePlan): boolean {
  const roles = new Set(plan.approvals.map((item) => item.role));
  return REQUIRED_APPROVERS.every((role) => roles.has(role));
}

interface InvalidationResult {
  plans: ShuttlePlan[];
  timeline: TimelineEntry[];
}

/**
 * 车站状态或车辆数变化后，受影响计划的旧确认立刻作废：
 * 清空审批、回到待确认、记录作废原因。
 */
function invalidatePlans(args: {
  plans: ShuttlePlan[];
  stationId?: string;
  planId?: string;
  reason: string;
}): InvalidationResult {
  const extra: TimelineEntry[] = [];
  const plans = args.plans.map((plan) => {
    if (plan.status === "已执行" || plan.status === "草稿") return plan;
    const affected = args.planId
      ? plan.id === args.planId
      : args.stationId
        ? plan.stations.includes(args.stationId)
        : false;
    if (!affected || plan.approvals.length === 0) {
      return affected ? { ...plan, status: "待确认" as PlanStatus, invalidReason: args.reason } : plan;
    }
    extra.push({
      id: uid(),
      time: now(),
      actor: "系统",
      action: "确认自动作废",
      detail: `计划 ${plan.stations.join("、")}（${plan.vehicles} 辆）：${args.reason}`,
      phase: "接驳"
    });
    return {
      ...plan,
      status: "待确认" as PlanStatus,
      approvals: [],
      basis: undefined,
      invalidReason: args.reason
    };
  });
  return { plans, timeline: extra };
}

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now(), syncedVersion: 2, lastSyncedBy: "车站值班员", syncedUpdatedAt: now() },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now(), syncedVersion: 1, lastSyncedBy: "调度员", syncedUpdatedAt: now() },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now(), syncedVersion: 0, syncedUpdatedAt: now() }
];

function initialState() {
  return {
    incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中" as IncidentStatus, startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
    stations: seedStations,
    timeline: [
      { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员" as TimelineActor, action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" as const },
      { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员" as TimelineActor, action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" as const }
    ],
    plans: [
      {
        id: "p1",
        stations: ["s1", "s2"],
        vehicles: 8,
        interval: 6,
        operator: "东城公交",
        status: "待确认" as PlanStatus,
        approvals: [{ role: "调度员" as Role, at: now() }],
        note: "优先疏运站外滞留乘客",
        invalidReason: "等待公交接驳负责人确认",
        updatedAt: now()
      }
    ],
    role: "调度员" as Role,
    online: true,
    queue: [] as QueueEntry[]
  };
}

// ---- 提交侧（服务端语义）：模拟重新连接后的逐条校验提交 ----

interface CommitContext {
  stations: Station[];
  plans: ShuttlePlan[];
  timeline: TimelineEntry[];
}
interface CommitOutput extends CommitContext {
  planId?: string;
  stationId?: string;
}

/**
 * 车站状态提交：按角色优先级放行并发修改。
 * 操作基于入队时看到的服务端状态（OCC）：
 *  - 所依据版本已被更高优先级岗位的并发修改覆盖时，值班员修改被拦截；
 *  - 调度员的并发修改永远放行（跨岗位并发冲突按权限放行）。
 */
function commitStation(ctx: CommitContext, entry: Extract<QueueEntry, { action: "更新车站状态" }>): { result: ActionResult; output?: CommitOutput } {
  if (!canWriteStation(entry.actor)) return { result: { ok: false, reason: "角色无车站状态维护权限" } };
  const station = ctx.stations.find((item) => item.id === entry.stationId);
  if (!station) return { result: { ok: false, reason: "车站不存在" } };

  // 依据版本之后出现过并发的已提交修改
  const overwritten = station.syncedVersion !== entry.baseVersion;
  if (overwritten && entry.actor !== "调度员") {
    const blockerHigher = station.lastSyncedBy !== undefined && ROLE_PRIORITY[station.lastSyncedBy] > ROLE_PRIORITY[entry.actor];
    if (blockerHigher) {
      return { result: { ok: false, reason: `并发冲突：${station.lastSyncedBy}已更新「${station.name}」状态（权限优先级更高），${entry.actor}的修改被拦截，请核对现场后重试` } };
    }
  }

  const stations = ctx.stations.map((item) =>
    item.id === entry.stationId
      ? { ...item, status: entry.next, note: entry.note ?? item.note, updatedAt: entry.time, syncedVersion: Math.max(item.syncedVersion, entry.baseVersion) + 1, lastSyncedBy: entry.actor, syncedUpdatedAt: entry.time }
      : item
  );
  return {
    result: { ok: true },
    output: { ...ctx, stations, stationId: entry.stationId }
  };
}

function commitTimeline(ctx: CommitContext, entry: Extract<QueueEntry, { action: "添加处置记录" }>): { result: ActionResult; output?: CommitOutput } {
  return {
    result: { ok: true },
    output: { ...ctx, timeline: [{ ...entry.entry, id: uid(), time: entry.time, actor: entry.actor }, ...ctx.timeline] }
  };
}

function commitPlanCreate(ctx: CommitContext, entry: Extract<QueueEntry, { action: "新建接驳计划" }>): { result: ActionResult; output?: CommitOutput } {
  if (!canWritePlan(entry.actor)) return { result: { ok: false, reason: "角色无接驳计划维护权限" } };
  const id = `p-${entry.id.slice(0, 8)}`;
  if (ctx.plans.some((item) => item.id === id)) return { result: { ok: true }, output: { ...ctx, planId: id } };
  const plan: ShuttlePlan = { ...entry.plan, id, status: "草稿", approvals: [], updatedAt: entry.time };
  return { result: { ok: true }, output: { ...ctx, plans: [plan, ...ctx.plans], planId: id } };
}

function commitSubmit(ctx: CommitContext, entry: Extract<QueueEntry, { action: "提交接驳计划" }>): { result: ActionResult; output?: CommitOutput } {
  if (!canWritePlan(entry.actor)) return { result: { ok: false, reason: "角色无接驳计划维护权限" } };
  const plan = ctx.plans.find((item) => item.id === entry.planId);
  if (!plan) return { result: { ok: false, reason: "计划不存在" } };
  if (plan.status === "待确认" || plan.status === "已确认" || plan.status === "已执行") {
    // 本地乐观状态可能已推进，排队的提交视为幂等成功
    return { result: { ok: true }, output: { ...ctx, planId: plan.id } };
  }
  const plans = ctx.plans.map((item) => item.id === plan.id ? { ...item, status: "待确认" as PlanStatus, invalidReason: item.invalidReason ?? "等待调度员与公交接驳负责人双重确认" } : item);
  return { result: { ok: true }, output: { ...ctx, plans, planId: plan.id } };
}

function commitApprove(ctx: CommitContext, entry: Extract<QueueEntry, { action: "确认接驳计划" }>): { result: ActionResult; output?: CommitOutput } {
  if (!canWritePlan(entry.actor)) return { result: { ok: false, reason: "客服主管无权确认接驳计划" } };
  const plan = ctx.plans.find((item) => item.id === entry.planId);
  if (!plan) return { result: { ok: false, reason: "计划不存在" } };
  if (plan.status === "已执行") {
    // 本地乐观已执行：排队中的确认仅当其确实在审批记录中时幂等成功，否则说明执行被回滚
    return plan.approvals.some((a) => a.role === entry.actor)
      ? { result: { ok: true }, output: { ...ctx, planId: plan.id } }
      : { result: { ok: false, reason: "计划执行前依据已变化，确认被回滚" } };
  }
  if (plan.status === "草稿") return { result: { ok: false, reason: "计划尚未提交确认" } };
  if (plan.approvals.some((item) => item.role === entry.actor)) return { result: { ok: true }, output: { ...ctx, planId: plan.id } };

  const approvals = [...plan.approvals, { role: entry.actor, at: entry.time }];
  const dual = REQUIRED_APPROVERS.every((role) => approvals.some((item) => item.role === role));
  const plans = ctx.plans.map((item) => item.id === plan.id ? {
    ...item,
    approvals,
    // 双确认集齐才锁定依据并置为已确认；否则继续等待
    status: dual ? "已确认" as PlanStatus : "待确认" as PlanStatus,
    basis: dual ? currentBasis(plan, ctx.stations) : undefined,
    invalidReason: dual ? undefined : "等待调度员与公交接驳负责人双重确认"
  } : item);
  return { result: { ok: true }, output: { ...ctx, plans, planId: plan.id } };
}

function commitVehicles(ctx: CommitContext, entry: Extract<QueueEntry, { action: "调整车辆数" }>): { result: ActionResult; output?: CommitOutput } {
  if (!canWritePlan(entry.actor)) return { result: { ok: false, reason: "角色无接驳计划维护权限" } };
  const plan = ctx.plans.find((item) => item.id === entry.planId);
  if (!plan) return { result: { ok: false, reason: "计划不存在" } };
  if (plan.status === "已执行") return { result: { ok: false, reason: "计划已执行，车辆数不可调整" } };
  if (plan.vehicles === entry.vehicles) return { result: { ok: true }, output: { ...ctx, planId: plan.id } };

  const moved: ShuttlePlan = { ...plan, vehicles: entry.vehicles, updatedAt: entry.time };
  // 车辆数变化：相关确认立刻作废、回到待确认
  const invalid = invalidatePlans({ plans: [moved], planId: plan.id, reason: `车辆数由 ${plan.vehicles} 调整为 ${entry.vehicles}` });
  const timeline = [...invalid.timeline, ...ctx.timeline];
  const plans = ctx.plans.map((item) => item.id === plan.id ? invalid.plans[0] : item);
  return { result: { ok: true }, output: { ...ctx, plans, timeline, planId: plan.id } };
}

function commitExecute(ctx: CommitContext, entry: Extract<QueueEntry, { action: "执行接驳计划" }>): { result: ActionResult; output?: CommitOutput } {
  if (!canWritePlan(entry.actor)) return { result: { ok: false, reason: "角色无接驳计划执行权限" } };
  const plan = ctx.plans.find((item) => item.id === entry.planId);
  if (!plan) return { result: { ok: false, reason: "计划不存在" } };
  // 执行前重新校验：必须双确认、且确认依据仍与现场一致
  if (!hasDualApproval(plan)) return { result: { ok: false, reason: "缺少调度员或公交接驳负责人确认，计划未生效" } };
  if (!basisMatches(plan, ctx.stations)) {
    // 本地乐观执行为「已执行」，提交侧复核失败：回滚为待确认并强制清空双重确认
    const reason = "执行前复核：覆盖车站状态或车辆数已变化，旧确认失效";
    const plans = ctx.plans.map((item) => item.id === plan.id ? {
      ...item,
      status: "待确认" as PlanStatus,
      approvals: [],
      basis: undefined,
      invalidReason: reason
    } : item);
    const timeline = [{
      id: uid(),
      time: entry.time,
      actor: "系统" as TimelineActor,
      action: "确认自动作废",
      detail: `计划 ${plan.stations.join("、")}：${reason}`,
      phase: "接驳" as const
    }, ...ctx.timeline];
    return { result: { ok: false, reason: "确认依据已变化（车站状态/车辆数），确认作废，需重新双重确认" }, output: { ...ctx, plans, timeline } };
  }
  const plans = ctx.plans.map((item) => item.id === plan.id ? { ...item, status: "已执行" as PlanStatus, updatedAt: entry.time } : item);
  const timeline = [{
    id: uid(),
    time: entry.time,
    actor: entry.actor,
    action: "执行接驳计划",
    detail: `${plan.stations.length} 座车站、${plan.vehicles} 辆车的接驳指令已下发`,
    phase: "接驳" as const
  }, ...ctx.timeline];
  return { result: { ok: true }, output: { ...ctx, plans, timeline, planId: plan.id } };
}

/**
 * 重新连接后先合并待同步操作：同岗位连续修改合并为最后一次、
 * 重复提交/重复确认去重，失败条目不参与合并。
 */
function mergeQueue(queue: QueueEntry[], plans: ShuttlePlan[]): { merged: QueueEntry[]; dropped: string[] } {
  const pending = queue.filter((entry) => entry.status === "待同步");
  const kept = queue.filter((entry) => entry.status !== "待同步");
  const dropped = new Set<string>();
  const redirect = new Map<string, string>();
  const depsOverride = new Map<string, string[]>();

  // 同岗位对同一车站的连续修改：保留最后一次
  for (const stationId of Array.from(new Set(pending.map((e) => e.action === "更新车站状态" ? e.stationId : "")))) {
    if (!stationId) continue;
    const group = pending.filter((e): e is Extract<QueueEntry, { action: "更新车站状态" }> => e.action === "更新车站状态" && e.stationId === stationId);
    for (const actor of Array.from(new Set(group.map((e) => e.actor)))) {
      const chain = group.filter((e) => e.actor === actor);
      if (chain.length < 2) continue;
      const winner = chain[chain.length - 1];
      chain.slice(0, -1).forEach((e) => { dropped.add(e.id); redirect.set(e.id, winner.id); });
      const mergedDeps = new Set(winner.dependsOn);
      chain.forEach((e) => e.dependsOn.forEach((d) => mergedDeps.add(d)));
      depsOverride.set(winner.id, Array.from(mergedDeps).filter((d) => d !== winner.id && !dropped.has(d)));
    }
  }

  // 同一计划的重复提交只保留第一次；连续车辆数调整保留最后一次；重复确认去重
  for (const planId of Array.from(new Set(pending.map((e) => "planId" in e ? e.planId : "")))) {
    if (!planId) continue;
    const submits = pending.filter((e) => e.action === "提交接驳计划" && e.planId === planId);
    submits.slice(1).forEach((e) => dropped.add(e.id));
    const vehicles = pending.filter((e): e is Extract<QueueEntry, { action: "调整车辆数" }> => e.action === "调整车辆数" && e.planId === planId);
    if (vehicles.length > 1) {
      const winner = vehicles[vehicles.length - 1];
      vehicles.slice(0, -1).forEach((e) => { dropped.add(e.id); redirect.set(e.id, winner.id); });
    }
    const approvePairs = new Set<string>();
    for (const entry of pending) {
      if (entry.action === "确认接驳计划" && entry.planId === planId) {
        const key = `${planId}:${entry.actor}`;
        if (approvePairs.has(key)) dropped.add(entry.id);
        else approvePairs.add(key);
      }
    }
  }

  const rewrite = (deps: string[], self?: string) => deps.map((d) => redirect.get(d) ?? d).filter((d) => !dropped.has(d) && d !== self);
  const fixDeps = (entry: QueueEntry): string[] => {
    const deps = new Set(rewrite(depsOverride.get(entry.id) ?? entry.dependsOn, entry.id));
    if ("planId" in entry) {
      const plan = plans.find((p) => p.id === entry.planId);
      pending.forEach((other) => {
        if (other.id === entry.id) return;
        // 同计划的更早操作一律作为前置（提交→确认→执行 的顺序由入队时间保证）
        if ("planId" in other && other.planId === entry.planId && other.time < entry.time) deps.add(other.id);
        // 执行前复核：同一弱网窗口内覆盖车站的任何未提交状态变更都必须先落库，
        // 无论它入队早于还是晚于执行（晚于说明执行指令尚未真正生效）
        if (entry.action === "执行接驳计划" && other.action === "更新车站状态" && plan?.stations.includes(other.stationId)) deps.add(other.id);
      });
    }
    return Array.from(deps);
  };
  const merged = pending
    .filter((entry) => !dropped.has(entry.id))
    .map((entry) => ({ ...entry, dependsOn: fixDeps(entry) }))
    .sort((a, b) => a.time.localeCompare(b.time));
  const keptFixed = kept.map((entry) => ({ ...entry, dependsOn: rewrite(entry.dependsOn, entry.id) }));
  return { merged: [...merged, ...keptFixed], dropped: Array.from(dropped) };
}

/** 按依赖关系拓扑排序；前置缺失（失败/被合并）不阻塞后续提交 */
function topoOrder(entries: QueueEntry[]): QueueEntry[] {
  const ids = new Set(entries.map((e) => e.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  entries.forEach((e) => {
    const validDeps = e.dependsOn.filter((d) => ids.has(d) && d !== e.id);
    indegree.set(e.id, new Set(validDeps).size);
    validDeps.forEach((d) => dependents.set(d, [...(dependents.get(d) ?? []), e.id]));
  });
  // 同层级按入队时间先后提交
  const ready = entries.filter((e) => (indegree.get(e.id) ?? 0) === 0).sort((a, b) => a.time.localeCompare(b.time));
  const result: QueueEntry[] = [];
  const enqueued = new Set<string>();
  while (ready.length) {
    const entry = ready.shift()!;
    if (enqueued.has(entry.id)) continue;
    enqueued.add(entry.id);
    result.push(entry);
    for (const depId of dependents.get(entry.id) ?? []) {
      indegree.set(depId, (indegree.get(depId) ?? 1) - 1);
      if ((indegree.get(depId) ?? 0) <= 0) {
        const next = entries.find((e) => e.id === depId);
        if (next) ready.push(next);
      }
    }
    ready.sort((a, b) => a.time.localeCompare(b.time));
  }
  // 依赖指向失败条目（图中不存在于当前可提交集合）的操作仍然追加提交
  entries.filter((e) => !enqueued.has(e.id)).sort((a, b) => a.time.localeCompare(b.time)).forEach((e) => result.push(e));
  return result;
}

const incidentCreator: StateCreator<IncidentState, [], [], IncidentState> = (set, get) => {
  /** 弱网下：本地先乐观生效，同时把操作按依赖关系放入队列 */
  const enqueue = (entry: QueueEntry) => set({ queue: [entry, ...get().queue] });

  return {
    ...initialState(),

    setRole: (role) => set({ role }),

    setOnline: (online) => {
      set({ online });
      // 重新连接后自动合并并提交队列
      if (online && get().queue.some((entry) => entry.status === "待同步")) {
        get().syncQueue();
      }
    },

    setStationStatus: (id, status, note) => {
      const state = get();
      if (!canWriteStation(state.role)) return { ok: false, reason: "客服主管无权改动车站状态" };
      const station = state.stations.find((item) => item.id === id);
      if (!station) return { ok: false, reason: "车站不存在" };

      // 车站状态变化：覆盖该站的计划旧确认立刻作废、回到待确认
      const invalid = invalidatePlans({
        plans: state.plans,
        stationId: id,
        reason: `覆盖车站「${station.name}」状态由 ${station.status} 变为 ${status}`
      });
      const timelineEntry: TimelineEntry = {
        id: uid(),
        time: now(),
        actor: state.role,
        action: "更新车站状态",
        detail: `${station.name}：${station.status} → ${status}`,
        phase: status === "正常" || status === "恢复中" ? "恢复" : "响应"
      };

      if (!state.online) {
        // 依赖同岗位此前对同一车站的未提交修改；跨岗位不串联，从而暴露并发冲突
        const prior = get().queue.find((e) => e.status === "待同步" && e.action === "更新车站状态" && e.stationId === id && e.actor === state.role);
        enqueue({
          id: uid(),
          time: now(),
          actor: state.role,
          status: "待同步",
          retries: 0,
          dependsOn: prior ? [prior.id] : [],
          action: "更新车站状态",
          stationId: id,
          next: status,
          note,
          baseVersion: station.syncedVersion,
          baseUpdatedAt: station.syncedUpdatedAt
        });
      }

      const changedAt = now();
      set({
        stations: state.stations.map((item) => item.id === id
          ? {
              ...item,
              status,
              note: note ?? item.note,
              updatedAt: changedAt,
              // 在线即视为提交成功，推进服务端版本；弱网下版本保持不变，留待同步时按 OCC 校验
              ...(state.online ? { syncedVersion: item.syncedVersion + 1, lastSyncedBy: state.role, syncedUpdatedAt: changedAt } : {})
            }
          : item),
        plans: invalid.plans,
        timeline: [{ ...timelineEntry, time: changedAt }, ...invalid.timeline, ...state.timeline]
      });
      return { ok: true };
    },

    addTimeline: (entry) => {
      const state = get();
      const full: TimelineEntry = { ...entry, id: uid(), time: now(), actor: state.role };
      if (!state.online) {
        enqueue({ id: uid(), time: now(), actor: state.role, status: "待同步", retries: 0, dependsOn: [], action: "添加处置记录", entry });
      }
      set({ timeline: [full, ...state.timeline] });
      return { ok: true };
    },

    addPlan: (plan) => {
      const state = get();
      if (!canWritePlan(state.role)) return { ok: false, reason: "客服主管无权维护接驳计划" };
      const queueId = uid();
      // 本地计划 ID 与提交侧（按队列条目派生）保持一致，保证排队中的提交/确认能引用到计划
      const id = `p-${queueId.slice(0, 8)}`;
      const full: ShuttlePlan = { ...plan, id, status: "草稿", approvals: [], updatedAt: now() };
      if (!state.online) {
        enqueue({ id: queueId, time: now(), actor: state.role, status: "待同步", retries: 0, dependsOn: [], action: "新建接驳计划", plan });
      }
      set({ plans: [full, ...state.plans] });
      return { ok: true };
    },

    submitPlan: (id) => {
      const state = get();
      if (!canWritePlan(state.role)) return { ok: false, reason: "客服主管无权提交接驳计划" };
      const plan = state.plans.find((item) => item.id === id);
      if (!plan) return { ok: false, reason: "计划不存在" };
      if (plan.status !== "草稿") return { ok: false, reason: "仅草稿状态可提交" };
      if (!state.online) {
        const create = get().queue.find((e) => e.status === "待同步" && e.action === "新建接驳计划");
        const deps = create ? [create.id] : [];
        enqueue({ id: uid(), time: now(), actor: state.role, status: "待同步", retries: 0, dependsOn: deps, action: "提交接驳计划", planId: id });
      }
      set({
        plans: state.plans.map((item) => item.id === id ? { ...item, status: "待确认", invalidReason: "等待调度员与公交接驳负责人双重确认" } : item),
        timeline: [{ id: uid(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${plan.stations.join("、")} 等待双重确认`, phase: "接驳" }, ...state.timeline]
      });
      return { ok: true };
    },

    approvePlan: (id) => {
      const state = get();
      if (!canWritePlan(state.role)) return { ok: false, reason: "客服主管无权确认接驳计划" };
      const plan = state.plans.find((item) => item.id === id);
      if (!plan) return { ok: false, reason: "计划不存在" };
      if (plan.status === "草稿") return { ok: false, reason: "计划尚未提交" };
      if (plan.status === "已执行") return { ok: false, reason: "计划已执行" };
      if (plan.approvals.some((item) => item.role === state.role)) return { ok: false, reason: "本岗位已确认，请勿重复确认" };

      if (!state.online) {
        const deps: string[] = [];
        // 依赖未提交的提交动作，以及覆盖车站尚未提交的状态变化
        get().queue.forEach((e) => {
          if (e.status !== "待同步") return;
          if (e.action === "提交接驳计划" && e.planId === id) deps.push(e.id);
          if (e.action === "更新车站状态" && plan.stations.includes(e.stationId)) deps.push(e.id);
        });
        enqueue({ id: uid(), time: now(), actor: state.role, status: "待同步", retries: 0, dependsOn: Array.from(new Set(deps)), action: "确认接驳计划", planId: id });
      }

      const approvals = [...plan.approvals, { role: state.role, at: now() }];
      const dual = REQUIRED_APPROVERS.every((role) => approvals.some((item) => item.role === role));
      set({
        plans: state.plans.map((item) => item.id === id ? {
          ...item,
          approvals,
          status: dual ? "已确认" : "待确认",
          basis: dual ? currentBasis(plan, state.stations) : undefined,
          invalidReason: dual ? undefined : "等待调度员与公交接驳负责人双重确认"
        } : item),
        timeline: dual
          ? [{ id: uid(), time: now(), actor: state.role, action: "接驳计划双确认通过", detail: `计划 ${plan.stations.join("、")} 已由调度员与公交接驳负责人共同确认`, phase: "接驳" }, ...state.timeline]
          : state.timeline
      });
      return { ok: true };
    },

    changeVehicles: (id, vehicles) => {
      const state = get();
      if (!canWritePlan(state.role)) return { ok: false, reason: "客服主管无权调整接驳计划" };
      const plan = state.plans.find((item) => item.id === id);
      if (!plan) return { ok: false, reason: "计划不存在" };
      if (plan.status === "已执行") return { ok: false, reason: "计划已执行，车辆数不可调整" };
      if (plan.vehicles === vehicles) return { ok: false, reason: "车辆数未变化" };

      if (!state.online) {
        const deps: string[] = [];
        get().queue.forEach((e) => {
          if (e.status !== "待同步") return;
          if (e.action === "提交接驳计划" && e.planId === id) deps.push(e.id);
        });
        enqueue({ id: uid(), time: now(), actor: state.role, status: "待同步", retries: 0, dependsOn: deps, action: "调整车辆数", planId: id, vehicles });
      }

      const moved = { ...plan, vehicles, updatedAt: now() };
      const invalid = invalidatePlans({ plans: [moved], planId: id, reason: `车辆数由 ${plan.vehicles} 调整为 ${vehicles}` });
      set({ plans: state.plans.map((item) => item.id === id ? invalid.plans[0] : item), timeline: [...invalid.timeline, ...state.timeline] });
      return { ok: true };
    },

    executePlan: (id) => {
      const state = get();
      if (!canWritePlan(state.role)) return { ok: false, reason: "客服主管无权执行接驳计划" };
      const plan = state.plans.find((item) => item.id === id);
      if (!plan) return { ok: false, reason: "计划不存在" };

      // 执行前按双重确认重新校验：先确认双确认齐备，再复核确认依据是否仍与现场一致
      if (!hasDualApproval(plan)) return { ok: false, reason: "需调度员与公交接驳负责人双重确认后方可执行" };
      if (!basisMatches(plan, state.stations)) {
        const invalid = invalidatePlans({ plans: state.plans, planId: id, reason: "执行前复核：覆盖车站状态或车辆数已变化，旧确认失效" });
        set({ plans: invalid.plans, timeline: [...invalid.timeline, ...state.timeline] });
        return { ok: false, reason: "确认依据已变化，旧确认已作废，需重新双重确认" };
      }

      if (!state.online) {
        const deps: string[] = [];
        get().queue.forEach((e) => {
          if (e.status !== "待同步") return;
          if ("planId" in e && e.planId === id) deps.push(e.id);
          if (e.action === "更新车站状态" && plan.stations.includes(e.stationId)) deps.push(e.id);
        });
        enqueue({ id: uid(), time: now(), actor: state.role, status: "待同步", retries: 0, dependsOn: Array.from(new Set(deps)), action: "执行接驳计划", planId: id });
      }

      set({
        plans: state.plans.map((item) => item.id === id ? { ...item, status: "已执行", updatedAt: now() } : item),
        timeline: [{ id: uid(), time: now(), actor: state.role, action: "执行接驳计划", detail: `${plan.stations.length} 座车站、${plan.vehicles} 辆车的接驳指令已下发`, phase: "接驳" }, ...state.timeline]
      });
      return { ok: true };
    },

    retryQueued: (id) => set({ queue: get().queue.map((entry) => entry.id === id ? { ...entry, status: "待同步" as QueueStatus, reason: undefined, retries: entry.retries + 1 } : entry) }),

    dismissQueued: (id) => set({ queue: get().queue.filter((entry) => entry.id !== id) }),

    clearSynced: () => set({ queue: get().queue.filter((entry) => entry.status !== "已同步") }),

    syncQueue: () => {
      if (!get().online) return { synced: 0, failed: 0 };

      // 1) 先合并待同步操作
      const { merged } = mergeQueue(get().queue, get().plans);
      set({ queue: merged });

      const pending = merged.filter((entry) => entry.status === "待同步");
      let ctx: CommitContext = { stations: get().stations, plans: get().plans, timeline: get().timeline };
      let synced = 0;
      let failed = 0;
      const results = new Map<string, { result: ActionResult; output?: CommitOutput }>();

      // 1.5) 并发预检：同一车站、基于同一已同步版本、且无依赖关系的跨岗位修改视为并发。
      // 按角色权限放行：调度员覆盖值班员；低权限方直接失败并保留原因，不影响其他操作提交。
      const stationPending = pending.filter((e): e is Extract<QueueEntry, { action: "更新车站状态" }> => e.action === "更新车站状态");
      const blockedIds = new Set<string>();
      for (const entry of stationPending) {
        const rival = stationPending.find((other) =>
          other.id !== entry.id &&
          other.stationId === entry.stationId &&
          other.baseVersion === entry.baseVersion &&
          other.actor !== entry.actor &&
          // 有依赖关系的是先后修改，不是并发
          !entry.dependsOn.includes(other.id) && !other.dependsOn.includes(entry.id)
        );
        if (rival && ROLE_PRIORITY[rival.actor] > ROLE_PRIORITY[entry.actor]) {
          blockedIds.add(entry.id);
          results.set(entry.id, { result: { ok: false, reason: `并发冲突：${rival.actor}同时修改了该车站（权限优先级更高），${entry.actor}的修改不予放行，请核对现场后重试` } });
          failed += 1;
        }
      }

      // 2) 按依赖关系排序后逐条提交；某条失败不阻塞后续操作
      // 执行被提交侧驳回的计划：同计划后续排队确认一并标记失败，不能把作废的确认补回来
      const rejectedPlans = new Set<string>();
      for (const entry of topoOrder(pending)) {
        if (blockedIds.has(entry.id)) continue;
        if (entry.action === "确认接驳计划" && rejectedPlans.has(entry.planId)) {
          results.set(entry.id, { result: { ok: false, reason: "关联执行已被驳回（确认依据变化），该确认随旧确认一并作废" } });
          failed += 1;
          continue;
        }
        let commit: { result: ActionResult; output?: CommitOutput };
        switch (entry.action) {
          case "更新车站状态": commit = commitStation(ctx, entry); break;
          case "添加处置记录": commit = commitTimeline(ctx, entry); break;
          case "新建接驳计划": commit = commitPlanCreate(ctx, entry); break;
          case "提交接驳计划": commit = commitSubmit(ctx, entry); break;
          case "确认接驳计划": commit = commitApprove(ctx, entry); break;
          case "调整车辆数": commit = commitVehicles(ctx, entry); break;
          case "执行接驳计划": commit = commitExecute(ctx, entry); break;
        }
        results.set(entry.id, commit);
        if (commit.result.ok && commit.output) {
          ctx = commit.output;
          synced += 1;
        } else {
          // 失败不阻塞后续操作；若服务端复核产生了纠正视图（如执行被驳回后回滚计划），
          // 用该视图覆盖本地乐观状态，同时保留失败原因与重试次数
          if (commit.output) ctx = commit.output;
          if (entry.action === "执行接驳计划" && /确认作废|依据/.test(commit.result.reason ?? "")) rejectedPlans.add(entry.planId);
          failed += 1;
        }
      }

      const queue = get().queue.map((entry) => {
        const outcome = results.get(entry.id);
        if (!outcome) return entry;
        if (outcome.result.ok) return { ...entry, status: "已同步" as QueueStatus, reason: undefined };
        return { ...entry, status: "失败" as QueueStatus, reason: outcome.result.reason, retries: entry.retries + 1 };
      });

      set({ ...ctx, queue });
      return { synced, failed };
    }
  };
};

export const useIncidentStore = create<IncidentState>()(persist(incidentCreator, {
  name: "pair-wise-yf-47/incident-v2",
  version: 2,
  // 旧版（v1）持久化结构不兼容，直接丢弃
  migrate: () => initialState()
}));
