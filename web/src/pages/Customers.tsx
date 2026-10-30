import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
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

import { api, ApiError, type AdminCustomer, type PlanView, type SubscriptionStatus } from "../api";

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
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<AdminCustomer | null>(null);
  const [form] = Form.useForm<{ plan_id: string; paid_minor: number }>();

  // 特殊补偿通道（与上面的"开通/续订"是两件事，别混）
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<AdminCustomer | null>(null);
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustForm] = Form.useForm<{ days?: number; gb?: number; reason: string }>();

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

  async function addCustomer() {
    const email = window.prompt("新客户邮箱");
    if (!email) return;
    setBusy(true);
    try {
      await api.createCustomer(email.trim());
      message.success("已创建");
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "创建失败");
    } finally {
      setBusy(false);
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
    } finally {
      setAdjustBusy(false);
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
            <Button type="primary" onClick={() => void addCustomer()} loading={busy}>
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
              title: "操作",
              key: "actions",
              width: 160,
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
                </Space>
              ),
            },
          ]}
        />
      </div>

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
    </div>
  );
}
