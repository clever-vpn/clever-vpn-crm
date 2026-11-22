import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";

import {
  api,
  ApiError,
  type DomainCheck,
  type DomainCheckStep,
  type DomainDnsRecord,
  type DomainKind,
  type DomainStatus,
  type DomainView,
  type DomainsView,
  type DnsProvider,
  type StepStatus,
} from "../api";

/**
 * 域名：提交域名 → 按「状态检查」里的步骤做一次 DNS 设置。
 *
 * 检查全部在 CRM：cf-api 只提供绑定和原始 CF 状态。页面只留两个动作：
 * 状态检查 / 删除；不再有解析记录、重新验证、刷新状态。
 */
const STATUS_META: Record<DomainStatus, { color: string; text: string }> = {
  pending_check: { color: "default", text: "待检查" },
  needs_action: { color: "gold", text: "待设置" },
  wait: { color: "blue", text: "等待生效" },
  ready: { color: "green", text: "已生效" },
  manual: { color: "orange", text: "需处理" },
  failed: { color: "red", text: "验证失败" },
  unknown: { color: "default", text: "暂时无法检查" },
};

const STEP_META: Record<StepStatus, { color: string; text: string }> = {
  done: { color: "green", text: "已完成" },
  todo: { color: "gold", text: "待完成" },
  wait: { color: "blue", text: "已检测到，等待生效" },
  unknown: { color: "default", text: "暂时无法检查" },
  manual: { color: "orange", text: "需要平台处理" },
};

const STEP_TITLE: Record<DomainCheckStep["id"], string> = {
  traffic: "网站访问记录",
  dcv: "证书续期记录",
  ownership: "域名归属验证",
};

const PROVIDER_LABEL: Record<DnsProvider, string> = {
  cloudflare: "Cloudflare",
  other: "其他 DNS",
  unknown: "未识别",
};

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiError && e.message ? e.message : fallback;

const fmtTime = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)}`;
};

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
};

const copy = (text: string): void => {
  if (!navigator.clipboard) {
    message.info(text);
    return;
  }
  void navigator.clipboard
    .writeText(text)
    .then(() => message.success("已复制"))
    .catch(() => message.error("复制失败，请手动选中"));
};

/** 只做即时提示；权威校验在 cf-api（这里放宽，避免误伤 punycode / 长域名） */
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function DnsTable({ records }: { records: DomainDnsRecord[] }) {
  return (
    <Table
      rowKey={(r) => `${r.type}:${r.name}:${r.value}`}
      size="small"
      pagination={false}
      dataSource={records}
      columns={[
        { title: "类型", dataIndex: "type", width: 82 },
        {
          title: "主机记录",
          dataIndex: "name",
          render: (v: string) => <code style={{ wordBreak: "break-all" }}>{v}</code>,
        },
        {
          title: "记录值",
          dataIndex: "value",
          render: (v: string) => <code style={{ wordBreak: "break-all" }}>{v}</code>,
        },
        {
          title: "",
          key: "copy",
          width: 70,
          render: (_: unknown, r: DomainDnsRecord) => (
            <Button size="small" onClick={() => copy(r.value)}>
              复制
            </Button>
          ),
        },
      ]}
    />
  );
}

function StepCard({ step }: { step: DomainCheckStep }) {
  const meta = STEP_META[step.status];
  const isDone = step.status === "done";
  return (
    <div
      style={{
        border: "1px solid #e8ebf0",
        borderRadius: 8,
        padding: 14,
        background: "#fff",
      }}
    >
      <Space align="center" style={{ marginBottom: 8 }}>
        <Typography.Text strong>
          {STEP_TITLE[step.id]}
        </Typography.Text>
        <Tag color={meta.color}>{meta.text}</Tag>
      </Space>

      {step.expected && (
        <div style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            需要这条记录
          </Typography.Text>
          <DnsTable records={[step.expected]} />
        </div>
      )}

      {step.actual.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            检测到
          </Typography.Text>
          <DnsTable records={step.actual} />
        </div>
      )}

      {!isDone && step.fix && (
        <Alert
          type={step.status === "manual" || step.status === "unknown" ? "warning" : "info"}
          showIcon
          message="怎么改"
          description={step.fix}
        />
      )}
      {isDone && (
        <Typography.Text type="success" style={{ fontSize: 12 }}>
          已完成，不需要再操作。
        </Typography.Text>
      )}
    </div>
  );
}

function CheckModal({
  hostname,
  onClose,
  onChanged,
}: {
  hostname: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [check, setCheck] = useState<DomainCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (host: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.checkDomain(host);
      setCheck(res.check);
      onChanged();
    } catch (e) {
      setCheck(null);
      setError(errText(e, "暂时无法检查，请稍后重试"));
    } finally {
      setLoading(false);
    }
  }, [onChanged]);

  useEffect(() => {
    if (!hostname) {
      setCheck(null);
      setError(null);
      return;
    }
    setCheck(null);
    void run(hostname);
  }, [hostname, run]);

  const todoCount = check?.steps.filter((s) => s.status === "todo").length ?? 0;

  const banner = (() => {
    if (!check) {
      return error ? (
        <Alert type="error" showIcon message="暂时无法检查" description={error} />
      ) : (
        <Alert type="info" showIcon message="正在检查…" description="正在查询 Cloudflare 状态和 DNS 记录。" />
      );
    }
    if (check.status === "ready") {
      return (
        <Alert
          type="success"
          showIcon
          message="设置已完成，域名已生效"
          description={
            check.cert_expires_at
              ? `证书有效期至 ${fmtDate(check.cert_expires_at)}；到期会自动续期，不需要再操作。`
              : "证书到期会自动续期，不需要再操作。"
          }
        />
      );
    }
    if (check.status === "needs_action") {
      return (
        <Alert
          type="info"
          showIcon
          message={`还需要完成 ${todoCount || "几"} 步`}
          description="按下面每步的「怎么改」操作，然后点「重新检查」。"
        />
      );
    }
    if (check.status === "wait") {
      return (
        <Alert
          type="info"
          showIcon
          message="记录已检测到，正在等待生效"
          description="通常几分钟；稍后点「重新检查」。"
        />
      );
    }
    if (check.status === "manual") {
      return (
        <Alert
          type="warning"
          showIcon
          message="需要平台处理"
          description="请联系客服，不要删除现有 DNS 记录。"
        />
      );
    }
    if (check.status === "failed") {
      return (
        <Alert
          type="error"
          showIcon
          message="验证失败"
          description="请联系客服，并把下面的记录提供给客服。"
        />
      );
    }
    return (
      <Alert
        type="info"
        showIcon
        message="暂时无法检查"
        description="请稍后点「重新检查」。"
      />
    );
  })();

  return (
    <Modal
      open={hostname !== null}
      title={hostname ? `域名状态 · ${hostname}` : "域名状态"}
      width={820}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={loading}
            disabled={!hostname}
            onClick={() => hostname && void run(hostname)}
          >
            重新检查
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {banner}
        {check && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前按 {PROVIDER_LABEL[check.provider]} 生成步骤；DNS 服务商是自动判断的。
          </Typography.Text>
        )}
        {check?.steps.map((step) => <StepCard key={step.id} step={step} />)}
        {check && check.steps.length === 0 && (
          <Typography.Text type="secondary">
            暂时读不到 Cloudflare 的域名详情；请稍后重新检查，或联系客服。
          </Typography.Text>
        )}
      </Space>
    </Modal>
  );
}

function AddDomainModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (domain: DomainView) => void;
}) {
  const [form] = Form.useForm<{ hostname: string; kind: DomainKind }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      form.setFieldsValue({ hostname: "", kind: "site" });
      setError(null);
    }
  }, [open, form]);

  const submit = async (): Promise<void> => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const hostname = values.hostname.trim().toLowerCase();
    if (!HOST_RE.test(hostname)) {
      setError("请填写有效域名，例如 www.example.com");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.addDomain({ hostname, kind: values.kind });
      onCreated(res.domain);
      onClose();
    } catch (e) {
      setError(errText(e, "添加失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="添加域名"
      width={520}
      onCancel={onClose}
      onOk={() => void submit()}
      okText="添加并查看步骤"
      confirmLoading={busy}
    >
      <Form form={form} layout="vertical" initialValues={{ kind: "site" }}>
        <Form.Item
          name="hostname"
          label="域名"
          rules={[{ required: true, message: "请填写域名" }]}
          extra="添加后系统会自动判断 DNS 服务商，并生成需要你做的步骤。"
        >
          <Input placeholder="www.example.com" autoFocus onPressEnter={() => void submit()} />
        </Form.Item>
        <Form.Item name="kind" label="用途" rules={[{ required: true }]}>
          <Radio.Group>
            <Radio.Button value="site">品牌网站</Radio.Button>
            <Radio.Button value="crm">后台登录</Radio.Button>
          </Radio.Group>
        </Form.Item>
      </Form>
      {error && <Alert type="error" showIcon message={error} />}
    </Modal>
  );
}

export default function Domains() {
  const [data, setData] = useState<DomainsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [checkHost, setCheckHost] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.domains());
    } catch (e) {
      message.error(errText(e, "加载域名失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCheckChanged = useCallback(() => {
    void load();
  }, [load]);

  const remove = async (hostname: string): Promise<void> => {
    try {
      await api.removeDomain(hostname);
      message.success("已删除");
      if (checkHost === hostname) setCheckHost(null);
      await load();
    } catch (e) {
      message.error(errText(e, "删除失败"));
    }
  };

  const domains = data?.domains ?? [];

  if (data && data.supported === false) {
    return (
      <Alert
        type="info"
        showIcon
        message="当前是自部署模式"
        description={data.reason ?? "自定义域名由你自己管理，后台不参与托管绑定。"}
      />
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="添加域名后，按「状态检查」里的步骤完成一次 DNS 设置"
        description="设置完成后不需要再操作；之后随时可以点「状态检查」确认状态。原来的默认地址一直可用。"
      />

      {data?.defaults && (
        <Typography.Text type="secondary">
          默认后台地址：<code>{data.defaults.crm}</code> · 默认站点地址：
          <code>{data.defaults.site}</code>
        </Typography.Text>
      )}

      <Space style={{ width: "100%", justifyContent: "space-between" }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          已绑定域名
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
          添加域名
        </Button>
      </Space>

      <Table<DomainView>
        rowKey="hostname"
        loading={loading}
        dataSource={domains}
        pagination={false}
        locale={{ emptyText: "还没有绑定域名" }}
        columns={[
          {
            title: "域名",
            dataIndex: "hostname",
            render: (hostname: string, d) => (
              <div>
                <Typography.Text strong>{hostname}</Typography.Text>
                {d.status === "ready" && (
                  <div style={{ fontSize: 12, marginTop: 2 }}>
                    <a href={`https://${hostname}`} target="_blank" rel="noreferrer">
                      打开{d.kind === "crm" ? "后台" : "网站"}
                    </a>
                  </div>
                )}
              </div>
            ),
          },
          {
            title: "用途",
            dataIndex: "kind",
            width: 100,
            render: (kind: DomainKind) => (
              <Tag color={kind === "crm" ? "purple" : "blue"}>
                {kind === "crm" ? "后台" : "网站"}
              </Tag>
            ),
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 160,
            render: (status: DomainStatus) => {
              const meta = STATUS_META[status] ?? STATUS_META.pending_check;
              return <Tag color={meta.color}>{meta.text}</Tag>;
            },
          },
          {
            title: "上次检查",
            dataIndex: "last_checked_at",
            width: 170,
            render: (v: string | null) => fmtTime(v),
          },
          {
            title: "操作",
            key: "actions",
            width: 200,
            render: (_: unknown, d) => (
              <Space size={4}>
                <Button size="small" onClick={() => setCheckHost(d.hostname)}>
                  状态检查
                </Button>
                <Popconfirm
                  title="删除这个域名？"
                  description="删除后这个地址将无法访问；DNS 记录可以留着，但不再生效。"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => void remove(d.hostname)}
                >
                  <Button size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <AddDomainModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(domain) => {
          setCheckHost(domain.hostname);
          void load();
        }}
      />

      <CheckModal
        hostname={checkHost}
        onClose={() => setCheckHost(null)}
        onChanged={handleCheckChanged}
      />
    </Space>
  );
}
