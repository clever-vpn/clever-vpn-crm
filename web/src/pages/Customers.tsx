import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";

import { api, ApiError, type AdminCustomer, type PlanView, type PlatformLine, type SubscriptionStatus } from "../api";

const STATUS: Record<string, { color: string; text: string }> = {
  active: { color: "green", text: "生效中" },
  // inactive 的具体原因放 reason：expired / exhausted / frozen
  "inactive:expired": { color: "default", text: "已到期" },
  "inactive:exhausted": { color: "orange", text: "流量用完" },
  "inactive:frozen": { color: "volcano", text: "已暂停" },
  inactive: { color: "red", text: "不可用" },
};

/** 不限量：period 看月度额度是否为空，traffic 包看整包容量是否为空 */
function unlimitedOf(s: AdminCustomer["subscription"] | null | undefined) {
  if (!s) return false;
  return s.kind === "period" ? s.period_quota_gb === null : s.traffic_total_gb === null;
}

/** `inactive` 时要看 reason 才知道是哪一种不可用 */
function statusTag(s: AdminCustomer["subscription"]) {
  if (!s) return { color: "default", text: "无订阅" };
  const key = s.status === "inactive" && s.status_reason ? `inactive:${s.status_reason}` : s.status;
  return STATUS[key] ?? { color: "default", text: s.status };
}

const KIND_TEXT: Record<string, string> = {
  period: "周期",
  traffic: "流量包",
  addon: "加购包",
};

const yuan = (m: number | null | undefined) =>
  m === null || m === undefined ? "—" : `¥${(m / 100).toFixed(2)}`;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export default function Customers() {
  const [rows, setRows] = useState<AdminCustomer[]>([]);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addForm] = Form.useForm<{ email: string }>();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<AdminCustomer | null>(null);
  const [form] = Form.useForm<{ plan_id: string; paid_minor: number }>();

  // 特殊补偿通道（与上面的"开通/续订"是两件事，别混）
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<AdminCustomer | null>(null);
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustForm] = Form.useForm<{ days?: number; gb?: number; reason: string }>();

  // 临时冻结 / 解冻（停服务不减权益，与"调整权益"是两件事）
  const [holdOpen, setHoldOpen] = useState(false);
  const [holdTarget, setHoldTarget] = useState<AdminCustomer | null>(null);
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdForm] = Form.useForm<{ reason: string }>();

  // 线路权益（与"调整权益"是两件事：它只改可用线路白名单，不涉及天数/流量）
  const [linesOpen, setLinesOpen] = useState(false);
  const [linesTarget, setLinesTarget] = useState<AdminCustomer | null>(null);
  const [linesBusy, setLinesBusy] = useState(false);
  const [linesCatalog, setLinesCatalog] = useState<PlatformLine[] | null>(null);
  const [linesCatalogError, setLinesCatalogError] = useState<string | null>(null);
  const [linesForm] = Form.useForm<{ line_ids?: number[]; reason: string }>();

  const load = useCallback(async () => {
    try {
      const [{ customers }, { plans: list }] = await Promise.all([api.customers(), api.plans()]);
      setRows(customers);
      setPlans(list);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openAddCustomer(): void {
    addForm.resetFields();
    setAddOpen(true);
  }

  async function submitAddCustomer(): Promise<void> {
    const values = await addForm.validateFields();
    setAddBusy(true);
    try {
      await api.createCustomer(values.email.trim());
      message.success("已创建");
      setAddOpen(false);
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "创建失败");
    } finally {
      setAddBusy(false);
    }
  }

  function openGrant(customer: AdminCustomer, planId?: string) {
    setTarget(customer);
    const first = planId ?? plans.find((p) => p.kind !== "addon")?.plan_id ?? "";
    form.setFieldsValue({
      plan_id: first,
      paid_minor: plans.find((p) => p.plan_id === first)?.price_minor ?? 0,
    });
    setOpen(true);
  }

  async function submitGrant() {
    if (!target) return;
    const v = await form.validateFields();
    setBusy(true);
    try {
      await api.grantSubscription({
        customer_id: target.id,
        plan_id: v.plan_id,
        paid_minor: v.paid_minor,
      });
      message.success("已写入订阅（历史在变更流水里）");
      setOpen(false);
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "开通失败");
    } finally {
      setBusy(false);
    }
  }

  function openAdjust(customer: AdminCustomer) {
    setAdjustTarget(customer);
    adjustForm.resetFields();
    setAdjustOpen(true);
  }

  async function submitAdjust() {
    if (!adjustTarget) return;
    const v = await adjustForm.validateFields();
    const days = Number(v.days ?? 0);
    const gb = Number(v.gb ?? 0);
    if (days <= 0 && gb <= 0) {
      message.warning("天数和流量至少填一个");
      return;
    }
    setAdjustBusy(true);
    try {
      const r = await api.adjustSubscription({
        customer_id: adjustTarget.id,
        days,
        gb,
        reason: v.reason.trim(),
      });
      const parts: string[] = [];
      if (r.applied.days) parts.push(`+${r.applied.days} 天`);
      if (r.applied.gb) parts.push(`+${r.applied.gb} GB`);
      message.success(`已调整：${parts.join(" / ")}${r.platform_synced ? "" : "（未同步平台）"}`);
      setAdjustOpen(false);
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "调整失败");
    }
  }

  async function submitHold() {
    if (!holdTarget?.subscription) return;
    const v = await holdForm.validateFields();
    const frozen = holdTarget.subscription.status_reason !== "frozen";
    setHoldBusy(true);
    try {
      const r = await api.setCustomerHold(holdTarget.id, { frozen, reason: v.reason });
      message.success(
        `${frozen ? "已冻结" : "已解冻"}${r.platform_synced ? "" : "（未同步平台）"}`,
      );
      setHoldOpen(false);
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "操作失败");
    } finally {
      setAdjustBusy(false);
    }
  }

  async function openLines(customer: AdminCustomer) {
    setLinesTarget(customer);
    linesForm.setFieldsValue({ line_ids: customer.subscription?.line_ids ?? [], reason: "" });
    setLinesOpen(true);
    if (linesCatalog) return;
    try {
      const r = await api.platformLines();
      setLinesCatalog(r.lines);
      setLinesCatalogError(null);
    } catch (e) {
      setLinesCatalogError(e instanceof ApiError ? e.message : "读不到线路目录");
    }
  }

  async function submitLines() {
    if (!linesTarget) return;
    const v = await linesForm.validateFields();
    setLinesBusy(true);
    try {
      const r = await api.setCustomerLines(linesTarget.id, v.line_ids ?? [], v.reason.trim());
      message.success(
        `已改为${r.applied.length ? ` ${r.applied.length} 条线路` : "全部线路"}${r.platform_synced ? "" : "（未同步平台）"}`,
      );
      setLinesOpen(false);
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "改线路失败");
    } finally {
      setLinesBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && <Alert type="error" showIcon message={error} />}

      <div className="card">
        <div className="row between" style={{ marginBottom: 12 }}>
          <Space direction="vertical" size={0}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              客户
            </Typography.Title>
            <Typography.Text type="secondary">
              一个客户最多一行订阅；“状态”是算出来的（到期 / 冻结 / 用完都会说清原因）。
            </Typography.Text>
          </Space>
          <Space>
            <Button onClick={() => void load()} loading={busy}>
              刷新
            </Button>
            <Button type="primary" onClick={openAddCustomer} loading={busy}>
              新建客户
            </Button>
          </Space>
        </div>

        <Table<AdminCustomer>
          rowKey="id"
          size="small"
          dataSource={rows}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          columns={[
            {
              title: "客户",
              dataIndex: "email",
              render: (email: string, c) => (
                <Space direction="vertical" size={0}>
                  <span>{email}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    #{c.id} · 注册于 {day(c.created_at)}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "套餐",
              dataIndex: "subscription",
              render: (s: AdminCustomer["subscription"]) =>
                s ? (
                  <Space direction="vertical" size={0}>
                    <span>{s.plan_id}</span>
                    <Tag style={{ marginTop: 2 }}>{KIND_TEXT[s.kind] ?? s.kind}</Tag>
                  </Space>
                ) : (
                  <Typography.Text type="secondary">未购买</Typography.Text>
                ),
            },
            {
              title: "状态",
              dataIndex: "subscription",
              render: (s: AdminCustomer["subscription"]) =>
                s ? (
                  <Space direction="vertical" size={0}>
                    <Tag color={statusTag(s).color}>{statusTag(s).text}</Tag>
                    {s.status !== "active" && s.status_text && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {s.status_text}
                      </Typography.Text>
                    )}
                  </Space>
                ) : (
                  "—"
                ),
            },
            {
              title: "到期",
              dataIndex: "subscription",
              render: (s: AdminCustomer["subscription"]) => (s?.expires_at ? day(s.expires_at) : s ? "永久" : "—"),
            },
            {
              title: "额度 / 剩余",
              dataIndex: "subscription",
              render: (s: AdminCustomer["subscription"]) => {
                if (!s) return "—";
                // 不限量只看 period_quota_gb（period 才有）；traffic_remaining_gb 为 null = 还没同步 cf-api
                const unlimited = s.kind === "period" && s.period_quota_gb === null;
                const quota =
                  s.period_quota_gb !== null
                    ? `${s.period_quota_gb} GB/月`
                    : s.traffic_total_gb !== null
                      ? `${s.traffic_total_gb} GB`
                      : "不限量";
                const remaining = unlimited
                  ? null
                  : s.traffic_remaining_gb === null
                    ? "余额待同步"
                    : `剩 ${s.traffic_remaining_gb} GB`;
                return (
                  <Space direction="vertical" size={0}>
                    <span>
                      {quota}
                      {remaining ? ` · ${remaining}` : ""}
                    </span>
                    {!!s.period_extra_gb && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        额外流量池 {s.period_extra_gb} GB
                      </Typography.Text>
                    )}
                  </Space>
                );
              },
            },
            {
              title: "设备",
              dataIndex: "subscription",
              render: (s: AdminCustomer["subscription"]) => s?.licence_limit ?? "—",
            },
            {
              title: "线路",
              dataIndex: "subscription",
              render: (s: AdminCustomer["subscription"]) =>
                s ? (s.line_ids.length ? `${s.line_ids.length} 条` : "全部") : "—",
            },
            {
              title: "操作",
              key: "actions",
              width: 200,
              render: (_, c) => (
                <Space size={4}>
                  <Button size="small" onClick={() => openGrant(c, c.subscription?.plan_id)}>
                    {c.subscription ? "续订 / 升级" : "开通"}
                  </Button>
                  {c.subscription && (
                    <Button size="small" onClick={() => openAdjust(c)}>
                      调整权益
                    </Button>
                  )}
                  {c.subscription && (
                    <Button size="small" onClick={() => void openLines(c)}>
                      线路
                    </Button>
                  )}
                  {c.subscription && (
                    <Button
                      size="small"
                      danger={c.subscription.status_reason !== "frozen"}
                      onClick={() => {
                        setHoldTarget(c);
                        holdForm.setFieldsValue({ reason: "" });
                        setHoldOpen(true);
                      }}
                    >
                      {c.subscription.status_reason === "frozen" ? "解冻" : "冻结"}
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </div>

      <Modal
        open={addOpen}
        title="新建客户"
        okText="创建"
        cancelText="取消"
        confirmLoading={addBusy}
        onOk={() => void submitAddCustomer()}
        onCancel={() => setAddOpen(false)}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          只创建客户账号，不会自动开通订阅；开通/续订请用列表里的操作。
        </Typography.Paragraph>
        <Form form={addForm} layout="vertical">
          <Form.Item
            label="邮箱"
            name="email"
            rules={[
              { required: true, message: "请填客户邮箱" },
              { type: "email", message: "邮箱格式不对" },
            ]}
          >
            <Input placeholder="customer@example.com" autoFocus />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={target ? `手工开通：${target.email}` : "手工开通"}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void submitGrant()}
        confirmLoading={busy}
        okText="写入订阅"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          这是**运营补单**通道：不会走支付网关，直接按套餐快照写入订阅（同套餐=延续，别的套餐=覆盖）。
          线上正常流程永远是「订单 → 支付 → 发放」。
        </Typography.Paragraph>
        <Form form={form} layout="vertical">
          <Form.Item label="套餐" name="plan_id" rules={[{ required: true }]}>
            <Select
              options={plans.map((p) => ({
                value: p.plan_id,
                label: `${p.name}（${KIND_TEXT[p.kind] ?? p.kind} · ${yuan(p.price_minor)}）`,
              }))}
              onChange={(id: string) => {
                const plan = plans.find((p) => p.plan_id === id);
                form.setFieldValue("paid_minor", plan?.price_minor ?? 0);
              }}
            />
          </Form.Item>
          <Form.Item label="实付（最小货币单位，用于计算残值）" name="paid_minor">
            <InputNumber min={0} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item label="备注（可选）">
            <Input value="运营补单" disabled />
          </Form.Item>
        </Form>
      </Modal>

      {/* **特殊补偿通道**：不走营销活动、不产生 0 元订单、不进营销统计 */}
      <Modal
        title={adjustTarget ? `调整权益：${adjustTarget.email}` : "调整权益"}
        open={adjustOpen}
        onCancel={() => setAdjustOpen(false)}
        onOk={() => void submitAdjust()}
        confirmLoading={adjustBusy}
        okText="写入"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          给这一个人补权益：天数是<strong>在原到期日上加</strong>，流量是<strong>在平台真实剩余上加</strong>。
          这不是礼包 —— 不绑定活动、不进营销统计，但会留在台账与审计里（谁、何时、为什么）。
        </Typography.Paragraph>
        <Form form={adjustForm} layout="vertical">
          <Form.Item
            label="加流量（GB）"
            name="gb"
            extra={
              unlimitedOf(adjustTarget?.subscription)
                ? "该订阅不限量，填了也不会生效"
                : "留空或不填 = 不加"
            }
          >
            <InputNumber min={0} max={10000} style={{ width: 200 }} addonAfter="GB" />
          </Form.Item>
          <Form.Item label="加天数" name="days" extra="留空或不填 = 不加">
            <InputNumber min={0} max={3650} style={{ width: 200 }} addonAfter="天" />
          </Form.Item>
          <Form.Item
            label="原因（必填）"
            name="reason"
            rules={[{ required: true, message: "必须写清楚为什么补" }]}
          >
            <Input placeholder="例：11-03 线路故障补偿 / 投诉安抚" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 临时冻结：停服务、不减权益；两处一起动（平台 frozen + CRM hold） */}
      <Modal
        open={holdOpen}
        title={
          holdTarget ? `${holdTarget.subscription?.status_reason === "frozen" ? "解冻" : "冻结"}：${holdTarget.email}` : ""
        }
        onCancel={() => setHoldOpen(false)}
        onOk={() => void submitHold()}
        confirmLoading={holdBusy}
        okText={holdTarget?.subscription?.status_reason === "frozen" ? "解冻" : "冻结"}
        okButtonProps={{ danger: holdTarget?.subscription?.status_reason !== "frozen" }}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          {holdTarget?.subscription?.status_reason === "frozen"
            ? "解冻后 VPN 立即恢复，会话与激活码都不变。"
            : "冻结只停服务：VPN 立刻连不上，但用户仍能登录、看订阅、找客服。除权（退款撤销）是另一件事，不走这里。"}
        </Typography.Paragraph>
        <Form form={holdForm} layout="vertical">
          <Form.Item
            label="原因（必填）"
            name="reason"
            rules={[{ required: true, message: "必须写清楚为什么冻结 / 解冻" }]}
          >
            <Input placeholder="例：欠费暂停 / 投诉核实中 / 已结清" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 线路权益：直接改这个客户能用的线路（写订阅快照 + 投影到 cf-api） */}
      <Modal
        open={linesOpen}
        title={linesTarget ? `可用线路：${linesTarget.email}` : "可用线路"}
        onCancel={() => setLinesOpen(false)}
        onOk={() => void submitLines()}
        confirmLoading={linesBusy}
        okText="写入"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          一条都不勾 = <strong>全部线路</strong>（含以后新增的）。改完写进订阅快照并投影到 cf-api；
          对<strong>下次取许可</strong>生效，已建立的隧道不会立刻断开。只影响这一个客户 ——
          想改所有新买家请去改套餐。
        </Typography.Paragraph>
        {linesCatalogError && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`读不到 cf-api 线路目录：${linesCatalogError}`}
            description="仍可移除已有选择或点「取消」；写入前请确认 cf-api 已配置。"
          />
        )}
        <Form form={linesForm} layout="vertical">
          <Form.Item label="可用线路" name="line_ids">
            <Checkbox.Group
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
              options={(() => {
                const catalog = linesCatalog ?? [];
                const selected: number[] = linesForm.getFieldValue("line_ids") ?? [];
                const stale = selected.filter((id: number) => !catalog.some((line) => line.id === id));
                return [
                  ...catalog.map((line) => ({
                    value: line.id,
                    label: `${line.label ?? `线路 #${line.id}`}${line.traffic_factor && line.traffic_factor !== 1 ? ` ×${line.traffic_factor}` : ""}${Number(line.is_default) === 1 ? "（缺省）" : ""}`,
                  })),
                  ...stale.map((id: number) => ({ value: id, label: `线路 #${id}（已下线）` })),
                ];
              })()}
            />
          </Form.Item>
          <Form.Item
            label="原因（必填）"
            name="reason"
            rules={[{ required: true, message: "必须写清楚为什么改线路" }]}
          >
            <Input placeholder="例：线路故障临时切到备用线" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
