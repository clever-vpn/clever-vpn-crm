import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
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
  type DomainDnsRecord,
  type DomainKind,
  type DomainView,
  type DomainsView,
} from "../api";

/**
 * 域名：一屏两件事 —— 品牌网站域名 / 后台登录域名。
 *
 * 三条取舍：
 *   1. **托管模式才出现「添加」**：自部署的域名由租户在自己的 Cloudflare 配，
 *      CRM 不假装能代管。
 *   2. 状态只说 pending / active / failed；原始 CF 状态放在小字里给客服看。
 *   3. 失败不隐藏：`last_error` 直接显示，并给「重新验证」；不会只留一个红点。
 */
const STATE_META: Record<
  DomainView["state"],
  { color: string; text: string }
> = {
  pending: { color: "gold", text: "等待验证" },
  active: { color: "green", text: "已生效" },
  failed: { color: "red", text: "验证失败" },
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

function DomainSection({
  kind,
  title,
  hint,
  domains,
  loading,
  refreshing,
  busyHost,
  onAdd,
  onDns,
  onRetry,
  onRemove,
  onRefresh,
}: {
  kind: DomainKind;
  title: string;
  hint: string;
  domains: DomainView[];
  loading: boolean;
  refreshing: boolean;
  busyHost: string | null;
  onAdd: () => void;
  onDns: (d: DomainView) => void;
  onRetry: (d: DomainView) => void;
  onRemove: (d: DomainView) => void;
  onRefresh: () => void;
}) {
  const columns = [
    {
      title: "域名",
      dataIndex: "hostname",
      key: "hostname",
      render: (_: unknown, d: DomainView) => (
        <div>
          <Typography.Text strong>{d.hostname}</Typography.Text>
          {d.state === "active" && (
            <div style={{ fontSize: 12, marginTop: 2 }}>
              <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer">
                打开{d.kind === "crm" ? "后台" : "网站"}
              </a>
            </div>
          )}
          {d.last_error && (
            <Typography.Text
              type="danger"
              style={{ display: "block", fontSize: 12, marginTop: 2 }}
              ellipsis={{ tooltip: d.last_error }}
            >
              {d.last_error}
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: "状态",
      dataIndex: "state",
      key: "state",
      width: 150,
      render: (state: DomainView["state"], d: DomainView) => {
        const meta = STATE_META[state] ?? STATE_META.pending;
        const activeNoDcv = state === "active" && !d.dcv_available;
        const detail =
          state === "active"
            ? d.cert_expires_at
              ? `证书有效期至 ${fmtDate(d.cert_expires_at)}`
              : "证书已生效"
            : state === "pending"
              ? "需要完成 DNS 配置"
              : "验证失败，请点「重新验证」";
        return (
          <div>
            <Tag color={meta.color}>{meta.text}</Tag>
            <div
              style={{
                fontSize: 11,
                marginTop: 2,
                color: activeNoDcv ? "#b45309" : "#8593a8",
              }}
            >
              {activeNoDcv ? `${detail} · 自动续期待处理` : detail}
            </div>
          </div>
        );
      },
    },
    {
      title: "证书有效期至",
      dataIndex: "cert_expires_at",
      key: "cert_expires_at",
      width: 140,
      render: (v: string | null, d: DomainView) =>
        v ? fmtDate(v) : d.state === "active" ? "有效期内" : "—",
    },
    {
      title: "添加时间",
      dataIndex: "created_at",
      key: "created_at",
      width: 150,
      render: (v: string | null) => fmtTime(v),
    },
    {
      title: "操作",
      key: "actions",
      width: 260,
      render: (_: unknown, d: DomainView) => (
        <Space wrap size={4}>
          <Button size="small" onClick={() => onDns(d)}>
            解析记录
          </Button>
          {d.state === "failed" && (
            <Button size="small" loading={busyHost === d.hostname} onClick={() => onRetry(d)}>
              重新验证
            </Button>
          )}
          <Popconfirm
            title="解除绑定？"
            description="解除后这个域名将无法访问。DNS 记录可以留着，但不再生效。"
            okText="解除"
            cancelText="取消"
            onConfirm={() => onRemove(d)}
          >
            <Button size="small" danger loading={busyHost === d.hostname}>
              解除绑定
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={title}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>
            刷新状态
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>
            添加{kind === "crm" ? "后台" : "网站"}域名
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {hint}
      </Typography.Paragraph>
      <Table
        rowKey="hostname"
        size="small"
        loading={loading}
        dataSource={domains}
        pagination={false}
        columns={columns}
        locale={{ emptyText: "还没有绑定自定义域名" }}
      />
    </Card>
  );
}

function AddDomainModal({
  kind,
  open,
  onClose,
  onCreated,
}: {
  kind: DomainKind;
  open: boolean;
  onClose: () => void;
  onCreated: (d: DomainView) => void;
}) {
  const [hostname, setHostname] = useState("");
  const [includeWww, setIncludeWww] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setHostname("");
      setIncludeWww(true);
      setBusy(false);
    }
  }, [open]);

  const host = hostname.trim().toLowerCase();
  const valid = HOST_RE.test(host);
  const apex = host.split(".").length === 2 && !host.startsWith("www.");
  const willBindWww = kind === "site" && includeWww && apex;
  const targets = willBindWww ? [host, `www.${host}`] : [host];

  async function submit(): Promise<void> {
    if (!valid) {
      message.error("请填一个合法域名，例如 www.example.com");
      return;
    }
    setBusy(true);
    let first: DomainView | null = null;
    const errors: string[] = [];
    for (const h of targets) {
      try {
        const r = await api.addDomain({ hostname: h, kind });
        if (!first) first = r.domain;
      } catch (e) {
        errors.push(`${h}：${errText(e, "绑定失败")}`);
      }
    }
    setBusy(false);
    if (errors.length > 0) message.error(errors.join("；"));
    if (first) {
      onCreated(first);
      onClose();
    }
  }

  return (
    <Modal
      open={open}
      title={kind === "crm" ? "添加后台域名" : "添加网站域名"}
      okText="绑定"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Form layout="vertical" style={{ marginTop: 12 }}>
        <Form.Item
          label="域名"
          extra="只填域名本身，不要带 http:// 或路径。绑定后按提示添加解析记录。"
          required
        >
          <Input
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder={kind === "crm" ? "crm.example.com" : "www.example.com"}
            onPressEnter={() => void submit()}
            autoFocus
          />
        </Form.Item>
        {kind === "site" && apex && (
          <Form.Item>
            <Checkbox
              checked={includeWww}
              onChange={(e) => setIncludeWww(e.target.checked)}
            >
              同时绑定 <code>www.{host}</code>
            </Checkbox>
            <div style={{ color: "#8593a8", fontSize: 12, marginTop: 4 }}>
              会创建 {willBindWww ? 2 : 1} 个域名，占用同样数量的自定义域名名额。
            </div>
          </Form.Item>
        )}
      </Form>
      {kind === "crm" && (
        <Alert
          type="info"
          showIcon
          message="绑定后，后台会多一个入口，默认地址仍然可用"
          description="支付网关的回调地址不会自动改；如果换了后台域名，请到支付网关里核对回调地址。"
        />
      )}
    </Modal>
  );
}

function DnsRecordsTable({ records }: { records: DomainDnsRecord[] }) {
  return (
    <Table
      rowKey={(r) => `${r.type}:${r.name}:${r.value}`}
      size="small"
      pagination={false}
      dataSource={records}
      columns={[
        { title: "类型", dataIndex: "type", width: 80 },
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

function DnsModal({
  domain,
  onClose,
}: {
  domain: DomainView | null;
  onClose: () => void;
}) {
  const dns = domain?.dns;
  const state = domain?.state;
  const traffic: DomainDnsRecord[] =
    dns && domain
      ? [{ type: "CNAME", name: domain.hostname, value: dns.target }]
      : [];
  const dcv = dns?.dcv ?? [];
  const hasDcv = dcv.length > 0;
  // 归属 TXT 只在 Hostname 还没 active 时是备用；HTTP 能过就不用加
  const ownership =
    dns?.ownership && domain && domain.hostname_status !== "active"
      ? [dns.ownership]
      : [];

  const banner = !dns ? (
    <Alert
      type="info"
      showIcon
      message="暂时读不到解析记录"
      description="请点「刷新状态」再打开；多次仍然失败，请联系客服。"
    />
  ) : state === "active" ? (
    hasDcv ? (
      <Alert
        type="success"
        showIcon
        message="一切正常，无需操作"
        description="网站可以正常访问。证书到期会自动续期，不需要再改 DNS。"
      />
    ) : (
      <Alert
        type="warning"
        showIcon
        message="网站正常，但自动续期还没配置"
        description="当前证书仍然有效，网站不受影响；但证书到期前需要处理。请联系客服，不要删除现有 DNS 记录。"
      />
    )
  ) : state === "pending" ? (
    hasDcv ? (
      <Alert
        type="info"
        showIcon
        message="还需要一步：完成 DNS 配置"
        description="请添加下面第 2 节的 CNAME，然后点「刷新状态」。之后系统会自动续期，不需要再操作。"
      />
    ) : (
      <Alert
        type="info"
        showIcon
        message="正在生成证书续期记录"
        description="请稍后点「刷新状态」；10 分钟后仍然没有，请联系客服。"
      />
    )
  ) : (
    <Alert
      type="error"
      showIcon
      message="验证失败，需要处理"
      description="请关闭后点「重新验证」；仍然失败请联系客服，并把下面的记录一并提供。"
    />
  );

  return (
    <Modal
      open={domain !== null}
      title={domain ? `解析记录 · ${domain.hostname}` : "解析记录"}
      width={760}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {banner}

        {dns && (
          <>
            <div>
              <Typography.Title level={5}>1. 网站访问记录</Typography.Title>
              <DnsRecordsTable records={traffic} />
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                <strong>域名在 Cloudflare：</strong>把这条记录设为「已代理」（橙色云朵）。
                <br />
                <strong>不在 Cloudflare：</strong>直接使用这条 CNAME，不需要代理。
              </Typography.Paragraph>
            </div>

            <div>
              <Typography.Title level={5}>2. 证书自动续期记录</Typography.Title>
              {hasDcv ? (
                <>
                  <DnsRecordsTable records={dcv} />
                  <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                    {state === "active"
                      ? "已配置，无需操作。以后证书到期会自动续期。"
                      : "如果域名在 Cloudflare：把这条记录设为「仅 DNS」（灰色云朵），然后点「刷新状态」。之后系统会自动续期，不需要再操作。"}
                    <br />
                    不要删除这条记录，也不要加同名 TXT。
                  </Typography.Paragraph>
                </>
              ) : state === "active" ? (
                <Alert
                  type="warning"
                  showIcon
                  message="自动续期还没配置"
                  description="当前证书有效，网站正常；证书到期前需要处理。请联系客服，不要删除现有 DNS 记录。"
                />
              ) : (
                <Alert
                  type="info"
                  showIcon
                  message="证书续期记录正在生成"
                  description="请稍后点「刷新状态」；10 分钟后仍然没有，请联系客服。"
                />
              )}
            </div>

            {ownership.length > 0 && (
              <div>
                <Typography.Title level={5}>3. 域名归属验证（通常不需要）</Typography.Title>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                  先等 5 分钟；如果状态仍是「等待验证」，再加下面这条 TXT。生效后可以删除。
                </Typography.Paragraph>
                <DnsRecordsTable records={ownership} />
              </div>
            )}

            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              <strong>根域名（如 example.com）：</strong>
              域名在 Cloudflare 时，加一条 A 记录 <code>@ → 192.0.2.1</code>（开启代理）；
              不在 Cloudflare 时，需要服务商支持 CNAME 展平 / ALIAS，否则请用子域，或把 DNS 托管到 Cloudflare。
            </Typography.Paragraph>
          </>
        )}
      </Space>
    </Modal>
  );
}

export default function Domains() {
  const [data, setData] = useState<DomainsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addKind, setAddKind] = useState<DomainKind | null>(null);
  const [dnsDomain, setDnsDomain] = useState<DomainView | null>(null);
  const [busyHost, setBusyHost] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    try {
      setData(await api.domains(refresh));
    } catch (e) {
      message.error(errText(e, "读取域名失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  // 有 pending 时每 30 秒回源一次；页面不可见时暂停（避免后台标签页一直打 CF）
  useEffect(() => {
    const domains = data?.domains ?? [];
    if (!data?.supported || !domains.some((d) => d.state !== "active")) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [data, load]);

  const retry = async (d: DomainView): Promise<void> => {
    setBusyHost(d.hostname);
    try {
      await api.retryDomain(d.hostname);
      message.success("已重新触发验证");
      await load(true);
    } catch (e) {
      message.error(errText(e, "重新验证失败"));
    } finally {
      setBusyHost(null);
    }
  };

  const remove = async (d: DomainView): Promise<void> => {
    setBusyHost(d.hostname);
    try {
      await api.removeDomain(d.hostname);
      message.success("已解除绑定");
      await load(true);
    } catch (e) {
      message.error(errText(e, "解除失败"));
    } finally {
      setBusyHost(null);
    }
  };

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  };

  if (data && !data.supported) {
    return (
      <Card title="自定义域名">
        <Alert
          type="info"
          showIcon
          message="自部署模式：域名由你自己管理"
          description={data.reason}
        />
      </Card>
    );
  }

  const domains = data?.domains ?? [];
  const siteDomains = domains.filter((d) => d.kind === "site");
  const crmDomains = domains.filter((d) => d.kind === "crm");

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="自定义域名由平台自动申请证书"
        description="绑定后按「解析记录」里的一次性步骤配置 DNS；配置完成后不需要再操作。原来的默认地址一直可用。"
      />

      {data?.defaults && (
        <Typography.Text type="secondary">
          默认后台地址：<code>{data.defaults.crm}</code> · 默认站点地址：
          <code>{data.defaults.site}</code>
        </Typography.Text>
      )}

      <DomainSection
        kind="site"
        title="品牌网站域名"
        hint="访客打开你品牌网站的地址。绑定后，原来的默认站点地址仍然可用。"
        domains={siteDomains}
        loading={loading}
        refreshing={refreshing}
        busyHost={busyHost}
        onAdd={() => setAddKind("site")}
        onDns={setDnsDomain}
        onRetry={(d) => void retry(d)}
        onRemove={(d) => void remove(d)}
        onRefresh={() => void refresh()}
      />

      <DomainSection
        kind="crm"
        title="后台登录域名"
        hint="你和员工登录后台的地址。绑定后默认地址仍然可用；支付网关回调地址不会自动改，换域名后请核对。"
        domains={crmDomains}
        loading={loading}
        refreshing={refreshing}
        busyHost={busyHost}
        onAdd={() => setAddKind("crm")}
        onDns={setDnsDomain}
        onRetry={(d) => void retry(d)}
        onRemove={(d) => void remove(d)}
        onRefresh={() => void refresh()}
      />

      <AddDomainModal
        kind={addKind ?? "site"}
        open={addKind !== null}
        onClose={() => setAddKind(null)}
        onCreated={(d) => {
          setDnsDomain(d);
          void load(true);
        }}
      />

      <DnsModal domain={dnsDomain} onClose={() => setDnsDomain(null)} />
    </Space>
  );
}
