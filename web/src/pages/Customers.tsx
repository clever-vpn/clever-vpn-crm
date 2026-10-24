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

const STATUS: Record<SubscriptionStatus, { color: string; text: string }> = {
  active: { color: "green", text: "生效中" },
  expired: { color: "default", text: "已到期" },
  exhausted: { color: "orange", text: "流量用完" },
  frozen: { color: "volcano", text: "已冻结" },
  revoked: { color: "red", text: "已作废" },
};

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
                    <Tag color={STATUS[s.status]?.color}>{STATUS[s.status]?.text ?? s.status}</Tag>
                    {s.status_reason && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {s.status_reason}
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
                // 不限量只看 quota_gb（period 才有）；remaining_gb 为 null 只是"还没同步 cf-api"
                const unlimited = s.kind === "period" && s.quota_gb === null;
                const quota =
                  s.quota_gb !== null
                    ? `${s.quota_gb} GB/月`
                    : s.traffic_total_gb !== null
                      ? `${s.traffic_total_gb} GB`
                      : "不限量";
                const remaining = unlimited
                  ? null
                  : s.remaining_gb === null
                    ? "余额待同步"
                    : `剩 ${s.remaining_gb} GB`;
                return (
                  <Space direction="vertical" size={0}>
                    <span>
                      {quota}
                      {remaining ? ` · ${remaining}` : ""}
                    </span>
                    {!!s.balance_gb && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        加购余额 {s.balance_gb} GB
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
                <Button size="small" onClick={() => openGrant(c, c.subscription?.plan_id)}>
                  {c.subscription ? "续订 / 升级" : "开通"}
                </Button>
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
    </div>
  );
}
