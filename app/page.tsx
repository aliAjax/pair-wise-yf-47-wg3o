"use client";

import { useEffect, useState } from "react";
import { App as AntApp, Badge, Button, Card, Descriptions, Form, Input, InputNumber, List, Modal, Select, Segmented, Space, Statistic, Table, Tag, Timeline, Tooltip, Typography } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { fetchStations } from "../lib/query";
import { MapPanel } from "../components/MapPanel";
import { missingApprovals, roleCan, useIncidentStore, type Role, type ShuttlePlan, type Station, type StationStatus } from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(1, "至少选择两个接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

const APPROVAL_ROLES: Role[] = ["调度员", "公交接驳负责人"];

function Dashboard() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const state = useIncidentStore();
  const { data: cachedStations } = useQuery({ queryKey: ["stations"], queryFn: fetchStations, enabled: state.online });
  const [modalOpen, setModalOpen] = useState(false);
  const [panel, setPanel] = useState<string>("总览");
  const [syncing, setSyncing] = useState(false);
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });

  useEffect(() => { if (!state.online) queryClient.cancelQueries({ queryKey: ["stations"] }); }, [state.online, queryClient]);

  const canUpdateStation = roleCan(state.role, "station:update");
  const canApprovePlan = roleCan(state.role, "plan:approve");
  const canEditPlan = roleCan(state.role, "plan:create");
  const canExecutePlan = roleCan(state.role, "plan:execute");

  const run = (fn: () => void) => {
    try { fn(); } catch (error) { message.error(error instanceof Error ? error.message : "操作失败"); }
  };

  const changeStationStatus = (record: Station, status: StationStatus) => run(() => {
    state.setStationStatus(record.id, status);
    queryClient.invalidateQueries({ queryKey: ["stations"] });
  });

  const failedCount = state.pendingActions.filter((item) => item.status === "同步失败").length;

  const stationColumns: ColumnsType<Station> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    { title: "状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={value === "封闭" ? "red" : value === "限流" ? "orange" : value === "恢复中" ? "blue" : "green"}>{value}</Tag> },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    { title: "现场说明", dataIndex: "note" },
    { title: "更新时间", dataIndex: "updatedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    {
      title: "处置", render: (_, record) => <Space>
        <Tooltip title={!canUpdateStation ? `「${state.role}」无车站状态处置权限` : undefined}>
          <Button size="small" disabled={!canUpdateStation} onClick={() => changeStationStatus(record, "限流")}>限流</Button>
        </Tooltip>
        <Tooltip title={!canUpdateStation ? `「${state.role}」无车站状态处置权限` : undefined}>
          <Button size="small" disabled={!canUpdateStation} danger={record.status !== "封闭"} onClick={() => changeStationStatus(record, record.status === "封闭" ? "恢复中" : "封闭")}>{record.status === "封闭" ? "恢复中" : "封闭"}</Button>
        </Tooltip>
      </Space>
    }
  ];

  const submitPlan = (values: PlanForm) => {
    const parsed = planSchema.safeParse(values);
    if (!parsed.success) return;
    run(() => { state.addPlan(parsed.data); setModalOpen(false); reset(); });
  };

  const doSync = async () => {
    setSyncing(true);
    try {
      const result = await state.syncActions();
      message.success(`队列同步完成：提交 ${result.submitted} 条${result.failed ? `，失败 ${result.failed} 条（保留原因与重试次数，可逐条重试）` : ""}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  };

  const planColumns: ColumnsType<ShuttlePlan> = [
    { title: "接驳站", dataIndex: "stations", render: (v: string[]) => v.join(" → ") },
    {
      title: "车辆", dataIndex: "vehicles", render: (value, record) => <Space size={4}><InputNumber size="small" min={1} max={80} value={value} disabled={!canEditPlan || record.status === "已执行" || !state.online} addonAfter="辆" onChange={(v) => { if (v && v !== record.vehicles) run(() => state.updatePlanVehicles(record.id, v)); }} /><Typography.Text type="secondary" style={{ fontSize: 12 }}>变化后作废确认</Typography.Text></Space>
    },
    { title: "间隔", dataIndex: "interval", render: (v: number) => `${v} 分钟` },
    { title: "运营方", dataIndex: "operator" },
    {
      title: "双重确认", dataIndex: "approvals", render: (v: Role[], record) => <Space size={4}>{APPROVAL_ROLES.map((role) => {
        const approved = v.includes(role);
        return <Tag key={role} color={approved ? "green" : "default"}>{role}{approved ? " ✓" : " ✗"}</Tag>;
      })}{record.status === "待确认" && v.length > 0 && <Tag color="orange">确认已作废重提</Tag>}</Space>
    },
    { title: "状态", dataIndex: "status", render: (v) => <Tag color={v === "已确认" || v === "已执行" ? "green" : v === "待确认" ? "orange" : "default"}>{v}</Tag> },
    {
      title: "操作", render: (_, record) => {
        const missing = missingApprovals(record);
        const canApprove = record.status === "待确认" && canApprovePlan && !record.approvals.includes(state.role);
        return <Space>
          <Button size="small" disabled={record.status !== "草稿" || !state.online} onClick={() => run(() => state.submitPlan(record.id))}>提交确认</Button>
          <Tooltip title={!canApprovePlan ? `「${state.role}」无确认权限（客服主管不可确认计划）` : record.status !== "待确认" ? "仅待确认计划可确认" : record.approvals.includes(state.role) ? "本岗位已确认" : `还需：${missing.join("、")} 确认`}>
            <Button size="small" disabled={!canApprove || !state.online} onClick={() => run(() => state.approvePlan(record.id))}>确认{record.status === "待确认" && missing.length ? `（缺 ${missing.length}）` : ""}</Button>
          </Tooltip>
          <Tooltip title={record.status !== "已确认" ? "双重确认完成后方可执行" : undefined}>
            <Button size="small" type="primary" disabled={record.status !== "已确认" || !canExecutePlan || !state.online} onClick={() => run(() => state.executePlan(record.id))}>执行</Button>
          </Tooltip>
        </Space>;
      }
    }
  ];

  return <div className="shell">
    <aside className="side">
      <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
      <nav>{["总览", "事件时间线", "接驳计划", "确认中心"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
      <div className="side-status"><small>系统连接</small><b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b><span>最近缓存 32 秒前</span></div>
    </aside>
    <main>
      <header><div><small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><Space direction="vertical" size={4} style={{ alignItems: "flex-end" }}><Space><Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} /><Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} /></Space><Typography.Text type="secondary" style={{ fontSize: 12 }}>客服主管仅可查看：不可改动车站状态，不可确认/执行接驳计划</Typography.Text></Space></header>
      <section className="metrics"><Card><Statistic title="事件状态" value={state.incident.status} /></Card><Card><Statistic title="受影响车站" value={state.stations.filter((item) => item.status !== "正常").length} suffix="座" /></Card><Card><Statistic title="待确认计划" value={state.plans.filter((item) => item.status === "待确认").length} /></Card><Card><Statistic title="待同步 / 失败" value={`${state.pendingActions.length} / ${failedCount}`} /></Card></section>
      {!state.online && <div className="degrade">当前处于弱网降级模式，显示最近缓存数据。关键处置按依赖关系进入本地队列（车站状态 → 计划 → 确认 → 执行）；恢复连接后先合并再逐条提交，单条失败保留原因与重试次数，不影响后续操作。</div>}
      {panel === "总览" && <section className="overview">
        <Card title={t("stations")} className="wide"><Table rowKey="id" dataSource={state.online && cachedStations?.length ? cachedStations : state.stations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 760 }} /></Card>
        <Card title="受影响区段" className="map-card"><MapPanel stations={state.stations} plans={state.plans.filter((plan) => plan.status !== "草稿")} /></Card>
      </section>}
      {panel === "事件时间线" && <Card title="处置时间线" extra={<Space><Select value="响应" options={[{value:"响应"},{value:"接驳"},{value:"恢复"}]} /><Button type="primary" onClick={() => run(() => state.addTimeline({ actor: state.role, action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" }))}>添加处置记录</Button></Space>}><div className="timeline-grid"><Timeline items={state.timeline.map((item) => ({ color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : "red", children: <div><b>{item.action}</b><Tag>{item.actor}</Tag><p>{item.detail}</p><small>{format(new Date(item.time), "MM-DD HH:mm:ss")} · {item.phase}</small></div> }))} /><Card size="small" title="处置检查"><p>车站状态变化后，覆盖该站的接驳计划确认自动作废并退回待确认。</p><p>接驳车辆到场后需调度员和公交负责人双方确认。</p><p>恢复行车前检查区间水位和站台安全。</p></Card></div></Card>}
      {panel === "接驳计划" && <Card title="公交接驳计划" extra={<Button type="primary" disabled={!canEditPlan} onClick={() => setModalOpen(true)}>新建计划</Button>}><Table rowKey="id" pagination={false} dataSource={state.plans} columns={planColumns} /></Card>}
      {panel === "确认中心" && <Card title="跨岗位确认中心" extra={<Button type="primary" loading={syncing} disabled={!state.online || !state.pendingActions.length} onClick={doSync}>合并并同步队列（{state.pendingActions.length}）</Button>}>
        <List
          size="small"
          dataSource={state.plans}
          locale={{ emptyText: "暂无接驳计划" }}
          renderItem={(plan) => <List.Item>
            <List.Item.Meta
              title={<Space><b>{plan.stations.join(" → ")}</b><Tag color={plan.status === "已确认" || plan.status === "已执行" ? "green" : plan.status === "待确认" ? "orange" : "default"}>{plan.status}</Tag>{missingApprovals(plan).length === 0 && plan.status !== "已执行" && <Tag color="green">双重确认齐全</Tag>}</Space>}
              description={<Space direction="vertical" size={2}><span>{plan.vehicles} 辆，间隔 {plan.interval} 分钟，{plan.note}</span><Space size={4}>{APPROVAL_ROLES.map((role) => <Tag key={role} color={plan.approvals.includes(role) ? "green" : "default"}>{role}{plan.approvals.includes(role) ? " ✓" : " ✗"}</Tag>)}</Space></Space>}
            />
          </List.Item>}
        />
        <Card size="small" title={`本地队列（${state.pendingActions.length}）`} style={{ marginTop: 12 }}>
          <List
            size="small"
            dataSource={state.pendingActions}
            locale={{ emptyText: state.online ? "队列已清空，所有操作均已同步" : "弱网期间的操作将按依赖关系在此排队" }}
            renderItem={(action) => <List.Item actions={action.status === "同步失败" ? [
              <Button key="retry" size="small" type="primary" onClick={() => run(() => state.retryAction(action.id))}>重试</Button>,
              <Button key="clear" size="small" danger onClick={() => state.removeFailedAction(action.id)}>清除</Button>
            ] : undefined}>
              <List.Item.Meta
                avatar={<Badge status={action.status === "同步失败" ? "error" : "processing"} />}
                title={<Space><span>{action.action}</span><Tag>{action.status}</Tag>{action.retries > 0 && <Tag color="orange">已重试 {action.retries} 次</Tag>}</Space>}
                description={<><span>{action.detail}</span><br /><small>{format(new Date(action.time), "MM-DD HH:mm:ss")}{action.error && <Typography.Text type="danger"> · 失败原因：{action.error}</Typography.Text>}</small></>}
              />
            </List.Item>}
          />
        </Card>
      </Card>}
    </main>
    <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿"><Form layout="vertical"><Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}><Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.name, label: item.name }))} />} /></Form.Item><Space><Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} />} /></Form.Item><Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} addonAfter="分钟" />} /></Form.Item></Space><Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item><Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item></Form></Modal>
  </div>;
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
