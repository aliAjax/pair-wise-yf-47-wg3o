import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";

export type Permission = "station:update" | "plan:create" | "plan:approve" | "plan:execute" | "timeline:add";
export type ActionKind = "station:status" | "plan:add" | "plan:submit" | "plan:approve" | "plan:vehicles" | "plan:execute" | "timeline:add";

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Role;
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
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: Role[];
  note: string;
}

export type PendingActionStatus = "待同步" | "同步失败";

export interface PendingAction {
  id: string;
  kind: ActionKind;
  entityKey: string;
  action: string;
  detail: string;
  time: string;
  payload: Record<string, unknown>;
  status: PendingActionStatus;
  retries: number;
  error?: string;
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => void;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => string;
  submitPlan: (id: string) => void;
  approvePlan: (id: string) => void;
  executePlan: (id: string) => void;
  updatePlanVehicles: (id: string, vehicles: number) => void;
  syncActions: () => Promise<{ submitted: number; failed: number }>;
  retryAction: (id: string) => void;
  removeFailedAction: (id: string) => void;
}

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/** 各岗位权限矩阵：客服主管只能查看，不能改动车站状态、不能确认/执行计划 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  调度员: ["station:update", "plan:create", "plan:approve", "plan:execute", "timeline:add"],
  车站值班员: ["station:update", "timeline:add"],
  公交接驳负责人: ["plan:create", "plan:approve", "plan:execute", "timeline:add"],
  客服主管: ["timeline:add"]
};

/** 接驳计划执行前必须完成调度员与公交接驳负责人的双重确认 */
export const REQUIRED_APPROVAL_ROLES: Role[] = ["调度员", "公交接驳负责人"];

export function roleCan(role: Role | undefined, permission: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].includes(permission);
}

export function missingApprovals(plan: ShuttlePlan): Role[] {
  return REQUIRED_APPROVAL_ROLES.filter((role) => !plan.approvals.includes(role));
}

class OpsError extends Error {}

type Mutation = Partial<Pick<IncidentState, "stations" | "plans" | "timeline">>;

const timelineEntry = (actor: Role, action: string, detail: string, phase: TimelineEntry["phase"]): TimelineEntry => ({
  id: uuid(),
  time: now(),
  actor,
  action,
  detail,
  phase
});

/** 车站状态或车辆数变化后，相关确认立刻作废并退回待确认 */
function invalidatePlans(plans: ShuttlePlan[], stationName: string): { plans: ShuttlePlan[]; invalidated: ShuttlePlan[] } {
  const invalidated: ShuttlePlan[] = [];
  const next = plans.map((plan) => {
    const touched = plan.stations.includes(stationName) && (plan.status === "已确认" || (plan.status === "待确认" && plan.approvals.length > 0));
    if (!touched) return plan;
    invalidated.push(plan);
    return { ...plan, status: "待确认" as PlanStatus, approvals: [] as Role[] };
  });
  return { plans: next, invalidated };
}

function applyStationStatus(state: IncidentState, stationId: string, status: StationStatus, note: string | undefined, actor: Role): Mutation {
  if (!roleCan(actor, "station:update")) throw new OpsError(`角色「${actor}」无权更新车站状态`);
  const station = state.stations.find((item) => item.id === stationId);
  if (!station) throw new OpsError("车站不存在");
  const stations = state.stations.map((item) => item.id === stationId ? { ...item, status, note: note ?? item.note, updatedAt: now() } : item);
  const { plans, invalidated } = invalidatePlans(state.plans, station.name);
  const timeline = [
    timelineEntry(actor, "更新车站状态", `${station.name} → ${status}${note ? `（${note}）` : ""}`, status === "正常" || status === "恢复中" ? "恢复" : "响应"),
    ...invalidated.map((plan) => timelineEntry("调度员", "接驳确认作废", `${station.name} 状态变化，计划 ${plan.id.slice(0, 6)} 的双重确认已作废，退回待确认`, "接驳")),
    ...state.timeline
  ];
  return { stations, plans, timeline };
}

function applyAddPlan(state: IncidentState, data: Omit<ShuttlePlan, "id" | "status" | "approvals">, actor: Role, id: string): Mutation {
  if (!roleCan(actor, "plan:create")) throw new OpsError(`角色「${actor}」无权新建接驳计划`);
  const plan: ShuttlePlan = { ...data, id, status: "草稿", approvals: [] };
  return {
    plans: [plan, ...state.plans],
    timeline: [timelineEntry(actor, "新建接驳计划", `${plan.stations.join("、")} 接驳计划已存为草稿（${plan.vehicles} 辆，间隔 ${plan.interval} 分钟）`, "接驳"), ...state.timeline]
  };
}

function applySubmitPlan(state: IncidentState, planId: string, actor: Role): Mutation {
  if (!roleCan(actor, "plan:create")) throw new OpsError(`角色「${actor}」无权提交计划`);
  const plan = state.plans.find((item) => item.id === planId);
  if (!plan) throw new OpsError("接驳计划不存在");
  if (plan.status !== "草稿") throw new OpsError(`计划 ${planId.slice(0, 6)} 当前为「${plan.status}」，仅草稿可提交`);
  const plans = state.plans.map((item) => item.id === planId ? { ...item, status: "待确认" as PlanStatus } : item);
  return { plans, timeline: [timelineEntry(actor, "提交接驳计划", `计划 ${planId.slice(0, 6)} 已提交，等待调度员与公交接驳负责人双重确认`, "接驳"), ...state.timeline] };
}

function applyApprovePlan(state: IncidentState, planId: string, actor: Role): Mutation {
  if (!roleCan(actor, "plan:approve")) throw new OpsError(`角色「${actor}」无权确认计划`);
  const plan = state.plans.find((item) => item.id === planId);
  if (!plan) throw new OpsError("接驳计划不存在");
  if (plan.status !== "待确认") throw new OpsError(`计划 ${planId.slice(0, 6)} 当前为「${plan.status}」，不可确认`);
  if (plan.approvals.includes(actor)) throw new OpsError(`「${actor}」已确认，无需重复操作`);
  const approvals = [...plan.approvals, actor];
  const done = missingApprovals({ ...plan, approvals }).length === 0;
  const plans = state.plans.map((item) => item.id === planId ? { ...item, approvals, status: done ? "已确认" as PlanStatus : "待确认" as PlanStatus } : item);
  const stillMissing = missingApprovals({ ...plan, approvals });
  const timeline = [
    timelineEntry(actor, "确认接驳计划", done
      ? `计划 ${planId.slice(0, 6)} 已完成调度员与公交接驳负责人双重确认`
      : `「${actor}」已确认计划 ${planId.slice(0, 6)}，仍需 ${stillMissing.join("、")} 确认`, "接驳"),
    ...state.timeline
  ];
  return { plans, timeline };
}

function applyPlanVehicles(state: IncidentState, planId: string, vehicles: number, actor: Role): Mutation {
  if (!roleCan(actor, "plan:create")) throw new OpsError(`角色「${actor}」无权修改车辆数`);
  const plan = state.plans.find((item) => item.id === planId);
  if (!plan) throw new OpsError("接驳计划不存在");
  if (plan.vehicles === vehicles) return {};
  const needReconfirm = plan.status === "已确认" || plan.approvals.length > 0;
  const plans = state.plans.map((item) => item.id === planId
    ? { ...item, vehicles, status: needReconfirm ? "待确认" as PlanStatus : item.status, approvals: needReconfirm ? [] as Role[] : item.approvals }
    : item);
  const timeline = [
    timelineEntry(actor, "调整接驳车辆", `计划 ${planId.slice(0, 6)} 车辆数 ${plan.vehicles} → ${vehicles}${needReconfirm ? "，相关确认作废并退回待确认" : ""}`, "接驳"),
    ...state.timeline
  ];
  return { plans, timeline };
}

function applyExecutePlan(state: IncidentState, planId: string, actor: Role): Mutation {
  if (!roleCan(actor, "plan:execute")) throw new OpsError(`角色「${actor}」无权执行计划`);
  const plan = state.plans.find((item) => item.id === planId);
  if (!plan) throw new OpsError("接驳计划不存在");
  const missing = missingApprovals(plan);
  if (plan.status !== "已确认" || missing.length > 0) {
    throw new OpsError(`计划 ${planId.slice(0, 6)} 未通过双重确认（缺少：${missing.join("、") || "状态已失效"}），禁止执行`);
  }
  const plans = state.plans.map((item) => item.id === planId ? { ...item, status: "已执行" as PlanStatus } : item);
  return { plans, timeline: [timelineEntry(actor, "执行接驳计划", `计划 ${planId.slice(0, 6)} 双重确认有效，已向车辆和站点岗位下发执行指令`, "接驳"), ...state.timeline] };
}

function applyTimeline(state: IncidentState, entry: Omit<TimelineEntry, "id" | "time">): Mutation {
  return { timeline: [timelineEntry(entry.actor, entry.action, entry.detail, entry.phase), ...state.timeline] };
}

function replay(state: IncidentState, action: PendingAction): Mutation {
  const payload = action.payload;
  switch (action.kind) {
    case "station:status": return applyStationStatus(state, payload.stationId as string, payload.status as StationStatus, payload.note as string | undefined, payload.actor as Role);
    case "plan:add": return applyAddPlan(state, payload.data as Omit<ShuttlePlan, "id" | "status" | "approvals">, payload.actor as Role, payload.planId as string);
    case "plan:submit": return applySubmitPlan(state, payload.planId as string, payload.actor as Role);
    case "plan:approve": return applyApprovePlan(state, payload.planId as string, payload.actor as Role);
    case "plan:vehicles": return applyPlanVehicles(state, payload.planId as string, payload.vehicles as number, payload.actor as Role);
    case "plan:execute": return applyExecutePlan(state, payload.planId as string, payload.actor as Role);
    case "timeline:add": return applyTimeline(state, payload.entry as Omit<TimelineEntry, "id" | "time">);
    default: throw new OpsError("未知操作类型，无法同步");
  }
}

/** 依赖顺序：车站状态 → 计划新建 → 提交 → 确认 → 车辆调整 → 执行 */
const DEPTH: Record<ActionKind, number> = {
  "station:status": 0,
  "timeline:add": 0,
  "plan:add": 1,
  "plan:submit": 2,
  "plan:approve": 3,
  "plan:vehicles": 4,
  "plan:execute": 5
};

/** 合并待同步操作：同车站状态变更保留最新一次；同计划操作按类型去重并保留依赖链；失败项保留待重试。返回合并结果与被丢弃的重复项 id */
function mergePending(actions: PendingAction[]): { merged: PendingAction[]; discardedIds: string[] } {
  const pending = actions.filter((action) => action.status === "待同步");
  const failed = actions.filter((action) => action.status === "同步失败");
  const groups = new Map<string, PendingAction[]>();
  for (const action of pending) {
    const list = groups.get(action.entityKey) ?? [];
    list.push(action);
    groups.set(action.entityKey, list);
  }
  const merged: PendingAction[] = [];
  const discardedIds: string[] = [];
  for (const [entityKey, list] of groups) {
    if (entityKey.startsWith("station:")) {
      const keep = list.reduce((a, b) => (a.time >= b.time ? a : b));
      merged.push(keep);
      for (const action of list) if (action.id !== keep.id) discardedIds.push(action.id);
    } else {
      const byKind = new Map<string, PendingAction>();
      for (const action of list) {
        const key = action.kind === "plan:approve" ? `${action.kind}:${action.payload.actor as Role}` : action.kind;
        const prev = byKind.get(key);
        if (!prev || action.time > prev.time) byKind.set(key, action);
      }
      merged.push(...byKind.values());
      const kept = new Set([...byKind.values()].map((action) => action.id));
      for (const action of list) if (!kept.has(action.id)) discardedIds.push(action.id);
    }
  }
  merged.sort((a, b) => DEPTH[a.kind] - DEPTH[b.kind] || a.time.localeCompare(b.time));
  return { merged: [...merged, ...failed], discardedIds };
}

/** 兼容旧版本队列项（无 kind/payload） */
function normalizeActions(raw: unknown): PendingAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const action = item as Partial<PendingAction>;
    if (action.kind && action.entityKey && action.payload) {
      return { status: "待同步", retries: 0, ...action } as PendingAction;
    }
    return {
      id: action.id ?? uuid(),
      kind: "station:status" as ActionKind,
      entityKey: "unknown",
      action: action.action ?? "未知操作",
      detail: action.detail ?? "",
      time: action.time ?? now(),
      payload: {},
      status: "同步失败" as PendingActionStatus,
      retries: 0,
      error: "旧版本队列项缺少操作类型，无法同步，请清除"
    };
  });
}

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

export const useIncidentStore = create<IncidentState>()(persist((set, get) => {
  const enqueue = (spec: { kind: ActionKind; entityKey: string; action: string; detail: string; payload: Record<string, unknown> }) => {
    const item: PendingAction = { id: uuid(), time: now(), status: "待同步", retries: 0, ...spec };
    set((state) => ({ pendingActions: [item, ...state.pendingActions] }));
  };

  return {
    incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
    stations: seedStations,
    timeline: [
      { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
      { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
    ],
    plans: [
      { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客" }
    ],
    role: "调度员",
    online: true,
    pendingActions: [],
    setRole: (role) => set({ role }),
    setOnline: (online) => set({ online }),

    setStationStatus: (id, status, note) => {
      const state = get();
      if (!state.online) {
        const station = state.stations.find((item) => item.id === id);
        enqueue({ kind: "station:status", entityKey: `station:${id}`, action: "更新车站状态", detail: `${station?.name ?? id} → ${status}`, payload: { stationId: id, status, note, actor: state.role } });
        return;
      }
      set(applyStationStatus(state, id, status, note, state.role));
    },

    addTimeline: (entry) => {
      const state = get();
      if (!state.online) {
        enqueue({ kind: "timeline:add", entityKey: `timeline:${uuid()}`, action: entry.action, detail: entry.detail, payload: { entry: { ...entry, actor: state.role } } });
        return;
      }
      set(applyTimeline(state, { ...entry, actor: state.role }));
    },

    addPlan: (data) => {
      const state = get();
      const planId = uuid();
      if (!state.online) {
        enqueue({ kind: "plan:add", entityKey: `plan:${planId}`, action: "新建接驳计划", detail: `${data.stations.join("、")}，${data.vehicles} 辆`, payload: { planId, data, actor: state.role } });
        return planId;
      }
      set(applyAddPlan(state, data, state.role, planId));
      return planId;
    },

    submitPlan: (id) => {
      const state = get();
      if (!state.online) {
        enqueue({ kind: "plan:submit", entityKey: `plan:${id}`, action: "提交接驳计划", detail: `计划 ${id.slice(0, 6)} 提交确认`, payload: { planId: id, actor: state.role } });
        return;
      }
      set(applySubmitPlan(state, id, state.role));
    },

    approvePlan: (id) => {
      const state = get();
      if (!state.online) {
        enqueue({ kind: "plan:approve", entityKey: `plan:${id}`, action: "确认接驳计划", detail: `「${state.role}」确认计划 ${id.slice(0, 6)}`, payload: { planId: id, actor: state.role } });
        return;
      }
      set(applyApprovePlan(state, id, state.role));
    },

    executePlan: (id) => {
      const state = get();
      if (!state.online) {
        enqueue({ kind: "plan:execute", entityKey: `plan:${id}`, action: "执行接驳计划", detail: `计划 ${id.slice(0, 6)} 下发执行`, payload: { planId: id, actor: state.role } });
        return;
      }
      set(applyExecutePlan(state, id, state.role));
    },

    updatePlanVehicles: (id, vehicles) => {
      const state = get();
      if (!state.online) {
        enqueue({ kind: "plan:vehicles", entityKey: `plan:${id}`, action: "调整接驳车辆", detail: `计划 ${id.slice(0, 6)} 车辆数 → ${vehicles}`, payload: { planId: id, vehicles, actor: state.role } });
        return;
      }
      set(applyPlanVehicles(state, id, vehicles, state.role));
    },

    syncActions: async () => {
      const state = get();
      if (!state.online) throw new OpsError("当前处于弱网，无法同步");
      const actions = normalizeActions(state.pendingActions);
      const { merged, discardedIds } = mergePending(actions);
      // 合并后重复的旧操作直接出队，不重复提交
      let queue = actions.filter((action) => !discardedIds.includes(action.id));
      if (discardedIds.length) set({ pendingActions: queue });
      let submitted = 0;
      let failed = 0;
      for (const action of merged) {
        try {
          if (action.status === "待同步" && Math.random() < 0.2) throw new OpsError("网络波动，同步失败，请重试");
          const mutation = replay(get(), action);
          queue = queue.filter((item) => item.id !== action.id);
          set({ ...mutation, pendingActions: queue });
          submitted += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : "同步失败";
          queue = queue.map((item) => item.id === action.id ? { ...item, status: "同步失败" as PendingActionStatus, retries: item.retries + 1, error: message } : item);
          set({ pendingActions: queue });
        }
      }
      return { submitted, failed };
    },

    retryAction: (id) => {
      const state = get();
      if (!state.online) throw new OpsError("当前处于弱网，无法同步");
      const actions = normalizeActions(state.pendingActions);
      const action = actions.find((item) => item.id === id);
      if (!action) return;
      try {
        const mutation = replay(state, action);
        set({ ...mutation, pendingActions: state.pendingActions.filter((item) => item.id !== id) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "同步失败";
        set({ pendingActions: state.pendingActions.map((item) => item.id === id ? { ...item, retries: item.retries + 1, error: message } : item) });
      }
    },

    removeFailedAction: (id) => set((state) => ({ pendingActions: state.pendingActions.filter((item) => item.id !== id) }))
  };
}, {
  name: "pair-wise-yf-47/incident",
  merge: (persisted, current) => {
    const persistedState = (persisted ?? {}) as Partial<IncidentState>;
    return { ...current, ...persistedState, pendingActions: normalizeActions(persistedState.pendingActions) };
  }
}));
