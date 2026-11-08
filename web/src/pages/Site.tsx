import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  ColorPicker,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tabs,
  Typography,
  message,
} from "antd";

import {
  api,
  ApiError,
  type SiteDomainView,
  type SiteStateView,
  type SiteSettingsView,
  type SiteVersion,
} from "../api";

/**
 * 网站：三个页签，一屏一件事。
 *
 *   发布   → 看一眼线上是哪一版，点一下发布（唯一的 primary 按钮）
 *   站点设置 → 名称 / 介绍 / 主色 / 客服邮箱 / 页脚，**发布后才生效**
 *   域名   → **只有 SaaS（multi）模式才有**；自部署由租户自己在 Cloudflare 挂
 *
 * 三条刻意的取舍（评审时别改回去）：
 *
 *  1. **发布只有一个 primary 按钮**。回滚是版本表里的次要操作 —— 两个同权重按钮，
 *     零技术租户不知道该点哪个。
 *  2. **失败说人话**：闸门返回的 `issues[]` 逐条列出来，不把错误码丢给用户。
 *  3. **"保存"不等于"发布"**：品牌值是**发布时烘焙**进静态文件的，页面上必须写明
 *     "改完要重新发布"，否则租户会以为保存完就该变。
 */
const fmtBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)}`;
};

export default function Site() {
  const [state, setState] = useState<SiteStateView | null>(null);
  const [settings, setSettings] = useState<SiteSettingsView | null>(null);
  const [domain, setDomain] = useState<SiteDomainView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [tab, setTab] = useState("publish");

  const load = useCallback(async () => {
    try {
      const [s, st, d] = await Promise.all([
        api.site(),
        api.siteSettings(),
        api.siteDomain(),
      ]);
      setState(s);
      setSettings(st.settings);
      setDomain(d);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : "读不到站点状态");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish() {
    setBusy(true);
    setIssues([]);
    try {
      const res = await api.sitePublish();
      message.success(
        `已发布第 ${res.version} 版（${res.files} 个文件 / ${fmtBytes(res.bytes)}），约 5 秒内生效`,
      );
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        const list = Array.isArray(e.body?.issues)
          ? (e.body.issues as string[])
          : [];
        setIssues(list);
        message.error(list.length > 0 ? "发布前检查没通过" : e.message);
      } else {
        message.error("发布失败");
      }
    } finally {
      setBusy(false);
    }
  }

  async function rollback(version: number) {
    try {
      await api.siteRollback(version);
      message.success(`已回滚到第 ${version} 版`);
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : "回滚失败");
    }
  }

  async function saveSettings(values: Record<string, unknown>) {
    setBusy(true);
    try {
      const picked = values.color as
        | string
        | { toHexString?: () => string }
        | undefined;
      const color =
        typeof picked === "string" ? picked : picked?.toHexString?.() ?? "";
      const res = await api.saveSiteSettings({
        site_name: String(values.site_name ?? ""),
        tagline: String(values.tagline ?? ""),
        color,
        contact_email: String(values.contact_email ?? ""),
        footer_note: String(values.footer_note ?? ""),
      });
      setSettings(res.settings);
      message.success("已保存。要让线上生效，还需要点「发布」重新发布一次");
      setTab("publish");
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const active = state?.active ?? null;
  const templateReady = state?.templateReady ?? false;
  const versions = state?.versions ?? [];
  const published = versions.find((v) => v.seq === active) ?? null;

  const columns = [
    {
      title: "版本",
      dataIndex: "seq",
      render: (seq: number) =>
        seq === active ? (
          <Space>
            <Tag color="green">线上</Tag>
            <span>第 {seq} 版</span>
          </Space>
        ) : (
          <span>第 {seq} 版</span>
        ),
    },
    {
      title: "发布内容",
      dataIndex: "template",
      render: (t: string, row: SiteVersion) =>
        `${t} ${row.template_version}（${row.files} 个文件 / ${fmtBytes(row.bytes)}）`,
    },
    {
      title: "发布时间",
      dataIndex: "created_at",
      render: (iso: string) => fmtTime(iso),
    },
    {
      title: "操作",
      key: "op",
      render: (_: unknown, row: SiteVersion) =>
        row.seq === active ? (
          <Typography.Text type="secondary">正在服务</Typography.Text>
        ) : (
          <Popconfirm
            title={`把线上切回第 ${row.seq} 版？`}
            description="立即生效，不重建、不重新渲染。"
            okText="切回这一版"
            cancelText="取消"
            onConfirm={() => rollback(row.seq)}
          >
            <Button size="small">回滚到这一版</Button>
          </Popconfirm>
        ),
    },
  ];

  const publishTab = (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card>
            <Statistic
              title="线上版本"
              value={active === null ? "尚未发布" : `第 ${active} 版`}
              loading={loading}
            />
            <Typography.Paragraph
              type="secondary"
              style={{ marginTop: 12, marginBottom: 0 }}
            >
              {published
                ? `发布于 ${fmtTime(published.created_at)}。改完设置要再点一次「发布站点」才会生效。`
                : "点下面的「发布站点」，把当前内容生成静态文件并发到线上。"}
            </Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card>
            <Statistic
              title="历史版本"
              value={versions.length}
              loading={loading}
              suffix="个"
            />
            <Typography.Paragraph
              type="secondary"
              style={{ marginTop: 12, marginBottom: 0 }}
            >
              回滚不需要重新渲染：把指针指回旧版本即可，秒级生效。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      {!templateReady && !loading && (
        <Alert
          type="warning"
          showIcon
          message="模板还没上传到 R2"
          description="现在点发布会失败。先在服务器上执行 npm run site:template:upload（把仓库里的 site-template/ 传成 g/templates/basic/v1/）。"
        />
      )}

      {issues.length > 0 && (
        <Alert
          type="error"
          showIcon
          message="发布前检查没通过：内容有问题，线上没有任何变化"
          description={
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          }
        />
      )}

      <Card
        title="发布"
        extra={
          <Popconfirm
            title="把当前内容发布到线上？"
            description="发布后约 5 秒生效；出问题可以随时回滚到旧版本。"
            okText="发布"
            cancelText="取消"
            onConfirm={publish}
            disabled={busy || !templateReady}
          >
            <Button type="primary" loading={busy} disabled={!templateReady}>
              发布站点
            </Button>
          </Popconfirm>
        }
      >
        <Descriptions column={1} size="small">
          <Descriptions.Item label="模板">
            {templateReady ? "已就绪（basic v1）" : "未上传"}
          </Descriptions.Item>
          <Descriptions.Item label="生效时间">
            切指针后约 5 秒（site-serve 有 5 秒指针缓存）
          </Descriptions.Item>
          <Descriptions.Item label="发布失败会怎样">
            什么都不变：产物没写完就不会切指针，线上仍是上一版。
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="版本记录">
        <Table
          rowKey="seq"
          size="small"
          loading={loading}
          dataSource={versions}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "还没有发布过" }}
        />
      </Card>
    </Space>
  );

  const settingsTab = (
    <Card>
      <Form
        layout="vertical"
        initialValues={{
          site_name: settings?.siteName ?? "",
          tagline: settings?.tagline ?? "",
          color: settings?.color ?? "#3b82f6",
          contact_email: settings?.contactEmail ?? "",
          footer_note: settings?.footerNote ?? "",
        }}
        onFinish={saveSettings}
        style={{ maxWidth: 560 }}
      >
        <Form.Item
          label="站点名称"
          name="site_name"
          rules={[{ max: 40, message: "最多 40 个字符" }]}
          extra="用在浏览器标签页标题和页脚版权行"
        >
          <Input placeholder="例如：Acme VPN" />
        </Form.Item>
        <Form.Item
          label="一句话介绍"
          name="tagline"
          rules={[{ max: 120, message: "最多 120 个字符" }]}
          extra="用在搜索引擎摘要里（meta description）"
        >
          <Input placeholder="例如：快、稳、不记日志的 VPN" />
        </Form.Item>
        <Form.Item label="主色" name="color" extra="按钮与强调色">
          <ColorPicker format="hex" disabledAlpha />
        </Form.Item>
        <Form.Item
          label="客服邮箱"
          name="contact_email"
          rules={[{ type: "email", message: "邮箱格式不对" }]}
          extra="留空则不显示"
        >
          <Input placeholder="help@example.com" />
        </Form.Item>
        <Form.Item
          label="页脚版权行"
          name="footer_note"
          rules={[{ max: 80, message: "最多 80 个字符" }]}
          extra="留空则自动生成「© 年份 站点名称」"
        >
          <Input placeholder="© 2026 Acme Inc." />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={busy}>
            保存
          </Button>
          <Typography.Text type="secondary">
            保存后线上不会立刻变，需要重新发布
          </Typography.Text>
        </Space>
      </Form>
    </Card>
  );

  const domainTab = (
    <Card title="站点域名">
      {domain === null ? (
        <Typography.Text type="secondary">加载中…</Typography.Text>
      ) : domain.supported ? (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="托管模式：域名由平台代为绑定"
            description={domain.reason}
          />
          <Typography.Text type="secondary">
            绑定流程：填域名 → 按提示加一条解析记录 → 平台自动签发证书（通常 5 分钟，最多 24
            小时）。
          </Typography.Text>
        </Space>
      ) : (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="自部署模式：域名由你自己管理"
            description={domain.reason}
          />
          <Typography.Text type="secondary">
            具体做法：在 Cloudflare 里给 <code>site-serve</code> 这个 Worker 添加 Custom
            Domain，并让 <code>KV[host:你的域名]</code> 指向
            <code>{'{ tenant_id, slot, status }'}</code>。
          </Typography.Text>
        </Space>
      )}
    </Card>
  );

  return (
    <Tabs
      activeKey={tab}
      onChange={setTab}
      items={[
        { key: "publish", label: "发布", children: publishTab },
        { key: "settings", label: "站点设置", children: settingsTab },
        { key: "domain", label: "域名", children: domainTab },
      ]}
    />
  );
}
