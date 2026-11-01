import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";

import { api, ApiError, type StoreChannelView, type StoreChannelsResponse } from "../api";

/**
 * 商店渠道（Apple / Google）—— **不是支付网关**
 *
 * 钱进 Apple / Google 的账：CRM 不能发起支付、不能退款，只能"查单"。
 * 所以这里没有「支付方式 / 优先级 / 白名单」，只有"每平台一行 + 凭据 + 开关"。
 */
const PLATFORM_LABEL: Record<string, string> = {
  apple: "App Store（内购）",
  google: "Google Play（内购）",
};

const STATUS: Record<string, { color: string; text: string }> = {
  unset: { color: "default", text: "未配置" },
  draft: { color: "gold", text: "草稿" },
  live: { color: "green", text: "已启用" },
  disabled: { color: "red", text: "已停用" },
};

interface FormValues {
  identifier: string;
  environment: string;
  endpoint?: string;
  status: string;
  secret?: string;
}

export default function Stores() {
  const [data, setData] = useState<StoreChannelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StoreChannelView | null>(null);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const load = useCallback(async () => {
    try {
      setData(await api.storeChannels());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message || e.code : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openEdit(ch: StoreChannelView) {
    setEditing(ch);
    form.setFieldsValue({
      identifier: ch.identifier,
      environment: ch.environment,
      endpoint: ch.endpoint,
      status: ch.status === "unset" ? "draft" : ch.status,
      secret: "",
    });
  }

  async function save() {
    if (!editing) return;
    const values = await form.validateFields();
    setBusy(true);
    try {
      // 不填密钥 = 保留原值（表单永远不回显已有密钥）
      await api.saveStoreChannel(editing.platform, {
        identifier: values.identifier,
        environment: values.environment,
        endpoint: values.endpoint,
        status: values.status,
        ...(values.secret ? { secret: values.secret } : {}),
      });
      message.success("已保存");
      setEditing(null);
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message || e.code : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        商店渠道
      </Typography.Title>
      <Typography.Text type="secondary">
        App Store / Google Play 的内购凭证。内购的钱由商店收、商店结算 —— CRM
        只能<strong>查单</strong>，不能发起支付、不能退款、也不接签名回调。
        每平台最多一条，只有「已启用」才会被查单调用。
      </Typography.Text>

      {error && <Alert type="error" showIcon message={error} />}
      {data && !data.secret_key_ready && (
        <Alert
          type="warning"
          showIcon
          message="未配置 PAYMENT_SECRET_KEY"
          description="没有主密钥就无法加密保存凭据。请先 wrangler secret put PAYMENT_SECRET_KEY。"
        />
      )}

      <Table<StoreChannelView>
        rowKey="platform"
        dataSource={data?.channels ?? []}
        pagination={false}
        size="middle"
        columns={[
          {
            title: "平台",
            dataIndex: "platform",
            render: (p: string) => PLATFORM_LABEL[p] ?? p,
          },
          {
            title: "包名 / Bundle ID",
            dataIndex: "identifier",
            render: (v: string) => v || "—",
          },
          {
            title: "环境",
            dataIndex: "environment",
            width: 100,
            render: (v: string) => (v === "sandbox" ? <Tag color="orange">沙盒</Tag> : "生产"),
          },
          {
            title: "凭据",
            dataIndex: "has_secret",
            width: 90,
            render: (has: boolean) => (has ? <Tag color="blue">已设置</Tag> : <Tag>未设置</Tag>),
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 90,
            render: (v: string) => {
              const s = STATUS[v] ?? STATUS.unset!;
              return <Tag color={s.color}>{s.text}</Tag>;
            },
          },
          {
            title: "最近成功",
            dataIndex: "last_ok_at",
            render: (v: string | null) => (v ? new Date(v).toLocaleString() : "—"),
          },
          {
            title: "操作",
            key: "actions",
            width: 100,
            render: (_, ch) => (
              <Button size="small" onClick={() => openEdit(ch)}>
                配置
              </Button>
            ),
          },
        ]}
        expandable={{
          expandedRowRender: (ch) => (
            <Space direction="vertical" size={4} style={{ fontSize: 12 }}>
              <span>API 地址：{ch.endpoint || "—"}</span>
              {ch.last_error && <span style={{ color: "#cf1322" }}>最近错误：{ch.last_error}</span>}
            </Space>
          ),
        }}
      />

      <Modal
        open={Boolean(editing)}
        title={editing ? `配置 ${PLATFORM_LABEL[editing.platform] ?? editing.platform}` : ""}
        onCancel={() => setEditing(null)}
        onOk={() => void save()}
        confirmLoading={busy}
        okText="保存"
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item
            name="identifier"
            label={editing?.platform === "apple" ? "Bundle ID" : "包名（package name）"}
            rules={[{ required: true, message: "必填：查单时用它校验凭据属于本 App" }]}
          >
            <Input placeholder="org.clevervpn.android" />
          </Form.Item>

          <Form.Item name="environment" label="环境" initialValue="production">
            <Select
              options={[
                { value: "production", label: "生产" },
                { value: "sandbox", label: "沙盒（只在非生产实例可用）" },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="status"
            label="状态"
            initialValue="draft"
            extra="只有「已启用」才会被查单调用；先存草稿，验收通过再启用"
          >
            <Select
              options={[
                { value: "draft", label: "草稿" },
                { value: "live", label: "已启用" },
                { value: "disabled", label: "已停用" },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="endpoint"
            label="API 地址（可选）"
            extra="留空用官方默认地址；只有沙盒域名或自建代理才需要改"
          >
            <Input placeholder="留空 = 官方地址" />
          </Form.Item>

          <Form.Item
            name="secret"
            label={editing?.platform === "apple" ? "凭据 JSON（.p8 / issuer_id / key_id）" : "服务账号 JSON"}
            extra={
              editing?.has_secret
                ? "已设置过：留空表示保持不变"
                : editing?.platform === "apple"
                  ? '示例：{"p8":"-----BEGIN PRIVATE KEY-----…","issuer_id":"…","key_id":"…"}'
                  : "粘贴 Google 服务账号的 JSON 原文"
            }
          >
            <Input.TextArea rows={4} placeholder="只在需要更新时填写" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
