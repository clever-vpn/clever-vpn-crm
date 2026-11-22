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
        return (
          <div>
            <Tag color={meta.color}>{meta.text}</Tag>
            <div style={{ fontSize: 11, color: "#8593a8", marginTop: 2 }}>
              {d.hostname_status ?? "—"} / {d.cert_status ?? "—"}
            </div>
          </div>
        );
      },
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

function DnsModal({
  domain,
  onClose,
}: {
  domain: DomainView | null;
  onClose: () => void;
}) {
  const dns = domain?.dns;
  const records: DomainDnsRecord[] = [];
  if (dns) {
    records.push({ type: "CNAME", name: domain!.hostname, value: dns.target });
    if (dns.ownership) records.push(dns.ownership);
    records.push(...dns.validation, ...dns.dcv);
  }

  return (
    <Modal
      open={domain !== null}
      title={domain ? `解析记录 · ${domain.hostname}` : "解析记录"}
      width={720}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      {!dns ? (
        <Alert
          type="info"
          showIcon
          message="平台还没返回解析记录"
          description="Cloudflare 的 validation_records 有时会晚几秒生成；点「刷新状态」再打开。"
        />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="在你的 DNS 服务商处添加以下记录"
            description="DNS 生效通常 5 分钟，证书最多 24 小时。改完回到列表点「刷新状态」。"
          />
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
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            <strong>根域名（如 example.com）：</strong>首选把 DNS 托管到 Cloudflare，然后加一条
            A 记录 <code>@ → 192.0.2.1</code>（开启代理）。如果继续用现在的 DNS 服务商，需要它支持
            CNAME 展平 / ALIAS；注册商通常不允许根域直接 CNAME。
          </Typography.Paragraph>
          {dns.dcv.length > 0 && (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              <strong>推荐用 DCV Delegation：</strong>把 <code>_acme-challenge</code> 按上表的 CNAME
              指过去，之后证书续期自动完成；如果已经加过同名的 TXT 记录，先删掉冲突的 TXT。
            </Typography.Paragraph>
          )}
        </Space>
      )}
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
        message="自定义域名由平台代为申请证书，DNS 仍在你的域名服务商处"
        description="新增域名后按提示添加解析记录；通常 5 分钟生效，证书最多 24 小时。原来的默认地址一直可用。"
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
