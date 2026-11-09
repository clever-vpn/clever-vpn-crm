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
  /** 正在退款的订单（null = 弹窗关着） */
  const [refunding, setRefunding] = useState<AdminOrder | null>(null);
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundForm] = Form.useForm<{
    amount: number;
    reason: string;
    gateway_ref?: string;
  }>();

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
            {
              title: "金额",
              dataIndex: "amount_minor",
              render: (m: number, o) => (
                <Space direction="vertical" size={0}>
                  <span>{yuan(m)}</span>
                  {o.refunded_minor > 0 ? (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      已退 {yuan(o.refunded_minor)}
                    </Typography.Text>
                  ) : null}
                </Space>
              ),
            },
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
              width: 150,
              render: (_, o) => {
                if (o.status === "pending" && o.pay_url) {
                  return (
                    <Button
                      size="small"
                      onClick={() => {
                        navigator.clipboard?.writeText(o.pay_url ?? "");
                        message.success("支付链接已复制");
                      }}
                    >
                      复制链接
                    </Button>
                  );
                }
                // 只有"已到账 + 没退满 + 不是商店单"才给退款入口
                if (o.status !== "active" || o.refunded_minor >= o.amount_minor) {
                  return null;
                }
                return (
                  <Button
                    size="small"
                    danger
                    onClick={() => {
                      refundForm.resetFields();
                      refundForm.setFieldsValue({
                        amount: (o.amount_minor - o.refunded_minor) / 100,
                      });
                      setRefunding(o);
                    }}
                  >
                    退款
                  </Button>
                );
              },
            },
          ]}
        />
      </div>

      <Modal
        open={refunding !== null}
        title={`退款 · ${refunding?.code ?? ""}`}
        okText="确认已退"
        cancelText="取消"
        confirmLoading={refundBusy}
        onCancel={() => setRefunding(null)}
        onOk={async () => {
          if (!refunding) return;
          let v: { amount: number; reason: string; gateway_ref?: string };
          try {
            v = await refundForm.validateFields();
          } catch {
            return;
          }
          setRefundBusy(true);
          try {
            const r = await api.refundOrder(refunding.code, {
              amount_minor: Math.round(v.amount * 100),
              reason: v.reason,
              ...(v.gateway_ref ? { gateway_ref: v.gateway_ref } : {}),
            });
            const left =
              r.remaining === null
                ? "权益已终止"
                : "days" in r.remaining
                  ? `还剩 ${r.remaining.days} 天`
                  : `还剩 ${r.remaining.gb} GB`;
            message.success(
              `已记录退款 ${yuan(r.refundedMinor)}；${left}` +
                (r.platformSynced ? "" : "（平台未同步，请稍后重试或人工停服）"),
            );
            setRefunding(null);
            await load();
          } catch (e) {
            message.error(e instanceof ApiError ? e.message : "退款失败");
          } finally {
            setRefundBusy(false);
          }
        }}
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="钱要在支付网关里退"
          description="这里只记账并按残值调整权益。留空金额字段以外的一切都由 CRM 算：退多少就扣多少剩余价值，扣到 0 等于终止这份权益。"
        />
        <Form form={refundForm} layout="vertical">
          <Form.Item
            label="本次退还金额（元）"
            name="amount"
            rules={[{ required: true, message: "填金额" }]}
            extra="不能超过这一单未退金额，也不能超过当前剩余价值"
          >
            <InputNumber min={0.01} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label="原因"
            name="reason"
            rules={[{ required: true, message: "必须写原因（会记进审计）" }]}
          >
            <Input.TextArea rows={2} placeholder="例如：客户投诉，按未使用天数退还" />
          </Form.Item>
          <Form.Item label="网关退款流水号（可选）" name="gateway_ref" extra="对账用">
            <Input placeholder="网关后台的退款单号" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
