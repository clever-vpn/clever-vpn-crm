import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Select, Space, Table, Tag, Typography, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";

import { api, ApiError, type AdminOrder } from "../api";

const STATUS: Record<string, { color: string; text: string }> = {
  pending: { color: "default", text: "待支付" },
  paid: { color: "blue", text: "已付款" },
  provisioning: { color: "orange", text: "发放中" },
  active: { color: "green", text: "已完成" },
  refunded: { color: "red", text: "已退款" },
  expired: { color: "default", text: "已超时" },
  closed: { color: "default", text: "已关闭" },
};

const SOURCE: Record<string, string> = { purchase: "自助", gift: "赠送", manual: "后台" };
const KIND: Record<string, string> = { period: "周期", traffic: "流量包", addon: "加购包" };
const METHOD: Record<string, string> = {
  alipay: "支付宝",
  wechat: "微信",
  stripe: "银行卡",
  paypal: "PayPal",
  transfer: "转账",
  manual: "后台",
  gift: "赠送",
};

const yuan = (m: number) => `¥${(m / 100).toFixed(2)}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export default function Orders() {
  const [rows, setRows] = useState<AdminOrder[]>([]);
  const [status, setStatus] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { orders } = await api.orders({ status, limit: 200 });
      setRows(orders);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && <Alert type="error" showIcon message={error} />}

      <div className="card">
        <div className="row between" style={{ marginBottom: 12 }}>
          <Space direction="vertical" size={0}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              订单
            </Typography.Title>
            <Typography.Text type="secondary">
              订单是一次收款的凭证（金额、渠道、套餐快照都冻结在这里）；权益在订阅上。
            </Typography.Text>
          </Space>
          <Space>
            <Select
              allowClear
              placeholder="全部状态"
              style={{ width: 140 }}
              value={status}
              onChange={(v) => setStatus(v)}
              options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.text }))}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
              刷新
            </Button>
          </Space>
        </div>

        <Table<AdminOrder>
          rowKey="id"
          size="small"
          dataSource={rows}
          loading={loading}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          columns={[
            {
              title: "订单号",
              dataIndex: "code",
              render: (code: string) => (
                <Typography.Text
                  className="mono"
                  copyable={{ text: code }}
                  style={{ fontSize: 12 }}
                >
                  {code}
                </Typography.Text>
              ),
            },
            {
              title: "客户",
              dataIndex: "email",
              render: (email: string | null, o) => email ?? `#${o.customer_id}`,
            },
            {
              title: "套餐",
              dataIndex: "plan_id",
              render: (planId: string, o) => (
                <Space direction="vertical" size={0}>
                  <span>{planId}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {KIND[o.kind] ?? o.kind} · {SOURCE[o.source] ?? o.source}
                  </Typography.Text>
                </Space>
              ),
            },
            { title: "金额", dataIndex: "amount_minor", render: (m: number) => yuan(m) },
            {
              title: "状态",
              dataIndex: "status",
              render: (s: string) => <Tag color={STATUS[s]?.color}>{STATUS[s]?.text ?? s}</Tag>,
            },
            {
              title: "方式",
              dataIndex: "payment_method",
              render: (m: string) => METHOD[m] ?? m,
            },
            { title: "创建", dataIndex: "created_at", render: (v: string) => when(v) },
            { title: "支付", dataIndex: "paid_at", render: (v: string | null) => when(v) },
            {
              title: "",
              key: "actions",
              width: 90,
              render: (_, o) =>
                o.status === "pending" && o.pay_url ? (
                  <Button
                    size="small"
                    onClick={() => {
                      navigator.clipboard?.writeText(o.pay_url ?? "");
                      message.success("支付链接已复制");
                    }}
                  >
                    复制链接
                  </Button>
                ) : null,
            },
          ]}
        />
      </div>
    </div>
  );
}
