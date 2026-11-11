import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  ColorPicker,
  Descriptions,
  Divider,
  Form,
  Input,
  Popconfirm,
  Row,
  Select,
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
  type DownloadItem,
  type SiteCollections,
  type SiteDomainView,
  type SiteStateView,
  type SiteSettingsView,
  type SiteValues,
  type SiteVersion,
} from "../api";

/**
 * 网站：三个页签，一屏一件事。
 *
 *   发布   → 主按钮是「打开设计器」（改内容的正路）；「发布站点」是次要动作
 *            （改完设置要重新发布时用）
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

  /**
   * 进设计器：先换一张一次性票据，再整页跳过去。
   *
   * `url` 由 CRM 后端拼（studio 的 origin 只从服务端配置来，契约
   * `studio-identity.md` §2.1）；票据在 URL 的 `#` 片段里，**不会发给任何服务端**，
   * 由 studio 页面自己用一次就作废。
   */
  async function openStudio() {
    setBusy(true);
    try {
      const { url } = await api.studioTicket();
      window.location.assign(url);
    } catch (e) {
      const msg =
        e instanceof ApiError && e.body?.error === "studio_not_configured"
          ? "设计器还没启用：先在部署里配 STUDIO_SITE_URL（studio 的地址）。"
          : e instanceof ApiError
            ? e.message
            : "打不开设计器";
      message.error(msg);
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

  async function saveSettings(raw: unknown) {
    setBusy(true);
    // 表单里 settings 与集合在一个 `Form` 下（一次保存、一个 rev），
    // 提交时再拆成两段：`values` 走设置校验，`collections` 走集合校验。
    const form = raw as SiteValues & { collections?: SiteCollections };
    const { collections: rawCollections, ...values } = form;
    try {
      const picked = values.site?.theme?.brand as
        | string
        | { toHexString?: () => string }
        | undefined;
      const brand =
        typeof picked === "string" ? picked : (picked?.toHexString?.() ?? "");
      const res = await api.saveSiteSettings({
        if_rev: settings?.rev ?? 0,
        values: {
          ...values,
          site: {
            ...(values.site ?? {}),
            theme: { ...(values.site?.theme ?? {}), brand },
          },
        },
        collections: {
          downloads: (rawCollections?.downloads ?? []).filter(
            (d: DownloadItem) => d?.url,
          ),
        },
      });
      setSettings({ ...res, updatedAt: null });
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
      <Card
        title="改内容"
        extra={
          <Button type="primary" loading={busy} onClick={openStudio}>
            打开设计器
          </Button>
        }
      >
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          文案、配色、页面结构都在设计器里改，边改边看。改完点设计器里的「发布」，
          线上就会切到新的一版。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          这里是「设置 + 发布」：站点名称、客服邮箱这些改完要再点一次发布才会生效
          （品牌值是发布时写进页面的）。
        </Typography.Paragraph>
      </Card>

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
            <Button loading={busy} disabled={!templateReady}>
              发布站点
            </Button>
          </Popconfirm>
        }
      >
        <Descriptions column={1} size="small">
          <Descriptions.Item label="模板">
            {state?.templateVersion
              ? `设计器交付的 ${state.templateVersion}`
              : templateReady
                ? "公共模板 basic v1（你还没在设计器里改过）"
                : "未上传"}
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
          site: {
            name: settings?.values?.site?.name ?? "",
            tagline: settings?.values?.site?.tagline ?? "",
            contact_email: settings?.values?.site?.contact_email ?? "",
            footer_note: settings?.values?.site?.footer_note ?? "",
            hero: {
              title: settings?.values?.site?.hero?.title ?? "",
              sub: settings?.values?.site?.hero?.sub ?? "",
              layout: settings?.values?.site?.hero?.layout ?? "split",
            },
            layout: { shell: settings?.values?.site?.layout?.shell ?? "top" },
            theme: {
              brand: settings?.values?.site?.theme?.brand ?? "#4f46e5",
              bg: settings?.values?.site?.theme?.bg ?? "#ffffff",
              text: settings?.values?.site?.theme?.text ?? "#0d1626",
            },
            icon: {
              mark: settings?.values?.site?.icon?.mark ?? "",
              image: settings?.values?.site?.icon?.image ?? null,
            },
            download: {
              note: settings?.values?.site?.download?.note ?? "",
            },
          },
          collections: {
            downloads: (settings?.collections?.downloads ?? []).map((d) => ({
              platform: d.platform,
              kind: d.kind,
              label: d.label,
              url: d.url,
            })),
          },
        }}
        onFinish={saveSettings}
        style={{ maxWidth: 560 }}
      >
        <Form.Item
          label="站点名称"
          name={["site", "name"]}
          rules={[{ max: 40, message: "最多 40 个字符" }]}
          extra="用在浏览器标签页标题和页脚版权行"
        >
          <Input placeholder="例如：Acme VPN" />
        </Form.Item>
        <Form.Item
          label="一句话介绍"
          name={["site", "tagline"]}
          rules={[{ max: 120, message: "最多 120 个字符" }]}
          extra="用在搜索引擎摘要里（meta description）"
        >
          <Input placeholder="例如：快、稳、不记日志的 VPN" />
        </Form.Item>
        <Form.Item
          label="首页大标题"
          name={["site", "hero", "title"]}
          rules={[{ max: 40, message: "最多 40 个字符" }]}
          extra="首页最大那行字。留空用默认文案"
        >
          <Input placeholder="例如：一键连上，快得像本地网络" />
        </Form.Item>
        <Form.Item
          label="首页副标题"
          name={["site", "hero", "sub"]}
          rules={[{ max: 120, message: "最多 120 个字符" }]}
          extra="标题下面那行解释。留空则不显示"
        >
          <Input placeholder="例如：一个账号，三端通用，不限速不计日志" />
        </Form.Item>
        <Form.Item label="主色" name={["site", "theme", "brand"]} extra="按钮与强调色（主题里还有背景色与正文色，可后续扩展）">
          <ColorPicker format="hex" disabledAlpha />
        </Form.Item>
        <Form.Item
          label="客服邮箱"
          name={["site", "contact_email"]}
          rules={[{ type: "email", message: "邮箱格式不对" }]}
          extra="留空则不显示"
        >
          <Input placeholder="help@example.com" />
        </Form.Item>
        <Form.Item
          label="页脚版权行"
          name={["site", "footer_note"]}
          rules={[{ max: 80, message: "最多 80 个字符" }]}
          extra="留空则自动生成「© 年份 站点名称」"
        >
          <Input placeholder="© 2026 Acme Inc." />
        </Form.Item>

        <Divider orientation="left" plain>
          下载入口
        </Divider>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          一个平台可以挂多个渠道（商店、TestFlight、官网直链、历史版本）。
          按钮顺序就是这里的顺序；平台下一条都没有，那一块在下载页上不出现。
        </Typography.Paragraph>
        <Form.List name={["collections", "downloads"]}>
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <Row key={field.key} gutter={8} align="top" style={{ marginBottom: 8 }}>
                  <Col span={5}>
                    <Form.Item
                      name={[field.name, "platform"]}
                      rules={[{ required: true, message: "选平台" }]}
                      style={{ marginBottom: 0 }}
                    >
                      <Select
                        options={[
                          { value: "ios", label: "iPhone / iPad" },
                          { value: "android", label: "Android" },
                          { value: "windows", label: "Windows" },
                          { value: "macos", label: "Mac" },
                        ]}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={4}>
                    <Form.Item name={[field.name, "kind"]} style={{ marginBottom: 0 }}>
                      <Select
                        options={[
                          { value: "store", label: "应用商店" },
                          { value: "file", label: "直接下载" },
                        ]}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={5}>
                    <Form.Item
                      name={[field.name, "label"]}
                      rules={[{ max: 24, message: "最多 24 个字符" }]}
                      style={{ marginBottom: 0 }}
                    >
                      <Input placeholder="按钮文字（可空）" />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item
                      name={[field.name, "url"]}
                      rules={[
                        { required: true, message: "填链接" },
                        {
                          pattern: /^https?:\/\/\S+$/i,
                          message: "必须以 http(s):// 开头",
                        },
                      ]}
                      style={{ marginBottom: 0 }}
                    >
                      <Input placeholder="https://…" />
                    </Form.Item>
                  </Col>
                  <Col span={2}>
                    <Button danger type="text" onClick={() => remove(field.name)}>
                      删除
                    </Button>
                  </Col>
                </Row>
              ))}
              <Button
                block
                type="dashed"
                onClick={() =>
                  add({ platform: "windows", kind: "file", label: "", url: "" })
                }
                style={{ marginBottom: 16 }}
              >
                添加下载入口
              </Button>
            </>
          )}
        </Form.List>

        <Form.Item
          label="下载页补充说明"
          name={["site", "download", "note"]}
          rules={[{ max: 120, message: "最多 120 个字符" }]}
          extra="例如「iOS 版正在 TestFlight 内测」。留空则不显示"
        >
          <Input placeholder="例如：Windows 版暂时只有 64 位" />
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
