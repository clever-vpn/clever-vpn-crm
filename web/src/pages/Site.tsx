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
  Switch,
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
  type SiteMeta,
  type SitePalette,
  type SiteStateView,
  type SiteSettingsView,
  type SiteValues,
  type SiteRelease,
} from "../api";
import {
  effectiveInitialValues,
  formFields,
  getPath,
  palettePatch,
  setPath,
  type FormField,
} from "../site-fields";

/**
 * 网站：三个页签，一屏一件事。
 *
 *   发布   → 主按钮是「打开设计器」（改内容的正路）；「发布站点」是次要动作
 *            （改完设置要重新发布时用）
 *   站点设置 → 由 CRM 的 capabilities 生成（`src/site/meta.ts` 那份清单），
 *            **保存不等于发布**：品牌值是发布时烘焙进静态文件的
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

/** `ColorPicker` 给的是 Color 对象；存库只要 `#rrggbb` */
const colorEvent = (c: string | { toHexString: () => string }): string =>
  typeof c === "string" ? c : c.toHexString();

const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)}`;
};

export default function Site() {
  const [state, setState] = useState<SiteStateView | null>(null);
  const [settings, setSettings] = useState<SiteSettingsView | null>(null);
  /** 当前**生效**的渲染作用域：颜色留空时是跟随主题的那一套（表单回填用） */
  const [scope, setScope] = useState<Record<string, unknown> | null>(null);
  const [meta, setMeta] = useState<SiteMeta | null>(null);
  const [domain, setDomain] = useState<SiteDomainView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [tab, setTab] = useState("publish");
  /** 选中的配色建议（只用来高亮，不是被保存的字段） */
  const [paletteId, setPaletteId] = useState<string | null>(null);
  /** 展开「高级：逐个调色」 */
  const [advanced, setAdvanced] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const [s, st, d, m] = await Promise.all([
        api.site(),
        api.siteSettings(),
        api.siteDomain(),
        api.siteMeta(),
      ]);
      setState(s);
      setSettings(st.settings);
      setScope(st.scope ?? null);
      setDomain(d);
      setMeta(m);
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : "读不到站点状态");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 字段清单（由 CRM 的 capabilities 生成，见 `web/src/site-fields.ts`） */
  const fields = meta ? formFields(meta.capabilities) : [];
  /**
   * 五个颜色令牌收进「高级」：默认路径是**选一套配色方案**，不是让租户逐个挑颜色。
   * 逐个调色仍然在，只是要主动展开（评审时别把这条改回去）。
   */
  const colorFields = fields.filter((f) => f.path.startsWith("site.theme.color."));
  const restFields = fields.filter((f) => !f.path.startsWith("site.theme.color."));
  // 「主题（深/浅）」和「配色方案」是同一件事的两步，放同一组
  const themeFields = restFields.filter((f) => f.path === "site.theme.preset");
  const baseFields = restFields.filter((f) => f.path !== "site.theme.preset");
  /** 首屏那些字段（contract 8 起是 site.hero.*）单独一组 */
  const heroFields = baseFields.filter((f) => f.path.startsWith("site.hero."));
  const siteFields = baseFields.filter((f) => !f.path.startsWith("site.hero."));
  /** internal 设置：不在 capabilities 里，单独渲染 */
  const ZARAZ_PATH = "site.integrations.zaraz";
  const ZARAZ_NAME = ["site", "integrations", "zaraz"] as const;

  /**
   * 拿到设置 / 契约之后回填表单。
   *
   * 用 `initialValues` 这个纯函数而不是直接 `settings.values`：库里可能还留着已经
   * 删掉的路径，原样回填会被后端判 `unknown_field`（保存失败但说不清哪一项）。
   */
  useEffect(() => {
    if (!meta || !settings) return;
    form.setFieldsValue({
      ...effectiveInitialValues(fields, settings.values, scope),
      // 下载入口仍是一小块专用表单（集合不是单值），值也在同一个 Form 里，
      // 这样"设置 + 集合"一次保存、一个 `rev`
      collections: {
        downloads: settings.collections.downloads.map((d) => ({ ...d })),
      },
      // 集成开关是 internal 设置（不在 capabilities 里），单独回填。缺省 = 开。
      site: {
        ...((effectiveInitialValues(fields, settings.values, scope) as { site?: object }).site ?? {}),
        integrations: {
          zaraz: String(getPath(settings.values, "site.integrations.zaraz") ?? "1") !== "0",
        },
      },
    });
    // `fields` 由 meta 派生，跟着 meta 变；不放进依赖是为了避免每次渲染重算一份
  }, [meta, settings, scope, form]);

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

  /**
   * 应用一套配色：写 `preset` + 主色 + 强调色，并**标成"动过"**。
   *
   * 为什么不用 `setFieldsValue`：它只改值、不标 touched，而保存时"只提交动过的字段"
   * 正是靠 touched 判的 —— 用 setFieldsValue 会出现"点了方案、保存后什么也没存"。
   */
  function applyPalette(palette: SitePalette) {
    setPaletteId(palette.id);
    const patch = palettePatch(palette) as {
      site: { theme: { preset?: string; color?: Record<string, string> } };
    };
    const theme = patch.site.theme;
    const fields: { name: (string | number)[]; value: string; touched: true }[] = [];
    if (theme.preset) {
      fields.push({ name: ["site", "theme", "preset"], value: theme.preset, touched: true });
    }
    for (const [token, value] of Object.entries(theme.color ?? {})) {
      fields.push({ name: ["site", "theme", "color", token], value, touched: true });
    }
    form.setFields(fields);
  }

  async function saveSettings(raw: unknown) {
    setBusy(true);
    // 表单里设置与集合在一个 `Form` 下（一次保存、一个 rev），提交时拆成两段：
    // `values` 走设置校验，`collections` 走集合校验。
    //
    // `values` 里的键**全部来自 capabilities**（表单只渲染清单里的字段），所以不会
    // 把库里那些已经删掉的路径（比如 `contract: 7` 的 `site.theme.brand`）带上。
    const submitted = raw as SiteValues & { collections?: SiteCollections };
    const { collections: rawCollections, ...formValues } = submitted;
    /**
     * **只提交动过的字段**（合并到已存的值上）。
     *
     * 为什么不能整份提：表单里那些"留空 = 跟随主题"的项（底色 / 卡片色 / 正文色）
     * 会显示当前生效值（深色主题是深蓝底），整份提交等于把某一套主题的颜色钉死，
     * 之后换主题就不生效了。没动过的字段保持"没存过"。
     */
    const values: Record<string, unknown> = JSON.parse(
      JSON.stringify(settings?.values ?? {}),
    ) as Record<string, unknown>;
    for (const field of fields) {
      if (!form.isFieldTouched(field.name)) continue;
      setPath(values, field.name, getPath(formValues, field.path) ?? "");
    }
    // 集成开关：internal 设置，不在 capabilities 里，所以不在上面的循环里
    if (form.isFieldTouched(ZARAZ_NAME)) {
      setPath(values, ZARAZ_NAME, getPath(formValues, ZARAZ_PATH) ? "1" : "0");
    }
    try {
      const res = await api.saveSiteSettings({
        if_rev: settings?.rev ?? 0,
        values,
        collections: {
          downloads: (rawCollections?.downloads ?? []).filter(
            (d: DownloadItem) => d?.url,
          ),
        },
      });
      setSettings({ ...res, updatedAt: null });
      const unused = Array.isArray(res.unused_settings) ? res.unused_settings : [];
      if (unused.length > 0) {
        // S2：设了值但当前模板没用到 —— 菜单里说人话，别甩路径
        const label = (path: string) =>
          meta?.capabilities.find((c) => c.path === path)?.label ?? path;
        message.warning(
          `当前模板没用上这些设置，改了不会生效：${unused.slice(0, 3).map(label).join("、")}${
            unused.length > 3 ? ` 等 ${unused.length} 项` : ""
          }`,
        );
      }
      if (res.bake_error) {
        // 设置存下了，但渲染不出来：线上仍是上一份产物。必须说清，不能报"成功"。
        message.warning(`设置已保存，但线上没换：${res.bake_error.message}`);
      } else if (res.live) {
        message.success(
          `已保存，几秒内自动生效（设置 rev ${res.live.settingsRev}，不产生新版本）`,
        );
      } else {
        message.info(
          "已保存。站点还没发布过 —— 保存设置不会上线，请先在设计器里发布第一版",
        );
      }
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const active = state?.active ?? null;
  /**
   * **后台只能"重发"已经存在的设计**（`active` = 线上那一版设计）。没有就是
   * "从没在设计器里发布过"—— 此时后台不允许发布：种子只是设计器里的起点，
   * 发上去也只是一份通用模板，不是租户的站。新站点必须走设计器。
   */
  const canPublish = active !== null;
  const releases = state?.releases ?? [];
  const published = releases.find((v) => v.seq === active) ?? null;
  const live = state?.live ?? null;
  /** 源包从哪来：`release:vN` = 设计器交付的那一版；`seed` = 还没发布过 */
  const sourceFrom = state?.sourceFrom ?? '';

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
      key: "content",
      render: (_: unknown, row: SiteRelease) =>
        `${row.files} 个文件 / ${fmtBytes(row.bytes)}`,
    },
    {
      title: "发布时间",
      dataIndex: "created_at",
      render: (iso: string) => fmtTime(iso),
    },
    {
      title: "操作",
      key: "op",
      render: (_: unknown, row: SiteRelease) =>
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
                ? `设计发布于 ${fmtTime(published.created_at)}。改设置会自动重烘焙（只换产物，版本号不变）。`
                : "还没有发布过：新站点要先在设计器里发布一版。"}
            </Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card>
            <Statistic
              title="历史版本"
              value={releases.length}
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

      {!canPublish && !loading && (
        <Alert
          type="info"
          showIcon
          message="还没有站点：先在设计器里发布第一版"
          description="后台的「发布站点」只负责重发你在设计器里做过的站点。种子（起点模板）不会直接上线 —— 点右上角「打开设计器」改一版并发布，之后这里才有东西可发。"
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
            disabled={busy || !canPublish}
          >
            <Button loading={busy} disabled={!canPublish}>
              发布站点
            </Button>
          </Popconfirm>
        }
      >
        <Descriptions column={1} size="small">
          <Descriptions.Item label="内容来源">
            {sourceFrom === "seed"
              ? "起点模板（还没在设计器里发布过）"
              : sourceFrom
                ? `设计器交付的第 ${sourceFrom.replace("release:v", "")} 版`
                : "—"}
          </Descriptions.Item>
          <Descriptions.Item label="线上产物">
            {live
              ? `烘焙于 ${fmtTime(live.bakedAt)} · 设置 rev ${live.settingsRev}`
              : "还没有产物"}
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
          dataSource={releases}
          columns={columns}
          pagination={false}
          locale={{ emptyText: "还没有发布过" }}
        />
      </Card>
    </Space>
  );

  /** 一条设置字段：标签 + 上限计数 + 说明（和 studio 的面板一致） */
  const fieldItem = (f: FormField) => (
    <Form.Item
      key={f.path}
      label={f.label}
      name={f.name}
      extra={f.hint}
      rules={[
        ...(f.max ? [{ max: f.max, message: `最多 ${f.max} 个字符` }] : []),
        ...(f.control === "email"
          ? [{ type: "email" as const, message: "邮箱格式不对" }]
          : []),
      ]}
      getValueFromEvent={f.control === "color" ? colorEvent : undefined}
    >
      {f.control === "color" ? (
        <ColorPicker format="hex" disabledAlpha showText />
      ) : f.control === "select" ? (
        <Select options={f.options} />
      ) : (
        <Input type={f.control === "email" ? "email" : "text"} maxLength={f.max} showCount={Boolean(f.max)} />
      )}
    </Form.Item>
  );

  const settingsTab = (
    <Card>
      {/*
        设置是**租户事实**：保存即由 CRM 重烘焙，线上几秒内变，但**不产生版本号**。
        这行状态说的是"线上现在跑的哪份产物"，不是"哪一版设计"。
      */}
      {state?.live ? (
        <Typography.Paragraph type="secondary">
          线上正在用 {fmtTime(state.live.bakedAt)} 烘焙的产物（设置 rev{" "}
          {state.live.settingsRev}）。保存后会立刻重新烘焙一次，几秒内生效。
        </Typography.Paragraph>
      ) : (
        <Typography.Paragraph type="secondary">
          站点还没发布过：保存设置<strong>不会上线</strong>（种子不发布）。请先在设计器里发布第一版。
        </Typography.Paragraph>
      )}
      <Form
        form={form}
        layout="vertical"
        onFinish={saveSettings}
        style={{ maxWidth: 560 }}
      >
        <Divider orientation="left" plain>
          站点
        </Divider>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          谁在用这个站、怎么联系你
        </Typography.Paragraph>
        {siteFields.map(fieldItem)}

        {heroFields.length > 0 && (
          <>
            <Divider orientation="left" plain>
              首屏
            </Divider>
            <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
              首页最上面那一屏
            </Typography.Paragraph>
            {heroFields.map(fieldItem)}
          </>
        )}

        {(themeFields.length > 0 || meta?.palettes.length || colorFields.length > 0) && (
          <>
            <Divider orientation="left" plain>
              外观
            </Divider>
            <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
              深浅、配色
            </Typography.Paragraph>
            {themeFields.map(fieldItem)}
            {/* 配色方案：写 preset + 主色 + 强调色，本身不是字段（不落库） */}
            {meta && meta.palettes.length > 0 && (
              <Form.Item
                label="配色方案"
                extra="从现成的几套里挑一套。想逐个调色，展开下面的「高级」"
              >
                <Space wrap>
                  {meta.palettes.map((p) => (
                    <Button
                      key={p.id}
                      size="small"
                      type={paletteId === p.id ? "primary" : "default"}
                      onClick={() => applyPalette(p)}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          marginRight: 6,
                          background: p.colors.primary,
                        }}
                      />
                      {p.label}
                    </Button>
                  ))}
                </Space>
              </Form.Item>
            )}
            {colorFields.length > 0 && (
              <>
                <Button
                  type="link"
                  size="small"
                  style={{ paddingLeft: 0, marginBottom: 8 }}
                  onClick={() => setAdvanced((v) => !v)}
                >
                  {advanced ? "收起颜色微调" : "高级：逐个调色（一般不需要）"}
                </Button>
                {advanced && colorFields.map(fieldItem)}
              </>
            )}
          </>
        )}

        <Divider orientation="left" plain>
          集成
        </Divider>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          统计与客服
        </Typography.Paragraph>
        <Form.Item
          label="使用 Cloudflare Zaraz"
          name={ZARAZ_NAME as unknown as string[]}
          valuePropName="checked"
          extra="在 Cloudflare 后台的 Tag Management 里配置 GA4、客服等工具；打开这里之后，发布出来的页面会加载 Zaraz（工具本身不在这里配）。"
        >
          <Switch checkedChildren="开" unCheckedChildren="关" />
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

        <Space>
          <Button type="primary" htmlType="submit" loading={busy}>
            保存
          </Button>
          <Typography.Text type="secondary">
            保存即自动重新烘焙，几秒内线上生效（不产生新版本）
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
