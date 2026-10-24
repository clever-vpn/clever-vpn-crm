import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";

import { api, ApiError, type GatewayDraft, type GatewayView, type GatewaysResponse } from "../api";

const DRIVER_LABEL: Record<string, string> = {
  epay_v1: "易支付（内置映射）",
  generic_json_v1: "自定义映射",
  mock: "测试网关（演示）",
  stripe: "Stripe",
  paypal: "PayPal",
  manual: "对公转账",
};

const METHOD_LABEL: Record<string, string> = {
  alipay: "支付宝",
  wechat: "微信支付",
  stripe: "银行卡",
  paypal: "PayPal",
  transfer: "银行转账",
};

const STATUS: Record<string, { color: string; text: string }> = {
  draft: { color: "default", text: "草稿" },
  live: { color: "green", text: "已启用" },
  disabled: { color: "red", text: "已停用" },
};

interface FormValues {
  driver: string;
  name: string;
  endpoint?: string;
  merchant_id?: string;
  secret?: string;
  methods: string[];
  priority: number;
  allowed_emails?: string;
  mapping?: string;
}

export default function Gateways() {
  const [data, setData] = useState<GatewaysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<GatewayView | null>(null);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const driver: string = Form.useWatch("driver", form) ?? "epay_v1";
  const driverMethods = data?.drivers.find((d) => d.driver === driver)?.methods ?? [];

  const load = useCallback(async () => {
    try {
      setData(await api.gateways());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openNew() {
    setEditing(null);
    form.setFieldsValue({
      driver: "epay_v1",
      name: "",
      endpoint: "",
      merchant_id: "",
      secret: "",
      methods: ["alipay"],
      priority: 100,
      allowed_emails: "",
      mapping: "",
    });
    setOpen(true);
  }

  function openEdit(gw: GatewayView) {
    setEditing(gw);
    form.setFieldsValue({
      driver: gw.driver,
      name: gw.name,
      endpoint: gw.endpoint ?? "",
      merchant_id: gw.merchant_id ?? "",
      secret: "",
      methods: gw.methods,
      priority: gw.priority,
      allowed_emails: gw.allowed_emails.join(", "),
      mapping: gw.mapping ? JSON.stringify(gw.mapping, null, 2) : "",
    });
    setOpen(true);
  }

  async function save() {
    const v = await form.validateFields();
    setBusy(true);
    try {
      const emails = (v.allowed_emails ?? "")
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      let mapping: unknown = undefined;
      if (v.mapping && v.mapping.trim()) {
        try {
          mapping = JSON.parse(v.mapping);
        } catch {
          message.error("映射不是合法 JSON");
          return;
        }
      }

      const payload: GatewayDraft = {
        driver: v.driver,
        name: v.name,
        endpoint: v.endpoint || null,
        merchant_id: v.merchant_id || null,
        methods: v.methods,
        priority: v.priority,
        allowed_emails: emails,
      };
      if (v.secret && v.secret.trim()) payload.secret = v.secret.trim();
      if (mapping !== undefined) payload.mapping = mapping;

      if (editing) await api.updateGateway(editing.id, payload);
      else await api.createGateway(payload);

      message.success(editing ? "已保存" : "已创建草稿（发布后租户才看得到）");
      setOpen(false);
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      message.success(ok);
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && <Alert type="error" showIcon message={error} />}

      {data && !data.mock_enabled && (
        <Alert
          type="info"
          showIcon
          message="测试网关未启用"
          description="需要环境变量 ALLOW_MOCK_PAYMENTS=true 才能创建/发布测试网关。业务正式上线后应保持关闭。"
        />
      )}
      {data && !data.secret_key_ready && (
        <Alert
          type="warning"
          showIcon
          message="未配置 PAYMENT_SECRET_KEY"
          description="没有主密钥就无法保存网关密钥，真实网关无法发布。用 wrangler secret put PAYMENT_SECRET_KEY 配置。"
        />
      )}

      <div className="card">
        <div className="row between" style={{ marginBottom: 12 }}>
          <Space direction="vertical" size={0}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              支付网关
            </Typography.Title>
            <Typography.Text type="secondary">
              用户只看到「支付方式」；服务商、密钥、映射都在这一层，用户看不到。
            </Typography.Text>
          </Space>
          <Button type="primary" onClick={openNew} loading={busy}>
            新增网关
          </Button>
        </div>

        <Table<GatewayView>
          rowKey="id"
          size="small"
          dataSource={data?.gateways ?? []}
          pagination={false}
          columns={[
            {
              title: "名称",
              dataIndex: "name",
              render: (name: string, gw) => (
                <Space direction="vertical" size={0}>
                  <span>{name}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {DRIVER_LABEL[gw.driver] ?? gw.driver}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "支付方式",
              dataIndex: "methods",
              render: (m: string[]) => (
                <Space size={4} wrap>
                  {m.map((x) => (
                    <Tag key={x}>{METHOD_LABEL[x] ?? x}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (s: string) => <Tag color={STATUS[s]?.color}>{STATUS[s]?.text ?? s}</Tag>,
            },
            { title: "优先级", dataIndex: "priority", width: 80 },
            {
              title: "密钥",
              dataIndex: "has_secret",
              width: 80,
              render: (has: boolean) => (has ? <Tag color="blue">已设置</Tag> : <Tag>未设置</Tag>),
            },
            {
              title: "最近成功",
              dataIndex: "last_ok_at",
              render: (v: string | null) => (v ? new Date(v).toLocaleString() : "—"),
            },
            {
              title: "操作",
              key: "actions",
              width: 220,
              render: (_, gw) => (
                <Space size={4}>
                  <Button size="small" onClick={() => openEdit(gw)}>
                    编辑
                  </Button>
                  {gw.status !== "live" && (
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => void act(() => api.publishGateway(gw.id), "已启用")}
                    >
                      发布
                    </Button>
                  )}
                  {gw.status === "live" && (
                    <Popconfirm
                      title="停用后 App 里立刻看不到这个支付方式"
                      onConfirm={() => void act(() => api.disableGateway(gw.id), "已停用")}
                    >
                      <Button size="small" danger>
                        停用
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
          expandable={{
            expandedRowRender: (gw) => (
              <Space direction="vertical" size={4} style={{ fontSize: 12 }}>
                <span>网关地址：{gw.endpoint || "—"}</span>
                <span>商户号：{gw.merchant_id || "—"}</span>
                <span>
                  客户白名单：
                  {gw.allowed_emails.length ? gw.allowed_emails.join(", ") : "不限"}
                  {gw.driver === "mock" && !gw.allowed_emails.length ? "（测试网关必须非空才能发布）" : ""}
                </span>
                {gw.last_error && <span style={{ color: "#cf1322" }}>最近错误：{gw.last_error}</span>}
              </Space>
            ),
          }}
        />
      </div>

      <Modal
        title={editing ? `编辑：${editing.name}` : "新增支付网关"}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void save()}
        confirmLoading={busy}
        okText="保存"
        width={640}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="驱动" name="driver" rules={[{ required: true }]}>
            <Select
              options={(data?.drivers ?? []).map((d) => ({
                value: d.driver,
                label: DRIVER_LABEL[d.driver] ?? d.driver,
              }))}
              onChange={(v: string) => {
                const allowed = data?.drivers.find((d) => d.driver === v)?.methods ?? [];
                form.setFieldValue("methods", allowed.slice(0, 1));
              }}
            />
          </Form.Item>

          <Form.Item label="名称（后台显示，用户看不到）" name="name" rules={[{ required: true }]}>
            <Input placeholder="例：支付宝-主号" maxLength={60} />
          </Form.Item>

          {(driver === "epay_v1" || driver === "generic_json_v1") && (
            <>
              <Form.Item label="网关地址" name="endpoint" rules={[{ required: true }]}>
                <Input placeholder="https://pay.example.com" />
              </Form.Item>
              <Form.Item label="商户号 / pid" name="merchant_id" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </>
          )}

          {driver !== "mock" && driver !== "manual" && (
            <Form.Item
              label={editing?.has_secret ? "密钥（留空 = 不修改）" : "密钥"}
              name="secret"
              extra="AES-GCM 加密后入库，永不回显。"
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          )}

          <Form.Item label="支持的支付方式" name="methods" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              options={driverMethods.map((m) => ({ value: m, label: METHOD_LABEL[m] ?? m }))}
            />
          </Form.Item>

          <Form.Item label="优先级（数字小的先试）" name="priority">
            <InputNumber min={0} style={{ width: 160 }} />
          </Form.Item>

          <Form.Item
            label="客户白名单（逗号分隔，留空 = 不限）"
            name="allowed_emails"
            extra={driver === "mock" ? "测试网关必须填写白名单才能发布。" : "可用于灰度：先只让这些客户看到。"}
          >
            <Input placeholder="a@example.com, b@example.com" />
          </Form.Item>

          {driver === "generic_json_v1" && (
            <Form.Item label="协议映射（JSON）" name="mapping" extra="必填：完整映射，保存时会校验。">
              <Input.TextArea rows={10} className="mono" placeholder="{ ... }" />
            </Form.Item>
          )}
          {driver === "epay_v1" && (
            <Form.Item
              label="高级：覆盖内置映射（JSON，可留空）"
              name="mapping"
              extra="只写与易支付默认值不同的部分，会与内置映射深合并。例如 {&quot;channel_codes&quot;:{&quot;wechat&quot;:&quot;wechat&quot;}}"
            >
              <Input.TextArea rows={6} className="mono" placeholder="{ }" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
