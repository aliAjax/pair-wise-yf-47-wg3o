"use client";

import { useEffect, useState } from "react";
import { App as AntApp, Badge, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Popconfirm, Select, Segmented, Space, Statistic, Table, Tag, Timeline, Tooltip } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { fetchStations } from "../lib/query";
import { MapPanel } from "../components/MapPanel";
import {
  useIncidentStore,
  canWriteStation,
  canWritePlan,
  REQUIRED_APPROVERS,
  type Role,
  type ShuttlePlan,
  type Station,
  type StationStatus,
  type QueueEntry,
  type ApprovalState
} from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(2, "至少选择两座接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

const stationName = (stations: Station[], id: string) => stations.find((item) => item.id === id)?.name ?? id;
const queueLabel: Record<QueueEntry["action"], string> = {
  "更新车站状态": "车站状态变更",
  "添加处置记录": "处置记录",
  "新建接驳计划": "新建计划",
  "提交接驳计划": "提交计划",
  "确认接驳计划": "确认计划",
  "调整车辆数": "调整车辆",
  "执行接驳计划": "执行计划"
};

function describeQueueEntry(entry: QueueEntry, stations: Station[], plans: ShuttlePlan[]): string {
  switch (entry.action) {
    case "更新车站状态": return `${stationName(stations, entry.stationId)} → ${entry.next}`;
    case "添加处置记录": return entry.entry.detail;
    case "新建接驳计划": return `${entry.plan.stations.map((id) => stationName(stations, id)).join(" → ")}，${entry.plan.vehicles} 辆`;
    case "提交接驳计划":
    case "确认接驳计划":
    case "执行接驳计划": {
      const plan = plans.find((item) => item.id === entry.planId);
      return plan ? `${plan.stations.map((id) => stationName(stations, id)).join(" → ")}` : entry.planId;
    }
    case "调整车辆数": {
      const plan = plans.find((item) => item.id === entry.planId);
      return `${plan ? plan.stations.map((id) => stationName(stations, id)).join(" → ") : entry.planId}：${plan?.vehicles ?? "?"} → ${entry.vehicles} 辆`;
    }
  }
}

function Dashboard() {
  const t = useTranslations();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const state = useIncidentStore();
  const { data: cachedStations } = useQuery({ queryKey: ["stations"], queryFn: fetchStations, enabled: state.online });
  const [modalOpen, setModalOpen] = useState(false);
  const [panel, setPanel] = useState<string>("总览");
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["s1", "s2"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });

  useEffect(() => { if (!state.online) queryClient.cancelQueries({ queryKey: ["stations"] }); }, [state.online, queryClient]);

  const guard = (result: { ok: boolean; reason?: string }) => {
    if (result.ok) message.success("操作已生效");
    else message.error(result.reason ?? "操作被拒绝");
  };

  const approvalTag = (approvals: ApprovalState[]) => REQUIRED_APPROVERS.map((role) => {
    const hit = approvals.find((item) => item.role === role);
    return hit
      ? <Tag key={role} color="green">{role} 已确认</Tag>
      : <Tag key={role}>{role} 待确认</Tag>;
  });

  const stationColumns: ColumnsType<Station> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    { title: "状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={value === "封闭" ? "red" : value === "限流" ? "orange" : value === "恢复中" ? "blue" : "green"}>{value}</Tag> },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    { title: "现场说明", dataIndex: "note" },
    { title: "更新时间", dataIndex: "updatedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    {
      title: "处置",
      render: (_, record) => canWriteStation(state.role)
        ? <Space>
            <Button size="small" disabled={record.status === "限流"} onClick={() => guard(state.setStationStatus(record.id, "限流"))}>限流</Button>
            <Button size="small" danger={record.status !== "封闭"} onClick={() => guard(state.setStationStatus(record.id, record.status === "封闭" ? "恢复中" : "封闭"))}>{record.status === "封闭" ? "恢复中" : "封闭"}</Button>
            <Button size="small" type="dashed" disabled={record.status === "正常"} onClick={() => guard(state.setStationStatus(record.id, "正常"))}>恢复正常</Button>
          </Space>
        : <Tooltip title="客服主管仅可查看，不能改动车站状态"><Tag>无处置权限</Tag></Tooltip>
    }
  ];

  const submitPlan = (values: PlanForm) => {
    const parsed = planSchema.safeParse(values);
    if (!parsed.success) { message.error(parsed.error.issues[0]?.message ?? "表单校验失败"); return; }
    guard(state.addPlan(parsed.data));
    setModalOpen(false);
    reset();
  };

  const queueColumns: ColumnsType<QueueEntry> = [
    { title: "时间", dataIndex: "time", width: 90, render: (v: string) => format(new Date(v), "HH:mm:ss") },
    { title: "岗位", dataIndex: "actor", width: 110, render: (v: Role) => <Tag>{v}</Tag> },
    { title: "操作", dataIndex: "action", width: 110, render: (v: QueueEntry["action"]) => queueLabel[v] },
    { title: "内容", render: (_, record) => describeQueueEntry(record, state.stations, state.plans) },
    {
      title: "依赖",
      dataIndex: "dependsOn",
      width: 90,
      render: (deps: string[]) => deps.length
        ? <Tooltip title={deps.map((id, i) => `前置 ${i + 1}: ${id.slice(0, 6)}`).join("\n")}><Tag color="geekblue">{deps.length} 项前置</Tag></Tooltip>
        : <span style={{ color: "#9aa4b5" }}>无</span>
    },
    {
      title: "重试",
      dataIndex: "retries",
      width: 60,
      render: (v: number) => v
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 320,
      render: (status, record) => {
        if (status === "已同步") return <Tag color="green">已同步提交</Tag>;
        if (status === "失败") return <Space direction="vertical" size={2}>
          <Tag color="red">提交失败 · 第 {record.retries} 次</Tag>
          <small style={{ color: "#cf1322" }}>{record.reason}</small>
          <Space size={4}>
            <Button size="small" type="primary" onClick={() => { state.retryQueued(record.id); const r = state.syncQueue(); message.info(`提交完成：成功 ${r.synced} 条，失败 ${r.failed} 条，失败操作已保留`); }}>重试本条</Button>
            <Popconfirm title="放弃该操作？本地乐观结果将保留，请人工核对" onConfirm={() => state.dismissQueued(record.id)}><Button size="small">放弃</Button></Popconfirm>
          </Space>
        </Space>;
        return <Tag color="orange">待同步（弱网本地队列）</Tag>;
      }
    }
  ];

  const pendingCount = state.queue.filter((item) => item.status === "待同步").length;
  const failedCount = state.queue.filter((item) => item.status === "失败").length;

  return <div className="shell">
    <aside className="side">
      <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
      <nav>{["总览", "事件时间线", "接驳计划", "确认中心"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
      <div className="side-status"><small>系统连接</small><b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b><span>最近缓存 32 秒前</span></div>
    </aside>
    <main>
      <header><div><small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><Space><Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} /><Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} /></Space></header>
      <section className="metrics"><Card><Statistic title="事件状态" value={state.incident.status} /></Card><Card><Statistic title="受影响车站" value={state.stations.filter((item) => item.status !== "正常").length} suffix="座" /></Card><Card><Statistic title="待确认计划" value={state.plans.filter((item) => item.status === "待确认").length} /></Card><Card><Statistic title="待同步操作" value={pendingCount} suffix={failedCount ? `（失败 ${failedCount}）` : ""} /></Card></section>
      {!state.online && <div className="degrade">当前处于弱网降级模式，显示最近缓存数据。处置会按依赖关系进入本地队列；重新连接后自动合并并逐条提交，单条失败不影响后续操作。</div>}
      {failedCount > 0 && state.online && <div className="degrade" style={{ background: "#fff1f0", borderColor: "#ffa39e" }}>有 {failedCount} 条操作提交失败，已保留原因和重试次数，可在「确认中心」重试或放弃。</div>}
      {panel === "总览" && <section className="overview">
        <Card title={t("stations")} className="wide"><Table rowKey="id" dataSource={state.online && cachedStations?.length ? cachedStations : state.stations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 760 }} /></Card>
        <Card title="受影响区段" className="map-card"><MapPanel stations={state.stations} plans={state.plans.filter((plan) => plan.status !== "草稿")} /></Card>
      </section>}
      {panel === "事件时间线" && <Card title="处置时间线" extra={<Space><Select value="响应" options={[{value:"响应"},{value:"接驳"},{value:"恢复"}]} /><Button type="primary" disabled={state.role === "客服主管"} onClick={() => guard(state.addTimeline({ action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" }))}>添加处置记录</Button></Space>}><div className="timeline-grid"><Timeline items={state.timeline.map((item) => ({ color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : item.actor === "系统" ? "gold" : "red", children: <div><b>{item.action}</b><Tag color={item.actor === "系统" ? "gold" : undefined}>{item.actor}</Tag><p>{item.detail}</p><small>{format(new Date(item.time), "MM-DD HH:mm:ss")} · {item.phase}</small></div> }))} /><Card size="small" title="处置检查"><p>车站封闭与广播口径已确认。</p><p>接驳车辆到场后需调度员和公交接驳负责人双方确认。</p><p>车站状态或车辆数变化后，旧确认自动作废，须重新双确认。</p><p>恢复行车前检查区间水位和站台安全。</p></Card></div></Card>}
      {panel === "接驳计划" && <Card title="公交接驳计划" extra={<Button type="primary" disabled={!canWritePlan(state.role)} onClick={() => setModalOpen(true)}>新建计划</Button>}><Table rowKey="id" pagination={false} dataSource={state.plans} columns={[
        { title: "接驳站", dataIndex: "stations", render: (v: string[]) => v.map((id) => stationName(state.stations, id)).join(" → ") },
        {
          title: "车辆",
          dataIndex: "vehicles",
          render: (v: number, record: ShuttlePlan) => canWritePlan(state.role) && record.status !== "已执行"
            ? <Space size={4}><span>{v}</span><InputNumber size="small" style={{ width: 64 }} min={1} max={80} defaultValue={v} onChange={(value) => { if (typeof value === "number" && value !== v) guard(state.changeVehicles(record.id, value)); }} /></Space>
            : <span>{v}</span>
        },
        { title: "间隔", dataIndex: "interval", render: (v: number) => `${v} 分钟` },
        { title: "运营方", dataIndex: "operator" },
        { title: "双重确认", dataIndex: "approvals", width: 240, render: (_v: ApprovalState[], record) => <Space size={2} wrap>{approvalTag(record.approvals)}</Space> },
        {
          title: "状态",
          dataIndex: "status",
          render: (v: ShuttlePlan["status"], record: ShuttlePlan) => <Space direction="vertical" size={2}>
            <Tag color={v === "已确认" || v === "已执行" ? "green" : v === "待确认" ? "orange" : "default"}>{v}</Tag>
            {record.invalidReason && v !== "已确认" && v !== "已执行" && <small style={{ color: "#d48806" }}>{record.invalidReason}</small>}
          </Space>
        },
        {
          title: "操作",
          render: (_: unknown, record: ShuttlePlan) => <Space direction="vertical" size={2}>
            <Space size={4}>
              <Button size="small" disabled={record.status !== "草稿" || !canWritePlan(state.role)} onClick={() => guard(state.submitPlan(record.id))}>提交确认</Button>
              <Button size="small" disabled={record.status !== "待确认" || !canWritePlan(state.role) || record.approvals.some((a) => a.role === state.role)} onClick={() => guard(state.approvePlan(record.id))}>本岗位确认</Button>
            </Space>
            <Tooltip title={record.status !== "已确认" ? "须双确认且依据未变方可执行" : "执行前将再次校验确认依据"}>
              <Button size="small" type="primary" disabled={record.status !== "已确认" || !canWritePlan(state.role)} onClick={() => guard(state.executePlan(record.id))}>执行（复核双确认）</Button>
            </Tooltip>
          </Space>
        }
      ]} /></Card>}
      {panel === "确认中心" && <Space direction="vertical" style={{ width: "100%" }} size={16}>
        <Card title="跨岗位确认中心">
          <Timeline items={state.plans.map((plan) => ({ children: <div className="approval"><b>{plan.stations.map((id) => stationName(state.stations, id)).join(" → ")}</b><Tag color={plan.status === "已确认" || plan.status === "已执行" ? "green" : plan.status === "待确认" ? "orange" : "default"}>{plan.status}</Tag><p>{plan.vehicles} 辆，间隔 {plan.interval} 分钟，{plan.note}</p><Space size={2} wrap>{approvalTag(plan.approvals)}</Space>{plan.invalidReason && plan.status === "待确认" ? <p style={{ color: "#d48806" }}>作废原因：{plan.invalidReason}</p> : <p style={{ color: "#8b95a6" }}>确认依据：车辆数 {plan.basis?.vehicles ?? "—"} 辆，车站 {plan.basis ? Object.values(plan.basis.stations).join("、") : "未锁定"}</p>}</div> }))} />
        </Card>
        <Card title="弱网操作队列（按依赖关系提交）" extra={<Space>
          <Button disabled={state.online || pendingCount === 0} onClick={() => { const r = state.syncQueue(); message.info(`提交完成：成功 ${r.synced} 条，失败 ${r.failed} 条，失败操作已保留`); }}>立即同步</Button>
          <Button disabled={!state.queue.some((e) => e.status === "已同步")} onClick={state.clearSynced}>清除已同步</Button>
        </Space>}>
          <Descriptions size="small" column={3} style={{ marginBottom: 12 }}>
            <Descriptions.Item label="待同步">{pendingCount}</Descriptions.Item>
            <Descriptions.Item label="失败（保留原因与重试次数）">{failedCount}</Descriptions.Item>
            <Descriptions.Item label="已同步">{state.queue.filter((e) => e.status === "已同步").length}</Descriptions.Item>
          </Descriptions>
          <Table rowKey="id" size="small" pagination={false} dataSource={[...state.queue].sort((a, b) => b.time.localeCompare(a.time))} columns={queueColumns} />
        </Card>
      </Space>}
    </main>
    <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿"><Form layout="vertical"><Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}><Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.id, label: item.name }))} />} /></Form.Item><Space><Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} />} /></Form.Item><Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} addonAfter="分钟" />} /></Form.Item></Space><Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item><Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item></Form></Modal>
  </div>;
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
